"""Oura ring BLE protocol: GATT constants, packet framing, request builders,
response parsers and the app-auth proof.

Everything here is pure (no I/O) so it can be unit-tested with byte vectors.
Protocol facts come from public reverse-engineering of the ring firmware and
the Oura phone app (see docs/BLE.md). All integers are little-endian.

Frame layout on the wire: ``tag:u8 | len:u8 | payload[len]``. Several frames
may be packed into one ATT notification, so always use :func:`parse_many`.
Extended operations use outer tag ``0x2f`` with the sub-op as payload[0].
"""

from __future__ import annotations

import secrets
import struct
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# ----------------------------------------------------------------- GATT
OURA_SERVICE = "98ed0001-a541-11e4-b6a0-0002a5d5c51b"
OURA_WRITE = "98ed0002-a541-11e4-b6a0-0002a5d5c51b"
OURA_NOTIFY = "98ed0003-a541-11e4-b6a0-0002a5d5c51b"
CHARGER_SERVICE = "8bc5888f-c577-4f5d-857f-377354093f13"
OURA_COMPANY_ID = 0x02B2  # Bluetooth SIG: "Oura Health Oy"

# ----------------------------------------------------------- constants
AUTH_RESULTS = {0: "success", 1: "authentication_error", 2: "in_factory_reset", 3: "not_original_onboarded_device"}
FEATURE_MODES = {0: "off", 1: "automatic", 2: "requested", 3: "connected_live"}
FEATURE_STATES = {0: "idle", 1: "scanning", 2: "measuring", 3: "postprocessing"}
FEATURE_SET_RESULTS = {0: "success", 1: "not_supported", 2: "not_available", 3: "not_in_finger", 4: "message_too_short", 5: "low_battery"}
FEATURES = {
    0x00: "background_dfu", 0x01: "research_data", 0x02: "daytime_hr", 0x03: "exercise_hr", 0x04: "spo2",
    0x05: "bundling", 0x06: "encrypted_api", 0x07: "tap_to_tag", 0x08: "resting_hr", 0x09: "app_auth",
    0x0A: "ble_mode", 0x0B: "real_steps", 0x0C: "experimental", 0x0D: "cva_ppg_sampler", 0x0E: "charging_control",
    0x10: "ambient_light", 0x12: "raw_data_sampler", 0x15: "atlas",
}
FEATURE_IDS = {v: k for k, v in FEATURES.items()}

MODE_OFF, MODE_AUTOMATIC, MODE_REQUESTED, MODE_CONNECTED_LIVE = 0, 1, 2, 3

# Hardware id prefix -> human name (from the ring's product-info slot).
HARDWARE_FAMILIES = {"BLB": "Oura Ring Gen3", "ORE": "Oura Ring 4", "JAD": "Oura Ring 4", "COR": "Oura Ring 5", "KTH": "Oura Ring 4 (K)"}


# -------------------------------------------------------------- packets
@dataclass
class Packet:
    tag: int
    payload: bytes

    @property
    def ext(self) -> Optional[int]:
        """Extended sub-op for 0x2f packets."""
        return self.payload[0] if self.tag == 0x2F and self.payload else None

    @property
    def is_event(self) -> bool:
        return self.tag >= 0x41 and self.tag != 0x2F

    def hex(self) -> str:
        return bytes([self.tag, len(self.payload)]).hex() + self.payload.hex()


def packet(tag: int, payload: bytes = b"") -> bytes:
    if len(payload) > 255:
        raise ValueError("payload too long")
    return bytes([tag, len(payload)]) + payload


def parse_many(data: bytes) -> List[Packet]:
    """Walk every ``tag|len|payload`` frame packed in one notification."""
    out: List[Packet] = []
    i = 0
    n = len(data)
    while i + 2 <= n:
        tag, ln = data[i], data[i + 1]
        payload = bytes(data[i + 2 : i + 2 + ln])
        if len(payload) < ln:
            # truncated tail: keep what we have so the caller can still see it
            out.append(Packet(tag, payload))
            break
        out.append(Packet(tag, payload))
        i += 2 + ln
    return out


# ------------------------------------------------------------ requests
def req_firmware() -> bytes:
    return bytes.fromhex("0803000000")


def req_battery() -> bytes:
    return packet(0x0C)


def req_serial() -> bytes:
    return bytes.fromhex("1803080010")


def req_hardware_id() -> bytes:
    return bytes.fromhex("1803180010")


def req_product_code() -> bytes:
    return bytes.fromhex("1803280009")


def req_capabilities(page: int) -> bytes:
    return bytes([0x2F, 0x02, 0x01, page & 0xFF])


def req_auth_nonce() -> bytes:
    return bytes.fromhex("2f012b")


def req_authenticate(proof: bytes) -> bytes:
    if len(proof) != 16:
        raise ValueError("proof must be 16 bytes")
    return packet(0x2F, b"\x2d" + proof)


def req_set_auth_key(key: bytes) -> bytes:
    if len(key) != 16:
        raise ValueError("key must be 16 bytes")
    return packet(0x24, key)


def req_stream_subscribe(mode: int = 0x02) -> bytes:
    return bytes([0x16, 0x01, mode & 0xFF])


def req_event_subscribe(category: int, flags: int) -> bytes:
    return packet(0x18, struct.pack("<BH", category & 0xFF, flags & 0xFFFF))


def req_set_notification(flags: int = 0xBF) -> bytes:
    return bytes([0x1C, 0x01, flags & 0xFF])


def req_feature_status(feature: int) -> bytes:
    return bytes([0x2F, 0x02, 0x20, feature & 0xFF])


def req_set_feature_mode(feature: int, mode: int) -> bytes:
    return bytes([0x2F, 0x03, 0x22, feature & 0xFF, mode & 0xFF])


def req_feature_latest(feature: int) -> bytes:
    return bytes([0x2F, 0x02, 0x24, feature & 0xFF])


def req_set_feature_subscription(capability: int, mode: int) -> bytes:
    return bytes([0x2F, 0x03, 0x26, capability & 0xFF, mode & 0xFF])


def req_bundling(enabled: bool) -> bytes:
    return bytes([0x2F, 0x02, 0x03, 0x01 if enabled else 0x00])


def req_data_flush(force: bool = False) -> bytes:
    return bytes([0x28, 0x01, 0x01 if force else 0x00])


def req_get_event(cursor: int, max_events: int = 255, flags: int = -1) -> bytes:
    return packet(0x10, struct.pack("<IBi", cursor & 0xFFFFFFFF, max_events & 0xFF, flags))


def req_get_event_ack(cursor: int) -> bytes:
    return req_get_event(cursor, 0, -1)


def req_sync_time_app(now: Optional[int] = None, token: Optional[int] = None) -> bytes:
    """Official-app time sync: ``12 09 <token> <unix/256:u24> 00 00 00 00 f6``."""
    now = int(time.time()) if now is None else int(now)
    tok = secrets.randbits(8) if token is None else token & 0xFF
    counter = (now // 256) & 0xFFFFFF
    return b"\x12\x09" + bytes([tok]) + counter.to_bytes(3, "little") + b"\x00\x00\x00\x00\xf6"


def req_realtime_off() -> bytes:
    return bytes.fromhex("060400000000")


def req_realtime(bitmask: int, max_minutes: int, delay: int = 0) -> bytes:
    return packet(0x06, struct.pack("<IHB", bitmask, max_minutes, delay))


REALTIME_ACM = 0x20
ACM_RESPONSE_TAG = 0x33

# App-observed registration sequence (Ring 4/5); harmless on others.
APP_EVENT_CATEGORIES: Tuple[Tuple[int, int], ...] = ((0x14, 0x1000), (0x18, 0x1000), (0x28, 0x0900), (0x34, 0x0400), (0x04, 0x1000), (0x08, 0x1000))


# ------------------------------------------------------------- responses
@dataclass
class DeviceInfo:
    api_version: str
    firmware_version: str
    bootloader_version: str
    bt_stack_version: str
    mac: str

    @staticmethod
    def parse(p: Packet) -> Optional["DeviceInfo"]:
        if p.tag != 0x09 or len(p.payload) < 18:
            return None
        b = p.payload
        v = lambda o: f"{b[o]}.{b[o+1]}.{b[o+2]}"  # noqa: E731
        mac = ":".join(f"{x:02x}" for x in reversed(b[12:18]))
        return DeviceInfo(v(0), v(3), v(6), v(9), mac)


@dataclass
class Battery:
    percent: int
    charging_progress: int
    charge_recommended: bool
    raw_tail: str = ""

    @staticmethod
    def parse(p: Packet) -> Optional["Battery"]:
        if p.tag != 0x0D or len(p.payload) < 3:
            return None
        b = p.payload
        return Battery(b[0], b[1], bool(b[2]), b[3:].hex())


def parse_product_ascii(p: Packet) -> Optional[str]:
    if p.tag != 0x19 or len(p.payload) < 2 or p.payload[0] != 0:
        return None
    return p.payload[1:].rstrip(b"\x00").decode("ascii", "replace")


def parse_capabilities(p: Packet) -> Dict[int, int]:
    """``2f xx 02 <pages> <id,val>*`` → {feature_id: version}."""
    if p.ext != 0x02 or len(p.payload) < 2:
        return {}
    pairs = p.payload[2:]
    return {pairs[i]: pairs[i + 1] for i in range(0, len(pairs) - 1, 2)}


@dataclass
class FeatureStatus:
    feature: int
    mode: int
    status: int
    state: int
    subscription: int

    @staticmethod
    def parse(p: Packet) -> Optional["FeatureStatus"]:
        if p.ext != 0x21 or len(p.payload) < 6:
            return None
        b = p.payload
        return FeatureStatus(b[1], b[2], b[3], b[4], b[5])

    def as_dict(self) -> dict:
        return {
            "feature": self.feature,
            "name": FEATURES.get(self.feature, f"0x{self.feature:02x}"),
            "mode": self.mode,
            "mode_name": FEATURE_MODES.get(self.mode, "unknown"),
            "status": self.status,
            "state": self.state,
            "state_name": FEATURE_STATES.get(self.state, "unknown"),
            "subscription": self.subscription,
        }


@dataclass
class EventBatchSummary:
    events_received: int
    sleep_analysis_progress: int
    bytes_left: int

    @staticmethod
    def parse(p: Packet) -> Optional["EventBatchSummary"]:
        if p.tag != 0x11 or len(p.payload) < 6:
            return None
        b = p.payload
        return EventBatchSummary(b[0], b[1], struct.unpack_from("<I", b, 2)[0])


def auth_result_name(code: int) -> str:
    return AUTH_RESULTS.get(code, f"unknown_{code}")


def is_auth_required(p: Packet) -> bool:
    """``2f 02 2f 01`` — the ring refused an app-gated command."""
    return p.ext == 0x2F and len(p.payload) >= 2 and p.payload[1] == 0x01


# ------------------------------------------------------------------ auth
def auth_proof(key: bytes, nonce: bytes) -> bytes:
    """AES-128-ECB(key, nonce || 0x01, PKCS5 pad)[:16]."""
    if len(key) != 16:
        raise ValueError("auth key must be 16 bytes")
    if len(nonce) != 15:
        raise ValueError("nonce must be 15 bytes")
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    plaintext = nonce + b"\x01" + bytes([16]) * 16
    enc = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return (enc.update(plaintext) + enc.finalize())[:16]


def generate_auth_key() -> bytes:
    return secrets.token_bytes(16)


def hardware_family(hw_id: str) -> str:
    prefix = (hw_id or "").split("_")[0].upper()
    return HARDWARE_FAMILIES.get(prefix, f"Oura ring ({hw_id})" if hw_id else "Oura ring")


# ---------------------------------------------------------------- live
@dataclass
class HeartRateSample:
    bpm: int
    ibi_ms: int


def parse_live_hr(p: Packet) -> Optional[HeartRateSample]:
    """Daytime-HR live notification: ``2f xx 28 <cap> <status> <state> <t:u16> <ibi:u16>``.
    Returns only beats the ring marks VALID (the phone app's display rule)."""
    b = parse_live_beat(p)
    if b is None or b.validity != IBI_VALID or b.bpm is None:
        return None
    return HeartRateSample(b.bpm, b.ibi_ms)


IBI_UNKNOWN, IBI_VALID, IBI_INVALID, IBI_CORRECTED = 0, 1, 2, 3
IBI_VALIDITY_NAMES = {0: "unknown", 1: "valid", 2: "invalid", 3: "corrected"}
FEATURE_STATES = {0: "idle", 1: "scanning", 2: "measuring", 3: "postprocessing"}


@dataclass
class LiveBeat:
    """One ``FeatureSubscriptionEvent`` push for daytime HR.

    ``2f 0f 28 02 <status> <state> <tsince:u16> <ibi:u16> [<cqi:i32> <temp:i16> <pqi:u8>]``
    The IBI word carries a 12-bit interval and a validity nibble; the tail is the
    app's ``DaytimeHrSubscriptionStatus`` and includes a per-beat skin temperature
    in centi-°C (the only live temperature path on these rings)."""

    ibi_ms: int
    validity: int
    bpm: Optional[int]
    status: int
    state: int
    time_since: int
    cqi: Optional[int] = None
    skin_temp_c: Optional[float] = None
    pqi: Optional[int] = None

    @property
    def usable_for_hrv(self) -> bool:
        return self.validity in (IBI_VALID, IBI_CORRECTED) and 300 <= self.ibi_ms <= 2000


def parse_live_beat(p: Packet) -> Optional[LiveBeat]:
    if p.ext != 0x28 or len(p.payload) < 8 or p.payload[1] != 0x02:
        return None
    b = p.payload
    ibi = ((b[7] & 0x0F) << 8) | b[6]
    validity = (b[7] >> 4) & 0x0F
    bpm = 60000 // ibi if validity in (IBI_VALID, IBI_CORRECTED) and 300 <= ibi <= 2000 else None
    cqi = temp = pqi = None
    if len(b) >= 15:
        cqi = struct.unpack_from("<i", b, 8)[0]
        t = struct.unpack_from("<h", b, 12)[0]
        temp = t / 100.0 if 2000 <= t <= 4200 else None
        pqi = b[14]
    return LiveBeat(ibi, validity, bpm, b[2], b[3], struct.unpack_from("<H", b, 4)[0], cqi, temp, pqi)


def parse_feature_latest_beat(p: Packet) -> Optional[LiveBeat]:
    """``2f 10 25 02 <result> <status> <state> <counter:u16> <ibi:u16> <cqi:i32> <temp:i16> <pqi:u8>``
    shares the beat tail with the push frame."""
    if p.ext != 0x25 or len(p.payload) < 9 or p.payload[1] != 0x02 or p.payload[2] != 0:
        return None
    tail = bytes([0x28, 0x02, p.payload[3], p.payload[4]]) + bytes(p.payload[5:])
    return parse_live_beat(Packet(0x2F, tail))


def parse_state_notify(p: Packet) -> Optional[Dict[str, int]]:
    """Async ``1f 04 20 <state> <mode> 00`` frames (enabled by ``1c 01 3f``)."""
    if p.tag != 0x1F or len(p.payload) < 3 or p.payload[0] != 0x20:
        return None
    return {"state": p.payload[1], "mode": p.payload[2]}


@dataclass
class AcmSample:
    x: int
    y: int
    z: int


@dataclass
class AcmFrame:
    rate_hz: int
    seq: int
    samples: List[AcmSample]


def parse_acm_frame(p: Packet) -> Optional[AcmFrame]:
    """Live accelerometer frame ``33 0e <rate_hz> <seq> x y z x y z`` (two samples)."""
    if p.tag != ACM_RESPONSE_TAG or len(p.payload) < 8:
        return None
    b = p.payload
    out = []
    for off in (2, 8):
        if off + 6 <= len(b):
            x, y, z = struct.unpack_from("<hhh", b, off)
            out.append(AcmSample(x, y, z))
    return AcmFrame(b[0], b[1], out)


def parse_acm(p: Packet) -> List[AcmSample]:
    f = parse_acm_frame(p)
    return f.samples if f else []


@dataclass
class ScanResult:
    address: str
    name: Optional[str]
    rssi: int
    is_ring: bool
    is_charger: bool
    manufacturer_hex: str = ""
    extra: dict = field(default_factory=dict)
