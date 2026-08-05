import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  getCachedTerminalCredentials: vi.fn(),
  subscribeToCallerIdEvents: vi.fn(),
  reportCallerIdReceipt: vi.fn(),
  unsubscribeRealtime: vi.fn(),
  showCallerIdToast: vi.fn(),
  openCustomerSearch: vi.fn(),
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

vi.mock('../../services/terminal-credentials', () => ({
  getCachedTerminalCredentials: mocks.getCachedTerminalCredentials,
}))

vi.mock('../../services/CallerIdRealtimeService', () => ({
  subscribeToCallerIdEvents: mocks.subscribeToCallerIdEvents,
  reportCallerIdReceipt: mocks.reportCallerIdReceipt,
}))

vi.mock('../../components/callerid/CallerIdPopup', () => ({
  showCallerIdToast: mocks.showCallerIdToast,
}))

import { useCallerIdNotifications } from '../useCallerIdNotifications'

describe('useCallerIdNotifications', () => {
  const realtimeClient = {
    channel: vi.fn(),
    removeChannel: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isModuleEnabled.mockReturnValue(true)
    mocks.getCachedTerminalCredentials.mockReturnValue({
      terminalId: 'terminal-1',
      apiKey: 'terminal-api-key',
      organizationId: 'org-1',
      branchId: 'branch-1',
    })
    mocks.subscribeToCallerIdEvents.mockReturnValue(mocks.unsubscribeRealtime)
  })

  const renderNotifications = (overrides: Record<string, unknown> = {}) =>
    renderHook(() =>
      useCallerIdNotifications({
        realtimeReady: false,
        realtimeClient: null,
        onOpenCustomerSearch: mocks.openCustomerSearch,
        ...overrides,
      } as any),
    )

  it('starts authenticated cloud polling before Realtime is available', () => {
    renderHook(() =>
      useCallerIdNotifications({
        realtimeReady: false,
        realtimeClient: null,
      }),
    )

    expect(mocks.subscribeToCallerIdEvents).toHaveBeenCalledWith(
      null,
      'org-1',
      'terminal-1',
      expect.any(Function),
      expect.any(Function),
    )
  })

  it('does not listen while the POS session is inactive and clears accepted calls', () => {
    const occurredAt = new Date().toISOString()
    const localCall = {
      schemaVersion: 1,
      sourceId: '10000000-0000-4000-8000-000000000001',
      sourceVersion: 7,
      lineId: '20000000-0000-4000-8000-000000000002',
      lineName: 'Cosmote line',
      lineVersion: 4,
      providerEventId: 'inactive-session-call@ht813',
      callerNumber: '2101234567',
      presentation: 'allowed',
      occurredAt,
    }
    const { rerender } = renderHook(
      ({ active }) =>
        useCallerIdNotifications({
          active,
          realtimeReady: false,
          realtimeClient: null,
          onOpenCustomerSearch: mocks.openCustomerSearch,
        }),
      { initialProps: { active: false } },
    )

    expect(mocks.onEvent).not.toHaveBeenCalled()
    expect(mocks.subscribeToCallerIdEvents).not.toHaveBeenCalled()

    rerender({ active: true })
    const firstHandler = mocks.onEvent.mock.calls.find(
      ([eventName]) => eventName === 'callerid:validated-local-call',
    )?.[1]
    act(() => firstHandler?.(localCall))
    expect(mocks.openCustomerSearch).toHaveBeenCalledTimes(1)

    rerender({ active: false })
    act(() => firstHandler?.(localCall))
    expect(mocks.openCustomerSearch).toHaveBeenCalledTimes(1)

    rerender({ active: true })
    const latestHandler = mocks.onEvent.mock.calls
      .filter(([eventName]) => eventName === 'callerid:validated-local-call')
      .at(-1)?.[1]
    act(() => latestHandler?.(localCall))
    expect(mocks.openCustomerSearch).toHaveBeenCalledTimes(2)
  })

  it('invalidates the subscription when only the terminal branch changes', () => {
    renderHook(() =>
      useCallerIdNotifications({ realtimeReady: true, realtimeClient } as any),
    )
    const identityCurrent =
      mocks.subscribeToCallerIdEvents.mock.calls[0]?.[4]
    expect(identityCurrent()).toBe(true)

    mocks.getCachedTerminalCredentials.mockReturnValue({
      terminalId: 'terminal-1',
      apiKey: 'terminal-api-key',
      organizationId: 'org-1',
      branchId: 'branch-2',
    })

    expect(identityCurrent()).toBe(false)
  })

  it('never subscribes to or displays legacy native caller events', () => {
    const { rerender, unmount } = renderHook(
      ({ realtimeReady }) =>
        useCallerIdNotifications({ realtimeReady, realtimeClient } as any),
      { initialProps: { realtimeReady: false } },
    )

    expect(mocks.subscribeToCallerIdEvents).toHaveBeenCalledWith(
      null,
      'org-1',
      'terminal-1',
      expect.any(Function),
      expect.any(Function),
    )

    const legacyRegistration = mocks.onEvent.mock.calls.find(
      ([eventName]) => eventName === 'callerid:incoming-call',
    )
    if (legacyRegistration) {
      act(() => {
        legacyRegistration[1]({
          callerNumber: '+15551234567',
          sipCallId: 'local-call-1',
          timestamp: '2026-07-27T10:00:00.000Z',
        })
      })
    }

    expect(legacyRegistration).toBeUndefined()
    expect(mocks.showCallerIdToast).not.toHaveBeenCalled()

    rerender({ realtimeReady: true })
    expect(mocks.subscribeToCallerIdEvents).toHaveBeenCalledWith(
      realtimeClient,
      'org-1',
      'terminal-1',
      expect.any(Function),
      expect.any(Function),
    )
    const identityCurrent =
      mocks.subscribeToCallerIdEvents.mock.calls.at(-1)?.[4]
    expect(identityCurrent()).toBe(true)
    mocks.getCachedTerminalCredentials.mockReturnValue({
      terminalId: 'terminal-2',
      apiKey: 'replacement-terminal-api-key',
      organizationId: 'org-1',
      branchId: 'branch-1',
    })
    expect(identityCurrent()).toBe(false)

    rerender({ realtimeReady: false })
    expect(mocks.unsubscribeRealtime).toHaveBeenCalledTimes(2)

    unmount()
    expect(mocks.offEvent).not.toHaveBeenCalledWith(
      'callerid:incoming-call',
      expect.any(Function),
    )
  })

  it('displays a fresh hardened local call without waiting for Realtime', () => {
    const { unmount } = renderNotifications()
    const localRegistration = mocks.onEvent.mock.calls.find(
      ([eventName]) => eventName === 'callerid:validated-local-call',
    )
    const occurredAt = new Date().toISOString()

    expect(localRegistration).toBeDefined()
    act(() => {
      localRegistration?.[1]({
        schemaVersion: 1,
        sourceId: '10000000-0000-4000-8000-000000000001',
        sourceVersion: 7,
        lineId: '20000000-0000-4000-8000-000000000002',
        lineName: 'Cosmote line',
        lineVersion: 4,
        providerEventId: '40000000-0000-4000-8000-000000000004',
        callerNumber: '2101234567',
        presentation: 'allowed',
        occurredAt,
      })
    })

    expect(mocks.subscribeToCallerIdEvents).toHaveBeenCalledWith(
      null,
      'org-1',
      'terminal-1',
      expect.any(Function),
      expect.any(Function),
    )
    expect(mocks.showCallerIdToast).not.toHaveBeenCalled()
    expect(mocks.openCustomerSearch).toHaveBeenCalledTimes(1)
    expect(mocks.openCustomerSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        displayPhone: '2101234567',
        lookupPhone: '2101234567',
        requestKey: `call:20000000-0000-4000-8000-000000000002:${Date.parse(occurredAt)}:allowed:01234567`,
        onDisplayed: expect.any(Function),
      }),
    )
    const modalRequest = mocks.openCustomerSearch.mock.calls[0]?.[0]
    act(() => {
      modalRequest.onDisplayed()
    })
    expect(mocks.reportCallerIdReceipt).not.toHaveBeenCalled()

    unmount()
    expect(mocks.offEvent).toHaveBeenCalledWith(
      'callerid:validated-local-call',
      localRegistration?.[1],
    )
  })

  it('keeps the international caller number for display and emits a separate local lookup number', () => {
    renderNotifications()
    const localHandler = mocks.onEvent.mock.calls.find(
      ([eventName]) => eventName === 'callerid:validated-local-call',
    )?.[1]

    act(() => {
      localHandler?.({
        schemaVersion: 1,
        sourceId: '10000000-0000-4000-8000-000000000001',
        sourceVersion: 7,
        lineId: '20000000-0000-4000-8000-000000000002',
        lineName: 'Athens line',
        lineVersion: 4,
        providerEventId: 'swiss-caller@ht813',
        callerNumber: '+41779990214',
        countryCode: 'GR',
        presentation: 'allowed',
        occurredAt: new Date().toISOString(),
      })
    })

    expect(mocks.openCustomerSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        displayPhone: '+41779990214',
        canonicalPhone: '+41779990214',
        lookupPhone: '779990214',
        homeCountryCode: 'GR',
        requestKey: expect.any(String),
        onDisplayed: expect.any(Function),
      }),
    )
  })

  it('rejects malformed, stale, and privacy-inconsistent local calls', () => {
    renderNotifications()
    const localHandler = mocks.onEvent.mock.calls.find(
      ([eventName]) => eventName === 'callerid:validated-local-call',
    )?.[1]
    const validBase = {
      schemaVersion: 1,
      sourceId: '10000000-0000-4000-8000-000000000001',
      sourceVersion: 7,
      lineId: '20000000-0000-4000-8000-000000000002',
      lineName: 'Cosmote line',
      lineVersion: 4,
      providerEventId: 'local-call-2@ht813',
      callerNumber: '2101234567',
      presentation: 'allowed',
      occurredAt: new Date().toISOString(),
    }

    expect(localHandler).toBeTypeOf('function')
    act(() => {
      localHandler?.({ ...validBase, sourceId: 'not-a-uuid' })
      localHandler?.({
        ...validBase,
        occurredAt: new Date(Date.now() - 31_000).toISOString(),
      })
      localHandler?.({
        ...validBase,
        presentation: 'restricted',
        callerNumber: '2101234567',
      })
      localHandler?.({ ...validBase, callerNumber: '+30<script>' })
    })

    expect(mocks.showCallerIdToast).not.toHaveBeenCalled()
    expect(mocks.openCustomerSearch).not.toHaveBeenCalled()
  })

  it('deduplicates the local card when the normalized cloud event arrives', () => {
    renderNotifications({ realtimeReady: true, realtimeClient })
    const localHandler = mocks.onEvent.mock.calls.find(
      ([eventName]) => eventName === 'callerid:validated-local-call',
    )?.[1]
    const realtimeHandler = mocks.subscribeToCallerIdEvents.mock.calls[0]?.[3]
    const occurredAt = new Date().toISOString()
    const reportReceipt = vi.fn().mockResolvedValue(true)

    act(() => {
      localHandler?.({
        schemaVersion: 1,
        sourceId: '10000000-0000-4000-8000-000000000001',
        sourceVersion: 7,
        lineId: '20000000-0000-4000-8000-000000000002',
        lineName: 'Cosmote line',
        lineVersion: 4,
        providerEventId: 'local-call-3@ht813',
        callerNumber: '2101234567',
        presentation: 'allowed',
        occurredAt,
      })
    })
    const modalRequest = mocks.openCustomerSearch.mock.calls[0]?.[0]
    act(() => {
      modalRequest.onDisplayed()
    })
    expect(reportReceipt).not.toHaveBeenCalled()

    act(() => {
      realtimeHandler({
        callerNumber: '+302101234567',
        sipCallId: '30000000-0000-4000-8000-000000000003',
        timestamp: occurredAt.replace('Z', '+00:00'),
        lineId: '20000000-0000-4000-8000-000000000002',
        lineName: 'Cosmote line',
        presentation: 'allowed',
        reportReceipt,
      })
    })

    expect(mocks.showCallerIdToast).not.toHaveBeenCalled()
    expect(mocks.openCustomerSearch).toHaveBeenCalledTimes(1)
    expect(reportReceipt).toHaveBeenCalledTimes(1)
    expect(reportReceipt).toHaveBeenCalledWith({ status: 'displayed' })
  })

  it('does not report displayed at enqueue and reports it only from the mounted card callback', () => {
    renderNotifications({ realtimeReady: true, realtimeClient })
    const realtimeHandler = mocks.subscribeToCallerIdEvents.mock.calls[0]?.[3]
    const reportReceipt = vi.fn()

    act(() => {
      realtimeHandler({
        callerNumber: '+15551234567',
        sipCallId: '20000000-0000-4000-8000-000000000008',
        timestamp: '2026-07-27T10:00:30.000Z',
        reportReceipt,
      })
    })

    expect(mocks.showCallerIdToast).not.toHaveBeenCalled()
    expect(mocks.openCustomerSearch).toHaveBeenCalledTimes(1)
    expect(reportReceipt).not.toHaveBeenCalled()
    expect(mocks.reportCallerIdReceipt).not.toHaveBeenCalledWith(
      '20000000-0000-4000-8000-000000000008',
      { status: 'displayed' },
      '2026-07-27T10:00:30.000Z',
    )

    const modalRequest = mocks.openCustomerSearch.mock.calls[0]?.[0]
    act(() => {
      modalRequest.onDisplayed()
    })
    expect(reportReceipt).toHaveBeenCalledTimes(1)
    expect(reportReceipt).toHaveBeenCalledWith({ status: 'displayed' })
  })

  it('reports only DISPLAY_FAILED when the centered modal cannot be opened', () => {
    mocks.openCustomerSearch.mockImplementationOnce(() => {
      throw new Error('modal unavailable')
    })
    renderNotifications({ realtimeReady: true, realtimeClient })
    const realtimeHandler = mocks.subscribeToCallerIdEvents.mock.calls[0]?.[3]
    const reportReceipt = vi.fn()

    act(() => {
      realtimeHandler({
        callerNumber: '+15551234567',
        sipCallId: '20000000-0000-4000-8000-000000000009',
        timestamp: '2026-07-27T10:00:30.000Z',
        reportReceipt,
      })
    })

    expect(reportReceipt).toHaveBeenCalledTimes(1)
    expect(reportReceipt).toHaveBeenCalledWith({
      status: 'failed',
      failureCode: 'DISPLAY_FAILED',
    })
    expect(reportReceipt).not.toHaveBeenCalledWith({ status: 'displayed' })
  })

  it('keeps restricted calls out of customer lookup and shows only the privacy toast', () => {
    renderNotifications({ realtimeReady: true, realtimeClient })
    const realtimeHandler = mocks.subscribeToCallerIdEvents.mock.calls[0]?.[3]

    act(() => {
      realtimeHandler({
        callerNumber: 'Private number',
        sipCallId: '20000000-0000-4000-8000-000000000010',
        timestamp: '2026-07-27T10:00:30.000Z',
        lineId: '20000000-0000-4000-8000-000000000002',
        lineName: 'Cosmote line',
        presentation: 'restricted',
      })
    })

    expect(mocks.openCustomerSearch).not.toHaveBeenCalled()
    expect(mocks.showCallerIdToast).toHaveBeenCalledTimes(1)
  })
})
