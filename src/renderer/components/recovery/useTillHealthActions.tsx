import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getBridge,
  type DiagnosticsTerminalContext,
  type RecoveryActionDescriptor,
  type RecoveryActionLogEntry,
  type RecoveryIssue,
  type RecoveryRouteTarget,
} from '../../../lib';
import { usePrivilegedActionConfirmation } from '../../hooks/usePrivilegedActionConfirmation';
import { getErrorMessage } from '../../utils/privileged-actions';
import { acquireRecoveryAction, buildRecoveryActionRequest, executeHealthRecoveryAction, recoveryFailureCode, verifiedSupportReceipt, healthActionChangesState, type HealthTargetOutcome } from '../../services/support/SupportRemedyRunner';

const dispatchRecoveryRoute = (target: RecoveryRouteTarget) => {
  window.dispatchEvent(
    new CustomEvent('pos:recovery-route', {
      detail: target,
    }),
  );
};

export interface TillHealthAttempt {
  issue: RecoveryIssue;
  actionId: string;
  state: 'working' | 'pending' | 'solved' | 'failed' | 'busy' | 'signIn' | 'shift' | 'pin' | 'permission' | 'grant' | 'parked';
  startedAt: number;
  verifiedAt?: string;
}

export function useTillHealthActions({
  recentActions, terminalContext, onRefresh, onNavigate, onActionResolved, onReport, diagnosticsStale,
}: {
  recentActions: RecoveryActionLogEntry[];
  terminalContext?: DiagnosticsTerminalContext | null;
  onRefresh: () => Promise<unknown>;
  onNavigate: () => void;
  onActionResolved: (entry: RecoveryActionLogEntry) => void;
  onReport: (report: Awaited<ReturnType<ReturnType<typeof getBridge>['diagnostics']['sendRemoteIncident']>>) => void;
  diagnosticsStale: boolean;
}) {
  const { t } = useTranslation();
  const bridge = getBridge();
  const { runWithPrivilegedConfirmation, confirmationModal, confirmationOpen } = usePrivilegedActionConfirmation();
  const actionInFlight = useRef(false);
  const staleDiagnostics = useRef(diagnosticsStale);
  staleDiagnostics.current = diagnosticsStale;
  const binding = [terminalContext?.organizationId, terminalContext?.branchId, terminalContext?.terminalId].join(':');
  const currentBinding = useRef(binding);
  currentBinding.current = binding;
  const [attempts, setAttempts] = useState<TillHealthAttempt[]>([]);
  const setAttempt = (id: string, next: TillHealthAttempt | null) => {
    if (currentBinding.current !== binding) return;
    setAttempts(current => [...current.filter(attempt => attempt.issue.id !== id), ...(next ? [next] : [])]);
  };
  const [busy, setBusy] = useState(false);
  const [confirmingAction, setConfirmingAction] = useState<{
    issue: RecoveryIssue;
    action: RecoveryActionDescriptor;
  } | null>(null);

  useEffect(() => {
    setAttempts([]);
    setConfirmingAction(null);
  }, [binding]);

  useEffect(() => {
    if (diagnosticsStale) return;
    setAttempts(current => {
      const next = current.map(attempt => {
        if (attempt.state !== 'pending' || !attempt.issue.orderId || attempt.issue.code !== 'customer_correction_refused') return attempt;
        const proof = recentActions.find(entry =>
          entry.actionId === attempt.actionId && entry.targetRefs?.orderId === attempt.issue.orderId &&
          entry.outcome === 'resolved' && entry.success && Date.parse(entry.timestamp) >= attempt.startedAt &&
          entry.targetRefs?.entityId === attempt.issue.params?.queueId,
        );
        return proof ? { ...attempt, state: 'solved' as const, verifiedAt: proof.timestamp } : attempt;
      });
      return next.some((attempt, index) => attempt !== current[index]) ? next : current;
    });
  }, [diagnosticsStale, recentActions]);

  const runAction = async (
    issue: RecoveryIssue,
    action: RecoveryActionDescriptor,
  ) => {
    if (actionInFlight.current || (diagnosticsStale && action.id !== 'contactDev')) { return; }
    const releaseRecovery = acquireRecoveryAction();
    if (!releaseRecovery) { return; }
    actionInFlight.current = true;
    setBusy(true);
    const startedAt = Date.now();
    const request = buildRecoveryActionRequest(issue, action);
    const correction = issue.code === 'customer_correction_refused';
    const attemptId = `${issue.id}:${action.id}:${startedAt}`;
    let snapshotPointId: string | null = null;
    let exportPath: string | null = null;
    let reportReceipt: { incidentId: string; notification: string | null } | undefined;
    let targetOutcomes: Array<{ id: string; outcome: HealthTargetOutcome }> | undefined;
    let outcome: RecoveryActionLogEntry['outcome'] = 'unknown';
    let pinRefusals = 0;
    const buildLogEntry = (
      success: boolean,
      message?: string | null,
      errorMessage?: string | null,
      id = attemptId,
    ): RecoveryActionLogEntry & Record<string, unknown> => ({
      id,
      attemptId,
      actionId: action.id,
      issueCode: issue.code,
      issueId: issue.id,
      entityType: issue.entityType,
      queueId: issue.queueId ?? null,
      noticeQueueId: issue.params?.sampleItemId ?? issue.params?.queueId ?? (issue.queueId == null ? null : `financial:${issue.queueId}`),
      success,
      outcome,
      timestamp: new Date(startedAt).toISOString(),
      targetOutcomes,
      actorAttribution: 'unavailable',
      terminalId: terminalContext?.terminalId ?? null,
      recipeId: action.recipeId ?? issue.knownSolution?.recipeId ?? null,
      recipeVersion: action.recipeVersion ?? issue.knownSolution?.version ?? null,
      snapshotPointId,
      exportPath,
      reportReceipt,
      message: message ?? null,
      errorMessage: errorMessage ?? null,
      actor: {
        staffId: null,
        staffName: null,
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
      id?: string,
    ) => {
      const entry = buildLogEntry(success, message, errorMessage, id);
      try {
        const persisted = await bridge.recovery.recordActionLog(entry);
        onActionResolved?.(persisted);
      } catch (logError) {
        console.warn('[RecoveryCenter] failed to persist recovery action log', logError);
        onActionResolved?.(entry);
      }
    };

    const working: TillHealthAttempt = { issue, actionId: action.id, state: 'working', startedAt };
    if (action.id !== 'contactDev') setAttempt(issue.id, working);
    const show = (state: TillHealthAttempt['state']) => setAttempt(issue.id, state === 'solved'
      ? { ...working, state, verifiedAt: new Date().toISOString() }
      : { ...working, state });
    try {
      if (action.id === 'contactDev') {
        const report = await bridge.diagnostics.sendRemoteIncident({
          healthView: { selectedIssue: { code: issue.code, id: issue.id, queueId: request.queueId ?? request.params?.sampleItemId } },
        });
        onReport(report);
        const received = verifiedSupportReceipt(report);
        if (received && report.incidentId) {
          reportReceipt = {
            incidentId: report.incidentId,
            notification: report.alertSent ? 'sent' : report.alertStatus ?? null,
          };
        }
        exportPath = report.localPrepared && report.path ? report.path : null;
        if (report.deliveryState === 'waiting') {
          outcome = 'pending';
          await persistLogEntry(false, t('tillHealth.report.pending'));
          return;
        }
        const key = received
          ? report.alertSent || report.alertStatus === 'sent' ? 'reportNotified' : 'reportStored'
          : report.localPrepared ? 'reportPrepared' : 'reportFailed';
        const message = t(`recovery.actionStatus.${key}`);
        await persistLogEntry(received, message, received ? null : report.error ?? 'INCIDENT_DELIVERY_UNVERIFIED');
        return;
      }

      const result = await executeHealthRecoveryAction({
        request, action, stale: () => staleDiagnostics.current,
        authorize: runWithPrivilegedConfirmation, t,
        onSnapshot: id => { snapshotPointId = id; },
        onPinRefused: async () => {
          outcome = 'failed';
          await persistLogEntry(false, null, 'AUTH_PIN_WRONG', `${attemptId}:pin:${++pinRefusals}`);
        },
      });

      const navigatesOnly = action.id === 'openOrderPaymentFix' || action.id === 'openConnectionSettings';
      const isInspection = action.id === 'validatePendingOrders';
      const changesState = healthActionChangesState(action);
      const verificationStatus = result?.verification?.status ?? null;
      const succeeded = result?.success === true && verificationStatus !== 'failed';
      const changedIds = result?.changedIds ?? [];
      const expectedRow = action.id === 'retryParityItem' ? request.params?.sampleItemId
        : correction ? request.params?.queueId ?? request.entityId
        : action.id === 'restoreLastKnownPrinterBrand' ? request.entityId : null;
      const verifiedChange = succeeded && verificationStatus === 'passed' && (
        changedIds.length > 0 && (expectedRow == null || changedIds.includes(String(expectedRow)))
      );
      const pendingVerification = succeeded && changesState && !verifiedChange;

      targetOutcomes = result?.targetOutcomes;
      if (targetOutcomes?.length || (result?.targetOutcome && !verifiedChange)) {
        const targets = targetOutcomes?.map(target => target.outcome) ?? [result.targetOutcome!];
        outcome = verifiedChange ? 'resolved' : targets.includes('unknown') ? 'unknown' : targets.includes('refused') ? 'failed' : 'pending';
        await persistLogEntry(verifiedChange, result?.message);
        show(verifiedChange ? 'solved' : outcome === 'failed' ? 'failed' : 'pending');
        await onRefresh();
        return;
      }
      if ((navigatesOnly || isInspection) && succeeded) {
        const route = result?.routeTarget || action.routeTarget;
        if (route) {
          dispatchRecoveryRoute(route);
          onNavigate();
        }
        setAttempt(issue.id, null);
        await persistLogEntry(false, result?.message);
        await onRefresh();
        return;
      }
      if (action.id === 'restoreLastKnownPrinterBrand' && verificationStatus === 'unknown') {
        outcome = 'unknown';
        await persistLogEntry(false, result?.message);
        show('pending');
      } else if (!succeeded) {
        outcome = 'failed';
        const code = recoveryFailureCode(result?.message);
        await persistLogEntry(false, null, result?.message ?? (correction ? 'REMEDY_VERIFICATION_FAILED' : null));
        show(code === 'PREEMPTED_BY_CRITICAL_OPERATION' ? 'busy' : 'failed');
      } else if (pendingVerification) {
        outcome = 'pending';
        await persistLogEntry(false, result?.message);
        show('pending');
      } else {
        outcome = verifiedChange ? 'resolved' : 'unknown';
        await persistLogEntry(true, result?.message);
        if (verifiedChange) show('solved');
        else setAttempt(issue.id, null);
      }

      const routeTarget = result?.routeTarget || action.routeTarget;
      if (verifiedChange && routeTarget) {
        dispatchRecoveryRoute(routeTarget);
        onNavigate?.();
      }

      await onRefresh();
    } catch (error) {
      outcome = 'failed';
      const code = recoveryFailureCode(error);
      if (action.id === 'contactDev') {
        const message = t('recovery.actionStatus.reportFailed');
        await persistLogEntry(false, message, 'INCIDENT_PREPARATION_FAILED');
        onReport({ success: false, error: 'INCIDENT_PREPARATION_FAILED' });
        return;
      }
      if (code === 'AUTH_CONFIRMATION_CANCELLED') {
        await persistLogEntry(false, null, code);
        setAttempt(issue.id, null);
        return;
      }
      const feedback: Partial<Record<string, TillHealthAttempt['state']>> = {
        PREEMPTED_BY_CRITICAL_OPERATION: 'busy',
        AUTH_SESSION_REQUIRED: 'signIn',
        AUTH_SESSION_EXPIRED: 'signIn',
        CONCURRENT_OPERATION: 'busy',
        NOTICE_DATABASE_BUSY: 'busy',
        AUTH_SHIFT_REQUIRED: 'shift',
        AUTH_PIN_WRONG: 'pin',
        AUTH_PERMISSION_REQUIRED: 'permission',
        UNAUTHORIZED: 'permission',
        AUTH_GRANT_EXPIRED: 'grant',
        PARITY_ROWS_PARKED: 'parked',
      };
      const detail = error instanceof Error ? error.message : error;
      const reason = code === 'PREEMPTED_BY_CRITICAL_OPERATION' && typeof detail === 'string'
        && /^PREEMPTED_BY_CRITICAL_OPERATION: [A-Z_]+$/.test(detail) ? detail : code;
      await persistLogEntry(false, getErrorMessage(error, code), reason);
      show(feedback[code] ?? 'failed');
    } finally {
      releaseRecovery();
      actionInFlight.current = false;
      setBusy(false);
      setConfirmingAction(null);
    }
  };

  const handleActionClick = (
    issue: RecoveryIssue,
    action: RecoveryActionDescriptor,
  ) => {
    if ((diagnosticsStale && action.id !== 'contactDev') || actionInFlight.current) return;
    if (action.confirmationRequired) {
      setConfirmingAction({ issue, action });
      return;
    }
    void runAction(issue, action);
  };

  const handleConfirmDestructiveAction = () => {
    if (!confirmingAction) { return; }
    const pending = confirmingAction;
    setConfirmingAction(null);
    void runAction(pending.issue, pending.action);
  };

  return { attempts, busy, dismissAttempt: (issueId: string) => setAttempt(issueId, null),
    confirmationModal: confirmationOpen ? confirmationModal : null, confirmingAction, setConfirmingAction,
    handleActionClick, handleConfirmDestructiveAction };
}
