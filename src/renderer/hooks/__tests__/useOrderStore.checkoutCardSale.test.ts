import { beforeEach, describe, expect, it, vi } from 'vitest';

// Founder 01/11/2026 (a split saves its order only with its first payment). A card SALE the checkout took before its
// order existed, not recorded or not known yet, comes back from OrderService as `checkoutCardSale`. A generic
// `{ success: false }` reads as "try again" (another payment); the screen must get the cashier's sentence and the code.

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

const refused = (errorCode: string) =>
  Object.assign(new Error('refused by the till'), {
    code: errorCode,
    errorCode,
    checkoutCardSale: true,
    amountCents: 1300,
    currency: 'EUR',
  });

describe('useOrderStore.createOrder: a checkout card SALE not recorded or not known', () => {
  beforeEach(() => {
    createOrder.mockReset();
  });

  it.each([
    ['CHECKOUT_CARD_SALE_UNRECORDED', /already charged/i],
    ['CHECKOUT_CARD_SALE_UNRESOLVED', /did not answer/i],
  ])('%s keeps its code, amount and the cashier sentence', async (errorCode, sentence) => {
    createOrder.mockRejectedValue(refused(errorCode));
    const result = await useOrderStore.getState().createOrder({
      items: [{ id: 'item-1', name: 'Crepe', quantity: 2, price: 13 }] as any,
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(errorCode);
    expect(result.amountCents).toBe(1300);
    expect(result.savedForRetry).toBe(false);
    expect(result.error).toMatch(sentence);
    expect(result.error).toMatch(/13/);
  });
});
