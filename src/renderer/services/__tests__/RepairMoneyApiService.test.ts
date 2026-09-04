import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  moneyRequest: vi.fn(),
}))

import { RepairMoneyApiService } from '../RepairMoneyApiService'

const STAFF_SESSION_ID = '11111111-1111-4111-8111-111111111111'
const REPAIR_ID = '22222222-2222-4222-8222-222222222222'

const projection = {
  repair_id: REPAIR_ID,
  currency: 'EUR',
  total_minor: 12400,
  paid_minor: 5000,
  refunded_minor: 1000,
  balance_minor: 8400,
  orders: [{
    id: '33333333-3333-4333-8333-333333333333',
    order_number: 'ORD-100',
    role: 'primary',
    fiscal_state: 'deferred',
    payment_status: 'partial',
    total_minor: 12400,
  }],
  payments: [{
    id: '44444444-4444-4444-8444-444444444444',
    order_id: '33333333-3333-4333-8333-333333333333',
    payment_method: 'cash',
    amount_minor: 5000,
    refunded_minor: 1000,
    refundable_minor: 4000,
    status: 'completed',
    created_at: '2026-08-31T10:00:00.000Z',
  }],
  adjustments: [{
    id: '55555555-5555-4555-8555-555555555555',
    order_id: '33333333-3333-4333-8333-333333333333',
    payment_id: '44444444-4444-4444-8444-444444444444',
    adjustment_type: 'refund',
    amount_minor: 1000,
    refund_method: 'cash',
    created_at: '2026-08-31T10:01:00.000Z',
  }],
  fiscal_commands: [],
}

describe('RepairMoneyApiService financial projection', () => {
  let repairMoneyApiService: RepairMoneyApiService

  beforeEach(() => {
    mocks.moneyRequest.mockReset()
    repairMoneyApiService = new RepairMoneyApiService({
      staffAuth: { getSession: vi.fn().mockResolvedValue({ sessionId: STAFF_SESSION_ID }) },
      repairs: { moneyRequest: mocks.moneyRequest },
    })
  })

  it('loads the strict server-authoritative minor-unit projection with staff-session attribution', async () => {
    mocks.moneyRequest.mockResolvedValue(projection)

    await expect(
      repairMoneyApiService.getSettlement(REPAIR_ID),
    ).resolves.toEqual(projection)

    expect(mocks.moneyRequest).toHaveBeenCalledWith({
      staffSessionId: STAFF_SESSION_ID,
      request: { action: 'financial_projection', repair_id: REPAIR_ID },
    })
  })

  it('fails closed when a response substitutes raw cents aliases for the agreed minor-unit contract', async () => {
    mocks.moneyRequest.mockResolvedValue({
      ...projection,
      total_minor: undefined,
      total_amount_cents: 12400,
    })

    await expect(
      repairMoneyApiService.getSettlement(REPAIR_ID),
    ).rejects.toThrow('REPAIR_FINANCIAL_PROJECTION_INVALID')
  })

  it('surfaces transport failure instead of returning an empty zero-balance projection', async () => {
    mocks.moneyRequest.mockRejectedValue(new Error('This action requires an online connection.'))

    await expect(
      repairMoneyApiService.getSettlement(REPAIR_ID),
    ).rejects.toThrow('This action requires an online connection.')
  })

  it('rejects non-canonical financial roles and cross-order refund references', async () => {
    mocks.moneyRequest.mockResolvedValueOnce({
      ...projection,
      orders: [{ ...projection.orders[0], role: 'legacy_repair' }],
    })
    await expect(
      repairMoneyApiService.getSettlement(REPAIR_ID),
    ).rejects.toThrow('REPAIR_FINANCIAL_PROJECTION_INVALID')

    mocks.moneyRequest.mockResolvedValueOnce({
      ...projection,
      adjustments: [{
        ...projection.adjustments[0],
        order_id: '66666666-6666-4666-8666-666666666666',
      }],
    })
    await expect(
      repairMoneyApiService.getSettlement(REPAIR_ID),
    ).rejects.toThrow('REPAIR_FINANCIAL_PROJECTION_INVALID')
  })

  it('fails closed before transport when the native staff session is absent', async () => {
    repairMoneyApiService = new RepairMoneyApiService({
      staffAuth: { getSession: vi.fn().mockResolvedValue(null) },
      repairs: { moneyRequest: mocks.moneyRequest },
    })

    await expect(repairMoneyApiService.getSettlement(REPAIR_ID))
      .rejects.toThrow('REPAIR_STAFF_SESSION_REQUIRED')
    expect(mocks.moneyRequest).not.toHaveBeenCalled()
  })

  it('injects the secure native staff session into direct money writes', async () => {
    mocks.moneyRequest.mockRejectedValue(new Error('expected stop'))

    await repairMoneyApiService.recordPayment({
      operation_id: '77777777-7777-4777-8777-777777777777',
      repair_id: REPAIR_ID,
      expected_version: 3,
      occurred_at: '2026-08-31T11:00:00.000Z',
      payload: { amount_minor: 1000, payment_method: 'cash' },
    })

    expect(mocks.moneyRequest).toHaveBeenCalledWith({
      staffSessionId: STAFF_SESSION_ID,
      request: {
        action: 'payment',
          operation_id: '77777777-7777-4777-8777-777777777777',
          repair_id: REPAIR_ID,
          expected_version: 3,
          occurred_at: '2026-08-31T11:00:00.000Z',
        amount_minor: 1000,
        payment_method: 'cash',
      },
    })
  })
})
