/**
 * ReservationForm Component
 * 
 * Form for creating new reservations with customer details and table assignment.
 * 
 * Requirements:
 * - 4.1: Require customer name, phone number, reservation time, and number of guests
 * - 4.2: Validate that selected table has sufficient capacity for party size
 * 
 * **Feature: pos-tables-reservations-sync, Property 4: Reservation Capacity Validation**
 * **Validates: Requirements 4.2**
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import React, { memo, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useI18n } from '../../contexts/i18n-context';
import type { RestaurantTable } from '../../types/tables';
import { reservationsService, type Reservation } from '../../services/ReservationsService';
import { useSystemClock } from '../../hooks/useSystemClock';
import { parseLocalDateString, toLocalDateString } from '../../utils/date';
import { renderModalPortal } from '../../utils/render-modal-portal';
import { formatTableDisplayNumber } from '../../utils/table-display';
import { formatDate, formatTime } from '../../utils/format';
import {
  resolveReservationStart,
  selectUpcomingTableReservations,
} from '../../utils/reservationFormWarnings';
import { buildReservationDays, buildReservationSlots } from '../../utils/reservationAvailability';
import { X, Calendar, Clock, Users, Phone, User, MessageSquare, AlertCircle, AlertTriangle, Minus, Plus } from 'lucide-react';
import { KitDateField } from '../ui/KitDateField';

export interface CreateReservationDto {
  customerName: string;
  customerPhone: string;
  reservationTime: Date;
  partySize: number;
  specialRequests?: string;
  tableId: string;
}

export interface ReservationFormProps {
  tableId: string;
  tableCapacity: number;
  tableNumber: string | number;
  initialReservation?: Reservation | null;
  onSubmit: (data: CreateReservationDto) => Promise<void>;
  onCancel: () => void;
  isOpen: boolean;
}

export interface ReservationFormErrors {
  customerName?: string;
  customerPhone?: string;
  reservationDate?: string;
  reservationTime?: string;
  partySize?: string;
}

/**
 * Validates that party size does not exceed table capacity
 * 
 * **Feature: pos-tables-reservations-sync, Property 4: Reservation Capacity Validation**
 * **Validates: Requirements 4.2**
 * 
 * @param partySize - Number of guests
 * @param tableCapacity - Maximum capacity of the table
 * @returns true if valid, false if party size exceeds capacity
 */
export function validateCapacity(partySize: number, tableCapacity: number): boolean {
  return partySize > 0 && partySize <= tableCapacity;
}

/**
 * Validates phone number format (basic validation)
 * @param phone - Phone number string
 * @returns true if valid format
 */
export function validatePhone(phone: string): boolean {
  // Allow digits, spaces, dashes, plus, and parentheses
  const phoneRegex = /^[\d\s\-\+\(\)]{7,20}$/;
  return phoneRegex.test(phone.trim());
}

/**
 * ReservationForm - Form for creating new reservations
 * 
 * Collects customer information and validates against table capacity.
 */
export const ReservationForm: React.FC<ReservationFormProps> = memo(({
  tableId,
  tableCapacity,
  tableNumber,
  initialReservation = null,
  onSubmit,
  onCancel,
  isOpen
}) => {
  const { t } = useI18n();
  const now = useSystemClock();
  const nowRef = useRef(now);
  nowRef.current = now;
  const isEditing = Boolean(initialReservation);

  // Form state
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [reservationDate, setReservationDate] = useState('');
  const [reservationTime, setReservationTime] = useState('');
  const [partySize, setPartySize] = useState(2);
  const [specialRequests, setSpecialRequests] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<ReservationFormErrors>({});
  
  // Conflict checking state
  const [conflictingReservations, setConflictingReservations] = useState<Reservation[]>([]);
  const [isCheckingConflicts, setIsCheckingConflicts] = useState(false);
  const [showConflictWarning, setShowConflictWarning] = useState(false);
  const [existingReservations, setExistingReservations] = useState<Reservation[]>([]);

  // Load existing reservations for this table on mount (kept raw; the displayed
  // warning derives the relevant upcoming subset below).
  useEffect(() => {
    if (isOpen && tableId) {
      reservationsService.getReservationsForTable(tableId).then((reservations) => {
        setExistingReservations(reservations);
      });
    }
  }, [isOpen, tableId]);

  // Only warn about reservations that are still relevant (today or future),
  // excluding the one being edited - never stale past pending/confirmed rows.
  const upcomingReservations = useMemo(
    () =>
      selectUpcomingTableReservations(existingReservations, {
        now,
        excludeId: initialReservation?.id ?? null,
      }),
    [existingReservations, now, initialReservation?.id],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (initialReservation) {
      setCustomerName(initialReservation.customerName || '');
      setCustomerPhone(initialReservation.customerPhone || '');
      setReservationDate(
        initialReservation.reservationDate ||
          toLocalDateString(new Date(initialReservation.reservationDatetime)),
      );
      setReservationTime(String(initialReservation.reservationTime || '').slice(0, 5));
      setPartySize(Math.max(1, Number(initialReservation.partySize || 1)));
      setSpecialRequests(initialReservation.specialRequests || '');
      setErrors({});
      return;
    }

    setCustomerName('');
    setCustomerPhone('');
    // Today is the usual answer, and its times with the table's availability show at once.
    setReservationDate(toLocalDateString(nowRef.current));
    setReservationTime('');
    setPartySize(Math.max(1, Math.min(2, tableCapacity || 2)));
    setSpecialRequests('');
    setErrors({});
  }, [
    isOpen,
    initialReservation,
    tableCapacity,
  ]);

  // Check for conflicts when date/time changes
  useEffect(() => {
    if (reservationDate && reservationTime && tableId) {
      setIsCheckingConflicts(true);
      reservationsService.checkReservationConflicts(tableId, reservationDate, reservationTime)
        .then((conflicts) => {
          const activeConflicts = conflicts.filter(
            (reservation) => reservation.id !== initialReservation?.id,
          );
          setConflictingReservations(activeConflicts);
          setShowConflictWarning(activeConflicts.length > 0);
        })
        .finally(() => setIsCheckingConflicts(false));
    } else {
      setConflictingReservations([]);
      setShowConflictWarning(false);
    }
  }, [reservationDate, reservationTime, tableId, initialReservation?.id]);

  // The table's own availability for the day strip and the time grid (founder 11/11/2026).
  // Presentation only: the conflict check above and the server stay authoritative.
  const reservationDays = useMemo(
    () => buildReservationDays({ reservations: existingReservations, now, excludeId: initialReservation?.id ?? null }),
    [existingReservations, now, initialReservation?.id],
  );
  const reservationSlots = useMemo(
    () => buildReservationSlots({
      date: reservationDate,
      reservations: existingReservations,
      now,
      excludeId: initialReservation?.id ?? null,
    }),
    [reservationDate, existingReservations, now, initialReservation?.id],
  );

  // Get minimum date (today)
  const todayDate = toLocalDateString(now);
  const minDate = isEditing && reservationDate && reservationDate < todayDate
    ? reservationDate
    : todayDate;

  // Validate form
  const validateForm = useCallback((): boolean => {
    const newErrors: ReservationFormErrors = {};

    // Customer name is required (Requirements 4.1)
    if (!customerName.trim()) {
      newErrors.customerName = t('reservationForm.errors.nameRequired', { 
        defaultValue: 'Customer name is required' 
      });
    }

    // Phone number is required and must be valid (Requirements 4.1)
    if (!customerPhone.trim()) {
      newErrors.customerPhone = t('reservationForm.errors.phoneRequired', { 
        defaultValue: 'Phone number is required' 
      });
    } else if (!validatePhone(customerPhone)) {
      newErrors.customerPhone = t('reservationForm.errors.phoneInvalid', { 
        defaultValue: 'Please enter a valid phone number' 
      });
    }

    // Reservation date is required (Requirements 4.1)
    if (!reservationDate) {
      newErrors.reservationDate = t('reservationForm.errors.dateRequired', { 
        defaultValue: 'Reservation date is required' 
      });
    }

    // Reservation time is required (Requirements 4.1)
    if (!reservationTime) {
      newErrors.reservationTime = t('reservationForm.errors.timeRequired', { 
        defaultValue: 'Reservation time is required' 
      });
    }

    // Party size must be valid and within capacity (Requirements 4.1, 4.2)
    if (partySize < 1) {
      newErrors.partySize = t('reservationForm.errors.partySizeMin', { 
        defaultValue: 'Party size must be at least 1' 
      });
    } else if (!validateCapacity(partySize, tableCapacity)) {
      newErrors.partySize = t('reservationForm.errors.partySizeExceedsCapacity', { 
        defaultValue: 'Party size exceeds table capacity of {{capacity}}',
        capacity: tableCapacity
      });
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [customerName, customerPhone, reservationDate, reservationTime, partySize, tableCapacity, t]);

  // Clear a single field's validation error as soon as the user edits it, so a
  // required-field error does not stay active after a value has been entered.
  const clearFieldError = useCallback((field: keyof ReservationFormErrors) => {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }, []);

  // Another day has other times: a time of the grid that is gone or reserved there is dropped,
  // a typed time is kept (the conflict check speaks for it).
  const selectReservationDay = useCallback((date: string) => {
    setReservationDate(date);
    clearFieldError('reservationDate');
    setReservationTime((current) => {
      if (!current || !/^\d{2}:(00|30)$/.test(current)) return current;
      const slot = buildReservationSlots({
        date,
        reservations: existingReservations,
        now: nowRef.current,
        excludeId: initialReservation?.id ?? null,
      }).find((candidate) => candidate.time === current);
      return slot?.state === 'free' ? current : '';
    });
  }, [clearFieldError, existingReservations, initialReservation?.id]);

  // Handle form submission
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);

    try {
      // Combine date and time into a Date object
      const reservationDateTime = new Date(`${reservationDate}T${reservationTime}`);

      await onSubmit({
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        reservationTime: reservationDateTime,
        partySize,
        specialRequests: specialRequests.trim(),
        tableId,
      });
    } catch (error) {
      console.error(isEditing ? 'Failed to update reservation:' : 'Failed to create reservation:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [validateForm, customerName, customerPhone, reservationDate, reservationTime, partySize, specialRequests, tableId, onSubmit]);

  // Reset form
  const resetForm = useCallback(() => {
    setCustomerName('');
    setCustomerPhone('');
    setReservationDate('');
    setReservationTime('');
    setPartySize(2);
    setSpecialRequests('');
    setErrors({});
  }, []);

  // Handle cancel
  const dialogRef = useRef<HTMLDivElement>(null);

  const handleCancel = useCallback(() => {
    resetForm();
    onCancel();
  }, [resetForm, onCancel]);

  // Escape closes the reservation form, matching the rest of the app-level POS modals.
  // Only the topmost [role="dialog"] responds, so a dialog opened above this form closes
  // first and an underlying modal (e.g. TableActionModal) is never dismissed instead.
  // This routes through handleCancel (reset + onCancel) and never submits/creates.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== dialogRef.current) {
        return;
      }
      event.preventDefault();
      handleCancel();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, handleCancel]);

  // Customer, day and time are on screen from the start; the notes reveal once a day and a time
  // are set, and everything shows for edits and validation failures (founder 11/11/2026).
  const reduceMotion = useReducedMotion();
  const showAllStages = isEditing || Object.values(errors).some(Boolean);
  const showNotesStage = showAllStages || Boolean(reservationDate && reservationTime);
  const notesStageRef = useRef<HTMLDivElement>(null);
  const previousNotesStage = useRef(showNotesStage);
  useEffect(() => {
    if (!isOpen) {
      previousNotesStage.current = showNotesStage;
      return;
    }
    const revealed = showNotesStage && !previousNotesStage.current;
    previousNotesStage.current = showNotesStage;
    if (showAllStages || !revealed) return;
    const timer = window.setTimeout(() => notesStageRef.current?.scrollIntoView(
      { block: 'nearest', behavior: reduceMotion ? 'instant' : 'smooth' },
    ), reduceMotion ? 0 : 240);
    return () => window.clearTimeout(timer);
  }, [isOpen, showAllStages, showNotesStage, reduceMotion]);
  const revealMotion = {
    initial: reduceMotion || showAllStages ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion || showAllStages ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion || showAllStages ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion || showAllStages ? 0 : 0.24, duration: 0 } },
  };

  if (!isOpen) return null;

  // Check if party size exceeds capacity for warning display
  const capacityWarning = partySize > tableCapacity;

  return renderModalPortal(
    <div className="fixed inset-0 z-1200 flex items-start justify-center px-3 pb-3 pt-[4vh] sm:px-6 sm:pb-6">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-(--modal-backdrop) backdrop-blur-xl"
        onClick={handleCancel}
      />

      {/* Modal -- shared liquid-glass shell so the reservation form matches the TableSelector /
          TableActionModal / Settings glass modals: premium blurred translucent glass, 28px rounded
          corners, soft edge/glow, shared open animation. Portal/z-[1200]/Escape behaviour is unchanged. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reservation-form-title"
        data-reservation-form
        className="liquid-glass-modal-shell relative flex w-full max-w-3xl max-h-full flex-col"
      >
        {/* Header (shared glass header/title/close tokens; lucide X, labelled close) */}
        <div className="liquid-glass-modal-header pos-glass-header--plain">
          <div>
            <h2 id="reservation-form-title" className="liquid-glass-modal-title">
              {isEditing
                ? t('reservationForm.editTitle', { defaultValue: 'Edit Reservation' })
                : t('reservationForm.title', { defaultValue: 'New Reservation' })}
            </h2>
            <p className="mt-1 text-sm liquid-glass-modal-text-muted">
              {t('reservationForm.subtitle', {
                // Same shared display label as the dashboard/TableActionModal
                // (e.g. "#TP01"). The locale string no longer adds its own "#".
                tableNumber: formatTableDisplayNumber(tableNumber),
                capacity: tableCapacity,
                guests: t('reservationForm.guests', { count: tableCapacity }),
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="liquid-glass-modal-close active:scale-95"
            aria-label={t('common.actions.close', { defaultValue: 'Close' })}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          {/* Scrollable body (glass content, hidden scrollbar) keeps header/footer from clipping */}
          <div className="liquid-glass-modal-content scrollbar-hide pos-progressive-form flex-1 min-h-0 overflow-y-auto space-y-4">
            {/* Who: one frosted card (founder redesign, 11/11/2026) */}
            <div className="pos-glass-form-card grid gap-3 sm:grid-cols-2">
              <h3 className="sm:col-span-2 text-xs font-semibold liquid-glass-modal-text-muted">
                {t('appointments.modal.customer', { defaultValue: 'Customer' })}
              </h3>
              {/* Customer Name - Required (Requirements 4.1) */}
              <div>
                <label htmlFor="reservation-customer-name" className="mb-1.5 block text-xs font-semibold liquid-glass-modal-text">
                  <User className="w-4 h-4 inline mr-1" />
                  {t('reservationForm.customerName', { defaultValue: 'Customer Name' })} *
                </label>
                <input
                  id="reservation-customer-name"
                  type="text"
                  value={customerName}
                  onChange={(e) => { setCustomerName(e.target.value); clearFieldError('customerName'); }}
                  placeholder={t('reservationForm.customerNamePlaceholder', { defaultValue: 'Enter customer name' })}
                  className={`liquid-glass-modal-input pos-glass-field min-h-touch min-w-0 w-full ${errors.customerName ? 'border-red-500!' : ''}`}
                />
                {errors.customerName && (
                  <p className="mt-1 text-sm text-red-500 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {errors.customerName}
                  </p>
                )}
              </div>

              {/* Phone Number - Required (Requirements 4.1) */}
              <div>
                <label htmlFor="reservation-customer-phone" className="mb-1.5 block text-xs font-semibold liquid-glass-modal-text">
                  <Phone className="w-4 h-4 inline mr-1" />
                  {t('reservationForm.phone', { defaultValue: 'Phone Number' })} *
                </label>
                <input
                  id="reservation-customer-phone"
                  type="tel"
                  value={customerPhone}
                  onChange={(e) => { setCustomerPhone(e.target.value); clearFieldError('customerPhone'); }}
                  placeholder={t('reservationForm.phonePlaceholder', { defaultValue: '+30 XXX XXX XXXX' })}
                  className={`liquid-glass-modal-input pos-glass-field min-h-touch min-w-0 w-full ${errors.customerPhone ? 'border-red-500!' : ''}`}
                />
                {errors.customerPhone && (
                  <p className="mt-1 text-sm text-red-500 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {errors.customerPhone}
                  </p>
                )}
              </div>

            </div>

            {/* When and how many: one frosted card, on screen from the start with the table's own
                availability (founder 11/11/2026: the window showed no date, availability or time
                until a name and a phone were typed). */}
            <div data-reservation-stage="2">
              <div className="pos-glass-form-card space-y-4">
                {/* Day: today and the next days at a tap, any other day in the field. */}
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="reservation-date" className="block text-xs font-semibold liquid-glass-modal-text">
                      <Calendar className="w-4 h-4 inline mr-1" />
                      {t('reservationForm.date', { defaultValue: 'Date' })} *
                    </label>
                    <KitDateField
                      id="reservation-date"
                      type="date" required
                      value={reservationDate}
                      onChange={(e) => selectReservationDay(e.target.value)}
                      min={minDate}
                      className={`liquid-glass-modal-input pos-glass-field min-h-touch min-w-0 w-44 ${errors.reservationDate ? 'border-red-500!' : ''}`}
                    />
                  </div>
                  <div
                    role="group"
                    aria-label={t('reservationForm.dayStrip', { defaultValue: 'Next days' })}
                    data-reservation-days
                    className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 scrollbar-hide"
                  >
                    {reservationDays.map((day, index) => {
                      const date = parseLocalDateString(day.date);
                      const selected = reservationDate === day.date;
                      const dayState = day.slots === 0 ? 'over' : day.free === 0 ? 'full' : day.reserved > 0 ? 'some' : 'free';
                      return (
                        <button
                          key={day.date}
                          type="button"
                          aria-pressed={selected}
                          data-reservation-day={day.date}
                          data-day-state={dayState}
                          onClick={() => selectReservationDay(day.date)}
                          className={`flex min-h-touch min-w-[5.25rem] shrink-0 flex-col items-center justify-center rounded-xl border px-2 py-1.5 text-center transition active:scale-95 ${selected
                            ? 'border-(--pos-s-sel-bg) bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg)'
                            : 'pos-glass-field'}`}
                        >
                          <span className="text-[11px] font-medium leading-tight">
                            {index === 0
                              ? t('reservationForm.today', { defaultValue: 'Today' })
                              : index === 1
                                ? t('reservationForm.tomorrow', { defaultValue: 'Tomorrow' })
                                : formatDate(date, { weekday: 'short' })}
                          </span>
                          <span className="text-sm font-semibold leading-tight">
                            {formatDate(date, { day: 'numeric', month: 'short' })}
                          </span>
                          {/* Colour only on the state word; the selected day keeps the selection colours. */}
                          <span
                            className={`mt-0.5 text-[11px] leading-tight ${selected
                              ? ''
                              : dayState === 'full'
                                ? 'text-rose-600 dark:text-rose-400'
                                : dayState === 'some'
                                  ? 'text-amber-700 dark:text-amber-300'
                                  : dayState === 'free'
                                    ? 'text-emerald-700 dark:text-emerald-400'
                                    : 'liquid-glass-modal-text-muted'}`}
                          >
                            {dayState === 'over'
                              ? '-'
                              : dayState === 'full'
                                ? t('reservationForm.dayFull', { defaultValue: 'Full' })
                                : dayState === 'some'
                                  ? t('reservationForm.dayReserved', { count: day.reserved, defaultValue: '{{count}} reserved' })
                                  : t('reservationForm.dayFree', { defaultValue: 'Free' })}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {errors.reservationDate && (
                    <p className="mt-1 text-sm text-red-500 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {errors.reservationDate}
                    </p>
                  )}
                </div>

                {/* Time: the day's times with what the table already has; any other time in the field. */}
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="reservation-time" className="block text-xs font-semibold liquid-glass-modal-text">
                      <Clock className="w-4 h-4 inline mr-1" />
                      {t('reservationForm.time', { defaultValue: 'Time' })} *
                    </label>
                    <KitDateField
                      id="reservation-time"
                      type="time" required
                      value={reservationTime}
                      onChange={(e) => { setReservationTime(e.target.value); clearFieldError('reservationTime'); }}
                      className={`liquid-glass-modal-input pos-glass-field min-h-touch min-w-0 w-44 ${errors.reservationTime ? 'border-red-500!' : ''}`}
                    />
                  </div>
                  {!reservationDate ? (
                    <p className="py-3 text-center text-sm liquid-glass-modal-text-muted">
                      {t('reservationForm.pickDay', { defaultValue: 'Pick a day to see the times' })}
                    </p>
                  ) : reservationSlots.length === 0 ? (
                    <p className="py-3 text-center text-sm liquid-glass-modal-text-muted">
                      {t('reservationForm.noTimesLeft', { defaultValue: 'No times are left for this day. Pick another day or type a time.' })}
                    </p>
                  ) : (
                    <motion.div
                      key={reservationDate}
                      data-reservation-slots
                      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                      className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8"
                    >
                      {reservationSlots.map((slot) => {
                        const selected = reservationTime === slot.time;
                        const taken = slot.state === 'taken';
                        return (
                          <button
                            key={slot.time}
                            type="button"
                            aria-pressed={selected}
                            disabled={taken && !selected}
                            data-slot-state={slot.state}
                            aria-label={taken
                              ? `${slot.time} ${t('reservationForm.slotTaken', { defaultValue: 'Reserved' })}`
                              : undefined}
                            onClick={() => { setReservationTime(slot.time); clearFieldError('reservationTime'); }}
                            className={`relative flex min-h-touch items-center justify-center rounded-xl border px-2 py-2 text-sm tabular-nums transition active:scale-95 ${selected
                              ? 'border-(--pos-s-sel-bg) bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg)'
                              : taken
                                ? 'border-transparent bg-transparent text-red-700 dark:text-red-300 line-through cursor-not-allowed opacity-70'
                                : 'pos-glass-field'}`}
                          >
                            {slot.time}
                            {taken && <span aria-hidden="true" className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-red-500" />}
                          </button>
                        );
                      })}
                    </motion.div>
                  )}
                  {reservationDate && reservationSlots.length > 0 && (
                    <div className="mt-2 flex items-center gap-3 text-[11px] leading-none liquid-glass-modal-text-muted">
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="h-2 w-2 rounded-full border border-(--field-glass-border) bg-(--field-glass)" />
                        {t('reservationForm.slotFree', { defaultValue: 'Free' })}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-red-500" />
                        {t('reservationForm.slotTaken', { defaultValue: 'Reserved' })}
                      </span>
                    </div>
                  )}
                  {errors.reservationTime && (
                    <p className="mt-1 text-sm text-red-500 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {errors.reservationTime}
                    </p>
                  )}
                </div>

                {/* Party Size - Required (Requirements 4.1, 4.2) */}
                <div>
                  <label htmlFor="reservation-guests" className="mb-1.5 block text-xs font-semibold liquid-glass-modal-text">
                    <Users className="w-4 h-4 inline mr-1" />
                    {t('reservationForm.partySize', { defaultValue: 'Number of Guests' })} *
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPartySize(Math.max(1, partySize - 1));
                        clearFieldError('partySize');
                      }}
                      className="pos-glass-field inline-flex h-11 w-11 items-center justify-center transition active:scale-95"
                      aria-label={t('reservationForm.decreaseGuests', { defaultValue: 'Decrease guests' })}
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <input
                      id="reservation-guests"
                      type="number"
                      value={partySize}
                      onChange={(e) => { setPartySize(Math.max(1, parseInt(e.target.value) || 1)); clearFieldError('partySize'); }}
                      min={1}
                      aria-label={t('reservationForm.partySize', { defaultValue: 'Number of Guests' })}
                      className={`liquid-glass-modal-input pos-glass-field min-h-touch min-w-0 w-20 text-center ${errors.partySize || capacityWarning ? 'border-red-500!' : ''}`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setPartySize(partySize + 1);
                        clearFieldError('partySize');
                      }}
                      className="pos-glass-field inline-flex h-11 w-11 items-center justify-center transition active:scale-95"
                      aria-label={t('reservationForm.increaseGuests', { defaultValue: 'Increase guests' })}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                    <span className="text-sm liquid-glass-modal-text-muted">
                      {t('reservationForm.guests', { count: partySize })}
                    </span>
                  </div>
                  {(errors.partySize || capacityWarning) && (
                    <p className="mt-1 text-sm text-red-500 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {errors.partySize || t('reservationForm.errors.partySizeExceedsCapacity', {
                        defaultValue: 'Party size exceeds table capacity of {{capacity}}',
                        capacity: tableCapacity
                      })}
                    </p>
                  )}
                </div>
              </div>
            </div>
            <AnimatePresence initial={false}>
              {showNotesStage && (
                <motion.div key="reservation-notes" ref={notesStageRef} data-reservation-stage="3" {...revealMotion}>
                  <div className="space-y-4">
                    {/* Special Requests - Optional */}
                    <div className="pos-glass-form-card">
                      <label htmlFor="reservation-notes" className="mb-1.5 block text-xs font-semibold liquid-glass-modal-text-muted">
                        <MessageSquare className="w-4 h-4 inline mr-1" />
                        {t('reservationForm.specialRequests', { defaultValue: 'Special Requests' })}
                      </label>
                      <textarea
                        id="reservation-notes"
                        value={specialRequests}
                        onChange={(e) => setSpecialRequests(e.target.value)}
                        placeholder={t('reservationForm.specialRequestsPlaceholder', {
                          defaultValue: 'Any special requests or notes...'
                        })}
                        rows={3}
                        className="liquid-glass-modal-input pos-glass-field min-h-touch min-w-0 w-full resize-none"
                      />
                    </div>

                    {/* Existing Reservations Warning (upcoming only, localized date/time). Amber info
              panel; ASCII-safe list markers via list-disc (no literal bullet glyph). */}
                    {upcomingReservations.length > 0 && (
                      <div className="rounded-2xl border border-(--pos-s-warn) bg-(--pos-s-warn-bg) p-3">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                              {t('reservationForm.existingReservations', { defaultValue: 'This table has existing reservations:' })}
                            </p>
                            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-200">
                              {upcomingReservations.slice(0, 3).map((res) => {
                                const start = resolveReservationStart(res);
                                return (
                                  <li key={res.id}>
                                    {t('reservationForm.existingReservationItem', {
                                      date: start ? formatDate(start) : res.reservationDate,
                                      time: start
                                        ? formatTime(start, { hour: '2-digit', minute: '2-digit' })
                                        : res.reservationTime,
                                      customer: res.customerName,
                                      guests: t('reservationForm.guestCount', { count: res.partySize }),
                                    })}
                                  </li>
                                );
                              })}
                              {upcomingReservations.length > 3 && (
                                <li>{t('reservationForm.andMore', { count: upcomingReservations.length - 3 })}</li>
                              )}
                            </ul>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Conflict Warning (semantic red; ASCII-safe list markers) */}
                    {showConflictWarning && conflictingReservations.length > 0 && (
                      <div className="rounded-2xl border border-(--pos-s-bad) bg-(--pos-s-bad-bg) p-3">
                        <div className="flex items-start gap-2">
                          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-sm font-medium text-red-700 dark:text-red-400">
                              {t('reservationForm.conflictWarning', { defaultValue: 'Time conflict detected!' })}
                            </p>
                            <p className="mt-1 text-xs text-red-600 dark:text-red-300">
                              {t('reservationForm.conflictDescription', {
                                defaultValue: 'There is already a reservation at this time:'
                              })}
                            </p>
                            <ul className="mt-1 list-disc pl-5 text-xs text-red-600 dark:text-red-300">
                              {conflictingReservations.map((res) => {
                                const start = resolveReservationStart(res);
                                return (
                                  <li key={res.id}>
                                    {t('reservationForm.conflictItem', {
                                      time: start
                                        ? formatTime(start, { hour: '2-digit', minute: '2-digit' })
                                        : res.reservationTime,
                                      customer: res.customerName,
                                      guests: t('reservationForm.guestCount', { count: res.partySize }),
                                    })}
                                  </li>
                                );
                              })}
                            </ul>
                            <p className="mt-2 text-xs text-red-600 dark:text-red-300">
                              {t('reservationForm.conflictAction', {
                                defaultValue: 'Please choose a different time or cancel the existing reservation first.'
                              })}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                  </div>

                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Action Buttons - plain pinned footer, Cancel left and Create/Save right. */}
          <div className="pos-progressive-form flex justify-between gap-3 px-6 pb-5 pt-2 shrink-0">
            <button
              type="button"
              onClick={handleCancel}
              className="pos-raised flex-1 inline-flex min-h-touch items-center justify-center rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) font-medium text-(--pos-s-fg) transition active:scale-[0.98] active:bg-(--pos-s-surface-2)"
            >
              {t('reservationForm.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="submit"
              disabled={isSubmitting || capacityWarning || showConflictWarning}
              className={`flex-1 inline-flex min-h-touch items-center justify-center rounded-xl font-medium transition active:scale-[0.98] ${isSubmitting || capacityWarning || showConflictWarning
                  ? 'cursor-not-allowed bg-(--pos-s-surface-2) text-(--pos-s-muted)'
                  : 'bg-(--pos-s-yellow) text-black active:bg-yellow-500 shadow-lg'
                }`}
            >
              {isSubmitting
                ? isEditing
                  ? t('reservationForm.saving', { defaultValue: 'Saving...' })
                  : t('reservationForm.creating', { defaultValue: 'Creating...' })
                : isCheckingConflicts
                  ? t('reservationForm.checking', { defaultValue: 'Checking...' })
                  : isEditing
                    ? t('reservationForm.save', { defaultValue: 'Save Changes' })
                    : t('reservationForm.create', { defaultValue: 'Create Reservation' })
              }
            </button>
          </div>
        </form>
      </div>
    </div>
  );
});

ReservationForm.displayName = 'ReservationForm';

export default ReservationForm;
