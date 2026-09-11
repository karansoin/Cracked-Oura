"""Application configuration and sync-state persistence.

Two JSON files live in the user data directory:

* ``oura_config.json``   – settings (email, schedule, LLM, …) and the sync state
* ``oura_dashboard.json`` – dashboard layouts (kept separate because it is large
  and changes often)

All writes are atomic (temp file + ``os.replace``) and guarded by a lock.
Secrets (``llm_api_key``) are never returned by :meth:`ConfigManager.public_config`.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from .paths import get_user_data_dir

CONFIG_FILE = "oura_config.json"
DASHBOARD_FILE = "oura_dashboard.json"

logger = logging.getLogger("ConfigManager")

SYNC_STATES = (
    "idle",
    "needs_login",
    "otp_required",
    "logged_in",
    "export_requested",
    "waiting_for_export",
    "downloading",
    "ingesting",
    "done",
    "error",
)

DEFAULT_CONFIG: Dict[str, Any] = {
    "email": "",
    "schedule_time": "11:00",
    "is_active": True,
    "headless": True,
    "llm_provider": "ollama",
    "llm_host": "http://localhost:11434",
    "llm_model": "llama3.2:3b",
    "llm_base_url": "",
    "llm_api_key": "",
    "units": "metric",
    "sync": {
        "state": "idle",
        "method": None,
        "message": "",
        "started_at": None,
        "requested_at": None,
        "last_polled_at": None,
        "last_success_at": None,
        "next_scheduled_at": None,
        "progress": None,
        "error": None,
    },
}

SECRET_KEYS = {"llm_api_key", "password"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


class ConfigManager:
    def __init__(self, data_dir: Optional[str] = None):
        self.data_dir = str(data_dir or get_user_data_dir())
        self.config_path = os.path.join(self.data_dir, CONFIG_FILE)
        self.dashboard_path = os.path.join(self.data_dir, DASHBOARD_FILE)
        self._lock = threading.RLock()
        self._ensure_files()

    # ------------------------------------------------------------------ io
    def _ensure_files(self) -> None:
        with self._lock:
            if not os.path.exists(self.config_path):
                self._save_file(self.config_path, json.loads(json.dumps(DEFAULT_CONFIG)))
            else:
                # Migrate: fill in any keys added since the file was written.
                conf = self._load_file(self.config_path)
                changed = False
                for k, v in DEFAULT_CONFIG.items():
                    if k not in conf:
                        conf[k] = json.loads(json.dumps(v))
                        changed = True
                if not isinstance(conf.get("sync"), dict):
                    conf["sync"] = json.loads(json.dumps(DEFAULT_CONFIG["sync"]))
                    changed = True
                # Legacy free-text status field → drop it.
                for legacy in ("status", "last_run", "next_run", "message"):
                    if legacy in conf:
                        conf.pop(legacy)
                        changed = True
                if changed:
                    self._save_file(self.config_path, conf)
            if not os.path.exists(self.dashboard_path):
                self._save_file(self.dashboard_path, {"dashboard": {"dashboards": [], "activeDashboardId": None}})

    @staticmethod
    def _load_file(path: str) -> Dict[str, Any]:
        try:
            if not os.path.exists(path):
                return {}
            with open(path, "r", encoding="utf-8") as f:
                content = f.read().strip()
            return json.loads(content) if content else {}
        except Exception as e:
            logger.error("Error loading %s: %s", path, e)
            return {}

    @staticmethod
    def _save_file(path: str, data: Dict[str, Any]) -> None:
        tmp_path = f"{path}.{uuid.uuid4().hex}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, default=str)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, path)
        except Exception as e:
            logger.error("Error saving %s: %s", path, e)
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    # ------------------------------------------------------------ settings
    def get_config(self) -> Dict[str, Any]:
        """Full settings dict (including secrets). Internal use only."""
        with self._lock:
            return self._load_file(self.config_path)

    def public_config(self) -> Dict[str, Any]:
        """Settings safe to send to the UI (secrets masked)."""
        conf = self.get_config()
        for k in SECRET_KEYS:
            if conf.get(k):
                conf[k] = "********"
            elif k in conf:
                conf[k] = ""
        return conf

    def update_config(self, **kwargs: Any) -> Dict[str, Any]:
        """Set top-level settings. Pass ``None`` to clear a key's value to null.

        The masked placeholder ``********`` is ignored so the UI can round-trip
        ``public_config`` without wiping secrets.
        """
        with self._lock:
            conf = self._load_file(self.config_path)
            for key, value in kwargs.items():
                if key == "sync":
                    continue  # use update_sync
                if key in SECRET_KEYS and value == "********":
                    continue
                conf[key] = value
            self._save_file(self.config_path, conf)
            return conf

    # ----------------------------------------------------------- dashboard
    def get_dashboard(self) -> Dict[str, Any]:
        with self._lock:
            d = self._load_file(self.dashboard_path)
            return d.get("dashboard", {"dashboards": [], "activeDashboardId": None})

    def save_dashboard(self, dashboard: Dict[str, Any]) -> None:
        with self._lock:
            self._save_file(self.dashboard_path, {"dashboard": dashboard})

    # ---------------------------------------------------------------- sync
    def get_sync(self) -> Dict[str, Any]:
        with self._lock:
            conf = self._load_file(self.config_path)
            sync = conf.get("sync") or {}
            base = json.loads(json.dumps(DEFAULT_CONFIG["sync"]))
            base.update(sync)
            return base

    def update_sync(self, state: Optional[str] = None, **fields: Any) -> Dict[str, Any]:
        """Update the sync state machine. Unknown states are rejected."""
        if state is not None and state not in SYNC_STATES:
            raise ValueError(f"Unknown sync state: {state}")
        with self._lock:
            conf = self._load_file(self.config_path)
            sync = conf.get("sync") or json.loads(json.dumps(DEFAULT_CONFIG["sync"]))
            if state is not None:
                sync["state"] = state
                if state not in ("error",):
                    sync["error"] = None
                if state in ("done",):
                    sync["last_success_at"] = _now_iso()
                    sync["progress"] = None
            sync["updated_at"] = _now_iso()
            for k, v in fields.items():
                sync[k] = v
            conf["sync"] = sync
            self._save_file(self.config_path, conf)
            return sync

    def set_sync_error(self, message: str, code: str = "SYNC_FAILED", retryable: bool = True) -> Dict[str, Any]:
        return self.update_sync("error", message=message, error={"code": code, "message": message, "retryable": retryable})


config_manager = ConfigManager()
