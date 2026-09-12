"""A simulated ring transport for development and tests.

Speaks enough of the protocol for pairing/sync (see tests) and produces live
streams on request: 50 Hz accelerometer frames (tag 0x33, two samples per
frame) and per-beat daytime-HR notifications while CONNECTED_LIVE is set.
Scenarios shape the synthetic signal: 'still', 'tremor', 'walk', 'run', 'reps'.
"""

from __future__ import annotations

import asyncio
import math
import random
import struct
import time
from typing import Optional

from . import protocol as P
from .client import Transport, _Fanout

COUNTS_PER_G = 4096  # arbitrary but fixed; the app calibrates at rest


class SimulatedRing(Transport):
    def __init__(self, scenario: str = "still", hr_bpm: float = 62.0, seed: int = 1):
        self.fanout = _Fanout()
        self.scenario = scenario
        self.hr_bpm = hr_bpm
        self.rng = random.Random(seed)
        self.key: Optional[bytes] = None
        self.authed = False
        self.nonce = bytes(range(1, 16))
        self._acm_task: Optional[asyncio.Task] = None
        self._hr_task: Optional[asyncio.Task] = None
        self._hr_until = 0.0
        self.writes: list = []
        self.t0 = time.time()

    # ------------------------------------------------------------ protocol
    def _send(self, *frames: bytes) -> None:
        self.fanout.publish(b"".join(frames))

    async def write(self, data: bytes) -> None:
        self.writes.append(bytes(data))
        tag = data[0]
        if tag == 0x08:
            self._send(bytes.fromhex("0912020100020103010001090329665544332211"))
        elif tag == 0x18 and data[2] == 0x18:
            self._send(bytes.fromhex("191100434f525f303100000000000000000000"))
        elif tag == 0x18 and data[2] == 0x08:
            self._send(bytes.fromhex("19110053494d5230303030303030303100000000"))  # SIMR00000001
        elif tag == 0x24:
            self.key = bytes(data[2:18]); self._send(bytes.fromhex("250100"))
        elif tag == 0x2F:
            ext = data[2]
            if ext == 0x2B:
                self._send(b"\x2f\x10\x2c" + self.nonce)
            elif ext == 0x2D:
                if self.key is None:
                    self._send(b"\x2f\x02\x2e\x02")
                else:
                    self.authed = data[3:19] == P.auth_proof(self.key, self.nonce)
                    self._send(b"\x2f\x02\x2e" + (b"\x00" if self.authed else b"\x01"))
            elif ext == 0x20:
                self._send(bytes([0x2F, 6, 0x21, data[3], 1, 0, 0, 0]))
            elif ext == 0x22:
                fid, mode = data[3], data[4]
                self._send(bytes([0x2F, 3, 0x23, fid, 0]))
                if fid == 0x02 and mode == P.MODE_CONNECTED_LIVE:
                    self._hr_until = time.time() + 20.0
                    if self._hr_task is None or self._hr_task.done():
                        self._hr_task = asyncio.create_task(self._hr_loop())
            elif ext == 0x26:
                self._send(bytes([0x2F, 3, 0x27, data[3], 0]))
            elif ext == 0x01:
                self._send(bytes.fromhex("2f0c020209000a060b000c000d01"))
        elif tag == 0x0C:
            self._send(bytes.fromhex("0d065a0000000000"))
        elif tag == 0x06:
            bitmask, minutes, _delay = struct.unpack_from("<IHB", data, 2)
            self._send(bytes.fromhex("070100"))
            if bitmask & P.REALTIME_ACM:
                if self._acm_task is None or self._acm_task.done():
                    self._acm_task = asyncio.create_task(self._acm_loop(minutes * 60))
            else:
                if self._acm_task and not self._acm_task.done():
                    self._acm_task.cancel()
        elif tag in (0x12, 0x16, 0x1C, 0x28):
            self._send(bytes([tag + 1, 1, 0]))

    def subscribe(self):
        return self.fanout.subscribe()

    def unsubscribe(self, q):
        self.fanout.unsubscribe(q)

    async def close(self) -> None:
        for t in (self._acm_task, self._hr_task):
            if t and not t.done():
                t.cancel()

    # -------------------------------------------------------------- signal
    def _sample(self, t: float):
        n = self.rng.gauss
        x, y, z = n(0, 0.002), n(0, 0.002), 1.0 + n(0, 0.002)
        s = self.scenario
        if s == "tremor":
            x += 0.03 * math.sin(2 * math.pi * 5.3 * t)
        elif s == "walk":
            z += 0.35 * math.sin(2 * math.pi * 1.8 * t) + 0.1 * math.sin(2 * math.pi * 3.6 * t)
            x += 0.1 * math.sin(2 * math.pi * 0.9 * t)
        elif s == "run":
            z += 0.9 * math.sin(2 * math.pi * 2.8 * t) + 0.3 * math.sin(2 * math.pi * 5.6 * t)
        elif s == "reps":
            y += 0.25 * math.sin(2 * math.pi * 0.5 * t)
        return int(x * COUNTS_PER_G), int(y * COUNTS_PER_G), int(z * COUNTS_PER_G)

    async def _acm_loop(self, seconds: float) -> None:
        seq = 0
        end = time.time() + seconds
        t = 0.0
        try:
            while time.time() < end:
                a = self._sample(t)
                b = self._sample(t + 0.02)
                t += 0.04
                frame = bytes([P.ACM_RESPONSE_TAG, 14, 50, seq & 0xFF]) + struct.pack("<hhhhhh", *a, *b)
                seq += 1
                self._send(frame)
                await asyncio.sleep(0.04)
        except asyncio.CancelledError:
            pass

    async def _hr_loop(self) -> None:
        try:
            while time.time() < self._hr_until:
                bpm = self.hr_bpm + 4 * math.sin(2 * math.pi * 0.25 * (time.time() - self.t0)) + self.rng.gauss(0, 1)
                ibi = int(60000 / max(bpm, 30))
                hi = 0x10 | ((ibi >> 8) & 0x0F)
                self._send(bytes([0x2F, 0x08, 0x28, 0x02, 0x00, 0x02, 0x00, 0x00, ibi & 0xFF, hi]))
                await asyncio.sleep(ibi / 1000.0)
        except asyncio.CancelledError:
            pass
