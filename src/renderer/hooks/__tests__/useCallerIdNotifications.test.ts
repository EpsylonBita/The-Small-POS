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

  it('does not subscribe before the authenticated terminal client is available', () => {
    renderHook(() =>
      useCallerIdNotifications({
        realtimeReady: true,
        realtimeClient: null,
      }),
    )

    expect(mocks.subscribeToCallerIdEvents).not.toHaveBeenCalled()
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

    expect(mocks.subscribeToCallerIdEvents).not.toHaveBeenCalled()

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
      mocks.subscribeToCallerIdEvents.mock.calls[0]?.[4]
    expect(identityCurrent()).toBe(true)
    mocks.getCachedTerminalCredentials.mockReturnValue({
      terminalId: 'terminal-2',
      apiKey: 'replacement-terminal-api-key',
      organizationId: 'org-1',
      branchId: 'branch-1',
    })
    expect(identityCurrent()).toBe(false)

    rerender({ realtimeReady: false })
    expect(mocks.unsubscribeRealtime).toHaveBeenCalledTimes(1)

    unmount()
    expect(mocks.offEvent).not.toHaveBeenCalledWith(
      'callerid:incoming-call',
      expect.any(Function),
    )
  })

  it('displays a fresh hardened local call without waiting for Realtime', () => {
    const { unmount } = renderHook(() =>
      useCallerIdNotifications({
        realtimeReady: false,
        realtimeClient: null,
      }),
    )
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

    expect(mocks.subscribeToCallerIdEvents).not.toHaveBeenCalled()
    expect(mocks.showCallerIdToast).toHaveBeenCalledTimes(1)
    expect(mocks.showCallerIdToast).toHaveBeenCalledWith(
      expect.objectContaining({
        callerNumber: '2101234567',
        sipCallId: '40000000-0000-4000-8000-000000000004',
        timestamp: occurredAt,
        lineId: '20000000-0000-4000-8000-000000000002',
        lineName: 'Cosmote line',
        presentation: 'allowed',
      }),
      expect.objectContaining({
        onSearchCustomer: expect.any(Function),
        onDisplayed: expect.any(Function),
      }),
    )
    const toastOptions = mocks.showCallerIdToast.mock.calls[0]?.[1]
    act(() => {
      toastOptions.onDisplayed()
    })
    expect(mocks.reportCallerIdReceipt).not.toHaveBeenCalled()

    unmount()
    expect(mocks.offEvent).toHaveBeenCalledWith(
      'callerid:validated-local-call',
      localRegistration?.[1],
    )
  })

  it('rejects malformed, stale, and privacy-inconsistent local calls', () => {
    renderHook(() =>
      useCallerIdNotifications({
        realtimeReady: false,
        realtimeClient: null,
      }),
    )
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
  })

  it('deduplicates the local card when the normalized cloud event arrives', () => {
    renderHook(() =>
      useCallerIdNotifications({ realtimeReady: true, realtimeClient } as any),
    )
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
    const toastOptions = mocks.showCallerIdToast.mock.calls[0]?.[1]
    act(() => {
      toastOptions.onDisplayed()
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

    expect(mocks.showCallerIdToast).toHaveBeenCalledTimes(1)
    expect(reportReceipt).toHaveBeenCalledTimes(1)
    expect(reportReceipt).toHaveBeenCalledWith({ status: 'displayed' })
  })

  it('does not report displayed at enqueue and reports it only from the mounted card callback', () => {
    renderHook(() =>
      useCallerIdNotifications({ realtimeReady: true, realtimeClient } as any),
    )
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

    expect(mocks.showCallerIdToast).toHaveBeenCalledTimes(1)
    expect(reportReceipt).not.toHaveBeenCalled()
    expect(mocks.reportCallerIdReceipt).not.toHaveBeenCalledWith(
      '20000000-0000-4000-8000-000000000008',
      { status: 'displayed' },
      '2026-07-27T10:00:30.000Z',
    )

    const toastOptions = mocks.showCallerIdToast.mock.calls[0]?.[1]
    act(() => {
      toastOptions.onDisplayed()
    })
    expect(reportReceipt).toHaveBeenCalledTimes(1)
    expect(reportReceipt).toHaveBeenCalledWith({ status: 'displayed' })
  })

  it('reports only DISPLAY_FAILED when toast enqueue throws synchronously', () => {
    mocks.showCallerIdToast.mockImplementationOnce(() => {
      throw new Error('toast unavailable')
    })
    renderHook(() =>
      useCallerIdNotifications({ realtimeReady: true, realtimeClient } as any),
    )
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
})
