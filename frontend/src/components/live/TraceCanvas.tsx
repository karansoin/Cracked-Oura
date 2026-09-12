import { useEffect, useRef } from 'react';
import { useIsDark } from '@/components/theme-provider';
import { CHART_NEUTRAL, withAlpha } from '@/lib/bands';

export interface TracePoint { t: number; v: number | null }

interface TraceCanvasProps {
    points: TracePoint[];
    /** Seconds of history to show; the window slides with the newest point. When omitted, the full range is drawn. */
    windowS?: number;
    color: string;
    /** Fixed y-range; auto-scaled from the data otherwise. */
    yMin?: number;
    yMax?: number;
    /** Horizontal guide lines with labels (e.g. HR zones or 1 g). */
    guides?: Array<{ y: number; label?: string }>;
    /** Vertical markers in seconds (e.g. the detected stand). */
    markers?: Array<{ t: number; label?: string }>;
    height?: number;
    unit?: string;
    ariaLabel: string;
    fill?: boolean;
    className?: string;
    /** Custom x tick labels (e.g. dates when t is a day index); ticks are then spread evenly. */
    formatX?: (t: number) => string;
}

/**
 * Lightweight streaming line chart. A plain canvas (no Chart.js) so 50 Hz data
 * redraws in well under a millisecond and never allocates per frame.
 */
export function TraceCanvas({ points, windowS, color, yMin, yMax, guides = [], markers = [], height = 120, unit, ariaLabel, fill = false, className, formatX }: TraceCanvasProps) {
    const ref = useRef<HTMLCanvasElement>(null);
    const isDark = useIsDark();

    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const parent = canvas.parentElement;
        const cssW = Math.max(120, parent?.clientWidth ?? 300);
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(height * dpr);
            canvas.style.width = `${cssW}px`;
            canvas.style.height = `${height}px`;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, height);

        const padL = 34, padR = 8, padT = 8, padB = 18;
        const w = cssW - padL - padR;
        const h = height - padT - padB;
        const tick = isDark ? CHART_NEUTRAL.tickDark : CHART_NEUTRAL.tickLight;
        const grid = isDark ? withAlpha('#ffffff', 0.08) : withAlpha('#000000', 0.08);

        const last = points.length ? points[points.length - 1].t : 0;
        const first = points.length ? points[0].t : 0;
        const tMax = windowS ? Math.max(last, windowS) : last;
        const tMin = windowS ? tMax - windowS : first;
        const visible = points.filter(p => p.t >= tMin && p.t <= tMax);
        const values = visible.map(p => p.v).filter((v): v is number => v !== null && Number.isFinite(v));
        let lo = yMin ?? (values.length ? Math.min(...values) : 0);
        let hi = yMax ?? (values.length ? Math.max(...values) : 1);
        if (yMin === undefined || yMax === undefined) {
            const pad = (hi - lo) * 0.15 || 0.5;
            if (yMin === undefined) lo -= pad;
            if (yMax === undefined) hi += pad;
        }
        if (hi - lo < 1e-9) hi = lo + 1;
        const x = (t: number) => padL + ((t - tMin) / Math.max(tMax - tMin, 1e-9)) * w;
        const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * h;

        ctx.font = '10px ui-sans-serif, system-ui, -apple-system, sans-serif';
        ctx.fillStyle = tick;
        ctx.strokeStyle = grid;
        ctx.lineWidth = 1;
        const yTicks = 3;
        for (let i = 0; i <= yTicks; i++) {
            const v = lo + ((hi - lo) * i) / yTicks;
            const yy = Math.round(y(v)) + 0.5;
            ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + w, yy); ctx.stroke();
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(formatTick(v, hi - lo), padL - 4, yy);
        }
        const span = tMax - tMin;
        const step = formatX ? Math.max(1, Math.ceil(span / 4)) : span <= 15 ? 5 : span <= 60 ? 10 : span <= 300 ? 60 : 120;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let t = Math.ceil(tMin / step) * step; t <= tMax; t += step) {
            const xx = Math.round(x(t)) + 0.5;
            ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + h); ctx.stroke();
            ctx.fillText(formatX ? formatX(t) : formatT(t), xx, padT + h + 4);
        }
        if (unit) {
            ctx.textAlign = 'left';
            ctx.fillText(unit, padL + 4, padT + 2);
        }

        for (const g of guides) {
            if (g.y < lo || g.y > hi) continue;
            const yy = Math.round(y(g.y)) + 0.5;
            ctx.save();
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = withAlpha(color, 0.5);
            ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + w, yy); ctx.stroke();
            ctx.restore();
            if (g.label) { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = tick; ctx.fillText(g.label, padL + w - 2, yy - 1); }
        }
        for (const m of markers) {
            if (m.t < tMin || m.t > tMax) continue;
            const xx = Math.round(x(m.t)) + 0.5;
            ctx.save();
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = isDark ? '#F2B84B' : '#9A6400';
            ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + h); ctx.stroke();
            ctx.restore();
            if (m.label) { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = isDark ? '#F2B84B' : '#9A6400'; ctx.fillText(m.label, xx + 3, padT + 2); }
        }

        if (visible.length >= 2) {
            ctx.lineJoin = 'round';
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = color;
            ctx.beginPath();
            let pen = false;
            for (const p of visible) {
                if (p.v === null || !Number.isFinite(p.v)) { pen = false; continue; }
                const xx = x(p.t), yy = y(p.v);
                if (!pen) { ctx.moveTo(xx, yy); pen = true; } else ctx.lineTo(xx, yy);
            }
            ctx.stroke();
            if (fill) {
                ctx.lineTo(x(visible[visible.length - 1].t), padT + h);
                ctx.lineTo(x(visible[0].t), padT + h);
                ctx.closePath();
                ctx.fillStyle = withAlpha(color, 0.12);
                ctx.fill();
            }
        } else {
            ctx.fillStyle = tick;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Waiting for data…', padL + w / 2, padT + h / 2);
        }
    }, [points, windowS, color, yMin, yMax, guides, markers, height, unit, isDark, fill, formatX]);

    return <canvas ref={ref} role="img" aria-label={ariaLabel} className={className} />;
}

function formatTick(v: number, range: number): string {
    if (range >= 50) return v.toFixed(0);
    if (range >= 5) return v.toFixed(1);
    return v.toFixed(2);
}

function formatT(t: number): string {
    if (t < 60) return `${Math.round(t)}s`;
    const m = Math.floor(t / 60);
    const s = Math.round(t - m * 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}
