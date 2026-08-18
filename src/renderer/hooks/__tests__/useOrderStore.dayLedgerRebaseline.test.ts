import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store calls getBridge() at module scope; give it an inert bridge and
// inert event plumbing so importing the store has no side effects.
vi.mock('../../../lib', () => ({
  getBridge: () => ({ invoke: vi.fn() }),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

const fetchOrdersMock = vi.fn();
vi.mock('../../../services/OrderService', () => ({
  OrderService: {
    getInstance: () => ({ fetchOrders: fetchOrdersMock }),
  },
}));

import { useOrderStore } from '../useOrderStore';
import type { Order } from '../../../shared/types/orders';

const order = (id: string, createdAt: string): Order =>
  ({
    id,
    order_number: `#${id}`,
    status: 'pending',
    created_at: createdAt,
    updated_at: createdAt,
    total_amount: 10,
    sync_status: 'synced',
  }) as unknown as Order;

describe('useOrderStore.loadOrders re-baselines to the fetched day ledger', () => {
  beforeEach(() => {
    fetchOrdersMock.mockReset();
    useOrderStore.setState({ orders: [], pendingExternalOrders: [] });
  });

  it('replaces the list with the fetch result instead of accumulating', async () => {
    // First load: the ledger still contains yesterday's row.
    fetchOrdersMock.mockResolvedValueOnce([
      order('stale-yesterday', '2026-08-17T21:00:00Z'),
      order('today-a', '2026-08-18T08:00:00Z'),
    ]);
    await useOrderStore.getState().loadOrders();
    expect(useOrderStore.getState().orders.map((o) => o.id)).toEqual([
      'stale-yesterday',
      'today-a',
    ]);

    // Second load: the day-bounded read no longer returns the stale row.
    // The store must drop it — a merge-instead-of-replace regression here
    // would grow the renderer's copy of the ledger without bound.
    fetchOrdersMock.mockResolvedValueOnce([
      order('today-a', '2026-08-18T08:00:00Z'),
      order('today-b', '2026-08-18T09:00:00Z'),
    ]);
    await useOrderStore.getState().loadOrders();
    expect(useOrderStore.getState().orders.map((o) => o.id)).toEqual(['today-a', 'today-b']);
  });

  it('drops event-appended rows that the next day-bounded fetch does not return', async () => {
    fetchOrdersMock.mockResolvedValueOnce([order('today-a', '2026-08-18T08:00:00Z')]);
    await useOrderStore.getState().loadOrders();

    // Simulate what an `order-created` append leaves behind: an extra row in
    // state that the ledger no longer serves (e.g. recovered stale remote).
    useOrderStore.setState((state) => ({
      orders: [...state.orders, order('event-appended-stale', '2026-08-17T20:00:00Z')],
    }));
    expect(useOrderStore.getState().orders).toHaveLength(2);

    fetchOrdersMock.mockResolvedValueOnce([order('today-a', '2026-08-18T08:00:00Z')]);
    await useOrderStore.getState().loadOrders();
    expect(useOrderStore.getState().orders.map((o) => o.id)).toEqual(['today-a']);
  });
});
