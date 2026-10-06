/**
 * Review 06/10/2026 (#318 follow-up): the approval panel's "Print receipt"
 * said "Receipt printed successfully" as soon as the job was queued, also for
 * a job that failed or waited for the platform's items. It now reads the
 * queue first, as the dashboard does, and names only what happened.
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const i18n = vi.hoisted(() => {
  const t = (key: string, options?: Record<string, unknown>) =>
    typeof options?.defaultValue === 'string' ? (options.defaultValue as string) : key
  return { value: { t, language: 'en' } }
})

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  printReceipt: vi.fn(),
  listJobs: vi.fn(),
}))

vi.mock('react-hot-toast', () => ({
  default: Object.assign(h.toast, { success: h.success, error: h.error, dismiss: vi.fn() }),
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
    payments: { printReceipt: h.printReceipt },
    printer: { listJobs: h.listJobs },
  }),
}))

import { OrderApprovalPanel } from '../OrderApprovalPanel'

const order = {
  id: 'ord-print-1',
  order_number: 'ORD-print-1',
  status: 'pending',
  order_type: 'pickup',
  created_at: '2026-10-06T09:00:00Z',
  total_amount: 9,
  payment_status: 'pending',
  items: [{ menu_item_id: 'crepe', name: 'Crepe', quantity: 1, price: 9 }],
} as any

const job = (status: string, warningCode: string | null = null) => ({
  jobs: [{ id: 'job-1', status, warningCode }],
})

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  for (const mock of [h.toast, h.success, h.error, h.printReceipt, h.listJobs]) mock.mockReset()
  h.printReceipt.mockResolvedValue({ success: true, jobId: 'job-1' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const pressPrint = async () => {
  render(
    <OrderApprovalPanel order={order} viewOnly onApprove={vi.fn(async () => true)}
      onDecline={vi.fn(async () => true)} onClose={vi.fn()} />,
  )
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Print receipt' }))
  })
}

describe('OrderApprovalPanel print outcome', () => {
  it('says sent only once the queue handed the job to the printer', async () => {
    h.listJobs.mockResolvedValue(job('dispatched'))
    await pressPrint()
    await waitFor(() => expect(h.success).toHaveBeenCalledWith('Receipt sent to the printer.'))
    expect(h.success).not.toHaveBeenCalledWith('Receipt printed successfully')
  })

  it('says the receipt was not printed when the job failed', async () => {
    h.listJobs.mockResolvedValue(job('failed'))
    await pressPrint()
    await waitFor(() => expect(h.error).toHaveBeenCalled())
    expect(h.success).not.toHaveBeenCalled()
  })

  it('says queued, never printed, while the queue cannot prove an outcome', async () => {
    h.printReceipt.mockResolvedValue({ success: true })
    await pressPrint()
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(
      'Receipt queued but not printed yet. Check the print queue if it does not come out.',
    ))
    expect(h.success).not.toHaveBeenCalled()
    expect(h.listJobs).not.toHaveBeenCalled()
  })
})
