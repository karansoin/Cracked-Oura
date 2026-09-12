"""Nightly personal baselines, z-scores, CUSUM change-point alerts and a transparent readiness.

Inputs are per-night values (already derived from ring events or an import):
resting HR, average HRV (RMSSD), temperature deviation, breathing rate and sleep
duration. Reference = trailing 60 nights (min 14); recent = trailing 7 nights.
A one-sided CUSUM (slack k = 0.5 σ, threshold h = 4 σ) on nightly residuals
flags sustained shifts in the "worse" direction for each signal.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import numpy as np

SIGNALS = {
    # name: (direction that counts as "worse", weight in readiness)
    "resting_hr": (+1, 0.25),
    "lnrmssd": (-1, 0.35),
    "temp_deviation": (+1, 0.15),
    "breathing_rate": (+1, 0.10),
    "sleep_hours": (-1, 0.15),
}
REF_NIGHTS = 60
MIN_REF = 14
RECENT = 7


def cusum(residuals: Sequence[Optional[float]], sigma: float, direction: int, k: float = 0.5, h: float = 4.0) -> List[float]:
    """One-sided CUSUM in units of σ; alarm when value ≥ h."""
    s = 0.0
    out: List[float] = []
    for r in residuals:
        if r is None or sigma <= 0:
            out.append(round(s, 2))
            continue
        z = direction * r / sigma
        s = max(0.0, s + z - k)
        out.append(round(s, 2))
    return out


def _series(rows: Sequence[Dict[str, Any]], key: str) -> List[Optional[float]]:
    out = []
    for r in rows:
        v = r.get(key)
        out.append(float(v) if v is not None else None)
    return out


def analyze_baselines(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """``rows``: chronological nightly dicts with 'day' and optional signal keys
    (resting_hr, rmssd, temp_deviation, breathing_rate, sleep_hours)."""
    rows = list(rows)
    days = [r["day"] for r in rows]
    prepared = []
    for r in rows:
        d = dict(r)
        d["lnrmssd"] = float(np.log(r["rmssd"])) if r.get("rmssd") else None
        prepared.append(d)
    signals: Dict[str, Any] = {}
    alarms: List[Dict[str, Any]] = []
    zsum = 0.0
    wsum = 0.0
    for name, (direction, weight) in SIGNALS.items():
        vals = _series(prepared, name)
        arr = np.array([v if v is not None else np.nan for v in vals], dtype=float)
        ref = arr[-REF_NIGHTS:]
        ref = ref[~np.isnan(ref)]
        rec = arr[-RECENT:]
        rec = rec[~np.isnan(rec)]
        entry: Dict[str, Any] = {"n_ref": int(ref.size), "n_recent": int(rec.size), "values": [[str(d), v] for d, v in zip(days, vals)]}
        if ref.size >= MIN_REF and rec.size >= 3:
            mu, sd = float(ref.mean()), float(ref.std(ddof=1))
            sd = max(sd, 1e-6)
            last = float(rec[-1])
            z7 = float((rec.mean() - mu) / sd)
            zlast = float((last - mu) / sd)
            resid = [(v - mu) if v is not None else None for v in vals[-REF_NIGHTS:]]
            cs = cusum(resid, sd, direction)
            alarm = bool(cs and cs[-1] >= 4.0)
            entry.update({
                "mean_ref": round(mu, 3), "sd_ref": round(sd, 3), "recent_mean": round(float(rec.mean()), 3), "last": round(last, 3),
                "z_recent": round(z7, 2), "z_last": round(zlast, 2), "cusum": cs, "alarm": alarm, "worse_direction": "up" if direction > 0 else "down",
                "swc": round(0.5 * sd, 3),  # smallest worthwhile change (Hopkins/Plews)
            })
            if alarm:
                alarms.append({"signal": name, "cusum": cs[-1], "z_recent": round(z7, 2)})
            # readiness contribution: worse direction reduces the score
            zc = float(np.clip(-direction * z7, -2, 2))
            zsum += weight * zc
            wsum += weight
        else:
            entry.update({"insufficient": True, "needed": MIN_REF})
        signals[name] = entry
    readiness = None
    if wsum > 0:
        score = 100.0 / (1.0 + np.exp(-1.2 * zsum / wsum))
        readiness = int(round(float(score)))
    status = "watch" if alarms else ("ready" if readiness is None or readiness >= 55 else "easy")
    return {
        "nights": len(rows),
        "signals": signals,
        "alarms": alarms,
        "readiness": readiness,
        "status": status,
        "formula": "readiness = 100·σ(1.2·Σ w_i·clip(∓z_i,±2)/Σ w_i); w: lnRMSSD 0.35, resting HR 0.25, temp 0.15, sleep 0.15, breathing 0.10; z vs trailing 60-night mean/SD from the last 7 nights",
        "false_alarm_note": "CUSUM with k=0.5σ, h=4σ raises roughly one spurious alarm every few months; alcohol, late meals, travel, illness and menstrual phase all shift these baselines.",
    }
