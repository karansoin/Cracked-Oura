"""Tremor / steadiness analysis from a 3-axis accelerometer.

Bands (literature): physiological tremor 8–12 Hz, essential tremor 4–12 Hz
(postural), parkinsonian rest tremor 4–6 Hz. We report band powers, the
dominant frequency, an RMS amplitude in milli-g, and a 0–100 "steadiness"
score relative to typical resting physiological tremor. This is a wellness
measurement, not a diagnosis.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Dict, List, Optional, Sequence

import numpy as np

from .signal import band_power, bandpass_fft, dominant_frequency, welch_psd

G = 9.80665


@dataclass
class TremorResult:
    fs_hz: float
    duration_s: float
    n_samples: int
    dominant_hz: float
    dominant_power: float
    rms_mg: float                 # RMS of the 3–12 Hz band, milli-g
    amplitude_mm: float           # peak displacement estimate at the dominant frequency
    power_3_7: float              # rest/parkinsonian-type band
    power_7_12: float             # physiological/essential band
    power_12_20: float            # high band (noise/voluntary)
    tremor_ratio: float           # (3–12 Hz) / (0.5–20 Hz) power
    steadiness_score: int         # 0–100, higher = steadier
    quality: str                  # 'good' | 'short' | 'moving'
    movement_rms_mg: float        # low-frequency (voluntary) movement, for quality gating
    spectrum: Dict[str, List[float]]

    def as_dict(self) -> dict:
        return asdict(self)


def _magnitude(xyz: np.ndarray) -> np.ndarray:
    return np.sqrt((xyz.astype(float) ** 2).sum(axis=1))


def analyze_tremor(samples: Sequence[Sequence[float]], fs: float = 50.0, scale_g_per_lsb: Optional[float] = None) -> TremorResult:
    """``samples`` = N×3 accelerometer rows (raw counts or g). If ``scale_g_per_lsb`` is
    given the rows are converted to g first; otherwise they are assumed to be in g."""
    xyz = np.asarray(samples, dtype=float).reshape(-1, 3)
    if scale_g_per_lsb:
        xyz = xyz * scale_g_per_lsb
    n = xyz.shape[0]
    duration = n / fs if fs else 0.0
    if n < int(fs * 4):
        return TremorResult(fs, duration, n, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0, "short", 0.0, {"f": [], "p": []})

    mag = _magnitude(xyz)
    # Per-axis analysis catches tremor perpendicular to gravity; use the axis with most band power.
    f, p_mag = welch_psd(mag, fs, nperseg=min(256, n))
    axis_psds = [welch_psd(xyz[:, i], fs, nperseg=min(256, n))[1] for i in range(3)]
    axis_bp = [band_power(f, p, 3, 12) for p in axis_psds]
    best_axis = int(np.argmax(axis_bp))
    p = np.maximum(p_mag, axis_psds[best_axis])

    p37 = band_power(f, p, 3, 7)
    p712 = band_power(f, p, 7, 12)
    p1220 = band_power(f, p, 12, 20)
    total = band_power(f, p, 0.5, 20) or 1e-12
    ratio = (p37 + p712) / total
    dom_hz, dom_pow = dominant_frequency(f, p, 3, 12)

    band = bandpass_fft(xyz[:, best_axis], fs, 3, 12)
    rms_g = float(np.sqrt(np.mean(band**2)))
    rms_mg = rms_g * 1000.0
    # x(t)=A sin(2πft) → a = A(2πf)²; displacement amplitude from RMS acceleration
    amp_mm = (rms_g * G * np.sqrt(2)) / ((2 * np.pi * max(dom_hz, 1.0)) ** 2) * 1000.0 if dom_hz else 0.0

    low = bandpass_fft(mag, fs, 0.1, 2.0)
    movement_rms_mg = float(np.sqrt(np.mean(low**2))) * 1000.0
    quality = "moving" if movement_rms_mg > 60 else "good"

    # Steadiness: typical resting physiological tremor at the finger ≈ 2–6 mg RMS.
    score = int(round(100 * np.clip(1 - (np.log10(max(rms_mg, 0.5)) - np.log10(3.0)) / (np.log10(60.0) - np.log10(3.0)), 0, 1)))

    keep = f <= 20
    return TremorResult(
        fs_hz=fs, duration_s=round(duration, 2), n_samples=n,
        dominant_hz=round(dom_hz, 2), dominant_power=float(dom_pow),
        rms_mg=round(rms_mg, 2), amplitude_mm=round(amp_mm, 3),
        power_3_7=float(p37), power_7_12=float(p712), power_12_20=float(p1220),
        tremor_ratio=round(float(ratio), 3), steadiness_score=score, quality=quality,
        movement_rms_mg=round(movement_rms_mg, 1),
        spectrum={"f": [round(float(v), 2) for v in f[keep]], "p": [float(v) for v in p[keep]]},
    )
