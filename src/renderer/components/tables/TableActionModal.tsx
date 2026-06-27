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

import React, { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import type { RestaurantTable, TableStatus } from '../../types/tables';
import { formatTableDisplayNumber } from '../../utils/table-display';
import {
  useBackgroundAccessibilityIsolation,
  MODAL_VIEWPORT_ATTR,
} from '../ui/pos-glass-components';
import { X, ShoppingCart, Calendar, Users, LayoutGrid, Clock, Minus, Plus, CheckCircle2, Pencil, UserX, Ban, ChevronRight } from 'lucide-react';

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
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setGuestCount(Math.max(1, Number(table.guestCount || 1)));
  }, [table.id, table.guestCount]);

  // Escape closes the table action modal, matching the rest of the app-level POS
  // modals. Only the topmost [role="dialog"] responds, so a child dialog opened above
  // this one (e.g. the reservation form) closes first, and this modal is left in
  // control while it is the frontmost. Action callbacks never call onClose (the
  // parent owns that), so Escape -> onClose cannot race with them.
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
      onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

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
      color: 'text-red-500',
      bgClass: 'bg-red-500/10 border-red-500/30'
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

  // While open, hide the background POS app (sidebar, order tabs, table grid, FAB) from assistive
  // tech + focus, reusing the shared ref-counted isolation from the glass modals (round 199). The
  // portal root below is marked as a viewport root so the isolation skip-check never hides this modal.
  useBackgroundAccessibilityIsolation(isOpen);

  if (!isOpen) return null;

  const currentStatus = statusConfig[table.status];

  const modalContent = (
    // z-[1200] = POS app-modal layer: above the sidebar (z-50), FAB (z-[900]) and
    // content, below the custom titlebar. Required in addition to the portal so the
    // backdrop/blur actually stacks over the full app shell, not just escapes the grid.
    // The data-liquid-glass-modal-viewport marker (shared MODAL_VIEWPORT_ATTR) makes the
    // round-199 background-isolation skip-check leave this modal visible while hiding the app.
    <div {...{ [MODAL_VIEWPORT_ATTR]: '' }} className="fixed inset-0 z-[1200] flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal -- shared liquid-glass shell so this matches the TableSelector / Settings / Order Type
          glass modals: premium blurred translucent glass, soft glow edge, 28px rounded corners, and the
          shared open animation. Behaviour (portal, z-[1200], role=dialog, Escape, isolation) is unchanged. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="table-action-modal-title"
        data-table-action-modal
        className="liquid-glass-modal-shell relative mx-4 w-full max-w-md"
      >
        {/* Header (shared glass header/title/close tokens; lucide X, not a manual SVG) */}
        <div className="liquid-glass-modal-header">
          <h2 id="table-action-modal-title" className="liquid-glass-modal-title">
            {t('tableActionModal.title', { defaultValue: 'Table Actions' })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="liquid-glass-modal-close active:scale-95"
            aria-label={t('common.actions.close', { defaultValue: 'Close' })}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable content -- hidden scrollbar, like the other glass modals */}
        <div className="liquid-glass-modal-content scrollbar-hide overflow-x-hidden">
          <div className="space-y-4">
            {/* Table details card (keeps the semantic status tint) */}
            <div className={`rounded-2xl p-4 border ${currentStatus.bgClass}`}>
              <div className="flex items-center gap-4">
                {/* Table Icon */}
                <div className="rounded-xl bg-white/50 p-3 dark:bg-white/10">
                  <LayoutGrid className={`h-8 w-8 ${currentStatus.color}`} />
                </div>

                {/* Table Info */}
                <div className="flex-1">
                  <div className="text-2xl font-bold liquid-glass-modal-text">
                    {t('tableActionModal.tableNumber', { defaultValue: 'Table' })} {formatTableDisplayNumber(table.tableNumber)}
                  </div>
                  <div className="mt-1 flex items-center gap-4">
                    {/* Capacity */}
                    <div className="flex items-center gap-1 text-sm liquid-glass-modal-text-muted">
                      <Users className="h-4 w-4" />
                      <span>{table.capacity} {t('tableActionModal.guests', {
                        count: table.capacity,
                        defaultValue: table.capacity === 1 ? 'guest' : 'guests',
                      })}</span>
                    </div>
                    {/* Status */}
                    <div className={`flex items-center gap-1 text-sm ${currentStatus.color}`}>
                      <Clock className="h-4 w-4" />
                      <span>{currentStatus.label}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Notes if any (user/org data -- never translated) */}
              {table.notes && (
                <div className="mt-3 border-t pt-3 text-sm liquid-glass-modal-border liquid-glass-modal-text-muted">
                  {table.notes}
                </div>
              )}

              <div className="mt-4 border-t pt-4 liquid-glass-modal-border">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold liquid-glass-modal-text">
                      {t('tableActionModal.covers', { defaultValue: 'Covers' })}
                    </div>
                    <div className="text-xs liquid-glass-modal-text-muted">
                      {t('tableActionModal.coversDescription', { defaultValue: 'Guests on this check' })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setGuestCount((value) => Math.max(1, value - 1))}
                      className="inline-flex h-11 w-11 items-center justify-center rounded-xl border liquid-glass-modal-border liquid-glass-modal-text transition active:scale-95 active:bg-black/5 dark:active:bg-white/10"
                      aria-label={t('tableActionModal.decreaseCovers', { defaultValue: 'Decrease covers' })}
                    >
                      <Minus className="h-4 w-4" />
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
                      aria-label={t('tableActionModal.covers', { defaultValue: 'Covers' })}
                      className="h-11 w-16 rounded-xl border px-2 text-center font-semibold liquid-glass-modal-border liquid-glass-modal-text bg-white/50 dark:bg-black/20"
                    />
                    <button
                      type="button"
                      onClick={() => setGuestCount((value) => Math.min(99, value + 1))}
                      className="inline-flex h-11 w-11 items-center justify-center rounded-xl border liquid-glass-modal-border liquid-glass-modal-text transition active:scale-95 active:bg-black/5 dark:active:bg-white/10"
                      aria-label={t('tableActionModal.increaseCovers', { defaultValue: 'Increase covers' })}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {typeof table.unpaidBalance === 'number' && table.unpaidBalance > 0 && (
                  <div className="mt-3 text-sm liquid-glass-modal-text-muted">
                    {t('tableActionModal.unpaidBalance', {
                      defaultValue: 'Open balance: {{amount}}',
                      amount: table.unpaidBalance.toFixed(2),
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="space-y-3">
              {/* New Order Button - Requirements 3.2, 3.3 */}
              <button
                onClick={handleNewOrder}
                disabled={blocksGuestActions}
                aria-disabled={blocksGuestActions}
                className={`w-full p-4 rounded-xl border-2 transition-all duration-200 active:scale-[0.98] ${
                  blocksGuestActions
                    ? isDark
                      ? 'cursor-not-allowed bg-white/5 border-white/10 opacity-60'
                      : 'cursor-not-allowed bg-gray-100 border-gray-200 opacity-70'
                    : isDark
                      ? 'bg-yellow-400/15 border-yellow-400/40 active:bg-yellow-400/25'
                      : '!bg-yellow-400 border-yellow-500 active:!bg-yellow-500 shadow-lg shadow-yellow-500/30'
                }`}
              >
                <div className="flex items-center gap-4">
                  {/* Icon */}
                  <div className={`p-3 rounded-xl ${
                    isDark ? 'bg-yellow-400/20' : 'bg-black/10'
                  }`}>
                    <ShoppingCart className={`w-6 h-6 ${isDark ? 'text-yellow-300' : 'text-gray-900'}`} />
                  </div>

                  {/* Text */}
                  <div className="flex-1 text-left">
                    <div className={`text-lg font-bold ${isDark ? 'text-yellow-300' : 'text-gray-900'}`}>
                      {t('tableActionModal.newOrder', { defaultValue: 'New Order' })}
                    </div>
                    <div className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-700'}`}>
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

                  {/* Arrow (lucide, not a manual SVG) */}
                  <ChevronRight className={`h-6 w-6 shrink-0 ${isDark ? 'text-yellow-300' : 'text-gray-900'}`} />
                </div>
              </button>

              {blocksGuestActions && (
                <button
                  onClick={handleSetAvailable}
                  className={`w-full p-4 rounded-xl border-2 transition-all duration-200 active:scale-[0.98] ${
                    isDark
                      ? 'bg-emerald-500/10 border-emerald-500/30 active:bg-emerald-500/20'
                      : 'bg-emerald-50 border-emerald-200 active:bg-emerald-100'
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
                    className={`w-full p-4 rounded-xl border-2 transition-all duration-200 active:scale-[0.98] ${
                      isDark
                        ? 'bg-amber-500/10 border-amber-500/30 active:bg-amber-500/20'
                        : 'bg-amber-50 border-amber-200 active:bg-amber-100'
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
                    className={`w-full p-4 rounded-xl border-2 transition-all duration-200 active:scale-[0.98] ${
                      isDark
                        ? 'bg-slate-500/10 border-slate-500/30 active:bg-slate-500/20'
                        : 'bg-slate-50 border-slate-200 active:bg-slate-100'
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
                    className={`w-full p-4 rounded-xl border-2 transition-all duration-200 active:scale-[0.98] sm:col-span-2 ${
                      isDark
                        ? 'bg-red-500/10 border-red-500/30 active:bg-red-500/20'
                        : 'bg-red-50 border-red-200 active:bg-red-100'
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
                  className={`w-full p-4 rounded-xl border-2 transition-all duration-200 active:scale-[0.98] ${
                    isMaintenanceTable || isUnavailableTable
                      ? isDark
                        ? 'cursor-not-allowed bg-white/5 border-white/10 opacity-60'
                        : 'cursor-not-allowed bg-gray-100 border-gray-200 opacity-70'
                      : isDark
                        ? 'bg-amber-500/10 border-amber-500/30 active:bg-amber-500/20'
                        : 'bg-amber-50 border-amber-200 active:bg-amber-100'
                  }`}
                >
                  <div className="flex items-center gap-4">
                    {/* Icon */}
                    <div className={`p-3 rounded-xl ${
                      isDark ? 'bg-amber-500/20' : 'bg-amber-100'
                    }`}>
                      <Calendar className="w-6 h-6 text-amber-500" />
                    </div>

                    {/* Text */}
                    <div className="flex-1 text-left">
                      <div className="text-lg font-bold text-amber-500">
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

                    {/* Arrow (lucide, not a manual SVG) */}
                    <ChevronRight className="h-6 w-6 shrink-0 text-amber-500" />
                  </div>
                </button>
              )}
            </div>

            {/* Footer hint */}
            <div className="text-center text-xs liquid-glass-modal-text-muted">
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
      </div>
    </div>
  );

  // Render at the app-shell level so the backdrop/blur covers the full POS viewport
  // (sidebar + outer shell) instead of being clipped by a transformed/overflow
  // ancestor in the table grid. Mirrors TableCheckManagerModal's portal pattern.
  if (typeof document === 'undefined' || !document.body) {
    return modalContent;
  }

  return createPortal(modalContent, document.body);
});

TableActionModal.displayName = 'TableActionModal';

export default TableActionModal;
