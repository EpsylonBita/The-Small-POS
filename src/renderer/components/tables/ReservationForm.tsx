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

import React, { memo, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useI18n } from '../../contexts/i18n-context';
import type { RestaurantTable } from '../../types/tables';
import { reservationsService, type Reservation } from '../../services/ReservationsService';
import { useSystemClock } from '../../hooks/useSystemClock';
import { toLocalDateString } from '../../utils/date';
import { renderModalPortal } from '../../utils/render-modal-portal';
import { formatTableDisplayNumber } from '../../utils/table-display';
import { formatDate, formatTime } from '../../utils/format';
import {
  resolveReservationStart,
  selectUpcomingTableReservations,
} from '../../utils/reservationFormWarnings';
import { X, Calendar, Clock, Users, Phone, User, MessageSquare, AlertCircle, AlertTriangle, Minus, Plus } from 'lucide-react';

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
    setReservationDate('');
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

  if (!isOpen) return null;

  // Check if party size exceeds capacity for warning display
  const capacityWarning = partySize > tableCapacity;

  return renderModalPortal(
    <div className="fixed inset-0 z-[1200] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
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
        className="liquid-glass-modal-shell relative mx-4 flex w-full max-w-lg max-h-[90vh] flex-col"
      >
        {/* Header (shared glass header/title/close tokens; lucide X, labelled close) */}
        <div className="liquid-glass-modal-header">
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
          <div className="liquid-glass-modal-content scrollbar-hide flex-1 min-h-0 overflow-y-auto space-y-4">
          {/* Customer Name - Required (Requirements 4.1) */}
          <div>
            <label className="mb-1 block text-sm font-medium liquid-glass-modal-text">
              <User className="w-4 h-4 inline mr-1" />
              {t('reservationForm.customerName', { defaultValue: 'Customer Name' })} *
            </label>
            <input
              type="text"
              value={customerName}
              onChange={(e) => { setCustomerName(e.target.value); clearFieldError('customerName'); }}
              placeholder={t('reservationForm.customerNamePlaceholder', { defaultValue: 'Enter customer name' })}
              className={`liquid-glass-modal-input w-full ${errors.customerName ? '!border-red-500' : ''}`}
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
            <label className="mb-1 block text-sm font-medium liquid-glass-modal-text">
              <Phone className="w-4 h-4 inline mr-1" />
              {t('reservationForm.phone', { defaultValue: 'Phone Number' })} *
            </label>
            <input
              type="tel"
              value={customerPhone}
              onChange={(e) => { setCustomerPhone(e.target.value); clearFieldError('customerPhone'); }}
              placeholder={t('reservationForm.phonePlaceholder', { defaultValue: '+30 XXX XXX XXXX' })}
              className={`liquid-glass-modal-input w-full ${errors.customerPhone ? '!border-red-500' : ''}`}
            />
            {errors.customerPhone && (
              <p className="mt-1 text-sm text-red-500 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                {errors.customerPhone}
              </p>
            )}
          </div>

          {/* Date and Time Row - Required (Requirements 4.1) */}
          <div className="grid grid-cols-2 gap-4">
            {/* Date */}
            <div>
              <label className="mb-1 block text-sm font-medium liquid-glass-modal-text">
                <Calendar className="w-4 h-4 inline mr-1" />
                {t('reservationForm.date', { defaultValue: 'Date' })} *
              </label>
              <input
                type="date"
                value={reservationDate}
                onChange={(e) => { setReservationDate(e.target.value); clearFieldError('reservationDate'); }}
                min={minDate}
                className={`liquid-glass-modal-input w-full ${errors.reservationDate ? '!border-red-500' : ''}`}
              />
              {errors.reservationDate && (
                <p className="mt-1 text-sm text-red-500 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {errors.reservationDate}
                </p>
              )}
            </div>

            {/* Time */}
            <div>
              <label className="mb-1 block text-sm font-medium liquid-glass-modal-text">
                <Clock className="w-4 h-4 inline mr-1" />
                {t('reservationForm.time', { defaultValue: 'Time' })} *
              </label>
              <input
                type="time"
                value={reservationTime}
                onChange={(e) => { setReservationTime(e.target.value); clearFieldError('reservationTime'); }}
                className={`liquid-glass-modal-input w-full ${errors.reservationTime ? '!border-red-500' : ''}`}
              />
              {errors.reservationTime && (
                <p className="mt-1 text-sm text-red-500 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {errors.reservationTime}
                </p>
              )}
            </div>
          </div>

          {/* Party Size - Required (Requirements 4.1, 4.2) */}
          <div>
            <label className="mb-1 block text-sm font-medium liquid-glass-modal-text">
              <Users className="w-4 h-4 inline mr-1" />
              {t('reservationForm.partySize', { defaultValue: 'Number of Guests' })} *
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setPartySize(Math.max(1, partySize - 1));
                  clearFieldError('partySize');
                }}
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl border liquid-glass-modal-border liquid-glass-modal-text transition active:scale-95 active:bg-black/5 dark:active:bg-white/10"
                aria-label={t('reservationForm.decreaseGuests', { defaultValue: 'Decrease guests' })}
              >
                <Minus className="h-4 w-4" />
              </button>
              <input
                type="number"
                value={partySize}
                onChange={(e) => { setPartySize(Math.max(1, parseInt(e.target.value) || 1)); clearFieldError('partySize'); }}
                min={1}
                aria-label={t('reservationForm.partySize', { defaultValue: 'Number of Guests' })}
                className={`liquid-glass-modal-input w-20 text-center ${errors.partySize || capacityWarning ? '!border-red-500' : ''}`}
              />
              <button
                type="button"
                onClick={() => {
                  setPartySize(partySize + 1);
                  clearFieldError('partySize');
                }}
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl border liquid-glass-modal-border liquid-glass-modal-text transition active:scale-95 active:bg-black/5 dark:active:bg-white/10"
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

          {/* Special Requests - Optional */}
          <div>
            <label className="mb-1 block text-sm font-medium liquid-glass-modal-text">
              <MessageSquare className="w-4 h-4 inline mr-1" />
              {t('reservationForm.specialRequests', { defaultValue: 'Special Requests' })}
            </label>
            <textarea
              value={specialRequests}
              onChange={(e) => setSpecialRequests(e.target.value)}
              placeholder={t('reservationForm.specialRequestsPlaceholder', {
                defaultValue: 'Any special requests or notes...'
              })}
              rows={3}
              className="liquid-glass-modal-input w-full resize-none"
            />
          </div>

          {/* Existing Reservations Warning (upcoming only, localized date/time). Amber info
              panel; ASCII-safe list markers via list-disc (no literal bullet glyph). */}
          {upcomingReservations.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                    {t('reservationForm.existingReservations', { defaultValue: 'This table has existing reservations:' })}
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-200/80">
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
            <div className="rounded-2xl border border-red-200 bg-red-50 p-3 dark:border-red-500/30 dark:bg-red-500/10">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-700 dark:text-red-400">
                    {t('reservationForm.conflictWarning', { defaultValue: 'Time conflict detected!' })}
                  </p>
                  <p className="mt-1 text-xs text-red-600 dark:text-red-300/80">
                    {t('reservationForm.conflictDescription', {
                      defaultValue: 'There is already a reservation at this time:'
                    })}
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-xs text-red-600 dark:text-red-300/80">
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
                  <p className="mt-2 text-xs text-red-600 dark:text-red-300/80">
                    {t('reservationForm.conflictAction', {
                      defaultValue: 'Please choose a different time or cancel the existing reservation first.'
                    })}
                  </p>
                </div>
              </div>
            </div>
          )}

          </div>

          {/* Action Buttons - pinned footer so it never clips. Cancel = red, Create/Save = green. */}
          <div className="flex gap-3 p-4 border-t flex-shrink-0 liquid-glass-modal-border">
            <button
              type="button"
              onClick={handleCancel}
              className="flex-1 inline-flex min-h-[44px] items-center justify-center rounded-xl border border-red-500/50 bg-red-500/10 font-medium text-red-600 transition active:scale-[0.98] active:bg-red-500/20 dark:text-red-300"
            >
              {t('reservationForm.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="submit"
              disabled={isSubmitting || capacityWarning || showConflictWarning}
              className={`flex-1 inline-flex min-h-[44px] items-center justify-center rounded-xl font-medium text-white transition active:scale-[0.98] ${
                isSubmitting || capacityWarning || showConflictWarning
                  ? 'cursor-not-allowed bg-green-600/40 text-white/60'
                  : 'bg-green-600 active:bg-green-700 shadow-lg shadow-green-600/25'
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
