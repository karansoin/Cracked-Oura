import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SHORTCUTS } from '@/lib/shortcuts';

export function ShortcutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Keyboard shortcuts</DialogTitle>
                    <DialogDescription>Shortcuts are ignored while you are typing in a text field.</DialogDescription>
                </DialogHeader>
                <ul className="divide-y">
                    {SHORTCUTS.map((row) => (
                        <li key={row.action} className="flex items-center justify-between gap-4 py-2 text-sm">
                            <span className="text-muted-foreground">{row.action}</span>
                            <span className="flex items-center gap-1">
                                {row.keys.map((k, i) => <kbd key={`${k}-${i}`} className="h-6 min-w-6 px-1.5 text-foreground">{k}</kbd>)}
                            </span>
                        </li>
                    ))}
                </ul>
            </DialogContent>
        </Dialog>
    );
}
