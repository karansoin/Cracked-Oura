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
import { useIsDark } from '@/components/theme-provider';
import { chartTheme } from '@/lib/chart-theme';
import { humanizeKey } from '@/lib/format';
import { withAlpha } from '@/lib/bands';
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

export function RadarChartCanvas({ data, dataKey, axisKey = "subject", color = "#0072B2" }: RadarChartCanvasProps) {
    const isDark = useIsDark();
    const theme = chartTheme(isDark);

    const rows = useMemo(() => (Array.isArray(data) ? data : []), [data]);
    const values = useMemo(() => rows.map(d => (typeof d[dataKey] === 'number' && Number.isFinite(d[dataKey]) ? d[dataKey] : null)), [rows, dataKey]);
    const stats = seriesStats(values);

    const table = useMemo<ChartTable | null>(() => (rows.length === 0 ? null : {
        columns: ['Contributor', 'Value'],
        rows: rows.map((d, i) => [humanizeKey(String(d[axisKey] ?? '')), values[i] === null ? '' : formatNumber(values[i])]),
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
            <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed p-4 text-center text-sm" role="img" aria-label={summary}>
                <span className="font-medium text-foreground">{rows.length === 0 ? 'No data for this day' : 'No score (ring data)'}</span>
                <span className="mt-1 text-xs text-muted-foreground">Contributors come from Oura's daily summaries</span>
            </div>
        );
    }

    const chartData = {
        labels: rows.map(d => humanizeKey(String(d[axisKey] ?? ''))),
        datasets: [
            {
                label: 'Score',
                data: values,
                backgroundColor: withAlpha(color, 0.25),
                borderColor: color,
                borderWidth: 2,
                pointRadius: 2.5,
                pointHoverRadius: 4,
                pointBackgroundColor: color,
                pointBorderColor: color,
                pointHoverBackgroundColor: color,
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
                ...theme.tooltip,
                displayColors: false,
            }
        },
        scales: {
            r: {
                angleLines: {
                    color: theme.grid
                },
                grid: {
                    color: theme.grid
                },
                pointLabels: {
                    color: theme.tick,
                    font: theme.tickFont,
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
