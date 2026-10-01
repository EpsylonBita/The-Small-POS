import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { RestaurantTable, TableStatus } from '../../../types/tables';

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' }),
}));

import { TableActionModal } from '../TableActionModal';

afterEach(() => cleanup());

const table = (status: TableStatus): RestaurantTable => ({
  id: 'table-7',
  organizationId: 'org-1',
  branchId: 'branch-1',
  tableNumber: 7,
  capacity: 4,
  status,
  positionX: null,
  positionY: null,
  shape: null,
  notes: null,
  createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T00:00:00.000Z',
});

const renderModal = (status: TableStatus, extra: { canCreateReservation?: boolean } = {}) => {
  const handlers = {
    onNewOrder: vi.fn(),
    onNewReservation: vi.fn(),
    onSetAvailable: vi.fn(),
    onEditReservation: vi.fn(),
    onNoShowReservation: vi.fn(),
    onCancelReservation: vi.fn(),
    onClose: vi.fn(),
  };
  render(<TableActionModal isOpen table={table(status)} {...handlers} {...extra} />);
  return handlers;
};

// Booking a table needs the Reservations module, as on the Android POS.
describe('TableActionModal New Reservation and the Reservations module', () => {
  it('offers New Reservation for an available table when the store can book', () => {
    const handlers = renderModal('available', { canCreateReservation: true });

    fireEvent.click(screen.getByText('tableActionModal.newReservation'));
    expect(handlers.onNewReservation).toHaveBeenCalledTimes(1);
  });

  it('keeps New Reservation for callers that say nothing (default)', () => {
    renderModal('available');

    expect(screen.getByText('tableActionModal.newReservation')).toBeTruthy();
  });

  it('hides New Reservation without the Reservations module, keeping New Order', () => {
    const handlers = renderModal('available', { canCreateReservation: false });

    expect(screen.queryByText('tableActionModal.newReservation')).toBeNull();
    fireEvent.click(screen.getByText('tableActionModal.newOrder'));
    expect(handlers.onNewOrder).toHaveBeenCalledTimes(1);
  });

  it('still lets staff manage an existing reservation without the module', () => {
    const handlers = renderModal('reserved', { canCreateReservation: false });

    fireEvent.click(screen.getByText('tableActionModal.editReservation'));
    fireEvent.click(screen.getByText('tableActionModal.noShowReservation'));
    fireEvent.click(screen.getByText('tableActionModal.cancelReservation'));
    expect(handlers.onEditReservation).toHaveBeenCalledTimes(1);
    expect(handlers.onNoShowReservation).toHaveBeenCalledTimes(1);
    expect(handlers.onCancelReservation).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('tableActionModal.newReservation')).toBeNull();
  });
});
