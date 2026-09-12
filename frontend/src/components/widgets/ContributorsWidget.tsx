import { useIsDark } from '@/components/theme-provider';
import { getBand, bandColor } from '@/lib/bands';
import { humanizeKey } from '@/lib/format';
import { ScrollArea } from '@/components/ui/scroll-area';

interface ContributorsWidgetProps {
    contributors: unknown;
    title?: string;
    /** Headline for the empty state. */
    emptyTitle?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function ContributorsWidget({ contributors, title, emptyTitle = 'No score (ring data)' }: ContributorsWidgetProps) {
    const isDark = useIsDark();

    const rows = isRecord(contributors)
        ? Object.entries(contributors)
            .filter(([, v]) => v === null || typeof v === 'number')
            .map(([key, v]) => ({ key, label: humanizeKey(key), value: typeof v === 'number' ? v : null }))
        : [];

    const hasAny = rows.some(r => r.value !== null);

    if (rows.length === 0 || !hasAny) {
        return (
            <div className="flex flex-col items-center justify-center h-full rounded-lg border border-dashed text-muted-foreground p-4 text-center">
                <span className="text-sm font-medium">{emptyTitle}</span>
                <span className="text-xs opacity-70 mt-1">Contributors come from Oura's daily summaries</span>
            </div>
        );
    }

    const summary = rows
        .map(r => `${r.label} ${r.value === null ? 'no value' : `${Math.round(r.value)} ${getBand(r.value)?.label ?? ''}`}`)
        .join(', ');

    return (
        <ScrollArea className="h-full -mr-3 pr-3">
            <ul className="flex flex-col gap-2 py-1" role="list" aria-label={`${title ?? 'Contributors'}: ${summary}`}>
                {rows.map(({ key, label, value }) => {
                    const band = getBand(value);
                    const color = bandColor(band, isDark);
                    const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
                    return (
                        <li key={key} className="flex flex-col gap-1">
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-muted-foreground truncate">{label}</span>
                                <span className="tabular-nums font-medium flex items-center gap-1.5">
                                    {value === null ? (
                                        <span className="text-muted-foreground">—</span>
                                    ) : (
                                        <>
                                            <span>{Math.round(value)}</span>
                                            <span className="text-[10px] font-normal" style={{ color }}>{band?.glyph} {band?.label}</span>
                                        </>
                                    )}
                                </span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden" aria-hidden="true">
                                <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, backgroundColor: color }} />
                            </div>
                        </li>
                    );
                })}
            </ul>
        </ScrollArea>
    );
}
