import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Chart as ChartJS,
    LinearScale,
    PointElement,
    LineElement,
    Tooltip,
    type ChartOptions,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { toast } from 'sonner';
import {
    AlertTriangle,
    BatteryMedium,
    Bluetooth,
    BluetoothOff,
    HeartPulse,
    Info,
    Loader2,
    Radar,
    RefreshCw,
    Trash2,
    XCircle,
    Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/dashboard/ConfirmDialog';
import { useAppStatus, toastError } from '@/contexts/AppStatusContext';
import { useIsDark } from '@/components/theme-provider';
import { api, type BleDevice, type BleState, type PairedRing } from '@/lib/api';
import { formatBytes, formatCount, formatElapsed, formatRelative, formatRelativeUnix } from '@/lib/format';
import { withAlpha } from '@/lib/bands';
import { chartTheme } from '@/lib/chart-theme';
import { cn } from '@/lib/utils';
import { useElementWidth } from '@/hooks/useElementWidth';

ChartJS.register(LinearScale, PointElement, LineElement, Tooltip);

const SCAN_SECONDS = 12;
const LIVE_SECONDS = 60;
const BUSY: readonly BleState[] = ['scanning', 'connecting', 'pairing', 'authenticating', 'syncing', 'live'];

const STATE_LABEL: Record<BleState, string> = {
    idle: 'Idle',
    scanning: 'Scanning',
    connecting: 'Connecting',
    pairing: 'Pairing',
    authenticating: 'Authenticating',
    syncing: 'Syncing',
    live: 'Live heart rate',
    error: 'Error',
    unavailable: 'Bluetooth unavailable',
};

function RssiBars({ rssi }: { rssi: number | null }) {
    const level = rssi === null ? 0 : rssi >= -60 ? 4 : rssi >= -70 ? 3 : rssi >= -80 ? 2 : 1;
    return (
        <span className="inline-flex items-end gap-0.5 h-3" aria-label={rssi === null ? 'Signal unknown' : `Signal ${rssi} dBm`} title={rssi === null ? undefined : `${rssi} dBm`}>
            {[1, 2, 3, 4].map(i => (
                <span key={i} className={cn('w-1 rounded-sm', i <= level ? 'bg-foreground' : 'bg-muted-foreground/30')} style={{ height: `${i * 3}px` }} />
            ))}
        </span>
    );
}

function LiveHeartRateChart({ samples }: { samples: Array<{ t: number; bpm: number }> }) {
    const isDark = useIsDark();
    const theme = chartTheme(isDark);
    const t0 = samples[0]?.t ?? 0;
    const points = samples.map(s => ({ x: s.t - t0, y: s.bpm }));
    const latest = samples[samples.length - 1]?.bpm ?? null;
    const min = samples.length ? Math.min(...samples.map(s => s.bpm)) : null;
    const max = samples.length ? Math.max(...samples.map(s => s.bpm)) : null;

    const options: ChartOptions<'line'> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        plugins: { legend: { display: false }, tooltip: { enabled: true, ...theme.tooltip, displayColors: false, callbacks: { title: () => '', label: (c) => `${c.parsed.y ?? '—'} bpm at ${Math.round(c.parsed.x ?? 0)} s` } } },
        scales: {
            x: {
                type: 'linear',
                min: 0,
                grid: { display: false },
                border: { display: false },
                ticks: { color: theme.tick, font: theme.tickFont, maxRotation: 0, callback: (v) => `${v} s` },
            },
            y: {
                suggestedMin: 40,
                suggestedMax: 120,
                grid: { color: theme.grid, drawTicks: false },
                border: { display: false },
                ticks: { color: theme.tick, font: theme.tickFont, maxTicksLimit: 6 },
            },
        },
    };

    const data = {
        datasets: [{
            label: 'bpm',
            data: points,
            borderColor: '#D55E00',
            backgroundColor: withAlpha('#D55E00', 0.15),
            fill: true,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
        }],
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-baseline gap-4 text-sm">
                <span className="text-3xl font-semibold tabular-nums leading-none tracking-tight">{latest ?? '—'}<span className="ml-1 text-sm font-normal text-muted-foreground">bpm</span></span>
                {min !== null && max !== null && <span className="text-xs tabular-nums text-muted-foreground">min {min} · max {max} · {samples.length} beats</span>}
            </div>
            <div className="h-40" role="img" aria-label={`Live heart rate, ${samples.length} samples${latest ? `, latest ${latest} bpm` : ''}`}>
                {samples.length > 1 ? <Line data={data} options={options} /> : (
                    <div className="flex h-full items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">Waiting for the first beats…</div>
                )}
            </div>
        </div>
    );
}

export function RingPage() {
    const { ble, logLines, liveSamples, clearLiveSamples, refreshBle, refreshInventory, backendOk } = useAppStatus();
    const [pageRef, pageWidth] = useElementWidth<HTMLDivElement>();
    const twoCol = pageWidth === 0 || pageWidth >= 860;
    const [rings, setRings] = useState<PairedRing[]>([]);
    const [ringsError, setRingsError] = useState<string | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    const [forgetTarget, setForgetTarget] = useState<PairedRing | null>(null);
    const [busySince, setBusySince] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());

    const state: BleState = ble?.state ?? 'idle';
    const busy = backendOk && (ble?.busy || BUSY.includes(state));
    const bluetoothOk = backendOk && (ble ? ble.bluetooth_ok !== false && state !== 'unavailable' : true);

    const loadRings = useCallback(async () => {
        try {
            setRings(await api.ble.rings());
            setRingsError(null);
        } catch (err) {
            setRingsError(err instanceof Error ? err.message : 'Failed to load paired rings');
        }
    }, []);

    useEffect(() => { void loadRings(); }, [loadRings]);

    // Reload rings + inventory whenever an operation finishes; track elapsed time while busy.
    const prevState = useRef<BleState | null>(null);
    useEffect(() => {
        if (prevState.current !== state) {
            if (BUSY.includes(state) && !BUSY.includes(prevState.current ?? 'idle')) setBusySince(Date.now());
            if (!BUSY.includes(state)) {
                setBusySince(null);
                if (prevState.current && BUSY.includes(prevState.current)) {
                    void loadRings();
                    void refreshInventory();
                }
            }
            prevState.current = state;
        }
    }, [state, loadRings, refreshInventory]);

    useEffect(() => {
        if (!busySince) return;
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [busySince]);

    const elapsed = ble?.progress?.elapsed_s ?? (busySince ? (now - busySince) / 1000 : null);

    const run = async (key: string, fn: () => Promise<unknown>, successMsg?: string) => {
        setPending(key);
        try {
            await fn();
            if (successMsg) toast.info(successMsg);
            await refreshBle();
        } catch (err) {
            toastError('Ring command failed', err);
        } finally {
            setPending(null);
        }
    };

    const devices = useMemo<BleDevice[]>(() => {
        const list = ble?.devices ?? [];
        return [...list].sort((a, b) => Number(b.is_ring) - Number(a.is_ring) || (b.rssi ?? -999) - (a.rssi ?? -999));
    }, [ble?.devices]);

    const preferred = ble?.preferred_address ?? undefined;
    const showLive = state === 'live' || liveSamples.length > 0;

    return (
        <div ref={pageRef} className="mx-auto flex max-w-5xl flex-col gap-4">
            {/* (a) Status card */}
            <Card>
                <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <span className={cn('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border bg-background', state === 'error' ? 'text-destructive border-destructive/40' : 'text-foreground')}>
                                {state === 'error' ? <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                                    : state === 'unavailable' ? <BluetoothOff className="h-5 w-5" aria-hidden="true" />
                                        : busy ? <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                                            : <Bluetooth className="h-5 w-5" aria-hidden="true" />}
                            </span>
                            <div>
                                <CardTitle aria-live="polite">{backendOk ? (STATE_LABEL[state] ?? state) : 'Backend offline'}</CardTitle>
                                <CardDescription>
                                    {backendOk
                                        ? (ble?.error || ble?.message || (ble ? 'Ready.' : 'Connecting to the local backend…'))
                                        : 'The local backend stopped responding. If it crashed while scanning, macOS may be blocking Bluetooth — see the permission note below, then restart the app.'}
                                </CardDescription>
                            </div>
                        </div>
                        {busy && (
                            <Button variant="outline" size="sm" onClick={() => run('cancel', () => api.ble.cancel())} disabled={pending === 'cancel'} className="gap-1.5">
                                <XCircle className="h-4 w-4" aria-hidden="true" /> Cancel
                            </Button>
                        )}
                    </div>
                </CardHeader>
                {(busy || ble?.progress) && (
                    <CardContent className="pt-0">
                        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                            <div><dt className="text-xs text-muted-foreground">Elapsed</dt><dd className="font-medium tabular-nums">{formatElapsed(elapsed)}</dd></div>
                            <div><dt className="text-xs text-muted-foreground">Events read</dt><dd className="tabular-nums font-medium">{formatCount(ble?.progress?.events ?? null)}</dd></div>
                            <div><dt className="text-xs text-muted-foreground">New events</dt><dd className="tabular-nums font-medium">{formatCount(ble?.progress?.new ?? null)}</dd></div>
                            <div><dt className="text-xs text-muted-foreground">Bytes left</dt><dd className="tabular-nums font-medium">{formatBytes(ble?.progress?.bytes_left ?? null)}</dd></div>
                        </dl>
                    </CardContent>
                )}
            </Card>

            {!bluetoothOk && (
                <Alert>
                    <BluetoothOff className="h-4 w-4" />
                    <AlertTitle>Bluetooth permission needed</AlertTitle>
                    <AlertDescription>
                        macOS is blocking Bluetooth for this app. Open <strong>System Settings → Privacy &amp; Security → Bluetooth</strong>, enable Cracked Oura (or your terminal when running in development), and make sure Bluetooth is switched on. Then click Scan again.
                    </AlertDescription>
                </Alert>
            )}

            <div className={cn("grid gap-4", twoCol && "grid-cols-2")}>
                {/* (b) Find your ring */}
                <Card>
                    <CardHeader className="pb-3">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <CardTitle>Find your ring</CardTitle>
                                <CardDescription>
                                    {ble?.last_scan_at ? `Last scan ${formatRelativeUnix(ble.last_scan_at)}` : 'Put the ring on or near this computer, then scan.'}
                                </CardDescription>
                            </div>
                            <Button
                                size="sm"
                                className="gap-1.5"
                                disabled={busy || !bluetoothOk || pending === 'scan'}
                                onClick={() => run('scan', () => api.ble.scan(SCAN_SECONDS))}
                            >
                                {state === 'scanning' ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Radar className="h-4 w-4" aria-hidden="true" />}
                                Scan ({SCAN_SECONDS} s)
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                        {devices.length === 0 ? (
                            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                                {state === 'scanning' ? 'Listening for nearby rings…' : 'No devices found yet.'}
                            </div>
                        ) : (
                            <ul className="divide-y" role="list">
                                {devices.map(d => (
                                    <li key={d.address} className="flex items-center justify-between gap-3 py-2.5">
                                        <div className="min-w-0 flex items-center gap-3">
                                            <RssiBars rssi={d.rssi} />
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-medium truncate">{d.name || 'Unnamed ring'}</span>
                                                    {d.is_charger && <Badge variant="secondary" className="gap-1"><Zap className="h-3 w-3" aria-hidden="true" />Charger</Badge>}
                                                    {d.is_ring && !d.is_charger && <Badge variant="outline">Ring</Badge>}
                                                    {preferred === d.address && <Badge variant="outline">Preferred</Badge>}
                                                </div>
                                                <span className="block truncate font-mono text-xs text-muted-foreground">{d.address}</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1 shrink-0">
                                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(`probe:${d.address}`, () => api.ble.probe(d.address))}>Probe</Button>
                                            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(`sync:${d.address}`, () => api.ble.sync(d.address))}>Sync</Button>
                                            <Button size="sm" disabled={busy} onClick={() => run(`pair:${d.address}`, () => api.ble.pair(d.address))}>Pair</Button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>

                {/* (f) How pairing works */}
                <Alert className="h-fit">
                    <Info className="h-4 w-4" />
                    <AlertTitle>How pairing works</AlertTitle>
                    <AlertDescription>
                        <ul className="list-disc pl-4 space-y-1 mt-1">
                            <li>The ring talks to <strong>one device at a time</strong>. A ring already set up with the Oura app will not accept a second device.</li>
                            <li>To use it here, <strong>factory-reset the ring</strong> first (Oura app → ring settings → reset, or the charger/case procedure), then click <strong>Pair</strong> here.</li>
                            <li>After that, the Oura app can no longer use the ring until another reset.</li>
                            <li>Nothing is sent to Oura. Everything stays on this computer.</li>
                        </ul>
                    </AlertDescription>
                </Alert>
            </div>

            {/* (c) Paired rings */}
            <Card>
                <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <CardTitle>Paired rings</CardTitle>
                            <CardDescription>Rings this computer has a key for, and what has been read from them.</CardDescription>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => void loadRings()} className="gap-1.5" aria-label="Refresh paired rings">
                            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-4">
                    {rings.length > 0 && (
                        <div className="flex items-center justify-between gap-4 rounded-md border bg-background p-3">
                            <div>
                                <p className="text-sm font-medium">Auto-sync</p>
                                <p className="text-xs text-muted-foreground">Every 30 minutes, if the ring is nearby (on its charger works best) and not connected to a phone.</p>
                            </div>
                            <Switch
                                checked={!!ble?.auto_sync}
                                aria-label="Auto-sync paired ring"
                                onCheckedChange={(v) => {
                                    void api.saveSettings({ ble_auto_sync: v }).then(() => { refreshBle(); toast.success(v ? 'Auto-sync on' : 'Auto-sync off'); }).catch((e) => toastError('Could not save auto-sync', e));
                                }}
                            />
                        </div>
                    )}
                    {ringsError && <p className="text-sm text-destructive">{ringsError}</p>}
                    {!ringsError && rings.length === 0 && (
                        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                            No paired rings yet. Scan above and click Pair on your ring.
                        </div>
                    )}
                    <ul className={cn("grid gap-3", pageWidth >= 640 && "grid-cols-2")} role="list">
                        {rings.map(r => (
                            <li key={r.serial} className="flex flex-col gap-3 rounded-md border bg-background p-4">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="truncate font-medium">{r.name || ble?.ring?.model || 'Oura ring'}</p>
                                        <p className="truncate font-mono text-xs text-muted-foreground">Serial {r.serial}</p>
                                    </div>
                                    {!r.paired_here && <Badge variant="secondary">Key elsewhere</Badge>}
                                </div>
                                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                                    <dt className="text-muted-foreground">Model</dt><dd className="truncate">{ble?.ring?.serial === r.serial ? (ble.ring.model || r.hardware_id || '—') : (r.hardware_id || '—')}</dd>
                                    <dt className="text-muted-foreground">Firmware</dt><dd className="truncate">{r.firmware_version || '—'}</dd>
                                    <dt className="text-muted-foreground">Battery</dt>
                                    <dd className="flex items-center gap-1">
                                        <BatteryMedium className="h-3.5 w-3.5" aria-hidden="true" />
                                        {r.battery_percent !== null ? `${r.battery_percent}%` : '—'}
                                        {r.battery_at && <span className="text-muted-foreground">· {formatRelative(r.battery_at)}</span>}
                                    </dd>
                                    <dt className="text-muted-foreground">Last sync</dt><dd>{r.last_sync_at ? formatRelative(r.last_sync_at) : 'never'}</dd>
                                    <dt className="text-muted-foreground">Events stored</dt><dd className="tabular-nums">{formatCount(r.events)}</dd>
                                    <dt className="text-muted-foreground">Latest event</dt><dd>{formatRelativeUnix(r.last_event_unix)}</dd>
                                </dl>
                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                    <Button size="sm" disabled={busy} className="gap-1.5" onClick={() => run(`syncnow:${r.serial}`, () => api.ble.sync(preferred, false))}>
                                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Sync now
                                    </Button>
                                    <Button size="sm" variant="outline" disabled={busy} onClick={() => run(`fullsync:${r.serial}`, () => api.ble.sync(preferred, true))}>
                                        Full re-sync
                                    </Button>
                                    <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive gap-1.5 ml-auto" disabled={busy} onClick={() => setForgetTarget(r)}>
                                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Forget
                                    </Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </CardContent>
            </Card>

            {/* (d) Live heart rate */}
            <Card>
                <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <CardTitle>Live heart rate</CardTitle>
                            <CardDescription>Streams beats from a paired ring for {LIVE_SECONDS} seconds. Wear the ring.</CardDescription>
                        </div>
                        <Button
                            size="sm"
                            variant={state === 'live' ? 'secondary' : 'default'}
                            className="gap-1.5"
                            disabled={busy || rings.length === 0 && !ble?.paired_serials?.length}
                            onClick={() => { clearLiveSamples(); void run('live', () => api.ble.live(preferred, LIVE_SECONDS)); }}
                        >
                            <HeartPulse className="h-4 w-4" aria-hidden="true" /> Start ({LIVE_SECONDS} s)
                        </Button>
                    </div>
                </CardHeader>
                {showLive && (
                    <CardContent className="pt-0">
                        <LiveHeartRateChart samples={liveSamples} />
                    </CardContent>
                )}
            </Card>

            {/* (e) Activity log */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle>Activity log</CardTitle>
                    <CardDescription>Last {Math.min(30, logLines.length)} lines from the Bluetooth worker.</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                    <div className="h-48 overflow-y-auto rounded-md border bg-background p-3 font-mono text-xs leading-relaxed" role="log" aria-live="polite">
                        {logLines.length === 0 && <span className="text-muted-foreground">No activity yet.</span>}
                        {logLines.slice(-30).map((line, i) => (
                            <div key={`${line.ts}-${i}`} className={cn(line.level === 'error' && 'text-destructive', line.level === 'warning' && 'text-amber-600 dark:text-amber-400')}>
                                <span className="text-muted-foreground">{new Date(line.ts).toLocaleTimeString()}</span> {line.msg}
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>

            <ConfirmDialog
                open={forgetTarget !== null}
                onOpenChange={(o) => !o && setForgetTarget(null)}
                title="Forget this ring?"
                description={<p>The pairing key for serial <span className="font-mono">{forgetTarget?.serial}</span> will be deleted from this computer. Data already read from the ring is kept. To read it again you will need to reset and pair the ring once more.</p>}
                confirmLabel="Forget ring"
                destructive
                onConfirm={async () => {
                    if (!forgetTarget) return;
                    try {
                        await api.ble.forget(forgetTarget.serial);
                        toast.success('Ring forgotten');
                        await Promise.all([loadRings(), refreshBle()]);
                    } catch (err) {
                        toastError('Could not forget ring', err);
                    }
                }}
            />
        </div>
    );
}
