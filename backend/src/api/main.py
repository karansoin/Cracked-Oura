"""Cracked Oura backend.

Local-only FastAPI service:
* SQLite database in the user data directory
* data comes from the ring over Bluetooth (``ble`` router) or from an
  Oura export ZIP the user already has on disk (``/api/ingest/zip``)
* optional local LLM analyst

Nothing here ever talks to Oura's servers.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# The Bluetooth worker runs as a child process of this same executable so a
# CoreBluetooth permission failure can never take the API down.
if len(sys.argv) > 1 and sys.argv[1] == "--ble-worker":
    from backend.src.ble.worker import main as _ble_worker_main

    raise SystemExit(_ble_worker_main(sys.argv[1:]))

from backend.src.paths import get_log_dir

# --------------------------------------------------------------------- logging
# Configure the root logger exactly once, with force=True so that any module
# that called ``logging.basicConfig`` earlier cannot pre-empt us.
LOG_FILE = os.path.join(get_log_dir(), "backend.log")
_handlers: list[logging.Handler] = [
    logging.handlers.RotatingFileHandler(LOG_FILE, maxBytes=2_000_000, backupCount=3, encoding="utf-8"),
    logging.StreamHandler(sys.stdout),
]
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=_handlers,
    force=True,
)
logger = logging.getLogger("API")

from backend.src.api.routes import router  # noqa: E402  (after logging setup)
from backend.src.database import init_db  # noqa: E402

try:
    from backend.src.api.ble_routes import router as ble_router  # noqa: E402
    from backend.src.api.live_routes import router as live_router  # noqa: E402
    from backend.src.api.insights_routes import router as insights_router  # noqa: E402
except Exception as e:  # pragma: no cover - BLE stack optional at import time
    ble_router = None
    live_router = None
    insights_router = None
    logger.warning("BLE router unavailable: %s", e)


async def _auto_sync_loop() -> None:
    """Every few minutes: if auto-sync is on, a ring is paired and nothing is running,
    start a ring sync. The ring only answers when it is on the charger or nearby and
    not connected to a phone, so failures are expected and logged quietly."""
    import asyncio

    from backend.src.ble.supervisor import ring_manager
    from backend.src.config import config_manager

    interval = int(os.environ.get("CRACKED_OURA_AUTOSYNC_MINUTES") or 30)
    await asyncio.sleep(60)
    while True:
        try:
            cfg = config_manager.get_config()
            if cfg.get("ble_auto_sync") and ring_manager.paired_serials() and not ring_manager.busy:
                logger.info("Auto-sync: starting ring sync")
                ring_manager.start_sync(cfg.get("ble_ring_address"))
        except Exception as e:  # noqa: BLE001
            logger.warning("Auto-sync loop error: %s", e)
        await asyncio.sleep(interval * 60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio

    init_db()
    logger.info("Backend ready. Logging to %s", LOG_FILE)
    auto_task = asyncio.create_task(_auto_sync_loop()) if ble_router is not None else None
    yield
    if auto_task is not None:
        auto_task.cancel()
    if ble_router is not None:
        try:
            from backend.src.ble.supervisor import ring_manager

            await ring_manager.shutdown()
        except Exception:  # pragma: no cover
            pass


app = FastAPI(
    title="Cracked Oura API",
    description="Local API over the Oura data stored in the local SQLite database.",
    version="0.2.0",
    lifespan=lifespan,
)

# The renderer runs from the Vite dev server (http://localhost:5173) or from a
# file:// page inside Electron (origin "null"). Nothing else may read the data.
app.add_middleware(
    CORSMiddleware,
    # Only pages served from this machine (the Vite dev server on any port, or the
    # packaged app's file:// page, whose origin is "null") may read the data.
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_origins=["null", "file://"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)

app.include_router(router)
if ble_router is not None:
    app.include_router(ble_router)
if live_router is not None:
    app.include_router(live_router)
if insights_router is not None:
    app.include_router(insights_router)


def _port() -> int:
    try:
        return int(os.environ.get("CRACKED_OURA_PORT") or os.environ.get("PORT") or 8000)
    except ValueError:
        return 8000


if __name__ == "__main__":
    import uvicorn

    if getattr(sys, "frozen", False):
        uvicorn.run(app, host="127.0.0.1", port=_port(), reload=False, log_config=None)
    else:
        uvicorn.run(
            "backend.src.api.main:app",
            host="127.0.0.1",
            port=_port(),
            reload=True,
            reload_dirs=["backend"],
            log_config=None,
        )
