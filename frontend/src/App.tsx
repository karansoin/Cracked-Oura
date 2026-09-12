import { useEffect, useMemo, useState } from "react";
import { Toaster } from "sonner";
import { DashboardProvider, useDashboard } from "@/contexts/DashboardContext";
import { AppStatusProvider, useAppStatus } from "@/contexts/AppStatusContext";
import { MainLayout } from "@/components/layout/MainLayout";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { Button } from "@/components/ui/button";
import { Edit2, Check, CalendarCheck } from "lucide-react";
import { format, parseISO } from "date-fns";
import { SettingsPanel } from "@/components/dashboard/SettingsPanel";
import { DataSyncPanel } from "@/components/dashboard/DataSyncPanel";
import { WidgetEditorPanel } from "@/components/dashboard/WidgetEditorPanel";
import { ChatPanel } from "@/components/dashboard/ChatPanel";
import { ChatPage } from "@/components/dashboard/ChatPage";
import { RingPage } from "@/components/ring/RingPage";
import { TrendsView } from "@/components/trends/TrendsView";
import { TrendsRangeSelector } from "@/components/trends/TrendsRangeSelector";
import { OnboardingEmptyState } from "@/components/dashboard/OnboardingEmptyState";
import { ShortcutSheet } from "@/components/dashboard/ShortcutSheet";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { useChat } from "@/hooks/useChat";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useIsDark } from "@/components/theme-provider";
import { api } from "@/lib/api";
import { formatDay, formatRelative } from "@/lib/format";
import type { LayoutItem } from "@/types";

function DashboardApp() {
    const {
        dashboards,
        activeDashboardId,
        setActiveDashboardId,
        addDashboard,
        deleteDashboard,
        renameDashboard,
        resetOverview,
        widgets,
        layout,
        updateActiveDashboard,
        isEditing,
        setIsEditing,
        activePanel,
        setActivePanel,
        activeView,
        setActiveView,
        isDatePickerOpen,
        setDatePickerOpen,
        isShortcutSheetOpen,
        setShortcutSheetOpen,
        startEditingWidget,
        editingWidget,
        updateEditingWidget,
        saveEditingWidget,
        cancelEditingWidget,
        deleteWidget,
        selectedDate,
        setSelectedDate,
        data,
        trends,
        updateTrends,
    } = useDashboard();
    const { hasData, sync, inventory } = useAppStatus();
    const isDark = useIsDark();

    useKeyboardShortcuts();

    // Chat State
    const { messages, isLoading, sendMessage, clearHistory } = useChat();

    // Days with data (dims empty days in the calendar); refreshed when the inventory changes.
    const [daysWithData, setDaysWithData] = useState<ReadonlySet<string>>(new Set());
    useEffect(() => {
        let cancelled = false;
        api.getDays().then(days => { if (!cancelled) setDaysWithData(new Set(days)); }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [inventory]);

    const [resetTarget, setResetTarget] = useState<string | null>(null);

    const handleLayoutChange = (newLayout: LayoutItem[]) => {
        updateActiveDashboard({ layout: newLayout });
    };

    const dataSyncHint = useMemo(() => {
        if (sync?.state === 'ingesting') return 'Importing…';
        if (sync?.state === 'error') return 'Last import failed';
        if (sync?.last_success_at) return `Up to date · ${formatRelative(sync.last_success_at)}`;
        if (hasData === false) return 'No data yet';
        return undefined;
    }, [sync, hasData]);

    const togglePanel = (panel: 'chat' | 'settings' | 'data') =>
        setActivePanel(activePanel === panel ? 'none' : panel);

    const renderRightPanel = () => {
        if (activePanel === 'editor') {
            return (
                <WidgetEditorPanel
                    onClose={cancelEditingWidget}
                    onSave={saveEditingWidget}
                    onChange={updateEditingWidget}
                    widget={editingWidget}
                />
            );
        }
        if (activePanel === 'chat') {
            return (
                <ChatPanel
                    onClose={() => setActivePanel('none')}
                    messages={messages}
                    isLoading={isLoading}
                    onSend={sendMessage}
                />
            );
        }
        if (activePanel === 'settings') {
            return <SettingsPanel onClose={() => setActivePanel('none')} />;
        }
        if (activePanel === 'data') {
            return <DataSyncPanel onClose={() => setActivePanel('none')} />;
        }
        return null;
    };

    const latestWithData = daysWithData.size > 0 ? [...daysWithData].sort().at(-1) : undefined;

    const renderMain = () => {
        if (activeView === 'ring') return <RingPage />;
        if (activeView === 'trends') {
            if (hasData === false) {
                return (
                    <OnboardingEmptyState
                        onConnectRing={() => setActiveView('ring')}
                        onImportZip={() => setActivePanel('data')}
                    />
                );
            }
            return <TrendsView latestDate={latestWithData} />;
        }
        if (activeView === 'chat-page') {
            return (
                <ChatPage
                    messages={messages}
                    isLoading={isLoading}
                    onSend={sendMessage}
                    onClear={clearHistory}
                />
            );
        }
        if (hasData === false) {
            return (
                <OnboardingEmptyState
                    onConnectRing={() => setActiveView('ring')}
                    onImportZip={() => setActivePanel('data')}
                />
            );
        }
        const selectedKey = format(selectedDate, 'yyyy-MM-dd');
        const showNoDataBanner = !data.isLoading && daysWithData.size > 0 && !daysWithData.has(selectedKey);

        return (
            <>
                {showNoDataBanner && (
                    <div className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed bg-card px-4 py-3 text-sm" role="status">
                        <span>
                            <span className="font-medium">No data for {format(selectedDate, 'EEE d MMM yyyy')}.</span>{' '}
                            {latestWithData && <span className="text-muted-foreground">Your most recent day with data is {formatDay(latestWithData)}.</span>}
                        </span>
                        {latestWithData && (
                            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSelectedDate(parseISO(latestWithData))}>
                                <CalendarCheck className="h-3.5 w-3.5" aria-hidden="true" /> Go to {formatDay(latestWithData)}
                            </Button>
                        )}
                    </div>
                )}
                <DashboardGrid
                    widgets={widgets}
                    layout={layout}
                    isEditing={isEditing}
                    onLayoutChange={handleLayoutChange}
                    onEditWidget={startEditingWidget}
                    onDeleteWidget={deleteWidget}
                    onWidgetChange={updateEditingWidget}
                    data={data}
                    selectedDate={selectedDate}
                    isLoading={data.isLoading}
                />
            </>
        );
    };

    return (
        <>
            <MainLayout
                rightPanel={renderRightPanel()}
                onChatToggle={() => togglePanel('chat')}
                isChatOpen={activePanel === 'chat'}
                selectedDate={selectedDate}
                onDateChange={(date) => date && setSelectedDate(date)}
                onToday={() => setSelectedDate(new Date())}
                isDatePickerOpen={isDatePickerOpen}
                onDatePickerOpenChange={setDatePickerOpen}
                onSettingsClick={() => togglePanel('settings')}
                onDataSyncClick={() => togglePanel('data')}
                daysWithData={daysWithData}

                // Dashboard Props
                dashboards={dashboards}
                activeDashboardId={activeDashboardId}
                onDashboardSelect={(id) => {
                    setActiveDashboardId(id);
                    setActiveView('dashboard');
                }}
                onDashboardAdd={addDashboard}
                onDashboardDelete={deleteDashboard}
                onDashboardRename={renameDashboard}
                onDashboardReset={(id) => setResetTarget(id)}

                // Navigation
                activeView={activeView}
                activePanel={activePanel}
                onChatPageSelect={() => setActiveView('chat-page')}
                onRingPageSelect={() => setActiveView('ring')}
                onTrendsPageSelect={() => setActiveView('trends')}
                dataSyncHint={dataSyncHint}
                headerExtra={activeView === 'trends' && hasData !== false ? (
                    <TrendsRangeSelector value={trends.range} onChange={(range) => updateTrends({ range })} />
                ) : undefined}

                headerActions={
                    activeView === 'dashboard' && hasData !== false ? (
                        <>
                            {isEditing && (
                                <Button onClick={() => startEditingWidget()} variant="secondary" size="sm">
                                    Add Widget
                                </Button>
                            )}
                            <Button
                                variant={isEditing ? "default" : "outline"}
                                size="sm"
                                onClick={() => {
                                    if (isEditing) {
                                        if (activePanel === 'editor') setActivePanel('none');
                                    }
                                    setIsEditing(!isEditing);
                                }}
                                className="gap-2"
                                title="Toggle edit mode (E)"
                            >
                                {isEditing ? <Check className="h-4 w-4" aria-hidden="true" /> : <Edit2 className="h-4 w-4" aria-hidden="true" />}
                                {isEditing ? "Done Editing" : "Edit Layout"}
                            </Button>
                        </>
                    ) : null
                }
            >
                {renderMain()}
            </MainLayout>

            <ShortcutSheet open={isShortcutSheetOpen} onOpenChange={setShortcutSheetOpen} />

            <ConfirmDialog
                open={resetTarget !== null}
                onOpenChange={(o) => !o && setResetTarget(null)}
                title="Reset this dashboard to the Overview template?"
                description={<p>All widgets on <strong>{dashboards.find(d => d.id === resetTarget)?.name ?? 'this dashboard'}</strong> will be replaced with the default Overview layout. This cannot be undone.</p>}
                confirmLabel="Reset Overview"
                destructive
                onConfirm={() => { if (resetTarget) resetOverview(resetTarget); }}
            />

            <Toaster
                position="bottom-right"
                theme={isDark ? 'dark' : 'light'}
                richColors
                closeButton
                visibleToasts={3}
                duration={8000}
            />
        </>
    );
}

function App() {
    return (
        <AppStatusProvider>
            <DashboardProvider>
                <DashboardApp />
            </DashboardProvider>
        </AppStatusProvider>
    );
}

export default App;
