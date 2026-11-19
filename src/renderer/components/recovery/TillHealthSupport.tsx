import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBridge, type DiagnosticsTerminalContext, type RecoveryActionDescriptor, type RecoveryActionLogEntry, type RecoveryIssue } from '../../../lib';
import { redactForExport, sanitizeOperationalError } from '../../../../../shared/pos/health/diagnostics-redaction';
import { formatDateTime, formatTime } from '../../utils/format';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { SupportConnectAction } from '../support/SupportConnectAction';
import { SupportDetailsPanel } from '../support/SupportDetailsPanel';
import { RecoveryPanel } from './RecoveryPanel';
import { TableAttemptRecoveryNotice } from './TableAttemptRecoveryNotice';
import { TillHealthButton } from './TillHealthWindow';
import { tillHealthReportStatus, type TillHealthReport } from './till-health-model';
import type { DesktopRecoveryIssue } from './sync-recovery-issues';

interface TillHealthSupportProps {
  issues: DesktopRecoveryIssue[];
  recentActions: RecoveryActionLogEntry[];
  terminal?: DiagnosticsTerminalContext | null;
  online: boolean;
  stale: boolean;
  busy: boolean;
  supportTools: React.ReactNode;
  diagnostics: React.ReactNode;
  previousReports: TillHealthReport[];
  lastReport: TillHealthReport | null;
  historyUnavailable?: boolean;
  sending: boolean;
  onReport: (issue?: RecoveryIssue, action?: RecoveryActionDescriptor) => void;
  onOpenCopy: (path: string) => void;
  onIssueAction: (issue: RecoveryIssue, action: RecoveryActionDescriptor) => void;
}

export function TillHealthSupport({
  issues, recentActions, terminal, online, stale, busy, supportTools, diagnostics, previousReports, lastReport, historyUnavailable, sending,
  onReport, onOpenCopy, onIssueAction,
}: TillHealthSupportProps) {
  const { t, i18n } = useTranslation();
  const [selected, setSelected] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    const diagnosticsBridge = getBridge().diagnostics;
    if (typeof diagnosticsBridge?.getAbout !== 'function') return;
    let current = true;
    void diagnosticsBridge.getAbout().then(about => {
      if (current) setVersion(about?.version ?? null);
    }).catch(() => {});
    return () => { current = false; };
  }, []);
  const locale = i18n?.resolvedLanguage || i18n?.language;
  const reportableIssues = issues.filter(issue => issue.actions.some(action => action.id === 'contactDev'));
  const reportIssue = reportableIssues.find(issue => issue.id === selected);
  const reportStatus = tillHealthReportStatus(lastReport);
  const reportReceived = reportStatus === 'sent' || reportStatus === 'automatic';
  const statusLine = (report: TillHealthReport | null) => {
    const status = tillHealthReportStatus(report);
    const copy = status === 'local' && report?.result.historical ? 'archivedLocal'
      : status === 'waiting' && online ? 'pending' : status;
    return t(`tillHealth.report.${copy}`, {
      time: report ? formatTime(report.result.lastSentAt ?? report.at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, locale) : '',
    });
  };
  return <div className="space-y-5">
    <SupportConnectAction hideLauncher />
    <section className="space-y-2">
      <h4>{t('tillHealth.support.attempts')}</h4>
      {!recentActions.length && <p>{t('recovery.center.noRecentActions')}</p>}
      <ul className="space-y-3">
        {recentActions.map(entry => {
          const automatic = entry.actionId.toLowerCase().includes('automatic') || entry.id.startsWith('automatic:');
          return <li key={entry.id} className="space-y-1">
            <div className="till-health-row">
              <time dateTime={entry.timestamp}>{formatDateTime(entry.timestamp, {}, locale)}</time>
              <strong>{entry.actor?.staffName || t(`tillHealth.support.${automatic ? 'automaticActor' : 'unknownActor'}`)}</strong>
            </div>
            <p>{t(`recovery.actions.${entry.actionId}.label`, { defaultValue: entry.actionId })} · {t(`recovery.center.outcomes.${entry.outcome ?? 'unknown'}`)}</p>
            <code>{[entry.issueCode, entry.recipeId, sanitizeOperationalError(entry.errorMessage), sanitizeOperationalError(entry.message)].filter(Boolean).join(' · ')}</code>
          </li>;
        })}
      </ul>
    </section>
    <section className="space-y-2">
      <h4>{t('tillHealth.support.identifiers')}</h4>
      {terminal && <code>{[terminal.terminalId, terminal.branchId, terminal.organizationId].filter(Boolean).join(' · ')}</code>}
      {version && <p>{t('updates.available.version', { version })}</p>}
      {issues.map(issue => {
        const params = Object.fromEntries(Object.entries(issue.params ?? {}).map(([key, value]) =>
          [key, typeof value === 'string' && /(?:error|reason|details)/i.test(key) ? sanitizeOperationalError(value) : value]));
        return <details key={issue.id} className="border-b border-(--pos-s-border)">
        <summary className="min-h-11 cursor-pointer py-2">{t(issue.titleKey, { ...params, defaultValue: issue.code })}</summary>
        <div className="space-y-2 pb-3">
          <p>{t(issue.summaryKey, { ...params, defaultValue: '' })}</p>
          <p>{t(issue.guidanceKey, { ...params, defaultValue: '' })}</p>
          <code>{[issue.code, issue.entityId, issue.businessEventKey, ...(issue.collectorIssueIds ?? [])].filter(Boolean).join(' · ')}</code>
          {issue.params && <pre className="text-sm">{JSON.stringify(redactForExport(params), null, 2)}</pre>}
          <div className="flex flex-wrap gap-2">
            {issue.actions.filter(action => action.id !== 'contactDev').map(action =>
              <TillHealthButton key={action.id} disabled={busy || stale || (action.requiresOnline && !online)}
                onClick={() => onIssueAction(issue, action)}>
                {t(action.labelKey, { defaultValue: action.id })}
              </TillHealthButton>)}
          </div>
        </div>
        </details>;
      })}
    </section>
    <section className="space-y-2">
      <h4>{t('tillHealth.support.report')}</h4>
      {reportableIssues.length > 0 && <label className="block">
        {t('tillHealth.support.reportTopic')}
        <select value={selected} onChange={event => setSelected(event.target.value)} className="block max-w-full rounded-lg border border-(--pos-s-border) bg-(--pos-s-surface) p-2">
          <option value="">{t('tillHealth.support.allTopics')}</option>
          {reportableIssues.map(issue => <option key={issue.id} value={issue.id}>{t(issue.titleKey, { ...issue.params, defaultValue: issue.code })} · {issue.orderNumber ?? issue.entityId}</option>)}
        </select>
      </label>}
      <p role="status">{statusLine(lastReport)}</p>
      {lastReport?.result.error && <code>{sanitizeOperationalError(lastReport.result.error)}</code>}
      {reportReceived && lastReport?.result.alertStatus === 'failed' && <p>{t('recovery.actionStatus.reportStored')}</p>}
      <TillHealthButton onClick={() => onReport(reportIssue, reportIssue?.actions.find(action => action.id === 'contactDev'))} disabled={sending || busy} aria-busy={sending}>
        {t(sending ? 'tillHealth.report.preparing' : 'tillHealth.report.new')}
      </TillHealthButton>
      <p>{t('tillHealth.report.explanation')}</p>
      <details>
        <summary className="min-h-11 cursor-pointer py-2">{t('tillHealth.report.previous')}</summary>
        {historyUnavailable && <p>{t('tillHealth.report.historyUnavailable')}</p>}
        {previousReports.length > 0 ? <ul className="space-y-2">
          {previousReports.map(report => {
            const path = report.result.path;
            const date = formatDateTime(report.at, {}, locale);
            return <li key={report.result.reportId ?? path} className="space-y-1">
              {path ? <TillHealthButton onClick={() => onOpenCopy(path)}>{t('tillHealth.report.openCopy', { date })}</TillHealthButton>
                : <time dateTime={report.at}>{date}</time>}
              <p>{statusLine(report)}</p>
              {report.result.error && <code>{sanitizeOperationalError(report.result.error)}</code>}
            </li>;
          })}
        </ul> : !historyUnavailable && <p>{t('tillHealth.report.noCopies')}</p>}
      </details>
    </section>
    <details onToggle={event => setToolsOpen(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer py-2">{t('tillHealth.support.tools')}</summary>
      <div className="space-y-4">
        {supportTools}
        {toolsOpen && <>
          <TableAttemptRecoveryNotice />
          <RecoveryPanel />
          <SupportDetailsPanel active />
        </>}
      </div>
    </details>
    <details>
      <summary className="min-h-11 cursor-pointer py-2">{t('sync.healthModal.actions.openAdvanced')}</summary>
      {diagnostics}
    </details>
  </div>;
}

export function TillHealthConfirmation({ confirmation, onClose, onConfirm, busy }: {
  confirmation: { issue: RecoveryIssue; action: RecoveryActionDescriptor } | null;
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  if (!confirmation) return null;
  const { action } = confirmation;
  return <ConfirmDialog isOpen onClose={onClose} onConfirm={onConfirm}
    title={t(action?.confirmTitleKey ?? 'recovery.actions.confirmTitle')}
    message={t(action?.confirmMessageKey ?? 'recovery.actions.confirmMessage', { ...confirmation?.issue.params, orderNumber: confirmation?.issue.orderNumber ?? '' })}
    confirmText={t('common.actions.confirm')} cancelText={t('common.actions.cancel')} variant="warning"
    requireCheckbox={action?.confirmCheckboxKey ? t(action.confirmCheckboxKey) : undefined} isLoading={busy} />;
}
