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
except Exception as e:  # pragma: no cover - BLE stack optional at import time
    ble_router = None
    logger.warning("BLE router unavailable: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    logger.info("Backend ready. Logging to %s", LOG_FILE)
    yield
    if ble_router is not None:
        try:
            from backend.src.ble.manager import ring_manager

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
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "null",
        "file://",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)

app.include_router(router)
if ble_router is not None:
    app.include_router(ble_router)


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
