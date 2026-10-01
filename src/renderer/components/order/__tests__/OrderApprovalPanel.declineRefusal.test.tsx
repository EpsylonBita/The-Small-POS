/**
 * Item D2, round 2 review (founder rule 30/09 and 01/10/2026: an order is
 * never paid without its payment record, and a refusal comes before any
 * reason or PIN).
 *
 * The decline asked for the reason first and only then checked whether the
 * till refuses it (money taken on it, or a paid label with no payment record
 * here). On a refusal the dashboard showed the error and returned normally,
 * so the panel still said "Declined" and closed while the order stayed open.
 * Now the check runs when Decline is pressed, and a decline that did not
 * happen is never reported as one.
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const i18n = vi.hoisted(() => {
  const t = (key: string, options?: Record<string, unknown>) =>
    typeof options?.defaultValue === 'string' ? (options.defaultValue as string) : key
  return { value: { t, language: 'en' } }
})

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: toastMock.success, error: toastMock.error, dismiss: vi.fn() }),
}))

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => i18n.value,
}))

vi.mock('../../../../lib', () => ({
  emitCompatEvent: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  getBridge: () => ({
    orders: { getById: vi.fn(async () => null), fetchItemsFromSupabase: vi.fn(async () => []) },
    customers: { lookupByPhone: vi.fn(async () => null) },
    payments: { printReceipt: vi.fn(async () => ({ success: true })) },
  }),
}))

import { OrderApprovalPanel } from '../OrderApprovalPanel'

const order = {
  id: 'ord-decline-1',
  order_number: 'ORD-decline-1',
  status: 'pending',
  order_type: 'pickup',
  created_at: '2026-10-01T09:00:00Z',
  total_amount: 9,
  payment_status: 'paid',
  items: [{ menu_item_id: 'crepe', name: 'Crepe', quantity: 1, price: 9 }],
} as any

const reasonBox = () => screen.queryByPlaceholderText('Enter a reason...')

beforeEach(() => {
  toastMock.success.mockClear()
  toastMock.error.mockClear()
})

afterEach(() => cleanup())

describe('OrderApprovalPanel decline refusals', () => {
  it('asks no reason when the till refuses the decline', async () => {
    const onBeforeDecline = vi.fn(async () => false)
    const onDecline = vi.fn(async () => true)
    render(
      <OrderApprovalPanel
        order={order}
        onApprove={vi.fn(async () => {})}
        onDecline={onDecline}
        onBeforeDecline={onBeforeDecline}
        onClose={vi.fn()}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^decline$/i }))
    })

    await waitFor(() => expect(onBeforeDecline).toHaveBeenCalledWith('ord-decline-1'))
    expect(reasonBox()).toBeNull()
    expect(onDecline).not.toHaveBeenCalled()
  })

  it('asks the reason when the decline may go on', async () => {
    const onBeforeDecline = vi.fn(async () => true)
    render(
      <OrderApprovalPanel
        order={order}
        onApprove={vi.fn(async () => {})}
        onDecline={vi.fn(async () => true)}
        onBeforeDecline={onBeforeDecline}
        onClose={vi.fn()}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^decline$/i }))
    })

    await waitFor(() => expect(reasonBox()).not.toBeNull())
  })

  it('never says Declined, nor closes, when the decline did not happen', async () => {
    const onClose = vi.fn()
    const onDecline = vi.fn(async () => false)
    render(
      <OrderApprovalPanel
        order={order}
        onApprove={vi.fn(async () => {})}
        onDecline={onDecline}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }))
    fireEvent.change(reasonBox()!, { target: { value: 'Out of stock' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    })

    await waitFor(() => expect(onDecline).toHaveBeenCalledWith('ord-decline-1', 'Out of stock'))
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still reports a decline that happened', async () => {
    const onClose = vi.fn()
    render(
      <OrderApprovalPanel
        order={order}
        onApprove={vi.fn(async () => {})}
        onDecline={vi.fn(async () => true)}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }))
    fireEvent.change(reasonBox()!, { target: { value: 'Out of stock' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    })

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(toastMock.success).toHaveBeenCalledWith('orderApprovalPanel.declined')
  })
})
