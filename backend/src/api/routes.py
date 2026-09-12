"""HTTP routes for local data access, import, settings and the AI analyst."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
import zipfile
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import config_manager
from ..database import DB_PATH, SessionLocal, get_db
from ..ingestion import OuraParser
from ..models import (
    Activity,
    CardiovascularAge,
    HeartRate,
    Meditation,
    Readiness,
    Resilience,
    RingBattery,
    RingConfiguration,
    Sleep,
    SleepSession,
    Tag,
    Temperature,
    Workout,
)
from .schemas import DayDataResponse

logger = logging.getLogger("API")
router = APIRouter()

MODEL_MAP = {
    "sleep": Sleep,
    "activity": Activity,
    "readiness": Readiness,
    "resilience": Resilience,
    "cardiovascular_age": CardiovascularAge,
    "sleep_session": SleepSession,
    "workout": Workout,
    "meditation": Meditation,
    "ring_battery": RingBattery,
    "heart_rate": HeartRate,
    "temperature": Temperature,
    "ring_configuration": RingConfiguration,
    "tag": Tag,
}
TIMESTAMP_DOMAINS = {"heart_rate", "temperature", "ring_battery"}

# Extra models that may exist (added by newer ingestion code)
try:  # pragma: no cover - optional
    from ..models import Vo2Max  # type: ignore

    MODEL_MAP["vo2max"] = Vo2Max
except Exception:  # pragma: no cover
    pass
try:  # pragma: no cover - optional
    from ..models import LiveSession as _LiveSession, RingEvent as _RingEvent  # type: ignore

    MODEL_MAP["live_session"] = _LiveSession
    MODEL_MAP["ring_event"] = _RingEvent
except Exception:
    pass


# ----------------------------------------------------------------- schemas
class ChatRequest(BaseModel):
    message: str
    history: List[Dict[str, Any]] = Field(default_factory=list)


class SettingsRequest(BaseModel):
    schedule_time: Optional[str] = None
    email: Optional[str] = None
    units: Optional[str] = None
    llm_provider: Optional[str] = None
    llm_host: Optional[str] = None
    llm_model: Optional[str] = None
    llm_base_url: Optional[str] = None
    llm_api_key: Optional[str] = None
    ble_ring_address: Optional[str] = None
    ble_auto_sync: Optional[bool] = None


class Dashboard(BaseModel):
    id: str
    name: str
    widgets: List[Any]
    layout: List[Any]


class DashboardConfigRequest(BaseModel):
    dashboards: Optional[List[Dashboard]] = None
    activeDashboardId: Optional[str] = None
    layout: Optional[List[Any]] = None
    widgets: Optional[List[Any]] = None


# ------------------------------------------------------------------ health
@router.get("/api/health")
async def health():
    return {"ok": True, "service": "cracked-oura", "version": "0.2.0", "db": os.path.exists(DB_PATH)}


# ------------------------------------------------------------------- chat
@router.post("/api/advisor/chat")
async def chat(request: ChatRequest):
    """AI analyst. Runs in a worker thread so the event loop stays free."""
    from ..llm import DataAnalyst

    history = [m for m in request.history if isinstance(m, dict)] + [{"role": "user", "content": request.message}]
    try:
        analyst = DataAnalyst()
        return await asyncio.to_thread(analyst.chat, history)
    except Exception as e:
        logger.exception("Chat failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/advisor/status")
async def advisor_status():
    from ..llm import check_llm_connection

    return await asyncio.to_thread(check_llm_connection)


# --------------------------------------------------------------- settings
@router.get("/api/settings")
async def get_settings():
    return config_manager.public_config()


@router.post("/api/settings")
async def save_settings(request: SettingsRequest):
    updates = {k: v for k, v in request.model_dump().items() if v is not None}
    config_manager.update_config(**updates)
    return {"message": "Settings saved", "settings": config_manager.public_config()}


# --------------------------------------------------------------- dashboard
@router.get("/api/dashboard")
async def get_dashboard_config():
    return config_manager.get_dashboard()


@router.post("/api/dashboard")
async def save_dashboard_config(request: DashboardConfigRequest):
    current = config_manager.get_dashboard()
    update: Dict[str, Any] = dict(current)
    if request.dashboards is not None:
        update["dashboards"] = [d.model_dump() for d in request.dashboards]
    if request.activeDashboardId is not None:
        update["activeDashboardId"] = request.activeDashboardId
    if request.layout is not None:
        update["layout"] = request.layout
    if request.widgets is not None:
        update["widgets"] = request.widgets
    config_manager.save_dashboard(update)
    return {"message": "Dashboard saved"}


# ------------------------------------------------------------- sync state
@router.get("/api/sync/status")
async def sync_status():
    return config_manager.get_sync()


# ---------------------------------------------------------- data access
@router.get("/api/days/{date_str}", response_model=DayDataResponse)
async def get_day_data(date_str: str, include_details: bool = False, db: Session = Depends(get_db)):
    try:
        target = datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")

    start_of_day = datetime.combine(target, datetime.min.time())
    end_of_day = datetime.combine(target, datetime.max.time())

    def fetch_timeseries(model):
        return db.scalars(
            select(model).where(model.timestamp >= start_of_day, model.timestamp <= end_of_day).order_by(model.timestamp)
        ).all()

    data: Dict[str, Any] = {
        "date": target,
        "sleep": db.query(Sleep).filter(Sleep.day == target).first(),
        "activity": db.query(Activity).filter(Activity.day == target).first(),
        "readiness": db.query(Readiness).filter(Readiness.day == target).first(),
        "resilience": db.query(Resilience).filter(Resilience.day == target).first(),
        "cardiovascular_age": db.query(CardiovascularAge).filter(CardiovascularAge.day == target).first(),
        "ring_battery": fetch_timeseries(RingBattery),
        "sleep_sessions": db.query(SleepSession).filter(SleepSession.day == target).all(),
        "workouts": db.query(Workout).filter(Workout.day == target).all(),
        "meditation": db.query(Meditation).filter(Meditation.day == target).all(),
    }
    if include_details:
        data["heart_rate"] = fetch_timeseries(HeartRate)
        data["temperature"] = fetch_timeseries(Temperature)
    return data


@router.get("/api/days")
def list_days_with_data(db: Session = Depends(get_db)):
    """Days that have at least one daily summary row. Used for calendar hints."""
    days = set()
    for model in (Sleep, Activity, Readiness):
        for (d,) in db.execute(select(model.day)).all():
            if d:
                days.add(d.isoformat())
    return sorted(days)


@router.get("/api/query")
def query_data(
    path: str,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    db: Session = Depends(get_db),
):
    """Metric trend query. Path: ``domain.field`` or ``domain.jsoncol.key``."""
    parts = path.split(".")
    if len(parts) < 2:
        raise HTTPException(status_code=400, detail="Invalid path. Use 'domain.field' or 'domain.field.key'")
    domain, field = parts[0].lower(), parts[1]
    json_key = ".".join(parts[2:]) if len(parts) > 2 else None

    model = MODEL_MAP.get(domain)
    if model is None:
        raise HTTPException(status_code=400, detail=f"Unknown domain: {domain}")
    columns = model.__table__.columns
    if field not in columns:
        raise HTTPException(status_code=400, detail=f"Unknown field: {field} in {domain}")
    column = getattr(model, field)
    value_expr = func.json_extract(column, f"$.{json_key}") if json_key else column

    date_col = model.timestamp if domain in TIMESTAMP_DOMAINS or not hasattr(model, "day") else model.day
    is_datetime = date_col.type.python_type is datetime

    query = select(date_col, value_expr)
    if domain == "sleep_session":
        query = query.where(SleepSession.type.in_(["long_sleep", "sleep"]))
        query = query.order_by(date_col, SleepSession.type.desc())
    else:
        query = query.order_by(date_col)
    if start_date:
        query = query.where(date_col >= (datetime.combine(start_date, datetime.min.time()) if is_datetime else start_date))
    if end_date:
        query = query.where(date_col <= (datetime.combine(end_date, datetime.max.time()) if is_datetime else end_date))

    out = []
    for d, v in db.execute(query).all():
        out.append({"date": d.isoformat() if isinstance(d, (datetime, date)) else d, "value": v})
    return out


@router.get("/api/schema")
def get_schema():
    schema = {}
    for name, model in MODEL_MAP.items():
        fields = []
        for col in model.__table__.columns:
            if col.name == "id":
                continue
            is_json = "JSON" in str(col.type).upper()
            fields.append({"name": col.name, "type": "json" if is_json else str(col.type), "is_json": is_json})
        schema[name] = fields
    return schema


@router.get("/api/data/inventory")
def data_inventory(db: Session = Depends(get_db)):
    """Row counts and date coverage per table, for the Data page."""
    inv = {}
    for name, model in MODEL_MAP.items():
        col = model.timestamp if name in TIMESTAMP_DOMAINS else getattr(model, "day", None)
        if col is None:
            count = db.scalar(select(func.count()).select_from(model))
            inv[name] = {"rows": count, "first": None, "last": None}
            continue
        count, first, last = db.execute(select(func.count(), func.min(col), func.max(col)).select_from(model)).one()
        inv[name] = {
            "rows": count,
            "first": first.isoformat() if isinstance(first, (datetime, date)) else first,
            "last": last.isoformat() if isinstance(last, (datetime, date)) else last,
        }
    return inv


@router.delete("/api/data")
def delete_all_data(db: Session = Depends(get_db)):
    """Wipe every table (used by 'Delete local data')."""
    for model in MODEL_MAP.values():
        db.execute(model.__table__.delete())
    try:  # ring bookkeeping: the events are gone, so the next sync must start from the beginning
        from ..models import RingState as _RingState

        db.execute(_RingState.__table__.update().values(next_cursor=0, events_total=0, last_event_unix=None))
    except Exception:  # pragma: no cover
        pass
    db.commit()
    return {"message": "All local data deleted"}


# --------------------------------------------------------------- import
def _ingest_file(path: str) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        parser = OuraParser(db)
        summary = parser.parse_zip(path)
        return summary or {}
    finally:
        db.close()


@router.post("/api/ingest/zip")
async def ingest_zip(file: UploadFile = File(...)):
    """Import an Oura data-export ZIP the user already downloaded themselves."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp_path = tmp.name
        if not zipfile.is_zipfile(tmp_path):
            raise HTTPException(status_code=400, detail="That file is not a ZIP archive.")
        config_manager.update_sync("ingesting", method="zip", message=f"Importing {file.filename}", started_at=datetime.now().isoformat(timespec="seconds"))
        summary = await asyncio.to_thread(_ingest_file, tmp_path)
        config_manager.update_sync("done", message="Import complete", progress=None, summary=summary)
        return {"message": "Ingestion successful", "summary": summary}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Ingestion error")
        config_manager.set_sync_error(f"Import failed: {e}", code="IMPORT_FAILED")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
