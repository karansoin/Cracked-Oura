"""Persist ring events and derive dashboard rows from them.

Two layers:

* :func:`store_events` — lossless insert of raw events (idempotent thanks to
  the unique constraint) with a wall-clock estimate from the time anchor.
* :func:`derive` — recompute the human-facing tables (sleep sessions, heart
  rate, temperature, activity, readiness) from the raw events for a serial.
  It is a pure function of the ``ring_event`` table so it can be re-run at
  any time (for example after a decoder improves).

The ring itself does not compute Oura's 0-100 scores (those live in the phone
app), so score columns stay ``NULL`` for ring-derived days; every other
number is measured by the ring.
"""

from __future__ import annotations

import json
import logging
import statistics
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Dict, Iterable, List, Tuple

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from ..models import Activity, HeartRate, Readiness, RingBattery, RingEvent as RingEventRow, RingState, Sleep, SleepSession, Temperature
from .events import RingEvent, TimeAnchor

logger = logging.getLogger("RingStore")

LOCAL_TZ = datetime.now().astimezone().tzinfo


def _local(unix: float) -> datetime:
    return datetime.fromtimestamp(unix, tz=timezone.utc).astimezone(LOCAL_TZ).replace(tzinfo=None)


def _day_for_sleep(end: datetime) -> date:
    """Oura attributes a night to the day you wake up on."""
    return end.date()


# ------------------------------------------------------------- raw store
def get_state(db: Session, serial: str) -> RingState:
    st = db.get(RingState, serial)
    if st is None:
        st = RingState(serial=serial, next_cursor=0, events_total=0)
        db.add(st)
        db.commit()
    return st


def load_anchor(st: RingState) -> TimeAnchor:
    return TimeAnchor(st.anchor_ring_ts, st.anchor_unix, bool(st.anchor_precise))


def save_anchor(st: RingState, anchor: TimeAnchor) -> None:
    st.anchor_ring_ts, st.anchor_unix, st.anchor_precise = anchor.ring_ts, anchor.unix, anchor.precise


def store_events(db: Session, serial: str, events: Iterable[RingEvent], anchor: TimeAnchor) -> int:
    rows = []
    now = datetime.now()
    for ev in events:
        decoded = ev.decode()
        anchor.observe(ev, decoded)
        rows.append(
            {
                "serial": serial,
                "tag": ev.tag,
                "ring_ts": ev.ring_ts,
                "body_hex": ev.body.hex(),
                "decoded": decoded,
                "unix_time": anchor.to_unix(ev.ring_ts),
                "synced_at": now,
            }
        )
    if not rows:
        return 0
    inserted = 0
    for i in range(0, len(rows), 500):
        chunk = rows[i : i + 500]
        res = db.execute(insert(RingEventRow).values(chunk).on_conflict_do_nothing(index_elements=["serial", "tag", "ring_ts", "body_hex"]))
        inserted += res.rowcount if res.rowcount and res.rowcount > 0 else 0
    db.commit()
    return inserted


def backfill_times(db: Session, serial: str, anchor: TimeAnchor) -> int:
    """Fill ``unix_time`` for events stored before an anchor was known."""
    if anchor.ring_ts is None:
        return 0
    rows = db.scalars(select(RingEventRow).where(RingEventRow.serial == serial, RingEventRow.unix_time.is_(None))).all()
    for r in rows:
        r.unix_time = anchor.to_unix(r.ring_ts)
    db.commit()
    return len(rows)


# --------------------------------------------------------------- derive
def _events(db: Session, serial: str, tags: Tuple[int, ...]) -> List[RingEventRow]:
    return db.scalars(
        select(RingEventRow)
        .where(RingEventRow.serial == serial, RingEventRow.tag.in_(tags), RingEventRow.unix_time.is_not(None))
        .order_by(RingEventRow.ring_ts)
    ).all()


def _upsert_rows(db: Session, model, rows: List[dict], index_elements: List[str]) -> None:
    if not rows:
        return
    for i in range(0, len(rows), 500):
        chunk = rows[i : i + 500]
        stmt = insert(model).values(chunk)
        update = {c.name: c for c in stmt.excluded if c.name not in index_elements and c.name != "id"}
        db.execute(stmt.on_conflict_do_update(index_elements=index_elements, set_=update))
    db.commit()


def derive_heart_rate(db: Session, serial: str) -> int:
    """Beats from the IBI streams (0x60 daytime/sleep, 0x80 green) → 1 sample per event."""
    rows = []
    for r in _events(db, serial, (0x60, 0x80)):
        d = r.decoded or {}
        hrs = d.get("hr_bpm") or []
        if not hrs:
            continue
        bpm = int(round(statistics.median(hrs)))
        rows.append({"timestamp": _local(r.unix_time), "bpm": bpm, "source": "ring_ibi" if r.tag == 0x60 else "ring_green"})
    # De-duplicate identical timestamps (HeartRate.timestamp is the PK)
    by_ts: Dict[datetime, dict] = {}
    for row in rows:
        by_ts[row["timestamp"]] = row
    _upsert_rows(db, HeartRate, list(by_ts.values()), ["timestamp"])
    return len(by_ts)


def derive_temperature(db: Session, serial: str) -> int:
    rows: Dict[datetime, dict] = {}
    for r in _events(db, serial, (0x46, 0x75)):
        d = r.decoded or {}
        temps = [t for t in (d.get("temps_c") or []) if t is not None]
        if not temps:
            continue
        # The first channel is the skin-facing sensor on every generation.
        rows[_local(r.unix_time)] = {"timestamp": _local(r.unix_time), "skin_temp": float(temps[0])}
    _upsert_rows(db, Temperature, list(rows.values()), ["timestamp"])
    return len(rows)


def derive_battery(db: Session, serial: str) -> int:
    rows: Dict[datetime, dict] = {}
    for r in _events(db, serial, (0x61,)):
        d = r.decoded or {}
        if d.get("kind") == "battery_level_changed":
            ts = _local(r.unix_time)
            rows[ts] = {"timestamp": ts, "level": int(d["battery_pct"]), "charging": False, "in_charger": False}
    for r in _events(db, serial, (0x45, 0x53)):
        d = r.decoded or {}
        if d.get("state") == 8:  # charging
            ts = _local(r.unix_time)
            rows.setdefault(ts, {"timestamp": ts, "level": None, "charging": True, "in_charger": True})
    rows = {k: v for k, v in rows.items() if v["level"] is not None}
    _upsert_rows(db, RingBattery, list(rows.values()), ["timestamp"])
    return len(rows)


def _series_in(events: List[RingEventRow], start: float, end: float) -> List[RingEventRow]:
    return [e for e in events if e.unix_time is not None and start <= e.unix_time <= end]


def derive_sleep(db: Session, serial: str) -> int:
    """One sleep session per ``bedtime_period`` (0x76) window."""
    periods = _events(db, serial, (0x76,))
    if not periods:
        return 0
    phases_ev = _events(db, serial, (0x4B, 0x4E, 0x5A))
    hrv_ev = _events(db, serial, (0x5D,))
    ibi_ev = _events(db, serial, (0x60, 0x80))
    temp_ev = _events(db, serial, (0x75, 0x46))
    spo2_ev = _events(db, serial, (0x6F,))
    st = db.get(RingState, serial)
    anchor = load_anchor(st) if st else TimeAnchor()

    sessions: List[dict] = []
    for p in periods:
        d = p.decoded or {}
        s_unix = anchor.to_unix(d.get("start_ring_ts", 0)) if anchor.ring_ts is not None else None
        e_unix = anchor.to_unix(d.get("end_ring_ts", 0)) if anchor.ring_ts is not None else None
        if not s_unix or not e_unix or e_unix <= s_unix or (e_unix - s_unix) < 30 * 60:
            continue
        start, end = _local(s_unix), _local(e_unix)
        # Hypnogram: concatenate 5-min phase codes emitted during the window
        phases: List[str] = []
        for ev in _series_in(phases_ev, s_unix - 600, e_unix + 600):
            phases.extend((ev.decoded or {}).get("phases") or [])
        n_expected = int((e_unix - s_unix) // 300)
        phases = phases[:n_expected] if n_expected and len(phases) > n_expected else phases
        counts = {k: phases.count(k) for k in ("deep", "light", "rem", "awake")}
        code = {"deep": "1", "light": "2", "rem": "3", "awake": "4"}
        hypno = "".join(code[x] for x in phases)
        phase_series = [{"timestamp": (start + timedelta(minutes=5 * i)).isoformat(), "value": int(code[x])} for i, x in enumerate(phases)]

        # HR / HRV 5-minute series
        hr_series, hrv_series, hr_vals, hrv_vals = [], [], [], []
        for ev in _series_in(hrv_ev, s_unix, e_unix):
            samples = (ev.decoded or {}).get("samples_5min") or []
            t_end = ev.unix_time
            for i, s in enumerate(reversed(samples)):
                ts = _local(t_end - 300 * i)
                if s["hr_bpm"]:
                    hr_series.append({"timestamp": ts.isoformat(), "bpm": s["hr_bpm"]})
                    hr_vals.append(s["hr_bpm"])
                if s["rmssd_ms"]:
                    hrv_series.append({"timestamp": ts.isoformat(), "value": s["rmssd_ms"]})
                    hrv_vals.append(s["rmssd_ms"])
        if not hr_vals:  # fall back to beat-level IBI events
            for ev in _series_in(ibi_ev, s_unix, e_unix):
                hrs = (ev.decoded or {}).get("hr_bpm") or []
                if hrs:
                    v = int(statistics.median(hrs))
                    hr_series.append({"timestamp": _local(ev.unix_time).isoformat(), "bpm": v})
                    hr_vals.append(v)
        hr_series.sort(key=lambda x: x["timestamp"])
        hrv_series.sort(key=lambda x: x["timestamp"])

        temps = []
        for ev in _series_in(temp_ev, s_unix, e_unix):
            t = [x for x in ((ev.decoded or {}).get("temps_c") or []) if x is not None]
            if t:
                temps.append(t[0])

        spo2_vals: List[int] = []
        for ev in _series_in(spo2_ev, s_unix, e_unix):
            spo2_vals.extend((ev.decoded or {}).get("spo2_percent") or [])
        spo2_avg = round(statistics.mean(spo2_vals), 1) if len(spo2_vals) >= 30 else None

        total = (counts["deep"] + counts["light"] + counts["rem"]) * 300 if phases else int(e_unix - s_unix)
        awake = counts["awake"] * 300
        tib = int(e_unix - s_unix)
        sid = f"ring-{serial}-{int(s_unix)}"
        sessions.append(
            {
                "id": sid,
                "day": _day_for_sleep(end),
                "start_time": start,
                "end_time": end,
                "bedtime_start": start,
                "bedtime_end": end,
                "type": "long_sleep" if total >= 3 * 3600 else "sleep",
                "efficiency": int(round(100 * total / tib)) if tib else None,
                "latency": None,
                "total_sleep_duration": total,
                "deep_sleep_duration": counts["deep"] * 300 if phases else None,
                "rem_sleep_duration": counts["rem"] * 300 if phases else None,
                "light_sleep_duration": counts["light"] * 300 if phases else None,
                "awake_time": awake if phases else None,
                "time_in_bed": tib,
                "average_heart_rate": round(statistics.mean(hr_vals), 1) if hr_vals else None,
                "lowest_heart_rate": min(hr_vals) if hr_vals else None,
                "average_hrv": int(round(statistics.mean(hrv_vals))) if hrv_vals else None,
                "hr_data": hr_series or None,
                "hrv_data": hrv_series or None,
                "sleep_phase_5_min": phase_series or None,
                "sleep_algorithm_version": "ring-ble",
                "readiness": {k: v for k, v in (("skin_temp_avg_c", round(statistics.mean(temps), 2) if temps else None), ("spo2_avg", spo2_avg), ("spo2_samples", len(spo2_vals) or None)) if v is not None} or None,
                "_hypno": hypno,
            }
        )

    # Keep only the longest session per day as 'long_sleep'
    by_day: Dict[date, List[dict]] = defaultdict(list)
    for s in sessions:
        by_day[s["day"]].append(s)
    rows = []
    daily_sleep_rows = []
    for day, items in by_day.items():
        items.sort(key=lambda s: s["total_sleep_duration"] or 0, reverse=True)
        for i, s in enumerate(items):
            s["type"] = "long_sleep" if i == 0 else "sleep"
            s.pop("_hypno", None)
            rows.append(s)
        main = items[0]
        daily_sleep_rows.append(
            {
                "id": f"ring-sleep-{serial}-{day.isoformat()}",
                "day": day,
                "score": None,
                "contributors": None,
                "status": "ring",
                "recommendation": None,
                "optimal_bedtime": None,
                "average_spo2": (main.get("readiness") or {}).get("spo2_avg"),
                "breathing_disturbance_index": None,
            }
        )
    # Replace previous ring-derived sessions to avoid stale duplicates
    db.execute(delete(SleepSession).where(SleepSession.id.like(f"ring-{serial}-%")))
    db.commit()
    _upsert_rows(db, SleepSession, rows, ["id"])
    # Do not overwrite a daily sleep row that came from an export (has a score)
    existing = {r.day for r in db.scalars(select(Sleep).where(Sleep.score.is_not(None))).all()}
    _upsert_rows(db, Sleep, [r for r in daily_sleep_rows if r["day"] not in existing], ["day"])
    return len(rows)


def derive_activity(db: Session, serial: str) -> int:
    """Per-minute MET from 0x50 events → activity table (no steps without the real-steps feature)."""
    per_day: Dict[date, List[Tuple[datetime, float]]] = defaultdict(list)
    for r in _events(db, serial, (0x50,)):
        mets = (r.decoded or {}).get("met") or []
        if not mets:
            continue
        end = _local(r.unix_time)
        for i, m in enumerate(reversed(mets)):
            ts = end - timedelta(minutes=i)
            per_day[ts.date()].append((ts, float(m)))
    existing = {r.day for r in db.scalars(select(Activity).where(Activity.score.is_not(None))).all()}
    rows = []
    for day, samples in per_day.items():
        if day in existing:
            continue
        samples.sort()
        mets = [m for _, m in samples]
        n = len(mets)
        hi = sum(1 for m in mets if m >= 6.0)
        med = sum(1 for m in mets if 3.5 <= m < 6.0)
        low = sum(1 for m in mets if 1.5 <= m < 3.5)
        sed = sum(1 for m in mets if 1.0 <= m < 1.5)
        rest = n - hi - med - low - sed
        rows.append(
            {
                "id": f"ring-activity-{serial}-{day.isoformat()}",
                "day": day,
                "score": None,
                "steps": None,
                "total_calories": None,
                "active_calories": None,
                "average_met": round(statistics.mean(mets), 3) if mets else None,
                "equivalent_walking_distance": None,
                "contributors": None,
                "met": [{"timestamp": ts.isoformat(), "value": m} for ts, m in samples],
                "class_5_min": None,
                "stress": None,
                "high_activity_time": hi * 60,
                "medium_activity_time": med * 60,
                "low_activity_time": low * 60,
                "sedentary_time": sed * 60,
                "resting_time": rest * 60,
                "high_activity_met_minutes": int(sum(m for m in mets if m >= 6.0)),
                "medium_activity_met_minutes": int(sum(m for m in mets if 3.5 <= m < 6.0)),
                "low_activity_met_minutes": int(sum(m for m in mets if 1.5 <= m < 3.5)),
                "sedentary_met_minutes": None,
                "non_wear_time": None,
                "inactivity_alerts": None,
                "meters_to_target": None,
                "target_calories": None,
                "target_meters": None,
            }
        )
    _upsert_rows(db, Activity, rows, ["day"])
    return len(rows)


def derive_readiness(db: Session, serial: str) -> int:
    """Temperature deviation vs the trailing 30-night baseline (Oura's own definition)."""
    nights = db.scalars(select(SleepSession).where(SleepSession.id.like(f"ring-{serial}-%"), SleepSession.type == "long_sleep").order_by(SleepSession.day)).all()
    temps = [(s.day, (s.readiness or {}).get("skin_temp_avg_c")) for s in nights]
    temps = [(d, t) for d, t in temps if t is not None]
    existing = {r.day for r in db.scalars(select(Readiness).where(Readiness.score.is_not(None))).all()}
    rows = []
    for i, (day, t) in enumerate(temps):
        if day in existing:
            continue
        base = [x for _, x in temps[max(0, i - 30) : i]]
        dev = round(t - statistics.median(base), 2) if len(base) >= 3 else None
        rows.append(
            {
                "id": f"ring-readiness-{serial}-{day.isoformat()}",
                "day": day,
                "score": None,
                "temperature_deviation": dev,
                "temperature_trend_deviation": None,
                "contributors": None,
                "stress_high": None,
                "recovery_high": None,
                "day_summary": None,
            }
        )
    _upsert_rows(db, Readiness, rows, ["day"])
    return len(rows)


def derive(db: Session, serial: str) -> Dict[str, int]:
    out = {
        "heart_rate": derive_heart_rate(db, serial),
        "temperature": derive_temperature(db, serial),
        "battery": derive_battery(db, serial),
        "sleep_sessions": derive_sleep(db, serial),
        "activity_days": derive_activity(db, serial),
        "readiness_days": derive_readiness(db, serial),
    }
    logger.info("derived for %s: %s", serial, json.dumps(out))
    return out


def new_session_id() -> str:
    return uuid.uuid4().hex
