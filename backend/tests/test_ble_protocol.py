from backend.src.ble import protocol as P
from backend.src.ble.events import RingEvent, TimeAnchor, dec_hrv, dec_ibi_amplitude, dec_sleep_phases, dec_temperatures


def test_auth_proof_matches_published_vector():
    key = bytes.fromhex("4431967d8bacc2659743142b68391d9a")
    nonce = bytes.fromhex("0e2d6a0a08c99b4365f458e6e97382")
    assert P.auth_proof(key, nonce).hex() == "a38a8772d3acb6db5c2b516dd56987c8"
    assert P.req_authenticate(P.auth_proof(key, nonce)).hex() == "2f112da38a8772d3acb6db5c2b516dd56987c8"


def test_firmware_response_parses():
    (p,) = P.parse_many(bytes.fromhex("091202000003040301000105000cffeeddccbbaa"))
    info = P.DeviceInfo.parse(p)
    assert info.api_version == "2.0.0" and info.firmware_version == "3.4.3"
    assert info.bt_stack_version == "5.0.12" and info.mac == "aa:bb:cc:dd:ee:ff"


def test_parse_many_walks_packed_frames():
    frames = P.parse_many(bytes.fromhex("290100" "4606" "64000000" "1c0e" "110801000000000000"))
    assert [f.tag for f in frames] == [0x29, 0x46, 0x11]
    ev = RingEvent.from_packet(frames[1])
    assert ev.ring_ts == 100 and ev.decode() == {"temps_c": [36.12]}
    s = P.EventBatchSummary.parse(frames[2])
    assert s.events_received == 1 and s.bytes_left == 0


def test_request_builders():
    assert P.req_get_event(0, 8).hex() == "10090000000008ffffffff"
    assert P.req_get_event_ack(0x65).hex() == "10096500000000ffffffff"
    ts = P.req_sync_time_app(now=1700000000, token=0x11)
    assert ts.hex() == "120911" + (1700000000 // 256).to_bytes(3, "little").hex() + "00000000f6"
    assert P.req_set_feature_mode(2, 3).hex() == "2f03220203"
    assert P.req_event_subscribe(0x14, 0x1000).hex() == "18031400" + "10"


def test_capabilities_and_feature_status():
    (p,) = P.parse_many(bytes.fromhex("2f12020200050102020403030401050107000800"))
    caps = P.parse_capabilities(p)
    assert caps[0] == 5 and caps[2] == 4 and caps[8] == 0
    (fs,) = P.parse_many(bytes.fromhex("2f06210201110200"))
    st = P.FeatureStatus.parse(fs)
    assert st.feature == 2 and st.mode == 1 and st.state == 2
    assert P.is_auth_required(P.parse_many(bytes.fromhex("2f022f01"))[0])


def test_event_decoders():
    assert dec_hrv(bytes([60, 45, 58, 50])) == {"samples_5min": [{"hr_bpm": 60, "rmssd_ms": 45}, {"hr_bpm": 58, "rmssd_ms": 50}]}
    assert dec_temperatures(bytes.fromhex("0080")) is None  # sentinel only
    assert dec_sleep_phases(bytes([0, 0b00011011]))["phases"] == ["deep", "light", "rem", "awake"]
    # 6 IBIs of 800 ms: high byte = 800>>3 = 100, low bit 0, mid bits 0
    body = bytes([100] * 6 + [0] * 6 + [0, 7])
    d = dec_ibi_amplitude(body)
    assert d["ibi_ms"] == [800] * 6 and d["hr_bpm"] == [75] * 6


def test_time_anchor_prefers_precise_beacon():
    a = TimeAnchor()
    a.observe(RingEvent(0x42, 1000, b""), {"unix_time_approx": 1700000000})
    assert a.to_unix(1010) == 1700000001.0
    a.observe(RingEvent(0x85, 2000, b""), {"unix_time": 1700000123})
    assert a.precise and a.to_unix(2010) == 1700000124.0
    a.observe(RingEvent(0x42, 3000, b""), {"unix_time_approx": 1700000200})
    assert a.ring_ts == 2000  # coarse sync does not override the beacon


def test_live_hr_parse():
    (p,) = P.parse_many(bytes([0x2F, 0x08, 0x28, 0x02, 0x00, 0x02, 0x00, 0x00, 0x59, 0x13]))
    s = P.parse_live_hr(p)
    assert s.ibi_ms == 857 and s.bpm == 70


def test_live_beat_full_frame_with_skin_temperature():
    from backend.src.ble import protocol as P

    frame = bytes.fromhex("2f0f2802110200000104000000003 50d7f".replace(" ", ""))
    (p,) = P.parse_many(frame)
    b = P.parse_live_beat(p)
    assert b is not None
    assert b.ibi_ms == 1025 and b.validity == P.IBI_UNKNOWN and b.bpm is None
    assert b.status == 0x11 and b.state == 2 and b.skin_temp_c == 33.81 and b.pqi == 0x7F
    assert P.parse_live_hr(p) is None  # unknown validity is not displayed
    valid = bytes.fromhex("2f0f280211020000fb13000000009 90c7f".replace(" ", ""))
    (p2,) = P.parse_many(valid)
    b2 = P.parse_live_beat(p2)
    assert b2.ibi_ms == 1019 and b2.validity == P.IBI_VALID and b2.bpm == 58 and b2.skin_temp_c == 32.25
    assert P.parse_live_hr(p2).bpm == 58
    short = bytes.fromhex("2f08280200020000f811")
    (p3,) = P.parse_many(short)
    b3 = P.parse_live_beat(p3)
    assert b3.ibi_ms == 504 and b3.validity == P.IBI_VALID and b3.skin_temp_c is None
    inv = bytes.fromhex("2f082802000200004b22")
    (p4,) = P.parse_many(inv)
    assert P.parse_live_beat(p4).validity == P.IBI_INVALID and not P.parse_live_beat(p4).usable_for_hrv


def test_acm_frame_rate_and_seq():
    from backend.src.ble import protocol as P

    frame = bytes([0x33, 0x0E, 0x32, 0x07]) + (100).to_bytes(2, "little", signed=True) * 6
    (p,) = P.parse_many(frame)
    f = P.parse_acm_frame(p)
    assert f.rate_hz == 50 and f.seq == 7 and len(f.samples) == 2 and f.samples[1].z == 100


def test_state_notify_parse():
    from backend.src.ble import protocol as P

    (p,) = P.parse_many(bytes.fromhex("1f0420050300"))
    assert P.parse_state_notify(p) == {"state": 5, "mode": 3}
