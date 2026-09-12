import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SidePanelProps {
    title: string;
    /** Short line under the title. */
    subtitle?: string;
    /** Accessible name for the `<aside>`; defaults to the title. */
    ariaLabel?: string;
    /** Leading icon in the header. */
    icon?: React.ReactNode;
    onClose: () => void;
    /** Extra header controls, left of the close button. */
    headerActions?: React.ReactNode;
    children: React.ReactNode;
    footer?: React.ReactNode;
    /** Body padding + vertical rhythm; set false when the body manages its own layout (e.g. chat). */
    padded?: boolean;
    className?: string;
}

/**
 * Right-hand panel shell shared by Settings, Data & Sync, the widget editor and the
 * AI Analyst side chat: same width, header height (matches the top bar), paddings and
 * close control.
 */
export function SidePanel({ title, subtitle, ariaLabel, icon, onClose, headerActions, children, footer, padded = true, className }: SidePanelProps) {
    return (
        <aside className={cn('flex h-full w-[400px] shrink-0 flex-col border-l bg-card', className)} aria-label={ariaLabel ?? title}>
            <div className="flex h-16 shrink-0 items-center justify-between gap-3 border-b px-5">
                <div className="flex min-w-0 items-center gap-2.5">
                    {icon && <span className="shrink-0 text-muted-foreground" aria-hidden="true">{icon}</span>}
                    <div className="min-w-0">
                        <h2 className="truncate text-base font-semibold leading-tight">{title}</h2>
                        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {headerActions}
                    <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close panel" className="text-muted-foreground hover:text-foreground">
                        <X className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            <div className={cn('min-h-0 flex-1', padded ? 'overflow-y-auto p-5 space-y-8' : 'flex flex-col')}>
                {children}
            </div>

            {footer && <div className="shrink-0 border-t p-4">{footer}</div>}
        </aside>
    );
}

/** Eyebrow heading used for panel sections ("Units", "Status", ...). */
export function PanelSectionHeading({ id, children, trailing }: { id: string; children: React.ReactNode; trailing?: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <h3 id={id} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{children}</h3>
            {trailing}
        </div>
    );
}
