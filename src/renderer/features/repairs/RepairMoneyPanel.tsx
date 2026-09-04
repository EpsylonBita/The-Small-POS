import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { RepairCapabilitiesSnapshot, RepairStatus } from './contracts'
import type { RepairConnectivity } from './policy'
import {
  repairMoneyApiService,
  type RepairFinancialProjection,
} from '../../services/RepairMoneyApiService'
import { createSecureRepairId } from './secure-id'

export type RepairMoneyService = Pick<typeof repairMoneyApiService,
  | 'getSettlement'
  | 'createOrRefreshSettlement'
  | 'recordPayment'
  | 'recordRefund'
  | 'fiscalize'
  | 'deliver'
>

export interface RepairMoneyPanelProps {
  repairId: string
  repairVersion: number
  repairStatus: RepairStatus
  currency: string
  capabilities: RepairCapabilitiesSnapshot
  allowedTransitions: RepairStatus[]
  hasAcceptedEstimate: boolean
  repairDepositSupported: boolean
  connectivity: RepairConnectivity
  hasActiveShift: boolean
  isBusy: boolean
  moneyService?: RepairMoneyService
  onBusyChange: (busy: boolean) => void
  onAuthoritativeRefresh: (repairId: string) => Promise<void>
}

interface StableOperation {
  operationId: string
  occurredAt: string
}

const MAX_REPAIR_MONEY_MINOR = 999_999_999_999
const PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]+$/

function toMinor(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const minor = Math.round(amount * 100)
  return minor <= MAX_REPAIR_MONEY_MINOR ? minor : null
}

export function RepairMoneyPanel({
  repairId,
  repairVersion,
  repairStatus,
  currency,
  capabilities,
  allowedTransitions,
  hasAcceptedEstimate,
  repairDepositSupported,
  connectivity,
  hasActiveShift,
  isBusy,
  moneyService = repairMoneyApiService,
  onBusyChange,
  onAuthoritativeRefresh,
}: RepairMoneyPanelProps) {
  const { t, i18n } = useTranslation()
  const [projection, setProjection] = useState<RepairFinancialProjection | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'digital_wallet' | 'other'>('cash')
  const [providerReference, setProviderReference] = useState('')
  const [refundPaymentId, setRefundPaymentId] = useState('')
  const [refundAmount, setRefundAmount] = useState('')
  const [refundMethod, setRefundMethod] = useState<'cash' | 'card'>('cash')
  const [refundReason, setRefundReason] = useState('')
  const [deliveryReason, setDeliveryReason] = useState('')
  const operations = useRef(new Map<string, StableOperation>())
  const projectionRequest = useRef(0)
  const activeRepairId = useRef(repairId)
  activeRepairId.current = repairId
  const activeProjection = projection?.repair_id === repairId ? projection : null

  const onlineReadReady = connectivity === 'online'
  const onlineActionReady = onlineReadReady && hasActiveShift
  const busy = isBusy || isRunning

  const formatMoney = useMemo(() => new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency,
  }), [currency, i18n.language])

  const loadProjection = useCallback(async () => {
    const requestedRepairId = repairId
    const requestId = ++projectionRequest.current
    if (!onlineReadReady) {
      setProjection(null)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const nextProjection = await moneyService.getSettlement(requestedRepairId)
      if (
        projectionRequest.current !== requestId
        || activeRepairId.current !== requestedRepairId
      ) return
      if (nextProjection.currency !== currency) {
        throw new Error('REPAIR_FINANCIAL_CURRENCY_MISMATCH')
      }
      setProjection(nextProjection)
    } catch (loadError) {
      if (
        projectionRequest.current !== requestId
        || activeRepairId.current !== requestedRepairId
      ) return
      setProjection(null)
      setError(loadError instanceof Error
        ? loadError.message
        : 'REPAIR_FINANCIAL_PROJECTION_UNAVAILABLE')
    } finally {
      if (projectionRequest.current === requestId) setIsLoading(false)
    }
  }, [currency, moneyService, onlineReadReady, repairId])

  useEffect(() => {
    setProjection(null)
    operations.current.clear()
    setPaymentAmount('')
    setRefundAmount('')
    setRefundPaymentId('')
    setRefundReason('')
    setDeliveryReason('')
    void loadProjection()
    return () => { projectionRequest.current += 1 }
  }, [loadProjection, repairVersion])

  const stableOperation = (key: string): StableOperation | null => {
    const existing = operations.current.get(key)
    if (existing) return existing
    const operationId = createSecureRepairId()
    if (!operationId) return null
    const created = { operationId, occurredAt: new Date().toISOString() }
    operations.current.set(key, created)
    return created
  }

  const run = async (
    key: string,
    execute: (operation: StableOperation) => Promise<{ success: boolean; error?: string }>,
  ) => {
    if (!onlineActionReady || busy) return
    const actionRepairId = repairId
    const operation = stableOperation(key)
    if (!operation) {
      setError('REPAIR_SECURE_OPERATION_ID_UNAVAILABLE')
      return
    }
    setError(null)
    setIsRunning(true)
    onBusyChange(true)
    try {
      const result = await execute(operation)
      if (!result.success) throw new Error(result.error || 'REPAIR_MONEY_ACTION_FAILED')
      operations.current.delete(key)
      if (activeRepairId.current !== actionRepairId) return
      await onAuthoritativeRefresh(actionRepairId)
      await loadProjection()
    } catch (actionError) {
      // Keep the complete operation identity for an explicit retry after an
      // ambiguous transport result. The server owns replay detection.
      if (activeRepairId.current === actionRepairId) {
        setError(actionError instanceof Error ? actionError.message : 'REPAIR_MONEY_ACTION_FAILED')
      }
    } finally {
      setIsRunning(false)
      onBusyChange(false)
    }
  }

  const baseIntent = (operation: StableOperation) => ({
    operation_id: operation.operationId,
    repair_id: repairId,
    expected_version: repairVersion,
    occurred_at: operation.occurredAt,
  })

  const paymentMinor = toMinor(paymentAmount)
  const normalizedProviderReference = providerReference.trim()
  const providerReferenceAllowed = normalizedProviderReference.length === 0
    || (normalizedProviderReference.length <= 200
      && PROVIDER_REFERENCE_PATTERN.test(normalizedProviderReference))
  const paymentAllowed = onlineActionReady
    && capabilities.collectPayments
    && hasAcceptedEstimate
    && activeProjection !== null
    && paymentMinor !== null
    && paymentMinor <= activeProjection.balance_minor
    && providerReferenceAllowed
    && (paymentMinor === activeProjection.balance_minor || repairDepositSupported)
  const selectedPayment = activeProjection?.payments.find((payment) => payment.id === refundPaymentId) ?? null
  const refundMinor = toMinor(refundAmount)
  const refundAllowed = onlineActionReady
    && capabilities.refundPayments
    && selectedPayment !== null
    && refundMinor !== null
    && refundMinor <= selectedPayment.refundable_minor
    && refundReason.trim().length > 0
    && refundReason.trim().length <= 1_000
  const balanceMinor = activeProjection?.balance_minor ?? null
  const deliveryHasBalance = balanceMinor !== null && balanceMinor > 0
  const deliveryAllowed = onlineActionReady
    && capabilities.update
    && allowedTransitions.includes('delivered')
    && repairStatus === 'ready'
    && balanceMinor !== null
    && (!deliveryHasBalance
      || (capabilities.overrideDeliveryBalance && deliveryReason.trim().length > 0))
    && deliveryReason.trim().length <= 1_000

  return (
    <section className="space-y-5" aria-label={t('repairs.money.title', { defaultValue: 'Repair payments' })}>
      {connectivity !== 'online' && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          {t('repairs.money.onlineRequired', { defaultValue: 'Payments require an online connection.' })}
        </p>
      )}
      {connectivity === 'online' && !hasActiveShift && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          {t('repairs.money.activeShiftRequired', { defaultValue: 'Open a shift to perform repair money actions.' })}
        </p>
      )}
      {isLoading && <p role="status">{t('repairs.money.loading', { defaultValue: 'Loading settlement…' })}</p>}
      {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-800 dark:text-red-200">{error}</p>}

      {activeProjection && (
        <dl className="grid gap-3 sm:grid-cols-3">
          <div><dt className="text-xs font-semibold uppercase text-slate-500">{t('repairs.money.total', { defaultValue: 'Total' })}</dt><dd className="font-semibold">{formatMoney.format(activeProjection.total_minor / 100)}</dd></div>
          <div><dt className="text-xs font-semibold uppercase text-slate-500">{t('repairs.money.paid', { defaultValue: 'Paid' })}</dt><dd className="font-semibold">{formatMoney.format((activeProjection.paid_minor - activeProjection.refunded_minor) / 100)}</dd></div>
          <div><dt className="text-xs font-semibold uppercase text-slate-500">{t('repairs.money.balance', { defaultValue: 'Balance' })}</dt><dd className="font-semibold">{formatMoney.format(activeProjection.balance_minor / 100)}</dd></div>
        </dl>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !onlineActionReady || !capabilities.update || !hasAcceptedEstimate}
          onClick={() => void run(`settlement:${repairVersion}`, (operation) => moneyService.createOrRefreshSettlement({
            ...baseIntent(operation), payload: {},
          }))}
          className="min-h-11 rounded-xl border border-blue-500 px-4 font-semibold disabled:opacity-45"
        >
          {t('repairs.money.createSettlement', { defaultValue: 'Create settlement' })}
        </button>
        <button
          type="button"
          disabled={busy || !onlineActionReady || !capabilities.fiscalize || !activeProjection?.orders.length}
          onClick={() => void run(`fiscalize:${repairVersion}`, (operation) => moneyService.fiscalize({
            ...baseIntent(operation), payload: {},
          }))}
          className="min-h-11 rounded-xl border border-blue-500 px-4 font-semibold disabled:opacity-45"
        >
          {t('repairs.money.fiscalize', { defaultValue: 'Issue fiscal document' })}
        </button>
      </div>

      <fieldset className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-white/10">
        <legend className="px-1 font-semibold">{t('repairs.money.collect', { defaultValue: 'Collect payment' })}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm font-semibold">{t('repairs.money.paymentAmount', { defaultValue: 'Payment amount' })}<input aria-label={t('repairs.money.paymentAmount', { defaultValue: 'Payment amount' })} type="number" min="0.01" step="0.01" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
          <label className="text-sm font-semibold">{t('repairs.money.paymentMethod', { defaultValue: 'Payment method' })}<select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as typeof paymentMethod)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 dark:border-white/15 dark:bg-zinc-900"><option value="cash">Cash</option><option value="card">Card</option><option value="digital_wallet">Digital wallet</option><option value="other">Other</option></select></label>
          <label className="text-sm font-semibold">{t('repairs.money.providerReference', { defaultValue: 'Provider reference' })}<input value={providerReference} onChange={(event) => setProviderReference(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
        </div>
        {!repairDepositSupported && paymentMinor !== null && activeProjection && paymentMinor < activeProjection.balance_minor && <p className="text-xs text-amber-800 dark:text-amber-200">{t('repairs.money.depositUnsupported', { defaultValue: 'Partial repair deposits are not supported by this fiscal profile.' })}</p>}
        <button
          type="button"
          disabled={busy || !paymentAllowed}
          onClick={() => paymentMinor !== null && void run(
            `payment:${repairVersion}:${paymentMinor}:${paymentMethod}:${normalizedProviderReference}`,
            (operation) => moneyService.recordPayment({
              ...baseIntent(operation),
              payload: {
                amount_minor: paymentMinor,
                payment_method: paymentMethod,
                ...(normalizedProviderReference ? { provider_reference: normalizedProviderReference } : {}),
              },
            }),
          )}
          className="min-h-11 rounded-xl bg-blue-600 px-4 font-semibold text-white disabled:opacity-45"
        >
          {t('repairs.money.collect', { defaultValue: 'Collect payment' })}
        </button>
      </fieldset>

      <fieldset className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-white/10">
        <legend className="px-1 font-semibold">{t('repairs.money.refund', { defaultValue: 'Refund payment' })}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-semibold">{t('repairs.money.refundPayment', { defaultValue: 'Payment to refund' })}<select aria-label={t('repairs.money.refundPayment', { defaultValue: 'Payment to refund' })} value={refundPaymentId} onChange={(event) => setRefundPaymentId(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 dark:border-white/15 dark:bg-zinc-900"><option value="">—</option>{activeProjection?.payments.filter((payment) => payment.refundable_minor > 0).map((payment) => <option key={payment.id} value={payment.id}>{formatMoney.format(payment.refundable_minor / 100)} · {payment.payment_method}</option>)}</select></label>
          <label className="text-sm font-semibold">{t('repairs.money.refundAmount', { defaultValue: 'Refund amount' })}<input aria-label={t('repairs.money.refundAmount', { defaultValue: 'Refund amount' })} type="number" min="0.01" step="0.01" value={refundAmount} onChange={(event) => setRefundAmount(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
          <label className="text-sm font-semibold">{t('repairs.money.refundMethod', { defaultValue: 'Refund method' })}<select value={refundMethod} onChange={(event) => setRefundMethod(event.target.value as typeof refundMethod)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 dark:border-white/15 dark:bg-zinc-900"><option value="cash">Cash</option><option value="card">Card</option></select></label>
          <label className="text-sm font-semibold">{t('repairs.money.refundReason', { defaultValue: 'Refund reason' })}<input aria-label={t('repairs.money.refundReason', { defaultValue: 'Refund reason' })} value={refundReason} onChange={(event) => setRefundReason(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>
        </div>
        <button
          type="button"
          disabled={busy || !refundAllowed}
          onClick={() => selectedPayment && refundMinor !== null && void run(
            `refund:${repairVersion}:${selectedPayment.id}:${refundMinor}:${refundMethod}:${refundReason.trim()}`,
            (operation) => moneyService.recordRefund({
              ...baseIntent(operation),
              payload: {
                payment_id: selectedPayment.id,
                amount_minor: refundMinor,
                refund_method: refundMethod,
                reason: refundReason.trim(),
              },
            }),
          )}
          className="min-h-11 rounded-xl border border-amber-500 px-4 font-semibold disabled:opacity-45"
        >
          {t('repairs.money.refund', { defaultValue: 'Refund payment' })}
        </button>
      </fieldset>

      <fieldset className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-white/10">
        <legend className="px-1 font-semibold">{t('repairs.money.delivery', { defaultValue: 'Delivery' })}</legend>
        {deliveryHasBalance && <label className="block text-sm font-semibold">{t('repairs.money.deliveryReason', { defaultValue: 'Delivery override reason' })}<input aria-label={t('repairs.money.deliveryReason', { defaultValue: 'Delivery override reason' })} value={deliveryReason} onChange={(event) => setDeliveryReason(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-transparent px-3 dark:border-white/15" /></label>}
        <button
          type="button"
          disabled={busy || !deliveryAllowed}
          onClick={() => void run(
            `delivery:${repairVersion}:${deliveryReason.trim()}`,
            (operation) => moneyService.deliver({
              ...baseIntent(operation),
              payload: { reason: deliveryReason.trim() || null },
            }),
          )}
          className="min-h-11 rounded-xl bg-emerald-600 px-4 font-semibold text-white disabled:opacity-45"
        >
          {t('repairs.money.deliver', { defaultValue: 'Deliver repair' })}
        </button>
      </fieldset>
    </section>
  )
}
