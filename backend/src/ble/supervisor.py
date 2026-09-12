"""Supervises BLE worker processes and mirrors their state for the API.

Public surface matches what ``ble_routes`` needs from the in-process
``RingManager`` (status, start_*, cancel, listen/unlisten, paired_serials,
forget, shutdown). Each operation runs in a child process (see ``worker.py``);
its JSON-line events are relayed to SSE listeners and folded into ``status()``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import time
from collections import deque
from datetime import datetime
from typing import Any, Deque, Dict, List, Optional

from ..config import config_manager
from ..paths import get_user_data_dir

logger = logging.getLogger("RingSupervisor")

# Generous per-operation ceilings; a worker blocked on the macOS permission dialog
# or a ring that never answers is stopped instead of hanging forever.
OP_TIMEOUTS = {"scan": 90.0, "probe": 180.0, "pair": 300.0, "sync": 1800.0, "live": 900.0, "live_session": 120.0}

PERMISSION_HINT = (
    "Bluetooth is not available to this app. On macOS open System Settings → Privacy & Security → Bluetooth and "
    "allow Cracked Oura (when running from a terminal, allow the terminal app), then try again."
)


def _worker_argv(cmd: Dict[str, Any]) -> List[str]:
    payload = json.dumps(cmd)
    if getattr(sys, "frozen", False):
        return [sys.executable, "--ble-worker", payload]
    return [sys.executable, "-m", "backend.src.ble.worker", payload]


def _repo_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


class RingSupervisor:
    def __init__(self) -> None:
        self.state = "idle"
        self.message = ""
        self.error: Optional[str] = None
        self.progress: Optional[Dict[str, Any]] = None
        self.devices: List[Dict[str, Any]] = []
        self.ring: Dict[str, Any] = {}
        self.log: Deque[Dict[str, Any]] = deque(maxlen=200)
        self.live_samples: Deque[Dict[str, Any]] = deque(maxlen=600)
        self.last_scan_at: Optional[float] = None
        self.bluetooth_ok: Optional[bool] = None
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._task: Optional[asyncio.Task] = None
        self._listeners: List[asyncio.Queue] = []
        self._current_op: Optional[str] = None
        # Live session state (rolling buffers for the UI; the worker keeps the full record)
        self.live: Dict[str, Any] = {"active": False}
        self._live_acm: Deque[List[int]] = deque(maxlen=50 * 30)
        self._live_ibi: Deque[List[float]] = deque(maxlen=300)
        self._live_last_snapshot = 0.0

    # ------------------------------------------------------------ events
    def _emit(self, ev: Dict[str, Any]) -> None:
        for q in list(self._listeners):
            try:
                q.put_nowait(ev)
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

    def _log(self, level: str, msg: str) -> None:
        entry = {"ts": datetime.now().isoformat(timespec="seconds"), "level": level, "msg": msg}
        self.log.append(entry)
        self._emit({"type": "log", **entry})

    def _apply(self, ev: Dict[str, Any]) -> None:
        t = ev.get("type")
        if t == "state":
            self.state = ev.get("state", self.state)
            self.message = ev.get("message", "")
            self.progress = ev.get("progress")
            if self.state == "error":
                self.error = self.message
            else:
                self.error = None
        elif t == "log":
            self.log.append({k: ev.get(k) for k in ("ts", "level", "msg")})
        elif t == "hr":
            self.live_samples.append({k: ev.get(k) for k in ("t", "bpm", "ibi_ms")})
            if self.live.get("active"):
                self._live_ibi.append([float(ev.get("t") or 0), float(ev.get("ibi_ms") or 0)])
                self.live["beats"] = self.live.get("beats", 0) + 1
                self.live["last_bpm"] = ev.get("bpm")
        elif t == "acm":
            if self.live.get("active"):
                self._live_acm.extend(ev.get("samples") or [])
                self.live["fs"] = ev.get("fs")
                self.live["acm_samples"] = ev.get("n_total")
                self.live["t"] = ev.get("t")
            self._maybe_snapshot()
        elif t == "result":
            if self._current_op == "live_session":
                self._finish_live(ev)
            if ev.get("devices") is not None and self._current_op == "scan":
                self.devices = ev["devices"]
                self.last_scan_at = time.time()
            if ev.get("ring"):
                self.ring = ev["ring"]
            if ev.get("bluetooth_ok") is not None:
                self.bluetooth_ok = ev["bluetooth_ok"]
            self.state = ev.get("state", "idle")
            self.message = ev.get("message", "")
            self.error = ev.get("error")
            self.progress = None
        self._emit(ev)

    # -------------------------------------------------------------- live
    def _maybe_snapshot(self) -> None:
        now = time.time()
        if now - self._live_last_snapshot < 2.0 or not self.live.get("active"):
            return
        self._live_last_snapshot = now
        try:
            from ..analysis.session_metrics import snapshot

            fs = float(self.live.get("fs") or 50.0)
            snap = snapshot(list(self._live_acm)[-int(fs * 10) :], list(self._live_ibi)[-60:], fs, self.live.get("scale"))
            if snap.get("scale_g_per_lsb") and not self.live.get("scale"):
                self.live["scale"] = snap["scale_g_per_lsb"]
            self.live["snapshot"] = snap
            self._emit({"type": "analysis", **snap, "t": self.live.get("t")})
        except Exception as e:  # noqa: BLE001
            logger.debug("snapshot failed: %s", e)

    def _finish_live(self, ev: Dict[str, Any]) -> None:
        data = ev.get("data") or {}
        live = self.live
        live["active"] = False
        if not ev.get("ok") or not data:
            live["last_error"] = ev.get("error")
            return
        try:
            from ..analysis.session_metrics import acm_preview, compute_metrics
            from ..database import SessionLocal
            from ..models import LiveSession as LiveSessionRow

            fs = float(data.get("fs_hz") or 50.0)
            metrics = compute_metrics(live.get("kind", "free"), data.get("acm") or [], data.get("ibi") or [], fs, live.get("scale"))
            metrics["preview"] = acm_preview(data.get("acm") or [], fs, metrics.get("scale_g_per_lsb"))
            db = SessionLocal()
            try:
                row = LiveSessionRow(
                    id=live["id"], serial=(self.ring or {}).get("serial"), kind=live.get("kind", "free"),
                    simulated=bool(live.get("simulate")), started_at=datetime.fromtimestamp(live["started"]),
                    ended_at=datetime.now(), duration_s=data.get("duration_s"), fs_hz=fs,
                    scale_g_per_lsb=metrics.get("scale_g_per_lsb"), acm=data.get("acm"), ibi=data.get("ibi"), metrics=metrics,
                )
                db.merge(row)
                db.commit()
            finally:
                db.close()
            live["saved_id"] = live["id"]
            live["metrics"] = {k: v for k, v in metrics.items() if k not in ("timeline", "rmssd_series", "hr_series", "preview")}
            self._emit({"type": "session_saved", "id": live["id"], "kind": live.get("kind")})
        except Exception as e:  # noqa: BLE001
            logger.exception("Could not persist live session")
            live["last_error"] = f"Session analysis failed: {e}"

    def start_live_session(self, kind: str, duration: float, streams: List[str], address: Optional[str] = None, simulate: Optional[str] = None) -> Optional[str]:
        import uuid

        if self.busy:
            return None
        sid = uuid.uuid4().hex[:12]
        self._live_acm.clear()
        self._live_ibi.clear()
        self.live_samples.clear()
        self.live = {"active": True, "id": sid, "kind": kind, "started": time.time(), "duration": duration, "streams": streams, "simulate": simulate, "beats": 0, "acm_samples": 0}
        ok = self._start({"op": "live_session", "duration": duration, "streams": streams, "address": address, "simulate": simulate})
        if not ok:
            self.live = {"active": False}
            return None
        return sid

    def stop_live(self) -> bool:
        """Ask a running live session to finish now; its data is still saved."""
        if not (self.busy and self._current_op == "live_session" and self._proc and self._proc.returncode is None):
            return False
        self.live["stopping"] = True
        try:
            self._proc.terminate()
        except ProcessLookupError:
            return False
        return True

    def live_status(self) -> Dict[str, Any]:
        fs = float(self.live.get("fs") or 50.0)
        tail = list(self._live_acm)[-int(fs * 5) :]
        return {
            **{k: v for k, v in self.live.items() if k != "snapshot"},
            "snapshot": self.live.get("snapshot"),
            "state": self.state,
            "message": self.message,
            "error": self.error or self.live.get("last_error"),
            "busy": self.busy,
            "recent_hr": list(self.live_samples)[-60:],
            "recent_acm": tail,
        }

    # ------------------------------------------------------------ status
    def status(self) -> Dict[str, Any]:
        cfg = config_manager.get_config()
        return {
            "state": self.state,
            "message": self.message,
            "error": self.error,
            "progress": self.progress,
            "busy": self.busy,
            "devices": self.devices,
            "ring": self.ring,
            "paired_serials": self.paired_serials(),
            "preferred_address": cfg.get("ble_ring_address"),
            "auto_sync": bool(cfg.get("ble_auto_sync", False)),
            "last_scan_at": self.last_scan_at,
            "bluetooth_ok": self.bluetooth_ok,
            "log": list(self.log)[-30:],
            "live_samples": list(self.live_samples)[-120:],
            "connected": self.busy and self.state in ("connecting", "pairing", "authenticating", "syncing", "live"),
        }

    @property
    def busy(self) -> bool:
        return bool(self._task and not self._task.done())

    # -------------------------------------------------------------- keys
    def paired_serials(self) -> List[str]:
        return sorted(f[5:-4] for f in os.listdir(get_user_data_dir()) if f.startswith("ring-") and f.endswith(".key"))

    def forget(self, serial: str) -> bool:
        p = os.path.join(get_user_data_dir(), f"ring-{serial}.key")
        if os.path.exists(p):
            os.remove(p)
            self._log("info", f"Forgot key for ring {serial}")
            return True
        return False

    # ------------------------------------------------------------ control
    def _start(self, cmd: Dict[str, Any]) -> bool:
        if self.busy:
            return False
        self._current_op = cmd["op"]
        self.error = None
        self.state = {"scan": "scanning", "live": "connecting", "live_session": "connecting"}.get(cmd["op"], "connecting")
        self.message = "Starting…"
        self.progress = None
        if cmd["op"] == "live":
            self.live_samples.clear()
        self._task = asyncio.create_task(self._run(cmd), name=f"ble-{cmd['op']}")
        return True

    async def _run(self, cmd: Dict[str, Any]) -> None:
        env = dict(os.environ)
        env["PYTHONUNBUFFERED"] = "1"
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *_worker_argv(cmd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=None if getattr(sys, "frozen", False) else _repo_root(),
                env=env,
            )
        except Exception as e:  # noqa: BLE001
            self._finish_error(f"Could not start the Bluetooth worker: {e}")
            return
        got_result = False
        stderr_tail: Deque[str] = deque(maxlen=20)

        async def drain_stderr():
            assert self._proc and self._proc.stderr
            async for line in self._proc.stderr:
                stderr_tail.append(line.decode("utf-8", "replace").rstrip())

        err_task = asyncio.create_task(drain_stderr())
        timeout = OP_TIMEOUTS.get(cmd.get("op", ""), 600.0) + float(cmd.get("duration", 0) or 0)

        async def read_events():
            assert self._proc and self._proc.stdout
            async for raw in self._proc.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self._apply(ev)
                if ev.get("type") == "result":
                    return True
            return False

        try:
            try:
                got_result = await asyncio.wait_for(read_events(), timeout)
            except asyncio.TimeoutError:
                self._kill()
                self._finish_error(
                    f"The Bluetooth operation did not finish within {int(timeout)} s and was stopped. "
                    "If macOS is asking whether Cracked Oura may use Bluetooth, click Allow and try again; "
                    "otherwise put the ring on its charger and retry."
                )
                got_result = True  # error already reported
            rc = await self._proc.wait()
        except asyncio.CancelledError:
            self._kill()
            self.live["active"] = False
            self.state, self.message, self.progress = "idle", "Cancelled", None
            self._emit({"type": "state", "state": "idle", "message": "Cancelled"})
            raise
        finally:
            err_task.cancel()
        if not got_result:
            if rc is not None and rc < 0 and -rc in (signal.SIGABRT, signal.SIGKILL, signal.SIGTRAP):
                self.bluetooth_ok = False
                self._finish_error(PERMISSION_HINT, state="unavailable")
            else:
                tail = " | ".join(list(stderr_tail)[-3:])
                self._finish_error(f"The Bluetooth worker exited unexpectedly (code {rc}). {tail}".strip())
        self._proc = None

    def _finish_error(self, message: str, state: str = "error") -> None:
        self.state, self.message, self.error, self.progress = state, message, message, None
        self._log("error", message)
        self._emit({"type": "state", "state": state, "message": message})

    def _kill(self) -> None:
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass

    async def cancel(self) -> bool:
        if not self.busy:
            return False
        assert self._task
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):
            pass
        return True

    async def shutdown(self) -> None:
        await self.cancel()
        self._kill()

    # --------------------------------------------------------- operations
    def start_scan(self, duration: float = 12.0) -> bool:
        return self._start({"op": "scan", "duration": duration})

    def start_probe(self, address: Optional[str]) -> bool:
        return self._start({"op": "probe", "address": address})

    def start_pair(self, address: Optional[str]) -> bool:
        return self._start({"op": "pair", "address": address})

    def start_sync(self, address: Optional[str] = None, full: bool = False) -> bool:
        return self._start({"op": "sync", "address": address, "full": full})

    def start_live(self, address: Optional[str], duration: float = 60.0) -> bool:
        return self._start({"op": "live", "address": address, "duration": duration})


ring_manager = RingSupervisor()
