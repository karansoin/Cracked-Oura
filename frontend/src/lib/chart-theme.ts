/**
 * One visual language for every Chart.js chart: grid alpha, tick font,
 * legend style and tooltip style. Components spread these into their options.
 */
import type { ChartOptions, TooltipOptions } from 'chart.js';
import { CHART_NEUTRAL, withAlpha } from '@/lib/bands';

export const CHART_FONT = { size: 11, family: 'ui-sans-serif, system-ui, -apple-system, sans-serif' } as const;

export interface ChartTheme {
    tick: string;
    grid: string;
    /** Slightly stronger ink for lines that carry data (HR overlay, markers). */
    ink: string;
    hoverLine: string;
    legend: NonNullable<NonNullable<ChartOptions['plugins']>['legend']>;
    tooltip: Partial<TooltipOptions>;
    tickFont: typeof CHART_FONT;
}

export function chartTheme(isDark: boolean): ChartTheme {
    const tick = isDark ? CHART_NEUTRAL.tickDark : CHART_NEUTRAL.tickLight;
    return {
        tick,
        grid: isDark ? withAlpha('#ffffff', 0.08) : withAlpha('#000000', 0.08),
        ink: isDark ? '#e4e4e7' : '#27272a',
        hoverLine: isDark ? withAlpha('#ffffff', 0.25) : withAlpha('#000000', 0.25),
        tickFont: CHART_FONT,
        legend: {
            position: 'top',
            align: 'end',
            labels: {
                boxWidth: 8,
                boxHeight: 8,
                usePointStyle: true,
                pointStyle: 'circle',
                color: tick,
                font: CHART_FONT,
                padding: 12,
            },
        },
        tooltip: {
            backgroundColor: isDark ? '#18181b' : '#ffffff',
            titleColor: isDark ? '#fafafa' : '#09090b',
            bodyColor: isDark ? '#d4d4d8' : '#3f3f46',
            borderColor: isDark ? '#2e2e35' : '#dedee2',
            borderWidth: 1,
            padding: { x: 10, y: 8 },
            cornerRadius: 6,
            titleFont: { ...CHART_FONT, weight: 600 },
            bodyFont: CHART_FONT,
            titleMarginBottom: 4,
            boxWidth: 8,
            boxHeight: 8,
            boxPadding: 4,
            usePointStyle: true,
            caretSize: 5,
        },
    };
}
