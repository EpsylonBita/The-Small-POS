import { describe, expect, it } from 'vitest';
import {
  canChangeOrderDriver,
  currentOrderDriver,
  driverChangeErrorCode,
  driverChangeErrorKey,
} from '../driverChange';
import en from '../../../locales/en.json';

// Founder request (Tomikro 26/10/2026): the cashier picked the wrong driver
// for a delivery that is now in the delivered list. "Change driver" is
// offered for a delivery order in any non-cancelled status.
describe('change driver eligibility', () => {
  it('is offered for a delivered or completed delivery order', () => {
    for (const status of ['pending', 'ready', 'out_for_delivery', 'delivered', 'completed']) {
      expect(canChangeOrderDriver({ status, orderType: 'delivery' })).toBe(true);
      expect(canChangeOrderDriver({ status, order_type: 'delivery' })).toBe(true);
    }
  });

  it('is never offered for a cancelled or refunded order', () => {
    for (const status of ['cancelled', 'canceled', 'refunded', ' Cancelled ']) {
      expect(canChangeOrderDriver({ status, orderType: 'delivery' })).toBe(false);
    }
  });

  it('is never offered for pickup, dine-in or no order', () => {
    expect(canChangeOrderDriver({ status: 'delivered', orderType: 'pickup' })).toBe(false);
    expect(canChangeOrderDriver({ status: 'completed', orderType: 'dine-in' })).toBe(false);
    expect(canChangeOrderDriver(null)).toBe(false);
  });

  it('reads the current driver from either field spelling', () => {
    expect(currentOrderDriver({ driverId: 'd-1', driverName: 'Nikos' })).toEqual({ id: 'd-1', name: 'Nikos' });
    expect(currentOrderDriver({ driver_id: 'd-2', driver_name: ' ' })).toEqual({ id: 'd-2', name: null });
    expect(currentOrderDriver({ status: 'delivered' })).toBeNull();
  });
});

describe('change driver refusals', () => {
  it('maps every native refusal code to an English message', () => {
    const cases: Array<[string, string]> = [
      ['DRIVER_CHANGE_SHIFT_CLOSED: The driver\'s shift is closed', 'shiftClosed'],
      ['DRIVER_CHANGE_NEW_DRIVER_OFF_SHIFT: not checked in', 'newDriverOffShift'],
      ['DRIVER_CHANGE_CANCELLED: cancelled', 'cancelled'],
      ['DRIVER_CHANGE_ADJUSTED_ORDER: refund', 'adjustedOrder'],
      ['DRIVER_CHANGE_SAME_DRIVER: same', 'sameDriver'],
      ['DRIVER_CHANGE_SYNC_IN_PROGRESS: sending', 'syncInProgress'],
      ['DRIVER_CHANGE_CURRENCY_MISMATCH: currency', 'currencyMismatch'],
      ['DRIVER_CHANGE_MONEY_CHANGED: money', 'moneyChanged'],
      ['DRIVER_CHANGE_PLATFORM_FLEET: platform', 'platformFleet'],
      ['DRIVER_CHANGE_NOT_DELIVERY: pickup', 'notDelivery'],
      ['database is locked', 'failed'],
    ];
    const errors = (en as any).orderDashboard.driverChange.errors as Record<string, string>;
    for (const [raw, leaf] of cases) {
      const key = driverChangeErrorKey(new Error(raw));
      expect(key).toBe(`orderDashboard.driverChange.errors.${leaf}`);
      expect(typeof errors[leaf]).toBe('string');
    }
  });

  it('reads the code from a rejected invoke string or an IPC result', () => {
    expect(driverChangeErrorCode('DRIVER_CHANGE_SHIFT_CLOSED: closed')).toBe('DRIVER_CHANGE_SHIFT_CLOSED');
    expect(driverChangeErrorCode({ success: false, error: 'DRIVER_CHANGE_SAME_DRIVER: same' })).toBe(
      'DRIVER_CHANGE_SAME_DRIVER',
    );
    expect(driverChangeErrorCode(undefined)).toBeNull();
  });
});
