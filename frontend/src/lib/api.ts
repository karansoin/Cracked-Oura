export const BASE_URL = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8000';

// ---------------------------------------------------------------- types

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    thoughts?: unknown[];
}

export type Units = 'metric' | 'imperial';
export type LlmProvider = 'ollama' | 'openai_compatible';

export interface AppSettings {
    email?: string;
    schedule_time?: string;
    is_active?: boolean;
    headless?: boolean;
    llm_provider: LlmProvider;
    llm_host: string;
    llm_model: string;
    llm_base_url: string;
    /** '********' when a key is stored. */
    llm_api_key: string;
    units: Units;
    ble_auto_sync?: boolean;
    sync?: SyncStatus;
}

export type SettingsUpdate = Partial<Pick<AppSettings,
    'units' | 'llm_provider' | 'llm_host' | 'llm_model' | 'llm_base_url' | 'llm_api_key' | 'ble_auto_sync'>>;

export interface AdvisorStatus {
    ok: boolean;
    provider: string;
    models: string[];
    model: string;
    model_available: boolean;
    error?: string;
}

export type SyncState = 'idle' | 'ingesting' | 'done' | 'error' | (string & {});

export interface SyncError {
    code: string;
    message: string;
    retryable: boolean;
}

export interface SyncStatus {
    state: SyncState;
    method?: string | null;
    message?: string;
    started_at?: string | null;
    last_success_at?: string | null;
    progress?: unknown;
    error?: SyncError | null;
    summary?: Record<string, unknown> | null;
}

export interface InventoryEntry {
    rows: number;
    first: string | null;
    last: string | null;
}

export type DataInventory = Record<string, InventoryEntry>;

export interface IngestResult {
    message: string;
    summary: Record<string, unknown>;
}

export type BleState =
    | 'idle' | 'scanning' | 'connecting' | 'pairing' | 'authenticating'
    | 'syncing' | 'live' | 'error' | 'unavailable';

export interface BleProgress {
    events?: number;
    new?: number;
    bytes_left?: number;
    elapsed_s?: number;
}

export interface BleDevice {
    address: string;
    name: string | null;
    rssi: number | null;
    is_ring: boolean;
    is_charger: boolean;
    manufacturer_hex?: string | null;
    seen_at?: number | null;
}

export interface BleRingInfo {
    serial?: string | null;
    model?: string | null;
    hardware_id?: string | null;
    firmware_version?: string | null;
    mac?: string | null;
    address?: string | null;
    name?: string | null;
    battery_percent?: number | null;
}

export interface BleLogLine {
    ts: string;
    level: string;
    msg: string;
}

export interface LiveSample {
    t: number;
    bpm: number;
    ibi_ms?: number | null;
}

export interface BleStatus {
    state: BleState;
    message: string;
    error: string | null;
    progress: BleProgress | null;
    busy: boolean;
    devices: BleDevice[];
    ring: BleRingInfo | null;
    paired_serials: string[];
    preferred_address: string | null;
    auto_sync: boolean;
    last_scan_at: number | null;
    bluetooth_ok: boolean;
    log: BleLogLine[];
    live_samples: LiveSample[];
    connected: boolean;
}

export interface PairedRing {
    serial: string;
    name: string | null;
    hardware_id: string | null;
    firmware_version: string | null;
    mac: string | null;
    next_cursor: number | null;
    last_sync_at: string | null;
    last_event_unix: number | null;
    battery_percent: number | null;
    battery_at: string | null;
    events: number;
    paired_here: boolean;
}

export type BleStreamEvent =
    | ({ type: 'hello' } & Partial<BleStatus>)
    | { type: 'state'; state: BleState; message: string; progress?: BleProgress | null }
    | ({ type: 'log' } & BleLogLine)
    | ({ type: 'hr' } & LiveSample);

export class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

/** Human message for any thrown value. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return fallback;
}

// -------------------------------------------------------------- helpers

async function parseError(res: Response, fallback: string): Promise<ApiError> {
    let message = fallback;
    try {
        const body: unknown = await res.json();
        if (body && typeof body === 'object' && 'detail' in body) {
            const detail = (body as { detail: unknown }).detail;
            if (typeof detail === 'string') message = detail;
            else if (detail) message = JSON.stringify(detail);
        }
    } catch {
        /* non-JSON body */
    }
    if (res.status === 409 && message === fallback) message = 'The ring is busy — wait for the current operation to finish.';
    return new ApiError(message, res.status);
}

async function getJson<T>(path: string, fallback = 'Request failed'): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`);
    if (!res.ok) throw await parseError(res, fallback);
    return res.json() as Promise<T>;
}

async function sendJson<T>(method: 'POST' | 'DELETE', path: string, body?: unknown, fallback = 'Request failed'): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await parseError(res, fallback);
    return res.json() as Promise<T>;
}

// ------------------------------------------------------------------ api

export const api = {
    // --- Health ---
    health: () => getJson<{ ok: boolean }>('/api/health', 'Backend unreachable'),

    // --- Settings ---
    getSettings: () => getJson<AppSettings>('/api/settings', 'Failed to fetch settings'),
    saveSettings: (settings: SettingsUpdate) =>
        sendJson<{ message: string; settings: AppSettings }>('POST', '/api/settings', settings, 'Failed to save settings'),
    getAdvisorStatus: () => getJson<AdvisorStatus>('/api/advisor/status', 'Failed to check AI Analyst'),

    // --- Sync / data ---
    getSyncStatus: () => getJson<SyncStatus>('/api/sync/status', 'Failed to fetch sync status'),
    getInventory: () => getJson<DataInventory>('/api/data/inventory', 'Failed to fetch data inventory'),
    deleteAllData: () => sendJson<{ message: string }>('DELETE', '/api/data', undefined, 'Failed to delete data'),

    uploadZip: async (file: File): Promise<IngestResult> => {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch(`${BASE_URL}/api/ingest/zip`, { method: 'POST', body: formData });
        if (!res.ok) throw await parseError(res, 'Import failed');
        return res.json() as Promise<IngestResult>;
    },

    // --- Dashboard data ---
    getDailyData: (date: string) => getJson<Record<string, unknown>>(`/api/days/${date}`, 'Failed to fetch daily data'),
    /** Full day payload including the large intraday detail columns. */
    getDailyDataDetailed: (date: string) =>
        getJson<Record<string, unknown>>(`/api/days/${date}?include_details=true`, 'Failed to fetch detailed daily data'),
    getDays: () => getJson<string[]>('/api/days', 'Failed to fetch days'),

    getQuery: (path: string, startDate?: string, endDate?: string) => {
        const params = new URLSearchParams({ path });
        if (startDate) params.append('start_date', startDate);
        if (endDate) params.append('end_date', endDate);
        return getJson<Array<{ date: string; value: unknown }>>(`/api/query?${params.toString()}`, 'Failed to fetch query data');
    },

    getSchema: () => getJson<Record<string, Array<{ name: string; type: string; is_json: boolean }>>>('/api/schema', 'Failed to fetch schema'),

    getTrends: (metric: string, startDate: string, endDate: string) => api.getQuery(metric, startDate, endDate),

    // --- Layout ---
    getLayout: () => getJson<Record<string, unknown>>('/api/dashboard', 'Failed to fetch layout'),
    saveLayout: (layout: unknown) => sendJson<{ message: string }>('POST', '/api/dashboard', layout, 'Failed to save layout'),

    // --- Chat ---
    sendChatMessage: (message: string, history: ChatMessage[], context?: unknown) =>
        sendJson<{ response: string; thoughts?: unknown[] }>(
            'POST', '/api/advisor/chat', { message, history, context }, 'Chat request failed'),

    // --- Ring (Bluetooth) ---
    ble: {
        status: () => getJson<BleStatus>('/api/ble/status', 'Failed to fetch ring status'),
        scan: (duration = 12) => sendJson<unknown>('POST', '/api/ble/scan', { duration }, 'Scan failed'),
        probe: (address: string) => sendJson<unknown>('POST', '/api/ble/probe', { address }, 'Probe failed'),
        pair: (address: string) => sendJson<unknown>('POST', '/api/ble/pair', { address }, 'Pairing failed'),
        sync: (address?: string, full = false) =>
            sendJson<unknown>('POST', '/api/ble/sync', { address, full }, 'Sync failed'),
        live: (address: string | undefined, duration = 60) =>
            sendJson<unknown>('POST', '/api/ble/live', { address, duration }, 'Live heart rate failed'),
        cancel: () => sendJson<unknown>('POST', '/api/ble/cancel', undefined, 'Cancel failed'),
        forget: (serial: string) => sendJson<unknown>('DELETE', `/api/ble/pair/${encodeURIComponent(serial)}`, undefined, 'Forget failed'),
        rings: () => getJson<PairedRing[]>('/api/ble/rings', 'Failed to fetch paired rings'),
        events: (serial?: string, limit = 100, tag?: string) => {
            const params = new URLSearchParams();
            if (serial) params.append('serial', serial);
            params.append('limit', String(limit));
            if (tag) params.append('tag', tag);
            return getJson<unknown[]>(`/api/ble/events?${params.toString()}`, 'Failed to fetch ring events');
        },
        streamUrl: () => `${BASE_URL}/api/ble/stream`,
    },
};
