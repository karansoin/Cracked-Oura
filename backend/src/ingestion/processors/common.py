"""Streams and metadata: heartrate, temperature, ringbatterylevel, ringconfiguration,
enhancedtag/tag, dailycardiovascularage, vo2max."""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from backend.src.ingestion.base import IngestionBase
from backend.src.models import (
    CardiovascularAge, HeartRate, RingBattery, RingConfiguration, Tag, Temperature, Vo2Max,
)

logger = logging.getLogger(__name__)


class CommonProcessor(IngestionBase):
    def process_heart_rate(self, rows: List[Dict[str, str]]) -> int:
        records: List[Dict[str, Any]] = []
        for row in rows:
            try:
                ts = self.parse_datetime(row.get("timestamp"))
                bpm = self.parse_int(row.get("bpm"))
                if ts is None or bpm is None:
                    continue
                records.append({"timestamp": ts, "bpm": bpm, "source": self.parse_str(row.get("source")) or ""})
            except Exception as exc:
                self.row_error("heartrate", row, exc)
        return self.upsert(HeartRate, records, ["timestamp"])

    def process_temperature(self, rows: List[Dict[str, str]]) -> int:
        records: List[Dict[str, Any]] = []
        for row in rows:
            try:
                ts = self.parse_datetime(row.get("timestamp"))
                skin_temp = self.parse_float(row.get("skin_temp"))
                if ts is None or skin_temp is None:
                    continue
                records.append({"timestamp": ts, "skin_temp": skin_temp})
            except Exception as exc:
                self.row_error("temperature", row, exc)
        return self.upsert(Temperature, records, ["timestamp"])

    def process_ring_battery(self, rows: List[Dict[str, str]]) -> int:
        records: List[Dict[str, Any]] = []
        for row in rows:
            try:
                ts = self.parse_datetime(row.get("timestamp"))
                level = self.parse_int(row.get("level"))
                if ts is None or level is None:
                    continue
                records.append({
                    "timestamp": ts,
                    "level": level,
                    "charging": bool(self.parse_bool(row.get("charging"))),
                    "in_charger": bool(self.parse_bool(row.get("in_charger"))),
                })
            except Exception as exc:
                self.row_error("ringbatterylevel", row, exc)
        return self.upsert(RingBattery, records, ["timestamp"])

    def process_ring_configuration(self, rows: List[Dict[str, str]]) -> int:
        records: List[Dict[str, Any]] = []
        for row in rows:
            try:
                records.append({
                    "id": self.row_id(row),
                    "firmware_version": self.parse_str(row.get("firmware_version")),
                    "size": self.parse_int(row.get("size")),
                    "color": self.parse_str(row.get("color")),
                    "hardware_type": self.parse_str(row.get("hardware_type")),
                })
            except Exception as exc:
                self.row_error("ringconfiguration", row, exc)
        return self.upsert(RingConfiguration, records, ["id"])

    def process_tag(self, rows: List[Dict[str, str]]) -> int:
        records: List[Dict[str, Any]] = []
        for row in rows:
            try:
                start = self.parse_datetime(row.get("start_time")) or self.parse_datetime(row.get("start_day"))
                end = self.parse_datetime(row.get("end_time")) or self.parse_datetime(row.get("end_day"))
                records.append({
                    "id": self.row_id(row),
                    "start_time": start,
                    "end_time": end,
                    "tag_type_code": self.parse_str(row.get("tag_type_code")),
                    "comment": self.parse_str(row.get("comment")),
                })
            except Exception as exc:
                self.row_error("tag", row, exc)
        return self.upsert(Tag, records, ["id"])

    def process_cardiovascular_age(self, rows: List[Dict[str, str]]) -> int:
        records: List[Dict[str, Any]] = []
        for row in rows:
            try:
                day = self.row_day(row, "timestamp")
                if day is None:
                    self.warn("dailycardiovascularage", f"row {row.get('id') or '?'} skipped: no day")
                    continue
                records.append({
                    "id": self.row_id(row),
                    "day": day,
                    "vascular_age": self.parse_int(row.get("vascular_age")),
                })
            except Exception as exc:
                self.row_error("dailycardiovascularage", row, exc)
        return self.upsert(CardiovascularAge, records, ["day"])

    def process_vo2max(self, rows: List[Dict[str, str]]) -> int:
        records: List[Dict[str, Any]] = []
        for row in rows:
            try:
                day = self.row_day(row, "timestamp")
                if day is None:
                    self.warn("vo2max", f"row {row.get('id') or '?'} skipped: no day")
                    continue
                records.append({
                    "id": self.row_id(row),
                    "day": day,
                    "timestamp": self.parse_datetime(row.get("timestamp")),
                    "vo2_max": self.parse_float(row.get("vo2_max")),
                })
            except Exception as exc:
                self.row_error("vo2max", row, exc)
        return self.upsert(Vo2Max, records, ["day"])
