import { useState, useEffect, useCallback, useRef } from 'react';
import type { Dashboard, LayoutItem, WidgetInstance } from '../types';

import { api } from "@/lib/api";

export interface LoadedLayout {
    dashboards: Dashboard[];
    activeDashboardId: string;
}

interface UseDashboardPersistenceOptions {
    /** Called once, when the saved layouts arrive from the server (not on an empty/first-run response). */
    onLoaded?: (loaded: LoadedLayout) => void;
}

/** Shape of `GET /api/dashboard` - either the current multi-dashboard form or the legacy single layout. */
interface LayoutResponse {
    dashboards?: unknown;
    activeDashboardId?: string;
    widgets?: WidgetInstance[];
    layout?: LayoutItem[];
}

// Keep retrying with exponential backoff for roughly a minute (1, 2, 4, 8, 10, 10, ... s)
// so a slow backend start-up does not permanently disable persistence.
const RETRY_WINDOW_MS = 60_000;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 10_000;

const parseLayoutResponse = (data: LayoutResponse): LoadedLayout | null => {
    if (Array.isArray(data.dashboards)) {
        const dashboards = data.dashboards as Dashboard[];
        return {
            dashboards,
            activeDashboardId: data.activeDashboardId || dashboards[0]?.id
        };
    }
    if (data.widgets && data.layout) {
        // Migration from the legacy single-layout format
        const defaultDashboard: Dashboard = {
            id: 'default',
            name: 'Daily Overview',
            widgets: data.widgets,
            layout: data.layout
        };
        return { dashboards: [defaultDashboard], activeDashboardId: 'default' };
    }
    return null;
};

export const useDashboardPersistence = ({ onLoaded }: UseDashboardPersistenceOptions = {}) => {
    const [savedDashboards, setSavedDashboards] = useState<Dashboard[] | null>(null);
    const [savedActiveDashboardId, setSavedActiveDashboardId] = useState<string | null>(null);

    // `loaded` flips to true only after GET /api/dashboard succeeds. Until then (or if we
    // gave up) saving is disabled: a POST would overwrite the user's stored layouts with
    // the in-memory empty default.
    const [isLoaded, setIsLoaded] = useState(false);
    const loadedRef = useRef(false);

    // Keep the latest callback without making it an effect dependency.
    const onLoadedRef = useRef(onLoaded);
    useEffect(() => {
        onLoadedRef.current = onLoaded;
    });

    // Load dashboards from server with retry logic
    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const startedAt = Date.now();
        let delay = INITIAL_RETRY_MS;

        const loadConfig = () => {
            api.getLayout()
                .then((data: LayoutResponse) => {
                    if (cancelled) return;
                    loadedRef.current = true;
                    setIsLoaded(true);

                    const loaded = parseLayoutResponse(data);
                    if (loaded) {
                        setSavedDashboards(loaded.dashboards);
                        setSavedActiveDashboardId(loaded.activeDashboardId);
                        onLoadedRef.current?.(loaded);
                    }
                })
                .catch((err: unknown) => {
                    if (cancelled) return;
                    const elapsed = Date.now() - startedAt;
                    if (elapsed + delay <= RETRY_WINDOW_MS) {
                        console.warn(`Dashboard config load failed (${err instanceof Error ? err.message : String(err)}); retrying in ${delay} ms`);
                        timer = setTimeout(loadConfig, delay);
                        delay = Math.min(delay * 2, MAX_RETRY_MS);
                    } else {
                        console.error(`Gave up loading dashboard config after ~${Math.round(RETRY_WINDOW_MS / 1000)} s; saving is disabled to avoid overwriting the stored layouts.`);
                    }
                });
        };

        loadConfig();

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, []);

    const saveDashboards = useCallback((dashboards: Dashboard[], activeDashboardId: string) => {
        // Optimistic update
        setSavedDashboards(dashboards);
        setSavedActiveDashboardId(activeDashboardId);

        if (!loadedRef.current) {
            console.warn("Skipping dashboard save: saved layouts have not been loaded from the server yet, so a save would overwrite them.");
            return;
        }

        api.saveLayout({ dashboards, activeDashboardId })
            .catch(err => console.error("Error saving dashboard config:", err));
    }, []);

    return { savedDashboards, savedActiveDashboardId, saveDashboards, isLoaded };
};
