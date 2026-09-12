import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from 'react';
import type { WidgetInstance, Dashboard, LayoutItem } from '@/types';
import { useOuraData, type OuraDayData } from '@/hooks/useOuraData';
import { useDashboardPersistence } from '@/hooks/useDashboardPersistence';
import { useAppStatus } from '@/contexts/AppStatusContext';
import { buildOverviewContents, buildOverviewDashboard } from '@/lib/defaultDashboard';
import { format } from 'date-fns';

// Initial empty dashboard skeleton
const EMPTY_DASHBOARD: Dashboard = {
    id: 'default',
    name: 'Daily Overview',
    widgets: [],
    layout: []
};

export type PanelType = 'none' | 'chat' | 'editor' | 'settings' | 'data';
export type ViewType = 'dashboard' | 'chat-page' | 'ring';

interface DashboardContextType {
    // Dashboard State
    dashboards: Dashboard[];
    activeDashboardId: string;
    activeDashboard: Dashboard;
    setActiveDashboardId: (id: string) => void;
    addDashboard: () => void;
    deleteDashboard: (id: string) => void;
    renameDashboard: (id: string, name: string) => void;
    /** Replace a dashboard's widgets/layout with the Overview template (creates it if id is missing). */
    resetOverview: (id?: string) => void;

    // Layout/Widget State (for active dashboard)
    widgets: WidgetInstance[];
    layout: LayoutItem[];
    updateActiveDashboard: (updates: Partial<Dashboard>) => void;
    /** False until the saved layouts have been fetched; saves are skipped while false. */
    isLayoutLoaded: boolean;

    // UI State
    isEditing: boolean;
    setIsEditing: (isEditing: boolean) => void;
    activePanel: PanelType;
    setActivePanel: (panel: PanelType) => void;
    activeView: ViewType;
    setActiveView: (view: ViewType) => void;
    isDatePickerOpen: boolean;
    setDatePickerOpen: (open: boolean) => void;
    isShortcutSheetOpen: boolean;
    setShortcutSheetOpen: (open: boolean) => void;

    // Widget Editing
    editingWidget: WidgetInstance | undefined;
    startEditingWidget: (widget?: WidgetInstance) => void; // If undefined, adds new
    saveEditingWidget: () => void;
    cancelEditingWidget: () => void;
    updateEditingWidget: (widget: WidgetInstance) => void;
    deleteWidget: (id: string) => void;

    // Data State
    selectedDate: Date;
    setSelectedDate: (date: Date) => void;
    data: OuraDayData;
}

const DashboardContext = createContext<DashboardContextType | undefined>(undefined);

export function DashboardProvider({ children }: { children: ReactNode }) {
    // --- State Definitions ---

    const [isEditing, setIsEditing] = useState(false);
    const [activePanel, setActivePanel] = useState<PanelType>('none');
    const [activeView, setActiveView] = useState<ViewType>('dashboard');
    const [selectedDate, setSelectedDate] = useState<Date>(new Date());
    const [isDatePickerOpen, setDatePickerOpen] = useState(false);
    const [isShortcutSheetOpen, setShortcutSheetOpen] = useState(false);

    // Dashboards
    const [dashboards, setDashboards] = useState<Dashboard[]>([EMPTY_DASHBOARD]);
    const [activeDashboardId, setActiveDashboardId] = useState<string>('default');

    // Widget Editing
    const [editingWidget, setEditingWidget] = useState<WidgetInstance | undefined>(undefined);
    const [originalWidget, setOriginalWidget] = useState<WidgetInstance | undefined>(undefined);

    // Persistence. When the saved dashboards arrive they replace the empty default and
    // the saved active id is selected - done in the load promise callback rather than an
    // effect so no state is set synchronously during an effect.
    const { saveDashboards, savedDashboards, isLoaded: isLayoutLoaded } = useDashboardPersistence({
        onLoaded: ({ dashboards: saved, activeDashboardId: savedActiveId }) => {
            if (saved.length === 0) return;
            setDashboards(saved);
            setActiveDashboardId(savedActiveId || saved[0].id);
        }
    });

    // Data Fetching
    const dateString = format(selectedDate, 'yyyy-MM-dd');
    const data = useOuraData(dateString);
    const { hasData } = useAppStatus();

    // --- Effects ---

    // Resize trigger on panel change
    useEffect(() => {
        window.dispatchEvent(new Event('resize'));
    }, [activePanel]);

    // First-run Overview: once data exists and the user has no saved dashboards
    // (or only the empty skeleton), create the template dashboard.
    const seededRef = useRef(false);
    useEffect(() => {
        if (seededRef.current || !isLayoutLoaded || hasData !== true) return;
        const nothingSaved = !savedDashboards || savedDashboards.length === 0
            || (savedDashboards.length === 1 && savedDashboards[0].widgets.length === 0);
        if (!nothingSaved) return;
        // Seed in a callback (not synchronously in the effect body) so React does not
        // re-render in a cascade; the ref guards against double seeding.
        const timer = window.setTimeout(() => {
            if (seededRef.current) return;
            seededRef.current = true;
            const overview = buildOverviewDashboard();
            setDashboards([overview]);
            setActiveDashboardId(overview.id);
            saveDashboards([overview], overview.id);
        }, 0);
        return () => window.clearTimeout(timer);
    }, [isLayoutLoaded, hasData, savedDashboards, saveDashboards]);

    // --- Helpers ---

    const activeDashboard = dashboards.find(d => d.id === activeDashboardId) || dashboards[0];
    const widgets = activeDashboard?.widgets || [];
    const layout = activeDashboard?.layout || [];

    const persist = (newDashboards: Dashboard[], newActiveId: string) => {
        saveDashboards(newDashboards, newActiveId);
    };

    // --- Actions ---

    const addDashboard = () => {
        const newId = `dashboard-${Date.now()}`;
        const newDashboard: Dashboard = {
            id: newId,
            name: 'New Dashboard',
            widgets: [],
            layout: []
        };
        const newDashboards = [...dashboards, newDashboard];
        setDashboards(newDashboards);
        setActiveDashboardId(newId);
        setActiveView('dashboard');
        persist(newDashboards, newId);
    };

    const deleteDashboard = (id: string) => {
        if (dashboards.length <= 1) return;
        const newDashboards = dashboards.filter(d => d.id !== id);
        setDashboards(newDashboards);

        let newActiveId = activeDashboardId;
        if (activeDashboardId === id) {
            newActiveId = newDashboards[0].id;
            setActiveDashboardId(newActiveId);
        }
        persist(newDashboards, newActiveId);
    };

    const renameDashboard = (id: string, name: string) => {
        const newDashboards = dashboards.map(d =>
            d.id === id ? { ...d, name } : d
        );
        setDashboards(newDashboards);
        persist(newDashboards, activeDashboardId);
    };

    const resetOverview = (id?: string) => {
        const targetId = id ?? activeDashboardId;
        const exists = dashboards.some(d => d.id === targetId);
        const newDashboards = exists
            ? dashboards.map(d => d.id === targetId ? { ...d, ...buildOverviewContents() } : d)
            : [...dashboards, buildOverviewDashboard(targetId)];
        setDashboards(newDashboards);
        setActiveDashboardId(targetId);
        setActiveView('dashboard');
        setIsEditing(false);
        persist(newDashboards, targetId);
    };

    // Overriding updateActiveDashboard to handle persistence
    const handleUpdateActiveDashboard = (updates: Partial<Dashboard>) => {
        const newDashboards = dashboards.map(d =>
            d.id === activeDashboardId ? { ...d, ...updates } : d
        );
        setDashboards(newDashboards);
        // We persist here because most updates (layout, widget CRUD) should be saved.
        persist(newDashboards, activeDashboardId);
    };

    // Widget Actions

    const startEditingWidget = (widget?: WidgetInstance) => {
        if (widget) {
            // Edit existing
            setEditingWidget(widget);
            setOriginalWidget(widget);
        } else {
            // Add new
            const maxId = widgets.length > 0
                ? Math.max(...widgets.map(w => parseInt(w.id) || 0))
                : 0;
            const newId = (maxId + 1).toString();

            const newWidget: WidgetInstance = {
                id: newId,
                type: 'score',
                title: 'New Widget',
                width: 'col-span-4',
                height: 'h-40',
                config: { dataKey: 'sleep.score' }
            };

            const newWidgets = [...widgets, newWidget];
            const newLayout: LayoutItem[] = [...layout, {
                i: newId,
                x: 0,
                y: Infinity,
                w: 4,
                h: 4
            }];

            handleUpdateActiveDashboard({ widgets: newWidgets, layout: newLayout });
            setEditingWidget(newWidget);
            setOriginalWidget(undefined); // undefined indicates new
        }
        setActivePanel('editor');
    };

    const updateEditingWidget = (updatedWidget: WidgetInstance) => {

        setDashboards(prev => prev.map(d =>
            d.id === activeDashboardId ? { ...d, widgets: d.widgets.map(w => w.id === updatedWidget.id ? updatedWidget : w) } : d
        ));
        setEditingWidget(updatedWidget);
    };

    const saveEditingWidget = () => {
        setEditingWidget(undefined);
        setOriginalWidget(undefined);
        setActivePanel('none');
        persist(dashboards, activeDashboardId); // Save state "snapshot"
    };

    const cancelEditingWidget = () => {
        if (originalWidget) {
            // Revert
            const newWidgets = widgets.map(w => w.id === originalWidget.id ? originalWidget : w);
            handleUpdateActiveDashboard({ widgets: newWidgets });
        } else if (editingWidget) {
            // Remove newly added
            const newWidgets = widgets.filter(w => w.id !== editingWidget.id);
            const newLayout = layout.filter(l => l.i !== editingWidget.id);
            handleUpdateActiveDashboard({ widgets: newWidgets, layout: newLayout });
        }
        setEditingWidget(undefined);
        setOriginalWidget(undefined);
        setActivePanel('none');

    };

    const deleteWidget = (id: string) => {
        const newWidgets = widgets.filter(w => w.id !== id);
        const newLayout = layout.filter(l => l.i !== id);
        // Update and Save
        const newDashboards = dashboards.map(d =>
            d.id === activeDashboardId ? { ...d, widgets: newWidgets, layout: newLayout } : d
        );
        setDashboards(newDashboards);
        persist(newDashboards, activeDashboardId);
    };

    return (
        <DashboardContext.Provider value={{
            dashboards,
            activeDashboardId,
            activeDashboard,
            setActiveDashboardId,
            addDashboard,
            deleteDashboard,
            renameDashboard,
            resetOverview,
            widgets,
            layout,
            updateActiveDashboard: handleUpdateActiveDashboard,
            isLayoutLoaded,
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
            editingWidget,
            startEditingWidget,
            saveEditingWidget,
            cancelEditingWidget,
            updateEditingWidget,
            deleteWidget,
            selectedDate,
            setSelectedDate,
            data
        }}>
            {children}
        </DashboardContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components -- context hook lives with its provider
export function useDashboard() {
    const context = useContext(DashboardContext);
    if (context === undefined) {
        throw new Error('useDashboard must be used within a DashboardProvider');
    }
    return context;
}
