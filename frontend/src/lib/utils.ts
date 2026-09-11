import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
}

/**
 * Field names (the LAST dot-path segment) that always hold an intraday series
 * (a JSON/array column with many samples per day) rather than a daily number.
 */
const INTRADAY_FIELDS = new Set([
    'hr_data',
    'hrv_data',
    'sleep_phase_5_min',
    'sleep_phase_30_sec',
    'movement_30_sec',
    'class_5_min',
    'met',
]);

/**
 * Domains (the FIRST dot-path segment) that are sampled throughout the day, so
 * every field under them is intraday.
 */
const INTRADAY_DOMAINS = new Set(['heart_rate', 'temperature', 'ring_battery']);

/**
 * Decide whether a data key (a dot path such as `sleep_session.hr_data` or
 * `heart_rate.bpm`) refers to an intraday series instead of a single daily value.
 *
 * Two categories qualify, both matched exactly (no substring matching, which
 * previously misclassified daily fields like `readiness.stress_high` or
 * `sleep.total_sleep_duration`):
 *
 *  1. Field allow-list on the last segment (`hr_data`, `hrv_data`,
 *     `sleep_phase_5_min`, `sleep_phase_30_sec`, `movement_30_sec`,
 *     `class_5_min`, `met`), plus `stress` only when it is the `activity.stress`
 *     JSON column. `resilience.stress` and `readiness.stress_high` are daily
 *     numbers and are excluded.
 *  2. Domain allow-list on the first segment (`heart_rate`, `temperature`,
 *     `ring_battery`), whose every field is sampled through the day.
 */
export function isIntradayKey(key: string): boolean {
    if (!key) return false;
    const segments = key.toLowerCase().split('.');
    const domain = segments[0];
    const field = segments[segments.length - 1];

    if (INTRADAY_DOMAINS.has(domain)) return true;
    if (INTRADAY_FIELDS.has(field)) return true;

    // `stress` is intraday only as the activity JSON column (or a bare key).
    if (field === 'stress') return segments.length === 1 || domain === 'activity';

    return false;
}
