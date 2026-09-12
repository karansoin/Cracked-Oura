import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Calendar as CalendarIcon, ArrowRight, Lock } from "lucide-react";
import { format, parseISO, subDays, subHours, subMinutes, subYears, isValid, parse } from "date-fns";
import { isIntradayKey } from "@/lib/utils";
import type { WidgetConfig, WidgetInstance } from "@/types";

type DateRangeConfig = NonNullable<WidgetConfig['dateRange']>;
type RangeType = DateRangeConfig['type'];
type RangeUnit = NonNullable<DateRangeConfig['unit']>;
type RangeAnchor = NonNullable<DateRangeConfig['anchor']>;

interface DateRangeSelectorProps {
    widget: WidgetInstance;
    onUpdate: (updates: Partial<WidgetInstance>) => void;
    selectedDate?: Date;
    isLocked?: boolean;
}

export function DateRangeSelector({ widget, onUpdate, selectedDate = new Date(), isLocked = false }: DateRangeSelectorProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [tempRange, setTempRange] = useState<{ from: Date | undefined; to?: Date | undefined } | undefined>(undefined);
    const [inputFrom, setInputFrom] = useState("");
    const [inputTo, setInputTo] = useState("");

    // Initialize temp range and inputs from widget config when opening
    useEffect(() => {
        if (isOpen) {
            const { type, startDate, endDate, value, unit, anchor } = widget.config.dateRange || {};

            let fromDate: Date | undefined;
            let toDate: Date | undefined;
            let fromStr = "";
            let toStr = "";

            const formatStr = 'yyyy-MM-dd';

            if (type === 'custom' && startDate) {
                fromDate = parseISO(startDate);
                toDate = endDate ? parseISO(endDate) : undefined;
                fromStr = format(fromDate, formatStr);
                toStr = toDate ? format(toDate, formatStr) : "";
            } else if (type === 'relative') {
                if (anchor === 'selected_date') {
                    toStr = "selection";
                    toDate = selectedDate;
                } else {
                    toStr = "today";
                    toDate = new Date();
                }

                if (value && unit) {
                    let unitStr = 'd';
                    if (unit === 'hours') unitStr = 'h';
                    if (unit === 'minutes') unitStr = 'm';
                    if (unit === 'years') unitStr = 'y';

                    fromStr = `${value}${unitStr}`;

                    if (unit === 'days') fromDate = subDays(toDate, value);
                    else if (unit === 'hours') fromDate = subHours(toDate, value);
                    else if (unit === 'minutes') fromDate = subMinutes(toDate, value);
                    else if (unit === 'years') fromDate = subYears(toDate, value);
                }
            } else if (type === 'selected_day') {
                fromStr = "selection";
                toStr = "selection";
                fromDate = selectedDate;
                toDate = selectedDate;
            } else if (type === 'last_30') {
                fromStr = "30d";
                toStr = "today";
                toDate = new Date();
                fromDate = subDays(toDate, 30);
            } else if (type === 'last_90') {
                fromStr = "90d";
                toStr = "today";
                toDate = new Date();
                fromDate = subDays(toDate, 90);
            } else {
                // Default to 7d - today if no config
                fromStr = "7d";
                toStr = "today";
                toDate = new Date();
                fromDate = subDays(toDate, 7);
            }

            setTempRange({ from: fromDate, to: toDate });
            setInputFrom(fromStr);
            setInputTo(toStr);
        }
    }, [isOpen, widget.config.dateRange, selectedDate]);



    const parseInput = (input: string): { date?: Date, isRelative?: boolean, value?: number, unit?: string, keyword?: string } => {
        const lower = input.toLowerCase().trim();

        // Keywords
        if (lower === 'today') return { date: new Date(), keyword: 'today' };
        if (lower === 'selection') return { date: selectedDate, keyword: 'selection' };

        // Handle "today HH:mm"
        if (lower.startsWith('today ')) {
            const timePart = lower.replace('today ', '');
            const today = new Date();
            const parsedTime = parse(timePart, 'HH:mm', today);
            if (isValid(parsedTime)) return { date: parsedTime };
        }

        // Relative patterns
        const daysMatch = lower.match(/^(\d+)d$/);
        if (daysMatch) return { isRelative: true, value: parseInt(daysMatch[1]), unit: 'days' };

        const yearsMatch = lower.match(/^(\d+)[ya]$/); // 'y' or 'a'
        if (yearsMatch) return { isRelative: true, value: parseInt(yearsMatch[1]), unit: 'years' };

        // Absolute dates
        // Try ISO first
        let parsed = parseISO(input);
        if (isValid(parsed)) return { date: parsed };

        // Try yyyy-MM-dd
        parsed = parse(input, 'yyyy-MM-dd', new Date());
        if (isValid(parsed)) return { date: parsed };

        return {};
    };

    const handleApply = () => {
        const from = parseInput(inputFrom);
        const to = parseInput(inputTo);

        // Case 1: Relative range
        if (from.isRelative && from.value && from.unit && to.keyword) {
            onUpdate({
                config: {
                    ...widget.config,
                    dateRange: {
                        type: 'relative',
                        value: from.value,
                        unit: from.unit as RangeUnit,
                        anchor: to.keyword === 'selection' ? 'selected_date' : 'today'
                    }
                }
            });
            setIsOpen(false);
            return;
        }

        // Case 2: Keywords
        if (from.keyword === 'selection' && to.keyword === 'selection') {
            onUpdate({
                config: {
                    ...widget.config,
                    dateRange: { type: 'selected_day' }
                }
            });
            setIsOpen(false);
            return;
        }

        // Case 3: Absolute dates
        let startDate = from.date;
        const endDate = to.date;

        // Resolve relative start date if end date is known
        if (from.isRelative && from.value && from.unit && endDate) {
            if (from.unit === 'days') startDate = subDays(endDate, from.value);
            else if (from.unit === 'hours') startDate = subHours(endDate, from.value);
            else if (from.unit === 'minutes') startDate = subMinutes(endDate, from.value);
            else if (from.unit === 'years') startDate = subYears(endDate, from.value);
        }

        if (startDate) {
            onUpdate({
                config: {
                    ...widget.config,
                    dateRange: {
                        type: 'custom',
                        startDate: format(startDate, 'yyyy-MM-dd'), // Store date only
                        endDate: endDate ? format(endDate, 'yyyy-MM-dd') : undefined
                    }
                }
            });
            setIsOpen(false);
        }
    };

    const handlePreset = (type: RangeType, value?: number, unit?: RangeUnit, anchor?: RangeAnchor) => {
        onUpdate({
            config: {
                ...widget.config,
                dateRange: {
                    type,
                    value,
                    unit,
                    anchor
                }
            }
        });
        setIsOpen(false);
    };

    const effectiveIsLocked = isLocked || isIntradayKey(widget.config.dataKey || widget.config.dataKeys?.[0] || '');

    const unitWord = (unit: string | undefined, value: number | undefined): string => {
        const plural = (value ?? 0) !== 1;
        switch (unit) {
            case 'hours': return plural ? 'hours' : 'hour';
            case 'minutes': return plural ? 'minutes' : 'minute';
            case 'weeks': return plural ? 'weeks' : 'week';
            case 'months': return plural ? 'months' : 'month';
            case 'years': return plural ? 'years' : 'year';
            default: return plural ? 'days' : 'day';
        }
    };

    /** Short pill label; the popover spells the range out in full. */
    const getLabel = () => {
        if (effectiveIsLocked) return format(selectedDate, 'd MMM yyyy');
        const { type, value, unit, anchor, startDate: from, endDate: to } = widget.config.dateRange || {};
        if (type === 'selected_day') return format(selectedDate, 'd MMM yyyy');
        if (type === 'relative') {
            const span = `${value} ${unitWord(unit, value)}`;
            return anchor === 'selected_date' ? `${span} to ${format(selectedDate, 'd MMM')}` : `Last ${span}`;
        }
        if (type === 'last_30') return 'Last 30 days';
        if (type === 'last_90') return 'Last 90 days';
        if (type === 'all') return 'All time';
        if (type === 'custom') {
            const fromDate = from ? parseISO(from) : undefined;
            const toDate = to ? parseISO(to) : undefined;
            if (fromDate && isValid(fromDate)) {
                return `${format(fromDate, 'd MMM')} – ${toDate && isValid(toDate) ? format(toDate, 'd MMM') : 'today'}`;
            }
            return 'Custom range';
        }
        return 'Last 7 days';
    };

    const triggerClass = "h-7 min-w-0 max-w-[180px] gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground relative z-[70]";

    if (effectiveIsLocked) {
        return (
            <Popover>
                <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className={triggerClass} aria-label={`Locked to ${format(selectedDate, 'd MMM yyyy')}`}>
                        <Lock className="h-3 w-3" aria-hidden="true" />
                        <span className="truncate">{format(selectedDate, 'd MMM yyyy')}</span>
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2.5 text-xs text-muted-foreground" align="end">
                    This widget always shows the selected day.
                </PopoverContent>
            </Popover>
        );
    }

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className={triggerClass} aria-label={`Date range: ${getLabel()}`}>
                    <CalendarIcon className="h-3 w-3" aria-hidden="true" />
                    <span className="truncate">{getLabel()}</span>
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
                <div className="flex h-[380px]">
                    {/* Quick Ranges Column */}
                    <div className="flex w-[190px] flex-col gap-0.5 overflow-y-auto border-r p-2">
                        <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Relative to selected day
                        </div>
                        <Button variant="ghost" size="sm" className="h-8 justify-start font-normal"
                            onClick={() => handlePreset('selected_day')}>
                            Selected day only
                        </Button>
                        <Button variant="ghost" size="sm" className="h-8 justify-start font-normal"
                            onClick={() => handlePreset('relative', 7, 'days', 'selected_date')}>
                            7 days to selected day
                        </Button>
                        <Button variant="ghost" size="sm" className="h-8 justify-start font-normal"
                            onClick={() => handlePreset('relative', 30, 'days', 'selected_date')}>
                            30 days to selected day
                        </Button>
                        <Button variant="ghost" size="sm" className="h-8 justify-start font-normal"
                            onClick={() => handlePreset('relative', 90, 'days', 'selected_date')}>
                            90 days to selected day
                        </Button>

                        <div className="mt-2 px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Relative to today
                        </div>
                        <Button variant="ghost" size="sm" className="h-8 justify-start font-normal"
                            onClick={() => handlePreset('last_30')}>
                            30 days to today
                        </Button>
                        <Button variant="ghost" size="sm" className="h-8 justify-start font-normal"
                            onClick={() => handlePreset('last_90')}>
                            90 days to today
                        </Button>
                        <Button variant="ghost" size="sm" className="h-8 justify-start font-normal"
                            onClick={() => handlePreset('all')}>
                            All time
                        </Button>
                    </div>

                    {/* Custom Range Column */}
                    <div className="flex w-[300px] flex-col">
                        <div className="border-b p-3">
                            <div className="mb-2 text-sm font-medium">Custom range</div>
                            <div className="flex items-end gap-2">
                                <div className="flex-1 space-y-1">
                                    <label htmlFor="range-from" className="text-xs text-muted-foreground">From</label>
                                    <Input
                                        id="range-from"
                                        className="h-8 text-xs"
                                        value={inputFrom}
                                        onChange={(e) => setInputFrom(e.target.value)}
                                        placeholder="e.g. 30d, 2024-04-01"
                                    />
                                </div>
                                <ArrowRight className="mb-2.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                                <div className="flex-1 space-y-1">
                                    <label htmlFor="range-to" className="text-xs text-muted-foreground">To</label>
                                    <Input
                                        id="range-to"
                                        className="h-8 text-xs"
                                        value={inputTo}
                                        onChange={(e) => setInputTo(e.target.value)}
                                        placeholder="e.g. today, selection"
                                    />
                                </div>
                            </div>
                            <Button size="sm" className="mt-3 w-full" onClick={handleApply}>
                                Apply
                            </Button>
                        </div>
                        <div className="flex-1 overflow-auto p-2">
                            <Calendar
                                mode="range"
                                selected={tempRange}
                                onSelect={(range) => {
                                    setTempRange(range);
                                    if (range?.from) setInputFrom(format(range.from, 'yyyy-MM-dd'));
                                    if (range?.to) setInputTo(format(range.to, 'yyyy-MM-dd'));
                                    else setInputTo("");
                                }}
                                initialFocus
                                className="w-full rounded-md border-0 shadow-none"
                            />
                        </div>
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}
