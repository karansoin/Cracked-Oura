"""dailysleep (+ sleeptime + dailyspo2) -> ``sleep``; sleepmodel/sleep -> ``sleep_session``."""
from __future__ import annotations

import logging
from datetime import date
from typing import Any, Dict, List, Optional

from backend.src.ingestion.base import IngestionBase
from backend.src.models import Sleep, SleepSession

logger = logging.getLogger(__name__)

# sleep-session types that must never be imported
SKIPPED_SLEEP_TYPES = {"deleted"}


class SleepProcessor(IngestionBase):
    def _by_day(self, rows: List[Dict[str, str]], label: str) -> Dict[date, Dict[str, str]]:
        out: Dict[date, Dict[str, str]] = {}
        for row in rows:
            day = self.row_day(row, "timestamp")
            if day is None:
                self.warn(label, f"row {row.get('id') or '?'} skipped: no day")
                continue
            out[day] = row  # last one wins
        return out

    def process_sleep(self, sleep_rows: List[Dict[str, str]],
                      sleeptime_rows: Optional[List[Dict[str, str]]] = None,
                      spo2_rows: Optional[List[Dict[str, str]]] = None) -> int:
        """Merge the three day-keyed files into one ``sleep`` row per day."""
        base = self._by_day(sleep_rows, "dailysleep")
        times = self._by_day(sleeptime_rows or [], "sleeptime")
        spo2 = self._by_day(spo2_rows or [], "dailyspo2")

        records: List[Dict[str, Any]] = []
        for day in sorted(set(base) | set(times) | set(spo2)):
            s, t, o = base.get(day, {}), times.get(day, {}), spo2.get(day, {})
            try:
                spo2_val = self.parse_json(o.get("spo2_percentage"))
                if isinstance(spo2_val, dict):
                    average_spo2 = self.parse_float(spo2_val.get("average"))
                else:  # some exports carry a bare float
                    average_spo2 = self.parse_float(o.get("spo2_percentage"))
                records.append({
                    "id": self.row_id(s) if s else self.row_id(t or o),
                    "day": day,
                    "score": self.parse_int(s.get("score")),
                    "contributors": self.parse_json(s.get("contributors")),
                    "optimal_bedtime": self.parse_json(t.get("optimal_bedtime")),
                    "recommendation": self.parse_str(t.get("recommendation")),
                    "status": self.parse_str(t.get("status")),
                    "average_spo2": average_spo2,
                    "breathing_disturbance_index": self.parse_int(o.get("breathing_disturbance_index")),
                })
            except Exception as exc:
                self.row_error("dailysleep", s or t or o, exc)
        return self.upsert(Sleep, records, ["day"])

    def process_sleep_session(self, rows: List[Dict[str, str]]) -> int:
        records: List[Dict[str, Any]] = []
        skipped_deleted = 0
        for row in rows:
            try:
                stype = self.parse_str(row.get("type"))
                if stype and stype.lower() in SKIPPED_SLEEP_TYPES:
                    skipped_deleted += 1
                    continue
                bedtime_start = self.parse_datetime(row.get("bedtime_start"))
                bedtime_end = self.parse_datetime(row.get("bedtime_end"))
                day = self.row_day(row, "bedtime_end", "bedtime_start", "timestamp")
                if day is None:
                    self.warn("sleep_session", f"row {row.get('id') or '?'} skipped: no day")
                    continue
                records.append({
                    "id": self.row_id(row),
                    "day": day,
                    "start_time": bedtime_start,
                    "end_time": bedtime_end,
                    "type": stype,
                    "efficiency": self.parse_int(row.get("efficiency")),
                    "latency": self.parse_int(row.get("latency")),
                    "total_sleep_duration": self.parse_int(row.get("total_sleep_duration")),
                    "deep_sleep_duration": self.parse_int(row.get("deep_sleep_duration")),
                    "rem_sleep_duration": self.parse_int(row.get("rem_sleep_duration")),
                    "light_sleep_duration": self.parse_int(row.get("light_sleep_duration")),
                    "awake_time": self.parse_int(row.get("awake_time")),
                    "average_heart_rate": self.parse_float(row.get("average_heart_rate")),
                    "average_hrv": self.parse_int(row.get("average_hrv")),
                    # digit strings anchored at bedtime_start
                    "sleep_phase_5_min": self.digit_sequence(row.get("sleep_phase_5_min"), bedtime_start, 300),
                    "sleep_phase_30_sec": self.digit_sequence(row.get("sleep_phase_30_sec"), bedtime_start, 30),
                    "movement_30_sec": self.digit_sequence(row.get("movement_30_sec"), bedtime_start, 30),
                    # sample objects anchored at their own timestamp/interval
                    "hr_data": self.sample_series(row.get("heart_rate"), bedtime_start, 300),
                    "hrv_data": self.sample_series(row.get("hrv"), bedtime_start, 300),
                    "readiness": self.parse_json(row.get("readiness")),
                    "average_breath": self.parse_float(row.get("average_breath")),
                    "bedtime_end": bedtime_end,
                    "bedtime_start": bedtime_start,
                    "lowest_heart_rate": self.parse_int(row.get("lowest_heart_rate")),
                    "low_battery_alert": self.parse_bool(row.get("low_battery_alert")),
                    "period": self.parse_int(row.get("period")),
                    "restless_periods": self.parse_int(row.get("restless_periods")),
                    "sleep_algorithm_version": self.parse_str(row.get("sleep_algorithm_version")),
                    "sleep_score_delta": self.parse_int(row.get("sleep_score_delta")),
                    "readiness_score_delta": self.parse_float(row.get("readiness_score_delta")),
                    "time_in_bed": self.parse_int(row.get("time_in_bed")),
                })
            except Exception as exc:
                self.row_error("sleep_session", row, exc)
        if skipped_deleted:
            logger.info("sleep_session: skipped %d deleted row(s)", skipped_deleted)
        return self.upsert(SleepSession, records, ["id"])
