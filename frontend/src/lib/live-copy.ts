import type { SessionMetrics } from '@/lib/live-api';

/** Plain-language reading of a steadiness spectrum. Wellness wording only. */
export function steadinessSummary(t: NonNullable<SessionMetrics['tremor']>): { headline: string; body: string } {
    if (t.quality === 'moving') return { headline: 'Too much movement to score', body: 'Voluntary movement dominated the recording. Rest the forearm on a surface, relax the hand and try again.' };
    if (t.quality === 'short') return { headline: 'Recording too short', body: 'At least 20 s of still data is needed for a spectrum.' };
    const narrow = t.q_factor >= 4 && t.peak_prominence >= 8;
    if (t.tremor_ratio < 0.3 || !narrow) return { headline: 'No discrete oscillation', body: 'Band power is spread out with no sharp peak, which is what a steady hand looks like on this sensor.' };
    if (t.dominant_hz >= 7.5) return { headline: 'Peak in the physiological range', body: `A narrow peak at ${t.dominant_hz.toFixed(1)} Hz. Everyone has a small 8–12 Hz oscillation; caffeine, fatigue, cold and stress make it larger.` };
    return { headline: 'Low-frequency peak', body: `A narrow peak at ${t.dominant_hz.toFixed(1)} Hz. If this keeps appearing at rest across several sessions, it is worth mentioning to a clinician. One session on its own means little.` };
}
