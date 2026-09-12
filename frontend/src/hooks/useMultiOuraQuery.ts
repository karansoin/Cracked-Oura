import { useState, useEffect, useMemo } from 'react';

import { api } from "@/lib/api";

type MergedRow = Record<string, unknown> & { date: string; timestamp: string };

export function useMultiOuraQuery(paths: string[], startDate?: string, endDate?: string) {
    const [data, setData] = useState<MergedRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Stable identity for the path list so callers can pass fresh arrays each render.
    const pathsKey = JSON.stringify(paths ?? []);
    const stablePaths = useMemo(() => JSON.parse(pathsKey) as string[], [pathsKey]);

    useEffect(() => {
        if (stablePaths.length === 0) {
            setData([]);
            return;
        }

        let cancelled = false;

        const fetchData = async () => {
            setLoading(true);
            setError(null);
            try {
                // Fetch all paths in parallel
                const results = await Promise.all(stablePaths.map(async (path) => ({
                    path,
                    data: await api.getQuery(path, startDate, endDate),
                })));
                if (cancelled) return;

                // Merge data by date
                const mergedMap = new Map<string, MergedRow>();

                results.forEach(({ path, data }) => {
                    data.forEach(item => {
                        const dateKey = item.date;
                        let entry = mergedMap.get(dateKey);
                        if (!entry) {
                            entry = {
                                date: dateKey,
                                timestamp: dateKey // Ensure timestamp exists for charts
                            };
                            mergedMap.set(dateKey, entry);
                        }
                        entry[path] = item.value;
                    });
                });

                // Convert map to array and sort by date
                const mergedArray = Array.from(mergedMap.values()).sort((a, b) =>
                    new Date(a.date).getTime() - new Date(b.date).getTime()
                );

                setData(mergedArray);
            } catch (err) {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : 'Unknown error');
                console.error("Multi Query Error:", err);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        void fetchData();
        return () => { cancelled = true; };
    }, [stablePaths, startDate, endDate]);

    return { data, loading, error };
}
