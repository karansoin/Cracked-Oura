"""Live streaming session against a connected ring.

Streams:
* ``acm`` — realtime accelerometer (request tag 0x06 bitmask 0x20, frames tag 0x33,
  two 3-axis i16 samples per frame, ≈50 Hz). The ring time-boxes the stream in
  minutes; we re-arm it 20 s before it lapses and send an explicit off on exit.
* ``hr``  — daytime-HR in CONNECTED_LIVE mode. Start sequence (as the phone app):
  ``1c 01 3f`` (async notifications), ``2f 02 20 02`` (status read),
  ``2f 03 22 02 03`` (CONNECTED_LIVE), ``2f 03 26 02 02`` (LATEST subscription).
  Ring 3 then pushes ``2f 0f 28 02 …`` per beat (IBI + validity + skin temperature).
  Ring 4 firmware 2.12 acknowledges but never pushes; for that case a *history
  drain* runs concurrently: every 2 s the ring's event log is pulled (through the
  caller-supplied ``drain`` coroutine, which also persists the events exactly like
  a sync) and beats are read from ``0x80`` green-IBI / ``0x60`` records. Whichever
  path delivers beats is used. The ring reverts to automatic after ~20 s, so the
  live mode is re-triggered every 15 s and restored to AUTOMATIC on exit.

Events are delivered through ``emit`` as plain dicts so the same code path
serves the worker process (JSON lines) and in-process tests.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence

from . import protocol as P
from .client import RingClient
from .events import RingEvent

logger = logging.getLogger("ble.live")

Emit = Callable[[Dict[str, Any]], None]
Drain = Callable[[], Awaitable[List[RingEvent]]]

ACM_NOMINAL_FS = 50.0
HR_RETRIGGER_S = 15.0
ACM_BATCH = 25  # samples per emitted batch (~0.5 s)
PUSH_GRACE_S = 10.0  # no 0x28 push within this → start the history-drain fallback
DRAIN_PERIOD_S = 2.0


class LiveSession:
    def __init__(
        self,
        client: RingClient,
        streams: Sequence[str] = ("acm", "hr"),
        emit: Optional[Emit] = None,
        stop_event: Optional[asyncio.Event] = None,
        drain: Optional[Drain] = None,
    ):
        self.client = client
        self.stop_event = stop_event or asyncio.Event()
        self.streams = set(streams)
        self.emit = emit or (lambda ev: None)
        self.drain = drain
        self.acm: List[List[int]] = []
        self.ibi: List[List[float]] = []          # [t_s, ibi_ms]
        self.beats_meta: List[Dict[str, Any]] = []  # validity / source per beat (parallel to ibi)
        self.temps: List[List[float]] = []        # [t_s, skin °C] from the push tail
        self.started = 0.0
        self._acm_batch: List[List[int]] = []
        self._acm_last_emit = 0.0
        self.frames = 0
        self.seq_gaps = 0
        self._last_seq: Optional[int] = None
        self.fs_estimate: Optional[float] = None
        self._acm_t0: Optional[float] = None
        self.hr_source: Optional[str] = None      # 'push' | 'history'
        self.ring_state: Optional[int] = None
        self._hr_result: Optional[int] = None     # last 2f 03 23 02 <result>
        self._drain_task: Optional[asyncio.Task] = None
        self._seen_event_ts: set = set()

    # ------------------------------------------------------------- frames
    def _on_frame(self, frame: bytes) -> None:
        now = time.time()
        for p in P.parse_many(frame):
            if p.tag == P.ACM_RESPONSE_TAG:
                f = P.parse_acm_frame(p)
                if not f:
                    continue
                if self._last_seq is not None and (f.seq - self._last_seq) & 0xFF != 1:
                    self.seq_gaps += 1
                self._last_seq = f.seq
                for s in f.samples:
                    self.acm.append([s.x, s.y, s.z])
                    self._acm_batch.append([s.x, s.y, s.z])
                self.frames += 1
                if self._acm_t0 is None:
                    self._acm_t0 = now
                if len(self._acm_batch) >= ACM_BATCH or now - self._acm_last_emit > 1.0:
                    self._flush_acm(now)
            elif p.tag == 0x1F:
                st = P.parse_state_notify(p)
                if st:
                    self.ring_state = st["state"]
                    self.emit({"type": "ring_state", "t": round(now - self.started, 3), **st})
            elif p.ext == 0x23 and len(p.payload) >= 3 and p.payload[1] == 0x02:
                self._hr_result = p.payload[2]
                if self._hr_result not in (0, None):
                    self.emit({"type": "hr_status", "t": round(now - self.started, 3), "result": self._hr_result, "message": P.FEATURE_SET_RESULTS.get(self._hr_result, f"result {self._hr_result}")})
            else:
                beat = P.parse_live_beat(p)
                if beat:
                    self._add_beat(now - self.started, beat.ibi_ms, beat.validity, "push", beat.bpm, beat.skin_temp_c)
                elif p.is_event and self.drain is None:
                    # No storage path for events: still read beats out of records the ring pushes on its own.
                    ev = RingEvent.from_packet(p)
                    if ev:
                        self._beats_from_event(ev, now)

    def _add_beat(self, t: float, ibi_ms: int, validity: int, source: str, bpm: Optional[int], temp_c: Optional[float] = None) -> None:
        if self.hr_source is None:
            self.hr_source = source
        usable = validity in (P.IBI_VALID, P.IBI_CORRECTED) and 300 <= ibi_ms <= 2000
        self.beats_meta.append({"validity": validity, "source": source})
        if usable:
            self.ibi.append([round(t, 3), ibi_ms])
        ev: Dict[str, Any] = {"type": "hr", "t": round(t, 3), "bpm": bpm, "ibi_ms": ibi_ms, "validity": P.IBI_VALIDITY_NAMES.get(validity, str(validity)), "source": source}
        if temp_c is not None:
            self.temps.append([round(t, 3), temp_c])
            ev["skin_temp_c"] = temp_c
        self.emit(ev)

    def _beats_from_event(self, ev: RingEvent, now: float) -> int:
        """Extract beats from 0x80 (green IBI + quality) and 0x60 (IBI + amplitude) records."""
        if ev.tag not in (0x80, 0x60):
            return 0
        key = (ev.tag, ev.ring_ts)
        if key in self._seen_event_ts:
            return 0
        self._seen_event_ts.add(key)
        dec = ev.decode() or {}
        ibis = [int(x) for x in dec.get("ibi_ms") or []]
        if not ibis:
            return 0
        quality = dec.get("quality") or [None] * len(ibis)
        # The record time is (roughly) the time of its last beat; walk backwards.
        t_last = now - self.started
        offsets = [0.0] * len(ibis)
        acc = 0.0
        for k in range(len(ibis) - 1, -1, -1):
            offsets[k] = acc
            acc += ibis[k] / 1000.0
        n = 0
        for k, ibi in enumerate(ibis):
            if not 300 <= ibi <= 2000:
                continue
            q = quality[k]
            # PR#3: quality bits are unreliable; 2/3 seen on moving beats → treat as 'corrected' grade
            validity = P.IBI_VALID if q in (None, 0, 1) else P.IBI_CORRECTED
            self._add_beat(t_last - offsets[k], ibi, validity, "history", 60000 // ibi)
            n += 1
        return n

    def _flush_acm(self, now: float) -> None:
        if not self._acm_batch:
            return
        if self._acm_t0 is not None and len(self.acm) > 100:
            self.fs_estimate = round(len(self.acm) / max(now - self._acm_t0, 1e-3), 1)
        self.emit({"type": "acm", "t": round(now - self.started, 3), "fs": self.fs_estimate or ACM_NOMINAL_FS, "n_total": len(self.acm), "samples": self._acm_batch, "seq_gaps": self.seq_gaps})
        self._acm_batch = []
        self._acm_last_emit = now

    # -------------------------------------------------------------- run
    async def run(self, duration_s: float) -> Dict[str, Any]:
        t = self.client.t
        q = t.subscribe()
        self.started = time.time()
        minutes = max(1, int(duration_s // 60) + 1)
        acm_armed_at = 0.0
        try:
            if "acm" in self.streams:
                await t.write(P.req_realtime(P.REALTIME_ACM, minutes, 0))
                acm_armed_at = time.time()
            if "hr" in self.streams:
                await self._start_hr()
            last_hr_trigger = time.time()
            deadline = self.started + duration_s
            while not self.stop_event.is_set():
                now = time.time()
                remaining = deadline - now
                if remaining <= 0:
                    break
                try:
                    frame = await asyncio.wait_for(q.get(), min(remaining, 1.0))
                    self._on_frame(frame)
                except asyncio.TimeoutError:
                    pass
                now = time.time()
                if "hr" in self.streams:
                    if now - last_hr_trigger >= HR_RETRIGGER_S:
                        await self._trigger_hr()
                        last_hr_trigger = now
                    if self.drain is not None and self._drain_task is None and self.hr_source is None and now - self.started >= PUSH_GRACE_S:
                        logger.info("No live beat push after %.0f s; starting history-drain fallback", PUSH_GRACE_S)
                        self.emit({"type": "hr_fallback", "t": round(now - self.started, 3), "message": "Ring does not push beats; reading them from its event log every 2 s."})
                        self._drain_task = asyncio.create_task(self._drain_loop())
                if "acm" in self.streams and minutes * 60 - (now - acm_armed_at) <= 20 and deadline - now > 5:
                    await t.write(P.req_realtime(P.REALTIME_ACM, minutes, 0))  # re-arm before the ring's auto-stop
                    acm_armed_at = now
                if self._acm_batch and now - self._acm_last_emit > 1.0:
                    self._flush_acm(now)
        finally:
            if self._drain_task is not None:
                self._drain_task.cancel()
                try:
                    await self._drain_task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
            t.unsubscribe(q)
            self._flush_acm(time.time())
            await self.stop()
        return self.summary()

    async def _drain_loop(self) -> None:
        assert self.drain is not None
        while not self.stop_event.is_set():
            try:
                events = await self.drain()
                now = time.time()
                for ev in events:
                    self._beats_from_event(ev, now)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - keep the session alive
                logger.warning("live drain failed: %s", e)
            await asyncio.sleep(DRAIN_PERIOD_S)

    async def _start_hr(self) -> None:
        t = self.client.t
        for req in (P.req_set_notification(0x3F), P.req_feature_status(0x02)):
            try:
                await t.write(req)
            except Exception:  # noqa: BLE001
                pass
        await self._trigger_hr()

    async def _trigger_hr(self) -> None:
        t = self.client.t
        try:
            await t.write(P.req_set_feature_mode(0x02, P.MODE_CONNECTED_LIVE))
            await t.write(P.req_set_feature_subscription(0x02, 0x02))
        except Exception:  # noqa: BLE001 - keep streaming ACM even if HR trigger fails
            pass

    async def stop(self) -> None:
        """Best-effort restore, in the documented order: ACM off first (quiets the
        link), then daytime HR back to AUTOMATIC (never OFF), subscription off."""
        t = self.client.t
        reqs = []
        if "acm" in self.streams:
            reqs.append(P.req_realtime_off())
        if "hr" in self.streams:
            reqs += [P.req_set_feature_mode(0x02, P.MODE_AUTOMATIC), P.req_set_feature_subscription(0x02, 0x00)]
        for req in reqs:
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
            "beats_seen": len(self.beats_meta),
            "frames": self.frames,
            "seq_gaps": self.seq_gaps,
            "hr_source": self.hr_source,
            "acm": self.acm,
            "ibi": self.ibi,
            "temps": self.temps,
        }
