"""BLE worker process.

Runs ONE ring operation in a fresh process and streams JSON lines to stdout:

    {"type":"state"|"log"|"hr", ...}   progress events (same shapes as RingManager)
    {"type":"result", "ok": bool, "state":..., "message":..., "error":..., "ring":..., "devices":[...], "data":...}

Isolating CoreBluetooth in a child process means the API server can never be
taken down by a Bluetooth permission problem (macOS terminates a process that
touches CoreBluetooth without the right entitlement).

Invocation (dev):     python -m backend.src.ble.worker '<json command>'
Invocation (frozen):  backend --ble-worker '<json command>'
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Any, Dict


def _emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


async def _run(cmd: Dict[str, Any]) -> int:
    from .manager import RingManager

    mgr = RingManager()
    q = mgr.listen()

    async def relay():
        while True:
            ev = await q.get()
            _emit(ev)

    relay_task = asyncio.create_task(relay())
    op = cmd.get("op")
    address = cmd.get("address")
    data: Any = None
    try:
        if op == "scan":
            data = await mgr.scan(float(cmd.get("duration", 12)))
        elif op == "probe":
            data = await mgr.probe(address)
        elif op == "pair":
            data = await mgr.pair(address)
        elif op == "sync":
            data = await mgr.sync(address, bool(cmd.get("full", False)))
        elif op == "live":
            await mgr.live(address, float(cmd.get("duration", 60)))
            data = list(mgr.live_samples)
        else:
            raise ValueError(f"unknown op {op!r}")
        ok = True
    except Exception as e:  # noqa: BLE001 - reported to the supervisor
        # Reuse the manager's user-facing error mapping.
        from .client import AuthFailed, AuthRequired, PairingRequired, RingError
        from . import protocol as P

        if isinstance(e, PairingRequired):
            mgr._fail("macOS did not pair with the ring. A ring that is already set up with the Oura app only accepts its phone; to use it here, factory-reset the ring first (see the Ring page), then pair again.", e)
        elif isinstance(e, AuthFailed):
            mgr._fail(f"The ring rejected this app's key ({P.auth_result_name(e.code)}). If the ring was re-onboarded in the Oura app, it needs a factory reset before it can be paired here again.", e)
        elif isinstance(e, AuthRequired):
            mgr._fail("The ring has a key installed that this app does not have. Factory-reset the ring, then pair it here.", e)
        elif isinstance(e, RingError):
            mgr._fail(str(e), e)
        else:
            mgr._fail(f"{op} failed: {e}", e)
        ok = False
    finally:
        await mgr._disconnect()
        await asyncio.sleep(0)  # let the relay flush queued events
        relay_task.cancel()
        while not q.empty():
            _emit(q.get_nowait())
    _emit(
        {
            "type": "result",
            "ok": ok,
            "state": mgr.state,
            "message": mgr.message,
            "error": mgr.error,
            "ring": mgr.ring,
            "devices": mgr.devices,
            "bluetooth_ok": mgr.bluetooth_ok,
            "data": data,
        }
    )
    return 0 if ok else 1


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "--ble-worker":
        argv = argv[1:]
    if not argv:
        _emit({"type": "result", "ok": False, "error": "missing command"})
        return 2
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    try:
        cmd = json.loads(argv[0])
    except json.JSONDecodeError:
        _emit({"type": "result", "ok": False, "error": "bad command json"})
        return 2
    try:
        return asyncio.run(_run(cmd))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
