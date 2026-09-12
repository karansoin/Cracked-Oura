"""The API-facing supervisor relays worker events and survives worker death."""
import asyncio
import json
import os
import sys
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


def test_hung_worker_is_stopped_with_hint(monkeypatch):
    import backend.src.ble.supervisor as sup_mod

    monkeypatch.setitem(sup_mod.OP_TIMEOUTS, "scan", 0.5)
    # A worker that never prints a result: emulate with a sleeping python process.
    monkeypatch.setattr(sup_mod, "_worker_argv", lambda cmd: [sys.executable, "-c", "import time; time.sleep(30)"])
    sup = sup_mod.RingSupervisor()

    async def go():
        assert sup.start_scan(0.0)
        await asyncio.wait_for(sup._task, 30)

    asyncio.run(go())
    assert sup.state == "error" and "did not finish" in (sup.error or "")
    assert not sup.busy


def test_worker_death_closes_a_live_session():
    sup = RingSupervisor()
    sup.live = {"active": True, "id": "abc", "kind": "free", "started": 0.0}
    seen = []
    q = sup.listen()
    sup._finish_error("worker died", state="unavailable")
    while not q.empty():
        seen.append(q.get_nowait())
    assert sup.live["active"] is False and sup.live["last_error"] == "worker died"
    assert any(e.get("type") == "session_failed" and e.get("id") == "abc" for e in seen)
    st = sup.live_status()
    assert st["active"] is False and st["error"] == "worker died"
