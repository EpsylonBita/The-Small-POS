import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix review 30/09/2026 (double charge on a slow card terminal). The store
// gave up on every create after 15 s and answered a plain failure while the
// fiscal device still waited for the card (up to 120 s); the checkout screens
// let the cashier press Pay again, a second checkout and a second charge. A
// checkout carrying its payment now waits past the terminal's own timeout,
// and one still without an answer is reported as unknown, never as failed.

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

const items = [{ id: 'item-1', name: 'Crepe', quantity: 1, price: 13 }] as any;

describe('useOrderStore.createOrder: a checkout without an answer yet', () => {
  beforeEach(() => {
    createOrder.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps waiting on the card terminal past 15 s', async () => {
    let answer: (order: unknown) => void = () => undefined;
    createOrder.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    const pending = useOrderStore.getState().createOrder({
      clientRequestId: 'checkout-request-slow-1',
      items,
      initialPayment: { method: 'card', amount: 13 },
    } as any);
    await vi.advanceTimersByTimeAsync(40_000);
    // The customer taps the card after 40 s: the order is created.
    answer({ id: 'order-1', orderNumber: 'ORD-30092026-00001' });

    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.orderId).toBe('order-1');
  });

  it('reports a checkout still without an answer as unknown, never as failed', async () => {
    createOrder.mockReturnValue(new Promise(() => undefined));

    const pending = useOrderStore.getState().createOrder({
      clientRequestId: 'checkout-request-slow-1',
      items,
      initialPayment: { method: 'card', amount: 13 },
    } as any);
    await vi.advanceTimersByTimeAsync(181_000);

    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.outcomeUnknown).toBe(true);
    expect(result.errorCode).toBe('CHECKOUT_OUTCOME_UNKNOWN');
  });

  it('reports the same checkout still in progress as unknown', async () => {
    createOrder.mockRejectedValue(
      Object.assign(new Error('This checkout is still in progress on the card terminal.'), {
        code: 'CHECKOUT_IN_PROGRESS',
        checkoutInProgress: true,
      }),
    );

    const result = await useOrderStore.getState().createOrder({
      clientRequestId: 'checkout-request-slow-1',
      items,
      initialPayment: { method: 'card', amount: 13 },
    } as any);

    expect(result.success).toBe(false);
    expect(result.outcomeUnknown).toBe(true);
    expect(result.errorCode).toBe('CHECKOUT_IN_PROGRESS');
  });

  it('keeps the short timeout for an order without a payment', async () => {
    createOrder.mockReturnValue(new Promise(() => undefined));

    const pending = useOrderStore.getState().createOrder({ items } as any);
    await vi.advanceTimersByTimeAsync(16_000);

    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.outcomeUnknown).toBeUndefined();
  });
});
