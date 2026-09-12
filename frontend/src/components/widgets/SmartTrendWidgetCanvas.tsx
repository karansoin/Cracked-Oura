import { useState, useMemo } from 'react';
import { useMultiOuraQuery } from '@/hooks/useMultiOuraQuery';
import { TrendChartCanvas } from './TrendChartCanvas';
import { BarChartCanvas } from './BarChartCanvas';
import { TableWidget } from './TableWidget';
import { WidgetSkeleton } from './WidgetSkeleton';
import { useIsDark } from '@/components/theme-provider';
import { BANDS } from '@/lib/bands';
import type { WidgetInstance } from '@/types';
import { subDays, subWeeks, subMonths, subYears, subHours, subMinutes, format, parseISO } from 'date-fns';

import { isIntradayKey } from "@/lib/utils";
import { aggregateDailySeries, normalizeTimeSeriesData, pickAutoAggregationInterval } from '@/lib/data-processing';

interface SmartTrendWidgetCanvasProps {
    widget: WidgetInstance;
    date: string; // End date

    chartType?: 'area' | 'bar' | 'table';
    onUpdate?: (updates: Partial<WidgetInstance>) => void;
}

export function SmartTrendWidgetCanvas({ widget, date, chartType = 'area' }: SmartTrendWidgetCanvasProps) {
    const isDark = useIsDark();
    // Temperature deviation bars diverge around 0: beyond +/-0.5 degC uses the "Pay attention" colour.
    const isTemperatureDeviation = (widget.config.dataKey ?? '').endsWith('temperature_deviation');
    const baseColor = widget.config.color || (isDark ? BANDS[1].dark : BANDS[1].light);
    const attentionColor = isDark ? BANDS[3].dark : BANDS[3].light;
    // Calculate date range based on config
    const { startDate, endDate } = useMemo(() => {
        const primaryKey = widget.config.dataKey || '';
        if (primaryKey && isIntradayKey(primaryKey)) {
            // Force date-only format to avoid start_datetime/end_datetime queries which cause freezes
            const dateOnly = date.split('T')[0];
            return { startDate: dateOnly, endDate: dateOnly };
        }

        // For Table view, strictly fetch only the selected date to match the UI
        if (chartType === 'table') {
            const dateOnly = date.split('T')[0];
            return { startDate: dateOnly, endDate: dateOnly };
        }

        const rangeType = widget.config.dateRange?.type || 'default';
        // NOTE: `yyyy-MM-dd` strings must go through parseISO (local midnight), never
        // `new Date(str)` (UTC midnight) - otherwise formatting back to a local date
        // shifts the range by one day for users west of UTC.
        const today = format(new Date(), 'yyyy-MM-dd');
        const todayDate = parseISO(today);
        const selectedDate = parseISO(date);

        switch (rangeType) {
            case 'custom':
                return {
                    startDate: widget.config.dateRange?.startDate || format(subDays(selectedDate, 30), 'yyyy-MM-dd'),
                    endDate: widget.config.dateRange?.endDate || date
                };
            case 'relative': {
                const { value, unit, anchor } = widget.config.dateRange || {};

                // Anchor on the selected day, or on today (start of day).
                const end = anchor === 'selected_date' ? selectedDate : todayDate;

                if (value && unit) {
                    let start = end;
                    switch (unit) {
                        case 'minutes': start = subMinutes(end, value); break;
                        case 'hours': start = subHours(end, value); break;
                        case 'days': start = subDays(end, value); break;
                        case 'weeks': start = subWeeks(end, value); break;
                        case 'months': start = subMonths(end, value); break;
                        case 'years': start = subYears(end, value); break;
                    }

                    // Queries are date-granular, so hours/minutes still emit date-only strings.
                    return {
                        startDate: format(start, 'yyyy-MM-dd'),
                        endDate: format(end, 'yyyy-MM-dd')
                    };
                }

                return {
                    startDate: format(subDays(end, 7), 'yyyy-MM-dd'),
                    endDate: format(end, 'yyyy-MM-dd')
                };
            }
            case 'to_today':
                return {
                    startDate: widget.config.dateRange?.startDate || format(subDays(todayDate, 30), 'yyyy-MM-dd'),
                    endDate: today
                };
            case 'all':
                return { startDate: undefined, endDate: undefined };
            case 'last_90':
                return { startDate: format(subDays(todayDate, 90), 'yyyy-MM-dd'), endDate: today };
            case 'last_30':
                return { startDate: format(subDays(todayDate, 30), 'yyyy-MM-dd'), endDate: today };
            default:
                // Default to last 7 days relative to today for new widgets
                return { startDate: format(subDays(todayDate, 7), 'yyyy-MM-dd'), endDate: today };
        }
    }, [widget.config.dateRange, date, widget.config.dataKey, chartType]);

    // Determine keys to fetch
    const keysToFetch = useMemo(() => {
        if (widget.config.dataKeys && widget.config.dataKeys.length > 0) {
            return widget.config.dataKeys;
        }
        return widget.config.dataKey ? [widget.config.dataKey] : [];
    }, [widget.config.dataKeys, widget.config.dataKey]);

    const { data, loading, error } = useMultiOuraQuery(keysToFetch, startDate, endDate);

    // Intraday Logic (Simplified for Canvas Test)
    const [selectedDayIndex] = useState<number | null>(null);

    const processedData = useMemo(() => {
        if (keysToFetch.length === 0) return { data: [], isIntraday: false };

        const primaryKey = keysToFetch[0];
        // Heuristic: If we are plotting sleep (hypnogram or detailed sleep), we want the chart
        // to only show the "in-bed" period, not the full 24h day with empty space.
        // Passing undefined for start/end lets normalizeTimeSeriesData use the data's own timestamps.
        const isSleepDetailed = (primaryKey.includes('sleep') || primaryKey.includes('hypnogram')) && isIntradayKey(primaryKey);

        return normalizeTimeSeriesData(
            data,
            primaryKey,
            selectedDayIndex,
            isSleepDetailed ? undefined : startDate,
            isSleepDetailed ? undefined : endDate
        );
    }, [data, selectedDayIndex, keysToFetch, startDate, endDate]);

    const aggregatedData = useMemo(() => {
        if (!processedData.data.length) return processedData;
        if (processedData.isIntraday) return processedData;

        const rangeType = widget.config.dateRange?.type;
        if (rangeType !== 'all') return processedData;

        const interval = pickAutoAggregationInterval(processedData.data);
        if (!interval) return processedData;

        return {
            ...processedData,
            data: aggregateDailySeries(processedData.data, keysToFetch, interval, 'avg')
        };
    }, [processedData, keysToFetch, widget.config.dateRange?.type]);

    if (keysToFetch.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed p-4 text-center">
                <span className="text-sm font-medium text-foreground">No data selected</span>
                <span className="mt-1 text-xs text-muted-foreground">Edit the widget to choose a field</span>
            </div>
        );
    }

    if (loading) return <WidgetSkeleton kind={chartType === 'table' ? 'table' : 'chart'} />;
    if (error) {
        return (
            <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed border-destructive/40 p-4 text-center" role="alert">
                <span className="text-sm font-medium text-foreground">Couldn't load this data</span>
                <span className="mt-1 max-w-[240px] truncate text-xs text-muted-foreground" title={error}>{error}</span>
            </div>
        );
    }

    if (aggregatedData.data.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed p-4 text-center">
                <span className="text-sm font-medium text-foreground">No data for this period</span>
                <span className="mt-1 text-xs text-muted-foreground">Try a different date range</span>
            </div>
        );
    }



    return (
        <div className="h-full flex flex-col relative group">
            {chartType === 'bar' ? (
                <BarChartCanvas
                    data={aggregatedData.data}
                    dataKey={keysToFetch[0]}
                    categoryKey="date"
                    color={widget.config.color || '#0072B2'}
                    ariaLabel={`${widget.title}: bar chart of ${keysToFetch[0]} over ${aggregatedData.data.length} points`}
                    barColor={isTemperatureDeviation ? (v) => (v !== null && Math.abs(v) > 0.5 ? attentionColor : baseColor) : undefined}
                />
            ) : chartType === 'table' ? (
                <TableWidget
                    data={aggregatedData.data}
                    dataKeys={keysToFetch}
                    selectedDate={date}
                />
            ) : (
                <TrendChartCanvas
                    data={aggregatedData.data}
                    dataKey={keysToFetch[0]}
                    dataKeys={keysToFetch}
                    title={widget.title}
                    color={widget.config.color || '#0072B2'}
                    showPoints={widget.config.showPoints}
                />
            )}
        </div>
    );
}
