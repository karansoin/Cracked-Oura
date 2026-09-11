"""dailyactivity (+ daytimestress) -> ``activity``; workout -> ``workout``; session -> ``meditation``."""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from backend.src.ingestion.base import IngestionBase
from backend.src.models import Activity, Meditation, Workout

logger = logging.getLogger(__name__)

_ACTIVITY_INT_COLUMNS = (
    "high_activity_met_minutes", "high_activity_time", "inactivity_alerts",
    "low_activity_met_minutes", "low_activity_time", "medium_activity_met_minutes",
    "medium_activity_time", "meters_to_target", "non_wear_time", "resting_time",
    "sedentary_met_minutes", "sedentary_time", "target_calories", "target_meters",
)


class ActivityProcessor(IngestionBase):
    def build_stress_by_day(self, rows: List[Dict[str, str]]) -> Dict[date, List[Dict[str, Any]]]:
        """daytimestress stream -> ``{day: [{timestamp, stress, recovery}, ...]}``."""
        out: Dict[date, List[Dict[str, Any]]] = {}
        for row in rows:
            try:
                ts = self.parse_datetime(row.get("timestamp"))
                if ts is None:
                    continue
                out.setdefault(ts.date(), []).append({
                    "timestamp": ts.isoformat(),
                    "stress": self.parse_int(row.get("stress_value")),
                    "recovery": self.parse_int(row.get("recovery_value")),
                })
            except Exception as exc:
                self.row_error("daytimestress", row, exc)
        for items in out.values():
            items.sort(key=lambda e: e["timestamp"])
        return out

    def process_activity(self, rows: List[Dict[str, str]],
                         stress_rows: Optional[List[Dict[str, str]]] = None) -> int:
        stress_by_day = self.build_stress_by_day(stress_rows or [])
        records: Dict[date, Dict[str, Any]] = {}
        for row in rows:
            try:
                day = self.row_day(row, "timestamp")
                if day is None:
                    self.warn("dailyactivity", f"row {row.get('id') or '?'} skipped: no day")
                    continue
                day_start = datetime.combine(day, datetime.min.time())
                # ``average_met`` is the real metric; older exports only have ``average_met_minutes``
                average_met = self.parse_float(row.get("average_met"))
                if average_met is None:
                    average_met = self.parse_float(row.get("average_met_minutes"))
                rec: Dict[str, Any] = {
                    "id": self.row_id(row),
                    "day": day,
                    "score": self.parse_int(row.get("score")),
                    "steps": self.parse_int(row.get("steps")),
                    "total_calories": self.parse_int(row.get("total_calories")),
                    "active_calories": self.parse_int(row.get("active_calories")),
                    "average_met": average_met,
                    "equivalent_walking_distance": self.parse_int(row.get("equivalent_walking_distance")),
                    "contributors": self.parse_json(row.get("contributors")),
                    "class_5_min": self.digit_sequence(row.get("class_5_min"), day_start, 300),
                    "met": self.sample_series(row.get("met"), day_start, 60),
                    "stress": None,
                }
                for col in _ACTIVITY_INT_COLUMNS:
                    rec[col] = self.parse_int(row.get(col))
                records[day] = rec
            except Exception as exc:
                self.row_error("dailyactivity", row, exc)

        for day, items in stress_by_day.items():
            rec = records.get(day)
            if rec is None:
                rec = {"id": str(uuid.uuid4()), "day": day}
                records[day] = rec
            rec["stress"] = items

        return self.upsert(Activity, [records[d] for d in sorted(records)], ["day"])

    def process_workout(self, rows: List[Dict[str, str]]) -> int:
        records: List[Dict[str, Any]] = []
        for row in rows:
            try:
                day = self.row_day(row, "start_datetime", "timestamp")
                if day is None:
                    self.warn("workout", f"row {row.get('id') or '?'} skipped: no day")
                    continue
                records.append({
                    "id": self.row_id(row),
                    "day": day,
                    "start_time": self.parse_datetime(row.get("start_datetime")),
                    "end_time": self.parse_datetime(row.get("end_datetime")),
                    "activity": self.parse_str(row.get("activity")),
                    "calories": self.parse_float(row.get("calories")),
                    "distance": self.parse_float(row.get("distance")),
                    "intensity": self.parse_str(row.get("intensity")),
                    "label": self.parse_str(row.get("label")),
                    "source": self.parse_str(row.get("source")),
                })
            except Exception as exc:
                self.row_error("workout", row, exc)
        return self.upsert(Workout, records, ["id"])

    def process_meditation(self, rows: List[Dict[str, str]]) -> int:
        records: List[Dict[str, Any]] = []
        for row in rows:
            try:
                day = self.row_day(row, "start_datetime", "timestamp")
                if day is None:
                    self.warn("session", f"row {row.get('id') or '?'} skipped: no day")
                    continue
                records.append({
                    "id": self.row_id(row),
                    "day": day,
                    "start_time": self.parse_datetime(row.get("start_datetime")),
                    "end_time": self.parse_datetime(row.get("end_datetime")),
                    "type": self.parse_str(row.get("type")),
                    "mood": self.parse_str(row.get("mood")),
                })
            except Exception as exc:
                self.row_error("session", row, exc)
        return self.upsert(Meditation, records, ["id"])
