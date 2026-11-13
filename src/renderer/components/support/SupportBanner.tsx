import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { SUPPORT_GREEK_REFERENCE } from '../../../../../shared/pos/support/i18n-keys';
import { supportIpc } from '../../../lib/ipc-adapter';
import { useSupportSession, type SupportBannerSnapshot } from '../../hooks/useSupportSession';
import { SupportActorPicker, SupportRenewSignIn, SupportStaffNotice } from './SupportActorPicker';
import { supportCountdown } from './SupportCodeScreen';

// Native sends a command kind; use shipped labels rather than showing a tool ID.
const activityLabels: Readonly<Record<string, string>> = {
  till_confirmed_command: 'support.confirmed.running', till_screenshot: 'support.banner.activity', till_health: 'sync.labels.health', till_error_codes: 'support.evidence.syncError',
  till_sync_queue: 'support.evidence.pendingQueue', till_printers: 'sync.system.printers',
  till_settings: 'settings.title', till_shifts: 'settings.recovery.shifts',
  till_modules: 'settings.managedByAdmin.enabledModulesLabel', till_diagnostics_bundle: 'support.actions.exportDiagnostics',
  till_logs: 'support.onsite.technicalDetails', till_sql_schema: 'sync.system.database',
  till_sql_query: 'sync.system.database', till_sql_refresh_replica: 'sync.system.database',
  till_network_info: 'settings.sections.network', till_network_scan: 'settings.sections.network',
  till_network_identify: 'settings.sections.network', till_list_remedies: 'support.actions.troubleshoot',
  till_run_remedy: 'support.actions.troubleshoot', till_request_physical_check: 'support.onsite.title',
  till_apply_device_settings: 'settings.title', breakglass_propose_sql: 'sync.system.database',
  breakglass_propose_quarantine: 'sync.system.database', breakglass_propose_restore: 'support.restore.action',
  till_list_snapshots: 'sync.system.database',
  till_list_quarantine: 'sync.system.database',
};

// The dot is the only colour on the pill: green while support works, amber while it waits, grey once it ended.
const stateDots: Readonly<Record<NonNullable<SupportBannerSnapshot['state']>, string>> = {
  connected: 'bg-emerald-500', executing: 'bg-emerald-500',
  waiting: 'bg-amber-500', awaitingOnsite: 'bg-amber-500', deferredPayment: 'bg-amber-500', pausedOffline: 'bg-amber-500', restarting: 'bg-amber-500',
  ended: 'bg-(--pos-s-muted)',
};
export function SupportBannerView({ snapshot, onEnd, onExtend }: {
  snapshot: SupportBannerSnapshot; onEnd(): void; onExtend(): void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!snapshot.executing_command_id || !snapshot.evidence_reason || (snapshot.current_activity_key !== 'till_screenshot' && !snapshot.personal_data_open)) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      void supportIpc('support_banner_state', { visible: !document.hidden, evidence_command_id: snapshot.executing_command_id }).catch(() => { /* Native fails closed if the pill cannot acknowledge. */ });
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [snapshot.executing_command_id, snapshot.evidence_reason, snapshot.current_activity_key, snapshot.personal_data_open]);
  const [expanded, setExpanded] = useState(false);
  const [endedVisible, setEndedVisible] = useState(true);
  useEffect(() => {
    setEndedVisible(true);
    if (snapshot.state !== 'ended') { return; }
    const timer = window.setTimeout(() => setEndedVisible(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [snapshot.state]);
  if (!snapshot.state || (snapshot.state === 'ended' && !endedVisible)) { return null; }
  const activity = snapshot.current_activity_key;
  const confirmed = activity === 'till_confirmed_command' ? (snapshot.confirmed_command_id ? snapshot.confirmed_history?.find(row => row.command_id === snapshot.confirmed_command_id) : snapshot.confirmed_history?.[0]) : undefined;
  const knownActivity = activity && Object.prototype.hasOwnProperty.call(SUPPORT_GREEK_REFERENCE, activity);
  const activityKey = activity && Object.prototype.hasOwnProperty.call(activityLabels, activity) ? activityLabels[activity] : null;
  const activityLabel = knownActivity ? t(`support.${activity}`) : t(activityKey ?? 'support.banner.activity');
  const canExtend = snapshot.extend_allowed && snapshot.remaining_ms <= 600_000 && snapshot.state !== 'waiting' && snapshot.state !== 'ended';
  // The staff step of «+30 λεπτά» opens under the pill, where the details are: asking for more time closes them.
  const requestExtension = () => { setExpanded(false); onExtend(); };
  const outcome = snapshot.write_outcome && <p role="status">{t(`support.banner.endDuringWrite.${snapshot.write_outcome === 'rolled_back' ? 'rolledBack' : 'committed'}`)}</p>;
  // A small glass pill in the top centre (founder 12/11/2026: «pill shaped στη μέση και liquid glass»), in place of
  // a bar across the window. The glass is the neutral frost of the windows and the buttons on it stay solid. Each
  // button keeps a 48px touch height; it is its face that is smaller, so the pill stays 40px tall.
  return <aside aria-label={t('support.connect.action')} data-testid="support-banner" data-cashier-recovery="true"
    className="pointer-events-auto relative z-[10070] flex max-w-full flex-col items-center gap-1 text-(--pos-s-fg)">
    <div data-support-pill className="pos-glass-panel flex max-w-full min-w-0 items-center gap-1 rounded-full border px-1 shadow-(--pos-s-depth-card)">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
        className="-my-1 flex min-h-[48px] min-w-[48px] flex-1 items-center gap-2 rounded-full py-1 pl-3 pr-2 text-left text-sm active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2">
        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${stateDots[snapshot.state]}`} />
        <span className="min-w-0">
          <span role="status" className="block font-semibold leading-tight">{t(`support.banner.${snapshot.state}`)}</span>
          {confirmed && <span data-testid="support-confirmed-explanation" className="block break-words text-xs leading-tight">{t(`support.confirmed.${confirmed.state === 'started' ? 'running' : confirmed.state}`)}: {confirmed.explanation}<span className="block text-(--pos-s-muted)">{confirmed.reason}</span></span>}
          {/* One small line under the state: what support is doing right now, else who is connected. */}
          {snapshot.evidence_reason && (activity === 'till_screenshot' || snapshot.personal_data_open) && <span data-testid="support-evidence-reason" className="block break-words text-xs leading-tight">{t(activity === 'till_screenshot' ? 'support.evidence.screenshot' : 'support.evidence.personalData', { reason: snapshot.evidence_reason })}</span>}
          {(activity || snapshot.operator_name) && !confirmed && !(snapshot.evidence_reason && (activity === 'till_screenshot' || snapshot.personal_data_open)) && <span className="block break-words text-xs leading-tight text-(--pos-s-muted)">{activity ? activityLabel : snapshot.operator_name}</span>}
        </span>
      </button>
      {snapshot.state !== 'ended' && <span role="timer" aria-label={t('support.code.timeLeft')} className="shrink-0 px-1 text-sm tabular-nums">{supportCountdown(snapshot.remaining_ms)}</span>}
      {canExtend && <button type="button" onClick={requestExtension}
        className="-my-1 hidden min-h-[48px] min-w-[48px] shrink-0 whitespace-nowrap items-center rounded-full px-1 text-sm font-semibold active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 sm:flex">
        <span className="rounded-full bg-(--pos-s-raised) px-3 py-1.5 shadow-(--pos-s-depth)">{t('support.banner.extend')}</span>
      </button>}
      <button type="button" onClick={onEnd}
        className="-my-1 flex min-h-[48px] min-w-[48px] shrink-0 whitespace-nowrap items-center justify-center rounded-full text-sm font-bold active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2">
        <span className="rounded-full bg-(--pos-s-sel-bg) px-4 py-1.5 text-(--pos-s-sel-fg) shadow-(--pos-s-depth-yellow)">{t(confirmed ? 'support.confirmed.endSession' : 'support.banner.end')}</span>
      </button>
    </div>
    {/* The details float under the pill: opening them never moves the screen below. */}
    {expanded && <div className="pos-glass-panel absolute left-1/2 top-full z-10 mt-2 w-[min(22rem,calc(100vw-1rem))] -translate-x-1/2 space-y-2 rounded-3xl border p-3 text-sm shadow-(--pos-s-depth-card)">
      {activity && snapshot.operator_name && <p className="break-words font-semibold">{snapshot.operator_name}</p>}
      {activity && !knownActivity && !activityKey && <p className="break-words">{activity}</p>}
      {confirmed && <p>{confirmed.reason}</p>}
      <SupportConfirmedHistory rows={snapshot.confirmed_history} />
      <p>{t('support.banner.noPinPromise')}</p>
      {canExtend && <button type="button" onClick={requestExtension}
        className="min-h-[48px] min-w-[48px] rounded-full bg-(--pos-s-raised) px-4 font-semibold shadow-(--pos-s-depth) active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 sm:hidden">
        {t('support.banner.extend')}
      </button>}
      {outcome}
    </div>}
    {!expanded && outcome && <div className="pos-glass-panel max-w-full rounded-2xl border px-3 py-1.5 text-center text-sm">{outcome}</div>}
  </aside>;
}
export function SupportBanner() {
  const session = useSupportSession();
  const state = session?.snapshot?.state;
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!state || !host.current) { return; }
    const element = host.current;
    const measure = () => document.documentElement.style.setProperty('--pos-support-banner-height', `${element.getBoundingClientRect().height}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => { observer?.disconnect(); document.documentElement.style.removeProperty('--pos-support-banner-height'); };
  }, [state]);
  useEffect(() => {
    if (!state) { return; }
    const report = () => { void supportIpc('support_banner_state', { visible: !document.hidden }).catch(() => { /* Visibility reports are best effort. */ }); };
    report();
    document.addEventListener('visibilitychange', report);
    return () => {
      document.removeEventListener('visibilitychange', report);
      void supportIpc('support_banner_state', { visible: false }).catch(() => { /* Visibility reports are best effort. */ });
    };
  }, [state]);
  if (!state || !session?.snapshot) { return null; }
  // +30 minutes may need to know who asks when several people are on shift.
  const view = session.view;
  const extendStep = session.actorPurpose === 'extend' && (view === 'pick' || view === 'staff_required' || view === 'sign_in_again') ? view : null;
  // A body portal keeps End above checkout/Health portals. The pill sits in a band of its own height, which the
  // shell and the modal viewports leave free, so it never covers a control. Only the pill takes touches.
  return createPortal(<div ref={host} data-support-banner-host data-cashier-recovery="true"
    className="pointer-events-none fixed inset-x-0 z-[2147483646] flex flex-col items-center px-2 py-1" style={{ top: 'var(--app-window-frame-height, 0px)' }}>
    <style>{`[data-app-window-content] { padding-top: var(--pos-support-banner-height, 0px); }
      [data-liquid-glass-modal-viewport] { top: calc(var(--app-window-frame-height, 0px) + var(--pos-support-banner-height, 0px)) !important; }`}</style>
    <SupportBannerView snapshot={state === 'waiting' && session.code ? { ...session.snapshot, remaining_ms: session.remainingMs } : session.snapshot}
      onEnd={() => { void session.end(); }} onExtend={() => { void session.extend(); }} />
    {/* Out of the flow, like the pill's details: the band keeps the pill's height while someone answers. It is
        layered above the pill (z 10070), so details opened again can never cover the question. */}
    {extendStep && <div data-testid="support-extend-step" className="pos-glass-panel pointer-events-auto absolute left-1/2 top-full z-[10080] mt-1 w-[min(28rem,calc(100vw-1rem))] -translate-x-1/2 rounded-3xl border p-3 text-(--pos-s-fg) shadow-(--pos-s-depth-card)">
      {extendStep === 'pick'
        ? <SupportActorPicker purpose="extend" actors={session.actors} busy={session.busy}
          onChoose={staffId => { void session.choose(staffId); }} onCancel={() => { session.dismiss(); }} />
        : <>
          <SupportStaffNotice view={extendStep} onClose={() => { session.dismiss(); }} />
          {extendStep === 'sign_in_again' && <SupportRenewSignIn people={session.renewable} busy={session.busy} onRenew={session.renew} />}
        </>}
    </div>}
  </div>, document.body);
}

/** A support record time in the app language; an unreadable value is shown as it came. */
export function supportRecordTime(at: string, language?: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(language) : at;
}

export function SupportConfirmedHistory({rows=[]}:{rows?:SupportBannerSnapshot['confirmed_history']}){
  const {t,i18n}=useTranslation();
  if(!rows.length)return null;
  const latest=[...new Map([...rows].reverse().map(row=>[row.command_id,row])).values()].reverse();
  return <div data-testid="support-confirmed-history" className="space-y-2"><p>{t('support.confirmed.snapshot')}</p>{latest.map(row=><div key={row.command_id} className="break-words"><p>{row.explanation}</p><p>{row.reason}</p><p><time dateTime={row.at}>{supportRecordTime(row.at, i18n?.language)}</time> · {t(`support.confirmed.${row.state==='started'?'running':row.state}`)}{row.outcome?` · ${t(`support.confirmed.outcomes.${row.outcome}`)}`:''}</p></div>)}</div>;
}
