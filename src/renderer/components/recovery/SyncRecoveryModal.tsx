import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FolderOpen,
  RefreshCw,
  ShieldAlert,
  Wrench,
} from 'lucide-react';

import {
  getBridge,
  type DiagnosticsCredentialState,
  type DiagnosticsLastParitySync,
  type DiagnosticsSystemHealth,
  type RecoveryActionRequest,
} from '../../../lib';
import type { SyncBlockerDetail, SyncFinancialQueueItem } from '../../../lib/ipc-contracts';
import { runParitySyncCycle } from '../../services/ParitySyncCoordinator';

export interface SyncRecoveryOpenContext {
  systemHealth?: DiagnosticsSystemHealth | null;
  lastParitySync?: DiagnosticsLastParitySync | null;
}

interface SyncRecoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialContext?: SyncRecoveryOpenContext | null;
  onOpenConnectionSettings?: () => void;
  onOpenSnapshots?: () => void;
}

type ActionTone = 'success' | 'error' | 'info';

interface ActionFeedback {
  tone: ActionTone;
  message: string;
}

const ENTITY_LABEL_KEYS: Record<string, string> = {
  order: 'sync.entityTypes.order',
  payment: 'sync.entityTypes.payment',
  payments: 'sync.entityTypes.payment',
  payment_adjustment: 'sync.entityTypes.paymentAdjustment',
  payment_adjustments: 'sync.entityTypes.paymentAdjustment',
  shift: 'sync.entityTypes.shift',
  z_report: 'sync.entityTypes.zReport',
  shift_expense: 'sync.entityTypes.shiftExpense',
  shift_expenses: 'sync.entityTypes.shiftExpense',
  driver_earning: 'sync.entityTypes.driverEarning',
  driver_earnings: 'sync.entityTypes.driverEarning',
  staff_payment: 'sync.entityTypes.staffPayment',
  staff_payments: 'sync.entityTypes.staffPayment',
};

const PAYMENT_ENTITY_TYPES = new Set(['payment', 'payments', 'payment_adjustment', 'payment_adjustments']);
const STAFF_ENTITY_TYPES = new Set(['staff_payment', 'staff_payments', 'shift_expense', 'shift_expenses']);
const DRIVER_ENTITY_TYPES = new Set(['driver_earning', 'driver_earnings']);
// Add new entity types here whenever a new guided unblock flow is implemented.
const GUIDED_RECOVERY_ENTITY_TYPES = new Set([
  'order',
  'payment',
  'payments',
  'payment_adjustment',
  'payment_adjustments',
  'shift',
  'shift_expense',
  'shift_expenses',
  'staff_payment',
  'staff_payments',
  'driver_earning',
  'driver_earnings',
]);

const summarizeId = (value?: string | null) => {
  if (!value) return '—';
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
};

const formatDateTime = (value?: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Unknown error';

const isPaymentEntity = (entityType: string) => PAYMENT_ENTITY_TYPES.has(entityType);
const isStaffEntity = (entityType: string) =>
  STAFF_ENTITY_TYPES.has(entityType) || DRIVER_ENTITY_TYPES.has(entityType);
const hasGuidedRecovery = (entityType: string) => GUIDED_RECOVERY_ENTITY_TYPES.has(entityType);

const isRepairablePaymentItem = (item: SyncFinancialQueueItem) => {
  if (!isPaymentEntity(item.entityType)) {
    return false;
  }

  const normalizedError = typeof item.lastError === 'string' ? item.lastError.toLowerCase() : '';
  return (
    normalizedError.includes('order not found') ||
    normalizedError.includes('payment does not belong to the provided order')
  );
};

const buildRetryRequest = (blocker: SyncBlockerDetail): RecoveryActionRequest => ({
  actionId: 'retrySync',
  issueId: `sync-blocker-${blocker.queueId}`,
  issueCode: blocker.blockerReason || 'sync_blocker',
  queueId: blocker.queueId,
  entityType: blocker.entityType,
  entityId: blocker.entityId,
  orderId: blocker.orderId ?? null,
  orderNumber: blocker.orderNumber ?? null,
  paymentId: blocker.paymentId ?? null,
  adjustmentId: blocker.adjustmentId ?? null,
  zReportId: null,
  shiftId: null,
  reportDate: null,
});

const SummaryTile: React.FC<{
  label: string;
  value: string | number;
  detail: string;
  accentClassName?: string;
}> = ({ label, value, detail, accentClassName = 'text-slate-900 dark:text-white' }) => (
  <div className="rounded-[22px] border border-slate-200/80 bg-slate-50/90 px-4 py-4 dark:border-white/10 dark:bg-black/20">
    <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
      {label}
    </div>
    <div className={`mt-2 text-2xl font-black tracking-tight ${accentClassName}`}>{value}</div>
    <div className="mt-1 text-xs text-slate-600 dark:text-slate-300/80">{detail}</div>
  </div>
);

const IssueCard: React.FC<{
  title: string;
  subtitle: string;
  tone?: 'danger' | 'warning' | 'neutral' | 'success';
  children: React.ReactNode;
}> = ({ title, subtitle, tone = 'neutral', children }) => {
  const toneClasses =
    tone === 'danger'
      ? 'border-red-200/90 bg-red-50/90 dark:border-red-400/30 dark:bg-red-500/10'
      : tone === 'warning'
        ? 'border-amber-200/90 bg-amber-50/90 dark:border-amber-400/30 dark:bg-amber-500/10'
        : tone === 'success'
          ? 'border-emerald-200/90 bg-emerald-50/90 dark:border-emerald-400/30 dark:bg-emerald-500/10'
          : 'border-slate-200/80 bg-slate-50/90 dark:border-white/10 dark:bg-black/20';

  return (
    <div className={`rounded-[24px] border p-4 ${toneClasses}`}>
      <div>
        <div className="text-sm font-bold text-slate-900 dark:text-white">{title}</div>
        <div className="mt-1 text-xs text-slate-600 dark:text-slate-300/80">{subtitle}</div>
      </div>
      <div className="mt-4 space-y-3">{children}</div>
    </div>
  );
};

const QueueRow: React.FC<{
  title: string;
  detail: string;
  meta: string;
  buttonLabel: string;
  onClick: () => void;
  busy?: boolean;
}> = ({ title, detail, meta, buttonLabel, onClick, busy = false }) => (
  <div className="rounded-[18px] border border-white/60 bg-white/80 px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-900 dark:text-white">{title}</div>
        <div className="mt-1 text-sm text-slate-700 dark:text-slate-200/90">{detail}</div>
        <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">{meta}</div>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-2xl border border-slate-200/90 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.08]"
      >
        {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
        {buttonLabel}
      </button>
    </div>
  </div>
);

export const SyncRecoveryModal: React.FC<SyncRecoveryModalProps> = ({
  isOpen,
  onClose,
  initialContext,
  onOpenConnectionSettings,
  onOpenSnapshots,
}) => {
  const { t } = useTranslation();
  const bridge = getBridge();
  const [systemHealth, setSystemHealth] = useState<DiagnosticsSystemHealth | null>(
    initialContext?.systemHealth ?? null,
  );
  const [lastParitySync, setLastParitySync] = useState<DiagnosticsLastParitySync | null>(
    initialContext?.lastParitySync ?? null,
  );
  const [failedFinancialItems, setFailedFinancialItems] = useState<SyncFinancialQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<ActionFeedback | null>(null);

  const loadRecoveryState = async () => {
    setLoading(true);
    try {
      const [nextSystemHealth, nextFailedFinancialItems] = await Promise.all([
        bridge.diagnostics.getSystemHealth(),
        bridge.sync.getFailedFinancialItems(200),
      ]);
      setSystemHealth(nextSystemHealth);
      setLastParitySync(nextSystemHealth.lastParitySync ?? initialContext?.lastParitySync ?? null);
      setFailedFinancialItems(Array.isArray(nextFailedFinancialItems) ? nextFailedFinancialItems : []);
    } catch (error) {
      console.error('[SyncRecoveryModal] Failed to load recovery state:', error);
      const message = getErrorMessage(error);
      setLastAction({ tone: 'error', message });
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setSystemHealth(initialContext?.systemHealth ?? null);
    setLastParitySync(initialContext?.lastParitySync ?? null);
    setLastAction(null);
    void loadRecoveryState();
  }, [initialContext, isOpen]);

  const financialQueueStatus = systemHealth?.financialQueueStatus ?? null;
  const credentialState: DiagnosticsCredentialState | null =
    lastParitySync?.credentialState ?? systemHealth?.credentialState ?? null;
  const missingCredentials = useMemo(() => {
    if (!credentialState) return [] as string[];

    const missing: string[] = [];
    if (!credentialState.hasAdminUrl) {
      missing.push(t('sync.dashboard.missingAdminUrl', { defaultValue: 'Admin URL' }));
    }
    if (!credentialState.hasApiKey) {
      missing.push(t('sync.dashboard.missingApiKey', { defaultValue: 'POS API key' }));
    }
    return missing;
  }, [credentialState, t]);

  const invalidOrders = systemHealth?.invalidOrders?.details ?? [];
  const syncBlockers = systemHealth?.syncBlockerDetails ?? [];
  const orderBlockers = syncBlockers.filter((item) => item.entityType === 'order');
  const paymentBlockers = syncBlockers.filter((item) => isPaymentEntity(item.entityType));
  const staffBlockers = syncBlockers.filter(
    (item) => isStaffEntity(item.entityType) || item.entityType === 'shift',
  );
  const paymentFinancialItems = failedFinancialItems.filter((item) => isPaymentEntity(item.entityType));
  const staffFinancialItems = failedFinancialItems.filter((item) => isStaffEntity(item.entityType));
  const repairablePaymentItems = paymentFinancialItems.filter(isRepairablePaymentItem);
  const unhandledBlockers = syncBlockers.filter(
    (item) => !hasGuidedRecovery(item.entityType),
  );

  const parityRemaining =
    lastParitySync?.remaining ?? systemHealth?.parityQueueStatus?.total ?? 0;
  const parityFailed = lastParitySync?.status === 'failed';
  const parityNeedsAttention = parityRemaining > 0 || parityFailed || missingCredentials.length > 0;

  const orderIssueCount = invalidOrders.length + orderBlockers.length;
  const paymentIssueCount =
    paymentBlockers.length +
    paymentFinancialItems.length +
    (financialQueueStatus?.payments?.failed ?? 0);
  const staffIssueCount =
    staffBlockers.length +
    staffFinancialItems.length +
    (financialQueueStatus?.driver_earnings?.failed ?? 0) +
    (financialQueueStatus?.staff_payments?.failed ?? 0) +
    (financialQueueStatus?.shift_expenses?.failed ?? 0);

  const hasAnyIssues =
    missingCredentials.length > 0 ||
    parityNeedsAttention ||
    orderIssueCount > 0 ||
    paymentIssueCount > 0 ||
    staffIssueCount > 0 ||
    (financialQueueStatus?.driver_earnings?.pending ?? 0) > 0 ||
    (financialQueueStatus?.staff_payments?.pending ?? 0) > 0 ||
    (financialQueueStatus?.shift_expenses?.pending ?? 0) > 0;

  const handleRefresh = async () => {
    await loadRecoveryState();
    toast.success(t('sync.recoveryCenter.refreshSuccess', { defaultValue: 'Recovery status refreshed' }));
  };

  const handleValidateOrders = async () => {
    setActionKey('validate-orders');
    try {
      const result = await bridge.sync.validatePendingOrders();
      setSystemHealth((current) =>
        current
          ? {
              ...current,
              invalidOrders: {
                count: result.invalid,
                details: result.invalid_orders,
              },
            }
          : current,
      );
      const message = t('sync.recoveryCenter.validateOrdersSuccess', {
        defaultValue: 'Validation finished: {{invalid}} invalid / {{valid}} valid.',
        invalid: result.invalid,
        valid: result.valid,
      });
      setLastAction({ tone: 'info', message });
      toast.success(message);
      await loadRecoveryState();
    } catch (error) {
      const message = getErrorMessage(error);
      setLastAction({ tone: 'error', message });
      toast.error(message);
    } finally {
      setActionKey(null);
    }
  };

  const handleRemoveInvalidOrders = async () => {
    if (invalidOrders.length === 0) return;

    setActionKey('remove-invalid-orders');
    try {
      const result = await bridge.sync.removeInvalidOrders(
        invalidOrders.map((order) => order.order_id),
      );
      const message = t('sync.recoveryCenter.removeInvalidOrdersSuccess', {
        defaultValue: 'Removed {{count}} invalid orders.',
        count: result.removed ?? invalidOrders.length,
      });
      setLastAction({ tone: 'success', message });
      toast.success(message);
      await loadRecoveryState();
    } catch (error) {
      const message = getErrorMessage(error);
      setLastAction({ tone: 'error', message });
      toast.error(message);
    } finally {
      setActionKey(null);
    }
  };

  const handleRetrySyncBlocker = async (blocker: SyncBlockerDetail) => {
    setActionKey(`retry-blocker-${blocker.queueId}`);
    try {
      await bridge.recovery.executeAction(buildRetryRequest(blocker));
      const message = t('sync.recoveryCenter.retryQueueRowSuccess', {
        defaultValue: 'Queue row scheduled for retry.',
      });
      setLastAction({ tone: 'success', message });
      toast.success(message);
      await loadRecoveryState();
    } catch (error) {
      const message = getErrorMessage(error);
      setLastAction({ tone: 'error', message });
      toast.error(message);
    } finally {
      setActionKey(null);
    }
  };

  const handleRetryFinancialItem = async (item: SyncFinancialQueueItem) => {
    setActionKey(`retry-financial-${item.queueId}`);
    try {
      await bridge.sync.retryFinancialItem(item.queueId);
      const message = t('sync.recoveryCenter.retryQueueRowSuccess', {
        defaultValue: 'Queue row scheduled for retry.',
      });
      setLastAction({ tone: 'success', message });
      toast.success(message);
      await loadRecoveryState();
    } catch (error) {
      const message = getErrorMessage(error);
      setLastAction({ tone: 'error', message });
      toast.error(message);
    } finally {
      setActionKey(null);
    }
  };

  const handleRetryAllFailedFinancial = async () => {
    setActionKey('retry-all-financial');
    try {
      await bridge.sync.retryAllFailedFinancial();
      const message = t('sync.recoveryCenter.retryFinancialAllSuccess', {
        defaultValue: 'Failed financial sync rows scheduled for retry.',
      });
      setLastAction({ tone: 'success', message });
      toast.success(message);
      await loadRecoveryState();
    } catch (error) {
      const message = getErrorMessage(error);
      setLastAction({ tone: 'error', message });
      toast.error(message);
    } finally {
      setActionKey(null);
    }
  };

  const handleRepairPayments = async () => {
    setActionKey('repair-payments');
    try {
      await bridge.sync.requeueOrphanedFinancial();
      const message = t('sync.recoveryCenter.repairPaymentsSuccess', {
        defaultValue: 'Payment repair was scheduled successfully.',
      });
      setLastAction({ tone: 'success', message });
      toast.success(message);
      await loadRecoveryState();
    } catch (error) {
      const message = getErrorMessage(error);
      setLastAction({ tone: 'error', message });
      toast.error(message);
    } finally {
      setActionKey(null);
    }
  };

  const handleRunParitySync = async () => {
    setActionKey('run-parity-sync');
    try {
      const result = await runParitySyncCycle({ trigger: 'manual' });
      const nextParitySync = result.paritySyncStatus;
      setLastParitySync(nextParitySync);

      if (nextParitySync.status === 'failed') {
        throw new Error(nextParitySync.error || nextParitySync.reason || 'Parity sync failed');
      }

      if (nextParitySync.status === 'skipped_missing_credentials') {
        throw new Error(
          nextParitySync.reason ||
            t('sync.dashboard.paritySkippedDetail', {
              defaultValue:
                'Parity sync could not start because terminal credentials are incomplete.',
            }),
        );
      }

      const message = t('sync.dashboard.parityCompletedDetail', {
        defaultValue: 'Processed {{processed}} item(s); {{remaining}} remaining.',
        processed: nextParitySync.processed,
        remaining: nextParitySync.remaining,
      });
      setLastAction({ tone: 'success', message });
      toast.success(message);
      await loadRecoveryState();
    } catch (error) {
      const message = getErrorMessage(error);
      setLastAction({ tone: 'error', message });
      toast.error(message);
    } finally {
      setActionKey(null);
    }
  };

  const handleOpenConnectionSettings = () => {
    onClose();
    onOpenConnectionSettings?.();
  };

  const handleOpenSnapshots = () => {
    onClose();
    onOpenSnapshots?.();
  };

  const headerSubtitle =
    lastParitySync?.status === 'failed'
      ? lastParitySync.error || lastParitySync.reason
      : t('sync.recoveryCenter.subtitle', {
          defaultValue:
            'Uses the same sync-health diagnostics and adds guided repair actions for the visible problems.',
        });

  if (!isOpen || typeof document === 'undefined') {
    return null;
  }

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[10040] px-4 py-6 sm:px-6 sm:py-8" style={{ isolation: 'isolate' }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />

      <div className="relative z-[10050] flex h-full items-center justify-center">
        <div
          className="liquid-glass-modal-shell flex w-full flex-col overflow-hidden rounded-[32px]"
          style={{ width: 'min(1040px, calc(100vw - 32px))', maxHeight: '86vh' }}
        >
          <div className="flex items-start justify-between gap-4 border-b liquid-glass-modal-border px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                {t('sync.health.label', { defaultValue: 'Sync health' })}
              </div>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                {t('sync.recoveryCenter.title', { defaultValue: 'Recovery Center' })}
              </h2>
              <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-slate-300/80">
                {headerSubtitle}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleRefresh()}
                disabled={loading}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200/90 bg-white/90 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:hover:bg-white/[0.08]"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                {t('common.actions.refresh', { defaultValue: 'Refresh' })}
              </button>
              {onOpenSnapshots ? (
                <button
                  type="button"
                  onClick={handleOpenSnapshots}
                  className="inline-flex items-center gap-2 rounded-2xl border border-slate-200/90 bg-white/90 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:hover:bg-white/[0.08]"
                >
                  <FolderOpen className="h-4 w-4" />
                  {t('sync.recoveryCenter.openSnapshots', {
                    defaultValue: 'Open snapshots and restore',
                  })}
                </button>
              ) : null}
              <button
                type="button"
                onClick={onClose}
                className="liquid-glass-modal-button min-h-0 min-w-0 rounded-xl p-2"
                aria-label={t('common.actions.close', { defaultValue: 'Close' })}
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>

          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
            <div className="rounded-[22px] border border-sky-200/90 bg-sky-50/90 px-4 py-4 text-sm text-sky-800 dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-100">
              {t('sync.recoveryCenter.contextNote', {
                defaultValue:
                  'This recovery view stays in sync with the same blockers shown by the sync explanation panel.',
              })}
            </div>
            {lastAction ? (
              <div
                className={`rounded-[22px] border px-4 py-4 text-sm ${
                  lastAction.tone === 'error'
                    ? 'border-red-200/90 bg-red-50/90 text-red-800 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-100'
                    : lastAction.tone === 'info'
                      ? 'border-sky-200/90 bg-sky-50/90 text-sky-800 dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-100'
                      : 'border-emerald-200/90 bg-emerald-50/90 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-100'
                }`}
              >
                <div className="font-semibold">
                  {t('sync.recoveryCenter.lastAction', { defaultValue: 'Last action' })}
                </div>
                <div className="mt-1">{lastAction.message}</div>
              </div>
            ) : null}

            {loading && !systemHealth ? (
              <div className="flex h-56 items-center justify-center">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-blue-500/30 border-t-blue-500" />
              </div>
            ) : (
              <>
                <div className="grid gap-3 xl:grid-cols-4">
                  <SummaryTile
                    label={t('sync.recoveryCenter.ordersSection', { defaultValue: 'Orders' })}
                    value={orderIssueCount}
                    detail={t('sync.system.invalidOrdersDesc', {
                      defaultValue: 'Pending orders with invalid or blocked sync state.',
                    })}
                    accentClassName={
                      orderIssueCount > 0
                        ? 'text-red-700 dark:text-red-300'
                        : 'text-emerald-700 dark:text-emerald-300'
                    }
                  />
                  <SummaryTile
                    label={t('sync.recoveryCenter.paymentsSection', { defaultValue: 'Payments' })}
                    value={paymentIssueCount}
                    detail={t('sync.financial.failedGroupDesc', {
                      defaultValue: 'Payment sync rows that failed or need repair.',
                    })}
                    accentClassName={
                      paymentIssueCount > 0
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-emerald-700 dark:text-emerald-300'
                    }
                  />
                  <SummaryTile
                    label={t('sync.recoveryCenter.staffSection', { defaultValue: 'Staff and drivers' })}
                    value={staffIssueCount}
                    detail={t('sync.dashboard.financialSummarySubtitle', {
                      defaultValue:
                        'Pending driver earnings, staff payments, and expenses waiting to sync from this terminal.',
                    })}
                    accentClassName={
                      staffIssueCount > 0
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-emerald-700 dark:text-emerald-300'
                    }
                  />
                  <SummaryTile
                    label={t('sync.dashboard.parityProcessorTitle', { defaultValue: 'Parity processor' })}
                    value={parityRemaining}
                    detail={
                      missingCredentials.length > 0
                        ? t('sync.dashboard.parityCredentialsMissingDetail', {
                            defaultValue:
                              '{{items}} must be configured before the parity queue can drain.',
                            items: missingCredentials.join(', '),
                          })
                        : t('sync.dashboard.parityCompletedDetail', {
                            defaultValue: 'Processed {{processed}} item(s); {{remaining}} remaining.',
                            processed: lastParitySync?.processed ?? 0,
                            remaining: parityRemaining,
                          })
                    }
                    accentClassName={
                      parityNeedsAttention
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-emerald-700 dark:text-emerald-300'
                    }
                  />
                </div>

                {!hasAnyIssues ? (
                  <IssueCard
                    title={t('sync.dashboard.allClear', { defaultValue: 'All clear' })}
                    subtitle={t('sync.recoveryCenter.noIssues', {
                      defaultValue: 'No actionable recovery issues are currently visible.',
                    })}
                    tone="success"
                  >
                    <div className="flex items-center gap-3 text-sm text-emerald-800 dark:text-emerald-100">
                      <CheckCircle2 className="h-5 w-5" />
                      <span>
                        {t('sync.health.healthyDetail', {
                          defaultValue: 'No local sync backlog or failures are currently visible.',
                        })}
                      </span>
                    </div>
                  </IssueCard>
                ) : null}

                <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="space-y-5">
                    {missingCredentials.length > 0 ? (
                      <IssueCard
                        title={t('sync.recoveryCenter.credentialsTitle', {
                          defaultValue: 'Credentials need attention',
                        })}
                        subtitle={t('sync.recoveryCenter.credentialsSubtitle', {
                          defaultValue:
                            'Parity sync cannot drain until terminal credentials are complete.',
                        })}
                        tone="danger"
                      >
                        <div className="flex items-start gap-3 rounded-[18px] border border-red-200/90 bg-white/80 px-4 py-3 text-sm text-red-800 dark:border-red-400/30 dark:bg-white/[0.04] dark:text-red-100">
                          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
                          <div>
                            <div className="font-semibold">{missingCredentials.join(', ')}</div>
                            <div className="mt-1 text-xs text-red-700/90 dark:text-red-100/80">
                              {t('sync.dashboard.parityCredentialsMissingDetail', {
                                defaultValue:
                                  '{{items}} must be configured before the parity queue can drain.',
                                items: missingCredentials.join(', '),
                              })}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={handleOpenConnectionSettings}
                            className="inline-flex items-center gap-2 rounded-2xl border border-red-300/80 bg-white px-4 py-2.5 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-400/30 dark:bg-transparent dark:text-red-100 dark:hover:bg-red-500/10"
                          >
                            <Database className="h-4 w-4" />
                            {t('sync.recoveryCenter.openConnectionSettings', {
                              defaultValue: 'Open connection settings',
                            })}
                          </button>
                        </div>
                      </IssueCard>
                    ) : null}
                    {(orderIssueCount > 0 || invalidOrders.length > 0 || orderBlockers.length > 0) && (
                      <IssueCard
                        title={t('sync.recoveryCenter.ordersSection', { defaultValue: 'Orders' })}
                        subtitle={t('sync.system.invalidOrdersDesc', {
                          defaultValue: 'Some pending orders reference menu data that is no longer valid.',
                        })}
                        tone={invalidOrders.length > 0 ? 'danger' : 'warning'}
                      >
                        {invalidOrders.length > 0 ? (
                          <>
                            <div className="rounded-[18px] border border-white/60 bg-white/80 px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
                              <div className="text-sm font-semibold text-slate-900 dark:text-white">
                                {t('sync.system.invalidCount', {
                                  count: invalidOrders.length,
                                  defaultValue: '{{count}} invalid',
                                })}
                              </div>
                              <div className="mt-2 space-y-2">
                                {invalidOrders.slice(0, 5).map((order) => (
                                  <div
                                    key={order.order_id}
                                    className="flex items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-300/80"
                                  >
                                    <span className="font-mono text-slate-800 dark:text-slate-100">
                                      {summarizeId(order.order_id)}
                                    </span>
                                    <span>
                                      {order.invalid_menu_items.length}{' '}
                                      {t('sync.system.items', { defaultValue: 'items' })}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => void handleValidateOrders()}
                                disabled={actionKey === 'validate-orders'}
                                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200/90 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.08]"
                              >
                                <RefreshCw
                                  className={`h-4 w-4 ${actionKey === 'validate-orders' ? 'animate-spin' : ''}`}
                                />
                                {actionKey === 'validate-orders'
                                  ? t('sync.recoveryCenter.validatingOrders', {
                                      defaultValue: 'Validating pending orders...',
                                    })
                                  : t('sync.recoveryCenter.validateOrders', {
                                      defaultValue: 'Validate pending orders',
                                    })}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleRemoveInvalidOrders()}
                                disabled={actionKey === 'remove-invalid-orders'}
                                className="inline-flex items-center gap-2 rounded-2xl border border-red-300/80 bg-white px-4 py-2.5 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-400/30 dark:bg-transparent dark:text-red-100 dark:hover:bg-red-500/10"
                              >
                                {actionKey === 'remove-invalid-orders' ? (
                                  <RefreshCw className="h-4 w-4 animate-spin" />
                                ) : (
                                  <AlertTriangle className="h-4 w-4" />
                                )}
                                {t('sync.system.removeInvalidOrders', {
                                  defaultValue: 'Remove Invalid Orders',
                                })}
                              </button>
                            </div>
                          </>
                        ) : null}

                        {orderBlockers.slice(0, 5).map((blocker) => (
                          <QueueRow
                            key={`order-blocker-${blocker.queueId}`}
                            title={blocker.orderNumber || summarizeId(blocker.orderId || blocker.entityId)}
                            detail={blocker.blockerReason || blocker.lastError || blocker.entityId}
                            meta={`${t('sync.blocker.status', { defaultValue: 'Status' })}: ${blocker.queueStatus}`}
                            buttonLabel={t('sync.recoveryCenter.retryQueueRow', {
                              defaultValue: 'Retry queue row',
                            })}
                            busy={actionKey === `retry-blocker-${blocker.queueId}`}
                            onClick={() => void handleRetrySyncBlocker(blocker)}
                          />
                        ))}
                      </IssueCard>
                    )}
                  </div>

                  <div className="space-y-5">
                    {(paymentIssueCount > 0 ||
                      (financialQueueStatus?.payments?.pending ?? 0) > 0 ||
                      (financialQueueStatus?.payments?.failed ?? 0) > 0) && (
                      <IssueCard
                        title={t('sync.recoveryCenter.paymentsSection', { defaultValue: 'Payments' })}
                        subtitle={t('sync.financial.failedGroupDesc', {
                          defaultValue: 'These items stopped syncing and need intervention.',
                        })}
                        tone={paymentIssueCount > 0 ? 'warning' : 'neutral'}
                      >
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="rounded-[18px] border border-white/60 bg-white/80 px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                              {t('sync.labels.pending', { defaultValue: 'Pending' })}
                            </div>
                            <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
                              {financialQueueStatus?.payments?.pending ?? 0}
                            </div>
                          </div>
                          <div className="rounded-[18px] border border-white/60 bg-white/80 px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                              {t('sync.financial.failed', { defaultValue: 'Failed' })}
                            </div>
                            <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
                              {financialQueueStatus?.payments?.failed ?? paymentFinancialItems.length}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void handleRunParitySync()}
                            disabled={actionKey === 'run-parity-sync'}
                            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200/90 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.08]"
                          >
                            <RefreshCw
                              className={`h-4 w-4 ${actionKey === 'run-parity-sync' ? 'animate-spin' : ''}`}
                            />
                            {actionKey === 'run-parity-sync'
                              ? t('sync.recoveryCenter.runningParitySync', {
                                  defaultValue: 'Running sync...',
                                })
                              : t('sync.recoveryCenter.forceParitySync', {
                                  defaultValue: 'Run sync now',
                                })}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRetryAllFailedFinancial()}
                            disabled={actionKey === 'retry-all-financial'}
                            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200/90 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.08]"
                          >
                            {actionKey === 'retry-all-financial' ? (
                              <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : (
                              <Wrench className="h-4 w-4" />
                            )}
                            {t('sync.financial.retryAll', { defaultValue: 'Retry All' })}
                          </button>
                          {repairablePaymentItems.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => void handleRepairPayments()}
                              disabled={actionKey === 'repair-payments'}
                              className="inline-flex items-center gap-2 rounded-2xl border border-amber-300/80 bg-white px-4 py-2.5 text-sm font-semibold text-amber-700 transition-colors hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-400/30 dark:bg-transparent dark:text-amber-100 dark:hover:bg-amber-500/10"
                            >
                              {actionKey === 'repair-payments' ? (
                                <RefreshCw className="h-4 w-4 animate-spin" />
                              ) : (
                                <ShieldAlert className="h-4 w-4" />
                              )}
                              {t('sync.financial.repairOrphanedAdjustments', {
                                defaultValue: 'Repair orphaned adjustments',
                              })}
                            </button>
                          ) : null}
                        </div>
                        {paymentBlockers.slice(0, 3).map((blocker) => (
                          <QueueRow
                            key={`payment-blocker-${blocker.queueId}`}
                            title={
                              blocker.orderNumber ||
                              summarizeId(blocker.paymentId || blocker.adjustmentId || blocker.entityId)
                            }
                            detail={blocker.blockerReason || blocker.lastError || blocker.entityId}
                            meta={`${t('sync.blocker.status', { defaultValue: 'Status' })}: ${blocker.queueStatus}`}
                            buttonLabel={t('sync.recoveryCenter.retryQueueRow', {
                              defaultValue: 'Retry queue row',
                            })}
                            busy={actionKey === `retry-blocker-${blocker.queueId}`}
                            onClick={() => void handleRetrySyncBlocker(blocker)}
                          />
                        ))}
                        {paymentFinancialItems.slice(0, 5).map((item) => (
                          <QueueRow
                            key={`payment-financial-${item.queueId}`}
                            title={t(ENTITY_LABEL_KEYS[item.entityType] || '', {
                              defaultValue: item.entityType,
                            })}
                            detail={item.lastError || summarizeId(item.entityId)}
                            meta={`${formatDateTime(item.createdAt)} • ${t('sync.financial.attempts', {
                              defaultValue: 'Attempts',
                            })}: ${item.retryCount}`}
                            buttonLabel={t('sync.recoveryCenter.retryQueueRow', {
                              defaultValue: 'Retry queue row',
                            })}
                            busy={actionKey === `retry-financial-${item.queueId}`}
                            onClick={() => void handleRetryFinancialItem(item)}
                          />
                        ))}
                      </IssueCard>
                    )}

                    {(staffIssueCount > 0 ||
                      (financialQueueStatus?.driver_earnings?.pending ?? 0) > 0 ||
                      (financialQueueStatus?.staff_payments?.pending ?? 0) > 0 ||
                      (financialQueueStatus?.shift_expenses?.pending ?? 0) > 0) && (
                      <IssueCard
                        title={t('sync.recoveryCenter.staffSection', {
                          defaultValue: 'Staff and drivers',
                        })}
                        subtitle={t('sync.dashboard.financialSummarySubtitle', {
                          defaultValue:
                            'Pending driver earnings, staff payments, and expenses waiting to sync from this terminal.',
                        })}
                        tone={staffIssueCount > 0 ? 'warning' : 'neutral'}
                      >
                        <div className="grid gap-3 sm:grid-cols-3">
                          <div className="rounded-[18px] border border-white/60 bg-white/80 px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                              {t('sync.entityTypes.driverEarning', { defaultValue: 'Driver Earning' })}
                            </div>
                            <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
                              {(financialQueueStatus?.driver_earnings?.pending ?? 0) +
                                (financialQueueStatus?.driver_earnings?.failed ?? 0)}
                            </div>
                          </div>
                          <div className="rounded-[18px] border border-white/60 bg-white/80 px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                              {t('sync.entityTypes.staffPayment', { defaultValue: 'Staff Payment' })}
                            </div>
                            <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
                              {(financialQueueStatus?.staff_payments?.pending ?? 0) +
                                (financialQueueStatus?.staff_payments?.failed ?? 0)}
                            </div>
                          </div>
                          <div className="rounded-[18px] border border-white/60 bg-white/80 px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                              {t('sync.entityTypes.shiftExpense', { defaultValue: 'Shift Expense' })}
                            </div>
                            <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
                              {(financialQueueStatus?.shift_expenses?.pending ?? 0) +
                                (financialQueueStatus?.shift_expenses?.failed ?? 0)}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void handleRunParitySync()}
                            disabled={actionKey === 'run-parity-sync'}
                            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200/90 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.08]"
                          >
                            <RefreshCw
                              className={`h-4 w-4 ${actionKey === 'run-parity-sync' ? 'animate-spin' : ''}`}
                            />
                            {actionKey === 'run-parity-sync'
                              ? t('sync.recoveryCenter.runningParitySync', {
                                  defaultValue: 'Running sync...',
                                })
                              : t('sync.recoveryCenter.forceParitySync', {
                                  defaultValue: 'Run sync now',
                                })}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRetryAllFailedFinancial()}
                            disabled={actionKey === 'retry-all-financial'}
                            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200/90 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.08]"
                          >
                            {actionKey === 'retry-all-financial' ? (
                              <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : (
                              <Wrench className="h-4 w-4" />
                            )}
                            {t('sync.financial.retryAll', { defaultValue: 'Retry All' })}
                          </button>
                        </div>
                        {staffBlockers.slice(0, 3).map((blocker) => (
                          <QueueRow
                            key={`staff-blocker-${blocker.queueId}`}
                            title={t(ENTITY_LABEL_KEYS[blocker.entityType] || '', {
                              defaultValue: blocker.entityType,
                            })}
                            detail={blocker.blockerReason || blocker.lastError || blocker.entityId}
                            meta={`${t('sync.blocker.status', { defaultValue: 'Status' })}: ${blocker.queueStatus}`}
                            buttonLabel={t('sync.recoveryCenter.retryQueueRow', {
                              defaultValue: 'Retry queue row',
                            })}
                            busy={actionKey === `retry-blocker-${blocker.queueId}`}
                            onClick={() => void handleRetrySyncBlocker(blocker)}
                          />
                        ))}
                        {staffFinancialItems.slice(0, 5).map((item) => (
                          <QueueRow
                            key={`staff-financial-${item.queueId}`}
                            title={t(ENTITY_LABEL_KEYS[item.entityType] || '', {
                              defaultValue: item.entityType,
                            })}
                            detail={item.lastError || summarizeId(item.entityId)}
                            meta={`${formatDateTime(item.createdAt)} • ${t('sync.financial.attempts', {
                              defaultValue: 'Attempts',
                            })}: ${item.retryCount}`}
                            buttonLabel={t('sync.recoveryCenter.retryQueueRow', {
                              defaultValue: 'Retry queue row',
                            })}
                            busy={actionKey === `retry-financial-${item.queueId}`}
                            onClick={() => void handleRetryFinancialItem(item)}
                          />
                        ))}
                      </IssueCard>
                    )}

                    {unhandledBlockers.length > 0 ? (
                      <IssueCard
                        title={t('sync.recoveryCenter.contactOperator', {
                          defaultValue: 'Contact operator',
                        })}
                        subtitle={t('sync.recoveryCenter.contactOperatorDetail', {
                          defaultValue:
                            'This issue does not have a guided unblock yet. Contact an operator and add a dedicated fix for this blocker type so the next occurrence can be recovered directly from this screen.',
                        })}
                        tone="danger"
                      >
                        {unhandledBlockers.slice(0, 5).map((blocker) => (
                          <div
                            key={`unhandled-${blocker.queueId}`}
                            className="rounded-[18px] border border-white/60 bg-white/80 px-4 py-3 text-sm dark:border-white/10 dark:bg-white/[0.04]"
                          >
                            <div className="font-semibold text-slate-900 dark:text-white">
                              {t(ENTITY_LABEL_KEYS[blocker.entityType] || '', {
                                defaultValue: blocker.entityType,
                              })}
                            </div>
                            <div className="mt-1 text-slate-700 dark:text-slate-200/90">
                              {blocker.blockerReason || blocker.lastError || blocker.entityId}
                            </div>
                            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                              {t('sync.blocker.status', { defaultValue: 'Status' })}: {blocker.queueStatus}
                            </div>
                          </div>
                        ))}
                      </IssueCard>
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default SyncRecoveryModal;
