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


def analyze_hrv(ibi_ms: Sequence[float], breathing_lo_hz: float = 0.15) -> HrvResult:
    """``breathing_lo_hz``: lower edge of the respiratory band (0.15 Hz = 9/min for
    spontaneous breathing; paced sessions at 6/min need 0.08)."""
    x, rejected = clean_ibi(ibi_ms)
    if x.size < 10:
        return HrvResult(int(x.size), rejected, float(60000 / x.mean()) if x.size else 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    d = np.diff(x)
    rmssd = float(np.sqrt(np.mean(d**2)))
    sdnn = float(np.std(x, ddof=1))
    pnn50 = float(np.mean(np.abs(d) > 50) * 100)
    br, conf, lfhf = breathing_from_ibi(x, lo_hz=breathing_lo_hz)
    return HrvResult(
        n_beats=int(x.size), rejected=rejected, mean_hr=round(float(60000 / x.mean()), 1),
        rmssd_ms=round(rmssd, 1), sdnn_ms=round(sdnn, 1), pnn50=round(pnn50, 1),
        lnrmssd=round(float(np.log(max(rmssd, 1e-3))), 2), breathing_rpm=round(br, 1),
        breathing_confidence=round(conf, 2), lf_hf=round(lfhf, 2),
    )


def breathing_from_ibi(ibi_ms: np.ndarray, fs_resample: float = 4.0, lo_hz: float = 0.15) -> Tuple[float, float, float]:
    """Respiratory rate from respiratory sinus arrhythmia: resample the IBI tachogram
    at 4 Hz and find the HF (``lo_hz``–0.5 Hz) peak. Returns (breaths/min, confidence, LF/HF)."""
    if ibi_ms.size < 20:
        return 0.0, 0.0, 0.0
    t = np.cumsum(ibi_ms) / 1000.0
    tt = np.arange(t[0], t[-1], 1.0 / fs_resample)
    if tt.size < 32:
        return 0.0, 0.0, 0.0
    y = np.interp(tt, t, ibi_ms)
    f, p = welch_psd(y, fs_resample, nperseg=min(256, tt.size))
    hf_peak, hf_pow = dominant_frequency(f, p, lo_hz, 0.5)
    hf = band_power(f, p, 0.15, 0.4)
    lf = band_power(f, p, 0.04, 0.15)
    total = band_power(f, p, 0.04, 0.5) or 1e-9
    resp = band_power(f, p, max(lo_hz, hf_peak - 0.03), min(0.5, hf_peak + 0.03)) if hf_peak else 0.0
    conf = float(min(1.0, resp / total * 1.5))
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


# ---------------------------------------------------------------------------
# Artifact correction (Lipponen & Tarvainen 2019, simplified), stress index,
# guided-breathing scoring and training load.
# ---------------------------------------------------------------------------


def correct_ibi(ibi_ms: Sequence[float], c: float = 5.2, window: int = 91) -> Tuple[np.ndarray, dict]:
    """Kubios-style automatic correction.

    Beats whose successive difference (dRR) or deviation from the local 11-beat
    median (mRR) exceeds ``c`` quartile deviations inside a sliding 91-beat window
    are flagged. Very short beats followed by very long ones ("extra") are merged,
    very long beats are split ("missed"), the rest are replaced by cubic-ish
    interpolation of their neighbours. Returns the corrected series and a report
    with the corrected fraction (Kubios recommends discarding windows > 5 %).
    """
    x = np.asarray(ibi_ms, dtype=float)
    x = x[(x > 200) & (x < 3000)]
    n = x.size
    if n < 12:
        return x, {"n": int(n), "corrected": 0, "fraction": 0.0, "usable": n >= 5}
    drr = np.diff(x, prepend=x[0])
    med = np.array([np.median(x[max(0, i - 5) : i + 6]) for i in range(n)])
    mrr = x - med
    half = window // 2

    def qd(v: np.ndarray) -> float:
        q1, q3 = np.percentile(v, [25, 75])
        return max((q3 - q1) / 2.0, 1.0)

    flags = np.zeros(n, dtype=bool)
    kinds = np.zeros(n, dtype=np.int8)  # 1 ectopic/long-short, 2 missed, 3 extra
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        th1 = c * qd(drr[lo:hi])
        th2 = c * qd(mrr[lo:hi])
        # The beat *after* an artifact also has a large dRR; requiring a median
        # deviation as well keeps normal neighbours from being flagged.
        if abs(mrr[i]) > th2 or (abs(drr[i]) > th1 and abs(mrr[i]) > th2 / 2):
            flags[i] = True
            if mrr[i] > 0 and abs(x[i] - 2 * med[i]) < 0.35 * med[i]:
                kinds[i] = 2  # roughly double the local median: a missed beat
            elif mrr[i] < 0 and i + 1 < n and abs(x[i] + x[i + 1] - med[i]) < 0.35 * med[i]:
                kinds[i] = 3  # this and the next one add up to a normal beat: extra detection
            else:
                kinds[i] = 1
    out: List[float] = []
    i = 0
    while i < n:
        k = kinds[i]
        if k == 2:
            out.extend([x[i] / 2.0, x[i] / 2.0])
        elif k == 3 and i + 1 < n:
            out.append(x[i] + x[i + 1])
            i += 1
        elif k == 1:
            out.append(float(med[i]))
        else:
            out.append(float(x[i]))
        i += 1
    corrected = int(flags.sum())
    frac = corrected / n
    return np.asarray(out), {"n": int(n), "corrected": corrected, "fraction": round(float(frac), 4), "usable": frac <= 0.05}


def stress_index(ibi_ms: Sequence[float]) -> dict:
    """Baevsky stress index: SI = AMo% / (2 · Mo[s] · MxDMn[s]) on 50 ms bins.
    Healthy resting adults ≈ 50–150; > 150 sympathetic predominance; < 50 vagal.
    Only meaningful while still. Returns SI and sqrt(SI) (the Kubios display convention)."""
    x, rep = correct_ibi(ibi_ms)
    if x.size < 30:
        return {"si": None, "sqrt_si": None, "n": int(x.size), "usable": False}
    bins = np.arange(300, 2050, 50)
    counts, edges = np.histogram(x, bins=bins)
    k = int(np.argmax(counts))
    mo = (edges[k] + edges[k + 1]) / 2000.0  # s
    amo = 100.0 * counts[k] / x.size
    mxdmn = max(float(x.max() - x.min()) / 1000.0, 0.02)
    si = amo / (2 * mo * mxdmn)
    band = "vagal" if si < 50 else "balanced" if si <= 150 else "sympathetic" if si <= 500 else "high strain"
    return {"si": round(float(si), 1), "sqrt_si": round(float(np.sqrt(si)), 2), "band": band, "n": int(x.size), "usable": bool(rep["usable"])}


def breathing_session(ibi_ms: Sequence[float], t_s: Sequence[float], target_bpm: float = 6.0, baseline_ibi_ms: Optional[Sequence[float]] = None) -> dict:
    """Score a paced-breathing session from the beat series.

    resonance   = share of tachogram power in 0.08–0.12 Hz vs 0.04–0.4 Hz
    rsa_amp     = mean per-breath (max HR − min HR), beats/min
    adherence   = share of detected breaths within ±1 breath/min of the target
    pre_post    = lnRMSSD(last 60 s) − lnRMSSD(first 60 s) (or vs. the given baseline)
    """
    x = np.asarray(ibi_ms, dtype=float)
    t = np.asarray(t_s, dtype=float)
    out: dict = {"target_bpm": target_bpm, "resonance": None, "rsa_amplitude_bpm": None, "adherence": None, "breath_rate_bpm": None, "pre_post_lnrmssd": None, "n_breaths": 0}
    if x.size < 30 or t.size != x.size:
        return out
    xc, _ = correct_ibi(x)
    if xc.size != x.size:  # keep timestamps aligned: fall back to the raw series
        xc = x
    fs = 4.0
    tt = np.arange(t[0], t[-1], 1.0 / fs)
    if tt.size < 64:
        return out
    y = np.interp(tt, t, xc)
    f, p = welch_psd(y - y.mean(), fs, nperseg=min(240, tt.size))
    lf_res = band_power(f, p, 0.08, 0.12)
    total = band_power(f, p, 0.04, 0.4) or 1e-9
    out["resonance"] = round(float(min(1.0, lf_res / total)), 3)
    peak_hz, _ = dominant_frequency(f, p, 0.05, 0.5)
    out["breath_rate_bpm"] = round(peak_hz * 60, 1) if peak_hz else None
    # per-breath RSA amplitude: band-limit the HR trace around the target and split at troughs
    from .signal import bandpass_fft, find_peaks

    hr = 60000.0 / y
    ft = target_bpm / 60.0
    band = bandpass_fft(hr - hr.mean(), fs, max(0.03, ft * 0.5), min(0.5, ft * 2.0))
    min_dist = int(fs * 60 / (target_bpm * 2.0))
    troughs = find_peaks(-band, min_dist, 0.0)
    amps: List[float] = []
    periods: List[float] = []
    for a, b in zip(troughs[:-1], troughs[1:]):
        seg = hr[a:b]
        if seg.size >= 3:
            amps.append(float(seg.max() - seg.min()))
            periods.append((b - a) / fs)
    if amps:
        out["rsa_amplitude_bpm"] = round(float(np.mean(amps)), 1)
        out["n_breaths"] = len(amps)
        rates = 60.0 / np.asarray(periods)
        out["adherence"] = round(float(np.mean(np.abs(rates - target_bpm) <= 1.0)), 2)
    # pre/post lnRMSSD
    def ln_rmssd(sel: np.ndarray) -> Optional[float]:
        seg = xc[sel]
        if seg.size < 8:
            return None
        return float(np.log(max(np.sqrt(np.mean(np.diff(seg) ** 2)), 1e-3)))

    if baseline_ibi_ms is not None and len(baseline_ibi_ms) >= 8:
        pre = float(np.log(max(np.sqrt(np.mean(np.diff(np.asarray(baseline_ibi_ms, dtype=float)) ** 2)), 1e-3)))
    else:
        pre = ln_rmssd(t <= t[0] + 60)
    post = ln_rmssd(t >= t[-1] - 60)
    if pre is not None and post is not None:
        out["pre_post_lnrmssd"] = round(post - pre, 3)
    return out


def training_load(hr_bpm: Sequence[float], t_s: Sequence[float], max_hr: float, rest_hr: float, sex: str = "unspecified") -> dict:
    """Banister TRIMP (with the sex-specific exponent) and Edwards' zone-weighted TRIMP."""
    hr = np.asarray(hr_bpm, dtype=float)
    t = np.asarray(t_s, dtype=float)
    if hr.size < 2 or t.size != hr.size:
        return {"banister": None, "edwards": None, "minutes": 0.0}
    dt_min = np.diff(t, append=t[-1]) / 60.0
    dt_min = np.clip(dt_min, 0, 10 / 60)
    frac = np.clip((hr - rest_hr) / max(max_hr - rest_hr, 1), 0, 1)
    b = 1.67 if sex == "female" else 1.92
    banister = float(np.sum(dt_min * frac * 0.64 * np.exp(b * frac)))
    pct = hr / max_hr
    weights = np.select([pct < 0.5, pct < 0.6, pct < 0.7, pct < 0.8, pct < 0.9], [0, 1, 2, 3, 4], 5)
    edwards = float(np.sum(dt_min * weights))
    return {"banister": round(banister, 1), "edwards": round(edwards, 1), "minutes": round(float(dt_min.sum()), 1)}
