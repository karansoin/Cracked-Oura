"""Small, dependency-free DSP helpers (NumPy only)."""

from __future__ import annotations

from typing import Tuple

import numpy as np


def detrend(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    if x.size < 2:
        return x - x.mean() if x.size else x
    t = np.arange(x.size)
    a, b = np.polyfit(t, x, 1)
    return x - (a * t + b)


def moving_average(x: np.ndarray, n: int) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    if n <= 1 or x.size < n:
        return x.copy()
    k = np.ones(n) / n
    pad = n // 2
    xp = np.pad(x, (pad, n - 1 - pad), mode="edge")
    return np.convolve(xp, k, mode="valid")


def highpass(x: np.ndarray, fs: float, cutoff_hz: float) -> np.ndarray:
    """High-pass by subtracting a moving average whose length ≈ 1/cutoff."""
    n = max(3, int(round(fs / cutoff_hz)))
    return np.asarray(x, dtype=float) - moving_average(x, n)


def bandpass_fft(x: np.ndarray, fs: float, lo: float, hi: float) -> np.ndarray:
    """Zero-phase band-pass via FFT masking (fine for offline windows)."""
    x = detrend(x)
    n = x.size
    if n < 8:
        return x
    # Taper only the outer 5 % to limit edge ringing; the body keeps unit gain.
    taper = np.ones(n)
    k = max(2, n // 20)
    ramp = 0.5 - 0.5 * np.cos(np.pi * np.arange(k) / k)
    taper[:k] = ramp
    taper[-k:] = ramp[::-1]
    spec = np.fft.rfft(x * taper)
    f = np.fft.rfftfreq(n, d=1.0 / fs)
    spec[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(spec, n=n)


def welch_psd(x: np.ndarray, fs: float, nperseg: int = 256, overlap: float = 0.5) -> Tuple[np.ndarray, np.ndarray]:
    """Welch power spectral density (Hann window, one-sided, unit²/Hz)."""
    x = detrend(x)
    n = x.size
    nperseg = int(min(nperseg, n))
    if nperseg < 8:
        f = np.fft.rfftfreq(max(n, 8), d=1.0 / fs)
        return f, np.zeros_like(f)
    step = max(1, int(nperseg * (1 - overlap)))
    win = np.hanning(nperseg)
    scale = fs * (win**2).sum()
    acc = None
    count = 0
    for start in range(0, n - nperseg + 1, step):
        seg = x[start : start + nperseg]
        seg = seg - seg.mean()
        p = np.abs(np.fft.rfft(seg * win)) ** 2 / scale
        p[1:-1] *= 2
        acc = p if acc is None else acc + p
        count += 1
    f = np.fft.rfftfreq(nperseg, d=1.0 / fs)
    return f, (acc / count if count else np.zeros_like(f))


def band_power(f: np.ndarray, p: np.ndarray, lo: float, hi: float) -> float:
    m = (f >= lo) & (f <= hi)
    if not m.any():
        return 0.0
    return float(np.trapezoid(p[m], f[m]))


def dominant_frequency(f: np.ndarray, p: np.ndarray, lo: float, hi: float) -> Tuple[float, float]:
    """Peak frequency and its power within [lo, hi]."""
    m = (f >= lo) & (f <= hi)
    if not m.any():
        return 0.0, 0.0
    idx = np.argmax(np.where(m, p, -1))
    return float(f[idx]), float(p[idx])


def find_peaks(x: np.ndarray, min_distance: int, min_height: float) -> np.ndarray:
    """Indices of local maxima above ``min_height`` separated by ≥ ``min_distance`` samples."""
    x = np.asarray(x, dtype=float)
    if x.size < 3:
        return np.array([], dtype=int)
    cand = np.where((x[1:-1] > x[:-2]) & (x[1:-1] >= x[2:]) & (x[1:-1] >= min_height))[0] + 1
    if cand.size == 0:
        return cand
    keep = [int(cand[0])]
    for i in cand[1:]:
        if i - keep[-1] >= min_distance:
            keep.append(int(i))
        elif x[i] > x[keep[-1]]:
            keep[-1] = int(i)
    return np.array(keep, dtype=int)


def autocorr_period(x: np.ndarray, fs: float, lo_hz: float, hi_hz: float) -> Tuple[float, float]:
    """Fundamental period via normalised autocorrelation; returns (freq_hz, strength 0..1)."""
    x = detrend(x)
    n = x.size
    if n < int(2 * fs / lo_hz):
        return 0.0, 0.0
    x = x - x.mean()
    ac = np.correlate(x, x, mode="full")[n - 1 :]
    if ac[0] <= 0:
        return 0.0, 0.0
    ac = ac / ac[0]
    lag_lo, lag_hi = int(fs / hi_hz), int(fs / lo_hz)
    if lag_hi >= ac.size or lag_lo >= lag_hi:
        return 0.0, 0.0
    seg = ac[lag_lo:lag_hi]
    k = int(np.argmax(seg)) + lag_lo
    return fs / k, float(max(0.0, ac[k]))
