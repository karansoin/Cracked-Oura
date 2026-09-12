"""Beat-to-beat analysis: artifact rejection, HRV, breathing rate, HR recovery."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import List, Optional, Sequence, Tuple

import numpy as np

from .signal import band_power, dominant_frequency, welch_psd


def clean_ibi(ibi_ms: Sequence[float], lo: float = 300, hi: float = 2000, max_rel_jump: float = 0.2) -> Tuple[np.ndarray, int]:
    """Drop implausible intervals and ectopic-like jumps (>20 % vs local median)."""
    x = np.asarray(ibi_ms, dtype=float)
    x = x[(x >= lo) & (x <= hi)]
    if x.size < 5:
        return x, 0
    med = np.array([np.median(x[max(0, i - 5) : i + 6]) for i in range(x.size)])
    ok = np.abs(x - med) <= max_rel_jump * med
    return x[ok], int((~ok).sum())


@dataclass
class HrvResult:
    n_beats: int
    rejected: int
    mean_hr: float
    rmssd_ms: float
    sdnn_ms: float
    pnn50: float
    lnrmssd: float
    breathing_rpm: float
    breathing_confidence: float
    lf_hf: float

    def as_dict(self) -> dict:
        return asdict(self)


def analyze_hrv(ibi_ms: Sequence[float]) -> HrvResult:
    x, rejected = clean_ibi(ibi_ms)
    if x.size < 10:
        return HrvResult(int(x.size), rejected, float(60000 / x.mean()) if x.size else 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    d = np.diff(x)
    rmssd = float(np.sqrt(np.mean(d**2)))
    sdnn = float(np.std(x, ddof=1))
    pnn50 = float(np.mean(np.abs(d) > 50) * 100)
    br, conf, lfhf = breathing_from_ibi(x)
    return HrvResult(
        n_beats=int(x.size), rejected=rejected, mean_hr=round(float(60000 / x.mean()), 1),
        rmssd_ms=round(rmssd, 1), sdnn_ms=round(sdnn, 1), pnn50=round(pnn50, 1),
        lnrmssd=round(float(np.log(max(rmssd, 1e-3))), 2), breathing_rpm=round(br, 1),
        breathing_confidence=round(conf, 2), lf_hf=round(lfhf, 2),
    )


def breathing_from_ibi(ibi_ms: np.ndarray, fs_resample: float = 4.0) -> Tuple[float, float, float]:
    """Respiratory rate from respiratory sinus arrhythmia: resample the IBI tachogram
    at 4 Hz and find the HF (0.15–0.5 Hz) peak. Returns (breaths/min, confidence, LF/HF)."""
    if ibi_ms.size < 20:
        return 0.0, 0.0, 0.0
    t = np.cumsum(ibi_ms) / 1000.0
    tt = np.arange(t[0], t[-1], 1.0 / fs_resample)
    if tt.size < 32:
        return 0.0, 0.0, 0.0
    y = np.interp(tt, t, ibi_ms)
    f, p = welch_psd(y, fs_resample, nperseg=min(256, tt.size))
    hf_peak, hf_pow = dominant_frequency(f, p, 0.15, 0.5)
    hf = band_power(f, p, 0.15, 0.4)
    lf = band_power(f, p, 0.04, 0.15)
    total = band_power(f, p, 0.04, 0.5) or 1e-9
    conf = float(min(1.0, hf / total * 1.5))
    return hf_peak * 60.0, conf, float(lf / hf) if hf > 0 else 0.0


def rolling_rmssd(ibi_ms: Sequence[float], window_beats: int = 30) -> List[Optional[float]]:
    x = np.asarray(ibi_ms, dtype=float)
    out: List[Optional[float]] = []
    for i in range(x.size):
        seg = x[max(0, i - window_beats + 1) : i + 1]
        seg, _ = clean_ibi(seg)
        out.append(round(float(np.sqrt(np.mean(np.diff(seg) ** 2))), 1) if seg.size >= 5 else None)
    return out


def heart_rate_recovery(hr_bpm: Sequence[float], t_s: Sequence[float], peak_t: Optional[float] = None) -> dict:
    """HRR1/HRR2: drop in HR 1 and 2 minutes after the peak (or after the given time)."""
    hr = np.asarray(hr_bpm, dtype=float)
    t = np.asarray(t_s, dtype=float)
    if hr.size < 10:
        return {"peak_bpm": None, "hrr1": None, "hrr2": None}
    if peak_t is None:
        i = int(np.argmax(hr))
        peak_t = float(t[i])
    peak = float(np.interp(peak_t, t, hr))

    def at(dt: float) -> Optional[float]:
        if t[-1] < peak_t + dt:
            return None
        return float(peak - np.interp(peak_t + dt, t, hr))

    return {"peak_bpm": round(peak, 1), "hrr1": at(60), "hrr2": at(120)}


def hr_zones(hr_bpm: Sequence[float], max_hr: float, rest_hr: Optional[float] = None) -> dict:
    """Time share per zone (Karvonen when rest_hr given, else % of max)."""
    hr = np.asarray(hr_bpm, dtype=float)
    if hr.size == 0:
        return {}
    if rest_hr:
        frac = (hr - rest_hr) / max(max_hr - rest_hr, 1)
    else:
        frac = hr / max_hr
    edges = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 10]
    names = ["below", "z1", "z2", "z3", "z4", "z5"]
    counts = np.histogram(frac, bins=edges)[0]
    return {name: round(float(c / hr.size), 3) for name, c in zip(names, counts)}
