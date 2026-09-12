import { useCallback, useMemo, useRef } from 'react';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Tooltip,
    type ActiveDataPoint,
    type ActiveElement,
    type ChartArea,
    type ChartEvent,
    type ChartOptions,
    type Element as ChartElement,
    type Plugin,
    type Point,
    type Scale,
    type ScriptableLineSegmentContext,
    type UpdateMode,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { format, isValid, parseISO } from 'date-fns';
import { useIsDark } from '@/components/theme-provider';
import { STAGE_COLORS, SERIES_PALETTE, withAlpha } from '@/lib/bands';
import { chartTheme } from '@/lib/chart-theme';
import { formatMinutes } from '@/lib/format';
import { nearestIndex, seriesStats, type ChartTable } from '@/lib/series-table';
import { hypnogramBandsPlugin, lowestPointPlugin, typicalRangePlugin, type CrosshairOptions } from '@/lib/chart-plugins';
import { useChartTable } from '@/contexts/ChartTableContext';
import { SeriesTable } from './SeriesTable';

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
/** Fixed axis widths so the stacked charts share one x-axis pixel range. */
const LEFT_AXIS_PX = 44;
const RIGHT_AXIS_PX = 40;
const HRV_COLOR = SERIES_PALETTE[2];

interface Epoch {
    /** Minutes since the chart origin. */
    t: number;
    stage: StageCode;
}

interface Run {
    stage: StageMeta;
    startMin: number;
    endMin: number;
}

/** One HR / HRV sample, minutes since the chart origin. */
interface Sample {
    t: number;
    v: number | null;
}

export interface TypicalRange {
    low: number;
    high: number;
    n: number;
}

export interface HypnogramOverlay {
    hr: boolean;
    hrv: boolean;
}

const toStage = (value: unknown): StageCode | null => {
    const n = typeof value === 'string' ? Number(value) : value;
    if (n === 1 || n === 2 || n === 3 || n === 4) return n;
    return null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

const parseDate = (iso: string | null | undefined): Date | null => {
    if (!iso) return null;
    const d = parseISO(iso);
    return isValid(d) ? d : null;
};

const toNumber = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
};

/**
 * Parse the export's `sleep_phase_5_min` into evenly spaced epochs.
 * Accepts a list of `{timestamp, value}`, a bare list of codes, a digit string,
 * or an `{items, timestamp}` object.
 */
function parsePhases(raw: unknown, startTime: string | null | undefined): { start: Date | null; epochs: Epoch[] } {
    let items: unknown[] | null = null;
    let start: Date | null = parseDate(startTime);

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

/**
 * Parse `hr_data` / `hrv_data` (a list of `{timestamp, bpm|value}`, optionally
 * JSON-encoded or wrapped in `{items}`) into samples relative to `origin`.
 */
function parseSamples(raw: unknown, origin: Date | null): Sample[] {
    if (!origin) return [];
    let items: unknown = raw;
    if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch { return []; }
    }
    if (isRecord(items) && Array.isArray(items.items)) items = items.items;
    if (!Array.isArray(items)) return [];
    const out: Sample[] = [];
    for (const item of items) {
        if (!isRecord(item) || typeof item.timestamp !== 'string') continue;
        const ts = parseISO(item.timestamp);
        if (!isValid(ts)) continue;
        const v = toNumber(item.bpm ?? item.value);
        out.push({ t: (ts.getTime() - origin.getTime()) / 60_000, v });
    }
    return out.sort((a, b) => a.t - b.t);
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
    /** ISO start of the night (`bedtime_start` / `start_time`); also the x-axis origin. */
    startTime?: string | null;
    /** ISO end of the night (`bedtime_end`); extends the x-axis to the wake-up time. */
    endTime?: string | null;
    /** Day label for the accessible name. */
    dayLabel?: string;
    /** Hide the legend (compact variant). */
    compact?: boolean;
    /** Which overlay lines to show; omit (or null) to hide the overlay chart entirely. */
    overlay?: HypnogramOverlay | null;
    hrData?: unknown;
    hrvData?: unknown;
    lowestHeartRate?: number | null;
    /** Personal p25-p75 of nightly lowest HR / average HRV (last 90 nights). */
    typicalHr?: TypicalRange | null;
    typicalHrv?: TypicalRange | null;
}

type StagePoint = { x: number; y: string };
type SamplePoint = { x: number; y: number | null };
type StageChart = ChartJS<'line', StagePoint[], unknown>;
type SampleChart = ChartJS<'line', SamplePoint[], unknown>;

/** The slice of the Chart.js API the hover sync needs (the two charts have different data types). */
interface SyncChart {
    scales: Record<string, Scale>;
    chartArea: ChartArea;
    tooltip?: { setActiveElements(active: ActiveDataPoint[], eventPosition: Point): void };
    setActiveElements(active: ActiveDataPoint[]): void;
    getDatasetMeta(index: number): { data: ChartElement[] };
    update(mode?: UpdateMode): void;
    draw(): void;
}

export function HypnogramCanvas({
    phases,
    startTime,
    endTime,
    dayLabel,
    compact = false,
    overlay = null,
    hrData,
    hrvData,
    lowestHeartRate,
    typicalHr,
    typicalHrv,
}: HypnogramCanvasProps) {
    const isDark = useIsDark();

    const { origin, epochs, runs, totals, totalMin, xMin, xMax } = useMemo(() => {
        const parsed = parsePhases(phases, startTime);
        // The x-axis origin is bedtime_start when known, else the first epoch.
        const bedStart = parseDate(startTime);
        const origin = bedStart ?? parsed.start;
        const shift = origin && parsed.start ? Math.round((parsed.start.getTime() - origin.getTime()) / 60_000) : 0;
        const epochs = parsed.epochs.map(e => ({ t: e.t + shift, stage: e.stage }));
        const runs = buildRuns(epochs);
        const totals: Record<StageMeta['key'], number> = { awake: 0, rem: 0, light: 0, deep: 0 };
        for (const r of runs) totals[r.stage.key] += r.endMin - r.startMin;
        const totalMin = runs.length ? runs[runs.length - 1].endMin - runs[0].startMin : 0;
        const bedEnd = parseDate(endTime);
        const epochEnd = epochs.length ? epochs[epochs.length - 1].t + EPOCH_MIN : 0;
        const xMin = Math.min(0, epochs.length ? epochs[0].t : 0);
        const xMax = Math.max(epochEnd, origin && bedEnd ? (bedEnd.getTime() - origin.getTime()) / 60_000 : 0);
        return { origin, epochs, runs, totals, totalMin, xMin, xMax };
    }, [phases, startTime, endTime]);

    const hr = useMemo(() => (overlay ? parseSamples(hrData, origin) : []), [overlay, hrData, origin]);
    const hrv = useMemo(() => (overlay ? parseSamples(hrvData, origin) : []), [overlay, hrvData, origin]);
    const hrStats = useMemo(() => seriesStats(hr.map(s => s.v)), [hr]);
    const hrvStats = useMemo(() => seriesStats(hrv.map(s => s.v)), [hrv]);
    const lowest = useMemo(() => {
        let best: Sample | null = null;
        for (const s of hr) if (s.v !== null && (best === null || s.v < (best.v ?? Infinity))) best = s;
        if (!best) return null;
        const value = typeof lowestHeartRate === 'number' && Number.isFinite(lowestHeartRate) ? lowestHeartRate : best.v;
        return { t: best.t, value: value ?? best.v ?? 0 };
    }, [hr, lowestHeartRate]);

    const clock = useCallback((min: number): string => {
        if (!origin) {
            const h = Math.floor(min / 60);
            const m = Math.round(min % 60);
            return `${h}:${m.toString().padStart(2, '0')}`;
        }
        return format(new Date(origin.getTime() + min * 60_000), 'HH:mm');
    }, [origin]);

    // Points sit at the END of each epoch so `stepped: 'before'` draws epoch i at y_i
    // over [t_i, t_i + 5min]; a leading point anchors the first epoch's start.
    const points = useMemo(() => {
        if (epochs.length === 0) return [];
        const first = epochs[0];
        const pts: StagePoint[] = [{ x: first.t, y: stageByCode(first.stage).label }];
        for (const e of epochs) pts.push({ x: e.t + EPOCH_MIN, y: stageByCode(e.stage).label });
        return pts;
    }, [epochs]);

    const hasOverlay = !!overlay && epochs.length > 0 && (hr.length > 0 || hrv.length > 0);
    const showHr = hasOverlay && overlay.hr && hr.length > 0;
    const showHrv = hasOverlay && overlay.hrv && hrv.length > 0;

    // Table of the plotted series: one row per 5-minute epoch.
    const table = useMemo<ChartTable | null>(() => {
        if (epochs.length === 0) return null;
        const columns = ['Time', 'Stage'];
        if (hr.length) columns.push('HR (bpm)');
        if (hrv.length) columns.push('HRV (ms)');
        const stageAt = new Map(epochs.map(e => [e.t, stageByCode(e.stage).label]));
        const hrXs = hr.map(s => s.t);
        const hrvXs = hrv.map(s => s.t);
        const sampleAt = (samples: Sample[], xs: number[], t: number): string => {
            const i = nearestIndex(xs, t);
            if (i < 0 || Math.abs(xs[i] - t) > EPOCH_MIN / 2) return '';
            const v = samples[i].v;
            return v === null ? '' : String(Math.round(v * 10) / 10);
        };
        const rows: string[][] = [];
        for (let t = Math.floor(xMin / EPOCH_MIN) * EPOCH_MIN; t < xMax; t += EPOCH_MIN) {
            const row = [clock(t), stageAt.get(t) ?? ''];
            if (hr.length) row.push(sampleAt(hr, hrXs, t));
            if (hrv.length) row.push(sampleAt(hrv, hrvXs, t));
            rows.push(row);
        }
        return { columns, rows };
    }, [epochs, hr, hrv, xMin, xMax, clock]);
    const viewAsTable = useChartTable(table);

    // --- Hover sync between the two stacked charts -------------------------
    const stageRef = useRef<StageChart | null>(null);
    const sampleRef = useRef<SampleChart | null>(null);
    const hoverXRef = useRef<number | null>(null);
    const stageXs = useMemo(() => points.map(p => p.x), [points]);
    const hrXs = useMemo(() => hr.map(s => s.t), [hr]);
    const hrvXs = useMemo(() => hrv.map(s => s.t), [hrv]);

    const clearSibling = useCallback((chart: SyncChart | null) => {
        if (!chart) return;
        chart.setActiveElements([]);
        chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
        chart.update('none');
    }, []);

    const activateSibling = useCallback((chart: SyncChart | null, datasetIndex: number, index: number, x: number, y: number) => {
        if (!chart || index < 0) return;
        const element = chart.getDatasetMeta(datasetIndex).data[index];
        if (!element) return;
        const active: ActiveElement[] = [{ datasetIndex, index, element }];
        chart.setActiveElements(active);
        chart.tooltip?.setActiveElements(active, { x, y });
        chart.update('none');
    }, []);

    /** Vertical hover line on both charts at the shared x value (state comes from `options.plugins.sleepCrosshair`). */
    const crosshairPlugin = useMemo<Plugin<'line', CrosshairOptions>>(() => ({
        id: 'sleepCrosshair',
        afterDraw: (chart, _args, opts) => {
            const xVal = hoverXRef.current;
            if (xVal === null || !opts?.enabled) return;
            const { ctx, chartArea, scales } = chart;
            const x = scales.x?.getPixelForValue(xVal);
            if (x === undefined || x < chartArea.left || x > chartArea.right) return;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top);
            ctx.lineTo(x, chartArea.bottom);
            ctx.lineWidth = 1;
            ctx.strokeStyle = opts.color;
            ctx.stroke();
            ctx.restore();
        },
    }), []);

    const runForMinute = useCallback((min: number): Run | undefined =>
        runs.find(r => min > r.startMin && min <= r.endMin) ?? runs.find(r => min >= r.startMin && min < r.endMin), [runs]);

    /** Hover on the hypnogram -> highlight the nearest HR/HRV sample. */
    const onStageHover = useCallback((event: ChartEvent, _els: ActiveElement[], chart: SyncChart) => {
        if (!hasOverlay) return;
        if (event.type === 'mouseout' || event.x === null || event.y === null) {
            hoverXRef.current = null;
            clearSibling(sampleRef.current);
            chart.draw();
            return;
        }
        const xVal = chart.scales.x.getValueForPixel(event.x);
        if (xVal === undefined) return;
        hoverXRef.current = xVal;
        const sibling = sampleRef.current;
        if (!sibling) return;
        const useHr = showHr || !showHrv;
        const xs = useHr ? hrXs : hrvXs;
        const datasetIndex = useHr ? 0 : 1;
        const index = nearestIndex(xs, xVal);
        const y = sibling.chartArea ? (sibling.chartArea.top + sibling.chartArea.bottom) / 2 : event.y;
        activateSibling(sibling, datasetIndex, index, sibling.scales.x.getPixelForValue(xs[index] ?? xVal), y);
    }, [hasOverlay, showHr, showHrv, hrXs, hrvXs, clearSibling, activateSibling]);

    /** Hover on the overlay -> highlight the matching hypnogram epoch. */
    const onSampleHover = useCallback((event: ChartEvent, _els: ActiveElement[], chart: SyncChart) => {
        if (event.type === 'mouseout' || event.x === null || event.y === null) {
            hoverXRef.current = null;
            clearSibling(stageRef.current);
            chart.draw();
            return;
        }
        const xVal = chart.scales.x.getValueForPixel(event.x);
        if (xVal === undefined) return;
        hoverXRef.current = xVal;
        const sibling = stageRef.current;
        if (!sibling) return;
        const index = nearestIndex(stageXs, xVal);
        const y = sibling.chartArea ? (sibling.chartArea.top + sibling.chartArea.bottom) / 2 : event.y;
        activateSibling(sibling, 0, index, sibling.scales.x.getPixelForValue(stageXs[index] ?? xVal), y);
    }, [stageXs, clearSibling, activateSibling]);

    if (epochs.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed p-4 text-center">
                <span className="text-sm font-medium text-foreground">No sleep recorded</span>
                <span className="mt-1 text-xs text-muted-foreground">No sleep stages for this day</span>
            </div>
        );
    }

    const asleepMin = totals.deep + totals.light + totals.rem;
    const ariaLabel = `Hypnogram${dayLabel ? ` for ${dayLabel}` : ''}: ${formatMinutes(asleepMin)} asleep. ` +
        STAGES.map(s => `${s.label} ${formatMinutes(totals[s.key])}`).join(', ') + '.';

    if (viewAsTable && table) {
        return <SeriesTable table={table} caption={ariaLabel} />;
    }

    const theme = chartTheme(isDark);
    const gridColor = theme.grid;
    const tickColor = theme.tick;
    const tickFont = theme.tickFont;
    const inkColor = theme.ink;
    const crosshairColor = theme.hoverLine;
    const tooltipStyle = theme.tooltip;

    const stageData = {
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

    const xScale = (showTicks: boolean): NonNullable<ChartOptions<'line'>['scales']>['x'] => ({
        type: 'linear',
        min: xMin,
        max: xMax,
        grid: { color: gridColor, drawTicks: false },
        border: { display: false },
        ticks: {
            display: showTicks,
            color: tickColor,
            font: tickFont,
            stepSize: 60,
            maxRotation: 0,
            autoSkip: true,
            callback: (v) => clock(Number(v)),
        },
    });

    const stageOptions: ChartOptions<'line'> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        parsing: { xAxisKey: 'x', yAxisKey: 'y' },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        layout: { padding: { right: hasOverlay ? RIGHT_AXIS_PX : 0 } },
        onHover: onStageHover,
        plugins: {
            hypnogramBands: { runs: runs.map(r => ({ startMin: r.startMin, endMin: r.endMin, label: r.stage.label, color: r.stage.color })), labels: Y_LABELS },
            sleepCrosshair: { enabled: hasOverlay, color: crosshairColor },
            legend: { display: false },
            tooltip: {
                enabled: true,
                displayColors: false,
                ...tooltipStyle,
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
            x: xScale(!hasOverlay),
            y: {
                type: 'category',
                labels: Y_LABELS,
                offset: true,
                grid: { color: gridColor, drawTicks: false },
                border: { display: false },
                ticks: { color: tickColor, font: tickFont },
                afterFit: (scale) => { if (hasOverlay) scale.width = LEFT_AXIS_PX; },
            },
        },
    };

    // --- Overlay chart ------------------------------------------------------
    const sampleData = {
        datasets: [
            {
                label: 'HR',
                data: hr.map((s): SamplePoint => ({ x: s.t, y: s.v })),
                yAxisID: 'y',
                borderColor: inkColor,
                borderWidth: 1.5,
                pointRadius: 0,
                pointHoverRadius: 3,
                pointHoverBackgroundColor: inkColor,
                spanGaps: false,
                hidden: !showHr,
            },
            {
                label: 'HRV',
                data: hrv.map((s): SamplePoint => ({ x: s.t, y: s.v })),
                yAxisID: 'y1',
                borderColor: HRV_COLOR,
                borderDash: [4, 3],
                borderWidth: 1.5,
                pointRadius: 0,
                pointHoverRadius: 3,
                pointHoverBackgroundColor: HRV_COLOR,
                spanGaps: false,
                hidden: !showHrv,
            },
        ],
    };

    const sampleOptions: ChartOptions<'line'> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        parsing: { xAxisKey: 'x', yAxisKey: 'y' },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        onHover: onSampleHover,
        plugins: {
            sleepCrosshair: { enabled: hasOverlay, color: crosshairColor },
            typicalRange: {
                left: showHr && typicalHr ? { low: typicalHr.low, high: typicalHr.high } : null,
                leftColor: inkColor,
                right: showHrv && typicalHrv ? { low: typicalHrv.low, high: typicalHrv.high } : null,
                rightColor: HRV_COLOR,
            },
            lowestPoint: {
                enabled: showHr && lowest !== null,
                x: lowest?.t ?? 0,
                y: lowest?.value ?? 0,
                label: lowest ? `Lowest ${Math.round(lowest.value)} bpm · ${clock(lowest.t)}` : '',
                color: inkColor,
            },
            legend: { display: false },
            tooltip: {
                enabled: true,
                displayColors: false,
                ...tooltipStyle,
                callbacks: {
                    title: (items) => (items[0] ? clock(items[0].parsed.x ?? 0) : ''),
                    label: (item) => {
                        const v = item.parsed.y;
                        if (v === null || v === undefined) return `${item.dataset.label}: —`;
                        return item.datasetIndex === 0 ? `HR ${Math.round(v)} bpm` : `HRV ${Math.round(v)} ms`;
                    },
                },
            },
        },
        scales: {
            x: xScale(true),
            y: {
                type: 'linear',
                position: 'left',
                display: true,
                grid: { color: gridColor, drawTicks: false },
                border: { display: false },
                ticks: { display: showHr, color: tickColor, font: tickFont, maxTicksLimit: 4 },
                afterFit: (scale) => { scale.width = LEFT_AXIS_PX; },
                suggestedMin: typicalHr && showHr ? Math.floor(typicalHr.low - 2) : undefined,
                suggestedMax: typicalHr && showHr ? Math.ceil(typicalHr.high + 2) : undefined,
            },
            y1: {
                type: 'linear',
                position: 'right',
                display: true,
                grid: { display: false, drawTicks: false },
                border: { display: false },
                ticks: { display: showHrv, color: HRV_COLOR, font: tickFont, maxTicksLimit: 4 },
                afterFit: (scale) => { scale.width = RIGHT_AXIS_PX; },
                suggestedMin: typicalHrv && showHrv ? Math.floor(typicalHrv.low - 2) : undefined,
                suggestedMax: typicalHrv && showHrv ? Math.ceil(typicalHrv.high + 2) : undefined,
            },
        },
    };

    const overlayAria = [
        hrStats ? `Heart rate during sleep: lowest ${Math.round(hrStats.min)}${lowest ? ` bpm at ${clock(lowest.t)}` : ' bpm'}, average ${Math.round(hrStats.avg)}, highest ${Math.round(hrStats.max)} bpm.` : '',
        hrvStats ? `HRV: lowest ${Math.round(hrvStats.min)}, average ${Math.round(hrvStats.avg)}, highest ${Math.round(hrvStats.max)} ms.` : '',
    ].filter(Boolean).join(' ');

    const typicalHint = (band: TypicalRange, unit: string) =>
        `Typical range: p25–p75 of your last ${band.n} nights (${Math.round(band.low)}–${Math.round(band.high)} ${unit})`;

    return (
        <div className="h-full w-full flex flex-col min-h-0">
            <div className="min-h-0" style={{ flex: hasOverlay ? '3 1 0%' : '1 1 0%' }} role="img" aria-label={ariaLabel}>
                <Line ref={stageRef} data={stageData} options={stageOptions} plugins={[hypnogramBandsPlugin, crosshairPlugin]} />
            </div>
            {hasOverlay && (
                <div className="min-h-0" style={{ flex: '2 1 0%' }} role="img" aria-label={overlayAria || 'Heart rate and HRV during sleep'}>
                    <Line ref={sampleRef} data={sampleData} options={sampleOptions} plugins={[typicalRangePlugin, crosshairPlugin, lowestPointPlugin]} />
                </div>
            )}
            {!compact && (
                <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-xs text-muted-foreground" aria-hidden="true">
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
                    {showHr && typicalHr && (
                        <li className="flex items-center gap-1.5" title={typicalHint(typicalHr, 'bpm')}>
                            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: withAlpha(inkColor, 0.18) }} />
                            <span className="text-foreground/80">Typical HR</span>
                            <span className="tabular-nums">{Math.round(typicalHr.low)}–{Math.round(typicalHr.high)} bpm</span>
                        </li>
                    )}
                    {showHrv && typicalHrv && (
                        <li className="flex items-center gap-1.5" title={typicalHint(typicalHrv, 'ms')}>
                            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: withAlpha(HRV_COLOR, 0.25) }} />
                            <span className="text-foreground/80">Typical HRV</span>
                            <span className="tabular-nums">{Math.round(typicalHrv.low)}–{Math.round(typicalHrv.high)} ms</span>
                        </li>
                    )}
                </ul>
            )}
        </div>
    );
}
