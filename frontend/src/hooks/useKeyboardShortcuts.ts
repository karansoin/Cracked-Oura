import { useEffect } from 'react';
import { addDays } from 'date-fns';
import { useDashboard } from '@/contexts/DashboardContext';

/** True when the keyboard focus is somewhere the user is typing. */
function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return !!target.closest('[contenteditable="true"]');
}

const dialogIsOpen = () => !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');

/**
 * Global shortcuts: ←/→ ±1 day, Shift+←/→ ±7, T today, D date picker, E edit mode,
 * Esc close panel / exit edit, ? shortcut sheet, 1 Ring page, 2 AI Analyst, 3 Trends.
 * The day shortcuts also work on the Trends view (its top bar keeps the day stepper).
 */
export function useKeyboardShortcuts() {
    const {
        selectedDate,
        setSelectedDate,
        setDatePickerOpen,
        isDatePickerOpen,
        isEditing,
        setIsEditing,
        activePanel,
        setActivePanel,
        activeView,
        setActiveView,
        isShortcutSheetOpen,
        setShortcutSheetOpen,
        cancelEditingWidget,
    } = useDashboard();

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
            if (isTypingTarget(e.target)) return;
            const hasDayStepper = activeView === 'dashboard' || activeView === 'trends';

            switch (e.key) {
                case 'ArrowLeft':
                case 'ArrowRight': {
                    if (!hasDayStepper || isDatePickerOpen) return;
                    e.preventDefault();
                    const step = (e.shiftKey ? 7 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
                    setSelectedDate(addDays(selectedDate, step));
                    return;
                }
                case 't':
                case 'T':
                    if (!hasDayStepper) return;
                    e.preventDefault();
                    setSelectedDate(new Date());
                    return;
                case 'd':
                case 'D':
                    if (!hasDayStepper) return;
                    e.preventDefault();
                    setDatePickerOpen(!isDatePickerOpen);
                    return;
                case 'e':
                case 'E':
                    if (activeView !== 'dashboard') return;
                    e.preventDefault();
                    if (isEditing && activePanel === 'editor') cancelEditingWidget();
                    setIsEditing(!isEditing);
                    return;
                case 'Escape':
                    if (dialogIsOpen()) return; // Radix closes its own dialogs/popovers
                    if (isDatePickerOpen) { setDatePickerOpen(false); return; }
                    if (activePanel === 'editor') { cancelEditingWidget(); return; }
                    if (activePanel !== 'none') { setActivePanel('none'); return; }
                    if (isEditing) setIsEditing(false);
                    return;
                case '?':
                case '/': // some keyboard layouts / synthetic events report Shift+/ as '/'
                    if (e.key === '/' && !e.shiftKey) return;
                    e.preventDefault();
                    setShortcutSheetOpen(!isShortcutSheetOpen);
                    return;
                case '1':
                    e.preventDefault();
                    setActiveView('ring');
                    return;
                case '2':
                    e.preventDefault();
                    setActiveView('chat-page');
                    return;
                case '3':
                    e.preventDefault();
                    setActiveView('trends');
                    return;
                default:
                    return;
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [
        selectedDate, setSelectedDate, setDatePickerOpen, isDatePickerOpen, isEditing, setIsEditing,
        activePanel, setActivePanel, activeView, setActiveView, isShortcutSheetOpen, setShortcutSheetOpen, cancelEditingWidget,
    ]);
}
