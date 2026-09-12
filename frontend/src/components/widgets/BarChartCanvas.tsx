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
import { Bar } from 'react-chartjs-2';
import { useIsDark } from '@/components/theme-provider';

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

    const values = data.map(d => toNumber(d[dataKey]));

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
        <div className="w-full h-full min-h-[100px]" role="img" aria-label={ariaLabel ?? `Bar chart of ${dataKey} over ${data.length} points`}>
            <Bar data={chartData} options={options} />
        </div>
    );
}
