"""History-event decoding.

Every history event the ring streams is ``tag | len | ring_ts:u32 | body``.
``ring_ts`` is a monotonic counter in **deciseconds** (100 ms per tick) that
doubles as the sync cursor; it is mapped to wall-clock time with the ring's own
time-sync anchors (tags 0x42 / 0x85), see :class:`TimeAnchor`.

Bodies are decoded for the record types whose layout has been recovered and
validated by the community against the phone app's database. Everything else is
kept raw (hex) so nothing is lost and decoders can be added later.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from .protocol import Packet

EVENT_NAMES = {
    0x41: "ring_start", 0x42: "time_sync", 0x43: "debug_event", 0x44: "ibi_event", 0x45: "state_change",
    0x46: "temp_event", 0x47: "motion_event", 0x48: "sleep_period_information", 0x49: "sleep_summary_1",
    0x4A: "ppg_amplitude", 0x4B: "sleep_phase_information", 0x4C: "sleep_summary_2",
    0x4D: "ring_sleep_feature_information", 0x4E: "sleep_phase_details", 0x4F: "sleep_summary_3",
    0x50: "activity_information", 0x51: "activity_summary_1", 0x52: "activity_summary_2", 0x53: "wear_event",
    0x54: "recovery_summary", 0x55: "sleep_heart_rate", 0x56: "alert_event", 0x57: "ring_sleep_feature_information_2",
    0x58: "sleep_summary_4", 0x59: "eda_event", 0x5A: "sleep_phase_data", 0x5B: "ble_connection",
    0x5C: "user_information", 0x5D: "hrv_event", 0x5E: "self_test_event", 0x5F: "raw_acm_event",
    0x60: "ibi_and_amplitude_event", 0x61: "debug_data", 0x62: "on_demand_meas", 0x63: "ppg_peak_event",
    0x64: "raw_ppg_event", 0x65: "on_demand_session", 0x66: "on_demand_motion", 0x67: "raw_ppg_summary",
    0x68: "raw_ppg_data", 0x69: "temp_period", 0x6A: "sleep_period_information_2", 0x6B: "motion_period",
    0x6C: "feature_session", 0x6D: "meas_quality_event", 0x6E: "spo2_ibi_and_amplitude_event", 0x6F: "spo2_event",
    0x70: "spo2_smoothed_event", 0x71: "green_ibi_and_amplitude_event", 0x72: "sleep_acm_period",
    0x73: "ehr_trace_event", 0x74: "ehr_acm_intensity_event", 0x75: "sleep_temp_event", 0x76: "bedtime_period",
    0x77: "spo2_dc_event", 0x79: "self_test_data_event", 0x7A: "tag_event", 0x7E: "real_step_event_feature_1",
    0x7F: "real_step_event_feature_2", 0x80: "green_ibi_quality_event", 0x81: "cva_raw_ppg_data",
    0x82: "scan_start", 0x83: "scan_end", 0x84: "ambient_event", 0x85: "rtc_beacon", 0x86: "aohr_event",
    0x8B: "spo2_r_pi_event",
}

STATE_NAMES = {1: "not_on_finger", 2: "on_finger", 3: "sleep", 4: "awake", 5: "active", 6: "rest", 7: "moving", 8: "charging"}
SLEEP_PHASES = ["deep", "light", "rem", "awake"]
TICKS_PER_SECOND = 10  # ring_ts is in 100 ms units


@dataclass
class RingEvent:
    tag: int
    ring_ts: int
    body: bytes

    @property
    def name(self) -> str:
        return EVENT_NAMES.get(self.tag, f"unknown_0x{self.tag:02x}")

    @staticmethod
    def from_packet(p: Packet) -> Optional["RingEvent"]:
        if not p.is_event or len(p.payload) < 4:
            return None
        ts = struct.unpack_from("<I", p.payload, 0)[0]
        return RingEvent(p.tag, ts, bytes(p.payload[4:]))

    def decode(self) -> Optional[Dict[str, Any]]:
        fn = DECODERS.get(self.tag)
        if fn is None:
            return None
        try:
            return fn(self.body)
        except Exception:  # malformed body: keep raw
            return None


# ---------------------------------------------------------------- helpers
def _u16(b: bytes, o: int) -> int:
    return b[o] | (b[o + 1] << 8)


def _i16(b: bytes, o: int) -> int:
    return struct.unpack_from("<h", b, o)[0]


def _u32(b: bytes, o: int) -> int:
    return struct.unpack_from("<I", b, o)[0]


def _i8(v: int) -> int:
    return v - 256 if v & 0x80 else v


def _bpm(ibi_ms: int) -> Optional[int]:
    return 60000 // ibi_ms if 300 <= ibi_ms <= 2000 else None


# --------------------------------------------------------------- decoders
def dec_ring_start(b: bytes) -> Optional[dict]:
    if len(b) < 14:
        return None
    v = lambda o: f"{b[o]}.{b[o+1]}.{b[o+2]}"  # noqa: E731
    return {"reason": _u32(b, 0), "firmware_version": v(5), "bootloader_version": v(8), "api_version": v(11)}


def dec_time_sync(b: bytes) -> Optional[dict]:
    """``token:u8 | counter:u24 | const*5`` where counter = unix // 256."""
    if len(b) >= 9:
        counter = b[1] | (b[2] << 8) | (b[3] << 16)
        return {"token": b[0], "unix_time_approx": counter * 256}
    if len(b) >= 4:
        return {"unix_time_approx": _u32(b, 0)}
    return None


def dec_ascii(b: bytes) -> Optional[dict]:
    text = b.decode("ascii", "replace").rstrip("\x00").strip()
    return {"text": text} if text else None


def dec_state(b: bytes) -> Optional[dict]:
    if not b:
        return None
    return {"state": b[0], "state_name": STATE_NAMES.get(b[0], "unknown"), "text": b[1:].decode("ascii", "replace").rstrip("\x00")}


def dec_temperatures(b: bytes) -> Optional[dict]:
    """int16 LE centi-degrees; -327.68 is the missing-channel sentinel."""
    if not b or len(b) % 2:
        return None
    temps = []
    for i in range(0, len(b), 2):
        v = _i16(b, i) / 100.0
        temps.append(None if v == -327.68 or not -40 <= v <= 85 else round(v, 2))
    if all(t is None for t in temps):
        return None
    return {"temps_c": temps}


def dec_hrv(b: bytes) -> Optional[dict]:
    """Pairs of (avg HR bpm, RMSSD ms), one per 5-minute window, newest last."""
    if not b or len(b) % 2:
        return None
    return {"samples_5min": [{"hr_bpm": b[i], "rmssd_ms": b[i + 1]} for i in range(0, len(b), 2)]}


def dec_ibi_amplitude(b: bytes) -> Optional[dict]:
    """14-byte packed 6×(IBI ms 11-bit, PPG amplitude 7-bit) — validated vs app DB."""
    if len(b) != 14:
        return None
    b12, b13 = b[12], b[13]
    mid = [(b12 >> 5) & 6, (b12 >> 3) & 6, (b12 >> 1) & 6, (b12 << 1) & 6, (b13 >> 5) & 6, (b13 >> 3) & 6]
    ibi = [(b[i] << 3) | mid[i] | (b[6 + i] & 1) for i in range(6)]
    nib = b13 & 0x0F
    shift = 0 if nib == 7 else nib + 1
    amp = [(b[6 + i] >> 1) << shift for i in range(6)]
    return {"ibi_ms": ibi, "amplitude": amp, "hr_bpm": [x for x in (_bpm(i) for i in ibi) if x]}


def dec_green_ibi_quality(b: bytes) -> Optional[dict]:
    if len(b) < 2 or len(b) % 2:
        return None
    ibi, quality, hr = [], [], []
    for i in range(0, len(b), 2):
        v = (b[i] << 3) | (b[i + 1] & 7)
        q = (b[i + 1] >> 3) & 3
        ibi.append(v)
        quality.append(q)
        if q == 1 and (x := _bpm(v)):
            hr.append(x)
    return {"ibi_ms": ibi, "quality": quality, "hr_bpm": hr}


def dec_spo2(b: bytes) -> Optional[dict]:
    if len(b) < 2:
        return None
    end = len(b) - 1 if b[-1] == 0xFF else len(b)
    vals = [x for x in b[1:end] if 50 <= x <= 100]
    return {"spo2_percent": vals} if vals else None


def dec_spo2_r_pi(b: bytes) -> Optional[dict]:
    if len(b) < 4 or (len(b) - 1) % 3:
        return None
    r, pi = [], []
    for o in range(1, len(b) - 2, 3):
        r.append(round(((b[o] << 8) | b[o + 1]) / 16384.0, 4))
        pi.append(round(b[o + 2] / 255.0 * 0.05, 4))
    return {"r": r, "perfusion_index": pi}


def dec_sleep_phases(b: bytes) -> Optional[dict]:
    """Header byte then 2-bit phase codes, 4 per byte MSB-first (deep/light/rem/awake)."""
    if len(b) < 2:
        return None
    phases = []
    for x in b[1:]:
        for s in (6, 4, 2, 0):
            phases.append(SLEEP_PHASES[(x >> s) & 3])
    return {"header": b[0], "phases": phases}


def dec_activity_info(b: bytes) -> Optional[dict]:
    """State byte + per-minute MET levels (b<128 → b*0.1, else 12.8+(b-128)*0.2)."""
    if not b:
        return None
    met = [round(x * 0.1, 2) if x < 128 else round(12.8 + (x - 128) * 0.2, 2) for x in b[1:]]
    return {"state": b[0], "met": met}


def dec_motion(b: bytes) -> Optional[dict]:
    if len(b) < 4:
        return None
    out = {"orientation": b[0] >> 5, "motion_seconds": b[0] & 0x1F, "avg_x": _i8(b[1]) * 8, "avg_y": _i8(b[2]) * 8, "avg_z": _i8(b[3]) * 8}
    if len(b) >= 5:
        out["low_intensity"] = b[4] & 0x3F
    if len(b) >= 6:
        out["high_intensity"] = b[5] & 0x3F
    return out


def dec_motion_period(b: bytes) -> Optional[dict]:
    if len(b) < 2:
        return None
    header = b[0]
    last_count = (header >> 4) & 3
    levels: List[int] = []
    body = b[1:]
    for i, x in enumerate(body):
        n = last_count if i == len(body) - 1 else 4
        for k in range(n):
            levels.append((x >> (6 - 2 * k)) & 3)
    return {"period_type": header >> 6, "motion_levels": levels}


def dec_bedtime_period(b: bytes) -> Optional[dict]:
    if len(b) < 8:
        return None
    start, end = _u32(b, 0), _u32(b, 4)
    return {"start_ring_ts": start, "end_ring_ts": end, "duration_s": max(0, end - start) / TICKS_PER_SECOND}


def dec_sleep_period_info(b: bytes) -> Optional[dict]:
    if len(b) < 10 or b[6] >= 120 or not 0 <= _i8(b[7]) <= 2:
        return None
    return {
        "average_hr": round(b[0] * 0.5, 2),
        "hr_trend": round(_i8(b[1]) * 0.0625, 4),
        "breath": round(b[4] / 8.0, 3),
        "breath_variability": round(b[5] / 8.0, 3),
        "motion_count": b[6],
        "sleep_state": _i8(b[7]),
        "cv": round(_u16(b, 8) / 65536.0, 4),
    }


def dec_sleep_acm_period(b: bytes) -> Optional[dict]:
    if len(b) < 12:
        return None
    fp = lambda frac, i: i + frac / 255.0  # noqa: E731
    q12 = lambda lo, hi: ((lo | ((hi & 0x0F) << 8)) / 4095.0) + (hi >> 4)  # noqa: E731
    return {"acm_mad": [round(v, 4) for v in (fp(b[0], b[1]), fp(b[2], b[3]), fp(b[4], b[5]), q12(b[6], b[7]), q12(b[8], b[9]), q12(b[10], b[11]))]}


def dec_feature_session(b: bytes) -> Optional[dict]:
    if len(b) < 2:
        return None
    out = {"feature_id": b[0], "session_status": b[1]}
    if len(b) >= 4:
        out["value"] = _u16(b, 2)
    return out


def dec_rtc_beacon(b: bytes) -> Optional[dict]:
    if len(b) < 4:
        return None
    return {"unix_time": _u32(b, 0)}


def dec_u16_samples(key: str) -> Callable[[bytes], Optional[dict]]:
    def fn(b: bytes) -> Optional[dict]:
        if not b or len(b) % 2:
            return None
        return {key: [_u16(b, i) for i in range(0, len(b), 2)]}

    return fn


def dec_cva_raw_ppg(b: bytes) -> Optional[dict]:
    if not b:
        return None
    samples, acc, i = [], 0, 0
    while i < len(b):
        x = b[i]
        if x == 0x80 and i + 3 < len(b):
            raw = b[i + 1] | (b[i + 2] << 8) | (b[i + 3] << 16)
            acc = raw - (1 << 24) if raw & 0x800000 else raw
            i += 4
        else:
            acc += _i8(x)
            i += 1
        samples.append(acc)
    return {"ppg_samples": samples, "n": len(samples)}


def dec_debug_data(b: bytes) -> Optional[dict]:
    if not b:
        return None
    if all(x == 0 or 0x20 <= x < 0x7F for x in b):
        return dec_ascii(b)
    if b[0] == 0x24 and len(b) >= 4:
        return {"kind": "battery_level_changed", "battery_pct": b[1], "voltage_mv": _u16(b, 2)}
    return {"kind": "debug_data", "subtype": b[0], "raw": b.hex()}


def dec_user_information(b: bytes) -> Optional[dict]:
    if len(b) < 4:
        return None
    return {"age_years": b[0], "weight_kg": b[1], "sex_code": b[2], "height_cm": b[3]}


def dec_aohr(b: bytes) -> Optional[dict]:
    if len(b) < 3 or len(b) != b[2] * 2 + 3:
        return None
    n = b[2]
    return {"interval_ms": 1920, "bpm": [b[3 + 2 * i] for i in range(n)], "quality": [b[4 + 2 * i] for i in range(n)]}


DECODERS: Dict[int, Callable[[bytes], Optional[dict]]] = {
    0x41: dec_ring_start,
    0x42: dec_time_sync,
    0x43: dec_ascii,
    0x45: dec_state,
    0x53: dec_state,
    0x46: dec_temperatures,
    0x69: dec_temperatures,
    0x75: dec_temperatures,
    0x47: dec_motion,
    0x4B: dec_sleep_phases,
    0x4E: dec_sleep_phases,
    0x5A: dec_sleep_phases,
    0x50: dec_activity_info,
    0x5C: dec_user_information,
    0x5D: dec_hrv,
    0x60: dec_ibi_amplitude,
    0x61: dec_debug_data,
    0x6A: dec_sleep_period_info,
    0x6B: dec_motion_period,
    0x6C: dec_feature_session,
    0x6F: dec_spo2,
    0x72: dec_sleep_acm_period,
    0x74: dec_u16_samples("intensity"),
    0x76: dec_bedtime_period,
    0x80: dec_green_ibi_quality,
    0x81: dec_cva_raw_ppg,
    0x85: dec_rtc_beacon,
    0x86: dec_aohr,
    0x8B: dec_spo2_r_pi,
}


# ------------------------------------------------------------- time map
@dataclass
class TimeAnchor:
    """Maps ring deciseconds to unix seconds using the latest anchor event.

    ``rtc_beacon`` (0x85) is exact to the second; ``time_sync`` (0x42) is only
    accurate to 256 s, so a beacon always wins when both are seen.
    """

    ring_ts: Optional[int] = None
    unix: Optional[float] = None
    precise: bool = False

    def observe(self, ev: RingEvent, decoded: Optional[dict]) -> None:
        if not decoded:
            return
        if ev.tag == 0x85 and "unix_time" in decoded:
            self.ring_ts, self.unix, self.precise = ev.ring_ts, float(decoded["unix_time"]), True
        elif ev.tag == 0x42 and "unix_time_approx" in decoded and not self.precise:
            self.ring_ts, self.unix = ev.ring_ts, float(decoded["unix_time_approx"])

    def observe_host(self, ring_ts: int, unix: float) -> None:
        """Anchor on a value we set ourselves (after a time-sync request)."""
        self.ring_ts, self.unix, self.precise = ring_ts, unix, True

    def to_unix(self, ring_ts: int) -> Optional[float]:
        if self.ring_ts is None or self.unix is None:
            return None
        return self.unix + (ring_ts - self.ring_ts) / TICKS_PER_SECOND

    def as_dict(self) -> dict:
        return {"ring_ts": self.ring_ts, "unix": self.unix, "precise": self.precise}
