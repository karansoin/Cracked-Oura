export interface ShortcutRow {
    keys: string[];
    action: string;
}

/** Global keyboard shortcuts (implemented in `useKeyboardShortcuts`). */
export const SHORTCUTS: readonly ShortcutRow[] = [
    { keys: ['←', '→'], action: 'Previous / next day' },
    { keys: ['Shift', '←', '→'], action: 'Back / forward 7 days' },
    { keys: ['T'], action: 'Jump to today' },
    { keys: ['D'], action: 'Open the date picker' },
    { keys: ['E'], action: 'Toggle edit mode on the current dashboard' },
    { keys: ['Esc'], action: 'Close the side panel / exit edit mode' },
    { keys: ['1'], action: 'Ring page' },
    { keys: ['2'], action: 'AI Analyst' },
    { keys: ['?'], action: 'Show this sheet' },
];
