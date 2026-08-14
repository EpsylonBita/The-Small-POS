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
  PrintQueuePagination,
  PrintQueuePauseResult,
  PrintQueueReprintResult,
  PrintQueueResumeResult,
  PrintQueueRetryResult,
} from './print-queue-contract'
import { ConfirmDialog } from '../ui/ConfirmDialog'

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

type Label = (
  key: string,
  defaultValue: string,
  values?: Record<string, unknown>,
) => string

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
    <div className="rounded-xl border border-yellow-300 bg-yellow-50 px-2 py-2 text-xs text-yellow-900 dark:border-yellow-400/30 dark:bg-yellow-500/10 dark:text-yellow-100">
      <div className="flex items-start gap-2">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{summary}</span>
      </div>
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
            className="mt-2 inline-flex min-h-[44px] min-w-[44px] items-center gap-1 rounded-xl border border-yellow-400/60 px-2 py-1 text-xs font-semibold active:bg-yellow-100 dark:active:bg-yellow-500/20"
          >
            {expanded
              ? <ChevronUp aria-hidden="true" className="h-4 w-4" />
              : <ChevronDown aria-hidden="true" className="h-4 w-4" />}
            {expanded
              ? label('settings.printQueue.hideDetails', 'Hide details')
              : label('settings.printQueue.showDetails', 'Show details')}
          </button>
          {expanded && (
            <p id={detailsId} className="mt-2 break-words border-t border-yellow-300 pt-2 text-xs dark:border-yellow-400/30">
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
    <div className="mt-2 flex flex-wrap gap-2">
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
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-xl border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 active:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-100 dark:active:bg-emerald-500/20"
          >
            <PlayCircle aria-hidden="true" className="h-4 w-4" />
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
  const queue = usePrintQueue({ limit, offset: 0 })
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

  return (
    <section
      aria-labelledby="print-queue-title"
      aria-busy={queue.loading}
      className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4 text-slate-800 dark:border-white/10 dark:bg-gray-900/40 dark:text-slate-100"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Printer aria-hidden="true" className="h-4 w-4 text-yellow-600 dark:text-yellow-300" />
            <h3 id="print-queue-title" className="text-sm font-semibold text-slate-900 dark:text-white">
              {label('settings.printQueue.posTitle', 'POS Print Queue')}
            </h3>
          </div>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
            {label(
              'settings.printQueue.posOnlyScope',
              'This panel controls only print jobs created by The Small POS. Jobs from other applications are never controlled here.',
            )}
          </p>

          {displaySnapshot && (
            <div
              role="status"
              aria-label={label('settings.printQueue.countsLabel', 'POS print queue counts')}
              className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300"
            >
              <span>{label('settings.printQueue.counts.active', `${displaySnapshot.counts.active} active`, { count: displaySnapshot.counts.active })}</span>
              <span>{label('settings.printQueue.counts.failed', `${displaySnapshot.counts.failed} failed`, { count: displaySnapshot.counts.failed })}</span>
              <span>{label('settings.printQueue.counts.stale', `${displaySnapshot.counts.stale} stale`, { count: displaySnapshot.counts.stale })}</span>
              <span>{label('settings.printQueue.counts.history', `${displaySnapshot.counts.history} history`, { count: displaySnapshot.counts.history })}</span>
            </div>
          )}

          {displayPausedPrinterProfileIds.length > 0 && (
            <div className="mt-2 text-[11px] text-yellow-800 dark:text-yellow-200">
              {visiblePausedProfileNames.size > 0 && (
                <span>
                  {label(
                    'settings.printQueue.visiblePausedPrinters',
                    `Paused: ${[...visiblePausedProfileNames.values()].join(', ')}`,
                    { printers: [...visiblePausedProfileNames.values()].join(', ') },
                  )}
                </span>
              )}
              {unnamedPausedCount > 0 && (
                <>
                  <span className={visiblePausedProfileNames.size > 0 ? 'ms-2' : undefined}>
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
        </div>

        <div className="grid w-full shrink-0 grid-cols-1 gap-2 md:w-56">
          <button
            type="button"
            aria-label={label('settings.printQueue.refreshAria', 'Refresh POS print queue')}
            onClick={() => void queue.refresh()}
            disabled={queue.loading}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition active:bg-slate-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-500 dark:border-white/15 dark:bg-white/10 dark:text-slate-100 dark:active:bg-white/20 dark:disabled:border-white/10 dark:disabled:bg-white/5 dark:disabled:text-slate-400"
          >
            <RefreshCw aria-hidden="true" className={`h-4 w-4 ${queue.loading ? 'animate-spin' : ''}`} />
            {label('settings.printQueue.refresh', 'Refresh')}
          </button>
          <button
            type="button"
            aria-label={displayQueuePaused
              ? label('settings.printQueue.resumeQueueAria', 'Resume POS print queue')
              : label('settings.printQueue.pauseQueueAria', 'Pause POS print queue')}
            onClick={handleQueuePauseToggle}
            disabled={queue.loading || anyMutationBusy}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl border border-yellow-400 bg-yellow-50 px-3 py-2 text-xs font-semibold text-yellow-900 transition active:bg-yellow-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-500 dark:border-yellow-400/35 dark:bg-yellow-400/10 dark:text-yellow-100 dark:active:bg-yellow-400/20 dark:disabled:border-white/10 dark:disabled:bg-white/5 dark:disabled:text-slate-400"
          >
            {displayQueuePaused
              ? <PlayCircle aria-hidden="true" className="h-4 w-4" />
              : <PauseCircle aria-hidden="true" className="h-4 w-4" />}
            {displayQueuePaused
              ? label('settings.printQueue.resume', 'Resume queue')
              : label('settings.printQueue.pause', 'Pause queue')}
          </button>
          <button
            type="button"
            aria-label={label('settings.printQueue.pauseCancelAria', 'Pause and cancel POS jobs')}
            onClick={() => setConfirmation({ kind: 'bulk' })}
            disabled={queue.loading || bulkMutationBusy}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 transition active:bg-rose-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-500 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-100 dark:active:bg-rose-500/20 dark:disabled:border-white/10 dark:disabled:bg-white/5 dark:disabled:text-slate-400"
          >
            <XCircle aria-hidden="true" className="h-4 w-4" />
            {label('settings.printQueue.pauseCancel', 'Pause and cancel POS jobs')}
          </button>
        </div>
      </div>

      {queue.stale && (
        <div
          role="status"
          aria-live="polite"
          aria-label={label('settings.printQueue.freshnessLabel', 'Print queue freshness')}
          className="mt-3 rounded-xl border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-900 dark:border-yellow-400/30 dark:bg-yellow-500/10 dark:text-yellow-100"
        >
          {hasAuthoritativeSnapshot
            ? label('settings.printQueue.stale', 'Queue data may be out of date. The last good data remains visible.')
            : label('settings.printQueue.unavailable', 'Queue status is unavailable. Refresh to try again.')}
        </div>
      )}

      {queue.error && (
        <div role="alert" className="mt-3 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-100">
          {label(
            hasAuthoritativeSnapshot
              ? 'settings.printQueue.loadFailedSafe'
              : 'settings.printQueue.initialLoadFailedSafe',
            hasAuthoritativeSnapshot
              ? 'Could not refresh the POS print queue. The last good data remains visible.'
              : 'Could not load the POS print queue. Current queue status is unavailable.',
          )}
        </div>
      )}

      {feedback && (
        <div
          role={feedback.kind === 'alert' ? 'alert' : 'status'}
          aria-live={feedback.kind !== 'alert' ? 'polite' : undefined}
          aria-label={feedback.kind !== 'alert'
            ? label('settings.printQueue.actionResultLabel', 'Print queue action result')
            : undefined}
          className={`mt-3 rounded-xl border px-3 py-2 text-xs ${feedback.kind === 'alert'
            ? 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-100'
            : feedback.kind === 'warning'
              ? 'border-yellow-300 bg-yellow-50 text-yellow-900 dark:border-yellow-400/30 dark:bg-yellow-500/10 dark:text-yellow-100'
              : 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-100'}`}
        >
          {feedback.message}
        </div>
      )}

      <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 dark:border-white/10">
        {queue.loading && !hasAuthoritativeSnapshot ? (
          <div
            role="status"
            aria-live="polite"
            aria-label={label('settings.printQueue.loadingLabel', 'Loading POS print queue')}
            className="px-3 py-5 text-sm text-slate-600 dark:text-slate-300"
          >
            {label('settings.printQueue.loading', 'Loading POS print jobs…')}
          </div>
        ) : !hasAuthoritativeSnapshot ? (
          <div className="px-3 py-5 text-sm text-slate-600 dark:text-slate-300">
            {label('settings.printQueue.unavailableBody', 'POS print queue is currently unavailable.')}
          </div>
        ) : displayJobs.length === 0 ? (
          <div className="px-3 py-5 text-sm text-slate-600 dark:text-slate-300">
            {label('settings.printQueue.empty', 'No POS print jobs are available.')}
          </div>
        ) : (
          <ul className="max-h-96 list-none divide-y divide-slate-200 overflow-y-auto p-0 scrollbar-hide dark:divide-white/10">
            {displayJobs.map((job: PrintQueueJob, index) => {
              const { entityLabel, rowContext, duplicateContext } = rowPresentations[index]
              const actionContext = displayJobs.length > 1 ? rowContext : null
              const articleLabel = label(
                'settings.printQueue.jobArticleAria',
                `POS print job: ${rowContext}`,
                { context: rowContext },
              )
              const issueSummary = job.warningMessage
                ? operatorSafeDetail(job.warningMessage)
                : job.lastError
                  ? label('settings.printQueue.issue.genericAttention', 'This POS print job needs attention.')
                  : null
              const printerPaused = Boolean(
                job.printerProfileId
                && displayPausedPrinterProfileIds.includes(job.printerProfileId),
              )
              const lastSeen = job.lastSeenAt
              const jobBusy = anyMutationBusy
              return (
                <li key={job.id} className="p-0">
                  <article
                    aria-label={articleLabel}
                    className="grid gap-3 px-3 py-3 text-sm md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)]"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {entityLabel}
                      </div>
                      {highlightedNewJobId === job.id && (
                        <span className="mt-1 inline-flex rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200">
                          {label('settings.printQueue.newReprint', 'New reprint')}
                        </span>
                      )}
                      <div className="mt-1 text-xs text-slate-700 dark:text-slate-200">
                        {job.printerDisplayName}
                      </div>
                      {job.resolvedTarget && (
                        <div className="break-words text-[11px] text-slate-600 dark:text-slate-400">
                          {job.resolvedTarget}
                        </div>
                      )}
                      <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                        {label('settings.printQueue.updatedAt', `Updated ${formatTimestamp(job.updatedAt)}`, {
                          value: formatTimestamp(job.updatedAt),
                        })}
                      </div>
                      {lastSeen && (
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {label('settings.printQueue.lastSeenAt', `Last seen ${formatTimestamp(lastSeen)}`, {
                            value: formatTimestamp(lastSeen),
                          })}
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2 md:grid-cols-1">
                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-2 py-2 dark:border-white/10 dark:bg-white/5">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                          {label('settings.printQueue.localStatus', 'POS status')}
                        </div>
                        <div className="mt-1 text-xs font-semibold text-slate-800 dark:text-slate-100">
                          {statusLabel(job.status)}
                        </div>
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-2 py-2 dark:border-white/10 dark:bg-white/5">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                          {label('settings.printQueue.transportStatus', 'Transport status')}
                        </div>
                        <div className="mt-1 text-xs font-semibold text-slate-800 dark:text-slate-100">
                          {transportLabel(job.transportState)}
                        </div>
                      </div>
                    </div>

                    <div className="flex min-w-0 flex-col gap-2">
                      {issueSummary && (
                        <PrintQueueIssue
                          summary={issueSummary}
                          details={job.lastError ? operatorSafeDetail(job.lastError) : null}
                          actionContext={actionContext}
                          label={label}
                        />
                      )}

                      <div className="flex flex-wrap gap-2">
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
                            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-xl border border-rose-300 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700 active:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-100 dark:active:bg-rose-500/20"
                          >
                            <XCircle aria-hidden="true" className="h-4 w-4" />
                            {label('settings.printQueue.cancel', 'Cancel')}
                          </button>
                        )}
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
                            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-xl border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 active:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-100 dark:active:bg-emerald-500/20"
                          >
                            <RotateCcw aria-hidden="true" className="h-4 w-4" />
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
                            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-xl border border-yellow-400 bg-yellow-50 px-2 py-1 text-xs font-semibold text-yellow-900 active:bg-yellow-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-yellow-400/35 dark:bg-yellow-400/10 dark:text-yellow-100 dark:active:bg-yellow-400/20"
                          >
                            <Printer aria-hidden="true" className="h-4 w-4" />
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
                            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-xl border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 active:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-100 dark:active:bg-emerald-500/20"
                          >
                            <PlayCircle aria-hidden="true" className="h-4 w-4" />
                            {label('settings.printQueue.resumePrinter', 'Resume')}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {displaySnapshot && (
        <div className="mt-3 flex flex-col items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
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
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 active:bg-slate-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-500 dark:border-white/15 dark:bg-white/10 dark:text-slate-100 dark:active:bg-white/20 dark:disabled:border-white/10 dark:disabled:bg-white/5 dark:disabled:text-slate-400"
            >
              {label('settings.printQueue.showMore', 'Show more')}
            </button>
          )}
        </div>
      )}

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
