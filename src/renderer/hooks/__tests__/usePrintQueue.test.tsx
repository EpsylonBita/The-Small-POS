import { Suspense, startTransition, useState } from 'react'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  printer: {
    listJobs: vi.fn(),
    cancelJob: vi.fn(),
    cancelAllJobs: vi.fn(),
    pauseQueue: vi.fn(),
    resumeQueue: vi.fn(),
    retryJob: vi.fn(),
    reprintJob: vi.fn(),
  },
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}))

vi.mock('../../../lib', () => ({
  getBridge: () => ({ printer: mocks.printer }),
  onEvent: mocks.onEvent,
  offEvent: mocks.offEvent,
}))

import { usePrintQueue } from '../usePrintQueue'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const job = (id: string, status = 'pending') => ({
  id,
  source: 'pos' as const,
  entityType: 'order_receipt',
  entityId: `order-${id}`,
  printerProfileId: 'profile-1',
  printerDisplayName: 'Front counter MCP31',
  resolvedTransport: 'windows' as const,
  resolvedTarget: 'MCP31 - Ethernet:TCP;',
  status,
  transportState: status === 'dispatched' ? 'spool_completed' as const : 'windows_queued' as const,
  spoolJobId: 73,
  snapshotAvailable: true,
  reprintOfJobId: null,
  cancellable: status === 'pending',
  retryable: status === 'failed',
  reprintable: status === 'dispatched',
  lastError: null,
  warningCode: null,
  warningMessage: null,
  lastSeenAt: '2026-08-12T08:00:01Z',
  createdAt: '2026-08-12T08:00:00Z',
  updatedAt: '2026-08-12T08:00:01Z',
})

const snapshot = (
  ids: string[],
  options: {
    status?: string
    offset?: number
    limit?: number
    total?: number
  } = {},
) => ({
  success: true as const,
  jobs: ids.map((id) => job(id, options.status)),
  queuePaused: false,
  pausedPrinterProfileIds: [],
  counts: {
    active: 7,
    failed: 3,
    stale: 2,
    history: 11,
  },
  pagination: {
    offset: options.offset ?? 0,
    limit: options.limit ?? 20,
    total: options.total ?? ids.length,
    hasMore: (options.offset ?? 0) + (options.limit ?? 20) < (options.total ?? ids.length),
  },
})

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('usePrintQueue', () => {
  let visibilityState: DocumentVisibilityState

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    visibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    })
    mocks.printer.listJobs.mockResolvedValue(snapshot(['job-1']))
  })

  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('loads the typed snapshot initially and exposes whole-queue counts plus filtered pagination', async () => {
    mocks.printer.listJobs.mockResolvedValueOnce(snapshot(['job-21'], {
      offset: 20,
      limit: 20,
      total: 47,
    }))

    const { result } = renderHook(() => usePrintQueue({
      status: 'pending',
      printerProfileId: 'profile-1',
      limit: 20,
      offset: 20,
    }))

    expect(result.current.loading).toBe(true)
    await flush()
    expect(result.current.loading).toBe(false)

    expect(mocks.printer.listJobs).toHaveBeenCalledWith({
      status: 'pending',
      printerProfileId: 'profile-1',
      limit: 20,
      offset: 20,
    })
    expect(result.current.jobs.map(({ id }) => id)).toEqual(['job-21'])
    expect(result.current.counts).toEqual({ active: 7, failed: 3, stale: 2, history: 11 })
    expect(result.current.pagination).toEqual({
      offset: 20,
      limit: 20,
      total: 47,
      hasMore: true,
    })
    expect(result.current.stale).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('replaces the page when stable list options change instead of appending shifted offset pages', async () => {
    mocks.printer.listJobs
      .mockResolvedValueOnce(snapshot(['job-1'], { limit: 20, total: 47 }))
      .mockResolvedValueOnce(snapshot(['job-1', 'job-2'], { limit: 40, total: 47 }))
      .mockResolvedValueOnce(snapshot(['job-41'], { limit: 40, offset: 40, total: 47 }))

    const { result, rerender } = renderHook(
      ({ limit, offset }) => usePrintQueue({ limit, offset }),
      { initialProps: { limit: 20, offset: 0 } },
    )
    await flush()
    expect(result.current.jobs).toHaveLength(1)

    rerender({ limit: 40, offset: 0 })
    await flush()
    expect(result.current.jobs.map(({ id }) => id)).toEqual(['job-1', 'job-2'])
    expect(result.current.pagination.limit).toBe(40)

    rerender({ limit: 40, offset: 40 })
    await flush()
    expect(result.current.jobs.map(({ id }) => id)).toEqual(['job-41'])
    expect(result.current.pagination.offset).toBe(40)
    expect(mocks.printer.listJobs).toHaveBeenLastCalledWith({ limit: 40, offset: 40 })
  })

  it('uses a stable jobIds option key, requests the bounded bridge page, and keeps server metadata truthful', async () => {
    mocks.printer.listJobs.mockResolvedValue(snapshot(['job-1', 'job-2'], {
      limit: 100,
      total: 12,
    }))

    const { result, rerender } = renderHook(
      ({ render }) => {
        void render
        return usePrintQueue({ jobIds: ['job-2'] })
      },
      { initialProps: { render: 1 } },
    )
    await flush()
    expect(result.current.jobs.map(({ id }) => id)).toEqual(['job-2'])

    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(1)
    expect(mocks.printer.listJobs).toHaveBeenCalledWith({ limit: 100, offset: 0 })
    expect(result.current.pagination).toEqual({
      offset: 0,
      limit: 100,
      total: 12,
      hasMore: false,
    })

    rerender({ render: 2 })
    await flush()
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(1)
  })

  it('invalidates prior rows immediately when the query changes and ignores the prior query response', async () => {
    const priorQueryRefresh = deferred<ReturnType<typeof snapshot>>()
    const nextQueryRefresh = deferred<ReturnType<typeof snapshot>>()
    mocks.printer.listJobs
      .mockResolvedValueOnce(snapshot(['old-job'], { limit: 100 }))
      .mockReturnValueOnce(priorQueryRefresh.promise)
      .mockReturnValueOnce(nextQueryRefresh.promise)
    const renderStates: Array<{
      jobId: string
      jobs: string[]
      loading: boolean
      stale: boolean
      error: string | null
    }> = []

    const { result, rerender } = renderHook(
      ({ jobId }) => {
        const queue = usePrintQueue({ jobIds: [jobId] })
        renderStates.push({
          jobId,
          jobs: queue.jobs.map(({ id }) => id),
          loading: queue.loading,
          stale: queue.stale,
          error: queue.error,
        })
        return queue
      },
      { initialProps: { jobId: 'old-job' } },
    )
    await flush()
    expect(result.current.jobs.map(({ id }) => id)).toEqual(['old-job'])

    act(() => vi.advanceTimersByTime(5_000))
    rerender({ jobId: 'new-job' })

    expect(renderStates.find(({ jobId }) => jobId === 'new-job')).toEqual({
      jobId: 'new-job',
      jobs: [],
      loading: true,
      stale: false,
      error: null,
    })
    expect(result.current.jobs).toEqual([])
    expect(result.current.loading).toBe(true)
    expect(result.current.stale).toBe(false)
    expect(result.current.error).toBeNull()
    expect(mocks.printer.listJobs).toHaveBeenLastCalledWith({ limit: 100, offset: 0 })

    await act(async () => {
      priorQueryRefresh.resolve(snapshot(['old-job'], { limit: 100 }))
      await priorQueryRefresh.promise
    })
    await flush()
    expect(result.current.jobs).toEqual([])

    await act(async () => {
      nextQueryRefresh.resolve(snapshot(['new-job'], { limit: 100 }))
      await nextQueryRefresh.promise
    })
    expect(result.current.jobs.map(({ id }) => id)).toEqual(['new-job'])
  })

  it('does not let a suspended query render invalidate the committed query refresh', async () => {
    const committedRefresh = deferred<ReturnType<typeof snapshot>>()
    const neverCommits = new Promise<void>(() => {})
    mocks.printer.listJobs
      .mockResolvedValueOnce(snapshot(['old-job']))
      .mockReturnValueOnce(committedRefresh.promise)
    let selectJob!: (jobId: string) => void
    let refresh!: () => Promise<void>

    function Harness() {
      const [jobId, setJobId] = useState('old-job')
      const queue = usePrintQueue({ jobIds: [jobId] })
      selectJob = setJobId
      if (jobId === 'suspended-job') throw neverCommits
      refresh = queue.refresh
      return <div data-testid="committed-job">{queue.jobs[0]?.status ?? 'empty'}</div>
    }

    render(<Suspense fallback={<div>loading transition</div>}><Harness /></Suspense>)
    await flush()
    expect(screen.getByTestId('committed-job')).toHaveTextContent('pending')

    let refreshPromise!: Promise<void>
    act(() => {
      refreshPromise = refresh()
      startTransition(() => selectJob('suspended-job'))
    })
    await act(async () => {
      committedRefresh.resolve(snapshot(['old-job'], { status: 'failed' }))
      await refreshPromise
    })

    expect(screen.getByTestId('committed-job')).toHaveTextContent('failed')
  })

  it('debounces queue invalidation events by exactly 100ms', async () => {
    const { result } = renderHook(() => usePrintQueue())
    await flush()
    expect(result.current.loading).toBe(false)
    const handler = mocks.onEvent.mock.calls.find(
      ([channel]) => channel === 'printer:queue-changed',
    )?.[1]

    expect(handler).toBeTypeOf('function')
    act(() => {
      handler()
      handler()
      handler()
      vi.advanceTimersByTime(99)
    })
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(2)
  })

  it('polls every five seconds for the full visible hook lifetime, including terminal jobs', async () => {
    mocks.printer.listJobs.mockResolvedValue(snapshot(['done'], { status: 'dispatched' }))
    const { result } = renderHook(() => usePrintQueue())
    await flush()
    expect(result.current.loading).toBe(false)

    act(() => vi.advanceTimersByTime(4_999))
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(3)
  })

  it('does not supersede an unfinished poll with another five-second tick', async () => {
    const slowPoll = deferred<ReturnType<typeof snapshot>>()
    mocks.printer.listJobs
      .mockResolvedValueOnce(snapshot(['initial']))
      .mockReturnValueOnce(slowPoll.promise)
    const { result } = renderHook(() => usePrintQueue())
    await flush()

    act(() => vi.advanceTimersByTime(10_000))
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(2)

    await act(async () => {
      slowPoll.resolve(snapshot(['slow-result']))
      await slowPoll.promise
    })
    await flush()
    expect(result.current.jobs[0]?.id).toBe('slow-result')
  })

  it('pauses polling while hidden and refreshes on visibility and focus return', async () => {
    const { result } = renderHook(() => usePrintQueue())
    await flush()
    expect(result.current.loading).toBe(false)

    visibilityState = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await Promise.resolve()
    })
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(1)

    visibilityState = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(2)

    visibilityState = 'hidden'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(2)

    visibilityState = 'visible'
    act(() => window.dispatchEvent(new Event('focus')))
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(3)
  })

  it('uses last-write-wins sequencing for overlapping requests', async () => {
    const older = deferred<ReturnType<typeof snapshot>>()
    const newer = deferred<ReturnType<typeof snapshot>>()
    mocks.printer.listJobs
      .mockResolvedValueOnce(snapshot(['initial']))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)

    const { result } = renderHook(() => usePrintQueue())
    await flush()
    expect(result.current.jobs[0]?.id).toBe('initial')

    let olderRefresh!: Promise<void>
    let newerRefresh!: Promise<void>
    act(() => {
      olderRefresh = result.current.refresh()
      newerRefresh = result.current.refresh()
    })
    await act(async () => {
      newer.resolve(snapshot(['newer']))
      await newerRefresh
    })
    expect(result.current.jobs[0]?.id).toBe('newer')

    await act(async () => {
      older.resolve(snapshot(['older']))
      await olderRefresh
    })
    expect(result.current.jobs[0]?.id).toBe('newer')
  })

  it('retains the last good snapshot and marks it stale after a silent refresh failure', async () => {
    mocks.printer.listJobs
      .mockResolvedValueOnce(snapshot(['last-good']))
      .mockRejectedValueOnce(new Error('native queue temporarily unavailable'))
      .mockResolvedValueOnce(snapshot(['recovered']))

    const { result } = renderHook(() => usePrintQueue())
    await flush()
    expect(result.current.jobs[0]?.id).toBe('last-good')

    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    await flush()
    expect(result.current.stale).toBe(true)
    expect(result.current.jobs[0]?.id).toBe('last-good')
    expect(result.current.error).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    await flush()
    expect(result.current.jobs[0]?.id).toBe('recovered')
    expect(result.current.stale).toBe(false)
  })

  it('retains data and exposes the error from a failed manual refresh', async () => {
    mocks.printer.listJobs
      .mockResolvedValueOnce(snapshot(['last-good']))
      .mockRejectedValueOnce('manual bridge failure')

    const { result } = renderHook(() => usePrintQueue())
    await flush()
    expect(result.current.jobs[0]?.id).toBe('last-good')

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.jobs[0]?.id).toBe('last-good')
    expect(result.current.stale).toBe(true)
    expect(result.current.error).toBe('manual bridge failure')
  })

  it('returns exact mutation results and silently refreshes in finally', async () => {
    const cancelResult = { success: true, affected: 1, unchanged: 0 }
    const bulkResult = { success: true, affected: 2, unchanged: 3 }
    const pauseResult = { success: true, queuePaused: true, nativeControlsConfirmed: 1 }
    const resumeResult = { success: true, queuePaused: false, nativeControlsConfirmed: 1 }
    const retryResult = {
      success: true,
      jobId: 'failed-job',
      newJobId: null,
      affected: 1,
      unchanged: false,
      duplicate: false,
    }
    const reprintResult = {
      success: true,
      jobId: 'source-job',
      newJobId: 'new-job',
      affected: 1,
      unchanged: false,
      duplicate: false,
    }
    mocks.printer.cancelJob.mockResolvedValue(cancelResult)
    mocks.printer.cancelAllJobs.mockResolvedValue(bulkResult)
    mocks.printer.pauseQueue.mockResolvedValue(pauseResult)
    mocks.printer.resumeQueue.mockResolvedValue(resumeResult)
    mocks.printer.retryJob.mockResolvedValue(retryResult)
    mocks.printer.reprintJob.mockResolvedValue(reprintResult)

    const { result } = renderHook(() => usePrintQueue())
    await flush()
    expect(result.current.loading).toBe(false)
    const initialListCalls = mocks.printer.listJobs.mock.calls.length

    const mutationResults: unknown[] = []
    await act(async () => {
      mutationResults.push(await result.current.cancelJob('pending-job'))
      mutationResults.push(await result.current.cancelAllJobs({
        statuses: ['pending', 'printing'],
      }))
      mutationResults.push(await result.current.pauseQueue({
        printerProfileId: 'profile-1',
      }))
      mutationResults.push(await result.current.resumeQueue({
        printerProfileId: 'profile-1',
      }))
      mutationResults.push(await result.current.retryJob('failed-job'))
      mutationResults.push(await result.current.reprintJob('source-job'))
    })

    expect(mutationResults).toEqual([
      cancelResult,
      bulkResult,
      pauseResult,
      resumeResult,
      retryResult,
      reprintResult,
    ])

    expect(mocks.printer.cancelJob).toHaveBeenCalledWith('pending-job')
    expect(mocks.printer.cancelAllJobs).toHaveBeenCalledWith({
      statuses: ['pending', 'printing'],
    })
    expect(mocks.printer.pauseQueue).toHaveBeenCalledWith({ printerProfileId: 'profile-1' })
    expect(mocks.printer.resumeQueue).toHaveBeenCalledWith({ printerProfileId: 'profile-1' })
    expect(mocks.printer.retryJob).toHaveBeenCalledWith('failed-job')
    expect(mocks.printer.reprintJob).toHaveBeenCalledWith({ jobId: 'source-job' })
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(initialListCalls + 6)
  })

  it('still silently refreshes when a mutation rejects without replacing the mutation error', async () => {
    const mutationError = new Error('ownership not confirmed')
    mocks.printer.cancelJob.mockRejectedValueOnce(mutationError)
    const { result } = renderHook(() => usePrintQueue())
    await flush()
    expect(result.current.loading).toBe(false)
    const initialListCalls = mocks.printer.listJobs.mock.calls.length

    await expect(result.current.cancelJob('windows-job')).rejects.toBe(mutationError)

    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(initialListCalls + 1)
  })

  it('removes its listener and clears polling and debounce timers on unmount', async () => {
    const { result, unmount } = renderHook(() => usePrintQueue())
    await flush()
    expect(result.current.loading).toBe(false)
    const handler = mocks.onEvent.mock.calls.find(
      ([channel]) => channel === 'printer:queue-changed',
    )?.[1]
    act(() => handler())

    unmount()
    expect(mocks.offEvent).toHaveBeenCalledWith('printer:queue-changed', handler)
    const callsAtUnmount = mocks.printer.listJobs.mock.calls.length

    act(() => vi.advanceTimersByTime(15_000))
    expect(mocks.printer.listJobs).toHaveBeenCalledTimes(callsAtUnmount)
  })
})
