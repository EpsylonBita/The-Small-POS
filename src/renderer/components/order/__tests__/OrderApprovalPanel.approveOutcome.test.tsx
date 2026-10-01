/**
 * Round 3 item DR4 (01/10/2026): the approval reported a failure as a
 * success. When approving failed, the dashboard showed its error and
 * returned normally, so the panel still said "Approved" and closed while the
 * order stayed pending; on a success both the dashboard and the panel said
 * "Approved". Now the dashboard answers whether the order was approved: the
 * panel says "Approved" once, only for an approval that happened, and stays
 * open otherwise.
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
  id: 'ord-approve-1',
  order_number: 'ORD-approve-1',
  status: 'pending',
  order_type: 'pickup',
  created_at: '2026-10-01T09:00:00Z',
  total_amount: 9,
  payment_status: 'pending',
  items: [{ menu_item_id: 'crepe', name: 'Crepe', quantity: 1, price: 9 }],
} as any

beforeEach(() => {
  toastMock.success.mockClear()
  toastMock.error.mockClear()
})

afterEach(() => cleanup())

const pressApprove = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))
  })
}

describe('OrderApprovalPanel approval outcome', () => {
  it('never says Approved, nor closes, when the approval did not happen', async () => {
    const onClose = vi.fn()
    const onApprove = vi.fn(async () => false)
    render(
      <OrderApprovalPanel
        order={order}
        onApprove={onApprove}
        onDecline={vi.fn(async () => true)}
        onClose={onClose}
      />,
    )

    await pressApprove()

    await waitFor(() => expect(onApprove).toHaveBeenCalledWith('ord-approve-1', expect.any(Number)))
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says Approved once, and closes, when the order was approved', async () => {
    const onClose = vi.fn()
    render(
      <OrderApprovalPanel
        order={order}
        onApprove={vi.fn(async () => true)}
        onDecline={vi.fn(async () => true)}
        onClose={onClose}
      />,
    )

    await pressApprove()

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(toastMock.success).toHaveBeenCalledTimes(1)
    expect(toastMock.success).toHaveBeenCalledWith('orderApprovalPanel.approved')
  })
})
