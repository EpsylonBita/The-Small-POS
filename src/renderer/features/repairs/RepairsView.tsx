import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { offEvent, onEvent } from '../../../lib/event-bridge'
import type {
  RepairCacheChangedEvent,
  RepairCommand,
  RepairConflictEvent,
  RepairConflictResolution,
  RepairCustomerNotificationState,
  RepairPrintKind,
  RepairScopeResetEvent,
} from './contracts'
import { shouldRefetchForRepairCacheReason } from './event-policy'
import {
  RepairIntakeDialog,
  type RepairDeviceDraft,
  type RepairIntakeSubmission,
} from './RepairIntakeDialog'
import type { RepairIntent } from './navigation'
import {
  evaluateRepairMutationPolicy,
  type RepairConnectivity,
  validateRepairAttachmentPolicy,
  validateRepairIntakePolicy,
} from './policy'
import { RepairsShell } from './RepairsShell'
import { createSecureRepairId } from './secure-id'
import { repairService, type RepairListQuery } from './service'
import { repairStore, useRepairStore } from './store'
import { normalizeUuid } from '../../utils/staffAttribution'
import {
  repairCatalogService,
  type RepairCatalogKind,
} from './RepairCatalogService'

export interface RepairsViewProps {
  initialIntent?: RepairIntent | null
  onIntentConsumed?: () => void
  connectivity: RepairConnectivity
  hasActiveShift: boolean
  actorKey: string | null
  currentStaffId?: string | null
  organizationId?: string | null
  branchId?: string | null
}

const LIST_QUERY = { status: null, search: null, limit: 100, offset: 0 } as const

function hasString(value: unknown, key: string): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>)[key] === 'string'
}

function commandCapability(command: RepairCommand, capabilities: NonNullable<ReturnType<typeof repairStore.getState>['workspace']>['capabilities']): boolean {
  if (command.command === 'record_approval') return capabilities.approve
  if (command.command === 'plan_line') return capabilities.planParts
  if (command.command === 'consume_nonstock_part'
    || command.command === 'reverse_nonstock_part'
    || command.command === 'consume_repair_part'
    || command.command === 'reverse_repair_part') return capabilities.consumeParts
  if (command.command === 'assign_repair') return capabilities.assign
  if (command.command === 'transition_status' && command.payload.target_status === 'cancelled') return capabilities.cancel
  return capabilities.update
}

export default function RepairsView({
  initialIntent = null,
  onIntentConsumed,
  connectivity,
  hasActiveShift,
  actorKey,
  currentStaffId = null,
  organizationId = null,
  branchId = null,
}: RepairsViewProps) {
  const { t } = useTranslation()
  const repairs = useRepairStore((state) => state.repairs)
  const pagination = useRepairStore((state) => state.pagination)
  const workspace = useRepairStore((state) => state.workspace)
  const settingsSnapshot = useRepairStore((state) => state.settings)
  const conflicts = useRepairStore((state) => state.conflicts)
  const attachmentsByRepairId = useRepairStore((state) => state.attachmentsByRepairId)
  const selectedRepairId = useRepairStore((state) => state.selectedRepairId)
  const [isLoading, setIsLoading] = useState(true)
  const [isMutating, setIsMutating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intakeIntent, setIntakeIntent] = useState<RepairIntent | null>(null)
  const eventRefreshInFlight = useRef(false)
  const eventRefreshPending = useRef(false)
  const eventRefreshRepairIds = useRef<Set<string>>(new Set())
  const selectionInFlight = useRef(false)
  const pendingSelection = useRef<string | null>(null)
  const selectionGeneration = useRef(0)
  const [notification, setNotification] = useState<{
    repairId: string
    state: RepairCustomerNotificationState
  } | null>(null)
  const activeActorKey = hasActiveShift && actorKey ? actorKey : null
  const activeActorRef = useRef<string | null>(activeActorKey)
  const connectivityRef = useRef<RepairConnectivity>(connectivity)
  activeActorRef.current = activeActorKey
  connectivityRef.current = connectivity
  const settings = settingsSnapshot?.settings ?? null
  const scopedOrganizationId = normalizeUuid(organizationId) ?? null
  const scopedBranchId = normalizeUuid(branchId) ?? null

  const refresh = useCallback(async (showLoading = true) => {
    const actorAtStart = activeActorRef.current
    if (!actorAtStart) {
      setIsLoading(false)
      return
    }
    if (showLoading) setIsLoading(true)
    setError(null)
    const store = repairStore.getState()
    const listQuery = store.lastListQuery ?? LIST_QUERY
    const results = await Promise.allSettled([
      store.loadSettings(),
      store.loadRepairs(listQuery),
      store.loadConflicts(),
    ])
    if (activeActorRef.current !== actorAtStart) return
    if (results.some((result) => result.status === 'rejected')) {
      setError(t('repairs.messages.loadFailed'))
    }
    const current = repairStore.getState()
    const repairId = current.selectedRepairId ?? current.repairs[0]?.id ?? null
    if (repairId) {
      current.selectRepair(repairId)
      const detailResults = await Promise.allSettled([
        current.loadWorkspace(repairId),
        current.loadAttachments(repairId),
      ])
      if (activeActorRef.current !== actorAtStart) return
      if (detailResults.some((result) => result.status === 'rejected')) {
        setError(t('repairs.messages.loadFailed'))
      }
    }
    if (showLoading) setIsLoading(false)
  }, [t])

  useEffect(() => {
    selectionGeneration.current += 1
    pendingSelection.current = null
    selectionInFlight.current = false
    repairStore.getState().clearSession()
    setNotification(null)
    setIntakeIntent(null)
    setError(null)
    if (!activeActorKey) {
      setIsLoading(false)
      return
    }
    void refresh()
    return () => {
      selectionGeneration.current += 1
      pendingSelection.current = null
      selectionInFlight.current = false
      repairStore.getState().clearSession()
    }
  }, [activeActorKey, refresh])

  useEffect(() => {
    if (!initialIntent || !activeActorKey) return
    setIntakeIntent(initialIntent)
    onIntentConsumed?.()
  }, [activeActorKey, initialIntent, onIntentConsumed])

  useEffect(() => {
    if (!activeActorKey) return
    const runEventRefresh = async () => {
      if (eventRefreshInFlight.current) return
      eventRefreshInFlight.current = true
      try {
        do {
          eventRefreshPending.current = false
          const repairIds = eventRefreshRepairIds.current
          eventRefreshRepairIds.current = new Set()
          const current = repairStore.getState()
          try {
            await current.loadRepairs(current.lastListQuery ?? LIST_QUERY)
            const refreshed = repairStore.getState()
            const repairId = refreshed.selectedRepairId
            if (repairId && repairIds.has(repairId)) {
              await Promise.allSettled([
                refreshed.loadWorkspace(repairId),
                refreshed.loadAttachments(repairId),
              ])
            }
            const latest = repairStore.getState()
            if (latest.selectedRepairId
              && latest.workspace?.repair.id !== latest.selectedRepairId) {
              await Promise.allSettled([
                latest.loadWorkspace(latest.selectedRepairId),
                latest.loadAttachments(latest.selectedRepairId),
              ])
            }
          } catch {
            setError(t('repairs.messages.loadFailed'))
          }
        } while (eventRefreshPending.current)
      } finally {
        eventRefreshInFlight.current = false
      }
    }
    const cacheChanged = (event: RepairCacheChangedEvent) => {
      if (!hasString(event, 'scopeToken') || typeof event.reason !== 'string') return
      if (!shouldRefetchForRepairCacheReason(event.reason)) return
      if (repairStore.getState().applyCacheChangedEvent(event) !== true) return
      eventRefreshPending.current = true
      if (event.repairId) eventRefreshRepairIds.current.add(event.repairId)
      void runEventRefresh()
    }
    const conflict = (event: RepairConflictEvent) => {
      if (!hasString(event, 'scopeToken') || !event.conflict) return
      repairStore.getState().applyConflictEvent(event)
    }
    const scopeReset = (event: RepairScopeResetEvent) => {
      if (!hasString(event, 'scopeToken') || (event.reason !== 'module_revoked' && event.reason !== 'identity_rebound')) return
      if (!repairStore.getState().applyScopeResetEvent(event)) return
      eventRefreshPending.current = false
      eventRefreshRepairIds.current.clear()
      setNotification(null)
      setIntakeIntent(null)
      if (event.reason === 'identity_rebound') void refresh(false)
    }
    onEvent<RepairCacheChangedEvent>('repairs:cache-changed', cacheChanged)
    onEvent<RepairConflictEvent>('repairs:conflict', conflict)
    onEvent<RepairScopeResetEvent>('repairs:scope-reset', scopeReset)
    return () => {
      offEvent<RepairCacheChangedEvent>('repairs:cache-changed', cacheChanged)
      offEvent<RepairConflictEvent>('repairs:conflict', conflict)
      offEvent<RepairScopeResetEvent>('repairs:scope-reset', scopeReset)
    }
  }, [activeActorKey, refresh, t])

  const selectRepair = async (repairId: string) => {
    const actorAtStart = activeActorRef.current
    if (!actorAtStart) return
    pendingSelection.current = repairId
    if (selectionInFlight.current) return
    selectionInFlight.current = true
    const generation = selectionGeneration.current
    try {
      while (pendingSelection.current
        && generation === selectionGeneration.current
        && activeActorRef.current === actorAtStart) {
        const nextRepairId = pendingSelection.current
        pendingSelection.current = null
        const store = repairStore.getState()
        store.selectRepair(nextRepairId)
        setNotification((current) => current?.repairId === nextRepairId ? current : null)
        setError(null)
        const results = await Promise.allSettled([
          store.loadWorkspace(nextRepairId),
          store.loadAttachments(nextRepairId),
        ])
        if (generation !== selectionGeneration.current || activeActorRef.current !== actorAtStart) return
        if (results.some((result) => result.status === 'rejected')) {
          setError(t('repairs.messages.loadFailed'))
        }
      }
    } finally {
      if (generation === selectionGeneration.current) selectionInFlight.current = false
    }
  }

  const loadListPage = async (query: { status: RepairListQuery['status']; search: string | null; offset: number }) => {
    const actorAtStart = activeActorRef.current
    if (!actorAtStart) return
    setIsLoading(true)
    setError(null)
    try {
      await repairStore.getState().loadRepairs({
        status: query.status,
        search: query.search,
        limit: LIST_QUERY.limit,
        offset: Math.max(0, query.offset),
      })
      if (activeActorRef.current !== actorAtStart) return
    } catch {
      if (activeActorRef.current === actorAtStart) setError(t('repairs.messages.loadFailed'))
    } finally {
      if (activeActorRef.current === actorAtStart) setIsLoading(false)
    }
  }

  const submitIntake = async ({ repairId, command }: RepairIntakeSubmission) => {
    const actorAtStart = activeActorRef.current
    if (!actorAtStart) throw new Error('REPAIR_STAFF_SESSION_REQUIRED')
    const currentSettings = repairStore.getState().settings
    const policy = validateRepairIntakePolicy({
      intakeMode: command.payload.intake_mode,
      isAnonymous: command.payload.is_anonymous,
      customerId: command.payload.customer_id,
      customerDeviceId: command.payload.customer_device_id,
    }, currentSettings ? { quickServiceEnabled: currentSettings.settings.quickServiceEnabled } : null)
    const mutation = evaluateRepairMutationPolicy({
      connectivity: connectivityRef.current,
      command,
      hasCapability: currentSettings?.capabilities.create,
      hasActiveShift,
    })
    const operationId = createSecureRepairId()
    if (!policy.ok || !mutation.allowed || !operationId) throw new Error('REPAIR_INTAKE_BLOCKED')

    setIsMutating(true)
    try {
      const result = await repairStore.getState().executeCommand({
        operationId,
        repairId,
        expectedVersion: 0,
        occurredAt: new Date().toISOString(),
        command,
      })
      if (!result) throw new Error('REPAIR_SCOPE_CHANGED')
      if (activeActorRef.current !== actorAtStart) throw new Error('REPAIR_STAFF_SESSION_CHANGED')
      if (result.kind === 'applied') {
        setNotification({ repairId: result.repairId, state: result.customerNotificationState })
        repairStore.getState().selectRepair(result.repairId)
        setIntakeIntent(null)
      }
    } finally {
      setIsMutating(false)
    }
  }

  const executeCommand = async (command: RepairCommand) => {
    const actorAtStart = activeActorRef.current
    const state = repairStore.getState()
    const current = state.workspace
    const operationId = createSecureRepairId()
    if (!actorAtStart
      || !current
      || state.selectedRepairId !== current.repair.id
      || !operationId) throw new Error('REPAIR_COMMAND_BLOCKED')
    const policy = evaluateRepairMutationPolicy({
      connectivity: connectivityRef.current,
      command,
      hasCapability: commandCapability(command, current.capabilities),
      hasActiveShift,
    })
    if (!policy.allowed) throw new Error(policy.code)

    setIsMutating(true)
    try {
      const result = await repairStore.getState().executeCommand({
        operationId,
        repairId: current.repair.id,
        expectedVersion: current.repair.version,
        occurredAt: new Date().toISOString(),
        command,
      })
      if (!result) throw new Error('REPAIR_SCOPE_CHANGED')
      if (activeActorRef.current !== actorAtStart) throw new Error('REPAIR_STAFF_SESSION_CHANGED')
      if (result.kind === 'applied') setNotification({ repairId: result.repairId, state: result.customerNotificationState })
    } finally {
      setIsMutating(false)
    }
  }

  const stagePhoto = async (file: File) => {
    const actorAtStart = activeActorRef.current
    const before = repairStore.getState()
    const current = before.workspace
    const attachmentId = createSecureRepairId()
    const operationId = createSecureRepairId()
    if (!actorAtStart
      || !current
      || before.selectedRepairId !== current.repair.id
      || !before.scopeToken
      || !attachmentId
      || !operationId) throw new Error('REPAIR_ATTACHMENT_BLOCKED')
    const attachmentPolicy = before.settings?.settings.attachmentPolicy ?? null
    const policy = validateRepairAttachmentPolicy({ mimeType: file.type, byteSize: file.size }, attachmentPolicy)
    if (!policy.ok
      || !current.capabilities.manageAttachments
      || activeActorRef.current !== actorAtStart
      || (connectivityRef.current !== 'online' && connectivityRef.current !== 'offline')) {
      throw new Error(policy.ok ? 'REPAIR_ATTACHMENT_BLOCKED' : policy.code)
    }
    setIsMutating(true)
    try {
      const buffer = await file.arrayBuffer()
      const fresh = repairStore.getState()
      const freshWorkspace = fresh.workspace
      const freshAttachmentPolicy = fresh.settings?.settings.attachmentPolicy ?? null
      const freshPolicy = validateRepairAttachmentPolicy({
        mimeType: file.type,
        byteSize: buffer.byteLength,
      }, freshAttachmentPolicy)
      if (!freshPolicy.ok
        || activeActorRef.current !== actorAtStart
        || fresh.epoch !== before.epoch
        || fresh.scopeToken !== before.scopeToken
        || fresh.selectedRepairId !== current.repair.id
        || freshWorkspace?.repair.id !== current.repair.id
        || !freshWorkspace.capabilities.manageAttachments
        || (connectivityRef.current !== 'online' && connectivityRef.current !== 'offline')) {
        throw new Error(freshPolicy.ok ? 'REPAIR_ATTACHMENT_CONTEXT_CHANGED' : freshPolicy.code)
      }
      const result = await repairStore.getState().stageAttachment({
        attachmentId,
        operationId,
        repairId: current.repair.id,
        expectedVersion: freshWorkspace.repair.version,
        occurredAt: new Date().toISOString(),
        attachmentType: 'repair',
        filename: file.name.slice(0, 255) || 'repair-photo',
        caption: null,
        mimeType: file.type,
        bytes: Array.from(new Uint8Array(buffer)),
      })
      if (!result) throw new Error('REPAIR_SCOPE_CHANGED')
      if (activeActorRef.current !== actorAtStart) throw new Error('REPAIR_STAFF_SESSION_CHANGED')
    } finally {
      setIsMutating(false)
    }
  }

  const openAttachment = async (attachmentId: string) => {
    const actorAtStart = activeActorRef.current
    const before = repairStore.getState()
    const repairId = before.selectedRepairId
    if (!actorAtStart
      || connectivityRef.current !== 'online'
      || !repairId
      || before.workspace?.repair.id !== repairId
      || before.workspace.capabilities.manageAttachments !== true
      || !before.scopeToken) {
      setError(t('repairs.messages.attachmentOpenFailed'))
      return
    }
    setIsMutating(true)
    setError(null)
    try {
      const result = await repairService.openAttachment({ repairId, attachmentId })
      const after = repairStore.getState()
      if (activeActorRef.current !== actorAtStart
        || connectivityRef.current !== 'online'
        || after.epoch !== before.epoch
        || after.scopeToken !== before.scopeToken
        || result.scopeToken !== before.scopeToken
        || result.attachmentId !== attachmentId
        || result.opened !== true) {
        throw new Error('REPAIR_SCOPE_CHANGED')
      }
    } catch {
      setError(t('repairs.messages.attachmentOpenFailed'))
    } finally {
      setIsMutating(false)
    }
  }

  const searchCatalog = async (kind: RepairCatalogKind, query: string) => {
    const actorAtStart = activeActorRef.current
    const before = repairStore.getState()
    if (!actorAtStart
      || connectivityRef.current !== 'online'
      || !before.scopeToken
      || !scopedOrganizationId
      || !scopedBranchId) return []
    const items = await repairCatalogService.search({
      organizationId: scopedOrganizationId,
      branchId: scopedBranchId,
      kind,
      query,
    })
    const after = repairStore.getState()
    return activeActorRef.current === actorAtStart
      && connectivityRef.current === 'online'
      && after.epoch === before.epoch
      && after.scopeToken === before.scopeToken
      ? items
      : []
  }

  const lookupCatalogBarcode = async (barcode: string) => {
    const actorAtStart = activeActorRef.current
    const before = repairStore.getState()
    if (!actorAtStart
      || connectivityRef.current !== 'online'
      || !before.scopeToken
      || !scopedOrganizationId
      || !scopedBranchId) return null
    const item = await repairCatalogService.lookupBarcode({
      organizationId: scopedOrganizationId,
      branchId: scopedBranchId,
      barcode,
    })
    const after = repairStore.getState()
    return activeActorRef.current === actorAtStart
      && connectivityRef.current === 'online'
      && after.epoch === before.epoch
      && after.scopeToken === before.scopeToken
      ? item
      : null
  }

  const printRepair = async (kind: RepairPrintKind) => {
    const actorAtStart = activeActorRef.current
    const before = repairStore.getState()
    const repairId = before.selectedRepairId
    if (!actorAtStart
      || connectivityRef.current !== 'online'
      || !repairId
      || before.workspace?.repair.id !== repairId
      || !before.scopeToken) {
      setError(t('repairs.messages.printFailed', { defaultValue: 'The repair document could not be queued securely.' }))
      return
    }
    setIsMutating(true)
    setError(null)
    try {
      const queued = await repairService.enqueuePrint({
        scopeToken: before.scopeToken,
        repairId,
        kind,
      })
      const afterQueue = repairStore.getState()
      if (activeActorRef.current !== actorAtStart
        || connectivityRef.current !== 'online'
        || afterQueue.epoch !== before.epoch
        || afterQueue.scopeToken !== before.scopeToken
        || queued.scopeToken !== before.scopeToken
        || queued.repairId !== repairId
        || queued.kind !== kind
        || queued.queued !== true) {
        throw new Error('REPAIR_SCOPE_CHANGED')
      }
    } catch {
      setError(t('repairs.messages.printFailed', { defaultValue: 'The repair document could not be queued securely.' }))
    } finally {
      setIsMutating(false)
    }
  }

  const refreshAuthoritativeRepair = async (repairId: string) => {
    const actorAtStart = activeActorRef.current
    const before = repairStore.getState()
    if (!actorAtStart
      || connectivityRef.current !== 'online'
      || before.selectedRepairId !== repairId
      || before.workspace?.repair.id !== repairId) {
      throw new Error('REPAIR_SCOPE_CHANGED')
    }
    const results = await Promise.allSettled([
      before.loadRepairs(before.lastListQuery ?? LIST_QUERY),
      before.loadWorkspace(repairId),
      before.loadAttachments(repairId),
    ])
    const after = repairStore.getState()
    if (results.some((result) => result.status === 'rejected')
      || activeActorRef.current !== actorAtStart
      || connectivityRef.current !== 'online'
      || after.selectedRepairId !== repairId) {
      throw new Error('REPAIR_REFRESH_FAILED')
    }
  }

  const resolveConflict = async (conflictId: string, resolution: RepairConflictResolution) => {
    const actorAtStart = activeActorRef.current
    if (!actorAtStart
      || connectivityRef.current !== 'online'
      || repairStore.getState().settings?.capabilities.update !== true) {
      setError(t('repairs.messages.commandFailed'))
      return
    }
    setIsMutating(true)
    setError(null)
    try {
      const result = await repairStore.getState().resolveConflict(conflictId, resolution)
      if (!result) throw new Error('REPAIR_SCOPE_CHANGED')
      if (activeActorRef.current !== actorAtStart) throw new Error('REPAIR_STAFF_SESSION_CHANGED')
    } catch {
      setError(t('repairs.messages.commandFailed'))
    } finally {
      setIsMutating(false)
    }
  }

  const selectedAttachments = selectedRepairId
    ? attachmentsByRepairId[selectedRepairId] ?? []
    : []
  const visibleWorkspace = workspace?.repair.id === selectedRepairId ? workspace : null

  if (!activeActorKey) {
    return (
      <div className="m-4 space-y-3 text-slate-950 dark:text-white">
        <h1 className="text-2xl font-bold tracking-tight">{t('repairs.title')}</h1>
        <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          {t('repairs.messages.activeShiftRequired')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && <div role="alert" className="mx-4 mt-3 shrink-0 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-800 dark:text-red-200">{error}</div>}
      <div className="min-h-0 flex-1">
        <RepairsShell
          repairs={repairs}
          pagination={pagination}
          workspace={visibleWorkspace}
          attachments={selectedAttachments}
          conflicts={conflicts}
          isLoading={isLoading}
          isOffline={connectivity === 'offline'}
          quickServiceEnabled={settings?.quickServiceEnabled === true}
          canCreateRepair={settingsSnapshot?.capabilities.create === true}
          canResolveConflicts={connectivity === 'online'
            && hasActiveShift
            && settingsSnapshot?.capabilities.update === true
            && !isMutating}
          notificationState={notification && notification.repairId === visibleWorkspace?.repair.id ? notification.state : null}
          attachmentPolicy={settings?.attachmentPolicy ?? null}
          connectivity={connectivity}
          hasActiveShift={hasActiveShift}
          currentStaffId={normalizeUuid(currentStaffId) ?? null}
          isMutating={isMutating}
          onRefresh={() => void refresh()}
          onListQueryChange={(query) => void loadListPage(query)}
          onSelectRepair={(repairId) => void selectRepair(repairId)}
          onNewRepair={() => setIntakeIntent('new_repair')}
          onQuickService={() => settings?.quickServiceEnabled === true && setIntakeIntent('quick_service')}
          onResolveConflict={(conflictId, resolution) => void resolveConflict(conflictId, resolution)}
          onExecuteCommand={executeCommand}
          onStagePhoto={stagePhoto}
          onOpenAttachment={(attachmentId) => void openAttachment(attachmentId)}
          onCatalogSearch={scopedOrganizationId && scopedBranchId ? searchCatalog : undefined}
          onCatalogBarcodeLookup={scopedOrganizationId && scopedBranchId ? lookupCatalogBarcode : undefined}
          repairDepositSupported={settings?.repairDepositSupported === true}
          onMoneyBusyChange={setIsMutating}
          onAuthoritativeRefresh={refreshAuthoritativeRepair}
          onPrintRepair={printRepair}
        />
      </div>
      <RepairIntakeDialog
        isOpen={intakeIntent !== null}
        intent={intakeIntent ?? 'new_repair'}
        settings={settings}
        connectivity={connectivity}
        isSubmitting={isMutating}
        onClose={() => !isMutating && setIntakeIntent(null)}
        onSearchCustomers={async (search) => {
          const actorAtStart = activeActorRef.current
          const before = repairStore.getState()
          if (!actorAtStart || connectivityRef.current !== 'online' || !before.scopeToken) return []
          const response = await repairService.searchCustomers({ search, limit: 20, offset: 0 })
          const after = repairStore.getState()
          return activeActorRef.current === actorAtStart
            && connectivityRef.current === 'online'
            && after.epoch === before.epoch
            && after.scopeToken === before.scopeToken
            && response.scopeToken === before.scopeToken
            ? response.customers
            : []
        }}
        onLoadDevices={async (customerId) => {
          const actorAtStart = activeActorRef.current
          const before = repairStore.getState()
          if (!actorAtStart || connectivityRef.current !== 'online' || !before.scopeToken) return []
          const response = await repairService.customerDevices(customerId)
          const after = repairStore.getState()
          return activeActorRef.current === actorAtStart
            && connectivityRef.current === 'online'
            && after.epoch === before.epoch
            && after.scopeToken === before.scopeToken
            && response.scopeToken === before.scopeToken
            ? response.devices
            : []
        }}
        onCreateDevice={async (draft: RepairDeviceDraft) => {
          const actorAtStart = activeActorRef.current
          const before = repairStore.getState()
          if (!actorAtStart || connectivityRef.current !== 'online' || !before.scopeToken) return []
          const response = await repairService.createCustomerDevice(draft)
          const after = repairStore.getState()
          return activeActorRef.current === actorAtStart
            && connectivityRef.current === 'online'
            && after.epoch === before.epoch
            && after.scopeToken === before.scopeToken
            && response.scopeToken === before.scopeToken
            ? response.devices
            : []
        }}
        onSubmit={submitIntake}
      />
    </div>
  )
}
