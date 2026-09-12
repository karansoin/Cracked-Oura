/**
 * Inline Chart.js plugins driven by `options.plugins.<id>`.
 *
 * react-chartjs-2 hands the `plugins` array to Chart.js only when the chart is
 * created, so plugin closures never see later renders. Everything a plugin needs
 * therefore travels through the chart options (refreshed on every update).
 */
import type { ChartType, Plugin } from 'chart.js';
import { BANDS, withAlpha } from '@/lib/bands';

export interface HypnogramBandRun {
    startMin: number;
    endMin: number;
    /** Category label on the y-axis. */
    label: string;
    color: string;
}

export interface HypnogramBandsOptions {
    runs: HypnogramBandRun[];
    labels: string[];
}

export interface CrosshairOptions {
    enabled: boolean;
    color: string;
}

export interface TypicalRangeBand {
    low: number;
    high: number;
}

export interface TypicalRangeOptions {
    /** Band on the left axis (`y`). */
    left: TypicalRangeBand | null;
    leftColor: string;
    /** Band on the right axis (`y1`). */
    right: TypicalRangeBand | null;
    rightColor: string;
}

export interface LowestPointOptions {
    enabled: boolean;
    x: number;
    y: number;
    label: string;
    color: string;
}

export interface TrendsDecorOptions {
    scoreBands: boolean;
    isDark: boolean;
    baseline: TypicalRangeBand | null;
    baselineColor: string;
    /** x value of the selected-day marker (null = none). */
    marker: number | null;
}

export interface HoverLineOptions {
    color: string;
}

export interface ScoreBandsOptions {
    enabled: boolean;
    isDark: boolean;
}

declare module 'chart.js' {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- must mirror Chart.js's own declaration
    interface PluginOptionsByType<TType extends ChartType> {
        hypnogramBands?: HypnogramBandsOptions;
        sleepCrosshair?: CrosshairOptions;
        typicalRange?: TypicalRangeOptions;
        lowestPoint?: LowestPointOptions;
        trendsDecor?: TrendsDecorOptions;
        hoverLine?: HoverLineOptions;
        scoreBands?: ScoreBandsOptions;
    }
}

/** Translucent boxes behind each sleep-stage run. */
export const hypnogramBandsPlugin: Plugin<'line', HypnogramBandsOptions> = {
    id: 'hypnogramBands',
    beforeDatasetsDraw: (chart, _args, opts) => {
        const { ctx, scales } = chart;
        const x = scales.x;
        const y = scales.y;
        if (!x || !y || !opts?.runs) return;
        const rowPx = opts.labels.length > 1 ? Math.abs(y.getPixelForValue(1) - y.getPixelForValue(0)) : 20;
        const half = rowPx * 0.32;
        ctx.save();
        for (const r of opts.runs) {
            const x0 = x.getPixelForValue(r.startMin);
            const x1 = x.getPixelForValue(r.endMin);
            const yc = y.getPixelForValue(opts.labels.indexOf(r.label));
            ctx.fillStyle = withAlpha(r.color, 0.18);
            ctx.fillRect(x0, yc - half, Math.max(1, x1 - x0), half * 2);
        }
        ctx.restore();
    },
};

/** Horizontal p25-p75 boxes on the left and/or right axis. */
export const typicalRangePlugin: Plugin<'line', TypicalRangeOptions> = {
    id: 'typicalRange',
    beforeDatasetsDraw: (chart, _args, opts) => {
        if (!opts) return;
        const { ctx, chartArea, scales } = chart;
        ctx.save();
        const draw = (band: TypicalRangeBand | null, scaleId: 'y' | 'y1', color: string) => {
            const scale = scales[scaleId];
            if (!band || !scale) return;
            const top = scale.getPixelForValue(band.high);
            const bottom = scale.getPixelForValue(band.low);
            ctx.fillStyle = withAlpha(color, 0.16);
            ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, bottom - top);
        };
        draw(opts.left, 'y', opts.leftColor);
        draw(opts.right, 'y1', opts.rightColor);
        ctx.restore();
    },
};

/** A filled point plus a text label (e.g. "Lowest 47 bpm · 03:40"). */
export const lowestPointPlugin: Plugin<'line', LowestPointOptions> = {
    id: 'lowestPoint',
    afterDatasetsDraw: (chart, _args, opts) => {
        if (!opts?.enabled) return;
        const { ctx, chartArea, scales } = chart;
        const x = scales.x.getPixelForValue(opts.x);
        const y = scales.y.getPixelForValue(opts.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = opts.color;
        ctx.fill();
        ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
        ctx.fillStyle = opts.color;
        const width = ctx.measureText(opts.label).width;
        const left = x + 6 + width > chartArea.right ? x - 6 - width : x + 6;
        const textY = Math.min(chartArea.bottom - 2, Math.max(chartArea.top + 10, y + 4));
        ctx.textAlign = 'left';
        ctx.fillText(opts.label, left, textY);
        ctx.restore();
    },
};

/** Very light 85 / 70 / 60 score-band shading behind score lines. */
export const scoreBandsPlugin: Plugin<'line', ScoreBandsOptions> = {
    id: 'scoreBands',
    beforeDatasetsDraw: (chart, _args, opts) => {
        if (!opts?.enabled) return;
        const { ctx, chartArea, scales } = chart;
        const y = scales.y;
        if (!y || !chartArea) return;
        ctx.save();
        let upper = 100;
        for (const band of BANDS) {
            const top = y.getPixelForValue(upper);
            const bottom = y.getPixelForValue(band.min);
            ctx.fillStyle = withAlpha(opts.isDark ? band.dark : band.light, 0.07);
            ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, bottom - top);
            upper = band.min;
        }
        ctx.restore();
    },
};

/** Score bands + personal baseline band + selected-day marker for the Trends chart. */
export const trendsDecorPlugin: Plugin<'line', TrendsDecorOptions> = {
    id: 'trendsDecor',
    beforeDatasetsDraw: (chart, _args, opts) => {
        if (!opts) return;
        const { ctx, chartArea, scales } = chart;
        const y = scales.y;
        if (!y || !chartArea) return;
        ctx.save();
        if (opts.scoreBands) {
            let upper = 100;
            for (const b of BANDS) {
                const top = y.getPixelForValue(upper);
                const bottom = y.getPixelForValue(b.min);
                ctx.fillStyle = withAlpha(opts.isDark ? b.dark : b.light, 0.06);
                ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, bottom - top);
                upper = b.min;
            }
        }
        if (opts.baseline) {
            const top = y.getPixelForValue(opts.baseline.high);
            const bottom = y.getPixelForValue(opts.baseline.low);
            ctx.fillStyle = withAlpha(opts.baselineColor, 0.12);
            ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, bottom - top);
        }
        ctx.restore();
    },
    afterDatasetsDraw: (chart, _args, opts) => {
        if (!opts || opts.marker === null) return;
        const { ctx, chartArea, scales } = chart;
        const x = scales.x.getPixelForValue(opts.marker);
        if (x < chartArea.left || x > chartArea.right) return;
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = opts.isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)';
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
    },
};

/** Vertical line through the tooltip's active element. */
export const hoverLinePlugin: Plugin<'line', HoverLineOptions> = {
    id: 'hoverLine',
    afterDraw: (chart, _args, opts) => {
        const active = chart.tooltip?.getActiveElements();
        if (!active || active.length === 0) return;
        const { ctx, chartArea } = chart;
        const x = active[0].element.x;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = opts?.color ?? 'rgba(128,128,128,0.3)';
        ctx.stroke();
        ctx.restore();
    },
};
