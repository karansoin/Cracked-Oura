import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Filler,
    Legend,
    type ChartOptions,
    type ScriptableContext
} from 'chart.js';
import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import { useIsDark } from '@/components/theme-provider';
import { useAppStatus } from '@/contexts/AppStatusContext';
import { useChartTable } from '@/contexts/ChartTableContext';
import { SERIES_PALETTE, withAlpha } from '@/lib/bands';
import { chartTheme } from '@/lib/chart-theme';
import { formatDay, humanizeKey, humanizePath } from '@/lib/format';
import { hoverLinePlugin, scoreBandsPlugin } from '@/lib/chart-plugins';
import { formatMetricValue, formatMetricWithUnit, kindForKey } from '@/lib/metrics';
import { formatNumber, seriesStats, type ChartTable } from '@/lib/series-table';
import { SeriesTable } from './SeriesTable';

// Register ChartJS components
ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Filler,
    Legend
);

type Row = Record<string, unknown>;

interface TrendChartCanvasProps {
    data: Row[];
    dataKey?: string;
    dataKeys?: string[];
    title: string;
    color: string;
    showPoints?: boolean;
    ariaLabel?: string;
}

const toNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** "2024-04-29" or "2024-04-29 07:35" for intraday timestamps. */
const formatRowDate = (label: string): string => {
    if (!label.includes('T')) return label;
    const d = new Date(label);
    if (Number.isNaN(d.getTime())) return label;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Tooltip title: "Mon 29 Apr 2024" or "Mon 29 Apr 2024, 07:35". */
const formatPointLabel = (label: string): string => {
    if (!label) return '';
    if (label.includes('T')) {
        const d = new Date(label);
        if (Number.isNaN(d.getTime())) return label;
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${formatDay(label)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return formatDay(label);
};

export function TrendChartCanvas({ data, dataKey, dataKeys, title, color, showPoints = false, ariaLabel }: TrendChartCanvasProps) {
    const isDark = useIsDark();
    const theme = chartTheme(isDark);
    const { units } = useAppStatus();

    // Determine keys to plot
    const keys = useMemo(
        () => ((dataKeys && dataKeys.length > 0) ? dataKeys : (dataKey ? [dataKey] : [])),
        [dataKeys, dataKey],
    );

    // Score charts (every key is a `*.score`) get band shading behind the lines.
    const isScoreChart = keys.length > 0 && keys.every(k => k.endsWith('.score'));

    // Okabe-Ito palette for multi-series; the widget accent leads.
    const colors = [color, ...SERIES_PALETTE.filter(c => c.toLowerCase() !== color.toLowerCase())];

    // Series labels: the humanised last path segment, unless that would be ambiguous
    // (e.g. sleep.score / readiness.score / activity.score -> "Sleep score", ...).
    const lastSegments = keys.map(k => k.split('.').pop() ?? k);
    const ambiguous = new Set(lastSegments).size !== lastSegments.length;
    const seriesLabel = (key: string) => (ambiguous ? humanizePath(key) : humanizeKey(key)) || title;
    const kinds = keys.map(kindForKey);

    // Plotted values per series (null-safe), for the table, the summary and the empty check.
    const series = useMemo(
        () => keys.map(key => data.map(d => toNumber(d[key] !== undefined ? d[key] : d.value))),
        [keys, data],
    );
    const hasValues = series.some(values => values.some(v => v !== null));

    const table = useMemo<ChartTable | null>(() => {
        if (keys.length === 0 || data.length === 0) return null;
        return {
            columns: ['Date', ...keys.map(seriesLabel)],
            rows: data.map((row, i) => [
                formatRowDate(String(row.date ?? '')),
                ...series.map((values, s) => (values[i] === null ? '' : formatMetricValue(values[i], kinds[s], units))),
            ]),
        };
        // seriesLabel / kinds are pure functions of `keys`
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keys, data, series, units]);
    const viewAsTable = useChartTable(table);

    const summary = ariaLabel ?? `${title}: line chart over ${data.length} points. ` + keys.map((key, i) => {
        const stats = seriesStats(series[i]);
        if (!stats) return `${seriesLabel(key)}: no values`;
        return `${seriesLabel(key)} min ${formatNumber(stats.min, 1)}, max ${formatNumber(stats.max, 1)}, average ${formatNumber(stats.avg, 1)}`;
    }).join('; ') + '.';

    if (viewAsTable && table) {
        return <SeriesTable table={table} caption={summary} />;
    }

    if (!hasValues) {
        return (
            <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed p-4 text-center" role="img" aria-label={`${title}: no values in this range`}>
                <span className="text-sm font-medium text-foreground">No values in this range</span>
                <span className="mt-1 text-xs text-muted-foreground">Days synced from the ring have no scores yet</span>
            </div>
        );
    }

    // Prepare data for Chart.js
    const chartData = {
        labels: data.map(d => String(d.date ?? '')),
        datasets: keys.map((key, index) => {
            const seriesColor = colors[index % colors.length];
            const label = seriesLabel(key);

            return {
                label: label,
                data: series[index],
                borderColor: seriesColor,
                backgroundColor: (context: ScriptableContext<'line'>) => {
                    const ctx = context.chart.ctx;
                    const gradient = ctx.createLinearGradient(0, 0, 0, context.chart.height);
                    gradient.addColorStop(0, withAlpha(seriesColor, isScoreChart ? 0.15 : 0.5));
                    gradient.addColorStop(1, withAlpha(seriesColor, 0));
                    return gradient;
                },
                fill: !isScoreChart || keys.length === 1,
                tension: 0, // No smoothing (linear)
                pointRadius: showPoints ? 3 : 0, // Show points if enabled
                pointHoverRadius: 4,
                borderWidth: 2,
                spanGaps: true,
            };
        }),
    };

    const options: ChartOptions<'line'> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
            duration: 0
        },
        interaction: {
            mode: 'index',
            intersect: false,
        },
        plugins: {
            scoreBands: { enabled: isScoreChart, isDark },
            hoverLine: { color: theme.hoverLine },
            legend: { ...theme.legend, display: keys.length > 1 },
            tooltip: {
                enabled: true,
                ...theme.tooltip,
                displayColors: keys.length > 1,
                callbacks: {
                    title: (tooltipItems) => formatPointLabel(tooltipItems[0]?.label ?? ''),
                    label: (context) => {
                        const label = context.dataset.label || '';
                        const y = context.parsed.y;
                        const value = y === null || y === undefined ? '—' : formatMetricWithUnit(y, kinds[context.datasetIndex] ?? 'number', units);
                        return label ? `${label}: ${value}` : value;
                    }
                }
            }
        },
        scales: {
            x: {
                display: true, // Show X axis
                grid: {
                    display: false
                },
                ticks: {
                    color: theme.tick,
                    font: theme.tickFont,
                    maxRotation: 0,
                    autoSkip: true,
                    maxTicksLimit: 12, // More frequent labels
                    callback: function (val) {
                        const label = this.getLabelForValue(val as number);
                        if (!label) return '';

                        // Intraday: within a day and a half, the date prefix is noise
                        if (label.includes('T')) {
                            const date = new Date(label);
                            const all = (this.chart.data.labels ?? []) as string[];
                            const spanMs = all.length > 1 ? Date.parse(String(all[all.length - 1])) - Date.parse(String(all[0])) : 0;
                            if (spanMs > 0 && spanMs <= 36 * 3600 * 1000) {
                                return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                            }
                            return date.toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: false
                            });
                        }

                        // Daily
                        const parts = label.split('-');
                        if (parts.length === 3) {
                            const [y, m, d] = parts.map(Number);
                            const date = new Date(y, m - 1, d);
                            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                        }

                        return label;
                    }
                },
                border: {
                    display: false
                }
            },
            y: {
                display: true,
                position: 'left', // Move to left
                min: isScoreChart ? 0 : undefined,
                max: isScoreChart ? 100 : undefined,
                grid: {
                    color: theme.grid,
                    drawTicks: false,
                },
                border: {
                    display: false
                },
                ticks: {
                    color: theme.tick,
                    font: theme.tickFont,
                    maxTicksLimit: 6,
                }
            }
        }
    };

    return (
        <div className="w-full h-full min-h-[100px]" role="img" aria-label={summary}>
            <Line data={chartData} options={options} plugins={[scoreBandsPlugin, hoverLinePlugin]} />
        </div>
    );
}
