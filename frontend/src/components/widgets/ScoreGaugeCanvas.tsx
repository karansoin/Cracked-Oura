import {
    Chart as ChartJS,
    ArcElement,
    Tooltip,
    Legend,
    type ChartOptions
} from 'chart.js';
import { Doughnut } from 'react-chartjs-2';
import { cn } from '@/lib/utils';
import { useIsDark } from '@/components/theme-provider';
import { CHART_NEUTRAL, getBand, bandColor, bandTextColor } from '@/lib/bands';
import { useElementWidth } from '@/hooks/useElementWidth';

// Register ChartJS components
ChartJS.register(
    ArcElement,
    Tooltip,
    Legend
);

interface ScoreGaugeCanvasProps {
    /** 0-100, or null when the source has no score (e.g. ring-derived days). */
    score: number | null;
    title?: string;
    /** Optional accent override; band colour is used when omitted. */
    color?: string;
    className?: string;
    /** Shown under the band label when the score is missing. */
    emptyHint?: string;
}

export function ScoreGaugeCanvas({ score, title, color, className, emptyHint = 'No score (ring data)' }: ScoreGaugeCanvasProps) {
    const isDark = useIsDark();
    const [ref, width] = useElementWidth<HTMLDivElement>();

    const hasScore = score !== null && Number.isFinite(score);
    const band = getBand(hasScore ? score : null);
    const arcColor = hasScore ? (color || bandColor(band, isDark)) : bandColor(null, isDark);
    const textColor = hasScore ? (color || bandTextColor(band, isDark)) : bandTextColor(null, isDark);
    const trackColor = isDark ? CHART_NEUTRAL.trackDark : CHART_NEUTRAL.trackLight;
    const clamped = hasScore ? Math.max(0, Math.min(100, score)) : 0;

    // The number scales with the card so it never collides with the arc when the
    // dashboard is squeezed by a side panel.
    const small = width > 0 && width < 170;

    const chartData = {
        labels: ['Score', 'Remaining'],
        datasets: [
            {
                data: hasScore ? [clamped, 100 - clamped] : [0, 100],
                backgroundColor: [arcColor, trackColor],
                borderWidth: 0,
                borderRadius: 20, // Rounded ends
                cutout: '85%', // Thickness of the ring
            },
        ],
    };

    const options: ChartOptions<'doughnut'> = {
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
                enabled: false, // Disable tooltip for gauge
            }
        },
        rotation: -135, // 270° arc, open at the bottom
        circumference: 270,
    };

    const ariaLabel = hasScore
        ? `${title ?? 'Score'}: ${Math.round(score)} out of 100, ${band?.label ?? ''}`
        : `${title ?? 'Score'}: no score available`;

    return (
        <div ref={ref} className={cn("relative flex h-full w-full flex-col items-center justify-center", className)}>
            <div className="h-full w-full p-1" role="img" aria-label={ariaLabel}>
                <Doughnut data={chartData} options={options} />
            </div>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
                <span className={cn("font-semibold tabular-nums leading-none tracking-tight", small ? "text-2xl" : "text-4xl")} style={{ color: textColor }}>
                    {hasScore ? Math.round(score) : '—'}
                </span>
                <span className={cn("mt-1.5 font-medium", small ? "text-xs" : "text-sm")} style={{ color: textColor }}>
                    {hasScore ? `${band?.glyph ?? ''} ${band?.label ?? ''}`.trim() : emptyHint}
                </span>
            </div>
        </div>
    );
}
