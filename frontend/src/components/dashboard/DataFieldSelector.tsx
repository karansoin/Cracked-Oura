import { useState, useEffect } from 'react';
import { api } from "@/lib/api";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { humanizeKey } from "@/lib/format";
import {
    ChevronRight,
    ChevronDown,
    Database,
    Moon,
    Activity,
    Zap,
    Brain,
    Heart,
    Battery,
    Thermometer,
    Flame,
    Tag,
    type LucideIcon,
} from 'lucide-react';

// --- Types ---
interface SchemaNode {
    icon?: LucideIcon;
    fields?: string[];
    children?: Record<string, SchemaNode>;
}

// --- Constants ---
const ICON_MAP: Record<string, LucideIcon> = {
    sleep: Moon,
    activity: Activity,
    readiness: Zap,
    resilience: Brain,
    cardiovascular_age: Heart,
    sleep_session: Moon,
    workout: Activity,
    meditation: Brain,
    ring_battery: Battery,
    stress: Flame,
    heart_rate: Heart,
    temperature: Thermometer,
    ring_configuration: Tag,
    tag: Tag
};

const JSON_HINTS: Record<string, Record<string, SchemaNode | string[]>> = {
    sleep: {
        contributors: {
            fields: ['deep_sleep', 'efficiency', 'latency', 'rem_sleep', 'restfulness', 'timing', 'total_sleep']
        }
    },
    readiness: {
        contributors: {
            fields: ['activity_balance', 'body_temperature', 'hrv_balance', 'previous_day_activity', 'previous_night', 'recovery_index', 'resting_heart_rate', 'sleep_balance']
        }
    },
    activity: {
        contributors: {
            fields: ['meet_daily_targets', 'move_every_hour', 'recovery_time', 'stay_active', 'training_frequency', 'training_volume']
        }
    }
};

interface FieldNodeProps {
    name: string;
    node: SchemaNode;
    pathPrefix: string;
    onSelect: (path: string) => void;
    selectedPath?: string;
    selectedPaths?: string[];
    multiSelect?: boolean;
    level?: number;
    filter?: (field: string, domain: string) => boolean;
    isSelectable?: (field: string, domain: string) => boolean;
}

function FieldNode({ name, node, pathPrefix, onSelect, selectedPath, selectedPaths, multiSelect, level = 0, filter, isSelectable }: FieldNodeProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const Icon = node.icon || Database;
    const hasChildren = (node.fields && node.fields.length > 0) || (node.children && Object.keys(node.children).length > 0);

    const toggle = () => setIsExpanded(!isExpanded);

    return (
        <div className="space-y-0.5">
            <div
                className="flex items-center w-full gap-1"
                style={{ paddingLeft: level > 0 ? `${level * 12}px` : undefined }}
            >
                {hasChildren ? (
                    <button
                        type="button"
                        onClick={toggle}
                        aria-label={isExpanded ? `Collapse ${name}` : `Expand ${name}`}
                        aria-expanded={isExpanded}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    </button>
                ) : <span className="w-7 shrink-0" />}

                <button
                    type="button"
                    onClick={() => {
                        if (hasChildren) {
                            toggle();
                        } else {
                            onSelect(pathPrefix || name);
                        }
                    }}
                    className={cn(
                        "flex flex-1 items-center gap-2 rounded-sm p-1.5 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        "hover:bg-accent/60",
                        level > 0 && "text-xs",
                        !multiSelect && selectedPath === (pathPrefix || name) && "bg-accent text-foreground"
                    )}
                >
                    {multiSelect && !hasChildren && (
                        <Checkbox
                            checked={selectedPaths?.includes(pathPrefix || name)}
                            onCheckedChange={() => onSelect(pathPrefix || name)}
                            className="mr-2 h-3.5 w-3.5"
                        />
                    )}
                    {level === 0 && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                    <span className="truncate">{humanizeKey(name)}</span>
                </button>
            </div>

            {isExpanded && (
                <div className="space-y-0.5">
                    {/* Render Fields */}
                    {node.fields?.filter(field => !filter || filter(field, name)).map(field => {
                        const path = pathPrefix ? `${pathPrefix}.${field}` : field;
                        const isSelected = multiSelect ? selectedPaths?.includes(path) : selectedPath === path;
                        const selectable = !isSelectable || isSelectable(field, name);

                        return (
                            <button
                                key={field}
                                type="button"
                                onClick={() => selectable && onSelect(path)}
                                disabled={!selectable}
                                aria-pressed={multiSelect ? undefined : !!isSelected}
                                title={path}
                                className={cn(
                                    "flex min-h-7 w-full items-center rounded-sm py-1 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    !selectable && "cursor-not-allowed opacity-50",
                                    !multiSelect && isSelected
                                        ? "bg-accent font-medium text-foreground"
                                        : selectable ? "text-muted-foreground hover:bg-accent/60 hover:text-foreground" : "text-muted-foreground"
                                )}
                                style={{ paddingLeft: `${(level + 1) * 12 + 28}px` }}
                            >
                                {multiSelect && (
                                    <Checkbox
                                        checked={isSelected}
                                        onCheckedChange={() => selectable && onSelect(path)}
                                        disabled={!selectable}
                                        className="mr-2 h-3.5 w-3.5"
                                    />
                                )}
                                <span className="truncate">{humanizeKey(field)}</span>
                            </button>
                        );
                    })}

                    {/* Render Children (Nested Objects) */}
                    {node.children && Object.entries(node.children).map(([childName, childNode]) => (
                        <FieldNode
                            key={childName}
                            name={childName}
                            node={childNode}
                            pathPrefix={pathPrefix ? `${pathPrefix}.${childName}` : childName}
                            onSelect={onSelect}
                            selectedPath={selectedPath}
                            selectedPaths={selectedPaths}
                            multiSelect={multiSelect}
                            level={level + 1}
                            filter={filter}
                            isSelectable={isSelectable}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export interface DataFieldSelectorProps {
    onSelect: (path: string) => void;
    selectedPath?: string;
    selectedPaths?: string[];

    multiSelect?: boolean;
    filter?: (field: string, domain: string) => boolean;
    isSelectable?: (field: string, domain: string) => boolean;
}

export function DataFieldSelector({ onSelect, selectedPath, selectedPaths, multiSelect, filter, isSelectable }: DataFieldSelectorProps) {
    const [schema, setSchema] = useState<Record<string, SchemaNode>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        api.getSchema()
            .then((data) => {
                const newSchema: Record<string, SchemaNode> = {};

                Object.entries(data).forEach(([domain, fields]) => {
                    const node: SchemaNode = {
                        icon: ICON_MAP[domain] || Database,
                        fields: [],
                        children: {}
                    };

                    fields.forEach(f => {
                        if (f.is_json) {
                            // It's a JSON column, check hints
                            const hints = JSON_HINTS[domain]?.[f.name];
                            if (hints) {
                                if (Array.isArray(hints)) {
                                    // Legacy array format
                                    node.children![f.name] = {
                                        fields: hints
                                    };
                                } else {
                                    // New object format with nested structure
                                    node.children![f.name] = hints;
                                }
                            } else {
                                // No hints, just show as field (or maybe generic 'json' node?)
                                node.fields!.push(f.name);
                            }
                        } else {
                            node.fields!.push(f.name);
                        }
                    });

                    newSchema[domain] = node;
                });

                if (Object.keys(newSchema).length === 0) {
                    setError("Schema is empty (No models found)");
                }

                setSchema(newSchema);
                setLoading(false);
            })
            .catch(err => {
                console.error("Failed to fetch schema:", err);
                setError(err.message);
                setLoading(false);
            });
    }, []);

    if (loading) {
        return <div className="rounded-md border border-dashed p-4 text-xs text-muted-foreground" aria-busy="true">Loading fields…</div>;
    }

    if (error) {
        return <div className="rounded-md border border-dashed border-destructive/40 p-4 text-xs text-destructive" role="alert">Couldn't load the fields: {error}</div>;
    }

    return (
        <div className="flex h-[300px] flex-col rounded-md border bg-background">
            <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                Available fields
            </div>
            <ScrollArea className="flex-1">
                <div className="p-2 space-y-1">
                    {Object.entries(schema).map(([domain, node]) => (
                        <FieldNode
                            key={domain}
                            name={domain}
                            node={node}
                            pathPrefix={domain}
                            onSelect={onSelect}
                            selectedPath={selectedPath}
                            selectedPaths={selectedPaths}
                            multiSelect={multiSelect}
                            filter={filter}
                            isSelectable={isSelectable}
                        />
                    ))}
                </div>
            </ScrollArea>
        </div>
    );
}
