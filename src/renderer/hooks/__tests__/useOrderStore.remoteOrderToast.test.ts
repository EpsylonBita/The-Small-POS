import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Live audit 30/10: a catch-up sync stacked five English "New order #ORD-20261009-…
// received!" toasts over the staff schedule. They fired for orders the till already
// held and for orders three weeks old, with the long technical id.
const listeners = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: toastSuccess, error: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock('../../../lib', () => ({
  getBridge: () => ({ invoke: vi.fn() }),
  onEvent: (channel: string, handler: (payload: unknown) => void) => {
    listeners.set(channel, handler);
  },
  offEvent: vi.fn(),
}));

vi.mock('../../../services/OrderService', () => ({
  OrderService: { getInstance: () => ({ fetchOrders: vi.fn().mockResolvedValue([]) }) },
}));

import i18n from '../../../lib/i18n';
import { isRecentRemoteOrder, remoteOrderToastMessage, useOrderStore } from '../useOrderStore';

const remoteOrder = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  order_number: `ORD-20261030-${id}`,
  display_order_number: id.toUpperCase(),
  status: 'pending',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  sync_status: 'synced',
  ...overrides,
});

describe('remote "new order" toast', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    listeners.clear();
    toastSuccess.mockReset();
    await i18n.changeLanguage('el');
    useOrderStore.setState({ orders: [], pendingExternalOrders: [] });
    useOrderStore.getState()._setupRealtimeListeners();
  });

  afterEach(() => {
    // Flush the shared toast batch so no test leaks a pending toast into the next.
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('merges a burst of new orders into one localized toast', () => {
    listeners.get('order-created')?.(remoteOrder('a1'));
    listeners.get('order-created')?.(remoteOrder('a2'));
    listeners.get('order-created')?.(remoteOrder('a3'));
    vi.advanceTimersByTime(700);

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess.mock.calls[0][0]).toBe('3 νέες παραγγελίες');
    expect(toastSuccess.mock.calls[0][1]).toMatchObject({ id: 'remote-new-orders' });
  });

  it('keeps two different remote orders that both lack a supabase_id', () => {
    listeners.get('order-created')?.(remoteOrder('d1'));
    listeners.get('order-created')?.(remoteOrder('d2'));
    const ids = [...useOrderStore.getState().orders, ...useOrderStore.getState().pendingExternalOrders].map((row) => row.id);
    expect(ids.sort()).toEqual(['d1', 'd2']);
  });

  it('shows the short staff number for a single order', () => {
    listeners.get('order-created')?.(remoteOrder('b7'));
    vi.advanceTimersByTime(700);
    expect(toastSuccess).toHaveBeenCalledWith('Νέα παραγγελία #B7', expect.anything());
  });

  it('stays quiet for an order the till already holds and for old catch-up orders', () => {
    useOrderStore.setState({ orders: [remoteOrder('c1') as any], pendingExternalOrders: [] });
    listeners.get('order-created')?.(remoteOrder('c1', { status: 'preparing' }));
    listeners.get('order-created')?.(remoteOrder('old', { created_at: '2026-10-09T10:00:00Z' }));
    vi.advanceTimersByTime(700);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('remote order toast helpers', () => {
  it('treats orders without a creation time as new and older than 30 minutes as old', () => {
    const now = Date.parse('2026-10-30T18:00:00Z');
    expect(isRecentRemoteOrder({}, now)).toBe(true);
    expect(isRecentRemoteOrder({ created_at: '2026-10-30T17:45:00Z' }, now)).toBe(true);
    expect(isRecentRemoteOrder({ created_at: '2026-10-30T17:15:00Z' }, now)).toBe(false);
  });

  it('leaves a long technical id out of the message', async () => {
    await i18n.changeLanguage('en');
    expect(remoteOrderToastMessage(['ORD-20261009-b20a32b3faeb33efa7d753325eae261a'])).toBe('New order');
    expect(remoteOrderToastMessage(['0042'])).toBe('New order #0042');
  });
});

describe('document language', () => {
  it('follows the app language so Greek capitals drop the tonos', async () => {
    await i18n.changeLanguage('el');
    expect(document.documentElement.lang).toBe('el');
    await i18n.changeLanguage('de');
    expect(document.documentElement.lang).toBe('de');
  });
});
