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
    type Chart,
    type ChartOptions,
    type Plugin,
    type ScriptableContext
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { useIsDark } from '@/components/theme-provider';
import { BANDS, CHART_NEUTRAL, SERIES_PALETTE, withAlpha } from '@/lib/bands';

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

export function TrendChartCanvas({ data, dataKey, dataKeys, title, color, showPoints = false, ariaLabel }: TrendChartCanvasProps) {
    const isDark = useIsDark();

    // Determine keys to plot
    const keys = (dataKeys && dataKeys.length > 0) ? dataKeys : (dataKey ? [dataKey] : []);

    // Score charts (every key is a `*.score`) get band shading behind the lines.
    const isScoreChart = keys.length > 0 && keys.every(k => k.endsWith('.score'));

    // Okabe-Ito palette for multi-series; the widget accent leads.
    const colors = [color, ...SERIES_PALETTE.filter(c => c.toLowerCase() !== color.toLowerCase())];

    // Series labels: the last path segment, unless that would be ambiguous
    // (e.g. sleep.score / readiness.score / activity.score -> "sleep score", ...).
    const lastSegments = keys.map(k => k.split('.').pop() ?? k);
    const ambiguous = new Set(lastSegments).size !== lastSegments.length;
    const seriesLabel = (key: string) => (ambiguous ? key.replace(/\./g, ' ') : (key.split('.').pop() ?? key)).replace(/_/g, ' ') || title;

    // Prepare data for Chart.js
    const chartData = {
        labels: data.map(d => String(d.date ?? '')),
        datasets: keys.map((key, index) => {
            const seriesColor = colors[index % colors.length];
            const label = seriesLabel(key);

            return {
                label: label,
                data: data.map(d => toNumber(d[key] !== undefined ? d[key] : d.value)),
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

    // Custom plugin to draw vertical line on hover
    const verticalLinePlugin: Plugin<'line'> = {
        id: 'verticalLine',
        afterDraw: (chart: Chart<'line'>) => {
            const active = chart.tooltip?.getActiveElements();
            if (active && active.length) {
                const ctx = chart.ctx;
                const x = active[0].element.x;
                const topY = chart.scales.y.top;
                const bottomY = chart.scales.y.bottom;

                ctx.save();
                ctx.beginPath();
                ctx.moveTo(x, topY);
                ctx.lineTo(x, bottomY);
                ctx.lineWidth = 1;
                ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)';
                ctx.stroke();
                ctx.restore();
            }
        }
    };

    // Very light horizontal band shading (85 / 70 / 60) behind score lines.
    const bandShadingPlugin: Plugin<'line'> = {
        id: 'scoreBands',
        beforeDatasetsDraw: (chart: Chart<'line'>) => {
            if (!isScoreChart) return;
            const { ctx, chartArea, scales } = chart;
            const y = scales.y;
            if (!y || !chartArea) return;
            ctx.save();
            let upper = 100;
            for (const band of BANDS) {
                const top = y.getPixelForValue(upper);
                const bottom = y.getPixelForValue(band.min);
                ctx.fillStyle = withAlpha(isDark ? band.dark : band.light, 0.07);
                ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, bottom - top);
                upper = band.min;
            }
            ctx.restore();
        }
    };

    const summary = ariaLabel ?? `${title}: line chart of ${keys.map(k => k.split('.').pop()?.replace(/_/g, ' ')).join(', ')} over ${data.length} points`;

    return (
        <div className="w-full h-full min-h-[100px]" role="img" aria-label={summary}>
            <Line data={chartData} options={options} plugins={[bandShadingPlugin, verticalLinePlugin]} />
        </div>
    );
}
