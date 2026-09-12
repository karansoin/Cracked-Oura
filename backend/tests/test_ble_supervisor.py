"""The API-facing supervisor relays worker events and survives worker death."""
import asyncio
import json
import os
import tempfile

os.environ.setdefault("CRACKED_OURA_DATA_DIR", tempfile.mkdtemp(prefix="cracked-oura-sup-"))

from backend.src.ble.supervisor import RingSupervisor  # noqa: E402


def test_scan_via_worker_reports_result_or_unavailable():
    sup = RingSupervisor()

    async def go():
        q = sup.listen()
        assert sup.start_scan(2.0)
        assert not sup.start_scan(2.0)  # busy
        await asyncio.wait_for(sup._task, 60)
        events = []
        while not q.empty():
            events.append(q.get_nowait())
        return events

    events = asyncio.run(go())
    types = [e.get("type") for e in events]
    st = sup.status()
    # Either Bluetooth worked (a 'result' arrived and we are idle) or macOS killed the
    # worker for lack of permission (state 'unavailable' with the hint). Never a crash.
    assert ("result" in types and st["state"] in ("idle", "error")) or st["state"] == "unavailable"
    assert not st["busy"]
    if st["state"] == "unavailable":
        assert "Bluetooth" in st["error"] and st["bluetooth_ok"] is False


def test_bad_op_is_reported_not_raised():
    sup = RingSupervisor()

    async def go():
        assert sup._start({"op": "bogus"})
        await asyncio.wait_for(sup._task, 60)

    asyncio.run(go())
    assert sup.state == "error" and "unknown op" in (sup.error or "")


def test_worker_argv_json_roundtrip():
    from backend.src.ble.supervisor import _worker_argv

    argv = _worker_argv({"op": "sync", "address": None, "full": True})
    assert json.loads(argv[-1]) == {"op": "sync", "address": None, "full": True}
