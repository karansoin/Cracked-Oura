import { useCallback, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { Copy, Table2 } from 'lucide-react';
import RGL, { WidthProvider } from 'react-grid-layout/legacy';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { WidgetCard, type WidgetMenuItem } from './WidgetCard';
import { WidgetRegistry } from '../WidgetRegistry';
import { ChartTableProvider } from '@/contexts/ChartTableContext';
import { copyTableAsCsv, type ChartTable } from '@/lib/series-table';
import type { HypnogramOverlay } from '../widgets/HypnogramCanvas';
import type { WidgetInstance, LayoutItem } from '@/types';
import { cn, isIntradayKey } from '@/lib/utils';

import { DateRangeSelector } from './DateRangeSelector';

import { ErrorBoundary } from '../ErrorBoundary';

const GridLayout = WidthProvider(RGL);

const DEFAULT_WIDGET_W = 4;
const DEFAULT_WIDGET_H = 4;

/** Widget types that plot a series and therefore get "View as table" / "Copy CSV". */
const CHART_TYPES = new Set(['trend', 'bar', 'hypnogram', 'radar']);
/** Hypnogram widgets shorter than this hide the HR/HRV overlay. */
const OVERLAY_MIN_H = 4;
const DEFAULT_OVERLAY: HypnogramOverlay = { hr: true, hrv: false };

/** Mutable store of the series each chart published; only touched from callbacks. */
function useChartTableStore() {
    const ref = useRef(new Map<string, ChartTable | null>());
    const publish = useCallback((id: string, table: ChartTable | null) => { ref.current.set(id, table); }, []);
    const get = useCallback((id: string) => ref.current.get(id), []);
    return { publish, get };
}


interface DashboardGridProps {
    widgets: WidgetInstance[];
    layout: LayoutItem[];
    isEditing: boolean;
    onLayoutChange: (layout: LayoutItem[]) => void;
    onEditWidget?: (widget: WidgetInstance) => void;
    onWidgetChange?: (widget: WidgetInstance) => void;
    onDeleteWidget?: (widgetId: string) => void;

    data?: unknown;
    selectedDate: Date;
    /** True while the selected day's payload is loading (widgets show skeletons). */
    isLoading?: boolean;
}

/** Keep only the fields we persist from react-grid-layout's richer layout items. */
const toLayoutItem = (item: { i: string; x: number; y: number; w: number; h: number; moved?: boolean; static?: boolean }): LayoutItem => {
    const result: LayoutItem = { i: item.i, x: item.x, y: item.y, w: item.w, h: item.h };
    if (item.moved !== undefined) result.moved = item.moved;
    if (item.static !== undefined) result.static = item.static;
    return result;
};

export function DashboardGrid({
    widgets,
    layout,
    isEditing,
    onLayoutChange,
    onEditWidget,
    onWidgetChange,
    onDeleteWidget,
    data,
    selectedDate,
    isLoading = false
}: DashboardGridProps) {
    const dateString = format(selectedDate, 'yyyy-MM-dd');

    // Per-widget presentation state (not persisted): table mode, the series each chart
    // published (for Copy CSV), and the hypnogram HR/HRV toggles.
    const [tableMode, setTableMode] = useState<ReadonlySet<string>>(new Set());
    const tables = useChartTableStore();
    const [overlays, setOverlays] = useState<Record<string, HypnogramOverlay>>({});

    const toggleTableMode = useCallback((id: string) => {
        setTableMode(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const toggleOverlay = useCallback((id: string, key: keyof HypnogramOverlay) => {
        setOverlays(prev => {
            const current = prev[id] ?? DEFAULT_OVERLAY;
            return { ...prev, [id]: { ...current, [key]: !current[key] } };
        });
    }, []);

    // Stable publish callbacks per widget id (the chart-table context value must not churn).
    const widgetIds = widgets.map(w => w.id).join('|');
    const publishers = useMemo(() => {
        const map = new Map<string, (table: ChartTable | null) => void>();
        for (const id of widgetIds.split('|')) {
            map.set(id, (table) => tables.publish(id, table));
        }
        return map;
    }, [widgetIds, tables]);
    const noopPublish: (table: ChartTable | null) => void = useCallback(() => undefined, []);

    // Every widget needs a layout entry. Widgets without one (e.g. a layout saved before
    // the widget was added) previously vanished; instead give each a default slot on its
    // own row below the bottom-most existing item. Props are never mutated.
    const { items: effectiveLayout, byId: layoutById } = useMemo(() => {
        const byId = new Map<string, LayoutItem>(layout.map(item => [item.i, item]));
        const items = [...layout];
        let nextY = layout.reduce((max, item) => {
            const bottom = item.y + item.h;
            return Number.isFinite(bottom) ? Math.max(max, bottom) : max;
        }, 0);

        for (const widget of widgets) {
            if (byId.has(widget.id)) continue;
            const item: LayoutItem = { i: widget.id, x: 0, y: nextY, w: DEFAULT_WIDGET_W, h: DEFAULT_WIDGET_H };
            items.push(item);
            byId.set(widget.id, item);
            nextY += DEFAULT_WIDGET_H;
        }

        return { items, byId };
    }, [layout, widgets]);

    const renderWidget = (widget: WidgetInstance) => {
        const layoutItem = layoutById.get(widget.id);
        const h = layoutItem?.h ?? DEFAULT_WIDGET_H;
        const compact = h <= 1;

        // This ensures the button is always visible for charts that support it, INCLUDING intraday ones (so user can pick "Selected Day")
        const supportsDateRange = widget.type === 'trend' || widget.type === 'bar';
        const showDateSelector = !compact && (!!widget.config.dateRange || supportsDateRange) && widget.type !== 'table';

        const isChart = CHART_TYPES.has(widget.type) && !compact;
        const viewAsTable = isChart && tableMode.has(widget.id);
        const menuItems: WidgetMenuItem[] | undefined = isChart ? [
            {
                id: 'table',
                label: 'View as table',
                icon: <Table2 aria-hidden="true" />,
                checked: viewAsTable,
                onSelect: () => toggleTableMode(widget.id),
            },
            {
                id: 'csv',
                label: 'Copy CSV',
                icon: <Copy aria-hidden="true" />,
                onSelect: () => { void copyTableAsCsv(tables.get(widget.id), widget.title); },
            },
        ] : undefined;

        const showOverlay = widget.type === 'hypnogram' && !compact && h >= OVERLAY_MIN_H;
        const overlay = showOverlay ? (overlays[widget.id] ?? DEFAULT_OVERLAY) : null;
        const overlayToggles = overlay && !viewAsTable && (
            <div className="flex items-center gap-1" role="group" aria-label="Overlay lines">
                {(['hr', 'hrv'] as const).map(key => (
                    <button
                        key={key}
                        type="button"
                        aria-pressed={overlay[key]}
                        onClick={() => toggleOverlay(widget.id, key)}
                        className={cn(
                            "h-7 rounded-md border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            overlay[key] ? "border-transparent bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                        )}
                    >
                        {key.toUpperCase()}
                    </button>
                ))}
            </div>
        );

        const chartTableValue = { viewAsTable, publish: publishers.get(widget.id) ?? noopPublish };

        return (
            <WidgetCard
                title={widget.title}
                subtitle={undefined}
                isEditing={isEditing}
                onEdit={() => onEditWidget?.(widget)}
                onDelete={() => onDeleteWidget?.(widget.id)}
                className="h-full"
                compact={compact}
                menuItems={menuItems}
                headerContent={(
                    <>
                        {overlayToggles}
                        {showDateSelector && (
                            <DateRangeSelector
                                widget={widget}
                                onUpdate={(updates) => onWidgetChange?.({ ...widget, ...updates })}
                                selectedDate={selectedDate}
                                isLocked={isIntradayKey(widget.config.dataKey || widget.config.dataKeys?.[0] || '')}
                            />
                        )}
                    </>
                )}
            >
                <div className="h-full">
                    <ErrorBoundary resetKeys={[dateString, widget.type, widget.config.dataKey]}>
                        <ChartTableProvider value={chartTableValue}>
                            <WidgetRegistry
                                widget={widget}
                                data={data}
                                date={dateString}
                                compact={compact}
                                isLoading={isLoading}
                                overlay={overlay}
                            />
                        </ChartTableProvider>
                    </ErrorBoundary>
                </div>
            </WidgetCard>
        );
    };

    return (
        <div className={cn("w-full", isEditing && "-m-4 w-[calc(100%+2rem)] rounded-lg border border-dashed border-foreground/20 bg-secondary/20")}>
            {isEditing ? (
                <GridLayout
                    className="layout"
                    layout={effectiveLayout}
                    cols={12}
                    rowHeight={60}
                    isDraggable={isEditing}
                    isResizable={isEditing}
                    onLayoutChange={(next) => onLayoutChange(next.map(toLayoutItem))}
                    margin={[16, 16]}
                    containerPadding={[16, 16]}
                    draggableHandle=".drag-handle"
                    measureBeforeMount
                >
                    {widgets.map((widget) => (
                        <div key={widget.id} className="relative group">
                            {renderWidget(widget)}
                        </div>
                    ))}
                </GridLayout>
            ) : (
                <div
                    className="grid grid-cols-12 gap-4"
                    style={{
                        gridAutoRows: '60px'
                    }}
                >
                    {widgets.map((widget) => {
                        const layoutItem = layoutById.get(widget.id);
                        if (!layoutItem) return null; // unreachable: effectiveLayout covers every widget

                        return (
                            <div
                                key={widget.id}
                                className="relative group"
                                style={{
                                    gridColumn: `${(layoutItem.x || 0) + 1} / span ${layoutItem.w || 1}`,
                                    gridRow: `${(layoutItem.y || 0) + 1} / span ${layoutItem.h || 1}`
                                }}
                            >
                                {renderWidget(widget)}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
