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
        let color = "text-green-400"; // Strings
        if (typeof data === 'number') color = "text-blue-400";
        if (typeof data === 'boolean') color = "text-purple-400";
        if (data === null) color = "text-gray-400";

        return (
            <div style={{ paddingLeft: level * 20 }} className="font-mono text-xs py-0.5 hover:bg-white/5 rounded px-1 flex items-start">
                <span className="text-muted-foreground mr-2 shrink-0">{label}:</span>
                <span className={cn("break-all", color)}>{JSON.stringify(data)}</span>
            </div>
        );
    }

    return (
        <div className="font-mono text-xs">
            <div
                onClick={() => !isEmpty && setIsOpen(!isOpen)}
                style={{ paddingLeft: level * 20 }}
                className={cn(
                    "flex items-center gap-1 cursor-pointer hover:bg-white/5 rounded px-1 py-0.5 select-none",
                    isEmpty && "opacity-50 cursor-default"
                )}
            >
                <span className="text-muted-foreground w-4 flex justify-center shrink-0">
                    {isEmpty ? '•' : (isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />)}
                </span>
                <span className="text-foreground font-medium">{label}</span>
                {Array.isArray(data) && (
                    <span className="text-muted-foreground text-[10px] ml-1">[{data.length}]</span>
                )}
            </div>

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
            <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading raw data...
            </div>
        );
    }

    if (!displayData) {
        return (
            <div className="flex items-center justify-center h-full text-muted-foreground">
                No data available
            </div>
        );
    }

    return (
        <ScrollArea className="h-full w-full rounded-md border bg-card p-2">
            <div className="space-y-1">
                {Object.entries(displayData).map(([key, value]) => (
                    <JsonNode key={key} label={key} data={value} />
                ))}
            </div>
        </ScrollArea>
    );
}
