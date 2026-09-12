import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';

export type TrendsRange = '7d' | '30d' | '90d' | '1y' | 'all';
export type Aggregation = 'auto' | 'day' | 'week' | 'month';
export type ResolvedAggregation = Exclude<Aggregation, 'auto'>;

export interface TrendsRangeDef {
    id: TrendsRange;
    label: string;
    /** Days in the window; null = everything. */
    days: number | null;
    /** Short label for headers, e.g. "90 d". */
    short: string;
}

export const TREND_RANGES: readonly TrendsRangeDef[] = [
    { id: '7d', label: '7D', days: 7, short: '7 d' },
    { id: '30d', label: '30D', days: 30, short: '30 d' },
    { id: '90d', label: '90D', days: 90, short: '90 d' },
    { id: '1y', label: '1Y', days: 365, short: '1 y' },
    { id: 'all', label: 'All', days: null, short: 'all time' },
] as const;

export const rangeDef = (id: TrendsRange): TrendsRangeDef => TREND_RANGES.find(r => r.id === id) ?? TREND_RANGES[2];

export interface TrendsState {
    metric: string;
    /** Optional second metric drawn on the right axis. */
    secondary: string | null;
    range: TrendsRange;
    aggregation: Aggregation;
}

export const DEFAULT_TRENDS_STATE: TrendsState = {
    metric: 'sleep.score',
    secondary: null,
    range: '90d',
    aggregation: 'auto',
};

/** <= 90 days daily, 1Y weekly means, All monthly means (by actual span for "All"). */
export function autoAggregation(range: TrendsRange, spanDays: number): ResolvedAggregation {
    if (range === 'all') {
        if (spanDays <= 120) return 'day';
        if (spanDays <= 730) return 'week';
        return 'month';
    }
    if (range === '1y') return 'week';
    return 'day';
}

export const AGGREGATION_LABEL: Record<ResolvedAggregation, string> = {
    day: '7-day average',
    week: 'Weekly mean',
    month: 'Monthly mean',
};

const DAY_ZERO = parseISO('1970-01-01');

/** Days since 1970-01-01 in local calendar days (integer x for a linear axis). */
export const dayIndex = (date: string): number => differenceInCalendarDays(parseISO(date), DAY_ZERO);
export const dateFromIndex = (index: number): Date => addDays(DAY_ZERO, Math.round(index));
export const isoFromIndex = (index: number): string => format(dateFromIndex(index), 'yyyy-MM-dd');
