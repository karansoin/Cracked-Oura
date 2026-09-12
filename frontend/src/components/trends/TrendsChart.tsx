import { useMemo } from 'react';
import {
    Chart as ChartJS,
    LinearScale,
    PointElement,
    LineElement,
    Tooltip,
    Legend,
    type ActiveElement,
    type ChartEvent,
    type ChartOptions,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { format } from 'date-fns';
import { useIsDark } from '@/components/theme-provider';
import { CHART_NEUTRAL, withAlpha } from '@/lib/bands';
import { hoverLinePlugin, trendsDecorPlugin } from '@/lib/chart-plugins';
import type { Units } from '@/lib/format';
import { formatMetricValue, formatMetricWithUnit, type MetricKind } from '@/lib/metrics';
import { dateFromIndex, isoFromIndex } from '@/lib/trends';

ChartJS.register(LinearScale, PointElement, LineElement, Tooltip, Legend);

export interface XY {
    x: number;
    y: number | null;
}

export interface TrendsChartProps {
    /** Raw daily values (small, translucent points). */
    points: XY[];
    /** Smoothed / aggregated line for the primary metric. */
    line: XY[];
    lineLabel: string;
    kind: MetricKind;
    metricLabel: string;
    color: string;
    /** Personal baseline p25-p75 of the trailing 90 days. */
    band: { low: number; high: number } | null;
    /** Optional second metric on the right axis (dashed). */
    secondary?: { line: XY[]; label: string; kind: MetricKind; color: string } | null;
    xMin: number;
    xMax: number;
    /** Day index of the top-bar selected day (vertical marker when inside the range). */
    selectedX: number | null;
    onPointClick?: (isoDate: string) => void;
    units: Units;
    ariaLabel: string;
}

export function TrendsChart({
    points,
    line,
    lineLabel,
    kind,
    metricLabel,
    color,
    band,
    secondary,
    xMin,
    xMax,
    selectedX,
    onPointClick,
    units,
    ariaLabel,
}: TrendsChartProps) {
    const isDark = useIsDark();
    const isScore = kind === 'score';
    const gridColor = isDark ? withAlpha('#ffffff', 0.08) : withAlpha('#000000', 0.08);
    const tickColor = isDark ? CHART_NEUTRAL.tickDark : CHART_NEUTRAL.tickLight;
    const spanDays = Math.max(1, xMax - xMin);

    const data = useMemo(() => ({
        datasets: [
            {
                label: metricLabel,
                data: points,
                yAxisID: 'y',
                showLine: false,
                pointRadius: spanDays > 400 ? 1.5 : 2.5,
                pointHoverRadius: 4,
                pointBackgroundColor: withAlpha(color, 0.4),
                pointBorderColor: withAlpha(color, 0.4),
                pointBorderWidth: 0,
                borderColor: withAlpha(color, 0.4),
                backgroundColor: withAlpha(color, 0.4),
            },
            {
                label: lineLabel,
                data: line,
                yAxisID: 'y',
                borderColor: color,
                backgroundColor: color,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 3,
                tension: 0.2,
                spanGaps: true,
            },
            ...(secondary ? [{
                label: secondary.label,
                data: secondary.line,
                yAxisID: 'y1',
                borderColor: secondary.color,
                backgroundColor: secondary.color,
                borderDash: [5, 4],
                borderWidth: 1.5,
                pointRadius: 0,
                pointHoverRadius: 3,
                tension: 0.2,
                spanGaps: true,
            }] : []),
        ],
    }), [points, line, secondary, metricLabel, lineLabel, color, spanDays]);

    const tickFor = (k: MetricKind) => (value: number | string): string => {
        const n = Number(value);
        if (k === 'duration_s') return formatMetricValue(n, k, units);
        if (k === 'temp_dev') return n.toFixed(1);
        return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1);
    };

    const options: ChartOptions<'line'> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        parsing: { xAxisKey: 'x', yAxisKey: 'y' },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        onClick: (_event: ChartEvent, elements: ActiveElement[]) => {
            if (!onPointClick) return;
            const hit = elements.find(e => e.datasetIndex === 0) ?? elements[0];
            if (!hit) return;
            const point = (hit.datasetIndex === 0 ? points : hit.datasetIndex === 1 ? line : secondary?.line ?? [])[hit.index];
            if (point) onPointClick(isoFromIndex(point.x));
        },
        plugins: {
            trendsDecor: {
                scoreBands: isScore,
                isDark,
                baseline: band,
                baselineColor: color,
                marker: selectedX !== null && selectedX >= xMin && selectedX <= xMax ? selectedX : null,
            },
            hoverLine: { color: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' },
            legend: {
                display: true,
                position: 'top',
                align: 'end',
                labels: {
                    boxWidth: 8,
                    boxHeight: 8,
                    usePointStyle: true,
                    color: tickColor,
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
                callbacks: {
                    title: (items) => (items[0] ? format(dateFromIndex(items[0].parsed.x ?? 0), 'EEE d MMM yyyy') : ''),
                    label: (item) => {
                        const k = item.datasetIndex === 2 && secondary ? secondary.kind : kind;
                        const v = item.parsed.y;
                        return `${item.dataset.label}: ${v === null || v === undefined ? '—' : formatMetricWithUnit(v, k, units)}`;
                    },
                },
            },
        },
        scales: {
            x: {
                type: 'linear',
                min: xMin,
                max: xMax,
                grid: { display: false },
                border: { display: false },
                ticks: {
                    color: tickColor,
                    font: { size: 10 },
                    maxRotation: 0,
                    autoSkip: true,
                    maxTicksLimit: 10,
                    callback: (v) => {
                        const d = dateFromIndex(Number(v));
                        return format(d, spanDays > 400 ? 'MMM yy' : 'd MMM');
                    },
                },
            },
            y: {
                type: 'linear',
                position: 'left',
                min: isScore ? 0 : undefined,
                max: isScore ? 100 : undefined,
                grid: { color: gridColor, drawTicks: false },
                border: { display: false },
                ticks: { color: tickColor, font: { size: 10 }, maxTicksLimit: 6, callback: tickFor(kind) },
            },
            y1: {
                type: 'linear',
                position: 'right',
                display: !!secondary,
                min: secondary?.kind === 'score' ? 0 : undefined,
                max: secondary?.kind === 'score' ? 100 : undefined,
                grid: { display: false, drawTicks: false },
                border: { display: false },
                ticks: { color: secondary?.color ?? tickColor, font: { size: 10 }, maxTicksLimit: 6, callback: tickFor(secondary?.kind ?? 'number') },
            },
        },
    };

    return (
        <div className="h-full w-full min-h-[240px]" role="img" aria-label={ariaLabel}>
            <Line data={data} options={options} plugins={[trendsDecorPlugin, hoverLinePlugin]} />
        </div>
    );
}
