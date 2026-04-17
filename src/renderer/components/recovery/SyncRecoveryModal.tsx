import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  getBridge,
  type DiagnosticsLastParitySync,
  type DiagnosticsSystemHealth,
  type RecoveryActionLogEntry,
  type SyncFinancialIntegrityResponse,
} from '../../../lib';
import { getSyncQueueBridge } from '../../services/SyncQueueBridge';
import { RecoveryCenterPanel } from './RecoveryCenterPanel';
import {
  buildSyncRecoveryIssues,
  type BuildSyncRecoveryIssuesResult,
} from './sync-recovery-issues';

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

const EMPTY_INTEGRITY_RESULT: SyncFinancialIntegrityResponse = {
  valid: true,
  issues: [],
};

export const SyncRecoveryModal: React.FC<SyncRecoveryModalProps> = ({
  isOpen,
  onClose,
  initialContext,
  onOpenSnapshots,
}) => {
  const { t } = useTranslation();
  const bridge = getBridge();
  const syncQueue = getSyncQueueBridge();
  const [loading, setLoading] = useState(false);
  const [systemHealth, setSystemHealth] = useState<DiagnosticsSystemHealth | null>(
    initialContext?.systemHealth ?? null,
  );
  const [lastParitySync, setLastParitySync] = useState<DiagnosticsLastParitySync | null>(
    initialContext?.lastParitySync ?? null,
  );
  const [financialItems, setFinancialItems] = useState<
    Awaited<ReturnType<typeof bridge.sync.getFailedFinancialItems>>
  >([]);
  const [integrity, setIntegrity] = useState<SyncFinancialIntegrityResponse>(
    EMPTY_INTEGRITY_RESULT,
  );
  const [parityItems, setParityItems] = useState<
    Awaited<ReturnType<typeof syncQueue.listItems>>
  >([]);
  const [recentActions, setRecentActions] = useState<RecoveryActionLogEntry[]>([]);

  const loadRecoveryState = async () => {
    setLoading(true);
    try {
      const [
        nextSystemHealth,
        nextFinancialItems,
        nextIntegrity,
        nextParityItems,
      ] = await Promise.all([
        bridge.diagnostics.getSystemHealth(),
        bridge.sync.getFailedFinancialItems(250),
        bridge.sync.validateFinancialIntegrity(),
        syncQueue.listItems({ limit: 250 }),
      ]);

      setSystemHealth(nextSystemHealth);
      setLastParitySync(nextSystemHealth.lastParitySync ?? initialContext?.lastParitySync ?? null);
      setFinancialItems(Array.isArray(nextFinancialItems) ? nextFinancialItems : []);
      setIntegrity(nextIntegrity ?? EMPTY_INTEGRITY_RESULT);
      setParityItems(Array.isArray(nextParityItems) ? nextParityItems : []);
    } catch (error) {
      console.error('[SyncRecoveryModal] Failed to load recovery state:', error);
      setIntegrity(EMPTY_INTEGRITY_RESULT);
      setFinancialItems([]);
      setParityItems([]);
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
    setRecentActions([]);
    void loadRecoveryState();
  }, [initialContext, isOpen]);

  const issueResult: BuildSyncRecoveryIssuesResult = useMemo(
    () =>
      buildSyncRecoveryIssues({
        systemHealth,
        lastParitySync,
        parityItems,
        financialItems,
        integrity,
      }),
    [financialItems, integrity, lastParitySync, parityItems, systemHealth],
  );

  const headerSubtitle =
    lastParitySync?.status === 'failed'
      ? lastParitySync.error || lastParitySync.reason
      : t('sync.recoveryCenter.subtitle', {
          defaultValue:
            'Uses the same sync-health diagnostics and adds guided repair actions for the visible problems.',
        });

  const handleOpenSnapshots = () => {
    onClose();
    onOpenSnapshots?.();
  };

  if (!isOpen || typeof document === 'undefined') {
    return null;
  }

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[10040] px-4 py-6 sm:px-6 sm:py-8"
      style={{ isolation: 'isolate' }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />

      <div className="relative z-[10050] flex h-full items-center justify-center">
        <div
          className="liquid-glass-modal-shell flex w-full flex-col overflow-hidden rounded-[32px]"
          style={{ width: 'min(1180px, calc(100vw - 32px))', maxHeight: '88vh' }}
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
                onClick={() => void loadRecoveryState()}
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

          <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            <div className="mb-5 rounded-[22px] border border-sky-200/90 bg-sky-50/90 px-4 py-4 text-sm text-sky-800 dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-100">
              {t('sync.recoveryCenter.contextNote', {
                defaultValue:
                  'This recovery view stays in sync with the same blockers shown by the sync explanation panel.',
              })}
            </div>

            {loading && !systemHealth ? (
              <div className="flex h-56 items-center justify-center">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-blue-500/30 border-t-blue-500" />
              </div>
            ) : (
              <RecoveryCenterPanel
                issues={issueResult.issues}
                recentActions={recentActions}
                terminalContext={systemHealth?.terminalContext ?? null}
                onRefresh={loadRecoveryState}
                onNavigate={onClose}
                onActionResolved={(entry) =>
                  setRecentActions((current) => [entry, ...current].slice(0, 8))
                }
              />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default SyncRecoveryModal;
