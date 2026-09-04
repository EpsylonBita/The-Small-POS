import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Camera,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  Plus,
  Printer,
  RefreshCw,
  Search,
  ShieldAlert,
  Smartphone,
  Wrench,
  Zap,
} from 'lucide-react'
import type {
  RepairAttachmentSnapshot,
  RepairAttachmentPolicySnapshot,
  RepairCommand,
  RepairConflictResolution,
  RepairConflictSnapshot,
  RepairListItemSnapshot,
  RepairPaginationSnapshot,
  RepairPriority,
  RepairStatus,
  RepairSyncState,
  RepairWorkspaceSnapshot,
} from './contracts'
import { RepairWorkspaceActions } from './RepairWorkspaceActions'
import type { RepairCatalogItem, RepairCatalogKind } from './RepairCatalogService'
import { RepairMoneyPanel, type RepairMoneyService } from './RepairMoneyPanel'
import type { RepairConnectivity } from './policy'
import { CustomerMessagingPanel } from '../customer-messaging/CustomerMessagingPanel'

export type RepairTabId =
  | 'overview'
  | 'diagnosis'
  | 'partsLabour'
  | 'estimateApproval'
  | 'timeline'
  | 'photos'
  | 'payments'
  | 'communication'

type DueFilter = 'all' | 'overdue'

interface RepairsShellProps {
  repairs: RepairListItemSnapshot[]
  pagination?: RepairPaginationSnapshot | null
  workspace: RepairWorkspaceSnapshot | null
  attachments: RepairAttachmentSnapshot[]
  conflicts: RepairConflictSnapshot[]
  isLoading: boolean
  isOffline: boolean
  quickServiceEnabled: boolean
  canCreateRepair?: boolean
  canResolveConflicts?: boolean
  notificationState?: string | null
  onRefresh: () => void
  onListQueryChange?: (query: { status: RepairStatus | null; search: string | null; offset: number }) => void
  onSelectRepair: (repairId: string) => void
  onNewRepair: () => void
  onQuickService: () => void
  onResolveConflict: (
    conflictId: string,
    resolution: RepairConflictResolution,
  ) => void
  attachmentPolicy?: RepairAttachmentPolicySnapshot | null
  connectivity?: RepairConnectivity
  hasActiveShift?: boolean
  currentStaffId?: string | null
  isMutating?: boolean
  onExecuteCommand?: (command: RepairCommand) => Promise<void>
  onStagePhoto?: (file: File) => Promise<void>
  onOpenAttachment?: (attachmentId: string) => void
  onCatalogSearch?: (kind: RepairCatalogKind, query: string) => Promise<RepairCatalogItem[]>
  onCatalogBarcodeLookup?: (barcode: string) => Promise<RepairCatalogItem | null>
  repairDepositSupported?: boolean
  moneyService?: RepairMoneyService
  onMoneyBusyChange?: (busy: boolean) => void
  onAuthoritativeRefresh?: (repairId: string) => Promise<void>
  onPrintRepair?: (kind: 'repair_intake' | 'repair_label') => Promise<void>
}

const TAB_IDS: RepairTabId[] = [
  'overview',
  'diagnosis',
  'partsLabour',
  'estimateApproval',
  'timeline',
  'photos',
  'payments',
  'communication',
]

const TERMINAL_STATUSES = new Set<RepairStatus>([
  'delivered',
  'cancelled',
  'unrepairable',
])

const TIMELINE_EVENT_KEYS: Readonly<Record<string, string>> = {
  created: 'repairs.timeline.created',
  status_changed: 'repairs.timeline.status_changed',
  note_added: 'repairs.timeline.note_added',
  assignment_changed: 'repairs.timeline.assignment_changed',
  diagnosis_updated: 'repairs.timeline.diagnosis_updated',
  line_changed: 'repairs.timeline.line_changed',
  part_consumed: 'repairs.timeline.part_consumed',
  part_reversed: 'repairs.timeline.part_reversed',
  estimate_created: 'repairs.timeline.estimate_created',
  approval_recorded: 'repairs.timeline.approval_recorded',
  attachment_added: 'repairs.timeline.attachment_added',
  attachment_retention_changed: 'repairs.timeline.attachment_retention_changed',
  settlement_linked: 'repairs.timeline.settlement_linked',
  branch_transferred: 'repairs.timeline.branch_transferred',
  reopened: 'repairs.timeline.reopened',
}

const cardClass =
  'rounded-2xl border border-slate-200 bg-white/85 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-zinc-950/75'

function isRepairOverdue(repair: RepairListItemSnapshot, now: number): boolean {
  if (!repair.dueAt || TERMINAL_STATUSES.has(repair.status)) return false
  const due = Date.parse(repair.dueAt)
  return Number.isFinite(due) && due < now
}

function LockedSurface({
  icon: Icon,
  message,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  message: string
}) {
  return (
    <div className="flex gap-3 rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 text-sm text-amber-950 dark:text-amber-100">
      <Icon aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
      <p>{message}</p>
    </div>
  )
}

function RepairStatusPill({
  status,
  syncState,
}: {
  status: RepairStatus
  syncState: RepairSyncState
}) {
  const { t } = useTranslation()
  const tone = status === 'ready'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
    : status === 'cancelled' || status === 'unrepairable'
      ? 'border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-200'
      : 'border-blue-500/30 bg-blue-500/10 text-blue-800 dark:text-blue-200'

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${tone}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {t(`repairs.status.${status}`)}
      {syncState !== 'synced' && (
        <span className="font-normal opacity-80">· {t(`repairs.sync.${syncState === 'queued' ? 'pending' : syncState}`)}</span>
      )}
    </span>
  )
}

function RepairConflictInbox({
  conflicts,
  onResolve,
  canResolve,
}: {
  conflicts: RepairConflictSnapshot[]
  onResolve: RepairsShellProps['onResolveConflict']
  canResolve: boolean
}) {
  const { t } = useTranslation()

  return (
    <section
      aria-label={t('repairs.panels.conflictsTitle')}
      className={`${cardClass} p-4`}
      role="region"
    >
      <div className="mb-3 flex items-center gap-2">
        <ShieldAlert aria-hidden className="h-5 w-5 text-amber-500" />
        <h2 className="text-base font-semibold text-slate-900 dark:text-white">
          {t('repairs.panels.conflictsTitle')}
        </h2>
      </div>
      {conflicts.length > 0 && !canResolve && (
        <p id="repair-conflict-disabled-reason" className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          {t('repairs.messages.conflictResolutionUnavailable')}
        </p>
      )}
      {conflicts.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-zinc-400">
          {t('repairs.panels.conflictsEmpty')}
        </p>
      ) : (
        <ul className="space-y-3">
          {conflicts.map((conflict) => (
            <li key={conflict.conflictId} className="rounded-xl border border-amber-500/25 p-3">
              <p className="font-semibold text-slate-900 dark:text-white">
                {conflict.displayNumber ?? t('repairs.fields.notRecorded')}
              </p>
              <p className="mt-1 text-xs text-slate-600 dark:text-zinc-400">
                {t(`repairs.status.${conflict.status}`)} · v{conflict.expectedVersion} → v{conflict.currentVersion}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!canResolve}
                  aria-describedby={!canResolve ? 'repair-conflict-disabled-reason' : undefined}
                  className="min-h-11 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-45 dark:border-white/15"
                  onClick={() => onResolve(conflict.conflictId, 'accept_server')}
                >
                  {t('repairs.actions.acceptServer')}
                </button>
                <button
                  type="button"
                  disabled={!canResolve}
                  aria-describedby={!canResolve ? 'repair-conflict-disabled-reason' : undefined}
                  className="min-h-11 rounded-xl bg-amber-500 px-3 py-2 text-sm font-semibold text-black disabled:opacity-45"
                  onClick={() => onResolve(conflict.conflictId, 'rebase')}
                >
                  {t('repairs.actions.rebase')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function WorkspacePanel({
  tab,
  workspace,
  attachments,
  attachmentPolicy,
  connectivity,
  hasActiveShift,
  currentStaffId,
  isMutating,
  onExecuteCommand,
  onStagePhoto,
  onOpenAttachment,
  onCatalogSearch,
  onCatalogBarcodeLookup,
  repairDepositSupported,
  moneyService,
  onMoneyBusyChange,
  onAuthoritativeRefresh,
  onPrintRepair,
}: {
  tab: RepairTabId
  workspace: RepairWorkspaceSnapshot
  attachments: RepairAttachmentSnapshot[]
  attachmentPolicy: RepairAttachmentPolicySnapshot | null
  connectivity: RepairConnectivity
  hasActiveShift: boolean
  currentStaffId: string | null
  isMutating: boolean
  onExecuteCommand?: (command: RepairCommand) => Promise<void>
  onStagePhoto?: (file: File) => Promise<void>
  onOpenAttachment?: (attachmentId: string) => void
  onCatalogSearch?: (kind: RepairCatalogKind, query: string) => Promise<RepairCatalogItem[]>
  onCatalogBarcodeLookup?: (barcode: string) => Promise<RepairCatalogItem | null>
  repairDepositSupported: boolean
  moneyService?: RepairMoneyService
  onMoneyBusyChange: (busy: boolean) => void
  onAuthoritativeRefresh: (repairId: string) => Promise<void>
  onPrintRepair?: (kind: 'repair_intake' | 'repair_label') => Promise<void>
}) {
  const { t, i18n } = useTranslation()
  const repair = workspace.repair
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  )
  const actions = onExecuteCommand && onStagePhoto ? (
    <RepairWorkspaceActions
      tab={tab}
      workspace={workspace}
      attachmentPolicy={attachmentPolicy}
      connectivity={connectivity}
      hasActiveShift={hasActiveShift}
      currentStaffId={currentStaffId}
      isBusy={isMutating}
      onExecuteCommand={onExecuteCommand}
      onStagePhoto={onStagePhoto}
      onCatalogSearch={onCatalogSearch}
      onCatalogBarcodeLookup={onCatalogBarcodeLookup}
    />
  ) : null

  if (tab === 'overview') {
    return (
      <div className="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div><dt className="text-xs font-semibold uppercase text-slate-500">{t('repairs.fields.customer')}</dt><dd className="mt-1 text-sm">{workspace.customer?.displayName ?? t('repairs.fields.anonymous')}</dd></div>
          <div><dt className="text-xs font-semibold uppercase text-slate-500">{t('repairs.fields.device')}</dt><dd className="mt-1 text-sm">{workspace.device?.label || [workspace.device?.manufacturer, workspace.device?.model].filter(Boolean).join(' ') || t('repairs.fields.notRecorded')}</dd></div>
          <div><dt className="text-xs font-semibold uppercase text-slate-500">{t('repairs.fields.assignedTo')}</dt><dd className="mt-1 text-sm">{repair.assignedStaffId ? t('repairs.fields.assigned') : t('repairs.fields.unassigned')}</dd></div>
          <div><dt className="text-xs font-semibold uppercase text-slate-500">{t('repairs.fields.dueAt')}</dt><dd className="mt-1 text-sm">{repair.dueAt ? dateFormatter.format(new Date(repair.dueAt)) : t('repairs.fields.notRecorded')}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs font-semibold uppercase text-slate-500">{t('repairs.fields.intakeNotes')}</dt><dd className="mt-1 whitespace-pre-wrap text-sm">{repair.intakeNotes || t('repairs.fields.notRecorded')}</dd></div>
        </dl>
        {onPrintRepair ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={connectivity !== 'online' || !hasActiveShift || isMutating} onClick={() => void onPrintRepair('repair_intake')} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-blue-500 px-4 text-sm font-semibold disabled:opacity-45"><Printer aria-hidden className="h-4 w-4" />{t('repairs.actions.printIntake', { defaultValue: 'Print intake' })}</button>
            <button type="button" disabled={connectivity !== 'online' || !hasActiveShift || isMutating} onClick={() => void onPrintRepair('repair_label')} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-blue-500 px-4 text-sm font-semibold disabled:opacity-45"><Printer aria-hidden className="h-4 w-4" />{t('repairs.actions.printLabel', { defaultValue: 'Print label' })}</button>
          </div>
        ) : <LockedSurface icon={Wrench} message={t('repairs.locked.printing')} />}
        {actions}
      </div>
    )
  }

  if (tab === 'diagnosis') {
    return (
      <div className="space-y-4">
        <h3 className="text-base font-semibold">{t('repairs.tabs.diagnosis')}</h3>
        <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700 dark:text-zinc-300">
          {repair.diagnosis || t('repairs.fields.notRecorded')}
        </p>
        {actions}
      </div>
    )
  }

  if (tab === 'partsLabour') {
    return (
      <div className="space-y-4">
        {workspace.lines.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-zinc-400">{t('repairs.panels.partsEmpty')}</p>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-white/10">
            {workspace.lines.map((line) => (
              <li key={line.id} className="flex justify-between gap-4 py-3 text-sm">
                <span>{line.nameSnapshot}</span>
                <span>{line.quantity} × {line.unitPriceSnapshot.toFixed(2)} {repair.currency}</span>
              </li>
            ))}
          </ul>
        )}
        {!onCatalogSearch && <LockedSurface icon={Search} message={t('repairs.locked.catalog')} />}
        {actions}
      </div>
    )
  }

  if (tab === 'estimateApproval') {
    return (
      <div className="space-y-4">
        {workspace.estimates.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-zinc-400">{t('repairs.panels.estimateEmpty')}</p>
        ) : (
          <ul className="space-y-3">
            {workspace.estimates.map((estimate) => (
              <li key={estimate.id} className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
                <span className="font-semibold">v{estimate.version}</span>
                <span className="float-right font-semibold">{estimate.totalAmount.toFixed(2)} {estimate.currency}</span>
              </li>
            ))}
          </ul>
        )}
        {actions}
      </div>
    )
  }

  if (tab === 'timeline') {
    return workspace.timeline.length === 0 ? (
      <p className="text-sm text-slate-600 dark:text-zinc-400">{t('repairs.panels.timelineEmpty')}</p>
    ) : (
      <ol className="space-y-3">
        {workspace.timeline.map((event) => (
          <li key={event.id} className="flex gap-3 text-sm">
            <Clock3 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
            <span>{t(TIMELINE_EVENT_KEYS[event.eventType] ?? 'repairs.timeline.unknown')}</span>
            <time className="ml-auto text-slate-500">{dateFormatter.format(new Date(event.occurredAt))}</time>
          </li>
        ))}
      </ol>
    )
  }

  if (tab === 'photos') {
    return (
      <div className="space-y-4">
        {attachments.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-zinc-400">{t('repairs.panels.photosEmpty')}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {attachments.map((attachment) => (
              <li key={attachment.id} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 dark:border-white/10">
                <Camera aria-hidden className="h-5 w-5 text-blue-500" />
                <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{attachment.mimeType}</p><p className="text-xs text-slate-500">{Math.ceil(attachment.byteSize / 1024)} KB</p></div>
                <button
                  type="button"
                  disabled={connectivity !== 'online' || !onOpenAttachment || isMutating}
                  onClick={() => onOpenAttachment?.(attachment.id)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/15"
                >
                  <ExternalLink aria-hidden className="h-4 w-4" />
                  {t('repairs.actions.openAttachment')}
                </button>
              </li>
            ))}
          </ul>
        )}
        {actions}
      </div>
    )
  }

  if (tab === 'payments') {
    const latestEstimate = [...workspace.estimates]
      .sort((left, right) => right.version - left.version)[0] ?? null
    const hasAcceptedEstimate = latestEstimate !== null && workspace.approvals.some((approval) => (
      approval.decision === 'accepted'
      && approval.estimateId === latestEstimate.id
      && approval.estimateVersion === latestEstimate.version
    ))
    return <RepairMoneyPanel
      repairId={repair.id}
      repairVersion={repair.version}
      repairStatus={repair.status}
      currency={repair.currency}
      capabilities={workspace.capabilities}
      allowedTransitions={workspace.allowedTransitions}
      hasAcceptedEstimate={hasAcceptedEstimate}
      repairDepositSupported={repairDepositSupported}
      connectivity={connectivity}
      hasActiveShift={hasActiveShift}
      isBusy={isMutating}
      moneyService={moneyService}
      onBusyChange={onMoneyBusyChange}
      onAuthoritativeRefresh={onAuthoritativeRefresh}
    />
  }

  return <CustomerMessagingPanel
    customerId={workspace.customer?.id ?? null}
    repairId={repair.id}
    repairVersion={repair.version}
    repairNumber={repair.displayNumber}
    customerName={workspace.customer?.displayName ?? t('repairs.fields.anonymous')}
    deviceLabel={workspace.device?.label || [workspace.device?.manufacturer, workspace.device?.model].filter(Boolean).join(' ') || t('repairs.fields.notRecorded')}
    online={connectivity === 'online'}
  />
}

function RepairWorkspace({
  workspace,
  attachments,
  attachmentPolicy,
  connectivity,
  hasActiveShift,
  currentStaffId,
  isMutating,
  onExecuteCommand,
  onStagePhoto,
  onOpenAttachment,
  onCatalogSearch,
  onCatalogBarcodeLookup,
  repairDepositSupported,
  moneyService,
  onMoneyBusyChange,
  onAuthoritativeRefresh,
  onPrintRepair,
}: {
  workspace: RepairWorkspaceSnapshot
  attachments: RepairAttachmentSnapshot[]
  attachmentPolicy: RepairAttachmentPolicySnapshot | null
  connectivity: RepairConnectivity
  hasActiveShift: boolean
  currentStaffId: string | null
  isMutating: boolean
  onExecuteCommand?: (command: RepairCommand) => Promise<void>
  onStagePhoto?: (file: File) => Promise<void>
  onOpenAttachment?: (attachmentId: string) => void
  onCatalogSearch?: (kind: RepairCatalogKind, query: string) => Promise<RepairCatalogItem[]>
  onCatalogBarcodeLookup?: (barcode: string) => Promise<RepairCatalogItem | null>
  repairDepositSupported: boolean
  moneyService?: RepairMoneyService
  onMoneyBusyChange: (busy: boolean) => void
  onAuthoritativeRefresh: (repairId: string) => Promise<void>
  onPrintRepair?: (kind: 'repair_intake' | 'repair_label') => Promise<void>
}) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<RepairTabId>('overview')
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const selectTab = (index: number) => {
    const normalizedIndex = (index + TAB_IDS.length) % TAB_IDS.length
    setActiveTab(TAB_IDS[normalizedIndex])
    tabRefs.current[normalizedIndex]?.focus()
  }

  return (
    <section className={`${cardClass} flex min-h-0 flex-col overflow-hidden`} aria-label={t('repairs.a11y.currentRepair', { number: workspace.repair.displayNumber })}>
      <header className="border-b border-slate-200 p-4 dark:border-white/10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-lg font-bold text-slate-950 dark:text-white">{workspace.repair.displayNumber}</p>
            <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">
              {workspace.device?.label || [workspace.device?.manufacturer, workspace.device?.model].filter(Boolean).join(' ') || t('repairs.fields.notRecorded')}
            </p>
          </div>
          <RepairStatusPill status={workspace.repair.status} syncState={workspace.syncState} />
        </div>
      </header>
      <div
        aria-label={t('repairs.a11y.tabHint')}
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 px-3 py-2 dark:border-white/10"
        role="tablist"
      >
        {TAB_IDS.map((tab, index) => (
          <button
            key={tab}
            ref={(node) => { tabRefs.current[index] = node }}
            id={`repair-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`repair-panel-${tab}`}
            tabIndex={activeTab === tab ? 0 : -1}
            onClick={() => setActiveTab(tab)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault()
                selectTab(index + 1)
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault()
                selectTab(index - 1)
              } else if (event.key === 'Home') {
                event.preventDefault()
                selectTab(0)
              } else if (event.key === 'End') {
                event.preventDefault()
                selectTab(TAB_IDS.length - 1)
              }
            }}
            className={`min-h-11 shrink-0 rounded-xl px-3 py-2 text-sm font-semibold ${activeTab === tab ? 'bg-blue-600 text-white' : 'text-slate-700 dark:text-zinc-300'}`}
          >
            {t(`repairs.tabs.${tab}`)}
          </button>
        ))}
      </div>
      <div
        id={`repair-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`repair-tab-${activeTab}`}
        className="min-h-0 flex-1 overflow-y-auto p-4 text-slate-900 dark:text-white"
      >
        <WorkspacePanel tab={activeTab} workspace={workspace} attachments={attachments} attachmentPolicy={attachmentPolicy} connectivity={connectivity} hasActiveShift={hasActiveShift} currentStaffId={currentStaffId} isMutating={isMutating} onExecuteCommand={onExecuteCommand} onStagePhoto={onStagePhoto} onOpenAttachment={onOpenAttachment} onCatalogSearch={onCatalogSearch} onCatalogBarcodeLookup={onCatalogBarcodeLookup} repairDepositSupported={repairDepositSupported} moneyService={moneyService} onMoneyBusyChange={onMoneyBusyChange} onAuthoritativeRefresh={onAuthoritativeRefresh} onPrintRepair={onPrintRepair} />
      </div>
    </section>
  )
}

export function RepairsShell({
  repairs,
  pagination = null,
  workspace,
  attachments,
  conflicts,
  isLoading,
  isOffline,
  quickServiceEnabled,
  canCreateRepair = false,
  canResolveConflicts = false,
  notificationState,
  onRefresh,
  onListQueryChange,
  onSelectRepair,
  onNewRepair,
  onQuickService,
  onResolveConflict,
  attachmentPolicy = null,
  connectivity = 'unknown',
  hasActiveShift = false,
  currentStaffId = null,
  isMutating = false,
  onExecuteCommand,
  onStagePhoto,
  onOpenAttachment,
  onCatalogSearch,
  onCatalogBarcodeLookup,
  repairDepositSupported = false,
  moneyService,
  onMoneyBusyChange = () => undefined,
  onAuthoritativeRefresh = async () => undefined,
  onPrintRepair,
}: RepairsShellProps) {
  const { t, i18n } = useTranslation()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | RepairStatus>('all')
  const [priorityFilter, setPriorityFilter] = useState<'all' | RepairPriority>('all')
  const [dueFilter, setDueFilter] = useState<DueFilter>('all')
  const [syncFilter, setSyncFilter] = useState<'all' | RepairSyncState>('all')
  const didMountListQuery = useRef(false)
  const onListQueryChangeRef = useRef(onListQueryChange)
  onListQueryChangeRef.current = onListQueryChange

  useEffect(() => {
    if (!didMountListQuery.current) {
      didMountListQuery.current = true
      return
    }
    const timer = window.setTimeout(() => {
      onListQueryChangeRef.current?.({
        status: statusFilter === 'all' ? null : statusFilter,
        search: search.trim() || null,
        offset: 0,
      })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search, statusFilter])

  const filteredRepairs = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase(i18n.language)
    const now = Date.now()
    return repairs.filter((repair) => {
      if (statusFilter !== 'all' && repair.status !== statusFilter) return false
      if (priorityFilter !== 'all' && repair.priority !== priorityFilter) return false
      if (syncFilter !== 'all' && repair.syncState !== syncFilter) return false
      if (dueFilter === 'overdue' && !isRepairOverdue(repair, now)) return false
      if (!needle) return true
      const haystack = [repair.displayNumber, ...repair.aliases, repair.safeDeviceLabel ?? '']
        .join(' ')
        .toLocaleLowerCase(i18n.language)
      return haystack.includes(needle)
    })
  }, [dueFilter, i18n.language, priorityFilter, repairs, search, statusFilter, syncFilter])

  const showQueuedReady = notificationState === 'queued_after_sync'

  return (
    <main className="flex h-full min-h-0 flex-col gap-4 overflow-hidden p-4 text-slate-950 dark:text-white">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('repairs.title')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-zinc-400">{t('repairs.subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onRefresh} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold dark:border-white/15" aria-label={t('repairs.refresh')}>
            <RefreshCw aria-hidden className="h-4 w-4" />
            {t('repairs.refresh')}
          </button>
          <button type="button" disabled={!canCreateRepair || !hasActiveShift} aria-describedby={!canCreateRepair || !hasActiveShift ? 'repair-create-disabled-reason' : undefined} onClick={onNewRepair} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            <Plus aria-hidden className="h-4 w-4" />
            {t('repairs.newRepair')}
          </button>
          <button type="button" disabled={!quickServiceEnabled || !canCreateRepair || !hasActiveShift} onClick={onQuickService} aria-describedby={!quickServiceEnabled || !canCreateRepair || !hasActiveShift ? 'repair-create-disabled-reason' : undefined} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50">
            <Zap aria-hidden className="h-4 w-4" />
            {t('repairs.quickService')}
          </button>
        </div>
        {(!canCreateRepair || !hasActiveShift) && <p id="repair-create-disabled-reason" className="w-full text-right text-xs text-slate-600 dark:text-zinc-400">{t('repairs.messages.createUnavailable')}</p>}
        {canCreateRepair && hasActiveShift && !quickServiceEnabled && <p className="w-full text-right text-xs text-slate-600 dark:text-zinc-400">{t('repairs.messages.settingsUnavailable')}</p>}
      </header>

      {(isOffline || showQueuedReady) && (
        <div role="status" aria-live="polite" className="flex shrink-0 gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-950 dark:text-blue-100">
          <AlertTriangle aria-hidden className="h-5 w-5 shrink-0" />
          <div>
            {isOffline && <p>{t('repairs.messages.offline')}</p>}
            {showQueuedReady && <p className="font-semibold">{t('repairs.messages.readyQueued')}</p>}
            {showQueuedReady && <p>{t('repairs.messages.noNotificationSent')}</p>}
          </div>
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.6fr)]">
        <aside className={`${cardClass} flex min-h-0 flex-col overflow-hidden`} aria-label={t('repairs.title')}>
          <div className="space-y-3 border-b border-slate-200 p-4 dark:border-white/10">
            <label className="block">
              <span className="mb-1 block text-sm font-semibold">{t('repairs.searchLabel')}</span>
              <span className="relative block">
                <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('repairs.searchPlaceholder')} className="min-h-11 w-full rounded-xl border border-slate-300 bg-transparent py-2 pl-10 pr-3 text-sm dark:border-white/15" />
              </span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs font-semibold">{t('repairs.filters.status')}<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-2 text-sm dark:border-white/15 dark:bg-zinc-900"><option value="all">{t('repairs.filters.all')}</option>{(['received', 'diagnosing', 'waiting_customer_approval', 'approved', 'waiting_parts', 'repairing', 'quality_check', 'ready', 'delivered', 'cancelled', 'unrepairable'] as RepairStatus[]).map((status) => <option key={status} value={status}>{t(`repairs.status.${status}`)}</option>)}</select></label>
              <label className="text-xs font-semibold">{t('repairs.filters.priority')}<select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as typeof priorityFilter)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-2 text-sm dark:border-white/15 dark:bg-zinc-900"><option value="all">{t('repairs.filters.all')}</option>{(['low', 'normal', 'high', 'urgent'] as RepairPriority[]).map((priority) => <option key={priority} value={priority}>{t(`repairs.priority.${priority}`)}</option>)}</select></label>
              <label className="text-xs font-semibold">{t('repairs.filters.due')}<select value={dueFilter} onChange={(event) => setDueFilter(event.target.value as DueFilter)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-2 text-sm dark:border-white/15 dark:bg-zinc-900"><option value="all">{t('repairs.filters.all')}</option><option value="overdue">{t('repairs.filters.overdue')}</option></select></label>
              <label className="text-xs font-semibold">{t('repairs.filters.sync')}<select value={syncFilter} onChange={(event) => setSyncFilter(event.target.value as typeof syncFilter)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-2 text-sm dark:border-white/15 dark:bg-zinc-900"><option value="all">{t('repairs.filters.all')}</option>{(['synced', 'queued', 'conflict', 'needs_refetch'] as RepairSyncState[]).map((sync) => <option key={sync} value={sync}>{t(`repairs.sync.${sync === 'queued' ? 'pending' : sync}`)}</option>)}</select></label>
            </div>
          </div>
          <p className="sr-only" aria-live="polite">{t('repairs.a11y.resultsUpdated', { count: filteredRepairs.length })}</p>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {isLoading ? (
              <p className="p-4 text-sm text-slate-600 dark:text-zinc-400">{t('repairs.list.loading')}</p>
            ) : filteredRepairs.length === 0 ? (
              <p className="p-4 text-sm text-slate-600 dark:text-zinc-400">{t('repairs.list.empty')}</p>
            ) : (
              <ul className="space-y-2">
                {filteredRepairs.map((repair) => {
                  const overdue = isRepairOverdue(repair, Date.now())
                  const selected = workspace?.repair.id === repair.id
                  return (
                    <li key={repair.id}>
                      <button type="button" aria-current={selected ? 'true' : undefined} onClick={() => onSelectRepair(repair.id)} className={`min-h-11 w-full rounded-xl border p-3 text-left ${selected ? 'border-blue-500 bg-blue-500/10' : 'border-transparent hover:bg-slate-100 dark:hover:bg-white/5'}`}>
                        <span className="flex items-start justify-between gap-2"><span className="font-bold">{repair.displayNumber}</span><RepairStatusPill status={repair.status} syncState={repair.syncState} /></span>
                        <span className="mt-2 flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-400"><Smartphone aria-hidden className="h-4 w-4" />{repair.safeDeviceLabel || t('repairs.fields.notRecorded')}</span>
                        {repair.aliases.length > 0 && <span className="mt-1 block text-xs text-slate-500">{t('repairs.list.aliases', { aliases: repair.aliases.join(', ') })}</span>}
                        {overdue && <span className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-red-600 dark:text-red-300"><AlertTriangle aria-hidden className="h-3.5 w-3.5" />{t('repairs.list.overdue')}</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          {pagination && pagination.count > pagination.limit && (
            <nav aria-label={t('repairs.pagination.label')} className="flex items-center justify-between gap-2 border-t border-slate-200 p-3 text-xs dark:border-white/10">
              <button
                type="button"
                disabled={isLoading || pagination.offset === 0}
                onClick={() => onListQueryChangeRef.current?.({
                  status: statusFilter === 'all' ? null : statusFilter,
                  search: search.trim() || null,
                  offset: Math.max(0, pagination.offset - pagination.limit),
                })}
                className="min-h-11 rounded-xl border border-slate-300 px-3 font-semibold disabled:opacity-45 dark:border-white/15"
              >
                {t('repairs.pagination.previous')}
              </button>
              <span>{t('repairs.pagination.summary', {
                start: pagination.offset + 1,
                end: Math.min(pagination.count, pagination.offset + pagination.limit),
                total: pagination.count,
              })}</span>
              <button
                type="button"
                disabled={isLoading || pagination.offset + pagination.limit >= pagination.count}
                onClick={() => onListQueryChangeRef.current?.({
                  status: statusFilter === 'all' ? null : statusFilter,
                  search: search.trim() || null,
                  offset: pagination.offset + pagination.limit,
                })}
                className="min-h-11 rounded-xl border border-slate-300 px-3 font-semibold disabled:opacity-45 dark:border-white/15"
              >
                {t('repairs.pagination.next')}
              </button>
            </nav>
          )}
        </aside>

        <div className="grid min-h-0 gap-4 xl:grid-rows-[minmax(0,1fr)_auto]">
          {workspace ? (
            <RepairWorkspace workspace={workspace} attachments={attachments} attachmentPolicy={attachmentPolicy} connectivity={connectivity} hasActiveShift={hasActiveShift} currentStaffId={currentStaffId} isMutating={isMutating} onExecuteCommand={onExecuteCommand} onStagePhoto={onStagePhoto} onOpenAttachment={onOpenAttachment} onCatalogSearch={onCatalogSearch} onCatalogBarcodeLookup={onCatalogBarcodeLookup} repairDepositSupported={repairDepositSupported} moneyService={moneyService} onMoneyBusyChange={onMoneyBusyChange} onAuthoritativeRefresh={onAuthoritativeRefresh} onPrintRepair={onPrintRepair} />
          ) : (
            <section className={`${cardClass} flex min-h-52 items-center justify-center p-8 text-center text-sm text-slate-600 dark:text-zinc-400`}>
              {t('repairs.list.select')}
            </section>
          )}
          <RepairConflictInbox conflicts={conflicts} onResolve={onResolveConflict} canResolve={canResolveConflicts} />
        </div>
      </div>
    </main>
  )
}
