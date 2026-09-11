"""Async client for an Oura ring over BLE.

Transport-agnostic so the protocol layer can be unit-tested with a mock. The
real transport wraps ``bleak`` (CoreBluetooth on macOS).

Connection recipe (mirrors the phone app; see docs/BLE.md):

1. connect + subscribe to every notify characteristic of the Oura service
2. read firmware / hardware id (unauthenticated)
3. app-auth: nonce → AES proof → verdict (per connection)
4. app-style stream registration + parameter sweep, time sync
5. flush + drain history events from the persisted cursor, acknowledging
   each batch so the ring can free its buffer
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable, Dict, List, Optional

from . import protocol as P
from .events import RingEvent

logger = logging.getLogger("RingClient")


class RingError(Exception):
    pass


class PairingRequired(RingError):
    """The link is not encrypted: macOS must pair (bond) with the ring first."""


class AuthRequired(RingError):
    """The ring has an app key installed and we did not authenticate."""


class AuthFailed(RingError):
    def __init__(self, code: int):
        self.code = code
        super().__init__(f"ring rejected the key: {P.auth_result_name(code)} ({code})")


# ------------------------------------------------------------ transport
class Transport:
    """Minimal duplex byte transport. Subclass for real BLE or tests."""

    async def write(self, data: bytes) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def subscribe(self) -> "asyncio.Queue[bytes]":  # pragma: no cover - interface
        raise NotImplementedError

    def unsubscribe(self, q: "asyncio.Queue[bytes]") -> None:  # pragma: no cover
        raise NotImplementedError

    async def close(self) -> None:  # pragma: no cover
        return None

    @property
    def connected(self) -> bool:  # pragma: no cover
        return True


class _Fanout:
    def __init__(self) -> None:
        self._subs: List[asyncio.Queue] = []

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subs.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._subs.remove(q)
        except ValueError:
            pass

    def publish(self, data: bytes) -> None:
        for q in list(self._subs):
            q.put_nowait(data)


class BleakTransport(Transport):
    def __init__(self, client, on_disconnect: Optional[Callable[[], None]] = None):
        self.client = client
        self.fanout = _Fanout()
        self._on_disconnect = on_disconnect
        self.write_char = None
        self.notify_chars: list = []

    async def setup(self) -> None:
        from bleak.exc import BleakError

        svc = self.client.services.get_service(P.OURA_SERVICE)
        if svc is None:
            raise RingError("Oura service not found on this device")
        for ch in svc.characteristics:
            if ch.uuid.lower() == P.OURA_WRITE:
                self.write_char = ch
        if self.write_char is None:
            raise RingError("Oura write characteristic missing")
        for ch in svc.characteristics:
            if "notify" in ch.properties or "indicate" in ch.properties:
                try:
                    await asyncio.wait_for(self.client.start_notify(ch, self._on_notify), 90)
                    self.notify_chars.append(ch)
                except BleakError as e:
                    if "ncryption" in str(e) or "uthentication" in str(e):
                        raise PairingRequired(str(e)) from e
                    if ch.uuid.lower() == P.OURA_NOTIFY:
                        raise
                    logger.debug("notify %s: %s", ch.uuid, e)
        if not self.notify_chars:
            raise RingError("Could not subscribe to any Oura notify characteristic")

    def _on_notify(self, _char, data: bytearray) -> None:
        self.fanout.publish(bytes(data))

    async def write(self, data: bytes) -> None:
        from bleak.exc import BleakError

        try:
            await asyncio.wait_for(self.client.write_gatt_char(self.write_char, data, response=True), 30)
        except BleakError as e:
            if "ncryption" in str(e):
                raise PairingRequired(str(e)) from e
            raise RingError(f"write failed: {e}") from e

    def subscribe(self) -> asyncio.Queue:
        return self.fanout.subscribe()

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.fanout.unsubscribe(q)

    async def close(self) -> None:
        try:
            for ch in self.notify_chars:
                try:
                    await asyncio.wait_for(self.client.stop_notify(ch), 5)
                except Exception:
                    pass
            await asyncio.wait_for(self.client.disconnect(), 10)
        except Exception:
            pass

    @property
    def connected(self) -> bool:
        try:
            return bool(self.client.is_connected)
        except Exception:
            return False


class MockTransport(Transport):
    """Scripted transport for tests: ``on(request_hex, [response_hex, ...])``."""

    def __init__(self) -> None:
        self.fanout = _Fanout()
        self.responses: Dict[str, List[str]] = {}
        self.writes: List[bytes] = []

    def on(self, request_hex: str, responses: List[str]) -> None:
        self.responses[request_hex.lower()] = responses

    async def write(self, data: bytes) -> None:
        self.writes.append(bytes(data))
        for r in self.responses.get(data.hex(), []):
            self.fanout.publish(bytes.fromhex(r))
            await asyncio.sleep(0)

    def subscribe(self) -> asyncio.Queue:
        return self.fanout.subscribe()

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.fanout.unsubscribe(q)


# --------------------------------------------------------------- client
Terminal = Callable[[P.Packet], bool]


class RingClient:
    def __init__(self, transport: Transport, quiet: float = 1.5, batch_quiet: float = 6.0):
        self.t = transport
        self.quiet = quiet
        self.batch_quiet = batch_quiet
        self.authenticated = False
        self.hardware_id: Optional[str] = None
        self.tx_log: List[str] = []

    # ------------------------------------------------------- transact
    async def request(self, data: bytes, terminal: Optional[Terminal] = None, quiet: Optional[float] = None) -> List[P.Packet]:
        """Write ``data`` and collect notifications until ``terminal`` matches or
        the link stays quiet for ``quiet`` seconds."""
        quiet = self.quiet if quiet is None else quiet
        q = self.t.subscribe()
        packets: List[P.Packet] = []
        try:
            await self.t.write(data)
            deadline = time.monotonic() + quiet
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    frame = await asyncio.wait_for(q.get(), remaining)
                except asyncio.TimeoutError:
                    break
                parsed = P.parse_many(frame)
                packets.extend(parsed)
                deadline = time.monotonic() + quiet  # quiet window restarts on traffic
                if terminal and any(terminal(p) for p in parsed):
                    break
        finally:
            self.t.unsubscribe(q)
        for p in packets:
            if P.is_auth_required(p):
                raise AuthRequired("ring requires app authentication for this command")
        return packets

    async def request_tag(self, data: bytes, tag: int) -> List[P.Packet]:
        return await self.request(data, lambda p: p.tag == tag)

    async def request_ext(self, data: bytes, ext: int) -> List[P.Packet]:
        return await self.request(data, lambda p: p.ext == ext)

    @staticmethod
    def _find(packets: List[P.Packet], tag: int) -> Optional[P.Packet]:
        return next((p for p in packets if p.tag == tag), None)

    @staticmethod
    def _find_ext(packets: List[P.Packet], ext: int) -> Optional[P.Packet]:
        return next((p for p in packets if p.ext == ext), None)

    # ----------------------------------------------------- device info
    async def firmware(self) -> P.DeviceInfo:
        packets = await self.request_tag(P.req_firmware(), 0x09)
        info = next((d for d in (P.DeviceInfo.parse(p) for p in packets) if d), None)
        if info is None:
            raise RingError("no firmware response")
        return info

    async def serial(self) -> str:
        packets = await self.request_tag(P.req_serial(), 0x19)
        val = next((s for s in (P.parse_product_ascii(p) for p in packets) if s), None)
        if val is None:
            raise RingError("no serial response")
        return val

    async def read_hardware_id(self) -> str:
        packets = await self.request_tag(P.req_hardware_id(), 0x19)
        val = next((s for s in (P.parse_product_ascii(p) for p in packets) if s), None)
        if val is None:
            raise RingError("no hardware-id response")
        self.hardware_id = val
        return val

    async def capabilities(self) -> Dict[int, int]:
        caps: Dict[int, int] = {}
        for page in (0, 1):
            packets = await self.request_ext(P.req_capabilities(page), 0x02)
            for p in packets:
                caps.update(P.parse_capabilities(p))
        return caps

    async def battery(self) -> P.Battery:
        packets = await self.request_tag(P.req_battery(), 0x0D)
        b = next((x for x in (P.Battery.parse(p) for p in packets) if x), None)
        if b is None:
            raise RingError("no battery response")
        return b

    # ------------------------------------------------------------ auth
    async def auth_nonce(self) -> bytes:
        packets = await self.request_ext(P.req_auth_nonce(), 0x2C)
        p = self._find_ext(packets, 0x2C)
        if p is None or len(p.payload) < 16:
            raise RingError("no auth nonce (is the link bonded?)")
        return bytes(p.payload[1:16])

    async def authenticate(self, key: bytes) -> None:
        nonce = await self.auth_nonce()
        proof = P.auth_proof(key, nonce)
        packets = await self.request_ext(P.req_authenticate(proof), 0x2E)
        p = self._find_ext(packets, 0x2E)
        if p is None or len(p.payload) < 2:
            raise RingError("no authenticate response")
        if p.payload[1] != 0:
            raise AuthFailed(p.payload[1])
        self.authenticated = True

    async def set_auth_key(self, key: bytes) -> None:
        packets = await self.request_tag(P.req_set_auth_key(key), 0x25)
        p = self._find(packets, 0x25)
        if p is None or not p.payload:
            raise RingError("no set_auth_key response (ring not factory-reset?)")
        if p.payload[0] != 0:
            raise RingError(f"set_auth_key refused with status {p.payload[0]}")

    # ------------------------------------------------------- session
    async def setup_app_stream(self) -> None:
        """Stream registration + parameter sweep as the phone app does."""
        try:
            await self.request_tag(P.req_stream_subscribe(0x02), 0x17)
            for cat, flags in P.APP_EVENT_CATEGORIES:
                await self.request_tag(P.req_event_subscribe(cat, flags), 0x19)
            for fid in (0x02, 0x04):
                await self.request_ext(P.req_feature_status(fid), 0x21)
            await self.request_ext(P.req_bundling(True), 0x04)
            for fid in (0x0B, 0x0D, 0x03, 0x0B, 0x10):
                await self.request_ext(P.req_feature_status(fid), 0x21)
        except AuthRequired:
            raise
        except RingError as e:
            logger.debug("app-stream setup incomplete: %s", e)

    async def sync_time(self) -> None:
        await self.request_tag(P.req_sync_time_app(), 0x13)

    async def set_notification(self, flags: int = 0xBF) -> None:
        await self.request_tag(P.req_set_notification(flags), 0x1D)

    async def data_flush(self, force: bool = False) -> None:
        await self.request_tag(P.req_data_flush(force), 0x29)

    async def feature_status(self, feature: int) -> P.FeatureStatus:
        packets = await self.request_ext(P.req_feature_status(feature), 0x21)
        st = next((s for s in (P.FeatureStatus.parse(p) for p in packets) if s), None)
        if st is None:
            raise RingError("no feature-status response")
        return st

    async def set_feature_mode(self, feature: int, mode: int) -> int:
        packets = await self.request_ext(P.req_set_feature_mode(feature, mode), 0x23)
        p = self._find_ext(packets, 0x23)
        if p is None or len(p.payload) < 3:
            raise RingError("no set_feature_mode response")
        return p.payload[2]

    async def feature_latest(self, feature: int) -> Dict[str, Optional[int]]:
        packets = await self.request_ext(P.req_feature_latest(feature), 0x25)
        p = self._find_ext(packets, 0x25)
        if p is None:
            raise RingError("no feature-latest response")
        data = p.payload[7:]
        out: Dict[str, Optional[int]] = {"bpm": None, "spo2": None}
        if feature == 0x02 and len(data) >= 2:
            ibi = data[0] | (data[1] << 8)
            out["bpm"] = 60000 // ibi if 300 <= ibi <= 2000 else None
        elif feature == 0x03 and len(data) >= 5 and data[4]:
            out["bpm"] = data[4]
        elif feature == 0x04 and len(data) >= 5:
            out["spo2"] = data[3] or None
            out["bpm"] = data[4] or None
        return out

    # ------------------------------------------------------- history
    async def drain_events(
        self,
        cursor: int,
        on_event: Callable[[RingEvent], None],
        on_batch: Optional[Callable[[int, int, int], Awaitable[None]]] = None,
        max_batches: int = 100_000,
    ) -> Dict[str, int]:
        """Pull every history event newer than ``cursor``.

        Uses the legacy ``GetEvent`` API (works on Ring 3/4/5). After each
        batch the ring's summary packet reports ``bytes_left``; the cursor is
        advanced to ``max(ring_ts) + 1`` and acknowledged so the ring can drop
        the delivered events. ``on_batch(next_cursor, bytes_left, total)`` is
        awaited after every batch so callers can checkpoint.
        """
        total = 0
        start = cursor
        terminal = lambda p: p.tag == 0x11  # noqa: E731
        for _ in range(max_batches):
            await self.data_flush()
            packets = await self.request(P.req_get_event(start, 255, -1), terminal, self.batch_quiet)
            summary = next((s for s in (P.EventBatchSummary.parse(p) for p in packets) if s), None)
            if summary is None:
                raise RingError(f"batch ended without a summary packet (link lost?) — cursor {start} is checkpointed")
            newest = None
            for p in packets:
                ev = RingEvent.from_packet(p)
                if ev is None:
                    continue
                if ev.ring_ts < start:
                    continue  # stale replay from a previous batch
                on_event(ev)
                total += 1
                newest = ev.ring_ts if newest is None else max(newest, ev.ring_ts)
            progressed = newest is not None and newest + 1 > start
            if progressed:
                start = newest + 1
                try:
                    await self.request_tag(P.req_get_event_ack(start), 0x11)
                except RingError:
                    pass
            if on_batch:
                await on_batch(start, summary.bytes_left, total)
            if summary.bytes_left == 0:
                break
            if not progressed:
                logger.warning("ring reports %d bytes left but sent no events; stopping", summary.bytes_left)
                break
        return {"events": total, "next_cursor": start}

    # ----------------------------------------------------------- live
    async def live_heart_rate(self, duration: float, on_sample: Callable[[P.HeartRateSample], None]) -> None:
        q = self.t.subscribe()
        try:
            await self.t.write(P.req_set_feature_mode(0x02, P.MODE_CONNECTED_LIVE))
            deadline = time.monotonic() + duration
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    frame = await asyncio.wait_for(q.get(), remaining)
                except asyncio.TimeoutError:
                    break
                for p in P.parse_many(frame):
                    s = P.parse_live_hr(p)
                    if s:
                        on_sample(s)
        finally:
            self.t.unsubscribe(q)
            try:
                await self.t.write(P.req_set_feature_mode(0x02, P.MODE_AUTOMATIC))
            except Exception:
                pass

    async def stream_accelerometer(self, duration: float, on_sample: Callable[[P.AcmSample], None]) -> None:
        q = self.t.subscribe()
        try:
            minutes = max(1, int(duration // 60) + 1)
            await self.t.write(P.req_realtime(P.REALTIME_ACM, minutes, 0))
            deadline = time.monotonic() + duration
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    frame = await asyncio.wait_for(q.get(), remaining)
                except asyncio.TimeoutError:
                    break
                for p in P.parse_many(frame):
                    for s in P.parse_acm(p):
                        on_sample(s)
        finally:
            self.t.unsubscribe(q)
            try:
                await self.t.write(P.req_realtime_off())
            except Exception:
                pass
