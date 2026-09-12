import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useIsDark } from '@/components/theme-provider';
import { cn } from '@/lib/utils';
import { formatClock, formatDay, formatDurationSeconds } from '@/lib/format';
import { SERIES_PALETTE } from '@/lib/bands';
import { KIND_META, type SessionDetail, type SessionMetrics, type TimelineWindow } from '@/lib/live-api';
import { steadinessSummary } from '@/lib/live-copy';
import { SpectrumCanvas } from './SpectrumCanvas';
import { TraceCanvas, type TracePoint } from './TraceCanvas';

const ACTIVITY_COLOR: Record<string, string> = {
    rest: '#9ca3af', walk: '#0072B2', run: '#D55E00', cycle: '#009E73', strength: '#CC79A7', active: '#E69F00',
};

export function Stat({ label, value, unit, hint, className }: { label: string; value: string | number | null | undefined; unit?: string; hint?: string; className?: string }) {
    const shown = value === null || value === undefined || value === '' ? '—' : value;
    return (
        <div className={cn('min-w-0 rounded-md border bg-background/60 px-3 py-2', className)}>
            <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-0.5 truncate text-lg font-semibold tabular-nums leading-tight">
                {shown}{shown !== '—' && unit ? <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span> : null}
            </p>
            {hint && <p className="mt-0.5 truncate text-xs text-muted-foreground" title={hint}>{hint}</p>}
        </div>
    );
}

function Formula({ children }: { children: React.ReactNode }) {
    return <p className="mt-2 rounded bg-muted/60 px-2 py-1 font-mono text-[11px] leading-relaxed text-muted-foreground">{children}</p>;
}

function Disclaimer({ children }: { children: React.ReactNode }) {
    return <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

export function TimelineBar({ windows, total }: { windows: TimelineWindow[]; total: number }) {
    if (!windows.length) return null;
    return (
        <div>
            <div className="flex h-5 w-full overflow-hidden rounded border" role="img" aria-label="Activity timeline">
                {windows.map((w, i) => {
                    const next = windows[i + 1]?.t_s ?? total;
                    const width = Math.max(((next - w.t_s) / Math.max(total, 1)) * 100, 0.5);
                    return <div key={w.t_s} style={{ width: `${width}%`, backgroundColor: ACTIVITY_COLOR[w.activity] ?? '#9ca3af' }} title={`${formatDurationSeconds(w.t_s)} · ${w.activity}${w.cadence_spm ? ` · ${Math.round(w.cadence_spm)} spm` : ''}`} />;
                })}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {Object.entries(ACTIVITY_COLOR).filter(([k]) => windows.some(w => w.activity === k)).map(([k, c]) => (
                    <span key={k} className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: c }} aria-hidden="true" />{k}</span>
                ))}
            </div>
        </div>
    );
}

function hrPoints(m: SessionMetrics): TracePoint[] {
    return (m.hr_series ?? []).map(([t, v]) => ({ t, v }));
}

function accelPoints(m: SessionMetrics): TracePoint[] {
    return (m.preview ?? []).map(([t, v]) => ({ t, v }));
}

export function SessionResult({ session, onNotes, compact = false }: { session: SessionDetail; onNotes?: (id: string, notes: string) => Promise<void>; compact?: boolean }) {
    const m = session.metrics;
    const isDark = useIsDark();
    const [notes, setNotes] = useState(session.notes ?? '');
    const [saving, setSaving] = useState(false);
    const meta = KIND_META[session.kind] ?? KIND_META.free;
    const hr = useMemo(() => hrPoints(m), [m]);
    const acc = useMemo(() => accelPoints(m), [m]);
    const hrColor = isDark ? '#F07F3C' : '#D55E00';
    const accColor = isDark ? '#5AA9E6' : SERIES_PALETTE[0];
    const duration = session.duration_s ?? 0;

    const tremor = m.tremor;
    const motion = m.motion;
    const hrv = m.hrv;
    const stress = m.stress;
    const breathing = m.breathing;
    const ortho = m.orthostatic;
    const load = m.training_load;
    const zones = m.hr_zones;
    const rec = m.hr_recovery;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold">{meta.title}{m.options?.label ? ` · ${m.options.label}` : ''}</h3>
                {session.simulated && <Badge variant="outline">Simulated</Badge>}
                {m.hr_source && <Badge variant="secondary">beats via {m.hr_source === 'push' ? 'live push' : 'event log'}</Badge>}
                {(m.options?.tags ?? []).map(t => <Badge key={t} variant="outline">{t}</Badge>)}
                <span className="ml-auto text-xs text-muted-foreground">
                    {session.started_at ? `${formatDay(session.started_at)} ${formatClock(session.started_at)}` : ''} · {formatDurationSeconds(duration)} · {m.beats} beats · {m.acm_samples} samples{m.seq_gaps ? ` · ${m.seq_gaps} gaps` : ''}
                </span>
            </div>

            {tremor && (session.kind === 'steadiness' || session.kind === 'free') && (
                <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm">Steadiness</CardTitle></CardHeader>
                    <CardContent className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                        <div className="flex flex-col gap-3">
                            <div className="grid grid-cols-2 gap-2">
                                <Stat label="Steadiness" value={tremor.quality === 'good' ? tremor.steadiness_score : null} unit="/100" hint={tremor.quality === 'good' ? 'log scale vs 3–60 mg' : tremor.quality} />
                                <Stat label="Dominant" value={tremor.dominant_hz ? tremor.dominant_hz.toFixed(1) : null} unit="Hz" hint={`peak Q ${tremor.q_factor.toFixed(1)}, ×${tremor.peak_prominence.toFixed(0)} above band`} />
                                <Stat label="Amplitude" value={tremor.rms_mg.toFixed(1)} unit="mg RMS" hint={`≈ ${tremor.amplitude_mm.toFixed(3)} mm at ${tremor.dominant_hz.toFixed(1)} Hz`} />
                                <Stat label="Tremor share" value={Math.round(tremor.tremor_ratio * 100)} unit="%" hint="3–12 Hz of 0.5–20 Hz power" />
                                <Stat label="Band split" value={`${Math.round(100 * tremor.power_3p5_7p5 / Math.max(tremor.power_3p5_7p5 + tremor.power_7p5_12, 1e-12))} / ${Math.round(100 * tremor.power_7p5_12 / Math.max(tremor.power_3p5_7p5 + tremor.power_7p5_12, 1e-12))}`} unit="%" hint="3.5–7.5 / 7.5–12 Hz" />
                                <Stat label="Jitter" value={`${(tremor.jitter_amp_cv * 100).toFixed(0)}% · ${tremor.jitter_f_sd_hz.toFixed(2)} Hz`} hint="5 s power CV · peak SD" />
                            </div>
                            {(() => { const s = steadinessSummary(tremor); return (<div><p className="text-sm font-medium">{s.headline}</p><p className="text-xs leading-relaxed text-muted-foreground">{s.body}</p></div>); })()}
                        </div>
                        <div>
                            <SpectrumCanvas f={tremor.spectrum.f} p={tremor.spectrum.p} dominantHz={tremor.dominant_hz} ariaLabel="Accelerometer power spectrum" />
                            {!compact && <Formula>Welch PSD of |a| and the most active axis (5 s Hann, 50 % overlap) · steadiness = 100·clip(1 − (log₁₀ rms − log₁₀ 3) / (log₁₀ 60 − log₁₀ 3)) · amplitude = a_rms·√2 / (2π f)²</Formula>}
                            <Disclaimer>Wellness measurement, not a diagnosis. Bands follow the Movement Disorder Society consensus (Deuschl 1998, Bhatia 2018); no consumer ring has clinical tremor validation.</Disclaimer>
                        </div>
                    </CardContent>
                </Card>
            )}

            {motion && (session.kind === 'workout' || session.kind === 'free' || session.kind === 'gait') && (
                <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm">Movement</CardTitle></CardHeader>
                    <CardContent className="flex flex-col gap-3">
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            <Stat label="Activity" value={motion.activity} hint={`${Math.round(motion.confidence * 100)} % confidence`} />
                            <Stat label="Cadence" value={motion.cadence_spm ? Math.round(motion.cadence_spm) : null} unit="spm" />
                            <Stat label="Steps" value={motion.steps || null} hint="inside walking/running windows only" />
                            <Stat label="Reps" value={motion.reps || null} hint="0.2–0.9 Hz cycles on the active axis" />
                        </div>
                        {m.timeline && <TimelineBar windows={m.timeline} total={duration} />}
                        {acc.length > 1 && <TraceCanvas points={acc} color={accColor} unit="|a| g" height={110} ariaLabel="Acceleration magnitude" />}
                        {!compact && <Formula>windows of 10 s → dynamic norm, spectral entropy, cadence by autocorrelation (0.8–3.5 Hz) · walk &lt; 130 spm ≤ run · strength = reps and low entropy · cycle = low impact, regular</Formula>}
                    </CardContent>
                </Card>
            )}

            {hrv && (
                <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm">Heart</CardTitle></CardHeader>
                    <CardContent className="flex flex-col gap-3">
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            <Stat label="Mean HR" value={hrv.mean_hr ? Math.round(hrv.mean_hr) : null} unit="bpm" />
                            <Stat label="RMSSD" value={hrv.rmssd_ms || null} unit="ms" hint={`ln ${hrv.lnrmssd} · SDNN ${hrv.sdnn_ms} · pNN50 ${hrv.pnn50}%`} />
                            <Stat label="Breathing" value={hrv.breathing_rpm || null} unit="/min" hint={`RSA peak, confidence ${Math.round(hrv.breathing_confidence * 100)} %`} />
                            <Stat label="Beat quality" value={hrv.correction ? `${Math.round((1 - hrv.correction.fraction) * 100)} %` : null} hint={hrv.correction ? `${hrv.correction.corrected} of ${hrv.correction.n} corrected${hrv.correction.usable ? '' : ' · above the 5 % gate'}` : undefined} />
                            {stress?.si != null && <Stat label="Stress index" value={stress.sqrt_si} hint={`√SI · ${stress.band}${stress.usable ? '' : ' · low quality'}`} />}
                            {m.skin_temp && <Stat label="Skin temp" value={m.skin_temp.mean_c.toFixed(2)} unit="°C" hint="per-beat sensor, mean" />}
                            {rec && rec.peak_bpm != null && (session.kind === 'workout' || session.kind === 'free') && (
                                <Stat label="HR recovery" value={rec.hrr1 != null ? `${Math.round(rec.hrr1)} / ${rec.hrr2 != null ? Math.round(rec.hrr2) : '—'}` : null} unit="bpm" hint={`drop 1 / 2 min after the ${Math.round(rec.peak_bpm)} bpm peak`} />
                            )}
                            {load && load.banister != null && <Stat label="Training load" value={load.banister} hint={`Banister TRIMP · Edwards ${load.edwards} · max HR ${m.max_hr_used ? Math.round(m.max_hr_used) : '—'}`} />}
                        </div>
                        {hr.length > 1 && (
                            <TraceCanvas points={hr} color={hrColor} unit="bpm" height={120} ariaLabel="Heart rate over the session"
                                markers={ortho?.stand ? [{ t: ortho.stand.t_stand_s, label: 'stand' }] : []}
                                guides={m.max_hr_used && zones ? [{ y: m.max_hr_used * 0.6, label: 'z2' }, { y: m.max_hr_used * 0.8, label: 'z4' }] : []} />
                        )}
                        {zones && Object.keys(zones).length > 0 && (
                            <div className="flex h-3 w-full overflow-hidden rounded border" role="img" aria-label="Time in heart-rate zones">
                                {(['below', 'z1', 'z2', 'z3', 'z4', 'z5'] as const).map((z, i) => (zones[z] ?? 0) > 0 && (
                                    <div key={z} style={{ width: `${zones[z] * 100}%`, backgroundColor: ['#d4d4d8', '#56B4E9', '#009E73', '#E69F00', '#D55E00', '#CC79A7'][i] }} title={`${z}: ${Math.round(zones[z] * 100)} %`} />
                                ))}
                            </div>
                        )}
                        {!compact && <Formula>beats: 12-bit inter-beat intervals from the ring; Kubios-style correction (Lipponen &amp; Tarvainen 2019); RMSSD = √mean(ΔNN²); breathing = RSA peak 0.15–0.5 Hz of the 4 Hz tachogram; stress = AMo / (2·Mo·MxDMn) (Baevsky)</Formula>}
                    </CardContent>
                </Card>
            )}

            {breathing && (
                <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm">Paced breathing at {breathing.target_bpm} / min</CardTitle></CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                            <Stat label="Resonance" value={breathing.resonance != null ? Math.round(breathing.resonance * 100) : null} unit="/100" hint="0.08–0.12 Hz share of 0.04–0.4 Hz" />
                            <Stat label="RSA amplitude" value={breathing.rsa_amplitude_bpm} unit="bpm" hint="HR swing per breath" />
                            <Stat label="Adherence" value={breathing.adherence != null ? Math.round(breathing.adherence * 100) : null} unit="%" hint={`${breathing.n_breaths} breaths within ±1/min`} />
                            <Stat label="Breath rate" value={breathing.breath_rate_bpm} unit="/min" />
                            <Stat label="lnRMSSD Δ" value={breathing.pre_post_lnrmssd != null ? (breathing.pre_post_lnrmssd >= 0 ? '+' : '') + breathing.pre_post_lnrmssd.toFixed(2) : null} hint="last minute vs first" />
                        </div>
                        <Disclaimer>A high resonance score means the heart rhythm oscillated in step with breathing (Steffen 2017, Laborde 2022). It is a training signal, not a health score.</Disclaimer>
                    </CardContent>
                </Card>
            )}

            {ortho && (
                <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm">Orthostatic response</CardTitle></CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            <Stat label="Stand detected" value={ortho.stand ? formatDurationSeconds(ortho.stand.t_stand_s) : 'no'} hint={ortho.stand?.angle_deg != null ? `gravity turned ${Math.round(ortho.stand.angle_deg)}°` : ortho.quality} />
                            <Stat label="Resting HR" value={ortho.hr_supine} unit="bpm" hint="last 60 s before standing" />
                            <Stat label="Peak rise" value={ortho.delta_peak != null ? `+${ortho.delta_peak}` : null} unit="bpm" hint={`peak ${ortho.hr_peak ?? '—'} within 30 s`} />
                            <Stat label="Sustained rise" value={ortho.delta_stand != null ? `+${ortho.delta_stand}` : null} unit="bpm" hint={`standing ${ortho.hr_stand ?? '—'} bpm at 1–3 min`} />
                            <Stat label="RMSSD ratio" value={ortho.rmssd_ratio} hint={`${ortho.rmssd_supine ?? '—'} → ${ortho.rmssd_stand ?? '—'} ms`} />
                            <Stat label="Quality" value={ortho.quality} />
                        </div>
                        <Disclaimer>A rise of about 10–15 bpm is typical. Clinicians look at sustained rises of 30 bpm or more together with symptoms on standing; this test cannot tell you that on its own. Track your own trend, same time of day.</Disclaimer>
                    </CardContent>
                </Card>
            )}

            {onNotes && (
                <div className="flex items-center gap-2">
                    <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (caffeine, sleep, how it felt…)" aria-label="Session notes" className="h-9" />
                    <Button size="sm" variant="secondary" disabled={saving || notes === (session.notes ?? '')} onClick={async () => { setSaving(true); try { await onNotes(session.id, notes); } finally { setSaving(false); } }}>Save</Button>
                </div>
            )}
        </div>
    );
}
