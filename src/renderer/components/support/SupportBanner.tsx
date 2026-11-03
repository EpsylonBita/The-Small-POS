import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { SUPPORT_GREEK_REFERENCE } from '../../../../../shared/pos/support/i18n-keys';
import { supportIpc } from '../../../lib/ipc-adapter';
import { useSupportSession, type SupportBannerSnapshot } from '../../hooks/useSupportSession';
import { supportCountdown } from './SupportCodeScreen';

// Native sends a command kind; use shipped labels rather than showing a tool ID.
const activityLabels: Readonly<Record<string, string>> = {
  till_health: 'sync.labels.health', till_error_codes: 'support.evidence.syncError',
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

export function SupportBannerView({ snapshot, onEnd, onExtend }: {
  snapshot: SupportBannerSnapshot; onEnd(): void; onExtend(): void;
}) {
  const { t } = useTranslation();
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
  const knownActivity = activity && Object.prototype.hasOwnProperty.call(SUPPORT_GREEK_REFERENCE, activity);
  const activityKey = activity && Object.prototype.hasOwnProperty.call(activityLabels, activity) ? activityLabels[activity] : null;
  const activityLabel = knownActivity ? t(`support.${activity}`) : t(activityKey ?? 'support.banner.activity');
  const canExtend = snapshot.extend_allowed && snapshot.remaining_ms <= 600_000 && snapshot.state !== 'waiting' && snapshot.state !== 'ended';
  return <aside aria-label={t('support.connect.action')} data-testid="support-banner" data-cashier-recovery="true"
    className="relative z-[10070] w-full shrink-0 border-b border-(--pos-s-border) bg-(--pos-s-surface) text-(--pos-s-fg)">
    <div className="flex min-h-[48px] min-w-0 items-center gap-2 px-2">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
        className="min-h-[48px] min-w-[48px] flex-1 rounded-lg px-2 text-left text-sm active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2">
        <span role="status" className="block font-semibold">{t(`support.banner.${snapshot.state}`)}</span>
        {snapshot.operator_name && <span className="block break-words">{snapshot.operator_name}</span>}
        {activity && <span className="hidden sm:block">{activityLabel}</span>}
      </button>
      {snapshot.state !== 'ended' && <span role="timer" aria-label={t('support.code.timeLeft')} className="shrink-0 tabular-nums">{supportCountdown(snapshot.remaining_ms)}</span>}
      {canExtend && <button type="button" onClick={onExtend}
        className="hidden min-h-[48px] min-w-[48px] shrink-0 whitespace-nowrap rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) px-4 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 sm:block">
        {t('support.banner.extend')}
      </button>}
      <button type="button" onClick={onEnd}
        className="min-h-[48px] min-w-[48px] shrink-0 whitespace-nowrap rounded-xl bg-(--pos-s-sel-bg) px-4 font-bold text-(--pos-s-sel-fg) active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2">
        {t('support.banner.end')}
      </button>
    </div>
    {expanded && <div className="space-y-2 border-t border-(--pos-s-border) bg-(--pos-s-surface) p-3">
      {activity && <p className="sm:hidden">{activityLabel}</p>}
      {activity && !knownActivity && !activityKey && <p className="break-words">{activity}</p>}
      <p>{t('support.banner.noPinPromise')}</p>
      {canExtend && <button type="button" onClick={onExtend}
        className="min-h-[48px] min-w-[48px] rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) px-4 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 sm:hidden">
        {t('support.banner.extend')}
      </button>}
      {snapshot.write_outcome && <p role="status">{t(`support.banner.endDuringWrite.${snapshot.write_outcome === 'rolled_back' ? 'rolledBack' : 'committed'}`)}</p>}
    </div>}
    {!expanded && snapshot.write_outcome && <p role="status" className="px-3 pb-2">{t(`support.banner.endDuringWrite.${snapshot.write_outcome === 'rolled_back' ? 'rolledBack' : 'committed'}`)}</p>}
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
  // A body portal keeps End above checkout/Health portals. Reserve the same band
  // in the shell and modal viewports so it never covers their controls.
  return createPortal(<div ref={host} data-support-banner-host data-cashier-recovery="true"
    className="fixed inset-x-0 z-[2147483646]" style={{ top: 'var(--app-window-frame-height, 0px)' }}>
    <style>{`[data-app-window-content] { padding-top: var(--pos-support-banner-height, 0px); }
      [data-liquid-glass-modal-viewport] { top: calc(var(--app-window-frame-height, 0px) + var(--pos-support-banner-height, 0px)) !important; }`}</style>
    <SupportBannerView snapshot={state === 'waiting' && session.code ? { ...session.snapshot, remaining_ms: session.remainingMs } : session.snapshot}
      onEnd={() => { void session.end(); }} onExtend={() => { void session.extend(); }} />
  </div>, document.body);
}
