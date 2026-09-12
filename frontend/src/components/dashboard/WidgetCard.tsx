import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Settings, Trash2, GripHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

interface WidgetCardProps {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
    isEditing?: boolean;
    onEdit?: () => void;
    onDelete?: () => void;
    className?: string;
    headerContent?: React.ReactNode;
    /** One-row-tall widgets: title and content share a single line. */
    compact?: boolean;
}

export function WidgetCard({
    title,
    subtitle,
    children,
    isEditing = false,
    onEdit,
    onDelete,
    className,
    headerContent,
    compact = false
}: WidgetCardProps) {
    const editControls = isEditing && (
        <div className="flex items-center gap-1">
            <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Edit ${title}`}
                onClick={(e) => {
                    e.stopPropagation();
                    onEdit?.();
                }}
            >
                <Settings className="h-4 w-4" />
            </Button>
            <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-destructive hover:text-destructive"
                aria-label={`Delete ${title}`}
                onClick={(e) => {
                    e.stopPropagation();
                    onDelete?.();
                }}
            >
                <Trash2 className="h-4 w-4" />
            </Button>
        </div>
    );

    const dragHandle = isEditing && (
        <div
            className="absolute top-0 left-1/2 -translate-x-1/2 z-[100] h-5 w-12 flex items-center justify-center bg-secondary/90 hover:bg-secondary backdrop-blur-[2px] rounded-b-lg border-b border-x border-white/10 transition-all shadow-sm cursor-move drag-handle opacity-0 group-hover:opacity-100"
            title="Drag to move"
        >
            <GripHorizontal className="w-4 h-4 text-muted-foreground" />
        </div>
    );

    if (compact) {
        return (
            <Card className={cn("h-full flex flex-row items-center gap-3 px-4 relative", className)}>
                {dragHandle}
                <CardTitle className="text-xs font-medium text-muted-foreground truncate shrink-0 max-w-[55%]">{title}</CardTitle>
                <div className="flex-1 min-w-0 flex items-center justify-end gap-2">
                    {children}
                    {editControls}
                </div>
            </Card>
        );
    }

    return (
        <Card className={cn("h-full flex flex-col relative", className)}>
            {dragHandle}
            <CardHeader className={cn("flex flex-row items-center justify-between space-y-0 pb-2 px-4 pt-4 relative z-[50]")}>
                <div className="flex flex-col min-w-0">
                    <CardTitle className="text-sm font-medium truncate">{title}</CardTitle>
                    {subtitle && <p className="text-[10px] text-muted-foreground">{subtitle}</p>}
                </div>
                <div className="flex items-center gap-2 relative z-[60]">
                    {headerContent}
                    {editControls}
                </div>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 p-4 pt-0 relative z-[1]">
                {children}
            </CardContent>
        </Card >
    );
}
