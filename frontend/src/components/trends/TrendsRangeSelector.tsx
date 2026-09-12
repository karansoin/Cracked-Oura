import { cn } from '@/lib/utils';
import { TREND_RANGES, type TrendsRange } from '@/lib/trends';

interface TrendsRangeSelectorProps {
    value: TrendsRange;
    onChange: (range: TrendsRange) => void;
    className?: string;
}

/** Segmented 7D · 30D · 90D · 1Y · All control. */
export function TrendsRangeSelector({ value, onChange, className }: TrendsRangeSelectorProps) {
    return (
        <div className={cn("inline-flex h-9 items-center rounded-md border bg-background p-0.5", className)} role="group" aria-label="Trend range">
            {TREND_RANGES.map(r => (
                <button
                    key={r.id}
                    type="button"
                    aria-pressed={value === r.id}
                    onClick={() => onChange(r.id)}
                    className={cn(
                        "h-full rounded-sm px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        value === r.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                >
                    {r.label}
                </button>
            ))}
        </div>
    );
}
