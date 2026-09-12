"""Live sessions: in-process with the simulator, and end-to-end through the worker subprocess."""
import asyncio
import os
import tempfile

os.environ["CRACKED_OURA_DATA_DIR"] = tempfile.mkdtemp(prefix="cracked-oura-live-")

from fastapi.testclient import TestClient  # noqa: E402

from backend.src.analysis.session_metrics import compute_metrics  # noqa: E402
from backend.src.ble.client import RingClient  # noqa: E402
from backend.src.ble.live import LiveSession  # noqa: E402
from backend.src.ble.simulator import SimulatedRing  # noqa: E402


def test_live_session_with_simulated_tremor():
    ring = SimulatedRing(scenario="tremor")
    rc = RingClient(ring, quiet=0.2)
    events = []
    session = LiveSession(rc, ("acm", "hr"), emit=events.append)
    summary = asyncio.run(session.run(6.0))
    assert summary["acm_samples"] >= 250 and summary["beats"] >= 4
    assert any(e["type"] == "acm" for e in events) and any(e["type"] == "hr" for e in events)
    # exit sequence restored the ring
    tail = ring.writes[-3:]
    assert tail[0][:2] == bytes([0x06, 0x04]), tail  # ACM off first
    assert tail[1][:5] == bytes([0x2F, 0x03, 0x22, 0x02, 0x01]), tail  # daytime HR back to AUTOMATIC (never OFF)
    assert tail[2][:5] == bytes([0x2F, 0x03, 0x26, 0x02, 0x00]), tail  # subscription off
    assert summary["hr_source"] == "push" and summary["temps"] and 33 <= summary["temps"][0][1] <= 35
    assert any(e["type"] == "hr" and e.get("skin_temp_c") for e in events)
    m = compute_metrics("steadiness", summary["acm"], summary["ibi"], summary["fs_hz"])
    assert 4.8 <= m["tremor"]["dominant_hz"] <= 5.8, m["tremor"]
    assert m["scale_g_per_lsb"] and abs(1 / m["scale_g_per_lsb"] - 4096) < 200
    assert m["hrv"]["mean_hr"] > 40


def test_live_api_end_to_end_with_worker_subprocess():
    from backend.src.api.main import app

    with TestClient(app) as c:
        r = c.post("/api/live/start", json={"kind": "workout", "duration_s": 8, "simulate": "walk"})
        assert r.status_code == 200, r.text
        sid = r.json()["id"]
        assert c.post("/api/live/start", json={"kind": "free", "duration_s": 5, "simulate": "still"}).status_code == 409
        import time

        deadline = time.time() + 40
        saved = None
        while time.time() < deadline:
            time.sleep(1)
            st = c.get("/api/live/status").json()
            if not st.get("active") and st.get("saved_id"):
                saved = st
                break
        assert saved, c.get("/api/live/status").json().get("last_error")
        assert saved["snapshot"]["motion"]["activity"] == "walk", saved["snapshot"]
        detail = c.get(f"/api/live/sessions/{sid}").json()
        assert detail["kind"] == "workout" and detail["simulated"] is True
        assert detail["metrics"]["motion"]["activity"] == "walk"
        assert detail["metrics"]["timeline"] and detail["metrics"]["hr_series"]
        assert detail["hrv"]["mean_hr"] > 40
        lst = c.get("/api/live/sessions").json()
        assert lst and lst[0]["id"] == sid

        # stop early: data still saved
        r = c.post("/api/live/start", json={"kind": "steadiness", "duration_s": 60, "simulate": "tremor"})
        sid2 = r.json()["id"]
        time.sleep(6)
        assert c.post("/api/live/stop").json()["stopping"] is True
        deadline = time.time() + 30
        while time.time() < deadline:
            time.sleep(1)
            st = c.get("/api/live/status").json()
            if not st.get("active") and st.get("saved_id") == sid2:
                break
        d2 = c.get(f"/api/live/sessions/{sid2}").json()
        assert d2["duration_s"] < 30 and 4.5 <= d2["tremor"]["dominant_hz"] <= 6.0, d2
        assert c.delete(f"/api/live/sessions/{sid2}").status_code == 200

        a = c.post("/api/live/analyze", json={"kind": "free", "fs_hz": 50, "acm": [[0, 0, 4096]] * 300, "ibi": [[i, 1000] for i in range(40)]}).json()
        assert a["motion"]["activity"] == "rest" and a["hrv"]["mean_hr"] == 60.0

        # Ring 4-style firmware: no beat pushes, beats come from the event-log drain
        r = c.post("/api/live/start", json={"kind": "workout", "duration_s": 24, "simulate": "ring4", "options": {"max_hr": 185, "rest_hr": 55, "label": "test"}})
        assert r.status_code == 200, r.text
        sid3 = r.json()["id"]
        deadline = time.time() + 60
        while time.time() < deadline:
            time.sleep(1)
            st = c.get("/api/live/status").json()
            if not st.get("active") and st.get("saved_id") == sid3:
                break
        d3 = c.get(f"/api/live/sessions/{sid3}").json()
        assert d3["metrics"]["hr_source"] == "history", d3["metrics"].get("hr_source")
        assert d3["beats"] >= 7 and d3["hrv"]["mean_hr"] > 40, d3
        assert d3["metrics"]["training_load"]["banister"] is not None and d3["label"] == "test"
        assert d3["metrics"]["motion"]["activity"] == "walk"
