import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Activity, HeartPulse, Loader2, Play, Square, Trash2, Wind, ArrowUpFromLine, Hand, FlaskConical } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/dashboard/ConfirmDialog';
import { useIsDark } from '@/components/theme-provider';
import { toastError, useAppStatus } from '@/contexts/AppStatusContext';
import { api } from '@/lib/api';
import { formatClock, formatDay, formatElapsed } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
    KIND_META, liveApi,
    type LiveSnapshot, type LiveStatus, type LiveStreamEvent, type SessionDetail, type SessionKind, type SessionOptions, type SessionSummary, type SimScenario,
} from '@/lib/live-api';
import { BreathingPacer } from './BreathingPacer';
import { steadinessSummary } from '@/lib/live-copy';
import { SessionResult, Stat } from './SessionResult';
import { TraceCanvas, type TracePoint } from './TraceCanvas';

const KINDS: SessionKind[] = ['steadiness', 'workout', 'breathing', 'orthostatic', 'free'];
const KIND_ICON: Record<SessionKind, React.ReactNode> = {
    steadiness: <Hand className="h-4 w-4" aria-hidden="true" />,
    workout: <Activity className="h-4 w-4" aria-hidden="true" />,
    breathing: <Wind className="h-4 w-4" aria-hidden="true" />,
    orthostatic: <ArrowUpFromLine className="h-4 w-4" aria-hidden="true" />,
    gait: <Activity className="h-4 w-4" aria-hidden="true" />,
    free: <HeartPulse className="h-4 w-4" aria-hidden="true" />,
};
const SIM_OPTIONS: Array<{ value: SimScenario; label: string }> = [
    { value: 'still', label: 'Still hand' }, { value: 'tremor', label: '5 Hz oscillation' }, { value: 'walk', label: 'Walking' },
    { value: 'run', label: 'Running' }, { value: 'reps', label: 'Slow reps' }, { value: 'breathing', label: 'Paced breathing' },
    { value: 'orthostatic', label: 'Stand at 20 s' }, { value: 'ring4', label: 'Walking, ring without beat push' },
];
const PROTOCOL: Record<SessionKind, string[]> = {
    steadiness: ['Sit down. Rest the forearm on your lap or an armrest, hand relaxed and palm up.', 'Start. Stay still for the whole countdown; the first 5 s are discarded.', 'For the full test the app then asks you to hold the arm straight out, palm down, fingers spread, for another 30 s.', 'Repeat at the same time of day; tag caffeine or alcohol so trends make sense.'],
    workout: ['Wear the ring snugly on the same finger as always.', 'Start before you begin and stop a couple of minutes after you finish, so heart-rate recovery is captured.', 'Enter max and resting HR for zones and load (Tanaka 208 − 0.7·age otherwise).'],
    breathing: ['Sit or lie comfortably; ring hand still, ideally resting on the chest or lap.', 'Follow the circle: inhale as it grows, exhale as it shrinks. Five minutes is the standard dose.', 'Pick 6 breaths/min or your own resonance pace (usually 4.5–7).'],
    orthostatic: ['Best in the morning after waking. Lie or sit still for 2 minutes with the ring hand relaxed.', 'Stand up in one movement and stand still for 3 minutes, arm hanging. The app detects the stand from the ring.', 'Track your own rise; same time of day, same posture.'],
    gait: ['Walk normally with the arm swinging.'],
    free: ['Record whatever you like. Every analysis that applies runs afterwards.'],
};

type Phase = 'idle' | 'rest' | 'postural';

function magnitude(s: number[]): number { return Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]); }

export function LivePage() {
    const { ble, backendOk } = useAppStatus();
    const isDark = useIsDark();
    const [kind, setKind] = useState<SessionKind>('steadiness');
    const [duration, setDuration] = useState<number>(KIND_META.steadiness.defaultDuration);
    const [fullTest, setFullTest] = useState(true);
    const [targetBpm, setTargetBpm] = useState(6);
    const [maxHr, setMaxHr] = useState<string>('');
    const [restHr, setRestHr] = useState<string>('');
    const [age, setAge] = useState<string>('');
    const [tags, setTags] = useState<string[]>([]);
    const [simulate, setSimulate] = useState<SimScenario | 'none'>('none');
    const [status, setStatus] = useState<LiveStatus | null>(null);
    const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
    const [hrPoints, setHrPoints] = useState<TracePoint[]>([]);
    const [accPoints, setAccPoints] = useState<TracePoint[]>([]);
    const [lastBpm, setLastBpm] = useState<number | null>(null);
    const [skinTemp, setSkinTemp] = useState<number | null>(null);
    const [hint, setHint] = useState<string | null>(null);
    const [phase, setPhase] = useState<Phase>('idle');
    const [starting, setStarting] = useState(false);
    const [now, setNow] = useState(Date.now());
    const [results, setResults] = useState<SessionDetail[]>([]);
    const [history, setHistory] = useState<SessionSummary[]>([]);
    const [selected, setSelected] = useState<SessionDetail | null>(null);
    const [loadingSel, setLoadingSel] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
    const scaleRef = useRef<number | null>(null);
    const calibRef = useRef<number[]>([]);
    const chainRef = useRef<{ next: Phase | null; kind: SessionKind } | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    const startRef = useRef<(label?: Phase) => Promise<void>>(async () => undefined);

    const active = !!status?.active;
    const ringReady = !!ble && (ble.paired_serials?.length ?? 0) > 0 && ble.state !== 'unavailable';
    const busyElsewhere = !active && !!ble && ['scanning', 'connecting', 'pairing', 'authenticating', 'syncing', 'live'].includes(ble.state);

    useEffect(() => { setDuration(KIND_META[kind].defaultDuration); }, [kind]);

    const loadHistory = useCallback(async () => {
        try { setHistory(await liveApi.sessions(undefined, 200)); } catch (err) { toastError('Could not load sessions', err); }
    }, []);
    useEffect(() => { void loadHistory(); }, [loadHistory]);

    const refreshStatus = useCallback(async () => {
        try {
            const s = await liveApi.status();
            setStatus(s);
            if (s.snapshot) setSnapshot(s.snapshot);
            if (s.last_bpm != null) setLastBpm(s.last_bpm);
            if (s.skin_temp_c != null) setSkinTemp(s.skin_temp_c);
            if (s.hint) setHint(s.hint);
            return s;
        } catch { return null; }
    }, []);
    useEffect(() => { void refreshStatus(); }, [refreshStatus]);

    // Poll while a session is running (the stream is the fast path; this is the safety net).
    useEffect(() => {
        if (!active) return;
        const id = window.setInterval(() => { void refreshStatus(); setNow(Date.now()); }, 1000);
        return () => window.clearInterval(id);
    }, [active, refreshStatus]);

    const resetBuffers = () => {
        setHrPoints([]); setAccPoints([]); setSnapshot(null); setLastBpm(null); setSkinTemp(null); setHint(null);
        scaleRef.current = null; calibRef.current = [];
    };

    const onSaved = useCallback(async (id: string) => {
        try {
            const d = await liveApi.session(id);
            setResults(prev => [...prev.filter(r => r.id !== id), d]);
            setSelected(null);
            void loadHistory();
            const chain = chainRef.current;
            if (chain?.next === 'postural') {
                chainRef.current = { next: null, kind: chain.kind };
                toast.info('Rest phase saved. Now hold the arm straight out for the postural phase.', { duration: 6000 });
                window.setTimeout(() => { void startRef.current('postural'); }, 4000);
            } else {
                chainRef.current = null;
                setPhase('idle');
            }
        } catch (err) { toastError('Session saved but could not be loaded', err); }
    }, [loadHistory]);

    // Live stream: accelerometer batches, beats, rolling analysis and the saved-session signal.
    useEffect(() => {
        let source: EventSource | null = null;
        let retry: number | undefined;
        let closed = false;
        const connect = () => {
            if (closed) return;
            source = new EventSource(api.ble.streamUrl());
            source.onmessage = (msg: MessageEvent<string>) => {
                let ev: LiveStreamEvent;
                try { ev = JSON.parse(msg.data) as LiveStreamEvent; } catch { return; }
                switch (ev.type) {
                    case 'acm': {
                        const e = ev as Extract<LiveStreamEvent, { type: 'acm' }>;
                        const fs = e.fs || 50;
                        if (scaleRef.current === null) {
                            calibRef.current.push(...e.samples.map(magnitude));
                            if (calibRef.current.length >= 50) {
                                const sorted = [...calibRef.current].sort((a, b) => a - b);
                                scaleRef.current = 1 / Math.max(sorted[Math.floor(sorted.length / 2)], 1);
                            }
                        }
                        const scale = scaleRef.current ?? 1 / 4096;
                        const t0 = e.t - e.samples.length / fs;
                        const pts = e.samples.map((s, i) => ({ t: t0 + i / fs, v: magnitude(s) * scale }));
                        setAccPoints(prev => { const next = prev.concat(pts); return next.length > fs * 20 ? next.slice(next.length - fs * 20) : next; });
                        break;
                    }
                    case 'hr': {
                        const e = ev as Extract<LiveStreamEvent, { type: 'hr' }>;
                        if (e.bpm != null) { setLastBpm(e.bpm); setHrPoints(prev => [...prev, { t: e.t, v: e.bpm }].slice(-3600)); }
                        if (e.skin_temp_c != null) setSkinTemp(e.skin_temp_c);
                        break;
                    }
                    case 'analysis': {
                        const { type: _t, t: _tt, ...snap } = ev as Extract<LiveStreamEvent, { type: 'analysis' }>;
                        void _t; void _tt;
                        setSnapshot(snap);
                        if (snap.scale_g_per_lsb && scaleRef.current === null) scaleRef.current = snap.scale_g_per_lsb;
                        break;
                    }
                    case 'hr_fallback': case 'hr_status': {
                        setHint(String((ev as { message?: string }).message ?? ''));
                        break;
                    }
                    case 'session_failed': {
                        chainRef.current = null;
                        setPhase('idle');
                        toast.error(String((ev as { message?: string }).message ?? 'The session could not be completed.'));
                        void refreshStatus();
                        break;
                    }
                    case 'session_saved': {
                        const e = ev as Extract<LiveStreamEvent, { type: 'session_saved' }>;
                        void refreshStatus();
                        void onSaved(e.id);
                        break;
                    }
                    case 'state': {
                        void refreshStatus();
                        break;
                    }
                    default: break;
                }
            };
            source.onerror = () => { source?.close(); source = null; if (!closed) retry = window.setTimeout(connect, 4000); };
        };
        connect();
        return () => { closed = true; source?.close(); if (retry) window.clearTimeout(retry); };
    }, [onSaved, refreshStatus]);

    const buildOptions = (label?: string): SessionOptions => {
        const o: SessionOptions = {};
        if (label) o.label = label;
        if (tags.length) o.tags = tags;
        if (kind === 'breathing') o.target_bpm = targetBpm;
        if (kind === 'workout' || kind === 'free') {
            if (maxHr) o.max_hr = Number(maxHr);
            if (restHr) o.rest_hr = Number(restHr);
            if (age) o.age = Number(age);
        }
        return o;
    };

    const start = async (label?: Phase) => {
        setStarting(true);
        try {
            resetBuffers();
            if (label !== 'postural') setResults([]);
            const res = await liveApi.start({
                kind, duration_s: duration, streams: KIND_META[kind].streams,
                simulate: simulate === 'none' ? undefined : simulate,
                options: buildOptions(label && label !== 'idle' ? label : undefined),
            });
            sessionIdRef.current = res.id;
            setPhase(label ?? 'idle');
            await refreshStatus();
        } catch (err) {
            chainRef.current = null; setPhase('idle');
            toastError('Could not start', err);
        } finally { setStarting(false); }
    };

    startRef.current = start;

    const startClicked = () => {
        if (kind === 'steadiness' && fullTest) { chainRef.current = { next: 'postural', kind }; void start('rest'); }
        else { chainRef.current = null; void start(kind === 'steadiness' ? 'postural' : undefined); }
    };

    const stop = async () => {
        chainRef.current = null;
        try { await liveApi.stop(); toast.info('Stopping… the recording so far is being analysed.'); } catch (err) { toastError('Could not stop', err); }
    };

    const remove = async (id: string) => {
        try { await liveApi.remove(id); setHistory(h => h.filter(x => x.id !== id)); setResults(r => r.filter(x => x.id !== id)); if (selected?.id === id) setSelected(null); }
        catch (err) { toastError('Could not delete', err); }
    };

    const open = async (id: string) => {
        setLoadingSel(true);
        try { setSelected(await liveApi.session(id)); } catch (err) { toastError('Could not open session', err); } finally { setLoadingSel(false); }
    };

    const saveNotes = async (id: string, notes: string) => {
        try { await liveApi.setNotes(id, notes); void loadHistory(); toast.success('Notes saved'); } catch (err) { toastError('Could not save notes', err); }
    };

    const elapsed = status?.started ? Math.max(0, now / 1000 - status.started) : 0;
    const total = status?.duration ?? duration;
    const remaining = Math.max(0, total - elapsed);
    const hrColor = isDark ? '#F07F3C' : '#D55E00';
    const accColor = isDark ? '#5AA9E6' : '#0072B2';
    const filteredHistory = useMemo(() => history.filter(h => h.kind === kind), [history, kind]);
    const shownResults = results.filter(r => r.kind === kind);
    const canStart = backendOk !== false && !active && !busyElsewhere && !starting && (ringReady || simulate !== 'none');

    const toggleTag = (t: string) => setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

    return (
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
            <Tabs value={kind} onValueChange={v => { if (!active) { setKind(v as SessionKind); setSelected(null); } }}>
                <TabsList className="h-auto flex-wrap justify-start gap-1 bg-transparent p-0">
                    {KINDS.map(k => (
                        <TabsTrigger key={k} value={k} disabled={active && kind !== k} className="gap-1.5 rounded-md border data-[state=active]:border-foreground/30 data-[state=active]:bg-accent">
                            {KIND_ICON[k]}{KIND_META[k].title}
                        </TabsTrigger>
                    ))}
                </TabsList>
            </Tabs>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                <div className="flex min-w-0 flex-col gap-4">
                    {!active ? (
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="flex items-center gap-2 text-base">{KIND_ICON[kind]}{KIND_META[kind].title}</CardTitle>
                                <CardDescription>{KIND_META[kind].blurb}</CardDescription>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-4">
                                <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                                    {PROTOCOL[kind].map(step => <li key={step}>{step}</li>)}
                                </ol>
                                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                    <div className="flex flex-col gap-1.5">
                                        <Label htmlFor="live-duration">Duration</Label>
                                        <Select value={String(duration)} onValueChange={v => setDuration(Number(v))}>
                                            <SelectTrigger id="live-duration" className="h-9"><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                {[30, 60, 120, 180, 300, 600, 900, 1800, 3600].map(s => <SelectItem key={s} value={String(s)}>{formatElapsed(s)}{kind === 'steadiness' && fullTest && s === 30 ? ' per phase' : ''}</SelectItem>)}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    {kind === 'steadiness' && (
                                        <div className="flex flex-col gap-1.5">
                                            <Label htmlFor="live-full">Protocol</Label>
                                            <Select value={fullTest ? 'full' : 'postural'} onValueChange={v => setFullTest(v === 'full')}>
                                                <SelectTrigger id="live-full" className="h-9"><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="full">Rest, then postural (two phases)</SelectItem>
                                                    <SelectItem value="postural">Postural only</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    )}
                                    {kind === 'breathing' && (
                                        <div className="flex flex-col gap-1.5">
                                            <Label htmlFor="live-pace">Pace</Label>
                                            <Select value={String(targetBpm)} onValueChange={v => setTargetBpm(Number(v))}>
                                                <SelectTrigger id="live-pace" className="h-9"><SelectValue /></SelectTrigger>
                                                <SelectContent>{[4.5, 5, 5.5, 6, 6.5, 7].map(p => <SelectItem key={p} value={String(p)}>{p} breaths/min</SelectItem>)}</SelectContent>
                                            </Select>
                                        </div>
                                    )}
                                    {(kind === 'workout' || kind === 'free') && (
                                        <>
                                            <div className="flex flex-col gap-1.5"><Label htmlFor="live-max">Max HR (bpm)</Label><Input id="live-max" inputMode="numeric" className="h-9" placeholder="from age" value={maxHr} onChange={e => setMaxHr(e.target.value.replace(/\D/g, ''))} /></div>
                                            <div className="flex flex-col gap-1.5"><Label htmlFor="live-rest">Resting HR (bpm)</Label><Input id="live-rest" inputMode="numeric" className="h-9" placeholder="60" value={restHr} onChange={e => setRestHr(e.target.value.replace(/\D/g, ''))} /></div>
                                            <div className="flex flex-col gap-1.5"><Label htmlFor="live-age">Age</Label><Input id="live-age" inputMode="numeric" className="h-9" placeholder="optional" value={age} onChange={e => setAge(e.target.value.replace(/\D/g, ''))} /></div>
                                        </>
                                    )}
                                    <div className="flex flex-col gap-1.5">
                                        <Label htmlFor="live-sim" className="flex items-center gap-1"><FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />Without a ring</Label>
                                        <Select value={simulate} onValueChange={v => setSimulate(v as SimScenario | 'none')}>
                                            <SelectTrigger id="live-sim" className="h-9"><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">Use my ring</SelectItem>
                                                {SIM_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>Simulate: {o.label}</SelectItem>)}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-xs text-muted-foreground">Tags</span>
                                    {['caffeine', 'alcohol', 'poor sleep', 'medication', 'after exercise'].map(t => (
                                        <button key={t} type="button" onClick={() => toggleTag(t)} aria-pressed={tags.includes(t)}
                                            className={cn('rounded-full border px-2.5 py-0.5 text-xs transition-colors', tags.includes(t) ? 'border-foreground/40 bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>{t}</button>
                                    ))}
                                </div>
                                <div className="flex flex-wrap items-center gap-3">
                                    <Button onClick={startClicked} disabled={!canStart}>
                                        {starting ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
                                        Start {KIND_META[kind].title.toLowerCase()}
                                    </Button>
                                    <p className="text-xs text-muted-foreground">
                                        {backendOk === false ? 'Backend offline.'
                                            : busyElsewhere ? `Ring is busy (${ble?.state}).`
                                                : !ringReady && simulate === 'none' ? 'No paired ring yet. Pair one on the Ring page, or pick a simulation to try the analysis.'
                                                    : simulate !== 'none' ? 'Simulation: synthetic signals, no Bluetooth.'
                                                        : 'Wear the ring; the phone app must be off or away.'}
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                    ) : (
                        <Card className="border-foreground/20">
                            <CardHeader className="pb-3">
                                <div className="flex flex-wrap items-center gap-3">
                                    <CardTitle className="flex items-center gap-2 text-base" aria-live="polite">
                                        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                                        {KIND_META[kind].title}{phase !== 'idle' ? ` · ${phase}` : ''}{status?.stopping ? ' · stopping' : ''}
                                    </CardTitle>
                                    <span className="text-sm tabular-nums text-muted-foreground">{formatElapsed(elapsed)} / {formatElapsed(total)}</span>
                                    <Button size="sm" variant="outline" className="ml-auto" onClick={stop} disabled={!!status?.stopping}><Square className="h-3.5 w-3.5" aria-hidden="true" />Stop &amp; analyse</Button>
                                </div>
                                <Progress value={Math.min(100, (elapsed / Math.max(total, 1)) * 100)} className="mt-2 h-1.5" aria-label="Session progress" />
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {kind === 'steadiness' && (phase === 'rest' ? 'Hand relaxed, forearm supported. Stay still.' : 'Arm straight out, palm down, fingers spread. Stay still.')}
                                    {kind === 'orthostatic' && (elapsed < 120 ? `Stay lying or seated… stand up in ${formatElapsed(120 - elapsed)}` : 'Stand still, arm hanging relaxed.')}
                                    {kind === 'breathing' && 'Follow the circle.'}
                                    {kind === 'workout' && 'Recording. Keep going; stop a couple of minutes after you finish.'}
                                    {kind === 'free' && 'Recording.'}
                                    {remaining < 5 && ' · finishing'}
                                </p>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-4">
                                {hint && <p className="rounded-md border border-[#E69F00]/40 bg-[#E69F00]/10 px-3 py-2 text-xs">{hint}</p>}
                                <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
                                    <div className="flex flex-col gap-2">
                                        <div className="rounded-md border bg-background/60 px-3 py-3">
                                            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Heart rate</p>
                                            <p className="text-4xl font-semibold tabular-nums leading-none">{lastBpm ?? '—'}<span className="ml-1 text-sm font-normal text-muted-foreground">bpm</span></p>
                                            <p className="mt-1 text-xs text-muted-foreground">{status?.beats ?? 0} beats{status?.hr_source ? ` · ${status.hr_source === 'push' ? 'live' : 'event log'}` : ''}{skinTemp != null ? ` · skin ${skinTemp.toFixed(1)} °C` : ''}</p>
                                        </div>
                                        {kind === 'breathing' ? (
                                            <BreathingPacer pace={targetBpm} running={active} elapsed={elapsed} />
                                        ) : (
                                            <div className="grid grid-cols-2 gap-2">
                                                {(kind === 'steadiness' || kind === 'free') && <>
                                                    <Stat label="Steady" value={snapshot?.tremor?.quality === 'good' ? snapshot.tremor.steadiness_score : snapshot?.tremor?.quality === 'moving' ? 'moving' : null} unit={snapshot?.tremor?.quality === 'good' ? '/100' : undefined} />
                                                    <Stat label="Peak" value={snapshot?.tremor?.dominant_hz && (snapshot.tremor.peak_prominence ?? 0) >= 8 ? snapshot.tremor.dominant_hz.toFixed(1) : null} unit="Hz" hint={snapshot?.tremor && (snapshot.tremor.peak_prominence ?? 0) < 8 ? 'no discrete peak' : undefined} />
                                                </>}
                                                {(kind === 'workout' || kind === 'free') && <>
                                                    <Stat label="Activity" value={snapshot?.motion?.activity ?? null} />
                                                    <Stat label="Cadence" value={snapshot?.motion?.cadence_spm ? Math.round(snapshot.motion.cadence_spm) : null} unit="spm" />
                                                </>}
                                                <Stat label="RMSSD" value={snapshot?.hrv?.rmssd_ms || null} unit="ms" />
                                                <Stat label="Breathing" value={snapshot?.hrv?.breathing_rpm || null} unit="/min" />
                                                {kind === 'orthostatic' && <Stat label="Stress" value={snapshot?.stress?.sqrt_si ?? null} hint={snapshot?.stress?.band} className="col-span-2" />}
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex min-w-0 flex-col gap-3">
                                        <TraceCanvas points={hrPoints} color={hrColor} unit="bpm" height={120} ariaLabel="Live heart rate" windowS={Math.max(60, Math.min(elapsed + 5, total))} />
                                        <TraceCanvas points={accPoints} color={accColor} unit="|a| g" height={110} windowS={10} yMin={kind === 'workout' || kind === 'free' ? undefined : 0.7} yMax={kind === 'workout' || kind === 'free' ? undefined : 1.3} guides={[{ y: 1, label: '1 g' }]} ariaLabel="Live acceleration magnitude" />
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {status?.last_error && !active && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{status.last_error}</p>}

                    {selected ? (
                        <Card>
                            <CardContent className="pt-6">
                                <SessionResult session={selected} onNotes={saveNotes} />
                                <div className="mt-3 flex justify-end gap-2">
                                    <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Close</Button>
                                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleteTarget(selected.id)}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Delete</Button>
                                </div>
                            </CardContent>
                        </Card>
                    ) : shownResults.length > 0 && (
                        <>
                            {kind === 'steadiness' && shownResults.length === 2 && shownResults[0].metrics.tremor && shownResults[1].metrics.tremor && (
                                <Card>
                                    <CardHeader className="pb-2"><CardTitle className="text-sm">Rest vs postural</CardTitle></CardHeader>
                                    <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                        {shownResults.map(r => <Stat key={r.id + 'a'} label={`${r.metrics.options?.label ?? r.kind} amplitude`} value={r.metrics.tremor!.rms_mg.toFixed(1)} unit="mg" hint={steadinessSummary(r.metrics.tremor!).headline} />)}
                                        {shownResults.map(r => <Stat key={r.id + 'f'} label={`${r.metrics.options?.label ?? r.kind} peak`} value={r.metrics.tremor!.dominant_hz.toFixed(1)} unit="Hz" hint={`Q ${r.metrics.tremor!.q_factor.toFixed(1)}`} />)}
                                    </CardContent>
                                </Card>
                            )}
                            {shownResults.map(r => (
                                <Card key={r.id}><CardContent className="pt-6"><SessionResult session={r} onNotes={saveNotes} compact={shownResults.length > 1} /></CardContent></Card>
                            ))}
                        </>
                    )}
                </div>

                <Card className="h-fit">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Past {KIND_META[kind].title.toLowerCase()} sessions</CardTitle>
                        <CardDescription>{filteredHistory.length === 0 ? 'Nothing recorded yet.' : `${filteredHistory.length} on this Mac.`}</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-1 p-2 pt-0">
                        {loadingSel && <p className="px-2 py-1 text-xs text-muted-foreground">Loading…</p>}
                        {filteredHistory.slice(0, 40).map(h => (
                            <button key={h.id} type="button" onClick={() => open(h.id)} className={cn('flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60', selected?.id === h.id && 'bg-accent')}>
                                <span className="flex items-center gap-2 text-sm">
                                    <span className="truncate">{h.started_at ? `${formatDay(h.started_at)} ${formatClock(h.started_at)}` : h.id}</span>
                                    {h.label && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{h.label}</Badge>}
                                    {h.simulated && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">sim</Badge>}
                                </span>
                                <span className="truncate text-xs text-muted-foreground">{summaryLine(h)}</span>
                            </button>
                        ))}
                    </CardContent>
                </Card>
            </div>
            <ConfirmDialog
                open={deleteTarget !== null}
                onOpenChange={o => !o && setDeleteTarget(null)}
                title="Delete this session?"
                description={<p>The recording and its analysis are removed from this Mac. This cannot be undone.</p>}
                confirmLabel="Delete session"
                destructive
                onConfirm={() => { if (deleteTarget) void remove(deleteTarget); }}
            />
        </div>
    );
}

function summaryLine(h: SessionSummary): string {
    const parts: string[] = [formatElapsed(h.duration_s ?? 0)];
    if (h.tremor && h.kind === 'steadiness') parts.push(h.tremor.quality === 'good' ? `steadiness ${h.tremor.steadiness_score}` : h.tremor.quality, `${h.tremor.dominant_hz.toFixed(1)} Hz`);
    if (h.motion && (h.kind === 'workout' || h.kind === 'free')) parts.push(h.motion.activity, h.motion.cadence_spm ? `${Math.round(h.motion.cadence_spm)} spm` : '');
    if (h.breathing?.resonance != null) parts.push(`resonance ${Math.round(h.breathing.resonance * 100)}`);
    if (h.orthostatic?.delta_stand != null) parts.push(`+${h.orthostatic.delta_stand} bpm standing`);
    if (h.hrv?.mean_hr) parts.push(`${Math.round(h.hrv.mean_hr)} bpm`);
    if (h.hrv?.rmssd_ms) parts.push(`RMSSD ${h.hrv.rmssd_ms}`);
    return parts.filter(Boolean).join(' · ');
}
