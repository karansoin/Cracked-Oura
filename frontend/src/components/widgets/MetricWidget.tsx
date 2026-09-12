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

/** Big-number widget. Numbers are tabular; the unit sits on the baseline in muted text. */
export function MetricWidget({ value, label, unit, color, compact = false, hint }: MetricWidgetProps) {
    const isEmpty = value === '—' || value === '' || value === null || value === undefined;

    if (compact) {
        return (
            <div className="flex h-full w-full items-baseline justify-end gap-1 whitespace-nowrap" aria-label={`${label ?? ''} ${value}${unit ? ' ' + unit : ''}`.trim()}>
                <span className={cn("text-xl font-semibold tabular-nums leading-none", isEmpty && "text-muted-foreground")} style={{ color: isEmpty ? undefined : color }}>
                    {value}
                </span>
                {unit && !isEmpty && <span className="text-xs text-muted-foreground">{unit}</span>}
                {hint && <span className="ml-1 text-xs text-muted-foreground">{hint}</span>}
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col items-center justify-center">
            <div className={cn("flex items-baseline gap-1.5 text-4xl font-semibold tabular-nums leading-none tracking-tight", isEmpty && "text-muted-foreground")} style={{ color: isEmpty ? undefined : color }}>
                <span>{value}</span>
                {unit && !isEmpty && <span className="text-base font-normal text-muted-foreground">{unit}</span>}
            </div>
            {hint && <div className="mt-2 text-xs text-muted-foreground">{hint}</div>}
            {label && <div className="mt-1 text-xs text-muted-foreground">{label}</div>}
        </div>
    );
}
