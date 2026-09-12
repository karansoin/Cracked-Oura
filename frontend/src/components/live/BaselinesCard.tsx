import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useIsDark } from '@/components/theme-provider';
import { toastError } from '@/contexts/AppStatusContext';
import { liveApi, type BaselineSignal, type Baselines } from '@/lib/live-api';
import { cn } from '@/lib/utils';
import { TraceCanvas, type TracePoint } from './TraceCanvas';

const SIGNAL_META: Record<string, { label: string; unit: string; decimals: number }> = {
    resting_hr: { label: 'Resting HR', unit: 'bpm', decimals: 0 },
    lnrmssd: { label: 'HRV (ln RMSSD)', unit: '', decimals: 2 },
    temp_deviation: { label: 'Skin temp deviation', unit: '°C', decimals: 2 },
    breathing_rate: { label: 'Breathing rate', unit: '/min', decimals: 1 },
    sleep_hours: { label: 'Sleep', unit: 'h', decimals: 1 },
};

function Strip({ name, sig }: { name: string; sig: BaselineSignal }) {
    const isDark = useIsDark();
    const meta = SIGNAL_META[name] ?? { label: name, unit: '', decimals: 1 };
    const points = useMemo<TracePoint[]>(() => sig.values.map(([, v], i) => ({ t: i, v: v ?? null })), [sig.values]);
    const alarm = !!sig.alarm;
    const color = alarm ? (isDark ? '#F07F3C' : '#D55E00') : (isDark ? '#5AA9E6' : '#0072B2');
    const guides = sig.mean_ref != null && sig.sd_ref != null ? [{ y: sig.mean_ref, label: 'usual' }, { y: sig.mean_ref + sig.sd_ref }, { y: sig.mean_ref - sig.sd_ref }] : [];
    const z = sig.z_recent;
    return (
        <div className={cn('rounded-md border px-3 py-2', alarm && 'border-[#D55E00]/50')}>
            <div className="flex items-baseline gap-2">
                <p className="text-sm font-medium">{meta.label}</p>
                {sig.insufficient ? (
                    <p className="text-xs text-muted-foreground">needs {sig.needed} nights ({sig.n_ref} so far)</p>
                ) : (
                    <>
                        <p className="text-sm tabular-nums">{sig.last?.toFixed(meta.decimals)}{meta.unit && <span className="ml-0.5 text-xs text-muted-foreground">{meta.unit}</span>}</p>
                        <p className="text-xs text-muted-foreground">7-night mean {sig.recent_mean?.toFixed(meta.decimals)} vs usual {sig.mean_ref?.toFixed(meta.decimals)} ± {sig.sd_ref?.toFixed(meta.decimals)}</p>
                        {z != null && <Badge variant={alarm ? 'destructive' : Math.abs(z) >= 1 ? 'secondary' : 'outline'} className="ml-auto h-5 px-1.5 text-[10px] tabular-nums">z {z >= 0 ? '+' : ''}{z.toFixed(1)}{alarm ? ' · sustained shift' : ''}</Badge>}
                    </>
                )}
            </div>
            {!sig.insufficient && <div className="mt-1"><TraceCanvas points={points} color={color} height={64} guides={guides} ariaLabel={`${meta.label} over the last ${points.length} nights`} /></div>}
        </div>
    );
}

/** Overnight baselines from synced or imported nights: z-scores against your own 60-night reference and CUSUM shift alerts. */
export function BaselinesCard() {
    const [data, setData] = useState<Baselines | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        liveApi.baselines(90).then(d => { if (!cancelled) setData(d); }).catch(err => { if (!cancelled) { setError('Could not load baselines'); toastError('Baselines', err); } });
        return () => { cancelled = true; };
    }, []);
    const status = data?.status;
    return (
        <Card>
            <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-sm">Overnight baselines</CardTitle>
                    {data?.readiness != null && (
                        <Badge variant={status === 'watch' ? 'destructive' : 'secondary'} className="tabular-nums">
                            {status === 'watch' ? 'Watch' : status === 'easy' ? 'Take it easy' : 'Ready'} · {data.readiness}
                        </Badge>
                    )}
                </div>
                <CardDescription>
                    {error ?? (data ? (data.nights < 14 ? `${data.nights} nights stored; baselines need 14.` : `${data.nights} nights · last ${data.latest_day ?? '—'}. Each signal is compared with your own trailing 60 nights.`) : 'Loading…')}
                </CardDescription>
            </CardHeader>
            {data && (
                <CardContent className="flex flex-col gap-2">
                    {data.alarms.length > 0 && (
                        <p className="rounded-md border border-[#D55E00]/40 bg-[#D55E00]/10 px-3 py-2 text-xs">
                            Sustained shift in {data.alarms.map(a => SIGNAL_META[a.signal]?.label ?? a.signal).join(', ')}. Your overnight numbers are outside their usual range; nothing more than that is claimed. {data.false_alarm_note}
                        </p>
                    )}
                    {Object.entries(data.signals).map(([name, sig]) => <Strip key={name} name={name} sig={sig} />)}
                    <p className="rounded bg-muted/60 px-2 py-1 font-mono text-[11px] leading-relaxed text-muted-foreground">{data.formula}</p>
                </CardContent>
            )}
        </Card>
    );
}
