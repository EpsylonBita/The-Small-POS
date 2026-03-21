import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getBridge, offEvent, onEvent } from '../../lib';
import type {
  SyncFinancialQueueItem,
  SyncFinancialQueueStatus,
} from '../../lib/ipc-contracts';

type ActionableFinancialStatus =
  | 'failed'
  | 'pending'
  | 'in_progress'
  | 'deferred'
  | 'queued_remote';

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
  'failed',
  'pending',
  'deferred',
  'queued_remote',
  'in_progress',
];

const ACTIONABLE_STATUSES = new Set<ActionableFinancialStatus>(
  ACTIONABLE_STATUS_ORDER,
);

const RETRYABLE_STATUSES = new Set<ActionableFinancialStatus>([
  'failed',
  'pending',
  'deferred',
]);

const normalizeStatus = (status: SyncFinancialQueueStatus): ActionableFinancialStatus | null => {
  const normalized = typeof status === 'string' ? status.toLowerCase() : '';
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

const formatDependencyStatus = (value: string | null | undefined): string => {
  if (!value) {
    return '';
  }

  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (segment) => segment.toUpperCase());
};

const getStatusPresentation = (
  t: ReturnType<typeof useTranslation>['t'],
  status: ActionableFinancialStatus,
): FinancialStatusPresentation => {
  switch (status) {
    case 'failed':
      return {
        label: t('sync.financial.failed', { defaultValue: 'Failed' }),
        badgeClassName:
          'bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30',
        accentClassName: 'text-red-600 dark:text-red-300',
        description: t('sync.financial.failedGroupDesc', {
          defaultValue: 'These items stopped syncing and need intervention.',
        }),
      };
    case 'pending':
      return {
        label: t('sync.financial.pending', { defaultValue: 'Pending' }),
        badgeClassName:
          'bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/30',
        accentClassName: 'text-blue-600 dark:text-blue-300',
        description: t('sync.financial.pendingGroupDesc', {
          defaultValue: 'These items are queued locally and still waiting to sync.',
        }),
      };
    case 'deferred':
      return {
        label: t('sync.financial.deferred', { defaultValue: 'Deferred' }),
        badgeClassName:
          'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30',
        accentClassName: 'text-amber-600 dark:text-amber-300',
        description: t('sync.financial.deferredGroupDesc', {
          defaultValue: 'These items were delayed by retry or backpressure handling.',
        }),
      };
    case 'queued_remote':
      return {
        label: t('sync.financial.queuedRemote', {
          defaultValue: 'Queued Remotely',
        }),
        badgeClassName:
          'bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-500/30',
        accentClassName: 'text-violet-600 dark:text-violet-300',
        description: t('sync.financial.queuedRemoteGroupDesc', {
          defaultValue: 'These items were accepted and are still waiting upstream.',
        }),
      };
    case 'in_progress':
      return {
        label: t('sync.financial.inProgress', { defaultValue: 'In Progress' }),
        badgeClassName:
          'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30',
        accentClassName: 'text-cyan-600 dark:text-cyan-300',
        description: t('sync.financial.inProgressGroupDesc', {
          defaultValue: 'These items are being processed right now.',
        }),
      };
  }
};

const canRetry = (item: SyncFinancialQueueItem): boolean => {
  const status = normalizeStatus(item.status);
  return status ? RETRYABLE_STATUSES.has(status) : false;
};

export const FinancialSyncPanel: React.FC<FinancialSyncPanelProps> = ({
  isOpen,
  onClose,
  onRefresh,
  queueSummary,
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const [items, setItems] = useState<SyncFinancialQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState<string | null>(null);

  const loadItems = async () => {
    setLoading(true);
    try {
      const queueItems = await bridge.sync.getFailedFinancialItems(100);
      setItems(Array.isArray(queueItems) ? queueItems : []);
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
        const normalizedStatus = normalizeStatus(item.status);
        return normalizedStatus ? { ...item, normalizedStatus } : null;
      })
      .filter(
        (
          item,
        ): item is SyncFinancialQueueItem & {
          normalizedStatus: ActionableFinancialStatus;
        } => item !== null,
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

  const handleRetryItem = async (queueId: number) => {
    setProcessing(String(queueId));
    try {
      await bridge.sync.retryFinancialItem(queueId);
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
      await bridge.sync.retryAllFailedFinancial();
      await loadItems();
      onRefresh();
    } catch (err) {
      console.error('Failed to retry all', err);
    } finally {
      setProcessing(null);
    }
  };

  if (!isOpen || typeof document === 'undefined') {
    return null;
  }

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[10020] px-4 py-6 sm:px-6 sm:py-8"
      style={{ isolation: 'isolate' }}
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-md"
        onClick={onClose}
      />

      <div className="relative z-[10030] flex h-full items-center justify-center">
        <div
          className="liquid-glass-modal-shell flex w-full flex-col overflow-hidden rounded-3xl"
          style={{
            width: 'min(760px, calc(100vw - 32px))',
            maxHeight: '76vh',
          }}
        >
          <div className="flex items-start justify-between gap-4 border-b liquid-glass-modal-border px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <h2 className="text-xl font-extrabold text-black dark:text-white sm:text-2xl">
                {t('sync.financial.title')}
              </h2>
              <p className="mt-1 text-sm font-medium text-slate-600 dark:text-slate-400">
                {t('sync.financial.subtitle')}
              </p>
            </div>
            <button
              onClick={onClose}
              className="liquid-glass-modal-button min-h-0 min-w-0 rounded-xl p-2"
              aria-label={t('common.actions.close')}
            >
              <svg
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
            {loading ? (
              <div className="flex h-40 items-center justify-center">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-500/30 border-t-blue-500" />
              </div>
            ) : !hasQueueDetails && !hasActionableSummary ? (
              <div className="py-14 text-center">
                <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-green-500/20">
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
                <h3 className="mb-2 text-xl font-extrabold text-black dark:text-white">
                  {t('sync.financial.allClear')}
                </h3>
                <p className="font-medium text-slate-600 dark:text-slate-400">
                  {t('sync.financial.noFailedItems')}
                </p>
              </div>
            ) : !hasQueueDetails ? (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5">
                <div className="mb-2 text-sm font-bold text-amber-700 dark:text-amber-300">
                  {t('sync.financial.queueDetailsUnavailable', {
                    defaultValue: 'Financial sync still has actionable items.',
                  })}
                </div>
                <p className="text-sm font-medium text-amber-700/90 dark:text-amber-200">
                  {t('sync.financial.queueDetailsUnavailableHint', {
                    defaultValue:
                      'The local summary still reports pending or failed financial sync rows, but their queue details were not returned.',
                  })}
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                  <span className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-blue-700 dark:text-blue-300">
                    {t('sync.financial.pending', { defaultValue: 'Pending' })}:{' '}
                    {queueSummary?.pending ?? 0}
                  </span>
                  <span className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-red-700 dark:text-red-300">
                    {t('sync.financial.failed', { defaultValue: 'Failed' })}:{' '}
                    {queueSummary?.failed ?? 0}
                  </span>
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl liquid-glass-modal-card p-4">
                  <div>
                    <div className="text-sm font-bold text-black dark:text-white">
                      {t('sync.financial.actionableItemsTitle', {
                        defaultValue: 'Actionable financial queue items',
                      })}
                    </div>
                    <div className="mt-1 text-xs font-medium text-slate-600 dark:text-slate-400">
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
                      className="rounded-xl bg-gradient-to-r from-blue-500 to-cyan-500 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-blue-500/25 transition-all hover:from-blue-600 hover:to-cyan-600 hover:shadow-blue-500/40 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {processing === 'all'
                        ? t('sync.financial.retryingAll')
                        : t('sync.financial.retryAll')}
                    </button>
                  )}
                </div>

                <div className="space-y-4">
                  {groupedItems.map((group) => {
                    const presentation = getStatusPresentation(t, group.status);

                    return (
                      <section
                        key={group.status}
                        className="rounded-2xl liquid-glass-modal-card p-4"
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
                            <p className="mt-2 text-xs font-medium text-slate-600 dark:text-slate-400">
                              {presentation.description}
                            </p>
                          </div>
                        </div>

                        <div className="space-y-3">
                          {group.items.map((item) => {
                            const dependencyMessage =
                              item.parentShiftId &&
                              (item.dependencyBlockReason ||
                                t('sync.financial.waitingForCashierShiftSync', {
                                  defaultValue: 'Waiting for cashier shift sync',
                                }));
                            const secondaryError =
                              dependencyMessage &&
                              item.lastError &&
                              item.lastError !== dependencyMessage
                                ? item.lastError
                                : null;

                            return (
                              <div
                                key={item.queueId}
                                className="rounded-2xl border border-white/10 bg-black/5 p-4 dark:bg-white/[0.03]"
                              >
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                  <div className="min-w-0 flex-1">
                                    <div className="mb-2 flex flex-wrap items-center gap-2">
                                      <span className="rounded-lg border border-slate-400/30 bg-slate-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                                        {item.entityType}
                                      </span>
                                      <span className="rounded-lg border border-slate-400/30 bg-slate-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                                        {item.operation}
                                      </span>
                                      <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                                        {new Date(item.createdAt).toLocaleString()}
                                      </span>
                                    </div>

                                    <div className="mb-2 break-all text-sm font-semibold text-black dark:text-white">
                                      {item.entityId}
                                    </div>

                                    {dependencyMessage ? (
                                      <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                                        <div className="text-sm font-semibold text-amber-700 dark:text-amber-200">
                                          {dependencyMessage}
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold text-amber-800/90 dark:text-amber-100">
                                          <span className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1">
                                            {t('sync.financial.parentShiftLabel', {
                                              defaultValue: 'Parent shift',
                                            })}
                                            : {item.parentShiftId}
                                          </span>
                                          {item.parentShiftSyncStatus && (
                                            <span className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1">
                                              {t('sync.financial.parentShiftLocalStatus', {
                                                defaultValue: 'Local',
                                              })}
                                              : {formatDependencyStatus(item.parentShiftSyncStatus)}
                                            </span>
                                          )}
                                          {item.parentShiftQueueStatus && (
                                            <span className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1">
                                              {t('sync.financial.parentShiftQueueStatus', {
                                                defaultValue: 'Queue',
                                              })}
                                              : {formatDependencyStatus(item.parentShiftQueueStatus)}
                                            </span>
                                          )}
                                          {item.parentShiftQueueId != null && (
                                            <span className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1">
                                              {t('sync.financial.parentShiftQueueId', {
                                                defaultValue: 'Queue ID',
                                              })}
                                              : {item.parentShiftQueueId}
                                            </span>
                                          )}
                                        </div>
                                        {secondaryError && (
                                          <div className="mt-2 text-xs font-medium text-amber-800/80 dark:text-amber-100/80">
                                            {secondaryError}
                                          </div>
                                        )}
                                      </div>
                                    ) : (
                                      item.lastError && (
                                        <div className="mb-3 text-sm font-medium text-red-700 dark:text-red-300">
                                          {item.lastError}
                                        </div>
                                      )
                                    )}

                                    <details className="group cursor-pointer text-xs">
                                      <summary className="font-semibold text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300">
                                        {t('sync.financial.viewPayload')}
                                      </summary>
                                      <pre className="mt-2 overflow-x-auto rounded-xl border border-slate-300/50 bg-slate-100 p-3 font-mono text-[10px] text-slate-700 dark:border-slate-600/50 dark:bg-slate-800/50 dark:text-slate-300">
                                        {formatPayload(item.payload)}
                                      </pre>
                                    </details>
                                  </div>

                                  <div className="flex flex-row items-start gap-2 sm:flex-col sm:items-end">
                                    <span className="rounded-lg border border-slate-300/50 bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600 dark:border-slate-600/50 dark:bg-slate-800/50 dark:text-slate-400">
                                      {t('sync.financial.attempts')}:{' '}
                                      <span className="font-mono text-black dark:text-white">
                                        {item.retryCount}
                                      </span>
                                    </span>
                                    {canRetry(item) && (
                                      <button
                                        onClick={() =>
                                          void handleRetryItem(item.queueId)
                                        }
                                        disabled={!!processing}
                                        className="rounded-xl border border-slate-300/50 px-4 py-2 text-xs font-bold text-black transition-all hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-white dark:hover:bg-white/10"
                                      >
                                        {processing === String(item.queueId)
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
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
