/**
 * Shared rule R5 (round 3, 01/10/2026): a refund names its tender, and an
 * `other` tender is never guessed as cash. The edit-settlement refund (and
 * the order's refund screen) started every non-card payment as a CASH refund
 * from the drawer, so refunding an `other` payment lowered the drawer's
 * expected cash for money that never left it. They now start from the
 * payment's own tender: cash, card, or `other` (round 3 review: a refund
 * always names its tender, as Android stores it).
 *
 * Shared rule R2 (round 3 review): who hands a cash refund back is the
 * till's rule, shown and never sent. Shared rule R1: the platform's
 * settlement row is never refunded.
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.defaultValue === 'string' ? (options.defaultValue as string) : key,
  }),
}))

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}))

vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({
    children,
    isOpen,
    footer,
  }: {
    children: React.ReactNode
    isOpen: boolean
    footer?: React.ReactNode
  }) =>
    isOpen ? (
      <div role="dialog">
        {children}
        {footer}
      </div>
    ) : null,
}))

import { EditOrderRefundSettlementModal } from '../EditOrderRefundSettlementModal'
import { refundFormDefaults, refundRouteForTender } from '../RefundAttributionFields'

afterEach(() => cleanup())

const preview = (method: string, extra: Record<string, unknown> = {}) =>
  ({
    success: true,
    orderId: 'ord-r5',
    orderType: 'pickup',
    isGhostOrder: false,
    originalTotal: 10,
    nextTotal: 6,
    paidTotal: 10,
    ledgerPaidTotal: 10,
    refundAmount: 4,
    delta: -4,
    paymentStatus: 'paid',
    paymentMethod: method,
    requiredAction: 'refund',
    completedPayments: [
      { id: `pay-${method}`, method, amount: 10, remainingRefundable: 10, createdAt: '2026-10-01T10:00:00Z' },
    ],
    deliverySettlement: { driverCashOwned: false },
    ...extra,
  }) as any

const confirmWithReason = async (onConfirm: ReturnType<typeof vi.fn>) => {
  fireEvent.change(screen.getByPlaceholderText('Enter refund reason...'), {
    target: { value: 'Synthetic refund' },
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record Refund' }))
  })
  await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  return onConfirm.mock.calls[0][0] as Array<Record<string, unknown>>
}

describe('refund tender (R5)', () => {
  it('names an other tender as other, never cash and never nothing', async () => {
    const onConfirm = vi.fn(async () => {})
    render(<EditOrderRefundSettlementModal isOpen preview={preview('other')} onConfirm={onConfirm} />)
    const refunds = await confirmWithReason(onConfirm)
    expect(refunds).toHaveLength(1)
    expect(refunds[0].refundMethod).toBe('other')
    expect('cashHandler' in refunds[0]).toBe(false)
  })

  it("starts a cash payment as a cash refund and shows the rule's handler, never sends one", async () => {
    const onConfirm = vi.fn(async () => {})
    render(
      <EditOrderRefundSettlementModal
        isOpen
        preview={preview('cash', { cashHandlerByRule: 'driver_shift' })}
        onConfirm={onConfirm}
      />,
    )
    expect(screen.getByTestId('refund-cash-handler').textContent).toContain('Driver Cash')
    expect(screen.queryByRole('button', { name: /Cashier Cash/ })).toBeNull()
    const refunds = await confirmWithReason(onConfirm)
    expect(refunds[0].refundMethod).toBe('cash')
    expect('cashHandler' in refunds[0]).toBe(false)
  })

  it('never allocates the refund to the platform settlement row (R1)', async () => {
    const onConfirm = vi.fn(async () => {})
    const settled = preview('cash')
    settled.completedPayments = [
      { id: 'settle-1', method: 'other', amount: 10, remainingRefundable: 10, createdAt: '2026-10-01T09:00:00Z', platformSettlement: true },
      ...settled.completedPayments,
    ]
    render(<EditOrderRefundSettlementModal isOpen preview={settled} onConfirm={onConfirm} />)
    expect(screen.getByTestId('edit-refund-platform-settlement-settle-1')).toBeTruthy()
    const refunds = await confirmWithReason(onConfirm)
    expect(refunds.map((refund) => refund.paymentId)).toEqual(['pay-cash'])
  })

  it("reads the till's tender and handler for the refund screen", () => {
    expect(refundRouteForTender('other')).toBe('other')
    expect(refundRouteForTender('gift_card')).toBe('other')
    expect(refundRouteForTender('CARD')).toBe('card')
    expect(
      refundFormDefaults(
        { method: 'cash' },
        { defaultRefundMethod: 'cash', cashHandlerByRule: 'driver_shift' },
      ),
    ).toEqual({ refundMethod: 'cash', cashHandler: 'driver_shift' })
    expect(refundFormDefaults({ method: 'other' }, undefined)).toEqual({
      refundMethod: 'other',
      cashHandler: null,
    })
  })
})
