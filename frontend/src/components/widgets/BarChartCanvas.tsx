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
import { formatMetricValue, kindForKey } from '@/lib/metrics';
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
    const { units } = useAppStatus();

    const values = useMemo(() => data.map(d => toNumber(d[dataKey])), [data, dataKey]);
    const seriesName = dataKey.split('.').pop()?.replace(/_/g, ' ') ?? dataKey;
    const stats = seriesStats(values);

    const table = useMemo<ChartTable | null>(() => {
        if (data.length === 0) return null;
        const kind = kindForKey(dataKey);
        return {
            columns: [categoryKey === 'date' ? 'Date' : 'Category', seriesName],
            rows: data.map((d, i) => [String(d[categoryKey] ?? ''), values[i] === null ? '' : formatMetricValue(values[i], kind, units)]),
        };
    }, [data, dataKey, categoryKey, seriesName, values, units]);
    const viewAsTable = useChartTable(table);

    const summary = ariaLabel ?? (stats
        ? `Bar chart of ${seriesName} over ${data.length} points: min ${formatNumber(stats.min, 2)}, max ${formatNumber(stats.max, 2)}, average ${formatNumber(stats.avg, 2)}.`
        : `Bar chart of ${seriesName}: no values.`);

    if (viewAsTable && table) {
        return <SeriesTable table={table} caption={summary} />;
    }

    if (!stats) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4 text-center" role="img" aria-label={summary}>
                <span className="text-sm font-medium">No values in this range</span>
                <span className="text-xs opacity-70 mt-1">Days synced from the ring have no scores yet</span>
            </div>
        );
    }

    const chartData = {
        labels: data.map(d => String(d[categoryKey] ?? '')),
        datasets: [
            {
                label: dataKey.split('.').pop()?.replace(/_/g, ' ') ?? dataKey,
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
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                titleColor: isDark ? '#f3f4f6' : '#111827',
                bodyColor: isDark ? '#f3f4f6' : '#111827',
                borderColor: isDark ? '#374151' : '#e5e7eb',
                borderWidth: 1,
            }
        },
        scales: {
            x: {
                grid: {
                    display: false,
                },
                ticks: {
                    color: isDark ? '#9ca3af' : '#6b7280',
                    font: {
                        size: 10
                    },
                    callback: function (val) {
                        const label = this.getLabelForValue(val as number);
                        // Check if it's a date YYYY-MM-DD
                        if (typeof label === 'string' && label.match(/^\d{4}-\d{2}-\d{2}$/)) {
                            const parts = label.split('-');
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
                position: 'left',
                grid: {
                    color: isDark ? '#374151' : '#e5e7eb',
                    drawTicks: false,
                },
                border: {
                    display: false
                },
                ticks: {
                    color: isDark ? '#9ca3af' : '#6b7280',
                    font: {
                        size: 10
                    }
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
