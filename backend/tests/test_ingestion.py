"""Offline Oura data-export ZIP importer."""
import os
import tempfile
import zipfile
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from backend.src.ingestion import OuraParser
from backend.src.ingestion import reader
from backend.src.ingestion.base import IngestionBase
from backend.src.models import (
    Activity, Base, CardiovascularAge, HeartRate, Meditation, Readiness, Resilience, RingBattery,
    RingConfiguration, Sleep, SleepSession, Tag, Temperature, Vo2Max, Workout,
)
from backend.tests.fixtures.make_export import LOCAL_TZ, TAG_COMMENT, build_export_zip

ALL_TABLES = [Sleep, Readiness, Activity, Resilience, SleepSession, Workout, Meditation, HeartRate,
              Temperature, RingBattery, RingConfiguration, Tag, CardiovascularAge, Vo2Max]


def make_db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def table_counts(db):
    return {m.__tablename__: len(db.scalars(select(m)).all()) for m in ALL_TABLES}


def local(iso: str) -> datetime:
    """Expected stored value: aware ISO -> LOCAL_TZ wall clock, naive."""
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(LOCAL_TZ).replace(tzinfo=None)


@pytest.fixture(scope="module")
def export():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "oura_export.zip")
        expected = build_export_zip(path, days=14)
        yield path, expected


@pytest.fixture(scope="module")
def imported(export):
    path, expected = export
    db = make_db()
    summary = OuraParser(db, tz=LOCAL_TZ).parse_zip(path)
    return db, summary, expected


# ----------------------------------------------------------------- summary / counts
def test_parse_zip_returns_summary_dict(imported):
    db, summary, expected = imported
    assert set(summary) == {"files", "tables", "warnings"}
    assert summary["files"]["dailysleep.csv"] == 14
    assert summary["files"]["sleepmodel.csv"] == expected["sleep_rows"]
    assert summary["files"]["heartrate.csv"] == expected["heartrate_rows"]
    assert "bloodglucose.csv" not in summary["files"]  # unknown files are ignored
    assert "account.csv" not in summary["files"]
    assert all(isinstance(v, int) for v in summary["files"].values())
    assert summary["warnings"] == []
    assert summary["tables"] == table_counts(db)


def test_row_counts_per_table(imported):
    db, summary, exp = imported
    counts = table_counts(db)
    assert counts == {
        "sleep": 14, "readiness": 14, "activity": exp["activity_days"], "resilience": 14,
        "sleep_session": exp["sleep_sessions"], "workout": exp["workouts"], "meditation": exp["meditations"],
        "heart_rate": exp["heartrate_rows"], "temperature": exp["temperature_rows"],
        "ring_battery": exp["battery_rows"], "ring_configuration": 1, "tag": exp["tags"],
        "cardiovascular_age": exp["cva_rows"], "vo2max": exp["vo2max_rows"],
    }


# ----------------------------------------------------------------- sleep
def test_sleep_merges_sleeptime_and_spo2_by_day(imported):
    db, _, exp = imported
    day = date(2024, 1, 2)
    row = db.scalars(select(Sleep).where(Sleep.day == day)).one()
    assert row.id == "ds-1"
    assert row.score == 71
    assert row.contributors["deep_sleep"] == 61
    assert row.average_spo2 == pytest.approx(exp["spo2"][day.isoformat()])
    assert row.breathing_disturbance_index == exp["bdi"][day.isoformat()]
    assert row.optimal_bedtime == {"day_tz": -18000, "end_offset": -1740, "start_offset": -5400}
    assert row.recommendation == "follow_optimal_bedtime" and row.status == "optimal_found"
    # a day whose sleeptime row had empty ;; values
    empty = db.scalars(select(Sleep).where(Sleep.day == date(2024, 1, 4))).one()
    assert empty.optimal_bedtime is None and empty.recommendation is None
    assert empty.status == "not_enough_nights"


def test_sleep_sessions_skip_deleted_and_parse_booleans(imported):
    db, _, exp = imported
    sessions = db.scalars(select(SleepSession)).all()
    assert len(sessions) == exp["sleep_sessions"] == exp["sleep_rows"] - 1
    assert not any(s.type == "deleted" for s in sessions)
    assert {s.type for s in sessions} == {"long_sleep", "late_nap"}
    by_id = {s.id: s for s in sessions}
    assert "sl-deleted" not in by_id
    assert by_id["sl-2"].low_battery_alert is True
    assert by_id["sl-1"].low_battery_alert is False
    assert by_id["sl-1"].time_in_bed == 8 * 3600 + 5 * 60
    assert by_id["sl-1"].sleep_algorithm_version == "v2"
    assert by_id["sl-1"].readiness["contributors"]["hrv_balance"] == 70


def test_hr_data_uses_json_timestamp_and_interval(imported):
    db, _, exp = imported
    s = db.scalars(select(SleepSession).where(SleepSession.id == "sl-1")).one()
    spec = exp["hr_series"]["sl-1"]
    assert s.hr_data is not None and len(s.hr_data) == spec["n"]
    first = datetime.fromisoformat(s.hr_data[0]["timestamp"])
    assert first == local(spec["timestamp"])
    assert first.tzinfo is None
    for a, b in zip(s.hr_data, s.hr_data[1:]):
        assert datetime.fromisoformat(b["timestamp"]) - datetime.fromisoformat(a["timestamp"]) == timedelta(seconds=300)
    assert any(item["value"] is None for item in s.hr_data)  # nulls inside the JSON survive
    assert len(s.hrv_data) == spec["n"]
    # digit strings anchored at bedtime_start (local wall clock) and spaced by their own cadence
    assert s.bedtime_start == local(spec["timestamp"])
    assert datetime.fromisoformat(s.sleep_phase_5_min[0]["timestamp"]) == s.bedtime_start
    assert datetime.fromisoformat(s.sleep_phase_5_min[1]["timestamp"]) == s.bedtime_start + timedelta(minutes=5)
    assert datetime.fromisoformat(s.movement_30_sec[1]["timestamp"]) == s.bedtime_start + timedelta(seconds=30)
    assert datetime.fromisoformat(s.sleep_phase_30_sec[3]["timestamp"]) == s.bedtime_start + timedelta(seconds=90)
    assert {p["value"] for p in s.sleep_phase_5_min} <= {1, 2, 3, 4}


# ----------------------------------------------------------------- activity / readiness
def test_activity_met_class_and_stress(imported):
    db, _, exp = imported
    day = date(2024, 1, 3)
    a = db.scalars(select(Activity).where(Activity.day == day)).one()
    assert a.average_met == pytest.approx(1.2 + 0.05 * 2)  # from average_met_minutes (no average_met column)
    assert a.steps == 6600 and a.score == 62 and a.contributors["move_every_hour"] == 90
    assert len(a.class_5_min) == 288
    assert a.class_5_min[0]["timestamp"] == "2024-01-03T00:00:00"
    assert a.class_5_min[1]["timestamp"] == "2024-01-03T00:05:00"
    # met anchored at the JSON's own timestamp (04:00 local), spaced by its own interval (60 s)
    assert a.met[0]["timestamp"] == "2024-01-03T04:00:00"
    assert a.met[1]["timestamp"] == "2024-01-03T04:01:00"
    assert len(a.met) == 1440
    # daytimestress merged into activity.stress per day
    assert len(a.stress) == exp["stress_points"][day.isoformat()]
    assert a.stress[0]["timestamp"] == "2024-01-03T06:00:00"
    assert a.stress[5]["stress"] is None  # the empty ;; value
    assert all(isinstance(p["recovery"], int) for p in a.stress)


def test_readiness_merges_dailystress_and_resilience_flattens(imported):
    db, _, _ = imported
    r = db.scalars(select(Readiness).where(Readiness.day == date(2024, 1, 1))).one()
    assert r.score == 65 and r.day_summary == "restored"
    assert r.stress_high == 900 and r.recovery_high == 1800
    assert r.temperature_trend_deviation is None  # written as ;;
    assert r.contributors["sleep_regularity"] == 77
    r2 = db.scalars(select(Readiness).where(Readiness.day == date(2024, 1, 2))).one()
    assert r2.temperature_trend_deviation == pytest.approx(0.1)
    res = db.scalars(select(Resilience).where(Resilience.day == date(2024, 1, 1))).one()
    assert (res.level, res.sleep_recovery, res.daytime_recovery, res.stress) == ("limited", 70.5, 60.25, 55.0)


# ----------------------------------------------------------------- documents & streams
def test_tag_with_delimiter_and_newline_round_trips(imported):
    db, _, exp = imported
    tag = db.scalars(select(Tag).where(Tag.id == exp["tag_id"])).one()
    assert tag.comment == TAG_COMMENT
    assert ";" in tag.comment and "\n" in tag.comment
    assert tag.tag_type_code == "tag_generic_caffeine"
    assert tag.start_time == datetime(2024, 1, 1, 21, 0)
    assert tag.end_time == datetime(2024, 1, 1, 22, 0)
    quoted = db.scalars(select(Tag).where(Tag.id == "tag-2")).one()
    assert quoted.comment == 'He said "hi"'
    assert quoted.end_time == datetime(2024, 1, 1, 0, 0)  # falls back to end_day
    empty = db.scalars(select(Tag).where(Tag.id == "tag-3")).one()
    assert empty.comment is None


def test_workout_meditation_and_metadata(imported):
    db, _, _ = imported
    w = db.scalars(select(Workout).where(Workout.id == "wo-0")).one()
    assert w.activity == "running" and w.label == "Run, easy" and w.source == "workout_heart_rate"
    assert w.start_time == datetime(2024, 1, 1, 17, 30) and w.end_time == datetime(2024, 1, 1, 18, 15)
    assert w.distance == pytest.approx(8751.47)
    w2 = db.scalars(select(Workout).where(Workout.id == "wo-2")).one()
    assert w2.label is None
    m = db.scalars(select(Meditation).where(Meditation.id == "se-1")).one()
    assert m.type == "meditation" and m.mood == "great" and m.day == date(2024, 1, 2)
    rc = db.scalars(select(RingConfiguration)).one()
    assert (rc.firmware_version, rc.size, rc.color, rc.hardware_type) == ("3.4.3", 9, "silver", "gen3")
    v = db.scalars(select(Vo2Max).where(Vo2Max.day == date(2024, 1, 8))).one()
    assert v.id == "vo-7" and v.vo2_max == pytest.approx(42.1)
    assert v.timestamp == datetime(2024, 1, 8, 9, 0)
    c = db.scalars(select(CardiovascularAge).where(CardiovascularAge.day == date(2024, 1, 1))).one()
    assert c.vascular_age == 30


def test_streams_store_local_naive_timestamps(imported):
    db, _, exp = imported
    first = min(db.scalars(select(HeartRate)).all(), key=lambda h: h.timestamp)
    assert first.timestamp == local(exp["first_hr_utc"]) == datetime(2023, 12, 31, 19, 0)
    assert first.timestamp.tzinfo is None
    assert first.source == "rest" and isinstance(first.bpm, int)
    t = min(db.scalars(select(Temperature)).all(), key=lambda x: x.timestamp)
    assert t.timestamp == datetime(2023, 12, 31, 19, 0)
    b = db.scalars(select(RingBattery).where(RingBattery.timestamp == datetime(2024, 1, 1, 17, 0))).one()  # 22:00Z
    assert b.charging is True and b.in_charger is True and b.level == 12
    b2 = db.scalars(select(RingBattery).where(RingBattery.timestamp == datetime(2024, 1, 1, 0, 0))).one()  # 05:00Z
    assert b2.charging is False and b2.level == 80


# ----------------------------------------------------------------- idempotency & variants
def test_reimport_is_idempotent(export):
    path, _ = export
    db = make_db()
    parser = OuraParser(db, tz=LOCAL_TZ)
    first = parser.parse_zip(path)
    before = table_counts(db)
    ids_before = {s.id for s in db.scalars(select(Sleep)).all()}
    second = parser.parse_zip(path)
    assert table_counts(db) == before
    assert second["tables"] == first["tables"]
    assert second["warnings"] == []
    assert {s.id for s in db.scalars(select(Sleep)).all()} == ids_before


def test_reimport_with_new_ids_does_not_raise(export):
    """Day-keyed tables keep their primary key when the same day arrives with another id."""
    path, _ = export
    db = make_db()
    OuraParser(db, tz=LOCAL_TZ).parse_zip(path)
    proc = OuraParser(db, tz=LOCAL_TZ)
    n = proc.upsert(Sleep, [{"id": "brand-new-id", "day": date(2024, 1, 2), "score": 1}], ["day"])
    assert n == 1
    row = db.scalars(select(Sleep).where(Sleep.day == date(2024, 1, 2))).one()
    assert row.id == "ds-1" and row.score == 1
    assert len(db.scalars(select(Sleep)).all()) == 14


def _snapshot(db):
    """Sorted, id-independent view of every table for cross-variant comparison."""
    out = {}
    for m in ALL_TABLES:
        rows = []
        for obj in db.scalars(select(m)).all():
            rows.append(tuple(sorted((c.name, repr(getattr(obj, c.name))) for c in m.__table__.columns)))
        out[m.__tablename__] = sorted(rows)
    return out


@pytest.mark.parametrize("naming,delimiter,folder", [
    ("suffixed", ",", "App Data"),
    ("suffixed", ";", "export/App Data"),
    ("exact", ",", ""),
])
def test_alternate_layouts_import_identically(imported, naming, delimiter, folder):
    db_exact, _, _ = imported
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "alt.zip")
        expected = build_export_zip(path, days=14, naming=naming, delimiter=delimiter, folder=folder)
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
        if naming == "suffixed":
            assert any(n.endswith("/sleep_2024-01-01_2024-01-07.csv") for n in names)
            assert any("/tag_2024-01-01" in n for n in names)
            assert not any("sleepmodel" in n or "enhancedtag" in n for n in names)
        db = make_db()
        summary = OuraParser(db, tz=LOCAL_TZ).parse_zip(path)
    assert summary["warnings"] == []
    assert summary["tables"] == table_counts(db_exact)
    assert _snapshot(db) == _snapshot(db_exact)
    assert sum(summary["files"].values()) == sum(v for v in expected["files"].values())
    if naming == "suffixed":
        assert summary["files"]["sleep_2024-01-01_2024-01-07.csv"] + summary["files"]["sleep_2024-01-08_2024-01-14.csv"] == expected["sleep_rows"]


def test_header_only_export_imports_nothing_without_errors():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "empty.zip")
        build_export_zip(path, days=0)
        db = make_db()
        summary = OuraParser(db, tz=LOCAL_TZ).parse_zip(path)
    assert summary["warnings"] == []
    assert all(v == 0 for v in summary["files"].values()) and summary["files"]
    assert all(v == 0 for v in summary["tables"].values())
    assert all(v == 0 for v in table_counts(db).values())


# ----------------------------------------------------------------- error isolation
def test_bad_file_and_bad_processor_do_not_abort_import(export, monkeypatch):
    path, exp = export
    real_read = reader.read_csv

    def flaky_read(p):
        if os.path.basename(p) == "workout.csv":
            raise OSError("disk on fire")
        return real_read(p)

    monkeypatch.setattr(reader, "read_csv", flaky_read)

    from backend.src.ingestion.processors.common import CommonProcessor

    def boom(self, rows):
        raise RuntimeError("temperature exploded")

    monkeypatch.setattr(CommonProcessor, "process_temperature", boom)

    db = make_db()
    summary = OuraParser(db, tz=LOCAL_TZ).parse_zip(path)
    counts = table_counts(db)
    assert counts["sleep"] == 14 and counts["heart_rate"] == exp["heartrate_rows"]
    assert counts["workout"] == 0 and counts["temperature"] == 0
    assert summary["files"]["workout.csv"].startswith("error:")
    assert summary["tables"]["temperature"] == 0
    assert any("workout.csv" in w for w in summary["warnings"])
    assert any("temperature" in w and "exploded" in w for w in summary["warnings"])


def test_bad_row_is_skipped_and_reported():
    db = make_db()
    parser = OuraParser(db, tz=LOCAL_TZ)
    rows = [
        {"id": "a", "day": "2024-01-01", "vascular_age": "30"},
        {"id": "b", "day": "", "vascular_age": "31"},  # no day -> skipped
        {"id": "c", "day": "2024-01-03", "vascular_age": "not a number"},  # tolerated -> None
    ]
    assert parser.common_processor.process_cardiovascular_age(rows) == 2
    assert any("dailycardiovascularage" in w and "b" in w for w in parser.warnings)
    c = db.scalars(select(CardiovascularAge).where(CardiovascularAge.id == "c")).one()
    assert c.vascular_age is None


def test_invalid_zip_returns_summary_with_warning():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "bogus.zip")
        with open(path, "wb") as fh:
            fh.write(b"not a zip")
        summary = OuraParser(make_db()).parse_zip(path)
    assert summary["files"] == {} and summary["tables"] == {}
    assert summary["warnings"] and "ZIP" in summary["warnings"][0]


# ----------------------------------------------------------------- reader & helpers
@pytest.mark.parametrize("name,expected", [
    ("dailysleep.csv", "dailysleep"),
    ("DailySleep.CSV", "dailysleep"),
    ("dailysleep_2024-01-01_2024-12-31.csv", "dailysleep"),
    ("dailysleep_2024-01-01.csv", "dailysleep"),
    ("sleepmodel.csv", "sleep_session"),
    ("sleep.csv", "sleep_session"),
    ("sleep_2024-01-01_2024-12-31.csv", "sleep_session"),
    ("sleeptime.csv", "sleeptime"),
    ("enhancedtag.csv", "tag"),
    ("tag.csv", "tag"),
    ("vo2max.csv", "vo2max"),
    ("workoutheartratesession.csv", None),
    ("dailyvo2maxestimate.csv", None),
    ("bloodglucose.csv", None),
    ("account.csv", None),
    ("sleep_notes.csv", None),
])
def test_classify_filename(name, expected):
    assert reader.classify_filename(name) == expected


def test_sniff_delimiter():
    assert reader.sniff_delimiter("id;day;score\r\n") == ";"
    assert reader.sniff_delimiter("id,day,score\r\n") == ","
    assert reader.sniff_delimiter("timestamp\r\n") == ";"


def test_read_csv_handles_bom_quotes_and_short_rows():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "enhancedtag.csv")
        with open(p, "wb") as fh:
            fh.write(b"\xef\xbb\xbfid;comment;day\r\n")
            fh.write(b'1;"a; b\r\nc ""q""";2024-01-01\r\n')
            fh.write(b"2;;\r\n")
            fh.write(b"3;x\r\n")
            fh.write(b"\r\n")
        res = reader.read_csv(p)
    assert res.columns == ["id", "comment", "day"]
    assert res.rows[0] == {"id": "1", "comment": 'a; b\nc "q"', "day": "2024-01-01"}
    assert res.rows[1] == {"id": "2", "comment": "", "day": ""}
    assert res.rows[2] == {"id": "3", "comment": "x", "day": ""}
    assert len(res.rows) == 3 and res.warnings == []


def test_parse_helpers_timezone_and_sequences():
    base = IngestionBase(make_db(), tz=LOCAL_TZ)
    assert base.parse_datetime("2024-01-01T05:00:00Z") == datetime(2024, 1, 1, 0, 0)
    assert base.parse_datetime("2024-01-01T00:00:00+02:00") == datetime(2023, 12, 31, 17, 0)
    assert base.parse_datetime("2024-01-01T08:15:00") == datetime(2024, 1, 1, 8, 15)
    assert base.parse_datetime("") is None and base.parse_datetime(None) is None
    assert base.parse_date("2024-02-03") == date(2024, 2, 3)
    assert base.parse_date("2024-02-03T23:30:00-05:00") == date(2024, 2, 3)
    assert base.parse_bool("true") is True and base.parse_bool("0") is False and base.parse_bool("") is None
    assert base.parse_int("100.0") == 100 and base.parse_int("x") is None
    assert base.parse_json('{"a": 1}') == {"a": 1} and base.parse_json("2024") == 2024
    # digit strings only
    start = datetime(2024, 1, 1, 23, 0)
    assert base.digit_sequence("4422", start, 300) == [
        {"timestamp": "2024-01-01T23:00:00", "value": 4}, {"timestamp": "2024-01-01T23:05:00", "value": 4},
        {"timestamp": "2024-01-01T23:10:00", "value": 2}, {"timestamp": "2024-01-01T23:15:00", "value": 2}]
    assert base.digit_sequence("[1, 2]", start, 300) is None
    assert base.digit_sequence("", start, 300) is None
    # sample objects use their own timestamp + interval, not the fallback
    series = base.sample_series('{"interval": 60, "items": [1, null, 3], "timestamp": "2024-01-02T09:00:00Z"}',
                                start, 300)
    assert [s["timestamp"] for s in series] == ["2024-01-02T04:00:00", "2024-01-02T04:01:00", "2024-01-02T04:02:00"]
    assert [s["value"] for s in series] == [1, None, 3]
    assert base.sample_series("[5, 6]", start, 30)[1] == {"timestamp": "2024-01-01T23:00:30", "value": 6}
    assert base.sample_series("", start, 30) is None
