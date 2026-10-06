import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fix review 06/10/2026 (Le Petit Paris, CHF). A new-order TWINT checkout is
// sent to native after the cashier confirmed that the customer paid. Native
// refused every one with TWINT_RECEIPT_SCOPE_CHANGED, and the renderer read
// that as a soft failure: it saved the order for retry (`order_save_for_retry`)
// with its TWINT row but without the receipt journal, the Z blocker or the
// recovery. Any refusal of a TWINT checkout is final here.

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

vi.mock('../../renderer/services/terminal-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../renderer/services/terminal-credentials')>()
  const credentials = { organizationId: 'org-1', branchId: 'branch-1', terminalId: 'terminal-1' }
  return {
    ...actual,
    getCachedTerminalCredentials: () => credentials,
    refreshTerminalCredentialCache: async () => credentials,
  }
})

import { OrderService } from '../OrderService'

const twintMetadata = {
  provider: 'twint',
  confirmation: 'cashier',
  confirmation_action: 'confirm',
  qr_mode: 'static_qr_manual',
}

/** The cart a host hands to useOrderStore.createOrder after the QR confirm. */
const twintCheckout = () => ({
  clientRequestId: 'twint-checkout-0001',
  items: [{ id: 'item-1', name: 'Crêpe', quantity: 1, price: 12, is_manual: true }],
  total_amount: 12,
  totalAmount: 12,
  order_type: 'takeaway',
  currency: 'CHF',
  initialPayment: {
    method: 'twint',
    amount: 12,
    currency: 'CHF',
    idempotencyKey: 'twint-receipt-0001',
    metadata: twintMetadata,
  },
})

const settle = (promise: Promise<unknown>) =>
  promise.then(
    (order) => ({ order, error: null as any }),
    (error) => ({ order: null, error }),
  )

describe('OrderService: a refused TWINT checkout is never saved for retry', () => {
  beforeEach(() => {
    bridge.orders.create.mockReset()
    bridge.orders.saveForRetry.mockReset()
    bridge.orders.getById.mockReset()
    bridge.orders.createWithInitialPayment.mockReset()
    bridge.orders.saveForRetry.mockResolvedValue({ success: true, orderId: 'retry-order-1' })
  })

  it('sends the renderer payload without any scope fields (native stamps them)', async () => {
    bridge.orders.createWithInitialPayment.mockResolvedValueOnce({ success: true, orderId: 'saved-order' })
    bridge.orders.getById.mockResolvedValueOnce({ id: 'saved-order' })
    await OrderService.getInstance().createOrder(twintCheckout() as any)
    const sent = bridge.orders.createWithInitialPayment.mock.calls[0][0]
    for (const key of ['organizationId', 'branchId', 'terminalId', 'organization_id', 'branch_id', 'terminal_id']) {
      expect(sent).not.toHaveProperty(key)
    }
    expect(sent.initialPayment).toMatchObject({ method: 'twint', currency: 'CHF', idempotencyKey: 'twint-receipt-0001' })
  })

  it('is final when native rejects the checkout with a TWINT refusal (the pre-fix scope refusal)', async () => {
    bridge.orders.createWithInitialPayment.mockRejectedValueOnce(new Error('TWINT_RECEIPT_SCOPE_CHANGED'))
    const outcome = await settle(OrderService.getInstance().createOrder(twintCheckout() as any))
    expect(outcome.order).toBeNull()
    expect(outcome.error?.code).toBe('TWINT_RECEIPT_SCOPE_CHANGED')
    expect(outcome.error?.twintReceipt).toBe(true)
    expect(outcome.error?.retryable).toBe(false)
    expect(bridge.orders.saveForRetry).not.toHaveBeenCalled()
    expect(bridge.orders.create).not.toHaveBeenCalled()
  })

  it('is final, with its details, when native answers a TWINT receipt it could not retain', async () => {
    bridge.orders.createWithInitialPayment.mockResolvedValueOnce({
      success: false,
      errorCode: 'TWINT_RECEIPT_SCOPE_UNAVAILABLE',
      manualReceiptConfirmed: true,
      manualReceiptRetained: false,
      orderPersisted: false,
      error:
        'The cashier confirmed TWINT receipt, but this till could not retain it. Do not collect again. Keep the receipt and contact a manager before closing or restarting the POS.',
    })
    const outcome = await settle(OrderService.getInstance().createOrder(twintCheckout() as any))
    expect(outcome.error?.code).toBe('TWINT_RECEIPT_SCOPE_UNAVAILABLE')
    expect(outcome.error?.manualReceiptRetained).toBe(false)
    expect(outcome.error?.message).toContain('Do not collect again')
    expect(bridge.orders.saveForRetry).not.toHaveBeenCalled()
    expect(bridge.orders.create).not.toHaveBeenCalled()
  })

  it('is final for any other failure of a TWINT checkout too', async () => {
    bridge.orders.createWithInitialPayment.mockRejectedValueOnce(new Error('database is locked'))
    const outcome = await settle(OrderService.getInstance().createOrder(twintCheckout() as any))
    expect(outcome.error?.twintReceipt).toBe(true)
    expect(bridge.orders.saveForRetry).not.toHaveBeenCalled()
  })

  it('keeps the existing retry save for a cash checkout that native could not write', async () => {
    bridge.orders.createWithInitialPayment.mockRejectedValueOnce(new Error('database is locked'))
    bridge.orders.getById.mockResolvedValueOnce({ id: 'retry-order-1' })
    const cash = { ...twintCheckout(), clientRequestId: 'cash-checkout-0001', currency: 'EUR', initialPayment: { method: 'cash', amount: 12 } }
    const outcome = await settle(OrderService.getInstance().createOrder(cash as any))
    expect(outcome.error).toBeNull()
    expect(bridge.orders.saveForRetry).toHaveBeenCalledTimes(1)
  })
})
