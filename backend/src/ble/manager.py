"""Ring manager: owns the BLE connection lifecycle and exposes a status model.

States: ``idle → scanning → connecting → pairing → authenticating → syncing
→ idle`` (or ``live`` while streaming) with ``error`` on failure. Everything
runs inside the API's event loop; long operations are asyncio tasks so HTTP
handlers return immediately and the UI polls ``status()`` or listens on the
event stream.

Key material: the 16-byte app-auth key is generated here on first pairing and
stored in ``<user data dir>/ring-<serial>.key`` with mode 0600. It never leaves
this machine and is never logged.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import deque
from datetime import datetime
from typing import Any, Callable, Deque, Dict, List, Optional

from ..config import config_manager
from ..database import SessionLocal
from ..paths import get_user_data_dir
from . import protocol as P
from .client import AuthFailed, AuthRequired, BleakTransport, PairingRequired, RingClient, RingError
from .events import RingEvent
from .store import backfill_times, derive, get_state, load_anchor, save_anchor, store_events

logger = logging.getLogger("RingManager")

STATES = ("idle", "scanning", "connecting", "pairing", "authenticating", "syncing", "live", "error", "unavailable")


class RingManager:
    def __init__(self) -> None:
        self.state = "idle"
        self.message = ""
        self.error: Optional[str] = None
        self.progress: Optional[Dict[str, Any]] = None
        self.devices: List[Dict[str, Any]] = []
        self.device_index: Dict[str, Any] = {}  # address -> BLEDevice
        self.ring: Dict[str, Any] = {}  # identity of the connected/last ring
        self.log: Deque[Dict[str, Any]] = deque(maxlen=200)
        self.live_samples: Deque[Dict[str, Any]] = deque(maxlen=600)
        self._task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
        self._listeners: List[asyncio.Queue] = []
        self._client: Optional[RingClient] = None
        self._bleak_client = None
        self.last_scan_at: Optional[float] = None
        self.bluetooth_ok: Optional[bool] = None
        self.stop_event: Optional["asyncio.Event"] = None

    # ------------------------------------------------------------ status
    def _set(self, state: str, message: str = "", **extra: Any) -> None:
        if state not in STATES:
            raise ValueError(state)
        self.state = state
        self.message = message
        if state != "error":
            self.error = None
        for k, v in extra.items():
            setattr(self, k, v)
        self._emit({"type": "state", "state": state, "message": message, "progress": self.progress})

    def _fail(self, message: str, exc: Optional[BaseException] = None) -> None:
        self.error = message
        self.progress = None
        self.state = "error"
        self.message = message
        self._log("error", message)
        if exc:
            logger.error("%s: %s", message, exc)
        self._emit({"type": "state", "state": "error", "message": message})

    def _log(self, level: str, msg: str) -> None:
        entry = {"ts": datetime.now().isoformat(timespec="seconds"), "level": level, "msg": msg}
        self.log.append(entry)
        getattr(logger, level if level in ("debug", "info", "warning", "error") else "info")(msg)
        self._emit({"type": "log", **entry})

    def _emit(self, event: Dict[str, Any]) -> None:
        for q in list(self._listeners):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def listen(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._listeners.append(q)
        return q

    def unlisten(self, q: asyncio.Queue) -> None:
        try:
            self._listeners.remove(q)
        except ValueError:
            pass

    def status(self) -> Dict[str, Any]:
        cfg = config_manager.get_config()
        paired = self.paired_serials()
        return {
            "state": self.state,
            "message": self.message,
            "error": self.error,
            "progress": self.progress,
            "busy": bool(self._task and not self._task.done()),
            "devices": self.devices,
            "ring": self.ring,
            "paired_serials": paired,
            "preferred_address": cfg.get("ble_ring_address"),
            "auto_sync": bool(cfg.get("ble_auto_sync", False)),
            "last_scan_at": self.last_scan_at,
            "bluetooth_ok": self.bluetooth_ok,
            "log": list(self.log)[-30:],
            "live_samples": list(self.live_samples)[-120:],
            "connected": bool(self._bleak_client and getattr(self._bleak_client, "is_connected", False)),
        }

    # -------------------------------------------------------------- keys
    def _key_path(self, serial: str) -> str:
        return os.path.join(get_user_data_dir(), f"ring-{serial}.key")

    def paired_serials(self) -> List[str]:
        out = []
        for f in os.listdir(get_user_data_dir()):
            if f.startswith("ring-") and f.endswith(".key"):
                out.append(f[5:-4])
        return sorted(out)

    def _load_key(self, serial: str) -> Optional[bytes]:
        p = self._key_path(serial)
        if not os.path.exists(p):
            return None
        return bytes.fromhex(open(p, "r", encoding="utf-8").read().strip())

    def _save_key(self, serial: str, key: bytes) -> None:
        p = self._key_path(serial)
        with open(p, "w", encoding="utf-8") as f:
            f.write(key.hex() + "\n")
        os.chmod(p, 0o600)

    def forget(self, serial: str) -> bool:
        p = self._key_path(serial)
        if os.path.exists(p):
            os.remove(p)
            self._log("info", f"Forgot key for ring {serial}")
            return True
        return False

    # -------------------------------------------------------------- tasks
    def _start(self, coro_factory: Callable[[], Any], name: str) -> bool:
        if self._task and not self._task.done():
            return False

        async def runner():
            try:
                await coro_factory()
            except asyncio.CancelledError:
                self._set("idle", "Cancelled")
                raise
            except PairingRequired as e:
                self._fail(
                    "macOS did not pair with the ring. A ring that is already set up with the Oura app only accepts "
                    "its phone; to use it here, factory-reset the ring first (see the Ring page), then pair again.",
                    e,
                )
            except AuthFailed as e:
                self._fail(f"The ring rejected this app's key ({P.auth_result_name(e.code)}). If the ring was re-onboarded in the Oura app, it needs a factory reset before it can be paired here again.", e)
            except AuthRequired as e:
                self._fail("The ring has a key installed that this app does not have. Factory-reset the ring, then pair it here.", e)
            except RingError as e:
                self._fail(str(e), e)
            except Exception as e:  # noqa: BLE001
                self._fail(f"{name} failed: {e}", e)
            finally:
                await self._disconnect()

        self._task = asyncio.create_task(runner(), name=name)
        return True

    async def cancel(self) -> bool:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            return True
        return False

    async def shutdown(self) -> None:
        await self.cancel()
        await self._disconnect()

    # --------------------------------------------------------------- scan
    async def scan(self, duration: float = 12.0) -> List[Dict[str, Any]]:
        from bleak import BleakScanner

        self._set("scanning", f"Scanning for rings ({int(duration)} s)…")
        found: Dict[str, Dict[str, Any]] = {}
        index: Dict[str, Any] = {}

        def cb(dev, adv):
            svcs = [s.lower() for s in adv.service_uuids]
            name = dev.name or adv.local_name
            is_ring = P.OURA_SERVICE in svcs or (name or "").lower().startswith("oura") and P.CHARGER_SERVICE not in svcs
            is_charger = P.CHARGER_SERVICE in svcs
            has_cid = P.OURA_COMPANY_ID in adv.manufacturer_data
            if not (is_ring or is_charger or has_cid):
                return
            mfr = adv.manufacturer_data.get(P.OURA_COMPANY_ID, b"").hex()
            found[dev.address] = {
                "address": dev.address,
                "name": name,
                "rssi": adv.rssi,
                "is_ring": bool(is_ring or (has_cid and not is_charger)),
                "is_charger": bool(is_charger),
                "manufacturer_hex": mfr,
                "seen_at": time.time(),
            }
            index[dev.address] = dev

        try:
            scanner = BleakScanner(cb)
            await scanner.start()
            await asyncio.sleep(duration)
            await scanner.stop()
            self.bluetooth_ok = True
        except Exception as e:  # noqa: BLE001
            self.bluetooth_ok = False
            raise RingError(f"Bluetooth scan failed: {e}. On macOS, allow Bluetooth for this app in System Settings → Privacy & Security → Bluetooth.") from e
        self.devices = sorted(found.values(), key=lambda d: -d["rssi"])
        self.device_index = index
        self.last_scan_at = time.time()
        rings = [d for d in self.devices if d["is_ring"]]
        self._log("info", f"Scan finished: {len(rings)} ring(s), {len(self.devices) - len(rings)} charger(s)")
        self._set("idle", "Scan complete" if rings else "No ring found. Put the ring on its charger and keep the phone's Bluetooth off while pairing.")
        return self.devices

    def start_scan(self, duration: float = 12.0) -> bool:
        return self._start(lambda: self.scan(duration), "scan")

    # ------------------------------------------------------------ connect
    async def _open_transport(self, address: Optional[str]):
        """Find the ring and open a BLE transport. Returns (transport, address, name).

        Kept separate so tests can inject a simulated ring.
        """
        from bleak import BleakClient, BleakScanner

        target = self.device_index.get(address) if address else None
        if target is None:
            self._set("scanning", "Looking for the ring…")
            target = await BleakScanner.find_device_by_filter(
                lambda d, ad: (address and d.address == address) or (not address and P.OURA_SERVICE in [s.lower() for s in ad.service_uuids]),
                timeout=20.0,
            )
            if target is None:
                raise RingError("Ring not found. Place it on the charger, make sure it is not connected to a phone, and try again.")
        self._set("connecting", f"Connecting to {target.name or target.address}…")
        client = BleakClient(target, timeout=45.0, disconnected_callback=lambda c: self._log("warning", "Ring disconnected"))
        await client.connect()
        self._bleak_client = client
        transport = BleakTransport(client)
        self._set("pairing", "Connected. If macOS asks to pair with the ring, click Connect.")
        await transport.setup()  # may trigger the macOS pairing prompt
        return transport, target.address, target.name

    async def _connect(self, address: Optional[str]) -> RingClient:
        transport, addr, name = await self._open_transport(address)
        rc = RingClient(transport)
        self._client = rc
        info = await rc.firmware()
        hw = ""
        try:
            hw = await rc.read_hardware_id()
        except RingError:
            pass
        try:
            serial = await rc.serial()
        except RingError:
            serial = info.mac.replace(":", "")
        self.ring = {
            "serial": serial,
            "hardware_id": hw,
            "model": P.hardware_family(hw),
            "firmware_version": info.firmware_version,
            "api_version": info.api_version,
            "bt_stack_version": info.bt_stack_version,
            "mac": info.mac,
            "address": addr,
            "name": name,
        }
        self._log("info", f"Ring {self.ring['model']} serial {serial} fw {info.firmware_version}")
        config_manager.update_config(ble_ring_address=addr)
        return rc

    async def _disconnect(self) -> None:
        if self._client is not None:
            try:
                await self._client.t.close()
            except Exception:
                pass
        self._client = None
        self._bleak_client = None

    # ---------------------------------------------------------------- pair
    async def pair(self, address: Optional[str]) -> Dict[str, Any]:
        """Bond + install our key on a factory-reset ring (or verify an existing key)."""
        rc = await self._connect(address)
        serial = self.ring["serial"]
        key = self._load_key(serial)
        self._set("authenticating", "Authenticating…")
        if key is None:
            key = P.generate_auth_key()
            try:
                await rc.set_auth_key(key)
            except RingError as e:
                raise RingError(
                    "This ring already has a key installed by another app (probably the Oura app). To use it here, "
                    "factory-reset the ring and pair again. Details: " + str(e)
                ) from e
            self._save_key(serial, key)
            self._log("info", f"Installed a new key on ring {serial}")
            await rc.authenticate(key)
        else:
            try:
                await rc.authenticate(key)
            except AuthFailed as e:
                if e.code != 2:  # 2 = ring is factory-reset (no key installed)
                    raise
                self._log("info", "Ring was reset; re-installing this app's existing key")
                await rc.set_auth_key(key)
                await rc.authenticate(key)
        self._log("info", "Authenticated with the ring")
        # Make sure the measurement features that produce data are running.
        enabled = []
        for fid in (0x02, 0x04, 0x08, 0x0B, 0x03):
            try:
                st = await rc.feature_status(fid)
                if st.mode == P.MODE_OFF:
                    res = await rc.set_feature_mode(fid, P.MODE_AUTOMATIC)
                    if res == 0:
                        enabled.append(P.FEATURES.get(fid, hex(fid)))
            except (RingError, AuthRequired):
                continue
        if enabled:
            self._log("info", "Enabled features: " + ", ".join(enabled))
        try:
            await rc.sync_time()
        except RingError:
            pass
        try:
            b = await rc.battery()
            self.ring["battery_percent"] = b.percent
        except (RingError, AuthRequired):
            pass
        db = SessionLocal()
        try:
            st = get_state(db, serial)
            st.name, st.hardware_id, st.firmware_version, st.mac = self.ring.get("name"), self.ring.get("hardware_id"), self.ring.get("firmware_version"), self.ring.get("mac")
            if self.ring.get("battery_percent") is not None:
                st.battery_percent, st.battery_at = self.ring["battery_percent"], datetime.now()
            db.commit()
        finally:
            db.close()
        self._set("idle", f"Paired with {self.ring['model']} ({serial}).")
        return self.ring

    def start_pair(self, address: Optional[str]) -> bool:
        return self._start(lambda: self.pair(address), "pair")

    # ---------------------------------------------------------------- sync
    async def sync(self, address: Optional[str] = None, full: bool = False) -> Dict[str, Any]:
        rc = await self._connect(address)
        serial = self.ring["serial"]
        key = self._load_key(serial)
        if key is None:
            raise RingError("This ring is not paired with this app yet. Use Pair first.")
        self._set("authenticating", "Authenticating…")
        await rc.authenticate(key)
        try:
            await rc.setup_app_stream()
        except AuthRequired:
            pass
        host_now = time.time()
        try:
            await rc.sync_time()
        except RingError:
            pass
        try:
            b = await rc.battery()
            self.ring["battery_percent"] = b.percent
        except (RingError, AuthRequired):
            b = None

        db = SessionLocal()
        try:
            st = get_state(db, serial)
            st.name, st.hardware_id, st.firmware_version, st.mac = self.ring.get("name"), self.ring.get("hardware_id"), self.ring.get("firmware_version"), self.ring.get("mac")
            if b is not None:
                st.battery_percent, st.battery_at = b.percent, datetime.now()
            anchor = load_anchor(st)
            cursor = 0 if full else int(st.next_cursor or 0)
            db.commit()
            self._set("syncing", "Downloading history from the ring…", progress={"events": 0, "bytes_left": None})
            buffer: List[RingEvent] = []
            stats = {"events": 0, "inserted": 0}
            started = time.time()

            def on_event(ev: RingEvent) -> None:
                buffer.append(ev)

            async def on_batch(next_cursor: int, bytes_left: int, total: int) -> None:
                if buffer:
                    # anchor on our own time-sync if the ring has not told us the time yet
                    if anchor.ring_ts is None and buffer[-1].tag != 0x85:
                        anchor.observe_host(buffer[-1].ring_ts, host_now)
                    stats["inserted"] += store_events(db, serial, buffer, anchor)
                    stats["events"] += len(buffer)
                    buffer.clear()
                st.next_cursor = next_cursor
                save_anchor(st, anchor)
                st.events_total = (st.events_total or 0) + total - stats.get("_last_total", 0)
                stats["_last_total"] = total
                db.commit()
                self.progress = {"events": stats["events"], "new": stats["inserted"], "bytes_left": bytes_left, "elapsed_s": int(time.time() - started)}
                self._emit({"type": "state", "state": "syncing", "message": self.message, "progress": self.progress})

            outcome = await rc.drain_events(cursor, on_event, on_batch)
            backfilled = backfill_times(db, serial, anchor)
            st.last_sync_at = datetime.now()
            st.next_cursor = outcome["next_cursor"]
            save_anchor(st, anchor)
            db.commit()
            self._set("syncing", "Building sleep, heart-rate and activity records…")
            derived = await asyncio.to_thread(_derive_in_new_session, serial)
            self._log("info", f"Sync done: {stats['events']} events ({stats['inserted']} new, {backfilled} re-timed); derived {derived}")
            config_manager.update_sync("done", method="ring", message=f"Ring sync complete: {stats['inserted']} new events", summary={"events": stats, "derived": derived})
            self._set("idle", f"Synced {stats['inserted']} new events from the ring.", progress=None)
            return {"events": stats, "derived": derived, "next_cursor": outcome["next_cursor"]}
        finally:
            db.close()

    def start_sync(self, address: Optional[str] = None, full: bool = False) -> bool:
        return self._start(lambda: self.sync(address, full), "sync")

    # ---------------------------------------------------------------- live
    async def live(self, address: Optional[str], duration: float = 60.0) -> None:
        rc = await self._connect(address)
        serial = self.ring["serial"]
        key = self._load_key(serial)
        if key is None:
            raise RingError("Pair the ring first.")
        self._set("authenticating", "Authenticating…")
        await rc.authenticate(key)
        self._set("live", f"Streaming live heart rate for {int(duration)} s… (wear the ring)")
        self.live_samples.clear()

        def on_sample(s: P.HeartRateSample) -> None:
            entry = {"t": time.time(), "bpm": s.bpm, "ibi_ms": s.ibi_ms}
            self.live_samples.append(entry)
            self._emit({"type": "hr", **entry})

        await rc.live_heart_rate(duration, on_sample)
        self._set("idle", f"Live session ended ({len(self.live_samples)} beats).")

    def start_live(self, address: Optional[str], duration: float = 60.0) -> bool:
        return self._start(lambda: self.live(address, duration), "live")

    async def live_session(self, address: Optional[str], duration: float, streams=("acm", "hr"), simulate: Optional[str] = None) -> Dict[str, Any]:
        """Stream accelerometer and/or beats for ``duration`` seconds, emitting batches.

        ``simulate`` names a synthetic scenario ('still', 'tremor', 'walk', 'run',
        'reps') and bypasses Bluetooth entirely (development and tests)."""
        from .live import LiveSession

        if simulate:
            from .simulator import SimulatedRing

            ring = SimulatedRing(scenario=str(simulate))
            rc = RingClient(ring, quiet=0.2)
            self._client = rc
            self.ring = {"serial": f"SIM-{simulate}", "model": "Simulated ring", "simulated": True}
            self._set("connecting", f"Simulated ring ({simulate})")
        else:
            rc = await self._connect(address)
            key = self._load_key(self.ring["serial"])
            if key is None:
                raise RingError("Pair the ring first.")
            self._set("authenticating", "Authenticating…")
            await rc.authenticate(key)
        self._set("live", f"Live session ({', '.join(streams)}) for {int(duration)} s… wear the ring.")
        self.stop_event = asyncio.Event()
        serial = self.ring["serial"]
        db = None if simulate else SessionLocal()  # simulated rings leave no trace in the ring tables
        try:
            if db is not None:
                st = get_state(db, serial)
                anchor = load_anchor(st)
                db.commit()
            host_now = time.time()
            mem_cursor = {"next": 0}

            async def drain() -> List[RingEvent]:
                """One history pull; events are stored losslessly and the cursor advanced,
                exactly like a sync, so nothing the ring records during the session is lost."""
                got: List[RingEvent] = []
                stored = {"n": 0}
                cursor = int(st.next_cursor or 0) if db is not None else mem_cursor["next"]

                async def on_batch(next_cursor: int, bytes_left: int, total: int) -> None:
                    if db is None:
                        mem_cursor["next"] = next_cursor
                        return
                    fresh = got[stored["n"]:]
                    if fresh:
                        if anchor.ring_ts is None and fresh[-1].tag != 0x85:
                            anchor.observe_host(fresh[-1].ring_ts, host_now)
                        store_events(db, serial, fresh, anchor)
                        stored["n"] = len(got)
                    st.next_cursor = next_cursor
                    save_anchor(st, anchor)
                    db.commit()

                await rc.drain_events(cursor, got.append, on_batch, max_batches=3)
                return got

            session = LiveSession(rc, streams, emit=self._emit, stop_event=self.stop_event, drain=drain)
            summary = await session.run(duration)
            summary["serial"] = serial
        finally:
            if db is not None:
                db.close()
        src = summary.get("hr_source") or "none"
        self._set("idle", f"Live session ended: {summary['acm_samples']} accelerometer samples, {summary['beats']} beats (source: {src}).")
        return summary

    # ---------------------------------------------------------- info only
    async def probe(self, address: Optional[str]) -> Dict[str, Any]:
        """Read-only identification: firmware, hardware, whether a key is installed."""
        rc = await self._connect(address)
        result = dict(self.ring)
        result["paired_here"] = self._load_key(self.ring["serial"]) is not None
        try:
            await rc.battery()
            result["key_installed"] = False
            result["battery_readable_without_auth"] = True
        except AuthRequired:
            result["key_installed"] = True
        except RingError:
            result["key_installed"] = None
        self._set("idle", "Probe complete")
        return result

    def start_probe(self, address: Optional[str]) -> bool:
        return self._start(lambda: self.probe(address), "probe")


def _derive_in_new_session(serial: str) -> Dict[str, int]:
    db = SessionLocal()
    try:
        return derive(db, serial)
    finally:
        db.close()


ring_manager = RingManager()
