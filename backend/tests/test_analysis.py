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
