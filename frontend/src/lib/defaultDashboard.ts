import type { Dashboard, LayoutItem, WidgetInstance } from '@/types';

export const OVERVIEW_DASHBOARD_ID = 'overview';
export const OVERVIEW_DASHBOARD_NAME = 'Overview';

interface TemplateWidget {
    id: string;
    type: string;
    title: string;
    config: WidgetInstance['config'];
    layout: Omit<LayoutItem, 'i'>;
}

const SLEEP_STATS_KEYS = [
    'sleep_session.start_time',
    'sleep_session.end_time',
    'sleep_session.total_sleep_duration',
    'sleep_session.deep_sleep_duration',
    'sleep_session.rem_sleep_duration',
    'sleep_session.light_sleep_duration',
    'sleep_session.awake_time',
    'sleep_session.efficiency',
    'sleep_session.average_heart_rate',
    'sleep_session.lowest_heart_rate',
    'sleep_session.average_hrv',
    'sleep_session.average_breath',
    'sleep_session.time_in_bed',
];

/**
 * The first-run "Overview" dashboard, on the 12-column grid (rowHeight 60px).
 * Widget ids are numeric strings so `startEditingWidget` can keep allocating ids.
 */
const TEMPLATE: TemplateWidget[] = [
    { id: '1', type: 'score', title: 'Sleep', config: { dataKey: 'sleep.score' }, layout: { x: 0, y: 0, w: 3, h: 3 } },
    { id: '2', type: 'score', title: 'Readiness', config: { dataKey: 'readiness.score' }, layout: { x: 3, y: 0, w: 3, h: 3 } },
    { id: '3', type: 'score', title: 'Activity', config: { dataKey: 'activity.score' }, layout: { x: 6, y: 0, w: 3, h: 3 } },
    { id: '4', type: 'metric', title: 'Temperature deviation', config: { dataKey: 'readiness.temperature_deviation' }, layout: { x: 9, y: 0, w: 3, h: 1 } },
    { id: '5', type: 'metric', title: 'Lowest heart rate', config: { dataKey: 'sleep_session.lowest_heart_rate', unit: 'bpm' }, layout: { x: 9, y: 1, w: 3, h: 1 } },
    { id: '6', type: 'metric', title: 'Average HRV', config: { dataKey: 'sleep_session.average_hrv', unit: 'ms' }, layout: { x: 9, y: 2, w: 3, h: 1 } },
    { id: '7', type: 'hypnogram', title: 'Last night', config: { dataKey: 'sleep_session.sleep_phase_5_min' }, layout: { x: 0, y: 3, w: 8, h: 4 } },
    { id: '8', type: 'contributors', title: 'Sleep contributors', config: { dataKey: 'sleep.contributors' }, layout: { x: 8, y: 3, w: 4, h: 4 } },
    {
        id: '9', type: 'table', title: 'Sleep stats',
        config: { dataKey: SLEEP_STATS_KEYS[0], dataKeys: SLEEP_STATS_KEYS, dateRange: { type: 'selected_day' } },
        layout: { x: 8, y: 7, w: 4, h: 4 },
    },
    {
        id: '10', type: 'trend', title: 'Heart rate during sleep',
        config: { dataKey: 'sleep_session.hr_data', dataKeys: ['sleep_session.hr_data'], color: '#D55E00', dateRange: { type: 'selected_day' } },
        layout: { x: 0, y: 7, w: 8, h: 4 },
    },
    {
        id: '11', type: 'trend', title: 'Scores, 30 days',
        config: {
            dataKey: 'sleep.score',
            dataKeys: ['sleep.score', 'readiness.score', 'activity.score'],
            color: '#0072B2',
            dateRange: { type: 'relative', value: 30, unit: 'days', anchor: 'selected_date' },
        },
        layout: { x: 0, y: 11, w: 12, h: 4 },
    },
    {
        id: '12', type: 'trend', title: 'Resting HR & HRV, 90 days',
        config: {
            dataKey: 'sleep_session.lowest_heart_rate',
            dataKeys: ['sleep_session.lowest_heart_rate', 'sleep_session.average_hrv'],
            color: '#D55E00',
            showPoints: true,
            dateRange: { type: 'relative', value: 90, unit: 'days', anchor: 'selected_date' },
        },
        layout: { x: 0, y: 15, w: 6, h: 3 },
    },
    {
        id: '13', type: 'bar', title: 'Temperature deviation, 90 days',
        config: {
            dataKey: 'readiness.temperature_deviation',
            dataKeys: ['readiness.temperature_deviation'],
            color: '#E69F00',
            dateRange: { type: 'relative', value: 90, unit: 'days', anchor: 'selected_date' },
        },
        layout: { x: 6, y: 15, w: 6, h: 3 },
    },
    {
        id: '14', type: 'trend', title: 'Activity (MET) today',
        config: { dataKey: 'activity.met', dataKeys: ['activity.met'], color: '#009E73', dateRange: { type: 'selected_day' } },
        layout: { x: 0, y: 18, w: 12, h: 3 },
    },
];

/** Widgets + layout for the Overview template (fresh copies each call). */
export function buildOverviewContents(): Pick<Dashboard, 'widgets' | 'layout'> {
    const widgets: WidgetInstance[] = TEMPLATE.map(t => ({
        id: t.id,
        type: t.type,
        title: t.title,
        width: 'col-span-4',
        height: 'h-40',
        config: JSON.parse(JSON.stringify(t.config)) as WidgetInstance['config'],
    }));
    const layout: LayoutItem[] = TEMPLATE.map(t => ({ i: t.id, ...t.layout }));
    return { widgets, layout };
}

export function buildOverviewDashboard(id = OVERVIEW_DASHBOARD_ID, name = OVERVIEW_DASHBOARD_NAME): Dashboard {
    return { id, name, ...buildOverviewContents() };
}
