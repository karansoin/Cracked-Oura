import { useEffect, useRef } from 'react';
import { useIsDark } from '@/components/theme-provider';
import { CHART_NEUTRAL, withAlpha } from '@/lib/bands';

interface SpectrumCanvasProps {
    f: number[];
    p: number[];
    dominantHz?: number | null;
    height?: number;
    ariaLabel: string;
}

const BANDS: Array<{ lo: number; hi: number; label: string; color: string }> = [
    { lo: 3.5, hi: 7.5, label: '3.5–7.5 Hz · rest-type', color: '#D55E00' },
    { lo: 7.5, hi: 12, label: '7.5–12 Hz · physiological', color: '#0072B2' },
];

/** Power spectrum on a log axis with the tremor bands shaded and the dominant peak marked. */
export function SpectrumCanvas({ f, p, dominantHz, height = 150, ariaLabel }: SpectrumCanvasProps) {
    const ref = useRef<HTMLCanvasElement>(null);
    const isDark = useIsDark();
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const cssW = Math.max(160, canvas.parentElement?.clientWidth ?? 320);
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(height * dpr);
        canvas.style.width = `${cssW}px`; canvas.style.height = `${height}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, height);
        const padL = 30, padR = 8, padT = 20, padB = 20;
        const w = cssW - padL - padR, h = height - padT - padB;
        const tick = isDark ? CHART_NEUTRAL.tickDark : CHART_NEUTRAL.tickLight;
        const grid = isDark ? withAlpha('#ffffff', 0.08) : withAlpha('#000000', 0.08);
        const fMax = 20;
        const x = (hz: number) => padL + (hz / fMax) * w;
        const vals = p.map(v => Math.log10(Math.max(v, 1e-12)));
        const lo = vals.length ? Math.min(...vals) : -12, hi = vals.length ? Math.max(...vals) : 0;
        const y = (lv: number) => padT + (1 - (lv - lo) / Math.max(hi - lo, 1e-9)) * h;
        for (const b of BANDS) {
            ctx.fillStyle = withAlpha(b.color, isDark ? 0.14 : 0.1);
            ctx.fillRect(x(b.lo), padT, x(b.hi) - x(b.lo), h);
            ctx.fillStyle = tick; ctx.font = '10px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
            ctx.fillText(b.label, x(b.lo) + 3, 4);
        }
        ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.fillStyle = tick; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (let hz = 0; hz <= fMax; hz += 5) {
            const xx = Math.round(x(hz)) + 0.5;
            ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + h); ctx.stroke();
            ctx.fillText(`${hz} Hz`, xx, padT + h + 4);
        }
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText('log P', padL - 4, padT + 6);
        if (f.length > 1) {
            ctx.strokeStyle = isDark ? '#e4e4e7' : '#27272a'; ctx.lineWidth = 1.5; ctx.beginPath();
            f.forEach((hz, i) => { if (hz > fMax) return; const xx = x(hz), yy = y(vals[i]); if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy); });
            ctx.stroke();
        }
        if (dominantHz && dominantHz > 0) {
            const xx = Math.round(x(dominantHz)) + 0.5;
            ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = isDark ? '#F2B84B' : '#9A6400';
            ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + h); ctx.stroke(); ctx.restore();
            ctx.fillStyle = isDark ? '#F2B84B' : '#9A6400'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
            ctx.fillText(`${dominantHz.toFixed(1)} Hz`, xx + 3, padT + h - 2);
        }
    }, [f, p, dominantHz, height, isDark]);
    return <canvas ref={ref} role="img" aria-label={ariaLabel} />;
}
