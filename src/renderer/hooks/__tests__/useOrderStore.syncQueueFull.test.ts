import { beforeEach, describe, expect, it, vi } from 'vitest';

// Offline-week audit (13/10/2026). At its ceiling the till's offline queue
// refuses a sale or an order change before anything changes, typed
// `SYNC_QUEUE_FULL` (sync_queue.rs). The checkout screens toast the store's
// `error` and the status screens its `errorMessage`: both are the cashier's
// sentence in the store's language, never the native English, and the code
// reaches the screen.

const { createOrder, updateOrderStatus } = vi.hoisted(() => ({
  createOrder: vi.fn(),
  updateOrderStatus: vi.fn(),
}));

vi.mock('../../../lib', () => ({
  getBridge: () => ({ invoke: vi.fn() }),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

vi.mock('../../../services/OrderService', () => ({
  OrderService: {
    getInstance: () => ({ fetchOrders: vi.fn(), createOrder, updateOrderStatus }),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import en from '../../../locales/en.json';
import { useOrderStore } from '../useOrderStore';

const NATIVE_FULL =
  'enqueue parity sync: SYNC_QUEUE_FULL: Sync queue is full (20000/20000). New sales stop until this terminal reconnects and the queue drains; nothing already queued is lost.';

describe('useOrderStore: a write the full offline queue refused', () => {
  beforeEach(() => {
    createOrder.mockReset();
    updateOrderStatus.mockReset();
  });

  it('tells the checkout why the sale was not saved', async () => {
    createOrder.mockRejectedValue(new Error(NATIVE_FULL));

    const result = await useOrderStore.getState().createOrder({
      items: [{ id: 'item-1', name: 'Crepe', quantity: 1, price: 6.5 }] as any,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SYNC_QUEUE_FULL');
    expect(result.savedForRetry).toBe(false);
    expect(result.error).toBe(en.sync.capacity.full);
    expect(result.error).not.toContain('SYNC_QUEUE_FULL');
  });

  it('tells the status screen why the change was refused', async () => {
    updateOrderStatus.mockRejectedValue(
      new Error(
        'SYNC_QUEUE_CONFLICTS_FULL: Sync queue conflict backlog is full (1000/1000). Resolve conflicted items before enqueuing more.',
      ),
    );

    const result = await useOrderStore
      .getState()
      .updateOrderStatusDetailed('order-1', 'ready');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SYNC_QUEUE_CONFLICTS_FULL');
    expect(result.errorMessage).toBe(en.sync.capacity.conflictsFull);
  });
});
