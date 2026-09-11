"""Shared helpers for the Oura export processors.

Conventions enforced here so every table agrees with the UI's ``parseISO``:

* All ``DateTime`` columns and every timestamp inside a JSON series are stored
  as **naive local wall-clock** values.  Aware ISO-8601 inputs (``+02:00``,
  ``Z``) are converted to the configured local timezone first, then the
  tzinfo is dropped.  Naive inputs are stored as-is.
* Values arrive as strings straight from the CSV reader; ``""`` means the
  field was empty (``;;``) and ``None`` means the column did not exist.
* Upserts use SQLite ``ON CONFLICT DO UPDATE``.  The ``id`` primary key is
  never part of the ``SET`` clause on day-keyed tables, so a re-import with
  different ids cannot raise ``IntegrityError``.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import date, datetime, timedelta, tzinfo
from typing import Any, Dict, Iterable, List, Optional, Type

from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from backend.src.models import Base

logger = logging.getLogger(__name__)

_NULLISH = {"", "null", "none", "nan", "n/a"}
_DIGITS_RE = re.compile(r"^\d+$")
_TRUE = {"true", "t", "1", "yes", "y"}
_FALSE = {"false", "f", "0", "no", "n"}

# Per-label cap on warnings copied into the import summary (all are logged).
MAX_WARNINGS_PER_LABEL = 20
UPSERT_BATCH_SIZE = 500


def _is_null(val: Any) -> bool:
    if val is None:
        return True
    if isinstance(val, float) and val != val:  # NaN
        return True
    return isinstance(val, str) and val.strip().lower() in _NULLISH


class IngestionBase:
    """Base class shared by the parser and its processors."""

    def __init__(self, session: Session, tz: Optional[tzinfo] = None,
                 warnings: Optional[List[str]] = None, tables: Optional[Dict[str, int]] = None):
        self.session = session
        self.tz = tz  # None -> the machine's local timezone
        self.warnings: List[str] = warnings if warnings is not None else []
        self.tables: Dict[str, int] = tables if tables is not None else {}
        self._warning_counts: Dict[str, int] = {}

    # ------------------------------------------------------------------ warnings
    def warn(self, label: str, message: str) -> None:
        """Log a warning and copy it into the summary (capped per label)."""
        logger.warning("%s: %s", label, message)
        n = self._warning_counts.get(label, 0) + 1
        self._warning_counts[label] = n
        if n <= MAX_WARNINGS_PER_LABEL:
            self.warnings.append(f"{label}: {message}")
        elif n == MAX_WARNINGS_PER_LABEL + 1:
            self.warnings.append(f"{label}: further warnings suppressed (see log)")

    def row_error(self, label: str, row: Dict[str, Any], exc: Exception) -> None:
        ident = row.get("id") or row.get("timestamp") or row.get("day") or "?"
        self.warn(label, f"row {ident!s} skipped: {exc.__class__.__name__}: {exc}")

    # ------------------------------------------------------------------ time
    def to_local_naive(self, dt: Optional[datetime]) -> Optional[datetime]:
        if dt is None:
            return None
        if dt.tzinfo is not None:
            dt = dt.astimezone(self.tz) if self.tz is not None else dt.astimezone()
            dt = dt.replace(tzinfo=None)
        return dt

    def parse_datetime(self, val: Any) -> Optional[datetime]:
        """ISO-8601 (with offset, ``Z`` or naive) -> naive local datetime."""
        if _is_null(val):
            return None
        if isinstance(val, datetime):
            return self.to_local_naive(val)
        if isinstance(val, date):
            return datetime.combine(val, datetime.min.time())
        s = str(val).strip().strip('"')
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            # Unix epoch seconds / milliseconds (e.g. stepcount.end_time)
            try:
                num = float(s)
            except ValueError:
                return None
            if abs(num) > 1e11:
                num /= 1000.0
            try:
                dt = datetime.fromtimestamp(num, tz=self.tz)
            except (OverflowError, OSError, ValueError):
                return None
        return self.to_local_naive(dt)

    def parse_date(self, val: Any) -> Optional[date]:
        if _is_null(val):
            return None
        if isinstance(val, datetime):
            return self.to_local_naive(val).date()
        if isinstance(val, date):
            return val
        s = str(val).strip().strip('"')
        try:
            return date.fromisoformat(s[:10])
        except ValueError:
            dt = self.parse_datetime(s)
            return dt.date() if dt else None

    def row_day(self, row: Dict[str, Any], *fallback_columns: str) -> Optional[date]:
        """``day`` column, else the date of the first parseable fallback timestamp."""
        d = self.parse_date(row.get("day"))
        if d:
            return d
        for col in fallback_columns:
            dt = self.parse_datetime(row.get(col))
            if dt:
                return dt.date()
        return None

    # ------------------------------------------------------------------ scalars
    @staticmethod
    def row_id(row: Dict[str, Any]) -> str:
        val = row.get("id")
        if _is_null(val):
            return str(uuid.uuid4())
        return str(val).strip()

    @staticmethod
    def parse_str(val: Any) -> Optional[str]:
        if _is_null(val):
            return None
        return str(val)

    @staticmethod
    def parse_float(val: Any) -> Optional[float]:
        if _is_null(val):
            return None
        try:
            return float(val)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def parse_int(val: Any) -> Optional[int]:
        if _is_null(val):
            return None
        try:
            return int(float(val))
        except (TypeError, ValueError, OverflowError):
            return None

    @staticmethod
    def parse_bool(val: Any) -> Optional[bool]:
        if _is_null(val):
            return None
        if isinstance(val, bool):
            return val
        if isinstance(val, (int, float)):
            return bool(val)
        s = str(val).strip().lower()
        if s in _TRUE:
            return True
        if s in _FALSE:
            return False
        return None

    @staticmethod
    def parse_json(val: Any) -> Any:
        """Parse a JSON column; returns None when empty or not valid JSON."""
        if _is_null(val):
            return None
        if isinstance(val, (dict, list)):
            return val
        s = str(val).strip()
        try:
            return json.loads(s)
        except (TypeError, ValueError):
            # Leftover from pre-2026 exports where the blob was double-escaped.
            s2 = s.replace('""', '"')
            if s2.startswith('"') and s2.endswith('"'):
                s2 = s2[1:-1]
            try:
                return json.loads(s2)
            except (TypeError, ValueError):
                return None

    # ------------------------------------------------------------------ series
    @staticmethod
    def _series(items: Iterable[Any], start: datetime, interval_seconds: float) -> List[Dict[str, Any]]:
        step = timedelta(seconds=interval_seconds)
        out = []
        for i, item in enumerate(items):
            ts = (start + step * i).isoformat()
            if isinstance(item, dict):
                entry = dict(item)
                entry["timestamp"] = ts
            else:
                entry = {"timestamp": ts, "value": item}
            out.append(entry)
        return out

    def digit_sequence(self, val: Any, start: Optional[datetime], interval_seconds: int) -> Optional[List[Dict[str, Any]]]:
        """``"4422233"`` -> timestamped list anchored at ``start``.

        Only applies to values made solely of digits; anything else is
        ignored (callers pass this only for known sequence columns).
        """
        if _is_null(val) or start is None:
            return None
        s = str(val).strip()
        if not _DIGITS_RE.match(s):
            return None
        return self._series((int(c) for c in s), start, interval_seconds)

    def sample_series(self, val: Any, fallback_start: Optional[datetime] = None,
                      fallback_interval: Optional[float] = None) -> Optional[List[Dict[str, Any]]]:
        """Oura sample object ``{"interval": s, "items": [...], "timestamp": iso}``.

        The list is anchored at the object's OWN ``timestamp`` (converted to
        local wall-clock) and spaced by its own ``interval``; ``fallback_*``
        are used only when the object lacks them (or when the value is a
        bare JSON list).
        """
        parsed = self.parse_json(val)
        if parsed is None:
            return None
        if isinstance(parsed, dict):
            items = parsed.get("items")
            start = self.parse_datetime(parsed.get("timestamp")) or fallback_start
            interval = self.parse_float(parsed.get("interval")) or fallback_interval
        elif isinstance(parsed, list):
            items, start, interval = parsed, fallback_start, fallback_interval
        else:
            return None
        if not isinstance(items, list) or not items or start is None or not interval:
            return None
        return self._series(items, start, interval)

    # ------------------------------------------------------------------ upsert
    @staticmethod
    def _as_dicts(model: Type[Base], data: List[Any]) -> List[Dict[str, Any]]:
        cols = [c.name for c in model.__table__.columns]
        out = []
        for obj in data:
            if isinstance(obj, dict):
                out.append({c: obj.get(c) for c in cols})
            else:
                out.append({c: getattr(obj, c, None) for c in cols})
        return out

    def upsert(self, model: Type[Base], data: List[Any], index_elements: List[str],
               batch_size: int = UPSERT_BATCH_SIZE) -> int:
        """Batched ``INSERT ... ON CONFLICT(index) DO UPDATE``; returns rows written.

        * Rows sharing the conflict key are de-duplicated (last one wins) so a
          multi-row statement never conflicts with itself.
        * ``id`` and the conflict key are excluded from the ``SET`` clause.
        * A failing batch is retried row by row so one bad row is reported in
          the warnings instead of losing the whole batch.
        """
        if not data:
            return 0
        rows = self._as_dicts(model, data)
        table = model.__tablename__

        deduped: Dict[Any, Dict[str, Any]] = {}
        for r in rows:
            deduped[tuple(r.get(k) for k in index_elements)] = r
        rows = list(deduped.values())

        protected = set(index_elements) | {"id"}
        written = 0
        for i in range(0, len(rows), batch_size):
            batch = rows[i:i + batch_size]
            try:
                self._execute_upsert(model, batch, index_elements, protected)
                written += len(batch)
            except Exception as exc:
                self.session.rollback()
                logger.warning("%s: batch of %d failed (%s); retrying row by row", table, len(batch), exc)
                for r in batch:
                    try:
                        self._execute_upsert(model, [r], index_elements, protected)
                        written += 1
                    except Exception as row_exc:
                        self.session.rollback()
                        self.row_error(table, r, row_exc)
        self.tables[table] = self.tables.get(table, 0) + written
        logger.info("%s: upserted %d row(s)", table, written)
        return written

    def _execute_upsert(self, model: Type[Base], batch: List[Dict[str, Any]],
                        index_elements: List[str], protected: set) -> None:
        stmt = insert(model).values(batch)
        set_ = {c.name: c for c in stmt.excluded if c.name not in protected}
        if set_:
            stmt = stmt.on_conflict_do_update(index_elements=index_elements, set_=set_)
        else:
            stmt = stmt.on_conflict_do_nothing(index_elements=index_elements)
        self.session.execute(stmt)
        self.session.commit()
