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
    MoreVertical,
    Trash2,
    Edit2,
    Sparkles,
    Bluetooth,
    Database,
    RotateCcw,
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
    }) => {
        const button = (
            <Button
                variant={opts.active ? "secondary" : "ghost"}
                className={cn(
                    "w-full justify-start gap-3 h-auto py-2",
                    collapsed ? "px-2 justify-center" : "px-3",
                    opts.active && "bg-secondary/50"
                )}
                onClick={opts.onClick}
                aria-current={opts.active ? 'page' : undefined}
            >
                {opts.icon}
                {!collapsed && (
                    <span className="flex flex-col items-start min-w-0 flex-1 text-left">
                        <span className="truncate w-full">{opts.label}</span>
                        {opts.hint && <span className="text-[10px] font-normal text-muted-foreground truncate w-full">{opts.hint}</span>}
                    </span>
                )}
                {!collapsed && opts.shortcut && (
                    <kbd className="ml-auto text-[10px] font-mono text-muted-foreground border rounded px-1" aria-hidden="true">{opts.shortcut}</kbd>
                )}
            </Button>
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
        !collapsed && <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{text}</p>
    );

    return (
        <nav className={cn(
            "flex flex-col border-r bg-card",
            collapsed ? "w-16" : "w-64",
            className
        )} aria-label="Main navigation">
            {/* Header */}
            <div className="h-16 flex items-center px-4 border-b">
                <div className={cn("flex items-center gap-2 overflow-hidden", collapsed && "justify-center w-full")}>
                    <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 overflow-hidden">
                        <img src="icon.png" alt="" className="h-full w-full object-cover" />
                    </div>
                    {!collapsed && (
                        <span className="font-bold text-lg whitespace-nowrap">Cracked Oura</span>
                    )}
                </div>
            </div>

            {/* Navigation */}
            <ScrollArea className="flex-1 py-2">
                <div className="px-2 space-y-0.5">
                    {groupLabel('Views')}
                    {navButton({
                        label: 'Ring',
                        icon: <Bluetooth className="h-5 w-5 shrink-0" aria-hidden="true" />,
                        active: activeView === 'ring',
                        onClick: onRingPageSelect,
                        shortcut: '1',
                    })}
                    {navButton({
                        label: 'AI Analyst',
                        icon: <Sparkles className="h-5 w-5 shrink-0" aria-hidden="true" />,
                        active: activeView === 'chat-page',
                        onClick: onChatPageSelect,
                        shortcut: '2',
                    })}
                </div>

                <div className="px-2 space-y-0.5 mt-2">
                    {groupLabel('My dashboards')}
                    {dashboards.map(dashboard => {
                        const active = activeView === 'dashboard' && activeDashboardId === dashboard.id;
                        return (
                            <div key={dashboard.id} className="group relative flex items-center">
                                {editingId === dashboard.id && !collapsed ? (
                                    <div className="flex items-center w-full px-2">
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
                                        icon: <LayoutDashboard className="h-5 w-5 shrink-0" aria-hidden="true" />,
                                        active,
                                        onClick: () => onDashboardSelect(dashboard.id),
                                    })
                                )}

                                {!collapsed && !editingId && (
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 absolute right-1 text-muted-foreground hover:text-foreground"
                                                aria-label={`${dashboard.name} options`}
                                            >
                                                <MoreVertical className="h-4 w-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={() => handleStartEdit(dashboard)}>
                                                <Edit2 className="h-4 w-4 mr-2" />
                                                Rename
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => onDashboardReset(dashboard.id)}>
                                                <RotateCcw className="h-4 w-4 mr-2" />
                                                Reset Overview
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                                className="text-destructive focus:text-destructive"
                                                onClick={() => onDashboardDelete(dashboard.id)}
                                                disabled={dashboards.length <= 1}
                                            >
                                                <Trash2 className="h-4 w-4 mr-2" />
                                                Delete
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                )}
                            </div>
                        );
                    })}

                    {!collapsed ? (
                        <Button
                            variant="ghost"
                            className="w-full justify-start gap-3 px-3 text-muted-foreground hover:text-foreground"
                            onClick={onDashboardAdd}
                        >
                            <Plus className="h-5 w-5 shrink-0" aria-hidden="true" />
                            <span>New dashboard</span>
                        </Button>
                    ) : (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="w-full justify-center"
                            onClick={onDashboardAdd}
                            aria-label="New dashboard"
                            title="New dashboard"
                        >
                            <Plus className="h-5 w-5" />
                        </Button>
                    )}
                </div>
            </ScrollArea>

            {/* Footer */}
            <div className="p-2 border-t space-y-0.5">
                {navButton({
                    label: 'Data & Sync',
                    icon: <Database className="h-5 w-5 shrink-0" aria-hidden="true" />,
                    active: activePanel === 'data',
                    onClick: onDataSyncClick,
                    hint: dataSyncHint,
                })}
                {navButton({
                    label: 'Settings',
                    icon: <Settings className="h-5 w-5 shrink-0" aria-hidden="true" />,
                    active: activePanel === 'settings',
                    onClick: onSettingsClick,
                })}
                <Button
                    variant="ghost"
                    size="icon"
                    className="w-full"
                    onClick={() => setCollapsed(!collapsed)}
                    aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                    {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                </Button>
            </div>
        </nav>
    );
}
