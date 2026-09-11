import { parseISO, addDays, format, startOfWeek, startOfMonth, startOfYear, differenceInDays } from 'date-fns';
import type { TimeSeriesPoint, NormalizedData } from '@/types/data';

export type AggregationInterval = 'week' | 'month' | 'year';
export type AggregationMethod = 'avg' | 'median' | 'sum' | 'last';

/** A raw row from the query API: a date plus arbitrary per-path columns. */
export interface RawSeriesRow {
    date?: string;
    [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object';

/** Date portion (`yyyy-MM-dd`) of a row's date, whether or not it carries a time. */
const dayOf = (row: RawSeriesRow): string => (row.date ?? '').split('T')[0];

function toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }
    return null;
}

function summarize(values: number[], method: AggregationMethod): number | null {
    if (!values.length) return null;

    if (method === 'sum') return values.reduce((acc, v) => acc + v, 0);
    if (method === 'avg') return values.reduce((acc, v) => acc + v, 0) / values.length;
    if (method === 'median') {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
            return (sorted[mid - 1] + sorted[mid]) / 2;
        }
        return sorted[mid];
    }

    // "last" should be handled by caller using timestamp ordering
    return values[values.length - 1];
}

export function pickAutoAggregationInterval(data: TimeSeriesPoint[]): AggregationInterval | null {
    if (!data.length) return null;
    const first = parseISO(data[0].date);
    const last = parseISO(data[data.length - 1].date);
    if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return null;

    const rangeDays = Math.max(0, differenceInDays(last, first));
    if (rangeDays >= 365 * 5) return 'year';
    if (rangeDays >= 365) return 'month';
    if (rangeDays >= 120) return 'week';
    return null;
}

export function aggregateDailySeries(
    data: TimeSeriesPoint[],
    keys: string[],
    interval: AggregationInterval,
    method: AggregationMethod = 'avg'
): TimeSeriesPoint[] {
    if (!data.length || keys.length === 0) return data;

    const buckets = new Map<string, {
        start: Date;
        values: Record<string, number[]>;
        last: Record<string, { time: number; val: number }>;
    }>();

    for (const point of data) {
        const date = parseISO(point.date);
        if (Number.isNaN(date.getTime())) continue;

        let bucketStart: Date;
        if (interval === 'week') bucketStart = startOfWeek(date, { weekStartsOn: 1 });
        else if (interval === 'month') bucketStart = startOfMonth(date);
        else bucketStart = startOfYear(date);

        for (const key of keys) {
            const rawValue = point[key] ?? (keys[0] === key ? point.value : undefined);
            const value = toNumber(rawValue);
            if (value === null) continue;

            const bucketKey = format(bucketStart, 'yyyy-MM-dd');
            let bucket = buckets.get(bucketKey);
            if (!bucket) {
                bucket = { start: bucketStart, values: {}, last: {} };
                buckets.set(bucketKey, bucket);
            }

            if (!bucket.values[key]) bucket.values[key] = [];
            bucket.values[key].push(value);

            const time = date.getTime();
            const existing = bucket.last[key];
            if (!existing || time >= existing.time) {
                bucket.last[key] = { time, val: value };
            }
        }
    }

    const sortedBuckets = Array.from(buckets.entries())
        .sort((a, b) => a[1].start.getTime() - b[1].start.getTime());

    return sortedBuckets.map(([bucketKey, bucket]) => {
        const aggregated: TimeSeriesPoint = {
            date: bucketKey,
            value: null
        };

        for (const key of keys) {
            const values = bucket.values[key] || [];
            let val: number | null;
            if (method === 'last') {
                val = bucket.last[key]?.val ?? null;
            } else {
                val = summarize(values, method);
            }

            aggregated[key] = val;
            if (key === keys[0]) {
                aggregated.value = val;
            }
        }

        return aggregated;
    });
}

export function normalizeTimeSeriesData(
    data: RawSeriesRow[],
    primaryKey: string,
    selectedDayIndex: number | null = null,
    requestedStart?: string,
    requestedEnd?: string
): NormalizedData {
    if ((!data || data.length === 0) && (!requestedStart || !requestedEnd)) {
        return { data: [], isIntraday: false };
    }

    // 1. Detect Data Type (Daily vs Intraday)
    let isIntraday = false;
    let isFlatIntraday = false;

    if (data && data.length > 0) {
        let firstVal: unknown = data[0][primaryKey];
        if (typeof firstVal === 'string') {
            try { firstVal = JSON.parse(firstVal); } catch { /* not JSON */ }
        }
        const isIntradayNested = Array.isArray(firstVal) || (isRecord(firstVal) && Array.isArray(firstVal.items));
        isFlatIntraday = !!data[0]?.date?.includes('T');
        isIntraday = isIntradayNested || isFlatIntraday;
    }

    // --- CASE 1: DAILY DATA ---
    if (!isIntraday) {
        // Sort data by date
        const sorted = [...(data || [])].sort((a, b) => new Date(a.date ?? '').getTime() - new Date(b.date ?? '').getTime());

        // Determine boundaries
        let startDateStr = sorted.length > 0 ? dayOf(sorted[0]) : (requestedStart || new Date().toISOString().split('T')[0]);
        let endDateStr = sorted.length > 0 ? dayOf(sorted[sorted.length - 1]) : (requestedEnd || new Date().toISOString().split('T')[0]);

        // Override with requested dates if provided
        if (requestedStart) startDateStr = requestedStart;
        if (requestedEnd) endDateStr = requestedEnd;

        const filledData: TimeSeriesPoint[] = [];
        let current = parseISO(startDateStr);
        let dataIndex = 0;

        while (true) {
            // Use format to get local date string (matches input)
            const dateStr = format(current, 'yyyy-MM-dd');
            if (dateStr > endDateStr) break;

            const item = sorted[dataIndex];
            const itemDateStr = item ? dayOf(item) : '';

            if (item && itemDateStr === dateStr) {
                // Rows pass through untouched (charts read `[primaryKey]`, not `value`).
                filledData.push(item as TimeSeriesPoint);
                dataIndex++;
                // Handle duplicates if any
                while (sorted[dataIndex] && dayOf(sorted[dataIndex]) === dateStr) {
                    dataIndex++;
                }
            } else {
                // Check if we passed the item (shouldn't happen if sorted)
                if (item && itemDateStr < dateStr) {
                    dataIndex++;
                    continue; // Retry with next item
                }

                // Missing day, insert null
                filledData.push({
                    date: dateStr,
                    value: null,
                    [primaryKey]: null
                });
            }

            // Increment day safely
            current = addDays(current, 1);
        }

        return { data: filledData, isIntraday: false };
    }

    // --- CASE 2: INTRADAY DATA ---
    let rawItems: unknown[] | undefined = [];
    let targetIndex = 0;
    let dayData: RawSeriesRow = {};

    if (isFlatIntraday) {
        // Flat data (e.g. heart_rate from useMultiOuraQuery)
        rawItems = data.map((d): Record<string, unknown> | null => {
            const val: unknown = d[primaryKey];
            if (val === undefined || val === null) return null;
            if (isRecord(val)) return { ...val, timestamp: d.date };
            return { value: val, timestamp: d.date };
        }).filter((item): item is Record<string, unknown> => item !== null);

        dayData = data[data.length - 1] || {};
    } else {
        // Nested data (e.g. readiness.contributors)
        targetIndex = selectedDayIndex ?? data.length - 1;
        if (targetIndex < 0) targetIndex = 0;
        if (targetIndex >= data.length) targetIndex = data.length - 1;

        dayData = data[targetIndex];
        let val: unknown = dayData[primaryKey];
        if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch { /* not JSON */ }
        }
        const nestedItems: unknown = isRecord(val) ? val.items : undefined;
        rawItems = Array.isArray(val) ? val : (Array.isArray(nestedItems) ? nestedItems : undefined);
    }

    if (!rawItems || !Array.isArray(rawItems)) {
        return { data: [], isIntraday: false };
    }

    // Process Items: Linear Grid Generation
    // We only support timestamped data now.
    const hasExplicitTimestamp = isRecord(rawItems[0]) && 'timestamp' in rawItems[0];
    const chartData: TimeSeriesPoint[] = [];

    if (hasExplicitTimestamp) {
        // 1. Parse all items and sort by time
        const itemsWithTime = rawItems.map((val: unknown) => {
            let time = 0;
            if (isRecord(val) && typeof val.timestamp === 'string' && val.timestamp) {
                time = parseISO(val.timestamp).getTime();
            }

            // Extract numeric value (samples carry it under one of a few field names)
            let numericVal: unknown = val;
            if (isRecord(val)) {
                numericVal = val.bpm ?? val.score ?? val.value ?? val.average ?? null;
            }

            // Passed through as-is (previously untyped); charts treat it as a number.
            return { time, val: numericVal as number | null, original: val };
        }).filter(i => i.time > 0).sort((a, b) => a.time - b.time);

        if (itemsWithTime.length > 0 || (requestedStart && requestedEnd)) {
            // Determine start/end times
            let startTimeMs = itemsWithTime.length > 0 ? itemsWithTime[0].time : 0;
            let endTimeMs = itemsWithTime.length > 0 ? itemsWithTime[itemsWithTime.length - 1].time : 0;

            if (requestedStart) {
                startTimeMs = parseISO(requestedStart).getTime();
            }
            if (requestedEnd) {
                const endDate = parseISO(requestedEnd);
                // End of day (23:59:59 +)
                endTimeMs = addDays(endDate, 1).getTime() - 1;
            }

            // If we still don't have valid times (e.g. no data and no requested range), bail
            if (startTimeMs === 0 || endTimeMs === 0) return { data: [], isIntraday: false };

            const totalDuration = endTimeMs - startTimeMs;


            // Adaptive Downsampling
            const MAX_POINTS = 2000;
            const minInterval = totalDuration / MAX_POINTS;

            // Define available intervals (ms)
            const INTERVALS = [
                5 * 60 * 1000,        // 5 mins
                15 * 60 * 1000,       // 15 mins
                30 * 60 * 1000,       // 30 mins
                60 * 60 * 1000,       // 1 hour
                4 * 60 * 60 * 1000,   // 4 hours
                12 * 60 * 60 * 1000,  // 12 hours
                24 * 60 * 60 * 1000   // 1 day
            ];

            // Find smallest interval that keeps points under MAX_POINTS
            let INTERVAL = INTERVALS[0];
            for (const interval of INTERVALS) {
                if (interval >= minInterval) {
                    INTERVAL = interval;
                    break;
                }
            }

            let itemIndex = 0;

            // 2. Iterate from start to end in 5-minute steps
            for (let t = startTimeMs; t <= endTimeMs; t += INTERVAL) {
                // Find if there is a data point close to this time (within +/- 2.5 mins)
                let foundItem = null;

                // Advance itemIndex to current time window
                while (itemIndex < itemsWithTime.length && itemsWithTime[itemIndex].time < t - INTERVAL / 2) {
                    itemIndex++;
                }

                // Check if current item matches
                if (itemIndex < itemsWithTime.length) {
                    const itemTime = itemsWithTime[itemIndex].time;
                    if (Math.abs(itemTime - t) <= INTERVAL / 2) {
                        foundItem = itemsWithTime[itemIndex];
                    }
                }

                if (foundItem) {
                    chartData.push({
                        date: new Date(t).toISOString(),
                        value: foundItem.val,
                        [primaryKey]: foundItem.val
                    });
                } else {
                    // Insert null for missing interval to maintain linearity
                    chartData.push({
                        date: new Date(t).toISOString(),
                        value: null,
                        [primaryKey]: null
                    });
                }
            }
        }
    } else {
        console.warn("normalizeTimeSeriesData: Intraday data missing timestamps", rawItems);
    }

    return {
        data: chartData,
        isIntraday: true,
        currentDay: typeof dayData.date === 'string' ? dayData.date : undefined,
        currentIndex: targetIndex,
        totalDays: data.length
    };
}
