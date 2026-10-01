/**
 * The incoming-order alert dialog: on every page, with a watchdog that
 * escalates when an order waits without its approval panel on screen
 * (Tomikro, desktop 1.4.119, 30/09/2026 — see services/incomingOrderAlert.ts).
 * The sound comes from the loop module (services/incomingOrderAlertLoop.ts),
 * started here as IncomingOrderAlertManager starts it in the app.
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TestOrder = Record<string, unknown> & { id: string }

const h = vi.hoisted(() => ({
  playSelectedPlatformSound: vi.fn(),
  stopSound: vi.fn(),
  audioEnabled: true,
}))

vi.mock('../../../hooks/useOrderStore', async () => {
  const { create } = await import('zustand')
  const store = create<Record<string, any>>(() => ({
    orders: [],
    pendingExternalOrders: [] as TestOrder[],
    initializeOrders: vi.fn(async () => {}),
    silentRefresh: vi.fn(async () => {}),
  }))
  return { useOrderStore: store }
})

vi.mock('../../../services/platformNotificationSound', () => ({
  playSelectedPlatformSound: (...args: unknown[]) => {
    h.playSelectedPlatformSound(...args)
    return h.stopSound
  },
}))

vi.mock('../../../services/appAudio', () => ({
  isAppAudioEnabled: () => h.audioEnabled,
  useAppAudioEnabled: () => h.audioEnabled,
  subscribeAppAudio: () => () => {},
  playAppAudioTones: vi.fn(() => () => {}),
}))

vi.mock('../../ui/pos-glass-components', () => ({
  MODAL_VIEWPORT_ATTR: 'data-liquid-glass-modal-viewport',
  useBackgroundAccessibilityIsolation: vi.fn(),
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && typeof options.platform === 'string' ? `${key}:${options.platform}` : key,
  }),
}))

vi.mock('../../../../lib', () => ({
  emitCompatEvent: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}))

import { IncomingOrderAlertHost } from '../IncomingOrderAlertHost'
import { useOrderStore } from '../../../hooks/useOrderStore'
import {
  INCOMING_ORDER_ALERT_REPEAT_MS,
  INCOMING_ORDER_ALERT_TAP_GUARD_MS,
  INCOMING_ORDER_PANEL_GRACE_MS,
  INCOMING_ORDER_WATCHDOG_MS,
  __resetIncomingOrderAlertForTests,
  readIncomingOrderAlertLog,
  subscribeIncomingOrderApprovalFocus,
} from '../../../services/incomingOrderAlert'
import {
  __resetIncomingOrderAlertLoopForTests,
  configureIncomingOrderAlertLoop,
  startIncomingOrderAlertLoop,
} from '../../../services/incomingOrderAlertLoop'
import { getBusinessCategory, getDashboardOrderFilter } from '../../dashboards/dashboardOrderScope'
import { ORDERS_SCREEN_VIEWS } from '../IncomingOrderAlertManager'
import { registerUiBlocker, unregisterUiBlocker } from '../../../services/uiBlockerRegistry'

const efoodOrder = (id: string, extra: Record<string, unknown> = {}): TestOrder => ({
  id,
  order_number: `ORD-${id}`,
  status: 'pending',
  plugin: 'efood',
  external_plugin_order_id: `EF-${id}`,
  created_at: '2026-09-30T14:17:23Z',
  items: [{ menu_item_id: 'crepe', name: 'Crepe', quantity: 1, price: 6 }],
  ...extra,
})

const retailOrder = (id: string): TestOrder =>
  efoodOrder(id, { items: [{ product_id: 'sku-1', product_name: 'Olive oil', quantity: 1, price: 9 }] })

const setPending = (orders: TestOrder[]) => {
  act(() => {
    useOrderStore.setState({ pendingExternalOrders: orders } as never)
  })
}

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const alertDialog = () => screen.queryByTestId('incoming-order-alert')

/** A tap or key right as the dialog appears is ignored; staff answer after that. */
const passTapGuard = () => advance(INCOMING_ORDER_ALERT_TAP_GUARD_MS)

const addApprovalMarker = (orderId: string) => {
  const marker = document.createElement('div')
  marker.setAttribute('data-incoming-order-approval', orderId)
  marker.textContent = `Approval for ${orderId}`
  document.body.appendChild(marker)
  return marker
}

let releaseLoop: (() => void) | null = null

/** Starts the loop with the Orders screen's scope, as the manager does, and renders the dialog. */
const renderAlert = (
  currentView: string,
  options: { businessType?: string; onOpenOrders?: () => void; onOrdersScreen?: boolean } = {},
) => {
  configureIncomingOrderAlertLoop({
    enabled: true,
    orderFilter: getDashboardOrderFilter(getBusinessCategory((options.businessType ?? 'restaurant') as never)),
    view: currentView,
  })
  releaseLoop = startIncomingOrderAlertLoop()
  return render(
    <IncomingOrderAlertHost
      currentView={currentView}
      onOrdersScreen={options.onOrdersScreen ?? ORDERS_SCREEN_VIEWS.has(currentView)}
      onOpenOrders={options.onOpenOrders ?? vi.fn()}
    />,
  )
}

describe('IncomingOrderAlertHost', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-30T14:17:33Z') })
    h.playSelectedPlatformSound.mockClear()
    h.stopSound.mockClear()
    h.audioEnabled = true
    __resetIncomingOrderAlertLoopForTests()
    useOrderStore.setState({ pendingExternalOrders: [] } as never)
    __resetIncomingOrderAlertForTests()
    window.localStorage.clear()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    releaseLoop?.()
    releaseLoop = null
    __resetIncomingOrderAlertLoopForTests()
    document.body.innerHTML = ''
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint
    vi.useRealTimers()
  })

  it('rings at once off the Orders screen, repeats every 30 s, and stops once the order is answered', () => {
    renderAlert('tables')
    setPending([efoodOrder('ef-1')])

    expect(alertDialog()).not.toBeNull()
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText('incomingOrderAlert.title:Efood')).toBeInTheDocument()
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
    expect(h.playSelectedPlatformSound).toHaveBeenCalledWith(expect.objectContaining({ volume: 0.9 }))

    advance(INCOMING_ORDER_ALERT_REPEAT_MS)
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(2)
    advance(INCOMING_ORDER_ALERT_REPEAT_MS)
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(3)

    setPending([])
    expect(alertDialog()).toBeNull()
    expect(h.stopSound).toHaveBeenCalled()
    advance(INCOMING_ORDER_ALERT_REPEAT_MS * 3)
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(3)

    const events = readIncomingOrderAlertLog().map((entry) => entry.event)
    expect(events[0]).toBe('alerting')
    expect(events).toContain('resolved')
  })

  it('rings at once for a second order arriving mid-cycle and counts the others waiting', () => {
    renderAlert('menu')
    setPending([efoodOrder('ef-1')])
    advance(10_000)
    setPending([efoodOrder('ef-1'), efoodOrder('ef-2')])

    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(2)
    expect(alertDialog()).toHaveAttribute('data-order-id', 'ef-1')
    expect(screen.getByTestId('incoming-order-alert-more')).toBeInTheDocument()
  })

  it('on the Orders screen stays quiet visually while the approval panel is on screen, and never double-rings', () => {
    addApprovalMarker('ef-1')
    renderAlert('dashboard')
    setPending([efoodOrder('ef-1')])

    expect(alertDialog()).toBeNull()
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

    advance(INCOMING_ORDER_WATCHDOG_MS * 2)
    expect(alertDialog()).toBeNull()
    // Two repeats in 60 s, from the one loop.
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(3)
    expect(readIncomingOrderAlertLog().some((entry) => ['missed', 'escalated'].includes(entry.event))).toBe(false)
  })

  it('the retail product catalog is an Orders screen too: no dialog over its own approval panel', () => {
    addApprovalMarker('ef-1')
    renderAlert('product_catalog', { businessType: 'retail' })
    setPending([efoodOrder('ef-1')])

    expect(alertDialog()).toBeNull()
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

    advance(INCOMING_ORDER_WATCHDOG_MS * 2)
    expect(alertDialog()).toBeNull()
    expect(readIncomingOrderAlertLog().some((entry) => ['missed', 'escalated'].includes(entry.event))).toBe(false)
  })

  it('a food order on the retail product catalog (whose Orders screen offers only product orders) gets the dialog within 2 s, never logged as missed', () => {
    // A restaurant with the product catalog module: the food order is this
    // register's to approve, but ProductCatalogView's OrderDashboard filters
    // it out, so no approval panel ever opens for it there.
    renderAlert('product_catalog', { businessType: 'restaurant' })
    setPending([efoodOrder('ef-1')])

    // A moment for a panel to open by itself: nothing flashed meanwhile.
    expect(alertDialog()).toBeNull()
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
    advance(INCOMING_ORDER_PANEL_GRACE_MS - 1_000)
    expect(alertDialog()).toBeNull()

    // No panel: the dialog shows promptly, not as an escalation.
    advance(1_000)
    const dialog = alertDialog()
    expect(dialog).not.toBeNull()
    expect(dialog).toHaveAttribute('data-order-id', 'ef-1')
    expect(dialog).toHaveAttribute('data-escalated', 'false')
    expect(screen.queryByTestId('incoming-order-alert-escalated')).toBeNull()
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
    expect(readIncomingOrderAlertLog().some((entry) => ['missed', 'escalated'].includes(entry.event))).toBe(false)

    // Left unanswered, the watchdog still fires — as «escalated»: staff had
    // the dialog in front of them.
    advance(INCOMING_ORDER_WATCHDOG_MS)
    const events = readIncomingOrderAlertLog().map((entry) => entry.event)
    expect(events).toContain('escalated')
    expect(events).not.toContain('missed')
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('MISSED ALERT'), expect.anything())
  })

  it('an order without product lines on the retail product catalog gets the dialog within 2 s too', () => {
    renderAlert('product_catalog', { businessType: 'retail' })
    setPending([efoodOrder('ef-1', { items: [] })])

    expect(alertDialog()).toBeNull()
    advance(INCOMING_ORDER_PANEL_GRACE_MS)
    expect(alertDialog()).toHaveAttribute('data-escalated', 'false')
  })

  it('an order on the Orders screen whose approval panel never shows: the dialog within 2 s, then the watchdog at 30 s («escalated»)', () => {
    renderAlert('dashboard')
    setPending([efoodOrder('ef-1')])

    // The Orders screen normally opens the panel by itself: no dialog yet.
    expect(alertDialog()).toBeNull()
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

    advance(INCOMING_ORDER_PANEL_GRACE_MS)
    expect(alertDialog()).toHaveAttribute('data-escalated', 'false')

    advance(INCOMING_ORDER_WATCHDOG_MS - INCOMING_ORDER_PANEL_GRACE_MS + 1_000)
    const dialog = alertDialog()
    expect(dialog).toHaveAttribute('data-escalated', 'true')
    expect(screen.getByTestId('incoming-order-alert-escalated')).toBeInTheDocument()
    // Rang again at the escalation, and only once for it.
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(2)

    const watchdogEntries = readIncomingOrderAlertLog().filter((entry) => ['missed', 'escalated'].includes(entry.event))
    expect(watchdogEntries).toHaveLength(1)
    expect(watchdogEntries[0]).toMatchObject({
      event: 'escalated',
      orderId: 'ef-1',
      platform: 'efood',
      view: 'dashboard',
      approvalInDom: false,
      overlayShown: true,
      escalated: true,
      audioEnabled: true,
    })
    expect(watchdogEntries[0].waitedMs).toBeGreaterThanOrEqual(INCOMING_ORDER_WATCHDOG_MS)
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('MISSED ALERT'), expect.anything())
  })

  it('reaching an Orders-screen view gives its approval panel the grace again: the dialog steps aside, and returns only if no panel shows', () => {
    const view = renderAlert('tables')
    setPending([efoodOrder('ef-1')])
    expect(alertDialog()).not.toBeNull()
    advance(10_000)

    // Staff reach the Orders screen: the dialog steps aside at once for its panel …
    view.rerender(<IncomingOrderAlertHost currentView="dashboard" onOrdersScreen onOpenOrders={vi.fn()} />)
    expect(alertDialog()).toBeNull()
    advance(INCOMING_ORDER_PANEL_GRACE_MS - 1_000)
    expect(alertDialog()).toBeNull()

    // … which never shows: the dialog is back.
    advance(1_000)
    expect(alertDialog()).toHaveAttribute('data-escalated', 'false')

    // Another Orders-screen view whose panel does show: no dialog over it.
    const marker = addApprovalMarker('ef-1')
    view.rerender(<IncomingOrderAlertHost currentView="product_catalog" onOrdersScreen onOpenOrders={vi.fn()} />)
    expect(alertDialog()).toBeNull()
    advance(INCOMING_ORDER_PANEL_GRACE_MS * 2)
    expect(alertDialog()).toBeNull()
    marker.remove()
  })

  it('watchdog: an order left unanswered with the dialog on screen is «escalated», not «missed»', () => {
    renderAlert('tables')
    setPending([efoodOrder('ef-1')])
    expect(alertDialog()).not.toBeNull()

    advance(INCOMING_ORDER_WATCHDOG_MS + 1_000)

    expect(alertDialog()).toHaveAttribute('data-escalated', 'true')
    const log = readIncomingOrderAlertLog()
    expect(log.some((entry) => entry.event === 'missed')).toBe(false)
    expect(log.find((entry) => entry.event === 'escalated')).toMatchObject({
      orderId: 'ef-1',
      view: 'tables',
      overlayShown: true,
      approvalInDom: false,
    })
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('MISSED ALERT'), expect.anything())
  })

  it('watchdog: after «Later» the escalation is «escalated» too — staff saw it', () => {
    renderAlert('tables')
    setPending([efoodOrder('ef-1')])
    passTapGuard()
    fireEvent.click(screen.getByTestId('incoming-order-alert-later'))

    advance(INCOMING_ORDER_WATCHDOG_MS + 1_000)

    const events = readIncomingOrderAlertLog().map((entry) => entry.event)
    expect(events).toContain('escalated')
    expect(events).not.toContain('missed')
  })

  it('an approval panel covered by another dialog is not on screen: the dialog within 2 s, and the log names the dialog', () => {
    const marker = addApprovalMarker('ef-1')
    marker.getBoundingClientRect = () =>
      ({ left: 100, top: 100, width: 400, height: 60, right: 500, bottom: 160, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect
    const settingsDialog = document.createElement('div')
    settingsDialog.setAttribute('role', 'dialog')
    document.body.appendChild(settingsDialog)
    ;(document as { elementsFromPoint?: unknown }).elementsFromPoint = vi.fn(() => [settingsDialog, marker, document.body])
    registerUiBlocker({ id: 'settings', label: 'LiquidGlassModal:Settings', source: 'shared-modal' })

    try {
      renderAlert('dashboard')
      setPending([efoodOrder('ef-1')])
      expect(alertDialog()).toBeNull()

      advance(INCOMING_ORDER_PANEL_GRACE_MS)
      expect(alertDialog()).toHaveAttribute('data-escalated', 'false')

      advance(INCOMING_ORDER_WATCHDOG_MS)

      expect(alertDialog()).toHaveAttribute('data-escalated', 'true')
      const escalated = readIncomingOrderAlertLog().find((entry) => entry.event === 'escalated')
      expect(escalated).toMatchObject({
        approvalInDom: true,
        overlayShown: true,
        openDialogs: ['LiquidGlassModal:Settings'],
      })
    } finally {
      unregisterUiBlocker('settings')
    }
  })

  it('watchdog: the same panel on top is on screen and never escalates', () => {
    const marker = addApprovalMarker('ef-1')
    const header = document.createElement('span')
    marker.appendChild(header)
    marker.getBoundingClientRect = () =>
      ({ left: 100, top: 100, width: 400, height: 60, right: 500, bottom: 160, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect
    ;(document as { elementsFromPoint?: unknown }).elementsFromPoint = vi.fn(() => [header, marker, document.body])

    renderAlert('dashboard')
    setPending([efoodOrder('ef-1')])
    advance(INCOMING_ORDER_WATCHDOG_MS * 3)

    expect(alertDialog()).toBeNull()
    expect(readIncomingOrderAlertLog().some((entry) => ['missed', 'escalated'].includes(entry.event))).toBe(false)
  })

  it('follows the audio setting: the dialog shows, nothing rings', () => {
    h.audioEnabled = false
    renderAlert('tables')
    setPending([efoodOrder('ef-1')])

    expect(alertDialog()).not.toBeNull()
    advance(INCOMING_ORDER_ALERT_REPEAT_MS * 2)
    expect(h.playSelectedPlatformSound).not.toHaveBeenCalled()
  })

  it('never alerts for an order the Orders screen does not offer for approval', () => {
    renderAlert('tables')
    // Food scope: a retail product order is not this register's to approve.
    setPending([retailOrder('retail-1')])
    advance(INCOMING_ORDER_WATCHDOG_MS * 2)

    expect(alertDialog()).toBeNull()
    expect(h.playSelectedPlatformSound).not.toHaveBeenCalled()
    expect(readIncomingOrderAlertLog()).toEqual([])
  })

  it('a service business Orders screen offers every order, so it alerts for the same order', () => {
    renderAlert('tables', { businessType: 'salon' })
    setPending([retailOrder('retail-1')])

    expect(alertDialog()).not.toBeNull()
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
  })

  it('«Open the order» shows the Orders screen and asks it for this order', () => {
    const onOpenOrders = vi.fn()
    renderAlert('tables', { onOpenOrders })
    setPending([efoodOrder('ef-1'), efoodOrder('ef-2')])

    passTapGuard()
    fireEvent.click(screen.getByTestId('incoming-order-alert-open'))
    expect(onOpenOrders).toHaveBeenCalledTimes(1)
    expect(alertDialog()).toBeNull()

    // The Orders screen mounts after the navigation and still gets the request.
    const focused: string[] = []
    const unsubscribe = subscribeIncomingOrderApprovalFocus((orderId) => focused.push(orderId))
    expect(focused).toEqual(['ef-1'])
    unsubscribe()
  })

  it('takes focus on the dialog, never on a button, and gives it back when the dialog closes', () => {
    const onOpenOrders = vi.fn()
    const input = document.createElement('input')
    input.setAttribute('aria-label', 'Barcode')
    document.body.appendChild(input)
    input.focus()

    renderAlert('tables', { onOpenOrders })
    setPending([efoodOrder('ef-1')])

    const dialog = screen.getByRole('dialog')
    expect(document.activeElement).toBe(dialog)
    expect(screen.getByTestId('incoming-order-alert-open')).not.toHaveFocus()
    // A scanner's Enter / a Space already in flight lands on the dialog, not
    // on «Open the order».
    fireEvent.keyDown(dialog, { key: 'Enter' })
    fireEvent.keyUp(dialog, { key: 'Enter' })
    fireEvent.keyDown(dialog, { key: ' ' })
    fireEvent.keyUp(dialog, { key: ' ' })
    expect(onOpenOrders).not.toHaveBeenCalled()
    expect(alertDialog()).not.toBeNull()

    // Tab moves into the dialog's own buttons.
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(screen.getByTestId('incoming-order-alert-open')).toHaveFocus()

    passTapGuard()
    fireEvent.click(screen.getByTestId('incoming-order-alert-later'))
    expect(alertDialog()).toBeNull()
    expect(input).toHaveFocus()
  })

  it('«Later» hides the dialog for one watchdog period while the sound keeps going; a new order brings it back', () => {
    renderAlert('tables')
    setPending([efoodOrder('ef-1')])

    passTapGuard()
    fireEvent.click(screen.getByTestId('incoming-order-alert-later'))
    expect(alertDialog()).toBeNull()

    advance(INCOMING_ORDER_ALERT_REPEAT_MS)
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(2)

    advance(1_000)
    expect(alertDialog()).not.toBeNull()

    fireEvent.click(screen.getByTestId('incoming-order-alert-later'))
    expect(alertDialog()).toBeNull()
    setPending([efoodOrder('ef-1'), efoodOrder('ef-2')])
    expect(alertDialog()).not.toBeNull()
  })

  it('Escape is «Later», never an answer', () => {
    renderAlert('tables')
    setPending([efoodOrder('ef-1')])

    passTapGuard()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(alertDialog()).toBeNull()
    expect(useOrderStore.getState().pendingExternalOrders).toHaveLength(1)
  })

  it('ignores a tap or Escape already in flight as it appears; answers once that moment has passed', () => {
    const onOpenOrders = vi.fn()
    renderAlert('tables', { onOpenOrders })
    setPending([efoodOrder('ef-1')])

    // The tap meant for the page lands on the dialog's buttons as it pops up.
    fireEvent.click(screen.getByTestId('incoming-order-alert-open'))
    fireEvent.click(screen.getByTestId('incoming-order-alert-later'))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onOpenOrders).not.toHaveBeenCalled()
    expect(alertDialog()).not.toBeNull()

    advance(INCOMING_ORDER_ALERT_TAP_GUARD_MS - 50)
    fireEvent.click(screen.getByTestId('incoming-order-alert-open'))
    expect(onOpenOrders).not.toHaveBeenCalled()

    advance(50)
    fireEvent.click(screen.getByTestId('incoming-order-alert-open'))
    expect(onOpenOrders).toHaveBeenCalledTimes(1)
    expect(alertDialog()).toBeNull()
  })

  it('the tap guard starts again each time the dialog reappears', () => {
    renderAlert('tables')
    setPending([efoodOrder('ef-1')])
    passTapGuard()
    fireEvent.click(screen.getByTestId('incoming-order-alert-later'))
    expect(alertDialog()).toBeNull()

    // A new order brings it back: an immediate tap is ignored again.
    setPending([efoodOrder('ef-1'), efoodOrder('ef-2')])
    expect(alertDialog()).not.toBeNull()
    fireEvent.click(screen.getByTestId('incoming-order-alert-later'))
    expect(alertDialog()).not.toBeNull()
    passTapGuard()
    fireEvent.click(screen.getByTestId('incoming-order-alert-later'))
    expect(alertDialog()).toBeNull()
  })

  it('the pulse runs only for users who allow motion', () => {
    renderAlert('tables')
    setPending([efoodOrder('ef-1')])

    const icon = alertDialog()?.querySelector('[aria-hidden="true"].rounded-2xl')
    expect(icon?.className).toContain('motion-safe:animate-pulse')
    expect(icon?.className.split(/\s+/)).not.toContain('animate-pulse')
  })
})
