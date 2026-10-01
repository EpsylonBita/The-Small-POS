import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fix review 30/09/2026 (double charge on a slow card terminal). A press of
// Pay while the same checkout is still waiting on the card terminal comes
// back as `CHECKOUT_IN_PROGRESS`. Read as a plain failure, the renderer
// wrote an offline retry record of the order: a second order while the first
// press still charged the card. It must be final here.

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
  clientRequestId: 'checkout-request-slow-1',
  items: [{ id: 'item-1', name: 'Crepe', quantity: 1, price: 13, is_manual: true }],
  total_amount: 13,
  totalAmount: 13,
  order_type: 'takeaway',
  initialPayment: { method: 'card', amount: 13 },
})

describe('OrderService: the same checkout still in progress', () => {
  beforeEach(() => {
    bridge.orders.create.mockReset()
    bridge.orders.saveForRetry.mockReset()
    bridge.orders.getById.mockReset()
    bridge.orders.createWithInitialPayment.mockReset()
    bridge.orders.createWithInitialPayment.mockResolvedValue({
      success: false,
      errorCode: 'CHECKOUT_IN_PROGRESS',
      checkoutInProgress: true,
      orderPersisted: false,
      clientRequestId: 'checkout-request-slow-1',
      error:
        'This checkout is still in progress on the card terminal. Wait for it to finish; paying again then checks the same payment and never charges twice.',
    })
    bridge.orders.saveForRetry.mockResolvedValue({ success: true, orderId: 'retry-order-1' })
  })

  it('is final: typed, never saved for retry, never created again', async () => {
    const outcome = await OrderService.getInstance()
      .createOrder(checkout() as any)
      .then(
        (order) => ({ order, error: null as any }),
        (error) => ({ order: null, error }),
      )

    expect(outcome.order).toBeNull()
    expect(outcome.error?.checkoutInProgress).toBe(true)
    expect(outcome.error?.code).toBe('CHECKOUT_IN_PROGRESS')
    expect(bridge.orders.createWithInitialPayment).toHaveBeenCalledTimes(1)
    expect(bridge.orders.saveForRetry).not.toHaveBeenCalled()
    expect(bridge.orders.create).not.toHaveBeenCalled()
  })
})
