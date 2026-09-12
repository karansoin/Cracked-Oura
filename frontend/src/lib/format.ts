import { format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns';

export type Units = 'metric' | 'imperial';

/** Seconds -> "7h 12m" (or "45m"). */
export function formatDurationSeconds(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
    const total = Math.round(seconds / 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Whole minutes -> "7h 12m". */
export function formatMinutes(minutes: number | null | undefined): string {
    if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
    return formatDurationSeconds(minutes * 60);
}

/** Elapsed seconds -> "1m 05s" / "12s". */
export function formatElapsed(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    const rest = s % 60;
    if (m === 0) return `${rest}s`;
    return `${m}m ${rest.toString().padStart(2, '0')}s`;
}

/** Bytes -> "1.2 MB". */
export function formatBytes(bytes: number | null | undefined): string {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

/** ISO date or datetime -> "Tue 9 Sep 2026". Falls back to the raw string. */
export function formatDay(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = parseISO(iso);
    if (!isValid(d)) return iso;
    return format(d, 'EEE d MMM yyyy');
}

/** ISO datetime -> "09:12". */
export function formatClock(iso: string | Date | null | undefined): string {
    if (!iso) return '—';
    const d = typeof iso === 'string' ? parseISO(iso) : iso;
    if (!isValid(d)) return String(iso);
    return format(d, 'HH:mm');
}

/** ISO datetime -> "2 h ago" / "just now". */
export function formatRelative(iso: string | null | undefined): string {
    if (!iso) return 'never';
    const d = parseISO(iso);
    if (!isValid(d)) return iso;
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return 'just now';
    return `${formatDistanceToNowStrict(d)} ago`;
}

/** Unix seconds -> relative string. */
export function formatRelativeUnix(unix: number | null | undefined): string {
    if (!unix) return 'never';
    return formatRelative(new Date(unix * 1000).toISOString());
}

/** `snake_case_key` -> "Snake case key". */
export function humanizeKey(key: string): string {
    const last = key.split('.').pop() ?? key;
    const spaced = last.replace(/_/g, ' ').trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Thousands separators. */
export function formatCount(n: number | null | undefined): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    return n.toLocaleString();
}

/**
 * Temperature *deviation* (a delta, not an absolute temperature) with sign and unit.
 * Imperial converts the delta by x1.8 (no offset).
 */
export function formatTemperatureDeviation(celsiusDelta: number | null | undefined, units: Units): string {
    if (celsiusDelta === null || celsiusDelta === undefined || !Number.isFinite(celsiusDelta)) return '—';
    const value = units === 'imperial' ? celsiusDelta * 1.8 : celsiusDelta;
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)} °${units === 'imperial' ? 'F' : 'C'}`;
}

/** Metres -> "1.2 km" or "0.8 mi". */
export function formatDistance(metres: number | null | undefined, units: Units): string {
    if (metres === null || metres === undefined || !Number.isFinite(metres)) return '—';
    if (units === 'imperial') return `${(metres / 1609.344).toFixed(2)} mi`;
    return `${(metres / 1000).toFixed(2)} km`;
}
