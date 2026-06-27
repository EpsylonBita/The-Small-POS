import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Clock3,
  DatabaseBackup,
  ExternalLink,
  LifeBuoy,
  ListChecks,
  RefreshCw,
  ShieldAlert,
  Sparkles,
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
import { usePrivilegedActionConfirmation } from '../../hooks/usePrivilegedActionConfirmation';
import { getErrorMessage } from '../../utils/privileged-actions';

interface RecoveryCenterPanelProps {
  issues: RecoveryIssue[];
  recentActions: RecoveryActionLogEntry[];
  terminalContext?: DiagnosticsTerminalContext | null;
  onRefresh: () => Promise<void> | void;
  onSyncNow?: () => Promise<void> | void;
  onNavigate?: () => void;
  onActionResolved?: (entry: RecoveryActionLogEntry) => void;
  titleKey?: string;
  subtitleKey?: string;
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
      'border border-red-400/30 bg-red-500/10 text-red-700 dark:text-red-200',
    panel:
      'border-red-200/80 bg-red-50/80 dark:border-red-400/25 dark:bg-red-500/10',
    icon: AlertTriangle,
    iconClass: 'text-red-600 dark:text-red-300',
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
      'border border-slate-300/80 bg-white/85 text-slate-700 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-200',
    panel:
      'border-slate-200/80 bg-slate-50/80 dark:border-white/10 dark:bg-white/[0.06]',
    icon: Clock3,
    iconClass: 'text-slate-600 dark:text-slate-300',
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
  if (action.recommended) {
    return 'border-emerald-300/80 bg-emerald-50/90 text-emerald-800 active:bg-emerald-100 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-100 dark:active:bg-emerald-500/20';
  }
  if (action.safetyLevel === 'destructive_server') {
    return 'border-red-300/80 bg-red-50/90 text-red-700 active:bg-red-100 dark:border-red-400/25 dark:bg-red-500/10 dark:text-red-200 dark:active:bg-red-500/15';
  }
  if (action.safetyLevel === 'destructive_local') {
    return 'border-amber-300/80 bg-amber-50/90 text-amber-700 active:bg-amber-100 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-200 dark:active:bg-amber-500/15';
  }
  return 'border-slate-200/90 bg-white/90 text-slate-700 active:bg-slate-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:active:bg-white/[0.09]';
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
  recipeId: action.recipeId ?? issue.knownSolution?.recipeId ?? null,
  recipeVersion: action.recipeVersion ?? issue.knownSolution?.version ?? null,
  routeTarget: action.routeTarget ?? null,
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
  const diagnosticTiles = [
    {
      key: 'localOrderTotal',
      labelKey: 'recovery.common.localOrderTotal',
      value: issue.params?.localOrderTotal,
    },
    {
      key: 'remoteOrderTotal',
      labelKey: 'recovery.common.remoteOrderTotal',
      value: issue.params?.remoteOrderTotal || issue.params?.orderTotal,
    },
    {
      key: 'paymentAmount',
      labelKey: 'recovery.common.paymentAmount',
      value: issue.params?.paymentAmount,
    },
    {
      key: 'existingCompleted',
      labelKey: 'recovery.common.existingCompleted',
      value: issue.params?.existingCompleted,
    },
    {
      key: 'settlementMath',
      labelKey: 'recovery.common.settlementMath',
      value: issue.params?.settlementMath,
    },
    {
      key: 'remotePaymentId',
      labelKey: 'recovery.common.remotePayment',
      value: issue.params?.remotePaymentId,
      mono: true,
    },
  ].filter((tile) => typeof tile.value === 'string' && tile.value.trim().length > 0);
  const sortedActions = [...issue.actions].sort(
    (left, right) => Number(Boolean(right.recommended)) - Number(Boolean(left.recommended)),
  );

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
          {diagnosticTiles.map((tile) => (
            <div
              key={tile.key}
              className="rounded-2xl border border-white/50 bg-white/70 px-3 py-3 dark:border-white/10 dark:bg-white/[0.04]"
            >
              <div className="uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                {t(tile.labelKey, { defaultValue: tile.key })}
              </div>
              <div
                className={cn(
                  'mt-2 text-slate-800 dark:text-slate-100',
                  tile.mono
                    ? 'break-all font-mono text-[11px]'
                    : 'font-semibold',
                )}
              >
                {tile.value as string}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          {sortedActions.map((action) => {
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
                <span className="flex min-w-0 flex-col items-start leading-tight">
                  <span className="flex items-center gap-2">
                    {t(action.labelKey, { defaultValue: action.id })}
                    {action.recommended && (
                      <span className="rounded-full border border-current/25 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em]">
                        {t('recovery.common.recommended', {
                          defaultValue: 'Recommended',
                        })}
                      </span>
                    )}
                  </span>
                  {action.descriptionKey && (
                    <span className="mt-0.5 max-w-[18rem] text-left text-[11px] font-medium opacity-80">
                      {t(action.descriptionKey, { defaultValue: '' })}
                    </span>
                  )}
                </span>
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
  onSyncNow,
  onNavigate,
  onActionResolved,
  titleKey = 'recovery.center.guidedTitle',
  subtitleKey = 'recovery.center.guidedSubtitle',
}) => {
  const { t } = useTranslation();
  const bridge = getBridge();
  const { runWithPrivilegedConfirmation, confirmationModal } =
    usePrivilegedActionConfirmation();
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [optimisticallyResolvedIssueIds, setOptimisticallyResolvedIssueIds] = useState<
    Set<string>
  >(new Set());
  const [confirmingAction, setConfirmingAction] = useState<{
    issue: RecoveryIssue;
    action: RecoveryActionDescriptor;
  } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    setOptimisticallyResolvedIssueIds((current) => {
      if (current.size === 0) {
        return current;
      }

      const next = new Set(
        [...current].filter((issueId) =>
          issues.some((issue) => issue.id === issueId),
        ),
      );
      return next.size === current.size ? current : next;
    });
  }, [issues]);

  const visibleIssues = useMemo(
    () =>
      issues.filter((issue) => !optimisticallyResolvedIssueIds.has(issue.id)),
    [issues, optimisticallyResolvedIssueIds],
  );

  const blockingIssues = useMemo(
    () =>
      visibleIssues
        .filter((issue) => issue.status === 'blocking')
        .sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]),
    [visibleIssues],
  );
  const recoveringIssues = useMemo(
    () =>
      visibleIssues
        .filter((issue) => issue.status === 'recovering')
        .sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]),
    [visibleIssues],
  );
  const resolvedActions = useMemo(
    () => recentActions.slice(0, 8),
    [recentActions],
  );
  const primaryIssue = useMemo(
    () => blockingIssues[0] ?? recoveringIssues[0] ?? visibleIssues[0] ?? null,
    [blockingIssues, recoveringIssues, visibleIssues],
  );
  const primaryActions = useMemo(
    () =>
      primaryIssue
        ? [...primaryIssue.actions].sort(
            (left, right) =>
              Number(Boolean(right.recommended)) - Number(Boolean(left.recommended)),
          )
        : [],
    [primaryIssue],
  );
  const recommendedAction = primaryActions.find((action) => action.recommended) ?? primaryActions[0] ?? null;
  const contactDevAction =
    primaryActions.find((action) => action.id === 'contactDev') ??
    primaryIssue?.actions.find((action) => action.id === 'contactDev') ??
    null;
  const remainingIssueCount = Math.max(visibleIssues.length - (primaryIssue ? 1 : 0), 0);
  // Cashier-facing summary: show the friendly branch/organization NAME when known, but never fall back to the
  // raw branchId/organizationId UUID. When no name is available, show a plain "This branch / This business"
  // label. The raw ids remain available to internal recovery logic, action logs, and diagnostics export.
  const branchDisplayName =
    terminalContext?.branchName?.trim() ||
    t('recovery.center.branchFallback', { defaultValue: 'This branch' });
  const organizationDisplayName =
    terminalContext?.organizationName?.trim() ||
    t('recovery.center.organizationFallback', { defaultValue: 'This business' });

  const runAction = async (
    issue: RecoveryIssue,
    action: RecoveryActionDescriptor,
  ) => {
    const actionKey = `${issue.id}:${action.id}`;
    const request = buildActionRequest(issue, action);
    let snapshotPointId: string | null = null;
    let exportPath: string | null = null;
    const buildLogEntry = (
      success: boolean,
      message?: string | null,
      errorMessage?: string | null,
    ): RecoveryActionLogEntry & Record<string, unknown> => ({
      id: `${issue.id}:${action.id}:${Date.now()}`,
      actionId: action.id,
      issueCode: issue.code,
      issueId: issue.id,
      entityType: issue.entityType,
      queueId: issue.queueId ?? null,
      success,
      timestamp: new Date().toISOString(),
      recipeId: action.recipeId ?? issue.knownSolution?.recipeId ?? null,
      recipeVersion: action.recipeVersion ?? issue.knownSolution?.version ?? null,
      snapshotPointId,
      exportPath,
      message: message ?? null,
      errorMessage: errorMessage ?? null,
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
    const persistLogEntry = async (
      success: boolean,
      message?: string | null,
      errorMessage?: string | null,
    ) => {
      const entry = buildLogEntry(success, message, errorMessage);
      try {
        const persisted = await bridge.recovery.recordActionLog(entry);
        onActionResolved?.(persisted);
      } catch (logError) {
        console.warn('[RecoveryCenter] failed to persist recovery action log', logError);
        onActionResolved?.(entry);
      }
    };

    setBusyActionId(actionKey);
    try {
      if (action.requiresSnapshot) {
        const snapshot = await bridge.recovery.createPreActionSnapshot();
        snapshotPointId = snapshot.id;
      }

      if (action.id === 'contactDev') {
        const diagnosticsExport = await bridge.diagnostics.export({
          includeLogs: true,
          redactSensitive: true,
        });
        exportPath = diagnosticsExport.path || null;
      }

      const executeAction = () => bridge.recovery.executeAction(request);
      const result = await runWithPrivilegedConfirmation({
        scope: 'cash_drawer_control',
        action: executeAction,
        title: t('recovery.confirmations.cashDrawerControl.title', {
          defaultValue: 'Confirm recovery action',
        }),
        subtitle: t('recovery.confirmations.cashDrawerControl.subtitle', {
          defaultValue:
            'Enter the cashier or manager PIN to run this recovery action.',
        }),
      });

      toast.success(
        result.message ||
          t('recovery.messages.actionSucceeded', {
            action: t(action.labelKey, { defaultValue: action.id }),
            defaultValue: 'Action completed successfully.',
          }),
      );

      await persistLogEntry(true, result.message ?? null, null);

      setOptimisticallyResolvedIssueIds((current) => {
        const next = new Set(current);
        next.add(issue.id);
        return next;
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
      const errorMessage = getErrorMessage(
        error,
        t('recovery.messages.actionFailed', {
          action: t(action.labelKey, { defaultValue: action.id }),
          defaultValue: 'Action failed. Review the issue details and try again.',
        }),
      );
      await persistLogEntry(false, null, errorMessage);
      toast.error(
        errorMessage,
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
    const pending = confirmingAction;
    setConfirmingAction(null);
    void runAction(pending.issue, pending.action);
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
      {confirmationModal}
      <section className="rounded-[28px] border border-slate-200/80 bg-white/95 p-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-slate-950/55 dark:shadow-[0_18px_40px_rgba(2,6,23,0.28)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-2xl font-black tracking-tight text-slate-950 dark:text-white">
                {t(titleKey, {
                  defaultValue: 'System sync status',
                })}
              </h3>
              <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-slate-300/85">
                {t(subtitleKey, {
                  defaultValue:
                    'The POS explains what is happening, offers the safest next step, then verifies sync again.',
                })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void onRefresh()}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl border border-slate-200/90 bg-white px-4 text-sm font-semibold text-slate-700 transition-transform active:scale-[0.98] active:bg-slate-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:active:bg-white/[0.09]"
            >
              <RefreshCw className="h-4 w-4" />
              {t('recovery.actions.refresh.label', {
                defaultValue: 'Refresh issues',
              })}
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-[22px] border border-emerald-200/80 bg-emerald-50 px-4 py-3 dark:border-emerald-400/25 dark:bg-emerald-500/10">
              <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-200">
                {t('recovery.center.blockedCount', {
                  count: blockingIssues.length,
                  defaultValue: '{{count}} blocking',
                })}
              </div>
              <div className="mt-1 text-xs text-emerald-700/75 dark:text-emerald-100/70">
                {t('recovery.center.thisTerminal', {
                  defaultValue: 'This register',
                })}
              </div>
            </div>
            <div className="rounded-[22px] border border-slate-200/80 bg-slate-50 px-4 py-3 dark:border-white/10 dark:bg-white/[0.06]">
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                {branchDisplayName}
              </div>
              <div className="mt-1 text-xs text-slate-600/80 dark:text-slate-300/75">
                {organizationDisplayName}
              </div>
            </div>
            <div className="rounded-[22px] border border-slate-200/80 bg-slate-50 px-4 py-3 dark:border-white/10 dark:bg-black/20">
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                {t('recovery.center.remainingIssues', {
                  count: visibleIssues.length,
                  defaultValue: '{{count}} visible issues',
                })}
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {t(`recovery.status.${terminalContext?.syncHealthState || 'blocking'}`, {
                  defaultValue: terminalContext?.syncHealthState || '-',
                })}
              </div>
            </div>
          </div>

          {!primaryIssue ? (
            <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr_0.9fr]">
              <div className="rounded-[26px] border border-emerald-200 bg-emerald-50/90 p-5 text-emerald-900 dark:border-emerald-400/25 dark:bg-emerald-500/10 dark:text-emerald-100">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-200">
                  <CheckCircle2 className="h-4 w-4" />
                  {t('recovery.center.whatBlocksTitle', {
                    defaultValue: 'What is blocking sync',
                  })}
                </div>
                <h4 className="mt-4 text-xl font-black tracking-tight text-slate-950 dark:text-white">
                  {t('recovery.center.noVisibleBlockerTitle', {
                    defaultValue: 'Nothing is blocking sync',
                  })}
                </h4>
                <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-200/90">
                  {t('recovery.center.noVisibleBlockerDescription', {
                    defaultValue:
                      'No order, payment, or queue item currently needs manual recovery.',
                  })}
                </p>
              </div>

              <div className="rounded-[26px] border border-emerald-200 bg-emerald-50/90 p-5 dark:border-emerald-400/25 dark:bg-emerald-500/10">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-200">
                  <Sparkles className="h-4 w-4" />
                  {t('recovery.center.automaticSolutionTitle', {
                    defaultValue: 'Automatic solution',
                  })}
                </div>
                <h4 className="mt-4 text-lg font-black text-slate-950 dark:text-white">
                  {t('recovery.center.noFixNeededTitle', {
                    defaultValue: 'No fix needed',
                  })}
                </h4>
                <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-200/90">
                  {t('recovery.center.noFixNeededDescription', {
                    defaultValue:
                      'The app has no matched error to repair. If a new order was just changed, run sync and check again.',
                  })}
                </p>
              </div>

              <div className="rounded-[26px] border border-slate-200 bg-slate-50/90 p-5 dark:border-white/10 dark:bg-white/[0.06]">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-slate-700 dark:text-slate-200">
                  <ListChecks className="h-4 w-4" />
                  {t('recovery.center.verificationTitle', {
                    defaultValue: 'Check after the fix',
                  })}
                </div>
                <p className="mt-4 text-sm leading-6 text-slate-700 dark:text-slate-200/90">
                  {t('recovery.center.healthyVerificationDescription', {
                    defaultValue:
                      'Refresh this panel to verify the queue is still clear after the next sync cycle.',
                  })}
                </p>
                <div className="mt-5 flex flex-col gap-2">
                  {onSyncNow && (
                    <button
                      type="button"
                      onClick={() => void onSyncNow()}
                      className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-2xl bg-amber-400 px-4 text-sm font-black text-black transition-transform active:scale-[0.98] active:bg-amber-300"
                    >
                      <RefreshCw className="h-4 w-4" />
                      {t('sync.actions.forceSync', {
                        defaultValue: 'Sync now',
                      })}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void onRefresh()}
                    className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition-transform active:scale-[0.98] active:bg-slate-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:active:bg-white/[0.09]"
                  >
                    <RefreshCw className="h-4 w-4" />
                    {t('recovery.actions.refresh.label', {
                      defaultValue: 'Refresh issues',
                    })}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[1.2fr_0.9fr_0.9fr]">
              <div className="rounded-[26px] border border-amber-200 bg-amber-50/90 p-5 dark:border-amber-400/25 dark:bg-amber-500/10">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-200">
                  <AlertTriangle className="h-4 w-4" />
                  {t('recovery.center.whatBlocksTitle', {
                    defaultValue: 'What is blocking sync',
                  })}
                </div>
                <h4 className="mt-4 text-xl font-black tracking-tight text-slate-950 dark:text-white">
                  {t(primaryIssue.titleKey, {
                    ...primaryIssue.params,
                    defaultValue: primaryIssue.code,
                  })}
                </h4>
                <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-200/90">
                  {t(primaryIssue.summaryKey, {
                    ...primaryIssue.params,
                    defaultValue: primaryIssue.code,
                  })}
                </p>
                <div className="mt-4 rounded-2xl border border-white/70 bg-white/75 p-4 text-sm text-slate-700 dark:border-white/10 dark:bg-black/20 dark:text-slate-200">
                  {t(primaryIssue.guidanceKey, {
                    ...primaryIssue.params,
                    defaultValue: primaryIssue.code,
                  })}
                </div>
                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full border border-amber-300/70 bg-white/70 px-3 py-1 font-semibold text-amber-800 dark:border-amber-400/30 dark:bg-white/[0.06] dark:text-amber-100">
                    {primaryIssue.orderNumber || primaryIssue.entityId}
                  </span>
                  {remainingIssueCount > 0 && (
                    <span className="rounded-full border border-slate-200 bg-white/70 px-3 py-1 font-semibold text-slate-600 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-300">
                      {t('recovery.center.otherIssuesWaiting', {
                        count: remainingIssueCount,
                        defaultValue: '+{{count}} more',
                      })}
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-[26px] border border-emerald-200 bg-emerald-50/90 p-5 dark:border-emerald-400/25 dark:bg-emerald-500/10">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-200">
                  <Sparkles className="h-4 w-4" />
                  {t('recovery.center.automaticSolutionTitle', {
                    defaultValue: 'Automatic solution',
                  })}
                </div>
                <h4 className="mt-4 text-lg font-black text-slate-950 dark:text-white">
                  {primaryIssue.knownSolution
                    ? t(primaryIssue.knownSolution.labelKey, {
                        defaultValue: 'Known solution available',
                      })
                    : t('recovery.center.noKnownSolutionTitle', {
                        defaultValue: 'No one-click fix yet',
                      })}
                </h4>
                <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-200/90">
                  {primaryIssue.knownSolution
                    ? t(primaryIssue.knownSolution.explanationKey, {
                        defaultValue:
                          'This issue matches a developer-approved recovery recipe from this app version.',
                      })
                    : t('recovery.center.noKnownSolutionDescription', {
                        defaultValue:
                          'The POS can explain the blocker and prepare diagnostics for development support.',
                      })}
                </p>
                {recommendedAction?.requiresSnapshot && (
                  <div className="mt-4 flex items-start gap-2 rounded-2xl border border-emerald-300/60 bg-white/75 p-3 text-xs text-emerald-800 dark:border-emerald-400/25 dark:bg-black/20 dark:text-emerald-100">
                    <DatabaseBackup className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {t('recovery.center.backupBeforeFix', {
                        defaultValue:
                          'A recovery backup is created before this action changes local sync data.',
                      })}
                    </span>
                  </div>
                )}
                <div className="mt-5 flex flex-col gap-2">
                  {recommendedAction && (
                    <button
                      type="button"
                      onClick={() => handleActionClick(primaryIssue, recommendedAction)}
                      disabled={
                        busyActionId === `${primaryIssue.id}:${recommendedAction.id}` ||
                        (recommendedAction.requiresOnline && !navigator.onLine)
                      }
                      className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-4 text-sm font-black text-white transition-transform active:scale-[0.98] active:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 dark:bg-emerald-500 dark:text-slate-950 dark:active:bg-emerald-400"
                    >
                      {busyActionId === `${primaryIssue.id}:${recommendedAction.id}` ? (
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      ) : recommendedAction.routeTarget ? (
                        <ExternalLink className="h-4 w-4" />
                      ) : (
                        <Wrench className="h-4 w-4" />
                      )}
                      {t(recommendedAction.labelKey, {
                        defaultValue: recommendedAction.id,
                      })}
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  )}
                  {contactDevAction && contactDevAction.id !== recommendedAction?.id && (
                    <button
                      type="button"
                      onClick={() => handleActionClick(primaryIssue, contactDevAction)}
                      disabled={busyActionId === `${primaryIssue.id}:${contactDevAction.id}`}
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition-transform active:scale-[0.98] active:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:active:bg-white/[0.09]"
                    >
                      <LifeBuoy className="h-4 w-4" />
                      {t(contactDevAction.labelKey, {
                        defaultValue: 'Contact Dev',
                      })}
                    </button>
                  )}
                </div>
              </div>

              <div className="rounded-[26px] border border-slate-200 bg-slate-50/90 p-5 dark:border-white/10 dark:bg-white/[0.06]">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-slate-700 dark:text-slate-200">
                  <ListChecks className="h-4 w-4" />
                  {t('recovery.center.verificationTitle', {
                    defaultValue: 'Check after the fix',
                  })}
                </div>
                <p className="mt-4 text-sm leading-6 text-slate-700 dark:text-slate-200/90">
                  {primaryIssue.knownSolution?.verificationKey
                    ? t(primaryIssue.knownSolution.verificationKey, {
                        defaultValue:
                          'After the action finishes, refresh sync health to confirm the blocker is gone.',
                      })
                    : t('recovery.center.genericVerificationDescription', {
                        defaultValue:
                          'After any action, the POS refreshes diagnostics and shows whether the queue can continue.',
                      })}
                </p>
                {resolvedActions[0] && (
                  <div className="mt-4 rounded-2xl border border-white/70 bg-white/75 p-3 text-xs text-slate-700 dark:border-white/10 dark:bg-black/20 dark:text-slate-200">
                    <div className="font-bold">
                      {resolvedActions[0].success
                        ? t('recovery.center.lastActionSucceeded', {
                            defaultValue: 'Last action succeeded',
                          })
                        : t('recovery.center.lastActionFailed', {
                            defaultValue: 'Last action failed',
                          })}
                    </div>
                    <div className="mt-1 opacity-75">
                      {new Date(resolvedActions[0].timestamp).toLocaleString()}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="rounded-[24px] border border-slate-200/80 bg-slate-50/80 dark:border-white/10 dark:bg-black/20">
            <button
              type="button"
              onClick={() => setShowAdvanced((value) => !value)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-bold text-slate-800 dark:text-slate-100"
            >
              <span>
                {t('recovery.center.advancedDetailsTitle', {
                  defaultValue: 'Advanced details',
                })}
              </span>
              {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {showAdvanced && (
              <div className="space-y-6 border-t border-slate-200/80 p-4 dark:border-white/10">
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
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                  {t('recovery.center.recentActionsTitle', {
                    defaultValue: 'Resolved recently',
                  })}
                </div>
                <div className="mt-2 text-sm text-slate-600 dark:text-slate-300/80">
                  {t('recovery.center.recentActionsSubtitle', {
                    defaultValue:
                      'Every repair attempt is audited locally with the recipe version and backup id.',
                  })}
                </div>
              </div>
            </div>
            {resolvedActions.length > 0 ? (
              <div className="grid gap-2 md:grid-cols-2">
                {resolvedActions.slice(0, 4).map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between gap-3 rounded-[20px] border border-slate-200/80 bg-white px-4 py-3 text-sm dark:border-white/10 dark:bg-white/[0.04]"
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
                        <div className="truncate font-semibold text-slate-900 dark:text-white">
                          {t(`recovery.actions.${entry.actionId}.label`, {
                            defaultValue: entry.actionId,
                          })}
                        </div>
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {entry.recipeId || entry.issueCode}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-xs text-slate-500 dark:text-slate-400">
                      {new Date(entry.timestamp).toLocaleTimeString()}
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
