"""Filesystem locations for user data.

The directory can be overridden with the ``CRACKED_OURA_DATA_DIR``
environment variable (used by the test-suite and handy for running several
profiles side by side).
"""

import logging
import os
import sys
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger("Paths")

APP_NAME = "CrackedOura"
ENV_OVERRIDE = "CRACKED_OURA_DATA_DIR"


def _platform_default() -> Path:
    if sys.platform == "win32":
        base = os.getenv("APPDATA") or os.getenv("LOCALAPPDATA") or str(Path.home())
        return Path(base) / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    xdg = os.getenv("XDG_DATA_HOME")
    return (Path(xdg) if xdg else Path.home() / ".local" / "share") / APP_NAME


@lru_cache(maxsize=1)
def get_user_data_dir() -> Path:
    """Return (and create) the per-user data directory.

    - Windows: %APPDATA%/CrackedOura
    - macOS:   ~/Library/Application Support/CrackedOura
    - Linux:   $XDG_DATA_HOME/CrackedOura or ~/.local/share/CrackedOura
    """
    override = os.getenv(ENV_OVERRIDE)
    path = Path(override).expanduser() if override else _platform_default()
    try:
        path.mkdir(parents=True, exist_ok=True)
    except Exception as e:  # pragma: no cover - last-resort fallback
        fallback = Path.home() / ".cracked_oura"
        logger.warning("Cannot create %s (%s); falling back to %s", path, e, fallback)
        path = fallback
        path.mkdir(parents=True, exist_ok=True)
    return path


def get_log_dir() -> Path:
    d = get_user_data_dir() / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_downloads_dir() -> Path:
    d = get_user_data_dir() / "exports"
    d.mkdir(parents=True, exist_ok=True)
    return d
