import { format, parseISO, isValid } from 'date-fns';
import { ScoreGaugeCanvas } from './widgets/ScoreGaugeCanvas';
import { SmartTrendWidgetCanvas } from './widgets/SmartTrendWidgetCanvas';
import { MetricWidget } from './widgets/MetricWidget';
import { BarChartCanvas } from './widgets/BarChartCanvas';
import { RadarChartCanvas } from './widgets/RadarChartCanvas';
import { JSONWidget } from './widgets/JSONWidget';
import { HypnogramWidget } from './widgets/HypnogramWidget';
import type { HypnogramOverlay } from './widgets/HypnogramCanvas';
import { ContributorsWidget } from './widgets/ContributorsWidget';
import { WidgetSkeleton } from './widgets/WidgetSkeleton';
import { useAppStatus } from '@/contexts/AppStatusContext';
import { getBand } from '@/lib/bands';
import { formatDurationSeconds, formatMinutes, formatTemperatureDeviation } from '@/lib/format';
import type { WidgetInstance } from '@/types';

interface WidgetRegistryProps {
    widget: WidgetInstance;
    data?: unknown;
    date?: string;
    onUpdate?: (updates: Partial<WidgetInstance>) => void;
    /** Single-row widgets render a condensed layout. */
    compact?: boolean;
    /** True while the day payload for `date` is still loading. */
    isLoading?: boolean;
    /** Hypnogram HR/HRV overlay toggles; null hides the overlay (short widgets). */
    overlay?: HypnogramOverlay | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object';

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

/**
 * Duration fields in the day payload are in SECONDS
 * (`sleep_session.*_duration`, `time_in_bed`, `latency`, `awake_time`),
 * while the synthetic `sleep.total` adapter field from useOuraData is MINUTES.
 */
const durationUnit = (key: string): 'minutes' | 'seconds' | null => {
    if (key.endsWith('.total')) return 'minutes';
    if (/duration|time_in_bed|latency|awake_time/.test(key)) return 'seconds';
    return null;
};

/** Widget types whose content comes from the single-day payload (so they show a skeleton while it loads). */
const DAY_PAYLOAD_TYPES = new Set(['score', 'metric', 'hypnogram', 'contributors', 'radar']);

export const WidgetRegistry = ({ widget, data, date, onUpdate, compact = false, isLoading = false, overlay = null }: WidgetRegistryProps) => {
    const { units } = useAppStatus();

    // Helper to resolve dot notation
    const resolveData = (path: string): unknown => {
        if (!path || path === 'root') return data;
        let value: unknown = data;
        for (const key of path.split('.')) {
            if (!isRecord(value)) return undefined;
            value = value[key];
        }
        return value;
    };

    const resolvedDate = date || format(new Date(), 'yyyy-MM-dd');
    const dayLabel = (() => {
        const d = parseISO(resolvedDate);
        return isValid(d) ? format(d, 'EEE d MMM') : resolvedDate;
    })();

    if (isLoading && DAY_PAYLOAD_TYPES.has(widget.type)) {
        const kind = widget.type === 'score' ? 'gauge'
            : widget.type === 'metric' ? 'metric'
                : widget.type === 'contributors' ? 'list'
                    : 'chart';
        return <WidgetSkeleton kind={kind} compact={compact} />;
    }

    switch (widget.type) {
        case 'score': {
            const key = widget.config.dataKey || '';
            const raw = resolveData(key);
            // Distinguish "no row for this day" from "row exists but the ring did not compute a score".
            const parent = key.includes('.') ? resolveData(key.slice(0, key.lastIndexOf('.'))) : undefined;
            const emptyHint = parent === null || parent === undefined ? 'No data for this day' : 'No score (ring data)';
            return (
                <ScoreGaugeCanvas
                    score={isFiniteNumber(raw) ? raw : null}
                    title={widget.title}
                    color={widget.config.color}
                    emptyHint={emptyHint}
                />
            );
        }
        case 'trend':
            return (
                <SmartTrendWidgetCanvas
                    widget={widget}
                    date={resolvedDate}
                    onUpdate={onUpdate}
                />
            );
        case 'metric': {
            const key = widget.config.dataKey || '';
            const raw = resolveData(key);
            const metricLabel = key || 'Metric';
            const field = key.split('.').pop() ?? key;

            let displayValue: string | number = '—';
            let unit = widget.config.unit;
            let hint: string | undefined;

            if (isFiniteNumber(raw)) {
                const durationIn = durationUnit(key);
                if (field === 'temperature_deviation') {
                    displayValue = formatTemperatureDeviation(raw, units);
                    unit = '';
                } else if (durationIn) {
                    displayValue = durationIn === 'seconds' ? formatDurationSeconds(raw) : formatMinutes(raw);
                    unit = ''; // Unit is built-in
                } else if (field === 'score') {
                    displayValue = Math.round(raw);
                    hint = getBand(raw)?.label;
                } else {
                    displayValue = Number.isInteger(raw) ? raw : Number(raw.toFixed(2));
                }
            } else if (typeof raw === 'string' && raw !== '') {
                displayValue = raw;
            } else if (field === 'score' && raw === null) {
                hint = 'No score (ring data)';
            }

            return (
                <MetricWidget
                    value={displayValue}
                    label={compact ? undefined : metricLabel}
                    unit={unit}
                    color={widget.config.color}
                    compact={compact}
                    hint={hint}
                />
            );
        }
        case 'hypnogram': {
            const key = widget.config.dataKey || 'sleep_session.sleep_phase_5_min';
            const parentPath = key.includes('.') ? key.slice(0, key.lastIndexOf('.')) : key;
            const session = resolveData(parentPath);
            const phases = resolveData(key);
            return (
                <HypnogramWidget
                    session={isRecord(session) ? session : null}
                    phases={phases}
                    date={resolvedDate}
                    dayLabel={dayLabel}
                    compact={compact}
                    overlay={overlay}
                />
            );
        }
        case 'contributors': {
            const key = widget.config.dataKey || '';
            const raw = resolveData(key);
            const parent = key.includes('.') ? resolveData(key.slice(0, key.lastIndexOf('.'))) : undefined;
            return (
                <ContributorsWidget
                    contributors={raw}
                    title={widget.title}
                    emptyTitle={parent === null || parent === undefined ? 'No data for this day' : 'No score (ring data)'}
                />
            );
        }
        case 'bar': {
            const raw = resolveData(widget.config.dataKey || '');

            // If data is an object (raw contributors), format it for Bar Chart (Static)
            // BUT check if it's actually an intraday object (has 'items' array) - if so, let SmartTrendWidget handle it
            const isIntradayObject = isRecord(raw) && Array.isArray(raw.items);

            if (isRecord(raw) && !Array.isArray(raw) && !isIntradayObject) {
                const barData = Object.entries(raw).map(([key, value]) => ({
                    name: key.replace(/_/g, ' '),
                    value
                }));

                return (
                    <BarChartCanvas
                        data={barData}
                        dataKey="value"
                        categoryKey="name"
                        color={widget.config.color}
                        ariaLabel={`${widget.title}: bar chart`}
                    />
                );
            }

            return <SmartTrendWidgetCanvas widget={widget} date={resolvedDate} chartType="bar" />;
        }
        case 'table':
            return (
                <SmartTrendWidgetCanvas
                    widget={widget}
                    date={resolvedDate}
                    chartType="table"
                />
            );
        case 'radar': {
            const raw = resolveData(widget.config.dataKey || '');

            // If data is an object (raw contributors), format it for Radar Chart
            const radarData = isRecord(raw) && !Array.isArray(raw)
                ? Object.entries(raw).map(([key, value]) => ({
                    subject: key.replace(/_/g, ' '),
                    value,
                    fullMark: 100
                }))
                : (Array.isArray(raw) ? raw : []);

            return (
                <RadarChartCanvas
                    data={radarData}
                    dataKey="value"
                    axisKey="subject"
                    color={widget.config.color}
                />
            );
        }
        case 'json': {
            // If root is selected, use the date to fetch full dump
            // Otherwise use the resolved data
            const isRoot = !widget.config.dataKey || widget.config.dataKey === 'root';
            const jsonData = resolveData(widget.config.dataKey || 'root');

            return (
                <JSONWidget
                    data={jsonData}
                    date={isRoot ? date : undefined}
                    fetchFullDump={isRoot}
                />
            );
        }
        default:
            return (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                    Unknown Widget Type: {widget.type}
                </div>
            );
    }
};
