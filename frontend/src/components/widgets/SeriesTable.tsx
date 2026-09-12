import type { ChartTable } from '@/lib/series-table';

interface SeriesTableProps {
    table: ChartTable;
    /** Accessible name; defaults to the column list. */
    caption?: string;
}

/** Scrollable read-only table of a chart's plotted series ("View as table"). */
export function SeriesTable({ table, caption }: SeriesTableProps) {
    if (table.rows.length === 0) {
        return (
            <div className="flex h-full items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">No rows to show</div>
        );
    }
    return (
        <div className="h-full w-full overflow-auto rounded-md border bg-background text-xs">
            <table className="w-full border-collapse tabular-nums">
                <caption className="sr-only">{caption ?? `Table of ${table.columns.join(', ')}`}</caption>
                <thead className="sticky top-0 bg-background">
                    <tr>
                        {table.columns.map((col, i) => (
                            <th
                                key={`${col}-${i}`}
                                scope="col"
                                className={`border-b px-2 py-1.5 font-medium text-muted-foreground whitespace-nowrap ${i === 0 ? 'text-left' : 'text-right'}`}
                            >
                                {col}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {table.rows.map((row, r) => (
                        <tr key={r} className="transition-colors hover:bg-accent/60 odd:bg-muted/40">
                            {row.map((cell, c) => (
                                <td key={c} className={`px-2 py-1 whitespace-nowrap ${c === 0 ? 'text-left' : 'text-right'}`}>
                                    {cell}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
