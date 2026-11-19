import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePrivilegedActionConfirmation } from '../../hooks/usePrivilegedActionConfirmation';
import { useOrderNotices, refreshOrderNotices, openOrderNotice, readOrderNoticeStatus } from '../../services/OrderSyncNoticeStore';
import { acquireRecoveryAction, buildRecoveryActionRequest, executeHealthRecoveryAction, orderRecoveryFeedback, recoveryFailureCode } from '../../services/support/SupportRemedyRunner';
import { customerCorrectionIssue } from './sync-recovery-issues';
import { getBridge } from '../../../lib';
import { readOrderNoticeRemedy } from '../../services/OrderNoticeRemedy';
import type { RemedyTarget } from '../../services/support/SupportMatcherBridge';
import type { OrderSyncNotice as Notice } from '../../../lib/order-sync-notices';
import { isTillKnownOffline, subscribeServerReachability } from '../../services/server-reachability';

export function OrderSyncMark({ orderId, onOpen }: { orderId: string; onOpen?: () => void }) {
  const { t } = useTranslation();
  const { notices, status } = useOrderNotices([orderId], false);
  if (!notices.length) { return null; }
  if (notices.every(notice => notice.automatic && notice.state === 'pending')) {
    return <span className="text-sm text-(--pos-s-muted)" role="status">{t('orderSyncNotice.saving', { defaultValue: 'Saving…' })}
      {status === 'stale' && <span className="block text-xs">{t('orderSyncNotice.stale', { defaultValue: 'The notice has not refreshed. The last known one is shown.' })}</span>}
    </span>;
  }
  return <button type="button" className="min-h-11 text-left text-sm font-semibold text-amber-800 dark:text-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yellow-400"
    onClick={event => { event.stopPropagation(); (onOpen ?? (() => openOrderNotice(orderId)))(); }}>
    {t('orderSyncNotice.needsAction', { defaultValue: 'Needs attention' })}
    {status === 'stale' && <span className="block text-xs text-(--pos-s-muted)">{t('orderSyncNotice.stale', { defaultValue: 'The notice has not refreshed. The last known one is shown.' })}</span>}
  </button>;
}

export function OrderSyncNotice({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
  const { notices, status } = useOrderNotices([orderId]);
  const { runWithPrivilegedConfirmation, confirmationModal } = usePrivilegedActionConfirmation();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [remedy, setRemedy] = useState<RemedyTarget | null>(null);
  const [matching, setMatching] = useState(false);
  const [online, setOnline] = useState(!isTillKnownOffline());
  React.useEffect(() => {
    if (status === 'fresh' && !notices.length && feedback) { setFeedback(null); }
  }, [status, notices, feedback]);
  React.useEffect(() => {
    const update = () => setOnline(!isTillKnownOffline());
    const stop = subscribeServerReachability(update);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { stop(); window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  const other = notices.find(notice => notice.kind !== 'customer_correction_refused' && notice.state !== 'pending');
  React.useEffect(() => {
    let stopped = false;
    setRemedy(null);
    if (!other || status !== 'fresh') { setMatching(false); return; }
    const check = () => {
      setMatching(true);
      void readOrderNoticeRemedy(other, t).then(value => { if (!stopped) { setRemedy(value); } }).catch(() => { if (!stopped) { setRemedy(null); } }).finally(() => { if (!stopped) { setMatching(false); } });
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [other?.queueId, other?.since, status, online]);
  const run = async (notice: Notice, actionId: string) => {
    const release = acquireRecoveryAction();
    if (!release) { setFeedback('busy'); return; }
    setBusy(true); setFeedback(null);
    let attemptId: unknown;
    try {
      const target = notice.kind === 'customer_correction_refused' ? null : await readOrderNoticeRemedy(notice, t);
      if (notice.kind !== 'customer_correction_refused' && !target) { setRemedy(null); setFeedback('notSolved'); return; }
      const issue = target?.issue ?? customerCorrectionIssue(notice);
      const action = target?.action ?? issue.actions.find(action => action.id === actionId)!;
      attemptId = await getBridge().invoke('order_notice_employee_attempt', { queueId: notice.queueId });
      const result = await executeHealthRecoveryAction({ request: buildRecoveryActionRequest(issue, action), action,
        stale: () => readOrderNoticeStatus(orderId) !== 'fresh', authorize: runWithPrivilegedConfirmation, t,
        onPinRefused: async () => {
          if (attemptId) {
            await getBridge().invoke('order_notice_employee_attempt', { attemptId, outcome: 'failed', code: 'AUTH_PIN_WRONG' }).catch(() => {});
          }
        },
        beforeExecute: target ? async () => {
          const current = await readOrderNoticeRemedy(notice, t);
          if (current?.action.recipeId !== action.recipeId || current?.action.recipeVersion !== action.recipeVersion) { throw new Error('NOTICE_REMEDY_CHANGED'); }
        } : undefined });
      await refreshOrderNotices([orderId]);
      const fresh = await getBridge().invoke('order_sync_notices', { orderIds: [orderId] }) as Notice[];
      const remaining = fresh.find(row => row.queueId === notice.queueId || row.kind === notice.kind);
      const failed = result.success !== true || result.verification?.status === 'failed' || (notice.kind !== 'customer_correction_refused' && remaining?.state === 'refused');
      const outcome = failed ? 'failed' : remaining ? 'pending' : 'resolved';
      await getBridge().invoke('order_notice_employee_attempt', { attemptId, outcome, ...(failed ? { code: 'REMEDY_VERIFICATION_FAILED' } : {}) });
      setFeedback(failed ? notice.kind === 'customer_correction_refused' ? 'callSupport' : 'notSolved' : outcome === 'pending' ? 'pending' : null);
    } catch (error) {
      const code = recoveryFailureCode(error);
      if (attemptId) { await getBridge().invoke('order_notice_employee_attempt', { attemptId, outcome: 'failed', code }).catch(() => {}); }
      setFeedback(notice.kind === 'customer_correction_refused' || code.startsWith('AUTH_') ? orderRecoveryFeedback(code) : 'notSolved');
    }
    finally { await refreshOrderNotices([orderId]); setBusy(false); release(); }
  };
  const first = notices.find(notice => notice.kind === 'customer_correction_refused' && notice.state !== 'pending') ?? other ?? notices[0];
  const actionable = first?.kind === 'customer_correction_refused' && first.state !== 'pending' && first.actions.includes('resendOrderCustomerCorrection');
  const unavailable = busy || !online || status !== 'fresh' || Boolean(first?.unavailableReason);
  if (status === 'fresh' && !first && !feedback) { return null; }
  return <section className="mb-4 space-y-3 text-(--pos-s-text)" aria-label={t('orderSyncNotice.needsAction', { defaultValue: 'Needs attention' })} aria-busy={busy}>
    {status === 'loading' && <p role="status">{t('orderSyncNotice.loading', { defaultValue: 'Checking this order…' })}</p>}
    {(status === 'stale' || status === 'unavailable') && <p role="status">{t('orderSyncNotice.stale', { defaultValue: 'The notice has not refreshed. The last known one is shown.' })}</p>}
    {notices.map(notice => <div key={notice.queueId}>
      {notice.automatic && notice.state === 'pending' ? <p role="status" className="text-(--pos-s-muted)">{t('orderSyncNotice.saving', { defaultValue: 'Saving…' })}</p> : <>
        <p className="font-semibold text-amber-800 dark:text-amber-300">{t('orderSyncNotice.needsAction', { defaultValue: 'Needs attention' })}</p>
        <p>{t(`orderSyncNotice.${notice.kind}`, { defaultValue: 'A change to this order was not saved. You can carry on serving.' })}</p>
      </>}
      {notice.state === 'pending' && !notice.automatic && <p role="status">{t('orderSyncNotice.pending', { defaultValue: 'Saving… Please wait a moment.' })}</p>}
      {notice.failedAgain && <p role="status">{t('orderSyncNotice.failedAgain', { defaultValue: 'The change was not saved this time either. Tell the manager.' })}</p>}
    </div>)}
    {first && <p>{t('orderSyncNotice.remainsActive', { defaultValue: 'Until it is solved, the order stays in the active orders.' })}</p>}
    {actionable && <p>{t('orderSyncNotice.next', { defaultValue: 'Press the button to save it again.' })}</p>}
    {(!online || first?.unavailableReason === 'offline') && first && <p>{t('orderSyncNotice.offline', { defaultValue: 'There is no internet connection. Try again when it is back.' })}</p>}
    {first?.unavailableReason === 'busy' && <p>{t('orderSyncNotice.wait', { defaultValue: 'Finish the sale, the payment or the closing first, then try again.' })}</p>}
    {feedback && !(feedback === 'pending' && notices.some(notice => notice.state === 'pending' || notice.failedAgain)) && <p role="status">{t(feedback === 'wrongPin' ? 'auth.login.error'
      : feedback === 'grantExpired' || feedback === 'permissionRequired'
        ? `recovery.actionStatus.${feedback}` : `orderSyncNotice.${feedback}`, { defaultValue: 'It did not work. Call support.' })}</p>}
    {first && first.state !== 'pending' && !actionable && !remedy && <p>{matching ? t('orderSyncNotice.busy', { defaultValue: 'Checking…' }) : t('orderSyncNotice.noRemedy', { defaultValue: 'This cannot be solved from here. Tell the manager.' })}</p>}
    {first && first.state !== 'pending' && (actionable || remedy) && <div className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={unavailable} onClick={() => void run(first, actionable ? 'resendOrderCustomerCorrection' : remedy!.action.id)}
        className="min-h-11 rounded-xl bg-yellow-400 px-5 py-3 font-semibold text-zinc-950 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yellow-400">
        {busy ? t('orderSyncNotice.busy', { defaultValue: 'Checking…' }) : actionable ? t('orderSyncNotice.resend', { defaultValue: 'Save again' }) : t('orderSyncNotice.tryAgain', { defaultValue: 'Try again' })}
      </button>
    </div>}
    {confirmationModal}
  </section>;
}

export function ShiftOrderSyncNotices({ onOpen }: { onOpen?: () => void }) {
  const { t } = useTranslation();
  const { notices, status } = useOrderNotices();
  if (!notices.length && status === 'fresh') { return null; }
  const orders = [...new Map(notices.map(notice => [notice.orderId, notice])).values()];
  return <section className="mb-4 text-(--pos-s-text)">
    <h3 className="font-semibold">{t('orderSyncNotice.shift', { defaultValue: 'Orders to check before you leave' })}</h3>
    <p>{t('orderSyncNotice.shiftHint', { defaultValue: 'They do not stop you closing your shift.' })}</p>
    {status !== 'fresh' && <p role="status">{t(status === 'loading' ? 'orderSyncNotice.loading' : 'orderSyncNotice.stale', { defaultValue: 'The order notices have not refreshed yet.' })}</p>}
    <div className="flex flex-wrap gap-2">{orders.map(notice => <button key={notice.orderId} type="button" className="min-h-11 px-3 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-yellow-400" onClick={() => { onOpen?.(); openOrderNotice(notice.orderId); }}>
      {t('orderSyncNotice.order', { number: notice.orderNumber, defaultValue: 'Order {{number}}' })}
    </button>)}</div>
  </section>;
}
