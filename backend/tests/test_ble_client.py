import asyncio

import pytest

from backend.src.ble import protocol as P
from backend.src.ble.client import AuthFailed, AuthRequired, MockTransport, RingClient


def run(coro):
    return asyncio.run(coro)


def test_firmware_over_mock():
    m = MockTransport()
    m.on("0803000000", ["091202000003040301000105000cffeeddccbbaa"])
    c = RingClient(m, quiet=0.05)
    info = run(c.firmware())
    assert info.firmware_version == "3.4.3"


def test_authenticate_success_and_failure():
    key = bytes.fromhex("4431967d8bacc2659743142b68391d9a")
    m = MockTransport()
    m.on("2f012b", ["2f102c0e2d6a0a08c99b4365f458e6e97382"])
    m.on("2f112da38a8772d3acb6db5c2b516dd56987c8", ["2f022e00"])
    c = RingClient(m, quiet=0.05)
    run(c.authenticate(key))
    assert c.authenticated
    m.on("2f112da38a8772d3acb6db5c2b516dd56987c8", ["2f022e01"])
    with pytest.raises(AuthFailed):
        run(RingClient(m, quiet=0.05).authenticate(key))


def test_auth_required_is_raised():
    m = MockTransport()
    m.on("0c00", ["2f022f01"])
    with pytest.raises(AuthRequired):
        run(RingClient(m, quiet=0.05).battery())


def test_drain_events_legacy_with_ack():
    m = MockTransport()
    m.on("280100", ["290100"])
    # batch 1: two temperature events at ring_ts 100 and 101, then summary saying 12 bytes left
    m.on("10090000000" + "0ffffffffff", [])  # (unused shape guard)
    m.on(P.req_get_event(0, 255, -1).hex(), ["4606640000001c0e" "460665000000200e", "1108020" "00c000000" "0000"])
    m.on(P.req_get_event_ack(102).hex(), ["11080000000000000000"])
    # batch 2 from cursor 102: one event then drained
    m.on(P.req_get_event(102, 255, -1).hex(), ["46066600000024" "0e" + "110801000000000000"])
    m.on(P.req_get_event_ack(103).hex(), ["11080000000000000000"])
    seen = []
    batches = []

    async def on_batch(cursor, left, total):
        batches.append((cursor, left, total))

    c = RingClient(m, quiet=0.05, batch_quiet=0.1)
    out = run(c.drain_events(0, seen.append, on_batch))
    assert [e.ring_ts for e in seen] == [100, 101, 102]
    assert out == {"events": 3, "next_cursor": 103}
    assert batches[0][0] == 102 and batches[-1][1] == 0
    assert P.req_get_event_ack(102) in m.writes and P.req_get_event_ack(103) in m.writes
