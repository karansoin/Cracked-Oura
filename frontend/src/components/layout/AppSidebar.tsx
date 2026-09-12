import { useState } from 'react';
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
    LayoutDashboard,
    Settings,
    ChevronLeft,
    ChevronRight,
    Plus,
    MoreHorizontal,
    Trash2,
    Edit2,
    Sparkles,
    Bluetooth,
    Database,
    RotateCcw,
    TrendingUp,
    Radio,
} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Dashboard } from "@/types";
import type { PanelType, ViewType } from "@/contexts/DashboardContext";

interface AppSidebarProps {
    className?: string;
    dashboards: Dashboard[];
    activeDashboardId: string;
    onDashboardSelect: (id: string) => void;
    onDashboardAdd: () => void;
    onDashboardDelete: (id: string) => void;
    onDashboardRename: (id: string, newName: string) => void;
    onDashboardReset: (id: string) => void;
    onSettingsClick?: () => void;
    onDataSyncClick?: () => void;
    onChatPageSelect?: () => void;
    onRingPageSelect?: () => void;
    onTrendsPageSelect?: () => void;
    onLivePageSelect?: () => void;
    activeView?: ViewType;
    activePanel?: PanelType;
    /** Short line under "Data & Sync", e.g. "Up to date · 2 h ago". */
    dataSyncHint?: string;
}

export function AppSidebar({
    className,
    dashboards,
    activeDashboardId,
    onDashboardSelect,
    onDashboardAdd,
    onDashboardDelete,
    onDashboardRename,
    onDashboardReset,
    onSettingsClick,
    onDataSyncClick,
    onChatPageSelect,
    onRingPageSelect,
    onTrendsPageSelect,
    onLivePageSelect,
    activeView = 'dashboard',
    activePanel = 'none',
    dataSyncHint,
}: AppSidebarProps) {
    const [collapsed, setCollapsed] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState("");

    const handleStartEdit = (dashboard: Dashboard) => {
        setEditingId(dashboard.id);
        setEditName(dashboard.name);
    };

    const handleSaveEdit = () => {
        if (editingId && editName.trim()) {
            onDashboardRename(editingId, editName.trim());
        }
        setEditingId(null);
    };

    const navButton = (opts: {
        label: string;
        icon: React.ReactNode;
        active: boolean;
        onClick?: () => void;
        shortcut?: string;
        hint?: string;
        /** Leave room for a trailing overflow button rendered by the caller. */
        trailingSpace?: boolean;
    }) => {
        const button = (
            <button
                type="button"
                className={cn(
                    "group/nav relative flex w-full items-center gap-2.5 rounded-md text-sm transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    collapsed ? "h-9 justify-center px-0" : "min-h-9 px-2.5 py-1.5",
                    !collapsed && opts.trailingSpace && "pr-9",
                    opts.active
                        ? "bg-accent font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                )}
                onClick={opts.onClick}
                aria-current={opts.active ? 'page' : undefined}
            >
                {opts.active && !collapsed && (
                    <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-foreground" aria-hidden="true" />
                )}
                <span className={cn("shrink-0 [&_svg]:h-4 [&_svg]:w-4", opts.active ? "text-foreground" : "text-muted-foreground group-hover/nav:text-foreground")}>
                    {opts.icon}
                </span>
                {!collapsed && (
                    <span className="flex min-w-0 flex-1 flex-col items-start text-left">
                        <span className="w-full truncate leading-tight">{opts.label}</span>
                        {opts.hint && <span className="w-full truncate text-xs font-normal text-muted-foreground">{opts.hint}</span>}
                    </span>
                )}
                {!collapsed && opts.shortcut && (
                    <kbd className="ml-auto" aria-hidden="true">{opts.shortcut}</kbd>
                )}
            </button>
        );
        if (!collapsed) return button;
        return (
            <Tooltip>
                <TooltipTrigger asChild>{button}</TooltipTrigger>
                <TooltipContent side="right">{opts.label}{opts.shortcut ? ` (${opts.shortcut})` : ''}</TooltipContent>
            </Tooltip>
        );
    };

    const groupLabel = (text: string) => (
        !collapsed && <p className="px-2.5 pb-1.5 pt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{text}</p>
    );

    return (
        <nav className={cn(
            "flex shrink-0 flex-col border-r bg-card",
            collapsed ? "w-14" : "w-60",
            className
        )} aria-label="Main navigation">
            {/* Header */}
            <div className={cn("flex h-16 items-center border-b", collapsed ? "justify-center px-0" : "px-4")}>
                <div className="flex items-center gap-2.5 overflow-hidden">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md">
                        <img src="icon.png" alt="" className="h-full w-full object-cover" />
                    </div>
                    {!collapsed && (
                        <span className="whitespace-nowrap text-base font-semibold tracking-tight">Cracked Oura</span>
                    )}
                </div>
            </div>

            {/* Navigation */}
            <ScrollArea className="flex-1">
                <div className={cn("space-y-0.5", collapsed ? "px-2 pt-3" : "px-2")}>
                    {groupLabel('Views')}
                    {navButton({
                        label: 'Ring',
                        icon: <Bluetooth aria-hidden="true" />,
                        active: activeView === 'ring',
                        onClick: onRingPageSelect,
                        shortcut: '1',
                    })}
                    {navButton({
                        label: 'AI Analyst',
                        icon: <Sparkles aria-hidden="true" />,
                        active: activeView === 'chat-page',
                        onClick: onChatPageSelect,
                        shortcut: '2',
                    })}
                    {navButton({
                        label: 'Trends',
                        icon: <TrendingUp aria-hidden="true" />,
                        active: activeView === 'trends',
                        onClick: onTrendsPageSelect,
                        shortcut: '3',
                    })}
                    {navButton({
                        label: 'Live',
                        icon: <Radio aria-hidden="true" />,
                        active: activeView === 'live',
                        onClick: onLivePageSelect,
                        shortcut: '4',
                        hint: collapsed ? undefined : 'Steadiness, workouts, breathing',
                    })}
                </div>

                <div className={cn("space-y-0.5 px-2", collapsed && "mt-3 border-t pt-3")}>
                    {groupLabel('Dashboards')}
                    {dashboards.map(dashboard => {
                        const active = activeView === 'dashboard' && activeDashboardId === dashboard.id;
                        return (
                            <div key={dashboard.id} className="group relative flex items-center">
                                {editingId === dashboard.id && !collapsed ? (
                                    <div className="flex w-full items-center px-1">
                                        <Input
                                            value={editName}
                                            onChange={(e) => setEditName(e.target.value)}
                                            onBlur={handleSaveEdit}
                                            onKeyDown={(e) => e.key === 'Enter' && handleSaveEdit()}
                                            autoFocus
                                            className="h-8 text-sm"
                                            aria-label="Dashboard name"
                                        />
                                    </div>
                                ) : (
                                    navButton({
                                        label: dashboard.name,
                                        icon: <LayoutDashboard aria-hidden="true" />,
                                        active,
                                        onClick: () => onDashboardSelect(dashboard.id),
                                        trailingSpace: true,
                                    })
                                )}

                                {!collapsed && !editingId && (
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                className={cn(
                                                    "absolute right-1 text-muted-foreground hover:text-foreground",
                                                    "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100",
                                                    active && "opacity-100"
                                                )}
                                                aria-label={`${dashboard.name} options`}
                                            >
                                                <MoreHorizontal className="h-4 w-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={() => handleStartEdit(dashboard)}>
                                                <Edit2 className="h-4 w-4" />
                                                Rename
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => onDashboardReset(dashboard.id)}>
                                                <RotateCcw className="h-4 w-4" />
                                                Reset to Overview template
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                                className="text-destructive focus:text-destructive"
                                                onClick={() => onDashboardDelete(dashboard.id)}
                                                disabled={dashboards.length <= 1}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                                Delete
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                )}
                            </div>
                        );
                    })}

                    {!collapsed ? (
                        <button
                            type="button"
                            className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={onDashboardAdd}
                        >
                            <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>New dashboard</span>
                        </button>
                    ) : (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="w-full text-muted-foreground hover:text-foreground"
                                    onClick={onDashboardAdd}
                                    aria-label="New dashboard"
                                >
                                    <Plus className="h-4 w-4" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="right">New dashboard</TooltipContent>
                        </Tooltip>
                    )}
                </div>
            </ScrollArea>

            {/* Footer */}
            <div className="space-y-0.5 border-t p-2">
                {navButton({
                    label: 'Data & Sync',
                    icon: <Database aria-hidden="true" />,
                    active: activePanel === 'data',
                    onClick: onDataSyncClick,
                    hint: dataSyncHint,
                })}
                {navButton({
                    label: 'Settings',
                    icon: <Settings aria-hidden="true" />,
                    active: activePanel === 'settings',
                    onClick: onSettingsClick,
                })}
                <Button
                    variant="ghost"
                    size="sm"
                    className={cn("w-full text-muted-foreground hover:text-foreground", collapsed ? "justify-center px-0" : "justify-start px-2.5")}
                    onClick={() => setCollapsed(!collapsed)}
                    aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                    {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                    {!collapsed && <span>Collapse</span>}
                </Button>
            </div>
        </nav>
    );
}
