import { cn } from "@/lib/utils";

interface MetricWidgetProps {
    value: string | number;
    label?: string;
    unit?: string;
    color?: string;
    /** Single-row layout for 1-row-tall widgets. */
    compact?: boolean;
    /** Secondary line, e.g. a band label. */
    hint?: string;
}

export function MetricWidget({ value, label, unit, color, compact = false, hint }: MetricWidgetProps) {
    const isEmpty = value === '—' || value === '' || value === null || value === undefined;

    if (compact) {
        return (
            <div className="flex items-baseline justify-end gap-1.5 h-full w-full" aria-label={`${label ?? ''} ${value}${unit ? ' ' + unit : ''}`.trim()}>
                <span className={cn("text-xl font-semibold tabular-nums", isEmpty && "text-muted-foreground")} style={{ color: isEmpty ? undefined : color }}>
                    {value}
                </span>
                {unit && !isEmpty && <span className="text-xs text-muted-foreground">{unit}</span>}
                {hint && <span className="text-[10px] text-muted-foreground ml-1">{hint}</span>}
            </div>
        );
    }

    return (
        <div className="flex flex-col items-center justify-center h-full">
            <div className={cn("text-4xl font-bold tabular-nums", isEmpty && "text-muted-foreground")} style={{ color: isEmpty ? undefined : color }}>
                {value}
                {unit && !isEmpty && <span className="text-xl ml-1 text-muted-foreground">{unit}</span>}
            </div>
            {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
            {label && <div className="text-sm text-muted-foreground mt-2">{label}</div>}
        </div>
    );
}
