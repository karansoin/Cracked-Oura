import { Bluetooth, FileArchive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface OnboardingEmptyStateProps {
    onConnectRing: () => void;
    onImportZip: () => void;
}

/** First-run state: what this screen is for, why it is empty, and what to do about it. */
export function OnboardingEmptyState({ onConnectRing, onImportZip }: OnboardingEmptyStateProps) {
    return (
        <div className="flex flex-col items-center gap-10 py-10 px-4 max-w-5xl mx-auto">
            <Card className="w-full max-w-xl shadow-sm">
                <CardContent className="flex flex-col items-center text-center gap-5 p-8">
                    <h2 className="text-2xl font-semibold tracking-tight">Your Oura data, on your machine.</h2>
                    <p className="text-sm text-muted-foreground max-w-md">
                        Read your ring over Bluetooth or import an export ZIP you already have. Nothing leaves this computer.
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
                        <Button size="lg" className="gap-2" onClick={onConnectRing}>
                            <Bluetooth className="h-4 w-4" aria-hidden="true" />
                            Connect my ring
                        </Button>
                        <Button size="lg" variant="outline" className="gap-2" onClick={onImportZip}>
                            <FileArchive className="h-4 w-4" aria-hidden="true" />
                            Import a ZIP
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <div className="w-full opacity-50 select-none" aria-hidden="true">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 text-center">Preview of your Overview</p>
                <div className="grid grid-cols-12 gap-4" style={{ gridAutoRows: '60px' }}>
                    {[0, 3, 6].map((x) => (
                        <div key={x} className="rounded-xl border bg-card p-4 flex flex-col items-center justify-center gap-2" style={{ gridColumn: `${x + 1} / span 3`, gridRow: '1 / span 3' }}>
                            <Skeleton className="h-20 w-20 rounded-full" />
                            <Skeleton className="h-3 w-14" />
                        </div>
                    ))}
                    {[1, 2, 3].map((row) => (
                        <div key={row} className="rounded-xl border bg-card px-4 flex items-center justify-between" style={{ gridColumn: '10 / span 3', gridRow: `${row} / span 1` }}>
                            <Skeleton className="h-3 w-20" />
                            <Skeleton className="h-4 w-10" />
                        </div>
                    ))}
                    <div className="rounded-xl border bg-card p-4 flex flex-col gap-3" style={{ gridColumn: '1 / span 8', gridRow: '4 / span 4' }}>
                        <Skeleton className="h-3 w-24" />
                        <Skeleton className="flex-1 w-full rounded-md" />
                    </div>
                    <div className="rounded-xl border bg-card p-4 flex flex-col gap-3" style={{ gridColumn: '9 / span 4', gridRow: '4 / span 4' }}>
                        <Skeleton className="h-3 w-28" />
                        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-2 w-full" />)}
                    </div>
                </div>
            </div>
        </div>
    );
}
