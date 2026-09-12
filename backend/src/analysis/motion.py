"""Cadence, step counting and coarse activity recognition from a finger-worn accelerometer."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Dict, List, Optional, Sequence

import numpy as np

from .signal import autocorr_period, band_power, bandpass_fft, find_peaks, moving_average, welch_psd


@dataclass
class MotionResult:
    fs_hz: float
    duration_s: int
    activity: str                # rest | walk | run | cycle | strength | active
    confidence: float
    cadence_spm: float           # steps (or cycles) per minute
    cadence_strength: float      # autocorrelation peak 0..1
    steps: int
    intensity_rms_g: float       # dynamic acceleration RMS
    stride_regularity: float     # 0..1 (autocorrelation at one stride)
    reps: int                    # strength repetitions (slow periodic motion)
    spectral_entropy: float
    energy_1_3: float
    energy_3_8: float

    def as_dict(self) -> dict:
        return asdict(self)


def _dyn(xyz: np.ndarray, fs: float = 50.0) -> np.ndarray:
    """Dynamic acceleration: per-axis gravity removal (2 s moving mean), then the vector norm,
    signed by the vertical-ish component so periodic motion keeps its phase for autocorrelation."""
    n = max(3, int(2 * fs))
    dyn = np.column_stack([xyz[:, i] - moving_average(xyz[:, i], n) for i in range(3)])
    norm = np.sqrt((dyn**2).sum(axis=1))
    main = int(np.argmax(dyn.var(axis=0)))  # axis with the most dynamic motion keeps the phase
    return np.sign(dyn[:, main] + 1e-9) * norm


def spectral_entropy(p: np.ndarray) -> float:
    p = np.asarray(p, dtype=float)
    s = p.sum()
    if s <= 0:
        return 0.0
    q = p / s
    q = q[q > 0]
    return float(-(q * np.log(q)).sum() / np.log(len(p)))


def analyze_motion(samples: Sequence[Sequence[float]], fs: float = 50.0, scale_g_per_lsb: Optional[float] = None) -> MotionResult:
    xyz = np.asarray(samples, dtype=float).reshape(-1, 3)
    if scale_g_per_lsb:
        xyz = xyz * scale_g_per_lsb
    n = xyz.shape[0]
    dur = int(n / fs) if fs else 0
    if n < int(fs * 3):
        return MotionResult(fs, dur, "rest", 0.0, 0.0, 0.0, 0, 0.0, 0.0, 0, 0.0, 0.0, 0.0)

    d = _dyn(xyz, fs)
    rms = float(np.sqrt(np.mean(d**2)))
    f, p = welch_psd(d, fs, nperseg=min(256, n))
    e13 = band_power(f, p, 1.0, 3.0)
    e38 = band_power(f, p, 3.0, 8.0)
    ent = spectral_entropy(p[(f >= 0.3) & (f <= 10)])

    # Cadence: walking 1.3–2.2 Hz (78–132 spm), running 2.2–3.5 Hz. Finger sees each step.
    cad_hz, strength = autocorr_period(d, fs, 0.8, 3.6)
    cadence_spm = cad_hz * 60.0

    # Step count: peaks of the 0.8–3.6 Hz band with a cadence-aware minimum distance
    band = bandpass_fft(d, fs, 0.8, 3.6)
    min_dist = int(fs / max(cad_hz, 1.0) * 0.6) if cad_hz else int(fs * 0.3)
    thr = max(0.05, 0.4 * float(np.std(band)))
    steps = int(find_peaks(band, max(min_dist, 3), thr).size) if rms > 0.03 else 0

    # Reps: slow periodic motion 0.2–0.9 Hz on the raw axis that moves most in that band
    slow_axes = [bandpass_fft(xyz[:, i], fs, 0.2, 0.9) for i in range(3)]
    slow = slow_axes[int(np.argmax([np.var(a) for a in slow_axes]))]
    slow_rms = float(np.sqrt(np.mean(slow**2)))
    rep_hz, rep_strength = autocorr_period(slow, fs, 0.2, 0.9)
    reps = int(find_peaks(slow, int(fs * 0.7), max(0.05, 0.5 * float(np.std(slow)))).size) if rep_strength > 0.35 and slow_rms > 0.05 else 0

    # Classification (rule-based; see docs for the feature rationale)
    if rms < 0.03 and slow_rms < 0.03:
        activity, conf = "rest", 0.9
    elif strength > 0.5 and 2.2 <= cad_hz <= 3.6 and rms > 0.5:
        activity, conf = "run", min(1.0, strength + 0.2)
    elif strength > 0.45 and 1.2 <= cad_hz < 2.2 and rms > 0.12:
        activity, conf = "walk", min(1.0, strength + 0.1)
    elif rep_strength > 0.4 and reps >= 3 and slow_rms > 0.05:
        activity, conf = "strength", min(1.0, rep_strength + 0.1)
    elif strength > 0.4 and 0.9 <= cad_hz < 1.4 and rms < 0.35:
        activity, conf = "cycle", min(1.0, strength)
    else:
        activity, conf = "active", 0.5

    stride_reg = 0.0
    if cad_hz:
        _, stride_reg = autocorr_period(d, fs, cad_hz / 2.2, cad_hz / 1.8)  # one stride = two steps
    return MotionResult(
        fs_hz=fs, duration_s=dur, activity=activity, confidence=round(float(conf), 2),
        cadence_spm=round(float(cadence_spm), 1) if activity in ("walk", "run") else round(float(cadence_spm), 1) * (strength > 0.3),
        cadence_strength=round(float(strength), 2), steps=steps if activity in ("walk", "run", "active") else 0,
        intensity_rms_g=round(rms, 4), stride_regularity=round(float(stride_reg), 2), reps=reps,
        spectral_entropy=round(ent, 3), energy_1_3=float(e13), energy_3_8=float(e38),
    )


def classify_windows(samples: Sequence[Sequence[float]], fs: float = 50.0, window_s: float = 10.0, scale_g_per_lsb: Optional[float] = None) -> List[Dict]:
    """Per-window activity labels for a long recording (workout auto-detection timeline)."""
    xyz = np.asarray(samples, dtype=float).reshape(-1, 3)
    w = int(window_s * fs)
    out: List[Dict] = []
    n = xyz.shape[0]
    starts = list(range(0, max(n - w + 1, 1), w))
    # keep a trailing partial window when it holds at least 4 s of data
    tail = starts[-1] + w if starts else 0
    if n - tail >= int(4 * fs):
        starts.append(tail)
    for start in starts:
        r = analyze_motion(xyz[start : start + w], fs, scale_g_per_lsb)
        out.append({"t_s": start / fs, "activity": r.activity, "confidence": r.confidence, "cadence_spm": r.cadence_spm, "steps": r.steps, "reps": r.reps, "intensity_rms_g": r.intensity_rms_g})
    return out
