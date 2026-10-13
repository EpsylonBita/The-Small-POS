import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LiquidGlassModal } from '../ui/pos-glass-components'
import { useWaiterServiceInbox } from '../../hooks/useWaiterServiceInbox'
import type { WaiterServiceRequest } from '../../../../../shared/types/waiter-service-request'
import { serviceRequestModifiers } from '../../../../../shared/pos/tables/service-request-modifiers'
import { serviceRequestOrderLabel } from '../../../../../shared/pos/tables/service-request-order-label'
import { SERVICE_OVERVIEW_OPEN_EVENT } from '../../../../../shared/pos/tables/WaiterServiceInbox'
import { useShift } from '../../contexts/shift-context'
import { getSecureSessionSync, setSecureSession } from '../../lib/secure-session-cache'
import { posApiPost } from '../../utils/api-helpers'
import { MainServiceResolutionActions } from './MainServiceResolutionActions'

export function WaiterServiceRequestManager({ enabled }: { enabled: boolean }) {
  const inbox = useWaiterServiceInbox(enabled), { t } = useTranslation()
  const [overview, setOverview] = useState(false)
  const [recipients,setRecipients]=useState<Record<string,string>>({})
  const { staff } = useShift()
  const [pin, setPin] = useState(''), [signingIn, setSigningIn] = useState(false), [signInFailed, setSignInFailed] = useState(false)
  const loginRequired = inbox.failure === 'SERVICE_LOGIN_REQUIRED'
  const authEpoch = useRef(0)
  useEffect(() => () => { authEpoch.current += 1 }, [enabled, staff?.staffId, staff?.organizationId, staff?.branchId, staff?.terminalId])
  const current = enabled ? inbox.current : null, retained = current ? inbox.decisions[current.id] : null
  const mainCurrent = enabled && !current ? inbox.mainCurrent : null
  const blocking = !!current || !!mainCurrent
  const rejections = inbox.rejections || []
  useEffect(() => { if (!enabled) { setOverview(false); setPin('');setRecipients({}) } }, [enabled])
  // The full list is opened from Settings → mobile terminals, not from a permanent chip.
  useEffect(() => { const open = () => setOverview(true); window.addEventListener(SERVICE_OVERVIEW_OPEN_EVENT, open)
    return () => window.removeEventListener(SERVICE_OVERVIEW_OPEN_EVENT, open) }, [])
  const renewLogin = async () => {
    const original = getSecureSessionSync()
    const staffId = staff?.databaseStaffId || staff?.staffId
    if ((!inbox.mainLogin && (!original || !staffId)) || signingIn || pin.length < 4) return
    const enteredPin = pin; const epoch = authEpoch.current; setPin(''); setSigningIn(true); setSignInFailed(false)
    try {
      if (inbox.mainLogin) { await inbox.authorizeMain(enteredPin); return }
      const result = await posApiPost('pos/staff-auth/check-in', { staffId, pin: enteredPin, sessionHours: 8 })
      if (epoch !== authEpoch.current) return
      if (!original || !result.success || !result.data?.session_id || getSecureSessionSync()?.staffId !== original.staffId) throw new Error('SERVICE_LOGIN_REQUIRED')
      await setSecureSession({ ...original, sessionId: result.data.session_id })
    } catch { if (epoch === authEpoch.current) setSignInFailed(true) } finally { if (epoch === authEpoch.current) setSigningIn(false) }
  }
  const details = (r: WaiterServiceRequest) => <div key={r.id} className="space-y-2 rounded-xl border border-gray-300 p-4 dark:border-gray-700">
    <p className="font-bold">{t('waiterService.table', { table: r.summary.table_number })} · {serviceRequestOrderLabel(r.summary)}</p>
    <p>{t(r.assignment_required?'waiterService.qrRequest':`waiterService.kind.${r.kind}`)}</p>
    <p>{r.summary.requester_name}{r.summary.recipient_name&&<> → {r.summary.recipient_name}</>}</p>
    {r.summary.customer_notes&&<p>{r.summary.customer_notes}</p>}
    {r.summary.destination_table && <p>{t('waiterService.destination', { table: r.summary.destination_table })}</p>}
    {r.summary.items.map((line,i) => <div key={i}><p>{line.quantity} × {line.name}</p>{line.notes && <p>{line.notes}</p>}
      {serviceRequestModifiers(line.customizations).map((name,j) => <p key={j}>{name}</p>)}</div>)}
    {r.assignment_required&&!inbox.isMain&&<div className="space-y-3">
      <p>{t('waiterService.awaitingAssignment')}</p>
      {inbox.assignments?.[r.id]?<p role="status">{t('waiterService.awaitingDelivery')}</p>:<>
        <select data-testid={`waiter-intake-recipient-${r.id}`} aria-label={t('waiterService.chooseWaiter')} value={recipients[r.id]||''}
          disabled={inbox.busy||inbox.stale||!inbox.canAssign} onChange={event=>setRecipients(value=>({...value,[r.id]:event.target.value}))}
          className="min-h-12 w-full rounded-lg border border-gray-300 bg-white px-3 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white">
          <option value="">{t('waiterService.chooseWaiter')}</option>
          {(inbox.waiters||[]).map(waiter=><option key={waiter.id} value={waiter.id}>{waiter.name}</option>)}
        </select>
        {!inbox.waiters?.length&&<p>{t('waiterService.noActiveWaiters')}</p>}
        <button data-testid={`waiter-intake-assign-${r.id}`} disabled={inbox.busy||inbox.stale||!inbox.canAssign||!inbox.waiters?.some(waiter=>waiter.id===recipients[r.id])}
          onClick={()=>{void inbox.assign(r.id,recipients[r.id])}} className="min-h-12 w-full rounded-lg bg-blue-700 px-4 py-3 text-white disabled:opacity-50">{t('waiterService.assign')}</button>
      </>}
    </div>}
    {!current&&!r.assignment_required&&<p className="font-semibold">{inbox.decisions[r.id] ? t('waiterService.awaitingDelivery') : t(`waiterService.status.${r.status}`)}</p>}
    {inbox.isMain&&(r.resolution_required||r.assignment_required)&&<MainServiceResolutionActions key={r.id} request={r} inbox={inbox}/>}
    {!inbox.isMain && !current && rejections.some(notice => notice.id === r.id) && <div className="space-y-2">
      <p>{t(r.intake_id ? 'waiterService.rejectedQrHelp' : 'waiterService.rejectedChangeHelp')}</p>
      <button data-testid={`waiter-service-ack-${r.id}`} disabled={inbox.busy} onClick={() => { void inbox.acknowledgeRejection(r.id) }}
        className="min-h-12 rounded-lg border border-gray-400 px-4 py-2">{t('waiterService.acknowledgeRejection')}</button>
    </div>}
  </div>
  if (!enabled || !inbox.available) return null
  return <>
    {inbox.actionable && <div className="fixed bottom-5 left-5 z-[9000] flex max-w-sm flex-col gap-2">
      {rejections.length > 0 && <button data-testid="waiter-service-rejection-alert" onClick={() => setOverview(true)}
        className="rounded-xl border border-red-500 bg-red-50 px-4 py-3 text-left text-red-900 shadow-lg dark:bg-red-950 dark:text-red-100">
        <span role="alert" className="block font-bold">{t('waiterService.unreadRejections', { count: rejections.length })}</span>
        <span>{t('waiterService.rejectionSummary', { waiter: rejections[0].summary.recipient_name, table: rejections[0].summary.table_number })}</span>
      </button>}
      <button data-testid="waiter-service-overview" onClick={() => setOverview(true)}
        className="rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-900 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-white">
        {t('waiterService.requests')} · {inbox.requests.filter(r => r.status === 'pending').length}</button>
    </div>}
    <LiquidGlassModal isOpen={blocking || overview} onClose={blocking ? () => {} : () => setOverview(false)} closeOnBackdrop={!blocking} closeOnEscape={!blocking}
      title={t(current ? 'waiterService.incoming' : mainCurrent ? 'waiterService.mainResolutionTitle' : 'waiterService.requests')} size="lg" closeDisabled={blocking} closeMode={blocking ? 'request' : undefined}>
      <div className="space-y-4 text-gray-900 dark:text-gray-100" data-testid="waiter-service-dialog">
        <div key={current?.id ?? mainCurrent?.id ?? 'overview'} className="max-h-[55vh] space-y-4 overflow-y-auto">{current ? details(current) : mainCurrent ? details(mainCurrent) : (inbox.overviewRequests || inbox.requests).map(details)}
          {!current&&!mainCurrent&&(inbox.resolutionHistory||[]).map(receipt=><div key={receipt.id} className="space-y-2 rounded-xl border border-gray-300 p-4 dark:border-gray-700" data-testid="main-service-resolution-history">
            <p className="font-bold">{t(`waiterService.resolutionStatus.${receipt.action}`)}</p>
            {receipt.summary&&<><p>{t('waiterService.table',{table:receipt.summary.table_number})} · {serviceRequestOrderLabel(receipt.summary)}</p>
              {receipt.summary.items.map((item,i)=><p key={i}>{item.quantity} × {item.name}{item.notes?` · ${item.notes}`:''}</p>)}</>}
            <p>{receipt.actor_name}</p>{receipt.reason&&<p>{receipt.reason}</p>}
          </div>)}
          {!current && !inbox.requests.length && !inbox.resolutionHistory?.length && !inbox.stale && <p>{t('waiterService.empty')}</p>}</div>
        {inbox.stale && !loginRequired && <p role="alert" className="text-amber-700 dark:text-amber-300">{t('waiterService.stale')}</p>}
        {inbox.noticeFailure && <p role="alert" className="text-amber-700 dark:text-amber-300">{t('waiterService.noticeSaveFailed')}</p>}
        {retained && <p role="alert">{t('waiterService.awaitingDelivery')}</p>}
        {loginRequired && <div className="space-y-3"><p>{t('waiterService.signIn')}{inbox.mainLogin?.name ? ` · ${inbox.mainLogin.name}` : ''}</p>
          <input data-testid="waiter-service-pin" type="password" inputMode="numeric" value={pin} maxLength={8} disabled={signingIn}
            aria-label={t('waiterService.pin')} onChange={event => setPin(event.target.value.replace(/\D/g,''))} className="w-full rounded-lg border p-3 dark:bg-gray-800" />
          <button disabled={signingIn || pin.length < 4} onClick={() => { void renewLogin() }} className="rounded-lg bg-blue-700 px-4 py-3 text-white">{t('waiterService.signIn')}</button>
          {signInFailed && <p role="alert">{t('waiterService.signInFailed')}</p>}</div>}
        {current && !retained && !loginRequired && <div className="flex justify-between gap-4">
          <button data-testid="waiter-service-reject" disabled={inbox.busy} onClick={() => { void inbox.choose(current.id,'rejected') }} className="rounded-lg bg-red-700 px-5 py-3 text-white">{t('waiterService.reject')}</button>
          <button data-testid="waiter-service-accept" disabled={inbox.busy} onClick={() => { void inbox.choose(current.id,'accepted') }} className="rounded-lg bg-green-700 px-5 py-3 text-white">{t('waiterService.accept')}</button>
        </div>}
        {(inbox.stale || retained) && <button onClick={() => { void inbox.retry() }} className="rounded-lg border px-4 py-2">{t('common.retry')}</button>}
      </div>
    </LiquidGlassModal>
  </>
}
