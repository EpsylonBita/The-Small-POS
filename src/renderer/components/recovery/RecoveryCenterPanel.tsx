import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  DatabaseBackup,
  ExternalLink,
  LifeBuoy,
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
  diagnosticsStale?: boolean;
}

const severityOrder: Record<RecoveryIssue['severity'], number> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
};
const recoveryPriority = (left: RecoveryIssue, right: RecoveryIssue) =>
  severityOrder[left.severity] - severityOrder[right.severity] ||
  Number(Boolean(right.knownSolution)) - Number(Boolean(left.knownSolution));

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

// Backend exception text can contain credentials or customer details. Keep it
// in redacted support exports; staff copy uses a safe explanation instead.
const staffIssueParams = (issue: RecoveryIssue, fallback: string) => ({
  ...issue.params,
  reason: fallback,
  reasonText: fallback,
  lastError: fallback,
  errorMessage: fallback,
});

const RecoveryIssueCard: React.FC<{
  issue: RecoveryIssue;
  busyActionId: string | null;
  diagnosticsStale?: boolean;
  onActionClick: (issue: RecoveryIssue, action: RecoveryActionDescriptor) => void;
}> = ({ issue, busyActionId, diagnosticsStale, onActionClick }) => {
  const { t } = useTranslation();
  const displayParams = staffIssueParams(issue, t('sync.healthModal.failure.safeError'));
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
                  ...displayParams,
                  defaultValue: issue.orderNumber || issue.entityId,
                })}
              </div>
              <div className="mt-1 text-sm text-slate-700 dark:text-slate-200/90">
                {t(issue.summaryKey, {
                  ...displayParams,
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
            ...displayParams,
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
                disabled={diagnosticsStale || !!busyActionId || (action.requiresOnline && !navigator.onLine)}
                className={cn(
                  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-2xl border px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
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
  onNavigate,
  onActionResolved,
  diagnosticsStale = false,
}) => {
  const { t, i18n } = useTranslation();
  const bridge = getBridge();
  const { runWithPrivilegedConfirmation, confirmationModal } =
    usePrivilegedActionConfirmation();
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const actionInFlight = useRef(false);
  const pendingIssueIdRef = useRef<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  useEffect(() => {
    if (pendingIssueIdRef.current && !issues.some(issue => issue.id === pendingIssueIdRef.current)) {
      pendingIssueIdRef.current = null;
      setActionFeedback(t('recovery.center.outcomes.resolved'));
    }
  }, [issues, t]);
  const [confirmingAction, setConfirmingAction] = useState<{
    issue: RecoveryIssue;
    action: RecoveryActionDescriptor;
  } | null>(null);

  // Only the owner of a fresh diagnostics snapshot can remove an issue.
  const visibleIssues = issues;

  const blockingIssues = useMemo(
    () =>
      visibleIssues
        .filter((issue) => issue.status === 'blocking')
        .sort(recoveryPriority),
    [visibleIssues],
  );
  const recoveringIssues = useMemo(
    () =>
      visibleIssues
        .filter((issue) => issue.status === 'recovering')
        .sort(recoveryPriority),
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
    if (actionInFlight.current || diagnosticsStale) return;
    actionInFlight.current = true;
    setActionFeedback(null);
    const actionKey = `${issue.id}:${action.id}`;
    const request = buildActionRequest(issue, action);
    let snapshotPointId: string | null = null;
    let exportPath: string | null = null;
    let outcome: RecoveryActionLogEntry['outcome'] = 'unknown';
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
      outcome,
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
        if (!snapshot?.id) throw new Error('Recovery snapshot was not confirmed');
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

      // Route-only actions (open a screen) and contactDev (export diagnostics)
      // never "heal" a sync problem by themselves — resolving the underlying
      // issue still depends on what the operator does next or on the server.
      const isHealingAction = action.id !== 'contactDev' && !action.routeTarget;
      const verificationStatus = result?.verification?.status ?? null;
      // Only a strict `success === true` counts. A falsy/undefined response,
      // or a backend-reported verification failure, is a real failure even
      // though executeAction did not throw.
      const succeeded = result?.success === true && verificationStatus !== 'failed';
      const pendingVerification = succeeded && isHealingAction && verificationStatus !== 'passed';

      if (!succeeded) {
        outcome = 'failed';
        const friendlyMessage = t('recovery.messages.actionFailed', {
          action: t(action.labelKey, { defaultValue: action.id }),
          defaultValue: 'Action failed. Review the issue details and try again.',
        });
        // The raw backend message is kept in the audited log for support, but
        // the toast leads with plain language rather than a raw server string.
        await persistLogEntry(false, null, result?.message ?? friendlyMessage);
        setActionFeedback(friendlyMessage);
        toast.error(friendlyMessage);
      } else if (pendingVerification) {
        outcome = 'pending';
        pendingIssueIdRef.current = issue.id;
        const pendingMessage = t('recovery.messages.actionPendingVerification', {
          action: t(action.labelKey, { defaultValue: action.id }),
          defaultValue:
            'The action ran. Refreshing to confirm whether it actually fixed the problem.',
        });
        toast(pendingMessage);
        setActionFeedback(pendingMessage);
        // Not a confirmed success yet: keep the issue visible and log it as
        // unresolved so staff see honest pending state until a fresh
        // diagnostics refresh proves it worked.
        await persistLogEntry(false, result?.message ?? null, pendingMessage);
      } else {
        outcome = isHealingAction ? 'resolved' : 'unknown';
        toast.success(
          t('recovery.messages.actionSucceeded', {
            action: t(action.labelKey, { defaultValue: action.id }),
            defaultValue: 'Action completed successfully.',
          }),
        );
        await persistLogEntry(true, result?.message ?? null, null);

      }

      if (succeeded && (result?.routeTarget || action.routeTarget)) {
        dispatchRecoveryRoute(result?.routeTarget || action.routeTarget!);
        onNavigate?.();
      }

      await onRefresh();
    } catch (error) {
      outcome = 'failed';
      console.error('[RecoveryCenter] action failed', error);
      const errorMessage = getErrorMessage(
        error,
        t('recovery.messages.actionFailed', {
          action: t(action.labelKey, { defaultValue: action.id }),
          defaultValue: 'Action failed. Review the issue details and try again.',
        }),
      );
      await persistLogEntry(false, null, errorMessage);
      const friendlyMessage = t('recovery.messages.actionFailed');
      setActionFeedback(friendlyMessage);
      toast.error(friendlyMessage);
    } finally {
      actionInFlight.current = false;
      setBusyActionId(null);
      setConfirmingAction(null);
    }
  };

  const handleActionClick = (
    issue: RecoveryIssue,
    action: RecoveryActionDescriptor,
  ) => {
    if (diagnosticsStale || actionInFlight.current) return;
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
              diagnosticsStale={diagnosticsStale}
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
      <section className="space-y-4 text-slate-900 dark:text-slate-100">
        {actionFeedback && <div role="status" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">{actionFeedback}</div>}
        {!primaryIssue ? (
          <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-5 text-emerald-900 dark:border-emerald-400/25 dark:bg-emerald-500/10 dark:text-emerald-100">
            <h3 className="flex items-center gap-2 text-lg font-bold"><CheckCircle2 className="h-5 w-5" />{t('recovery.center.noVisibleBlockerTitle')}</h3>
            <p className="mt-2 text-sm">{t('recovery.center.noVisibleBlockerDescription')}</p>
          </div>
        ) : (
          <div className={cn('rounded-2xl border p-4 sm:p-5', severityClasses[primaryIssue.severity].panel)}>
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-1 h-6 w-6 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <h3 className="text-xl font-bold">{t(primaryIssue.titleKey, {...staffIssueParams(primaryIssue, t('sync.healthModal.failure.safeError')), defaultValue: t('recovery.center.whatBlocksTitle')})}</h3>
                <p className="mt-2 text-sm leading-6">{t(primaryIssue.summaryKey, {...staffIssueParams(primaryIssue, t('sync.healthModal.failure.safeError')), defaultValue: t('recovery.center.noKnownSolutionDescription')})}</p>
                <p className="mt-2 text-sm leading-6">{t(primaryIssue.guidanceKey, {...staffIssueParams(primaryIssue, t('sync.healthModal.failure.safeError')), defaultValue: t('recovery.center.noKnownSolutionDescription')})}</p>
                {recommendedAction && (
                  <button type="button" onClick={() => handleActionClick(primaryIssue, recommendedAction)}
                    disabled={diagnosticsStale || !!busyActionId || (recommendedAction.requiresOnline && !navigator.onLine)}
                    aria-busy={!!busyActionId}
                    className="mt-4 inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-amber-400 px-4 py-3 text-sm font-bold text-slate-950 active:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">
                    {busyActionId ? <RefreshCw className="h-5 w-5 animate-spin" /> : recommendedAction.routeTarget ? <ExternalLink className="h-5 w-5" /> : <Wrench className="h-5 w-5" />}
                    {t(recommendedAction.labelKey)}<ArrowRight className="h-4 w-4" />
                  </button>
                )}
                {recommendedAction?.requiresOnline && !navigator.onLine && <p role="status" className="mt-2 text-sm">{t('sync.healthModal.status.offline')}</p>}
                <p className="mt-3 text-sm opacity-80">{primaryIssue.knownSolution?.verificationKey ? t(primaryIssue.knownSolution.verificationKey) : t('recovery.center.genericVerificationDescription')}</p>
                {recommendedAction?.requiresSnapshot && <p className="mt-2 flex gap-2 text-xs opacity-80"><DatabaseBackup className="h-4 w-4 shrink-0" />{t('recovery.center.backupBeforeFix')}</p>}
                {remainingIssueCount > 0 && <p className="mt-3 text-sm font-semibold">{t('recovery.center.otherIssuesWaiting', {count: remainingIssueCount})}</p>}
              </div>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
          <span>{t('recovery.center.thisTerminal')}</span><span>{branchDisplayName}</span><span>{organizationDisplayName}</span>
        </div>
        <details className="rounded-2xl border border-slate-200 bg-white/70 dark:border-white/10 dark:bg-white/[0.04]">
          <summary className="min-h-[44px] cursor-pointer px-4 py-3 text-sm font-semibold">{t('recovery.center.advancedDetailsTitle')}</summary>
          <div className="space-y-4 border-t border-slate-200 p-4 dark:border-white/10">
            {primaryIssue && contactDevAction && contactDevAction.id !== recommendedAction?.id && <button type="button" onClick={() => handleActionClick(primaryIssue, contactDevAction)} disabled={diagnosticsStale || !!busyActionId} className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold disabled:opacity-50 dark:border-white/20"><LifeBuoy className="h-4 w-4" />{t(contactDevAction.labelKey)}</button>}
            {renderSection('recovery.center.needsAttentionTitle', 'recovery.center.needsAttentionSubtitle', blockingIssues, 'recovery.center.noBlockingIssues')}
            {renderSection('recovery.center.recoveringTitle', 'recovery.center.recoveringSubtitle', recoveringIssues, 'recovery.center.noRecoveringIssues')}
            <h4 className="text-sm font-bold">{t('recovery.center.recentActionsTitle')}</h4>
            <p className="text-xs">{t('recovery.center.recentActionsSubtitle')}</p>
            {resolvedActions.length === 0 ? <p className="text-sm">{t('recovery.center.noRecentActions')}</p> : resolvedActions.map(entry => (
              <div key={entry.id} className="rounded-xl border border-slate-200 p-3 text-sm dark:border-white/10">
                <div className="font-semibold">{t(`recovery.actions.${entry.actionId}.label`, {defaultValue: entry.actionId})}</div>
                <div className="mt-1">{entry.outcome ? t(`recovery.center.outcomes.${entry.outcome}`) : entry.success ? t('recovery.center.lastActionSucceeded') : t('recovery.center.actionNotVerified')}</div>
                <div className="mt-1 break-all text-xs opacity-70">{entry.recipeId || entry.issueCode} · {new Date(entry.timestamp).toLocaleString(i18n?.resolvedLanguage || i18n?.language)}</div>
              </div>
            ))}
          </div>
        </details>
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
