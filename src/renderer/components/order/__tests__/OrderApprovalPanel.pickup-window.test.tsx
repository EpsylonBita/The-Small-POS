/**
 * The accept window of a platform order whose own fleet delivers (founder,
 * 01/10/2026: «Δείχνει όριο, κλειδώνει τα μεγαλύτερα»): the picker shows the
 * platform's estimate and the latest time it takes, the longer times are
 * locked, and the accept sends what the window holds at that moment.
 *
 * Parity pin: POSSystemMobile runs the same cases (shared
 * pickup-window.parity-cases.ts) through its own two accept windows.
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PICKUP_WINDOW_PARITY_CASES,
  PARITY_PICKUP_WINDOW,
} from '../../../../../../shared/pickup-window.parity-cases'
import { PICKUP_WINDOW_REFRESH_MS } from '../../../../../../shared/pickup-window'

// One stable translator (the panel re-loads its items whenever `t` changes)
// that fills the English defaults the way i18next does.
const i18n = vi.hoisted(() => {
  const t = (key: string, options?: Record<string, unknown>) => {
    const template = typeof options?.defaultValue === 'string' ? (options.defaultValue as string) : key
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))
  }
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

const baseOrder = {
  id: 'ef-1',
  order_number: 'ORD-ef-1',
  status: 'pending',
  plugin: 'efood',
  external_plugin_order_id: 'EF-1',
  order_type: 'delivery',
  created_at: '2026-09-30T18:04:19Z',
  total_amount: 12,
  items: [{ menu_item_id: 'crepe', name: 'Crepe', quantity: 2, price: 6 }],
}

const withWindow = { food_delivery: { short_code: '4821', pickup_window: PARITY_PICKUP_WINDOW } }

function renderPanel(ghostMetadata: unknown, onApprove = vi.fn(async (_id: string, _minutes?: number) => {})) {
  render(
    <OrderApprovalPanel
      order={{ ...baseOrder, ghost_metadata: ghostMetadata } as any}
      onApprove={onApprove}
      onDecline={vi.fn(async () => {})}
      onClose={vi.fn()}
    />,
  )
  return onApprove
}

/** [minutes, disabled, isMax] for every prep-time button, in screen order. */
function prepChoices(): Array<[number, boolean, boolean]> {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid^="order-approval-prep-"]')).map(
    (button) => [
      Number(button.dataset.testid!.replace('order-approval-prep-', '')),
      button.disabled,
      /max$/.test(button.textContent ?? ''),
    ],
  )
}

function selectedChoice(): number | null {
  const pressed = document.querySelector<HTMLButtonElement>('[data-testid^="order-approval-prep-"][aria-pressed="true"]')
  return pressed ? Number(pressed.dataset.testid!.replace('order-approval-prep-', '')) : null
}

async function approve(onApprove: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))
  await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1))
}

describe('OrderApprovalPanel platform pickup window', () => {
  beforeEach(() => {
    // Timeouts stay real so the panel's item loading and waitFor still run.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  describe.each(PICKUP_WINDOW_PARITY_CASES)('parity case: $name', (parityCase) => {
    it('offers the shared choices and accepts with the minutes the window holds', async () => {
      const at = Date.parse(parityCase.now)
      if (parityCase.selected === undefined) {
        vi.setSystemTime(at)
        const onApprove = renderPanel(parityCase.ghostMetadata)
        expect(prepChoices()).toEqual(parityCase.expected.choices)
        expect(selectedChoice()).toBe(parityCase.expected.selected)
        await approve(onApprove)
        expect(onApprove).toHaveBeenCalledWith('ef-1', parityCase.expected.selected)
        return
      }

      // Staff picked while the time was still open; the window then shrank.
      const pickable = Date.parse(PARITY_PICKUP_WINDOW.latest_pickup_at) - (parityCase.selected + 1) * 60_000
      vi.setSystemTime(pickable)
      const onApprove = renderPanel(parityCase.ghostMetadata)
      fireEvent.click(screen.getByTestId(`order-approval-prep-${parityCase.selected}`))
      expect(selectedChoice()).toBe(parityCase.selected)

      vi.setSystemTime(at - PICKUP_WINDOW_REFRESH_MS)
      act(() => {
        vi.advanceTimersByTime(PICKUP_WINDOW_REFRESH_MS)
      })
      expect(prepChoices()).toEqual(parityCase.expected.choices)
      expect(selectedChoice()).toBe(parityCase.expected.selected)
      await approve(onApprove)
      expect(onApprove).toHaveBeenCalledWith('ef-1', parityCase.expected.selected)
    })
  })

  it("shows the platform's estimate and the latest time it takes", () => {
    vi.setSystemTime(Date.parse('2026-09-30T18:05:28.000Z'))
    renderPanel(withWindow)

    expect(screen.getByTestId('order-approval-pickup-window').textContent).toBe('Efood: 11′ · up to 27′')
  })

  it('says so when the latest pickup has passed and only the minimum is sent', () => {
    vi.setSystemTime(Date.parse('2026-09-30T18:34:00.000Z'))
    renderPanel(withWindow)

    expect(screen.getByTestId('order-approval-pickup-window').textContent).toBe(
      "Efood's latest pickup time has passed: 1′ will be sent.",
    )
  })

  it('an order without a window shows no limit', () => {
    vi.setSystemTime(Date.parse('2026-09-30T18:05:28.000Z'))
    renderPanel({ food_delivery: { short_code: '4821', delivery_provider: 'vendor_delivery' } })

    expect(screen.queryByTestId('order-approval-pickup-window')).toBeNull()
  })

  it('re-reads the window every 15 s while open', () => {
    vi.setSystemTime(Date.parse('2026-09-30T18:05:28.000Z'))
    renderPanel(withWindow)
    expect(screen.getByTestId('order-approval-prep-20')).not.toBeDisabled()

    // 12 minutes later the latest pickup is 15′ away: 20′ locks.
    vi.setSystemTime(Date.parse('2026-09-30T18:17:28.000Z') - PICKUP_WINDOW_REFRESH_MS)
    act(() => {
      vi.advanceTimersByTime(PICKUP_WINDOW_REFRESH_MS)
    })

    expect(screen.getByTestId('order-approval-prep-20')).toBeDisabled()
    expect(selectedChoice()).toBe(15)
    expect(screen.getByTestId('order-approval-pickup-window').textContent).toBe('Efood: 11′ · up to 15′')
  })

  it('reads the window again at the moment of accepting', async () => {
    vi.setSystemTime(Date.parse('2026-09-30T18:05:28.000Z'))
    const onApprove = renderPanel(withWindow)
    expect(selectedChoice()).toBe(20)

    // The screen has not refreshed yet, but only 15′ is left.
    vi.setSystemTime(Date.parse('2026-09-30T18:17:28.000Z'))
    await approve(onApprove)

    expect(onApprove).toHaveBeenCalledWith('ef-1', 15)
  })
})
