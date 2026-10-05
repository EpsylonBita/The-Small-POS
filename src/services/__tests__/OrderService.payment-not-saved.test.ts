import { beforeEach, describe, expect, it, vi } from 'vitest'

// Item E, fix review 30/09/2026 (Android 1.0.13 parity). A card charged at
// new-order checkout whose order the till could not save comes back as
// `PAYMENT_NOT_SAVED`: the till holds the order and its payment for "Save
// payment again". Before, the renderer read it as a plain failure and wrote
// an offline retry record of the order (or an Admin API create), and the
// screen let the cashier try the checkout again: a new checkout, a second
// charge. It must be final here, with its details intact.

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

const UNSAVED = {
  idempotencyKey: 'terminal-card:fiscal-txn-checkout-1',
  orderId: 'checkout-request-0001',
  method: 'card',
  amount: 13,
  amountCents: 1300,
  currency: 'EUR',
  kind: 'new_order_checkout',
  capturedAt: '2026-09-30T12:00:05Z',
  attempts: 4,
  canSaveAgain: true,
}

const checkout = () => ({
  clientRequestId: 'checkout-request-0001',
  items: [{ id: 'item-1', name: 'Crepe', quantity: 1, price: 13, is_manual: true }],
  total_amount: 13,
  totalAmount: 13,
  order_type: 'takeaway',
  initialPayment: { method: 'card', amount: 13 },
})

describe('OrderService: a card charged at checkout and not saved', () => {
  beforeEach(() => {
    bridge.orders.create.mockReset()
    bridge.orders.saveForRetry.mockReset()
    bridge.orders.getById.mockReset()
    bridge.orders.createWithInitialPayment.mockReset()
    bridge.orders.createWithInitialPayment.mockResolvedValue({
      success: false,
      errorCode: 'PAYMENT_NOT_SAVED',
      paymentNotSaved: true,
      paymentApproved: true,
      paymentPersisted: false,
      orderPersisted: false,
      orderId: null,
      newOrderCheckout: true,
      amountCents: 1300,
      unsavedPayment: UNSAVED,
      error:
        'The card was charged 13.00, but the payment could not be saved on this till yet. Do not charge again: save the payment again.',
    })
    bridge.orders.saveForRetry.mockResolvedValue({ success: true, orderId: 'retry-order-1' })
  })

  it.each(['charged receipt could not be saved', 'SHIFT_CURRENCY_MISMATCH during approved recovery'])('is final and retains recovery evidence even for %s', async message => {
    bridge.orders.createWithInitialPayment.mockResolvedValueOnce({ success:false,errorCode:'PAYMENT_NOT_SAVED',paymentNotSaved:true,amountCents:1300,unsavedPayment:UNSAVED,error:message })
    const outcome = await OrderService.getInstance()
      .createOrder(checkout() as any)
      .then(
        (order) => ({ order, error: null as any }),
        (error) => ({ order: null, error }),
      )

    expect(outcome.order).toBeNull()
    expect(outcome.error?.paymentNotSaved).toBe(true)
    expect(outcome.error?.code).toBe('PAYMENT_NOT_SAVED')
    expect(outcome.error?.amountCents).toBe(1300)
    expect(outcome.error?.unsavedPayment?.idempotencyKey).toBe(UNSAVED.idempotencyKey)
    expect(bridge.orders.createWithInitialPayment).toHaveBeenCalledTimes(1)
    expect(bridge.orders.saveForRetry).not.toHaveBeenCalled()
    expect(bridge.orders.create).not.toHaveBeenCalled()
  })
})
