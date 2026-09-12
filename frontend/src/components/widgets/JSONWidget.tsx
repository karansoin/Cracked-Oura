import { useState, useEffect } from 'react';
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { ChevronRight, ChevronDown, Loader2 } from "lucide-react";

interface JSONWidgetProps {
    data: unknown;
    date?: string;
    fetchFullDump?: boolean;
}

const asObject = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const JsonNode = ({ label, data, level = 0 }: { label: string, data: unknown, level?: number }) => {
    const [isOpen, setIsOpen] = useState(false);
    const obj = asObject(data);
    const isEmpty = obj !== null && Object.keys(obj).length === 0;

    if (obj === null) {
        // Okabe-Ito palette (text-safe variants on light): strings green, numbers blue, booleans purple.
        let color = "text-[#007A59] dark:text-[#3FC9A2]";
        if (typeof data === 'number') color = "text-[#0072B2] dark:text-[#5AA9E6]";
        if (typeof data === 'boolean') color = "text-[#A0568A] dark:text-[#CC79A7]";
        if (data === null) color = "text-muted-foreground";

        return (
            <div style={{ paddingLeft: level * 20 }} className="flex items-start rounded px-1 py-0.5 font-mono text-xs hover:bg-accent/60">
                <span className="text-muted-foreground mr-2 shrink-0">{label}:</span>
                <span className={cn("break-all", color)}>{JSON.stringify(data)}</span>
            </div>
        );
    }

    return (
        <div className="font-mono text-xs">
            <button
                type="button"
                onClick={() => !isEmpty && setIsOpen(!isOpen)}
                aria-expanded={isEmpty ? undefined : isOpen}
                disabled={isEmpty}
                style={{ paddingLeft: level * 20 }}
                className={cn(
                    "flex w-full select-none items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isEmpty && "cursor-default opacity-50"
                )}
            >
                <span className="text-muted-foreground w-4 flex justify-center shrink-0">
                    {isEmpty ? '•' : (isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />)}
                </span>
                <span className="text-foreground font-medium">{label}</span>
                {Array.isArray(data) && (
                    <span className="ml-1 text-xs text-muted-foreground">[{data.length}]</span>
                )}
            </button>

            {isOpen && (
                <div className="border-l border-border ml-2 pl-2 my-1">
                    {Object.entries(obj).map(([key, value]) => (
                        <JsonNode key={key} label={key} data={value} level={0} />
                    ))}
                </div>
            )}
        </div>
    );
};

/** Result of the last detailed-day fetch, tagged with the date it belongs to. */
interface FetchedDump {
    date: string;
    data: unknown;
}

export function JSONWidget({ data, date, fetchFullDump }: JSONWidgetProps) {
    const [fetched, setFetched] = useState<FetchedDump | null>(null);

    useEffect(() => {
        if (!fetchFullDump || !date) return;

        let cancelled = false;
        api.getDailyDataDetailed(date)
            .then(json => {
                if (!cancelled) setFetched({ date, data: json });
            })
            .catch(err => {
                console.error("Error fetching full dump:", err);
                if (!cancelled) setFetched({ date, data: null });
            });

        return () => { cancelled = true; };
    }, [date, fetchFullDump]);

    const wantsFullDump = !!(fetchFullDump && date);
    // Loading is derived: we want a dump and the one we hold is for a different date.
    const loading = wantsFullDump && fetched?.date !== date;
    const displayData = asObject(wantsFullDump ? fetched?.data : data);

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" aria-busy="true">
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Loading raw data…
            </div>
        );
    }

    if (!displayData) {
        return (
            <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed p-4 text-center">
                <span className="text-sm font-medium text-foreground">No data for this day</span>
                <span className="mt-1 text-xs text-muted-foreground">Nothing was recorded for the selected day</span>
            </div>
        );
    }

    return (
        <ScrollArea className="h-full w-full rounded-md border bg-background p-2">
            <div className="space-y-1">
                {Object.entries(displayData).map(([key, value]) => (
                    <JsonNode key={key} label={key} data={value} />
                ))}
            </div>
        </ScrollArea>
    );
}
