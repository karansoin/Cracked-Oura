/**
 * Tabular view of a chart's plotted series ("View as table" / "Copy CSV"),
 * plus the small numeric helpers charts share (stats, percentiles, rolling mean).
 */
import { toast } from 'sonner';

export interface ChartTable {
    /** Header labels; the first column is the date/time. */
    columns: string[];
    /** Formatted cells, one row per plotted x value. */
    rows: string[][];
}

const csvCell = (value: string): string =>
    /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/** RFC 4180-ish CSV with a header row. */
export function tableToCsv(table: ChartTable): string {
    const lines = [table.columns.map(csvCell).join(',')];
    for (const row of table.rows) lines.push(row.map(csvCell).join(','));
    return lines.join('\n');
}

/** Copy a chart table to the clipboard as CSV, with a toast either way. */
export async function copyTableAsCsv(table: ChartTable | null | undefined, title: string): Promise<void> {
    if (!table || table.rows.length === 0) {
        toast.info('Nothing to copy', { description: `${title} has no plotted values.` });
        return;
    }
    try {
        await navigator.clipboard.writeText(tableToCsv(table));
        toast.success('CSV copied', { description: `${table.rows.length} rows from ${title}` });
    } catch (err) {
        toast.error('Could not copy', { description: err instanceof Error ? err.message : 'Clipboard unavailable' });
    }
}

export interface SeriesStats {
    min: number;
    max: number;
    avg: number;
    count: number;
}

/** Min / max / mean of the finite values (null when there are none). */
export function seriesStats(values: ReadonlyArray<number | null | undefined>): SeriesStats | null {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;
    for (const v of values) {
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        count++;
    }
    if (count === 0) return null;
    return { min, max, avg: sum / count, count };
}

/** Linear-interpolated percentile (0-100) of the finite values. */
export function percentile(values: ReadonlyArray<number | null | undefined>, p: number): number | null {
    const sorted = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const pos = (Math.max(0, Math.min(100, p)) / 100) * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** p25-p75 of the finite values; null when fewer than `minCount` values. */
export function interquartileBand(values: ReadonlyArray<number | null | undefined>, minCount = 7): { low: number; high: number; n: number } | null {
    const finite = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (finite.length < minCount) return null;
    const low = percentile(finite, 25);
    const high = percentile(finite, 75);
    if (low === null || high === null) return null;
    return { low, high, n: finite.length };
}

/**
 * Trailing rolling mean over `window` consecutive entries (nulls are skipped,
 * a point needs at least one finite value in its window to get a value).
 */
export function rollingMean(values: ReadonlyArray<number | null>, window: number): Array<number | null> {
    const out: Array<number | null> = [];
    for (let i = 0; i < values.length; i++) {
        let sum = 0;
        let n = 0;
        for (let j = Math.max(0, i - window + 1); j <= i; j++) {
            const v = values[j];
            if (v === null || !Number.isFinite(v)) continue;
            sum += v;
            n++;
        }
        out.push(n > 0 ? sum / n : null);
    }
    return out;
}

/** Pearson correlation over the pairs where both values are finite. */
export function pearson(a: ReadonlyArray<number | null>, b: ReadonlyArray<number | null>): { r: number; n: number } | null {
    const xs: number[] = [];
    const ys: number[] = [];
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const x = a[i];
        const y = b[i];
        if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        xs.push(x);
        ys.push(y);
    }
    const n = xs.length;
    if (n < 3) return null;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx;
        const dy = ys[i] - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    if (sxx === 0 || syy === 0) return null;
    return { r: sxy / Math.sqrt(sxx * syy), n };
}

/** Compact number for labels/tables: integers as-is, otherwise up to 2 decimals. */
export function formatNumber(value: number | null | undefined, maxFractionDigits = 2): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
}

/** Index of the entry in ascending `xs` closest to `x` (-1 when empty). */
export function nearestIndex(xs: ReadonlyArray<number>, x: number): number {
    if (xs.length === 0) return -1;
    let lo = 0;
    let hi = xs.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] < x) lo = mid + 1;
        else hi = mid;
    }
    if (lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x)) return lo - 1;
    return lo;
}
