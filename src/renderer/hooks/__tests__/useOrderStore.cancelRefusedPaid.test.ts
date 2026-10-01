import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fix review 30/09/2026 (founder rule). The till refuses to cancel an order
// money was taken on (`ORDER_HAS_PAYMENTS`). The store used to flatten the
// refusal into a generic failure ("Failed to cancel order"): the cashier was
// never told to void or refund the payment first. The refusal now reaches the
// screen typed.

const { updateOrderStatus } = vi.hoisted(() => ({ updateOrderStatus: vi.fn() }));

vi.mock('../../../lib', () => ({
  getBridge: () => ({ invoke: vi.fn() }),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

vi.mock('../../../services/OrderService', () => ({
  OrderService: {
    getInstance: () => ({ fetchOrders: vi.fn(), updateOrderStatus }),
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

describe('useOrderStore.updateOrderStatusDetailed: a cancel refused for money taken', () => {
  beforeEach(() => {
    updateOrderStatus.mockReset();
  });

  it('reports the refusal typed', async () => {
    // OrderService rethrows the till's answer as the message.
    updateOrderStatus.mockRejectedValue(
      new Error(
        'ORDER_HAS_PAYMENTS: money was taken on this order. Void or refund it from the order first, or collect the rest.',
      ),
    );

    const result = await useOrderStore
      .getState()
      .updateOrderStatusDetailed('order-paid', 'cancelled', { cancellationReason: 'Changed mind' });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('ORDER_HAS_PAYMENTS');
  });

  // Founder rule 01/10/2026: a paid label with no payment record here.
  it('reports a paid label with no payment record typed', async () => {
    updateOrderStatus.mockRejectedValue(
      new Error(
        'ORDER_PAYMENT_NOT_RECORDED: this order is marked paid, but its payment is not recorded on this till. Restore it from the server (Sync Now), or record the payment from the Z report, then cancel.',
      ),
    );

    const result = await useOrderStore
      .getState()
      .updateOrderStatusDetailed('order-paid-no-row', 'cancelled', { cancellationReason: 'Left' });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('ORDER_PAYMENT_NOT_RECORDED');
  });

  it('leaves any other failure untyped', async () => {
    updateOrderStatus.mockRejectedValue(new Error('Invalid status transition: completed -> cancelled'));

    const result = await useOrderStore
      .getState()
      .updateOrderStatusDetailed('order-done', 'cancelled');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBeUndefined();
  });
});
