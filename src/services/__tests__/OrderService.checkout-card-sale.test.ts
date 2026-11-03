import { beforeEach, describe, expect, it, vi } from 'vitest'

// Founder 01/11/2026 (a split saves its order only with its first payment). A card SALE the checkout took before
// its order existed, not recorded or not known yet, and a split's first portion that may not start its order are
// refused by the till. Read as plain failures, the service would save an offline retry record (or an Admin API
// order) around the till's guard: a second order, or the card dropped. They must be final here.

const { bridge } = vi.hoisted(() => ({
  bridge: {
    orders: {
      create: vi.fn(),
      createWithInitialPayment: vi.fn(),
      saveForRetry: vi.fn(),
      getById: vi.fn(),
    },
    shifts: { getActiveByTerminalLoose: vi.fn() },
  },
}))

vi.mock('../../lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib')>()
  return {
    ...actual,
    getBridge: () => bridge,
  }
})

// The desktop runtime: no Admin API fallback.
vi.mock('../../lib/platform-detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/platform-detect')>()
  return {
    ...actual,
    isBrowser: () => false,
    isTauri: () => true,
  }
})

import { OrderService } from '../OrderService'

const checkout = () => ({
  clientRequestId: 'checkout-split-first-1',
  items: [{ id: 'item-1', name: 'Crepe', quantity: 2, price: 13, is_manual: true }],
  total_amount: 26,
  totalAmount: 26,
  order_type: 'takeaway',
  payment_method: 'pending',
  checkoutKind: 'split_first_portion',
  initialPayment: { method: 'cash', amount: 13 },
})

describe('OrderService: a checkout card SALE or a split first portion the till refuses', () => {
  beforeEach(() => {
    bridge.orders.create.mockReset()
    bridge.orders.saveForRetry.mockReset()
    bridge.orders.getById.mockReset()
    bridge.orders.createWithInitialPayment.mockReset()
    bridge.orders.saveForRetry.mockResolvedValue({ success: true, orderId: 'retry-order-1' })
  })

  it('passes the split marker to the till', async () => {
    bridge.orders.createWithInitialPayment.mockResolvedValue({ success: true, orderId: 'order-1' })
    bridge.orders.getById.mockResolvedValue({ id: 'order-1' })
    await OrderService.getInstance().createOrder(checkout() as any)
    expect(bridge.orders.createWithInitialPayment).toHaveBeenCalledWith(expect.objectContaining({
      checkoutKind: 'split_first_portion',
      initialPayment: expect.objectContaining({ method: 'cash', amount: 13 }),
    }))
  })

  it.each(['CHECKOUT_CARD_SALE_UNRECORDED', 'CHECKOUT_CARD_SALE_UNRESOLVED', 'SPLIT_FIRST_PORTION_REFUSED'])(
    '%s is final: typed, never saved for retry, never created again',
    async (errorCode) => {
      bridge.orders.createWithInitialPayment.mockResolvedValue({
        success: false, errorCode, amountCents: 1300, currency: 'EUR', orderPersisted: false, paymentApproved: false,
        error: 'refused by the till',
      })
      const outcome = await OrderService.getInstance()
        .createOrder(checkout() as any)
        .then(
          (order) => ({ order, error: null as any }),
          (error) => ({ order: null, error }),
        )
      expect(outcome.order).toBeNull()
      expect(outcome.error?.code).toBe(errorCode)
      expect(outcome.error?.checkoutCardSale).toBe(true)
      expect(outcome.error?.amountCents).toBe(1300)
      expect(bridge.orders.createWithInitialPayment).toHaveBeenCalledTimes(1)
      expect(bridge.orders.saveForRetry).not.toHaveBeenCalled()
      expect(bridge.orders.create).not.toHaveBeenCalled()
    },
  )
})
