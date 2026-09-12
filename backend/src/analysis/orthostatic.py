"""Orthostatic (lie/sit → stand) test from the ring accelerometer and beat series.

The stand is detected as a burst of |a| variance followed by a persistent change
in the direction of the low-passed gravity vector (ring orientation is unknown,
so only the *change* of direction is used). Heart-rate response follows the
exercise-science protocol: supine/seated mean over the last 60 s before the
stand, the 30 s peak after it, and the steady-state mean 60–180 s after it.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Sequence

import numpy as np

from .hrv import correct_ibi


def detect_stand(acm: Sequence[Sequence[float]], fs: float = 50.0, scale_g_per_lsb: Optional[float] = None, min_angle_deg: float = 30.0) -> Optional[Dict[str, Any]]:
    xyz = np.asarray(acm, dtype=float).reshape(-1, 3)
    if scale_g_per_lsb:
        xyz = xyz * scale_g_per_lsb
    n = xyz.shape[0]
    w = int(fs * 2)
    if n < int(fs * 30):
        return None
    # rolling movement energy in 2 s windows: per-axis variance summed (captures the
    # orientation swing of standing up, which |a| alone barely sees)
    var = np.array([xyz[i : i + w].var(axis=0).sum() for i in range(0, n - w, w // 2)])
    idx = np.arange(0, n - w, w // 2)
    ten = int(fs * 10)
    best = None
    for k in np.argsort(var)[::-1][:20]:
        c = int(idx[k]) + w // 2
        if c < ten or c + ten > n or var[k] < 0.002:
            continue
        pre = xyz[c - ten : c - int(fs)].mean(axis=0)
        post = xyz[c + int(fs) : c + ten].mean(axis=0)
        cosang = float(np.dot(pre, post) / (np.linalg.norm(pre) * np.linalg.norm(post) + 1e-9))
        angle = float(np.degrees(np.arccos(np.clip(cosang, -1, 1))))
        if angle >= min_angle_deg and (best is None or var[k] > best["burst_var"]):
            best = {"t_stand_s": round(c / fs, 1), "angle_deg": round(angle, 1), "burst_var": float(var[k])}
    return best


def analyze_orthostatic(acm: Sequence[Sequence[float]], ibi: Sequence[Sequence[float]], fs: float = 50.0, scale_g_per_lsb: Optional[float] = None, t_stand_s: Optional[float] = None) -> Dict[str, Any]:
    stand = detect_stand(acm, fs, scale_g_per_lsb) if t_stand_s is None else {"t_stand_s": t_stand_s, "angle_deg": None}
    out: Dict[str, Any] = {"stand": stand, "hr_supine": None, "hr_peak": None, "hr_stand": None, "delta_peak": None, "delta_stand": None, "rmssd_supine": None, "rmssd_stand": None, "rmssd_ratio": None, "quality": "no stand detected"}
    if not stand or not ibi:
        return out
    ts = float(stand["t_stand_s"])
    t = np.asarray([x[0] for x in ibi], dtype=float)
    x = np.asarray([x[1] for x in ibi], dtype=float)
    hr = 60000.0 / np.clip(x, 300, 2000)

    def mean_hr(lo: float, hi: float) -> Optional[float]:
        sel = (t >= lo) & (t < hi)
        return round(float(hr[sel].mean()), 1) if sel.sum() >= 5 else None

    def rmssd(lo: float, hi: float) -> Optional[float]:
        sel = (t >= lo) & (t < hi)
        if sel.sum() < 10:
            return None
        xc, _ = correct_ibi(x[sel])
        return round(float(np.sqrt(np.mean(np.diff(xc) ** 2))), 1) if xc.size >= 5 else None

    out["hr_supine"] = mean_hr(ts - 60, ts)
    # 5 s peak within 30 s of standing
    peak = None
    for a in np.arange(ts, ts + 26, 1.0):
        v = mean_hr(a, a + 5)
        if v is not None and (peak is None or v > peak):
            peak = v
    out["hr_peak"] = peak
    out["hr_stand"] = mean_hr(ts + 60, ts + 180) or mean_hr(ts + 30, t[-1] + 0.1)
    out["rmssd_supine"] = rmssd(ts - 180, ts)
    out["rmssd_stand"] = rmssd(ts + 60, ts + 180) or rmssd(ts + 20, t[-1] + 0.1)
    if out["hr_supine"] is not None:
        if peak is not None:
            out["delta_peak"] = round(peak - out["hr_supine"], 1)
        if out["hr_stand"] is not None:
            out["delta_stand"] = round(out["hr_stand"] - out["hr_supine"], 1)
    if out["rmssd_supine"] and out["rmssd_stand"] is not None:
        out["rmssd_ratio"] = round(out["rmssd_stand"] / out["rmssd_supine"], 2)
    pre_ok = ts >= 60 and out["hr_supine"] is not None
    post_ok = out["hr_stand"] is not None
    out["quality"] = "good" if (pre_ok and post_ok and t[-1] >= ts + 120) else "short" if (pre_ok and post_ok) else "incomplete"
    return out
