import { HypnogramCanvas, type HypnogramOverlay } from './HypnogramCanvas';
import { useSleepBaseline } from '@/hooks/useSleepBaseline';

interface HypnogramWidgetProps {
    /** The sleep session record (`sleep_session` from the day payload). */
    session: Record<string, unknown> | null;
    phases: unknown;
    /** Selected day (`yyyy-MM-dd`); anchors the 90-night typical range. */
    date: string;
    dayLabel?: string;
    compact?: boolean;
    /** HR / HRV toggles; null hides the overlay (short widgets). */
    overlay: HypnogramOverlay | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Hypnogram plus the HR/HRV overlay, with the personal typical-range band. */
export function HypnogramWidget({ session, phases, date, dayLabel, compact, overlay }: HypnogramWidgetProps) {
    const baseline = useSleepBaseline(date);
    const startTime = str(session?.bedtime_start) ?? str(session?.start_time);
    const endTime = str(session?.bedtime_end) ?? str(session?.end_time);
    return (
        <HypnogramCanvas
            phases={phases}
            startTime={startTime}
            endTime={endTime}
            dayLabel={dayLabel}
            compact={compact}
            overlay={overlay}
            hrData={session?.hr_data}
            hrvData={session?.hrv_data}
            lowestHeartRate={num(session?.lowest_heart_rate)}
            typicalHr={baseline.hr}
            typicalHrv={baseline.hrv}
        />
    );
}
