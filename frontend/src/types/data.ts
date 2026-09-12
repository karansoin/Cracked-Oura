export interface TimeSeriesPoint {
    date: string; // ISO string
    value: number | null;
    original?: unknown; // Keep original data for tooltips
    [key: string]: unknown; // Allow dynamic keys for multi-series
}

export interface NormalizedData {
    data: TimeSeriesPoint[];
    isIntraday: boolean;
    currentDay?: string;
    currentIndex?: number;
    totalDays?: number;
}
