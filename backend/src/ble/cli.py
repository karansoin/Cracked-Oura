"""Command-line ring tool (no Electron needed).

    backend/venv/bin/python -m backend.src.ble.cli scan [--seconds 12]
    backend/venv/bin/python -m backend.src.ble.cli probe [--address X]
    backend/venv/bin/python -m backend.src.ble.cli pair  [--address X]
    backend/venv/bin/python -m backend.src.ble.cli sync  [--address X] [--full]
    backend/venv/bin/python -m backend.src.ble.cli live  [--address X] [--seconds 60]
    backend/venv/bin/python -m backend.src.ble.cli events [--limit 50]

Run it from Terminal.app (macOS attributes the Bluetooth permission to the
terminal). Uses the same data directory and key files as the app.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys


async def _run(args: argparse.Namespace) -> int:
    from .manager import ring_manager

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.cmd == "scan":
        devs = await ring_manager.scan(args.seconds)
        print(json.dumps(devs, indent=2))
        return 0 if any(d["is_ring"] for d in devs) else 1
    if args.cmd == "probe":
        print(json.dumps(await ring_manager.probe(args.address), indent=2))
    elif args.cmd == "pair":
        print(json.dumps(await ring_manager.pair(args.address), indent=2))
    elif args.cmd == "sync":
        print(json.dumps(await ring_manager.sync(args.address, args.full), indent=2, default=str))
    elif args.cmd == "live":
        await ring_manager.live(args.address, args.seconds)
        print(json.dumps(list(ring_manager.live_samples), indent=2))
    elif args.cmd == "events":
        from sqlalchemy import select

        from ..database import SessionLocal
        from ..models import RingEvent
        from .events import EVENT_NAMES

        db = SessionLocal()
        try:
            for r in db.scalars(select(RingEvent).order_by(RingEvent.ring_ts.desc()).limit(args.limit)).all():
                print(r.ring_ts, r.unix_time, EVENT_NAMES.get(r.tag, hex(r.tag)), json.dumps(r.decoded) if r.decoded else r.body_hex)
        finally:
            db.close()
    await ring_manager.shutdown()
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="cracked-oura-ring")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan"); s.add_argument("--seconds", type=float, default=12.0)
    for name in ("probe", "pair", "sync", "live"):
        p = sub.add_parser(name)
        p.add_argument("--address")
        if name == "sync":
            p.add_argument("--full", action="store_true")
        if name == "live":
            p.add_argument("--seconds", type=float, default=60.0)
    e = sub.add_parser("events"); e.add_argument("--limit", type=int, default=50)
    args = ap.parse_args(argv)
    try:
        return asyncio.run(_run(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
