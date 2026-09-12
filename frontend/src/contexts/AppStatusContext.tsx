import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
    api,
    errorMessage,
    type AppSettings,
    type BleLogLine,
    type BleState,
    type BleStatus,
    type BleStreamEvent,
    type DataInventory,
    type LiveSample,
    type SettingsUpdate,
    type SyncStatus,
    type Units,
} from '@/lib/api';

const POLL_MS = 5_000;
const MAX_LOG = 100;
const MAX_LIVE = 600;

interface AppStatusContextType {
    ble: BleStatus | null;
    sync: SyncStatus | null;
    inventory: DataInventory | null;
    /** null until the inventory has been fetched at least once. */
    hasData: boolean | null;
    settings: AppSettings | null;
    units: Units;
    backendOk: boolean;
    refreshBle: () => Promise<void>;
    refreshSync: () => Promise<void>;
    refreshInventory: () => Promise<void>;
    refreshSettings: () => Promise<void>;
    updateSettings: (update: SettingsUpdate) => Promise<AppSettings>;
    /** Live heart-rate samples from the SSE stream (cleared when a live session starts). */
    liveSamples: LiveSample[];
    clearLiveSamples: () => void;
    logLines: BleLogLine[];
}

const AppStatusContext = createContext<AppStatusContextType | undefined>(undefined);

const BUSY_STATES: readonly BleState[] = ['scanning', 'connecting', 'pairing', 'authenticating', 'syncing', 'live'];

const countRows = (inv: DataInventory | null): number =>
    inv ? Object.values(inv).reduce((sum, e) => sum + (e?.rows ?? 0), 0) : 0;

export function AppStatusProvider({ children }: { children: ReactNode }) {
    const [ble, setBle] = useState<BleStatus | null>(null);
    const [sync, setSync] = useState<SyncStatus | null>(null);
    const [inventory, setInventory] = useState<DataInventory | null>(null);
    const [settings, setSettings] = useState<AppSettings | null>(null);
    const [backendOk, setBackendOk] = useState(true);
    const [liveSamples, setLiveSamples] = useState<LiveSample[]>([]);
    const [logLines, setLogLines] = useState<BleLogLine[]>([]);

    const prevBleState = useRef<BleState | null>(null);

    const refreshInventory = useCallback(async () => {
        try {
            setInventory(await api.getInventory());
        } catch (err) {
            console.warn('Inventory fetch failed', err);
        }
    }, []);

    // Refresh the inventory whenever a ZIP import finishes (transition observed via polling).
    const prevSyncState = useRef<string | null>(null);
    const refreshSync = useCallback(async () => {
        try {
            const next = await api.getSyncStatus();
            if (prevSyncState.current === 'ingesting' && next.state === 'done') void refreshInventory();
            prevSyncState.current = next.state;
            setSync(next);
            setBackendOk(true);
        } catch {
            setBackendOk(false);
        }
    }, [refreshInventory]);

    const refreshSettings = useCallback(async () => {
        try {
            setSettings(await api.getSettings());
        } catch (err) {
            console.warn('Settings fetch failed', err);
        }
    }, []);

    const updateSettings = useCallback(async (update: SettingsUpdate) => {
        const res = await api.saveSettings(update);
        setSettings(res.settings);
        return res.settings;
    }, []);

    /** Announce state transitions the user may not be looking at, and refresh data after a sync. */
    const handleBleTransition = useCallback((next: BleStatus) => {
        const prev = prevBleState.current;
        prevBleState.current = next.state;
        if (prev === null || prev === next.state) return;

        if (next.state === 'error') {
            toast.error('Ring error', { description: next.error || next.message || 'Unknown error' });
            return;
        }
        if (next.state === 'idle') {
            if (prev === 'pairing' || prev === 'authenticating') {
                toast.success('Ring paired', { description: next.message || undefined });
            } else if (prev === 'syncing') {
                toast.success('Ring sync complete', { description: next.message || undefined });
                void refreshInventory();
            } else if (prev === 'live') {
                toast.info('Live heart rate ended', { description: next.message || undefined });
            } else if (prev === 'scanning') {
                toast.info('Scan finished', { description: `${next.devices?.length ?? 0} device(s) found` });
            }
        }
    }, [refreshInventory]);

    const refreshBle = useCallback(async () => {
        try {
            const status = await api.ble.status();
            setBle(status);
            setLogLines(status.log ?? []);
            if (status.state === 'live' && status.live_samples?.length) {
                setLiveSamples(status.live_samples);
            }
            setBackendOk(true);
            handleBleTransition(status);
        } catch {
            setBackendOk(false);
        }
    }, [handleBleTransition]);

    // Initial fetches (deferred a tick so nothing sets state synchronously in the effect) + 5 s polling
    useEffect(() => {
        const poll = () => {
            void refreshBle();
            void refreshSync();
        };
        const initial = window.setTimeout(() => {
            poll();
            void refreshInventory();
            void refreshSettings();
        }, 0);
        const id = window.setInterval(poll, POLL_MS);
        return () => {
            window.clearTimeout(initial);
            window.clearInterval(id);
        };
    }, [refreshBle, refreshSync, refreshInventory, refreshSettings]);

    // Server-sent events: instant state/log/heart-rate updates between polls
    useEffect(() => {
        let source: EventSource | null = null;
        let retry: number | undefined;
        let closed = false;

        const connect = () => {
            if (closed) return;
            source = new EventSource(api.ble.streamUrl());
            source.onmessage = (ev: MessageEvent<string>) => {
                let event: BleStreamEvent;
                try {
                    event = JSON.parse(ev.data) as BleStreamEvent;
                } catch {
                    return;
                }
                switch (event.type) {
                    case 'hello': {
                        const { type: _type, ...partial } = event;
                        void _type;
                        setBle(prev => (prev ? { ...prev, ...partial } : prev));
                        break;
                    }
                    case 'state': {
                        setBle(prev => {
                            if (!prev) return prev;
                            const next: BleStatus = {
                                ...prev,
                                state: event.state,
                                message: event.message,
                                progress: event.progress ?? (event.state === 'syncing' ? prev.progress : null),
                                busy: BUSY_STATES.includes(event.state),
                                error: event.state === 'error' ? event.message : null,
                            };
                            return next;
                        });
                        if (event.state === 'live') setLiveSamples([]);
                        // Pull the full status (devices, ring, paired list) right after a transition.
                        void refreshBle();
                        break;
                    }
                    case 'log': {
                        const { ts, level, msg } = event;
                        setLogLines(prev => [...prev, { ts, level, msg }].slice(-MAX_LOG));
                        break;
                    }
                    case 'hr': {
                        const { t, bpm, ibi_ms } = event;
                        setLiveSamples(prev => [...prev, { t, bpm, ibi_ms }].slice(-MAX_LIVE));
                        break;
                    }
                }
            };
            source.onerror = () => {
                source?.close();
                source = null;
                if (!closed) retry = window.setTimeout(connect, 5_000);
            };
        };

        connect();
        return () => {
            closed = true;
            source?.close();
            if (retry) window.clearTimeout(retry);
        };
    }, [refreshBle]);

    const hasData = inventory === null ? null : countRows(inventory) > 0;
    const units: Units = settings?.units === 'imperial' ? 'imperial' : 'metric';

    const value = useMemo<AppStatusContextType>(() => ({
        ble,
        sync,
        inventory,
        hasData,
        settings,
        units,
        backendOk,
        refreshBle,
        refreshSync,
        refreshInventory,
        refreshSettings,
        updateSettings,
        liveSamples,
        clearLiveSamples: () => setLiveSamples([]),
        logLines,
    }), [ble, sync, inventory, hasData, settings, units, backendOk, refreshBle, refreshSync, refreshInventory, refreshSettings, updateSettings, liveSamples, logLines]);

    return <AppStatusContext.Provider value={value}>{children}</AppStatusContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- context hook lives with its provider
export function useAppStatus() {
    const ctx = useContext(AppStatusContext);
    if (!ctx) throw new Error('useAppStatus must be used within an AppStatusProvider');
    return ctx;
}

/** Convenience for callers that only need a toast-friendly error string. */
// eslint-disable-next-line react-refresh/only-export-components -- tiny helper co-located with the provider
export function toastError(title: string, err: unknown) {
    toast.error(title, { description: errorMessage(err) });
}
