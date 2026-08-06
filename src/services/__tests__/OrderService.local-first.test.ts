import { beforeEach, describe, expect, it, vi } from 'vitest'

const { bridge } = vi.hoisted(() => ({
  bridge: {
    orders: {
      getAll: vi.fn(),
      saveFromRemote: vi.fn(),
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
})
