import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Settings, Trash2, GripHorizontal, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export interface WidgetMenuItem {
    id: string;
    label: string;
    icon?: React.ReactNode;
    onSelect: () => void;
    disabled?: boolean;
    /** Marks a toggle that is currently on (rendered with a check state). */
    checked?: boolean;
}

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
    /** Overflow ("...") menu entries; the menu is hidden when empty. */
    menuItems?: WidgetMenuItem[];
}

/**
 * Dashboard card chrome: 16px padding, one radius/border, 28px header controls,
 * a subtle border on hover, and titles that wrap to two lines before clipping.
 */
export function WidgetCard({
    title,
    subtitle,
    children,
    isEditing = false,
    onEdit,
    onDelete,
    className,
    headerContent,
    compact = false,
    menuItems,
}: WidgetCardProps) {
    const overflowMenu = menuItems && menuItems.length > 0 && (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
                    aria-label={`${title} options`}
                    onClick={(e) => e.stopPropagation()}
                >
                    <MoreHorizontal className="h-4 w-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[10rem]">
                {menuItems.map(item => item.checked === undefined ? (
                    <DropdownMenuItem key={item.id} inset disabled={item.disabled} onSelect={item.onSelect}>
                        {item.icon}
                        {item.label}
                    </DropdownMenuItem>
                ) : (
                    <DropdownMenuCheckboxItem
                        key={item.id}
                        className="gap-2 [&_svg]:size-4 [&_svg]:shrink-0"
                        disabled={item.disabled}
                        checked={item.checked}
                        onCheckedChange={item.onSelect}
                    >
                        {item.icon}
                        {item.label}
                    </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );

    const editControls = isEditing && (
        <div className="flex items-center gap-0.5">
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Edit ${title}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            onEdit?.();
                        }}
                    >
                        <Settings className="h-4 w-4" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Edit widget</TooltipContent>
            </Tooltip>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Delete ${title}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            onDelete?.();
                        }}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Remove widget</TooltipContent>
            </Tooltip>
        </div>
    );

    const dragHandle = isEditing && (
        <div
            className="drag-handle absolute left-1/2 top-0 z-[100] flex h-5 w-12 -translate-x-1/2 cursor-move items-center justify-center rounded-b-md border-x border-b bg-popover opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
            title="Drag to move"
        >
            <GripHorizontal className="h-4 w-4 text-muted-foreground" />
        </div>
    );

    const hoverClass = "hover:border-foreground/20";

    if (compact) {
        return (
            <Card className={cn("relative flex h-full flex-row items-center gap-3 overflow-hidden px-4", hoverClass, className)}>
                {dragHandle}
                <CardTitle className="line-clamp-3 min-w-[3.5rem] flex-1 text-xs font-medium leading-snug text-muted-foreground" title={title}>{title}</CardTitle>
                <div className="flex shrink-0 items-center justify-end gap-1">
                    {children}
                    {editControls}
                </div>
            </Card>
        );
    }

    return (
        <Card className={cn("relative flex h-full flex-col overflow-hidden", hoverClass, className)}>
            {dragHandle}
            <CardHeader className="relative z-[50] flex flex-row items-start justify-between gap-2 space-y-0 px-4 pb-2 pt-3">
                <div className="flex min-w-[35%] flex-1 flex-col pt-1">
                    <CardTitle className="line-clamp-2 text-base font-medium leading-tight" title={title}>{title}</CardTitle>
                    {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
                </div>
                <div className="relative z-[60] flex min-w-0 items-center gap-1">
                    {headerContent}
                    {editControls}
                    {overflowMenu}
                </div>
            </CardHeader>
            <CardContent className="relative z-[1] min-h-0 flex-1 p-4 pt-0">
                {children}
            </CardContent>
        </Card>
    );
}
