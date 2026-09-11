import { useMemo } from 'react';
import { format } from 'date-fns';
import RGL, { WidthProvider } from 'react-grid-layout/legacy';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { WidgetCard } from './WidgetCard';
import { WidgetRegistry } from '../WidgetRegistry';
import type { WidgetInstance, LayoutItem } from '@/types';
import { cn, isIntradayKey } from '@/lib/utils';

import { DateRangeSelector } from './DateRangeSelector';

import { ErrorBoundary } from '../ErrorBoundary';

const GridLayout = WidthProvider(RGL);

const DEFAULT_WIDGET_W = 4;
const DEFAULT_WIDGET_H = 4;

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
    selectedDate
}: DashboardGridProps) {
    const dateString = format(selectedDate, 'yyyy-MM-dd');

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
        // This ensures the button is always visible for charts that support it, INCLUDING intraday ones (so user can pick "Selected Day")
        const supportsDateRange = widget.type === 'trend' || widget.type === 'bar';
        const showDateSelector = (!!widget.config.dateRange || supportsDateRange) && widget.type !== 'table';

        return (
            <WidgetCard
                title={widget.title}
                subtitle={undefined}
                isEditing={isEditing}
                onEdit={() => onEditWidget?.(widget)}
                onDelete={() => onDeleteWidget?.(widget.id)}
                className="h-full"
                headerContent={showDateSelector && (
                    <DateRangeSelector
                        widget={widget}
                        onUpdate={(updates) => onWidgetChange?.({ ...widget, ...updates })}
                        selectedDate={selectedDate}
                        isLocked={isIntradayKey(widget.config.dataKey || widget.config.dataKeys?.[0] || '')}
                    />
                )}
            >
                <div className="h-full pt-2">
                    <ErrorBoundary>
                        <WidgetRegistry widget={widget} data={data} date={dateString} />
                    </ErrorBoundary>
                </div>
            </WidgetCard>
        );
    };

    return (
        <div className={cn("w-full", isEditing && "bg-secondary/10 rounded-xl border border-dashed border-secondary/50")}>
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
                    className="grid grid-cols-12 gap-4 p-4"
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
