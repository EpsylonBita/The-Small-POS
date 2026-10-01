/**
 * Shared rule R4 (round 3, 01/10/2026): "Record the payment" is never offered
 * for an order whose money the delivery platform holds. The server refused
 * the till's payment on it as platform-held and the payment was set aside;
 * while the settlement is not mirrored, the Z listed the order with no
 * payment and offered to record cash or card for it, which the server
 * refuses again. The till marks such a blocker `platformHeld`, and the panel
 * never offers a tender for it.
 */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.defaultValue === 'string' ? (options.defaultValue as string) : key,
  }),
}))

import type { UnsettledPaymentBlocker } from '../../../../lib/ipc-contracts'
import { UnsettledPaymentBlockersPanel } from '../UnsettledPaymentBlockersPanel'

const blocker = (overrides: Partial<UnsettledPaymentBlocker> = {}): UnsettledPaymentBlocker => ({
  orderId: 'ord-platform-held',
  orderNumber: 'A-0404',
  totalAmount: 13,
  settledAmount: 0,
  paymentStatus: 'pending',
  paymentMethod: 'pending',
  reasonCode: 'no_persisted_payment',
  reasonText: 'Order was completed without a persisted cash/card payment.',
  suggestedFix: 'Record the missing cash or card payment.',
  severity: 'blocking',
  ...overrides,
})

afterEach(() => cleanup())

const recordButtons = () =>
  screen.queryAllByRole('button').filter((button) => /cash|card/i.test(button.textContent ?? ''))

describe('UnsettledPaymentBlockersPanel and platform-held money', () => {
  it('offers to record cash or card for a store order with no payment', () => {
    render(<UnsettledPaymentBlockersPanel blockers={[blocker()]} onResolveBlocker={vi.fn()} />)
    expect(recordButtons().length).toBeGreaterThan(0)
  })

  it('never offers to record a tender when the platform holds the money', () => {
    const onResolveBlocker = vi.fn()
    render(
      <UnsettledPaymentBlockersPanel
        blockers={[blocker({ platformHeld: true })]}
        onResolveBlocker={onResolveBlocker}
      />,
    )
    expect(screen.getByText('A-0404')).toBeTruthy()
    expect(recordButtons()).toEqual([])
    expect(onResolveBlocker).not.toHaveBeenCalled()
  })
})
