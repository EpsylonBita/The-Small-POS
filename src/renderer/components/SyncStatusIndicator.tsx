import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { RefreshCw } from 'lucide-react';
import { OrderSyncRouteIndicator } from './OrderSyncRouteIndicator';
import { FinancialSyncPanel } from './FinancialSyncPanel';
import { useFeatures } from '../hooks/useFeatures';
import { formatDate } from '../utils/format';
import { getBridge, offEvent, onEvent } from '../../lib';

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

const defaultFinancialStats = {
  driver_earnings: { pending: 0, failed: 0 },
  staff_payments: { pending: 0, failed: 0 },
  shift_expenses: { pending: 0, failed: 0 }
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
    }
  };
};

const getNavigatorOnline = () => (typeof navigator !== 'undefined' ? navigator.onLine : true);

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
    isOnline: typeof status.isOnline === 'boolean' ? status.isOnline : getNavigatorOnline(),
    lastSync: toDateString(status.lastSync ?? status.lastSyncAt),
    pendingItems: coerceNumber(status.pendingItems ?? status.pendingChanges, 0),
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

export const SyncStatusIndicator: React.FC<SyncStatusIndicatorProps> = ({
  className = '',
  showDetails = false
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
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
  const [showDetailPanel, setShowDetailPanel] = useState(showDetails);
  const [showFinancialPanel, setShowFinancialPanel] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [financialStats, setFinancialStats] = useState(defaultFinancialStats);

  const {
    isMobileWaiter,
    parentTerminalId,
  } = useFeatures();

  useEffect(() => {
    setShowDetailPanel(showDetails);
  }, [showDetails]);

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
      const financialStats = (status as any)?.financialStats;
      if (financialStats) {
        setFinancialStats(normalizeFinancialStats(financialStats));
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
      setSyncStatus(prev => ({ ...prev, isOnline }));
    };

    onEvent('sync:status', handleSyncStatusUpdate);
    onEvent('network:status', handleNetworkStatus);

    const handleMenuRefreshed = () => {
      setJustRefreshed(true);
      setTimeout(() => setJustRefreshed(false), 2000);
    };
    window.addEventListener('menu-sync:refreshed', handleMenuRefreshed as EventListener);

    return () => {
      offEvent('sync:status', handleSyncStatusUpdate);
      offEvent('network:status', handleNetworkStatus);
      window.removeEventListener('menu-sync:refreshed', handleMenuRefreshed as EventListener);
    };
  }, [loadSyncStatus, loadFinancialStats]);

  const hasErrors = !!syncStatus.error ||
    syncStatus.failedPaymentItems > 0 ||
    financialStats.driver_earnings.failed > 0 ||
    financialStats.staff_payments.failed > 0 ||
    financialStats.shift_expenses.failed > 0;

  const hasPending =
    syncStatus.pendingItems > 0 ||
    syncStatus.pendingPaymentItems > 0 ||
    syncStatus.backpressureDeferred > 0;

  const getStatusText = () => {
    if (!syncStatus.isOnline) return t('sync.status.offline');
    if (syncStatus.syncInProgress) return t('sync.status.syncing');
    if (hasErrors) return t('sync.status.error');
    if (hasPending) {
      const totalPending = syncStatus.pendingItems + syncStatus.pendingPaymentItems;
      return t('sync.status.pending', { count: totalPending });
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
    if (diffMins < 60) return t('sync.time.minutesAgo', { minutes: diffMins });
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return t('sync.time.hoursAgo', { hours: diffHours });
    return formatDate(date);
  };

  const handleForceSync = async () => {
    try {
      setSyncStatus(prev => ({ ...prev, syncInProgress: true }));
      await bridge.sync.force();
      toast.success(t('sync.messages.syncComplete') || 'Sync completed');

      setTimeout(async () => {
        await loadSyncStatus();
      }, 2000);
    } catch (error) {
      console.error('Failed to force sync:', error);
      toast.error(t('sync.messages.syncFailed') || 'Sync failed');
      setSyncStatus(prev => ({ ...prev, syncInProgress: false }));
    }
  };

  const isSynced = syncStatus.isOnline && !syncStatus.syncInProgress && !hasErrors && !hasPending;

  return (
    <div className={`relative ${className}`}>
      {/* Heart Icon Status Indicator */}
      <button
        className="group relative p-2 rounded-full hover:bg-white/10 transition-all duration-200"
        onClick={() => setShowDetailPanel(!showDetailPanel)}
        title={getStatusText()}
      >
        {/* Heart Icon */}
        <svg
          className={`w-6 h-6 transition-all duration-300 ${isSynced
            ? 'text-green-400 drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]'
            : 'text-red-400 drop-shadow-[0_0_8px_rgba(239,68,68,0.6)]'
            } ${syncStatus.syncInProgress ? 'animate-pulse' : ''}`}
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
        </svg>

        {/* Pulse ring animation when syncing */}
        {syncStatus.syncInProgress && (
          <span className="absolute inset-0 rounded-full bg-yellow-400/20 animate-ping"></span>
        )}
        {/* Subtle flash ring when a background menu refresh just completed */}
        {justRefreshed && (
          <span className="absolute inset-0 rounded-full ring-2 ring-green-400/70 animate-[ping_1s_ease-out_2]"></span>
        )}
      </button>

      {/* Detail Panel - Centered Modal */}
      {showDetailPanel && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-[1000] liquid-glass-modal-backdrop"
            onClick={() => setShowDetailPanel(false)}
          />

          {/* Modal */}
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 liquid-glass-modal-shell w-full max-w-2xl max-h-[90vh] overflow-y-auto z-[1050] rounded-3xl">
            <div className="p-6 space-y-6 rounded-3xl">
              {/* Header */}
              <div className="flex items-center justify-between pb-4 border-b liquid-glass-modal-border rounded-t-3xl">
                <div className="flex items-center gap-3">
                  <svg
                    className={`w-7 h-7 ${isSynced ? 'text-green-500' : 'text-red-500'}`}
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
                  </svg>
                  <h3 className="text-2xl font-extrabold text-black dark:text-white">{t('sync.labels.syncStatus')}</h3>
                </div>
                <button
                  onClick={() => setShowDetailPanel(false)}
                  className="liquid-glass-modal-button p-2 min-h-0 min-w-0"
                  aria-label={t('common.actions.close')}
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Status Overview */}
              <div className="liquid-glass-modal-card rounded-2xl">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-bold text-black dark:text-white uppercase tracking-wide">{t('sync.labels.connection')}</span>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${syncStatus.isOnline ? 'bg-green-500' : 'bg-red-500'} ${syncStatus.isOnline ? 'animate-pulse' : ''}`}></div>
                    <span className={`text-sm font-extrabold ${syncStatus.isOnline ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                      {syncStatus.isOnline ? t('sync.labels.online') : t('sync.labels.offline')}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-bold text-black dark:text-white uppercase tracking-wide">{t('sync.labels.lastSync')}</span>
                  <span className="text-sm font-extrabold text-slate-800 dark:text-white">
                    {formatLastSync()}
                  </span>
                </div>

                {/* Terminal Type Info */}
                <div className="flex items-center justify-between pt-3 border-t liquid-glass-modal-border">
                  <span className="text-sm font-bold text-black dark:text-white uppercase tracking-wide">
                    {t('terminal.labels.terminalType', { defaultValue: 'Terminal Type' })}
                  </span>
                  <span
                    className={`text-sm font-extrabold ${isMobileWaiter ? 'text-blue-700 dark:text-blue-300' : 'text-green-700 dark:text-green-300'}`}
                  >
                    {isMobileWaiter ? t('terminal.type.mobile_waiter', { defaultValue: 'Mobile POS' }) : t('terminal.type.main', { defaultValue: 'Main Terminal' })}
                  </span>
                </div>

                {/* Parent Terminal (for mobile waiter) */}
                {isMobileWaiter && parentTerminalId && (
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-sm font-bold text-black dark:text-white uppercase tracking-wide">
                      {t('terminal.labels.parentTerminal', 'Parent Terminal')}
                    </span>
                    <span className="text-sm font-extrabold text-purple-800 dark:text-purple-300 font-mono">
                      {parentTerminalId.substring(0, 8)}...
                    </span>
                  </div>
                )}
              </div>

              {/* Sync Details Grid */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div className="liquid-glass-modal-card p-3 rounded-xl">
                  <div className="text-xs font-bold text-black dark:text-white uppercase tracking-wide mb-1">{t('sync.labels.pending')}</div>
                  <div className="text-2xl font-extrabold text-blue-800 dark:text-blue-300">{syncStatus.pendingItems}</div>
                  {(syncStatus.queuedRemote > 0 || syncStatus.backpressureDeferred > 0) && (
                    <div className="mt-1 text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                      queued {syncStatus.queuedRemote} | deferred {syncStatus.backpressureDeferred}
                    </div>
                  )}
                  {syncStatus.oldestNextRetryAt && (
                    <div className="mt-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                      next retry {new Date(syncStatus.oldestNextRetryAt).toLocaleTimeString()}
                    </div>
                  )}
                </div>

                <div className="liquid-glass-modal-card p-3 rounded-xl">
                  <div className="text-xs font-bold text-black dark:text-white uppercase tracking-wide mb-1">{t('sync.labels.health')}</div>
                  <div className={`text-2xl font-extrabold ${syncStatus.terminalHealth >= 80 ? 'text-green-700 dark:text-green-300' :
                    syncStatus.terminalHealth >= 60 ? 'text-yellow-700 dark:text-yellow-300' : 'text-red-700 dark:text-red-300'
                    }`}>
                    {Math.round(syncStatus.terminalHealth)}%
                  </div>
                </div>

                <div className="liquid-glass-modal-card p-3 rounded-xl">
                  <div className="text-xs font-bold text-black dark:text-white uppercase tracking-wide mb-1">{t('sync.labels.settings')}</div>
                  <div className="text-lg font-extrabold text-purple-800 dark:text-purple-300">v{syncStatus.settingsVersion}</div>
                </div>

                <div className="liquid-glass-modal-card p-3 rounded-xl">
                  <div className="text-xs font-bold text-black dark:text-white uppercase tracking-wide mb-1">{t('sync.labels.menu')}</div>
                  <div className="text-lg font-extrabold text-cyan-800 dark:text-cyan-300">v{syncStatus.menuVersion}</div>
                </div>

                <div className="liquid-glass-modal-card p-3 rounded-xl">
                  <div className="text-xs font-bold text-black dark:text-white uppercase tracking-wide mb-1">{t('sync.labels.pendingPayments')}</div>
                  <div className="text-lg font-extrabold text-orange-800 dark:text-orange-300">{syncStatus.pendingPaymentItems}</div>
                </div>

                <div className="liquid-glass-modal-card p-3 rounded-xl">
                  <div className="text-xs font-bold text-black dark:text-white uppercase tracking-wide mb-1">{t('sync.labels.failedPayments')}</div>
                  <div className={`text-lg font-extrabold ${syncStatus.failedPaymentItems > 0 ? 'text-red-700 dark:text-red-300' : 'text-green-800 dark:text-green-300'}`}>
                    {syncStatus.failedPaymentItems}
                  </div>
                </div>
              </div>

              {/* Financial Transactions Status */}
              <div className="pt-4 border-t liquid-glass-modal-border rounded-2xl">
                <div className="flex justify-between items-center mb-3">
                  <h4 className="text-sm font-bold text-black dark:text-white uppercase tracking-wide">{t('sync.financial.title')}</h4>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        try {
                          await loadFinancialStats();
                          toast.success(t('sync.actions.refreshed', { defaultValue: 'Refreshed' }));
                        } catch (err) {
                          console.error('Failed to refresh financial stats:', err);
                          toast.error(t('sync.actions.refreshFailed', { defaultValue: 'Refresh failed' }));
                        }
                      }}
                      className="text-xs font-semibold text-green-500 hover:text-green-400 underline"
                      title={t('sync.actions.refresh', { defaultValue: 'Refresh' })}
                    >
                      <RefreshCw className="w-3 h-3" aria-hidden="true" />
                    </button>
                    <button
                      onClick={() => setShowFinancialPanel(true)}
                      className="text-xs font-semibold text-blue-500 hover:text-blue-400 underline"
                    >
                      {t('sync.actions.manage')}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="liquid-glass-modal-card p-2 text-center rounded-xl">
                    <div className="text-[11px] font-bold text-black dark:text-white uppercase tracking-wide">{t('sync.financial.driver')}</div>
                    <div className="text-xs font-bold mt-1">
                      {financialStats.driver_earnings.pending > 0 && (
                        <div className="text-blue-700 dark:text-blue-300">
                          {financialStats.driver_earnings.pending} {t('sync.financial.pending')}
                        </div>
                      )}
                      {financialStats.driver_earnings.failed > 0 && (
                        <div className="text-red-700 dark:text-red-300">
                          {financialStats.driver_earnings.failed} {t('sync.financial.failed')}
                        </div>
                      )}
                      {financialStats.driver_earnings.pending === 0 && financialStats.driver_earnings.failed === 0 && (
                        <span className="text-green-700 dark:text-green-300">{t('sync.financial.complete')}</span>
                      )}
                    </div>
                  </div>
                  <div className="liquid-glass-modal-card p-2 text-center rounded-xl">
                    <div className="text-[11px] font-bold text-black dark:text-white uppercase tracking-wide">{t('sync.financial.staff')}</div>
                    <div className="text-xs font-bold mt-1">
                      {financialStats.staff_payments.pending > 0 && (
                        <div className="text-blue-700 dark:text-blue-300">
                          {financialStats.staff_payments.pending} {t('sync.financial.pending')}
                        </div>
                      )}
                      {financialStats.staff_payments.failed > 0 && (
                        <div className="text-red-700 dark:text-red-300">
                          {financialStats.staff_payments.failed} {t('sync.financial.failed')}
                        </div>
                      )}
                      {financialStats.staff_payments.pending === 0 && financialStats.staff_payments.failed === 0 && (
                        <span className="text-green-700 dark:text-green-300">{t('sync.financial.complete')}</span>
                      )}
                    </div>
                  </div>
                  <div className="liquid-glass-modal-card p-2 text-center rounded-xl">
                    <div className="text-[11px] font-bold text-black dark:text-white uppercase tracking-wide">{t('sync.financial.expenses')}</div>
                    <div className="text-xs font-bold mt-1">
                      {financialStats.shift_expenses.pending > 0 && (
                        <div className="text-blue-700 dark:text-blue-300">
                          {financialStats.shift_expenses.pending} {t('sync.financial.pending')}
                        </div>
                      )}
                      {financialStats.shift_expenses.failed > 0 && (
                        <div className="text-red-700 dark:text-red-300">
                          {financialStats.shift_expenses.failed} {t('sync.financial.failed')}
                        </div>
                      )}
                      {financialStats.shift_expenses.pending === 0 && financialStats.shift_expenses.failed === 0 && (
                        <span className="text-green-700 dark:text-green-300">{t('sync.financial.complete')}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Order Routing Info */}
              <OrderSyncRouteIndicator />

              {/* Error Message */}
              {syncStatus.error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-3">
                  <div className="flex items-start gap-2">
                    <svg className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <div className="text-sm font-bold text-red-700 dark:text-red-400 mb-1">{t('sync.labels.error')}</div>
                      <div className="text-xs font-semibold text-red-600 dark:text-red-300">{syncStatus.error}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="pt-4 border-t liquid-glass-modal-border rounded-2xl">
                <button
                  onClick={handleForceSync}
                  disabled={syncStatus.syncInProgress}
                  className="w-full py-3 px-4 rounded-2xl font-bold text-white bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                >
                  <div className="flex items-center justify-center gap-2">
                    {syncStatus.syncInProgress ? (
                      <>
                        <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        <span>{t('sync.status.syncing')}</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        <span>{t('sync.actions.forceSync')}</span>
                      </>
                    )}
                  </div>
                </button>
              </div>
            </div>
          </div>
        </>
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
