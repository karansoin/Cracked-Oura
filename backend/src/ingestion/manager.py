"""Entry point for importing an Oura data-export ZIP.

``OuraParser(db).parse_zip(path)`` extracts the archive, discovers every known
CSV (any folder depth, exact or date-suffixed names, ``;`` or ``,``), feeds
each data type to its processor and returns a summary::

    {
        "files":    {"dailysleep.csv": 14, "workout.csv": "error: ..."},
        "tables":   {"sleep": 14, "sleep_session": 15, ...},
        "warnings": ["tag: row 3 skipped: ...", ...],
    }

One unreadable or malformed file never aborts the rest of the import.
"""
from __future__ import annotations

import logging
import os
import tempfile
import zipfile
from datetime import tzinfo
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy.orm import Session

from .base import IngestionBase
from .processors.activity import ActivityProcessor
from .processors.common import CommonProcessor
from .processors.readiness import ReadinessProcessor
from .processors.sleep import SleepProcessor
from .reader import discover_files, read_many

logger = logging.getLogger(__name__)

Rows = List[Dict[str, str]]


class OuraParser(IngestionBase):
    def __init__(self, session: Session, tz: Optional[tzinfo] = None):
        super().__init__(session, tz=tz)
        shared = dict(tz=tz, warnings=self.warnings, tables=self.tables)
        self.sleep_processor = SleepProcessor(session, **shared)
        self.activity_processor = ActivityProcessor(session, **shared)
        self.readiness_processor = ReadinessProcessor(session, **shared)
        self.common_processor = CommonProcessor(session, **shared)

    # ------------------------------------------------------------------ public
    def parse_zip(self, zip_path: str) -> Dict[str, Any]:
        """Extract ``zip_path`` to a temp dir and import everything it contains."""
        self._reset()
        with tempfile.TemporaryDirectory(prefix="oura-export-") as temp_dir:
            try:
                with zipfile.ZipFile(zip_path, "r") as zf:
                    zf.extractall(temp_dir)
            except zipfile.BadZipFile as exc:
                logger.error("Invalid ZIP file at %s: %s", zip_path, exc)
                self.warnings.append(f"invalid ZIP archive: {exc}")
                return self._summary({})
            return self.parse_directory(temp_dir)

    def parse_directory(self, dir_path: str) -> Dict[str, Any]:
        """Import every known CSV found under ``dir_path`` (searched recursively)."""
        found = discover_files(dir_path)
        files: Dict[str, Any] = {}
        if not found:
            logger.warning("No Oura CSV files found under %s", dir_path)
            self.warnings.append("no Oura CSV files found in the archive")
            return self._summary(files)

        def load(dtype: str) -> Rows:
            paths = found.get(dtype) or []
            if not paths:
                return []
            rows, per_file, warns = read_many(paths)
            files.update(per_file)
            self.warnings.extend(warns)
            return rows

        # --- day-keyed summaries (merged by day) ---
        self._run("sleep", lambda: self.sleep_processor.process_sleep(
            load("dailysleep"), load("sleeptime"), load("dailyspo2")))
        self._run("readiness", lambda: self.readiness_processor.process_readiness(
            load("dailyreadiness"), load("dailystress")))
        self._run("activity", lambda: self.activity_processor.process_activity(
            load("dailyactivity"), load("daytimestress")))
        self._run("resilience", lambda: self.readiness_processor.process_resilience(
            load("dailyresilience")))

        # --- id-keyed documents ---
        self._run("sleep_session", lambda: self.sleep_processor.process_sleep_session(load("sleep_session")))
        self._run("workout", lambda: self.activity_processor.process_workout(load("workout")))
        self._run("meditation", lambda: self.activity_processor.process_meditation(load("session")))
        self._run("ring_configuration", lambda: self.common_processor.process_ring_configuration(
            load("ringconfiguration")))
        self._run("tag", lambda: self.common_processor.process_tag(load("tag")))
        self._run("cardiovascular_age", lambda: self.common_processor.process_cardiovascular_age(
            load("dailycardiovascularage")))
        self._run("vo2max", lambda: self.common_processor.process_vo2max(load("vo2max")))

        # --- timestamp-keyed streams (largest files last) ---
        self._run("ring_battery", lambda: self.common_processor.process_ring_battery(load("ringbatterylevel")))
        self._run("heart_rate", lambda: self.common_processor.process_heart_rate(load("heartrate")))
        self._run("temperature", lambda: self.common_processor.process_temperature(load("temperature")))

        return self._summary(files)

    # ------------------------------------------------------------------ helpers
    def _reset(self) -> None:
        self.warnings.clear()
        self.tables.clear()

    def _run(self, table: str, fn: Callable[[], int]) -> None:
        """Run one processor; a crash is recorded, not propagated."""
        try:
            fn()
        except Exception as exc:
            logger.exception("Import of %s failed", table)
            try:
                self.session.rollback()
            except Exception:  # pragma: no cover - session already unusable
                pass
            self.warnings.append(f"{table}: import failed: {exc.__class__.__name__}: {exc}")
        self.tables.setdefault(table, 0)

    def _summary(self, files: Dict[str, Any]) -> Dict[str, Any]:
        summary = {
            "files": dict(sorted(files.items(), key=lambda kv: os.path.basename(kv[0]).lower())),
            "tables": dict(sorted(self.tables.items())),
            "warnings": list(self.warnings),
        }
        logger.info("Import summary: %d file(s), %d table(s), %d warning(s)",
                    len(summary["files"]), len(summary["tables"]), len(summary["warnings"]))
        return summary
