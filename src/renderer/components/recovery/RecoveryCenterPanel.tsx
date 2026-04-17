import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
  Wrench,
} from 'lucide-react';

import { ConfirmDialog } from '../ui/ConfirmDialog';
import { cn } from '../../utils/cn';
import {
  getBridge,
  type DiagnosticsTerminalContext,
  type RecoveryActionDescriptor,
  type RecoveryActionLogEntry,
  type RecoveryActionRequest,
  type RecoveryIssue,
  type RecoveryRouteTarget,
} from '../../../lib';

interface RecoveryCenterPanelProps {
  issues: RecoveryIssue[];
  recentActions: RecoveryActionLogEntry[];
  terminalContext?: DiagnosticsTerminalContext | null;
  onRefresh: () => Promise<void> | void;
  onNavigate?: () => void;
  onActionResolved?: (entry: RecoveryActionLogEntry) => void;
}

const severityOrder: Record<RecoveryIssue['severity'], number> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
};

const severityClasses: Record<
  RecoveryIssue['severity'],
  {
    badge: string;
    panel: string;
    icon: React.ComponentType<{ className?: string }>;
    iconClass: string;
  }
> = {
  critical: {
    badge:
      'border border-red-400/30 bg-red-500/10 text-red-700 dark:text-red-200',
    panel:
      'border-red-200/80 bg-red-50/80 dark:border-red-400/25 dark:bg-red-500/10',
    icon: ShieldAlert,
    iconClass: 'text-red-600 dark:text-red-300',
  },
  error: {
    badge:
      'border border-orange-400/30 bg-orange-500/10 text-orange-700 dark:text-orange-200',
    panel:
      'border-orange-200/80 bg-orange-50/80 dark:border-orange-400/25 dark:bg-orange-500/10',
    icon: AlertTriangle,
    iconClass: 'text-orange-600 dark:text-orange-300',
  },
  warning: {
    badge:
      'border border-amber-400/30 bg-amber-500/10 text-amber-700 dark:text-amber-200',
    panel:
      'border-amber-200/80 bg-amber-50/80 dark:border-amber-400/25 dark:bg-amber-500/10',
    icon: Wrench,
    iconClass: 'text-amber-600 dark:text-amber-300',
  },
  info: {
    badge:
      'border border-sky-400/30 bg-sky-500/10 text-sky-700 dark:text-sky-200',
    panel:
      'border-sky-200/80 bg-sky-50/80 dark:border-sky-400/25 dark:bg-sky-500/10',
    icon: Clock3,
    iconClass: 'text-sky-600 dark:text-sky-300',
  },
};

const entityLabelKey: Record<string, string> = {
  order: 'sync.entityTypes.order',
  payment: 'sync.entityTypes.payment',
  payment_adjustment: 'sync.entityTypes.paymentAdjustment',
  z_report: 'sync.entityTypes.zReport',
  shift: 'sync.entityTypes.shift',
  print_job: 'sync.entityTypes.printer',
};

const actionButtonTone = (action: RecoveryActionDescriptor) => {
  if (action.safetyLevel === 'destructive_server') {
    return 'border-red-300/80 bg-red-50/90 text-red-700 hover:bg-red-100 dark:border-red-400/25 dark:bg-red-500/10 dark:text-red-200 dark:hover:bg-red-500/15';
  }
  if (action.safetyLevel === 'destructive_local') {
    return 'border-amber-300/80 bg-amber-50/90 text-amber-700 hover:bg-amber-100 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/15';
  }
  return 'border-slate-200/90 bg-white/90 text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.09]';
};

const buildActionRequest = (
  issue: RecoveryIssue,
  action: RecoveryActionDescriptor,
): RecoveryActionRequest => ({
  actionId: action.id,
  issueId: issue.id,
  issueCode: issue.code,
  queueId: issue.queueId ?? null,
  entityType: issue.entityType,
  entityId: issue.entityId,
  orderId: issue.orderId ?? null,
  orderNumber: issue.orderNumber ?? null,
  paymentId: issue.paymentId ?? null,
  adjustmentId: issue.adjustmentId ?? null,
  zReportId: issue.zReportId ?? null,
  shiftId: issue.shiftId ?? null,
  reportDate:
    typeof issue.params?.reportDate === 'string'
      ? issue.params.reportDate
      : typeof issue.params?.pendingReportDate === 'string'
        ? issue.params.pendingReportDate
        : action.routeTarget?.zReportDate ?? null,
  params: issue.params,
});

const dispatchRecoveryRoute = (target: RecoveryRouteTarget) => {
  window.dispatchEvent(
    new CustomEvent('pos:recovery-route', {
      detail: target,
    }),
  );
};

const RecoveryIssueCard: React.FC<{
  issue: RecoveryIssue;
  busyActionId: string | null;
  onActionClick: (issue: RecoveryIssue, action: RecoveryActionDescriptor) => void;
}> = ({ issue, busyActionId, onActionClick }) => {
  const { t } = useTranslation();
  const style = severityClasses[issue.severity];
  const Icon = style.icon;
  const entityLabel = entityLabelKey[issue.entityType]
    ? t(entityLabelKey[issue.entityType], { defaultValue: issue.entityType })
    : issue.entityType;
  const reference =
    issue.orderNumber ||
    (typeof issue.params?.reportDate === 'string' ? issue.params.reportDate : null) ||
    issue.shiftId ||
    issue.entityId;

  return (
    <div className={cn('rounded-[24px] border p-5 shadow-[0_10px_24px_rgba(15,23,42,0.05)] dark:shadow-none', style.panel)}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-2xl border border-white/40 bg-white/60 p-2.5 dark:border-white/10 dark:bg-white/[0.05]">
              <Icon className={cn('h-5 w-5', style.iconClass)} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                  {entityLabel}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]',
                    style.badge,
                  )}
                >
                  {t(`recovery.status.${issue.status}`, {
                    defaultValue: issue.status,
                  })}
                </span>
              </div>
              <div className="mt-2 text-base font-black tracking-tight text-slate-900 dark:text-white">
                {t(issue.titleKey, {
                  ...issue.params,
                  defaultValue: issue.orderNumber || issue.entityId,
                })}
              </div>
              <div className="mt-1 text-sm text-slate-700 dark:text-slate-200/90">
                {t(issue.summaryKey, {
                  ...issue.params,
                  defaultValue: issue.code,
                })}
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-white/50 bg-white/70 px-3 py-2 text-right dark:border-white/10 dark:bg-white/[0.05]">
            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
              {t('recovery.common.reference', { defaultValue: 'Reference' })}
            </div>
            <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
              {reference}
            </div>
          </div>
        </div>

        <div className="rounded-[20px] border border-white/50 bg-white/70 px-4 py-3 text-sm text-slate-700 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-200/90">
          {t(issue.guidanceKey, {
            ...issue.params,
            defaultValue: issue.code,
          })}
        </div>

        <div className="grid gap-3 text-xs text-slate-600 dark:text-slate-300 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-white/50 bg-white/70 px-3 py-3 dark:border-white/10 dark:bg-white/[0.04]">
            <div className="uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
              {t('recovery.common.entityId', { defaultValue: 'Entity ID' })}
            </div>
            <div className="mt-2 break-all font-mono text-[11px] text-slate-800 dark:text-slate-100">
              {issue.entityId}
            </div>
          </div>
          {(issue.orderId || issue.orderNumber) && (
            <div className="rounded-2xl border border-white/50 bg-white/70 px-3 py-3 dark:border-white/10 dark:bg-white/[0.04]">
              <div className="uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                {t('recovery.common.order', { defaultValue: 'Order' })}
              </div>
              <div className="mt-2 font-semibold text-slate-800 dark:text-slate-100">
                {issue.orderNumber || issue.orderId}
              </div>
            </div>
          )}
          {issue.paymentId && (
            <div className="rounded-2xl border border-white/50 bg-white/70 px-3 py-3 dark:border-white/10 dark:bg-white/[0.04]">
              <div className="uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                {t('recovery.common.payment', { defaultValue: 'Payment' })}
              </div>
              <div className="mt-2 break-all font-mono text-[11px] text-slate-800 dark:text-slate-100">
                {issue.paymentId}
              </div>
            </div>
          )}
          {issue.adjustmentId && (
            <div className="rounded-2xl border border-white/50 bg-white/70 px-3 py-3 dark:border-white/10 dark:bg-white/[0.04]">
              <div className="uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                {t('recovery.common.adjustment', {
                  defaultValue: 'Adjustment',
                })}
              </div>
              <div className="mt-2 break-all font-mono text-[11px] text-slate-800 dark:text-slate-100">
                {issue.adjustmentId}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {issue.actions.map((action) => {
            const actionBusy = busyActionId === `${issue.id}:${action.id}`;
            return (
              <button
                key={`${issue.id}:${action.id}`}
                type="button"
                onClick={() => onActionClick(issue, action)}
                disabled={actionBusy || (action.requiresOnline && !navigator.onLine)}
                className={cn(
                  'inline-flex items-center justify-center gap-2 rounded-2xl border px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  actionButtonTone(action),
                )}
              >
                {actionBusy ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : action.routeTarget ? (
                  <ExternalLink className="h-4 w-4" />
                ) : (
                  <Wrench className="h-4 w-4" />
                )}
                {t(action.labelKey, { defaultValue: action.id })}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const RecoveryCenterPanel: React.FC<RecoveryCenterPanelProps> = ({
  issues,
  recentActions,
  terminalContext,
  onRefresh,
  onNavigate,
  onActionResolved,
}) => {
  const { t } = useTranslation();
  const bridge = getBridge();
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [confirmingAction, setConfirmingAction] = useState<{
    issue: RecoveryIssue;
    action: RecoveryActionDescriptor;
  } | null>(null);

  const blockingIssues = useMemo(
    () =>
      issues
        .filter((issue) => issue.status === 'blocking')
        .sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]),
    [issues],
  );
  const recoveringIssues = useMemo(
    () =>
      issues
        .filter((issue) => issue.status === 'recovering')
        .sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]),
    [issues],
  );
  const resolvedActions = useMemo(
    () => recentActions.slice(0, 8),
    [recentActions],
  );
  const branchDisplayName =
    terminalContext?.branchName?.trim() ||
    terminalContext?.branchId?.trim() ||
    '-';
  const organizationDisplayName =
    terminalContext?.organizationName?.trim() ||
    terminalContext?.organizationId?.trim() ||
    '-';

  const runAction = async (
    issue: RecoveryIssue,
    action: RecoveryActionDescriptor,
  ) => {
    const actionKey = `${issue.id}:${action.id}`;
    setBusyActionId(actionKey);
    try {
      const result = await bridge.recovery.executeAction(
        buildActionRequest(issue, action),
      );

      toast.success(
        result.message ||
          t('recovery.messages.actionSucceeded', {
            action: t(action.labelKey, { defaultValue: action.id }),
            defaultValue: 'Action completed successfully.',
          }),
      );

      onActionResolved?.({
        id: `${issue.id}:${action.id}:${Date.now()}`,
        actionId: action.id,
        issueCode: issue.code,
        success: true,
        timestamp: new Date().toISOString(),
        actor: {
          staffId: null,
          staffName: terminalContext?.terminalId ?? null,
        },
        targetRefs: {
          entityId: issue.entityId,
          orderId: issue.orderId ?? null,
          orderNumber: issue.orderNumber ?? null,
          shiftId: issue.shiftId ?? null,
        },
      });

      if (result.routeTarget || action.routeTarget) {
        dispatchRecoveryRoute(result.routeTarget || action.routeTarget!);
        onNavigate?.();
      }

      if (result.requiresRefresh) {
        await onRefresh();
      } else {
        await onRefresh();
      }
    } catch (error) {
      console.error('[RecoveryCenter] action failed', error);
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('recovery.messages.actionFailed', {
              action: t(action.labelKey, { defaultValue: action.id }),
              defaultValue: 'Action failed. Review the issue details and try again.',
            }),
      );
    } finally {
      setBusyActionId(null);
      setConfirmingAction(null);
    }
  };

  const handleActionClick = (
    issue: RecoveryIssue,
    action: RecoveryActionDescriptor,
  ) => {
    if (action.confirmationRequired) {
      setConfirmingAction({ issue, action });
      return;
    }
    void runAction(issue, action);
  };

  const handleConfirmDestructiveAction = () => {
    if (!confirmingAction) return;
    void runAction(confirmingAction.issue, confirmingAction.action);
  };

  const renderSection = (
    titleKey: string,
    descriptionKey: string,
    list: RecoveryIssue[],
    emptyKey: string,
  ) => (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
            {t(titleKey)}
          </div>
          <div className="mt-2 text-sm text-slate-600 dark:text-slate-300/80">
            {t(descriptionKey)}
          </div>
        </div>
        <div className="rounded-full border border-slate-200/80 bg-white/90 px-3 py-1 text-xs font-semibold text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200">
          {t('recovery.common.issueCount', {
            count: list.length,
            defaultValue: '{{count}} issues',
          })}
        </div>
      </div>
      {list.length > 0 ? (
        <div className="space-y-3">
          {list.map((issue) => (
            <RecoveryIssueCard
              key={issue.id}
              issue={issue}
              busyActionId={busyActionId}
              onActionClick={handleActionClick}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-[22px] border border-emerald-200/80 bg-emerald-50/90 px-4 py-4 text-sm text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-500/10 dark:text-emerald-200">
          {t(emptyKey)}
        </div>
      )}
    </div>
  );

  return (
    <>
      <section className="rounded-[28px] border border-slate-200/80 bg-white/92 p-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-white/[0.04] dark:shadow-[0_18px_40px_rgba(2,6,23,0.28)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                {t('recovery.center.eyebrow', {
                  defaultValue: 'Recovery center',
                })}
              </div>
              <h3 className="mt-2 text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                {t('recovery.center.title', {
                  defaultValue: 'Self-service recovery',
                })}
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-slate-300/80">
                {t('recovery.center.subtitle', {
                  defaultValue:
                    'Use guided repair actions to resolve blocked orders, payments, shifts, Z-reports, and printer issues without leaving the POS.',
                })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void onRefresh()}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200/90 bg-white/90 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:hover:bg-white/[0.08]"
            >
              <RefreshCw className="h-4 w-4" />
              {t('recovery.actions.refresh.label', {
                defaultValue: 'Refresh issues',
              })}
            </button>
          </div>

          <div className="grid gap-3 xl:grid-cols-4">
            <div className="rounded-[22px] border border-slate-200/80 bg-slate-50/90 px-4 py-4 dark:border-white/10 dark:bg-black/20">
              <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                {t('recovery.context.terminalId', { defaultValue: 'Terminal ID' })}
              </div>
              <div className="mt-2 break-all text-sm font-semibold text-slate-900 dark:text-white">
                {terminalContext?.terminalId || '-'}
              </div>
            </div>
            <div className="rounded-[22px] border border-slate-200/80 bg-slate-50/90 px-4 py-4 dark:border-white/10 dark:bg-black/20">
              <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                {t('recovery.context.branchName', { defaultValue: 'Branch' })}
              </div>
              <div className="mt-2 break-all text-sm font-semibold text-slate-900 dark:text-white">
                {branchDisplayName}
              </div>
            </div>
            <div className="rounded-[22px] border border-slate-200/80 bg-slate-50/90 px-4 py-4 dark:border-white/10 dark:bg-black/20">
              <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                {t('recovery.context.organizationName', {
                  defaultValue: 'Organization',
                })}
              </div>
              <div className="mt-2 break-all text-sm font-semibold text-slate-900 dark:text-white">
                {organizationDisplayName}
              </div>
            </div>
            <div className="rounded-[22px] border border-slate-200/80 bg-slate-50/90 px-4 py-4 dark:border-white/10 dark:bg-black/20">
              <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                {t('recovery.context.syncHealthState', {
                  defaultValue: 'Sync health',
                })}
              </div>
              <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
                {t(`recovery.status.${terminalContext?.syncHealthState || 'blocking'}`, {
                  defaultValue: terminalContext?.syncHealthState || '-',
                })}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            {renderSection(
              'recovery.center.needsAttentionTitle',
              'recovery.center.needsAttentionSubtitle',
              blockingIssues,
              'recovery.center.noBlockingIssues',
            )}
            {renderSection(
              'recovery.center.recoveringTitle',
              'recovery.center.recoveringSubtitle',
              recoveringIssues,
              'recovery.center.noRecoveringIssues',
            )}
          </div>

          <div className="space-y-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                {t('recovery.center.recentActionsTitle', {
                  defaultValue: 'Resolved recently',
                })}
              </div>
              <div className="mt-2 text-sm text-slate-600 dark:text-slate-300/80">
                {t('recovery.center.recentActionsSubtitle', {
                  defaultValue:
                    'Every repair attempt is audited locally so staff can see what was tried and what succeeded.',
                })}
              </div>
            </div>
            {resolvedActions.length > 0 ? (
              <div className="space-y-2">
                {resolvedActions.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-slate-200/80 bg-slate-50/90 px-4 py-3 text-sm dark:border-white/10 dark:bg-black/20"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <CheckCircle2
                        className={cn(
                          'h-4 w-4 shrink-0',
                          entry.success
                            ? 'text-emerald-600 dark:text-emerald-300'
                            : 'text-red-600 dark:text-red-300',
                        )}
                      />
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {t(`recovery.actions.${entry.actionId}.label`, {
                            defaultValue: entry.actionId,
                          })}
                        </div>
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {entry.targetRefs.orderNumber ||
                            entry.targetRefs.orderId ||
                            entry.targetRefs.shiftId ||
                            entry.targetRefs.entityId ||
                            entry.issueCode}
                        </div>
                      </div>
                    </div>
                    <div className="text-right text-xs text-slate-500 dark:text-slate-400">
                      <div>{new Date(entry.timestamp).toLocaleString()}</div>
                      <div>
                        {entry.actor.staffName ||
                          entry.actor.staffId ||
                          t('recovery.common.unknownActor', {
                            defaultValue: 'Unknown actor',
                          })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-[22px] border border-slate-200/80 bg-slate-50/90 px-4 py-4 text-sm text-slate-600 dark:border-white/10 dark:bg-black/20 dark:text-slate-300">
                {t('recovery.center.noRecentActions', {
                  defaultValue: 'No recovery actions have been recorded yet.',
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      <ConfirmDialog
        isOpen={confirmingAction !== null}
        onClose={() => setConfirmingAction(null)}
        onConfirm={handleConfirmDestructiveAction}
        title={
          confirmingAction
            ? t(
                confirmingAction.action.confirmTitleKey ||
                  'recovery.actions.confirmTitle',
                {
                  defaultValue: 'Confirm recovery action',
                },
              )
            : ''
        }
        message={
          confirmingAction
            ? t(
                confirmingAction.action.confirmMessageKey ||
                  'recovery.actions.confirmMessage',
                {
                  ...confirmingAction.issue.params,
                  orderNumber:
                    confirmingAction.issue.orderNumber ||
                    confirmingAction.issue.entityId,
                  defaultValue:
                    'This action changes local recovery data for the selected issue.',
                },
              )
            : ''
        }
        confirmText={t('common.actions.confirm', { defaultValue: 'Confirm' })}
        cancelText={t('common.actions.cancel', { defaultValue: 'Cancel' })}
        variant="warning"
        requireCheckbox={
          confirmingAction?.action.confirmCheckboxKey
            ? t(confirmingAction.action.confirmCheckboxKey, {
                defaultValue:
                  'I understand this recovery action may discard local data.',
              })
            : undefined
        }
        isLoading={confirmingAction ? busyActionId === `${confirmingAction.issue.id}:${confirmingAction.action.id}` : false}
      />
    </>
  );
};
