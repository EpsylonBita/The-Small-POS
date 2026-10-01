/**
 * The incoming-order alert loop is a module, not a component: it keeps the
 * store listening and rings on its own, so nothing that happens to the alert
 * dialog (a render error, a route change) can silence it. Tomikro, desktop
 * 1.4.119, 30/09/2026 — see services/incomingOrderAlert.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TestOrder = Record<string, unknown> & { id: string }

const h = vi.hoisted(() => ({
  playSelectedPlatformSound: vi.fn(),
  stopSound: vi.fn(),
  audioEnabled: true,
  audioListeners: new Set<() => void>(),
  initializeOrders: vi.fn(async () => {}),
  silentRefresh: vi.fn(async () => {}),
  eventHandlers: new Map<string, Set<(payload?: unknown) => void>>(),
}))

vi.mock('../../hooks/useOrderStore', async () => {
  const { create } = await import('zustand')
  const store = create<Record<string, any>>(() => ({
    orders: [],
    pendingExternalOrders: [] as TestOrder[],
    initializeOrders: h.initializeOrders,
    silentRefresh: h.silentRefresh,
  }))
  return { useOrderStore: store }
})

vi.mock('../platformNotificationSound', () => ({
  playSelectedPlatformSound: (...args: unknown[]) => {
    h.playSelectedPlatformSound(...args)
    return h.stopSound
  },
}))

vi.mock('../appAudio', () => ({
  isAppAudioEnabled: () => h.audioEnabled,
  subscribeAppAudio: (listener: () => void) => {
    h.audioListeners.add(listener)
    return () => h.audioListeners.delete(listener)
  },
  playAppAudioTones: vi.fn(() => () => {}),
}))

vi.mock('../../../lib', () => ({
  emitCompatEvent: vi.fn(),
  onEvent: (channel: string, handler: (payload?: unknown) => void) => {
    const handlers = h.eventHandlers.get(channel) ?? new Set()
    handlers.add(handler)
    h.eventHandlers.set(channel, handlers)
  },
  offEvent: (channel: string, handler: (payload?: unknown) => void) => {
    h.eventHandlers.get(channel)?.delete(handler)
  },
}))

import { useOrderStore } from '../../hooks/useOrderStore'
import {
  __resetIncomingOrderAlertLoopForTests,
  configureIncomingOrderAlertLoop,
  getIncomingOrderAlertQueue,
  logIncomingOrderAlertEvent,
  ringIncomingOrderAlertAgain,
  startIncomingOrderAlertLoop,
} from '../incomingOrderAlertLoop'
import {
  INCOMING_ORDER_ALERT_EVIDENCE_FORMAT,
  INCOMING_ORDER_ALERT_LOG_KEY,
  INCOMING_ORDER_ALERT_REPEAT_MS,
  INCOMING_ORDER_SAFETY_REFRESH_MS,
  buildIncomingOrderAlertSupportEvidence,
  readIncomingOrderAlertLog,
} from '../incomingOrderAlert'
import { foodOrderFilter } from '../../components/dashboards/dashboardOrderScope'

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

const setPending = (orders: TestOrder[]) => {
  useOrderStore.setState({ pendingExternalOrders: orders } as never)
}

const emit = (channel: string) => {
  for (const handler of h.eventHandlers.get(channel) ?? []) handler({})
}

describe('incoming-order alert loop', () => {
  let release: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-30T14:17:33Z') })
    h.playSelectedPlatformSound.mockClear()
    h.stopSound.mockClear()
    h.initializeOrders.mockClear()
    h.silentRefresh.mockClear()
    h.eventHandlers.clear()
    h.audioListeners.clear()
    h.audioEnabled = true
    __resetIncomingOrderAlertLoopForTests()
    setPending([])
    window.localStorage.clear()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    release?.()
    release = null
    __resetIncomingOrderAlertLoopForTests()
    vi.useRealTimers()
  })

  it('rings with no component mounted at all, repeats every 30 s and stops once the order is answered', () => {
    configureIncomingOrderAlertLoop({ enabled: true, orderFilter: foodOrderFilter, view: 'new-order' })
    release = startIncomingOrderAlertLoop()

    setPending([efoodOrder('ef-1')])
    expect(getIncomingOrderAlertQueue().map((order) => order.id)).toEqual(['ef-1'])
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(INCOMING_ORDER_ALERT_REPEAT_MS)
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(2)

    setPending([])
    expect(h.stopSound).toHaveBeenCalled()
    vi.advanceTimersByTime(INCOMING_ORDER_ALERT_REPEAT_MS * 3)
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(2)

    const log = readIncomingOrderAlertLog()
    expect(log.map((entry) => entry.event)).toEqual(['alerting', 'resolved'])
    expect(log[0]).toMatchObject({ orderId: 'ef-1', platform: 'efood', view: 'new-order' })
  })

  it('is reference-counted: one holder releasing does not stop the ringing of another', () => {
    release = startIncomingOrderAlertLoop()
    const second = startIncomingOrderAlertLoop()
    setPending([efoodOrder('ef-1')])
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

    second()
    second()
    vi.advanceTimersByTime(INCOMING_ORDER_ALERT_REPEAT_MS)
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(2)
  })

  it('never rings on a waiter terminal (the main register accepts), as on Android', () => {
    configureIncomingOrderAlertLoop({ enabled: false, orderFilter: foodOrderFilter })
    release = startIncomingOrderAlertLoop()
    setPending([efoodOrder('ef-1')])
    vi.advanceTimersByTime(INCOMING_ORDER_ALERT_REPEAT_MS * 2)

    expect(getIncomingOrderAlertQueue()).toEqual([])
    expect(h.playSelectedPlatformSound).not.toHaveBeenCalled()
    expect(readIncomingOrderAlertLog()).toEqual([])
  })

  it('an order the scope filter cannot read still rings', () => {
    const throwingFilter = () => {
      throw new Error('unreadable items')
    }
    configureIncomingOrderAlertLoop({ enabled: true, orderFilter: throwingFilter })
    release = startIncomingOrderAlertLoop()
    setPending([efoodOrder('ef-1')])

    expect(getIncomingOrderAlertQueue()).toHaveLength(1)
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
  })

  it('follows the app audio setting: silent while off, rings again once it is back on', () => {
    h.audioEnabled = false
    release = startIncomingOrderAlertLoop()
    setPending([efoodOrder('ef-1')])
    vi.advanceTimersByTime(INCOMING_ORDER_ALERT_REPEAT_MS)
    expect(h.playSelectedPlatformSound).not.toHaveBeenCalled()

    h.audioEnabled = true
    for (const listener of h.audioListeners) listener()
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
  })

  it('rings again for an escalation, but never on top of a play that just started', () => {
    release = startIncomingOrderAlertLoop()
    setPending([efoodOrder('ef-1')])
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

    ringIncomingOrderAlertAgain()
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(10_000)
    ringIncomingOrderAlertAgain()
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(2)
  })

  it('keeps the order store listening and re-reads the local cache after sync ticks, throttled', async () => {
    release = startIncomingOrderAlertLoop()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.initializeOrders).toHaveBeenCalledTimes(1)

    // No polling loop of its own: time alone re-reads nothing.
    vi.advanceTimersByTime(INCOMING_ORDER_SAFETY_REFRESH_MS * 2)
    expect(h.silentRefresh).not.toHaveBeenCalled()

    // A Rust sync tick (the pull that materialises platform orders) does,
    // at most once per safety period.
    emit('sync:status')
    await Promise.resolve()
    expect(h.silentRefresh).toHaveBeenCalledTimes(1)
    emit('sync:status')
    await Promise.resolve()
    expect(h.silentRefresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(INCOMING_ORDER_SAFETY_REFRESH_MS)
    emit('sync:status')
    await Promise.resolve()
    expect(h.silentRefresh).toHaveBeenCalledTimes(2)
  })

  it('stops ringing when the last holder releases it (logout)', () => {
    release = startIncomingOrderAlertLoop()
    setPending([efoodOrder('ef-1')])
    release()
    release = null

    expect(h.stopSound).toHaveBeenCalled()
    vi.advanceTimersByTime(INCOMING_ORDER_ALERT_REPEAT_MS * 2)
    expect(h.playSelectedPlatformSound).toHaveBeenCalledTimes(1)
    expect(h.eventHandlers.get('sync:status')?.size ?? 0).toBe(0)
  })
})

describe('incoming-order alert support evidence', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('carries the watchdog and render-failure entries, bounded, for the diagnostics export', () => {
    const entry = (event: string, orderId: string) => ({
      at: '2026-09-30T14:18:03.000Z',
      event,
      orderId,
      orderNumber: '4545',
      platform: 'efood',
      view: 'tables',
      waitedMs: 30_000,
      pendingCount: 1,
      audioEnabled: true,
    })
    const log = [
      entry('alerting', 'ef-1'),
      entry('missed', 'ef-1'),
      entry('escalated', 'ef-2'),
      entry('render_error', 'ef-3'),
      entry('resolved', 'ef-1'),
      ...Array.from({ length: 25 }, (_, index) => entry('escalated', `ef-x${index}`)),
    ]
    window.localStorage.setItem(INCOMING_ORDER_ALERT_LOG_KEY, JSON.stringify(log))

    const evidence = buildIncomingOrderAlertSupportEvidence()
    expect(evidence.format).toBe(INCOMING_ORDER_ALERT_EVIDENCE_FORMAT)
    expect(evidence.counts).toEqual({ missed: 1, escalated: 26, render_error: 1 })
    expect(evidence.entries).toHaveLength(20)
    expect(evidence.entries.every((item) => ['missed', 'escalated', 'render_error'].includes(item.event))).toBe(true)
    expect(evidence.entries.at(-1)?.orderId).toBe('ef-x24')
  })

  it('a «missed» entry (neither the panel nor the dialog was on screen) is a console error and a log entry', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      configureIncomingOrderAlertLoop({ enabled: true, orderFilter: undefined, view: 'dashboard' })
      logIncomingOrderAlertEvent('missed', efoodOrder('ef-1') as never, {
        approvalInDom: false,
        overlayShown: false,
        escalated: true,
        openDialogs: [],
      })

      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('MISSED ALERT'), expect.anything())
      expect(readIncomingOrderAlertLog().at(-1)).toMatchObject({
        event: 'missed',
        orderId: 'ef-1',
        platform: 'efood',
        view: 'dashboard',
        approvalInDom: false,
        overlayShown: false,
        escalated: true,
      })
      expect(buildIncomingOrderAlertSupportEvidence().counts.missed).toBe(1)
    } finally {
      consoleError.mockRestore()
      __resetIncomingOrderAlertLoopForTests()
    }
  })

  it('an unreadable log is empty evidence, never an error', () => {
    window.localStorage.setItem(INCOMING_ORDER_ALERT_LOG_KEY, '{not json')
    expect(buildIncomingOrderAlertSupportEvidence()).toMatchObject({
      counts: { missed: 0, escalated: 0, render_error: 0 },
      entries: [],
    })
  })
})
