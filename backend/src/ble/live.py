"""Live streaming session against a connected ring.

Streams:
* ``acm`` — realtime accelerometer (request tag 0x06 bitmask 0x20, frames tag 0x33,
  two 3-axis i16 samples per frame, ≈50 Hz). Time-boxed in minutes by the ring;
  we also send an explicit off on exit.
* ``hr``  — daytime-HR in CONNECTED_LIVE mode (``2f 03 22 02 03`` + subscription
  ``2f 03 26 02 02``); the ring emits ``2f xx 28 …`` per beat and reverts to
  automatic after ~20 s, so we re-trigger every 15 s. Restored on exit.

Events are delivered through ``emit`` as plain dicts so the same code path
serves the worker process (JSON lines) and in-process tests.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, Dict, List, Optional, Sequence

from . import protocol as P
from .client import RingClient

Emit = Callable[[Dict[str, Any]], None]

ACM_NOMINAL_FS = 50.0
HR_RETRIGGER_S = 15.0
ACM_BATCH = 25  # samples per emitted batch (~0.5 s)


class LiveSession:
    def __init__(self, client: RingClient, streams: Sequence[str] = ("acm", "hr"), emit: Optional[Emit] = None, stop_event: Optional[asyncio.Event] = None):
        self.client = client
        self.stop_event = stop_event or asyncio.Event()
        self.streams = set(streams)
        self.emit = emit or (lambda ev: None)
        self.acm: List[List[int]] = []
        self.ibi: List[List[float]] = []
        self.started = 0.0
        self._acm_batch: List[List[int]] = []
        self._acm_last_emit = 0.0
        self.frames = 0
        self.fs_estimate: Optional[float] = None
        self._acm_t0: Optional[float] = None

    # ------------------------------------------------------------- frames
    def _on_frame(self, frame: bytes) -> None:
        now = time.time()
        for p in P.parse_many(frame):
            if p.tag == P.ACM_RESPONSE_TAG:
                for s in P.parse_acm(p):
                    self.acm.append([s.x, s.y, s.z])
                    self._acm_batch.append([s.x, s.y, s.z])
                self.frames += 1
                if self._acm_t0 is None:
                    self._acm_t0 = now
                if len(self._acm_batch) >= ACM_BATCH or now - self._acm_last_emit > 1.0:
                    self._flush_acm(now)
            else:
                hr = P.parse_live_hr(p)
                if hr:
                    t = now - self.started
                    self.ibi.append([round(t, 3), hr.ibi_ms])
                    self.emit({"type": "hr", "t": round(t, 3), "bpm": hr.bpm, "ibi_ms": hr.ibi_ms})

    def _flush_acm(self, now: float) -> None:
        if not self._acm_batch:
            return
        if self._acm_t0 is not None and len(self.acm) > 100:
            self.fs_estimate = round(len(self.acm) / max(now - self._acm_t0, 1e-3), 1)
        self.emit({"type": "acm", "t": round(now - self.started, 3), "fs": self.fs_estimate or ACM_NOMINAL_FS, "n_total": len(self.acm), "samples": self._acm_batch})
        self._acm_batch = []
        self._acm_last_emit = now

    # -------------------------------------------------------------- run
    async def run(self, duration_s: float) -> Dict[str, Any]:
        t = self.client.t
        q = t.subscribe()
        self.started = time.time()
        minutes = max(1, int(duration_s // 60) + 1)
        try:
            if "acm" in self.streams:
                await t.write(P.req_realtime(P.REALTIME_ACM, minutes, 0))
            if "hr" in self.streams:
                await self._trigger_hr()
            last_hr_trigger = time.time()
            deadline = self.started + duration_s
            while not self.stop_event.is_set():
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                try:
                    frame = await asyncio.wait_for(q.get(), min(remaining, 1.0))
                    self._on_frame(frame)
                except asyncio.TimeoutError:
                    pass
                if "hr" in self.streams and time.time() - last_hr_trigger >= HR_RETRIGGER_S:
                    await self._trigger_hr()
                    last_hr_trigger = time.time()
                self._flush_acm(time.time()) if self._acm_batch and time.time() - self._acm_last_emit > 1.0 else None
        finally:
            t.unsubscribe(q)
            self._flush_acm(time.time())
            await self.stop()
        return self.summary()

    async def _trigger_hr(self) -> None:
        t = self.client.t
        try:
            await t.write(P.req_set_feature_mode(0x02, P.MODE_CONNECTED_LIVE))
            await t.write(P.req_set_feature_subscription(0x02, 0x02))
        except Exception:  # noqa: BLE001 - keep streaming ACM even if HR trigger fails
            pass

    async def stop(self) -> None:
        t = self.client.t
        for req in ((P.req_realtime_off(),) if "acm" in self.streams else ()) + (
            (P.req_set_feature_subscription(0x02, 0x00), P.req_set_feature_mode(0x02, P.MODE_AUTOMATIC)) if "hr" in self.streams else ()
        ):
            try:
                await t.write(req)
            except Exception:  # noqa: BLE001
                pass

    def summary(self) -> Dict[str, Any]:
        return {
            "duration_s": round(time.time() - self.started, 1) if self.started else 0.0,
            "fs_hz": self.fs_estimate or ACM_NOMINAL_FS,
            "acm_samples": len(self.acm),
            "beats": len(self.ibi),
            "frames": self.frames,
            "acm": self.acm,
            "ibi": self.ibi,
        }
