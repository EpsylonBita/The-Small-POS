import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  RefreshCw,
  Download,
  Printer,
  FileText,
  Database,
  CheckCircle2,
  AlertTriangle,
  Clock,
  FolderOpen,
  ChevronDown,
} from 'lucide-react';
import { OrderSyncRouteIndicator } from './OrderSyncRouteIndicator';
import { FinancialSyncPanel } from './FinancialSyncPanel';
import { useFeatures } from '../hooks/useFeatures';
import { formatDate } from '../utils/format';
import {
  getBridge,
  offEvent,
  onEvent,
  type DiagnosticsSystemHealth,
  type DiagnosticsExportOptions,
} from '../../lib';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyncStatus {
  isOnline: boolean;
  lastSync: string | null;
  pendingItems: number;
  queuedRemote: number;
  backpressureDeferred: number;
  oldestNextRetryAt: string | null;
  syncInProgress: boolean;
  error: string | null;
  terminalHealth: number;
  settingsVersion: number;
  menuVersion: number;
  pendingPaymentItems: number;
  failedPaymentItems: number;
}

interface SyncStatusIndicatorProps {
  className?: string;
  showDetails?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultFinancialStats = {
  driver_earnings: { pending: 0, failed: 0 },
  staff_payments: { pending: 0, failed: 0 },
  shift_expenses: { pending: 0, failed: 0 },
};

const normalizeFinancialStats = (stats: any) => {
  if (!stats || typeof stats !== 'object') return defaultFinancialStats;
  return {
    driver_earnings: {
      pending: coerceNumber(stats.driver_earnings?.pending, 0),
      failed: coerceNumber(stats.driver_earnings?.failed, 0),
    },
    staff_payments: {
      pending: coerceNumber(stats.staff_payments?.pending, 0),
      failed: coerceNumber(stats.staff_payments?.failed, 0),
    },
    shift_expenses: {
      pending: coerceNumber(stats.shift_expenses?.pending, 0),
      failed: coerceNumber(stats.shift_expenses?.failed, 0),
    },
  };
};

const getNavigatorOnline = () =>
  typeof navigator !== 'undefined' ? navigator.onLine : true;

const coerceNumber = (value: any, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const normalizeHealth = (value: any): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) return 80;
  if (value <= 1) return Math.round(value * 100);
  if (value > 100) return 100;
  return Math.round(value);
};

const toDateString = (value: any): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const normalizeStatus = (status: any): SyncStatus => {
  if (!status) {
    return {
      isOnline: getNavigatorOnline(),
      lastSync: null,
      pendingItems: 0,
      queuedRemote: 0,
      backpressureDeferred: 0,
      oldestNextRetryAt: null,
      syncInProgress: false,
      error: null,
      terminalHealth: 80,
      settingsVersion: 0,
      menuVersion: 0,
      pendingPaymentItems: 0,
      failedPaymentItems: 0,
    };
  }
  return {
    isOnline:
      typeof status.isOnline === 'boolean'
        ? status.isOnline
        : getNavigatorOnline(),
    lastSync: toDateString(status.lastSync ?? status.lastSyncAt),
    pendingItems: coerceNumber(
      status.pendingItems ?? status.pendingChanges,
      0,
    ),
    queuedRemote: coerceNumber(status.queuedRemote, 0),
    backpressureDeferred: coerceNumber(status.backpressureDeferred, 0),
    oldestNextRetryAt: toDateString(status.oldestNextRetryAt),
    syncInProgress: !!status.syncInProgress,
    error: typeof status.error === 'string' ? status.error : null,
    terminalHealth: normalizeHealth(status.terminalHealth),
    settingsVersion: coerceNumber(status.settingsVersion, 0),
    menuVersion: coerceNumber(status.menuVersion, 0),
    pendingPaymentItems: coerceNumber(status.pendingPaymentItems, 0),
    failedPaymentItems: coerceNumber(status.failedPaymentItems, 0),
  };
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatCurrency = (n: number) => `\u20AC${n.toFixed(2)}`;

// Translate backend entity type names (e.g. "order" → "Παραγγελία")
const ENTITY_TYPE_KEYS: Record<string, string> = {
  order: 'sync.entityTypes.order',
  payment: 'sync.entityTypes.payment',
  shift: 'sync.entityTypes.shift',
  z_report: 'sync.entityTypes.zReport',
  payment_adjustment: 'sync.entityTypes.paymentAdjustment',
  shift_expense: 'sync.entityTypes.shiftExpense',
  driver_earning: 'sync.entityTypes.driverEarning',
  staff_payment: 'sync.entityTypes.staffPayment',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SyncStatusIndicator: React.FC<SyncStatusIndicatorProps> = ({
  className = '',
  showDetails = false,
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();

  // --- Sync state ---
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => ({
    isOnline: getNavigatorOnline(),
    lastSync: null,
    pendingItems: 0,
    queuedRemote: 0,
    backpressureDeferred: 0,
    oldestNextRetryAt: null,
    syncInProgress: false,
    error: null,
    terminalHealth: 80,
    settingsVersion: 0,
    menuVersion: 0,
    pendingPaymentItems: 0,
    failedPaymentItems: 0,
  }));
  const [financialStats, setFinancialStats] = useState(defaultFinancialStats);

  // --- UI state ---
  const [showDetailPanel, setShowDetailPanel] = useState(showDetails);
  const [showFinancialPanel, setShowFinancialPanel] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);

  // --- System health state (eager on modal open) ---
  const [systemHealth, setSystemHealth] =
    useState<DiagnosticsSystemHealth | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const systemLoaded = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);

  const { isMobileWaiter, parentTerminalId } = useFeatures();

  useEffect(() => {
    setShowDetailPanel(showDetails);
  }, [showDetails]);

  // --- Sync data loading ---

  const loadFinancialStats = useCallback(async () => {
    try {
      const stats = await bridge.sync.getFinancialStats();
      setFinancialStats(normalizeFinancialStats(stats));
    } catch (err) {
      console.error('Failed to load financial stats:', err);
    }
  }, [bridge.sync]);

  const loadSyncStatus = useCallback(async () => {
    try {
      const status = await bridge.sync.getStatus();
      setSyncStatus(normalizeStatus(status));
      const fs = (status as any)?.financialStats;
      if (fs) {
        setFinancialStats(normalizeFinancialStats(fs));
      } else {
        await loadFinancialStats();
      }
    } catch (error) {
      console.error('Failed to load sync status:', error);
    }
  }, [bridge.sync, loadFinancialStats]);

  useEffect(() => {
    loadSyncStatus();

    const handleSyncStatusUpdate = async (status: any) => {
      setSyncStatus(normalizeStatus(status));
      if (status?.financialStats) {
        setFinancialStats(normalizeFinancialStats(status.financialStats));
      } else {
        await loadFinancialStats();
      }
    };

    const handleNetworkStatus = ({ isOnline }: { isOnline: boolean }) => {
      setSyncStatus((prev) => ({ ...prev, isOnline }));
    };

    onEvent('sync:status', handleSyncStatusUpdate);
    onEvent('network:status', handleNetworkStatus);

    const handleMenuRefreshed = () => {
      setJustRefreshed(true);
      setTimeout(() => setJustRefreshed(false), 2000);
    };
    window.addEventListener(
      'menu-sync:refreshed',
      handleMenuRefreshed as EventListener,
    );

    return () => {
      offEvent('sync:status', handleSyncStatusUpdate);
      offEvent('network:status', handleNetworkStatus);
      window.removeEventListener(
        'menu-sync:refreshed',
        handleMenuRefreshed as EventListener,
      );
    };
  }, [loadSyncStatus, loadFinancialStats]);

  // --- System health loading (eager — loads on mount) ---

  const loadSystemHealth = useCallback(async () => {
    setSystemLoading(true);
    try {
      const data = await bridge.diagnostics.getSystemHealth();
      setSystemHealth(data);
      systemLoaded.current = true;
    } catch (err) {
      console.error('Failed to load system health:', err);
    } finally {
      setSystemLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (!systemLoaded.current) {
      loadSystemHealth();
    }

    const handleHealthUpdate = (payload: any) => {
      const candidate =
        payload?.data && payload?.success ? payload.data : payload;
      if (candidate && typeof candidate === 'object') {
        setSystemHealth(candidate as DiagnosticsSystemHealth);
      }
    };
    onEvent('database-health-update', handleHealthUpdate);
    return () => {
      offEvent('database-health-update', handleHealthUpdate);
    };
  }, [loadSystemHealth]);

  // --- Derived ---

  const hasErrors =
    !!syncStatus.error ||
    syncStatus.failedPaymentItems > 0 ||
    financialStats.driver_earnings.failed > 0 ||
    financialStats.staff_payments.failed > 0 ||
    financialStats.shift_expenses.failed > 0;

  const hasPending =
    syncStatus.pendingItems > 0 ||
    syncStatus.pendingPaymentItems > 0 ||
    syncStatus.backpressureDeferred > 0;

  const isSynced =
    syncStatus.isOnline &&
    !syncStatus.syncInProgress &&
    !hasErrors &&
    !hasPending;

  const getStatusText = () => {
    if (!syncStatus.isOnline) return t('sync.status.offline');
    if (syncStatus.syncInProgress) return t('sync.status.syncing');
    if (hasErrors) return t('sync.status.error');
    if (hasPending) {
      const total = syncStatus.pendingItems + syncStatus.pendingPaymentItems;
      return t('sync.status.pending', { count: total });
    }
    return t('sync.status.synced');
  };

  const formatLastSync = () => {
    if (!syncStatus.lastSync) return t('sync.time.never');
    const date = new Date(syncStatus.lastSync);
    if (Number.isNaN(date.getTime())) return t('sync.time.never');
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return t('sync.time.justNow');
    if (diffMins < 60)
      return t('sync.time.minutesAgo', { minutes: diffMins });
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return t('sync.time.hoursAgo', { hours: diffHours });
    return formatDate(date);
  };

  // --- Actions ---

  const handleForceSync = async () => {
    try {
      setSyncStatus((prev) => ({ ...prev, syncInProgress: true }));
      await bridge.sync.force();
      toast.success(t('sync.messages.syncComplete') || 'Sync completed');
      setTimeout(async () => {
        await loadSyncStatus();
        if (systemLoaded.current) await loadSystemHealth();
      }, 2000);
    } catch (error) {
      console.error('Failed to force sync:', error);
      toast.error(t('sync.messages.syncFailed') || 'Sync failed');
      setSyncStatus((prev) => ({ ...prev, syncInProgress: false }));
    }
  };

  const handleExport = async () => {
    setExporting(true);
    setExportPath(null);
    try {
      const options: DiagnosticsExportOptions = {
        includeLogs: true,
        redactSensitive: false,
      };
      const result = await bridge.diagnostics.export(options);
      if (result?.success && result?.path) {
        setExportPath(result.path);
      }
    } catch (err) {
      console.error('Failed to export diagnostics:', err);
    } finally {
      setExporting(false);
    }
  };

  const handleOpenExportDir = async () => {
    if (!exportPath) return;
    try {
      await bridge.diagnostics.openExportDir(exportPath);
    } catch (error) {
      console.warn('Failed to open diagnostics export folder:', error);
    }
  };

  const handleRemoveInvalidOrders = async () => {
    if (!systemHealth?.invalidOrders?.details?.length) return;
    try {
      const orderIds = systemHealth.invalidOrders.details.map(
        (o) => o.order_id,
      );
      const result = await bridge.sync.removeInvalidOrders(orderIds);
      if (result?.success) {
        await loadSystemHealth();
      }
    } catch (err) {
      console.error('Failed to remove invalid orders:', err);
    }
  };

  // --- System health helpers ---

  const totalBacklog = systemHealth
    ? Object.values(systemHealth.syncBacklog).reduce((sum, statuses) => {
        return (
          sum +
          Object.entries(statuses)
            .filter(([s]) => s !== 'synced' && s !== 'applied')
            .reduce((s, [, c]) => s + c, 0)
        );
      }, 0)
    : 0;

  const totalPending =
    syncStatus.pendingItems + syncStatus.pendingPaymentItems;

  const healthColor =
    syncStatus.terminalHealth >= 80
      ? 'text-green-600 dark:text-green-400'
      : syncStatus.terminalHealth >= 60
        ? 'text-yellow-600 dark:text-yellow-400'
        : 'text-red-600 dark:text-red-400';

  // =========================================================================
  // Render
  // =========================================================================

  return (
    <div className={`relative ${className}`}>
      {/* Heart Icon Status Indicator */}
      <button
        className="group relative p-2 rounded-full hover:bg-white/10 transition-all duration-200"
        onClick={() => setShowDetailPanel(!showDetailPanel)}
        title={getStatusText()}
      >
        <svg
          className={`w-6 h-6 transition-all duration-300 ${
            isSynced
              ? 'text-green-400 drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]'
              : 'text-red-400 drop-shadow-[0_0_8px_rgba(239,68,68,0.6)]'
          } ${syncStatus.syncInProgress ? 'animate-pulse' : ''}`}
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
        </svg>

        {syncStatus.syncInProgress && (
          <span className="absolute inset-0 rounded-full bg-yellow-400/20 animate-ping" />
        )}
        {justRefreshed && (
          <span className="absolute inset-0 rounded-full ring-2 ring-green-400/70 animate-[ping_1s_ease-out_2]" />
        )}
      </button>

      {/* ================================================================= */}
      {/* Detail Modal                                                       */}
      {/* ================================================================= */}
      {showDetailPanel && ReactDOM.createPortal(
        <div className="fixed inset-0 z-[10000]" style={{ isolation: 'isolate' }}>
          {/* Backdrop — blur + dim layer; covers everything at body level */}
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
            onClick={() => setShowDetailPanel(false)}
          />

          {/* Modal shell — sits above backdrop; isolation prevents blur from affecting it */}
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 liquid-glass-modal-shell rounded-2xl flex flex-col"
            style={{ width: '540px', maxWidth: '95vw', maxHeight: '85vh', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
          >
            {/* -- Header ------------------------------------------------- */}
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b liquid-glass-modal-border flex-shrink-0">
              <div className="flex items-center gap-2">
                <svg
                  className={`w-5 h-5 ${isSynced ? 'text-green-500' : 'text-red-500'}`}
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
                </svg>
                <h3 className="text-lg font-bold text-black dark:text-white">
                  {t('sync.labels.syncStatus')}
                </h3>
              </div>
              <button
                onClick={() => setShowDetailPanel(false)}
                className="liquid-glass-modal-button p-1.5 min-h-0 min-w-0"
                aria-label={t('common.actions.close')}
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
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

            {/* -- Status banner ------------------------------------------ */}
            <div className="flex items-center gap-3 px-5 py-2.5 text-xs font-semibold flex-shrink-0 flex-wrap">
              <span className="flex items-center gap-1.5">
                <span
                  className={`w-2 h-2 rounded-full ${syncStatus.isOnline ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}
                />
                <span
                  className={
                    syncStatus.isOnline
                      ? 'text-green-700 dark:text-green-300'
                      : 'text-red-700 dark:text-red-300'
                  }
                >
                  {syncStatus.isOnline
                    ? t('sync.labels.online')
                    : t('sync.labels.offline')}
                </span>
              </span>
              <span className="text-slate-400 dark:text-slate-500">|</span>
              <span className="text-slate-700 dark:text-slate-300">
                {formatLastSync()}
              </span>
              <span className="text-slate-400 dark:text-slate-500">|</span>
              <span className={healthColor}>
                {Math.round(syncStatus.terminalHealth)}%
              </span>
            </div>

            {/* -- Scrollable content (hidden scrollbar) ------------------- */}
            <div
              className="flex-1 overflow-y-auto px-5 pb-3 min-h-0 space-y-3 hide-scrollbar"
              style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' } as React.CSSProperties}
            >
              {/* ── SYNC SECTION ──────────────────────────────────────── */}

              {/* Sync queue + payments compact card */}
              <div className="liquid-glass-modal-card p-3 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-black dark:text-white uppercase tracking-wide">
                    {t('sync.labels.pending')}
                  </span>
                  <span
                    className={`text-sm font-extrabold ${totalPending > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}
                  >
                    {totalPending}
                  </span>
                </div>
                {(syncStatus.queuedRemote > 0 ||
                  syncStatus.backpressureDeferred > 0) && (
                  <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                    {t('sync.queue.queued', { defaultValue: 'queued' })} {syncStatus.queuedRemote} | {t('sync.queue.deferred', { defaultValue: 'deferred' })}{' '}
                    {syncStatus.backpressureDeferred}
                  </div>
                )}
                {syncStatus.oldestNextRetryAt && (
                  <div className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                    {t('sync.queue.nextRetry', { defaultValue: 'next retry' })}{' '}
                    {new Date(syncStatus.oldestNextRetryAt).toLocaleTimeString()}
                  </div>
                )}

                <div className="flex items-center justify-between pt-1.5 border-t liquid-glass-modal-border">
                  <span className="text-[11px] font-bold text-black dark:text-white uppercase tracking-wide">
                    {t('sync.labels.pendingPayments')}
                  </span>
                  <span className="text-sm font-extrabold text-orange-600 dark:text-orange-400">
                    {syncStatus.pendingPaymentItems}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-black dark:text-white uppercase tracking-wide">
                    {t('sync.labels.failedPayments')}
                  </span>
                  <span
                    className={`text-sm font-extrabold ${syncStatus.failedPaymentItems > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}
                  >
                    {syncStatus.failedPaymentItems}
                  </span>
                </div>
              </div>

              {/* Versions + terminal type compact card */}
              <div className="liquid-glass-modal-card p-3 rounded-xl">
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
                  <span>
                    <span className="font-bold text-black dark:text-white uppercase tracking-wide">
                      {t('sync.labels.settings')}
                    </span>{' '}
                    <span className="font-extrabold text-purple-700 dark:text-purple-300">
                      v{syncStatus.settingsVersion}
                    </span>
                  </span>
                  <span>
                    <span className="font-bold text-black dark:text-white uppercase tracking-wide">
                      {t('sync.labels.menu')}
                    </span>{' '}
                    <span className="font-extrabold text-cyan-700 dark:text-cyan-300">
                      v{syncStatus.menuVersion}
                    </span>
                  </span>
                  <span>
                    <span className="font-bold text-black dark:text-white uppercase tracking-wide">
                      {t('terminal.labels.terminalType', {
                        defaultValue: 'Terminal',
                      })}
                    </span>{' '}
                    <span
                      className={`font-extrabold ${isMobileWaiter ? 'text-blue-700 dark:text-blue-300' : 'text-green-700 dark:text-green-300'}`}
                    >
                      {isMobileWaiter
                        ? t('terminal.type.mobile_waiter', {
                            defaultValue: 'Mobile POS',
                          })
                        : t('terminal.type.main', { defaultValue: 'Main' })}
                    </span>
                  </span>
                  {isMobileWaiter && parentTerminalId && (
                    <span>
                      <span className="font-bold text-black dark:text-white uppercase tracking-wide">
                        {t('terminal.labels.parentTerminal', 'Parent')}
                      </span>{' '}
                      <span className="font-extrabold text-purple-700 dark:text-purple-300 font-mono">
                        {parentTerminalId.substring(0, 8)}...
                      </span>
                    </span>
                  )}
                </div>
              </div>

              {/* Financial Transactions */}
              <div className="liquid-glass-modal-card p-3 rounded-xl">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[11px] font-bold text-black dark:text-white uppercase tracking-wide">
                    {t('sync.financial.title')}
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        try {
                          await loadFinancialStats();
                          toast.success(
                            t('sync.actions.refreshed', { defaultValue: 'Refreshed' }),
                          );
                        } catch {
                          toast.error(
                            t('sync.actions.refreshFailed', {
                              defaultValue: 'Refresh failed',
                            }),
                          );
                        }
                      }}
                      className="text-green-500 hover:text-green-400"
                      title={t('sync.actions.refresh', { defaultValue: 'Refresh' })}
                    >
                      <RefreshCw className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => setShowFinancialPanel(true)}
                      className="text-[10px] font-semibold text-blue-500 hover:text-blue-400 underline"
                    >
                      {t('sync.actions.manage')}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ['driver_earnings', 'sync.financial.driver'],
                      ['staff_payments', 'sync.financial.staff'],
                      ['shift_expenses', 'sync.financial.expenses'],
                    ] as const
                  ).map(([key, label]) => {
                    const stats = financialStats[key];
                    return (
                      <div key={key} className="text-center">
                        <div className="text-[10px] font-bold text-black dark:text-white uppercase tracking-wide">
                          {t(label)}
                        </div>
                        <div className="text-[11px] font-bold mt-0.5">
                          {stats.pending > 0 && (
                            <div className="text-blue-700 dark:text-blue-300">
                              {stats.pending} {t('sync.financial.pending')}
                            </div>
                          )}
                          {stats.failed > 0 && (
                            <div className="text-red-700 dark:text-red-300">
                              {stats.failed} {t('sync.financial.failed')}
                            </div>
                          )}
                          {stats.pending === 0 && stats.failed === 0 && (
                            <span className="text-green-700 dark:text-green-300">
                              {t('sync.financial.complete')}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Order Routing (conditional) */}
              <OrderSyncRouteIndicator />

              {/* Error */}
              {syncStatus.error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-2.5">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="text-xs font-bold text-red-700 dark:text-red-400 mb-0.5">
                        {t('sync.labels.error')}
                      </div>
                      <div className="text-[11px] font-semibold text-red-600 dark:text-red-300">
                        {syncStatus.error}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── DIVIDER ───────────────────────────────────────────── */}
              <div className="border-t liquid-glass-modal-border my-1" />

              {/* ── SYSTEM SECTION ────────────────────────────────────── */}

              {systemLoading && !systemHealth ? (
                <div className="flex items-center justify-center py-6">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500" />
                </div>
              ) : systemHealth ? (
                <>
                  {/* Sync Backlog */}
                  <div className="liquid-glass-modal-card p-3 rounded-xl">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-bold text-black dark:text-white uppercase tracking-wide">
                        {t('sync.system.syncBacklog', { defaultValue: 'Sync Backlog' })}
                      </span>
                      {totalBacklog === 0 ? (
                        <span className="flex items-center gap-1 text-[11px] font-bold text-green-600 dark:text-green-400">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {t('sync.system.clear', { defaultValue: 'Clear' })}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[11px] font-bold text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          {t('sync.system.pending', { count: totalBacklog, defaultValue: '{{count}} pending' })}
                        </span>
                      )}
                    </div>
                    {totalBacklog > 0 && (
                      <div className="space-y-0.5">
                        {Object.entries(systemHealth.syncBacklog).map(([type, statuses]) => {
                          const pending = Object.entries(statuses)
                            .filter(([s]) => s !== 'synced' && s !== 'applied')
                            .reduce((s, [, c]) => s + c, 0);
                          if (pending === 0) return null;
                          return (
                            <div
                              key={type}
                              className="text-[11px] flex justify-between text-slate-600 dark:text-slate-400"
                            >
                              <span>{ENTITY_TYPE_KEYS[type] ? t(ENTITY_TYPE_KEYS[type], { defaultValue: type }) : type}</span>
                              <span className="font-mono font-semibold">{pending}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Invalid Orders (conditional) */}
                  {(systemHealth.invalidOrders?.count ?? 0) > 0 && (
                    <div className="liquid-glass-modal-card p-3 rounded-xl border-red-500/30">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                        <span className="text-[11px] font-bold text-red-700 dark:text-red-400 uppercase tracking-wide">
                          {t('sync.system.invalidCount', {
                            count: systemHealth.invalidOrders!.count,
                            defaultValue: '{{count}} invalid',
                          })}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400 mb-2">
                        {t('sync.system.invalidOrdersDesc', { defaultValue: 'Orders have menu items not in local cache' })}
                      </p>
                      <button
                        onClick={handleRemoveInvalidOrders}
                        className="w-full px-2 py-1.5 rounded-lg text-[11px] font-bold bg-red-500 hover:bg-red-600 text-white mb-2"
                      >
                        {t('sync.system.removeInvalidOrders', { defaultValue: 'Remove Invalid Orders' })}
                      </button>
                      <div className="space-y-0.5 max-h-20 overflow-auto">
                        {systemHealth.invalidOrders!.details.slice(0, 5).map((order) => (
                          <div
                            key={order.order_id}
                            className="text-[10px] flex justify-between text-slate-500"
                          >
                            <span className="font-mono">
                              {order.order_id.substring(0, 8)}...
                            </span>
                            <span className="text-red-500">
                              {order.invalid_menu_items.length} {t('sync.system.items', { defaultValue: 'items' })}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Printers */}
                  <div className="liquid-glass-modal-card p-3 rounded-xl">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-bold text-black dark:text-white uppercase tracking-wide">
                        {t('sync.system.printers', { defaultValue: 'Printers' })}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Printer
                          className={`w-3.5 h-3.5 ${systemHealth.printerStatus.configured ? 'text-green-500' : 'text-slate-400'}`}
                        />
                        <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                          {systemHealth.printerStatus.configured
                            ? t('sync.system.configured', {
                                count: systemHealth.printerStatus.profileCount,
                                defaultValue: '{{count}} configured',
                              })
                            : t('sync.system.notConfigured', { defaultValue: 'Not configured' })}
                        </span>
                      </span>
                    </div>
                    {systemHealth.printerStatus.defaultProfile && (
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 mb-1">
                        {t('sync.system.defaultPrinter', { defaultValue: 'Default' })}:{' '}
                        {systemHealth.printerStatus.defaultProfile}
                      </div>
                    )}
                    {systemHealth.printerStatus.recentJobs.length > 0 && (
                      <div className="space-y-0.5">
                        {systemHealth.printerStatus.recentJobs.slice(0, 3).map((job) => (
                          <div
                            key={job.id}
                            className="text-[10px] flex justify-between text-slate-500"
                          >
                            <span>{ENTITY_TYPE_KEYS[job.entityType] ? t(ENTITY_TYPE_KEYS[job.entityType], { defaultValue: job.entityType }) : job.entityType}</span>
                            <span
                              className={`font-mono ${
                                job.status === 'printed'
                                  ? 'text-green-500'
                                  : job.status === 'failed'
                                    ? 'text-red-500'
                                    : 'text-amber-500'
                              }`}
                            >
                              {job.status}
                              {job.warningCode ? ' !' : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Last Z-Report */}
                  <div className="liquid-glass-modal-card p-3 rounded-xl">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-bold text-black dark:text-white uppercase tracking-wide">
                        {t('sync.system.lastZReport', { defaultValue: 'Last Z-Report' })}
                      </span>
                      {systemHealth.lastZReport && (
                        <FileText className="w-3.5 h-3.5 text-blue-500" />
                      )}
                    </div>
                    {systemHealth.lastZReport ? (
                      <div className="text-[11px] space-y-0.5 text-slate-600 dark:text-slate-400">
                        <div className="flex justify-between">
                          <span>{t('sync.system.gross', { defaultValue: 'Gross' })}</span>
                          <span className="font-semibold text-black dark:text-white">
                            {formatCurrency(systemHealth.lastZReport.totalGrossSales)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>{t('sync.system.net', { defaultValue: 'Net' })}</span>
                          <span className="font-semibold">
                            {formatCurrency(systemHealth.lastZReport.totalNetSales)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>{t('sync.system.generated', { defaultValue: 'Generated' })}</span>
                          <span className="font-mono text-[10px]">
                            {new Date(systemHealth.lastZReport.generatedAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>{t('sync.system.syncState', { defaultValue: 'Sync' })}</span>
                          <span
                            className={`font-mono ${systemHealth.lastZReport.syncState === 'applied' ? 'text-green-500' : 'text-amber-500'}`}
                          >
                            {systemHealth.lastZReport.syncState}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                        <FileText className="w-3.5 h-3.5" />
                        {t('sync.system.noReports', { defaultValue: 'No reports generated' })}
                      </div>
                    )}
                  </div>

                  {/* Database + Pending Queue */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="liquid-glass-modal-card p-3 rounded-xl">
                      <div className="text-[11px] font-bold text-black dark:text-white uppercase tracking-wide mb-1">
                        {t('sync.system.database', { defaultValue: 'Database' })}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Database className="w-3.5 h-3.5 text-purple-500" />
                        <span className="text-sm font-extrabold text-purple-700 dark:text-purple-300">
                          v{systemHealth.schemaVersion}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-500 mt-0.5">
                        {formatBytes(systemHealth.dbSizeBytes)}
                      </div>
                    </div>
                    <div className="liquid-glass-modal-card p-3 rounded-xl">
                      <div className="text-[11px] font-bold text-black dark:text-white uppercase tracking-wide mb-1">
                        {t('sync.labels.pending')}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {systemHealth.pendingOrders === 0 ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                        ) : (
                          <Clock className="w-3.5 h-3.5 text-amber-500" />
                        )}
                        <span
                          className={`text-sm font-extrabold ${systemHealth.pendingOrders === 0 ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}
                        >
                          {systemHealth.pendingOrders}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Last Sync by Entity (collapsible) */}
                  {Object.keys(systemHealth.lastSyncTimes).length > 0 && (
                    <details className="liquid-glass-modal-card rounded-xl">
                      <summary className="cursor-pointer p-3 flex items-center justify-between text-[11px] font-bold text-black dark:text-white uppercase tracking-wide select-none">
                        {t('sync.system.lastSyncByEntity', { defaultValue: 'Last Sync by Entity' })}
                        <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                      </summary>
                      <div className="px-3 pb-3 grid grid-cols-2 gap-x-4 gap-y-1">
                        {Object.entries(systemHealth.lastSyncTimes).map(([entity, ts]) => (
                          <div key={entity} className="text-[10px] text-slate-500">
                            <span className="font-medium text-slate-700 dark:text-slate-300">
                              {ENTITY_TYPE_KEYS[entity] ? t(ENTITY_TYPE_KEYS[entity], { defaultValue: entity }) : entity}
                            </span>
                            <div className="font-mono">
                              {ts ? new Date(ts).toLocaleString() : '\u2014'}
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </>
              ) : (
                <div className="text-center py-6">
                  <AlertTriangle className="w-6 h-6 text-amber-500 mx-auto mb-2" />
                  <p className="text-xs text-slate-500">
                    {t('sync.system.retry', { defaultValue: 'Failed to load. Try refreshing.' })}
                  </p>
                </div>
              )}
            </div>

            {/* -- Export success banner ----------------------------------- */}
            {exportPath && (
              <div className="mx-5 mb-2 p-2 rounded-lg flex items-center gap-2 bg-green-500/10 border border-green-500/20 flex-shrink-0">
                <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                <span className="text-[11px] font-medium text-green-600 dark:text-green-400 truncate flex-1">
                  {t('sync.system.exportSuccess', { defaultValue: 'Diagnostics exported' })}
                </span>
                <button
                  onClick={handleOpenExportDir}
                  className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold bg-green-500/20 hover:bg-green-500/30 text-green-600 dark:text-green-400"
                >
                  <FolderOpen className="w-3 h-3" />
                  {t('sync.system.openFolder', { defaultValue: 'Open Folder' })}
                </button>
              </div>
            )}

            {/* -- Footer ------------------------------------------------- */}
            <div className="flex gap-2 px-5 py-3 border-t liquid-glass-modal-border flex-shrink-0">
              <button
                onClick={handleForceSync}
                disabled={syncStatus.syncInProgress}
                className="flex-1 py-2 px-3 rounded-xl font-bold text-white text-sm bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
              >
                <span className="flex items-center justify-center gap-2">
                  <RefreshCw
                    className={`w-4 h-4 ${syncStatus.syncInProgress ? 'animate-spin' : ''}`}
                  />
                  {syncStatus.syncInProgress
                    ? t('sync.status.syncing')
                    : t('sync.actions.forceSync')}
                </span>
              </button>
              <button
                onClick={handleExport}
                disabled={exporting}
                className="py-2 px-3 rounded-xl font-bold text-sm liquid-glass-modal-card border liquid-glass-modal-border text-slate-700 dark:text-slate-200 hover:bg-white/20 dark:hover:bg-white/5 transition-all disabled:opacity-50"
              >
                <span className="flex items-center gap-1.5">
                  <Download
                    className={`w-4 h-4 ${exporting ? 'animate-bounce' : ''}`}
                  />
                  {exporting
                    ? t('sync.system.exporting', { defaultValue: 'Exporting...' })
                    : t('sync.system.exportDiagnostics', { defaultValue: 'Export' })}
                </span>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      <FinancialSyncPanel
        isOpen={showFinancialPanel}
        onClose={() => setShowFinancialPanel(false)}
        onRefresh={() => {
          void loadSyncStatus();
        }}
      />
    </div>
  );
};
