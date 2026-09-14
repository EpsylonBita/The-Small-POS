import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  getResolvedTerminalIdentity: vi.fn(),
  fetchAllCancellationNotices: vi.fn(),
}))

vi.mock('../../../lib', () => ({
  onEvent: mocks.onEvent,
  offEvent: mocks.offEvent,
}))

vi.mock('../../services/terminal-credentials', () => ({
  getResolvedTerminalIdentity: mocks.getResolvedTerminalIdentity,
}))

vi.mock('../../services/platformCancellationNoticesApi', () => ({
  fetchAllCancellationNotices: mocks.fetchAllCancellationNotices,
}))

import { useCancellationNotices } from '../useCancellationNotices'
import * as store from '../../services/platformCancellationNoticeStore'
import type { PlatformCancellationNotice } from '../../services/platformCancellationNoticeStore'

const identity = { organizationId: 'org-1', branchId: 'branch-1', terminalId: 'terminal-1' }

const notice = (id: string, overrides: Partial<PlatformCancellationNotice> = {}): PlatformCancellationNotice => ({
  id,
  order_number: `#${id}`,
  platform: 'efood',
  external_order_id: null,
  cancelled_at: '2026-09-14T10:00:00.000Z',
  ...overrides,
})

function okResult(scope: string, notices: PlatformCancellationNotice[]) {
  return { ok: true, scope, notices, incomplete: false, resumeCursor: null }
}

function eventHandlers(): Record<string, Array<(payload?: unknown) => void>> {
  const handlers: Record<string, Array<(payload?: unknown) => void>> = {}
  for (const call of mocks.onEvent.mock.calls) {
    const [name, fn] = call as [string, (payload?: unknown) => void]
    handlers[name] = handlers[name] ? [...handlers[name], fn] : [fn]
  }
  return handlers
}

function emit(name: string, payload?: unknown) {
  for (const fn of eventHandlers()[name] ?? []) fn(payload)
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  mocks.getResolvedTerminalIdentity.mockResolvedValue(identity)
  mocks.fetchAllCancellationNotices.mockResolvedValue(okResult('scope-a', []))
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useCancellationNotices', () => {
  it('surfaces an authenticated provider notice as the global current notice', async () => {
    mocks.fetchAllCancellationNotices.mockResolvedValue(okResult('scope-a', [notice('n1')]))

    const { result } = renderHook(() => useCancellationNotices(true))

    await waitFor(() => expect(result.current.current?.id).toBe('n1'))
    expect(result.current.queueLength).toBe(1)
  })

  it('does not fetch or surface a notice while disabled', async () => {
    mocks.fetchAllCancellationNotices.mockResolvedValue(okResult('scope-a', [notice('n1')]))

    const { result } = renderHook(() => useCancellationNotices(false))

    await Promise.resolve()
    expect(result.current.current).toBeNull()
    expect(mocks.fetchAllCancellationNotices).not.toHaveBeenCalled()
  })

  it('advances the queue only on a durable acknowledgement', async () => {
    mocks.fetchAllCancellationNotices.mockResolvedValue(okResult('scope-a', [notice('n1'), notice('n2')]))

    const { result } = renderHook(() => useCancellationNotices(true))

    await waitFor(() => expect(result.current.queueLength).toBe(2))
    expect(result.current.current?.id).toBe('n1')

    await act(async () => {
      result.current.acknowledge()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(result.current.current?.id).toBe('n2'))
    expect(result.current.queueLength).toBe(1)
  })

  it('keeps showing the notice and blocks acknowledgement when durable persistence fails', async () => {
    mocks.fetchAllCancellationNotices.mockResolvedValue(okResult('scope-a', [notice('n1')]))
    const mergeSpy = vi
      .spyOn(store, 'mergeIncomingNotices')
      .mockResolvedValue({ pending: [], ok: false })
    vi.spyOn(store, 'loadPendingNotices').mockResolvedValue({
      scope: null,
      pending: [],
      ackedIds: new Set(),
      ok: true,
    })

    const { result } = renderHook(() => useCancellationNotices(true))

    await waitFor(() => expect(result.current.current?.id).toBe('n1'))
    expect(result.current.persistPending).toBe(true)

    act(() => {
      result.current.acknowledge()
    })
    // Acknowledge must be a no-op while persistPending: nothing to await/assert
    // beyond the notice still being present and unacked.
    expect(result.current.current?.id).toBe('n1')

    mergeSpy.mockRestore()
  })

  it('restores an offline-saved notice at startup with no network fetch', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true })
    await store.mergeIncomingNotices(identity, 'scope-a', [notice('n1')])
    mocks.fetchAllCancellationNotices.mockClear()

    const { result } = renderHook(() => useCancellationNotices(true))

    await waitFor(() => expect(result.current.current?.id).toBe('n1'))
    expect(mocks.fetchAllCancellationNotices).not.toHaveBeenCalled()
  })

  it('never replays an already-acknowledged notice across a poll and a simulated restart', async () => {
    mocks.fetchAllCancellationNotices.mockResolvedValue(okResult('scope-a', [notice('n1')]))

    const { result, unmount } = renderHook(() => useCancellationNotices(true))
    await waitFor(() => expect(result.current.current?.id).toBe('n1'))

    await act(async () => {
      result.current.acknowledge()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.current).toBeNull())

    // A later poll re-returning the same notice must not resurrect it.
    await act(async () => {
      result.current.retry()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.current).toBeNull()
    unmount()

    // Simulated restart: a fresh mount must also restore it as acknowledged.
    const second = renderHook(() => useCancellationNotices(true))
    await waitFor(() => expect(mocks.getResolvedTerminalIdentity).toHaveBeenCalled())
    expect(second.result.current.current).toBeNull()
  })

  it('clears stale pending and ignores a stale in-flight response when the identity/scope changes mid-read', async () => {
    let resolveFirst: ((value: ReturnType<typeof okResult>) => void) | null = null
    mocks.fetchAllCancellationNotices.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
    )

    const { result } = renderHook(() => useCancellationNotices(true))
    await waitFor(() => expect(mocks.fetchAllCancellationNotices).toHaveBeenCalledTimes(1))

    // Identity changes while the first read is still in flight.
    mocks.fetchAllCancellationNotices.mockResolvedValue(okResult('scope-b', [notice('n2')]))
    mocks.getResolvedTerminalIdentity.mockResolvedValue({
      organizationId: 'org-1',
      branchId: 'branch-1',
      terminalId: 'terminal-2',
    })
    emit('terminal-credentials-updated')

    // The stale first read (still in flight, blocking `pollInFlightRef`) must
    // resolve before the new identity's poll can run; its scope-a payload
    // must never overwrite the new scope's queue.
    await act(async () => {
      resolveFirst?.(okResult('scope-a', [notice('n1')]))
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(result.current.current?.id).toBe('n2'))
  })

  it('cancels trailing polls and stops surfacing notices once disabled/unmounted', async () => {
    mocks.fetchAllCancellationNotices.mockResolvedValue(okResult('scope-a', [notice('n1')]))

    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useCancellationNotices(enabled),
      { initialProps: { enabled: true } },
    )
    await waitFor(() => expect(result.current.current?.id).toBe('n1'))

    mocks.fetchAllCancellationNotices.mockClear()
    rerender({ enabled: false })
    expect(result.current.current).toBeNull()

    // A subsequent hint/online event while disabled must not trigger a fetch.
    emit('order-realtime-update', { status: 'cancelled' })
    await Promise.resolve()
    expect(mocks.fetchAllCancellationNotices).not.toHaveBeenCalled()

    unmount()
  })

  it('re-fetches on a realtime cancellation hint but not on a regular recognized status update', async () => {
    mocks.fetchAllCancellationNotices.mockResolvedValue(okResult('scope-a', []))
    renderHook(() => useCancellationNotices(true))
    await waitFor(() => expect(mocks.fetchAllCancellationNotices).toHaveBeenCalledTimes(1))

    mocks.fetchAllCancellationNotices.mockClear()
    emit('order-status-updated', { status: 'preparing' })
    await Promise.resolve()
    expect(mocks.fetchAllCancellationNotices).not.toHaveBeenCalled()

    emit('order-realtime-update', { status: 'cancelled' })
    await waitFor(() => expect(mocks.fetchAllCancellationNotices).toHaveBeenCalledTimes(1))
  })
})
