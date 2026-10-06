/**
 * Fix review 06/10/2026: a cashier-confirmed TWINT receipt that can never be
 * saved (its last save met a lasting refusal) held the Z with no way out: the
 * card-style "Money given back to the customer" is never offered for TWINT.
 * The Z now offers "Returned via TWINT outside the POS" for exactly that case,
 * and never while the original receipt can still be saved.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown> | string) =>
      typeof options === 'string'
        ? options
        : typeof options?.defaultValue === 'string' ? (options.defaultValue as string) : key,
  }),
}))

import type { UnsettledPaymentBlocker } from '../../../../lib/ipc-contracts'
import { UnsettledPaymentBlockersPanel } from '../UnsettledPaymentBlockersPanel'

const KEY = 'twint-receipt-key'
const blocker = (unsaved: Record<string, unknown>): UnsettledPaymentBlocker => ({
  orderId: 'order-twint',
  orderNumber: 'A-0412',
  totalAmount: 12.35,
  settledAmount: 0,
  paymentStatus: 'pending',
  paymentMethod: 'twint',
  reasonCode: 'payments_not_saved',
  reasonText: 'A TWINT receipt is confirmed but not saved.',
  suggestedFix: 'Save the original receipt.',
  severity: 'blocking',
  unsavedPayment: {
    idempotencyKey: KEY,
    method: 'twint',
    kind: 'manual_twint_payment',
    amount: 12.35,
    amountCents: 1235,
    currency: 'CHF',
    capturedAt: '2026-10-06T10:05:00Z',
    attempts: 3,
    canSaveAgain: false,
    manualReceiptConfirmed: true,
    ...unsaved,
  },
} as unknown as UnsettledPaymentBlocker)

const returnedButton = () => screen.queryByTestId(`twint-returned-${KEY}`)

afterEach(() => cleanup())

describe('UnsettledPaymentBlockersPanel and TWINT returned outside the POS', () => {
  it('offers it for a TWINT receipt that can never be saved, and never the card way out', () => {
    const onResolveTwintReturned = vi.fn()
    const onResolveUnsavedPayment = vi.fn()
    const target = blocker({})
    render(
      <UnsettledPaymentBlockersPanel
        blockers={[target]}
        onResolveTwintReturned={onResolveTwintReturned}
        onResolveUnsavedPayment={onResolveUnsavedPayment}
        onSaveUnsavedPayment={vi.fn()}
      />,
    )
    expect(returnedButton()).toHaveTextContent('Returned via TWINT outside the POS')
    expect(screen.queryByRole('button', { name: /Money given back to the customer/ })).toBeNull()
    fireEvent.click(returnedButton()!)
    expect(onResolveTwintReturned).toHaveBeenCalledWith(target)
    expect(onResolveUnsavedPayment).not.toHaveBeenCalled()
  })

  it('never offers it while the original receipt can still be saved', () => {
    render(
      <UnsettledPaymentBlockersPanel
        blockers={[blocker({ canSaveAgain: true })]}
        onResolveTwintReturned={vi.fn()}
        onSaveUnsavedPayment={vi.fn()}
      />,
    )
    expect(returnedButton()).toBeNull()
  })

  it('never offers it for a legacy TWINT record or a card payment', () => {
    render(
      <UnsettledPaymentBlockersPanel
        blockers={[blocker({ kind: 'single' }), { ...blocker({ method: 'card', kind: 'single' }), orderId: 'order-card' } as UnsettledPaymentBlocker]}
        onResolveTwintReturned={vi.fn()}
      />,
    )
    expect(returnedButton()).toBeNull()
  })

  it('is not offered where no manager resolution is wired', () => {
    render(<UnsettledPaymentBlockersPanel blockers={[blocker({})]} />)
    expect(returnedButton()).toBeNull()
  })
})
