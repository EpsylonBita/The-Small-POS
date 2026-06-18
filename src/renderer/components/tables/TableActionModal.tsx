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

import React, { memo, useEffect, useState } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import type { RestaurantTable, TableStatus } from '../../types/tables';
import { X, ShoppingCart, Calendar, Users, LayoutGrid, Clock, Minus, Plus, CheckCircle2, Pencil, UserX, Ban } from 'lucide-react';

interface TableActionModalProps {
  table: RestaurantTable;
  onNewOrder: (guestCount: number) => void;
  onNewReservation: () => void;
  onSetAvailable: () => void | Promise<void>;
  onEditReservation?: () => void | Promise<void>;
  onNoShowReservation?: () => void | Promise<void>;
  onCancelReservation?: () => void | Promise<void>;
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
  onSetAvailable,
  onEditReservation,
  onNoShowReservation,
  onCancelReservation,
  onClose,
  isOpen
}) => {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [guestCount, setGuestCount] = useState(() => Math.max(1, Number(table.guestCount || 1)));

  useEffect(() => {
    setGuestCount(Math.max(1, Number(table.guestCount || 1)));
  }, [table.id, table.guestCount]);

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
    },
    maintenance: {
      label: t('tableActionModal.status.maintenance', { defaultValue: 'Maintenance' }),
      color: 'text-orange-500',
      bgClass: 'bg-orange-500/10 border-orange-500/30'
    },
    unavailable: {
      label: t('tableActionModal.status.unavailable', { defaultValue: 'Unavailable' }),
      color: 'text-slate-500',
      bgClass: 'bg-slate-500/10 border-slate-500/30'
    }
  };

  const isCleaningTable = table.status === 'cleaning';
  const isMaintenanceTable = table.status === 'maintenance';
  const isUnavailableTable = table.status === 'unavailable';
  const isReservedTable = table.status === 'reserved';
  const blocksGuestActions = isCleaningTable || isMaintenanceTable || isUnavailableTable;

  const handleNewOrder = () => {
    if (blocksGuestActions) {
      return;
    }
    onNewOrder(guestCount);
    // Note: Don't call onClose() here - the parent handler manages modal state
  };

  const handleNewReservation = () => {
    if (isMaintenanceTable || isUnavailableTable) {
      return;
    }
    onNewReservation();
    // Note: Don't call onClose() here - the parent handler manages modal state
  };

  const handleSetAvailable = () => {
    onSetAvailable();
    // Note: Don't call onClose() here - the parent handler manages modal state
  };

  const handleEditReservation = () => {
    onEditReservation?.();
  };

  const handleNoShowReservation = () => {
    onNoShowReservation?.();
  };

  const handleCancelReservation = () => {
    onCancelReservation?.();
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

            <div className={`mt-4 pt-4 border-t ${
              isDark ? 'border-white/10' : 'border-gray-200'
            }`}>
              <div className="flex items-center justify-between">
                <div>
                  <div className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {t('tableActionModal.covers', { defaultValue: 'Covers' })}
                  </div>
                  <div className={`text-xs ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                    {t('tableActionModal.coversDescription', { defaultValue: 'Guests on this check' })}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setGuestCount((value) => Math.max(1, value - 1))}
                    className={`p-2 rounded-lg border ${
                      isDark
                        ? 'border-white/10 hover:bg-white/10 text-white'
                        : 'border-gray-200 hover:bg-gray-100 text-gray-700'
                    }`}
                    aria-label={t('tableActionModal.decreaseCovers', { defaultValue: 'Decrease covers' })}
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={guestCount}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setGuestCount(Number.isFinite(next) ? Math.max(1, Math.min(99, Math.trunc(next))) : 1);
                    }}
                    className={`w-16 px-2 py-2 text-center rounded-lg border font-semibold ${
                      isDark
                        ? 'bg-white/5 border-white/10 text-white'
                        : 'bg-white border-gray-200 text-gray-900'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setGuestCount((value) => Math.min(99, value + 1))}
                    className={`p-2 rounded-lg border ${
                      isDark
                        ? 'border-white/10 hover:bg-white/10 text-white'
                        : 'border-gray-200 hover:bg-gray-100 text-gray-700'
                    }`}
                    aria-label={t('tableActionModal.increaseCovers', { defaultValue: 'Increase covers' })}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {typeof table.unpaidBalance === 'number' && table.unpaidBalance > 0 && (
                <div className={`mt-3 text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                  {t('tableActionModal.unpaidBalance', {
                    defaultValue: 'Open balance: {{amount}}',
                    amount: table.unpaidBalance.toFixed(2),
                  })}
                </div>
              )}
            </div>
          </div>
        </div>


        {/* Action Buttons */}
        <div className="p-4 space-y-3">
          {/* New Order Button - Requirements 3.2, 3.3 */}
          <button
            onClick={handleNewOrder}
            disabled={blocksGuestActions}
            aria-disabled={blocksGuestActions}
            className={`w-full p-4 rounded-xl border-2 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] ${
              blocksGuestActions
                ? isDark
                  ? 'cursor-not-allowed bg-white/5 border-white/10 opacity-60'
                  : 'cursor-not-allowed bg-gray-100 border-gray-200 opacity-70'
                : isDark
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
                  {isCleaningTable
                    ? t('tableActionModal.newOrderCleaningDisabled', {
                        defaultValue: 'Mark the table cleaned before taking a new order',
                      })
                    : isMaintenanceTable
                      ? t('tableActionModal.newOrderMaintenanceDisabled', {
                          defaultValue: 'Return this table to service before taking a new order',
                        })
                      : isUnavailableTable
                        ? t('tableActionModal.newOrderUnavailableDisabled', {
                            defaultValue: 'Make this table available before taking a new order',
                          })
                    : t('tableActionModal.newOrderDescription', {
                        defaultValue: 'Start a new order for this table',
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

          {blocksGuestActions && (
            <button
              onClick={handleSetAvailable}
              className={`w-full p-4 rounded-xl border-2 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] ${
                isDark
                  ? 'bg-emerald-500/10 border-emerald-500/30 hover:border-emerald-500 hover:bg-emerald-500/20'
                  : 'bg-emerald-50 border-emerald-200 hover:border-emerald-500 hover:bg-emerald-100'
              }`}
            >
              <div className="flex items-center gap-4">
                <div className={`p-3 rounded-xl ${
                  isDark ? 'bg-emerald-500/20' : 'bg-emerald-100'
                }`}>
                  <CheckCircle2 className="w-6 h-6 text-emerald-500" />
                </div>

                <div className="flex-1 text-left">
                  <div className="text-lg font-bold text-emerald-500">
                    {isCleaningTable
                      ? t('tableActionModal.markCleaned', { defaultValue: 'Cleaned' })
                      : isMaintenanceTable
                        ? t('tableActionModal.markBackInService', { defaultValue: 'Back in service' })
                        : t('tableActionModal.markAvailable', { defaultValue: 'Set Available' })}
                  </div>
                  <div className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                    {isMaintenanceTable
                      ? t('tableActionModal.markBackInServiceDescription', {
                          defaultValue: 'Set this table as available after maintenance',
                        })
                      : t('tableActionModal.markAvailableDescription', {
                          defaultValue: 'Set this table as available for orders',
                        })}
                  </div>
                </div>

                <div className="text-emerald-500">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
              </div>
            </button>
          )}

          {isReservedTable && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                onClick={handleEditReservation}
                disabled={!onEditReservation}
                className={`w-full p-4 rounded-xl border-2 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] ${
                  isDark
                    ? 'bg-amber-500/10 border-amber-500/30 hover:border-amber-500 hover:bg-amber-500/20'
                    : 'bg-amber-50 border-amber-200 hover:border-amber-500 hover:bg-amber-100'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`p-3 rounded-xl ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
                    <Pencil className="w-5 h-5 text-amber-500" />
                  </div>
                  <div className="text-left">
                    <div className="font-bold text-amber-500">
                      {t('tableActionModal.editReservation', { defaultValue: 'Edit Reservation' })}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                      {t('tableActionModal.editReservationDescription', {
                        defaultValue: 'Change time, guests, or notes',
                      })}
                    </div>
                  </div>
                </div>
              </button>

              <button
                onClick={handleNoShowReservation}
                disabled={!onNoShowReservation}
                className={`w-full p-4 rounded-xl border-2 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] ${
                  isDark
                    ? 'bg-slate-500/10 border-slate-500/30 hover:border-slate-400 hover:bg-slate-500/20'
                    : 'bg-slate-50 border-slate-200 hover:border-slate-400 hover:bg-slate-100'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`p-3 rounded-xl ${isDark ? 'bg-slate-500/20' : 'bg-slate-100'}`}>
                    <UserX className="w-5 h-5 text-slate-500" />
                  </div>
                  <div className="text-left">
                    <div className="font-bold text-slate-500">
                      {t('tableActionModal.noShowReservation', { defaultValue: 'No Show' })}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                      {t('tableActionModal.noShowReservationDescription', {
                        defaultValue: 'Guest did not arrive',
                      })}
                    </div>
                  </div>
                </div>
              </button>

              <button
                onClick={handleCancelReservation}
                disabled={!onCancelReservation}
                className={`w-full p-4 rounded-xl border-2 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] sm:col-span-2 ${
                  isDark
                    ? 'bg-red-500/10 border-red-500/30 hover:border-red-500 hover:bg-red-500/20'
                    : 'bg-red-50 border-red-200 hover:border-red-500 hover:bg-red-100'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`p-3 rounded-xl ${isDark ? 'bg-red-500/20' : 'bg-red-100'}`}>
                    <Ban className="w-5 h-5 text-red-500" />
                  </div>
                  <div className="text-left">
                    <div className="font-bold text-red-500">
                      {t('tableActionModal.cancelReservation', { defaultValue: 'Cancel Reservation' })}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                      {t('tableActionModal.cancelReservationDescription', {
                        defaultValue: 'Cancel booking and release table',
                      })}
                    </div>
                  </div>
                </div>
              </button>
            </div>
          )}

          {/* New Reservation Button - Requirements 3.2, 3.4 */}
          {!isReservedTable && (
            <button
              onClick={handleNewReservation}
              disabled={isMaintenanceTable || isUnavailableTable}
              aria-disabled={isMaintenanceTable || isUnavailableTable}
              className={`w-full p-4 rounded-xl border-2 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] ${
                isMaintenanceTable || isUnavailableTable
                  ? isDark
                    ? 'cursor-not-allowed bg-white/5 border-white/10 opacity-60'
                    : 'cursor-not-allowed bg-gray-100 border-gray-200 opacity-70'
                  : isDark
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
                    {isMaintenanceTable || isUnavailableTable
                      ? t('tableActionModal.newReservationUnavailableDescription', {
                          defaultValue: 'Return this table to service before booking',
                        })
                      : t('tableActionModal.newReservationDescription', {
                          defaultValue: 'Book this table for a future time',
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
          )}
        </div>

        {/* Footer hint */}
      <div className={`px-4 pb-4 text-center text-xs ${
        isDark ? 'text-white/40' : 'text-gray-400'
      }`}>
          {isCleaningTable
            ? t('tableActionModal.cleaningHint', {
                defaultValue: 'Set the table as cleaned to make it available for orders',
              })
            : isMaintenanceTable
              ? t('tableActionModal.maintenanceHint', {
                  defaultValue: 'Maintenance tables are out of service until marked back in service',
                })
              : isReservedTable
                ? t('tableActionModal.reservedHint', {
                    defaultValue: 'Manage this reservation or start the table order when guests arrive',
                  })
              : isUnavailableTable
                ? t('tableActionModal.unavailableHint', {
                    defaultValue: 'Set the table available before using it for guests',
                  })
            : t('tableActionModal.hint', {
                defaultValue: 'Select an action to continue',
              })}
        </div>
      </div>
    </div>
  );
});

TableActionModal.displayName = 'TableActionModal';

export default TableActionModal;
