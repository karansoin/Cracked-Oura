import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { ChartTable } from '@/lib/series-table';

interface ChartTableContextValue {
    /** True when the card asked the chart to render its series as a table. */
    viewAsTable: boolean;
    /** Charts publish their plotted series here so the card can copy it as CSV. */
    publish: (table: ChartTable | null) => void;
}

const ChartTableContext = createContext<ChartTableContextValue | undefined>(undefined);

export function ChartTableProvider({ value, children }: { value: ChartTableContextValue; children: ReactNode }) {
    return <ChartTableContext.Provider value={value}>{children}</ChartTableContext.Provider>;
}

/**
 * Used by chart canvases: publishes `table` to the surrounding widget card (if any)
 * and returns whether the card wants the table rendered instead of the canvas.
 */
// eslint-disable-next-line react-refresh/only-export-components -- context hook lives with its provider
export function useChartTable(table: ChartTable | null): boolean {
    const ctx = useContext(ChartTableContext);
    const publish = ctx?.publish;
    useEffect(() => {
        if (!publish) return;
        publish(table);
        return () => publish(null);
    }, [publish, table]);
    return ctx?.viewAsTable ?? false;
}
