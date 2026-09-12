import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarElement,
    Title,
    Tooltip,
    Legend,
    type ChartOptions
} from 'chart.js';
import { useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import { useIsDark } from '@/components/theme-provider';
import { useAppStatus } from '@/contexts/AppStatusContext';
import { useChartTable } from '@/contexts/ChartTableContext';
import { formatMetricValue, formatMetricWithUnit, kindForKey } from '@/lib/metrics';
import { chartTheme } from '@/lib/chart-theme';
import { formatDay, humanizeKey } from '@/lib/format';
import { formatNumber, seriesStats, type ChartTable } from '@/lib/series-table';
import { SeriesTable } from './SeriesTable';

// Register ChartJS components
ChartJS.register(
    CategoryScale,
    LinearScale,
    BarElement,
    Title,
    Tooltip,
    Legend
);

interface BarChartCanvasProps {
    data: Array<Record<string, unknown>>;
    dataKey: string;
    categoryKey?: string;
    color?: string;
    ariaLabel?: string;
    /** Per-bar colour override (e.g. diverging colouring for deviations). */
    barColor?: (value: number | null) => string;
}

const toNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function BarChartCanvas({ data, dataKey, categoryKey = "name", color = "#0072B2", ariaLabel, barColor }: BarChartCanvasProps) {
    const isDark = useIsDark();
    const theme = chartTheme(isDark);
    const { units } = useAppStatus();

    const values = useMemo(() => data.map(d => toNumber(d[dataKey])), [data, dataKey]);
    const seriesName = humanizeKey(dataKey);
    const kind = kindForKey(dataKey);
    const stats = seriesStats(values);

    const table = useMemo<ChartTable | null>(() => {
        if (data.length === 0) return null;
        return {
            columns: [categoryKey === 'date' ? 'Date' : 'Category', seriesName],
            rows: data.map((d, i) => [String(d[categoryKey] ?? ''), values[i] === null ? '' : formatMetricValue(values[i], kind, units)]),
        };
    }, [data, kind, categoryKey, seriesName, values, units]);
    const viewAsTable = useChartTable(table);

    const summary = ariaLabel ?? (stats
        ? `Bar chart of ${seriesName} over ${data.length} points: min ${formatNumber(stats.min, 2)}, max ${formatNumber(stats.max, 2)}, average ${formatNumber(stats.avg, 2)}.`
        : `Bar chart of ${seriesName}: no values.`);

    if (viewAsTable && table) {
        return <SeriesTable table={table} caption={summary} />;
    }

    if (!stats) {
        return (
            <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed p-4 text-center" role="img" aria-label={summary}>
                <span className="text-sm font-medium text-foreground">No values in this range</span>
                <span className="mt-1 text-xs text-muted-foreground">Days synced from the ring have no scores yet</span>
            </div>
        );
    }

    const chartData = {
        labels: data.map(d => String(d[categoryKey] ?? '')),
        datasets: [
            {
                label: seriesName,
                data: values,
                backgroundColor: barColor ? values.map(barColor) : color,
                borderRadius: 4, // Rounded corners like Recharts radius={[4, 4, 0, 0]}
                borderSkipped: 'bottom' as const,
            },
        ],
    };

    const options: ChartOptions<'bar'> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
            duration: 0 // Instant resize
        },
        plugins: {
            legend: {
                display: false,
            },
            tooltip: {
                enabled: true,
                ...theme.tooltip,
                displayColors: false,
                callbacks: {
                    title: (items) => {
                        const label = items[0]?.label ?? '';
                        return /^\d{4}-\d{2}-\d{2}$/.test(label) ? formatDay(label) : humanizeKey(label);
                    },
                    label: (context) => {
                        const y = context.parsed.y;
                        return `${seriesName}: ${y === null || y === undefined ? '—' : formatMetricWithUnit(y, kind, units)}`;
                    },
                },
            }
        },
        scales: {
            x: {
                grid: {
                    display: false,
                },
                border: {
                    display: false
                },
                ticks: {
                    color: theme.tick,
                    font: theme.tickFont,
                    maxRotation: 0,
                    autoSkip: true,
                    maxTicksLimit: 12,
                    callback: function (val) {
                        const label = this.getLabelForValue(val as number);
                        // Check if it's a date YYYY-MM-DD
                        if (typeof label === 'string' && label.match(/^\d{4}-\d{2}-\d{2}$/)) {
                            const parts = label.split('-');
                            const [y, m, d] = parts.map(Number);
                            const date = new Date(y, m - 1, d);
                            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                        }
                        return typeof label === 'string' ? humanizeKey(label) : label;
                    }
                },
            },
            y: {
                position: 'left',
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
            <Bar data={chartData} options={options} />
        </div>
    );
}
