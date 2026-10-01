/**
 * The incoming-order dialog's error boundary must never leave the register
 * without its alert for good: it logs what it catches and resets by itself,
 * at once when there is another order to show, else on a timer.
 */
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../contexts/module-context', () => ({ useModules: () => ({ businessType: 'restaurant' }) }))
vi.mock('../../../hooks/useFeatures', () => ({ useFeatures: () => ({ isMobileWaiter: false }) }))
vi.mock('../../../../lib', () => ({ emitCompatEvent: vi.fn(), onEvent: vi.fn(), offEvent: vi.fn() }))
vi.mock('../../../hooks/useOrderStore', async () => {
  const { create } = await import('zustand')
  return { useOrderStore: create<Record<string, unknown>>(() => ({ orders: [], pendingExternalOrders: [] })) }
})
vi.mock('../../../services/appAudio', () => ({
  isAppAudioEnabled: () => false,
  subscribeAppAudio: () => () => {},
  playAppAudioTones: vi.fn(() => () => {}),
}))
vi.mock('../../../services/platformNotificationSound', () => ({ playSelectedPlatformSound: vi.fn(() => () => {}) }))

import {
  INCOMING_ORDER_ALERT_RETRY_MS,
  IncomingOrderAlertBoundary,
  ORDERS_SCREEN_VIEWS,
  resolveIncomingOrderAlertLocation,
} from '../IncomingOrderAlertManager'

const control = { throwing: true }

function Flaky({ label }: { label: string }) {
  if (control.throwing) throw new Error('dialog render failed')
  return <div>{label}</div>
}

describe('IncomingOrderAlertBoundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    control.throwing = true
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('logs the failure, renders nothing, and retries by itself on a timer', () => {
    const onError = vi.fn()
    render(
      <IncomingOrderAlertBoundary resetKey="order:ef-1" onError={onError}>
        <Flaky label="alert dialog" />
      </IncomingOrderAlertBoundary>,
    )

    expect(screen.queryByText('alert dialog')).toBeNull()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'dialog render failed' }))
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[IncomingOrderAlert] the alert dialog failed to render'),
      expect.anything(),
      expect.anything(),
    )

    control.throwing = false
    act(() => {
      vi.advanceTimersByTime(INCOMING_ORDER_ALERT_RETRY_MS)
    })
    expect(screen.getByText('alert dialog')).toBeInTheDocument()
  })

  it('backs off while it keeps failing, and resets at once when there is another order to show', () => {
    const onError = vi.fn()
    const { rerender } = render(
      <IncomingOrderAlertBoundary resetKey="order:ef-1" onError={onError}>
        <Flaky label="alert dialog" />
      </IncomingOrderAlertBoundary>,
    )
    act(() => {
      vi.advanceTimersByTime(INCOMING_ORDER_ALERT_RETRY_MS)
    })
    // Second failure: the next retry waits twice as long.
    expect(onError).toHaveBeenCalledTimes(2)
    act(() => {
      vi.advanceTimersByTime(INCOMING_ORDER_ALERT_RETRY_MS)
    })
    expect(onError).toHaveBeenCalledTimes(2)

    control.throwing = false
    rerender(
      <IncomingOrderAlertBoundary resetKey="order:ef-2" onError={onError}>
        <Flaky label="alert dialog" />
      </IncomingOrderAlertBoundary>,
    )
    expect(screen.getByText('alert dialog')).toBeInTheDocument()
  })
})

describe('where the alert is', () => {
  it('/new-order renders without the layout: never the Orders screen', () => {
    expect(resolveIncomingOrderAlertLocation('/new-order', null)).toEqual({ view: 'new-order', onOrdersScreen: false })
    // A stale layout view never makes /new-order the Orders screen.
    expect(resolveIncomingOrderAlertLocation('/new-order/', 'dashboard')).toEqual({ view: 'new-order', onOrdersScreen: false })
  })

  it('on the layout routes, the layout view decides; the product catalog is an Orders screen', () => {
    expect(resolveIncomingOrderAlertLocation('/', 'dashboard').onOrdersScreen).toBe(true)
    expect(resolveIncomingOrderAlertLocation('/dashboard', 'product_catalog').onOrdersScreen).toBe(true)
    expect(resolveIncomingOrderAlertLocation('/', 'tables')).toEqual({ view: 'tables', onOrdersScreen: false })
    expect(resolveIncomingOrderAlertLocation('/', 'efood_partner').onOrdersScreen).toBe(false)
    expect(ORDERS_SCREEN_VIEWS.has('product_catalog')).toBe(true)
  })

  it('while the layout is still loading nothing is known to be on screen, so the dialog may show', () => {
    expect(resolveIncomingOrderAlertLocation('/', null)).toEqual({ view: 'layout-loading', onOrdersScreen: false })
  })
})
