"""Turn a recorded live session into metrics, by session kind."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from .calibrate import estimate_scale
from .hrv import analyze_hrv, breathing_session, correct_ibi, heart_rate_recovery, hr_zones, rolling_rmssd, stress_index, training_load
from .motion import analyze_motion, classify_windows
from .orthostatic import analyze_orthostatic
from .tremor import analyze_tremor


def _scale(acm: Sequence[Sequence[float]], given: Optional[float]) -> Optional[float]:
    if given:
        return given
    if not acm:
        return None
    a = np.asarray(acm, dtype=float)
    # Try the stillest 5 s window for calibration.
    n = a.shape[0]
    best = None
    w = 250
    for s in range(0, max(1, n - w + 1), w):
        sc = estimate_scale(a[s : s + w])
        if sc:
            best = sc
            break
    return best or estimate_scale(a, max_cv=0.5) or (1.0 / max(float(np.median(np.sqrt((a**2).sum(axis=1)))), 1.0))


def snapshot(acm_tail: Sequence[Sequence[float]], ibi_tail: Sequence[Sequence[float]], fs: float, scale: Optional[float]) -> Dict[str, Any]:
    """Cheap rolling summary for the live UI (last ~10 s of accel, last ~60 beats)."""
    out: Dict[str, Any] = {}
    sc = _scale(acm_tail, scale)
    if len(acm_tail) >= int(fs * 4):
        t = analyze_tremor(acm_tail, fs, sc)
        m = analyze_motion(acm_tail, fs, sc)
        out["tremor"] = {"steadiness_score": t.steadiness_score, "dominant_hz": t.dominant_hz, "rms_mg": t.rms_mg, "quality": t.quality, "peak_prominence": t.peak_prominence, "tremor_ratio": t.tremor_ratio}
        out["motion"] = {"activity": m.activity, "cadence_spm": m.cadence_spm, "intensity_rms_g": m.intensity_rms_g, "reps": m.reps}
    if len(ibi_tail) >= 10:
        h = analyze_hrv([x[1] for x in ibi_tail])
        out["hrv"] = {"mean_hr": h.mean_hr, "rmssd_ms": h.rmssd_ms, "breathing_rpm": h.breathing_rpm, "breathing_confidence": h.breathing_confidence}
        if len(ibi_tail) >= 30:
            si = stress_index([x[1] for x in ibi_tail])
            out["stress"] = {"sqrt_si": si.get("sqrt_si"), "band": si.get("band")}
    out["scale_g_per_lsb"] = sc
    return out


def compute_metrics(kind: str, acm: Sequence[Sequence[float]], ibi: Sequence[Sequence[float]], fs: float, scale: Optional[float] = None, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Session-kind aware analysis. ``options`` may carry: label (e.g. rest/postural),
    target_bpm (breathing pace), max_hr, rest_hr, sex, t_stand_s, tags."""
    opt = dict(options or {})
    sc = _scale(acm, scale)
    metrics: Dict[str, Any] = {"kind": kind, "fs_hz": fs, "scale_g_per_lsb": sc, "acm_samples": len(acm), "beats": len(ibi), "options": opt}
    ibi_ms = [x[1] for x in ibi]
    t_s = [x[0] for x in ibi]
    if acm:
        if kind in ("steadiness", "free"):
            metrics["tremor"] = analyze_tremor(acm, fs, sc).as_dict()
        if kind in ("workout", "free", "gait"):
            metrics["motion"] = analyze_motion(acm, fs, sc).as_dict()
            metrics["timeline"] = classify_windows(acm, fs, 10.0, sc)
        if kind == "orthostatic":
            metrics["orthostatic"] = analyze_orthostatic(acm, ibi, fs, sc, opt.get("t_stand_s"))
    if ibi_ms:
        metrics["hrv"] = analyze_hrv(ibi_ms, breathing_lo_hz=0.08 if kind == "breathing" else 0.15).as_dict()
        _, rep = correct_ibi(ibi_ms)
        metrics["hrv"]["correction"] = rep
        metrics["rmssd_series"] = rolling_rmssd(ibi_ms)
        hr = [60000 / x for x in ibi_ms if x > 0]
        if kind in ("steadiness", "breathing", "orthostatic", "free"):
            metrics["stress"] = stress_index(ibi_ms)
        if kind == "breathing":
            metrics["breathing"] = breathing_session(ibi_ms, t_s, float(opt.get("target_bpm") or 6.0))
        if kind in ("workout", "free") and len(hr) >= 10:
            max_hr = float(opt.get("max_hr") or 0) or None
            rest_hr = float(opt.get("rest_hr") or 0) or None
            if not max_hr:
                age = opt.get("age")
                max_hr = 208 - 0.7 * float(age) if age else 190.0  # Tanaka 2001
            metrics["hr_recovery"] = heart_rate_recovery(hr, t_s)
            metrics["hr_zones"] = hr_zones(hr, max_hr=max_hr, rest_hr=rest_hr)
            metrics["training_load"] = training_load(hr, t_s, max_hr, rest_hr or 60.0, str(opt.get("sex") or "unspecified"))
            metrics["max_hr_used"] = max_hr
        metrics["hr_series"] = [[round(t, 1), int(round(v))] for t, v in zip(t_s, hr)]
    return metrics


def acm_preview(acm: Sequence[Sequence[float]], fs: float, scale: Optional[float], max_points: int = 1500) -> List[List[float]]:
    """Down-sampled |a| in g for charts."""
    if not acm:
        return []
    a = np.asarray(acm, dtype=float)
    sc = scale or _scale(acm, None) or 1.0
    norm = np.sqrt((a**2).sum(axis=1)) * sc
    step = max(1, len(norm) // max_points)
    return [[round(i / fs, 2), round(float(norm[i]), 4)] for i in range(0, len(norm), step)]
