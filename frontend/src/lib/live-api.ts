/**
 * Live sessions (/api/live) and overnight insights (/api/insights).
 * Kept apart from api.ts so the streaming types stay in one place.
 */
import { BASE_URL, ApiError } from '@/lib/api';

export type SessionKind = 'steadiness' | 'workout' | 'breathing' | 'orthostatic' | 'gait' | 'free';
export type SimScenario = 'still' | 'tremor' | 'walk' | 'run' | 'reps' | 'breathing' | 'orthostatic' | 'ring4';

export interface SessionOptions {
    label?: string;
    target_bpm?: number;
    max_hr?: number;
    rest_hr?: number;
    age?: number;
    sex?: string;
    tags?: string[];
    notes?: string;
    t_stand_s?: number;
}

export interface StartRequest {
    kind: SessionKind;
    duration_s: number;
    streams?: Array<'acm' | 'hr'>;
    address?: string;
    simulate?: SimScenario;
    options?: SessionOptions;
}

export interface TremorMetrics {
    fs_hz: number; duration_s: number; n_samples: number;
    dominant_hz: number; dominant_power: number; rms_mg: number; amplitude_mm: number;
    power_3_7: number; power_7_12: number; power_12_20: number; tremor_ratio: number;
    steadiness_score: number; quality: 'good' | 'short' | 'moving'; movement_rms_mg: number;
    spectrum: { f: number[]; p: number[] };
    q_factor: number; power_3p5_7p5: number; power_7p5_12: number; log_amplitude: number;
    jitter_amp_cv: number; jitter_f_sd_hz: number; peak_prominence: number;
}

export interface MotionMetrics {
    activity: 'rest' | 'walk' | 'run' | 'cycle' | 'strength' | 'active' | string;
    confidence: number; cadence_spm: number | null; steps: number; reps: number;
    intensity_rms_g: number; dominant_hz: number; spectral_entropy?: number; duration_s: number;
}

export interface TimelineWindow {
    t_s: number; activity: string; confidence: number; cadence_spm: number | null; steps: number; reps: number; intensity_rms_g: number;
}

export interface HrvMetrics {
    n_beats: number; rejected: number; mean_hr: number; rmssd_ms: number; sdnn_ms: number; pnn50: number;
    lnrmssd: number; breathing_rpm: number; breathing_confidence: number; lf_hf: number;
    correction?: { n: number; corrected: number; fraction: number; usable: boolean };
}

export interface StressMetrics { si: number | null; sqrt_si: number | null; band?: string; n: number; usable: boolean }

export interface BreathingMetrics {
    target_bpm: number; resonance: number | null; rsa_amplitude_bpm: number | null; adherence: number | null;
    breath_rate_bpm: number | null; pre_post_lnrmssd: number | null; n_breaths: number;
}

export interface OrthostaticMetrics {
    stand: { t_stand_s: number; angle_deg: number | null } | null;
    hr_supine: number | null; hr_peak: number | null; hr_stand: number | null;
    delta_peak: number | null; delta_stand: number | null;
    rmssd_supine: number | null; rmssd_stand: number | null; rmssd_ratio: number | null; quality: string;
}

export interface SessionMetrics {
    kind: SessionKind; fs_hz: number; scale_g_per_lsb: number | null; acm_samples: number; beats: number;
    options?: SessionOptions;
    tremor?: TremorMetrics; motion?: MotionMetrics; timeline?: TimelineWindow[];
    hrv?: HrvMetrics; rmssd_series?: Array<number | null>; hr_series?: Array<[number, number]>;
    hr_recovery?: { peak_bpm: number | null; hrr1: number | null; hrr2: number | null };
    hr_zones?: Record<string, number>; training_load?: { banister: number | null; edwards: number | null; minutes: number };
    max_hr_used?: number; stress?: StressMetrics; breathing?: BreathingMetrics; orthostatic?: OrthostaticMetrics;
    preview?: Array<[number, number]>; hr_source?: 'push' | 'history' | null; seq_gaps?: number | null;
    skin_temp?: { series: Array<[number, number]>; mean_c: number };
}

export interface LiveSnapshot {
    tremor?: { steadiness_score: number; dominant_hz: number; rms_mg: number; quality: string; peak_prominence?: number; tremor_ratio?: number };
    motion?: { activity: string; cadence_spm: number | null; intensity_rms_g: number; reps: number };
    hrv?: { mean_hr: number; rmssd_ms: number; breathing_rpm: number; breathing_confidence: number };
    stress?: { sqrt_si: number | null; band?: string };
    scale_g_per_lsb?: number | null;
}

export interface LiveStatus {
    active: boolean; id?: string; kind?: SessionKind; started?: number; duration?: number; streams?: string[];
    simulate?: string | null; beats?: number; acm_samples?: number; fs?: number; t?: number; last_bpm?: number | null;
    skin_temp_c?: number | null; hr_source?: string | null; hint?: string | null; ring_state?: number | null;
    stopping?: boolean; saved_id?: string; last_error?: string | null; snapshot?: LiveSnapshot | null;
    metrics?: Partial<SessionMetrics>; state: string; message: string; error: string | null; busy: boolean;
    recent_hr: Array<{ t: number; bpm: number; ibi_ms?: number | null }>; recent_acm: number[][]; options?: SessionOptions;
}

export interface SessionSummary {
    id: string; serial: string | null; kind: SessionKind; simulated: boolean; started_at: string | null; ended_at: string | null;
    duration_s: number | null; fs_hz: number | null; beats: number | null; acm_samples: number | null;
    tremor: Pick<TremorMetrics, 'steadiness_score' | 'dominant_hz' | 'rms_mg' | 'quality'> | null;
    motion: Pick<MotionMetrics, 'activity' | 'cadence_spm' | 'steps' | 'reps' | 'intensity_rms_g'> | null;
    hrv: Pick<HrvMetrics, 'mean_hr' | 'rmssd_ms' | 'breathing_rpm'> | null;
    hr_recovery: SessionMetrics['hr_recovery'] | null; stress: StressMetrics | null;
    breathing: Omit<BreathingMetrics, 'target_bpm' | 'n_breaths'> | null;
    orthostatic: Pick<OrthostaticMetrics, 'delta_peak' | 'delta_stand' | 'rmssd_ratio' | 'quality'> | null;
    training_load: SessionMetrics['training_load'] | null; label: string | null; tags: string[] | null; notes: string | null;
}

export interface SessionDetail extends SessionSummary { metrics: SessionMetrics; scale_g_per_lsb: number | null }

export interface BaselineSignal {
    n_ref: number; n_recent: number; values: Array<[string, number | null]>;
    mean_ref?: number; sd_ref?: number; recent_mean?: number; last?: number; z_recent?: number; z_last?: number;
    cusum?: number[]; alarm?: boolean; worse_direction?: 'up' | 'down'; swc?: number; insufficient?: boolean; needed?: number;
}

export interface Baselines {
    nights: number; signals: Record<string, BaselineSignal>;
    alarms: Array<{ signal: string; cusum: number; z_recent: number }>;
    readiness: number | null; status: 'ready' | 'easy' | 'watch'; formula: string; false_alarm_note: string; latest_day: string | null;
}

/** Events on /api/ble/stream that belong to live sessions. */
export type LiveStreamEvent =
    | { type: 'acm'; t: number; fs: number; n_total: number; samples: number[][]; seq_gaps?: number }
    | { type: 'hr'; t: number; bpm: number | null; ibi_ms: number; validity?: string; source?: string; skin_temp_c?: number }
    | ({ type: 'analysis'; t?: number } & LiveSnapshot)
    | { type: 'session_saved'; id: string; kind: SessionKind }
    | { type: 'hr_fallback'; t: number; message: string }
    | { type: 'hr_status'; t: number; result: number; message: string }
    | { type: 'ring_state'; t: number; state: number; mode: number }
    | { type: 'state'; state: string; message: string }
    | { type: string; [k: string]: unknown };

async function json<T>(path: string, init?: RequestInit, fallback = 'Request failed'): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, init);
    if (!res.ok) {
        let detail = fallback;
        try {
            const body = (await res.json()) as { detail?: unknown };
            if (typeof body.detail === 'string') detail = body.detail;
        } catch { /* keep fallback */ }
        throw new ApiError(detail, res.status);
    }
    return res.json() as Promise<T>;
}

const post = <T,>(path: string, body?: unknown, fallback?: string) =>
    json<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, fallback);

export const liveApi = {
    start: (req: StartRequest) => post<{ started: boolean; id: string }>('/api/live/start', req, 'Could not start the session'),
    stop: () => post<{ stopping: boolean }>('/api/live/stop', undefined, 'Could not stop the session'),
    status: () => json<LiveStatus>('/api/live/status', undefined, 'Could not read live status'),
    sessions: (kind?: SessionKind, limit = 100) =>
        json<SessionSummary[]>(`/api/live/sessions?limit=${limit}${kind ? `&kind=${kind}` : ''}`, undefined, 'Could not load sessions'),
    session: (id: string) => json<SessionDetail>(`/api/live/sessions/${encodeURIComponent(id)}`, undefined, 'Could not load the session'),
    remove: (id: string) => json<{ deleted: string }>(`/api/live/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Could not delete the session'),
    setNotes: (id: string, notes: string) => post<{ ok: boolean }>(`/api/live/sessions/${encodeURIComponent(id)}/notes`, { notes }, 'Could not save notes'),
    baselines: (days = 90) => json<Baselines>(`/api/insights/baselines?days=${days}`, undefined, 'Could not load baselines'),
};

/** Sessions kinds with copy used by the Live page. */
export const KIND_META: Record<SessionKind, { title: string; blurb: string; defaultDuration: number; streams: Array<'acm' | 'hr'> }> = {
    steadiness: { title: 'Steadiness', blurb: 'Hold still for 30 s at rest, then 30 s with the arm outstretched. Measures hand oscillation by frequency band.', defaultDuration: 30, streams: ['acm', 'hr'] },
    workout: { title: 'Workout', blurb: 'Record movement and beats during exercise: activity timeline, cadence, reps, zones, recovery and load.', defaultDuration: 600, streams: ['acm', 'hr'] },
    breathing: { title: 'Breathing', blurb: 'Five minutes of paced breathing. Scores how strongly your heart rhythm follows the pace.', defaultDuration: 300, streams: ['hr', 'acm'] },
    orthostatic: { title: 'Orthostatic', blurb: 'Rest lying or seated for two minutes, then stand still for three. Measures the heart-rate response to standing.', defaultDuration: 300, streams: ['acm', 'hr'] },
    gait: { title: 'Walk', blurb: 'A short walk: cadence, steps and regularity.', defaultDuration: 120, streams: ['acm', 'hr'] },
    free: { title: 'Free', blurb: 'Record anything. Every analysis that applies is run afterwards.', defaultDuration: 120, streams: ['acm', 'hr'] },
};
