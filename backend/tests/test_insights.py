import os
import tempfile
from datetime import date, datetime, timedelta

os.environ.setdefault("CRACKED_OURA_DATA_DIR", tempfile.mkdtemp(prefix="cracked-oura-insights-"))

import numpy as np  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def test_baselines_route_from_stored_nights():
    from backend.src.api.main import app
    from backend.src.database import SessionLocal, init_db
    from backend.src.models import Readiness, SleepSession

    init_db()
    rng = np.random.default_rng(7)
    db = SessionLocal()
    try:
        d0 = date.today() - timedelta(days=70)
        for i in range(70):
            d = d0 + timedelta(days=i)
            sick = i >= 66
            db.merge(SleepSession(
                id=f"n{i}", day=d, type="long_sleep", start_time=datetime.combine(d, datetime.min.time()),
                total_sleep_duration=int(7.2 * 3600 + rng.normal(0, 900)), lowest_heart_rate=int(50 + rng.normal(0, 1.5) + (7 if sick else 0)),
                average_hrv=int(58 + rng.normal(0, 6) - (18 if sick else 0)), average_breath=round(13.8 + rng.normal(0, 0.4) + (1.6 if sick else 0), 1),
            ))
            db.merge(SleepSession(id=f"nap{i}", day=d, type="nap", total_sleep_duration=1500, lowest_heart_rate=70))
            db.merge(Readiness(id=f"r{i}", day=d, temperature_deviation=round(float(rng.normal(0, 0.12) + (0.7 if sick else 0)), 2)))
        db.commit()
    finally:
        db.close()
    with TestClient(app) as c:
        r = c.get("/api/insights/baselines?days=90")
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["nights"] == 70 and j["status"] == "watch" and j["readiness"] is not None
        assert {a["signal"] for a in j["alarms"]} >= {"resting_hr", "temp_deviation"}
        assert j["signals"]["resting_hr"]["n_ref"] >= 14 and j["formula"]
        assert j["signals"]["sleep_hours"]["last"] > 5  # naps ignored
