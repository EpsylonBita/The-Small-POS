import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
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
  
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

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
  const details = (r: WaiterServiceRequest) => <motion.div {...revealMotion} key={r.id} className="pos-glass-form-card space-y-2">
    <p className="font-bold">{t('waiterService.table', { table: r.summary.table_number })} · {serviceRequestOrderLabel(r.summary)}</p>
    <p>{t(r.assignment_required?'waiterService.qrRequest':`waiterService.kind.${r.kind}`)}</p>
    <p>{r.summary.requester_name}{r.summary.recipient_name&&<> → {r.summary.recipient_name}</>}</p>
    <AnimatePresence initial={false}>{r.summary.customer_notes&&<motion.p {...revealMotion}>{r.summary.customer_notes}</motion.p>}</AnimatePresence>
    <AnimatePresence initial={false}>{r.summary.destination_table && <motion.p {...revealMotion}>{t('waiterService.destination', { table: r.summary.destination_table })}</motion.p>}</AnimatePresence>
    {r.summary.items.map((line,i) => <div key={i}><p>{line.quantity} × {line.name}</p><AnimatePresence initial={false}>{line.notes && <motion.p {...revealMotion}>{line.notes}</motion.p>}</AnimatePresence>
      {serviceRequestModifiers(line.customizations).map((name,j) => <p key={j}>{name}</p>)}</div>)}
    <AnimatePresence initial={false}>{r.assignment_required&&!inbox.isMain&&<motion.div {...revealMotion} className="space-y-3">
      <p>{t('waiterService.awaitingAssignment')}</p>
      {inbox.assignments?.[r.id]?<p role="status">{t('waiterService.awaitingDelivery')}</p>:<>
        <select data-testid={`waiter-intake-recipient-${r.id}`} aria-label={t('waiterService.chooseWaiter')} value={recipients[r.id]||''}
          disabled={inbox.busy||inbox.stale||!inbox.canAssign} onChange={event=>setRecipients(value=>({...value,[r.id]:event.target.value}))}
          className="pos-glass-field min-h-12 w-full px-3">
          <option value="">{t('waiterService.chooseWaiter')}</option>
          {(inbox.waiters||[]).map(waiter=><option key={waiter.id} value={waiter.id}>{waiter.name}</option>)}
        </select>
        <AnimatePresence initial={false}>{!inbox.waiters?.length&&<motion.p {...revealMotion}>{t('waiterService.noActiveWaiters')}</motion.p>}</AnimatePresence>
        <button data-testid={`waiter-intake-assign-${r.id}`} disabled={inbox.busy||inbox.stale||!inbox.canAssign||!inbox.waiters?.some(waiter=>waiter.id===recipients[r.id])}
          onClick={()=>{void inbox.assign(r.id,recipients[r.id])}} className="min-h-12 w-full rounded-lg bg-blue-700 px-4 py-3 text-white disabled:opacity-50">{t('waiterService.assign')}</button>
      </>}
    </motion.div>}</AnimatePresence>
    <AnimatePresence initial={false}>{!current&&!r.assignment_required&&<motion.p {...revealMotion} className="font-semibold">{inbox.decisions[r.id] ? t('waiterService.awaitingDelivery') : t(`waiterService.status.${r.status}`)}</motion.p>}</AnimatePresence>
    {inbox.isMain&&(r.resolution_required||r.assignment_required)&&<MainServiceResolutionActions key={r.id} request={r} inbox={inbox}/>}
    <AnimatePresence initial={false}>{!inbox.isMain && !current && rejections.some(notice => notice.id === r.id) && <motion.div {...revealMotion} className="space-y-2">
      <p>{t(r.intake_id ? 'waiterService.rejectedQrHelp' : 'waiterService.rejectedChangeHelp')}</p>
      <button data-testid={`waiter-service-ack-${r.id}`} disabled={inbox.busy} onClick={() => { void inbox.acknowledgeRejection(r.id) }}
        className="min-h-12 rounded-lg border border-gray-400 px-4 py-2">{t('waiterService.acknowledgeRejection')}</button>
    </motion.div>}</AnimatePresence>
  </motion.div>
  if (!enabled || !inbox.available) return null
  return <>
    {inbox.actionable && <div className="fixed bottom-5 left-5 z-9000 flex max-w-sm flex-col gap-2">
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
      className="[&_.liquid-glass-modal-header]:border-b-0!" title={t(current ? 'waiterService.incoming' : mainCurrent ? 'waiterService.mainResolutionTitle' : 'waiterService.requests')} size="lg" closeDisabled={blocking} closeMode={blocking ? 'request' : undefined}>
      <div className="space-y-3 liquid-glass-modal-text" data-testid="waiter-service-dialog">
        <div key={current?.id ?? mainCurrent?.id ?? 'overview'} className="max-h-[55vh] space-y-3 overflow-y-auto"><AnimatePresence initial={false}>{current ? details(current) : mainCurrent ? details(mainCurrent) : (inbox.overviewRequests || inbox.requests).map(details)}
          {!current&&!mainCurrent&&(inbox.resolutionHistory||[]).map(receipt=><motion.div {...revealMotion} key={receipt.id} className="pos-glass-form-card space-y-2" data-testid="main-service-resolution-history">
            <p className="font-bold">{t(`waiterService.resolutionStatus.${receipt.action}`)}</p>
            <AnimatePresence initial={false}>{receipt.summary&&<motion.div {...revealMotion}><><p>{t('waiterService.table',{table:receipt.summary.table_number})} · {serviceRequestOrderLabel(receipt.summary)}</p>
              {receipt.summary.items.map((item,i)=><p key={i}>{item.quantity} × {item.name}{item.notes?` · ${item.notes}`:''}</p>)}</></motion.div>}</AnimatePresence>
            <p>{receipt.actor_name}</p><AnimatePresence initial={false}>{receipt.reason&&<motion.p {...revealMotion}>{receipt.reason}</motion.p>}</AnimatePresence>
          </motion.div>)}
          <AnimatePresence initial={false}>{!current && !inbox.requests.length && !inbox.resolutionHistory?.length && !inbox.stale && <motion.p {...revealMotion}>{t('waiterService.empty')}</motion.p>}</AnimatePresence></AnimatePresence></div>
        <AnimatePresence initial={false}>{inbox.stale && !loginRequired && <motion.p {...revealMotion} role="alert" className="text-amber-700 dark:text-amber-300">{t('waiterService.stale')}</motion.p>}</AnimatePresence>
        <AnimatePresence initial={false}>{inbox.noticeFailure && <motion.p {...revealMotion} role="alert" className="text-amber-700 dark:text-amber-300">{t('waiterService.noticeSaveFailed')}</motion.p>}</AnimatePresence>
        <AnimatePresence initial={false}>{retained && <motion.p {...revealMotion} role="alert">{t('waiterService.awaitingDelivery')}</motion.p>}</AnimatePresence>
        <AnimatePresence initial={false}>{loginRequired && <motion.div {...revealMotion} className="pos-glass-form-card space-y-3"><p>{t('waiterService.signIn')}{inbox.mainLogin?.name ? ` · ${inbox.mainLogin.name}` : ''}</p>
          <input data-testid="waiter-service-pin" type="password" inputMode="numeric" value={pin} maxLength={8} disabled={signingIn}
            aria-label={t('waiterService.pin')} onChange={event => setPin(event.target.value.replace(/\D/g,''))} className="liquid-glass-modal-input pos-glass-field min-h-touch w-full p-3" />
          <button disabled={signingIn || pin.length < 4} onClick={() => { void renewLogin() }} className="rounded-lg bg-blue-700 px-4 py-3 text-white">{t('waiterService.signIn')}</button>
          <AnimatePresence initial={false}>{signInFailed && <motion.p {...revealMotion} role="alert">{t('waiterService.signInFailed')}</motion.p>}</AnimatePresence></motion.div>}</AnimatePresence>
        <AnimatePresence initial={false}>{current && !retained && !loginRequired && <motion.div {...revealMotion} className="flex justify-between gap-4 px-6 pb-5 pt-2">
          <button data-testid="waiter-service-reject" disabled={inbox.busy} onClick={() => { void inbox.choose(current.id,'rejected') }} className="rounded-lg bg-red-700 px-5 py-3 text-white">{t('waiterService.reject')}</button>
          <button data-testid="waiter-service-accept" disabled={inbox.busy} onClick={() => { void inbox.choose(current.id,'accepted') }} className="pos-raised pos-raised--yellow rounded-lg bg-(--pos-s-yellow) px-5 py-3 text-black">{t('waiterService.accept')}</button>
        </motion.div>}</AnimatePresence>
        <AnimatePresence initial={false}>{(inbox.stale || retained) && <motion.div {...revealMotion}><button onClick={() => { void inbox.retry() }} className="pos-glass-field min-h-touch px-4 py-2">{t('common.retry')}</button></motion.div>}</AnimatePresence>
      </div>
    </LiquidGlassModal>
  </>
}
