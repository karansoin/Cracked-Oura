"""Accelerometer scale estimation: at rest |a| == 1 g, so the median norm of raw
counts over a still window gives counts-per-g without knowing the sensor range."""

from __future__ import annotations

from typing import Optional, Sequence

import numpy as np


def estimate_scale(samples: Sequence[Sequence[float]], max_cv: float = 0.08) -> Optional[float]:
    """Return g-per-LSB, or None when the window is not still enough (CV of |a| > max_cv)."""
    xyz = np.asarray(samples, dtype=float).reshape(-1, 3)
    if xyz.shape[0] < 20:
        return None
    norm = np.sqrt((xyz**2).sum(axis=1))
    med = float(np.median(norm))
    if med <= 0:
        return None
    cv = float(np.std(norm) / med)
    if cv > max_cv:
        return None
    return 1.0 / med
