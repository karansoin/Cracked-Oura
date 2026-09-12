import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SlidersHorizontal, X } from "lucide-react";
import { cn, isIntradayKey } from "@/lib/utils";
import { SidePanel, PanelSectionHeading } from "@/components/layout/SidePanel";
import { DataFieldSelector } from "./DataFieldSelector";
import type { WidgetInstance } from "@/types";


interface WidgetEditorPanelProps {
    onClose: () => void;
    onSave: (widget: Partial<WidgetInstance>) => void;
    onChange?: (widget: WidgetInstance) => void;
    widget?: WidgetInstance; // If provided, we are editing
}

const WIDGET_TYPES = ["score", "trend", "metric", "bar", "radar", "json", "table", "hypnogram", "contributors"] as const;
type WidgetType = typeof WIDGET_TYPES[number];
const isWidgetType = (v: string): v is WidgetType => (WIDGET_TYPES as readonly string[]).includes(v);

/** Accent swatches: Okabe-Ito hues shared with the charts. */
const ACCENTS = [
    { color: '#0072B2', label: 'Blue' },
    { color: '#009E73', label: 'Green' },
    { color: '#E69F00', label: 'Amber' },
    { color: '#D55E00', label: 'Vermillion' },
    { color: '#CC79A7', label: 'Purple' },
    { color: '#56B4E9', label: 'Sky' },
    { color: '#8AB4F8', label: 'Light blue' },
] as const;

export function WidgetEditorPanel({ onClose, onSave, onChange, widget }: WidgetEditorPanelProps) {
    const [title, setTitle] = useState("");
    const [type, setType] = useState<WidgetType>("score");
    const [dataKey, setDataKey] = useState("");
    const [dataKeys, setDataKeys] = useState<string[]>([]);
    const [color, setColor] = useState("#8AB4F8");
    const [dateRangeType, setDateRangeType] = useState<'all' | 'custom' | 'to_today' | 'last_30' | 'last_90' | 'selected_day' | 'relative'>('last_30');
    const [startDate, setStartDate] = useState("");
    const [endDate, setEndDate] = useState("");
    const [showPoints, setShowPoints] = useState(false);

    // Re-seed the form when a different widget is opened (derived-state-during-render
    // pattern: only reset when the widget ID changes, not on every update).
    const widgetKey = widget?.id ?? '__new__';
    const [syncedKey, setSyncedKey] = useState<string | null>(null);
    if (syncedKey !== widgetKey) {
        setSyncedKey(widgetKey);
        if (widget) {
            setTitle(widget.title);
            setType(isWidgetType(widget.type) ? widget.type : "score");
            setDataKey(widget.config.dataKey || "");
            setDataKeys(widget.config.dataKeys || (widget.config.dataKey ? [widget.config.dataKey] : []));
            setColor(widget.config.color || "#0072B2");
            setShowPoints(widget.config.showPoints || false);

            // Date Range
            if (widget.config.dateRange) {
                setDateRangeType(widget.config.dateRange.type);
                setStartDate(widget.config.dateRange.startDate || "");
                setEndDate(widget.config.dateRange.endDate || "");
            } else {
                setDateRangeType('last_30');
                setStartDate("");
                setEndDate("");
            }
        } else {
            // Defaults for new widget
            setTitle("New widget");
            setType("score");
            setDataKey("sleep.score");
            setDataKeys(["sleep.score"]);
            setColor("#0072B2");
            setShowPoints(false);
            setDateRangeType('last_30');
            setStartDate("");
            setEndDate("");
        }
    }

    // Helper to update parent
    const updateWidget = (updates: Partial<WidgetInstance>) => {
        if (widget && onChange) {
            onChange({
                ...widget,
                ...updates
            });
        }
    };

    // Define available data sources and which widget types they support
    const DATA_OPTIONS = [
        { value: "sleep.score", label: "sleep.score", types: ["score", "metric", "trend", "table"] },
        { value: "readiness.score", label: "readiness.score", types: ["score", "metric", "trend", "table"] },
        { value: "activity.score", label: "activity.score", types: ["score", "metric", "trend", "table"] },
        { value: "sleep.total_sleep_duration", label: "sleep.total_sleep_duration", types: ["metric", "trend", "table"] },
        { value: "sleep.average_spo2", label: "sleep.average_spo2", types: ["metric", "trend", "table"] },
        { value: "sleep.breathing_disturbance_index", label: "sleep.breathing_disturbance_index", types: ["metric", "trend", "table"] },
        { value: "activity.steps", label: "activity.steps", types: ["metric", "trend", "table"] },
        { value: "sleep.contributors", label: "sleep.contributors", types: ["contributors", "bar", "radar", "table"] },
        { value: "readiness.contributors", label: "readiness.contributors", types: ["contributors", "bar", "radar", "table"] },
        { value: "activity.contributors", label: "activity.contributors", types: ["contributors", "bar", "radar", "table"] },
        { value: "sleep_session.sleep_phase_5_min", label: "sleep_session.sleep_phase_5_min", types: ["hypnogram"] },
        { value: "sleep_session.lowest_heart_rate", label: "sleep_session.lowest_heart_rate", types: ["metric", "trend", "table"] },
        { value: "sleep_session.average_hrv", label: "sleep_session.average_hrv", types: ["metric", "trend", "table"] },
        { value: "readiness.temperature_deviation", label: "readiness.temperature_deviation", types: ["metric", "trend", "bar", "table"] },
        { value: "root", label: "full_dump (json)", types: ["json"] },
        { value: "sleep", label: "sleep (json)", types: ["json"] },
        { value: "readiness", label: "readiness (json)", types: ["json"] },
        { value: "activity", label: "activity (json)", types: ["json"] },
    ];

    const multiSelect = type === 'table' || type === 'trend' || type === 'bar' || type === 'radar';

    const handleSave = () => {
        onSave({
            ...(widget || {}),
            title,
            type,
            config: {
                dataKey,
                dataKeys,
                color,
                showPoints,
                dateRange: {
                    type: dateRangeType,
                    startDate: startDate || undefined,
                    endDate: endDate || undefined
                }
            }
        });
    };

    return (
        <SidePanel
            title={widget ? "Edit widget" : "Add widget"}
            subtitle="Changes preview live on the dashboard"
            icon={<SlidersHorizontal className="h-4 w-4" />}
            onClose={onClose}
            footer={(
                <div className="flex gap-2">
                    <Button variant="outline" className="flex-1" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button className="flex-1" onClick={handleSave}>
                        Done
                    </Button>
                </div>
            )}
        >
            <section className="space-y-3" aria-labelledby="editor-basics-heading">
                <PanelSectionHeading id="editor-basics-heading">Widget</PanelSectionHeading>
                <div className="space-y-2">
                    <Label htmlFor="title">Title</Label>
                    <Input
                        id="title"
                        value={title}
                        onChange={(e) => {
                            setTitle(e.target.value);
                            updateWidget({ title: e.target.value });
                        }}
                        placeholder="Widget title"
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="type">Type</Label>
                    <Select
                        value={type}
                        onValueChange={(value) => {
                            if (!isWidgetType(value)) return;
                            const v = value;
                            setType(v);
                            // Find the first valid data source for this new type
                            const validOptions = DATA_OPTIONS.filter(opt => opt.types.includes(v));
                            let newDataKey = dataKey;
                            if (validOptions.length > 0) {
                                newDataKey = validOptions[0].value;
                                setDataKey(newDataKey);
                                setDataKeys([newDataKey]);
                            }

                            updateWidget({
                                type: v,
                                config: { ...widget?.config, dataKey: newDataKey, dataKeys: [newDataKey], color }
                            });
                        }}
                    >
                        <SelectTrigger id="type">
                            <SelectValue placeholder="Choose a type" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="score">Score gauge</SelectItem>
                            <SelectItem value="metric">Number</SelectItem>
                            <SelectItem value="trend">Trend chart</SelectItem>
                            <SelectItem value="bar">Bar chart</SelectItem>
                            <SelectItem value="hypnogram">Hypnogram (sleep stages)</SelectItem>
                            <SelectItem value="contributors">Contributors</SelectItem>
                            <SelectItem value="radar">Radar chart</SelectItem>
                            <SelectItem value="table">Table</SelectItem>
                            <SelectItem value="json">Raw data (JSON)</SelectItem>
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        How the data is visualised. Changing the type picks a matching field.
                    </p>
                </div>
            </section>

            <section className="space-y-3" aria-labelledby="editor-data-heading">
                <PanelSectionHeading id="editor-data-heading">Data</PanelSectionHeading>
                <div className="space-y-2">
                    {/* Show selected keys for multi-select */}
                    {multiSelect && dataKeys.length > 0 && (
                        <ul className="flex flex-wrap gap-1.5" aria-label="Selected fields">
                            {dataKeys.map(key => (
                                <li key={key} className="flex h-7 items-center gap-1 rounded-md border bg-background pl-2 pr-1 font-mono text-xs">
                                    <span>{key}</span>
                                    <button
                                        type="button"
                                        aria-label={`Remove ${key}`}
                                        onClick={() => {
                                            const newKeys = dataKeys.filter(k => k !== key);
                                            setDataKeys(newKeys);
                                            // If no keys left, clear primary dataKey too
                                            const newDataKey = newKeys.length > 0 ? newKeys[newKeys.length - 1] : "";
                                            if (newKeys.length === 0) setDataKey("");

                                            updateWidget({
                                                config: { ...widget?.config, dataKeys: newKeys, dataKey: newDataKey, color }
                                            });
                                        }}
                                        className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}

                    <Label htmlFor="data-path">Field path</Label>
                    <Input
                        id="data-path"
                        value={dataKey}
                        onChange={(e) => {
                            setDataKey(e.target.value);
                            updateWidget({
                                config: { ...widget?.config, dataKey: e.target.value, color }
                            });
                        }}
                        placeholder="Pick a field below, or type a path such as sleep.score"
                        className="font-mono text-xs"
                    />
                    <DataFieldSelector
                        selectedPath={dataKey}
                        selectedPaths={dataKeys}
                        multiSelect={multiSelect}
                        onSelect={(path) => {
                            if (multiSelect) {
                                // Multi-select logic
                                let newKeys = [...dataKeys];
                                if (newKeys.includes(path)) {
                                    newKeys = newKeys.filter(k => k !== path);
                                } else {
                                    newKeys.push(path);
                                }
                                // Also update primary dataKey for backward compat or single-view
                                // Check compatibility
                                if (dataKeys.length > 0) {
                                    const firstKey = dataKeys[0];
                                    const isFirstIntraday = isIntradayKey(firstKey);
                                    const isNewIntraday = isIntradayKey(path);

                                    if (isFirstIntraday !== isNewIntraday) {
                                        // Incompatible types
                                        // Ideally show a toast, but for now just ignore or alert
                                        console.warn("Cannot mix Intraday and Daily data points.");
                                        return;
                                    }
                                }

                                setDataKeys(newKeys);

                                // Update primary dataKey to the last selected one, or clear if empty
                                // If we just removed 'path', we should pick another one.
                                const finalDataKey = newKeys.length > 0 ? newKeys[newKeys.length - 1] : "";

                                setDataKey(finalDataKey);
                                updateWidget({
                                    config: { ...widget?.config, dataKeys: newKeys, dataKey: finalDataKey, color }
                                });
                            } else {
                                // Single select
                                setDataKey(path);
                                updateWidget({
                                    config: { ...widget?.config, dataKey: path, color }
                                });
                            }
                        }}
                        isSelectable={(field) => {
                            // 1. Check for incompatible field names (timestamp, etc.)
                            if (type === 'trend' || type === 'bar' || type === 'radar') {
                                const lower = field.toLowerCase();
                                if (lower.endsWith('_time') ||
                                    lower.endsWith('_date') ||
                                    lower.endsWith('_id') ||
                                    lower.endsWith('_code') ||
                                    lower === 'comment' ||
                                    lower === 'day' ||
                                    lower === 'timestamp') {
                                    return false;
                                }
                            }



                            return true;
                        }}
                    />
                </div>
            </section>

            <section className="space-y-3" aria-labelledby="editor-style-heading">
                <PanelSectionHeading id="editor-style-heading">Appearance</PanelSectionHeading>
                <div className="space-y-2">
                    <Label id="accent-label">Accent color</Label>
                    <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-labelledby="accent-label">
                        {ACCENTS.map(({ color: c, label }) => (
                            <button
                                key={c}
                                type="button"
                                role="radio"
                                aria-checked={color === c}
                                className={cn(
                                    "flex h-8 items-center gap-2 rounded-md border px-2 text-left text-xs transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    color === c ? "border-foreground/40 bg-accent font-medium" : "border-transparent text-muted-foreground"
                                )}
                                onClick={() => {
                                    setColor(c);
                                    updateWidget({
                                        config: { ...widget?.config, dataKey, color: c }
                                    });
                                }}
                            >
                                <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ backgroundColor: c }} aria-hidden="true" />
                                <span>{label}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {type === 'trend' && (
                    <div className="flex items-center justify-between gap-3 rounded-md border bg-background p-3">
                        <Label htmlFor="show-points" className="flex flex-col gap-1">
                            <span>Show data points</span>
                            <span className="text-xs font-normal text-muted-foreground">Draw a dot for every value</span>
                        </Label>
                        <Switch
                            id="show-points"
                            checked={showPoints}
                            onCheckedChange={(checked) => {
                                setShowPoints(checked);
                                updateWidget({
                                    config: { ...widget?.config, dataKey, color, showPoints: checked }
                                });
                            }}
                        />
                    </div>
                )}
            </section>
        </SidePanel>
    );
}
