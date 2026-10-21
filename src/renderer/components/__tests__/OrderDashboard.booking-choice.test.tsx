import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../../contexts/i18n-context', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../ui/pos-glass-components', async original => ({
  ...(await original<typeof import('../ui/pos-glass-components')>()),
  LiquidGlassModal: ({ isOpen, children }: any) => isOpen ? <div role="dialog">{children}</div> : null,
}));
import { TableBookingChoice } from '../OrderDashboard';
afterEach(cleanup);
const reservation = { id: 'evening', customerName: 'Evening guest', reservationTime: '20:00' } as any;

it('requires an explicit choice and keeps walk-in separate from seating the booking', () => {
  const walkIn = vi.fn(), seat = vi.fn();
  render(<TableBookingChoice reservation={reservation} busy={false} onClose={vi.fn()} onWalkIn={walkIn} onSeat={seat} />);
  expect(seat).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'verticalReadinessDesk.walkIn' }));
  expect(walkIn).toHaveBeenCalledOnce();
  expect(seat).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'verticalReadinessDesk.seatBooking' }));
  expect(seat).toHaveBeenCalledOnce();
});
it('blocks repeated party choices while the canonical action is pending', () => {
  render(<TableBookingChoice reservation={reservation} busy onClose={vi.fn()} onWalkIn={vi.fn()} onSeat={vi.fn()} />);
  expect(screen.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled)).toBe(true);
});
it('forwards session customer identity and exposes salon split through the ordinary payment callback', () => {
  const dashboard = readFileSync('src/renderer/components/OrderDashboard.tsx', 'utf8');
  const menu = readFileSync('src/renderer/components/modals/MenuModal.tsx', 'utf8');
  expect(dashboard).toContain('id: session?.metadata?.customer_id || session?.customer_id');
  expect(dashboard).toContain('isTableOrder ? tableCustomerId : undefined');
  expect(menu).toContain('onSplitPayment={onOrderComplete ? handleSplitPayment : undefined}');
  const shortcut = dashboard.slice(dashboard.indexOf('const handleTableNewOrder ='), dashboard.indexOf('// Handle New Reservation action'));
  expect(shortcut).toContain('setBookingChoice(');
  expect(shortcut).not.toContain('seatReservation(');
});
