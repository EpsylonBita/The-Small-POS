import { beforeEach, describe, expect, it, vi } from 'vitest';

// Item E, fix review 30/09/2026. A card charged at checkout whose order the
// till could not save is thrown by OrderService as `paymentNotSaved`. The
// store used to flatten it into a generic `{ success: false, error }` the
// checkout screens read as "try again" (a new checkout, a second charge).
// Its details must reach the screen so it tells the cashier "charged, not
// saved, do not charge again" and ends the checkout.

const { createOrder } = vi.hoisted(() => ({ createOrder: vi.fn() }));

vi.mock('../../../lib', () => ({
  getBridge: () => ({ invoke: vi.fn() }),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

vi.mock('../../../services/OrderService', () => ({
  OrderService: {
    getInstance: () => ({ fetchOrders: vi.fn(), createOrder }),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import { useOrderStore } from '../useOrderStore';

const UNSAVED = {
  idempotencyKey: 'terminal-card:fiscal-txn-checkout-1',
  kind: 'new_order_checkout',
  amount: 13,
  amountCents: 1300,
};

describe('useOrderStore.createOrder: charged, not saved', () => {
  beforeEach(() => {
    createOrder.mockReset();
  });

  it('keeps the not-saved details for the checkout screen', async () => {
    createOrder.mockRejectedValue(
      Object.assign(new Error('The card was charged 13.00, but the payment could not be saved.'), {
        code: 'PAYMENT_NOT_SAVED',
        errorCode: 'PAYMENT_NOT_SAVED',
        paymentNotSaved: true,
        orderPersisted: false,
        amountCents: 1300,
        unsavedPayment: UNSAVED,
      }),
    );

    const result = await useOrderStore.getState().createOrder({
      items: [{ id: 'item-1', name: 'Crepe', quantity: 1, price: 13 }] as any,
    });

    expect(result.success).toBe(false);
    expect(result.paymentNotSaved).toBe(true);
    expect(result.errorCode).toBe('PAYMENT_NOT_SAVED');
    expect(result.amountCents).toBe(1300);
    expect(result.unsavedPayment).toEqual(UNSAVED);
    expect(result.savedForRetry).toBe(false);
  });

  it('leaves any other failure as it was', async () => {
    createOrder.mockRejectedValue(new Error('Branch ID not configured.'));

    const result = await useOrderStore.getState().createOrder({
      items: [{ id: 'item-1', name: 'Crepe', quantity: 1, price: 13 }] as any,
    });

    expect(result.success).toBe(false);
    expect(result.paymentNotSaved).toBeUndefined();
  });
});
