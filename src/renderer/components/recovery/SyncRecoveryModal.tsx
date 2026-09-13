import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
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
  const { t, i18n } = useTranslation();
  const bridge = getBridge();
  const syncQueue = getSyncQueueBridge();
  const [loading, setLoading] = useState(true);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const contextKey = JSON.stringify(initialContext?.systemHealth?.terminalContext ?? null);
  const [snapshotContextKey, setSnapshotContextKey] = useState<string | null>(null);
  const hasCurrentSnapshot = hasSnapshot && snapshotContextKey === contextKey;
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
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
  const [loadFailed, setLoadFailed] = useState(false);
  const loadRequestIdRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogTitleId = useId();

  const loadRecoveryState = async () => {
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    try {
      const [
        nextSystemHealth,
        nextFinancialItems,
        nextIntegrity,
        nextParityItems,
        nextRecentActions,
      ] = await Promise.all([
        bridge.diagnostics.getSystemHealth(),
        bridge.sync.getFailedFinancialItems(250),
        bridge.sync.validateFinancialIntegrity(),
        syncQueue.listItems({ limit: 250 }),
        bridge.recovery.listActionLog(25).catch(() => []),
      ]);

      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      if (!nextSystemHealth || !Array.isArray(nextFinancialItems) ||
          !nextIntegrity || !Array.isArray(nextIntegrity.issues) ||
          !Array.isArray(nextParityItems)) {
        throw new Error('Incomplete recovery diagnostics');
      }

      setLoadFailed(false);
      setHasSnapshot(true);
      setSnapshotContextKey(contextKey);
      setLastCheckedAt(new Date().toISOString());
      setSystemHealth(nextSystemHealth);
      setLastParitySync(nextSystemHealth.lastParitySync ?? null);
      setFinancialItems(Array.isArray(nextFinancialItems) ? nextFinancialItems : []);
      setIntegrity(nextIntegrity ?? EMPTY_INTEGRITY_RESULT);
      setParityItems(Array.isArray(nextParityItems) ? nextParityItems : []);
      setRecentActions(Array.isArray(nextRecentActions) ? nextRecentActions : []);
    } catch (error) {
      if (requestId !== loadRequestIdRef.current) {
        return;
      }
      console.error('[SyncRecoveryModal] Failed to load recovery state:', error);
      // A failed refresh must not erase the last known diagnostics: doing so
      // would make a genuine, still-open sync problem silently disappear from
      // the guidance shown to staff. Keep whatever was last loaded and only
      // flag that the latest refresh could not be confirmed.
      setLoadFailed(true);
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!isOpen) {
      // Invalidate any in-flight load so a late response never applies state
      // after the modal has been closed.
      loadRequestIdRef.current += 1;
      setHasSnapshot(false);
      return;
    }

    setSystemHealth(initialContext?.systemHealth ?? null);
    setLastParitySync(initialContext?.lastParitySync ?? null);
    setHasSnapshot(false);
    setFinancialItems([]);
    setIntegrity(EMPTY_INTEGRITY_RESULT);
    setParityItems([]);
    setRecentActions([]);
    setLastCheckedAt(null);
    setLoadFailed(false);
    void loadRecoveryState();
  }, [initialContext, isOpen]);

  useEffect(
    () => () => {
      loadRequestIdRef.current += 1;
    },
    [],
  );

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

  const rawParityDiagnostic =
    lastParitySync?.status === 'failed'
      ? lastParitySync.error || lastParitySync.reason || null
      : null;

  const handleOpenSnapshots = () => {
    onClose();
    onOpenSnapshots?.();
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const previousFocus = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const openDialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
      if (openDialogs.at(-1) !== dialog) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          element.getAttribute('aria-hidden') !== 'true' && element.offsetParent !== null,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      window.setTimeout(() => {
        const remainingDialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
        const topDialog = remainingDialogs.at(-1);
        if (!topDialog || (previousFocus && topDialog.contains(previousFocus))) {
          previousFocus?.isConnected ? previousFocus.focus() : undefined;
        }
      }, 0);
    };
  }, [isOpen, onClose]);

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
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={dialogTitleId}
          tabIndex={-1}
          className="liquid-glass-modal-shell flex w-full flex-col overflow-hidden rounded-[32px]"
          style={{ width: 'min(1180px, calc(100vw - 32px))', maxHeight: '88vh' }}
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b liquid-glass-modal-border px-4 py-3 sm:px-6">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                {t('sync.health.label', { defaultValue: 'Sync health' })}
              </div>
              <h2
                id={dialogTitleId}
                className="mt-2 text-2xl font-black tracking-tight text-slate-900 dark:text-white"
              >
                {t('sync.recoveryCenter.guidedTitle', { defaultValue: 'Sync recovery assistant' })}
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                ref={closeButtonRef}
                type="button"
                onClick={onClose}
                className="liquid-glass-modal-button min-h-[44px] min-w-[44px] rounded-2xl p-2 transition-transform active:scale-95"
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

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide px-4 py-4 sm:px-6">

            {loadFailed && (
              <div
                role="status"
                className="mb-5 rounded-[22px] border border-amber-200/90 bg-amber-50/90 px-4 py-4 text-sm text-amber-800 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100"
              >
                {hasCurrentSnapshot
                  ? t('sync.recoveryCenter.staleData', {
                      defaultValue:
                        'Showing the last known sync status. The most recent refresh failed, so try again shortly.',
                    })
                  : t('sync.recoveryCenter.loadFailed', {
                      defaultValue:
                        "Sync status could not be loaded. This does not mean sync is healthy — try refreshing.",
                    })}
              </div>
            )}

            {!hasCurrentSnapshot && !loadFailed ? (
              <div role="status" className="flex min-h-32 items-center justify-center gap-3 text-slate-700 dark:text-slate-200">
                <RefreshCw className="h-6 w-6 animate-spin" />
                {t('sync.healthModal.loading.message')}
              </div>
            ) : !hasCurrentSnapshot ? null : (
              <RecoveryCenterPanel
                issues={issueResult.issues}
                recentActions={recentActions}
                terminalContext={systemHealth?.terminalContext ?? null}
                onRefresh={loadRecoveryState}
                diagnosticsStale={loadFailed || loading}
                onNavigate={onClose}
                onActionResolved={(entry) =>
                  setRecentActions((current) => [entry, ...current].slice(0, 8))
                }
              />
            )}
            <details className="mt-4 rounded-2xl border liquid-glass-modal-border text-slate-700 dark:text-slate-200">
              <summary className="min-h-[44px] cursor-pointer px-4 py-3 text-sm font-semibold">{t('sync.recoveryCenter.showTechnicalDetails')}</summary>
              <div className="space-y-3 px-4 pb-4">
                {rawParityDiagnostic && <pre className="whitespace-pre-wrap break-all text-xs">{rawParityDiagnostic.match(/CUSTOMER_ADDRESS_DEFAULT_(?:CONFLICT|RETRY)|idx_customer_addresses_default_unique/)?.[0] ?? t('sync.healthModal.failure.safeError')}</pre>}
                {onOpenSnapshots && <button type="button" onClick={handleOpenSnapshots} className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border liquid-glass-modal-border px-3 text-sm"><FolderOpen className="h-4 w-4" />{t('sync.recoveryCenter.openSnapshots')}</button>}
              </div>
            </details>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t liquid-glass-modal-border px-4 py-3 sm:px-6">
            <p className="text-xs text-slate-600 dark:text-slate-300">{lastCheckedAt ? t('sync.healthModal.lastChecked', {value: new Date(lastCheckedAt).toLocaleString(i18n?.resolvedLanguage || i18n?.language)}) : t('sync.healthModal.notCheckedYet')}</p>
            <button type="button" onClick={() => void loadRecoveryState()} disabled={loading} aria-busy={loading} className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border liquid-glass-modal-border px-4 text-sm font-semibold text-slate-700 disabled:opacity-50 dark:text-slate-100"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />{t('common.actions.refresh')}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default SyncRecoveryModal;
