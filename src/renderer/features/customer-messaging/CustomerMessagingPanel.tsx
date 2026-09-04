import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CustomerMessagingPosWorkspace } from '../../../shared/types/customer-messaging'
import { openExternalUrl } from '../../utils/external-url'
import {
  CustomerMessagingPreferencePicker,
  type CustomerMessagingPreferenceSelection,
} from './CustomerMessagingPreferencePicker'
import { customerMessagingService } from './service'

interface CustomerMessagingPanelProps {
  customerId: string | null
  repairId: string
  repairVersion: number
  repairNumber: string
  customerName: string
  deviceLabel: string
  online: boolean
}

const safeProviderLink = /^https:\/\/t\.me\/[A-Za-z0-9_?=&-]{1,900}$/

export function CustomerMessagingPanel(props: CustomerMessagingPanelProps) {
  const { t } = useTranslation()
  const [workspace, setWorkspace] = useState<CustomerMessagingPosWorkspace | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const retryOperationKeys = useRef<Record<string, string>>({})
  const loadRequest = useRef(0)
  const operationInFlight = useRef(false)
  const activeCustomerId = useRef(props.customerId)
  activeCustomerId.current = props.customerId

  const activeWorkspace = workspace?.customerId === props.customerId ? workspace : null

  const beginOperation = () => {
    if (operationInFlight.current) return false
    operationInFlight.current = true
    setBusy(true)
    return true
  }

  const endOperation = () => {
    operationInFlight.current = false
    setBusy(false)
  }

  const load = useCallback(async () => {
    const customerId = props.customerId
    const requestId = ++loadRequest.current
    if (!customerId || !props.online) {
      setWorkspace(null)
      return
    }
    try {
      const nextWorkspace = await customerMessagingService.history(customerId)
      if (
        loadRequest.current === requestId
        && activeCustomerId.current === customerId
        && nextWorkspace.customerId === customerId
      ) {
        setWorkspace(nextWorkspace)
        setNotice(null)
      }
    } catch {
      if (loadRequest.current === requestId && activeCustomerId.current === customerId) {
        setNotice('customerMessaging.unavailable')
      }
    }
  }, [props.customerId, props.online])

  useEffect(() => {
    retryOperationKeys.current = {}
    setWorkspace(current => current?.customerId === props.customerId ? current : null)
    void load()
    return () => { loadRequest.current += 1 }
  }, [load, props.customerId])

  const send = async () => {
    const customerId = props.customerId
    if (!customerId || !activeWorkspace?.permissions.send || activeWorkspace.operationalLocked || !props.online || !beginOperation()) return
    try {
      await customerMessagingService.send({
        customerId,
        repairId: props.repairId,
        repairVersion: props.repairVersion,
        idempotencyKey: `repair-ready:${props.repairId}:v${props.repairVersion}`,
      })
      if (activeCustomerId.current === customerId) {
        setNotice('customerMessaging.queued')
        await load()
      }
    } catch {
      if (activeCustomerId.current === customerId) setNotice('customerMessaging.sendFailed')
    } finally { endOperation() }
  }

  const retry = async (messageId: string) => {
    const customerId = props.customerId
    if (!customerId || !activeWorkspace?.permissions.retry || activeWorkspace.operationalLocked || !props.online || !beginOperation()) return
    try {
      const operationKey = retryOperationKeys.current[messageId] ?? globalThis.crypto.randomUUID()
      retryOperationKeys.current[messageId] = operationKey
      await customerMessagingService.retry({ messageId, idempotencyKey: operationKey })
      delete retryOperationKeys.current[messageId]
      if (activeCustomerId.current === customerId) {
        setNotice('customerMessaging.queued')
        await load()
      }
    } catch {
      if (activeCustomerId.current === customerId) setNotice('customerMessaging.retryFailed')
    } finally { endOperation() }
  }

  const link = async (connectionId: string) => {
    const customerId = props.customerId
    if (!customerId || !activeWorkspace?.permissions.link || activeWorkspace.operationalLocked || !props.online || !beginOperation()) return
    try {
      const result = await customerMessagingService.link({ customerId, connectionId, expiresInSeconds: 600 })
      if (!safeProviderLink.test(result.deepLink) || !await openExternalUrl(result.deepLink)) throw new Error('LINK_REJECTED')
      if (activeCustomerId.current === customerId) setNotice('customerMessaging.linkOpened')
    } catch {
      if (activeCustomerId.current === customerId) setNotice('customerMessaging.linkFailed')
    } finally { endOperation() }
  }

  const preference = async (input: CustomerMessagingPreferenceSelection) => {
    const customerId = props.customerId
    if (!customerId || !activeWorkspace?.permissions.link || activeWorkspace.operationalLocked || !props.online || !beginOperation()) return
    try {
      await customerMessagingService.preference({ customerId, ...input })
      if (activeCustomerId.current === customerId) await load()
    } catch {
      if (activeCustomerId.current === customerId) setNotice('customerMessaging.preferenceFailed')
    } finally { endOperation() }
  }

  if (!props.customerId) return <p className="text-sm text-slate-600 dark:text-zinc-400">{t('customerMessaging.customerRequired')}</p>
  if (!props.online) return <p className="text-sm text-amber-700 dark:text-amber-300">{t('customerMessaging.onlineOnly')}</p>

  return (
    <section className="space-y-3" aria-label={t('customerMessaging.title')}>
      {notice && <p role="status" className="text-sm text-slate-600 dark:text-zinc-300">{t(notice)}</p>}
      {activeWorkspace?.operationalLocked && <p className="rounded-xl border border-amber-500/30 p-3 text-sm">{t('customerMessaging.readOnly')}</p>}
      {activeWorkspace?.preference.decision !== 'allow' && activeWorkspace && (
        <p className="text-sm">{t(activeWorkspace.preference.decision === 'deny' ? 'customerMessaging.optedOut' : 'customerMessaging.noPreference')}</p>
      )}
      {activeWorkspace && <CustomerMessagingPreferencePicker workspace={activeWorkspace} busy={busy}
        onSelect={(selection) => void preference(selection)} />}
      <ul className="space-y-2">
        {activeWorkspace?.channels.map(channel => <li key={`${channel.channel}-${channel.displayLabel}`} className="flex min-h-11 items-center justify-between rounded-xl border border-slate-200 px-3 dark:border-white/10"><span>{channel.channel.toUpperCase()}</span><span>{channel.displayLabel}</span></li>)}
        {activeWorkspace?.messages.map(message => (
          <li key={message.id} className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
            <div className="flex min-h-11 items-center justify-between"><span>{t(`customerMessaging.status.${message.status}`)}</span><span>{message.displayLabel}</span></div>
            <p className="text-sm text-slate-600 dark:text-zinc-400">{t('customerMessaging.attemptCount', { count: message.attemptCount })}</p>
            {message.safeReasonCode && <p className="text-sm text-slate-600 dark:text-zinc-400">{message.safeReasonCode}</p>}
            <ol className="space-y-1">
              {message.attempts.map(attempt => (
                <li key={`${message.id}-${attempt.number}`} className="min-h-11 rounded-lg border border-slate-200 p-2 text-sm dark:border-white/10">
                  <span>{t('customerMessaging.attempt', { number: attempt.number })}</span>
                  <span className="ml-2 text-slate-600 dark:text-zinc-400">{attempt.provider} · {t(`customerMessaging.status.${attempt.status}`)} · {attempt.createdAt}</span>
                  {attempt.safeReasonCode && <span className="ml-2 text-slate-600 dark:text-zinc-400">{attempt.safeReasonCode}</span>}
                </li>
              ))}
            </ol>
            {message.retryEligible && activeWorkspace.permissions.retry && !activeWorkspace.operationalLocked && <button className="min-h-11 rounded-xl border px-4" disabled={busy} onClick={() => void retry(message.id)}>{t('customerMessaging.retry')}</button>}
          </li>
        ))}
      </ul>
      {(activeWorkspace?.linkTargets ?? []).map(target => {
        if (target.linkingStatus !== 'available') {
          return <button key={target.connectionId} type="button" className="min-h-11 rounded-xl border px-4 opacity-60" disabled>{t('customerMessaging.linkingUnavailable', { provider: target.channel, defaultValue: `${target.channel.toUpperCase()} customer linking is unavailable.` })}</button>
        }
        return activeWorkspace?.permissions.link && !activeWorkspace.operationalLocked
          ? <button key={target.connectionId} type="button" className="min-h-11 rounded-xl border px-4" disabled={busy} onClick={() => void link(target.connectionId)}>{t('customerMessaging.link', { provider: target.channel })}</button>
          : null
      })}
      {activeWorkspace?.permissions.send && !activeWorkspace.operationalLocked && activeWorkspace.preference.decision === 'allow' && <button className="min-h-11 rounded-xl bg-blue-600 px-4 font-semibold text-white" disabled={busy} onClick={() => void send()}>{t('customerMessaging.sendReady')}</button>}
    </section>
  )
}
