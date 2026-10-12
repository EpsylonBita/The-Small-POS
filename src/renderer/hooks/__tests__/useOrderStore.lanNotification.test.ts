import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: unknown) => void>(),
  fetchOrders: vi.fn(),
}));

vi.mock('../../../lib', () => ({
  getBridge: () => ({ invoke: vi.fn() }),
  onEvent: (channel: string, handler: (payload: unknown) => void) => mocks.listeners.set(channel, handler),
  offEvent: (channel: string, handler: (payload: unknown) => void) => {
    if (mocks.listeners.get(channel) === handler) mocks.listeners.delete(channel);
  },
}));
vi.mock('../../../services/OrderService', () => ({
  OrderService: { getInstance: () => ({ fetchOrders: mocks.fetchOrders }) },
}));

import { useOrderStore } from '../useOrderStore';

const order = {
  id: 'local-p02', supabase_id: 'canonical-p02', order_number: 'ORD-P02',
  orderType: 'dine-in', tableNumber: 'P02', tableSessionId: 'session-p02',
  status: 'pending', totalAmount: 21, total_amount: 21, sync_status: 'synced',
  created_at: '2026-10-10T00:01:34Z', updated_at: '2026-10-10T00:01:34Z',
};
const hint = { source: 'lan', request_id: 'committed-receipt-1' };
const emit = (payload: unknown) => mocks.listeners.get('order-realtime-update')?.(payload);
const tick = () => vi.advanceTimersByTimeAsync(150);

beforeEach(() => {
  useOrderStore.getState()._cleanup();
  vi.useFakeTimers();
  mocks.fetchOrders.mockReset();
  useOrderStore.setState({ orders: [], pendingExternalOrders: [], _filteredOrders: null, _orderCounts: null });
  useOrderStore.getState()._setupRealtimeListeners();
});

afterEach(() => {
  useOrderStore.getState()._cleanup();
  vi.useRealTimers();
});

describe('committed LAN order notification', () => {
  it('reads the durable local order and invalidates the filtered projection without a tab switch', async () => {
    useOrderStore.getState().getFilteredOrders();
    mocks.fetchOrders.mockResolvedValue([order]);
    emit(hint);
    await tick();
    expect(useOrderStore.getState().orders.map(row => [row.id, row.totalAmount, row.tableSessionId]))
      .toEqual([['local-p02', 21, 'session-p02']]);
    expect(useOrderStore.getState().getFilteredOrders().map(row => row.id)).toEqual(['local-p02']);
    expect(mocks.fetchOrders).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst but rereads a commit observed during an active read', async () => {
    let complete!: (rows: unknown[]) => void;
    mocks.fetchOrders.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
      .mockResolvedValueOnce([order, { ...order, id: 'local-p04', supabase_id: 'canonical-p04', order_number: 'ORD-P04' }]);
    emit(hint);
    emit({ ...hint, request_id: 'committed-receipt-2' });
    await tick();
    expect(mocks.fetchOrders).toHaveBeenCalledTimes(1);
    emit({ ...hint, request_id: 'committed-receipt-3' });
    await tick();
    expect(mocks.fetchOrders).toHaveBeenCalledTimes(1);
    complete([order]);
    await tick();
    expect(useOrderStore.getState().orders.map(row => row.id)).toEqual(['local-p02', 'local-p04']);
    expect(mocks.fetchOrders).toHaveBeenCalledTimes(2);
  });

  it('keeps row-bearing updates on their existing merge path', async () => {
    useOrderStore.setState({ orders: [order as any] });
    emit({ ...order, id: 'canonical-p02', totalAmount: 42, updated_at: '2026-10-10T00:02:00Z' });
    await tick();
    expect(useOrderStore.getState().orders[0].totalAmount).toBe(42);
    expect(mocks.fetchOrders).not.toHaveBeenCalled();
  });

  it('does not merge malformed hints into an unrelated row without a remote id', async () => {
    useOrderStore.setState({ orders: [{ ...order, supabase_id: undefined } as any] });
    for (const payload of [null, {}, { source: 'lan' }, { ...hint, request_id: ' ' }, { ...hint, source: 'other' }]) emit(payload);
    await tick();
    expect(useOrderStore.getState().orders).toEqual([{ ...order, supabase_id: undefined }]);
    expect(mocks.fetchOrders).not.toHaveBeenCalled();
  });

  it('cancels queued refresh work when listeners are cleaned up', async () => {
    mocks.fetchOrders.mockResolvedValue([order]);
    emit(hint);
    useOrderStore.getState()._cleanup();
    await tick();
    expect(useOrderStore.getState().orders).toEqual([]);
    expect(mocks.listeners.has('order-realtime-update')).toBe(false);
    expect(mocks.fetchOrders).not.toHaveBeenCalled();
  });

  it('allows a later committed hint to retry a failed read', async () => {
    mocks.fetchOrders.mockRejectedValueOnce(new Error('local read unavailable')).mockResolvedValueOnce([order]);
    emit(hint);
    await tick();
    expect(useOrderStore.getState().orders).toEqual([]);
    emit({ ...hint, request_id: 'committed-receipt-2' });
    await tick();
    expect(useOrderStore.getState().orders.map(row => row.id)).toEqual(['local-p02']);
  });
});
