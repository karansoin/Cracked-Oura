import { useState, useEffect } from 'react';

import { api } from '@/lib/api';

export interface DailyScore {
    score: number;
    contributors: Record<string, number | null>;
    activity_balance?: number;
    body_temperature?: number;
    hrv_balance?: number;
    previous_day_activity?: number;
    previous_night?: number;
    recovery_index?: number;
    resting_heart_rate?: number;
    sleep_balance?: number;
    steps?: number;
    total_sleep_duration?: number;
}

export interface SleepSession {
    sleep_phase_5_min: string;
    sleep_phase_30_sec: string;
    deep_sleep_duration: number;
    rem_sleep_duration: number;
    light_sleep_duration: number;
    total_sleep_duration?: number;
    awake_time: number;
    start_time: string;
    hr_data: unknown;
    hrv_data: unknown;
    type?: string;
    [key: string]: unknown;
}

export interface ResilienceData {
    day: string;
    level: string;
    contributors: Record<string, number | null>;
    sleep_recovery?: number;
    daytime_recovery?: number;
    stress?: number;
}

type Section = Record<string, unknown>;

/** Shape of `GET /api/days/{date}` (loosely typed - columns vary by export). */
export interface DailyPayload {
    sleep?: Section & {
        total_sleep_duration?: number;
        average_spo2?: number;
        breathing_disturbance_index?: number;
    };
    activity?: Section & { steps?: number };
    readiness?: Section;
    resilience?: ResilienceData;
    sleep_sessions?: SleepSession[];
    [key: string]: unknown;
}

const RETRY_DELAY_MS = 1000;
const MAX_ATTEMPTS = 10;

export const useOuraData = (date: string) => {
    const [data, setData] = useState<DailyPayload | null>(null);
    // The date the current `data` belongs to; differs from `date` while a fetch is in flight.
    const [loadedDate, setLoadedDate] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!date) return;

        // Fetch full daily dump with retry (the backend may still be starting up)
        let attempts = 0;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const fetchData = () => {
            api.getDailyData(date)
                .then((payload) => {
                    if (cancelled) return;
                    setData(payload as DailyPayload);
                    setLoadedDate(date);
                    setError(null);
                })
                .catch((err: unknown) => {
                    if (cancelled) return;
                    attempts++;
                    if (attempts < MAX_ATTEMPTS) {
                        timer = setTimeout(fetchData, RETRY_DELAY_MS);
                    } else {
                        setError(err instanceof Error ? err.message : 'Failed to load day');
                        setLoadedDate(date);
                    }
                });
        };
        fetchData();

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [date]);

    const sleepSessions = data?.sleep_sessions ?? [];

    return {
        /** True while the payload for `date` has not arrived yet. */
        isLoading: loadedDate !== date,
        loadError: error,
        // Pass through the raw data structure but add formatted helpers where needed
        ...(data ?? {}),
        // Adapter: Find primary sleep session (longest one) for widgets expecting singular 'sleep_session'
        sleep_session: sleepSessions.reduce<SleepSession | null>((longest, current) => {
            if (!longest) return current;
            return (current.total_sleep_duration || 0) > (longest.total_sleep_duration || 0) ? current : longest;
        }, null),
        sleepSessions,
        readiness: data?.readiness ? {
            ...data.readiness,
        } : null,
        activity: data?.activity ? {
            ...data.activity,
            steps: data.activity.steps
        } : null,
        sleep: data?.sleep ? {
            ...data.sleep,
            total: data.sleep.total_sleep_duration ? Math.round(data.sleep.total_sleep_duration / 60) : 0, // in minutes
            average_spo2: data.sleep.average_spo2,
            breathing_disturbance_index: data.sleep.breathing_disturbance_index
        } : null,
        resilience: data?.resilience ? [data.resilience] : [], // Adapter for array expectation if needed
    };
};

export type OuraDayData = ReturnType<typeof useOuraData>;
