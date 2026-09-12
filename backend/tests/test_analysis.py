import numpy as np

from backend.src.analysis.hrv import analyze_hrv, heart_rate_recovery, hr_zones, rolling_rmssd
from backend.src.analysis.motion import analyze_motion, classify_windows
from backend.src.analysis.tremor import analyze_tremor

FS = 50.0
rng = np.random.default_rng(7)


def accel(seconds, tremor_hz=None, tremor_g=0.0, walk_hz=None, walk_g=0.0, noise_g=0.002, slow_hz=None, slow_g=0.0):
    t = np.arange(int(seconds * FS)) / FS
    x = noise_g * rng.standard_normal(t.size)
    y = noise_g * rng.standard_normal(t.size)
    z = 1.0 + noise_g * rng.standard_normal(t.size)  # gravity on z
    if tremor_hz:
        x = x + tremor_g * np.sin(2 * np.pi * tremor_hz * t)
    if walk_hz:
        z = z + walk_g * np.sin(2 * np.pi * walk_hz * t) + 0.3 * walk_g * np.sin(2 * np.pi * 2 * walk_hz * t)
        x = x + 0.3 * walk_g * np.sin(2 * np.pi * walk_hz / 2 * t)
    if slow_hz:
        y = y + slow_g * np.sin(2 * np.pi * slow_hz * t)
    return np.stack([x, y, z], axis=1)


def test_tremor_detects_injected_5hz_and_scores_lower():
    steady = analyze_tremor(accel(20), FS)
    shaky = analyze_tremor(accel(20, tremor_hz=5.2, tremor_g=0.03), FS)
    assert steady.quality == "good" and steady.steadiness_score >= 85
    assert 4.8 <= shaky.dominant_hz <= 5.6
    assert shaky.power_3_7 > shaky.power_7_12 and shaky.tremor_ratio > 0.8
    assert shaky.steadiness_score < steady.steadiness_score - 20
    assert 20 <= shaky.rms_mg <= 26  # 30 mg peak sine ≈ 21 mg RMS
    assert shaky.amplitude_mm > 0.1


def test_tremor_flags_short_and_moving():
    assert analyze_tremor(accel(2), FS).quality == "short"
    moving = analyze_tremor(accel(20, walk_hz=1.0, walk_g=0.3), FS)
    assert moving.quality == "moving"


def test_walking_cadence_and_steps():
    r = analyze_motion(accel(30, walk_hz=1.8, walk_g=0.35), FS)
    assert r.activity == "walk", r
    assert 100 <= r.cadence_spm <= 116  # 1.8 Hz = 108 spm
    assert 48 <= r.steps <= 60  # 30 s at 1.8 Hz = 54 steps
    run = analyze_motion(accel(30, walk_hz=2.8, walk_g=0.9), FS)
    assert run.activity == "run" and 160 <= run.cadence_spm <= 176


def test_rest_and_reps_and_windows():
    assert analyze_motion(accel(10), FS).activity == "rest"
    reps = analyze_motion(accel(30, slow_hz=0.5, slow_g=0.25), FS)
    assert reps.activity == "strength" and 12 <= reps.reps <= 17  # 0.5 Hz × 30 s = 15
    timeline = classify_windows(np.concatenate([accel(20), accel(20, walk_hz=1.8, walk_g=0.35)]), FS, window_s=10)
    assert [w["activity"] for w in timeline] == ["rest", "rest", "walk", "walk"]


def test_hrv_and_breathing():
    # 60 bpm with 15 breaths/min RSA modulation of ±40 ms
    n = 300
    beat_t = np.cumsum(np.full(n, 1.0))
    ibi = 1000 + 40 * np.sin(2 * np.pi * 0.25 * beat_t) + rng.normal(0, 3, n)
    ibi[100] = 1500  # artifact
    r = analyze_hrv(ibi)
    assert r.rejected >= 1 and 55 <= r.mean_hr <= 65
    assert 20 <= r.rmssd_ms <= 80
    assert 13 <= r.breathing_rpm <= 17 and r.breathing_confidence > 0.3
    rr = rolling_rmssd(ibi[:60])
    assert rr[-1] is not None and rr[0] is None


def test_hr_recovery_and_zones():
    t = np.arange(0, 300, 5.0)
    hr = np.where(t < 120, 90 + t * 0.5, 150 - (t - 120) * 0.3)
    rec = heart_rate_recovery(hr, t)
    assert rec["peak_bpm"] and 15 <= rec["hrr1"] <= 20 and 34 <= rec["hrr2"] <= 38
    z = hr_zones([100, 120, 140, 160, 175, 185], max_hr=190, rest_hr=50)
    assert abs(sum(z.values()) - 1.0) < 0.01 and z["z5"] > 0


def test_correct_ibi_flags_missed_and_extra_beats():
    from backend.src.analysis.hrv import correct_ibi

    rng = np.random.default_rng(3)
    base = list(900 + rng.normal(0, 20, 120))
    series = base[:40] + [base[40] * 2] + base[41:80] + [base[80] * 0.45, base[80] * 0.55] + base[81:]
    fixed, rep = correct_ibi(series)
    assert rep["corrected"] >= 2 and rep["fraction"] < 0.05 and rep["usable"]
    assert abs(fixed.size - 122) <= 2  # a split and a merge net out
    assert abs(np.mean(fixed) - 900) < 15 and np.max(fixed) < 1100


def test_stress_index_bands():
    from backend.src.analysis.hrv import stress_index

    rng = np.random.default_rng(1)
    relaxed = stress_index(1000 + rng.normal(0, 60, 200))
    tense = stress_index(700 + rng.normal(0, 8, 200))
    assert relaxed["si"] < tense["si"] and relaxed["band"] in ("vagal", "balanced") and tense["band"] in ("sympathetic", "high strain")


def test_breathing_session_scores_paced_breathing():
    from backend.src.analysis.hrv import breathing_session

    t, ibi = [], []
    clock = 0.0
    rng = np.random.default_rng(0)
    while clock < 300:
        bpm = 62 + 8 * np.sin(2 * np.pi * 0.1 * clock) + rng.normal(0, 0.5)
        x = 60000 / bpm
        clock += x / 1000
        t.append(clock)
        ibi.append(x)
    r = breathing_session(ibi, t, target_bpm=6.0)
    assert r["n_breaths"] >= 20 and 5.0 <= r["breath_rate_bpm"] <= 7.0, r
    assert r["resonance"] > 0.5 and r["adherence"] >= 0.7 and 10 <= r["rsa_amplitude_bpm"] <= 20, r


def test_orthostatic_detects_stand_and_hr_rise():
    from backend.src.analysis.orthostatic import analyze_orthostatic

    fs = 50
    rng = np.random.default_rng(2)
    n = fs * 240
    xyz = np.zeros((n, 3))
    xyz[:, 2] = 1.0
    xyz += rng.normal(0, 0.003, xyz.shape)
    s = fs * 60
    burst = np.arange(s, s + 2 * fs)
    xyz[burst, 0] += 0.3 * np.sin(np.linspace(0, 12 * np.pi, burst.size))
    xyz[s + fs :, [0, 2]] = xyz[s + fs :, [2, 0]]  # gravity swaps axes after standing
    t, ibi, clock = [], [], 0.0
    while clock < 240:
        bpm = 58 if clock < 61 else (78 if clock < 80 else 70)
        x = 60000 / (bpm + rng.normal(0, 0.5))
        clock += x / 1000
        t.append(clock)
        ibi.append(x)
    r = analyze_orthostatic(xyz.tolist(), list(zip(t, ibi)), fs)
    assert r["stand"] and abs(r["stand"]["t_stand_s"] - 60) < 3, r["stand"]
    assert 15 <= r["delta_peak"] <= 24 and 9 <= r["delta_stand"] <= 15 and r["quality"] == "good", r


def test_baselines_cusum_alarm_and_readiness():
    from backend.src.analysis.baselines import analyze_baselines, cusum
    from datetime import date, timedelta

    rng = np.random.default_rng(5)
    rows = []
    d0 = date(2026, 6, 1)
    for i in range(70):
        sick = i >= 64
        rows.append({
            "day": d0 + timedelta(days=i),
            "resting_hr": 52 + rng.normal(0, 1.5) + (6 if sick else 0),
            "rmssd": 60 + rng.normal(0, 6) - (20 if sick else 0),
            "temp_deviation": rng.normal(0, 0.12) + (0.6 if sick else 0),
            "breathing_rate": 14 + rng.normal(0, 0.4) + (1.5 if sick else 0),
            "sleep_hours": 7.3 + rng.normal(0, 0.4),
        })
    healthy = analyze_baselines(rows[:60])
    assert healthy["readiness"] is not None and 35 <= healthy["readiness"] <= 70 and not healthy["alarms"]
    out = analyze_baselines(rows)
    names = {a["signal"] for a in out["alarms"]}
    assert {"resting_hr", "temp_deviation"} <= names, out["alarms"]
    assert out["status"] == "watch" and out["readiness"] < healthy["readiness"]
    assert cusum([0, 0, 5, 5, 5], 1.0, +1)[-1] > 4 and cusum([0, 0, -5, -5], 1.0, +1)[-1] == 0


def test_tremor_peak_sharpness_and_jitter():
    from backend.src.analysis.tremor import analyze_tremor

    fs = 50
    t = np.arange(0, 30, 1 / fs)
    rng = np.random.default_rng(0)
    xyz = np.stack([0.02 * np.sin(2 * np.pi * 5.0 * t) + rng.normal(0, 0.002, t.size), rng.normal(0, 0.002, t.size), 1 + rng.normal(0, 0.002, t.size)], axis=1)
    r = analyze_tremor(xyz.tolist(), fs)
    assert 4.6 <= r.dominant_hz <= 5.4 and r.q_factor >= 5 and r.peak_prominence > 20
    assert r.jitter_f_sd_hz < 0.5 and r.power_3p5_7p5 > r.power_7p5_12 and r.log_amplitude < -1
