"""dailyreadiness (+ dailystress) -> ``readiness``; dailyresilience -> ``resilience``."""
from __future__ import annotations

import logging
from datetime import date
from typing import Any, Dict, List, Optional

from backend.src.ingestion.base import IngestionBase
from backend.src.models import Readiness, Resilience

logger = logging.getLogger(__name__)


class ReadinessProcessor(IngestionBase):
    def _by_day(self, rows: List[Dict[str, str]], label: str) -> Dict[date, Dict[str, str]]:
        out: Dict[date, Dict[str, str]] = {}
        for row in rows:
            day = self.row_day(row, "timestamp")
            if day is None:
                self.warn(label, f"row {row.get('id') or '?'} skipped: no day")
                continue
            out[day] = row
        return out

    def process_readiness(self, readiness_rows: List[Dict[str, str]],
                          stress_rows: Optional[List[Dict[str, str]]] = None) -> int:
        base = self._by_day(readiness_rows, "dailyreadiness")
        stress = self._by_day(stress_rows or [], "dailystress")

        records: List[Dict[str, Any]] = []
        for day in sorted(set(base) | set(stress)):
            r, s = base.get(day, {}), stress.get(day, {})
            try:
                records.append({
                    "id": self.row_id(r) if r else self.row_id(s),
                    "day": day,
                    "score": self.parse_int(r.get("score")),
                    "temperature_deviation": self.parse_float(r.get("temperature_deviation")),
                    "temperature_trend_deviation": self.parse_float(r.get("temperature_trend_deviation")),
                    "contributors": self.parse_json(r.get("contributors")),
                    "stress_high": self.parse_int(s.get("stress_high")),
                    "recovery_high": self.parse_int(s.get("recovery_high")),
                    "day_summary": self.parse_str(s.get("day_summary")),
                })
            except Exception as exc:
                self.row_error("dailyreadiness", r or s, exc)
        return self.upsert(Readiness, records, ["day"])

    def process_resilience(self, rows: List[Dict[str, str]]) -> int:
        records: List[Dict[str, Any]] = []
        for row in rows:
            try:
                day = self.row_day(row, "timestamp")
                if day is None:
                    self.warn("dailyresilience", f"row {row.get('id') or '?'} skipped: no day")
                    continue
                contributors = self.parse_json(row.get("contributors"))
                if not isinstance(contributors, dict):
                    contributors = {}
                records.append({
                    "id": self.row_id(row),
                    "day": day,
                    "level": self.parse_str(row.get("level")),
                    "sleep_recovery": self.parse_float(contributors.get("sleep_recovery")),
                    "daytime_recovery": self.parse_float(contributors.get("daytime_recovery")),
                    "stress": self.parse_float(contributors.get("stress")),
                })
            except Exception as exc:
                self.row_error("dailyresilience", row, exc)
        return self.upsert(Resilience, records, ["day"])
