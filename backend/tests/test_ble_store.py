"""Derivation from synthetic ring events into dashboard tables."""
import os
import struct
import tempfile

os.environ["CRACKED_OURA_DATA_DIR"] = tempfile.mkdtemp(prefix="cracked-oura-store-")

from sqlalchemy import create_engine, select  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from backend.src.ble.events import RingEvent, TimeAnchor  # noqa: E402
from backend.src.ble.store import derive, get_state, save_anchor, store_events  # noqa: E402
from backend.src.models import Activity, Base, HeartRate, Sleep, SleepSession, Temperature  # noqa: E402


def make_db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def ibi_event(ring_ts: int, ibi_ms: int) -> RingEvent:
    high = ibi_ms >> 3
    low = ibi_ms & 1
    mid = (ibi_ms >> 1) & 3
    b12 = (mid << 6) | (mid << 4) | (mid << 2) | mid
    b13 = (mid << 6) | (mid << 4) | 7
    body = bytes([high] * 6 + [low] * 6 + [b12, b13])
    return RingEvent(0x60, ring_ts, body)


def test_store_and_derive_sleep_night():
    db = make_db()
    serial = "TEST123"
    st = get_state(db, serial)
    anchor = TimeAnchor()
    t0_unix = 1_757_400_000  # 2025-09-09 ~06:40 UTC, arbitrary
    t0_ring = 100_000
    events = [RingEvent(0x85, t0_ring, struct.pack("<I", t0_unix) + b"\x00" * 6)]  # precise beacon
    # 8-hour night starting 1h after anchor
    s_ring, e_ring = t0_ring + 36_000, t0_ring + 36_000 + 8 * 3600 * 10
    events.append(RingEvent(0x76, e_ring, struct.pack("<II", s_ring, e_ring)))
    # 96 five-minute phases: deep, light, rem, awake repeating → 24 bytes of 0b00011011
    events.append(RingEvent(0x4B, e_ring - 10, bytes([0] + [0b00011011] * 24)))
    # HRV every 5 minutes for the night: hr 52, rmssd 60
    for i in range(0, 8 * 3600, 1800):
        events.append(RingEvent(0x5D, s_ring + i * 10, bytes([52, 60] * 6)))
    # daytime IBI at 75 bpm (800 ms) after waking
    for i in range(10):
        events.append(ibi_event(e_ring + 6000 + i * 600, 800))
    # skin temperature during sleep 35.9 C, and during day 33.0
    events.append(RingEvent(0x75, s_ring + 36_000, struct.pack("<h", 3590)))
    events.append(RingEvent(0x46, e_ring + 36_000, struct.pack("<hhh", 3300, 3100, -32768)))
    # activity: 10 minutes at 1.2 MET then 5 at 7 MET
    events.append(RingEvent(0x50, e_ring + 40_000, bytes([1] + [12] * 10 + [70] * 5)))

    inserted = store_events(db, serial, events, anchor)
    assert inserted == len(events)
    assert anchor.precise and anchor.to_unix(t0_ring + 10) == t0_unix + 1
    save_anchor(st, anchor)
    db.commit()
    # idempotent
    assert store_events(db, serial, events, anchor) == 0

    out = derive(db, serial)
    assert out["sleep_sessions"] == 1 and out["heart_rate"] >= 10 and out["temperature"] == 2

    s = db.scalars(select(SleepSession)).one()
    assert s.type == "long_sleep"
    assert s.time_in_bed == 8 * 3600
    assert s.deep_sleep_duration == 24 * 300 and s.awake_time == 24 * 300
    assert s.total_sleep_duration == 72 * 300
    assert s.efficiency == 75
    assert s.average_heart_rate == 52.0 and s.average_hrv == 60
    assert len(s.hrv_data) == 16 * 6 and len(s.sleep_phase_5_min) == 96
    assert db.scalars(select(Sleep)).one().score is None

    hr = db.scalars(select(HeartRate)).all()
    assert all(h.bpm == 75 for h in hr)
    temps = sorted(db.scalars(select(Temperature)).all(), key=lambda t: t.timestamp)
    assert temps[0].skin_temp == 35.9 and temps[1].skin_temp == 33.0

    act = db.scalars(select(Activity)).one()
    assert act.high_activity_time == 300 and act.sedentary_time == 600 and act.score is None
