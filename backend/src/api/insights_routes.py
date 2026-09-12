"""Transparent nightly baselines, change-point alerts and readiness computed from stored nights."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter
from sqlalchemy import func, select

from ..analysis.baselines import analyze_baselines
from ..database import SessionLocal
from ..models import Readiness, SleepSession

router = APIRouter(prefix="/api/insights")


def nightly_rows(db, days: int = 90, end: Optional[date] = None) -> List[Dict[str, Any]]:
    """Nights up to ``end`` (default: the latest stored night, so an older import
    still yields baselines relative to its own last night)."""
    end = end or db.scalar(select(func.max(SleepSession.day))) or date.today()
    start = end - timedelta(days=days)
    sleeps = db.scalars(select(SleepSession).where(SleepSession.day >= start, SleepSession.day <= end).order_by(SleepSession.day)).all()
    temps = {r.day: r.temperature_deviation for r in db.scalars(select(Readiness).where(Readiness.day >= start, Readiness.day <= end)).all()}
    by_day: Dict[date, Dict[str, Any]] = {}
    for s in sleeps:
        if s.type not in (None, "long_sleep", "sleep") and (s.total_sleep_duration or 0) < 3 * 3600:
            continue  # naps do not count as nights
        cur = by_day.get(s.day)
        if cur and (cur.get("_dur") or 0) >= (s.total_sleep_duration or 0):
            continue
        by_day[s.day] = {
            "day": s.day,
            "_dur": s.total_sleep_duration or 0,
            "resting_hr": s.lowest_heart_rate or s.average_heart_rate,
            "rmssd": s.average_hrv,
            "temp_deviation": temps.get(s.day),
            "breathing_rate": s.average_breath,
            "sleep_hours": round(s.total_sleep_duration / 3600, 2) if s.total_sleep_duration else None,
        }
    rows = [dict(v) for _, v in sorted(by_day.items())]
    for r in rows:
        r.pop("_dur", None)
    return rows


@router.get("/baselines")
def baselines(days: int = 90):
    db = SessionLocal()
    try:
        rows = nightly_rows(db, max(21, min(days, 400)))
    finally:
        db.close()
    out = analyze_baselines(rows)
    out["latest_day"] = str(rows[-1]["day"]) if rows else None
    return out
