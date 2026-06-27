/**
 * ReservationInfoPanel - Displays reservation details for a reserved table
 * 
 * Shows customer name, phone, time, party size, special requests
 * and provides "Seat Guest" functionality.
 * 
 * Requirements: 4.5, 7.1, 7.2, 7.3, 7.4, 7.5
 * - 4.5: Display reservation confirmation with details
 * - 7.1: Display reservation info when clicking reserved table
 * - 7.2: Show customer name, phone, time, party size, special requests
 * - 7.3: Update reservation status to 'seated' on Seat Guest
 * - 7.4: Update table status to 'occupied' on Seat Guest
 * - 7.5: Highlight reservations past scheduled time by 15+ minutes
 */

import React, { memo, useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { reservationsService, type Reservation } from '../../services/ReservationsService';
import { formatDate as formatDateValue, formatTime as formatTimeValue } from '../../utils/format';
import {
  X,
  User,
  Phone,
  Clock,
  Users,
  Calendar,
  MessageSquare,
  AlertTriangle,
  UserCheck,
  XCircle,
  Loader2,
} from 'lucide-react';

interface ReservationInfoPanelProps {
  tableId: string;
  tableNumber: number;
  branchId: string;
  organizationId: string;
  onClose: () => void;
  onSeatGuest?: (reservation: Reservation) => void;
  onNavigateToMenu?: (tableId: string, tableNumber: number) => void;
}

export const ReservationInfoPanel: React.FC<ReservationInfoPanelProps> = memo(({
  tableId,
  tableNumber,
  branchId,
  organizationId,
  onClose,
  onSeatGuest,
  onNavigateToMenu,
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const panelClass = `w-80 rounded-3xl border p-6 shadow-2xl backdrop-blur-xl ${
    isDark
      ? 'border-white/10 bg-black/78 shadow-black/45'
      : 'border-black/10 bg-white/82 shadow-black/18'
  }`;
  const detailCardClass = `rounded-2xl border p-3 ${
    isDark ? 'border-white/10 bg-white/[0.06]' : 'border-black/10 bg-white/70'
  }`;
  const closeButtonClass = `inline-flex h-10 w-10 items-center justify-center rounded-2xl transition-transform duration-150 active:scale-95 ${
    isDark ? 'text-gray-300 active:bg-white/10' : 'text-gray-600 active:bg-black/10'
  }`;

  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSeating, setIsSeating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch today's reservation for this table
  useEffect(() => {
    const fetchReservation = async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        reservationsService.setContext(branchId, organizationId);
        const todayReservation = await reservationsService.getTodayReservationForTable(tableId);
        setReservation(todayReservation);
      } catch (err) {
        console.error('Error fetching reservation:', err);
        setError(t('reservationInfoPanel.fetchError', { defaultValue: 'Failed to load reservation' }));
      } finally {
        setIsLoading(false);
      }
    };

    fetchReservation();
  }, [tableId, branchId, organizationId, t]);


  // Check if reservation is late (15+ minutes past scheduled time)
  // Requirements: 7.5 - Highlight reservations past scheduled time by 15+ minutes
  const isLate = useMemo(() => {
    if (!reservation) return false;
    
    const reservationTime = new Date(reservation.reservationDatetime);
    const now = new Date();
    const diffMinutes = (now.getTime() - reservationTime.getTime()) / (1000 * 60);
    
    return diffMinutes >= 15;
  }, [reservation]);

  // Calculate how late the reservation is
  const lateMinutes = useMemo(() => {
    if (!reservation || !isLate) return 0;
    
    const reservationTime = new Date(reservation.reservationDatetime);
    const now = new Date();
    return Math.floor((now.getTime() - reservationTime.getTime()) / (1000 * 60));
  }, [reservation, isLate]);

  // Handle Seat Guest action
  // Requirements: 7.3, 7.4 - Update reservation to 'seated' and table to 'occupied'
  const handleSeatGuest = async () => {
    if (!reservation) return;
    
    setIsSeating(true);
    try {
      // Update reservation status to 'seated'
      await reservationsService.updateStatus(reservation.id, 'seated');

      const tableUpdated = await reservationsService.updateTableStatus(tableId, 'occupied');
      if (!tableUpdated) {
        console.warn('[ReservationInfoPanel] Failed to update table status to occupied');
      }

      // Callback to parent
      onSeatGuest?.(reservation);
      
      // Navigate to menu if callback provided
      if (onNavigateToMenu) {
        onNavigateToMenu(tableId, tableNumber);
      }
      
      onClose();
    } catch (err) {
      console.error('Error seating guest:', err);
      setError(t('reservationInfoPanel.seatError', { defaultValue: 'Failed to seat guest' }));
    } finally {
      setIsSeating(false);
    }
  };

  // Format time for display
  const formatTime = (datetime: string) => {
    return formatTimeValue(datetime, { hour: '2-digit', minute: '2-digit' });
  };

  // Format date for display
  const formatDate = (date: string) => {
    return formatDateValue(date, { weekday: 'short', month: 'short', day: 'numeric' });
  };

  if (isLoading) {
    return (
      <div className={panelClass}>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-8 h-8 animate-spin text-yellow-400" />
        </div>
      </div>
    );
  }

  if (error || !reservation) {
    return (
      <div className={panelClass}>
        <div className="flex items-center justify-between mb-4">
          <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('reservationInfoPanel.title', { defaultValue: 'Table' })} #{tableNumber}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.actions.close', { defaultValue: 'Close' })}
            className={closeButtonClass}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className={`text-center py-6 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <Calendar className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>{error || t('reservationInfoPanel.noReservation', { defaultValue: 'No reservation found for today' })}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={panelClass}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {t('reservationInfoPanel.title', { defaultValue: 'Table' })} #{tableNumber}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.actions.close', { defaultValue: 'Close' })}
          className={closeButtonClass}
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Late Warning */}
      {isLate && (
        <div className={`mb-4 flex items-center gap-2 rounded-2xl p-3 ${
          isDark ? 'bg-red-500/20 border border-red-500/30' : 'bg-red-50 border border-red-200'
        }`}>
          <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <span className="text-red-500 text-sm font-medium">
            {t('reservationInfoPanel.lateWarning', { 
              defaultValue: '{{minutes}} minutes late',
              minutes: lateMinutes 
            })}
          </span>
        </div>
      )}

      {/* Reservation Number */}
      <div className={`mb-4 rounded-2xl border px-3 py-2 text-center ${
        isDark ? 'border-yellow-400/30 bg-yellow-400/12' : 'border-yellow-500/25 bg-yellow-50'
      }`}>
        <span className={`text-sm font-mono font-bold ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
          {reservation.reservationNumber}
        </span>
      </div>

      {/* Customer Info */}
      <div className="space-y-3">
        {/* Customer Name */}
        <div className={detailCardClass}>
          <div className="flex items-center gap-2">
            <User className={`w-4 h-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
            <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('reservationInfoPanel.customerName', { defaultValue: 'Customer' })}
            </span>
          </div>
          <div className={`font-medium mt-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {reservation.customerName}
          </div>
        </div>

        {/* Phone */}
        <div className={detailCardClass}>
          <div className="flex items-center gap-2">
            <Phone className={`w-4 h-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
            <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('reservationInfoPanel.phone', { defaultValue: 'Phone' })}
            </span>
          </div>
          <div className={`font-medium mt-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {reservation.customerPhone}
          </div>
        </div>

        {/* Date & Time */}
        <div className="grid grid-cols-2 gap-2">
          <div className={detailCardClass}>
            <div className="flex items-center gap-2">
              <Calendar className={`w-4 h-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
              <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {t('reservationInfoPanel.date', { defaultValue: 'Date' })}
              </span>
            </div>
            <div className={`font-medium mt-1 text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {formatDate(reservation.reservationDate)}
            </div>
          </div>
          <div className={detailCardClass}>
            <div className="flex items-center gap-2">
              <Clock className={`w-4 h-4 ${isLate ? 'text-red-500' : isDark ? 'text-gray-400' : 'text-gray-500'}`} />
              <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {t('reservationInfoPanel.time', { defaultValue: 'Time' })}
              </span>
            </div>
            <div className={`font-medium mt-1 text-sm ${isLate ? 'text-red-500' : isDark ? 'text-white' : 'text-gray-900'}`}>
              {formatTime(reservation.reservationDatetime)}
            </div>
          </div>
        </div>

        {/* Party Size */}
        <div className={detailCardClass}>
          <div className="flex items-center gap-2">
            <Users className={`w-4 h-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
            <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('reservationInfoPanel.partySize', { defaultValue: 'Party Size' })}
            </span>
          </div>
          <div className={`font-medium mt-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {reservation.partySize} {t('reservationInfoPanel.guests', { defaultValue: 'guests' })}
          </div>
        </div>

        {/* Special Requests */}
        {reservation.specialRequests && (
          <div className={`p-3 rounded-2xl ${isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'}`}>
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-yellow-500" />
              <span className={`text-sm text-yellow-600`}>
                {t('reservationInfoPanel.specialRequests', { defaultValue: 'Special Requests' })}
              </span>
            </div>
            <div className={`mt-1 text-sm ${isDark ? 'text-yellow-400' : 'text-yellow-700'}`}>
              {reservation.specialRequests}
            </div>
          </div>
        )}

        {/* Status */}
        <div className={detailCardClass}>
          <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('reservationInfoPanel.status', { defaultValue: 'Status' })}
          </div>
          <div className={`font-medium mt-1 capitalize ${
            reservation.status === 'confirmed' ? 'text-green-500' :
            reservation.status === 'pending' ? 'text-yellow-500' :
            reservation.status === 'seated' ? 'text-green-500' :
            isDark ? 'text-white' : 'text-gray-900'
          }`}>
            {reservation.status}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-6 space-y-2">
        {/* Seat Guest Button - only show for confirmed/pending reservations */}
        {['confirmed', 'pending'].includes(reservation.status) && (
          <button
            type="button"
            onClick={handleSeatGuest}
            disabled={isSeating}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-green-600 py-3 font-medium text-white transition-transform duration-150 active:scale-[0.98] active:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
          >
            {isSeating ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <UserCheck className="w-5 h-5" />
            )}
            {t('reservationInfoPanel.seatGuest', { defaultValue: 'Seat Guest' })}
          </button>
        )}

        {/* Cancel Reservation Button */}
        {['confirmed', 'pending'].includes(reservation.status) && (
          <button
            type="button"
            className={`flex w-full items-center justify-center gap-2 rounded-2xl py-2.5 transition-transform duration-150 active:scale-[0.98] ${
              isDark 
                ? 'border border-red-400/30 bg-red-500/12 text-red-300 active:bg-red-500/20'
                : 'border border-red-500/25 bg-red-50 text-red-700 active:bg-red-100'
            }`}
          >
            <XCircle className="w-4 h-4" />
            {t('reservationInfoPanel.cancelReservation', { defaultValue: 'Cancel Reservation' })}
          </button>
        )}
      </div>
    </div>
  );
});

ReservationInfoPanel.displayName = 'ReservationInfoPanel';
export default ReservationInfoPanel;
