import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { OrderSyncRouteIndicator } from './OrderSyncRouteIndicator';
import { FinancialSyncPanel } from './FinancialSyncPanel';
import { useFeatures } from '../hooks/useFeatures';

interface SyncStatus {
  isOnline: boolean;
  lastSync: string | null;
  pendingItems: number;
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

export const SyncStatusIndicator: React.FC<SyncStatusIndicatorProps> = ({
  className = '',
  showDetails = false
}) => {
  const { t } = useTranslation();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    isOnline: navigator.onLine, // Use browser's online status as fallback
    lastSync: null,
    pendingItems: 0,
    syncInProgress: false,
    error: null,
    terminalHealth: 0.8, // Default to good health in browser mode
    settingsVersion: 0,
    menuVersion: 0,
    pendingPaymentItems: 0,
    failedPaymentItems: 0,
  });
  const [showDetailPanel, setShowDetailPanel] = useState(false);
  const [showFinancialPanel, setShowFinancialPanel] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [financialStats, setFinancialStats] = useState({
    driver_earnings: { pending: 0, failed: 0 },
    staff_payments: { pending: 0, failed: 0 },
    shift_expenses: { pending: 0, failed: 0 }
  });

  const {
    isMobileWaiter,
    parentTerminalId,
    loading: featuresLoading
  } = useFeatures();

  useEffect(() => {
    console.log('SyncStatusIndicator: mount');

    const normalizeStatus = (status: any): SyncStatus => {
      if (!status) {
        return {
          isOnline: navigator.onLine,
          lastSync: null,
          pendingItems: 0,
          syncInProgress: false,
          error: null,
          terminalHealth: 0.8,
          settingsVersion: 0,
          menuVersion: 0,
          pendingPaymentItems: 0,
          failedPaymentItems: 0,
        };
      }

      return {
        isOnline: typeof status.isOnline === 'boolean' ? status.isOnline : navigator.onLine,
        lastSync: status.lastSync ?? null,
        pendingItems: typeof status.pendingItems === 'number' ? status.pendingItems : 0,
        syncInProgress: !!status.syncInProgress,
        error: status.error ?? null,
        terminalHealth: typeof status.terminalHealth === 'number' ? status.terminalHealth : 0.8,
        settingsVersion: typeof status.settingsVersion === 'number' ? status.settingsVersion : 0,
        menuVersion: typeof status.menuVersion === 'number' ? status.menuVersion : 0,
        pendingPaymentItems: typeof status.pendingPaymentItems === 'number' ? status.pendingPaymentItems : 0,
        failedPaymentItems: typeof status.failedPaymentItems === 'number' ? status.failedPaymentItems : 0,
      };
    };

    // Get initial sync status
    const loadSyncStatus = async () => {
      try {
        if (window.electronAPI?.getSyncStatus) {
          const status = await window.electronAPI.getSyncStatus();
          console.log('SyncStatusIndicator: initial status', status);
          setSyncStatus(normalizeStatus(status));
        }

        if ((window as any).electronAPI?.getFinancialSyncStats) {
          const stats = await (window as any).electronAPI.getFinancialSyncStats();
          setFinancialStats(stats);
        }
      } catch (error) {
        console.error('Failed to load sync status:', error);
      }
    };

    loadSyncStatus();

    // Listen for sync status updates
    const handleSyncStatusUpdate = (status: any) => {
      console.log('SyncStatusIndicator: sync:status event', status);
      setSyncStatus(normalizeStatus(status));
    };

    const handleNetworkStatus = ({ isOnline }: { isOnline: boolean }) => {
      console.log('SyncStatusIndicator: network:status event', isOnline);
      setSyncStatus(prev => ({ ...prev, isOnline }));
    };

    if (window.electronAPI) {
      window.electronAPI.onSyncStatus?.(handleSyncStatusUpdate);
      window.electronAPI.onNetworkStatus?.(handleNetworkStatus);
    }

    // Listen for background menu refresh events from useMenuVersionPolling
    const handleMenuRefreshed = () => {
      setJustRefreshed(true);
      setTimeout(() => setJustRefreshed(false), 2000);
    };
    window.addEventListener('menu-sync:refreshed', handleMenuRefreshed as EventListener);

    // Refresh status every 30 seconds
    const interval = setInterval(loadSyncStatus, 30000);

    return () => {
      console.log('SyncStatusIndicator: unmount');
      clearInterval(interval);
      if (window.electronAPI) {
        window.electronAPI.removeSyncStatusListener?.();
        window.electronAPI.removeNetworkStatusListener?.();
      }
      window.removeEventListener('menu-sync:refreshed', handleMenuRefreshed as EventListener);
    };
  }, []);

  const getStatusColor = () => {
    if (!syncStatus.isOnline) return 'bg-red-500';
    if (syncStatus.syncInProgress) return 'bg-yellow-500';
    if (syncStatus.error || syncStatus.failedPaymentItems > 0 ||
      financialStats.driver_earnings.failed > 0 ||
      financialStats.staff_payments.failed > 0 ||
      financialStats.shift_expenses.failed > 0) return 'bg-orange-500';
    if (syncStatus.pendingItems > 0 || syncStatus.pendingPaymentItems > 0) return 'bg-blue-500';
    return 'bg-green-500';
  };

  const getStatusText = () => {
    if (!syncStatus.isOnline) return t('sync.status.offline');
    if (syncStatus.syncInProgress) return t('sync.status.syncing');
    if (syncStatus.error || syncStatus.failedPaymentItems > 0 ||
      financialStats.driver_earnings.failed > 0 ||
      financialStats.staff_payments.failed > 0 ||
      financialStats.shift_expenses.failed > 0) return t('sync.status.error');
    if (syncStatus.pendingItems > 0 || syncStatus.pendingPaymentItems > 0) {
      const totalPending = syncStatus.pendingItems + syncStatus.pendingPaymentItems;
      return t('sync.status.pending', { count: totalPending });
    }
    return t('sync.status.synced');
  };

  const getHealthColor = () => {
    if (syncStatus.terminalHealth >= 0.8) return 'text-green-600';
    if (syncStatus.terminalHealth >= 0.6) return 'text-yellow-600';
    return 'text-red-600';
  };

  const formatLastSync = () => {
    if (!syncStatus.lastSync) return t('sync.time.never');
    const date = new Date(syncStatus.lastSync);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return t('sync.time.justNow');
    if (diffMins < 60) return t('sync.time.minutesAgo', { minutes: diffMins });
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return t('sync.time.hoursAgo', { hours: diffHours });
    return date.toLocaleDateString();
  };

  const handleForceSync = async () => {
    try {
      // Check if we're in Electron or browser mode
      if (window.electronAPI) {
        // Electron mode - use IPC
        if ((window as any).electronAPI?.forceSettingsSync) {
          await (window as any).electronAPI.forceSettingsSync();
        }
        if (window.electronAPI?.forceSync) {
          await window.electronAPI.forceSync();
        }
      } else {
        // Browser mode - make direct API calls
        console.log('Browser mode: Force sync not available, but simulating...');
        alert(t('sync.messages.forceSyncElectronOnly'));
      }
    } catch (error) {
      console.error('Failed to force sync:', error);
    }
  };

  const isSynced = syncStatus.isOnline && !syncStatus.error && syncStatus.pendingItems === 0 && !syncStatus.syncInProgress;

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

      {/* Detail Panel */}
      {showDetailPanel && (
        <div className="absolute top-full left-0 mt-2 bg-gradient-to-br from-gray-900/95 to-gray-800/95 backdrop-blur-xl shadow-2xl rounded-2xl border border-white/10 p-5 min-w-96 z-[100]">
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div className="flex items-center gap-3">
                <svg
                  className={`w-5 h-5 ${isSynced ? 'text-green-400' : 'text-red-400'}`}
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
                </svg>
                <h3 className="font-semibold text-white text-lg">{t('sync.labels.syncStatus')}</h3>
              </div>
              <button
                onClick={() => setShowDetailPanel(false)}
                className="text-gray-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/10"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Status Overview */}
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-gray-400">{t('sync.labels.connection')}</span>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${syncStatus.isOnline ? 'bg-green-400' : 'bg-red-400'} ${syncStatus.isOnline ? 'animate-pulse' : ''}`}></div>
                  <span className={`text-sm font-semibold ${syncStatus.isOnline ? 'text-green-400' : 'text-red-400'}`}>
                    {syncStatus.isOnline ? t('sync.labels.online') : t('sync.labels.offline')}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-gray-400">{t('sync.labels.lastSync')}</span>
                <span className="text-sm font-medium text-white">
                  {formatLastSync()}
                </span>
              </div>

              {/* Terminal Type Info */}
              <div className="flex items-center justify-between pt-3 border-t border-white/10">
                <span className="text-sm text-gray-400">
                  {t('terminal.labels.terminalType', 'Terminal Type')}
                </span>
                <span
                  className={`text-sm font-semibold ${isMobileWaiter ? 'text-blue-400' : 'text-green-400'
                    }`}
                >
                  {isMobileWaiter ? t('terminal.type.mobile_waiter', 'Mobile POS') : t('terminal.type.main', 'Main Terminal')}
                </span>
              </div>

              {/* Parent Terminal (for mobile waiter) */}
              {isMobileWaiter && parentTerminalId && (
                <div className="flex items-center justify-between mt-2">
                  <span className="text-sm text-gray-400">
                    {t('terminal.labels.parentTerminal', 'Parent Terminal')}
                  </span>
                  <span className="text-sm font-medium text-white font-mono">
                    {parentTerminalId.substring(0, 8)}...
                  </span>
                </div>
              )}
            </div>

            {/* Sync Details Grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="bg-white/5 rounded-xl p-3 border border-white/10">
                <div className="text-xs text-gray-400 mb-1">{t('sync.labels.pending')}</div>
                <div className="text-2xl font-bold text-white">{syncStatus.pendingItems}</div>
              </div>

              <div className="bg-white/5 rounded-xl p-3 border border-white/10">
                <div className="text-xs text-gray-400 mb-1">{t('sync.labels.health')}</div>
                <div className={`text-2xl font-bold ${syncStatus.terminalHealth >= 0.8 ? 'text-green-400' :
                  syncStatus.terminalHealth >= 0.6 ? 'text-yellow-400' : 'text-red-400'
                  }`}>
                  {(syncStatus.terminalHealth * 100).toFixed(0)}%
                </div>
              </div>

              <div className="bg-white/5 rounded-xl p-3 border border-white/10">
                <div className="text-xs text-gray-400 mb-1">{t('sync.labels.settings')}</div>
                <div className="text-lg font-semibold text-white">v{syncStatus.settingsVersion}</div>
              </div>

              <div className="bg-white/5 rounded-xl p-3 border border-white/10">
                <div className="text-xs text-gray-400 mb-1">{t('sync.labels.menu')}</div>
                <div className="text-lg font-semibold text-white">v{syncStatus.menuVersion}</div>
              </div>

              <div className="bg-white/5 rounded-xl p-3 border border-white/10">
                <div className="text-xs text-gray-400 mb-1">{t('sync.labels.pendingPayments')}</div>
                <div className="text-lg font-semibold text-white">{syncStatus.pendingPaymentItems}</div>
              </div>

              <div className="bg-white/5 rounded-xl p-3 border border-white/10">
                <div className="text-xs text-gray-400 mb-1">{t('sync.labels.failedPayments')}</div>
                <div className={`text-lg font-semibold ${syncStatus.failedPaymentItems > 0 ? 'text-red-400' : 'text-white'}`}>
                  {syncStatus.failedPaymentItems}
                </div>

              </div>
            </div>

            {/* Financial Transactions Status */}
            <div className="mt-4 pt-3 border-t border-white/10">
              <div className="flex justify-between items-center mb-2">
                <h4 className="text-sm font-semibold text-gray-300">Financial Transactions</h4>
                <button
                  onClick={() => setShowFinancialPanel(true)}
                  className="text-xs text-blue-400 hover:text-blue-300 underline"
                >
                  Manage
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-white/5 rounded p-2 text-center">
                  <div className="text-[10px] text-gray-400">Driver</div>
                  <div className="text-sm font-bold text-white">
                    {financialStats.driver_earnings.pending > 0 && <span className="text-blue-400">{financialStats.driver_earnings.pending}P</span>}
                    {financialStats.driver_earnings.pending > 0 && financialStats.driver_earnings.failed > 0 && <span className="mx-1">/</span>}
                    {financialStats.driver_earnings.failed > 0 && <span className="text-red-400">{financialStats.driver_earnings.failed}F</span>}
                    {financialStats.driver_earnings.pending === 0 && financialStats.driver_earnings.failed === 0 && <span className="text-green-500">✓</span>}
                  </div>
                </div>
                <div className="bg-white/5 rounded p-2 text-center">
                  <div className="text-[10px] text-gray-400">Staff</div>
                  <div className="text-sm font-bold text-white">
                    {financialStats.staff_payments.pending > 0 && <span className="text-blue-400">{financialStats.staff_payments.pending}P</span>}
                    {financialStats.staff_payments.pending > 0 && financialStats.staff_payments.failed > 0 && <span className="mx-1">/</span>}
                    {financialStats.staff_payments.failed > 0 && <span className="text-red-400">{financialStats.staff_payments.failed}F</span>}
                    {financialStats.staff_payments.pending === 0 && financialStats.staff_payments.failed === 0 && <span className="text-green-500">✓</span>}
                  </div>
                </div>
                <div className="bg-white/5 rounded p-2 text-center">
                  <div className="text-[10px] text-gray-400">Expenses</div>
                  <div className="text-sm font-bold text-white">
                    {financialStats.shift_expenses.pending > 0 && <span className="text-blue-400">{financialStats.shift_expenses.pending}P</span>}
                    {financialStats.shift_expenses.pending > 0 && financialStats.shift_expenses.failed > 0 && <span className="mx-1">/</span>}
                    {financialStats.shift_expenses.failed > 0 && <span className="text-red-400">{financialStats.shift_expenses.failed}F</span>}
                    {financialStats.shift_expenses.pending === 0 && financialStats.shift_expenses.failed === 0 && <span className="text-green-500">✓</span>}
                  </div>
                </div>
              </div>
            </div>


            {/* Order Routing Info */}
            <OrderSyncRouteIndicator />

            {/* Error Message */}
            {syncStatus.error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3">
                <div className="flex items-start gap-2">
                  <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div>
                    <div className="text-sm font-semibold text-red-400 mb-1">{t('sync.labels.error')}</div>
                    <div className="text-xs text-red-300">{syncStatus.error}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-2 pt-2 border-t border-white/10">
              <button
                onClick={handleForceSync}
                disabled={syncStatus.syncInProgress}
                className="flex-1 bg-gradient-to-r from-blue-500 to-blue-600 text-white py-2.5 px-4 rounded-xl text-sm font-semibold hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg shadow-blue-500/20"
              >
                <div className="flex items-center justify-center gap-2">
                  {syncStatus.syncInProgress ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <span>{t('sync.status.syncing')}</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <span>{t('sync.actions.forceSync')}</span>
                    </>
                  )}
                </div>
              </button>

              <button
                onClick={() => {
                  if (window.electronAPI?.openSyncLogs) {
                    window.electronAPI.openSyncLogs();
                  } else {
                    console.log('View Logs: Check browser console for sync logs');
                    alert(t('sync.messages.logsElectronOnly'));
                  }
                }}
                className="bg-white/10 text-white py-2.5 px-4 rounded-xl text-sm font-semibold hover:bg-white/20 transition-all duration-200 border border-white/10"
              >
                <div className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span>{t('sync.actions.viewLogs')}</span>
                </div>
              </button>
            </div>
          </div>
        </div>
      )
      }
      <FinancialSyncPanel
        isOpen={showFinancialPanel}
        onClose={() => setShowFinancialPanel(false)}
        onRefresh={() => {
          // Reload sync status when refresh happens in panel
          if ((window as any).electronAPI?.getSyncStatus) window.electronAPI.getSyncStatus().then((s: any) => setSyncStatus(s as any));
          if ((window as any).electronAPI?.getFinancialSyncStats) (window as any).electronAPI.getFinancialSyncStats().then((s: any) => setFinancialStats(s));
        }}
      />
    </div >
  );
};
