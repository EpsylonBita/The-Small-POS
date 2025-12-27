import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
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

  const normalizeStatus = (status: any): SyncStatus => {
    if (!status) {
      return {
        isOnline: navigator.onLine,
        lastSync: null,
        pendingItems: 0,
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
      isOnline: typeof status.isOnline === 'boolean' ? status.isOnline : navigator.onLine,
      lastSync: status.lastSync ?? null,
      pendingItems: typeof status.pendingItems === 'number' ? status.pendingItems : 0,
      syncInProgress: !!status.syncInProgress,
      error: status.error ?? null,
      terminalHealth: typeof status.terminalHealth === 'number' ? status.terminalHealth : 80,
      settingsVersion: typeof status.settingsVersion === 'number' ? status.settingsVersion : 0,
      menuVersion: typeof status.menuVersion === 'number' ? status.menuVersion : 0,
      pendingPaymentItems: typeof status.pendingPaymentItems === 'number' ? status.pendingPaymentItems : 0,
      failedPaymentItems: typeof status.failedPaymentItems === 'number' ? status.failedPaymentItems : 0,
    };
  };

  useEffect(() => {
    console.log('SyncStatusIndicator: mount');

    // Get initial sync status
    const loadSyncStatus = async () => {
      try {
        if (window.electronAPI && typeof window.electronAPI.getSyncStatus === 'function') {
          const status = await window.electronAPI.getSyncStatus();
          console.log('SyncStatusIndicator: initial status', status);
          setSyncStatus(normalizeStatus(status));
        } else {
          console.warn('getSyncStatus is not available');
        }

        if ((window as any).electronAPI && typeof (window as any).electronAPI.getFinancialSyncStats === 'function') {
          const stats = await (window as any).electronAPI.getFinancialSyncStats();
          setFinancialStats(stats);
        } else {
          console.warn('getFinancialSyncStats is not available');
        }
      } catch (error) {
        console.error('Failed to load sync status:', error);
      }
    };

    loadSyncStatus();

    // Listen for sync status updates
    const handleSyncStatusUpdate = async (status: any) => {
      console.log('SyncStatusIndicator: sync:status event', status);
      setSyncStatus(normalizeStatus(status));

      // Also reload financial stats when sync status updates
      try {
        if ((window as any).electronAPI && typeof (window as any).electronAPI.getFinancialSyncStats === 'function') {
          const stats = await (window as any).electronAPI.getFinancialSyncStats();
          setFinancialStats(stats);
        }
      } catch (err) {
        console.error('Failed to reload financial stats on sync update:', err);
      }
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

    // Refresh status and financial stats every 30 seconds
    const interval = setInterval(async () => {
      await loadSyncStatus();
    }, 30000);

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
      if (window.electronAPI && typeof window.electronAPI.forceSync === 'function') {
        setSyncStatus(prev => ({ ...prev, syncInProgress: true }));

        await window.electronAPI.forceSync();

        // Show success message
        toast.success(t('sync.messages.syncComplete') || 'Sync completed');

        // Reload status and financial stats after sync
        setTimeout(async () => {
          try {
            if (window.electronAPI && typeof window.electronAPI.getSyncStatus === 'function') {
              const status = await window.electronAPI.getSyncStatus();
              setSyncStatus(normalizeStatus(status));
            }

            if ((window as any).electronAPI && typeof (window as any).electronAPI.getFinancialSyncStats === 'function') {
              const stats = await (window as any).electronAPI.getFinancialSyncStats();
              console.log('Financial stats after sync:', stats);
              setFinancialStats(stats);
            }
          } catch (err) {
            console.error('Failed to reload sync status:', err);
          }
        }, 2000); // Increased timeout to give sync more time to complete
      } else {
        toast.error(t('sync.messages.forceSyncElectronOnly') || 'Sync is only available in Electron mode');
      }
    } catch (error) {
      console.error('Failed to force sync:', error);
      toast.error(t('sync.messages.syncFailed') || 'Sync failed');
      setSyncStatus(prev => ({ ...prev, syncInProgress: false }));
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

      {/* Detail Panel - Centered Modal */}
      {showDetailPanel && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-[1000] liquid-glass-modal-backdrop"
            onClick={() => setShowDetailPanel(false)}
          />

          {/* Modal */}
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 liquid-glass-modal-shell w-full max-w-2xl max-h-[90vh] overflow-y-auto z-[1050]">
            <div className="p-6 space-y-6">
              {/* Header */}
              <div className="flex items-center justify-between pb-4 border-b liquid-glass-modal-border">
                <div className="flex items-center gap-3">
                  <svg
                    className={`w-6 h-6 ${isSynced ? 'text-green-400' : 'text-red-400'}`}
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
                  </svg>
                  <h3 className="text-2xl font-bold liquid-glass-modal-text">{t('sync.labels.syncStatus')}</h3>
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
              <div className="liquid-glass-modal-card">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm liquid-glass-modal-text-muted">{t('sync.labels.connection')}</span>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${syncStatus.isOnline ? 'bg-green-400' : 'bg-red-400'} ${syncStatus.isOnline ? 'animate-pulse' : ''}`}></div>
                    <span className={`text-sm font-semibold ${syncStatus.isOnline ? 'text-green-400' : 'text-red-400'}`}>
                      {syncStatus.isOnline ? t('sync.labels.online') : t('sync.labels.offline')}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm liquid-glass-modal-text-muted">{t('sync.labels.lastSync')}</span>
                  <span className="text-sm font-medium liquid-glass-modal-text">
                    {formatLastSync()}
                  </span>
                </div>

                {/* Terminal Type Info */}
                <div className="flex items-center justify-between pt-3 border-t liquid-glass-modal-border">
                  <span className="text-sm liquid-glass-modal-text-muted">
                    {t('terminal.labels.terminalType', 'Terminal Type')}
                  </span>
                  <span
                    className={`text-sm font-semibold ${isMobileWaiter ? 'text-blue-400' : 'text-green-400'
                      }`}
                  >
                    {isMobileWaiter ? t('terminal.type.mobile_waiter', 'Mobile POS') : t('terminal.type.main', 'Κεντρικό Τερματικό')}
                  </span>
                </div>

                {/* Parent Terminal (for mobile waiter) */}
                {isMobileWaiter && parentTerminalId && (
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-sm liquid-glass-modal-text-muted">
                      {t('terminal.labels.parentTerminal', 'Parent Terminal')}
                    </span>
                    <span className="text-sm font-medium liquid-glass-modal-text font-mono">
                      {parentTerminalId.substring(0, 8)}...
                    </span>
                  </div>
                )}
              </div>

              {/* Sync Details Grid */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div className="liquid-glass-modal-card p-3">
                  <div className="text-xs liquid-glass-modal-text-muted mb-1">{t('sync.labels.pending')}</div>
                  <div className="text-2xl font-bold liquid-glass-modal-text">{syncStatus.pendingItems}</div>
                </div>

                <div className="liquid-glass-modal-card p-3">
                  <div className="text-xs liquid-glass-modal-text-muted mb-1">{t('sync.labels.health')}</div>
                  <div className={`text-2xl font-bold ${syncStatus.terminalHealth >= 80 ? 'text-green-400' :
                    syncStatus.terminalHealth >= 60 ? 'text-yellow-400' : 'text-red-400'
                    }`}>
                    {Math.round(syncStatus.terminalHealth)}%
                  </div>
                </div>

                <div className="liquid-glass-modal-card p-3">
                  <div className="text-xs liquid-glass-modal-text-muted mb-1">{t('sync.labels.settings')}</div>
                  <div className="text-lg font-semibold liquid-glass-modal-text">v{syncStatus.settingsVersion}</div>
                </div>

                <div className="liquid-glass-modal-card p-3">
                  <div className="text-xs liquid-glass-modal-text-muted mb-1">{t('sync.labels.menu')}</div>
                  <div className="text-lg font-semibold liquid-glass-modal-text">v{syncStatus.menuVersion}</div>
                </div>

                <div className="liquid-glass-modal-card p-3">
                  <div className="text-xs liquid-glass-modal-text-muted mb-1">{t('sync.labels.pendingPayments')}</div>
                  <div className="text-lg font-semibold liquid-glass-modal-text">{syncStatus.pendingPaymentItems}</div>
                </div>

                <div className="liquid-glass-modal-card p-3">
                  <div className="text-xs liquid-glass-modal-text-muted mb-1">{t('sync.labels.failedPayments')}</div>
                  <div className={`text-lg font-semibold ${syncStatus.failedPaymentItems > 0 ? 'text-red-400' : 'liquid-glass-modal-text'}`}>
                    {syncStatus.failedPaymentItems}
                  </div>
                </div>
              </div>

              {/* Financial Transactions Status */}
              <div className="pt-4 border-t liquid-glass-modal-border">
                <div className="flex justify-between items-center mb-3">
                  <h4 className="text-sm font-semibold liquid-glass-modal-text">{t('sync.financial.title')}</h4>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        try {
                          if ((window as any).electronAPI && typeof (window as any).electronAPI.getFinancialSyncStats === 'function') {
                            const stats = await (window as any).electronAPI.getFinancialSyncStats();
                            console.log('Manual refresh - Financial stats:', stats);
                            setFinancialStats(stats);
                            toast.success('Ανανεώθηκε');
                          }
                        } catch (err) {
                          console.error('Failed to refresh financial stats:', err);
                          toast.error('Αποτυχία ανανέωσης');
                        }
                      }}
                      className="text-xs text-green-400 hover:text-green-300 underline"
                      title="Ανανέωση"
                    >
                      ↻
                    </button>
                    <button
                      onClick={() => setShowFinancialPanel(true)}
                      className="text-xs text-blue-400 hover:text-blue-300 underline"
                    >
                      {t('sync.actions.manage')}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="liquid-glass-modal-card p-2 text-center">
                    <div className="text-[10px] liquid-glass-modal-text-muted">{t('sync.financial.driver')}</div>
                    <div className="text-xs font-bold liquid-glass-modal-text">
                      {financialStats.driver_earnings.pending > 0 && (
                        <div className="text-blue-400">
                          {financialStats.driver_earnings.pending} {t('sync.financial.pending')}
                        </div>
                      )}
                      {financialStats.driver_earnings.failed > 0 && (
                        <div className="text-red-400">
                          {financialStats.driver_earnings.failed} {t('sync.financial.failed')}
                        </div>
                      )}
                      {financialStats.driver_earnings.pending === 0 && financialStats.driver_earnings.failed === 0 && (
                        <span className="text-green-500">✓ {t('sync.financial.complete')}</span>
                      )}
                    </div>
                  </div>
                  <div className="liquid-glass-modal-card p-2 text-center">
                    <div className="text-[10px] liquid-glass-modal-text-muted">{t('sync.financial.staff')}</div>
                    <div className="text-xs font-bold liquid-glass-modal-text">
                      {financialStats.staff_payments.pending > 0 && (
                        <div className="text-blue-400">
                          {financialStats.staff_payments.pending} {t('sync.financial.pending')}
                        </div>
                      )}
                      {financialStats.staff_payments.failed > 0 && (
                        <div className="text-red-400">
                          {financialStats.staff_payments.failed} {t('sync.financial.failed')}
                        </div>
                      )}
                      {financialStats.staff_payments.pending === 0 && financialStats.staff_payments.failed === 0 && (
                        <span className="text-green-500">✓ {t('sync.financial.complete')}</span>
                      )}
                    </div>
                  </div>
                  <div className="liquid-glass-modal-card p-2 text-center">
                    <div className="text-[10px] liquid-glass-modal-text-muted">{t('sync.financial.expenses')}</div>
                    <div className="text-xs font-bold liquid-glass-modal-text">
                      {financialStats.shift_expenses.pending > 0 && (
                        <div className="text-blue-400">
                          {financialStats.shift_expenses.pending} {t('sync.financial.pending')}
                        </div>
                      )}
                      {financialStats.shift_expenses.failed > 0 && (
                        <div className="text-red-400">
                          {financialStats.shift_expenses.failed} {t('sync.financial.failed')}
                        </div>
                      )}
                      {financialStats.shift_expenses.pending === 0 && financialStats.shift_expenses.failed === 0 && (
                        <span className="text-green-500">✓ {t('sync.financial.complete')}</span>
                      )}
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
              <div className="pt-4 border-t liquid-glass-modal-border">
                <button
                  onClick={handleForceSync}
                  disabled={syncStatus.syncInProgress}
                  className="w-full liquid-glass-modal-button bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
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
              </div>
            </div>
          </div>
        </>
      )}
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
