"""Generate a realistic synthetic Oura data-export ZIP for tests.

Dialect matches the July/Aug-2026 membership-hub export: one CSV per data
type under ``App Data/``, ``;``-delimited, CRLF line endings, UTF-8, RFC-4180
quoting (JSON blobs wrapped in double quotes with doubled inner quotes),
``id`` first then alphabetical columns, streams starting with ``timestamp``,
empty values written as bare ``;;``.

``naming='suffixed'`` produces the alternate scheme reported by downstream
users: ``sleep.csv``/``tag.csv`` instead of ``sleepmodel.csv``/
``enhancedtag.csv`` and a ``_YYYY-MM-DD_YYYY-MM-DD`` suffix, with each data
type split over two files so concatenation is exercised.

Run directly to write ``oura_export.zip`` into the current directory::

    python -m backend.tests.fixtures.make_export [out.zip] [--days N]
"""
from __future__ import annotations

import csv
import io
import json
import os
import random
import sys
import zipfile
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

# Local offset used for every "local" timestamp in the export (US Eastern, winter).
LOCAL_TZ = timezone(timedelta(hours=-5), name="-05:00")
UTC = timezone.utc

START_DAY = date(2024, 1, 1)

# Tag comment containing the delimiter, a newline and a quote.
TAG_COMMENT = 'Coffee; late evening\n"second" line, with comma'


def _iso(dt: datetime) -> str:
    """ISO-8601 with ``Z`` for UTC and ``+HH:MM`` otherwise (Oura style)."""
    s = dt.isoformat()
    return s[:-6] + "Z" if s.endswith("+00:00") else s


def _j(obj: Any) -> str:
    return json.dumps(obj, separators=(", ", ": "))


def _digits(rng: random.Random, n: int, alphabet: str) -> str:
    return "".join(rng.choice(alphabet) for _ in range(n))


def _sample(rng: random.Random, n: int, lo: float, hi: float, null_every: int = 0) -> List[Optional[float]]:
    out: List[Optional[float]] = []
    for i in range(n):
        if null_every and i % null_every == 0 and i:
            out.append(None)
        else:
            out.append(round(rng.uniform(lo, hi), 1))
    return out


class _Export:
    """Accumulates ``(exact_stem, alt_stem, header, rows, bom)`` per data type."""

    def __init__(self, days: int, seed: int = 42):
        self.rng = random.Random(seed)
        self.days = [START_DAY + timedelta(days=i) for i in range(days)]
        self.files: List[Tuple[str, Optional[str], List[str], List[List[Any]], bool]] = []
        self.expected: Dict[str, Any] = {
            "days": [d.isoformat() for d in self.days],
            "spo2": {}, "bdi": {}, "hr_series": {}, "stress_points": {},
        }

    def add(self, stem: str, header: Sequence[str], rows: List[List[Any]],
            alt: Optional[str] = None, bom: bool = False) -> None:
        assert header[0] in ("id", "timestamp"), stem
        assert list(header[1:]) == sorted(header[1:]), f"{stem}: columns after {header[0]} must be alphabetical"
        self.files.append((stem, alt, list(header), rows, bom))

    # ------------------------------------------------------------ daily files
    def daily(self) -> None:
        rng, days, exp = self.rng, self.days, self.expected
        sleep, sleeptime, spo2, readiness, stress, activity, resilience, cva, vo2 = ([] for _ in range(9))
        daytime: List[List[Any]] = []
        for i, d in enumerate(days):
            local_midnight = datetime.combine(d, datetime.min.time(), LOCAL_TZ)
            contributors = {"deep_sleep": 60 + i % 30, "efficiency": 80 + i % 15, "latency": 70 + i % 25,
                            "rem_sleep": 50 + i % 40, "restfulness": 60 + i % 30, "timing": 90 - i % 20,
                            "total_sleep": 70 + i % 25}
            sleep.append([f"ds-{i}", _j(contributors), d.isoformat(), 70 + i % 20, _iso(local_midnight)])

            if i % 5 == 3:  # one day without a recommendation -> bare ;; values
                sleeptime.append([f"st-{i}", d.isoformat(), "", "", "not_enough_nights"])
            else:
                sleeptime.append([f"st-{i}", d.isoformat(),
                                  _j({"day_tz": -18000, "end_offset": -1800 + 60 * i, "start_offset": -5400}),
                                  "follow_optimal_bedtime", "optimal_found"])

            avg = round(95.5 + (i % 4) * 0.5 + 0.343, 3)
            bdi = i % 5
            spo2.append([f"sp-{i}", bdi, d.isoformat(), _j({"average": avg})])
            exp["spo2"][d.isoformat()] = avg
            exp["bdi"][d.isoformat()] = bdi

            rc = {"activity_balance": 80 + i % 15, "body_temperature": 90, "hrv_balance": 70 + i % 20,
                  "previous_day_activity": 85, "previous_night": 75 + i % 20, "recovery_index": 88,
                  "resting_heart_rate": 90, "sleep_balance": 80, "sleep_regularity": 77}
            readiness.append([f"dr-{i}", _j(rc), d.isoformat(), 65 + i % 30, round(-0.3 + 0.05 * i, 2),
                              "" if i % 2 == 0 else round(0.1 * (i % 3), 2), _iso(local_midnight)])

            stress.append([f"dst-{i}", d.isoformat(), ("restored", "normal", "stressful")[i % 3],
                           1800 + 300 * i, 900 + 200 * (i % 4)])

            met_ts = local_midnight + timedelta(hours=4)
            met_items = _sample(rng, 1440, 0.9, 6.0, null_every=97)
            ac = {"meet_daily_targets": 70 + i % 30, "move_every_hour": 90, "recovery_time": 100,
                  "stay_active": 60 + i % 40, "training_frequency": 80, "training_volume": 75}
            activity.append([
                f"da-{i}", 300 + 20 * i, round(1.2 + 0.05 * (i % 7), 3), _digits(rng, 288, "012345"), _j(ac),
                d.isoformat(), 5000 + 200 * i, 10 + i, 600 + 60 * i, 1 + i % 3, 200 + 5 * i, 12000, 60 + i,
                3600 + 100 * i, _j({"interval": 60, "items": met_items, "timestamp": _iso(met_ts)}),
                2000 - 50 * i, 0 if i % 4 else 1800, 28800, 60 + i % 35, 50 + i, 30000 + 100 * i,
                6000 + 300 * i, 450, 9000, _iso(local_midnight), 2200 + 25 * i,
            ])

            resilience.append([f"rs-{i}", _j({"sleep_recovery": 70.5 + i, "daytime_recovery": 60.25 + i,
                                              "stress": 55.0 + i}), d.isoformat(),
                               ("limited", "adequate", "solid", "strong", "exceptional")[i % 5]])

            cva.append([f"cv-{i}", d.isoformat(), round(7.0 + 0.1 * (i % 5), 2), 30 + i % 6])
            if i % 7 == 0:
                vo2.append([f"vo-{i}", d.isoformat(), _iso(local_midnight + timedelta(hours=9)), round(40.0 + 0.3 * i, 1)])

            # daytimestress: every 15 minutes 06:00-22:00 local, one empty stress value per day
            pts = 0
            for k in range(0, 16 * 4):
                ts = local_midnight + timedelta(hours=6, minutes=15 * k)
                stress_v: Any = "" if k == 5 else rng.randint(0, 100)
                daytime.append([_iso(ts), rng.randint(0, 100), stress_v])
                pts += 1
            exp["stress_points"][d.isoformat()] = pts

        self.add("dailysleep", ["id", "contributors", "day", "score", "timestamp"], sleep)
        self.add("sleeptime", ["id", "day", "optimal_bedtime", "recommendation", "status"], sleeptime)
        self.add("dailyspo2", ["id", "breathing_disturbance_index", "day", "spo2_percentage"], spo2)
        self.add("dailyreadiness", ["id", "contributors", "day", "score", "temperature_deviation",
                                    "temperature_trend_deviation", "timestamp"], readiness, bom=True)
        self.add("dailystress", ["id", "day", "day_summary", "recovery_high", "stress_high"], stress)
        self.add("dailyactivity", [
            "id", "active_calories", "average_met_minutes", "class_5_min", "contributors", "day",
            "equivalent_walking_distance", "high_activity_met_minutes", "high_activity_time",
            "inactivity_alerts", "low_activity_met_minutes", "low_activity_time",
            "medium_activity_met_minutes", "medium_activity_time", "met", "meters_to_target",
            "non_wear_time", "resting_time", "score", "sedentary_met_minutes", "sedentary_time",
            "steps", "target_calories", "target_meters", "timestamp", "total_calories"], activity)
        self.add("dailyresilience", ["id", "contributors", "day", "level"], resilience)
        self.add("daytimestress", ["timestamp", "recovery_value", "stress_value"], daytime)
        self.add("dailycardiovascularage", ["id", "day", "pulse_wave_velocity", "vascular_age"], cva)
        self.add("vo2max", ["id", "day", "timestamp", "vo2_max"], vo2)
        exp.update(activity_days=len(activity), vo2max_rows=len(vo2), cva_rows=len(cva),
                   daytimestress_rows=len(daytime))

    # ------------------------------------------------------------ sleep sessions
    def sleep_sessions(self) -> None:
        rng, exp = self.rng, self.expected
        header = ["id", "app_sleep_phase_5_min", "average_breath", "average_heart_rate", "average_hrv",
                  "awake_time", "bedtime_end", "bedtime_start", "day", "deep_sleep_duration", "efficiency",
                  "heart_rate", "hrv", "latency", "light_sleep_duration", "low_battery_alert",
                  "lowest_heart_rate", "movement_30_sec", "period", "readiness", "readiness_score_delta",
                  "rem_sleep_duration", "restless_periods", "ring_id", "sleep_algorithm_version",
                  "sleep_analysis_reason", "sleep_phase_30_sec", "sleep_phase_5_min", "sleep_score_delta",
                  "time_in_bed", "total_sleep_duration", "type"]
        rows: List[List[Any]] = []
        deleted = 0

        def session(sid: str, d: date, start: datetime, end: datetime, stype: str, with_series: bool = True,
                    low_battery: str = "false") -> List[Any]:
            tib = int((end - start).total_seconds())
            n5 = tib // 300
            n30 = tib // 30
            hr = {"interval": 300, "items": _sample(rng, n5, 48, 70, null_every=13), "timestamp": _iso(start)}
            hrv = {"interval": 300, "items": _sample(rng, n5, 20, 90, null_every=11), "timestamp": _iso(start)}
            if with_series:
                exp["hr_series"][sid] = {"timestamp": _iso(start), "interval": 300, "n": n5}
            readiness = {"contributors": {"activity_balance": 80, "body_temperature": 95, "hrv_balance": 70,
                                          "previous_day_activity": 85, "previous_night": 75,
                                          "recovery_index": 88, "resting_heart_rate": 90,
                                          "sleep_balance": 80, "sleep_regularity": 77},
                         "score": 70 + rng.randint(0, 20), "temperature_deviation": -0.1,
                         "temperature_trend_deviation": None}
            deep, rem, awake = int(tib * 0.2), int(tib * 0.22), int(tib * 0.08)
            light = tib - deep - rem - awake
            return [
                sid, _digits(rng, n5, "1234") if with_series else "", round(rng.uniform(12, 16), 2),
                round(rng.uniform(50, 62), 3), rng.randint(25, 80), awake, _iso(end), _iso(start),
                d.isoformat(), deep, 80 + rng.randint(0, 15), _j(hr) if with_series else "",
                _j(hrv) if with_series else "", 300 + 60 * rng.randint(0, 10), light, low_battery,
                rng.randint(42, 55), _digits(rng, n30, "1234") if with_series else "", 0,
                _j(readiness) if with_series else "", rng.randint(-3, 3), rem, rng.randint(0, 40),
                "ring-0001", "v2", "background_sleep_analysis",
                _digits(rng, n30, "1234") if with_series else "", _digits(rng, n5, "1234") if with_series else "",
                rng.randint(-5, 5), tib, deep + rem + light, stype,
            ]

        for i, d in enumerate(self.days):
            start = datetime.combine(d - timedelta(days=1), datetime.min.time(), LOCAL_TZ) + timedelta(hours=23)
            end = datetime.combine(d, datetime.min.time(), LOCAL_TZ) + timedelta(hours=7, minutes=5 * (i % 4))
            rows.append(session(f"sl-{i}", d, start, end, "long_sleep", low_battery="true" if i == 2 else "false"))
            if i == 3:  # a user-deleted sleep that must be skipped
                rows.append(session("sl-deleted", d, start, end, "deleted", with_series=False))
                deleted += 1
            if i == 5:  # an afternoon nap
                nap_start = datetime.combine(d, datetime.min.time(), LOCAL_TZ) + timedelta(hours=14)
                rows.append(session("sl-nap", d, nap_start, nap_start + timedelta(minutes=40), "late_nap"))
        self.add("sleepmodel", header, rows, alt="sleep")
        exp.update(sleep_rows=len(rows), sleep_deleted=deleted, sleep_sessions=len(rows) - deleted)

    # ------------------------------------------------------------ id-keyed documents
    def documents(self) -> None:
        rng, exp = self.rng, self.expected
        workouts: List[List[Any]] = []
        for i, d in enumerate(self.days):
            if i % 2:
                continue
            start = datetime.combine(d, datetime.min.time(), LOCAL_TZ) + timedelta(hours=17, minutes=30)
            end = start + timedelta(minutes=45 + i)
            label = "" if i % 4 else "Run, easy"  # empty label on some rows; a comma on others
            workouts.append([f"wo-{i}", ("running", "cycling", "walking")[i % 3], round(300.0 + 10 * i, 1),
                             d.isoformat(), round(8751.47 + 100 * i, 5), _iso(end),
                             ("easy", "moderate", "hard")[i % 3], label,
                             "confirmed" if i % 4 else "workout_heart_rate", _iso(start)])
        self.add("workout", ["id", "activity", "calories", "day", "distance", "end_datetime", "intensity",
                             "label", "source", "start_datetime"], workouts)
        exp["workouts"] = len(workouts)

        sessions: List[List[Any]] = []
        for i, d in enumerate(self.days):
            if i % 6 != 1:
                continue
            start = datetime.combine(d, datetime.min.time(), LOCAL_TZ) + timedelta(hours=12)
            end = start + timedelta(minutes=10)
            hr = {"interval": 5, "items": _sample(rng, 120, 55, 70), "timestamp": _iso(start)}
            sessions.append([f"se-{i}", d.isoformat(), _iso(end), _j(hr), _j(hr), ("good", "great")[i % 2],
                             _j({"interval": 5, "items": [0] * 120, "timestamp": _iso(start)}), _iso(start),
                             "meditation"])
        self.add("session", ["id", "day", "end_datetime", "heart_rate", "heart_rate_variability", "mood",
                             "motion_count", "start_datetime", "type"], sessions)
        exp["meditations"] = len(sessions)

        if self.days:
            self.add("ringconfiguration", ["id", "color", "design", "firmware_version", "hardware_type",
                                           "set_up_at", "size"],
                     [["rc-1", "silver", "horizon", "3.4.3", "gen3", _iso(datetime(2023, 12, 20, 10, 0, tzinfo=UTC)), 9]])
            d0 = self.days[0]
            t0 = datetime.combine(d0, datetime.min.time(), LOCAL_TZ) + timedelta(hours=21)
            tags = [
                ["tag-1", TAG_COMMENT, "", "", _iso(t0 + timedelta(hours=1)), d0.isoformat(), _iso(t0), "tag_generic_caffeine"],
                ["tag-2", 'He said "hi"', "custom", d0.isoformat(), "", d0.isoformat(), _iso(t0), "tag_generic_alcohol"],
                ["tag-3", "", "", "", "", (d0 + timedelta(days=1)).isoformat(), _iso(t0 + timedelta(days=1)), "tag_generic_sick"],
            ]
            self.add("enhancedtag", ["id", "comment", "custom_name", "end_day", "end_time", "start_day",
                                     "start_time", "tag_type_code"], tags, alt="tag")
            exp.update(tags=len(tags), tag_comment=TAG_COMMENT, tag_id="tag-1", ring_configs=1)
        else:
            self.add("ringconfiguration", ["id", "color", "design", "firmware_version", "hardware_type",
                                           "set_up_at", "size"], [])
            self.add("enhancedtag", ["id", "comment", "custom_name", "end_day", "end_time", "start_day",
                                     "start_time", "tag_type_code"], [], alt="tag")
            exp.update(tags=0, tag_comment=TAG_COMMENT, tag_id="tag-1", ring_configs=0)

    # ------------------------------------------------------------ streams
    def streams(self) -> None:
        rng, exp = self.rng, self.expected
        hr: List[List[Any]] = []
        temp: List[List[Any]] = []
        batt: List[List[Any]] = []
        sources = ("rest", "awake", "sleep", "workout", "live")
        for d in self.days:
            day_utc = datetime.combine(d, datetime.min.time(), UTC)
            for k in range(288):
                ts = day_utc + timedelta(minutes=5 * k)
                hr.append([_iso(ts), rng.randint(45, 120), sources[k % 5]])
                temp.append([_iso(ts), round(rng.uniform(32.5, 36.5), 2)])
            for h in range(24):
                ts = day_utc + timedelta(hours=h)
                batt.append([_iso(ts), "true" if h == 22 else "false", "true" if h in (22, 23) else "false",
                             max(5, 100 - 4 * h)])
        self.add("heartrate", ["timestamp", "bpm", "source"], hr)
        self.add("temperature", ["timestamp", "skin_temp"], temp)
        self.add("ringbatterylevel", ["timestamp", "charging", "in_charger", "level"], batt)
        exp.update(heartrate_rows=len(hr), temperature_rows=len(temp), battery_rows=len(batt))
        if hr:
            exp["first_hr_utc"] = hr[0][0]

    # ------------------------------------------------------------ unknown / distractors
    def extras(self) -> None:
        # Header-only file the importer does not know (present in every real export)
        self.add("bloodglucose", ["timestamp", "value"], [])
        self.add("dailyvo2maxestimate", ["id", "day", "vo2_max_estimate"], [])


def _write_csv(header: Sequence[str], rows: List[List[Any]], delimiter: str, bom: bool) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=delimiter, quotechar='"', doublequote=True,
                   quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    w.writerow(header)
    for r in rows:
        w.writerow(["" if v is None else v for v in r])
    data = buf.getvalue().encode("utf-8")
    return (b"\xef\xbb\xbf" + data) if bom else data


def _file_names(stem: str, alt: Optional[str], naming: str, rows: List[List[Any]],
                days: List[date]) -> List[Tuple[str, List[List[Any]]]]:
    """Return ``[(file name, rows)]`` for one data type under the naming scheme."""
    if naming == "exact":
        return [(f"{stem}.csv", rows)]
    if naming != "suffixed":
        raise ValueError("naming must be 'exact' or 'suffixed'")
    base = alt or stem
    if not days:
        return [(f"{base}_{START_DAY.isoformat()}_{START_DAY.isoformat()}.csv", rows)]
    if len(rows) < 2:
        return [(f"{base}_{days[0].isoformat()}_{days[-1].isoformat()}.csv", rows)]
    mid_row = len(rows) // 2
    mid_day = days[len(days) // 2]
    return [
        (f"{base}_{days[0].isoformat()}_{(mid_day - timedelta(days=1)).isoformat()}.csv", rows[:mid_row]),
        (f"{base}_{mid_day.isoformat()}_{days[-1].isoformat()}.csv", rows[mid_row:]),
    ]


def build_export_zip(path: str, days: int = 14, naming: str = "exact", delimiter: str = ";",
                     folder: Optional[str] = "App Data") -> Dict[str, Any]:
    """Write a synthetic Oura export ZIP to ``path`` and return the expected contents.

    ``naming``: ``'exact'`` (``dailysleep.csv``, ``sleepmodel.csv``, ``enhancedtag.csv``)
    or ``'suffixed'`` (``sleep_2024-01-01_2024-01-07.csv``, ``tag_...``, split in two).
    ``delimiter``: ``';'`` (real exports) or ``','``.
    ``folder``: data folder inside the ZIP (``'App Data'``); ``''``/``None`` for a flat archive.
    ``days=0`` yields an export where every file is header-only.
    """
    if delimiter not in (";", ","):
        raise ValueError("delimiter must be ';' or ','")
    ex = _Export(days)
    ex.daily()
    ex.sleep_sessions()
    ex.documents()
    ex.streams()
    ex.extras()

    prefix = f"{folder.rstrip('/')}/" if folder else ""
    written: Dict[str, int] = {}
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for stem, alt, header, rows, bom in ex.files:
            for fname, part in _file_names(stem, alt, naming, rows, ex.days):
                zf.writestr(prefix + fname, _write_csv(header, part, delimiter, bom and fname not in written))
                written[fname] = len(part)
        # Distractors that exist in real archives and must be ignored
        zf.writestr("Subscriptions/account.csv", _write_csv(["id", "created_at", "email"],
                                                            [["acc-1", "2023-12-20T10:00:00Z", "user@example.com"]],
                                                            delimiter, False))
        zf.writestr("Partner Event Store/events.ndjson", b"")
    ex.expected["files"] = written
    ex.expected["naming"] = naming
    ex.expected["delimiter"] = delimiter
    return ex.expected


if __name__ == "__main__":  # pragma: no cover - manual helper
    out = "oura_export.zip"
    n = 14
    args = sys.argv[1:]
    if "--days" in args:
        n = int(args[args.index("--days") + 1])
        del args[args.index("--days"):args.index("--days") + 2]
    if args:
        out = args[0]
    info = build_export_zip(out, days=n)
    print(f"wrote {os.path.abspath(out)}: {len(info['files'])} files, {n} days")
