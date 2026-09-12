import { useMemo } from 'react';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Tooltip,
    type ChartOptions,
    type Plugin,
    type ScriptableLineSegmentContext,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { format, isValid, parseISO } from 'date-fns';
import { useIsDark } from '@/components/theme-provider';
import { STAGE_COLORS, CHART_NEUTRAL, withAlpha } from '@/lib/bands';
import { formatMinutes } from '@/lib/format';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip);

// Stage codes from the Oura export: 1 deep, 2 light, 3 REM, 4 awake.
type StageCode = 1 | 2 | 3 | 4;

interface StageMeta {
    code: StageCode;
    key: 'deep' | 'light' | 'rem' | 'awake';
    label: string;
    color: string;
}

const STAGES: readonly StageMeta[] = [
    { code: 4, key: 'awake', label: 'Awake', color: STAGE_COLORS.awake },
    { code: 3, key: 'rem', label: 'REM', color: STAGE_COLORS.rem },
    { code: 2, key: 'light', label: 'Light', color: STAGE_COLORS.light },
    { code: 1, key: 'deep', label: 'Deep', color: STAGE_COLORS.deep },
] as const;

/** Category labels, top -> bottom. */
const Y_LABELS = STAGES.map(s => s.label);
const stageByCode = (code: StageCode): StageMeta => STAGES.find(s => s.code === code) ?? STAGES[0];
const stageByLabelIndex = (i: number): StageMeta => STAGES[Math.max(0, Math.min(STAGES.length - 1, Math.round(i)))];

const EPOCH_MIN = 5;

interface Epoch {
    /** Minutes since the first epoch. */
    t: number;
    stage: StageCode;
}

interface Run {
    stage: StageMeta;
    startMin: number;
    endMin: number;
}

const toStage = (value: unknown): StageCode | null => {
    const n = typeof value === 'string' ? Number(value) : value;
    if (n === 1 || n === 2 || n === 3 || n === 4) return n;
    return null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

/**
 * Parse the export's `sleep_phase_5_min` into evenly spaced epochs.
 * Accepts a list of `{timestamp, value}`, a bare list of codes, a digit string,
 * or an `{items, timestamp}` object.
 */
function parsePhases(raw: unknown, startTime: string | null | undefined): { start: Date | null; epochs: Epoch[] } {
    let items: unknown[] | null = null;
    let start: Date | null = startTime ? parseISO(startTime) : null;
    if (start && !isValid(start)) start = null;

    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (/^[1-4]+$/.test(trimmed)) items = trimmed.split('');
        else {
            try {
                return parsePhases(JSON.parse(trimmed), startTime);
            } catch {
                items = null;
            }
        }
    } else if (Array.isArray(raw)) {
        items = raw;
    } else if (isRecord(raw) && Array.isArray(raw.items)) {
        items = raw.items;
        if (typeof raw.timestamp === 'string') {
            const ts = parseISO(raw.timestamp);
            if (isValid(ts)) start = ts;
        }
    }
    if (!items || items.length === 0) return { start, epochs: [] };

    // Timestamped list -> anchor at the first timestamp
    const first = items[0];
    if (isRecord(first) && typeof first.timestamp === 'string') {
        const ts0 = parseISO(first.timestamp);
        if (isValid(ts0)) start = ts0;
        const epochs: Epoch[] = [];
        items.forEach((item, i) => {
            if (!isRecord(item)) return;
            const stage = toStage(item.value);
            if (stage === null) return;
            let t = i * EPOCH_MIN;
            if (typeof item.timestamp === 'string' && start) {
                const ts = parseISO(item.timestamp);
                if (isValid(ts)) t = Math.round((ts.getTime() - start.getTime()) / 60_000);
            }
            epochs.push({ t, stage });
        });
        return { start, epochs };
    }

    const epochs: Epoch[] = [];
    items.forEach((item, i) => {
        const stage = toStage(item);
        if (stage !== null) epochs.push({ t: i * EPOCH_MIN, stage });
    });
    return { start, epochs };
}

function buildRuns(epochs: Epoch[]): Run[] {
    const runs: Run[] = [];
    for (const e of epochs) {
        const last = runs[runs.length - 1];
        if (last && last.stage.code === e.stage && last.endMin === e.t) {
            last.endMin = e.t + EPOCH_MIN;
        } else {
            runs.push({ stage: stageByCode(e.stage), startMin: e.t, endMin: e.t + EPOCH_MIN });
        }
    }
    return runs;
}

interface HypnogramCanvasProps {
    phases: unknown;
    /** ISO start of the sequence (`bedtime_start` / `start_time`); used for the digit-string form. */
    startTime?: string | null;
    /** Day label for the accessible name. */
    dayLabel?: string;
    /** Hide the legend (compact variant). */
    compact?: boolean;
}

export function HypnogramCanvas({ phases, startTime, dayLabel, compact = false }: HypnogramCanvasProps) {
    const isDark = useIsDark();

    const { start, epochs, runs, totals, totalMin } = useMemo(() => {
        const parsed = parsePhases(phases, startTime);
        const runs = buildRuns(parsed.epochs);
        const totals: Record<StageMeta['key'], number> = { awake: 0, rem: 0, light: 0, deep: 0 };
        for (const r of runs) totals[r.stage.key] += r.endMin - r.startMin;
        const totalMin = runs.length ? runs[runs.length - 1].endMin - runs[0].startMin : 0;
        return { start: parsed.start, epochs: parsed.epochs, runs, totals, totalMin };
    }, [phases, startTime]);

    const clock = (min: number): string => {
        if (!start) {
            const h = Math.floor(min / 60);
            const m = Math.round(min % 60);
            return `${h}:${m.toString().padStart(2, '0')}`;
        }
        return format(new Date(start.getTime() + min * 60_000), 'HH:mm');
    };

    // Points sit at the END of each epoch so `stepped: 'before'` draws epoch i at y_i
    // over [t_i, t_i + 5min]; a leading point anchors the first epoch's start.
    const points = useMemo(() => {
        if (epochs.length === 0) return [];
        const first = epochs[0];
        const pts: Array<{ x: number; y: string }> = [{ x: first.t, y: stageByCode(first.stage).label }];
        for (const e of epochs) pts.push({ x: e.t + EPOCH_MIN, y: stageByCode(e.stage).label });
        return pts;
    }, [epochs]);

    const runForMinute = (min: number): Run | undefined =>
        runs.find(r => min > r.startMin && min <= r.endMin) ?? runs.find(r => min >= r.startMin && min < r.endMin);

    if (epochs.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full rounded-lg border border-dashed text-muted-foreground p-4 text-center">
                <span className="text-sm font-medium">No sleep recorded</span>
                <span className="text-xs opacity-70 mt-1">No sleep stages for this day</span>
            </div>
        );
    }

    const xMin = epochs[0].t;
    const xMax = epochs[epochs.length - 1].t + EPOCH_MIN;

    const bandPlugin: Plugin<'line'> = {
        id: 'hypnogramBands',
        beforeDatasetsDraw: (chart) => {
            const { ctx, scales } = chart;
            const x = scales.x;
            const y = scales.y;
            if (!x || !y) return;
            const rowPx = Y_LABELS.length > 1 ? Math.abs(y.getPixelForValue(1) - y.getPixelForValue(0)) : 20;
            const half = rowPx * 0.32;
            ctx.save();
            for (const r of runs) {
                const x0 = x.getPixelForValue(r.startMin);
                const x1 = x.getPixelForValue(r.endMin);
                const yc = y.getPixelForValue(Y_LABELS.indexOf(r.stage.label));
                ctx.fillStyle = withAlpha(r.stage.color, 0.18);
                ctx.fillRect(x0, yc - half, Math.max(1, x1 - x0), half * 2);
            }
            ctx.restore();
        },
    };

    const data = {
        datasets: [
            {
                label: 'Stage',
                data: points,
                stepped: 'before' as const,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 3,
                borderColor: STAGE_COLORS.light,
                segment: {
                    borderColor: (ctx: ScriptableLineSegmentContext) => stageByLabelIndex(ctx.p1.parsed.y ?? 0).color,
                },
            },
        ],
    };

    const tickColor = isDark ? CHART_NEUTRAL.tickDark : CHART_NEUTRAL.tickLight;

    const options: ChartOptions<'line'> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        parsing: { xAxisKey: 'x', yAxisKey: 'y' },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                enabled: true,
                displayColors: false,
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                titleColor: isDark ? '#f3f4f6' : '#111827',
                bodyColor: isDark ? '#f3f4f6' : '#111827',
                borderColor: isDark ? '#374151' : '#e5e7eb',
                borderWidth: 1,
                callbacks: {
                    title: (items) => {
                        const item = items[0];
                        if (!item) return '';
                        const run = runForMinute(item.parsed.x ?? 0);
                        if (!run) return '';
                        return `${run.stage.label} · ${clock(run.startMin)}–${clock(run.endMin)} · ${run.endMin - run.startMin} min`;
                    },
                    label: () => '',
                },
            },
        },
        scales: {
            x: {
                type: 'linear',
                min: xMin,
                max: xMax,
                grid: { color: isDark ? withAlpha('#ffffff', 0.08) : withAlpha('#000000', 0.08), drawTicks: false },
                border: { display: false },
                ticks: {
                    color: tickColor,
                    font: { size: 10 },
                    stepSize: 60,
                    maxRotation: 0,
                    autoSkip: true,
                    callback: (v) => clock(Number(v)),
                },
            },
            y: {
                type: 'category',
                labels: Y_LABELS,
                offset: true,
                grid: { color: isDark ? withAlpha('#ffffff', 0.08) : withAlpha('#000000', 0.08), drawTicks: false },
                border: { display: false },
                ticks: { color: tickColor, font: { size: 10 } },
            },
        },
    };

    const asleepMin = totals.deep + totals.light + totals.rem;
    const ariaLabel = `Hypnogram${dayLabel ? ` for ${dayLabel}` : ''}: ${formatMinutes(asleepMin)} asleep. ` +
        STAGES.map(s => `${s.label} ${formatMinutes(totals[s.key])}`).join(', ') + '.';

    return (
        <div className="h-full w-full flex flex-col min-h-0">
            <div className="flex-1 min-h-0" role="img" aria-label={ariaLabel}>
                <Line data={data} options={options} plugins={[bandPlugin]} />
            </div>
            {!compact && (
                <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-[11px] text-muted-foreground" aria-hidden="true">
                    {STAGES.map(s => {
                        const mins = totals[s.key];
                        const pct = totalMin > 0 ? Math.round((mins / totalMin) * 100) : 0;
                        return (
                            <li key={s.key} className="flex items-center gap-1.5">
                                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
                                <span className="text-foreground/80">{s.label}</span>
                                <span className="tabular-nums">{formatMinutes(mins)} · {pct}%</span>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
