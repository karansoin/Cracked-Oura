import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { interquartileBand } from '@/lib/series-table';
import type { TypicalRange } from '@/components/widgets/HypnogramCanvas';

const NIGHTS = 90;
const MIN_NIGHTS = 7;

interface NightlyValue {
    date: string;
    value: number | null;
}

interface SleepBaseline {
    hr: TypicalRange | null;
    hrv: TypicalRange | null;
}

/** Nightly series keyed by date (`yyyy-MM-dd`), later rows winning (long_sleep over naps). */
function toNightly(rows: Array<{ date: string; value: unknown }>): NightlyValue[] {
    const byDate = new Map<string, number | null>();
    for (const row of rows) {
        const date = row.date.split('T')[0];
        const value = typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : null;
        byDate.set(date, value);
    }
    return [...byDate.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

/** The `NIGHTS` nights up to and including `endDate`. */
function trailing(series: NightlyValue[], endDate: string): Array<number | null> {
    return series.filter(n => n.date <= endDate).slice(-NIGHTS).map(n => n.value);
}

/**
 * Personal "typical range" (p25-p75) of nightly lowest heart rate and average HRV
 * over the 90 nights up to the selected day. The full nightly series is fetched
 * once per hook instance; the window is sliced client-side as the day changes.
 */
export function useSleepBaseline(endDate: string): SleepBaseline {
    const [series, setSeries] = useState<{ hr: NightlyValue[]; hrv: NightlyValue[] } | null>(null);

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            api.getQuery('sleep_session.lowest_heart_rate'),
            api.getQuery('sleep_session.average_hrv'),
        ]).then(([hr, hrv]) => {
            if (!cancelled) setSeries({ hr: toNightly(hr), hrv: toNightly(hrv) });
        }).catch(() => {
            if (!cancelled) setSeries({ hr: [], hrv: [] });
        });
        return () => { cancelled = true; };
    }, []);

    return useMemo(() => {
        if (!series) return { hr: null, hrv: null };
        return {
            hr: interquartileBand(trailing(series.hr, endDate), MIN_NIGHTS),
            hrv: interquartileBand(trailing(series.hrv, endDate), MIN_NIGHTS),
        };
    }, [series, endDate]);
}
