/**
 * The app-shell incoming-order alert knows the approval of an order is on
 * screen by the marker its approval panel carries (and the decline dialog,
 * which covers the panel while staff type a reason). A view-only panel accepts
 * nothing, so it must not pass for an answer.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// One stable translator: the panel re-loads its items whenever `t` changes.
const i18n = vi.hoisted(() => {
  const t = (key: string, options?: Record<string, unknown>) =>
    typeof options?.defaultValue === 'string' ? (options.defaultValue as string) : key
  return { value: { t, language: 'en' } }
})

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
import { INCOMING_ORDER_APPROVAL_MARKER_ATTR } from '../../../services/incomingOrderAlert'

const order = {
  id: 'ef-1',
  order_number: 'ORD-ef-1',
  status: 'pending',
  plugin: 'efood',
  external_plugin_order_id: 'EF-1',
  order_type: 'delivery',
  created_at: '2026-09-30T14:17:23Z',
  total_amount: 12,
  items: [{ menu_item_id: 'crepe', name: 'Crepe', quantity: 2, price: 6 }],
} as any

const markers = () =>
  Array.from(document.querySelectorAll(`[${INCOMING_ORDER_APPROVAL_MARKER_ATTR}]`))

describe('OrderApprovalPanel incoming-order marker', () => {
  afterEach(() => cleanup())

  it('marks the approval panel with the order id', () => {
    render(
      <OrderApprovalPanel
        order={order}
        onApprove={vi.fn(async () => {})}
        onDecline={vi.fn(async () => {})}
        onClose={vi.fn()}
        viewOnly={false}
      />,
    )

    expect(markers().length).toBeGreaterThan(0)
    expect(markers().every((marker) => marker.getAttribute(INCOMING_ORDER_APPROVAL_MARKER_ATTR) === 'ef-1')).toBe(true)
  })

  it('keeps the marker on the decline dialog that covers the panel', () => {
    render(
      <OrderApprovalPanel
        order={order}
        onApprove={vi.fn(async () => {})}
        onDecline={vi.fn(async () => {})}
        onClose={vi.fn()}
        viewOnly={false}
      />,
    )
    const before = markers().length

    fireEvent.click(screen.getByRole('button', { name: /decline/i }))

    expect(markers().length).toBe(before + 1)
  })

  it('a view-only panel carries no marker', () => {
    render(
      <OrderApprovalPanel
        order={order}
        onApprove={vi.fn(async () => {})}
        onDecline={vi.fn(async () => {})}
        onClose={vi.fn()}
        viewOnly
      />,
    )

    expect(markers()).toHaveLength(0)
  })
})
