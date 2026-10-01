import { beforeEach, describe, expect, it, vi } from 'vitest';

// When Rust pulls a remote order into the local cache but cannot read the row
// back, it emits `order_created` with `{ orderId }` only. The store used to
// drop that event as invalid, which hid the order — and its incoming-order
// alert — until something else refreshed the list.
const listeners = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

vi.mock('../../../lib', () => ({
  getBridge: () => ({ invoke: vi.fn() }),
  onEvent: (channel: string, handler: (payload: unknown) => void) => {
    listeners.set(channel, handler);
  },
  offEvent: vi.fn(),
}));

const fetchOrdersMock = vi.fn();
vi.mock('../../../services/OrderService', () => ({
  OrderService: {
    getInstance: () => ({ fetchOrders: fetchOrdersMock }),
  },
}));

import { useOrderStore } from '../useOrderStore';

const pendingEfoodOrder = {
  id: 'ef-1',
  order_number: 'ORD-ef-1',
  status: 'pending',
  plugin: 'efood',
  external_plugin_order_id: 'EF-1',
  created_at: '2026-09-30T14:17:23Z',
  updated_at: '2026-09-30T14:17:23Z',
  sync_status: 'synced',
};

describe('useOrderStore order-created without its row', () => {
  beforeEach(() => {
    listeners.clear();
    fetchOrdersMock.mockReset();
    useOrderStore.setState({ orders: [], pendingExternalOrders: [] });
    useOrderStore.getState()._setupRealtimeListeners();
  });

  it('re-reads the local cache so the pulled order reaches the approval queue', async () => {
    fetchOrdersMock.mockResolvedValue([pendingEfoodOrder]);

    listeners.get('order-created')?.({ orderId: 'ef-1' });

    await vi.waitFor(() => {
      expect(useOrderStore.getState().pendingExternalOrders.map((order) => order.id)).toEqual(['ef-1']);
    });
    expect(fetchOrdersMock).toHaveBeenCalledTimes(1);
  });

  it('still ignores a payload with no order at all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listeners.get('order-created')?.({});
    listeners.get('order-created')?.(null);
    expect(fetchOrdersMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
