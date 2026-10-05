import React, { memo, useEffect, useState } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import type { RestaurantTable, TableStatus } from '../../types/tables';
import { formatTableDisplayNumber } from '../../utils/table-display';
import { formatCurrency } from '../../utils/format';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { ShoppingCart, Calendar, Users, Minus, Plus, CheckCircle2, Pencil, UserX, Ban } from 'lucide-react';
import './table-action-modal.css';

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
  /** Creating bookings needs the module; managing existing bookings remains available. */
  canCreateReservation?: boolean;
}

const normalizeCovers = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.min(99, Math.trunc(numeric))) : 1;
};

export const TableActionModal: React.FC<TableActionModalProps> = memo(({
  table, onNewOrder, onNewReservation, onSetAvailable, onEditReservation,
  onNoShowReservation, onCancelReservation, onClose, isOpen, canCreateReservation = true,
}) => {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const [guestCount, setGuestCount] = useState(() => normalizeCovers(table.guestCount || 1));
  useEffect(() => { setGuestCount(normalizeCovers(table.guestCount || 1)); }, [table.id, table.guestCount]);

  const statusLabels: Record<TableStatus, string> = {
    available: t('tableActionModal.status.available', { defaultValue: 'Available' }),
    reserved: t('tableActionModal.status.reserved', { defaultValue: 'Reserved' }),
    occupied: t('tableActionModal.status.occupied', { defaultValue: 'Occupied' }),
    cleaning: t('tableActionModal.status.cleaning', { defaultValue: 'Cleaning' }),
    maintenance: t('tableActionModal.status.maintenance', { defaultValue: 'Maintenance' }),
    unavailable: t('tableActionModal.status.unavailable', { defaultValue: 'Unavailable' }),
  };
  const isCleaningTable = table.status === 'cleaning';
  const isMaintenanceTable = table.status === 'maintenance';
  const isUnavailableTable = table.status === 'unavailable';
  const isReservedTable = table.status === 'reserved';
  const blocksGuestActions = isCleaningTable || isMaintenanceTable || isUnavailableTable;
  // The parent owns lifecycle so actions can open the next dialog without double closing.
  const handleNewOrder = () => { if (!blocksGuestActions) onNewOrder(guestCount); };
  const handleNewReservation = () => { if (!isMaintenanceTable && !isUnavailableTable) onNewReservation(); };
  const handleSetAvailable = () => { onSetAvailable(); };
  const handleEditReservation = () => { onEditReservation?.(); };
  const handleNoShowReservation = () => { onNoShowReservation?.(); };
  const handleCancelReservation = () => { onCancelReservation?.(); };
  const newOrderDescription = isCleaningTable
    ? t('tableActionModal.newOrderCleaningDisabled', { defaultValue: 'Mark the table cleaned before taking a new order' })
    : isMaintenanceTable
      ? t('tableActionModal.newOrderMaintenanceDisabled', { defaultValue: 'Return this table to service before taking a new order' })
      : isUnavailableTable
        ? t('tableActionModal.newOrderUnavailableDisabled', { defaultValue: 'Make this table available before taking a new order' })
        : t('tableActionModal.newOrderDescription', { defaultValue: 'Start a new order for this table' });
  const hint = isCleaningTable
    ? t('tableActionModal.cleaningHint', { defaultValue: 'Set the table as cleaned to make it available for orders' })
    : isMaintenanceTable
      ? t('tableActionModal.maintenanceHint', { defaultValue: 'Maintenance tables are out of service until marked back in service' })
      : isReservedTable
        ? t('tableActionModal.reservedHint', { defaultValue: 'Manage this reservation or start the table order when guests arrive' })
        : isUnavailableTable
          ? t('tableActionModal.unavailableHint', { defaultValue: 'Set the table available before using it for guests' })
          : t('tableActionModal.hint', { defaultValue: 'Select an action to continue' });

  const action = (label: string, icon: React.ReactNode, onClick: () => void, description?: string, disabled = false, variant = '') => (
    <div>
      <button type="button" className={`table-action-button ${variant}`} onClick={onClick} disabled={disabled} aria-disabled={disabled}>
        {icon}{label}
      </button>
      {description && <p className="table-action-description">{description}</p>}
    </div>
  );

  return <LiquidGlassModal isOpen={isOpen} onClose={onClose} closeMode="request"
    title={t('tableActionModal.title', { defaultValue: 'Table Actions' })} size="md" blur={false}
    className={`table-action-dialog table-action-dialog--${resolvedTheme}`} contentClassName="table-action-body">
    <section className="table-action-details" data-table-action-modal>
      <h3>{t('tableActionModal.tableNumber', { defaultValue: 'Table' })} {formatTableDisplayNumber(table.tableNumber)}</h3>
      <div className="table-action-status" data-status={table.status}><span className="table-action-status-dot" aria-hidden="true" />{statusLabels[table.status]}</div>
      <div className="table-action-capacity"><Users size={16} aria-hidden="true" /><span>{table.capacity} {t('tableActionModal.guests', {
        count: table.capacity, defaultValue: table.capacity === 1 ? 'guest' : 'guests',
      })}</span></div>
      {table.notes && <p className="table-action-notes">{table.notes}</p>}
    </section>
    <div className="table-action-covers">
      <div className="table-action-covers-copy"><label htmlFor="table-action-covers">{t('tableActionModal.covers', { defaultValue: 'Covers' })}</label>
        <p>{t('tableActionModal.coversDescription', { defaultValue: 'Guests on this check' })}</p></div>
      <div className="table-action-stepper">
        <button type="button" onClick={() => setGuestCount(value => Math.max(1, value - 1))} disabled={guestCount <= 1}
          aria-label={t('tableActionModal.decreaseCovers', { defaultValue: 'Decrease covers' })}><Minus size={18} aria-hidden="true" /></button>
        <input id="table-action-covers" type="text" inputMode="numeric" pattern="[0-9]*" value={guestCount} onChange={event => setGuestCount(normalizeCovers(event.target.value))} />
        <button type="button" onClick={() => setGuestCount(value => Math.min(99, value + 1))} disabled={guestCount >= 99}
          aria-label={t('tableActionModal.increaseCovers', { defaultValue: 'Increase covers' })}><Plus size={18} aria-hidden="true" /></button>
      </div>
    </div>
    {typeof table.unpaidBalance === 'number' && table.unpaidBalance > 0 && <p className="table-action-balance">{t('tableActionModal.unpaidBalance', {
      defaultValue: 'Open balance: {{amount}}', amount: formatCurrency(table.unpaidBalance),
    })}</p>}
    <div className="table-action-list">
      {action(t('tableActionModal.newOrder', { defaultValue: 'New Order' }), <ShoppingCart size={20} aria-hidden="true" />, handleNewOrder, newOrderDescription, blocksGuestActions, 'table-action-button--primary')}
      {blocksGuestActions && action(isCleaningTable ? t('tableActionModal.markCleaned', { defaultValue: 'Cleaned' })
        : isMaintenanceTable ? t('tableActionModal.markBackInService', { defaultValue: 'Back in service' })
          : t('tableActionModal.markAvailable', { defaultValue: 'Set Available' }), <CheckCircle2 size={20} aria-hidden="true" />, handleSetAvailable,
        isMaintenanceTable ? t('tableActionModal.markBackInServiceDescription', { defaultValue: 'Set this table as available after maintenance' })
          : t('tableActionModal.markAvailableDescription', { defaultValue: 'Set this table as available for orders' }), false, 'table-action-button--primary')}
      {isReservedTable && <>
        {action(t('tableActionModal.editReservation', { defaultValue: 'Edit Reservation' }), <Pencil size={18} aria-hidden="true" />, handleEditReservation,
          t('tableActionModal.editReservationDescription', { defaultValue: 'Change time, guests, or notes' }), !onEditReservation)}
        {action(t('tableActionModal.noShowReservation', { defaultValue: 'No Show' }), <UserX size={18} aria-hidden="true" />, handleNoShowReservation,
          t('tableActionModal.noShowReservationDescription', { defaultValue: 'Guest did not arrive' }), !onNoShowReservation)}
        {action(t('tableActionModal.cancelReservation', { defaultValue: 'Cancel Reservation' }), <Ban size={18} aria-hidden="true" />, handleCancelReservation,
          t('tableActionModal.cancelReservationDescription', { defaultValue: 'Cancel booking and release table' }), !onCancelReservation, 'table-action-button--danger')}
      </>}
      {canCreateReservation && !isReservedTable && action(t('tableActionModal.newReservation', { defaultValue: 'New Reservation' }), <Calendar size={20} aria-hidden="true" />, handleNewReservation,
        isMaintenanceTable || isUnavailableTable ? t('tableActionModal.newReservationUnavailableDescription', { defaultValue: 'Return this table to service before booking' })
          : t('tableActionModal.newReservationDescription', { defaultValue: 'Book this table for a future time' }), isMaintenanceTable || isUnavailableTable)}
    </div>
    <p className="table-action-hint">{hint}</p>
  </LiquidGlassModal>;
});
TableActionModal.displayName = 'TableActionModal';
export default TableActionModal;
