import { AppSidebar } from "./AppSidebar";
import { StatusPill } from "./StatusPill";
import { Button } from "@/components/ui/button";
import { Sparkles, Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { format, isToday } from "date-fns";
import { cn } from "@/lib/utils";
import type { Dashboard } from "@/types";
import type { PanelType, ViewType } from "@/contexts/DashboardContext";
import { ModeToggle } from "@/components/mode-toggle";

interface MainLayoutProps {
    children: React.ReactNode;
    rightPanel?: React.ReactNode;
    onChatToggle?: () => void;
    isChatOpen?: boolean;
    selectedDate?: Date;
    onDateChange?: (date: Date | undefined) => void;
    onToday?: () => void;
    isDatePickerOpen?: boolean;
    onDatePickerOpenChange?: (open: boolean) => void;
    onSettingsClick?: () => void;
    onDataSyncClick?: () => void;
    headerActions?: React.ReactNode;
    /** Days (yyyy-MM-dd) that have data; other days are dimmed in the calendar. */
    daysWithData?: ReadonlySet<string>;

    // Dashboard Props
    dashboards: Dashboard[];
    activeDashboardId: string;
    onDashboardSelect: (id: string) => void;
    onDashboardAdd: () => void;
    onDashboardDelete: (id: string) => void;
    onDashboardRename: (id: string, newName: string) => void;
    onDashboardReset: (id: string) => void;

    // Navigation
    activeView?: ViewType;
    activePanel?: PanelType;
    onChatPageSelect?: () => void;
    onRingPageSelect?: () => void;
    dataSyncHint?: string;
}

export function MainLayout({
    children,
    rightPanel,
    onChatToggle,
    isChatOpen,
    selectedDate = new Date(),
    onDateChange,
    onToday,
    isDatePickerOpen,
    onDatePickerOpenChange,
    onSettingsClick,
    onDataSyncClick,
    headerActions,
    daysWithData,
    dashboards,
    activeDashboardId,
    onDashboardSelect,
    onDashboardAdd,
    onDashboardDelete,
    onDashboardRename,
    onDashboardReset,
    activeView = 'dashboard',
    activePanel = 'none',
    onChatPageSelect,
    onRingPageSelect,
    dataSyncHint,
}: MainLayoutProps) {
    const activeDashboardName = dashboards.find(d => d.id === activeDashboardId)?.name || "Dashboard";
    const title = activeView === 'ring' ? 'Ring' : activeView === 'chat-page' ? 'AI Analyst' : activeDashboardName;

    const shiftDay = (delta: number) => {
        if (!onDateChange || !selectedDate) return;
        const next = new Date(selectedDate);
        next.setDate(next.getDate() + delta);
        onDateChange(next);
    };

    return (
        <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
            <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[500] focus:top-2 focus:left-2 focus:bg-card focus:px-3 focus:py-2 focus:rounded-md focus:border">
                Skip to content
            </a>

            {/* Left Sidebar */}
            <AppSidebar
                onSettingsClick={onSettingsClick}
                onDataSyncClick={onDataSyncClick}
                dashboards={dashboards}
                activeDashboardId={activeDashboardId}
                onDashboardSelect={onDashboardSelect}
                onDashboardAdd={onDashboardAdd}
                onDashboardDelete={onDashboardDelete}
                onDashboardRename={onDashboardRename}
                onDashboardReset={onDashboardReset}
                activeView={activeView}
                activePanel={activePanel}
                onChatPageSelect={onChatPageSelect}
                onRingPageSelect={onRingPageSelect}
                dataSyncHint={dataSyncHint}
            />

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col min-w-0">
                {/* Header */}
                <header className="h-16 border-b flex items-center justify-between gap-4 px-6 bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/50">
                    <div className="flex items-center gap-4 min-w-0">
                        <h1 className="text-xl font-semibold truncate">{title}</h1>

                        {activeView === 'dashboard' && (
                            <>
                                <div className="h-6 w-px bg-border shrink-0" />

                                <div className="flex items-center gap-1" role="group" aria-label="Selected day">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => shiftDay(-1)} aria-label="Previous day">
                                                <ChevronLeft className="h-4 w-4" />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Previous day <kbd className="ml-1 font-mono">←</kbd> · 7 days <kbd className="font-mono">Shift+←</kbd></TooltipContent>
                                    </Tooltip>

                                    <Popover open={isDatePickerOpen} onOpenChange={onDatePickerOpenChange}>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <PopoverTrigger asChild>
                                                    <Button
                                                        variant={"outline"}
                                                        className={cn(
                                                            "w-[220px] h-9 justify-start text-left font-normal",
                                                            !selectedDate && "text-muted-foreground"
                                                        )}
                                                        aria-label={`Selected day: ${format(selectedDate, "PPP")}. Open date picker`}
                                                    >
                                                        <CalendarIcon className="mr-2 h-4 w-4" aria-hidden="true" />
                                                        {selectedDate ? format(selectedDate, "EEE d MMM yyyy") : <span>Pick a date</span>}
                                                    </Button>
                                                </PopoverTrigger>
                                            </TooltipTrigger>
                                            <TooltipContent>Pick a date <kbd className="ml-1 font-mono">D</kbd></TooltipContent>
                                        </Tooltip>
                                        <PopoverContent className="w-auto p-0" align="start">
                                            <Calendar
                                                mode="single"
                                                selected={selectedDate}
                                                onSelect={(d) => { onDateChange?.(d); if (d) onDatePickerOpenChange?.(false); }}
                                                modifiers={daysWithData ? { noData: (day) => !daysWithData.has(format(day, 'yyyy-MM-dd')) } : undefined}
                                                modifiersClassNames={{ noData: 'opacity-40' }}
                                                initialFocus
                                            />
                                        </PopoverContent>
                                    </Popover>

                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => shiftDay(1)} aria-label="Next day">
                                                <ChevronRight className="h-4 w-4" />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Next day <kbd className="ml-1 font-mono">→</kbd> · 7 days <kbd className="font-mono">Shift+→</kbd></TooltipContent>
                                    </Tooltip>

                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-9"
                                                onClick={onToday}
                                                disabled={isToday(selectedDate)}
                                            >
                                                Today
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Jump to today <kbd className="ml-1 font-mono">T</kbd></TooltipContent>
                                    </Tooltip>
                                </div>
                            </>
                        )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        <StatusPill />
                        {headerActions}
                        <ModeToggle />
                        <Button
                            variant={isChatOpen ? "secondary" : "outline"}
                            size="sm"
                            onClick={onChatToggle}
                        >
                            <Sparkles className="h-4 w-4 mr-2" aria-hidden="true" />
                            Ask AI
                        </Button>
                    </div>
                </header>

                {/* Dashboard Content */}
                <div className="flex-1 flex overflow-hidden">
                    <main id="main-content" className="flex-1 overflow-auto p-6 relative" tabIndex={-1}>
                        {children}
                    </main>

                    {/* Persistent Right Panel */}
                    {rightPanel}
                </div>
            </div>
        </div>
    );
}
