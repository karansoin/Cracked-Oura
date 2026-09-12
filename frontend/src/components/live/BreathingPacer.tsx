import { useEffect, useState } from 'react';

interface BreathingPacerProps {
    /** Breaths per minute. */
    pace: number;
    running: boolean;
    /** Elapsed seconds, used to keep the phase in step with the recording. */
    elapsed: number;
}

/**
 * Expanding / contracting circle at the target pace (inhale = exhale = half a cycle).
 * Driven by elapsed time rather than a CSS animation so pausing and resizing never drift.
 */
export function BreathingPacer({ pace, running, elapsed }: BreathingPacerProps) {
    const period = 60 / Math.max(pace, 1);
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!running) return;
        let raf = 0;
        const loop = () => { setTick(performance.now()); raf = requestAnimationFrame(loop); };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, [running]);
    void tick;
    const phase = running ? ((elapsed % period) / period) : 0; // 0..1
    const inhale = phase < 0.5;
    const s = inhale ? phase * 2 : 1 - (phase - 0.5) * 2; // 0..1..0
    const eased = 0.5 - 0.5 * Math.cos(Math.PI * s);
    const scale = 0.55 + 0.45 * eased;
    return (
        <div className="flex flex-col items-center gap-3 py-2" aria-live="polite">
            <div className="relative flex h-40 w-40 items-center justify-center">
                <div className="absolute inset-0 rounded-full border border-border/60" aria-hidden="true" />
                <div
                    className="rounded-full bg-[#0072B2]/20 ring-2 ring-[#0072B2]/60 dark:bg-[#5AA9E6]/20 dark:ring-[#5AA9E6]/60"
                    style={{ width: 160 * scale, height: 160 * scale, transition: running ? 'none' : 'width 300ms, height 300ms' }}
                    aria-hidden="true"
                />
                <span className="absolute text-sm font-medium">{running ? (inhale ? 'Inhale' : 'Exhale') : 'Ready'}</span>
            </div>
            <p className="text-xs text-muted-foreground">{pace.toFixed(1)} breaths/min · {(period / 2).toFixed(1)} s in, {(period / 2).toFixed(1)} s out</p>
        </div>
    );
}
