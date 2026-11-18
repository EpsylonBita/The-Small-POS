import { beforeEach, describe, expect, it, vi } from 'vitest'

const { bridge } = vi.hoisted(() => ({
  bridge: {
    orders: {
      getAll: vi.fn(),
      saveFromRemote: vi.fn(),
      updateStatus: vi.fn(),
    },
    sync: {
      fetchOrders: vi.fn(),
    },
  },
}))

vi.mock('../../lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib')>()
  return {
    ...actual,
    getBridge: () => bridge,
  }
})

import { OrderService } from '../OrderService'

describe('OrderService local-first order reads', () => {
  beforeEach(() => {
    bridge.orders.getAll.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'local-order-1',
          order_number: 'LOCAL-1',
          status: 'pending',
        },
      ],
    })
    bridge.sync.fetchOrders.mockResolvedValue({ success: true, orders: [] })
  })

  it('returns the SQLite ledger without waiting for or materializing Admin API history', async () => {
    const orders = await OrderService.getInstance().fetchOrders()

    expect(orders).toHaveLength(1)
    expect(orders[0]?.id).toBe('local-order-1')
    expect(bridge.orders.getAll).toHaveBeenCalledTimes(1)
    expect(bridge.sync.fetchOrders).not.toHaveBeenCalled()
    expect(bridge.orders.saveFromRemote).not.toHaveBeenCalled()
  })

  it.each(['returned', 'thrown'])('never falls back to HTTP for a %s open-notice refusal', async shape => {
    const service = OrderService.getInstance();
    const fallback = vi.spyOn(service as any, 'allowAdminApiFallback').mockReturnValue(true);
    const fetch = vi.spyOn(globalThis, 'fetch');
    if (shape === 'returned') bridge.orders.updateStatus.mockResolvedValue({ success: false, code: 'ORDER_HAS_OPEN_NOTICE' });
    else bridge.orders.updateStatus.mockRejectedValue('ORDER_HAS_OPEN_NOTICE');
    try {
      await expect(service.updateOrderStatus('local-order-1', 'completed')).rejects.toThrow('ORDER_HAS_OPEN_NOTICE');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fallback.mockRestore();
      fetch.mockRestore();
    }
  })
  it.each(['returned', 'thrown'])('preserves a %s unavailable-check refusal without HTTP fallback', async shape => {
    const service = OrderService.getInstance();
    const fallback = vi.spyOn(service as any, 'allowAdminApiFallback').mockReturnValue(true);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const code = 'ORDER_NOTICE_CHECK_UNAVAILABLE';
    if (shape === 'returned') bridge.orders.updateStatus.mockResolvedValue({ success: false, code });
    else bridge.orders.updateStatus.mockRejectedValue(code);
    try {
      await expect(service.updateOrderStatus('local-order-1', 'completed')).rejects.toThrow(code);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fallback.mockRestore(); fetch.mockRestore(); }
  })
})
