import { beforeEach, describe, expect, it, vi } from 'vitest';

// Item D5 (founder rule 30/09 and 01/10/2026: order → payment → grid; an
// order is never paid without its payment record). After a create, the
// service reads the stored order back. When that read failed, the store put
// the caller's `completed` claim on screen: the grid showed a paid order the
// till had stored as pending (no payment row yet). The label now comes from
// storage only; without the stored row it is `pending` until the refresh.

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

const checkout = {
  items: [{ id: 'item-1', name: 'Synthetic crepe', quantity: 1, price: 9, totalPrice: 9 }],
  totalAmount: 9,
  orderType: 'pickup',
  paymentStatus: 'completed',
  payment_status: 'completed',
  paymentMethod: 'cash',
} as const;

describe('useOrderStore.createOrder: the label on screen comes from storage', () => {
  beforeEach(() => {
    createOrder.mockReset();
    useOrderStore.setState({ orders: [], pendingExternalOrders: [] });
  });

  it('shows pending, never the caller claim, when the stored order could not be read back', async () => {
    // OrderService's fallback after a successful create whose getById failed:
    // the identity only, no stored row.
    createOrder.mockResolvedValue({ id: 'order-created-1', clientRequestId: 'req-1' });

    const result = await useOrderStore.getState().createOrder(checkout as any);

    expect(result.success).toBe(true);
    const stored = useOrderStore.getState().orders.find((order) => order.id === 'order-created-1');
    expect(stored?.paymentStatus).toBe('pending');
    expect((stored as any)?.payment_status).toBe('pending');
  });

  it('shows the stored label when the order was read back', async () => {
    createOrder.mockResolvedValue({
      id: 'order-created-2',
      paymentStatus: 'paid',
      status: 'pending',
    });

    await useOrderStore.getState().createOrder(checkout as any);

    const stored = useOrderStore.getState().orders.find((order) => order.id === 'order-created-2');
    expect(stored?.paymentStatus).toBe('paid');
  });
});
