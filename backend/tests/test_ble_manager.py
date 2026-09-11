"""End-to-end pair + sync through the RingManager against a simulated ring."""
import asyncio
import os
import struct
import tempfile

os.environ["CRACKED_OURA_DATA_DIR"] = tempfile.mkdtemp(prefix="cracked-oura-mgr-")

from sqlalchemy import select  # noqa: E402

from backend.src.ble import protocol as P  # noqa: E402
from backend.src.ble.client import Transport, _Fanout  # noqa: E402
from backend.src.database import SessionLocal, init_db  # noqa: E402
from backend.src.models import HeartRate, RingEvent as RingEventRow, RingState, SleepSession  # noqa: E402


class FakeRing(Transport):
    """A Ring-5-like device: factory-reset until a key is set, then auth-gated."""

    def __init__(self):
        self.fanout = _Fanout()
        self.key = None
        self.authed = False
        self.nonce = bytes(range(1, 16))
        self.features = {0x02: 1, 0x04: 1, 0x08: 1, 0x0B: 0, 0x03: 0}
        self.writes = []
        t0 = 500_000
        self.events = []  # (tag, ring_ts, body)
        self.events.append((0x85, t0, struct.pack("<I", 1_757_500_000) + b"\x00" * 6))
        s, e = t0 + 36_000, t0 + 36_000 + 7 * 36_000
        self.events.append((0x4B, e - 5, bytes([0] + [0b01010101] * 21)))  # 84 x light
        for i in range(0, 7 * 3600, 1800):
            self.events.append((0x5D, s + i * 10, bytes([50, 70] * 6)))
        self.events.append((0x76, e, struct.pack("<II", s, e)))
        for i in range(5):
            self.events.append((0x80, e + 1000 + i * 100, bytes([100, 0x08] * 7)))  # ibi 800, q=1
        self.acked = None

    def _send(self, *frames: bytes):
        self.fanout.publish(b"".join(frames))

    async def write(self, data: bytes):
        self.writes.append(data)
        tag = data[0]
        if tag == 0x08:
            self._send(bytes.fromhex("091202010002010301000109032966554433221" + "1"))
        elif tag == 0x18 and data[1] == 3 and data[2] == 0x18:
            self._send(bytes.fromhex("191100434f525f303100000000000000000000"))  # COR_01
        elif tag == 0x18 and data[1] == 3 and data[2] == 0x08:
            self._send(bytes.fromhex("19110052494e4735303030303030303100000000"))  # RING500000001
        elif tag == 0x18:
            self._send(bytes.fromhex("190100"))
        elif tag == 0x24:
            if self.key is None:
                self.key = bytes(data[2:18])
                self._send(bytes.fromhex("250100"))
            else:
                self._send(bytes.fromhex("250105"))
        elif tag == 0x2F:
            ext = data[2]
            if ext == 0x2B:
                self._send(b"\x2f\x10\x2c" + self.nonce)
            elif ext == 0x2D:
                if self.key is None:
                    self._send(b"\x2f\x02\x2e\x02")  # in_factory_reset
                    return
                ok = data[3:19] == P.auth_proof(self.key, self.nonce)
                self.authed = ok
                self._send(b"\x2f\x02\x2e" + (b"\x00" if ok else b"\x01"))
            elif ext == 0x20:
                if self.key and not self.authed:
                    self._send(bytes.fromhex("2f022f01"))
                else:
                    fid = data[3]
                    self._send(bytes([0x2F, 6, 0x21, fid, self.features.get(fid, 0), 0, 0, 0]))
            elif ext == 0x22:
                fid, mode = data[3], data[4]
                self.features[fid] = mode
                self._send(bytes([0x2F, 3, 0x23, fid, 0]))
            elif ext == 0x03:
                self._send(bytes.fromhex("2f020401"))
            elif ext == 0x01:
                self._send(bytes.fromhex("2f0c020209000a060b000c000d01"))
        elif tag == 0x16:
            self._send(bytes.fromhex("170102"))
        elif tag == 0x12:
            self._send(bytes.fromhex("13050000000000"))
        elif tag == 0x1C:
            self._send(bytes.fromhex("1d0100"))
        elif tag == 0x0C:
            if self.key and not self.authed:
                self._send(bytes.fromhex("2f022f01"))
            else:
                self._send(bytes.fromhex("0d065a0000000000"))
        elif tag == 0x28:
            self._send(bytes.fromhex("290100"))
        elif tag == 0x10:
            if self.key and not self.authed:
                self._send(bytes.fromhex("2f022f01"))
                return
            cursor, maxn = struct.unpack_from("<IB", data, 2)
            if maxn == 0:
                self.acked = cursor
                self._send(bytes.fromhex("11080000000000000000"))
                return
            pending = [ev for ev in self.events if ev[1] >= cursor][:maxn]
            frames = [bytes([t, 4 + len(b)]) + struct.pack("<I", ts) + b for t, ts, b in pending]
            left = len(self.events) - len([ev for ev in self.events if ev[1] < cursor]) - len(pending)
            self._send(*frames, bytes([0x11, 8, len(pending), 0]) + struct.pack("<I", left * 20) + b"\x00\x00")

    def subscribe(self):
        return self.fanout.subscribe()

    def unsubscribe(self, q):
        self.fanout.unsubscribe(q)


def test_pair_then_sync_through_manager():
    init_db()
    from backend.src.ble.manager import RingManager

    ring = FakeRing()
    mgr = RingManager()

    async def fake_open(address):
        mgr._set("connecting", "fake")
        return ring, "FAKE-ADDR", "Oura RING500000001"

    mgr._open_transport = fake_open  # type: ignore[assignment]

    async def go():
        info = await mgr.pair(None)
        assert info["serial"] == "RING500000001" and info["model"] == "Oura Ring 5"
        assert ring.key is not None and ring.authed
        assert ring.features[0x0B] == P.MODE_AUTOMATIC  # enabled by pairing
        assert os.path.exists(mgr._key_path("RING500000001"))
        ring.authed = False  # new connection needs auth again
        out = await mgr.sync(None)
        return out

    out = asyncio.run(go())
    assert out["events"]["inserted"] == len(ring.events)
    assert out["derived"]["sleep_sessions"] == 1
    assert ring.acked == out["next_cursor"]
    assert mgr.state == "idle" and mgr.error is None

    db = SessionLocal()
    try:
        st = db.get(RingState, "RING500000001")
        assert st.next_cursor == out["next_cursor"] and st.anchor_precise
        assert db.scalar(select(RingEventRow).where(RingEventRow.tag == 0x76)) is not None
        s = db.scalars(select(SleepSession)).one()
        assert s.type == "long_sleep" and s.time_in_bed == 7 * 3600 and s.average_hrv == 70
        assert s.light_sleep_duration == 84 * 300
        assert db.scalars(select(HeartRate)).first().bpm == 75
    finally:
        db.close()

    # A second sync from the checkpoint pulls nothing new
    ring.authed = False
    out2 = asyncio.run(mgr.sync(None))
    assert out2["events"]["inserted"] == 0


def test_wrong_key_is_reported():
    init_db()
    from backend.src.ble.manager import RingManager

    ring = FakeRing()
    ring.key = b"\x11" * 16  # provisioned by another app
    mgr = RingManager()

    async def fake_open(address):
        return ring, "FAKE", None

    mgr._open_transport = fake_open  # type: ignore[assignment]

    async def go():
        assert mgr.start_pair(None)
        assert not mgr.start_pair(None)  # busy
        await mgr._task

    asyncio.run(go())
    assert mgr.state == "error" and "factory" in (mgr.error or "").lower()


def test_existing_key_is_reinstalled_after_ring_reset():
    init_db()
    from backend.src.ble.manager import RingManager

    ring = FakeRing()  # key None = factory-reset state
    mgr = RingManager()
    # pretend we paired this serial before and still hold the key file
    mgr._save_key("RING500000001", b"\x42" * 16)

    async def fake_open(address):
        return ring, "FAKE", None

    mgr._open_transport = fake_open  # type: ignore[assignment]
    asyncio.run(mgr.pair(None))
    assert ring.key == b"\x42" * 16 and ring.authed
