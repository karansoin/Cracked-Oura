import { format } from 'date-fns';
import { ScoreGaugeCanvas } from './widgets/ScoreGaugeCanvas';
import { SmartTrendWidgetCanvas } from './widgets/SmartTrendWidgetCanvas';
import { MetricWidget } from './widgets/MetricWidget';
import { BarChartCanvas } from './widgets/BarChartCanvas';
import { RadarChartCanvas } from './widgets/RadarChartCanvas';
import { JSONWidget } from './widgets/JSONWidget';
import type { WidgetInstance } from '@/types';

interface WidgetRegistryProps {
    widget: WidgetInstance;
    data?: unknown;
    date?: string;
    onUpdate?: (updates: Partial<WidgetInstance>) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object';

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

/** Format a whole number of minutes as `Xh Ym`, omitting the hours when zero. */
const formatMinutes = (totalMinutes: number): string => {
    const hours = Math.floor(totalMinutes / 60);
    const mins = Math.round(totalMinutes % 60);
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
};

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

export const WidgetRegistry = ({ widget, data, date, onUpdate }: WidgetRegistryProps) => {
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

    switch (widget.type) {
        case 'score': {
            const raw = resolveData(widget.config.dataKey || '');
            const scoreLabel = widget.config.dataKey || 'Score';
            const hasScore = isFiniteNumber(raw);
            return (
                <ScoreGaugeCanvas
                    score={hasScore ? raw : 0}
                    title={hasScore ? scoreLabel : `${scoreLabel} — No data`}
                    color={widget.config.color}
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

            let displayValue: string | number = '—';
            let unit = widget.config.unit;

            if (isFiniteNumber(raw)) {
                const durationIn = durationUnit(key);
                if (durationIn) {
                    const minutes = durationIn === 'seconds' ? Math.round(raw / 60) : raw;
                    displayValue = formatMinutes(minutes);
                    unit = ''; // Unit is built-in
                } else {
                    displayValue = raw;
                }
            } else if (typeof raw === 'string' && raw !== '') {
                displayValue = raw;
            }

            return (
                <MetricWidget
                    value={displayValue}
                    label={metricLabel}
                    unit={unit}
                    color={widget.config.color}
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
