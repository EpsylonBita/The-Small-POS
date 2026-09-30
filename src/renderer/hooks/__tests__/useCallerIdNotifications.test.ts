import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  showCallerIdToast: vi.fn(),
  openCustomerSearch: vi.fn(),
  // Network spies: the local Caller ID path must never reach any of them.
  posApiGet: vi.fn(),
  posApiPost: vi.fn(),
  posApiFetch: vi.fn(),
  subscribeToCallerIdEvents: vi.fn(),
  reportCallerIdReceipt: vi.fn(),
}))

vi.mock('../../../lib', () => ({
  onEvent: mocks.onEvent,
  offEvent: mocks.offEvent,
}))

vi.mock('../../contexts/module-context', () => ({
  useModules: () => ({
    isModuleEnabled: mocks.isModuleEnabled,
  }),
}))

vi.mock('../../components/callerid/CallerIdPopup', () => ({
  showCallerIdToast: mocks.showCallerIdToast,
}))

vi.mock('../../utils/api-helpers', () => ({
  posApiGet: mocks.posApiGet,
  posApiPost: mocks.posApiPost,
  posApiFetch: mocks.posApiFetch,
}))

vi.mock('../../services/CallerIdRealtimeService', () => ({
  subscribeToCallerIdEvents: mocks.subscribeToCallerIdEvents,
  reportCallerIdReceipt: mocks.reportCallerIdReceipt,
}))

import { useCallerIdNotifications } from '../useCallerIdNotifications'

const CHANNEL = 'callerid:validated-local-call'

const validLocalCall = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  sourceId: '10000000-0000-4000-8000-000000000001',
  sourceVersion: 7,
  lineId: '20000000-0000-4000-8000-000000000002',
  lineName: 'Main line',
  lineVersion: 4,
  providerEventId: 'local-call@fxo',
  callerNumber: '2101234567',
  presentation: 'allowed',
  occurredAt: new Date().toISOString(),
  ...overrides,
})

function registeredHandlers(): Array<(payload: unknown) => void> {
  return [...(mocks.listeners.get(CHANNEL) ?? [])]
}

function deliver(payload: unknown) {
  const handlers = registeredHandlers()
  act(() => {
    for (const handler of handlers) handler(payload)
  })
}

function expectNoNetwork(fetchSpy: ReturnType<typeof vi.fn>) {
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(mocks.posApiGet).not.toHaveBeenCalled()
  expect(mocks.posApiPost).not.toHaveBeenCalled()
  expect(mocks.posApiFetch).not.toHaveBeenCalled()
  expect(mocks.subscribeToCallerIdEvents).not.toHaveBeenCalled()
  expect(mocks.reportCallerIdReceipt).not.toHaveBeenCalled()
}

describe('useCallerIdNotifications local delivery', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
    mocks.isModuleEnabled.mockReturnValue(true)
    mocks.onEvent.mockImplementation((channel: string, handler: (payload: unknown) => void) => {
      const handlers = mocks.listeners.get(channel) ?? new Set()
      handlers.add(handler)
      mocks.listeners.set(channel, handlers)
    })
    mocks.offEvent.mockImplementation((channel: string, handler: (payload: unknown) => void) => {
      mocks.listeners.get(channel)?.delete(handler)
    })
    fetchSpy = vi.fn(() => Promise.reject(new Error('network is not allowed here')))
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('registers only the hardened native local event channel', () => {
    const { unmount } = renderHook(() =>
      useCallerIdNotifications({ onOpenCustomerSearch: mocks.openCustomerSearch }),
    )

    expect(mocks.onEvent).toHaveBeenCalledTimes(1)
    expect(mocks.onEvent).toHaveBeenCalledWith(CHANNEL, expect.any(Function))

    unmount()
    expect(mocks.offEvent).toHaveBeenCalledWith(CHANNEL, expect.any(Function))
    expect(registeredHandlers()).toHaveLength(0)
  })

  it('opens the customer lookup for a known number without any request', () => {
    renderHook(() =>
      useCallerIdNotifications({ onOpenCustomerSearch: mocks.openCustomerSearch }),
    )

    deliver(validLocalCall())

    expect(mocks.openCustomerSearch).toHaveBeenCalledTimes(1)
    expect(mocks.openCustomerSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        displayPhone: '2101234567',
        lookupPhone: '2101234567',
        onDisplayed: expect.any(Function),
      }),
    )
    act(() => mocks.openCustomerSearch.mock.calls[0][0].onDisplayed())
    expectNoNetwork(fetchSpy)
  })

  it('keeps the international caller number for display and a separate lookup number', () => {
    renderHook(() =>
      useCallerIdNotifications({ onOpenCustomerSearch: mocks.openCustomerSearch }),
    )

    deliver(validLocalCall({
      providerEventId: 'swiss-caller@ht813',
      callerNumber: '+41779990214',
      countryCode: 'GR',
    }))

    expect(mocks.openCustomerSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        displayPhone: '+41779990214',
        canonicalPhone: '+41779990214',
        lookupPhone: '779990214',
        homeCountryCode: 'GR',
      }),
    )
  })

  it('shows withheld and unknown numbers as a toast without a customer lookup', () => {
    renderHook(() =>
      useCallerIdNotifications({ onOpenCustomerSearch: mocks.openCustomerSearch }),
    )

    deliver(validLocalCall({
      providerEventId: 'private@ht813',
      presentation: 'restricted',
      callerNumber: null,
    }))
    deliver(validLocalCall({
      providerEventId: 'whozz-unknown',
      presentation: 'unknown',
      callerNumber: null,
      occurredAt: new Date(Date.now() + 1).toISOString(),
    }))

    expect(mocks.openCustomerSearch).not.toHaveBeenCalled()
    expect(mocks.showCallerIdToast).toHaveBeenCalledTimes(2)
    const shown = mocks.showCallerIdToast.mock.calls.map(([event]) => event)
    expect(shown.map((event) => event.presentation)).toEqual(['restricted', 'unknown'])
    for (const event of shown) {
      expect(event.callerNumber).toBe('Private number')
      expect(event.reportReceipt).toBeUndefined()
    }
    for (const [, options] of mocks.showCallerIdToast.mock.calls) {
      expect(options.onSearchCustomer).toBeUndefined()
    }
    expectNoNetwork(fetchSpy)
  })

  it('rejects malformed, stale, and privacy-inconsistent local calls', () => {
    renderHook(() =>
      useCallerIdNotifications({ onOpenCustomerSearch: mocks.openCustomerSearch }),
    )

    deliver(validLocalCall({ sourceId: 'not-a-uuid' }))
    deliver(validLocalCall({ occurredAt: new Date(Date.now() - 31_000).toISOString() }))
    deliver(validLocalCall({ presentation: 'restricted', callerNumber: '2101234567' }))
    deliver(validLocalCall({ presentation: 'unknown', callerNumber: '2101234567' }))
    deliver(validLocalCall({ callerNumber: '+30<script>' }))
    deliver(validLocalCall({ presentation: 'blocked', callerNumber: null }))

    expect(mocks.showCallerIdToast).not.toHaveBeenCalled()
    expect(mocks.openCustomerSearch).not.toHaveBeenCalled()
  })

  it('shows one card for repeated delivery of the same call and a new card for the next call', async () => {
    vi.useFakeTimers()
    renderHook(() =>
      useCallerIdNotifications({ onOpenCustomerSearch: mocks.openCustomerSearch }),
    )
    const firstCall = validLocalCall({ providerEventId: 'call-1@ht813' })

    deliver(firstCall)
    deliver({ ...firstCall })
    expect(mocks.openCustomerSearch).toHaveBeenCalledTimes(1)

    // The same customer calls again eight seconds later: a new native call
    // with its own id and time must not be swallowed by deduplication.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000)
    })
    deliver(validLocalCall({ providerEventId: 'call-2@ht813' }))
    expect(mocks.openCustomerSearch).toHaveBeenCalledTimes(2)
    const [first, second] = mocks.openCustomerSearch.mock.calls.map(([request]) => request)
    expect(first.lookupPhone).toBe(second.lookupPhone)
    expect(first.requestKey).not.toBe(second.requestKey)
  })

  it('keeps a single listener across logout and login and ignores calls while logged out', () => {
    const { rerender, unmount } = renderHook(
      ({ active }) =>
        useCallerIdNotifications({ active, onOpenCustomerSearch: mocks.openCustomerSearch }),
      { initialProps: { active: true } },
    )
    expect(registeredHandlers()).toHaveLength(1)

    rerender({ active: false })
    expect(registeredHandlers()).toHaveLength(0)
    deliver(validLocalCall({ providerEventId: 'while-logged-out' }))
    expect(mocks.openCustomerSearch).not.toHaveBeenCalled()

    rerender({ active: true })
    rerender({ active: true })
    expect(registeredHandlers()).toHaveLength(1)
    deliver(validLocalCall({ providerEventId: 'after-login' }))
    expect(mocks.openCustomerSearch).toHaveBeenCalledTimes(1)

    unmount()
    expect(registeredHandlers()).toHaveLength(0)
    expect(mocks.onEvent).toHaveBeenCalledTimes(2)
    expect(mocks.offEvent).toHaveBeenCalledTimes(2)
  })

  it('does not listen on inactive or non-entitled terminals', () => {
    const { rerender } = renderHook(
      ({ active }) => useCallerIdNotifications({ active }),
      { initialProps: { active: false } },
    )
    expect(mocks.onEvent).not.toHaveBeenCalled()

    mocks.isModuleEnabled.mockReturnValue(false)
    rerender({ active: true })
    expect(mocks.onEvent).not.toHaveBeenCalled()
  })

  it('schedules no polling while idle and makes no request over a simulated day', async () => {
    vi.useFakeTimers()
    renderHook(() =>
      useCallerIdNotifications({ onOpenCustomerSearch: mocks.openCustomerSearch }),
    )
    // Nothing is scheduled while waiting for calls: no config or event poll.
    expect(vi.getTimerCount()).toBe(0)

    deliver(validLocalCall({ providerEventId: 'idle-day-call' }))
    // Only the 30-second duplicate window of the accepted call is pending.
    expect(vi.getTimerCount()).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000)
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(mocks.openCustomerSearch).toHaveBeenCalledTimes(1)
    expectNoNetwork(fetchSpy)
  })
})
