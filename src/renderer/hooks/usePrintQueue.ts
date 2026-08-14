import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getBridge, offEvent, onEvent } from '../../lib'
import type {
  PrintQueueCancelAllOptions,
  PrintQueueCancelAllResult,
  PrintQueueCancelJobResult,
  PrintQueueControlOptions,
  PrintQueueCounts,
  PrintQueueJob,
  PrintQueueListOptions,
  PrintQueuePagination,
  PrintQueuePauseResult,
  PrintQueueReprintResult,
  PrintQueueResumeResult,
  PrintQueueRetryResult,
} from '../components/printing/print-queue-contract'

const PRINT_QUEUE_EVENT = 'printer:queue-changed'
const EVENT_DEBOUNCE_MS = 100
const VISIBLE_POLL_MS = 5_000
const JOB_ID_BRIDGE_LIMIT = 100

const EMPTY_COUNTS: PrintQueueCounts = {
  active: 0,
  failed: 0,
  stale: 0,
  history: 0,
}

export interface UsePrintQueueOptions extends PrintQueueListOptions {
  /** Temporary client-side bridge until native job-ID filtering is available. */
  jobIds?: readonly string[]
}

export interface UsePrintQueueResult {
  jobs: PrintQueueJob[]
  queuePaused: boolean
  pausedPrinterProfileIds: string[]
  counts: PrintQueueCounts
  pagination: PrintQueuePagination
  loading: boolean
  stale: boolean
  error: string | null
  refresh: () => Promise<void>
  cancelJob: (jobId: string) => Promise<PrintQueueCancelJobResult>
  cancelAllJobs: (options?: PrintQueueCancelAllOptions) => Promise<PrintQueueCancelAllResult>
  pauseQueue: (options?: PrintQueueControlOptions) => Promise<PrintQueuePauseResult>
  resumeQueue: (options?: PrintQueueControlOptions) => Promise<PrintQueueResumeResult>
  retryJob: (jobId: string) => Promise<PrintQueueRetryResult>
  reprintJob: (jobId: string) => Promise<PrintQueueReprintResult>
}

interface QueueState {
  jobs: PrintQueueJob[]
  queuePaused: boolean
  pausedPrinterProfileIds: string[]
  counts: PrintQueueCounts
  pagination: PrintQueuePagination
}

interface StoredQueueState {
  queryKey: string
  data: QueueState
}

type RefreshMode = 'manual' | 'silent'

function normalizedJobIds(jobIds: readonly string[] | undefined): string[] | null {
  if (jobIds === undefined) return null
  return [...new Set(jobIds.map((jobId) => jobId.trim()).filter(Boolean))].sort()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Failed to load print queue'
}

function initialPagination(
  options: Pick<UsePrintQueueOptions, 'limit' | 'offset'>,
  hasJobIdFilter: boolean,
): PrintQueuePagination {
  return {
    offset: hasJobIdFilter ? 0 : (options.offset ?? 0),
    limit: hasJobIdFilter ? JOB_ID_BRIDGE_LIMIT : (options.limit ?? 50),
    total: 0,
    hasMore: false,
  }
}

export function usePrintQueue(options: UsePrintQueueOptions = {}): UsePrintQueueResult {
  const bridge = useRef(getBridge()).current
  const printerProfileId = options.printerProfileId?.trim() || undefined
  const jobIdsKey = options.jobIds === undefined
    ? null
    : JSON.stringify(normalizedJobIds(options.jobIds))
  const jobIds = useMemo<string[] | null>(
    () => (jobIdsKey === null ? null : JSON.parse(jobIdsKey) as string[]),
    [jobIdsKey],
  )
  const listOptions = useMemo<PrintQueueListOptions>(() => {
    const request: PrintQueueListOptions = {}
    if (options.status !== undefined) request.status = options.status
    if (printerProfileId !== undefined) request.printerProfileId = printerProfileId
    if (jobIds !== null) {
      request.limit = JOB_ID_BRIDGE_LIMIT
      request.offset = 0
    } else {
      if (options.limit !== undefined) request.limit = options.limit
      if (options.offset !== undefined) request.offset = options.offset
    }
    return request
  }, [jobIds, options.limit, options.offset, options.status, printerProfileId])
  const queryKey = useMemo(
    () => JSON.stringify({ listOptions, jobIds }),
    [jobIds, listOptions],
  )
  const activeQueryKeyRef = useRef(queryKey)
  const requestSequenceRef = useRef(0)

  useLayoutEffect(() => {
    if (activeQueryKeyRef.current === queryKey) return
    activeQueryKeyRef.current = queryKey
    requestSequenceRef.current += 1
  }, [queryKey])

  const [storedQueue, setStoredQueue] = useState<StoredQueueState>(() => ({
    queryKey,
    data: {
      jobs: [],
      queuePaused: false,
      pausedPrinterProfileIds: [],
      counts: EMPTY_COUNTS,
      pagination: initialPagination(listOptions, jobIds !== null),
    },
  }))
  const [loading, setLoading] = useState(true)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestSequenceRef.current += 1
    }
  }, [])

  const runRefresh = useCallback(async (mode: RefreshMode): Promise<void> => {
    if (!mountedRef.current) return
    const sequence = ++requestSequenceRef.current
    if (mode === 'manual') {
      setLoading(true)
      setError(null)
    }

    try {
      const latest = await bridge.printer.listJobs(listOptions)
      if (
        !mountedRef.current
        || sequence !== requestSequenceRef.current
        || queryKey !== activeQueryKeyRef.current
      ) return
      const filteredJobs = jobIds === null
        ? latest.jobs
        : latest.jobs.filter(({ id }) => jobIds.includes(id))
      setStoredQueue({
        queryKey,
        data: {
          jobs: filteredJobs,
          queuePaused: latest.queuePaused,
          pausedPrinterProfileIds: latest.pausedPrinterProfileIds,
          counts: latest.counts,
          // This remains native query metadata. Client-side jobIds filtering must
          // not invent a different server total or hasMore value.
          pagination: latest.pagination,
        },
      })
      setStale(false)
      setError(null)
    } catch (refreshError) {
      if (
        !mountedRef.current
        || sequence !== requestSequenceRef.current
        || queryKey !== activeQueryKeyRef.current
      ) return
      // Keep the last good QueueState intact. Events and polling are only
      // invalidation mechanisms; a malformed/failed latest read is never data.
      setStoredQueue((current) => current.queryKey === queryKey
        ? current
        : {
            queryKey,
            data: {
              ...current.data,
              jobs: [],
              pagination: initialPagination(listOptions, jobIds !== null),
            },
          })
      setStale(true)
      if (mode === 'manual') setError(errorMessage(refreshError))
    } finally {
      if (
        mountedRef.current
        && sequence === requestSequenceRef.current
        && queryKey === activeQueryKeyRef.current
      ) {
        setLoading(false)
      }
    }
  }, [bridge.printer, jobIds, listOptions, queryKey])

  const refresh = useCallback(() => runRefresh('manual'), [runRefresh])

  useEffect(() => {
    void runRefresh('manual')
  }, [runRefresh])

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const handleQueueChanged = () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void runRefresh('silent')
      }, EVENT_DEBOUNCE_MS)
    }

    onEvent(PRINT_QUEUE_EVENT, handleQueueChanged)
    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      offEvent(PRINT_QUEUE_EVENT, handleQueueChanged)
    }
  }, [runRefresh])

  useEffect(() => {
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let pollRefreshInFlight = false
    const stopPolling = () => {
      if (pollTimer === null) return
      clearInterval(pollTimer)
      pollTimer = null
    }
    const startPolling = () => {
      if (pollTimer !== null || document.visibilityState !== 'visible') return
      pollTimer = setInterval(() => {
        if (pollRefreshInFlight) return
        pollRefreshInFlight = true
        void runRefresh('silent').finally(() => {
          pollRefreshInFlight = false
        })
      }, VISIBLE_POLL_MS)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        stopPolling()
        return
      }
      startPolling()
      void runRefresh('silent')
    }
    const handleFocus = () => {
      if (document.visibilityState === 'visible') void runRefresh('silent')
    }

    startPolling()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)
    return () => {
      stopPolling()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [runRefresh])

  const refreshAfterMutation = useCallback(async <T,>(
    mutation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await mutation()
    } finally {
      await runRefresh('silent')
    }
  }, [runRefresh])

  const cancelJob = useCallback(
    (jobId: string) => refreshAfterMutation(() => bridge.printer.cancelJob(jobId)),
    [bridge.printer, refreshAfterMutation],
  )
  const cancelAllJobs = useCallback(
    (mutationOptions?: PrintQueueCancelAllOptions) =>
      refreshAfterMutation(() => bridge.printer.cancelAllJobs(mutationOptions)),
    [bridge.printer, refreshAfterMutation],
  )
  const pauseQueue = useCallback(
    (mutationOptions?: PrintQueueControlOptions) =>
      refreshAfterMutation(() => bridge.printer.pauseQueue(mutationOptions)),
    [bridge.printer, refreshAfterMutation],
  )
  const resumeQueue = useCallback(
    (mutationOptions?: PrintQueueControlOptions) =>
      refreshAfterMutation(() => bridge.printer.resumeQueue(mutationOptions)),
    [bridge.printer, refreshAfterMutation],
  )
  const retryJob = useCallback(
    (jobId: string) => refreshAfterMutation(() => bridge.printer.retryJob(jobId)),
    [bridge.printer, refreshAfterMutation],
  )
  const reprintJob = useCallback(
    (jobId: string) => refreshAfterMutation(() => bridge.printer.reprintJob({ jobId })),
    [bridge.printer, refreshAfterMutation],
  )

  const queryChanged = storedQueue.queryKey !== queryKey
  const queue = !queryChanged
    ? storedQueue.data
    : {
        ...storedQueue.data,
        jobs: [],
        pagination: initialPagination(listOptions, jobIds !== null),
      }

  return {
    ...queue,
    loading: queryChanged || loading,
    stale: queryChanged ? false : stale,
    error: queryChanged ? null : error,
    refresh,
    cancelJob,
    cancelAllJobs,
    pauseQueue,
    resumeQueue,
    retryJob,
    reprintJob,
  }
}

export default usePrintQueue
