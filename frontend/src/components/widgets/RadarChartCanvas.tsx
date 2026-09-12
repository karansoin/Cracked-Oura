import {
    Chart as ChartJS,
    RadialLinearScale,
    PointElement,
    LineElement,
    Filler,
    Tooltip,
    Legend,
    type ChartOptions
} from 'chart.js';
import { useMemo } from 'react';
import { Radar } from 'react-chartjs-2';
import { useTheme } from '@/components/theme-provider';
import { useChartTable } from '@/contexts/ChartTableContext';
import { formatNumber, seriesStats, type ChartTable } from '@/lib/series-table';
import { SeriesTable } from './SeriesTable';

// Register ChartJS components
ChartJS.register(
    RadialLinearScale,
    PointElement,
    LineElement,
    Filler,
    Tooltip,
    Legend
);

interface RadarChartCanvasProps {
    data: Array<Record<string, unknown>>;
    dataKey: string;
    axisKey?: string;
    color?: string;
}

export function RadarChartCanvas({ data, dataKey, axisKey = "subject", color = "#8AB4F8" }: RadarChartCanvasProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';

    const rows = useMemo(() => (Array.isArray(data) ? data : []), [data]);
    const values = useMemo(() => rows.map(d => (typeof d[dataKey] === 'number' && Number.isFinite(d[dataKey]) ? d[dataKey] : null)), [rows, dataKey]);
    const stats = seriesStats(values);

    const table = useMemo<ChartTable | null>(() => (rows.length === 0 ? null : {
        columns: ['Contributor', 'Value'],
        rows: rows.map((d, i) => [String(d[axisKey] ?? ''), values[i] === null ? '' : formatNumber(values[i])]),
    }), [rows, values, axisKey]);
    const viewAsTable = useChartTable(table);

    const summary = stats
        ? `Radar chart of ${rows.length} contributors: min ${formatNumber(stats.min)}, max ${formatNumber(stats.max)}, average ${formatNumber(stats.avg, 1)}.`
        : 'Radar chart: no values.';

    if (viewAsTable && table) {
        return <SeriesTable table={table} caption={summary} />;
    }

    if (rows.length === 0 || !stats) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm text-center p-4" role="img" aria-label={summary}>
                <span className="font-medium">{rows.length === 0 ? 'No data for this day' : 'No score (ring data)'}</span>
            </div>
        );
    }

    const chartData = {
        labels: rows.map(d => String(d[axisKey] ?? '')),
        datasets: [
            {
                label: 'Value',
                data: values,
                backgroundColor: `${color}80`, // 50% opacity
                borderColor: color,
                borderWidth: 2,
                pointBackgroundColor: color,
                pointBorderColor: '#fff',
                pointHoverBackgroundColor: '#fff',
                pointHoverBorderColor: color,
            },
        ],
    };

    const options: ChartOptions<'radar'> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
            duration: 0
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
            r: {
                angleLines: {
                    color: isDark ? '#374151' : '#e5e7eb'
                },
                grid: {
                    color: isDark ? '#374151' : '#e5e7eb'
                },
                pointLabels: {
                    color: isDark ? '#9ca3af' : '#6b7280',
                    font: {
                        size: 11
                    }
                },
                ticks: {
                    display: false, // Hide radial ticks for cleaner look
                    backdropColor: 'transparent',
                    stepSize: 20 // Optional: nice steps
                },
                min: 0,
                max: 100,
            }
        }
    };

    return (
        <div className="w-full h-full min-h-[200px]" role="img" aria-label={summary}>
            <Radar data={chartData} options={options} />
        </div>
    );
}
