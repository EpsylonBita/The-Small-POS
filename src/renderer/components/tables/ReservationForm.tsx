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

import React, { memo, useState, useCallback, useMemo, useEffect } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import type { RestaurantTable } from '../../types/tables';
import { reservationsService, type Reservation } from '../../services/ReservationsService';
import { X, Calendar, Clock, Users, Phone, User, MessageSquare, AlertCircle, AlertTriangle } from 'lucide-react';

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
  tableNumber: number;
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
  onSubmit,
  onCancel,
  isOpen
}) => {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

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

  // Load existing reservations for this table on mount
  useEffect(() => {
    if (isOpen && tableId) {
      reservationsService.getReservationsForTable(tableId).then(setExistingReservations);
    }
  }, [isOpen, tableId]);

  // Check for conflicts when date/time changes
  useEffect(() => {
    if (reservationDate && reservationTime && tableId) {
      setIsCheckingConflicts(true);
      reservationsService.checkReservationConflicts(tableId, reservationDate, reservationTime)
        .then((conflicts) => {
          setConflictingReservations(conflicts);
          setShowConflictWarning(conflicts.length > 0);
        })
        .finally(() => setIsCheckingConflicts(false));
    } else {
      setConflictingReservations([]);
      setShowConflictWarning(false);
    }
  }, [reservationDate, reservationTime, tableId]);

  // Get minimum date (today)
  const minDate = useMemo(() => {
    const today = new Date();
    return today.toISOString().split('T')[0];
  }, []);

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
        specialRequests: specialRequests.trim() || undefined,
        tableId,
      });
    } catch (error) {
      console.error('Failed to create reservation:', error);
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
  const handleCancel = useCallback(() => {
    resetForm();
    onCancel();
  }, [resetForm, onCancel]);

  if (!isOpen) return null;

  // Check if party size exceeds capacity for warning display
  const capacityWarning = partySize > tableCapacity;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={handleCancel}
      />

      {/* Modal */}
      <div className={`relative w-full max-w-lg mx-4 rounded-2xl shadow-2xl ${
        isDark ? 'bg-gray-900 border border-white/10' : 'bg-white'
      }`}>
        {/* Header */}
        <div className={`flex items-center justify-between p-4 border-b ${
          isDark ? 'border-white/10' : 'border-gray-200'
        }`}>
          <div>
            <h2 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('reservationForm.title', { defaultValue: 'New Reservation' })}
            </h2>
            <p className={`text-sm mt-1 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
              {t('reservationForm.subtitle', { 
                defaultValue: 'Table #{{tableNumber}} • Capacity: {{capacity}} guests',
                tableNumber,
                capacity: tableCapacity
              })}
            </p>
          </div>
          <button
            onClick={handleCancel}
            className={`p-2 rounded-lg transition-colors ${
              isDark 
                ? 'hover:bg-white/10 text-white/70 hover:text-white' 
                : 'hover:bg-gray-100 text-gray-500 hover:text-gray-700'
            }`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Customer Name - Required (Requirements 4.1) */}
          <div>
            <label className={`block text-sm font-medium mb-1 ${
              isDark ? 'text-white/80' : 'text-gray-700'
            }`}>
              <User className="w-4 h-4 inline mr-1" />
              {t('reservationForm.customerName', { defaultValue: 'Customer Name' })} *
            </label>
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder={t('reservationForm.customerNamePlaceholder', { defaultValue: 'Enter customer name' })}
              className={`w-full px-4 py-2 rounded-lg border transition-colors ${
                errors.customerName
                  ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20'
                  : isDark
                    ? 'bg-white/5 border-white/10 text-white placeholder-white/40 focus:border-purple-500'
                    : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-purple-500'
              } focus:outline-none focus:ring-2 focus:ring-purple-500/20`}
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
            <label className={`block text-sm font-medium mb-1 ${
              isDark ? 'text-white/80' : 'text-gray-700'
            }`}>
              <Phone className="w-4 h-4 inline mr-1" />
              {t('reservationForm.phone', { defaultValue: 'Phone Number' })} *
            </label>
            <input
              type="tel"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              placeholder={t('reservationForm.phonePlaceholder', { defaultValue: '+30 XXX XXX XXXX' })}
              className={`w-full px-4 py-2 rounded-lg border transition-colors ${
                errors.customerPhone
                  ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20'
                  : isDark
                    ? 'bg-white/5 border-white/10 text-white placeholder-white/40 focus:border-purple-500'
                    : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-purple-500'
              } focus:outline-none focus:ring-2 focus:ring-purple-500/20`}
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
              <label className={`block text-sm font-medium mb-1 ${
                isDark ? 'text-white/80' : 'text-gray-700'
              }`}>
                <Calendar className="w-4 h-4 inline mr-1" />
                {t('reservationForm.date', { defaultValue: 'Date' })} *
              </label>
              <input
                type="date"
                value={reservationDate}
                onChange={(e) => setReservationDate(e.target.value)}
                min={minDate}
                className={`w-full px-4 py-2 rounded-lg border transition-colors ${
                  errors.reservationDate
                    ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20'
                    : isDark
                      ? 'bg-white/5 border-white/10 text-white focus:border-purple-500'
                      : 'bg-gray-50 border-gray-200 text-gray-900 focus:border-purple-500'
                } focus:outline-none focus:ring-2 focus:ring-purple-500/20`}
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
              <label className={`block text-sm font-medium mb-1 ${
                isDark ? 'text-white/80' : 'text-gray-700'
              }`}>
                <Clock className="w-4 h-4 inline mr-1" />
                {t('reservationForm.time', { defaultValue: 'Time' })} *
              </label>
              <input
                type="time"
                value={reservationTime}
                onChange={(e) => setReservationTime(e.target.value)}
                className={`w-full px-4 py-2 rounded-lg border transition-colors ${
                  errors.reservationTime
                    ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20'
                    : isDark
                      ? 'bg-white/5 border-white/10 text-white focus:border-purple-500'
                      : 'bg-gray-50 border-gray-200 text-gray-900 focus:border-purple-500'
                } focus:outline-none focus:ring-2 focus:ring-purple-500/20`}
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
            <label className={`block text-sm font-medium mb-1 ${
              isDark ? 'text-white/80' : 'text-gray-700'
            }`}>
              <Users className="w-4 h-4 inline mr-1" />
              {t('reservationForm.partySize', { defaultValue: 'Number of Guests' })} *
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setPartySize(Math.max(1, partySize - 1))}
                className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
                  isDark
                    ? 'bg-white/10 hover:bg-white/20 text-white'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                }`}
              >
                -
              </button>
              <input
                type="number"
                value={partySize}
                onChange={(e) => setPartySize(Math.max(1, parseInt(e.target.value) || 1))}
                min={1}
                className={`w-20 px-4 py-2 rounded-lg border text-center transition-colors ${
                  errors.partySize || capacityWarning
                    ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20'
                    : isDark
                      ? 'bg-white/5 border-white/10 text-white focus:border-purple-500'
                      : 'bg-gray-50 border-gray-200 text-gray-900 focus:border-purple-500'
                } focus:outline-none focus:ring-2 focus:ring-purple-500/20`}
              />
              <button
                type="button"
                onClick={() => setPartySize(partySize + 1)}
                className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
                  isDark
                    ? 'bg-white/10 hover:bg-white/20 text-white'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                }`}
              >
                +
              </button>
              <span className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                {t('reservationForm.guests', { defaultValue: 'guests' })}
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
            <label className={`block text-sm font-medium mb-1 ${
              isDark ? 'text-white/80' : 'text-gray-700'
            }`}>
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
              className={`w-full px-4 py-2 rounded-lg border transition-colors resize-none ${
                isDark
                  ? 'bg-white/5 border-white/10 text-white placeholder-white/40 focus:border-purple-500'
                  : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-purple-500'
              } focus:outline-none focus:ring-2 focus:ring-purple-500/20`}
            />
          </div>

          {/* Existing Reservations Warning */}
          {existingReservations.length > 0 && (
            <div className={`p-3 rounded-lg ${isDark ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-blue-50 border border-blue-200'}`}>
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className={`text-sm font-medium ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>
                    {t('reservationForm.existingReservations', { defaultValue: 'This table has existing reservations:' })}
                  </p>
                  <ul className={`mt-1 text-xs space-y-1 ${isDark ? 'text-blue-300/80' : 'text-blue-600'}`}>
                    {existingReservations.slice(0, 3).map((res) => (
                      <li key={res.id}>
                        • {res.reservationDate} at {res.reservationTime} - {res.customerName} ({res.partySize} guests)
                      </li>
                    ))}
                    {existingReservations.length > 3 && (
                      <li>... and {existingReservations.length - 3} more</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Conflict Warning */}
          {showConflictWarning && conflictingReservations.length > 0 && (
            <div className={`p-3 rounded-lg ${isDark ? 'bg-red-500/10 border border-red-500/30' : 'bg-red-50 border border-red-200'}`}>
              <div className="flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className={`text-sm font-medium ${isDark ? 'text-red-400' : 'text-red-700'}`}>
                    {t('reservationForm.conflictWarning', { defaultValue: 'Time conflict detected!' })}
                  </p>
                  <p className={`mt-1 text-xs ${isDark ? 'text-red-300/80' : 'text-red-600'}`}>
                    {t('reservationForm.conflictDescription', { 
                      defaultValue: 'There is already a reservation at this time:' 
                    })}
                  </p>
                  <ul className={`mt-1 text-xs ${isDark ? 'text-red-300/80' : 'text-red-600'}`}>
                    {conflictingReservations.map((res) => (
                      <li key={res.id}>
                        • {res.reservationTime} - {res.customerName} ({res.partySize} guests)
                      </li>
                    ))}
                  </ul>
                  <p className={`mt-2 text-xs ${isDark ? 'text-red-300/80' : 'text-red-600'}`}>
                    {t('reservationForm.conflictAction', { 
                      defaultValue: 'Please choose a different time or cancel the existing reservation first.' 
                    })}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={handleCancel}
              className={`flex-1 py-3 rounded-xl font-medium transition-colors ${
                isDark
                  ? 'bg-white/10 hover:bg-white/20 text-white'
                  : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
              }`}
            >
              {t('reservationForm.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="submit"
              disabled={isSubmitting || capacityWarning || showConflictWarning}
              className={`flex-1 py-3 rounded-xl font-medium transition-colors ${
                isSubmitting || capacityWarning || showConflictWarning
                  ? 'bg-purple-500/50 text-white/50 cursor-not-allowed'
                  : 'bg-purple-600 hover:bg-purple-700 text-white'
              }`}
            >
              {isSubmitting 
                ? t('reservationForm.creating', { defaultValue: 'Creating...' })
                : isCheckingConflicts
                  ? t('reservationForm.checking', { defaultValue: 'Checking...' })
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
