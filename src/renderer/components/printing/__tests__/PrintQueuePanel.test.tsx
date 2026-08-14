import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  usePrintQueue: vi.fn(),
  directPrinter: {
    listJobs: vi.fn(),
    cancelJob: vi.fn(),
    cancelAllJobs: vi.fn(),
    pauseQueue: vi.fn(),
    resumeQueue: vi.fn(),
    retryJob: vi.fn(),
    reprintJob: vi.fn(),
  },
  cancelJob: vi.fn(),
  cancelAllJobs: vi.fn(),
  pauseQueue: vi.fn(),
  resumeQueue: vi.fn(),
  retryJob: vi.fn(),
  reprintJob: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  translations: {} as Record<string, string>,
  current: {} as Record<string, unknown>,
}))

vi.mock('../../../hooks/usePrintQueue', () => ({
  usePrintQueue: mocks.usePrintQueue,
}))

// The previous panel fetched through this bridge directly. Keeping a bridge
// double here makes that implementation renderable while the first test proves
// the new panel has moved entirely to usePrintQueue.
vi.mock('../../../../lib', () => ({
  getBridge: () => ({ printer: mocks.directPrinter }),
}))

vi.mock('react-hot-toast', () => ({
  default: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) => {
      if (mocks.translations[key]) return mocks.translations[key]
      if (typeof fallbackOrOptions === 'string') return fallbackOrOptions
      const fallback = fallbackOrOptions?.defaultValue
      if (typeof fallback !== 'string') return key
      return Object.entries(fallbackOrOptions ?? {}).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        fallback,
      )
    },
  }),
}))

// Exercise the real ConfirmDialog state/handlers while replacing only its
// portal/glass primitives, which are independently covered by their own tests.
vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({
    isOpen,
    children,
    ariaLabel,
  }: {
    isOpen: boolean
    children: React.ReactNode
    ariaLabel: string
  }) => (isOpen ? <div role="dialog" aria-label={ariaLabel}>{children}</div> : null),
  POSGlassButton: ({
    children,
    loading,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    loading?: boolean
    variant?: string
  }) => <button {...props} disabled={props.disabled || loading}>{children}</button>,
  POSGlassInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

import PrintQueuePanel from '../PrintQueuePanel'

type JobOverrides = Partial<{
  id: string
  entityType: string
  entityId: string
  printerProfileId: string | null
  printerDisplayName: string
  resolvedTarget: string | null
  status: 'pending' | 'printing' | 'printed' | 'dispatched' | 'failed' | 'cancelled'
  transportState: string | null
  cancellable: boolean
  retryable: boolean
  reprintable: boolean
  lastError: string | null
  warningMessage: string | null
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}>

const makeJob = (overrides: JobOverrides = {}) => ({
  id: 'job-source-1',
  source: 'pos' as const,
  entityType: 'order_receipt',
  entityId: 'order-private-1',
  printerProfileId: 'profile-private-1',
  printerDisplayName: 'Front counter MCP31',
  resolvedTransport: 'windows' as const,
  resolvedTarget: 'MCP31 - Ethernet:TCP;',
  status: 'pending' as const,
  transportState: 'windows_queued' as const,
  spoolJobId: 73,
  snapshotAvailable: true,
  reprintOfJobId: null,
  cancellable: false,
  retryable: false,
  reprintable: false,
  lastError: null,
  warningCode: null,
  warningMessage: null,
  lastSeenAt: '2026-08-12T08:00:01Z',
  createdAt: '2026-08-12T08:00:00Z',
  updatedAt: '2026-08-12T08:00:02Z',
  ...overrides,
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const queueState = (jobs = [makeJob()]) => ({
  jobs,
  queuePaused: false,
  pausedPrinterProfileIds: [] as string[],
  counts: { active: 1, failed: 0, stale: 0, history: 0 },
  pagination: { offset: 0, limit: 20, total: jobs.length, hasMore: false },
  loading: false,
  stale: false,
  error: null,
  refresh: mocks.refresh,
  cancelJob: mocks.cancelJob,
  cancelAllJobs: mocks.cancelAllJobs,
  pauseQueue: mocks.pauseQueue,
  resumeQueue: mocks.resumeQueue,
  retryJob: mocks.retryJob,
  reprintJob: mocks.reprintJob,
})

const setQueue = (state: ReturnType<typeof queueState>) => {
  mocks.current = state
  mocks.usePrintQueue.mockImplementation(() => mocks.current)
}

describe('PrintQueuePanel managed POS controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.translations = {}
    setQueue(queueState())
    mocks.directPrinter.listJobs.mockResolvedValue({
      success: true,
      jobs: [],
      queuePaused: false,
      pausedPrinterProfileIds: [],
    })
  })

  afterEach(() => cleanup())

  it('uses the typed hook only and exposes the POS-only queue as a semantic section/list/article', () => {
    render(<PrintQueuePanel />)

    expect(mocks.usePrintQueue).toHaveBeenCalledWith({ limit: 20, offset: 0 })
    expect(mocks.directPrinter.listJobs).not.toHaveBeenCalled()

    const queue = screen.getByRole('region', { name: 'POS Print Queue' })
    expect(queue).toHaveAttribute('aria-busy', 'false')
    expect(within(queue).getByText(/only print jobs created by The Small POS/i)).toBeVisible()
    expect(within(queue).getByRole('list')).toBeVisible()
    expect(within(queue).getAllByRole('article')).toHaveLength(1)
    expect(within(queue).getByText('Front counter MCP31')).toBeVisible()
    expect(within(queue).getByText('MCP31 - Ethernet:TCP;')).toBeVisible()
    expect(within(queue).getByText('POS status')).toBeVisible()
    expect(within(queue).getByText('Transport status')).toBeVisible()

    expect(screen.queryByText('job-source-1')).not.toBeInTheDocument()
    expect(screen.queryByText('profile-private-1')).not.toBeInTheDocument()
    expect(screen.queryByText('order-private-1')).not.toBeInTheDocument()
  })

  it('renders Cancel, Retry, Reprint, and per-printer Resume only from typed capabilities', () => {
    setQueue(queueState([
      makeJob({ id: 'none', status: 'failed', printerDisplayName: 'No actions printer' }),
      makeJob({ id: 'cancel', cancellable: true, printerDisplayName: 'Cancel printer' }),
      makeJob({ id: 'retry', status: 'failed', retryable: true, printerDisplayName: 'Retry printer' }),
      makeJob({ id: 'reprint', status: 'dispatched', reprintable: true, printerDisplayName: 'Reprint printer' }),
      makeJob({ id: 'resume', printerProfileId: 'paused-profile', printerDisplayName: 'Paused kitchen printer' }),
    ]))
    mocks.current = {
      ...mocks.current,
      pausedPrinterProfileIds: ['paused-profile'],
    }

    render(<PrintQueuePanel />)

    const rows = screen.getAllByRole('article')
    expect(within(rows[0]).queryByRole('button', { name: /cancel|retry|reprint|resume/i })).toBeNull()
    expect(within(rows[1]).getByRole('button', {
      name: 'Cancel POS print job for Order Receipt on Cancel printer',
    })).toBeEnabled()
    expect(within(rows[2]).getByRole('button', {
      name: 'Retry POS print job for Order Receipt on Retry printer',
    })).toBeEnabled()
    expect(within(rows[3]).getByRole('button', {
      name: 'Reprint POS print job for Order Receipt on Reprint printer',
    })).toBeEnabled()
    expect(within(rows[4]).getByRole('button', { name: 'Resume Paused kitchen printer' })).toBeEnabled()
    expect(screen.getAllByRole('button', { name: /Cancel POS print job/i })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Retry POS print job/i })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Reprint POS print job/i })).toHaveLength(1)
  })

  it('confirms one bulk pause-and-cancel mutation and reports requested versus confirmed evidence truthfully', async () => {
    mocks.cancelAllJobs.mockResolvedValue({
      success: true,
      affected: 2,
      unchanged: 1,
      localCancelled: 1,
      activeStopsRequested: 1,
      nativeControlsRequested: 2,
      nativeControlsConfirmed: 1,
      nativeControlsFailed: 1,
      ownershipRefused: 1,
      printerProfileId: null,
    })

    render(<PrintQueuePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause and cancel POS jobs' }))

    expect(mocks.cancelAllJobs).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Pause and cancel POS jobs?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause and cancel' }))

    await waitFor(() => expect(mocks.cancelAllJobs).toHaveBeenCalledTimes(1))
    expect(mocks.cancelAllJobs).toHaveBeenCalledWith({
      statuses: ['pending', 'printing', 'dispatched'],
    })
    const feedback = await screen.findByRole('status', { name: 'Print queue action result' })
    expect(feedback).toHaveTextContent('2 affected')
    expect(feedback).toHaveTextContent('1 unchanged')
    expect(feedback).toHaveTextContent('1 local job cancelled')
    expect(feedback).toHaveTextContent('1 active stop requested')
    expect(feedback).toHaveTextContent('2 native controls requested')
    expect(feedback).toHaveTextContent('1 native control confirmed')
    expect(feedback).toHaveTextContent('1 native control failed')
    expect(feedback).toHaveTextContent('1 ownership refused')
    expect(feedback).toHaveClass('bg-yellow-50')
    expect(feedback).not.toHaveClass('bg-emerald-50')
  })

  it('locks global and row mutations while a bulk cancellation is pending', async () => {
    const pendingBulk = deferred<{
      success: true
      affected: number
      unchanged: number
      localCancelled: number
      activeStopsRequested: number
      nativeControlsRequested: number
      nativeControlsConfirmed: number
      nativeControlsFailed: number
      ownershipRefused: number
      printerProfileId: null
    }>()
    setQueue(queueState([makeJob({
      id: 'bulk-locked-job',
      cancellable: true,
      retryable: true,
      reprintable: true,
      printerDisplayName: 'Bulk locked printer',
    })]))
    mocks.cancelAllJobs.mockReturnValue(pendingBulk.promise)
    render(<PrintQueuePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Pause and cancel POS jobs' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Pause and cancel' }))

    expect(screen.getByRole('button', { name: 'Pause POS print queue' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Pause and cancel POS jobs' })).toBeDisabled()
    const cancelJob = screen.getByRole('button', { name: 'Cancel POS print job' })
    const retryJob = screen.getByRole('button', { name: 'Retry POS print job' })
    const reprintJob = screen.getByRole('button', { name: 'Reprint POS print job' })
    expect(cancelJob).toBeDisabled()
    expect(retryJob).toBeDisabled()
    expect(reprintJob).toBeDisabled()

    fireEvent.click(cancelJob)
    fireEvent.click(retryJob)
    fireEvent.click(reprintJob)
    expect(mocks.cancelJob).not.toHaveBeenCalled()
    expect(mocks.retryJob).not.toHaveBeenCalled()
    expect(mocks.reprintJob).not.toHaveBeenCalled()

    await act(async () => {
      pendingBulk.resolve({
        success: true,
        affected: 1,
        unchanged: 0,
        localCancelled: 1,
        activeStopsRequested: 0,
        nativeControlsRequested: 0,
        nativeControlsConfirmed: 0,
        nativeControlsFailed: 0,
        ownershipRefused: 0,
        printerProfileId: null,
      })
      await pendingBulk.promise
    })

    expect(screen.getByRole('button', { name: 'Pause POS print queue' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel POS print job' })).toBeEnabled()
  })

  it('confirms Reprint, highlights a fresh returned job, and reports a duplicate as already queued', async () => {
    const source = makeJob({
      id: 'source-private-id',
      status: 'dispatched',
      reprintable: true,
      printerDisplayName: 'Receipt printer',
    })
    setQueue(queueState([source]))
    mocks.reprintJob
      .mockResolvedValueOnce({
        success: true,
        jobId: 'source-private-id',
        newJobId: 'new-private-id',
        affected: 1,
        unchanged: false,
        duplicate: false,
      })
      .mockResolvedValueOnce({
        success: true,
        jobId: 'source-private-id',
        newJobId: 'new-private-id',
        affected: 0,
        unchanged: true,
        duplicate: true,
      })

    const view = render(<PrintQueuePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Reprint POS print job' }))
    let dialog = screen.getByRole('dialog', {
      name: 'Reprint POS print job for Order Receipt on Receipt printer?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reprint' }))

    await waitFor(() => expect(mocks.reprintJob).toHaveBeenCalledWith('source-private-id'))
    expect(await screen.findByRole('status', { name: 'Print queue action result' }))
      .toHaveTextContent('New reprint queued')
    expect(screen.queryByText('new-private-id')).not.toBeInTheDocument()

    setQueue(queueState([
      source,
      makeJob({
        id: 'new-private-id',
        status: 'pending',
        printerDisplayName: 'Receipt printer',
      }),
    ]))
    view.rerender(<PrintQueuePanel />)
    expect(within(screen.getAllByRole('article')[1]).getByText('New reprint')).toBeVisible()

    fireEvent.click(screen.getByRole('button', {
      name: 'Reprint POS print job for Order Receipt on Receipt printer, item 1',
    }))
    dialog = screen.getByRole('dialog', {
      name: 'Reprint POS print job for Order Receipt on Receipt printer, item 1?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reprint' }))
    expect(await screen.findByRole('status', { name: 'Print queue action result' }))
      .toHaveTextContent('Reprint already queued')
  })

  it('retains the last authoritative panel snapshot during stale background and manual reads', () => {
    const retainedJob = makeJob({ printerDisplayName: 'Retained receipt printer' })
    setQueue(queueState([retainedJob]))
    const view = render(<PrintQueuePanel />)
    expect(screen.getByText('Retained receipt printer')).toBeVisible()

    mocks.current = {
      ...mocks.current,
      stale: true,
      error: null,
    }
    view.rerender(<PrintQueuePanel />)

    expect(screen.getByText('Retained receipt printer')).toBeVisible()
    const stale = screen.getByRole('status', { name: 'Print queue freshness' })
    expect(stale).toHaveAttribute('aria-live', 'polite')
    expect(stale).toHaveTextContent('Queue data may be out of date')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    mocks.current = {
      ...mocks.current,
      error: 'SQLite profile-private-1 stack trace',
    }
    view.rerender(<PrintQueuePanel />)

    expect(screen.getByText('Retained receipt printer')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not refresh the POS print queue. The last good data remains visible.',
    )
    expect(screen.queryByText(/SQLite profile-private-1 stack trace/)).not.toBeInTheDocument()
  })

  it('presents an initial stale load failure as unavailable, never as retained or empty', () => {
    setQueue({
      ...queueState([]),
      counts: { active: 0, failed: 0, stale: 0, history: 0 },
      pagination: { offset: 0, limit: 20, total: 0, hasMore: false },
      stale: true,
      error: 'SQLite private-profile-id initial load stack trace',
    })
    render(<PrintQueuePanel />)

    const stale = screen.getByRole('status', { name: 'Print queue freshness' })
    expect(stale).toHaveAttribute('aria-live', 'polite')
    expect(stale).toHaveTextContent('Queue status is unavailable. Refresh to try again.')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not load the POS print queue. Current queue status is unavailable.',
    )
    expect(screen.queryByText(/last good data remains visible/i)).not.toBeInTheDocument()
    expect(screen.queryByText('No POS print jobs are available.')).not.toBeInTheDocument()
    expect(screen.queryByText(/SQLite private-profile-id initial load stack trace/)).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'POS print queue counts' })).not.toBeInTheDocument()
    expect(screen.queryByText('0 active')).not.toBeInTheDocument()
    expect(screen.queryByText('0 failed')).not.toBeInTheDocument()
    expect(screen.queryByText('0 stale')).not.toBeInTheDocument()
    expect(screen.queryByText('0 history')).not.toBeInTheDocument()
    expect(screen.queryByText('Showing 0 of 0 POS jobs')).not.toBeInTheDocument()
  })

  it('shows loading instead of an empty result while the initial hook read is pending', () => {
    setQueue({
      ...queueState([]),
      counts: { active: 0, failed: 0, stale: 0, history: 0 },
      pagination: { offset: 0, limit: 20, total: 0, hasMore: false },
      loading: true,
    })
    const view = render(<PrintQueuePanel />)

    expect(screen.getByRole('status', { name: 'Loading POS print queue' })).toBeVisible()
    expect(screen.queryByText('No POS print jobs are available.')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'POS print queue counts' })).not.toBeInTheDocument()
    expect(screen.queryByText('Showing 0 of 0 POS jobs')).not.toBeInTheDocument()

    mocks.current = {
      ...mocks.current,
      loading: false,
    }
    view.rerender(<PrintQueuePanel />)
    expect(screen.queryByRole('status', { name: 'Loading POS print queue' })).not.toBeInTheDocument()
    expect(screen.getByText('No POS print jobs are available.')).toBeVisible()
    expect(screen.getByRole('status', { name: 'POS print queue counts' })).toHaveTextContent(
      '0 active',
    )
    expect(screen.getByText('Showing 0 of 0 POS jobs')).toBeVisible()
  })

  it('refetches offset zero at 20-row increments through 100 without appending shifted pages', () => {
    mocks.usePrintQueue.mockImplementation(({ limit, offset }: { limit: number; offset: number }) => {
      const jobs = Array.from({ length: limit }, (_, index) => makeJob({
        id: `private-job-${limit}-${index + 1}`,
        printerDisplayName: `Printer ${limit}-${index + 1}`,
      }))
      return {
        ...queueState(jobs),
        pagination: {
          offset,
          limit,
          total: 100,
          hasMore: limit < 100,
        },
      }
    })

    render(<PrintQueuePanel />)
    expect(screen.getAllByRole('article')).toHaveLength(20)
    expect(screen.getByText('Printer 20-1')).toBeVisible()

    for (const nextLimit of [40, 60, 80, 100]) {
      fireEvent.click(screen.getByRole('button', { name: 'Show more POS print jobs' }))
      expect(mocks.usePrintQueue).toHaveBeenLastCalledWith({ limit: nextLimit, offset: 0 })
      expect(screen.getAllByRole('article')).toHaveLength(nextLimit)
      expect(screen.getByText(`Printer ${nextLimit}-1`)).toBeVisible()
      expect(screen.queryByText(`Printer ${nextLimit - 20}-1`)).not.toBeInTheDocument()
    }

    expect(screen.queryByRole('button', { name: 'Show more POS print jobs' })).not.toBeInTheDocument()
  })

  it('prevents pagination changes while a mutation or queue load is pending', async () => {
    const pendingRetry = deferred<{
      success: true
      jobId: string
      newJobId: null
      affected: number
      unchanged: boolean
      duplicate: boolean
    }>()
    let loading = false
    mocks.usePrintQueue.mockImplementation(({ limit, offset }: { limit: number; offset: number }) => ({
      ...queueState(Array.from({ length: limit }, (_, index) => makeJob({
        id: `pagination-private-job-${index + 1}`,
        printerDisplayName: `Pagination printer ${index + 1}`,
        retryable: index === 0,
      }))),
      loading,
      pagination: { offset, limit, total: 100, hasMore: limit < 100 },
    }))
    mocks.retryJob.mockReturnValue(pendingRetry.promise)
    const view = render(<PrintQueuePanel />)

    fireEvent.click(screen.getByRole('button', {
      name: 'Retry POS print job for Order Receipt on Pagination printer 1',
    }))
    let showMore = screen.getByRole('button', { name: 'Show more POS print jobs' })
    expect(showMore).toBeDisabled()
    fireEvent.click(showMore)
    expect(mocks.usePrintQueue).not.toHaveBeenCalledWith({ limit: 40, offset: 0 })

    await act(async () => {
      pendingRetry.resolve({
        success: true,
        jobId: 'pagination-private-job-1',
        newJobId: null,
        affected: 1,
        unchanged: false,
        duplicate: false,
      })
      await pendingRetry.promise
    })
    showMore = screen.getByRole('button', { name: 'Show more POS print jobs' })
    expect(showMore).toBeEnabled()

    loading = true
    view.rerender(<PrintQueuePanel />)
    showMore = screen.getByRole('button', { name: 'Show more POS print jobs' })
    expect(showMore).toBeDisabled()
    fireEvent.click(showMore)
    expect(mocks.usePrintQueue).not.toHaveBeenCalledWith({ limit: 40, offset: 0 })

    loading = false
    view.rerender(<PrintQueuePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Show more POS print jobs' }))
    expect(mocks.usePrintQueue).toHaveBeenLastCalledWith({ limit: 40, offset: 0 })
  })

  it('retains the last authoritative offset-zero snapshot when Show More loads then fails', () => {
    const authoritativeJobs = Array.from({ length: 20 }, (_, index) => makeJob({
      id: `authoritative-private-job-${index + 1}`,
      printerDisplayName: `Authoritative printer ${index + 1}`,
    }))
    const authoritativeState = {
      ...queueState(authoritativeJobs),
      counts: { active: 7, failed: 3, stale: 2, history: 11 },
      pagination: { offset: 0, limit: 20, total: 47, hasMore: true },
    }
    let expandedPhase: 'loading' | 'failed' = 'loading'

    mocks.usePrintQueue.mockImplementation(({ limit, offset }: { limit: number; offset: number }) => {
      if (limit === 20) return authoritativeState
      const unavailableExpandedState = {
        ...queueState([]),
        counts: { active: 0, failed: 0, stale: 0, history: 0 },
        pagination: { offset, limit, total: 0, hasMore: false },
      }
      return expandedPhase === 'loading'
        ? { ...unavailableExpandedState, loading: true }
        : {
            ...unavailableExpandedState,
            stale: true,
            error: 'Expanded queue read failed with private diagnostics',
          }
    })

    const view = render(<PrintQueuePanel />)
    expect(screen.getAllByRole('article')).toHaveLength(20)
    expect(screen.getByText('Showing 20 of 47 POS jobs')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Show more POS print jobs' }))
    expect(mocks.usePrintQueue).toHaveBeenLastCalledWith({ limit: 40, offset: 0 })
    expect(screen.getAllByRole('article')).toHaveLength(20)
    expect(screen.getByText('Authoritative printer 1')).toBeVisible()
    expect(screen.getByRole('status', { name: 'POS print queue counts' })).toHaveTextContent(
      '7 active',
    )
    expect(screen.getByText('Showing 20 of 47 POS jobs')).toBeVisible()

    expandedPhase = 'failed'
    view.rerender(<PrintQueuePanel />)

    expect(screen.getAllByRole('article')).toHaveLength(20)
    expect(screen.getByText('Authoritative printer 20')).toBeVisible()
    expect(screen.getByRole('status', { name: 'Print queue freshness' })).toHaveTextContent(
      'The last good data remains visible.',
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not refresh the POS print queue. The last good data remains visible.',
    )
    expect(screen.getByRole('status', { name: 'POS print queue counts' })).toHaveTextContent(
      '3 failed',
    )
    expect(screen.getByText('Showing 20 of 47 POS jobs')).toBeVisible()

    const showMore = screen.getByRole('button', { name: 'Show more POS print jobs' })
    expect(showMore).toBeDisabled()
    fireEvent.click(showMore)
    expect(mocks.usePrintQueue.mock.calls.some(([options]) => options.limit === 60)).toBe(false)
  })

  it('shows independent global counts and expands then collapses bounded issue details', () => {
    const issue = 'The network printer refused the connection after the bounded transport timeout.'
    setQueue({
      ...queueState([makeJob({
        status: 'failed',
        retryable: true,
        warningMessage: 'Printer needs attention',
        lastError: issue,
        printerDisplayName: 'Kitchen issue printer',
      })]),
      counts: { active: 7, failed: 3, stale: 2, history: 11 },
    })
    render(<PrintQueuePanel />)

    const counts = screen.getByRole('status', { name: 'POS print queue counts' })
    expect(counts).toHaveTextContent('7 active')
    expect(counts).toHaveTextContent('3 failed')
    expect(counts).toHaveTextContent('2 stale')
    expect(counts).toHaveTextContent('11 history')

    expect(screen.getByText('Printer needs attention')).toBeVisible()
    expect(screen.queryByText(issue)).not.toBeInTheDocument()
    let toggle = screen.getByRole('button', { name: 'Show issue details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const detailsId = toggle.getAttribute('aria-controls')
    expect(detailsId).toBeTruthy()
    fireEvent.click(toggle)
    const details = screen.getByText(issue)
    expect(details).toHaveAttribute('id', detailsId)
    toggle = screen.getByRole('button', { name: 'Hide issue details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(screen.queryByText(issue)).not.toBeInTheDocument()
  })

  it('uses generic issue semantics even when the legacy locale key is printer-setup-specific', () => {
    mocks.translations['settings.printQueue.issue.needsAttention'] = 'Choose a printer, then retry.'
    setQueue(queueState([makeJob({
      status: 'failed',
      lastError: 'Bounded transport failure',
      warningMessage: null,
      printerDisplayName: 'Generic issue printer',
    })]))
    render(<PrintQueuePanel />)

    expect(screen.getByText('This POS print job needs attention.')).toBeVisible()
    expect(screen.queryByText('Choose a printer, then retry.')).not.toBeInTheDocument()
  })

  it('gives repeated row and issue controls distinct safe accessible context', () => {
    const jobs = [
      makeJob({
        id: '51fd2784-8550-48ee-93fc-e4621bd4b9c0',
        entityType: 'order_receipt',
        printerDisplayName: 'Front counter printer',
        resolvedTarget: 'private-target-one',
        status: 'failed',
        cancellable: true,
        retryable: true,
        reprintable: true,
        warningMessage: 'First printer needs attention',
        lastError: 'First bounded issue',
      }),
      makeJob({
        id: 'technical_job_identifier_0123456789abcdef',
        entityType: 'kitchen_ticket',
        printerDisplayName: 'Kitchen pass printer',
        resolvedTarget: 'private-target-two',
        status: 'failed',
        cancellable: true,
        retryable: true,
        reprintable: true,
        warningMessage: 'Second printer needs attention',
        lastError: 'Second bounded issue',
      }),
    ]
    setQueue(queueState(jobs))
    render(<PrintQueuePanel />)

    const expectedContexts = ['Order Receipt on Front counter printer', 'Kitchen Ticket on Kitchen pass printer']
    const buttons: HTMLElement[] = []
    for (const [index, row] of screen.getAllByRole('article').entries()) {
      const context = expectedContexts[index]
      buttons.push(
        within(row).getByRole('button', { name: `Cancel POS print job for ${context}` }),
        within(row).getByRole('button', { name: `Retry POS print job for ${context}` }),
        within(row).getByRole('button', { name: `Reprint POS print job for ${context}` }),
        within(row).getByRole('button', { name: `Show issue details for ${context}` }),
      )
    }

    const accessibleNames = buttons.map((button) => button.getAttribute('aria-label'))
    expect(accessibleNames.every(Boolean)).toBe(true)
    expect(new Set(accessibleNames).size).toBe(buttons.length)
    expect(accessibleNames.join(' ')).not.toContain(jobs[0].id)
    expect(accessibleNames.join(' ')).not.toContain(jobs[1].id)
    expect(accessibleNames.join(' ')).not.toContain('private-target-one')
    expect(accessibleNames.join(' ')).not.toContain('private-target-two')
  })

  it('adds safe rendered ordinals when rows share the same entity and printer context', () => {
    const jobs = [
      makeJob({
        id: '8bb2f66d-f412-43c2-8972-2e68dc24d840',
        printerProfileId: 'shared-paused-profile',
        printerDisplayName: 'Shared receipt printer',
        resolvedTarget: 'private-target-one',
        cancellable: true,
        retryable: true,
        reprintable: true,
        warningMessage: 'First shared printer issue',
        lastError: 'First bounded shared issue',
      }),
      makeJob({
        id: 'cd3b6a31-b4dc-4b46-8957-1ec0b842813c',
        printerProfileId: 'shared-paused-profile',
        printerDisplayName: 'Shared receipt printer',
        resolvedTarget: 'private-target-two',
        cancellable: true,
        retryable: true,
        reprintable: true,
        warningMessage: 'Second shared printer issue',
        lastError: 'Second bounded shared issue',
      }),
    ]
    setQueue({
      ...queueState(jobs),
      pausedPrinterProfileIds: ['shared-paused-profile'],
    })
    const view = render(<PrintQueuePanel />)

    const firstContext = 'Order Receipt on Shared receipt printer, item 1'
    const secondContext = 'Order Receipt on Shared receipt printer, item 2'
    const firstArticle = screen.getByRole('article', { name: `POS print job: ${firstContext}` })
    const secondArticle = screen.getByRole('article', { name: `POS print job: ${secondContext}` })

    for (const [article, context] of [
      [firstArticle, firstContext],
      [secondArticle, secondContext],
    ] as const) {
      expect(within(article).getByRole('button', {
        name: `Cancel POS print job for ${context}`,
      })).toBeVisible()
      expect(within(article).getByRole('button', {
        name: `Retry POS print job for ${context}`,
      })).toBeVisible()
      expect(within(article).getByRole('button', {
        name: `Reprint POS print job for ${context}`,
      })).toBeVisible()
      expect(within(article).getByRole('button', {
        name: `Show issue details for ${context}`,
      })).toBeVisible()
      expect(within(article).getByRole('button', {
        name: `Resume printer for ${context}`,
      })).toBeVisible()
    }

    fireEvent.click(within(secondArticle).getByRole('button', {
      name: `Reprint POS print job for ${secondContext}`,
    }))
    expect(screen.getByRole('dialog', {
      name: `Reprint POS print job for ${secondContext}?`,
    })).toBeVisible()

    const accessibleNames = [
      ...screen.getAllByRole('article').map((article) => article.getAttribute('aria-label')),
      ...screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')).filter(Boolean),
      screen.getByRole('dialog').getAttribute('aria-label'),
    ].join(' ')
    expect(accessibleNames).not.toContain('private-target-one')
    expect(accessibleNames).not.toContain('private-target-two')
    for (const job of jobs) expect(view.container.innerHTML).not.toContain(job.id)
  })

  it('uses stable unique issue-detail IDs without exposing raw job identifiers', () => {
    const privateJobIds = [
      '2f7147fa-6108-4cd3-8dd0-f42f578ea779',
      'technical_job_identifier_0123456789abcdef',
    ]
    setQueue(queueState(privateJobIds.map((id, index) => makeJob({
      id,
      status: 'failed',
      warningMessage: `Printer ${index + 1} needs attention`,
      lastError: `Bounded operator issue ${index + 1}`,
      printerDisplayName: `Issue printer ${index + 1}`,
    }))))
    const view = render(<PrintQueuePanel />)

    let toggles = screen.getAllByRole('button', { name: /^Show issue details/ })
    const initialControlIds = toggles.map((toggle) => toggle.getAttribute('aria-controls'))
    expect(initialControlIds.every(Boolean)).toBe(true)
    expect(new Set(initialControlIds).size).toBe(privateJobIds.length)
    for (const privateJobId of privateJobIds) {
      expect(initialControlIds.join(' ')).not.toContain(privateJobId)
      expect(view.container.innerHTML).not.toContain(privateJobId)
    }

    toggles.forEach((toggle) => fireEvent.click(toggle))
    initialControlIds.forEach((detailsId) => {
      expect(document.getElementById(detailsId as string)).toHaveAttribute('id', detailsId)
    })

    view.rerender(<PrintQueuePanel />)
    toggles = screen.getAllByRole('button', { name: /^Hide issue details/ })
    expect(toggles.map((toggle) => toggle.getAttribute('aria-controls'))).toEqual(initialControlIds)
  })

  it('offers indexed Resume controls for unseen paused profiles without exposing or inventing names', async () => {
    const unseenProfileIds = [
      '1ca27f14-67d6-4667-a733-90faf4e24ae3',
      'private_profile_identifier_0123456789abcdef',
    ]
    setQueue({
      ...queueState([makeJob({ printerProfileId: null, printerDisplayName: 'Default receipt printer' })]),
      queuePaused: true,
      pausedPrinterProfileIds: unseenProfileIds,
    })
    mocks.resumeQueue.mockResolvedValue({
      success: true,
      queuePaused: true,
      pausedPrinterProfileIds: [unseenProfileIds[1]],
      printerProfileId: unseenProfileIds[0],
      activeStopsRequested: 0,
      nativeControlsRequested: 0,
      nativeControlsConfirmed: 0,
      nativeControlsFailed: 0,
      ownershipRefused: 0,
    })
    const view = render(<PrintQueuePanel />)

    expect(screen.getByText('2 printers are paused')).toBeVisible()
    const resumeButtons = [
      screen.getByRole('button', { name: 'Resume paused printer 1' }),
      screen.getByRole('button', { name: 'Resume paused printer 2' }),
    ]
    const initialButtonIds = resumeButtons.map((button) => button.id)
    expect(initialButtonIds.every(Boolean)).toBe(true)
    expect(new Set(initialButtonIds).size).toBe(unseenProfileIds.length)
    for (const profileId of unseenProfileIds) {
      expect(initialButtonIds.join(' ')).not.toContain(profileId)
      expect(view.container.innerHTML).not.toContain(profileId)
    }

    fireEvent.click(resumeButtons[0])
    await waitFor(() => expect(mocks.resumeQueue).toHaveBeenCalledWith({
      printerProfileId: unseenProfileIds[0],
    }))
    const feedback = await screen.findByRole('status', { name: 'Print queue action result' })
    expect(feedback).toHaveTextContent(
      'Printer pause removed for paused printer 1. POS print queue remains paused.',
    )
    expect(feedback).toHaveClass('bg-yellow-50')
    expect(feedback).not.toHaveClass('bg-emerald-50')
    expect(view.container.innerHTML).not.toContain(unseenProfileIds[0])

    view.rerender(<PrintQueuePanel />)
    expect([
      screen.getByRole('button', { name: 'Resume paused printer 1' }).id,
      screen.getByRole('button', { name: 'Resume paused printer 2' }).id,
    ]).toEqual(initialButtonIds)
  })

  it('keeps unseen paused-printer indexes stable by canonical profile order without rendering IDs', async () => {
    const canonicalProfileIds = [
      'aaaaaaaa-1111-4111-8111-111111111111',
      'zzzzzzzz_private_profile_identifier_0123456789',
    ]
    setQueue({
      ...queueState([]),
      queuePaused: true,
      pausedPrinterProfileIds: [...canonicalProfileIds].reverse(),
    })
    mocks.resumeQueue.mockResolvedValue({
      success: true,
      queuePaused: true,
      pausedPrinterProfileIds: canonicalProfileIds,
      printerProfileId: canonicalProfileIds[0],
      activeStopsRequested: 0,
      nativeControlsRequested: 0,
      nativeControlsConfirmed: 0,
      nativeControlsFailed: 0,
      ownershipRefused: 0,
    })
    const view = render(<PrintQueuePanel />)

    const first = screen.getByRole('button', { name: 'Resume paused printer 1' })
    const initialButtonIds = screen.getAllByRole('button', { name: /^Resume paused printer/ })
      .map((button) => button.id)
    fireEvent.click(first)
    await waitFor(() => expect(mocks.resumeQueue).toHaveBeenCalledWith({
      printerProfileId: canonicalProfileIds[0],
    }))

    mocks.current = {
      ...mocks.current,
      pausedPrinterProfileIds: canonicalProfileIds,
    }
    view.rerender(<PrintQueuePanel />)
    expect(screen.getAllByRole('button', { name: /^Resume paused printer/ })
      .map((button) => button.id)).toEqual(initialButtonIds)
    for (const profileId of canonicalProfileIds) {
      expect(view.container.innerHTML).not.toContain(profileId)
    }
  })

  it('shows last update without inventing a last-seen time when native evidence is absent', () => {
    setQueue(queueState([makeJob({
      updatedAt: '2026-08-12T08:00:02Z',
      lastSeenAt: null,
      printerDisplayName: 'Timestamp printer',
    })]))
    render(<PrintQueuePanel />)

    const row = screen.getByRole('article')
    expect(within(row).getByText(/^Updated /)).toBeVisible()
    expect(within(row).queryByText(/^Last seen /)).not.toBeInTheDocument()
  })

  it('dismisses destructive confirmations without issuing a mutation', () => {
    render(<PrintQueuePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause and cancel POS jobs' }))
    let dialog = screen.getByRole('dialog', { name: 'Pause and cancel POS jobs?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep printing' }))
    expect(mocks.cancelAllJobs).not.toHaveBeenCalled()

    setQueue(queueState([makeJob({ status: 'dispatched', reprintable: true })]))
    cleanup()
    render(<PrintQueuePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Reprint POS print job' }))
    dialog = screen.getByRole('dialog', {
      name: 'Reprint POS print job for Order Receipt on Front counter MCP31?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep original' }))
    expect(mocks.reprintJob).not.toHaveBeenCalled()
  })

  it('locks every action for one job while its retry mutation is still pending', async () => {
    const pendingRetry = deferred<{
      success: true
      jobId: string
      newJobId: null
      affected: number
      unchanged: boolean
      duplicate: boolean
    }>()
    setQueue(queueState([makeJob({
      id: 'shared-action-job',
      status: 'failed',
      retryable: true,
      reprintable: true,
      printerDisplayName: 'Recovery printer',
    })]))
    mocks.retryJob.mockReturnValue(pendingRetry.promise)
    render(<PrintQueuePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry POS print job' }))
    expect(screen.getByRole('button', { name: 'Retry POS print job' })).toBeDisabled()
    const reprint = screen.getByRole('button', { name: 'Reprint POS print job' })
    expect(reprint).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Pause and cancel POS jobs' })).toBeDisabled()
    fireEvent.click(reprint)
    expect(mocks.reprintJob).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Reprint POS print job?' })).not.toBeInTheDocument()

    await act(async () => {
      pendingRetry.resolve({
        success: true,
        jobId: 'shared-action-job',
        newJobId: null,
        affected: 1,
        unchanged: false,
        duplicate: false,
      })
      await pendingRetry.promise
    })
    expect(screen.getByRole('button', { name: 'Reprint POS print job' })).toBeEnabled()
  })

  it('serializes mutations across different rows so shared feedback cannot be overwritten', async () => {
    const pendingRetry = deferred<{
      success: true
      jobId: string
      newJobId: null
      affected: number
      unchanged: boolean
      duplicate: boolean
    }>()
    setQueue(queueState([
      makeJob({
        id: 'first-private-job',
        status: 'failed',
        retryable: true,
        printerDisplayName: 'First recovery printer',
      }),
      makeJob({
        id: 'second-private-job',
        status: 'dispatched',
        cancellable: true,
        reprintable: true,
        printerDisplayName: 'Second recovery printer',
      }),
    ]))
    mocks.retryJob.mockReturnValue(pendingRetry.promise)
    render(<PrintQueuePanel />)

    const rows = screen.getAllByRole('article')
    fireEvent.click(within(rows[0]).getByRole('button', { name: /^Retry POS print job/ }))
    const secondCancel = within(rows[1]).getByRole('button', { name: /^Cancel POS print job/ })
    const secondReprint = within(rows[1]).getByRole('button', { name: /^Reprint POS print job/ })
    expect(secondCancel).toBeDisabled()
    expect(secondReprint).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Pause POS print queue' })).toBeDisabled()

    fireEvent.click(secondCancel)
    fireEvent.click(secondReprint)
    expect(mocks.cancelJob).not.toHaveBeenCalled()
    expect(mocks.reprintJob).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Reprint POS print job?' })).not.toBeInTheDocument()

    await act(async () => {
      pendingRetry.resolve({
        success: true,
        jobId: 'first-private-job',
        newJobId: null,
        affected: 1,
        unchanged: false,
        duplicate: false,
      })
      await pendingRetry.promise
    })

    expect(within(rows[1]).getByRole('button', { name: /^Cancel POS print job/ })).toBeEnabled()
    expect(within(rows[1]).getByRole('button', { name: /^Reprint POS print job/ })).toBeEnabled()
  })

  it('locks row mutations while a global queue mutation is pending', async () => {
    const pendingPause = deferred<{
      success: true
      queuePaused: true
      pausedPrinterProfileIds: string[]
      printerProfileId: null
      activeStopsRequested: number
      nativeControlsRequested: number
      nativeControlsConfirmed: number
      nativeControlsFailed: number
      ownershipRefused: number
    }>()
    setQueue(queueState([makeJob({
      id: 'global-lock-private-job',
      cancellable: true,
      retryable: true,
      reprintable: true,
      printerDisplayName: 'Global lock printer',
    })]))
    mocks.pauseQueue.mockReturnValue(pendingPause.promise)
    render(<PrintQueuePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Pause POS print queue' }))
    const cancel = screen.getByRole('button', { name: 'Cancel POS print job' })
    const retry = screen.getByRole('button', { name: 'Retry POS print job' })
    const reprint = screen.getByRole('button', { name: 'Reprint POS print job' })
    expect(cancel).toBeDisabled()
    expect(retry).toBeDisabled()
    expect(reprint).toBeDisabled()

    fireEvent.click(cancel)
    fireEvent.click(retry)
    fireEvent.click(reprint)
    expect(mocks.cancelJob).not.toHaveBeenCalled()
    expect(mocks.retryJob).not.toHaveBeenCalled()
    expect(mocks.reprintJob).not.toHaveBeenCalled()

    await act(async () => {
      pendingPause.resolve({
        success: true,
        queuePaused: true,
        pausedPrinterProfileIds: [],
        printerProfileId: null,
        activeStopsRequested: 0,
        nativeControlsRequested: 0,
        nativeControlsConfirmed: 0,
        nativeControlsFailed: 0,
        ownershipRefused: 0,
      })
      await pendingPause.promise
    })
    expect(screen.getByRole('button', { name: 'Cancel POS print job' })).toBeEnabled()
  })

  it('locks the other actions for a job while its per-printer resume is pending', async () => {
    const pendingResume = deferred<{
      success: true
      queuePaused: false
      pausedPrinterProfileIds: string[]
      printerProfileId: string
      activeStopsRequested: number
      nativeControlsRequested: number
      nativeControlsConfirmed: number
      nativeControlsFailed: number
      ownershipRefused: number
    }>()
    setQueue({
      ...queueState([makeJob({
        id: 'resume-action-job',
        printerProfileId: 'resume-profile',
        printerDisplayName: 'Resume lock printer',
        cancellable: true,
        retryable: true,
        reprintable: true,
      })]),
      pausedPrinterProfileIds: ['resume-profile'],
    })
    mocks.resumeQueue.mockReturnValue(pendingResume.promise)
    render(<PrintQueuePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Resume Resume lock printer' }))
    const cancel = screen.getByRole('button', { name: 'Cancel POS print job' })
    const retry = screen.getByRole('button', { name: 'Retry POS print job' })
    const reprint = screen.getByRole('button', { name: 'Reprint POS print job' })
    expect(cancel).toBeDisabled()
    expect(retry).toBeDisabled()
    expect(reprint).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Pause and cancel POS jobs' })).toBeDisabled()

    fireEvent.click(cancel)
    fireEvent.click(retry)
    fireEvent.click(reprint)
    expect(mocks.cancelJob).not.toHaveBeenCalled()
    expect(mocks.retryJob).not.toHaveBeenCalled()
    expect(mocks.reprintJob).not.toHaveBeenCalled()

    await act(async () => {
      pendingResume.resolve({
        success: true,
        queuePaused: false,
        pausedPrinterProfileIds: [],
        printerProfileId: 'resume-profile',
        activeStopsRequested: 0,
        nativeControlsRequested: 0,
        nativeControlsConfirmed: 0,
        nativeControlsFailed: 0,
        ownershipRefused: 0,
      })
      await pendingResume.promise
    })

    expect(screen.getByRole('button', { name: 'Cancel POS print job' })).toBeEnabled()
  })

  it('derives global and per-printer pause feedback from the returned queue state', async () => {
    setQueue({
      ...queueState([makeJob({
        id: 'paused-row',
        printerProfileId: 'profile-visible',
        printerDisplayName: 'Paused printer',
      })]),
      pausedPrinterProfileIds: ['profile-visible'],
    })
    mocks.pauseQueue.mockResolvedValue({
      success: true,
      queuePaused: false,
      pausedPrinterProfileIds: ['profile-visible'],
      printerProfileId: null,
      activeStopsRequested: 0,
      nativeControlsRequested: 0,
      nativeControlsConfirmed: 0,
      nativeControlsFailed: 0,
      ownershipRefused: 0,
    })
    mocks.resumeQueue.mockResolvedValue({
      success: true,
      queuePaused: false,
      pausedPrinterProfileIds: ['profile-visible'],
      printerProfileId: 'profile-visible',
      activeStopsRequested: 0,
      nativeControlsRequested: 0,
      nativeControlsConfirmed: 0,
      nativeControlsFailed: 0,
      ownershipRefused: 0,
    })
    render(<PrintQueuePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Pause POS print queue' }))
    let feedback = await screen.findByRole('status', { name: 'Print queue action result' })
    expect(feedback).toHaveTextContent('POS print queue remains active')
    expect(feedback).not.toHaveTextContent('POS print queue paused')
    expect(feedback).toHaveClass('bg-yellow-50')

    fireEvent.click(screen.getByRole('button', { name: 'Resume Paused printer' }))
    feedback = await screen.findByRole('status', { name: 'Print queue action result' })
    expect(feedback).toHaveTextContent('Paused printer remains paused')
    expect(feedback).not.toHaveTextContent('Paused printer resumed')
    expect(feedback).toHaveClass('bg-yellow-50')
  })

  it('warns when a printer pause is removed but the returned global queue stays paused', async () => {
    setQueue({
      ...queueState([makeJob({
        id: 'globally-paused-row',
        printerProfileId: 'profile-visible',
        printerDisplayName: 'Kitchen printer',
      })]),
      queuePaused: true,
      pausedPrinterProfileIds: ['profile-visible'],
    })
    mocks.resumeQueue.mockResolvedValue({
      success: true,
      queuePaused: true,
      pausedPrinterProfileIds: [],
      printerProfileId: 'profile-visible',
      activeStopsRequested: 0,
      nativeControlsRequested: 0,
      nativeControlsConfirmed: 0,
      nativeControlsFailed: 0,
      ownershipRefused: 0,
    })
    render(<PrintQueuePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Resume Kitchen printer' }))
    const feedback = await screen.findByRole('status', { name: 'Print queue action result' })
    expect(feedback).toHaveTextContent(
      'Printer pause removed for Kitchen printer. POS print queue remains paused.',
    )
    expect(feedback).not.toHaveTextContent('Kitchen printer resumed')
    expect(feedback).toHaveClass('bg-yellow-50')
    expect(feedback).not.toHaveClass('bg-emerald-50')
  })

  it('warns after a global Resume when returned printer-specific pauses remain', async () => {
    const remainingProfileIds = [
      '72c44f7d-9d06-4bd3-b7d1-b22be563dc81',
      'private_profile_identifier_abcdef0123456789',
    ]
    setQueue({
      ...queueState([]),
      queuePaused: true,
      pausedPrinterProfileIds: remainingProfileIds,
    })
    mocks.resumeQueue.mockResolvedValue({
      success: true,
      queuePaused: false,
      pausedPrinterProfileIds: remainingProfileIds,
      printerProfileId: null,
      activeStopsRequested: 0,
      nativeControlsRequested: 0,
      nativeControlsConfirmed: 0,
      nativeControlsFailed: 0,
      ownershipRefused: 0,
    })
    const view = render(<PrintQueuePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Resume POS print queue' }))
    const feedback = await screen.findByRole('status', { name: 'Print queue action result' })
    expect(feedback).toHaveTextContent('POS print queue resumed. 2 printer pauses remain.')
    expect(feedback).toHaveClass('bg-yellow-50')
    expect(feedback).not.toHaveClass('bg-emerald-50')
    for (const profileId of remainingProfileIds) {
      expect(view.container.innerHTML).not.toContain(profileId)
    }
  })

  it('gives each article and reprint confirmation safe contextual identity without job IDs', () => {
    const jobs = [
      makeJob({
        id: 'd925f518-b6fa-4c03-9ce4-3ce69af9431c',
        entityType: 'order_receipt',
        printerDisplayName: 'Front counter printer',
        resolvedTarget: null,
        reprintable: true,
      }),
      makeJob({
        id: 'technical_job_identifier_abcdef0123456789',
        entityType: 'kitchen_ticket',
        printerDisplayName: 'Kitchen pass printer',
        resolvedTarget: null,
        reprintable: true,
      }),
    ]
    setQueue(queueState(jobs))
    const view = render(<PrintQueuePanel />)

    expect(screen.getByRole('article', {
      name: 'POS print job: Order Receipt on Front counter printer',
    })).toBeVisible()
    const kitchenArticle = screen.getByRole('article', {
      name: 'POS print job: Kitchen Ticket on Kitchen pass printer',
    })
    fireEvent.click(within(kitchenArticle).getByRole('button', {
      name: 'Reprint POS print job for Kitchen Ticket on Kitchen pass printer',
    }))
    expect(screen.getByRole('dialog', {
      name: 'Reprint POS print job for Kitchen Ticket on Kitchen pass printer?',
    })).toBeVisible()
    for (const job of jobs) {
      expect(view.container.innerHTML).not.toContain(job.id)
    }
  })

  it('never presents success for a rejected mutation and reports affected zero as no change', async () => {
    const cancellable = makeJob({ id: 'cancel-private', cancellable: true })
    setQueue(queueState([cancellable]))
    mocks.cancelJob
      .mockResolvedValueOnce({
        success: false,
        affected: 0,
        unchanged: 1,
        localCancelled: 0,
        activeStopsRequested: 0,
        nativeControlsRequested: 0,
        nativeControlsConfirmed: 0,
        nativeControlsFailed: 0,
        ownershipRefused: 0,
        error: 'native stack and private identifiers',
      })
      .mockResolvedValueOnce({
        success: true,
        affected: 0,
        unchanged: 1,
        localCancelled: 0,
        activeStopsRequested: 1,
        nativeControlsRequested: 0,
        nativeControlsConfirmed: 0,
        nativeControlsFailed: 0,
        ownershipRefused: 0,
      })

    render(<PrintQueuePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel POS print job' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not cancel the POS print job')
    expect(screen.queryByText(/native stack and private identifiers/)).not.toBeInTheDocument()
    expect(screen.queryByText(/cancelled successfully/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel POS print job' }))
    const noChange = await screen.findByRole('status', { name: 'Print queue action result' })
    expect(noChange).toHaveTextContent('No change')
    expect(noChange).toHaveTextContent('1 active stop requested')
  })

  it('keeps rejected backend errors private while showing safe native evidence, including thrown failures', async () => {
    setQueue(queueState([makeJob({ id: 'failure-private', cancellable: true })]))
    mocks.cancelJob
      .mockResolvedValueOnce({
        success: false,
        affected: 0,
        unchanged: 1,
        localCancelled: 0,
        activeStopsRequested: 2,
        nativeControlsRequested: 3,
        nativeControlsConfirmed: 1,
        nativeControlsFailed: 1,
        ownershipRefused: 1,
        error: 'TheSmallPOS/private-job/private-attempt sensitive stack',
      })
      .mockRejectedValueOnce(new Error('TheSmallPOS/secret native failure'))
    render(<PrintQueuePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel POS print job' }))
    let failure = await screen.findByRole('alert')
    expect(failure).toHaveTextContent('Could not cancel the POS print job')
    expect(failure).toHaveTextContent('2 active stops requested')
    expect(failure).toHaveTextContent('3 native controls requested')
    expect(failure).toHaveTextContent('1 native control confirmed')
    expect(failure).toHaveTextContent('1 native control failed')
    expect(failure).toHaveTextContent('1 ownership refused')
    expect(failure).not.toHaveTextContent(/private|sensitive|stack|secret/i)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel POS print job' }))
    failure = await screen.findByRole('alert')
    expect(failure).toHaveTextContent('Could not cancel the POS print job')
    expect(failure).not.toHaveTextContent(/native failure|secret/i)
  })

  it('passes only job IDs, profile IDs, or allowlisted status filters to mutation methods', async () => {
    setQueue({
      ...queueState([
        makeJob({ id: 'cancel-private', cancellable: true, printerDisplayName: 'Cancel printer' }),
        makeJob({ id: 'retry-private', status: 'failed', retryable: true, printerDisplayName: 'Retry printer' }),
        makeJob({
          id: 'resume-private',
          printerProfileId: 'profile-visible',
          printerDisplayName: 'Paused printer',
        }),
      ]),
      pausedPrinterProfileIds: ['profile-visible'],
    })
    mocks.cancelJob.mockResolvedValue({ success: true, affected: 1, unchanged: 0 })
    mocks.retryJob.mockResolvedValue({
      success: true,
      jobId: 'retry-private',
      newJobId: null,
      affected: 1,
      unchanged: false,
      duplicate: false,
    })
    mocks.resumeQueue.mockResolvedValue({
      success: true,
      queuePaused: false,
      pausedPrinterProfileIds: [],
      printerProfileId: 'profile-visible',
      activeStopsRequested: 0,
      nativeControlsRequested: 0,
      nativeControlsConfirmed: 0,
      nativeControlsFailed: 0,
      ownershipRefused: 0,
    })
    mocks.pauseQueue.mockResolvedValue({
      success: true,
      queuePaused: true,
      pausedPrinterProfileIds: [],
      printerProfileId: null,
      activeStopsRequested: 0,
      nativeControlsRequested: 0,
      nativeControlsConfirmed: 0,
      nativeControlsFailed: 0,
      ownershipRefused: 0,
    })

    render(<PrintQueuePanel />)
    const cancel = screen.getByRole('button', { name: /^Cancel POS print job/ })
    const retry = screen.getByRole('button', { name: /^Retry POS print job/ })
    const resume = screen.getByRole('button', { name: 'Resume Paused printer' })
    fireEvent.click(cancel)
    await waitFor(() => expect(mocks.cancelJob).toHaveBeenCalledWith('cancel-private'))
    await waitFor(() => expect(retry).toBeEnabled())

    fireEvent.click(retry)
    await waitFor(() => expect(mocks.retryJob).toHaveBeenCalledWith('retry-private'))
    await waitFor(() => expect(resume).toBeEnabled())

    fireEvent.click(resume)
    await waitFor(() => expect(mocks.resumeQueue).toHaveBeenCalledWith({
      printerProfileId: 'profile-visible',
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Pause POS print queue' }))
    await waitFor(() => expect(mocks.pauseQueue).toHaveBeenCalledWith())
    const serializedArgs = JSON.stringify([
      mocks.cancelJob.mock.calls,
      mocks.retryJob.mock.calls,
      mocks.resumeQueue.mock.calls,
      mocks.pauseQueue.mock.calls,
    ])
    expect(serializedArgs).not.toMatch(/spool|ownership|target|queueName|attempt/i)
  })
})
