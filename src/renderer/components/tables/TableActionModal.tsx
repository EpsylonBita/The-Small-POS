/**
 * TableActionModal Component
 * 
 * Displays action options when a table is selected:
 * - "New Order" button to create an order for the table
 * - "New Reservation" button to create a reservation
 * 
 * Requirements:
 * - 3.2: Display two options: "New Order" and "New Reservation"
 * - 3.3: New Order navigates to menu with pickup pricing and table assigned
 * - 3.4: New Reservation displays the reservation creation form
 */

import React, { memo } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import type { RestaurantTable, TableStatus } from '../../types/tables';
import { X, ShoppingCart, Calendar, Users, LayoutGrid, Clock } from 'lucide-react';

interface TableActionModalProps {
  table: RestaurantTable;
  onNewOrder: () => void;
  onNewReservation: () => void;
  onClose: () => void;
  isOpen: boolean;
}

/**
 * TableActionModal - Modal for selecting table action
 * 
 * Shows "New Order" and "New Reservation" options when a table is selected.
 * Displays table details including number, capacity, and current status.
 */
export const TableActionModal: React.FC<TableActionModalProps> = memo(({
  table,
  onNewOrder,
  onNewReservation,
  onClose,
  isOpen
}) => {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // Status configuration for display
  const statusConfig: Record<TableStatus, { label: string; color: string; bgClass: string }> = {
    available: {
      label: t('tableActionModal.status.available', { defaultValue: 'Available' }),
      color: 'text-green-500',
      bgClass: 'bg-green-500/10 border-green-500/30'
    },
    reserved: {
      label: t('tableActionModal.status.reserved', { defaultValue: 'Reserved' }),
      color: 'text-yellow-500',
      bgClass: 'bg-yellow-500/10 border-yellow-500/30'
    },
    occupied: {
      label: t('tableActionModal.status.occupied', { defaultValue: 'Occupied' }),
      color: 'text-blue-500',
      bgClass: 'bg-blue-500/10 border-blue-500/30'
    },
    cleaning: {
      label: t('tableActionModal.status.cleaning', { defaultValue: 'Cleaning' }),
      color: 'text-gray-500',
      bgClass: 'bg-gray-500/10 border-gray-500/30'
    }
  };

  const handleNewOrder = () => {
    onNewOrder();
    // Note: Don't call onClose() here - the parent handler manages modal state
  };

  const handleNewReservation = () => {
    onNewReservation();
    // Note: Don't call onClose() here - the parent handler manages modal state
  };

  if (!isOpen) return null;

  const currentStatus = statusConfig[table.status];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className={`relative w-full max-w-md mx-4 rounded-2xl shadow-2xl ${
        isDark ? 'bg-gray-900 border border-white/10' : 'bg-white'
      }`}>
        {/* Header */}
        <div className={`flex items-center justify-between p-4 border-b ${
          isDark ? 'border-white/10' : 'border-gray-200'
        }`}>
          <h2 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('tableActionModal.title', { defaultValue: 'Table Actions' })}
          </h2>
          <button
            onClick={onClose}
            className={`p-2 rounded-lg transition-colors ${
              isDark 
                ? 'hover:bg-white/10 text-white/70 hover:text-white' 
                : 'hover:bg-gray-100 text-gray-500 hover:text-gray-700'
            }`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Table Details */}
        <div className="p-4">
          <div className={`rounded-xl p-4 border ${currentStatus.bgClass}`}>
            <div className="flex items-center gap-4">
              {/* Table Icon */}
              <div className={`p-3 rounded-xl ${isDark ? 'bg-white/10' : 'bg-white'}`}>
                <LayoutGrid className={`w-8 h-8 ${currentStatus.color}`} />
              </div>

              {/* Table Info */}
              <div className="flex-1">
                <div className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('tableActionModal.tableNumber', { defaultValue: 'Table' })} #{table.tableNumber}
                </div>
                <div className="flex items-center gap-4 mt-1">
                  {/* Capacity */}
                  <div className={`flex items-center gap-1 text-sm ${
                    isDark ? 'text-white/60' : 'text-gray-500'
                  }`}>
                    <Users className="w-4 h-4" />
                    <span>{table.capacity} {t('tableActionModal.guests', { defaultValue: 'guests' })}</span>
                  </div>
                  {/* Status */}
                  <div className={`flex items-center gap-1 text-sm ${currentStatus.color}`}>
                    <Clock className="w-4 h-4" />
                    <span>{currentStatus.label}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Notes if any */}
            {table.notes && (
              <div className={`mt-3 pt-3 border-t text-sm ${
                isDark ? 'border-white/10 text-white/60' : 'border-gray-200 text-gray-500'
              }`}>
                {table.notes}
              </div>
            )}
          </div>
        </div>


        {/* Action Buttons */}
        <div className="p-4 space-y-3">
          {/* New Order Button - Requirements 3.2, 3.3 */}
          <button
            onClick={handleNewOrder}
            className={`w-full p-4 rounded-xl border-2 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] ${
              isDark
                ? 'bg-blue-500/10 border-blue-500/30 hover:border-blue-500 hover:bg-blue-500/20'
                : 'bg-blue-50 border-blue-200 hover:border-blue-500 hover:bg-blue-100'
            }`}
          >
            <div className="flex items-center gap-4">
              {/* Icon */}
              <div className={`p-3 rounded-xl ${
                isDark ? 'bg-blue-500/20' : 'bg-blue-100'
              }`}>
                <ShoppingCart className="w-6 h-6 text-blue-500" />
              </div>

              {/* Text */}
              <div className="flex-1 text-left">
                <div className="text-lg font-bold text-blue-500">
                  {t('tableActionModal.newOrder', { defaultValue: 'New Order' })}
                </div>
                <div className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                  {t('tableActionModal.newOrderDescription', { 
                    defaultValue: 'Start a new order for this table' 
                  })}
                </div>
              </div>

              {/* Arrow */}
              <div className="text-blue-500">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </div>
          </button>

          {/* New Reservation Button - Requirements 3.2, 3.4 */}
          <button
            onClick={handleNewReservation}
            className={`w-full p-4 rounded-xl border-2 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] ${
              isDark
                ? 'bg-purple-500/10 border-purple-500/30 hover:border-purple-500 hover:bg-purple-500/20'
                : 'bg-purple-50 border-purple-200 hover:border-purple-500 hover:bg-purple-100'
            }`}
          >
            <div className="flex items-center gap-4">
              {/* Icon */}
              <div className={`p-3 rounded-xl ${
                isDark ? 'bg-purple-500/20' : 'bg-purple-100'
              }`}>
                <Calendar className="w-6 h-6 text-purple-500" />
              </div>

              {/* Text */}
              <div className="flex-1 text-left">
                <div className="text-lg font-bold text-purple-500">
                  {t('tableActionModal.newReservation', { defaultValue: 'New Reservation' })}
                </div>
                <div className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                  {t('tableActionModal.newReservationDescription', { 
                    defaultValue: 'Book this table for a future time' 
                  })}
                </div>
              </div>

              {/* Arrow */}
              <div className="text-purple-500">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </div>
          </button>
        </div>

        {/* Footer hint */}
        <div className={`px-4 pb-4 text-center text-xs ${
          isDark ? 'text-white/40' : 'text-gray-400'
        }`}>
          {t('tableActionModal.hint', { 
            defaultValue: 'Select an action to continue' 
          })}
        </div>
      </div>
    </div>
  );
});

TableActionModal.displayName = 'TableActionModal';

export default TableActionModal;
