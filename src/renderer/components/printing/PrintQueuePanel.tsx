import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  PauseCircle,
  PlayCircle,
  Printer,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePrintQueue } from '../../hooks/usePrintQueue'
import type {
  PrintQueueCancelAllResult,
  PrintQueueCancelJobResult,
  PrintQueueCounts,
  PrintQueueJob,
  PrintQueueListOptions,
  PrintQueuePagination,
  PrintQueuePauseResult,
  PrintQueueReprintResult,
  PrintQueueResumeResult,
  PrintQueueRetryResult,
  PrintQueueSnapshot,
} from './print-queue-contract'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { SegmentedControl, StatusLine, TechDisclosure, solidButton, type StatusTone } from '../settings/SettingsKit'

const INITIAL_LIMIT = 20
const LIMIT_STEP = 20
const MAX_LIMIT = 100
const CANCELLABLE_STATUSES = ['pending', 'printing', 'dispatched'] as const

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi
const OWNERSHIP_MARKER_IN_TEXT = /TheSmallPOS\/[^\s]+/gi
const LONG_TECHNICAL_TOKEN_IN_TEXT = /\b[a-z0-9_-]{32,}\b/gi

type Confirmation =
  | { kind: 'bulk' }
  | { kind: 'reprint'; jobId: string; actionContext: string | null }
  | null

interface ActionFeedback {
  kind: 'success' | 'warning' | 'alert'
  message: string
}

interface AuthoritativeQueueSnapshot {
  jobs: PrintQueueJob[]
  queuePaused: boolean
  pausedPrinterProfileIds: string[]
  counts: PrintQueueCounts
  pagination: PrintQueuePagination
}

interface RowPresentation {
  entityLabel: string
  rowContext: string
  duplicateContext: boolean
}

type NativeEvidence = Partial<{
  activeStopsRequested: number
  nativeControlsRequested: number
  nativeControlsConfirmed: number
  nativeControlsFailed: number
  ownershipRefused: number
}>

const titleCase = (value: string) =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase())

const normalizeKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown'

const operatorSafeDetail = (value: string) =>
  value
    .replace(OWNERSHIP_MARKER_IN_TEXT, 'technical identifier')
    .replace(UUID_IN_TEXT, 'technical identifier')
    .replace(LONG_TECHNICAL_TOKEN_IN_TEXT, 'technical identifier')

const isSuccessfulMutation = (value: unknown): value is { success: true } =>
  Boolean(value && typeof value === 'object' && (value as { success?: unknown }).success === true)

const positive = (value: number | undefined) =>
  Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : 0

/** One plain status line per job: red when it failed, green once it reached the printer. */
const jobStatusTone = (status: string, needsAttention: boolean): StatusTone => {
  if (status === 'failed') return 'bad'
  if (status === 'printed' || status === 'dispatched' || status === 'completed') return 'ok'
  return needsAttention ? 'warn' : 'idle'
}

type Label = (
  key: string,
  defaultValue: string,
  values?: Record<string, unknown>,
) => string

/**
 * Stable native reason codes (`print_jobs.warning_code`, pos-tauri print.rs).
 * The native English `warning_message`/`last_error` stays support evidence;
 * operators read the renderer's translated copy for these codes.
 */
export const FOOD_ORDER_ITEMS_PENDING = 'food_order_items_pending'
export const FOOD_ORDER_ITEMS_UNAVAILABLE = 'food_order_items_unavailable'

const PRINT_QUEUE_REASON_COPY = new Map<string, { key: string; defaultValue: string }>([
  [FOOD_ORDER_ITEMS_PENDING, {
    key: 'settings.printQueue.issue.foodOrderItemsPending',
    defaultValue:
      "Waiting for this order's items from the delivery platform. It prints by itself once they arrive. If it stays here, open the order to refresh its items.",
  }],
  [FOOD_ORDER_ITEMS_UNAVAILABLE, {
    key: 'settings.printQueue.issue.foodOrderItemsUnavailable',
    defaultValue:
      "This order's items did not arrive from the delivery platform, so it was not printed. Open the order to refresh its items, then press Retry.",
  }],
])

/**
 * Operator copy for a native reason code, or null for a code the renderer does
 * not know (its sanitized native message stays the fallback).
 */
export function printQueueReasonText(
  reasonCode: string | null | undefined,
  translate: (key: string, defaultValue: string) => string,
): string | null {
  const copy = reasonCode ? PRINT_QUEUE_REASON_COPY.get(reasonCode) : undefined
  return copy ? translate(copy.key, copy.defaultValue) : null
}

/** What one queued job became, as far as the queue can prove it. */
export type QueuedPrintOutcome =
  | { kind: 'sent' }
  | { kind: 'waiting'; reasonCode: string }
  | { kind: 'not_printed'; reasonCode: string | null }
  | { kind: 'queued' }

/** Native reasons that hold a pending job on purpose (it is waiting, not slow). */
const WAITING_REASON_CODES = new Set<string>([FOOD_ORDER_ITEMS_PENDING])

/**
 * The settled or explained outcome of one queued job, or null while it is
 * still plain queued work. A transport hand-off (`dispatched`, `printed`) is
 * "sent", never proof of paper.
 */
export function classifyQueuedPrintJob(job: PrintQueueJob | undefined): QueuedPrintOutcome | null {
  if (!job) return null
  switch (job.status) {
    case 'printed':
    case 'dispatched':
      return { kind: 'sent' }
    case 'failed':
    case 'cancelled':
      return { kind: 'not_printed', reasonCode: job.warningCode }
    case 'pending':
      return job.warningCode && WAITING_REASON_CODES.has(job.warningCode)
        ? { kind: 'waiting', reasonCode: job.warningCode }
        : null
    default:
      return null
  }
}

export interface ObserveQueuedPrintJobOptions {
  attempts?: number
  intervalMs?: number
  wait?: (ms: number) => Promise<void>
}

const OBSERVE_ATTEMPTS = 12
const OBSERVE_INTERVAL_MS = 500
const OBSERVE_PAGE_LIMIT = 10

/**
 * Watch a just-queued job for a few seconds. The reply that queued it is not
 * a print: anything not settled or explained in the window, including an
 * unreadable queue, stays "queued".
 */
export async function observeQueuedPrintJob(
  listJobs: (options?: PrintQueueListOptions) => Promise<PrintQueueSnapshot>,
  jobId: string,
  options: ObserveQueuedPrintJobOptions = {},
): Promise<QueuedPrintOutcome> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? OBSERVE_ATTEMPTS))
  const intervalMs = options.intervalMs ?? OBSERVE_INTERVAL_MS
  const wait = options.wait
    ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(intervalMs)
    try {
      const snapshot = await listJobs({ limit: OBSERVE_PAGE_LIMIT, offset: 0 })
      const outcome = classifyQueuedPrintJob(snapshot.jobs.find((job) => job.id === jobId))
      if (outcome) return outcome
    } catch {
      // An unreadable queue is not an outcome; the job stays "queued".
    }
  }
  return { kind: 'queued' }
}

interface PrintQueueIssueProps {
  summary: string
  details: string | null
  actionContext: string | null
  label: Label
}

const PrintQueueIssue: React.FC<PrintQueueIssueProps> = ({
  summary,
  details,
  actionContext,
  label,
}) => {
  const generatedId = useId()
  const [expanded, setExpanded] = useState(false)
  const detailsId = `print-queue-issue-${generatedId}`

  return (
    <div className="pos-notice pos-notice--warn pos-queue__issue">
      <AlertTriangle aria-hidden="true" className="pos-notice__icon h-4 w-4" />
      <span className="min-w-0 flex-1 wrap-break-word text-sm">{summary}</span>
      {details && (
        <>
          <button
            type="button"
            aria-label={expanded
              ? actionContext
                ? label(
                    'settings.printQueue.hideIssueDetailsWithContext',
                    `Hide issue details for ${actionContext}`,
                    { context: actionContext },
                  )
                : label('settings.printQueue.hideIssueDetails', 'Hide issue details')
              : actionContext
                ? label(
                    'settings.printQueue.showIssueDetailsWithContext',
                    `Show issue details for ${actionContext}`,
                    { context: actionContext },
                  )
                : label('settings.printQueue.showIssueDetails', 'Show issue details')}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((current) => !current)}
            className="pos-text-disclosure"
          >
            {expanded
              ? <ChevronUp aria-hidden="true" className="h-4 w-4" />
              : <ChevronDown aria-hidden="true" className="h-4 w-4" />}
            {expanded
              ? label('settings.printQueue.hideDetails', 'Hide details')
              : label('settings.printQueue.showDetails', 'Show details')}
          </button>
          {expanded && (
            <p id={detailsId} className="pos-notice__details">
              {details}
            </p>
          )}
        </>
      )}
    </div>
  )
}

interface UnseenPausedPrinterControlsProps {
  profileIds: string[]
  busy: boolean
  label: Label
  onResume: (actionId: string, profileId: string, printerName: string) => void
}

const UnseenPausedPrinterControls: React.FC<UnseenPausedPrinterControlsProps> = ({
  profileIds,
  busy,
  label,
  onResume,
}) => {
  const generatedId = useId()

  return (
    <div className="flex flex-wrap gap-2">
      {profileIds.map((profileId, index) => {
        const position = index + 1
        const printerName = label(
          'settings.printQueue.unseenPausedPrinterName',
          `paused printer ${position}`,
          { index: position },
        )
        return (
          <button
            key={profileId}
            id={`print-queue-unseen-resume-${generatedId}-${position}`}
            type="button"
            aria-label={label(
              'settings.printQueue.resumeUnseenPrinterAria',
              `Resume paused printer ${position}`,
              { index: position },
            )}
            onClick={() => onResume(`unseen-${position}`, profileId, printerName)}
            disabled={busy}
            className={solidButton('secondary', 'sm')}
          >
            <PlayCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
            {label('settings.printQueue.resumePrinter', 'Resume')}
          </button>
        )
      })}
    </div>
  )
}

const PrintQueuePanel: React.FC = () => {
  const { t } = useTranslation()
  const [limit, setLimit] = useState(INITIAL_LIMIT)
  // UI audit wave 7Γ: «Prints that did not come out» first; every job one tap away.
  const [jobFilter, setJobFilter] = useState<'failed' | 'all'>('failed')
  const queue = usePrintQueue(jobFilter === 'failed' ? { limit, offset: 0, status: 'failed' } : { limit, offset: 0 })
  const [confirmation, setConfirmation] = useState<Confirmation>(null)
  const [busyActions, setBusyActions] = useState<Set<string>>(() => new Set())
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null)
  const [highlightedNewJobId, setHighlightedNewJobId] = useState<string | null>(null)

  const authoritativeSnapshot = useMemo<AuthoritativeQueueSnapshot | null>(() => {
    if (queue.loading || queue.stale || queue.error || queue.pagination.offset !== 0) return null
    return {
      jobs: queue.jobs,
      queuePaused: queue.queuePaused,
      pausedPrinterProfileIds: queue.pausedPrinterProfileIds,
      counts: {
        active: queue.counts.active,
        failed: queue.counts.failed,
        stale: queue.counts.stale,
        history: queue.counts.history,
      },
      pagination: {
        offset: queue.pagination.offset,
        limit: queue.pagination.limit,
        total: queue.pagination.total,
        hasMore: queue.pagination.hasMore,
      },
    }
  }, [
    queue.counts.active,
    queue.counts.failed,
    queue.counts.history,
    queue.counts.stale,
    queue.error,
    queue.jobs,
    queue.loading,
    queue.pagination.hasMore,
    queue.pagination.limit,
    queue.pagination.offset,
    queue.pagination.total,
    queue.pausedPrinterProfileIds,
    queue.queuePaused,
    queue.stale,
  ])
  const authoritativeSignature = authoritativeSnapshot
    ? JSON.stringify(authoritativeSnapshot)
    : null
  const committedAuthoritativeSignature = useRef<string | null>(null)
  const [lastAuthoritativeSnapshot, setLastAuthoritativeSnapshot] =
    useState<AuthoritativeQueueSnapshot | null>(null)

  useEffect(() => {
    if (
      !authoritativeSnapshot
      || authoritativeSignature === committedAuthoritativeSignature.current
    ) return
    committedAuthoritativeSignature.current = authoritativeSignature
    setLastAuthoritativeSnapshot(authoritativeSnapshot)
  }, [authoritativeSignature, authoritativeSnapshot])

  const displaySnapshot = authoritativeSnapshot ?? lastAuthoritativeSnapshot
  const displayJobs = displaySnapshot?.jobs ?? []
  const displayPausedPrinterProfileIds = displaySnapshot?.pausedPrinterProfileIds ?? []
  const displayQueuePaused = displaySnapshot?.queuePaused ?? queue.queuePaused
  const hasAuthoritativeSnapshot = displaySnapshot !== null

  const label = useCallback(
    (key: string, defaultValue: string, values: Record<string, unknown> = {}) =>
      t(key, { defaultValue, ...values }),
    [t],
  )

  const formatTimestamp = useCallback(
    (value: string | null | undefined) => {
      if (!value) return label('settings.printQueue.unknown', 'Unknown')
      const parsed = new Date(value)
      return Number.isNaN(parsed.getTime()) ? operatorSafeDetail(value) : parsed.toLocaleString()
    },
    [label],
  )

  const markBusy = useCallback((key: string, busy: boolean) => {
    setBusyActions((current) => {
      const next = new Set(current)
      if (busy) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const evidenceParts = useCallback((result: NativeEvidence) => {
    const parts: string[] = []
    const activeStopsRequested = positive(result.activeStopsRequested)
    const nativeControlsRequested = positive(result.nativeControlsRequested)
    const nativeControlsConfirmed = positive(result.nativeControlsConfirmed)
    const nativeControlsFailed = positive(result.nativeControlsFailed)
    const ownershipRefused = positive(result.ownershipRefused)
    if (activeStopsRequested > 0) {
      parts.push(label(
        'settings.printQueue.feedback.activeStopsRequested',
        `${activeStopsRequested} active stop${activeStopsRequested === 1 ? '' : 's'} requested`,
        { count: activeStopsRequested },
      ))
    }
    if (nativeControlsRequested > 0) {
      parts.push(label(
        'settings.printQueue.feedback.nativeControlsRequested',
        `${nativeControlsRequested} native control${nativeControlsRequested === 1 ? '' : 's'} requested`,
        { count: nativeControlsRequested },
      ))
    }
    if (nativeControlsConfirmed > 0) {
      parts.push(label(
        'settings.printQueue.feedback.nativeControlsConfirmed',
        `${nativeControlsConfirmed} native control${nativeControlsConfirmed === 1 ? '' : 's'} confirmed`,
        { count: nativeControlsConfirmed },
      ))
    }
    if (nativeControlsFailed > 0) {
      parts.push(label(
        'settings.printQueue.feedback.nativeControlsFailed',
        `${nativeControlsFailed} native control${nativeControlsFailed === 1 ? '' : 's'} failed`,
        { count: nativeControlsFailed },
      ))
    }
    if (ownershipRefused > 0) {
      parts.push(label(
        'settings.printQueue.feedback.ownershipRefused',
        `${ownershipRefused} ownership refused`,
        { count: ownershipRefused },
      ))
    }
    return parts
  }, [label])

  const feedbackKind = useCallback((result: NativeEvidence): ActionFeedback['kind'] =>
    positive(result.nativeControlsFailed) > 0 || positive(result.ownershipRefused) > 0
      ? 'warning'
      : 'success', [])

  const runAction = useCallback(async <T,>(
    key: string,
    action: () => Promise<T>,
    onResult: (result: T) => void,
    failureMessage: string,
  ) => {
    markBusy(key, true)
    setFeedback(null)
    try {
      const result = await action()
      if (!isSuccessfulMutation(result)) {
        const evidence = result && typeof result === 'object'
          ? evidenceParts(result as NativeEvidence)
          : []
        setFeedback({ kind: 'alert', message: [failureMessage, ...evidence].join(' · ') })
        return
      }
      onResult(result)
    } catch {
      setFeedback({ kind: 'alert', message: failureMessage })
    } finally {
      markBusy(key, false)
    }
  }, [evidenceParts, markBusy])

  const cancellationFeedback = useCallback((
    result: PrintQueueCancelJobResult | PrintQueueCancelAllResult,
  ) => {
    const affected = positive(result.affected)
    const parts = [affected === 0
      ? label('settings.printQueue.feedback.noChange', 'No change')
      : label(
          'settings.printQueue.feedback.affected',
          `${affected} affected`,
          { count: affected },
        )]
    const unchanged = positive(result.unchanged)
    if (unchanged > 0) {
      parts.push(label(
        'settings.printQueue.feedback.unchanged',
        `${unchanged} unchanged`,
        { count: unchanged },
      ))
    }
    const localCancelled = positive(result.localCancelled)
    if (localCancelled > 0) {
      parts.push(label(
        'settings.printQueue.feedback.localCancelled',
        `${localCancelled} local job${localCancelled === 1 ? '' : 's'} cancelled`,
        { count: localCancelled },
      ))
    }
    parts.push(...evidenceParts(result))
    return parts.join(' · ')
  }, [evidenceParts, label])

  const handleQueuePauseToggle = useCallback(() => {
    const pausing = !displayQueuePaused
    const key = 'queue-pause'
    void runAction<PrintQueuePauseResult | PrintQueueResumeResult>(
      key,
      () => pausing ? queue.pauseQueue() : queue.resumeQueue(),
      (result) => {
        const evidence = evidenceParts(result)
        const remainingPrinterPauses = result.pausedPrinterProfileIds.length
        const resumedWithPrinterPauses = !pausing
          && !result.queuePaused
          && remainingPrinterPauses > 0
        const state = result.queuePaused
          ? label('settings.printQueue.feedback.queuePaused', 'POS print queue paused')
          : pausing
            ? label('settings.printQueue.feedback.queueStillActive', 'POS print queue remains active')
            : resumedWithPrinterPauses
              ? label(
                  'settings.printQueue.feedback.queueResumedWithPrinterPauses',
                  `POS print queue resumed. ${remainingPrinterPauses} printer pause${remainingPrinterPauses === 1 ? ' remains' : 's remain'}.`,
                  { count: remainingPrinterPauses },
                )
            : label('settings.printQueue.feedback.queueResumed', 'POS print queue resumed')
        setFeedback({
          kind: result.queuePaused === pausing && !resumedWithPrinterPauses
            ? feedbackKind(result)
            : 'warning',
          message: [state, ...evidence].join(' · '),
        })
      },
      label(
        'settings.printQueue.feedback.pauseFailed',
        pausing ? 'Could not pause the POS print queue' : 'Could not resume the POS print queue',
      ),
    )
  }, [displayQueuePaused, evidenceParts, feedbackKind, label, queue, runAction])

  const handleResumePrinter = useCallback((
    actionId: string,
    printerProfileId: string,
    printerName: string,
  ) => {
    const key = `resume:${printerProfileId}:${actionId}`
    void runAction<PrintQueueResumeResult>(
      key,
      () => queue.resumeQueue({ printerProfileId }),
      (result) => {
        const evidence = evidenceParts(result)
        const stillPaused = result.pausedPrinterProfileIds.includes(printerProfileId)
        const globallyPaused = result.queuePaused
        const message = stillPaused
          ? label(
              'settings.printQueue.feedback.printerStillPaused',
              `${printerName} remains paused`,
              { printer: printerName },
            )
          : globallyPaused
            ? label(
                'settings.printQueue.feedback.printerPauseRemovedQueuePaused',
                `Printer pause removed for ${printerName}. POS print queue remains paused.`,
                { printer: printerName },
              )
            : label(
                'settings.printQueue.feedback.printerResumed',
                `${printerName} resumed`,
                { printer: printerName },
              )
        setFeedback({
          kind: stillPaused || globallyPaused ? 'warning' : feedbackKind(result),
          message: [message, ...evidence].join(' · '),
        })
      },
      label('settings.printQueue.feedback.resumePrinterFailed', 'Could not resume this POS printer'),
    )
  }, [evidenceParts, feedbackKind, label, queue, runAction])

  const handleCancelJob = useCallback((jobId: string) => {
    void runAction<PrintQueueCancelJobResult>(
      `cancel:${jobId}`,
      () => queue.cancelJob(jobId),
      (result) => setFeedback({ kind: feedbackKind(result), message: cancellationFeedback(result) }),
      label('settings.printQueue.feedback.cancelFailed', 'Could not cancel the POS print job'),
    )
  }, [cancellationFeedback, feedbackKind, label, queue, runAction])

  const handleRetryJob = useCallback((jobId: string) => {
    void runAction<PrintQueueRetryResult>(
      `retry:${jobId}`,
      () => queue.retryJob(jobId),
      (result) => {
        const message = result.affected === 0 || result.unchanged
          ? label('settings.printQueue.feedback.noChange', 'No change')
          : label('settings.printQueue.feedback.retryQueued', 'Retry queued')
        setFeedback({ kind: 'success', message })
      },
      label('settings.printQueue.feedback.retryFailed', 'Could not retry the POS print job'),
    )
  }, [label, queue, runAction])

  const handleConfirmBulk = useCallback(() => {
    setConfirmation(null)
    void runAction<PrintQueueCancelAllResult>(
      'bulk-cancel',
      () => queue.cancelAllJobs({ statuses: [...CANCELLABLE_STATUSES] }),
      (result) => setFeedback({ kind: feedbackKind(result), message: cancellationFeedback(result) }),
      label('settings.printQueue.feedback.bulkFailed', 'Could not pause and cancel POS print jobs'),
    )
  }, [cancellationFeedback, feedbackKind, label, queue, runAction])

  const handleConfirmReprint = useCallback((jobId: string) => {
    setConfirmation(null)
    void runAction<PrintQueueReprintResult>(
      `reprint:${jobId}`,
      () => queue.reprintJob(jobId),
      (result) => {
        if (result.duplicate) {
          setFeedback({
            kind: 'success',
            message: label('settings.printQueue.feedback.reprintDuplicate', 'Reprint already queued'),
          })
          return
        }
        if (result.affected === 0 || result.unchanged || !result.newJobId) {
          setFeedback({
            kind: 'success',
            message: label('settings.printQueue.feedback.noChange', 'No change'),
          })
          return
        }
        setHighlightedNewJobId(result.newJobId)
        setFeedback({
          kind: 'success',
          message: label('settings.printQueue.feedback.reprintQueued', 'New reprint queued'),
        })
      },
      label('settings.printQueue.feedback.reprintFailed', 'Could not reprint the POS print job'),
    )
  }, [label, queue, runAction])

  const rowPresentations = useMemo<RowPresentation[]>(() => {
    const baseRows = displayJobs.map((job) => {
      const entityLabel = label(
        `settings.printQueue.entityType.${normalizeKey(job.entityType)}`,
        titleCase(job.entityType),
      )
      const baseContext = label(
        'settings.printQueue.actionContext',
        `${entityLabel} on ${job.printerDisplayName}`,
        { entity: entityLabel, printer: job.printerDisplayName },
      )
      return { entityLabel, baseContext }
    })
    const contextCounts = new Map<string, number>()
    for (const { baseContext } of baseRows) {
      contextCounts.set(baseContext, (contextCounts.get(baseContext) ?? 0) + 1)
    }
    return baseRows.map(({ entityLabel, baseContext }, index) => {
      const duplicateContext = (contextCounts.get(baseContext) ?? 0) > 1
      return {
        entityLabel,
        duplicateContext,
        rowContext: duplicateContext
          ? label(
              'settings.printQueue.actionContextWithPosition',
              `${baseContext}, item ${index + 1}`,
              { context: baseContext, position: index + 1 },
            )
          : baseContext,
      }
    })
  }, [displayJobs, label])

  const visiblePausedProfileNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const job of displayJobs) {
      if (
        job.printerProfileId
        && displayPausedPrinterProfileIds.includes(job.printerProfileId)
        && !names.has(job.printerProfileId)
      ) {
        names.set(job.printerProfileId, job.printerDisplayName)
      }
    }
    return names
  }, [displayJobs, displayPausedPrinterProfileIds])

  const unseenPausedProfileIds = useMemo(
    () => displayPausedPrinterProfileIds
      .filter((profileId) => !visiblePausedProfileNames.has(profileId))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    [displayPausedPrinterProfileIds, visiblePausedProfileNames],
  )
  const unnamedPausedCount = unseenPausedProfileIds.length
  const canShowMore = Boolean(displaySnapshot?.pagination.hasMore) && limit < MAX_LIMIT
  const bulkCancellationBusy = busyActions.has('bulk-cancel')
  const rowMutationBusy = [...busyActions].some((key) => key.includes(':'))
  const queueMutationBusy = bulkCancellationBusy
    || busyActions.has('queue-pause')
  const bulkMutationBusy = queueMutationBusy || rowMutationBusy
  const anyMutationBusy = queueMutationBusy || rowMutationBusy

  const statusLabel = useCallback((status: string) => label(
    `settings.printQueue.status.${normalizeKey(status)}`,
    titleCase(status),
  ), [label])
  const transportLabel = useCallback((status: string | null) => status
    ? label(`settings.printQueue.transport.${normalizeKey(status)}`, titleCase(status))
    : label('settings.printQueue.transport.notStarted', 'Not started'), [label])

  // UI audit wave 7A2: one solid group. A cashier sees the jobs and their own actions;
  // pausing or cancelling the whole queue lives under "Settings for technicians". The list
  // refreshes itself (native events, 5 s polling while visible, on focus), so there is no
  // Refresh button; a failed load offers a retry in its notice.
  return (
    <section
      aria-labelledby="print-queue-title"
      aria-busy={queue.loading}
      className="pos-group"
    >
      <header className="pos-group__head">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="print-queue-title" className="pos-group__title">
            {jobFilter === 'failed'
              ? label('settings.printQueue.failedTitle', 'Prints that did not come out')
              : label('settings.printQueue.posTitle', 'POS Print Queue')}
          </h3>
          <SegmentedControl
            ariaLabel={label('settings.printQueue.filterLabel', 'Show')}
            value={jobFilter}
            onChange={(value) => { setJobFilter(value); setLimit(INITIAL_LIMIT) }}
            options={[
              { value: 'failed', label: label('settings.printQueue.filterFailed', 'Not printed') },
              { value: 'all', label: label('settings.printQueue.filterAll', 'All') },
            ]}
          />
        </div>
        <p className="pos-group__desc">
          {label(
            'settings.printQueue.posOnlyScope',
            'This panel controls only print jobs created by The Small POS. Jobs from other applications are never controlled here.',
          )}
        </p>
        {displaySnapshot && (
          <p
            role="status"
            aria-label={label('settings.printQueue.countsLabel', 'POS print queue counts')}
            className="pos-queue__counts"
          >
            {[
              label('settings.printQueue.counts.active', `${displaySnapshot.counts.active} active`, { count: displaySnapshot.counts.active }),
              label('settings.printQueue.counts.failed', `${displaySnapshot.counts.failed} failed`, { count: displaySnapshot.counts.failed }),
              label('settings.printQueue.counts.stale', `${displaySnapshot.counts.stale} stale`, { count: displaySnapshot.counts.stale }),
              label('settings.printQueue.counts.history', `${displaySnapshot.counts.history} history`, { count: displaySnapshot.counts.history }),
            ].join(' · ')}
          </p>
        )}
      </header>

      {displayQueuePaused && (
        <div className="pos-notice pos-notice--warn pos-notice--row pos-queue__notice">
          <span role="status" className="text-sm font-semibold">
            {label('settings.printQueue.queuePausedNotice', 'Printing is paused on this till. Nothing prints until you resume it.')}
          </span>
          <button
            type="button"
            aria-label={label('settings.printQueue.resumeQueueAria', 'Resume POS print queue')}
            onClick={handleQueuePauseToggle}
            disabled={queue.loading || anyMutationBusy}
            className={solidButton('secondary', 'sm')}
          >
            <PlayCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
            {label('settings.printQueue.resume', 'Resume queue')}
          </button>
        </div>
      )}

      {displayPausedPrinterProfileIds.length > 0 && (
        <div className="pos-notice pos-notice--warn pos-notice--stack pos-queue__notice">
          {visiblePausedProfileNames.size > 0 && (
            <span className="text-sm">
              {label(
                'settings.printQueue.visiblePausedPrinters',
                `Paused: ${[...visiblePausedProfileNames.values()].join(', ')}`,
                { printers: [...visiblePausedProfileNames.values()].join(', ') },
              )}
            </span>
          )}
          {unnamedPausedCount > 0 && (
            <>
              <span className="text-sm">
                {label(
                  'settings.printQueue.unnamedPausedPrinters',
                  `${unnamedPausedCount} printer${unnamedPausedCount === 1 ? ' is' : 's are'} paused`,
                  { count: unnamedPausedCount },
                )}
              </span>
              <UnseenPausedPrinterControls
                profileIds={unseenPausedProfileIds}
                busy={anyMutationBusy}
                label={label}
                onResume={handleResumePrinter}
              />
            </>
          )}
        </div>
      )}

      {queue.stale && (
        <div
          role="status"
          aria-live="polite"
          aria-label={label('settings.printQueue.freshnessLabel', 'Print queue freshness')}
          className="pos-notice pos-notice--warn pos-queue__notice"
        >
          <AlertTriangle aria-hidden="true" className="pos-notice__icon h-4 w-4" />
          <span className="text-sm">
            {hasAuthoritativeSnapshot
              ? label('settings.printQueue.stale', 'Queue data may be out of date. The last good data remains visible.')
              : label('settings.printQueue.unavailable', 'Queue status is unavailable. Refresh to try again.')}
          </span>
        </div>
      )}

      {queue.error && (
        <div role="alert" className="pos-notice pos-notice--bad pos-notice--row pos-queue__notice">
          <span className="text-sm">
            {label(
              hasAuthoritativeSnapshot
                ? 'settings.printQueue.loadFailedSafe'
                : 'settings.printQueue.initialLoadFailedSafe',
              hasAuthoritativeSnapshot
                ? 'Could not refresh the POS print queue. The last good data remains visible.'
                : 'Could not load the POS print queue. Current queue status is unavailable.',
            )}
          </span>
          <button
            type="button"
            aria-label={label('settings.printQueue.refreshAria', 'Refresh POS print queue')}
            onClick={() => void queue.refresh()}
            disabled={queue.loading}
            className={solidButton('secondary', 'sm')}
          >
            <RefreshCw aria-hidden="true" className={`h-4 w-4 shrink-0 ${queue.loading ? 'animate-spin' : ''}`} />
            {label('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {feedback && (
        <div
          role={feedback.kind === 'alert' ? 'alert' : 'status'}
          aria-live={feedback.kind !== 'alert' ? 'polite' : undefined}
          aria-label={feedback.kind !== 'alert'
            ? label('settings.printQueue.actionResultLabel', 'Print queue action result')
            : undefined}
          className={`pos-notice pos-queue__notice ${feedback.kind === 'alert'
            ? 'pos-notice--bad'
            : feedback.kind === 'warning'
              ? 'pos-notice--warn'
              : 'pos-notice--ok'}`}
        >
          <span className="text-sm">{feedback.message}</span>
        </div>
      )}

      {queue.loading && !hasAuthoritativeSnapshot ? (
        <p
          role="status"
          aria-live="polite"
          aria-label={label('settings.printQueue.loadingLabel', 'Loading POS print queue')}
          className="pos-queue__empty"
        >
          {label('settings.printQueue.loading', 'Loading POS print jobs…')}
        </p>
      ) : !hasAuthoritativeSnapshot ? (
        <p className="pos-queue__empty">
          {label('settings.printQueue.unavailableBody', 'POS print queue is currently unavailable.')}
        </p>
      ) : displayJobs.length === 0 ? (
        <p className="pos-queue__empty">
          {jobFilter === 'failed'
            ? label('settings.printQueue.emptyFailed', 'Every print came out.')
            : label('settings.printQueue.empty', 'No POS print jobs are available.')}
        </p>
      ) : (
        <ul className="pos-queue__list">
          {displayJobs.map((job: PrintQueueJob, index) => {
            const { entityLabel, rowContext, duplicateContext } = rowPresentations[index]
            const actionContext = displayJobs.length > 1 ? rowContext : null
            const articleLabel = label(
              'settings.printQueue.jobArticleAria',
              `POS print job: ${rowContext}`,
              { context: rowContext },
            )
            // A known native reason code reads in the operator's language;
            // its English native text is not repeated as "details".
            const knownReason = printQueueReasonText(job.warningCode, label)
            const issueSummary = knownReason ?? (job.warningMessage
              ? operatorSafeDetail(job.warningMessage)
              : job.lastError
                ? label('settings.printQueue.issue.genericAttention', 'This POS print job needs attention.')
                : null)
            const issueDetails = !knownReason && job.lastError
              ? operatorSafeDetail(job.lastError)
              : null
            const printerPaused = Boolean(
              job.printerProfileId
              && displayPausedPrinterProfileIds.includes(job.printerProfileId),
            )
            const jobBusy = anyMutationBusy
            return (
              <li key={job.id}>
                <article aria-label={articleLabel} className="pos-job">
                  <div className="pos-job__main">
                    <div className="pos-job__title">
                      {entityLabel}
                      {highlightedNewJobId === job.id && (
                        <span className="pos-badge pos-badge--ok">
                          {label('settings.printQueue.newReprint', 'New reprint')}
                        </span>
                      )}
                    </div>
                    <div className="pos-row__help">
                      <span>{job.printerDisplayName}</span>
                      {' · '}
                      <span>
                        {label('settings.printQueue.updatedAt', `Updated ${formatTimestamp(job.updatedAt)}`, {
                          value: formatTimestamp(job.updatedAt),
                        })}
                      </span>
                    </div>
                    <StatusLine tone={jobStatusTone(job.status, Boolean(issueSummary))}>
                      <span data-print-job-status>
                        {statusLabel(job.status)}
                        {' · '}
                        {transportLabel(job.transportState)}
                      </span>
                    </StatusLine>
                    {issueSummary && (
                      <PrintQueueIssue
                        summary={issueSummary}
                        details={issueDetails}
                        actionContext={actionContext}
                        label={label}
                      />
                    )}
                  </div>

                  <div className="pos-job__actions">
                    {job.retryable && (
                      <button
                        type="button"
                        aria-label={actionContext
                          ? label(
                              'settings.printQueue.retryJobWithContextAria',
                              `Retry POS print job for ${actionContext}`,
                              { context: actionContext },
                            )
                          : label('settings.printQueue.retryJobAria', 'Retry POS print job')}
                        onClick={() => handleRetryJob(job.id)}
                        disabled={jobBusy}
                        className={solidButton('secondary', 'sm')}
                      >
                        <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
                        {label('settings.printQueue.retry', 'Retry')}
                      </button>
                    )}
                    {job.reprintable && (
                      <button
                        type="button"
                        aria-label={actionContext
                          ? label(
                              'settings.printQueue.reprintJobWithContextAria',
                              `Reprint POS print job for ${actionContext}`,
                              { context: actionContext },
                            )
                          : label('settings.printQueue.reprintJobAria', 'Reprint POS print job')}
                        onClick={() => setConfirmation({
                          kind: 'reprint',
                          jobId: job.id,
                          actionContext: rowContext,
                        })}
                        disabled={jobBusy}
                        className={solidButton('secondary', 'sm')}
                      >
                        <Printer aria-hidden="true" className="h-4 w-4 shrink-0" />
                        {label('settings.printQueue.reprint', 'Reprint')}
                      </button>
                    )}
                    {printerPaused && job.printerProfileId && (
                      <button
                        type="button"
                        aria-label={duplicateContext
                          ? label(
                              'settings.printQueue.resumePrinterWithContextAria',
                              `Resume printer for ${rowContext}`,
                              { context: rowContext },
                            )
                          : label(
                              'settings.printQueue.resumePrinterAria',
                              `Resume ${job.printerDisplayName}`,
                              { printer: job.printerDisplayName },
                            )}
                        onClick={() => handleResumePrinter(
                          job.id,
                          job.printerProfileId as string,
                          job.printerDisplayName,
                        )}
                        disabled={jobBusy
                          || [...busyActions].some((key) => key.startsWith(`resume:${job.printerProfileId}:`))}
                        className={solidButton('secondary', 'sm')}
                      >
                        <PlayCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
                        {label('settings.printQueue.resumePrinter', 'Resume')}
                      </button>
                    )}
                    {job.cancellable && (
                      <button
                        type="button"
                        aria-label={actionContext
                          ? label(
                              'settings.printQueue.cancelJobWithContextAria',
                              `Cancel POS print job for ${actionContext}`,
                              { context: actionContext },
                            )
                          : label('settings.printQueue.cancelJobAria', 'Cancel POS print job')}
                        onClick={() => handleCancelJob(job.id)}
                        disabled={jobBusy}
                        className={solidButton('danger', 'sm')}
                      >
                        <XCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
                        {label('settings.printQueue.cancel', 'Cancel')}
                      </button>
                    )}
                  </div>
                </article>
              </li>
            )
          })}
        </ul>
      )}

      {displaySnapshot && (
        <div className="pos-queue__foot">
          <span>
            {label(
              'settings.printQueue.pagination',
              `Showing ${displayJobs.length} of ${displaySnapshot.pagination.total} POS jobs`,
              { shown: displayJobs.length, total: displaySnapshot.pagination.total },
            )}
          </span>
          {canShowMore && (
            <button
              type="button"
              aria-label={label('settings.printQueue.showMoreAria', 'Show more POS print jobs')}
              onClick={() => setLimit((current) => Math.min(MAX_LIMIT, current + LIMIT_STEP))}
              disabled={queue.loading || queue.stale || Boolean(queue.error) || anyMutationBusy}
              className={solidButton('secondary', 'md')}
            >
              {label('settings.printQueue.showMore', 'Show more')}
            </button>
          )}
        </div>
      )}

      <TechDisclosure title={label('settings.printer.forTechnicians', 'Settings for technicians')}>
        <p className="pos-row__help">
          {label('settings.printQueue.techniciansHelp', 'Stop or clear the whole queue of this till. Use only while fixing a printer.')}
        </p>
        <div className="flex flex-wrap gap-3">
          {!displayQueuePaused && (
            <button
              type="button"
              aria-label={label('settings.printQueue.pauseQueueAria', 'Pause POS print queue')}
              onClick={handleQueuePauseToggle}
              disabled={queue.loading || anyMutationBusy}
              className={solidButton('secondary', 'md')}
            >
              <PauseCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
              {label('settings.printQueue.pause', 'Pause queue')}
            </button>
          )}
          <button
            type="button"
            aria-label={label('settings.printQueue.pauseCancelAria', 'Pause and cancel POS jobs')}
            onClick={() => setConfirmation({ kind: 'bulk' })}
            disabled={queue.loading || bulkMutationBusy}
            className={solidButton('danger', 'md')}
          >
            <XCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
            {label('settings.printQueue.pauseCancel', 'Pause and cancel POS jobs')}
          </button>
        </div>
      </TechDisclosure>

      <ConfirmDialog
        isOpen={confirmation?.kind === 'bulk'}
        onClose={() => setConfirmation(null)}
        onConfirm={handleConfirmBulk}
        title={label('settings.printQueue.confirmBulkTitle', 'Pause and cancel POS jobs?')}
        message={label(
          'settings.printQueue.confirmBulkMessage',
          'This pauses new POS submissions and requests cancellation only for jobs owned by The Small POS.',
        )}
        variant="error"
        confirmText={label('settings.printQueue.confirmBulkAction', 'Pause and cancel')}
        cancelText={label('settings.printQueue.keepPrinting', 'Keep printing')}
        isLoading={busyActions.has('bulk-cancel')}
      />

      <ConfirmDialog
        isOpen={confirmation?.kind === 'reprint'}
        onClose={() => setConfirmation(null)}
        onConfirm={() => {
          if (confirmation?.kind === 'reprint') handleConfirmReprint(confirmation.jobId)
        }}
        title={confirmation?.kind === 'reprint' && confirmation.actionContext
          ? label(
              'settings.printQueue.confirmReprintTitleWithContext',
              `Reprint POS print job for ${confirmation.actionContext}?`,
              { context: confirmation.actionContext },
            )
          : label('settings.printQueue.confirmReprintTitle', 'Reprint POS print job?')}
        message={label(
          'settings.printQueue.confirmReprintMessage',
          'Reprint creates a new auditable POS print job from the saved print snapshot.',
        )}
        variant="warning"
        confirmText={label('settings.printQueue.confirmReprintAction', 'Reprint')}
        cancelText={label('settings.printQueue.keepOriginal', 'Keep original')}
        isLoading={confirmation?.kind === 'reprint' && busyActions.has(`reprint:${confirmation.jobId}`)}
      />
    </section>
  )
}

export default PrintQueuePanel
