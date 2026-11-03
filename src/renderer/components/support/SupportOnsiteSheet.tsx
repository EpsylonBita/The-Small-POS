import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { getBridge } from '../../../lib';
import { useSupportSession } from '../../hooks/useSupportSession';
import { usePrivilegedActionConfirmation } from '../../hooks/usePrivilegedActionConfirmation';
import { listenSupportEvent, OnsiteRequestSchema, SupportRemedyRunner, type OnsiteDecision } from '../../services/support/SupportRemedyRunner';
import { SupportOnsiteChip, supportButtonClass, supportSelectedClass } from './SupportOnsiteChip';
import { SupportPhysicalCheck } from './SupportPhysicalCheck';

// Native supplies these facts only after verifying the exact founder approval.
export const TierThreeOnsiteRequestSchema = OnsiteRequestSchema.extend({
  catalogue: z.strictObject({ action: z.enum(['pause', 'resume_own_pause', 'cancel_one_uncertain_job']), printer_name: z.string().min(1).max(160) }).optional(),
  breakglass: z.object({
    statement_kind: z.enum(['INSERT', 'UPDATE', 'DELETE', 'QUARANTINE', 'RESTORE']),
    rows: z.array(z.object({ table: z.string().min(1), inserted: z.number().int().nonnegative(),
      updated: z.number().int().nonnegative(), deleted: z.number().int().nonnegative() })).max(20),
    explanation_text: z.string().min(1).max(600),
    restore_target: z.enum(['snapshot', 'quarantine_group']).optional(),
  }).refine(value => value.statement_kind !== 'RESTORE' || value.restore_target !== undefined).optional(),
}).strict().refine(value => [Boolean(value.catalogue), Boolean(value.breakglass), Boolean(value.check_id)].filter(Boolean).length <= 1, 'Conflicting on-site request kinds');
type OnsiteRequest = z.infer<typeof TierThreeOnsiteRequestSchema>;

export function SupportOnsiteSheet({ request, deferred, canConfirm, busy = false, failed = false, onShown, onDecision }: {
  request: OnsiteRequest; deferred: boolean; canConfirm: boolean; busy?: boolean; failed?: boolean;
  onShown(id: string): void; onDecision(decision: OnsiteDecision): void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const [armed, setArmed] = useState(false), [details, setDetails] = useState(false);
  const callbacks = useRef({ onShown, onDecision }); callbacks.current = { onShown, onDecision };
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { setDetails(false); }, [request.request_id]);
  useEffect(() => {
    setArmed(false);
    if (deferred) { return; }
    callbacks.current.onShown(request.request_id);
    const previous = document.activeElement;
    panel.current?.focus();
    const timer = window.setTimeout(() => setArmed(true), 2000);
    return () => {
      window.clearTimeout(timer);
      if (previous instanceof HTMLElement && previous.isConnected) { previous.focus(); }
    };
  }, [request.request_id, deferred]);
  useEffect(() => {
    const timer = window.setTimeout(() => callbacks.current.onDecision('timeout'), request.remaining_ms);
    return () => window.clearTimeout(timer);
  }, [request.request_id, request.remaining_ms]);
  if (deferred) { return <SupportOnsiteChip />; }
  return <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="support-onsite-sheet"
    className="max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-(--pos-s-border) bg-(--pos-s-surface) p-4 text-(--pos-s-fg) shadow-lg"
    onKeyDown={event => {
      if (event.key === 'Escape' && !busy && canConfirm) { event.stopPropagation(); onDecision('declined'); }
      if (event.key === 'Tab') {
        const buttons = panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        const first = buttons?.[0], last = buttons?.[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <h2 id={titleId} className="text-lg font-bold">{t('support.onsite.title')}</h2>
    {request.catalogue ? <div data-testid="support-catalogue-facts" className="mt-3 space-y-3">
      <p className="font-semibold">{t(`support.onsite.${request.catalogue.action === 'pause' ? 'cataloguePause' : request.catalogue.action === 'resume_own_pause' ? 'catalogueResume' : 'catalogueCancel'}`)}</p>
      <p className="break-words">{request.catalogue.printer_name}</p>
      <p>{t(request.catalogue.action === 'cancel_one_uncertain_job' ? 'support.onsite.catalogueCancelScope' : 'support.onsite.cataloguePauseScope')}</p>
      {request.catalogue.action === 'resume_own_pause' && <p>{t('support.onsite.catalogueResumeCheck')}</p>}
      <p>{t('support.onsite.cataloguePaperWarning')}</p>
    </div> : request.breakglass ? <div data-testid="support-breakglass-facts" className="mt-3 space-y-2">
      <p className="font-semibold">{request.breakglass.statement_kind}</p>
      {request.breakglass.rows.map(row => <p key={row.table}>{`${row.table}: ${row.inserted + row.updated + row.deleted}`}</p>)}
      <p>{t('support.restore.snapshotFirst')}</p>
      {request.breakglass.restore_target === 'snapshot' && <p>{t('support.banner.restoreRestarting')}</p>}
      <p className="font-semibold">{t('support.onsite.aiExplanation')}</p>
      <p className="whitespace-pre-wrap break-words">{Array.from(request.breakglass.explanation_text).slice(0, 600).join('')}</p>
    </div> : !request.check_id && <><p className="mt-3 font-semibold">{request.title === 'support.onsite.title' ? t('support.onsite.title') : request.title}</p><p className="mt-2 whitespace-pre-wrap break-words">{request.description}</p></>}
    <p className="mt-3">{t('support.banner.noPinPromise')}</p>
    {(request.needs_staff_pin || request.breakglass?.statement_kind === 'RESTORE') && <p className="mt-3">{t('support.onsite.storePinNotice')}</p>}
    {!request.check_id && request.technical_details && <div className="my-3">
      <button type="button" className={supportButtonClass} aria-expanded={details} onClick={() => setDetails(value => !value)}>{t('support.onsite.technicalDetails')}</button>
      {details && <pre className="mt-2 whitespace-pre-wrap break-all text-sm">{request.technical_details}</pre>}
    </div>}
    {failed && <p role="alert">{t('support.code.retry')}</p>}
    {busy ? <p role="status">{t('support.banner.executing')}</p> : request.check_id
      ? <SupportPhysicalCheck checkId={request.check_id} armed={armed && canConfirm} onAnswer={onDecision} />
      : <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={supportSelectedClass} disabled={!armed || !canConfirm} onClick={() => onDecision('confirmed')}>{t('support.onsite.execute')}</button>
        <button type="button" className={supportButtonClass} disabled={!canConfirm} onClick={() => onDecision('declined')}>{t('support.onsite.decline')}</button>
      </div>}
  </div>;
}

/** Shell owner for both native on-site requests and renderer-run remedies. */
export function SupportInteractionHost() {
  const session = useSupportSession(), { t } = useTranslation();
  const { runWithPrivilegedConfirmation, confirmationModal } = usePrivilegedActionConfirmation();
  const current = useRef({ session, t, runWithPrivilegedConfirmation }); current.current = { session, t, runWithPrivilegedConfirmation };
  const [request, setRequest] = useState<OnsiteRequest | null>(null);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), [otherDialog, setOtherDialog] = useState(false);
  const pending = useRef<{ request: OnsiteRequest; resolve(answer: OnsiteDecision): void } | null>(null);
  const decisionInFlight = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observe = () => setOtherDialog(Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
      .some(node => !host.current?.contains(node) && !node.closest('[hidden], [aria-hidden="true"]')));
    observe();
    const observer = new MutationObserver(observe); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'role'] });
    return () => observer.disconnect();
  }, []);
  const isCritical = () => current.current.session?.snapshot?.critical_op_active !== false;
  const ask = (next: OnsiteRequest): Promise<OnsiteDecision> => {
    if (pending.current) { return Promise.reject(new Error('CONCURRENT_OPERATION')); }
    setFailed(false); setRequest(next);
    return new Promise(resolve => { pending.current = { request: next, resolve }; });
  };
  const runner = useMemo(() => new SupportRemedyRunner({
    t: (key, params) => current.current.t(key, params),
    authorize: options => current.current.runWithPrivilegedConfirmation(options), onsite: ask,
    critical: isCritical, sessionId: () => current.current.session?.snapshot?.state === 'ended' ? null : current.current.session?.snapshot?.session_id ?? null,
  }), []);
  useEffect(() => {
    const stop = runner.start();
    const receive = (value: unknown) => {
      const parsed = TierThreeOnsiteRequestSchema.safeParse(value);
      if (!parsed.success || parsed.data.session_id !== current.current.session?.snapshot?.session_id || pending.current) { return; }
      void ask(parsed.data);
    };
    const stopOnsite = listenSupportEvent('support://onsite-request', receive);
    return () => { stop(); stopOnsite(); pending.current?.resolve('declined'); pending.current = null; };
  }, [runner]);
  useEffect(() => {
    if (pending.current && (session?.snapshot?.session_id !== pending.current.request.session_id || session?.snapshot?.state === 'ended')) {
      pending.current.resolve('declined'); pending.current = null; setRequest(null); setBusy(false);
    }
  }, [session?.snapshot?.session_id, session?.snapshot?.state]);
  const canConfirm = Boolean(session?.snapshot?.can_connect && session.snapshot.staff);
  const deferred = isCritical() || otherDialog || !canConfirm;
  const decide = async (decision: OnsiteDecision) => {
    const active = pending.current;
    if (!active || decisionInFlight.current) { return; }
    // Native also rechecks identity, permission, shown-at and critical state.
    if (decision !== 'timeout' && (!current.current.session?.snapshot?.can_connect || deferred)) { return; }
    decisionInFlight.current = true; setBusy(true); setFailed(false);
    try {
      const answer = (): Promise<unknown> => {
        if (decision !== 'timeout' && (isCritical() || !current.current.session?.snapshot?.can_connect || current.current.session.snapshot.session_id !== active.request.session_id)) {
          throw new Error('On-site decision no longer authorized');
        }
        return getBridge().invoke('support_onsite_decision', { request_id: active.request.request_id, session_id: active.request.session_id, decision,
          staff_ref: { staff_id: current.current.session?.snapshot?.staff?.staff_id } });
      };
      let deviceApply = false;
      try {
        const details: unknown = JSON.parse(active.request.technical_details);
        deviceApply = Boolean(details && typeof details === 'object' && 'device_kind' in details
          && ['printer', 'card_terminal', 'cash_register'].includes(String(details.device_kind)));
      } catch { /* Other request kinds can contain plain technical text. */ }
      const response: unknown = decision === 'confirmed' && (deviceApply || active.request.breakglass?.statement_kind === 'RESTORE')
        ? await current.current.runWithPrivilegedConfirmation({ scope: 'system_control', title: t(deviceApply ? active.request.title : 'support.restore.action'),
          subtitle: t('support.onsite.storePinNotice'), action: answer })
        : await answer();
      if (response === false || response && typeof response === 'object' && 'success' in response && response.success === false) { throw new Error('On-site decision refused'); }
      if (pending.current !== active) { return; }
      pending.current = null; setRequest(null); active.resolve(decision);
    } catch {
      if (decision === 'timeout' && pending.current === active) {
        pending.current = null; setRequest(null); active.resolve('timeout');
      } else { setFailed(true); }
    }
    finally { decisionInFlight.current = false; setBusy(false); }
  };
  return <>
    {request && createPortal(<div ref={host} data-cashier-recovery="true" data-liquid-glass-modal-viewport
      className={deferred ? 'pointer-events-none fixed right-3 z-[10080]' : 'fixed inset-0 z-[10080] flex items-end justify-center bg-(--pos-s-surface-2) p-3 sm:items-center'}
      style={{ top: 'calc(var(--app-window-frame-height, 0px) + var(--pos-support-banner-height, 0px))' }}>
      <SupportOnsiteSheet request={request} deferred={deferred} canConfirm={canConfirm} busy={busy} failed={failed}
        onShown={requestId => { void getBridge().invoke('support_onsite_decision', { request_id: requestId, session_id: request.session_id, decision: 'shown' }).catch(() => setFailed(true)); }}
        onDecision={decision => { void decide(decision); }} />
    </div>, document.body)}
    {!isCritical() && confirmationModal}
  </>;
}
