import { format, isValid, parseISO } from 'date-fns';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
    AlertTriangle,
    CheckCircle2,
    Copy,
    Database,
    FileArchive,
    Loader2,
    RotateCcw,
    Trash2,
    Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog } from '@/components/dashboard/ConfirmDialog';
import { SidePanel, PanelSectionHeading } from '@/components/layout/SidePanel';
import { useAppStatus, toastError } from '@/contexts/AppStatusContext';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatCount, formatDay, formatRelative, humanizeKey } from '@/lib/format';
import { cn } from '@/lib/utils';

interface DataSyncPanelProps {
    onClose: () => void;
}

const INVENTORY_ORDER = [
    'sleep', 'activity', 'readiness', 'resilience', 'cardiovascular_age', 'sleep_session', 'workout', 'meditation',
    'ring_battery', 'heart_rate', 'temperature', 'ring_configuration', 'tag', 'vo2max', 'live_session', 'ring_event',
];

const INVENTORY_LABEL: Record<string, string> = {
    sleep: 'Daily sleep',
    activity: 'Daily activity',
    readiness: 'Daily readiness',
    resilience: 'Resilience',
    cardiovascular_age: 'Cardiovascular age',
    sleep_session: 'Sleep sessions',
    workout: 'Workouts',
    meditation: 'Sessions (meditation)',
    ring_battery: 'Ring battery',
    heart_rate: 'Heart rate samples',
    temperature: 'Temperature samples',
    ring_configuration: 'Ring configuration',
    tag: 'Tags',
    vo2max: 'VO₂ max',
    live_session: 'Live sessions',
    ring_event: 'Raw ring events',
};

/** Flatten an ingest summary into "label: count" rows (numbers, or objects with numeric fields). */
function summaryRows(summary: Record<string, unknown> | null | undefined): Array<{ label: string; value: string }> {
    if (!summary) return [];
    const rows: Array<{ label: string; value: string }> = [];
    for (const [key, value] of Object.entries(summary)) {
        if (typeof value === 'number') rows.push({ label: humanizeKey(key), value: formatCount(value) });
        else if (typeof value === 'string') rows.push({ label: humanizeKey(key), value });
        else if (value && typeof value === 'object') {
            const inner = Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'number') as Array<[string, number]>;
            if (inner.length) rows.push({ label: humanizeKey(key), value: inner.map(([k, v]) => `${formatCount(v)} ${humanizeKey(k).toLowerCase()}`).join(', ') });
        }
    }
    return rows;
}

const shortDay = (iso: string | null | undefined): string => {
    if (!iso) return '—';
    const d = parseISO(iso);
    return isValid(d) ? format(d, 'd MMM yy') : '—';
};

export function DataSyncPanel({ onClose }: DataSyncPanelProps) {
    const { sync, inventory, refreshInventory, refreshSync, ble } = useAppStatus();
    const [file, setFile] = useState<File | null>(null);
    const [dragging, setDragging] = useState(false);
    const [importing, setImporting] = useState(false);
    const [lastSummary, setLastSummary] = useState<Record<string, unknown> | null>(null);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [layoutJson, setLayoutJson] = useState('');
    const fileInput = useRef<HTMLInputElement>(null);

    useEffect(() => { void refreshInventory(); }, [refreshInventory]);

    const pickFile = (f: File | null | undefined) => {
        if (!f) return;
        if (!f.name.toLowerCase().endsWith('.zip')) {
            toast.error('Not a ZIP file', { description: 'Choose the .zip export you downloaded from your Oura account.' });
            return;
        }
        setFile(f);
        setLastSummary(null);
    };

    const runImport = useCallback(async (f: File) => {
        setImporting(true);
        try {
            const res = await api.uploadZip(f);
            setLastSummary(res.summary ?? {});
            toast.success('Import complete', { description: res.message });
            await Promise.all([refreshInventory(), refreshSync()]);
        } catch (err) {
            toastError('Import failed', err);
            await refreshSync();
        } finally {
            setImporting(false);
        }
    }, [refreshInventory, refreshSync]);

    const syncState = sync?.state ?? 'idle';
    const busy = importing || syncState === 'ingesting' || !!ble?.busy;
    const inventoryRows = inventory
        ? [...Object.keys(inventory)].sort((a, b) => (INVENTORY_ORDER.indexOf(a) + 1 || 99) - (INVENTORY_ORDER.indexOf(b) + 1 || 99))
        : [];
    const totalRows = inventory ? Object.values(inventory).reduce((s, e) => s + (e?.rows ?? 0), 0) : 0;

    const statusIcon = syncState === 'error' ? <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
        : syncState === 'ingesting' ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <CheckCircle2 className="h-4 w-4 text-[#007A59] dark:text-[#3FC9A2]" aria-hidden="true" />;
    const statusText = syncState === 'error' ? 'Last import failed'
        : syncState === 'ingesting' ? (sync?.message || 'Importing…')
            : syncState === 'done' ? 'Up to date'
                : totalRows > 0 ? 'Local data ready' : 'No data yet';

    return (
        <SidePanel title="Data & Sync" subtitle="Everything stays on this computer" icon={<Database className="h-4 w-4" />} ariaLabel="Data and sync" onClose={onClose}>
            {/* Sync status */}
            <section className="space-y-3" aria-labelledby="sync-status-heading">
                <PanelSectionHeading id="sync-status-heading">Status</PanelSectionHeading>
                <div className="space-y-1.5 rounded-md border bg-background p-3">
                    <div className="flex items-center gap-2 text-sm font-medium">{statusIcon}<span>{statusText}</span></div>
                    {sync?.message && syncState !== 'ingesting' && <p className="text-xs text-muted-foreground">{sync.message}</p>}
                    <p className="text-xs text-muted-foreground">Last successful import: {sync?.last_success_at ? `${formatRelative(sync.last_success_at)} (${formatDay(sync.last_success_at)})` : 'never'}</p>
                    {syncState === 'error' && sync?.error && (
                        <Alert variant="destructive" className="mt-2">
                            <AlertTriangle className="h-4 w-4" />
                            <AlertTitle>{sync.error.code || 'Import failed'}</AlertTitle>
                            <AlertDescription className="flex flex-col gap-2">
                                <span>{sync.error.message}</span>
                                {sync.error.retryable && (
                                    <Button size="sm" variant="outline" className="w-fit" disabled={busy} onClick={() => file ? void runImport(file) : fileInput.current?.click()}>
                                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Retry{file ? ` ${file.name}` : ''}
                                    </Button>
                                )}
                            </AlertDescription>
                        </Alert>
                    )}
                </div>
            </section>

            {/* Import ZIP */}
            <section className="space-y-3" aria-labelledby="import-heading">
                <PanelSectionHeading id="import-heading">Import an export ZIP</PanelSectionHeading>
                <p className="text-xs text-muted-foreground">Drop the data-export ZIP you already downloaded from your Oura account. It is read locally and never uploaded anywhere.</p>
                <div
                    role="button"
                    tabIndex={0}
                    aria-label="Choose or drop a ZIP file"
                    className={cn(
                        'cursor-pointer rounded-md border border-dashed bg-background p-5 text-center text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        dragging ? 'border-foreground/40 bg-accent' : 'hover:border-foreground/30 hover:bg-accent/40'
                    )}
                    onClick={() => fileInput.current?.click()}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.current?.click(); } }}
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => { e.preventDefault(); setDragging(false); pickFile(e.dataTransfer.files?.[0]); }}
                >
                    <FileArchive className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />
                    {file ? (
                        <div>
                            <p className="truncate font-medium">{file.name}</p>
                            <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                        </div>
                    ) : (
                        <p className="text-muted-foreground">Drop a <span className="font-mono">.zip</span> here, or click to choose</p>
                    )}
                    <input
                        ref={fileInput}
                        type="file"
                        accept=".zip,application/zip"
                        className="sr-only"
                        onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }}
                    />
                </div>
                <div className="flex gap-2">
                    <Button className="flex-1" disabled={!file || busy} onClick={() => file && void runImport(file)}>
                        {importing ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
                        {importing ? 'Importing…' : 'Import'}
                    </Button>
                    {file && !importing && <Button variant="ghost" onClick={() => setFile(null)}>Clear</Button>}
                </div>
                {lastSummary && (
                    <div className="space-y-1 rounded-md border bg-background p-3 text-xs">
                        <p className="flex items-center gap-1.5 font-medium"><CheckCircle2 className="h-3.5 w-3.5 text-[#007A59] dark:text-[#3FC9A2]" aria-hidden="true" /> Imported</p>
                        {summaryRows(lastSummary).length === 0 ? (
                            <p className="text-muted-foreground">Done.</p>
                        ) : (
                            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                                {summaryRows(lastSummary).map(r => (
                                    <div key={r.label} className="contents"><dt className="text-muted-foreground">{r.label}</dt><dd className="text-right tabular-nums">{r.value}</dd></div>
                                ))}
                            </dl>
                        )}
                    </div>
                )}
            </section>

            {/* Inventory */}
            <section className="space-y-3" aria-labelledby="inventory-heading">
                <PanelSectionHeading
                    id="inventory-heading"
                    trailing={<span className="text-xs tabular-nums text-muted-foreground">{formatCount(totalRows)} rows</span>}
                >
                    Data on this computer
                </PanelSectionHeading>
                {!inventory ? (
                    <p className="text-xs text-muted-foreground" aria-busy="true">Loading…</p>
                ) : (
                    <div className="overflow-hidden rounded-md border bg-background">
                        <Table>
                            <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                    <TableHead>Table</TableHead>
                                    <TableHead className="text-right">Rows</TableHead>
                                    <TableHead>Range</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {inventoryRows.map(key => {
                                    const e = inventory[key];
                                    const empty = !e || e.rows === 0;
                                    return (
                                        <TableRow key={key} className={cn(empty && 'text-muted-foreground')}>
                                            <TableCell className="py-1.5 text-xs">{INVENTORY_LABEL[key] ?? humanizeKey(key)}</TableCell>
                                            <TableCell className="py-1.5 text-right text-xs tabular-nums">{formatCount(e?.rows ?? 0)}</TableCell>
                                            <TableCell className="whitespace-nowrap py-1.5 text-xs text-muted-foreground">{empty ? '—' : `${shortDay(e.first)} – ${shortDay(e.last)}`}</TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </div>
                )}
                <Button variant="outline" className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={busy || totalRows === 0} onClick={() => setDeleteOpen(true)}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete all local data
                </Button>
            </section>

            {/* Layout export / import */}
            <section className="space-y-3" aria-labelledby="layout-heading">
                <PanelSectionHeading id="layout-heading">Dashboard layouts</PanelSectionHeading>
                <Button variant="outline" className="w-full" onClick={() => {
                    api.getLayout()
                        .then(async (data) => {
                            await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
                            toast.success('Layout copied to clipboard');
                        })
                        .catch((err: unknown) => toastError('Could not copy layout', err));
                }}>
                    <Copy className="h-4 w-4" aria-hidden="true" /> Copy layout to clipboard
                </Button>
                <div className="space-y-2">
                    <Label htmlFor="import-layout-area">Import layout</Label>
                    <textarea
                        id="import-layout-area"
                        value={layoutJson}
                        onChange={(e) => setLayoutJson(e.target.value)}
                        placeholder="Paste layout JSON here…"
                        className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <Button
                        variant="outline"
                        className="w-full"
                        disabled={!layoutJson.trim()}
                        onClick={async () => {
                            try {
                                const raw: unknown = JSON.parse(layoutJson);
                                let payload: unknown = raw;
                                if (raw && typeof raw === 'object' && 'dashboard' in raw) {
                                    const inner = (raw as { dashboard?: unknown }).dashboard;
                                    if (inner && typeof inner === 'object' && 'dashboards' in inner) payload = inner;
                                }
                                const p = payload as Record<string, unknown> | null;
                                if (!p || (!('dashboards' in p) && !('widgets' in p))) {
                                    toast.error('Invalid layout JSON', { description: "Must contain a 'dashboards' or 'widgets' property." });
                                    return;
                                }
                                await api.saveLayout(payload);
                                toast.success('Layout imported', { description: 'Reloading…' });
                                window.setTimeout(() => window.location.reload(), 600);
                            } catch (err) {
                                toast.error('Import failed', { description: errorMessage(err) });
                            }
                        }}
                    >
                        <Upload className="h-4 w-4" aria-hidden="true" /> Import layout
                    </Button>
                </div>
            </section>

            <ConfirmDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title="Delete all local data?"
                description={
                    <p>
                        This removes every row in the local database ({formatCount(totalRows)} rows across {inventoryRows.filter(k => (inventory?.[k]?.rows ?? 0) > 0).length} tables).
                        Paired ring keys and your dashboard layouts are kept. This cannot be undone — you would need to re-import a ZIP or re-sync the ring.
                    </p>
                }
                confirmLabel="Delete everything"
                destructive
                onConfirm={async () => {
                    try {
                        await api.deleteAllData();
                        toast.success('All local data deleted');
                        setLastSummary(null);
                        await Promise.all([refreshInventory(), refreshSync()]);
                    } catch (err) {
                        toastError('Delete failed', err);
                    }
                }}
            />
        </SidePanel>
    );
}
