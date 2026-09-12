import { formatTemperatureDeviation, type Units } from '@/lib/format';
import { formatNumber } from '@/lib/series-table';

export type MetricGroup = 'Sleep' | 'Readiness' | 'Activity' | 'Body';

/** How a metric's numbers are formatted (and which unit they carry). */
export type MetricKind =
    | 'score'
    | 'duration_s'
    | 'percent'
    | 'bpm'
    | 'ms'
    | 'breaths'
    | 'temp_dev'
    | 'count'
    | 'met'
    | 'years'
    | 'vo2'
    | 'number';

export interface MetricDef {
    /** Query path (`domain.field`). */
    key: string;
    label: string;
    group: MetricGroup;
    kind: MetricKind;
}

/** Curated daily metrics offered in the Trends view. */
export const TREND_METRICS: readonly MetricDef[] = [
    { key: 'sleep.score', label: 'Sleep score', group: 'Sleep', kind: 'score' },
    { key: 'sleep_session.total_sleep_duration', label: 'Total sleep', group: 'Sleep', kind: 'duration_s' },
    { key: 'sleep_session.efficiency', label: 'Sleep efficiency', group: 'Sleep', kind: 'percent' },
    { key: 'sleep_session.lowest_heart_rate', label: 'Lowest heart rate', group: 'Sleep', kind: 'bpm' },
    { key: 'sleep_session.average_hrv', label: 'Average HRV', group: 'Sleep', kind: 'ms' },
    { key: 'sleep_session.average_breath', label: 'Breathing rate', group: 'Sleep', kind: 'breaths' },
    { key: 'sleep.average_spo2', label: 'Average SpO₂', group: 'Sleep', kind: 'percent' },
    { key: 'readiness.score', label: 'Readiness score', group: 'Readiness', kind: 'score' },
    { key: 'readiness.temperature_deviation', label: 'Temperature deviation', group: 'Readiness', kind: 'temp_dev' },
    { key: 'activity.score', label: 'Activity score', group: 'Activity', kind: 'score' },
    { key: 'activity.steps', label: 'Steps', group: 'Activity', kind: 'count' },
    { key: 'activity.average_met', label: 'Average MET', group: 'Activity', kind: 'met' },
    { key: 'activity.sedentary_time', label: 'Sedentary time', group: 'Activity', kind: 'duration_s' },
    { key: 'cardiovascular_age.vascular_age', label: 'Cardiovascular age', group: 'Body', kind: 'years' },
    { key: 'vo2max.vo2_max', label: 'VO₂ max', group: 'Body', kind: 'vo2' },
] as const;

export const METRIC_GROUPS: readonly MetricGroup[] = ['Sleep', 'Readiness', 'Activity', 'Body'];

export function metricFor(key: string): MetricDef | undefined {
    return TREND_METRICS.find(m => m.key === key);
}

/** Infer the kind of an arbitrary query path (used by widgets plotting any key). */
export function kindForKey(key: string): MetricKind {
    const known = metricFor(key);
    if (known) return known.kind;
    const field = key.split('.').pop() ?? key;
    if (field === 'score') return 'score';
    if (field === 'temperature_deviation') return 'temp_dev';
    if (/duration|time_in_bed|latency|awake_time|_time$/.test(field)) return 'duration_s';
    if (/heart_rate|bpm/.test(field)) return 'bpm';
    if (/hrv/.test(field)) return 'ms';
    if (/breath/.test(field)) return 'breaths';
    if (/efficiency|spo2|percent/.test(field)) return 'percent';
    if (field === 'steps') return 'count';
    return 'number';
}

/** Seconds -> "7:12" (h:mm). */
export function formatHm(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
    const total = Math.round(seconds / 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${h}:${m.toString().padStart(2, '0')}`;
}

/** Unit suffix shown next to a formatted value ('' when the value carries its own). */
export function metricUnit(kind: MetricKind, units: Units): string {
    switch (kind) {
        case 'percent': return '%';
        case 'bpm': return 'bpm';
        case 'ms': return 'ms';
        case 'breaths': return '/min';
        case 'met': return 'MET';
        case 'years': return 'yrs';
        case 'vo2': return 'ml/kg/min';
        case 'temp_dev': return units === 'imperial' ? '°F' : '°C';
        default: return '';
    }
}

/** Format a metric value for headers, tooltips and tables (no unit suffix unless built in). */
export function formatMetricValue(value: number | null | undefined, kind: MetricKind, units: Units): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    switch (kind) {
        case 'duration_s': return formatHm(value);
        case 'temp_dev': return formatTemperatureDeviation(value, units);
        case 'score':
        case 'bpm':
        case 'ms':
        case 'count':
        case 'years':
        case 'percent':
            return Math.round(value).toLocaleString();
        case 'breaths':
        case 'met':
        case 'vo2':
            return formatNumber(value, 1);
        default:
            return formatNumber(value, 2);
    }
}

/** Value + unit, e.g. "62 bpm", "7:12", "+0.12 °C". */
export function formatMetricWithUnit(value: number | null | undefined, kind: MetricKind, units: Units): string {
    const text = formatMetricValue(value, kind, units);
    if (text === '—' || kind === 'temp_dev') return text;
    const unit = metricUnit(kind, units);
    return unit ? `${text} ${unit}` : text;
}
