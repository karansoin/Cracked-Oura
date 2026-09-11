"""HTTP surface for the direct-BLE ring connection."""

from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, select

from ..ble.manager import ring_manager
from ..database import SessionLocal
from ..models import RingEvent, RingState

router = APIRouter(prefix="/api/ble")


class AddressRequest(BaseModel):
    address: Optional[str] = None


class SyncRequest(AddressRequest):
    full: bool = False


class LiveRequest(AddressRequest):
    duration: float = 60.0


class ScanRequest(BaseModel):
    duration: float = 12.0


def _busy():
    raise HTTPException(status_code=409, detail="The ring manager is busy; wait for the current operation or cancel it.")


@router.get("/status")
async def status():
    return ring_manager.status()


@router.post("/scan")
async def scan(req: ScanRequest):
    if not ring_manager.start_scan(max(3.0, min(req.duration, 60.0))):
        _busy()
    return {"started": True}


@router.post("/probe")
async def probe(req: AddressRequest):
    if not ring_manager.start_probe(req.address):
        _busy()
    return {"started": True}


@router.post("/pair")
async def pair(req: AddressRequest):
    if not ring_manager.start_pair(req.address):
        _busy()
    return {"started": True}


@router.post("/sync")
async def sync(req: SyncRequest):
    if not ring_manager.start_sync(req.address, req.full):
        _busy()
    return {"started": True}


@router.post("/live")
async def live(req: LiveRequest):
    if not ring_manager.start_live(req.address, max(5.0, min(req.duration, 600.0))):
        _busy()
    return {"started": True}


@router.post("/cancel")
async def cancel():
    return {"cancelled": await ring_manager.cancel()}


@router.delete("/pair/{serial}")
async def forget(serial: str):
    return {"forgotten": ring_manager.forget(serial)}


@router.get("/rings")
def rings():
    db = SessionLocal()
    try:
        out = []
        for st in db.scalars(select(RingState)).all():
            count = db.scalar(select(func.count()).select_from(RingEvent).where(RingEvent.serial == st.serial))
            last = db.scalar(select(func.max(RingEvent.unix_time)).where(RingEvent.serial == st.serial))
            out.append(
                {
                    "serial": st.serial,
                    "name": st.name,
                    "hardware_id": st.hardware_id,
                    "firmware_version": st.firmware_version,
                    "mac": st.mac,
                    "next_cursor": st.next_cursor,
                    "last_sync_at": st.last_sync_at.isoformat() if st.last_sync_at else None,
                    "last_event_unix": last,
                    "battery_percent": st.battery_percent,
                    "battery_at": st.battery_at.isoformat() if st.battery_at else None,
                    "events": count,
                    "paired_here": st.serial in ring_manager.paired_serials(),
                }
            )
        return out
    finally:
        db.close()


@router.get("/events")
def events(serial: Optional[str] = None, limit: int = 200, tag: Optional[int] = None):
    db = SessionLocal()
    try:
        q = select(RingEvent).order_by(RingEvent.ring_ts.desc()).limit(max(1, min(limit, 2000)))
        if serial:
            q = q.where(RingEvent.serial == serial)
        if tag is not None:
            q = q.where(RingEvent.tag == tag)
        rows = db.scalars(q).all()
        from ..ble.events import EVENT_NAMES

        return [
            {
                "id": r.id,
                "serial": r.serial,
                "tag": r.tag,
                "name": EVENT_NAMES.get(r.tag, f"unknown_0x{r.tag:02x}"),
                "ring_ts": r.ring_ts,
                "unix_time": r.unix_time,
                "decoded": r.decoded,
                "body_hex": r.body_hex,
            }
            for r in rows
        ]
    finally:
        db.close()


@router.get("/stream")
async def stream():
    """Server-sent events: state changes, log lines and live heart-rate samples."""
    q = ring_manager.listen()

    async def gen():
        try:
            yield "data: " + json.dumps({"type": "hello", **{k: v for k, v in ring_manager.status().items() if k not in ("log", "live_samples")}}) + "\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), 15.0)
                    yield "data: " + json.dumps(ev, default=str) + "\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            ring_manager.unlisten(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
