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
import { CHART_NEUTRAL, SERIES_PALETTE, withAlpha } from '@/lib/bands';
import { hoverLinePlugin, scoreBandsPlugin } from '@/lib/chart-plugins';
import { formatMetricValue, kindForKey } from '@/lib/metrics';
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

export function TrendChartCanvas({ data, dataKey, dataKeys, title, color, showPoints = false, ariaLabel }: TrendChartCanvasProps) {
    const isDark = useIsDark();
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

    // Series labels: the last path segment, unless that would be ambiguous
    // (e.g. sleep.score / readiness.score / activity.score -> "sleep score", ...).
    const lastSegments = keys.map(k => k.split('.').pop() ?? k);
    const ambiguous = new Set(lastSegments).size !== lastSegments.length;
    const seriesLabel = (key: string) => (ambiguous ? key.replace(/\./g, ' ') : (key.split('.').pop() ?? key)).replace(/_/g, ' ') || title;

    // Plotted values per series (null-safe), for the table, the summary and the empty check.
    const series = useMemo(
        () => keys.map(key => data.map(d => toNumber(d[key] !== undefined ? d[key] : d.value))),
        [keys, data],
    );
    const hasValues = series.some(values => values.some(v => v !== null));

    const table = useMemo<ChartTable | null>(() => {
        if (keys.length === 0 || data.length === 0) return null;
        const kinds = keys.map(kindForKey);
        return {
            columns: ['Date', ...keys.map(seriesLabel)],
            rows: data.map((row, i) => [
                formatRowDate(String(row.date ?? '')),
                ...series.map((values, s) => (values[i] === null ? '' : formatMetricValue(values[i], kinds[s], units))),
            ]),
        };
        // seriesLabel is a pure function of `keys`
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
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4 text-center" role="img" aria-label={`${title}: no values in this range`}>
                <span className="text-sm font-medium">No values in this range</span>
                <span className="text-xs opacity-70 mt-1">Days synced from the ring have no scores yet</span>
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
            hoverLine: { color: isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)' },
            legend: {
                display: keys.length > 1,
                position: 'top',
                align: 'end',
                labels: {
                    boxWidth: 8,
                    boxHeight: 8,
                    usePointStyle: true,
                    color: isDark ? CHART_NEUTRAL.tickDark : CHART_NEUTRAL.tickLight,
                    font: { size: 10 },
                },
            },
            tooltip: {
                enabled: true,
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                titleColor: isDark ? '#f3f4f6' : '#111827',
                bodyColor: isDark ? '#f3f4f6' : '#111827',
                borderColor: isDark ? '#374151' : '#e5e7eb',
                borderWidth: 1,
                padding: 10,
                displayColors: true,
                callbacks: {
                    title: (tooltipItems) => {
                        const label = tooltipItems[0].label;
                        if (!label) return '';

                        // Intraday
                        if (label.includes('T')) {
                            const date = new Date(label);
                            const day = date.getDate().toString().padStart(2, '0');
                            const month = (date.getMonth() + 1).toString().padStart(2, '0');
                            const year = date.getFullYear();
                            const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                            return `${day}.${month}.${year} ${time}`;
                        }

                        // Daily
                        const [y, m, d] = label.split('-').map(Number);
                        const day = d.toString().padStart(2, '0');
                        const month = m.toString().padStart(2, '0');
                        return `${day}.${month}.${y}`;
                    },
                    label: (context) => {
                        let label = context.dataset.label || '';
                        if (label) {
                            label += ': ';
                        }
                        if (context.parsed.y !== null) {
                            label += context.parsed.y;
                        }
                        return label;
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
                    color: isDark ? CHART_NEUTRAL.tickDark : CHART_NEUTRAL.tickLight,
                    font: {
                        size: 10
                    },
                    maxRotation: 0,
                    autoSkip: true,
                    maxTicksLimit: 12, // More frequent labels
                    callback: function (val) {
                        const label = this.getLabelForValue(val as number);
                        if (!label) return '';

                        // Intraday
                        if (label.includes('T')) {
                            const date = new Date(label);
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
                    color: isDark ? withAlpha('#ffffff', 0.08) : withAlpha('#000000', 0.08),
                    drawTicks: false,
                },
                border: {
                    display: false
                },
                ticks: {
                    color: isDark ? CHART_NEUTRAL.tickDark : CHART_NEUTRAL.tickLight,
                    font: {
                        size: 10
                    },
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
