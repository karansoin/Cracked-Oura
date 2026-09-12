import { Bluetooth, AlertTriangle, CheckCircle2, Loader2, WifiOff, HeartPulse, CircleDashed, Radar } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStatus } from '@/contexts/AppStatusContext';
import { useDashboard } from '@/contexts/DashboardContext';
import { formatRelative } from '@/lib/format';
import type { LucideIcon } from 'lucide-react';

interface PillModel {
    icon: LucideIcon;
    text: string;
    tone: 'neutral' | 'busy' | 'ok' | 'warn' | 'error';
    spin?: boolean;
}

function derivePill(status: ReturnType<typeof useAppStatus>): PillModel {
    const { ble, sync, backendOk, hasData } = status;
    if (!backendOk) return { icon: WifiOff, text: 'Backend offline', tone: 'error' };

    if (ble) {
        switch (ble.state) {
            case 'scanning':
                return { icon: Radar, text: 'Scanning for rings…', tone: 'busy', spin: true };
            case 'connecting':
                return { icon: Bluetooth, text: 'Connecting to ring…', tone: 'busy', spin: true };
            case 'pairing':
            case 'authenticating':
                return { icon: Bluetooth, text: 'Pairing ring…', tone: 'busy', spin: true };
            case 'syncing': {
                const events = ble.progress?.events;
                return { icon: Loader2, text: events ? `Syncing ring · ${events.toLocaleString()} events` : 'Syncing ring…', tone: 'busy', spin: true };
            }
            case 'live':
                return { icon: HeartPulse, text: 'Live session', tone: 'busy' };
            case 'error':
                return { icon: AlertTriangle, text: 'Ring error', tone: 'error' };
            default:
                break;
        }
    }

    if (sync?.state === 'ingesting') return { icon: Loader2, text: 'Importing ZIP…', tone: 'busy', spin: true };
    if (sync?.state === 'error') return { icon: AlertTriangle, text: 'Import failed', tone: 'error' };

    if (sync?.last_success_at) return { icon: CheckCircle2, text: `Up to date · ${formatRelative(sync.last_success_at)}`, tone: 'ok' };
    if (hasData === false) return { icon: CircleDashed, text: 'No data yet', tone: 'neutral' };
    return { icon: CheckCircle2, text: 'Local data ready', tone: 'neutral' };
}

/* Amber is the band palette's "Fair" hue; everything else is a theme token. */
const TONE_CLASS: Record<PillModel['tone'], string> = {
    neutral: 'text-muted-foreground border-border',
    busy: 'text-foreground border-border',
    ok: 'text-foreground border-border',
    warn: 'text-foreground border-[#E69F00]/60',
    error: 'text-destructive border-destructive/50',
};

/** Top-bar sync/ring status pill. Icon + text (never colour alone); click opens Data & Sync. */
export function StatusPill() {
    const status = useAppStatus();
    const { setActivePanel, activePanel } = useDashboard();
    const pill = derivePill(status);
    const Icon = pill.icon;
    const open = activePanel === 'data';

    return (
        <button
            type="button"
            onClick={() => setActivePanel(open ? 'none' : 'data')}
            className={cn(
                'inline-flex h-9 max-w-[260px] items-center gap-2 rounded-full border bg-card px-3 text-xs font-medium transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                TONE_CLASS[pill.tone],
                open && 'bg-accent text-foreground'
            )}
            title="Open Data & Sync"
            aria-label={`Status: ${pill.text}. Open Data & Sync`}
            aria-pressed={open}
        >
            <Icon className={cn('h-3.5 w-3.5 shrink-0', pill.spin && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
            <span className="truncate" aria-live="polite" aria-atomic="true">{pill.text}</span>
        </button>
    );
}
