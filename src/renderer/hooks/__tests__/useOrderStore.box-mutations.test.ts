import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateOrderStatus: vi.fn(), approve: vi.fn(), decline: vi.fn(), assignDriver: vi.fn(), updatePreparation: vi.fn(),
}));
vi.mock('../../../lib', () => ({
  getBridge: () => ({ invoke: vi.fn(), orders: mocks }), onEvent: vi.fn(), offEvent: vi.fn(),
}));
vi.mock('../../../services/OrderService', () => ({ OrderService: { getInstance: () => mocks } }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }) }));

import { useOrderStore } from '../useOrderStore';
import { BOX_REJECTION_REASONS } from '../../components/order/box-order-decision';

function seed(status = 'pending', plugin = 'box') {
  const order = { id: 'box-order', plugin, status, order_type: 'delivery', items: [], total_amount: 7.95 };
  useOrderStore.setState({ orders: [order] as never, pendingExternalOrders: [], loadingOperations: new Set(), error: null });
  return order;
}

describe('desktop BOX store mutation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateOrderStatus.mockResolvedValue(undefined);
    mocks.approve.mockResolvedValue({ success: true });
    mocks.decline.mockResolvedValue({ success: true });
    mocks.assignDriver.mockResolvedValue({ success: true });
    mocks.updatePreparation.mockResolvedValue({ success: true });
    seed();
  });

  it.each(['confirmed', 'preparing', 'ready', 'completed', 'cancelled'])('refuses pending -> %s before service calls or local changes', async next => {
    const original = useOrderStore.getState().orders[0];
    expect(await useOrderStore.getState().updateOrderStatus('box-order', next as never)).toBe(false);
    expect(mocks.updateOrderStatus).not.toHaveBeenCalled();
    expect(mocks.decline).not.toHaveBeenCalled();
    expect(useOrderStore.getState().orders[0]).toBe(original);
    expect(useOrderStore.getState().loadingOperations.size).toBe(0);
  });

  it.each([undefined, 0, -1, NaN, 1.5])('refuses an invalid accept estimate %s before bridge calls', async estimate => {
    expect(await useOrderStore.getState().approveOrder('box-order', estimate)).toBe(false);
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(useOrderStore.getState().orders[0].status).toBe('pending');
  });

  it('passes a valid accept estimate through the specialized decision bridge', async () => {
    expect(await useOrderStore.getState().approveOrder('box-order', 25)).toBe(true);
    expect(mocks.approve).toHaveBeenCalledWith('box-order', 25);
    expect(useOrderStore.getState().orders[0].status).toBe('confirmed');
  });

  it('routes valid pending generic cancellation through specialized decline unchanged', async () => {
    const reason = BOX_REJECTION_REASONS[0];
    expect(await useOrderStore.getState().updateOrderStatusDetailed('box-order', 'cancelled', { cancellationReason: reason })).toEqual({ success: true });
    expect(mocks.decline).toHaveBeenCalledWith('box-order', reason);
    expect(mocks.updateOrderStatus).not.toHaveBeenCalled();
    expect(useOrderStore.getState().orders[0].status).toBe('cancelled');
  });

  it.each(['other', '', ` ${BOX_REJECTION_REASONS[0]}`])('refuses an invented or altered reason %s', async reason => {
    expect(await useOrderStore.getState().declineOrder('box-order', reason)).toBe(false);
    expect(mocks.decline).not.toHaveBeenCalled();
    expect(useOrderStore.getState().orders[0].status).toBe('pending');
  });

  it.each(['confirmed', 'cancelled'])('refuses cancel/restore after decision status %s', async status => {
    const original = seed(status);
    expect(await useOrderStore.getState().updateOrderStatus('box-order', 'pending')).toBe(false);
    expect(await useOrderStore.getState().declineOrder('box-order', BOX_REJECTION_REASONS[0])).toBe(false);
    expect(mocks.updateOrderStatus).not.toHaveBeenCalled();
    expect(mocks.decline).not.toHaveBeenCalled();
    expect(useOrderStore.getState().orders[0]).toBe(original);
  });

  it('refuses pending driver and preparation progress shortcuts', async () => {
    expect(await useOrderStore.getState().assignDriver('box-order', 'driver')).toBe(false);
    expect(await useOrderStore.getState().updatePreparationProgress('box-order', 'preparing', 25)).toBe(false);
    expect(mocks.assignDriver).not.toHaveBeenCalled();
    expect(mocks.updatePreparation).not.toHaveBeenCalled();
  });

  it('retains the pending order when the specialized bridge reports failure', async () => {
    const original = useOrderStore.getState().orders[0];
    mocks.approve.mockResolvedValue({ success: false });
    expect(await useOrderStore.getState().approveOrder('box-order', 25)).toBe(false);
    expect(useOrderStore.getState().orders[0]).toBe(original);
  });

  it('keeps accepted BOX local-ready and driver paths', async () => {
    seed('confirmed');
    expect(await useOrderStore.getState().updateOrderStatus('box-order', 'ready')).toBe(true);
    expect(mocks.updateOrderStatus).toHaveBeenCalled();
    expect(await useOrderStore.getState().assignDriver('box-order', 'driver')).toBe(true);
    expect(mocks.assignDriver).toHaveBeenCalledWith('box-order', 'driver', undefined);
  });

  it('preserves efood estimate omission, free-text decline and generic transitions', async () => {
    seed('pending', 'efood');
    expect(await useOrderStore.getState().approveOrder('box-order')).toBe(true);
    expect(await useOrderStore.getState().declineOrder('box-order', 'Busy')).toBe(true);
    expect(await useOrderStore.getState().updateOrderStatus('box-order', 'pending')).toBe(true);
    expect(mocks.approve).toHaveBeenCalledWith('box-order', undefined);
    expect(mocks.decline).toHaveBeenCalledWith('box-order', 'Busy');
  });

  it.each([{ food_delivery: { platform: 'box_gr' } }, '{"food_delivery":{"platform":"boxgr"}}'])('guards legacy metadata-only BOX rows before mutation: %j', async ghost_metadata => {
    useOrderStore.setState({ orders: [{ id: 'box-order', status: 'pending', ghost_metadata }] as never });
    const original = useOrderStore.getState().orders[0];
    expect(await useOrderStore.getState().updateOrderStatus('box-order', 'ready')).toBe(false);
    expect(mocks.updateOrderStatus).not.toHaveBeenCalled();
    expect(useOrderStore.getState().orders[0]).toBe(original);
  });

  it('keeps efood canonical precedence over conflicting BOX ghost metadata', async () => {
    useOrderStore.setState({ orders: [{ id: 'box-order', status: 'pending', plugin: 'efood', ghost_metadata: { food_delivery: { platform: 'box' } } }] as never });
    expect(await useOrderStore.getState().approveOrder('box-order')).toBe(true);
    expect(mocks.approve).toHaveBeenCalledWith('box-order', undefined);
  });

  it.each(['ready', 'completed'])('loads the persisted paid room approval without regressing %s', async status => {
    seed('pending', '');
    mocks.approve.mockResolvedValue({ success: true, roomChargeConfirmed: true });
    const originalRefresh = useOrderStore.getState().silentRefresh;
    const refresh = vi.fn(async () => {
      useOrderStore.setState({ orders: [{
        id: 'box-order', status, payment_method: 'room_charge', payment_status: 'paid',
      }] as never });
    });
    useOrderStore.setState({ silentRefresh: refresh });
    try {
      expect(await useOrderStore.getState().approveOrder('box-order', 25)).toBe(true);
      expect(refresh).toHaveBeenCalledOnce();
      expect(useOrderStore.getState().orders[0]).toMatchObject({ status, payment_status: 'paid' });
    } finally {
      useOrderStore.setState({ silentRefresh: originalRefresh });
    }
  });
});
