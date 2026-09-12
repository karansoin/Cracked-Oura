import { Skeleton } from '@/components/ui/skeleton';

export type SkeletonKind = 'gauge' | 'chart' | 'metric' | 'table' | 'list';

/** Per-widget loading placeholder that mirrors the widget's final shape. */
export function WidgetSkeleton({ kind = 'chart', compact = false }: { kind?: SkeletonKind; compact?: boolean }) {
    if (compact) {
        return (
            <div className="flex items-center justify-end h-full" aria-busy="true" aria-label="Loading">
                <Skeleton className="h-5 w-16" />
            </div>
        );
    }
    switch (kind) {
        case 'gauge':
            return (
                <div className="flex h-full flex-col items-center justify-center gap-2" aria-busy="true" aria-label="Loading">
                    <div className="relative flex h-28 w-28 items-center justify-center">
                        <Skeleton className="absolute inset-0 rounded-full" />
                        <div className="relative h-[calc(100%-1.25rem)] w-[calc(100%-1.25rem)] rounded-full bg-card" />
                    </div>
                    <Skeleton className="h-3 w-16" />
                </div>
            );
        case 'metric':
            return (
                <div className="flex h-full flex-col items-center justify-center gap-2" aria-busy="true" aria-label="Loading">
                    <Skeleton className="h-8 w-24" />
                    <Skeleton className="h-3 w-16" />
                </div>
            );
        case 'table':
        case 'list':
            return (
                <div className="flex h-full flex-col gap-3 pt-1" aria-busy="true" aria-label="Loading">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="flex flex-col gap-1.5">
                            <div className="flex items-center justify-between gap-4">
                                <Skeleton className="h-3 w-1/3" />
                                <Skeleton className="h-3 w-12" />
                            </div>
                            {kind === 'list' && <Skeleton className="h-1 w-full rounded-full" />}
                        </div>
                    ))}
                </div>
            );
        case 'chart':
        default:
            return (
                <div className="flex h-full gap-2 pt-1" aria-busy="true" aria-label="Loading">
                    <div className="flex flex-col justify-between py-1">
                        <Skeleton className="h-2 w-6" />
                        <Skeleton className="h-2 w-6" />
                        <Skeleton className="h-2 w-6" />
                    </div>
                    <div className="flex-1 flex flex-col justify-end gap-2">
                        <Skeleton className="h-full w-full rounded-md" />
                        <div className="flex justify-between">
                            <Skeleton className="h-2 w-8" />
                            <Skeleton className="h-2 w-8" />
                            <Skeleton className="h-2 w-8" />
                        </div>
                    </div>
                </div>
            );
    }
}
