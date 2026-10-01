/**
 * Tomikro, desktop 1.4.119, 30/09/2026: two efood orders pulled into the local
 * cache while staff were on another page (efood «Live παραγγελίες», tables…)
 * got no modal and no sound for 11 and 2 minutes. The incoming-order alert
 * lived only inside OrderDashboard, which is mounted on the Orders screen
 * alone; its first fix lived in RefactoredMainLayout, which /new-order (where
 * TablesPage sends every dine-in order) does not render.
 *
 * These tests mount the app's real logged-in routes (AppRoutes) with the
 * alert manager beside them, inside an App-level error boundary, as App.tsx
 * does, inject a pending platform order into the order store and require the
 * alert to show and ring on every page — /new-order included, even when that
 * page crashes — and to ring exactly once on the Orders screen.
 */
import React, { Suspense } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TestOrder = Record<string, unknown> & { id: string }

const h = vi.hoisted(() => ({
  store: null as null | {
    setState: (partial: Record<string, unknown>) => void
    getState: () => Record<string, any>
  },
  playSelectedPlatformSound: vi.fn(),
  stopSound: vi.fn(),
  dashboardPresentsApproval: true,
  dashboardThrows: false,
  newOrderPageThrows: false,
  isMobileWaiter: false,
  paymentOpen: false,
}))

vi.mock('../../hooks/useOrderStore', async () => {
  const { create } = await import('zustand')
  const store = create<Record<string, any>>(() => ({
    orders: [],
    pendingExternalOrders: [] as TestOrder[],
    initializeOrders: vi.fn(async () => {}),
    silentRefresh: vi.fn(async () => {}),
  }))
  h.store = store as any
  return { useOrderStore: store }
})

vi.mock('../../services/platformNotificationSound', () => ({
  playSelectedPlatformSound: (...args: unknown[]) => {
    h.playSelectedPlatformSound(...args)
    return h.stopSound
  },
}))

vi.mock('../../services/appAudio', () => ({
  isAppAudioEnabled: () => true,
  useAppAudioEnabled: () => true,
  subscribeAppAudio: () => () => {},
  playAppAudioTones: vi.fn(() => () => {}),
}))

vi.mock('../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isMobileWaiter: h.isMobileWaiter }),
}))

// An order whose platform metadata cannot be rendered: the dialog must fail
// for it alone, never for the orders after it.
vi.mock('../../utils/plugin-icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/plugin-icons')>()
  return {
    ...actual,
    getPluginName: (pluginId: string) => {
      if (pluginId === 'broken') throw new Error('plugin metadata unreadable')
      return actual.getPluginName(pluginId)
    },
  }
})

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// The order-taking page, rendered by /new-order without the main layout. With
// `newOrderPageThrows` it fails to render as soon as an order waits.
vi.mock('../../pages/NewOrderPage', () => ({
  default: () => {
    const pending = (h.store as any)((state: any) => state.pendingExternalOrders) as TestOrder[]
    if (h.newOrderPageThrows && pending.length > 0) {
      throw new Error('new order page failed to render')
    }
    return (
      <div>
        New order page
        {h.paymentOpen ? (
          <div role="dialog" aria-modal="true" aria-label="Payment">
            <input aria-label="Cash received" data-testid="cash-received" />
          </div>
        ) : null}
      </div>
    )
  },
}))

// The Orders screen stand-in: like OrderDashboard it opens the approval panel
// for the queue head by itself, and that panel carries the approval marker.
vi.mock('../dashboards/BusinessCategoryDashboard', () => ({
  BusinessCategoryDashboard: () => {
    const pending = (h.store as any)((state: any) => state.pendingExternalOrders) as TestOrder[]
    const head = pending.find((order) => order.plugin !== 'broken')
    if (head && h.dashboardThrows) {
      throw new Error('approval panel failed to render')
    }
    return (
      <div>
        Dashboard
        {head && h.dashboardPresentsApproval ? (
          <div role="dialog" aria-label="Review incoming order">
            <div data-incoming-order-approval={head.id}>Approval for {head.id}</div>
          </div>
        ) : null}
      </div>
    )
  },
}))

vi.mock('../../contexts/navigation-context', () => ({
  NavigationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../NavigationSidebar', () => ({
  default: ({ onViewChange }: { onViewChange: (view: string) => void }) => (
    <>
      <button type="button" onClick={() => onViewChange('dashboard')}>Orders</button>
      <button type="button" onClick={() => onViewChange('tables')}>Tables</button>
      <button type="button" onClick={() => onViewChange('efood_partner')}>efood</button>
    </>
  ),
}))

vi.mock('../ThemeSwitcher', () => ({ ThemeSwitcher: () => null }))
vi.mock('../ui/ContentContainer', () => ({
  default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}))
vi.mock('../ui/PageLoadMotion', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}))
vi.mock('../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('../../contexts/shift-context', () => ({
  useShift: () => ({ staff: null, isShiftActive: true }),
}))
vi.mock('../../contexts/module-context', () => ({
  getModuleAccessStatic: () => ({ isLocked: false }),
  useModuleAccess: () => ({ isLocked: false, requiredPlan: undefined }),
  useModules: () => ({
    enabledModules: [],
    isModuleEnabled: () => false,
    lockedModules: [],
    businessType: 'restaurant',
  }),
}))
vi.mock('../../utils/module-view-access', () => ({
  isViewAccessDenied: () => false,
}))
vi.mock('../modals/ZReportModal', () => ({ default: () => null }))
vi.mock('../modals/UpgradePromptModal', () => ({ default: () => null }))
vi.mock('../ShiftManager', () => ({
  ShiftManager: React.forwardRef(() => null),
}))
vi.mock('../../hooks/useEndOfDayStatus', () => ({
  useEndOfDayStatus: () => ({ endOfDayStatus: {}, isPendingLocalSubmit: false }),
}))
vi.mock('../../hooks/useEfoodPartner', () => ({
  useEfoodPartner: () => ({ available: false, settings: { enabled: true, muted: true } }),
}))
vi.mock('../../pages/verticals/restaurant/TablesView', () => ({
  TablesView: () => <div>Restaurant tables</div>,
}))
vi.mock('../EfoodPartnerView', () => ({
  EfoodPartnerView: () => <div>efood Live orders</div>,
}))
vi.mock('../../../lib', () => ({
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  emitCompatEvent: vi.fn(),
  getBridge: () => ({
    sync: { getNetworkStatus: vi.fn().mockResolvedValue({ isOnline: true }) },
    branchData: { getBundleStatus: vi.fn().mockResolvedValue({ success: false }) },
  }),
}))
vi.mock('../../lib/secure-session-cache', () => ({
  clearSecureSession: vi.fn(),
  getSecureSessionSync: () => null,
}))
vi.mock('../../services/offline-page-capabilities', () => ({
  getOfflinePageBanner: () => null,
}))
vi.mock('../modals/ExpenseModal', () => ({ ExpenseModal: () => null }))

import { AppRoutes } from '../../AppRoutes'
import { ErrorBoundary } from '../error/ErrorBoundary'
import { IncomingOrderAlertManager } from '../notices/IncomingOrderAlertManager'
import { useOrderStore } from '../../hooks/useOrderStore'
import {
  INCOMING_ORDER_ALERT_REPEAT_MS,
  INCOMING_ORDER_ALERT_TAP_GUARD_MS,
  INCOMING_ORDER_PANEL_GRACE_MS,
  INCOMING_ORDER_WATCHDOG_MS,
  __resetIncomingOrderAlertForTests,
  readIncomingOrderAlertLog,
} from '../../services/incomingOrderAlert'
import { __resetIncomingOrderAlertLoopForTests } from '../../services/incomingOrderAlertLoop'

const efoodOrder = (id: string, extra: Record<string, unknown> = {}): TestOrder => ({
  id,
  order_number: `ORD-${id}`,
  status: 'pending',
  plugin: 'efood',
  external_plugin_order_id: `EF-${id}`,
  created_at: '2026-09-30T14:17:23Z',
  items: [{ menu_item_id: 'crepe', name: 'Crepe', quantity: 1, price: 6 }],
  ghost_metadata: { food_delivery: { short_code: '4545' } },
  ...extra,
})

const injectPending = (orders: TestOrder[]) => {
  act(() => {
    useOrderStore.setState({ pendingExternalOrders: orders } as never)
  })
}

/**
 * The logged-in shell as App.tsx renders it: one error boundary around the
 * whole tree, the routes, and the alert beside them.
 */
const renderApp = (path: string) =>
  render(
    <ErrorBoundary>
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback={<div>Loading page</div>}>
          <AppRoutes onLogout={vi.fn()} onOpenConnectionSettings={vi.fn()} />
        </Suspense>
        <IncomingOrderAlertManager enabled />
      </MemoryRouter>
    </ErrorBoundary>,
  )

const alert = () => screen.queryByTestId('incoming-order-alert')

/** The dialog ignores a tap in flight as it appears; staff answer after that. */
const passTapGuard = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, INCOMING_ORDER_ALERT_TAP_GUARD_MS + 20))
  })

describe('incoming platform-order alert on the app routes', () => {
  beforeEach(() => {
    h.playSelectedPlatformSound.mockClear()
    h.stopSound.mockClear()
    h.dashboardPresentsApproval = true
    h.dashboardThrows = false
    h.newOrderPageThrows = false
    h.isMobileWaiter = false
    h.paymentOpen = false
    __resetIncomingOrderAlertLoopForTests()
    __resetIncomingOrderAlertForTests()
    useOrderStore.setState({ pendingExternalOrders: [] } as never)
    window.localStorage.clear()
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    __resetIncomingOrderAlertLoopForTests()
    vi.useRealTimers()
  })

  it('/new-order (no main layout): shows and rings, then «Open the order» goes to the Orders screen', async () => {
    renderApp('/new-order')
    expect(await screen.findByText('New order page')).toBeInTheDocument()

    injectPending([efoodOrder('ef-1')])

    const dialog = await screen.findByTestId('incoming-order-alert')
    expect(dialog).toHaveAttribute('role', 'dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('data-order-id', 'ef-1')
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

    await passTapGuard()
    fireEvent.click(screen.getByTestId('incoming-order-alert-open'))

    // The route changes to the main layout, whose Orders screen opens its own
    // approval panel for the order.
    expect(await screen.findByText('Approval for ef-1')).toBeInTheDocument()
    expect(screen.queryByText('New order page')).toBeNull()
    await waitFor(() => expect(alert()).toBeNull())
    // Still one sound: nothing starts a second loop.
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
  })

  it('/new-order with a payment dialog open: the alert takes focus on itself, a key in flight changes nothing, «Later» gives focus back', async () => {
    h.paymentOpen = true
    renderApp('/new-order')
    const cash = await screen.findByTestId('cash-received')
    cash.focus()
    expect(cash).toHaveFocus()

    injectPending([efoodOrder('ef-1')])

    const dialog = await screen.findByTestId('incoming-order-alert')
    expect(document.activeElement).toBe(dialog)
    expect(screen.getByTestId('incoming-order-alert-open')).not.toHaveFocus()

    // The cashier's Enter / Space meant for the payment lands on the alert
    // itself: no page switch, the payment stays where it was.
    fireEvent.keyDown(dialog, { key: 'Enter' })
    fireEvent.keyUp(dialog, { key: 'Enter' })
    fireEvent.keyDown(dialog, { key: ' ' })
    fireEvent.keyUp(dialog, { key: ' ' })
    expect(screen.getByText('New order page')).toBeInTheDocument()
    expect(screen.getByTestId('cash-received')).toBeInTheDocument()
    expect(screen.queryByText(/Approval for/)).toBeNull()
    expect(alert()).not.toBeNull()

    await passTapGuard()
    fireEvent.click(screen.getByTestId('incoming-order-alert-later'))
    expect(alert()).toBeNull()
    await waitFor(() => expect(screen.getByTestId('cash-received')).toHaveFocus())
    expect(screen.getByText('New order page')).toBeInTheDocument()
  })

  it('a page that crashes while an order waits never silences the alert: it still rings at +30 s and the dialog shows', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.newOrderPageThrows = true
      renderApp('/new-order')
      expect(await screen.findByText('New order page')).toBeInTheDocument()
      vi.useFakeTimers()

      // The order arrives and the order-taking page fails to render because
      // of it: the routes' own boundary shows the usual error screen for the
      // page alone, and the alert beside the routes carries on.
      injectPending([efoodOrder('ef-1')])
      expect(screen.queryByText('New order page')).toBeNull()
      expect(screen.getByText('new order page failed to render')).toBeInTheDocument()
      expect(alert()).toHaveAttribute('data-order-id', 'ef-1')
      expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

      act(() => {
        vi.advanceTimersByTime(INCOMING_ORDER_ALERT_REPEAT_MS)
      })

      expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('incoming-order-alert')).toHaveAttribute('data-order-id', 'ef-1')

      // «Open the order» leaves the crashed page: the boundary gives the next
      // route a fresh start, and the Orders screen presents the order.
      vi.useRealTimers()
      await passTapGuard()
      fireEvent.click(screen.getByTestId('incoming-order-alert-open'))
      expect(await screen.findByText('Approval for ef-1')).toBeInTheDocument()
      expect(screen.queryByText('new order page failed to render')).toBeNull()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('a throwing order, then a valid order: both ring, and the valid one still shows', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderApp('/new-order')
      await screen.findByText('New order page')

      injectPending([efoodOrder('bad-1', { plugin: 'broken' })])

      // The dialog failed for that order: its boundary caught it, logged it,
      // and the dialog came back without that order's details.
      await waitFor(() => expect(alert()).toHaveAttribute('data-order-id', 'bad-1'))
      expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('[IncomingOrderAlert] the alert dialog failed to render'),
        expect.anything(),
        expect.anything(),
      )
      expect(readIncomingOrderAlertLog().find((entry) => entry.event === 'render_error')).toMatchObject({
        orderId: 'bad-1',
        view: 'new-order',
        error: 'plugin metadata unreadable',
      })

      injectPending([efoodOrder('bad-1', { plugin: 'broken' }), efoodOrder('ef-2')])

      await waitFor(() => expect(alert()).toHaveAttribute('data-order-id', 'ef-2'))
      expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('incoming-order-alert-more')).toBeInTheDocument()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('never rings or shows on a waiter terminal (the main register accepts), as on Android', async () => {
    h.isMobileWaiter = true
    renderApp('/new-order')
    await screen.findByText('New order page')

    injectPending([efoodOrder('ef-1')])

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(alert()).toBeNull()
    expect(h.playSelectedPlatformSound).not.toHaveBeenCalled()
  })

  it('shows and rings on the tables page, then hands the order to the Orders screen', async () => {
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: 'Tables' }))
    await screen.findByText('Restaurant tables')

    injectPending([efoodOrder('ef-1')])

    const dialog = await screen.findByTestId('incoming-order-alert')
    expect(dialog).toHaveAttribute('data-order-id', 'ef-1')
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

    await passTapGuard()
    fireEvent.click(screen.getByTestId('incoming-order-alert-open'))

    // The layout switches to the Orders screen (pos:navigate-view) and its
    // own approval panel takes over.
    expect(await screen.findByText('Approval for ef-1')).toBeInTheDocument()
    await waitFor(() => expect(alert()).toBeNull())
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
  })

  it('shows and rings on the efood Live orders page (the page staff were on)', async () => {
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: 'efood' }))
    await screen.findByText('efood Live orders')

    injectPending([efoodOrder('ef-2')])

    expect(await screen.findByTestId('incoming-order-alert')).toBeInTheDocument()
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
  })

  it('rings exactly once on the Orders screen, where the approval panel itself shows', async () => {
    renderApp('/')
    expect(await screen.findByText('Dashboard')).toBeInTheDocument()

    injectPending([efoodOrder('ef-3')])

    expect(await screen.findByText('Approval for ef-3')).toBeInTheDocument()
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
    // The panel is on screen: no second dialog over it.
    expect(alert()).toBeNull()
  })

  it('when the Orders screen fails to show the approval panel, the dialog shows over it within 2 s, then the watchdog escalates', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderApp('/')
      expect(await screen.findByText('Dashboard')).toBeInTheDocument()
      vi.useFakeTimers()

      // The panel throws while rendering: the page boundary catches it, the
      // register stays up, and the alert is still alive beside the routes.
      h.dashboardThrows = true
      injectPending([efoodOrder('ef-4')])
      expect(alert()).toBeNull()
      expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

      // No panel shows by itself: the dialog does, promptly.
      act(() => {
        vi.advanceTimersByTime(INCOMING_ORDER_PANEL_GRACE_MS)
      })
      expect(screen.getByTestId('incoming-order-alert')).toHaveAttribute('data-escalated', 'false')

      act(() => {
        vi.advanceTimersByTime(INCOMING_ORDER_WATCHDOG_MS)
      })

      expect(screen.getByTestId('incoming-order-alert')).toHaveAttribute('data-escalated', 'true')
      // The register is still up behind the dialog (hidden from assistive
      // tech while the modal alert shows).
      expect(screen.getByRole('button', { name: 'Tables', hidden: true })).toBeInTheDocument()
      // Staff had the dialog in front of them: escalated, not missed.
      const log = readIncomingOrderAlertLog()
      expect(log.find((entry) => entry.event === 'escalated')).toMatchObject({
        orderId: 'ef-4',
        view: 'dashboard',
        overlayShown: true,
      })
      expect(log.some((entry) => entry.event === 'missed')).toBe(false)
      expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('MISSED ALERT'), expect.anything())
    } finally {
      consoleError.mockRestore()
    }
  })

  it('never alerts for an order outside the Orders screen scope', async () => {
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: 'Tables' }))
    await screen.findByText('Restaurant tables')

    // A retail product order: the food Orders screen does not offer it for
    // approval, so this register must not ring for it either.
    injectPending([
      efoodOrder('retail-1', {
        items: [{ product_id: 'sku-1', product_name: 'Olive oil', quantity: 1, price: 9 }],
      }),
    ])

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(alert()).toBeNull()
    expect(h.playSelectedPlatformSound).not.toHaveBeenCalled()
  })
})
