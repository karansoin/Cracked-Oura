import { useEffect, useMemo, useState } from 'react';
import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';
import { Copy, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { WidgetSkeleton } from '@/components/widgets/WidgetSkeleton';
import { SeriesTable } from '@/components/widgets/SeriesTable';
import { TrendsChart, type XY } from './TrendsChart';
import { TrendsRangeSelector } from './TrendsRangeSelector';
import { BaselinesCard } from '@/components/live/BaselinesCard';
import { useDashboard } from '@/contexts/DashboardContext';
import { useAppStatus } from '@/contexts/AppStatusContext';
import { api } from '@/lib/api';
import { SERIES_PALETTE } from '@/lib/bands';
import { aggregateDailySeries } from '@/lib/data-processing';
import { METRIC_GROUPS, TREND_METRICS, formatMetricValue, formatMetricWithUnit, metricFor, metricUnit, type MetricDef } from '@/lib/metrics';
import { copyTableAsCsv, interquartileBand, pearson, rollingMean, seriesStats, type ChartTable } from '@/lib/series-table';
import { AGGREGATION_LABEL, autoAggregation, dayIndex, rangeDef, type Aggregation, type ResolvedAggregation } from '@/lib/trends';

const ISO = 'yyyy-MM-dd';
const BASELINE_DAYS = 90;
const ROLLING_DAYS = 7;
const PRIMARY_COLOR = SERIES_PALETTE[0];
const SECONDARY_COLOR = SERIES_PALETTE[1];

type DailyMap = Map<string, number | null>;

interface DailyRow {
    date: string;
    x: number;
    value: number | null;
    secondary: number | null;
}

/** Query rows -> per-day map (later rows win, so `long_sleep` beats naps). */
function toDaily(rows: Array<{ date: string; value: unknown }>): DailyMap {
    const out: DailyMap = new Map();
    for (const row of rows) {
        const value = typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : null;
        out.set(row.date.split('T')[0], value);
    }
    return out;
}

const mean = (values: Array<number | null>): number | null => seriesStats(values)?.avg ?? null;

interface TrendsViewProps {
    /** Latest day with data (`yyyy-MM-dd`); the range ends here (today when unknown). */
    latestDate?: string;
}

export function TrendsView({ latestDate }: TrendsViewProps) {
    const { trends, updateTrends, selectedDate, setSelectedDate } = useDashboard();
    const { units } = useAppStatus();
    const [viewAsTable, setViewAsTable] = useState(false);

    const metric: MetricDef = metricFor(trends.metric) ?? TREND_METRICS[0];
    const secondaryMetric = trends.secondary ? metricFor(trends.secondary) ?? null : null;
    const range = rangeDef(trends.range);

    // Window: ends on the latest day with data; fetch extra history for the baseline,
    // the previous-period comparison and the rolling-average warm-up.
    const endIso = latestDate ?? format(new Date(), ISO);
    const startIso = range.days ? format(addDays(parseISO(endIso), -(range.days - 1)), ISO) : null;
    const fetchStartIso = range.days
        ? format(addDays(parseISO(endIso), -(range.days - 1) - Math.max(BASELINE_DAYS, range.days) - ROLLING_DAYS), ISO)
        : undefined;

    // The fetched series is tagged with the request it answers; a mismatch means "loading".
    const secondaryKey = secondaryMetric?.key ?? null;
    const requestKey = `${metric.key}|${secondaryKey ?? ''}|${fetchStartIso ?? ''}|${endIso}`;
    const [series, setSeries] = useState<{ key: string; primary: DailyMap; secondary: DailyMap | null } | null>(null);
    const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
    const loading = series?.key !== requestKey && failure?.key !== requestKey;
    const error = failure?.key === requestKey ? failure.message : null;

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            api.getQuery(metric.key, fetchStartIso, endIso),
            secondaryKey ? api.getQuery(secondaryKey, fetchStartIso, endIso) : Promise.resolve(null),
        ]).then(([primary, secondary]) => {
            if (cancelled) return;
            setSeries({ key: requestKey, primary: toDaily(primary), secondary: secondary ? toDaily(secondary) : null });
        }).catch((err: unknown) => {
            if (cancelled) return;
            setFailure({ key: requestKey, message: err instanceof Error ? err.message : 'Failed to load trend' });
        });
        return () => { cancelled = true; };
    }, [metric.key, secondaryKey, fetchStartIso, endIso, requestKey]);

    const model = useMemo(() => {
        if (!series || series.key !== requestKey) return null;
        // Continuous daily rows from the fetch start (or the first known day for "All") to the end.
        const known = [...series.primary.keys(), ...(series.secondary ? series.secondary.keys() : [])].sort();
        const firstIso = fetchStartIso ?? known[0] ?? endIso;
        const total = differenceInCalendarDays(parseISO(endIso), parseISO(firstIso)) + 1;
        if (total <= 0) return null;
        const rows: DailyRow[] = [];
        for (let i = 0; i < total; i++) {
            const date = format(addDays(parseISO(firstIso), i), ISO);
            rows.push({ date, x: dayIndex(date), value: series.primary.get(date) ?? null, secondary: series.secondary?.get(date) ?? null });
        }
        const rolling = rollingMean(rows.map(r => r.value), ROLLING_DAYS);
        const rollingSecondary = series.secondary ? rollingMean(rows.map(r => r.secondary), ROLLING_DAYS) : null;

        const visibleFrom = startIso ? rows.findIndex(r => r.date >= startIso) : 0;
        const visible = rows.slice(Math.max(0, visibleFrom));
        if (visible.length === 0) return null;
        const spanDays = differenceInCalendarDays(parseISO(endIso), parseISO(visible[0].date)) + 1;
        const aggregation: ResolvedAggregation = trends.aggregation === 'auto' ? autoAggregation(trends.range, spanDays) : trends.aggregation;

        const bucketLine = (key: 'value' | 'secondary'): XY[] => {
            const points = visible.map(r => ({ date: r.date, value: r[key] }));
            const buckets = aggregateDailySeries(points, ['value'], aggregation === 'week' ? 'week' : 'month', 'avg');
            return buckets.map(b => ({ x: dayIndex(b.date), y: b.value }));
        };
        const line: XY[] = aggregation === 'day'
            ? visible.map((r, i) => ({ x: r.x, y: rolling[visibleFrom + i] }))
            : bucketLine('value');
        const secondaryLine: XY[] | null = series.secondary
            ? (aggregation === 'day' ? visible.map((r, i) => ({ x: r.x, y: rollingSecondary?.[visibleFrom + i] ?? null })) : bucketLine('secondary'))
            : null;

        const values = visible.map(r => r.value);
        const stats = seriesStats(values);
        const latest = [...visible].reverse().find(r => r.value !== null) ?? null;
        const baselineFrom = format(addDays(parseISO(endIso), -(BASELINE_DAYS - 1)), ISO);
        const baseline = interquartileBand(rows.filter(r => r.date >= baselineFrom).map(r => r.value), 7);

        let previousMean: number | null = null;
        if (startIso && range.days) {
            const prevEnd = format(addDays(parseISO(startIso), -1), ISO);
            const prevStart = format(addDays(parseISO(startIso), -range.days), ISO);
            previousMean = mean(rows.filter(r => r.date >= prevStart && r.date <= prevEnd).map(r => r.value));
        }
        const correlation = series.secondary ? pearson(values, visible.map(r => r.secondary)) : null;

        return {
            visible,
            points: visible.map((r): XY => ({ x: r.x, y: r.value })),
            line,
            secondaryLine,
            aggregation,
            stats,
            latest,
            baseline,
            previousMean,
            correlation,
            xMin: visible[0].x,
            xMax: visible[visible.length - 1].x,
            hasValues: values.some(v => v !== null),
        };
    }, [series, requestKey, fetchStartIso, endIso, startIso, trends.aggregation, trends.range, range.days]);

    const table = useMemo<ChartTable | null>(() => {
        if (!model) return null;
        const lineByX = new Map(model.line.map(p => [p.x, p.y]));
        const secondaryByX = model.secondaryLine ? new Map(model.secondaryLine.map(p => [p.x, p.y])) : null;
        const columns = ['Date', metric.label, AGGREGATION_LABEL[model.aggregation]];
        if (secondaryMetric) columns.push(secondaryMetric.label, `${secondaryMetric.label} (${AGGREGATION_LABEL[model.aggregation].toLowerCase()})`);
        const rows = model.visible.map(r => {
            const row = [r.date, formatMetricValue(r.value, metric.kind, units), formatMetricValue(lineByX.get(r.x) ?? null, metric.kind, units)];
            if (secondaryMetric) {
                row.push(formatMetricValue(r.secondary, secondaryMetric.kind, units), formatMetricValue(secondaryByX?.get(r.x) ?? null, secondaryMetric.kind, units));
            }
            return row.map(c => (c === '—' ? '' : c));
        });
        return { columns, rows };
    }, [model, metric, secondaryMetric, units]);

    const selectedX = dayIndex(format(selectedDate, ISO));

    // Header pieces -----------------------------------------------------------
    const latestText = model?.latest ? formatMetricWithUnit(model.latest.value, metric.kind, units) : '—';
    const avgText = model?.stats ? formatMetricWithUnit(model.stats.avg, metric.kind, units) : '—';
    const delta = (() => {
        if (!model?.stats || model.previousMean === null || !range.days) return null;
        const current = model.stats.avg;
        const previous = model.previousMean;
        if (metric.kind === 'temp_dev') {
            const diff = current - previous;
            const text = formatMetricValue(diff, metric.kind, units);
            return { arrow: diff > 0 ? '↑' : diff < 0 ? '↓' : '→', text, diff };
        }
        if (previous === 0) return null;
        const pct = ((current - previous) / Math.abs(previous)) * 100;
        return { arrow: pct > 0.05 ? '↑' : pct < -0.05 ? '↓' : '→', text: `${Math.abs(pct).toFixed(pct < 10 ? 1 : 0)}%`, diff: pct };
    })();

    const ariaLabel = model?.stats
        ? `${metric.label} over the last ${range.short}: latest ${latestText}, average ${avgText}, min ${formatMetricWithUnit(model.stats.min, metric.kind, units)}, max ${formatMetricWithUnit(model.stats.max, metric.kind, units)}.`
        : `${metric.label}: no values in the last ${range.short}.`;

    const selectMetric = (value: string) => updateTrends({ metric: value });
    const selectSecondary = (value: string) => updateTrends({ secondary: value === 'none' ? null : value });
    const selectAggregation = (value: string) => {
        if (value === 'auto' || value === 'day' || value === 'week' || value === 'month') updateTrends({ aggregation: value as Aggregation });
    };

    const metricOptions = (exclude?: string) => METRIC_GROUPS.map(group => (
        <SelectGroup key={group}>
            <SelectLabel>{group}</SelectLabel>
            {TREND_METRICS.filter(m => m.group === group && m.key !== exclude).map(m => (
                <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>
            ))}
        </SelectGroup>
    ));

    const renderBody = () => {
        if (loading) return <WidgetSkeleton kind="chart" />;
        if (error) {
            return (
                <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed border-destructive/40 p-4 text-center" role="alert">
                    <span className="text-sm font-medium">Couldn't load this metric</span>
                    <span className="mt-1 max-w-[320px] truncate text-xs text-muted-foreground" title={error}>{error}</span>
                </div>
            );
        }
        if (!model || !model.hasValues) {
            return (
                <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed p-4 text-center" role="img" aria-label={ariaLabel}>
                    <span className="text-sm font-medium text-foreground">No values in the last {range.short}</span>
                    <span className="mt-1 text-xs text-muted-foreground">Days synced from the ring have no scores yet — try a longer range or another metric</span>
                </div>
            );
        }
        if (viewAsTable && table) return <SeriesTable table={table} caption={ariaLabel} />;
        return (
            <TrendsChart
                points={model.points}
                line={model.line}
                lineLabel={AGGREGATION_LABEL[model.aggregation]}
                kind={metric.kind}
                metricLabel={metric.label}
                color={PRIMARY_COLOR}
                band={model.baseline}
                secondary={secondaryMetric && model.secondaryLine ? {
                    line: model.secondaryLine,
                    label: `${secondaryMetric.label} (${AGGREGATION_LABEL[model.aggregation].toLowerCase()})`,
                    kind: secondaryMetric.kind,
                    color: SECONDARY_COLOR,
                } : null}
                xMin={model.xMin}
                xMax={model.xMax}
                selectedX={selectedX}
                onPointClick={(iso) => setSelectedDate(parseISO(iso))}
                units={units}
                ariaLabel={ariaLabel}
            />
        );
    };

    return (
        <div className="flex min-h-full flex-col gap-4">
            {/* Toolbar: what to plot, over which window */}
            <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="trends-metric" className="text-xs text-muted-foreground">Metric</Label>
                    <Select value={metric.key} onValueChange={selectMetric}>
                        <SelectTrigger id="trends-metric" className="w-[200px]"><SelectValue /></SelectTrigger>
                        <SelectContent>{metricOptions()}</SelectContent>
                    </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="trends-secondary" className="text-xs text-muted-foreground">Compare with</Label>
                    <Select value={secondaryMetric?.key ?? 'none'} onValueChange={selectSecondary}>
                        <SelectTrigger id="trends-secondary" className="w-[200px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            {metricOptions(metric.key)}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="trends-aggregation" className="text-xs text-muted-foreground">Aggregation</Label>
                    <Select value={trends.aggregation} onValueChange={selectAggregation}>
                        <SelectTrigger id="trends-aggregation" className="w-[150px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="auto">Auto{model ? ` (${model.aggregation === 'day' ? 'daily' : model.aggregation === 'week' ? 'weekly' : 'monthly'})` : ''}</SelectItem>
                            <SelectItem value="day">Daily</SelectItem>
                            <SelectItem value="week">Weekly means</SelectItem>
                            <SelectItem value="month">Monthly means</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="ml-auto flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground" id="trends-range-label">Range</span>
                    <TrendsRangeSelector value={trends.range} onChange={(range) => updateTrends({ range })} />
                </div>
            </div>

            <section className="flex min-h-[440px] flex-1 flex-col gap-3 rounded-lg border bg-card p-4" aria-labelledby="trends-heading">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h2 id="trends-heading" className="text-base font-medium leading-tight">{metric.label}</h2>
                        <p className="text-sm tabular-nums text-muted-foreground" aria-live="polite">
                            <span className="font-semibold text-foreground">Latest {latestText}</span>
                            {model?.latest && <span className="text-xs"> ({format(parseISO(model.latest.date), 'd MMM')})</span>}
                            <span className="mx-1.5">·</span>
                            <span className="font-semibold text-foreground">Avg {avgText}</span>
                            <span className="text-xs"> ({range.short})</span>
                        </p>
                        {delta && (
                            <span
                                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs tabular-nums text-muted-foreground"
                                title={`Average of this period vs the ${range.days} days before it`}
                            >
                                <span aria-hidden="true">{delta.arrow}</span>
                                <span className="sr-only">{delta.diff > 0 ? 'Up' : delta.diff < 0 ? 'Down' : 'Unchanged'}</span>
                                {delta.text} vs previous {range.days} days
                            </span>
                        )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <Button variant={viewAsTable ? 'secondary' : 'ghost'} size="sm" aria-pressed={viewAsTable} onClick={() => setViewAsTable(v => !v)}>
                            <Table2 className="h-3.5 w-3.5" aria-hidden="true" /> {viewAsTable ? 'View as chart' : 'View as table'}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => { void copyTableAsCsv(table, metric.label); }}>
                            <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Copy CSV
                        </Button>
                    </div>
                </div>

                <div className="min-h-[280px] flex-1">
                    {renderBody()}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <p>
                        Dots are daily values; the line is the {AGGREGATION_LABEL[model?.aggregation ?? 'day'].toLowerCase()}. The dashed marker is the selected day — click a dot to select that day.
                        {secondaryMetric && model && (
                            <span className="tabular-nums">
                                {' '}{model.correlation
                                    ? <>Pearson r = {model.correlation.r.toFixed(2)} · n = {model.correlation.n} days</>
                                    : <>Not enough overlapping days for a correlation</>}
                                {' '}<span className="italic">(correlation, not cause)</span>.
                            </span>
                        )}
                    </p>
                    {model?.baseline && (
                        <p className="shrink-0" title={`p25–p75 of the last ${model.baseline.n} days`}>
                            <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ backgroundColor: `${PRIMARY_COLOR}33` }} aria-hidden="true" />
                            Typical range {formatMetricValue(model.baseline.low, metric.kind, units)}–{formatMetricValue(model.baseline.high, metric.kind, units)}{metricUnit(metric.kind, units) && metric.kind !== 'temp_dev' ? ` ${metricUnit(metric.kind, units)}` : ''} (90 d)
                        </p>
                    )}
                </div>
            </section>
            <BaselinesCard />
        </div>
    );
}
