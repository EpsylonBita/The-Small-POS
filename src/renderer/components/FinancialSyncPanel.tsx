import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getBridge, offEvent, onEvent } from '../../lib';
import { formatUnitShiftsQueueReason } from '../../lib/unit-shifts-queue-reason';
import { useBlockerRegistration } from '../hooks/useBlockerRegistration';
import { getSyncQueueBridge } from '../services/SyncQueueBridge';
import type { SyncQueueItem } from '../../../../shared/pos/sync-queue-types';

type ActionableFinancialStatus =
  | 'conflict'
  | 'failed'
  | 'pending'
  | 'in_progress'
  | 'deferred';

interface FinancialQueueSummary {
  pending: number;
  failed: number;
}

interface FinancialSyncPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void;
  queueSummary?: FinancialQueueSummary;
}

interface FinancialStatusPresentation {
  label: string;
  badgeClassName: string;
  accentClassName: string;
  description: string;
}

const ACTIONABLE_STATUS_ORDER: ActionableFinancialStatus[] = [
  'conflict',
  'failed',
  'pending',
  'deferred',
  'in_progress',
];

const ACTIONABLE_STATUSES = new Set<ActionableFinancialStatus>(
  ACTIONABLE_STATUS_ORDER,
);

const RETRYABLE_STATUSES = new Set<ActionableFinancialStatus>([
  'conflict',
  'failed',
  'pending',
  'deferred',
]);

type ActionableFinancialItem = SyncQueueItem & {
  normalizedStatus: ActionableFinancialStatus;
};

const normalizeStatus = (item: SyncQueueItem): ActionableFinancialStatus | null => {
  const normalized = typeof item.status === 'string' ? item.status.toLowerCase() : '';
  if (normalized === 'processing') {
    return 'in_progress';
  }
  if (normalized === 'conflict') {
    return 'conflict';
  }
  if (normalized === 'failed') {
    return 'failed';
  }
  if (normalized === 'pending') {
    const error = item.errorMessage?.toLowerCase() || '';
    if (error.includes('waiting for parent') || !!item.nextRetryAt) {
      return 'deferred';
    }
    return 'pending';
  }
  return ACTIONABLE_STATUSES.has(normalized as ActionableFinancialStatus)
    ? (normalized as ActionableFinancialStatus)
    : null;
};

const formatPayload = (payload: string): string => {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
};

const getStatusPresentation = (
  t: ReturnType<typeof useTranslation>['t'],
  status: ActionableFinancialStatus,
): FinancialStatusPresentation => {
  switch (status) {
    case 'conflict':
      return {
        label: t('sync.financial.conflict', { defaultValue: 'Conflict' }),
        badgeClassName:
          'text-orange-700 dark:text-orange-300',
        accentClassName: 'text-orange-600 dark:text-orange-300',
        description: t('sync.financial.conflictGroupDesc', {
          defaultValue: 'These items require operator review before they can sync.',
        }),
      };
    case 'failed':
      return {
        label: t('sync.financial.failed', { defaultValue: 'Failed' }),
        badgeClassName:
          'text-red-700 dark:text-red-300',
        accentClassName: 'text-red-600 dark:text-red-300',
        description: t('sync.financial.failedGroupDesc', {
          defaultValue: 'These items stopped syncing and need intervention.',
        }),
      };
    case 'pending':
      return {
        label: t('sync.financial.pending', { defaultValue: 'Pending' }),
        badgeClassName:
          'text-blue-700 dark:text-blue-300',
        accentClassName: 'text-blue-600 dark:text-blue-300',
        description: t('sync.financial.pendingGroupDesc', {
          defaultValue: 'These items are queued locally and still waiting to sync.',
        }),
      };
    case 'deferred':
      return {
        label: t('sync.financial.deferred', { defaultValue: 'Deferred' }),
        badgeClassName:
          'text-amber-700 dark:text-amber-300',
        accentClassName: 'text-amber-600 dark:text-amber-300',
        description: t('sync.financial.deferredGroupDesc', {
          defaultValue: 'These items were delayed by retry or backpressure handling.',
        }),
      };
    case 'in_progress':
      return {
        label: t('sync.financial.inProgress', { defaultValue: 'In Progress' }),
        badgeClassName:
          'text-cyan-700 dark:text-cyan-300',
        accentClassName: 'text-cyan-600 dark:text-cyan-300',
        description: t('sync.financial.inProgressGroupDesc', {
          defaultValue: 'These items are being processed right now.',
        }),
      };
  }
};

const canRetry = (item: SyncQueueItem): boolean => {
  const status = normalizeStatus(item);
  return status ? RETRYABLE_STATUSES.has(status) : false;
};

const canRepairOrphanedAdjustment = (item: ActionableFinancialItem): boolean => {
  if (
    item.tableName !== 'payment_adjustments' ||
    item.normalizedStatus !== 'failed'
  ) {
    return false;
  }

  const normalizedError =
    typeof item.errorMessage === 'string' ? item.errorMessage.toLowerCase() : '';
  return (
    normalizedError.includes('order not found') ||
    normalizedError.includes('payment does not belong to the provided order')
  );
};

export const FinancialSyncPanel: React.FC<FinancialSyncPanelProps> = ({
  isOpen,
  onClose,
  onRefresh,
  queueSummary,
}) => {
  const bridge = getBridge();
  const syncQueue = getSyncQueueBridge();
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

  const [items, setItems] = useState<SyncQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState<string | null>(null);
  const [incomingCount, setIncomingCount] = useState(0);
  const [incomingReadFailed, setIncomingReadFailed] = useState(false);
  const incomingRetryInFlight = useRef(false);

  const loadItems = async () => {
    setLoading(true);
    try {
      const queueItems = await syncQueue.listItems({
        limit: 200,
        moduleType: 'financial',
      });
      setItems(Array.isArray(queueItems) ? queueItems : []);
      if (typeof bridge.sync.getStatus === 'function') {
        try {
          const status=await bridge.sync.getStatus();
          setIncomingCount(status.unresolvedRemotePayments ?? 0);
          setIncomingReadFailed(false);
        } catch { setIncomingReadFailed(true); }
      }
    } catch (err) {
      console.error('Failed to load financial sync items', err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void loadItems();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const refreshQueue = () => {
      void loadItems();
    };

    onEvent('sync:complete', refreshQueue);
    onEvent('sync-retry-scheduled', refreshQueue);
    onEvent('sync:status', refreshQueue);

    return () => {
      offEvent('sync:complete', refreshQueue);
      offEvent('sync-retry-scheduled', refreshQueue);
      offEvent('sync:status', refreshQueue);
    };
  }, [isOpen]);

  const actionableItems = useMemo(() => {
    return items
      .map((item) => {
        const normalizedStatus = normalizeStatus(item);
        return normalizedStatus ? { ...item, normalizedStatus } : null;
      })
      .filter(
        (
          item,
        ): item is ActionableFinancialItem => item !== null,
      );
  }, [items]);

  const groupedItems = useMemo(
    () =>
      ACTIONABLE_STATUS_ORDER.map((status) => ({
        status,
        items: actionableItems.filter(
          (item) => item.normalizedStatus === status,
        ),
      })).filter((group) => group.items.length > 0),
    [actionableItems],
  );

  const actionableSummaryCount =
    (queueSummary?.pending ?? 0) + (queueSummary?.failed ?? 0);
  const hasQueueDetails = groupedItems.length > 0;
  const hasActionableSummary = actionableSummaryCount > 0;
  const failedItemsCount = actionableItems.filter(
    (item) => item.normalizedStatus === 'failed',
  ).length;
  const repairableOrphanedAdjustmentCount = actionableItems.filter((item) =>
    canRepairOrphanedAdjustment(item),
  ).length;
  const blockerMetadata = useMemo(
    () => ({
      actionableSummaryCount,
      failedItemsCount,
      repairableOrphanedAdjustmentCount,
      hasQueueDetails,
    }),
    [
      actionableSummaryCount,
      failedItemsCount,
      repairableOrphanedAdjustmentCount,
      hasQueueDetails,
    ],
  );

  useBlockerRegistration({
    id: 'financial-sync-panel',
    label: 'Financial sync panel',
    source: 'sync-status',
    active: isOpen,
    metadata: blockerMetadata,
  });

  const handleRetryItem = async (queueId: string) => {
    setProcessing(queueId);
    try {
      await syncQueue.retryItem(queueId);
      await loadItems();
      onRefresh();
    } catch (err) {
      console.error('Failed to retry item', err);
    } finally {
      setProcessing(null);
    }
  };

  const handleRetryAll = async () => {
    setProcessing('all');
    try {
      await syncQueue.retryModule('financial');
      await loadItems();
      onRefresh();
    } catch (err) {
      console.error('Failed to retry all', err);
    } finally {
      setProcessing(null);
    }
  };

  const handleRetryIncoming = async () => {
    if (incomingRetryInFlight.current) return;
    incomingRetryInFlight.current = true;
    setProcessing('incoming');
    try {
      const snapshot=await bridge.recovery.createPreActionSnapshot();
      if (!snapshot?.id) throw new Error('Recovery snapshot was not confirmed');
      await bridge.sync.retryAllFailedFinancial({ incomingOnly: true });
      await loadItems();
      onRefresh();
    } catch (error) {
      console.error('Failed to resume canonical payment downloads',error);
    } finally { incomingRetryInFlight.current = false; setProcessing(null); }
  };

  const handleRepairOrphanedAdjustments = async () => {
    setProcessing('repair-orphaned');
    try {
      await bridge.sync.requeueOrphanedFinancial();
      await loadItems();
      onRefresh();
    } catch (err) {
      console.error('Failed to repair orphaned financial items', err);
    } finally {
      setProcessing(null);
    }
  };

  if (!isOpen || typeof document === 'undefined') {
    return null;
  }

  return ReactDOM.createPortal(
    <div
      data-cashier-recovery="true"
      className="fixed inset-0 z-10020 px-4 py-6 sm:px-6 sm:py-8"
      style={{ isolation: 'isolate' }}
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-md"
        onClick={onClose}
      />

      <div className="relative z-10030 flex h-full items-center justify-center">
        <div
          className="liquid-glass-modal-shell flex w-full flex-col overflow-hidden rounded-3xl"
          style={{
            width: 'min(760px, calc(100vw - 32px))',
            maxHeight: '76vh',
          }}
        >
          <div className="flex items-start justify-between gap-4 px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <h2 className="text-xl font-extrabold liquid-glass-modal-text sm:text-2xl">
                {t('sync.financial.title')}
              </h2>
              <p className="mt-1 text-sm font-medium liquid-glass-modal-text-muted">
                {t('sync.financial.subtitle')}
              </p>
            </div>
            <button
              onClick={onClose}
              className="liquid-glass-modal-close"
              aria-label={t('common.actions.close')}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-5 sm:px-6">
            <AnimatePresence initial={false}>{incomingReadFailed && <motion.div key="glass-reveal-1" {...revealMotion}><p role="alert">{t('sync.financial.queueDetailsUnavailableHint')}</p></motion.div>}</AnimatePresence>
            <AnimatePresence initial={false}>{incomingCount>0 && (
              <motion.div key="glass-reveal-2" {...revealMotion}><div role="status" className="pos-glass-form-card">
                <p>{t('sync.financial.incomingRecovery',{count:incomingCount})}</p>
                <button onClick={handleRetryIncoming} disabled={!!processing} className="liquid-glass-modal-button mt-3">
                  {t('sync.financial.incomingRetry')}
                </button>
              </div></motion.div>
            )}</AnimatePresence>
            <AnimatePresence initial={false}>{loading ? (
              <motion.div key="queue-state-3" {...revealMotion}><div className="flex h-40 items-center justify-center">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-(--pos-s-border) border-t-blue-500" />
              </div></motion.div>
            ) : !hasQueueDetails && !hasActionableSummary && incomingCount===0 && !incomingReadFailed ? (
              <motion.div key="queue-state-4" {...revealMotion}><div className="py-14 text-center">
                <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full pos-glass-form-card p-0!">
                  <svg
                    className="h-10 w-10 text-green-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
                <h3 className="mb-2 text-xl font-extrabold liquid-glass-modal-text">
                  {t('sync.financial.allClear')}
                </h3>
                <p className="font-medium liquid-glass-modal-text-muted">
                  {t('sync.financial.noFailedItems')}
                </p>
              </div></motion.div>
            ) : !hasQueueDetails && (incomingReadFailed || (incomingCount>0 && actionableSummaryCount<=incomingCount)) ? null : !hasQueueDetails ? (
              <motion.div key="queue-state-5" {...revealMotion}><div className="pos-glass-form-card p-5!">
                <div className="mb-2 text-sm font-bold text-amber-700 dark:text-amber-300">
                  {t('sync.financial.queueDetailsUnavailable', {
                    defaultValue: 'Financial sync still has actionable items.',
                  })}
                </div>
                <p className="text-sm font-medium text-amber-700 dark:text-amber-200">
                  {t('sync.financial.queueDetailsUnavailableHint', {
                    defaultValue:
                      'The local summary still reports pending or failed financial sync rows, but their queue details were not returned.',
                  })}
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                  <span className="pos-glass-form-card px-3! py-1.5! text-blue-700 dark:text-blue-300">
                    {t('sync.financial.pending', { defaultValue: 'Pending' })}:{' '}
                    {queueSummary?.pending ?? 0}
                  </span>
                  <span className="pos-glass-form-card px-3! py-1.5! text-red-700 dark:text-red-300">
                    {t('sync.financial.failed', { defaultValue: 'Failed' })}:{' '}
                    {queueSummary?.failed ?? 0}
                  </span>
                </div>
              </div></motion.div>
            ) : (
              <motion.div key="queue-state-6" {...revealMotion}><>
                <div className="flex flex-wrap items-center justify-between gap-3 pos-glass-form-card">
                  <div>
                    <div className="text-sm font-bold liquid-glass-modal-text">
                      {t('sync.financial.actionableItemsTitle', {
                        defaultValue: 'Actionable financial queue items',
                      })}
                    </div>
                    <div className="mt-1 text-xs font-medium liquid-glass-modal-text-muted">
                      {t('sync.financial.actionableItemsSubtitle', {
                        defaultValue:
                          'Grouped by sync status so pending and blocked rows are visible before they fail.',
                      })}
                    </div>
                  </div>
                  {failedItemsCount > 0 && (
                    <button
                      onClick={handleRetryAll}
                      disabled={!!processing}
                      className="liquid-glass-modal-button pos-modal-primary min-h-11 px-4 py-2 text-sm font-bold transition-all disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {processing === 'all'
                        ? t('sync.financial.retryingAll')
                        : t('sync.financial.retryAll')}
                    </button>
                  )}
                  {repairableOrphanedAdjustmentCount > 0 && (
                    <button
                      onClick={handleRepairOrphanedAdjustments}
                      disabled={!!processing}
                      className="liquid-glass-modal-button min-h-11 px-4 py-2 text-sm font-bold transition-all disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {processing === 'repair-orphaned'
                        ? t('sync.financial.repairingOrphanedAdjustments', {
                            defaultValue: 'Repairing order links...',
                          })
                        : t('sync.financial.repairOrphanedAdjustments', {
                            defaultValue: 'Repair orphaned adjustments',
                          })}
                    </button>
                  )}
                </div>

                <div className="space-y-3">
                  {groupedItems.map((group) => {
                    const presentation = getStatusPresentation(t, group.status);

                    return (
                      <section
                        key={group.status}
                        className="pos-glass-form-card"
                      >
                        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <span
                                className={`rounded-lg px-3 py-1 text-xs font-bold uppercase tracking-wide ${presentation.badgeClassName}`}
                              >
                                {presentation.label}
                              </span>
                              <span
                                className={`text-sm font-extrabold ${presentation.accentClassName}`}
                              >
                                {group.items.length}
                              </span>
                            </div>
                            <p className="mt-2 text-xs font-medium liquid-glass-modal-text-muted">
                              {presentation.description}
                            </p>
                          </div>
                        </div>

                        <div className="space-y-3">
                          {group.items.map((item) => {
                            // A Z held for open phone shifts reads in the store's language (review 14/10/2026).
                            const queueError = formatUnitShiftsQueueReason(item.errorMessage, t) ?? item.errorMessage;
                            const isDeferred = item.normalizedStatus === 'deferred';

                            return (
                              <div
                                key={item.id}
                                className="pos-glass-form-card"
                              >
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                  <div className="min-w-0 flex-1">
                                    <div className="mb-2 flex flex-wrap items-center gap-2">
                                      <span className="pos-glass-form-card px-3! py-1! text-[11px] font-bold uppercase tracking-wide liquid-glass-modal-text-muted">
                                        {item.tableName}
                                      </span>
                                      <span className="pos-glass-form-card px-3! py-1! text-[11px] font-bold uppercase tracking-wide liquid-glass-modal-text-muted">
                                        {item.operation}
                                      </span>
                                      <span className="text-[11px] font-medium liquid-glass-modal-text-muted">
                                        {new Date(item.createdAt).toLocaleString()}
                                      </span>
                                    </div>

                                    <div className="mb-2 break-all text-sm font-semibold liquid-glass-modal-text">
                                      {item.recordId}
                                    </div>

                                    {isDeferred && queueError ? (
                                      <div className="mb-3 pos-glass-form-card p-3!">
                                        <div className="text-sm font-semibold text-amber-700 dark:text-amber-200">
                                          {queueError}
                                        </div>
                                        {item.nextRetryAt && (
                                          <div className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-100">
                                            {t('sync.financial.nextRetryAt', {
                                              defaultValue: 'Next retry',
                                            })}
                                            : {new Date(item.nextRetryAt).toLocaleString()}
                                          </div>
                                        )}
                                      </div>
                                    ) : (
                                      queueError && (
                                        <div className="mb-3 text-sm font-medium text-red-700 dark:text-red-300">
                                          {queueError}
                                        </div>
                                      )
                                    )}

                                    <details className="group cursor-pointer text-xs">
                                      <summary className="pos-glass-field flex min-h-11 items-center rounded-xl px-3 font-semibold transition-colors">
                                        {t('sync.financial.viewPayload')}
                                      </summary>
                                      <pre className="mt-2 overflow-x-auto pos-glass-form-card p-3! font-mono text-[10px] liquid-glass-modal-text-muted">
                                        {formatPayload(item.data)}
                                      </pre>
                                    </details>
                                  </div>

                                  <div className="flex flex-row items-start gap-2 sm:flex-col sm:items-end">
                                    <span className="pos-glass-form-card px-3! py-1.5! text-xs font-bold liquid-glass-modal-text-muted">
                                      {t('sync.financial.attempts')}:{' '}
                                      <span className="font-mono liquid-glass-modal-text">
                                        {item.attempts}
                                      </span>
                                    </span>
                                    {canRetry(item) && (
                                      <button
                                        onClick={() =>
                                          void handleRetryItem(item.id)
                                        }
                                        disabled={!!processing}
                                        className="pos-glass-field min-h-11 px-4 py-2 text-xs font-bold transition-all disabled:cursor-not-allowed disabled:opacity-50 "
                                      >
                                        {processing === item.id
                                          ? '...'
                                          : t('sync.financial.retry')}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              </></motion.div>
            )}</AnimatePresence>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
