import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

interface ConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    /** May be async; the dialog closes when it resolves. */
    onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
    onConfirm,
}: ConfirmDialogProps) {
    const [busy, setBusy] = useState(false);

    const handleConfirm = async () => {
        setBusy(true);
        try {
            await onConfirm();
            onOpenChange(false);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription asChild>
                        <div className="text-sm text-muted-foreground">{description}</div>
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                        {cancelLabel}
                    </Button>
                    <Button variant={destructive ? 'destructive' : 'default'} onClick={handleConfirm} disabled={busy} autoFocus={!destructive}>
                        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                        {confirmLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
