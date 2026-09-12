import { ScrollArea } from "@/components/ui/scroll-area";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { formatDay, humanizeKey } from "@/lib/format";

type Row = Record<string, unknown>;

interface TableWidgetProps {
    data: Row[];
    dataKeys: string[];
    selectedDate?: string;
}

const isRecord = (value: unknown): value is Row => value !== null && typeof value === 'object';

/**
 * Keys whose numeric value is a duration in SECONDS: `*_duration`, `latency`,
 * `time_in_bed`, `awake_time`. Note `restless_periods` is a COUNT, not a duration.
 */
const isDurationKey = (lastSegment: string) =>
    lastSegment.endsWith('_duration') ||
    lastSegment === 'latency' ||
    lastSegment === 'time_in_bed' ||
    lastSegment === 'awake_time';

export function TableWidget({ data, dataKeys, selectedDate }: TableWidgetProps) {
    // 1. Find the relevant row for the selected date
    const selectedRow = data.find(row => {
        if (!selectedDate) return true; // Fallback to first if no date

        // Check timestamp match
        if (typeof row.timestamp === 'string') {
            const rowDate = row.timestamp.split('T')[0];
            return rowDate === selectedDate;
        }
        // Check date/day match
        if (row.date === selectedDate) return true;
        if (row.day === selectedDate) return true;

        return false;
    });

    if (!selectedRow) {
        return (
            <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed p-4 text-center">
                <span className="text-sm font-medium text-foreground">No data for {selectedDate ? formatDay(selectedDate) : 'this day'}</span>
                <span className="mt-1 text-xs text-muted-foreground">Pick another day in the top bar</span>
            </div>
        );
    }

    // 2. Determine keys to display
    // If keys provided, use them. Otherwise use all keys except meta.
    const displayKeys = dataKeys.length > 0
        ? dataKeys
        : Object.keys(selectedRow).filter(k => !['timestamp', 'date', 'day', 'id'].includes(k));

    // Helper to get nested value
    const getValue = (obj: Row, path: string): unknown => {
        if (obj[path] !== undefined) return obj[path];
        return path.split('.').reduce<unknown>((acc, part) => (isRecord(acc) ? acc[part] : undefined), obj);
    };

    // Helper to format duration (seconds -> "7h 55m" or "45m")
    const formatDuration = (seconds: number) => {
        if (!seconds) return '—';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    };

    // Helper to format time (ISO -> HH:mm)
    const formatTime = (isoString: string) => {
        if (!isoString) return '—';
        try {
            return format(parseISO(isoString), 'HH:mm');
        } catch {
            return isoString;
        }
    };

    // Helper to format value based on key context
    const formatValue = (val: unknown, key: string) => {
        const k = key.toLowerCase();
        const field = k.split('.').pop() || k;

        if (val === null || val === undefined) return '—';

        // 1. Time / Dates
        if (typeof val === 'string' && (k.includes('start') || k.includes('end') || k.includes('timestamp') || k.includes('bedtime') || k.includes('wakeup'))) {
            // If it looks like a full ISO string, extract time
            if (val.includes('T')) return formatTime(val);
            return val;
        }

        // 2. Durations (Oura sends seconds). Only explicit duration fields qualify;
        //    counts like `restless_periods` fall through to the numeric formatting below.
        if (typeof val === 'number' && isDurationKey(field)) {
            return formatDuration(val);
        }

        // 3. Scores / Percentages (Round to int)
        if (typeof val === 'number' && (k.includes('score') || k.includes('efficiency') || k.includes('percent') || k.includes('activity_daily_target'))) {
            return Math.round(val).toString();
        }

        // 4. Specific Metrics
        if (typeof val === 'number') {
            if (k.includes('heart_rate') || k.includes('hrv') || k.includes('breath')) return Math.round(val).toString();
            if (k.includes('temperature')) return val.toFixed(2);

            // Generic decimals
            if (Number.isInteger(val)) return val.toLocaleString();
            return val.toLocaleString(undefined, { maximumFractionDigits: 2 });
        }

        return typeof val === 'object' ? JSON.stringify(val) : String(val);
    };

    return (
        <div className="flex h-full w-full flex-col">
            {/* Day the values belong to */}
            <div className="mb-1 flex items-center justify-between border-b pb-2 text-xs text-muted-foreground">
                <span>{selectedDate ? formatDay(selectedDate) : 'Latest'}</span>
            </div>

            <ScrollArea className="-mr-3 flex-1 pr-3">
                <dl className="flex flex-col">
                    {displayKeys.map(key => {
                        const rawVal = getValue(selectedRow, key);
                        const displayVal = formatValue(rawVal, key);
                        const label = humanizeKey(key);

                        return (
                            <div
                                key={key}
                                className="group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/60"
                            >
                                <dt className="truncate text-sm text-muted-foreground transition-colors group-hover:text-foreground">
                                    {label}
                                </dt>
                                <dd className={cn(
                                    "shrink-0 text-sm font-medium",
                                    typeof rawVal === 'number' && "tabular-nums",
                                    displayVal === '—' && "text-muted-foreground"
                                )}>
                                    {displayVal}
                                </dd>
                            </div>
                        );
                    })}
                </dl>
            </ScrollArea>
        </div>
    );
}
