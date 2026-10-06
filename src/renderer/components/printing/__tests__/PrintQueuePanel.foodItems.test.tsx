import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Symptom (desktop 1.4.123): a food print waiting for its efood items showed the
// native English text raw in every language, and the Print button said
// "printed" while the job was only queued. The panel now translates the stable
// native reason codes, and the order screens read the job's real outcome.

const mocks = vi.hoisted(() => ({
  usePrintQueue: vi.fn(),
  translations: {} as Record<string, string>,
  current: {} as Record<string, unknown>,
}))

vi.mock('../../../hooks/usePrintQueue', () => ({
  usePrintQueue: mocks.usePrintQueue,
}))

vi.mock('../../../../lib', () => ({
  getBridge: () => ({ printer: { listJobs: vi.fn() } }),
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
  toast: { success: vi.fn(), error: vi.fn() },
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

import PrintQueuePanel, {
  FOOD_ORDER_ITEMS_PENDING,
  FOOD_ORDER_ITEMS_UNAVAILABLE,
  classifyQueuedPrintJob,
  observeQueuedPrintJob,
  printQueueReasonText,
} from '../PrintQueuePanel'
import type { PrintQueueJob, PrintQueueSnapshot } from '../print-queue-contract'

const NATIVE_PENDING =
  'Waiting for structured food order items. Automatic recovery will retry; open this order to refresh its items if it remains pending.'
const NATIVE_UNAVAILABLE =
  'Food order items did not arrive within 4 minutes, so this job was not printed. Open the order to refresh its items, then retry it from the print queue.'
const GREEK_PENDING = 'Αναμονή για τα είδη της παραγγελίας. Θα τυπωθεί μόλις φτάσουν.'
const GREEK_UNAVAILABLE = 'Τα είδη της παραγγελίας δεν έφτασαν και δεν τυπώθηκε. Πατήστε Επανάληψη.'

const makeJob = (overrides: Partial<PrintQueueJob> = {}): PrintQueueJob => ({
  id: 'job-food-1',
  source: 'pos',
  entityType: 'order_receipt',
  entityId: 'order-food-1',
  printerProfileId: 'profile-1',
  printerDisplayName: 'Front counter',
  resolvedTransport: null,
  resolvedTarget: null,
  status: 'pending',
  transportState: null,
  spoolJobId: null,
  snapshotAvailable: false,
  reprintOfJobId: null,
  cancellable: true,
  retryable: false,
  reprintable: false,
  lastError: null,
  warningCode: null,
  warningMessage: null,
  lastSeenAt: null,
  createdAt: '2026-10-06T08:00:00Z',
  updatedAt: '2026-10-06T08:00:01Z',
  ...overrides,
})

const setQueue = (jobs: PrintQueueJob[]) => {
  mocks.current = {
    jobs,
    queuePaused: false,
    pausedPrinterProfileIds: [] as string[],
    counts: { active: 1, failed: 1, stale: 0, history: 1 },
    pagination: { offset: 0, limit: 20, total: jobs.length, hasMore: false },
    loading: false,
    stale: false,
    error: null,
    refresh: vi.fn(),
    cancelJob: vi.fn(),
    cancelAllJobs: vi.fn(),
    pauseQueue: vi.fn(),
    resumeQueue: vi.fn(),
    retryJob: vi.fn(),
    reprintJob: vi.fn(),
  }
  mocks.usePrintQueue.mockImplementation(() => mocks.current)
}

const snapshot = (jobs: PrintQueueJob[]): PrintQueueSnapshot => ({
  success: true,
  jobs,
  queuePaused: false,
  pausedPrinterProfileIds: [],
  counts: { active: 0, failed: 0, stale: 0, history: 0 },
  pagination: { offset: 0, limit: 10, total: jobs.length, hasMore: false },
})

describe('PrintQueuePanel food-items reasons', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.translations = {}
  })

  afterEach(() => cleanup())

  it('translates the waiting and failed food reasons from their stable codes, never the native English text', () => {
    mocks.translations = {
      'settings.printQueue.issue.foodOrderItemsPending': GREEK_PENDING,
      'settings.printQueue.issue.foodOrderItemsUnavailable': GREEK_UNAVAILABLE,
    }
    setQueue([
      makeJob({
        id: 'waiting',
        warningCode: FOOD_ORDER_ITEMS_PENDING,
        warningMessage: NATIVE_PENDING,
      }),
      makeJob({
        id: 'failed',
        status: 'failed',
        cancellable: false,
        retryable: true,
        lastError: NATIVE_UNAVAILABLE,
        warningCode: FOOD_ORDER_ITEMS_UNAVAILABLE,
        warningMessage: NATIVE_UNAVAILABLE,
      }),
    ])

    render(<PrintQueuePanel />)

    const [waitingRow, failedRow] = screen.getAllByRole('article')
    expect(within(waitingRow).getByText(GREEK_PENDING)).toBeVisible()
    expect(within(failedRow).getByText(GREEK_UNAVAILABLE)).toBeVisible()
    expect(screen.queryByText(/Waiting for structured food order items/)).toBeNull()
    expect(screen.queryByText(/did not arrive within 4 minutes/)).toBeNull()
    // The translated summary is complete; no English native detail is offered.
    expect(screen.queryByRole('button', { name: /issue details/i })).toBeNull()
    // The bounded wait ends in a failed job the operator can retry here.
    expect(within(failedRow).getByRole('button', { name: /Retry/ })).toBeEnabled()
  })

  it('keeps the sanitized native message and its details for codes the renderer does not know', () => {
    setQueue([
      makeJob({
        id: 'drawer',
        status: 'dispatched',
        cancellable: false,
        warningCode: 'drawer_kick_failed',
        warningMessage: 'Drawer kick failed on the receipt printer',
        lastError: 'Drawer pulse rejected',
      }),
    ])

    render(<PrintQueuePanel />)

    expect(screen.getByText('Drawer kick failed on the receipt printer')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Show issue details' })).toBeVisible()
  })

  it('uses the exact reason codes the native print worker writes', () => {
    const printRs = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', '..', 'src-tauri', 'src', 'print.rs'),
      'utf8',
    )
    expect(printRs).toContain(`FOOD_ITEMS_PENDING_CODE: &str = "${FOOD_ORDER_ITEMS_PENDING}"`)
    expect(printRs).toContain(`FOOD_ITEMS_UNAVAILABLE_CODE: &str = "${FOOD_ORDER_ITEMS_UNAVAILABLE}"`)
  })

  it('returns translated copy only for known reason codes', () => {
    const translate = (key: string, defaultValue: string) => mocks.translations[key] ?? defaultValue
    mocks.translations = { 'settings.printQueue.issue.foodOrderItemsPending': GREEK_PENDING }
    expect(printQueueReasonText(FOOD_ORDER_ITEMS_PENDING, translate)).toBe(GREEK_PENDING)
    expect(printQueueReasonText(FOOD_ORDER_ITEMS_UNAVAILABLE, translate)).toMatch(/Retry/)
    expect(printQueueReasonText('drawer_kick_failed', translate)).toBeNull()
    expect(printQueueReasonText(null, translate)).toBeNull()
  })
})

describe('queued print job outcome', () => {
  const noWait = () => Promise.resolve()

  it('classifies only settled or explained states and keeps watching plain queued work', () => {
    expect(classifyQueuedPrintJob(makeJob({ status: 'dispatched' }))).toEqual({ kind: 'sent' })
    expect(classifyQueuedPrintJob(makeJob({ status: 'printed' }))).toEqual({ kind: 'sent' })
    expect(classifyQueuedPrintJob(makeJob({ warningCode: FOOD_ORDER_ITEMS_PENDING }))).toEqual({
      kind: 'waiting',
      reasonCode: FOOD_ORDER_ITEMS_PENDING,
    })
    expect(
      classifyQueuedPrintJob(makeJob({ status: 'failed', warningCode: FOOD_ORDER_ITEMS_UNAVAILABLE })),
    ).toEqual({ kind: 'not_printed', reasonCode: FOOD_ORDER_ITEMS_UNAVAILABLE })
    expect(classifyQueuedPrintJob(makeJob({ status: 'cancelled' }))).toEqual({
      kind: 'not_printed',
      reasonCode: null,
    })
    expect(classifyQueuedPrintJob(makeJob())).toBeNull()
    expect(classifyQueuedPrintJob(makeJob({ status: 'printing' }))).toBeNull()
    expect(classifyQueuedPrintJob(undefined)).toBeNull()
  })

  it('reports a food print that is waiting for its items instead of claiming it printed', async () => {
    const listJobs = vi.fn(async () =>
      snapshot([makeJob({ warningCode: FOOD_ORDER_ITEMS_PENDING, warningMessage: NATIVE_PENDING })]),
    )
    await expect(
      observeQueuedPrintJob(listJobs, 'job-food-1', { attempts: 5, wait: noWait }),
    ).resolves.toEqual({ kind: 'waiting', reasonCode: FOOD_ORDER_ITEMS_PENDING })
    expect(listJobs).toHaveBeenCalledTimes(1)
  })

  it('reports sent only after the queue shows the job dispatched', async () => {
    const listJobs = vi
      .fn()
      .mockResolvedValueOnce(snapshot([makeJob()]))
      .mockResolvedValueOnce(snapshot([makeJob({ status: 'printing' })]))
      .mockResolvedValue(snapshot([makeJob({ status: 'dispatched' })]))
    await expect(
      observeQueuedPrintJob(listJobs, 'job-food-1', { attempts: 5, wait: noWait }),
    ).resolves.toEqual({ kind: 'sent' })
    expect(listJobs).toHaveBeenCalledTimes(3)
  })

  it('stays "queued" when the job never settles, is missing or the queue cannot be read', async () => {
    const pendingForever = vi.fn(async () => snapshot([makeJob()]))
    await expect(
      observeQueuedPrintJob(pendingForever, 'job-food-1', { attempts: 3, wait: noWait }),
    ).resolves.toEqual({ kind: 'queued' })
    expect(pendingForever).toHaveBeenCalledTimes(3)

    const missing = vi.fn(async () => snapshot([makeJob({ id: 'someone-else' })]))
    await expect(
      observeQueuedPrintJob(missing, 'job-food-1', { attempts: 2, wait: noWait }),
    ).resolves.toEqual({ kind: 'queued' })

    const unreadable = vi.fn(async () => {
      throw new Error('queue unavailable')
    })
    await expect(
      observeQueuedPrintJob(unreadable, 'job-food-1', { attempts: 2, wait: noWait }),
    ).resolves.toEqual({ kind: 'queued' })
    expect(unreadable).toHaveBeenCalledTimes(2)
  })
})
