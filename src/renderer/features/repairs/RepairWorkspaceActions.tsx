import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Camera, FilePlus2, Lock, StickyNote } from 'lucide-react'

import { offEvent, onEvent } from '../../../lib/event-bridge'
import type {
  RepairAttachmentPolicySnapshot,
  RepairBarcodeScannedEvent,
  RepairCommand,
  RepairLineType,
  RepairStatus,
  RepairWorkspaceSnapshot,
} from './contracts'
import {
  evaluateRepairMutationPolicy,
  validateRepairAttachmentPolicy,
  type RepairConnectivity,
} from './policy'
import { canCreateSecureRepairId, createSecureRepairId } from './secure-id'
import { normalizeUuid } from '../../utils/staffAttribution'
import type { RepairCatalogItem, RepairCatalogKind } from './RepairCatalogService'

export type RepairWorkspaceActionTab =
  | 'overview'
  | 'diagnosis'
  | 'partsLabour'
  | 'estimateApproval'
  | 'timeline'
  | 'photos'
  | 'payments'
  | 'communication'

export interface RepairWorkspaceActionsProps {
  tab: RepairWorkspaceActionTab
  workspace: RepairWorkspaceSnapshot
  attachmentPolicy: RepairAttachmentPolicySnapshot | null
  connectivity: RepairConnectivity
  hasActiveShift: boolean
  currentStaffId?: string | null
  isBusy: boolean
  onExecuteCommand: (command: RepairCommand) => Promise<void>
  onStagePhoto: (file: File) => Promise<void>
  onCatalogSearch?: (kind: RepairCatalogKind, query: string) => Promise<RepairCatalogItem[]>
  onCatalogBarcodeLookup?: (barcode: string) => Promise<RepairCatalogItem | null>
}

function commandAllowed(
  command: RepairCommand,
  connectivity: RepairConnectivity,
  hasCapability: boolean,
  hasActiveShift: boolean,
): boolean {
  return evaluateRepairMutationPolicy({
    connectivity,
    command,
    hasCapability,
    hasActiveShift,
  }).allowed
}

function nullable(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function RepairWorkspaceActions({
  tab,
  workspace,
  attachmentPolicy,
  connectivity,
  hasActiveShift,
  currentStaffId = null,
  isBusy,
  onExecuteCommand,
  onStagePhoto,
  onCatalogSearch,
  onCatalogBarcodeLookup,
}: RepairWorkspaceActionsProps) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [diagnosis, setDiagnosis] = useState(workspace.repair.diagnosis ?? '')
  const [lineType, setLineType] = useState<RepairLineType>('part')
  const [lineName, setLineName] = useState('')
  const [lineQuantity, setLineQuantity] = useState('1')
  const [linePrice, setLinePrice] = useState('0.00')
  const [lineVat, setLineVat] = useState('0')
  const [estimateDiscount, setEstimateDiscount] = useState('0.00')
  const [estimateNote, setEstimateNote] = useState('')
  const [estimateValidUntil, setEstimateValidUntil] = useState('')
  const [transitionReason, setTransitionReason] = useState('')
  const [remainConsumed, setRemainConsumed] = useState(false)
  const [lineSku, setLineSku] = useState('')
  const [reversalReason, setReversalReason] = useState('')
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogResults, setCatalogResults] = useState<RepairCatalogItem[]>([])
  const [selectedCatalog, setSelectedCatalog] = useState<RepairCatalogItem | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const hasSecureId = canCreateSecureRepairId()

  const applyCatalogItem = useCallback((item: RepairCatalogItem) => {
    setSelectedCatalog(item)
    setLineType(item.kind)
    setLineName(item.nameSnapshot)
    setLineSku(item.skuSnapshot ?? '')
    setLinePrice(String(item.unitPriceSnapshot))
    setLineVat(item.vatRateSnapshot === null ? '' : String(item.vatRateSnapshot))
    setError(null)
  }, [])

  useEffect(() => {
    setDiagnosis(workspace.repair.diagnosis ?? '')
    setError(null)
  }, [workspace.repair.diagnosis, workspace.repair.id])

  useEffect(() => {
    if (tab !== 'partsLabour') return
    const handleSerialScan = (event: RepairBarcodeScannedEvent) => {
      if (event?.source !== 'serial' || typeof event.barcode !== 'string') return
      const barcode = event.barcode.trim()
      if (!barcode || barcode.length > 256) return
      if (connectivity !== 'online' || !onCatalogBarcodeLookup) {
        setError(t('repairs.messages.catalogUnavailable', { defaultValue: 'Catalog lookup is unavailable.' }))
        return
      }
      setCatalogLoading(true)
      void onCatalogBarcodeLookup(barcode)
        .then((item) => {
          if (!item || item.kind !== 'part') {
            setError(t('repairs.messages.catalogNoMatch', { defaultValue: 'No safe catalog match was found.' }))
            return
          }
          applyCatalogItem(item)
        })
        .catch(() => setError(t('repairs.messages.catalogUnavailable', { defaultValue: 'Catalog lookup is unavailable.' })))
        .finally(() => setCatalogLoading(false))
    }
    onEvent<RepairBarcodeScannedEvent>('barcode_scanned_serial', handleSerialScan)
    return () => offEvent<RepairBarcodeScannedEvent>('barcode_scanned_serial', handleSerialScan)
  }, [applyCatalogItem, connectivity, onCatalogBarcodeLookup, t, tab])

  const run = async (command: RepairCommand) => {
    setError(null)
    try {
      await onExecuteCommand(command)
    } catch {
      setError(t('repairs.messages.commandFailed'))
    }
  }

  const transitionCommands = useMemo(() => workspace.allowedTransitions.map((status) => ({
    status,
    command: {
      command: 'transition_status' as const,
      payload: {
        target_status: status,
        reason: nullable(transitionReason),
        remain_consumed: status === 'cancelled' && remainConsumed,
      },
    },
  })), [remainConsumed, transitionReason, workspace.allowedTransitions])

  const errorNode = error ? (
    <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-800 dark:text-red-200">
      {error}
    </p>
  ) : null

  if (tab === 'overview') {
    const canonicalStaffId = normalizeUuid(currentStaffId) ?? null
    const isAssignedToCurrentStaff = canonicalStaffId !== null
      && normalizeUuid(workspace.repair.assignedStaffId) === canonicalStaffId
    const assignmentCommand: RepairCommand | null = canonicalStaffId ? {
      command: 'assign_repair',
      payload: { assigned_staff_id: isAssignedToCurrentStaff ? null : canonicalStaffId },
    } : null
    const canChangeAssignment = assignmentCommand !== null
      && commandAllowed(
        assignmentCommand,
        connectivity,
        workspace.capabilities.assign,
        hasActiveShift,
      )
    const noteCommand: RepairCommand = {
      command: 'add_note',
      payload: { note: note.trim(), visibility: 'internal' },
    }
    const canAddNote = note.trim().length > 0 && commandAllowed(
      noteCommand,
      connectivity,
      workspace.capabilities.update,
      hasActiveShift,
    )

    return (
      <section aria-label={t('repairs.actions.operations')} className="space-y-4 border-t border-slate-200 pt-4 dark:border-white/10">
        <div>
          <h3 className="text-sm font-semibold">{t('repairs.fields.assignedTo')}</h3>
          {canonicalStaffId && workspace.capabilities.assign ? (
            <button
              type="button"
              disabled={isBusy || !canChangeAssignment}
              onClick={() => assignmentCommand && void run(assignmentCommand)}
              className="mt-2 min-h-11 rounded-xl border border-slate-300 px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/15"
            >
              {t(isAssignedToCurrentStaff ? 'repairs.actions.unassign' : 'repairs.actions.assignToMe')}
            </button>
          ) : (
            <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
              {t('repairs.messages.assignmentUnavailable')}
            </p>
          )}
        </div>
        <div>
          <h3 className="text-sm font-semibold">{t('repairs.actions.changeStatus')}</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {transitionCommands.filter(({ status }) => status !== 'delivered' && status !== 'approved').map(({ status, command }) => {
              const capability = status === 'cancelled'
                ? workspace.capabilities.cancel
                : workspace.capabilities.update
              const requiresReason = status === 'cancelled'
                || status === 'unrepairable'
                || (workspace.repair.status === 'quality_check' && status === 'repairing')
              const allowed = commandAllowed(command, connectivity, capability, hasActiveShift)
                && (!requiresReason || transitionReason.trim().length > 0)
              return (
                <button
                  key={status}
                  type="button"
                  disabled={isBusy || !allowed}
                  onClick={() => void run(command)}
                  className="min-h-11 rounded-xl border border-slate-300 px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/15"
                >
                  {t(`repairs.status.${status}`)}
                </button>
              )
            })}
          </div>
          {(workspace.allowedTransitions.includes('cancelled')
            || workspace.allowedTransitions.includes('unrepairable')
            || (workspace.repair.status === 'quality_check' && workspace.allowedTransitions.includes('repairing'))) && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="text-sm font-semibold">{t('repairs.actions.transitionReason')}<input value={transitionReason} onChange={(event) => setTransitionReason(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
              {workspace.allowedTransitions.includes('cancelled') && <label className="flex min-h-11 items-center gap-2 self-end text-sm"><input type="checkbox" checked={remainConsumed} onChange={(event) => setRemainConsumed(event.target.checked)} />{t('repairs.actions.remainConsumed')}</label>}
            </div>
          )}
          {workspace.allowedTransitions.includes('approved') && (
            <p className="mt-2 flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200"><Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />{t('repairs.locked.approvalTransition')}</p>
          )}
          {workspace.allowedTransitions.includes('delivered') && (
            <p className="mt-2 flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200">
              <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              {t('repairs.locked.money')}
            </p>
          )}
          {connectivity === 'offline' && transitionCommands.some(({ command, status }) => status !== 'delivered' && !commandAllowed(command, connectivity, workspace.capabilities.update, hasActiveShift)) && (
            <p className="mt-2 text-xs text-slate-600 dark:text-zinc-400">{t('repairs.messages.onlineActionRequired')}</p>
          )}
        </div>
        <div>
          <label htmlFor="repair-internal-note" className="text-sm font-semibold">{t('repairs.actions.addNote')}</label>
          <div className="mt-1 flex gap-2">
            <textarea id="repair-internal-note" value={note} onChange={(event) => setNote(event.target.value)} rows={2} className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-transparent p-3 dark:border-white/15" />
            <button type="button" disabled={isBusy || !canAddNote} onClick={() => void run(noteCommand).then(() => setNote(''))} className="inline-flex min-h-11 items-center gap-2 self-end rounded-xl bg-blue-600 px-4 font-semibold text-white disabled:opacity-45">
              <StickyNote aria-hidden className="h-4 w-4" />
              {t('repairs.actions.addNote')}
            </button>
          </div>
        </div>
        {errorNode}
      </section>
    )
  }

  if (tab === 'diagnosis') {
    const draftCommand: RepairCommand = { command: 'update_diagnosis', payload: { diagnosis: nullable(diagnosis), draft: true } }
    const finalCommand: RepairCommand = { command: 'update_diagnosis', payload: { diagnosis: nullable(diagnosis), draft: false } }
    const canDraft = diagnosis.trim().length > 0 && commandAllowed(draftCommand, connectivity, workspace.capabilities.update, hasActiveShift)
    const canFinalize = diagnosis.trim().length > 0 && commandAllowed(finalCommand, connectivity, workspace.capabilities.update, hasActiveShift)
    return (
      <section className="space-y-3 border-t border-slate-200 pt-4 dark:border-white/10">
        <label htmlFor="repair-diagnosis" className="text-sm font-semibold">{t('repairs.fields.diagnosis')}</label>
        <textarea id="repair-diagnosis" value={diagnosis} onChange={(event) => setDiagnosis(event.target.value)} rows={5} className="w-full rounded-xl border border-slate-300 bg-transparent p-3 dark:border-white/15" />
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={isBusy || !canDraft} onClick={() => void run(draftCommand)} className="min-h-11 rounded-xl border border-blue-500 px-4 font-semibold text-blue-700 disabled:opacity-45 dark:text-blue-200">{t('repairs.actions.updateDiagnosis')}</button>
          <button type="button" disabled={isBusy || !canFinalize} onClick={() => void run(finalCommand)} className="min-h-11 rounded-xl bg-blue-600 px-4 font-semibold text-white disabled:opacity-45">{t('repairs.actions.finalizeDiagnosis')}</button>
        </div>
        {!canFinalize && connectivity !== 'online' && <p className="text-xs text-slate-600 dark:text-zinc-400">{t('repairs.messages.finalDiagnosisOnline')}</p>}
        {errorNode}
      </section>
    )
  }

  if (tab === 'partsLabour') {
    const quantity = Number(lineQuantity)
    const price = Number(linePrice)
    const vat = Number(lineVat)
    const lineId = createSecureRepairId()
    const command: RepairCommand | null = lineId ? {
      command: 'plan_line',
      payload: {
        line_id: lineId,
        line_type: lineType,
        name_snapshot: lineName.trim(),
        sku_snapshot: nullable(lineSku),
        description: selectedCatalog?.description ?? null,
        quantity: lineQuantity,
        unit_cost_snapshot: selectedCatalog?.unitCostSnapshot === null || selectedCatalog?.unitCostSnapshot === undefined
          ? null
          : String(selectedCatalog.unitCostSnapshot),
        unit_price_snapshot: linePrice,
        vat_rate_snapshot: lineVat,
        retail_product_id: selectedCatalog?.retailProductId ?? null,
        retail_variant_id: selectedCatalog?.retailVariantId ?? null,
        service_id: selectedCatalog?.serviceId ?? null,
        display_order: workspace.lines.length,
      },
    } : null
    const validNumbers = linePrice.trim().length > 0
      && lineVat.trim().length > 0
      && Number.isFinite(quantity)
      && quantity > 0
      && Number.isFinite(price)
      && price >= 0
      && Number.isFinite(vat)
      && vat >= 0
    const canPlan = Boolean(command && lineName.trim() && validNumbers && commandAllowed(command, connectivity, workspace.capabilities.planParts, hasActiveShift))
    const catalogKind: RepairCatalogKind | null = lineType === 'charge' ? null : lineType
    const canSearchCatalog = connectivity === 'online'
      && Boolean(onCatalogSearch)
      && catalogKind !== null
      && catalogQuery.trim().length > 0
      && catalogQuery.trim().length <= 120
    const searchCatalog = async () => {
      if (!canSearchCatalog || !onCatalogSearch || !catalogKind) return
      setCatalogLoading(true)
      setError(null)
      try {
        setCatalogResults(await onCatalogSearch(catalogKind, catalogQuery.trim()))
      } catch {
        setCatalogResults([])
        setError(t('repairs.messages.catalogUnavailable', { defaultValue: 'Catalog lookup is unavailable.' }))
      } finally {
        setCatalogLoading(false)
      }
    }
    const clearCatalogSelection = () => setSelectedCatalog(null)
    return (
      <section className="space-y-3 border-t border-slate-200 pt-4 dark:border-white/10">
        {workspace.lines.some((line) => line.lineType === 'part' && line.partState === 'consumed' && !line.retailProductId) && (
          <label className="block text-sm font-semibold">{t('repairs.actions.reversalReason')}<input value={reversalReason} onChange={(event) => setReversalReason(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
        )}
        {catalogKind && onCatalogSearch && (
          <div className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-white/10">
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="min-w-0 flex-1 text-sm font-semibold">
                {t('repairs.actions.catalogSearch', { defaultValue: 'Catalog search' })}
                <input
                  type="search"
                  value={catalogQuery}
                  disabled={catalogLoading || connectivity !== 'online'}
                  onChange={(event) => setCatalogQuery(event.target.value)}
                  className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15"
                />
              </label>
              <button type="button" disabled={isBusy || catalogLoading || !canSearchCatalog} onClick={() => void searchCatalog()} className="min-h-11 self-end rounded-xl border border-blue-500 px-4 text-sm font-semibold disabled:opacity-45">
                {t('repairs.actions.searchCatalog', { defaultValue: 'Search catalog' })}
              </button>
            </div>
            {catalogResults.length > 0 && <ul className="grid gap-2 sm:grid-cols-2">{catalogResults.map((item) => <li key={item.key}><button type="button" onClick={() => applyCatalogItem(item)} className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-left text-sm dark:border-white/15"><span className="font-semibold">{item.nameSnapshot}</span>{item.skuSnapshot ? <span className="ml-2 text-xs text-slate-600 dark:text-zinc-400">{item.skuSnapshot}</span> : null}</button></li>)}</ul>}
          </div>
        )}
        {workspace.lines.some((line) => line.lineType === 'part') && (
          <ul className="space-y-2">
            {workspace.lines.filter((line) => line.lineType === 'part').map((line) => {
              if (line.partState === 'planned') {
                const consumeCommand: RepairCommand = line.retailProductId
                  ? { command: 'consume_repair_part', payload: { line_id: line.id } }
                  : { command: 'consume_nonstock_part', payload: { line_id: line.id } }
                const allowed = commandAllowed(consumeCommand, connectivity, workspace.capabilities.consumeParts, hasActiveShift)
                return <li key={line.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-white/10"><span className="text-sm font-semibold">{line.nameSnapshot}</span><button type="button" disabled={isBusy || !allowed} onClick={() => void run(consumeCommand)} className="min-h-11 rounded-xl border border-blue-500 px-3 text-sm font-semibold disabled:opacity-45">{t('repairs.actions.consumePart')}</button></li>
              }
              if (line.partState === 'consumed' && !line.retailProductId) {
                const reverseCommand: RepairCommand = { command: 'reverse_nonstock_part', payload: { line_id: line.id, reason: reversalReason.trim() } }
                const allowed = reversalReason.trim().length > 0 && commandAllowed(reverseCommand, connectivity, workspace.capabilities.consumeParts, hasActiveShift)
                return <li key={line.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-white/10"><span className="text-sm font-semibold">{line.nameSnapshot}</span><button type="button" disabled={isBusy || !allowed} onClick={() => void run(reverseCommand)} className="min-h-11 rounded-xl border border-amber-500 px-3 text-sm font-semibold disabled:opacity-45">{t('repairs.actions.reversePart')}</button></li>
              }
              if (line.partState === 'consumed' && line.retailProductId) {
                const canonicalLineId = normalizeUuid(line.id)
                const consumption = workspace.timeline
                  .filter((event) => event.eventType === 'part_consumed'
                    && canonicalLineId !== null
                    && normalizeUuid(event.repairLineId) === canonicalLineId
                    && normalizeUuid(event.movementId) !== null)
                  .sort((left, right) => right.aggregateVersion - left.aggregateVersion)[0]
                const movementId = normalizeUuid(consumption?.movementId)
                if (movementId) {
                  const reverseCommand: RepairCommand = {
                    command: 'reverse_repair_part',
                    payload: { line_id: canonicalLineId!, original_movement_id: movementId },
                  }
                  const allowed = commandAllowed(reverseCommand, connectivity, workspace.capabilities.consumeParts, hasActiveShift)
                  return <li key={line.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 dark:border-white/10"><span className="text-sm font-semibold">{line.nameSnapshot}</span><button type="button" disabled={isBusy || !allowed} onClick={() => void run(reverseCommand)} className="min-h-11 rounded-xl border border-amber-500 px-3 text-sm font-semibold disabled:opacity-45">{t('repairs.actions.reversePart')}</button></li>
                }
                return <li key={line.id} className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{line.nameSnapshot}: {t('repairs.locked.stockReversal')}</li>
              }
              return null
            })}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <label className="text-sm font-semibold">{t('repairs.actions.lineType')}<select value={lineType} onChange={(event) => { setLineType(event.target.value as RepairLineType); setSelectedCatalog(null); setCatalogResults([]) }} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 dark:border-white/15 dark:bg-zinc-900"><option value="part">{t('repairs.actions.part')}</option><option value="labour">{t('repairs.actions.labour')}</option><option value="charge">{t('repairs.actions.charge')}</option></select></label>
          <label className="text-sm font-semibold sm:col-span-2">{t('repairs.actions.lineName')}<input value={lineName} onChange={(event) => { clearCatalogSelection(); setLineName(event.target.value) }} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
          <label className="text-sm font-semibold">{t('repairs.actions.sku')}<input value={lineSku} onChange={(event) => { clearCatalogSelection(); setLineSku(event.target.value) }} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 ring-blue-500 focus:ring-2 dark:border-white/15" /></label>
          <label className="text-sm font-semibold">{t('repairs.actions.quantity')}<input type="number" min="0.001" step="0.001" value={lineQuantity} onChange={(event) => setLineQuantity(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
          <label className="text-sm font-semibold">{t('repairs.actions.unitPrice')}<input type="number" min="0" step="0.01" value={linePrice} onChange={(event) => { clearCatalogSelection(); setLinePrice(event.target.value) }} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
          <label className="text-sm font-semibold">{t('repairs.actions.vatRate')}<input type="number" min="0" step="0.01" value={lineVat} onChange={(event) => { clearCatalogSelection(); setLineVat(event.target.value) }} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
        </div>
        <button type="button" disabled={isBusy || !canPlan} onClick={() => command && void run(command).then(() => setLineName(''))} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 font-semibold text-white disabled:opacity-45"><FilePlus2 aria-hidden className="h-4 w-4" />{t('repairs.actions.planLine')}</button>
        {!hasSecureId && <p role="alert" className="text-sm text-red-700 dark:text-red-200">{t('repairs.messages.secureIdUnavailable')}</p>}
        {(!onCatalogSearch || connectivity !== 'online') && <p className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200"><Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />{onCatalogSearch ? t('repairs.messages.onlineActionRequired') : t('repairs.locked.catalog')}</p>}
        {errorNode}
      </section>
    )
  }

  if (tab === 'estimateApproval') {
    const estimateId = createSecureRepairId()
    const lineIds = workspace.lines.map(() => createSecureRepairId())
    const command: RepairCommand | null = estimateId && lineIds.every(Boolean) ? {
      command: 'create_estimate',
      payload: {
        estimate_id: estimateId,
        currency: workspace.repair.currency,
        discount_amount: estimateDiscount,
        valid_until: estimateValidUntil ? new Date(estimateValidUntil).toISOString() : null,
        note: nullable(estimateNote),
        lines: workspace.lines.map((line, index) => ({
          id: lineIds[index]!,
          repair_line_id: line.id,
          line_type: line.lineType,
          description: line.description || line.nameSnapshot,
          quantity: String(line.quantity),
          unit_price: String(line.unitPriceSnapshot),
          tax_rate: String(line.vatRateSnapshot),
          display_order: line.displayOrder,
        })),
      },
    } : null
    const canCreateEstimate = Boolean(command && workspace.lines.length > 0 && commandAllowed(command, connectivity, workspace.capabilities.update, hasActiveShift))
    const latestEstimate = workspace.estimates[workspace.estimates.length - 1]
    const approvalId = createSecureRepairId()
    const approvalCommand: RepairCommand | null = latestEstimate && approvalId ? {
      command: 'record_approval',
      payload: {
        approval_id: approvalId,
        estimate_id: latestEstimate.id,
        decision: 'accepted',
        decision_source: 'in_person',
        reason: null,
      },
    } : null
    const canApprove = Boolean(approvalCommand && commandAllowed(approvalCommand, connectivity, workspace.capabilities.approve, hasActiveShift))
    return (
      <section className="space-y-3 border-t border-slate-200 pt-4 dark:border-white/10">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm font-semibold">{t('repairs.actions.discount')}<input type="number" min="0" step="0.01" value={estimateDiscount} onChange={(event) => setEstimateDiscount(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
          <label className="text-sm font-semibold">{t('repairs.actions.validUntil')}<input type="datetime-local" value={estimateValidUntil} onChange={(event) => setEstimateValidUntil(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
          <label className="text-sm font-semibold">{t('repairs.actions.estimateNote')}<input value={estimateNote} onChange={(event) => setEstimateNote(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={isBusy || !canCreateEstimate} onClick={() => command && void run(command)} className="min-h-11 rounded-xl bg-blue-600 px-4 font-semibold text-white disabled:opacity-45">{t('repairs.actions.createEstimate')}</button>
          <button type="button" disabled={isBusy || !canApprove} onClick={() => approvalCommand && void run(approvalCommand)} className="min-h-11 rounded-xl border border-emerald-500 px-4 font-semibold text-emerald-700 disabled:opacity-45 dark:text-emerald-200">{t('repairs.actions.recordApproval')}</button>
        </div>
        {connectivity !== 'online' && <p className="text-xs text-slate-600 dark:text-zinc-400">{t('repairs.messages.estimateOnline')}</p>}
        {workspace.lines.length === 0 && <p className="text-xs text-slate-600 dark:text-zinc-400">{t('repairs.messages.estimateNeedsLines')}</p>}
        {!hasSecureId && <p role="alert" className="text-sm text-red-700 dark:text-red-200">{t('repairs.messages.secureIdUnavailable')}</p>}
        {errorNode}
      </section>
    )
  }

  if (tab === 'photos') {
    const accept = attachmentPolicy?.allowedMimeTypes.join(',')
    const canStagePhoto = workspace.capabilities.manageAttachments
      && hasActiveShift
      && connectivity !== 'unknown'
      && attachmentPolicy !== null
    const choosePhoto = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) return
      const policy = validateRepairAttachmentPolicy(
        { mimeType: file.type, byteSize: file.size },
        attachmentPolicy,
      )
      if (!policy.ok) {
        setError(policy.code === 'REPAIR_ATTACHMENT_MIME_NOT_ALLOWED'
          ? t('repairs.messages.attachmentTypeInvalid')
          : policy.code === 'REPAIR_ATTACHMENT_TOO_LARGE'
            ? t('repairs.messages.attachmentTooLarge')
            : t('repairs.messages.attachmentInvalid'))
        event.target.value = ''
        return
      }
      setError(null)
      try {
        await onStagePhoto(file)
      } catch {
        setError(t('repairs.messages.attachmentStageFailed'))
      } finally {
        if (fileRef.current) fileRef.current.value = ''
      }
    }
    return (
      <section className="space-y-3 border-t border-slate-200 pt-4 dark:border-white/10">
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-blue-600 px-4 font-semibold text-white aria-disabled:cursor-not-allowed aria-disabled:opacity-45" aria-disabled={isBusy || !canStagePhoto} aria-describedby={!canStagePhoto ? 'repair-photo-disabled-reason' : undefined}>
          <Camera aria-hidden className="h-4 w-4" />
          {t('repairs.actions.stagePhoto')}
          <input ref={fileRef} type="file" accept={accept} disabled={isBusy || !canStagePhoto} onChange={(event) => void choosePhoto(event)} className="sr-only" />
        </label>
        {!canStagePhoto && <p id="repair-photo-disabled-reason" className="text-xs text-slate-600 dark:text-zinc-400">{t('repairs.messages.photoUnavailable')}</p>}
        <p className="text-xs text-slate-600 dark:text-zinc-400">{t('repairs.messages.photoOneShot')}</p>
        {errorNode}
      </section>
    )
  }

  return null
}
