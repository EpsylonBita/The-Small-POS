import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../utils/cn';

/**
 * Founder 01/11 («τα αναδυόμενα που δείχνουν επιλογή ημερομηνίας είναι τα παλιά στυλ Windows XP, θέλω να
 * τα κάνεις μοντέρνα όλα»): the kit date / time field that replaces the native <input type="date|time|
 * datetime-local"> everywhere in the till. Same value formats and the same onChange(event) shape as the
 * native input, so a call site swaps the tag only:
 * - date            'YYYY-MM-DD'
 * - time            'HH:mm'
 * - datetime-local  'YYYY-MM-DDTHH:mm'
 *
 * The picker opens in the top layer (the Popover API, the field is its invoker), so no window or scroll
 * area clips it; a touch outside, a second touch on the field or Escape closes it. It is anchored under the
 * field in CSS (.kit-date-picker in glassmorphism.css) and flips above near the bottom of the screen.
 * Kit look: solid surface, 44 px cells, the chosen day in the kit selection yellow, today ringed. Without
 * the Popover API (tests) it renders as a plain panel under the field.
 */
export type KitDateFieldType = 'date' | 'time' | 'datetime-local';

type ValueEvent = { target: { value: string }; currentTarget: { value: string } };

export interface KitDateFieldProps {
    type?: KitDateFieldType;
    value: string;
    onChange?: (event: ValueEvent) => void;
    onValueChange?: (value: string) => void;
    min?: string;
    max?: string;
    disabled?: boolean;
    required?: boolean;
    className?: string;
    id?: string;
    name?: string;
    placeholder?: string;
    'aria-label'?: string;
    'aria-describedby'?: string;
    'data-testid'?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function parseDate(value: string): { y: number; m: number; d: number } | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
    if (!match) return null;
    return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function parseTime(value: string): { h: number; min: number } | null {
    const match = /(?:^|T)(\d{2}):(\d{2})/.exec(value || '');
    if (!match) return null;
    return { h: Number(match[1]), min: Number(match[2]) };
}

const todayParts = () => {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), h: now.getHours(), min: now.getMinutes() };
};

const supportsPopover = () =>
    typeof HTMLElement !== 'undefined' && typeof (HTMLElement.prototype as { showPopover?: unknown }).showPopover === 'function';

const supportsAnchoring = () =>
    typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('position-area', 'bottom');

type PopoverElement = HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void };

const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const HOURS = Array.from({ length: 24 }, (_, i) => i);

export const KitDateField: React.FC<KitDateFieldProps> = ({
    type = 'date',
    value,
    onChange,
    onValueChange,
    min,
    max,
    disabled,
    required,
    className,
    id,
    name,
    placeholder,
    'aria-label': ariaLabel,
    'aria-describedby': ariaDescribedBy,
    'data-testid': testId,
}) => {
    const { t, i18n } = useTranslation();
    const locale = i18n?.language || 'el';
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const hasDate = type !== 'time';
    const hasTime = type !== 'date';
    const selectedDate = hasDate ? parseDate(value) : null;
    const selectedTime = hasTime ? parseTime(value) : null;
    const today = todayParts();
    const [view, setView] = useState(() => ({ y: selectedDate?.y ?? today.y, m: selectedDate?.m ?? today.m }));

    const emit = (next: string) => {
        onChange?.({ target: { value: next }, currentTarget: { value: next } });
        onValueChange?.(next);
    };

    const popover = useMemo(supportsPopover, []);
    const anchored = useMemo(() => popover && supportsAnchoring(), [popover]);
    const reactId = useId();
    const panelId = `kit-date-${reactId.replace(/[^A-Za-z0-9_-]/g, '')}`;
    const anchorStyle = { '--kit-date-anchor': `--${panelId}` } as React.CSSProperties;

    const resetView = () => setView({ y: selectedDate?.y ?? today.y, m: selectedDate?.m ?? today.m });

    const close = () => {
        const panel = panelRef.current as PopoverElement | null;
        try {
            if (panel?.matches?.(':popover-open')) panel.hidePopover?.();
        } catch {
            // Already closed.
        }
        setOpen(false);
        triggerRef.current?.focus();
    };

    // The browser opens and closes the popover (the field is its invoker); the content renders just before
    // it shows, so it never flashes empty.
    useEffect(() => {
        if (!popover) return undefined;
        const panel = panelRef.current;
        if (!panel) return undefined;
        const onBeforeToggle = (event: Event) => {
            if ((event as Event & { newState?: string }).newState !== 'open') return;
            flushSync(() => {
                resetView();
                setOpen(true);
            });
        };
        const onToggle = (event: Event) => {
            if ((event as Event & { newState?: string }).newState === 'closed') setOpen(false);
        };
        panel.addEventListener('beforetoggle', onBeforeToggle);
        panel.addEventListener('toggle', onToggle);
        return () => {
            panel.removeEventListener('beforetoggle', onBeforeToggle);
            panel.removeEventListener('toggle', onToggle);
        };
    });

    // Focus the chosen (or today's) cell; place the panel by hand only where CSS anchoring is missing.
    useLayoutEffect(() => {
        if (!open) return;
        const panel = panelRef.current;
        const trigger = triggerRef.current;
        if (!panel || !trigger) return;
        if (popover && !anchored) {
            const rect = trigger.getBoundingClientRect();
            const width = panel.offsetWidth;
            const height = panel.offsetHeight;
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
            const below = rect.bottom + 6;
            const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 6);
            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
        }
        panel.querySelector<HTMLButtonElement>('[data-kit-date-selected="true"], [data-kit-date-today="true"]')?.focus();
    }, [open, popover, anchored]);

    const display = useMemo(() => {
        const parts: string[] = [];
        if (selectedDate) {
            parts.push(
                new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(
                    new Date(selectedDate.y, selectedDate.m - 1, selectedDate.d),
                ),
            );
        }
        if (selectedTime) parts.push(`${pad(selectedTime.h)}:${pad(selectedTime.min)}`);
        return parts.join(' · ');
    }, [locale, selectedDate?.y, selectedDate?.m, selectedDate?.d, selectedTime?.h, selectedTime?.min]);

    const minDate = min ? parseDate(min) : null;
    const maxDate = max ? parseDate(max) : null;
    const minKey = minDate ? dateKey(minDate.y, minDate.m, minDate.d) : null;
    const maxKey = maxDate ? dateKey(maxDate.y, maxDate.m, maxDate.d) : null;

    const pickDate = (y: number, m: number, d: number) => {
        const datePart = dateKey(y, m, d);
        if (type === 'date') {
            emit(datePart);
            close();
            return;
        }
        const time = selectedTime ?? { h: today.h, min: 0 };
        emit(`${datePart}T${pad(time.h)}:${pad(time.min)}`);
    };

    const pickTime = (h: number, minute: number, done: boolean) => {
        const timePart = `${pad(h)}:${pad(minute)}`;
        if (type === 'time') emit(timePart);
        else {
            const date = selectedDate ?? today;
            emit(`${dateKey(date.y, date.m, date.d)}T${timePart}`);
        }
        if (done) close();
    };

    const weekdayNames = useMemo(() => {
        const format = new Intl.DateTimeFormat(locale, { weekday: 'short' });
        // 1 Jan 2024 was a Monday: the week starts on Monday.
        return Array.from({ length: 7 }, (_, i) => format.format(new Date(2024, 0, 1 + i)));
    }, [locale]);

    const monthTitle = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(view.y, view.m - 1, 1));

    const days = useMemo(() => {
        const first = new Date(view.y, view.m - 1, 1);
        const offset = (first.getDay() + 6) % 7;
        return Array.from({ length: 42 }, (_, i) => {
            const date = new Date(view.y, view.m - 1, 1 - offset + i);
            return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate(), inMonth: date.getMonth() === view.m - 1 };
        });
    }, [view.y, view.m]);

    const shiftMonth = (delta: number) =>
        setView((current) => {
            const date = new Date(current.y, current.m - 1 + delta, 1);
            return { y: date.getFullYear(), m: date.getMonth() + 1 };
        });

    // Without the Popover API the field toggles the panel itself.
    const togglePicker = () => {
        if (disabled) return;
        resetView();
        setOpen((current) => !current);
    };

    const minuteOptions = selectedTime && !MINUTES.includes(selectedTime.min)
        ? [...MINUTES, selectedTime.min].sort((a, b) => a - b)
        : MINUTES;

    const cell = 'flex h-11 min-w-11 items-center justify-center rounded-xl text-base font-semibold transition active:scale-[0.96]';

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                id={id}
                name={name}
                disabled={disabled}
                aria-label={ariaLabel}
                aria-describedby={ariaDescribedBy}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-required={required || undefined}
                data-testid={testId}
                data-kit-date-field={type}
                popoverTarget={popover ? panelId : undefined}
                onClick={popover ? undefined : togglePicker}
                style={anchored ? anchorStyle : undefined}
                className={cn('inline-flex items-center justify-between gap-2 disabled:cursor-not-allowed disabled:opacity-50', className)}
            >
                <span className={cn('min-w-0 truncate', !display && 'text-(--pos-s-muted)')}>
                    {display || placeholder || (type === 'time'
                        ? t('common.datePicker.selectTime', 'Select a time')
                        : t('common.datePicker.selectDate', 'Select a date'))}
                </span>
                {type === 'time'
                    ? <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-(--pos-s-muted)" />
                    : <CalendarDays aria-hidden="true" className="h-4 w-4 shrink-0 text-(--pos-s-muted)" />}
            </button>

            {(popover || open) && (
                <div
                    ref={panelRef}
                    id={panelId}
                    popover={popover ? 'auto' : undefined}
                    role="dialog"
                    aria-label={type === 'time' ? t('common.datePicker.selectTime', 'Select a time') : t('common.datePicker.selectDate', 'Select a date')}
                    data-testid="kit-date-picker"
                    style={anchored ? anchorStyle : undefined}
                    // A field inside a <label>: a touch on the panel's background must not re-click the field.
                    onClick={(event) => event.preventDefault()}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            event.stopPropagation();
                            close();
                        }
                    }}
                    className={cn(
                        'kit-date-picker z-[2147483600] rounded-2xl border border-(--pos-s-border) bg-(--pos-s-surface) p-3 text-(--pos-s-fg) shadow-2xl',
                        popover ? (anchored ? 'kit-date-picker--anchored' : 'fixed inset-auto m-0') : 'absolute m-0',
                        hasDate && hasTime ? 'w-[min(92vw,640px)]' : hasDate ? 'w-[min(92vw,340px)]' : 'w-[min(92vw,320px)]',
                    )}
                >
                    {open && (<>
                    <div className={cn('grid gap-4', hasDate && hasTime ? 'sm:grid-cols-[1fr_1fr]' : '')}>
                        {hasDate && (
                            <div>
                                <div className="mb-2 flex items-center justify-between gap-2">
                                    <button
                                        type="button"
                                        onClick={() => shiftMonth(-1)}
                                        data-kit-date-nav="prev"
                                        aria-label={t('common.datePicker.previousMonth', 'Previous month')}
                                        className="pos-icon-btn"
                                    >
                                        <ChevronLeft className="h-5 w-5" />
                                    </button>
                                    <span className="text-base font-semibold capitalize">{monthTitle}</span>
                                    <button
                                        type="button"
                                        onClick={() => shiftMonth(1)}
                                        data-kit-date-nav="next"
                                        aria-label={t('common.datePicker.nextMonth', 'Next month')}
                                        className="pos-icon-btn"
                                    >
                                        <ChevronRight className="h-5 w-5" />
                                    </button>
                                </div>
                                <div className="grid grid-cols-7 gap-1 text-center">
                                    {weekdayNames.map((name) => (
                                        <span key={name} className="py-1 text-xs font-semibold capitalize text-(--pos-s-muted)">{name}</span>
                                    ))}
                                    {days.map((day) => {
                                        const key = dateKey(day.y, day.m, day.d);
                                        const isSelected = !!selectedDate && key === dateKey(selectedDate.y, selectedDate.m, selectedDate.d);
                                        const isToday = key === dateKey(today.y, today.m, today.d);
                                        const outOfRange = (minKey !== null && key < minKey) || (maxKey !== null && key > maxKey);
                                        return (
                                            <button
                                                key={key}
                                                type="button"
                                                disabled={outOfRange}
                                                onClick={() => pickDate(day.y, day.m, day.d)}
                                                aria-pressed={isSelected}
                                                aria-label={new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(new Date(day.y, day.m - 1, day.d))}
                                                data-kit-date-day={key}
                                                data-kit-date-selected={isSelected || undefined}
                                                data-kit-date-today={isToday || undefined}
                                                className={cn(
                                                    cell,
                                                    isSelected
                                                        ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg)'
                                                        : day.inMonth
                                                            ? 'text-(--pos-s-fg) active:bg-(--pos-s-surface-2)'
                                                            : 'text-(--pos-s-muted) opacity-60 active:bg-(--pos-s-surface-2)',
                                                    isToday && !isSelected && 'ring-1 ring-inset ring-(--pos-s-fg)',
                                                    'disabled:cursor-not-allowed disabled:opacity-30',
                                                )}
                                            >
                                                {day.d}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {hasTime && (
                            <div className="space-y-3">
                                <div>
                                    <div className="mb-1 text-sm font-semibold text-(--pos-s-muted)">{t('common.datePicker.hours', 'Hours')}</div>
                                    <div className="grid grid-cols-6 gap-1">
                                        {HOURS.map((hour) => {
                                            const isSelected = selectedTime?.h === hour;
                                            return (
                                                <button
                                                    key={hour}
                                                    type="button"
                                                    aria-pressed={isSelected}
                                                    data-kit-date-selected={isSelected || undefined}
                                                    onClick={() => pickTime(hour, selectedTime?.min ?? 0, false)}
                                                    className={cn(cell, isSelected ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg)' : 'active:bg-(--pos-s-surface-2)')}
                                                >
                                                    {pad(hour)}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                                <div>
                                    <div className="mb-1 text-sm font-semibold text-(--pos-s-muted)">{t('common.datePicker.minutes', 'Minutes')}</div>
                                    <div className="grid grid-cols-6 gap-1">
                                        {minuteOptions.map((minute) => {
                                            const isSelected = selectedTime?.min === minute;
                                            return (
                                                <button
                                                    key={minute}
                                                    type="button"
                                                    aria-pressed={isSelected}
                                                    onClick={() => pickTime(selectedTime?.h ?? today.h, minute, true)}
                                                    className={cn(cell, isSelected ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg)' : 'active:bg-(--pos-s-surface-2)')}
                                                >
                                                    {pad(minute)}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-(--pos-s-border) pt-3">
                        {hasDate ? (
                            <button
                                type="button"
                                onClick={() => {
                                    if (type === 'date') {
                                        emit(dateKey(today.y, today.m, today.d));
                                        close();
                                    } else {
                                        pickDate(today.y, today.m, today.d);
                                        setView({ y: today.y, m: today.m });
                                    }
                                }}
                                className="pos-solid-btn pos-solid-btn--sm"
                            >
                                {t('common.datePicker.today', 'Today')}
                            </button>
                        ) : <span />}
                        <div className="flex gap-2">
                            {!required && value ? (
                                <button
                                    type="button"
                                    onClick={() => {
                                        emit('');
                                        close();
                                    }}
                                    className="pos-solid-btn pos-solid-btn--sm"
                                >
                                    {t('common.clear', 'Clear')}
                                </button>
                            ) : null}
                            <button type="button" onClick={close} className="pos-solid-btn pos-solid-btn--sm pos-solid-btn--primary">
                                {t('common.close', 'Close')}
                            </button>
                        </div>
                    </div>
                    </>)}
                </div>
            )}
        </>
    );
};

export default KitDateField;
