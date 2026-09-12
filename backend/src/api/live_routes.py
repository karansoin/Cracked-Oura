"""Live streaming sessions: steadiness tests, workouts, breathing, free recording."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..ble.supervisor import ring_manager
from ..database import SessionLocal
from ..models import LiveSession

router = APIRouter(prefix="/api/live")

KINDS = ("steadiness", "workout", "breathing", "gait", "orthostatic", "free")


class StartRequest(BaseModel):
    kind: str = "free"
    duration_s: float = 60.0
    streams: List[str] = Field(default_factory=lambda: ["acm", "hr"])
    address: Optional[str] = None
    simulate: Optional[str] = None  # 'still' | 'tremor' | 'walk' | 'run' | 'reps'


class AnalyzeRequest(BaseModel):
    kind: str = "free"
    fs_hz: float = 50.0
    acm: List[List[float]] = Field(default_factory=list)
    ibi: List[List[float]] = Field(default_factory=list)
    scale_g_per_lsb: Optional[float] = None


@router.post("/start")
async def start(req: StartRequest):
    if req.kind not in KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {KINDS}")
    streams = [s for s in req.streams if s in ("acm", "hr")] or ["acm", "hr"]
    sid = ring_manager.start_live_session(req.kind, max(5.0, min(req.duration_s, 3600.0)), streams, req.address, req.simulate)
    if sid is None:
        raise HTTPException(status_code=409, detail="The ring manager is busy.")
    return {"started": True, "id": sid}


@router.post("/stop")
async def stop():
    return {"stopping": ring_manager.stop_live()}


@router.get("/status")
async def status():
    return ring_manager.live_status()


def _row_summary(r: LiveSession) -> Dict[str, Any]:
    m = r.metrics or {}
    return {
        "id": r.id,
        "serial": r.serial,
        "kind": r.kind,
        "simulated": bool(r.simulated),
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "ended_at": r.ended_at.isoformat() if r.ended_at else None,
        "duration_s": r.duration_s,
        "fs_hz": r.fs_hz,
        "beats": m.get("beats"),
        "acm_samples": m.get("acm_samples"),
        "tremor": {k: m["tremor"].get(k) for k in ("steadiness_score", "dominant_hz", "rms_mg", "quality")} if m.get("tremor") else None,
        "motion": {k: m["motion"].get(k) for k in ("activity", "cadence_spm", "steps", "reps", "intensity_rms_g")} if m.get("motion") else None,
        "hrv": {k: m["hrv"].get(k) for k in ("mean_hr", "rmssd_ms", "breathing_rpm")} if m.get("hrv") else None,
        "hr_recovery": m.get("hr_recovery"),
        "notes": r.notes,
    }


@router.get("/sessions")
def sessions(kind: Optional[str] = None, limit: int = 100):
    db = SessionLocal()
    try:
        q = select(LiveSession).order_by(LiveSession.started_at.desc()).limit(max(1, min(limit, 1000)))
        if kind:
            q = q.where(LiveSession.kind == kind)
        return [_row_summary(r) for r in db.scalars(q).all()]
    finally:
        db.close()


@router.get("/sessions/{sid}")
def session(sid: str, raw: bool = False):
    db = SessionLocal()
    try:
        r = db.get(LiveSession, sid)
        if r is None:
            raise HTTPException(status_code=404, detail="No such session")
        out = _row_summary(r)
        out["metrics"] = r.metrics
        out["scale_g_per_lsb"] = r.scale_g_per_lsb
        if raw:
            out["acm"] = r.acm
            out["ibi"] = r.ibi
        return out
    finally:
        db.close()


@router.delete("/sessions/{sid}")
def delete_session(sid: str):
    db = SessionLocal()
    try:
        r = db.get(LiveSession, sid)
        if r is None:
            raise HTTPException(status_code=404, detail="No such session")
        db.delete(r)
        db.commit()
        return {"deleted": sid}
    finally:
        db.close()


class NotesRequest(BaseModel):
    notes: str


@router.post("/sessions/{sid}/notes")
def set_notes(sid: str, req: NotesRequest):
    db = SessionLocal()
    try:
        r = db.get(LiveSession, sid)
        if r is None:
            raise HTTPException(status_code=404, detail="No such session")
        r.notes = req.notes[:2000]
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@router.post("/analyze")
def analyze(req: AnalyzeRequest):
    """Analyse arrays directly (development, tests, imported recordings)."""
    from ..analysis.session_metrics import compute_metrics

    return compute_metrics(req.kind, req.acm, req.ibi, req.fs_hz, req.scale_g_per_lsb)
