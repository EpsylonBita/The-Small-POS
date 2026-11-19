import { verifiedSupportReceipt } from '../services/support/SupportRemedyRunner';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle } from 'lucide-react';
import { SUPPORT_PROTOCOL_VERSION } from '../../../../shared/pos/support/protocol';
import { TillHealthButton, TillHealthWindow, type TillHealthOrderDetails } from './recovery/TillHealthWindow';
import { TillHealthConfirmation, TillHealthSupport } from './recovery/TillHealthSupport';
import { useTillHealthActions } from './recovery/useTillHealthActions';
import { useTillHealthReports } from './recovery/useTillHealthReports';
import { buildTillHealthCards, OPEN_TILL_HEALTH, safeOrderNumber, tillHealthState, tillHealthTone, type TillHealthOpenContext, type TillHealthState } from './recovery/till-health-model';
import { FinancialSyncPanel } from './FinancialSyncPanel';
import { supportSessionLive, useSupportSession } from '../hooks/useSupportSession';
import { registerSupportHealthObservation } from '../services/support/SupportMatcherBridge';
import {
  buildSyncRecoveryIssues,
  orderRecoveryIssues,
} from './recovery/sync-recovery-issues';
import { useBlockerRegistration } from '../hooks/useBlockerRegistration';
import { useFeatures } from '../hooks/useFeatures';
import { useShift } from '../contexts/shift-context';
import { useEndOfDayStatus } from '../hooks/useEndOfDayStatus';
import { useSystemClock } from '../hooks/useSystemClock';
import { formatCurrency, formatDateTime, formatNumber } from '../utils/format';
import { isPosDayOpenTooLong } from '../utils/pos-day-open';
import { cn } from '../utils/cn';
import { liquidGlassModalTone } from '../styles/designSystem';
import { readRemoteSupportUnavailable } from '../support/adapters';
import {
  getLocalizedPaymentBlockerFix,
  getLocalizedPaymentBlockerReason,
} from '../../lib/payment-integrity';
import {
  getBridge,
  offEvent,
  onEvent,
  type DiagnosticsCredentialState,
  type DiagnosticsFinancialQueueStatus,
  type DiagnosticsLastParitySync,
  type DiagnosticsSystemHealth,
  type DiagnosticsExportOptions,
  type RemoteIncidentReportResponse,
  type RecoveryActionLogEntry,
  type SyncFinancialIntegrityResponse,
  type UnsettledPaymentBlocker,
} from '../../lib';
import {
  PARITY_QUEUE_STATUS_EVENT,
  PARITY_SYNC_STATUS_EVENT,
  REALTIME_STATUS_EVENT,
  type ParitySyncSnapshot,
  runParitySyncCycle,
} from '../services/ParitySyncCoordinator';
import type {
  QueueCapacityWarning,
  QueueStatus,
  SyncQueueItem,
} from '../../../../shared/pos/sync-queue-types';
import {
  type HealthAvailability,
  type HealthPrimaryActionId,
  type HealthProblemCode,
} from '../../../../shared/pos/health/health-contract';
import {
  SYNC_PROBLEMS,
  buildSimpleHealthSummary,
  countDesktopBacklog,
  countDesktopPrinterFailures,
  desktopPrintQueueSignal,
  isPrintingStallActive,
  judgeSyncAttempt,
  resolveSupportStatus,
  type HealthSignalExtras,
} from '../../../../shared/pos/health/health-summary';
import {
  classifyParityQueueItem,
  parseQueueTimestampMs,
  summarizeStuckRows,
} from '../../../../shared/pos/health/queue-classification';
import {
  closeoutStatusLabelKey,
  summarizeCloseout,
  type CloseoutBlockerInput,
} from '../../../../shared/pos/health/closeout-blockers';
import { buildHealthView } from '../../../../shared/pos/health/diagnostics-bundle';
import { sanitizeOperationalError } from '../../../../shared/pos/health/diagnostics-redaction';
import { healthDuration } from '../../../../shared/pos/health/health-i18n';
import { buildIncomingOrderAlertSupportEvidence } from '../services/incomingOrderAlert';
import { getSyncQueueBridge, type MadeDueRow } from '../services/SyncQueueBridge';
import {
  rowsWaitingOutRetry,
  syncNowIssueCode,
  syncNowRemainder,
  syncNowTargetItems,
  syncNowTargetOutcomes,
} from './recovery/sync-now-attempt';
import type { SubscriptionConnectionStatus } from '../services/RealtimeManager';
import { isPrivilegedConfirmationCancelled, privilegedActionFeedback } from '../utils/privileged-actions';
import { usePrivilegedActionConfirmation } from '../hooks/usePrivilegedActionConfirmation';
import type {
  LocalZWaitsFor,
  ZGateHealth,
  ZGateRefusedRow,
} from '../../lib/ipc-adapter';

export { buildSimpleHealthSummary };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyncStatus {
  isOnline: boolean;
  lastSync: string | null;
  pendingItems: number;
  queuedRemote: number;
  historicalZReportConflicts: number;
  backpressureDeferred: number;
  oldestNextRetryAt: string | null;
  syncInProgress: boolean;
  error: string | null;
  terminalHealth: number;
  settingsVersion: number;
  menuVersion: number;
  pendingPaymentItems: number;
  failedPaymentItems: number;
  lastQueueFailure: QueueFailureInfo | null;
}

interface ParityQueueSnapshot {
  pending: number;
  failed: number;
  conflicts: number;
  total: number;
  oldestItemAge: number | null;
}

interface SyncStatusIndicatorProps {
  className?: string;
  showDetails?: boolean;
  onHealthState?: (state: TillHealthState) => void;
  /** 'rail' (founder 31/10): stacked in the right utility rail; offline and backlog become icons. */
  layout?: 'inline' | 'rail';
}

type QueueFailureClassification =
  | 'backpressure'
  | 'transient'
  | 'permanent'
  | 'unknown';

interface QueueFailureInfo {
  queueId: number;
  entityType: string;
  entityId: string;
  operation: string;
  status: string;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
  lastError: string;
  classification: QueueFailureClassification;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createDefaultFinancialStats = (): DiagnosticsFinancialQueueStatus => ({
  driver_earnings: { pending: 0, failed: 0 },
  staff_payments: { pending: 0, failed: 0 },
  shift_expenses: { pending: 0, failed: 0 },
});

const normalizeFinancialStats = (stats: any): DiagnosticsFinancialQueueStatus => {
  if (!stats || typeof stats !== 'object') return createDefaultFinancialStats();
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

const toTimestamp = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

const STALE_TELEMETRY_MS = 10 * 60 * 1000;
const HEALTH_SNAPSHOT_FRESH_MS = 10 * 60 * 1000;

const toDateString = (value: any): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const normalizeQueueFailure = (value: any): QueueFailureInfo | null => {
  if (!value || typeof value !== 'object') return null;
  const classificationRaw =
    typeof value.classification === 'string'
      ? value.classification.toLowerCase()
      : 'unknown';
  const classification: QueueFailureClassification =
    classificationRaw === 'backpressure' ||
    classificationRaw === 'transient' ||
    classificationRaw === 'permanent'
      ? classificationRaw
      : 'unknown';

  const queueId =
    typeof value.queueId === 'number'
      ? value.queueId
      : typeof value.id === 'number'
        ? value.id
        : 0;
  const entityType =
    typeof value.entityType === 'string'
      ? value.entityType
      : typeof value.entity_type === 'string'
        ? value.entity_type
        : '';
  const entityId =
    typeof value.entityId === 'string'
      ? value.entityId
      : typeof value.entity_id === 'string'
        ? value.entity_id
        : '';
  const operation =
    typeof value.operation === 'string' ? value.operation : 'unknown';
  const status = typeof value.status === 'string' ? value.status : 'unknown';
  const retryCount =
    typeof value.retryCount === 'number'
      ? value.retryCount
      : typeof value.retry_count === 'number'
        ? value.retry_count
        : 0;
  const maxRetries =
    typeof value.maxRetries === 'number'
      ? value.maxRetries
      : typeof value.max_retries === 'number'
        ? value.max_retries
        : 0;
  const nextRetryAt = toDateString(value.nextRetryAt ?? value.next_retry_at);
  const lastError =
    typeof value.lastError === 'string'
      ? value.lastError
      : typeof value.last_error === 'string'
        ? value.last_error
        : '';

  if (!entityType || !entityId || !lastError) return null;
  return {
    queueId,
    entityType,
    entityId,
    operation,
    status,
    retryCount,
    maxRetries,
    nextRetryAt,
    lastError,
    classification,
  };
};

const normalizeStatus = (status: any): SyncStatus => {
  if (!status) {
    return {
      isOnline: getNavigatorOnline(),
      lastSync: null,
      pendingItems: 0,
      queuedRemote: 0,
      historicalZReportConflicts: 0,
      backpressureDeferred: 0,
      oldestNextRetryAt: null,
      syncInProgress: false,
      error: null,
      terminalHealth: 80,
      settingsVersion: 0,
      menuVersion: 0,
      pendingPaymentItems: 0,
      failedPaymentItems: 0,
      lastQueueFailure: null,
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
    historicalZReportConflicts: coerceNumber(
      status.historicalZReportConflicts,
      0,
    ),
    backpressureDeferred: coerceNumber(status.backpressureDeferred, 0),
    oldestNextRetryAt: toDateString(status.oldestNextRetryAt),
    syncInProgress: !!status.syncInProgress,
    error: typeof status.error === 'string' ? status.error : null,
    terminalHealth: normalizeHealth(status.terminalHealth),
    settingsVersion: coerceNumber(status.settingsVersion, 0),
    menuVersion: coerceNumber(status.menuVersion, 0),
    pendingPaymentItems: coerceNumber(status.pendingPaymentItems, 0),
    failedPaymentItems: coerceNumber(status.failedPaymentItems, 0),
    lastQueueFailure: normalizeQueueFailure(status.lastQueueFailure),
  };
};

const normalizeParityQueueStatus = (status: QueueStatus | null | undefined): ParityQueueSnapshot => ({
  pending: coerceNumber(status?.pending, 0),
  failed: coerceNumber(status?.failed, 0),
  conflicts: coerceNumber(status?.conflicts, 0),
  total: coerceNumber(status?.total, 0),
  oldestItemAge:
    typeof status?.oldestItemAge === 'number'
      ? status.oldestItemAge
      : typeof (status as any)?.oldest_item_age === 'number'
        ? (status as any).oldest_item_age
        : null,
});

const normalizeCredentialState = (value: any): DiagnosticsCredentialState | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return {
    hasAdminUrl: !!value.hasAdminUrl,
    hasApiKey: !!value.hasApiKey,
  };
};

const normalizeLastParitySync = (
  value: DiagnosticsLastParitySync | ParitySyncSnapshot | null | undefined,
): DiagnosticsLastParitySync | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const finishedAt = toDateString(value.finishedAt);
  const startedAt =
    toDateString(value.startedAt) ?? finishedAt ?? new Date(0).toISOString();
  const queueStatus =
    value.queueStatus && typeof value.queueStatus === 'object'
      ? normalizeParityQueueStatus(value.queueStatus as QueueStatus)
      : null;

  return {
    status:
      value.status === 'started' ||
      value.status === 'completed' ||
      value.status === 'skipped_missing_credentials' ||
      value.status === 'failed'
        ? value.status
        : 'idle',
    trigger: typeof value.trigger === 'string' ? value.trigger : 'unknown',
    startedAt,
    finishedAt,
    processed: coerceNumber(value.processed, 0),
    failed: coerceNumber(value.failed, 0),
    conflicts: coerceNumber(value.conflicts, 0),
    remaining: coerceNumber(value.remaining, queueStatus?.total ?? 0),
    error: typeof value.error === 'string' ? value.error : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
    legacySyncTriggered: !!value.legacySyncTriggered,
    credentialState: normalizeCredentialState(value.credentialState) ?? undefined,
    queueStatus,
  };
};

const Z_GATE_ROW_KIND: Record<string, string> = {
  payments: 'payment',
  order_payments: 'payment',
  payment_adjustments: 'refund',
  driver_earnings: 'driverEarning',
  driver_earning: 'driverEarning',
  shift_expenses: 'expense',
  staff_payments: 'staffPayment',
  staff_order_cash_returns: 'cashReturn',
  staff_shifts: 'shift',
  cash_drawer_sessions: 'shift',
};

const Z_GATE_WAITS_FOR_DEFAULTS: Record<LocalZWaitsFor, string> = {
  earlier_z: 'It waits for the earlier closed day to reach the server first.',
  window_rows: 'It waits for {{count}} record(s) of that day to reach the server.',
  server_refusal: 'The server refused it. Contact support with the details below.',
  sending: 'It is sent at the next sync.',
  cleanup: 'The server confirmed it. Its data is cleaned from this till.',
};

const Z_GATE_KIND_DEFAULTS: Record<string, string> = {
  payment: 'Payment',
  refund: 'Refund or void',
  driverEarning: 'Driver earning',
  expense: 'Expense',
  staffPayment: 'Staff payment',
  cashReturn: 'Cash return',
  shift: 'Shift',
  record: 'Record',
};

/**
 * Health: the Zs closed on this till still waiting for the server, with what
 * each waits for, and every row the server refused for good that holds a Z.
 * "Set aside" asks the void-payments approval (a holder of the right on shift
 * with a fresh PIN, else that holder's own PIN) and keeps the record on this
 * till: it is never deleted, never sent again on its own, and every Z of its
 * day lists it as "not on the server". "Bring back" undoes it. A failed read
 * keeps the last good list, marked stale.
 */
export const ZGateSetAsidePanel: React.FC<{ className?: string; refreshEpoch?: number }> = ({ className, refreshEpoch }) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { runWithPrivilegedConfirmation, confirmationModal } = usePrivilegedActionConfirmation();
  const [health, setHealth] = useState<ZGateHealth | null>(null);
  const [stale, setStale] = useState(false);
  const [busyQueueId, setBusyQueueId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // A bridge without the command (an older native build, a partial test
  // double) has nothing to list.
  const supported = typeof bridge.recovery?.zGateSetAside === 'function';

  const load = useCallback(async () => {
    if (!supported) return;
    try {
      const result = await bridge.recovery.zGateSetAside({ action: 'list' });
      if (result?.success) {
        setHealth(result);
        setStale(false);
      } else {
        setStale(true);
      }
    } catch {
      setStale(true);
    }
  }, [bridge, supported]);

  useEffect(() => {
    void load();
  }, [load, refreshEpoch]);

  const handleAction = useCallback(
    async (row: ZGateRefusedRow) => {
      const action = row.setAside ? 'undo' : 'set_aside';
      setBusyQueueId(row.queueId);
      setMessage(null);
      try {
        const result = await runWithPrivilegedConfirmation<ZGateHealth>({
          scope: 'cash_drawer_control',
          action: () => bridge.recovery.zGateSetAside({ action, queueId: row.queueId }),
          title: t('sync.zGate.approvalTitle', { defaultValue: 'Approve with your PIN' }),
          subtitle: t('sync.zGate.approvalSubtitle', {
            defaultValue:
              'Setting a record aside needs the right to void payments. A staff member who has it enters their own PIN. Nothing is deleted or charged.',
          }),
          approvalSubtitle: t('sync.zGate.approvalSubtitle', {
            defaultValue:
              'Setting a record aside needs the right to void payments. A staff member who has it enters their own PIN. Nothing is deleted or charged.',
          }),
        });
        if (!result?.success || result.applied !== action || result.queueId !== row.queueId) {
          throw new Error('Z_GATE_CHANGE_UNVERIFIED');
        }
        const selected = result.refused.find(item => item.queueId === row.queueId);
        if (!selected || Boolean(selected.setAside) !== (action === 'set_aside')) {
          throw new Error('Z_GATE_CHANGE_UNVERIFIED');
        }
        setHealth(result);
        setStale(false);
        setMessage(
          action === 'undo'
            ? t('sync.zGate.undoDone', {
              defaultValue: 'This record is waiting to be sent again. It may hold up the Z until it is sent.',
            })
            : t('sync.zGate.setAsideDone', {
              defaultValue:
                'Set aside for review. The till keeps the record and lists it on the Z.',
            }),
        );
      } catch (error) {
        if (error instanceof Error && error.message === 'Z_GATE_CHANGE_UNVERIFIED') {
          setStale(true);
          void load();
        }
        if (!isPrivilegedConfirmationCancelled(error)) {
          setMessage(
            privilegedActionFeedback(error, t) ?? t('sync.zGate.actionFailed', {
              defaultValue: 'The change could not be confirmed. Check the list again.',
            }),
          );
        }
      } finally {
        setBusyQueueId(null);
      }
    },
    [bridge, load, runWithPrivilegedConfirmation, t],
  );

  const localZs = health?.localZs ?? [];
  const refused = health?.refused ?? [];
  if (!supported || (!health && !stale)) return null;
  if (health && localZs.length === 0 && refused.length === 0 && !message && !stale) return null;

  return (
    <section
      className={cn('pos-frost rounded-2xl border p-4', liquidGlassModalTone('warning'), className)}
      data-testid="z-gate-panel"
      aria-live="polite"
    >
      {stale && (
        <p className="mb-3 text-sm font-semibold" data-testid="z-gate-stale">
          {health
            ? t('sync.zGate.stale', {
              defaultValue: 'This list could not be read again. It shows the last good read.',
            })
            : t('sync.zGate.unavailable', {
              defaultValue: 'The days closed on this till could not be read. Try again.',
            })}
        </p>
      )}
      {localZs.length > 0 && (
        <div data-testid="z-gate-local-zs">
          <h4 className="text-base font-black">
            {t('sync.zGate.localTitle', {
              count: localZs.length,
              defaultValue: 'Days closed on this till, not on the server yet: {{count}}',
            })}
          </h4>
          <ul className="mt-2 space-y-2">
            {localZs.map((z) => (
              <li
                key={z.zReportId}
                className="rounded-xl border border-(--pos-s-border) p-3 text-sm"
                data-testid={`z-gate-local-z-${z.zReportId}`}
              >
                <p className="font-bold">
                  {t('sync.zGate.localDay', {
                    date: z.reportDate,
                    defaultValue: 'Day of {{date}}: closed on this till without a connection',
                  })}
                </p>
                <p className="mt-1">
                  {t(`sync.zGate.waits.${z.waitsFor}`, {
                    count: z.windowRowsPending,
                    defaultValue: Z_GATE_WAITS_FOR_DEFAULTS[z.waitsFor] ?? Z_GATE_WAITS_FOR_DEFAULTS.sending,
                  })}
                </p>
                {(z.errorCode || z.serverMessage) && (
                  <details className="mt-1 text-xs text-(--pos-s-muted)">
                    <summary className="min-h-touch cursor-pointer py-2">
                      {t('sync.zGate.details', { defaultValue: 'Details for support' })}
                    </summary>
                    <p className="break-all">{z.errorCode}</p>
                    {z.serverMessage && <p className="mt-1 break-words">{z.serverMessage}</p>}
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {refused.length > 0 && (
        <div className={cn(localZs.length > 0 && 'mt-4')} data-testid="z-gate-refused">
          <h4 className="text-base font-black">
            {t('sync.zGate.refusedTitle', {
              count: refused.length,
              defaultValue: 'Refused by the server: {{count}}',
            })}
          </h4>
          <p className="mt-1 text-sm">
            {t('sync.zGate.refusedIntro', {
              defaultValue:
                'The server refused these records for good, so they hold the day close. A manager can set one aside: it stays on this till, the Z lists it as not on the server, and it is never sent again on its own.',
            })}
          </p>
          <ul className="mt-2 space-y-2">
            {refused.map((row) => {
              const kind = Z_GATE_ROW_KIND[row.tableName] ?? 'record';
              const busy = busyQueueId === row.queueId;
              return (
                <li
                  key={row.queueId}
                  className="flex flex-col gap-2 rounded-xl border border-(--pos-s-border) p-3 text-sm sm:flex-row sm:items-start sm:justify-between"
                  data-testid={`z-gate-row-${row.queueId}`}
                >
                  <div className="min-w-0">
                    <p className="font-bold">
                      {t(`sync.zGate.kind.${kind}`, { defaultValue: Z_GATE_KIND_DEFAULTS[kind] })}
                      {typeof row.amountCents === 'number' && ` · ${formatCurrency(row.amountCents / 100)}`}
                    </p>
                    {row.serverMessage && <p className="mt-1 wrap-break-word">{row.serverMessage}</p>}
                    {row.setAside && (
                      <p className="mt-1 font-semibold">
                        {t('sync.zGate.setAsideState', {
                          defaultValue: 'Set aside: kept on this till, not on the server',
                        })}
                      </p>
                    )}
                    <details className="mt-1 text-xs text-(--pos-s-muted)">
                      <summary className="min-h-touch cursor-pointer py-2">
                        {t('sync.zGate.details', { defaultValue: 'Details for support' })}
                      </summary>
                      <p className="break-all">{row.errorCode || row.status}</p>
                      <p className="break-all">{row.recordId}</p>
                    </details>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleAction(row)}
                    disabled={busyQueueId !== null}
                    aria-busy={busy}
                    className="pos-raised inline-flex min-h-[48px] shrink-0 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-900 active:bg-slate-100 disabled:opacity-50 dark:border-white/15 dark:bg-white/[0.07] dark:text-white dark:active:bg-white/12"
                  >
                    {row.setAside
                      ? t('sync.zGate.undo', { defaultValue: 'Bring back' })
                      : t('sync.zGate.setAside', { defaultValue: 'Set aside' })}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {message && (
        <p className="mt-3 text-sm font-semibold" role="status" data-testid="z-gate-message">
          {message}
        </p>
      )}
      {confirmationModal}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SyncStatusIndicator: React.FC<SyncStatusIndicatorProps> = ({
  className = '',
  showDetails = false,
  onHealthState,
  layout = 'inline',
}) => {
  const inRail = layout === 'rail';
  const bridge = getBridge();
  const { t, i18n } = useTranslation();
  const { staff, isShiftActive } = useShift();

  // --- Sync state ---
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => ({
    isOnline: getNavigatorOnline(),
    lastSync: null,
    pendingItems: 0,
    queuedRemote: 0,
    historicalZReportConflicts: 0,
    backpressureDeferred: 0,
    oldestNextRetryAt: null,
    syncInProgress: false,
    error: null,
    terminalHealth: 80,
    settingsVersion: 0,
    menuVersion: 0,
    pendingPaymentItems: 0,
    failedPaymentItems: 0,
    lastQueueFailure: null,
  }));
  const [financialStats, setFinancialStats] = useState<DiagnosticsFinancialQueueStatus>(() =>
    createDefaultFinancialStats(),
  );
  const [parityQueueStatus, setParityQueueStatus] = useState<ParityQueueSnapshot>(() =>
    normalizeParityQueueStatus(null),
  );
  // Parity-queue capacity early warning, fed by the backend
  // `sync:queue-capacity-warning` event (payload while >= 80% of a capacity
  // ceiling, a single null on the falling edge). Kept separate from
  // SyncHealthState on purpose: a capacity warning must inform staff
  // without flipping `isSynced` or any blocker logic — checkout still works.
  const [capacityWarning, setCapacityWarning] =
    useState<QueueCapacityWarning | null>(null);
  const capacityWarningActiveRef = useRef(false);
  const [lastParitySync, setLastParitySync] =
    useState<DiagnosticsLastParitySync | null>(null);
  const [realtimeStatus, setRealtimeStatus] =
    useState<SubscriptionConnectionStatus>('disconnected');

  // --- UI state ---
  const [showDetailPanel, setShowDetailPanel] = useState(showDetails);
  const [showFinancialPanel, setShowFinancialPanel] = useState(false);
  const [focus, setFocus] = useState<TillHealthOpenContext | null>(null);
  const supportSession = useSupportSession();
  const supportLive = Boolean(supportSession && (supportSession.view !== 'closed' || supportSession.code
    || supportSessionLive(supportSession.snapshot)));
  const availability = supportSession?.snapshot?.availability;
  const supportProtocolAvailable = Boolean(availability?.available && availability.min_protocol_version <= SUPPORT_PROTOCOL_VERSION);
  const canAskSupport = supportProtocolAvailable && Boolean(supportSession?.snapshot?.can_connect && !supportSession.busy);

  // --- System health state (eager on modal open) ---
  const [systemHealth, setSystemHealth] =
    useState<DiagnosticsSystemHealth | null>(null);
  const remoteSupportUnavailable = readRemoteSupportUnavailable(systemHealth);
  const [healthAvailability, setHealthAvailability] =
    useState<HealthAvailability>('loading');
  const [lastHealthCheckedAt, setLastHealthCheckedAt] = useState<string | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const systemLoaded = useRef(false);
  const healthReadId = useRef(0);
  const healthScope = useRef<string | null>(null);
  const [healthReadFailures, setHealthReadFailures] = useState<string[]>([]);
  const [zRefreshEpoch, setZRefreshEpoch] = useState(0);
  const [syncTargetFeedback, setSyncTargetFeedback] = useState<ReturnType<typeof syncNowTargetOutcomes>>([]);
  const [sendingSupport, setSendingSupport] = useState(false);
  const terminalContext = systemHealth?.terminalContext;
  const reportScope = terminalContext?.terminalId && terminalContext.organizationId
    ? [terminalContext.organizationId, terminalContext.branchId, terminalContext.terminalId].join(':') : '';
  const { last: lastReport, copies: previousReports, recordReport, historyUnavailable } = useTillHealthReports(reportScope, showDetailPanel);
  const incidentReport = lastReport?.result ?? null;
  const [sendState, setSendState] = useState<'pending' | 'solved' | 'failed'>();
  const [sendVerifiedAt, setSendVerifiedAt] = useState<string>();
  const [orderDetails, setOrderDetails] = useState<ReadonlyMap<string, TillHealthOrderDetails>>(new Map());
  const [recoveryFinancialItems, setRecoveryFinancialItems] = useState<
    Awaited<ReturnType<typeof bridge.sync.getFailedFinancialItems>>
  >([]);
  const [recoveryIntegrity, setRecoveryIntegrity] =
    useState<SyncFinancialIntegrityResponse>({
      valid: true,
      issues: [],
    });
  const [recoveryParityItems, setRecoveryParityItems] = useState<
    Awaited<ReturnType<ReturnType<typeof getSyncQueueBridge>['listItems']>>
  >([]);
  const [recentRecoveryActions, setRecentRecoveryActions] = useState<
    RecoveryActionLogEntry[]
  >([]);
  // The Health modal's one recommended action. `syncVerification` holds the
  // problem a primary "Sync now" tried to clear, and the queue rows it worked
  // on read by id before and after the cycle, until a fresh health check has
  // been read; `repeatedFailureProblem` remembers (for this session) a sync
  // problem that survived it, which turns the recommendation into "Export
  // diagnostics".
  const [primaryActionBusy, setPrimaryActionBusy] =
    useState<HealthPrimaryActionId | null>(null);
  const [syncVerification, setSyncVerification] = useState<{
    problem: HealthProblemCode;
    /** The rows it worked on, before and after the cycle; null when unreadable. */
    before: SyncQueueItem[] | null;
    after: SyncQueueItem[] | null;
    /** The recovery log entry holding the retry times of the rows made due. */
    auditId: string | null;
    madeDue: MadeDueRow[];
    startedAt: string;
    completed: boolean;
    acknowledgedIds: string[];
  } | null>(null);
  const [repeatedFailureProblem, setRepeatedFailureProblem] =
    useState<HealthProblemCode | null>(null);
  const healthDialogId = React.useId();
  const { isMobileWaiter } = useFeatures();
  const { endOfDayStatus, isZIssuedAwaitingFinalization } = useEndOfDayStatus(
    staff?.branchId || null,
  );
  // Minute ticks: the "open too long" warning appears without waiting for
  // another status change.
  const clockNow = useSystemClock();

  useEffect(() => {
    setShowDetailPanel(showDetails);
  }, [showDetails]);

  // --- Sync data loading ---

  const loadSyncStatus = useCallback(async () => {
    try {
      const status = await bridge.sync.getStatus();
      setSyncStatus(normalizeStatus(status));
      setFinancialStats(normalizeFinancialStats((status as any)?.financialStats));
    } catch (error) {
      console.error('Failed to load sync status:', error);
    }
  }, [bridge.sync]);

  useEffect(() => {
    loadSyncStatus();

    const handleParityQueueStatus = (status: QueueStatus | null) => {
      setParityQueueStatus(normalizeParityQueueStatus(status));
    };

    const handleRealtimeStatus = (payload: {
      status?: SubscriptionConnectionStatus;
    }) => {
      setRealtimeStatus(payload?.status || 'disconnected');
    };

    const handleSyncStatusUpdate = async (status: any) => {
      setSyncStatus(normalizeStatus(status));
      setFinancialStats(normalizeFinancialStats(status?.financialStats));
    };

    const handleNetworkStatus = ({ isOnline }: { isOnline: boolean }) => {
      setSyncStatus((prev) => ({ ...prev, isOnline }));
    };

    const handleParitySyncStatus = (snapshot: ParitySyncSnapshot | null) => {
      const normalized = normalizeLastParitySync(snapshot);
      setLastParitySync(normalized);
      if (normalized?.queueStatus) {
        setParityQueueStatus(normalizeParityQueueStatus(normalized.queueStatus as QueueStatus));
      }
    };

    onEvent('sync:status', handleSyncStatusUpdate);
    onEvent('network:status', handleNetworkStatus);
    onEvent(PARITY_QUEUE_STATUS_EVENT, handleParityQueueStatus);
    onEvent(PARITY_SYNC_STATUS_EVENT, handleParitySyncStatus);
    onEvent(REALTIME_STATUS_EVENT, handleRealtimeStatus);

    return () => {
      offEvent('sync:status', handleSyncStatusUpdate);
      offEvent('network:status', handleNetworkStatus);
      offEvent(PARITY_QUEUE_STATUS_EVENT, handleParityQueueStatus);
      offEvent(PARITY_SYNC_STATUS_EVENT, handleParitySyncStatus);
      offEvent(REALTIME_STATUS_EVENT, handleRealtimeStatus);
    };
  }, [loadSyncStatus]);

  useEffect(() => {
    const handleCapacityWarning = (payload: QueueCapacityWarning | null) => {
      const next =
        payload &&
        typeof payload === 'object' &&
        typeof payload.replayable === 'number'
          ? payload
          : null;
      // One toast per rising edge (and per app session while under
      // pressure) so staff notice the backlog without the badge being the
      // only signal. The chip and detail banner remain the durable state.
      if (next && !capacityWarningActiveRef.current) {
        toast(
          t('sync.capacity.toast', {
            defaultValue:
              'Sync backlog growing — sales keep working, but reconnect this terminal soon so the queue can drain.',
          }),
          { icon: '⚠️', duration: 8000, id: 'sync-queue-capacity-warning' },
        );
      }
      capacityWarningActiveRef.current = next !== null;
      setCapacityWarning(next);
    };

    onEvent('sync:queue-capacity-warning', handleCapacityWarning);
    return () => {
      offEvent('sync:queue-capacity-warning', handleCapacityWarning);
    };
  }, [t]);

  // --- System health loading (eager — loads on mount) ---

  /** Resolves true when a fresh health snapshot was read. */
  const loadSystemHealth = useCallback(async (): Promise<boolean> => {
    const readId = ++healthReadId.current;
    setZRefreshEpoch(epoch => epoch + 1);
    setSystemLoading(true);
    try {
      const [healthResult, financialResult, integrityResult, parityResult, actionsResult] =
        await Promise.allSettled([
          bridge.diagnostics.getSystemHealth(),
          bridge.sync.getFailedFinancialItems(250),
          bridge.sync.validateFinancialIntegrity(),
          getSyncQueueBridge().listItems({ limit: 250 }),
          bridge.recovery.listActionLog(25),
        ]);
      if (readId !== healthReadId.current) return false;
      const data = healthResult.status === 'fulfilled' ? healthResult.value : null;
      const context = data?.terminalContext;
      if (context?.terminalId && context.organizationId) {
        const nextScope = [context.organizationId, context.branchId, context.terminalId].join(':');
        if (healthScope.current && healthScope.current !== nextScope) {
          systemLoaded.current = false;
          setSystemHealth(null);
          setLastHealthCheckedAt(null);
          setRecoveryFinancialItems([]);
          setRecoveryIntegrity({ valid: true, issues: [] });
          setRecoveryParityItems([]);
          setRecentRecoveryActions([]);
          setOrderDetails(new Map());
          setSyncTargetFeedback([]);
          setSendState(undefined);
          setFocus(null);
        }
        healthScope.current = nextScope;
      }
      const financial = financialResult.status === 'fulfilled' ? financialResult.value : null;
      const integrity = integrityResult.status === 'fulfilled' ? integrityResult.value : null;
      const parity = parityResult.status === 'fulfilled' ? parityResult.value : null;
      const failures = [...(data?.readFailures ?? [])];
      if (!data) failures.push('systemHealth');
      if (data?.syncBacklogStatus === 'unavailable') failures.push('syncBacklog');
      if (!Array.isArray(financial)) failures.push('financialItems');
      if (!Array.isArray(integrity?.issues)) failures.push('integrity');
      if (!Array.isArray(parity)) failures.push('parityItems');
      setHealthReadFailures(failures);
      if (failures.length || !data || !financial || !integrity || !parity) {
        setHealthAvailability(systemLoaded.current ? 'stale' : 'unavailable');
        return false;
      }
      setSystemHealth(data);
      setFinancialStats(
        normalizeFinancialStats(
          data.financialQueueStatus ?? data.syncStatusSummary?.financialStats,
        ),
      );
      setParityQueueStatus(
        normalizeParityQueueStatus(
          (data.parityQueueStatus ?? data.lastParitySync?.queueStatus) as QueueStatus | null,
        ),
      );
      setLastParitySync(normalizeLastParitySync(data.lastParitySync));
      setRecoveryFinancialItems(financial);
      setRecoveryIntegrity(integrity);
      setRecoveryParityItems(parity);
      if (actionsResult.status === 'fulfilled' && Array.isArray(actionsResult.value)) {
        setRecentRecoveryActions(actionsResult.value);
      }
      setLastHealthCheckedAt(new Date().toISOString());
      systemLoaded.current = true;
      setHealthAvailability('ready');
      return true;
    } catch (err) {
      console.error('Failed to load system health:', err);
      if (readId === healthReadId.current) {
        setHealthReadFailures(['systemHealth']);
        setHealthAvailability(systemLoaded.current ? 'stale' : 'unavailable');
      }
      return false;
    } finally {
      if (readId === healthReadId.current) setSystemLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (!systemLoaded.current) {
      loadSystemHealth();
    }

    const handleHealthUpdate = () => { void loadSystemHealth(); };
    onEvent('database-health-update', handleHealthUpdate);
    return () => {
      healthReadId.current += 1;
      offEvent('database-health-update', handleHealthUpdate);
    };
  }, [loadSystemHealth]);
  useEffect(() => {
    const open = (event: Event) => {
      setFocus((event as CustomEvent<TillHealthOpenContext>).detail ?? null);
      setShowDetailPanel(true);
      void loadSystemHealth();
    };
    window.addEventListener(OPEN_TILL_HEALTH, open);
    return () => window.removeEventListener(OPEN_TILL_HEALTH, open);
  }, [loadSystemHealth]);

  useEffect(() => {
    const receive = (payload: RemoteIncidentReportResponse & { response?: RemoteIncidentReportResponse }) => {
      if (payload?.response && payload.success) {
        recordReport({ ...payload.response, success: true }, payload.lastSentAt, true);
      }
    };
    onEvent('incident-reporting-update', receive);
    return () => offEvent('incident-reporting-update', receive);
  }, [recordReport]);


  useEffect(() => {
    if (!lastHealthCheckedAt) return;
    const checkedAt = Date.parse(lastHealthCheckedAt);
    if (!Number.isFinite(checkedAt)) return;
    const remainingMs = Math.max(
      0,
      HEALTH_SNAPSHOT_FRESH_MS - (Date.now() - checkedAt) + 1,
    );
    const timer = window.setTimeout(() => {
      setHealthAvailability((current) =>
        current === 'ready' ? 'stale' : current,
      );
    }, remainingMs);
    return () => window.clearTimeout(timer);
  }, [lastHealthCheckedAt]);

  // --- Derived ---

  const financialPendingCount =
    financialStats.driver_earnings.pending +
    financialStats.staff_payments.pending +
    financialStats.shift_expenses.pending;

  const financialFailedCount =
    financialStats.driver_earnings.failed +
    financialStats.staff_payments.failed +
    financialStats.shift_expenses.failed;
  const parityPendingCount = parityQueueStatus.pending;
  const parityFailedCount = parityQueueStatus.failed;
  const parityConflictCount = parityQueueStatus.conflicts;
  const effectiveLastParitySync = useMemo(
    () => lastParitySync ?? normalizeLastParitySync(systemHealth?.lastParitySync),
    [lastParitySync, systemHealth?.lastParitySync],
  );
  const effectiveCredentialState = useMemo(
    () =>
      effectiveLastParitySync?.credentialState ??
      normalizeCredentialState(systemHealth?.credentialState),
    [effectiveLastParitySync?.credentialState, systemHealth?.credentialState],
  );

  const handleForceSync = async (employeeAttempt = false): Promise<{ healthRefreshed: boolean | null; acknowledgedIds: string[] }> => {
    let healthRefreshed: boolean | null = null;
    let acknowledgedIds: string[] = [];
    try {
      setSyncStatus((prev) => ({ ...prev, syncInProgress: true }));
      const result = await runParitySyncCycle({ trigger: 'manual', ...(employeeAttempt ? { reportHealthTargets: true } : {}) });
      acknowledgedIds = result.paritySyncResult?.acknowledgedIds ?? [];
      const parityResult = normalizeLastParitySync(result.paritySyncStatus);
      setLastParitySync(parityResult);

      if (!employeeAttempt && parityResult?.status === 'failed') {
        toast.error(t('tillHealth.action.sendFailed'));
      } else if (!employeeAttempt && parityResult?.status === 'skipped_missing_credentials') {
        toast.error(t('tillHealth.families.connection.title'));
      } else if (!employeeAttempt) {
        toast(t('tillHealth.action.sendChecked'));
      }

      await loadSyncStatus();
      if (systemLoaded.current) {
        healthRefreshed = await loadSystemHealth();
      }
    } catch (error) {
      console.error('Failed to force sync:', error);
      if (!employeeAttempt) toast.error(t('tillHealth.action.sendFailed'));
    } finally {
      setSyncStatus((prev) => ({ ...prev, syncInProgress: false }));
    }
    return { healthRefreshed, acknowledgedIds };
  };

  const handleOpenPrinterSettings = () => {
    setShowDetailPanel(false);
    window.dispatchEvent(
      new CustomEvent('pos:recovery-route', {
        detail: { screen: 'connectionSettings', params: { section: 'printing' } },
      }),
    );
  };

  /**
   * The Health modal's primary "Sync now". Sending is not proof of a fix:
   * once a fresh health check has been read, the rows it worked on are
   * judged, and only rows the cycle actually tried can make it a failure
   * (see the syncVerification effect). Rows waiting out a retry delay are
   * made due first, their retry time only, recorded in the recovery log
   * (review 30/09/2026: the cycle skipped them and the attempt still read
   * as failed).
   */
  const handlePrimarySyncNow = async () => {
    const attemptedProblem = simpleHealthSummary.problem;
    const startedAt = new Date().toISOString();
    const attemptId = `health-sync-now:${crypto.randomUUID()}`;
    const nowMs = Date.now();
    const queue = getSyncQueueBridge();
    const readById = async (ids: string[]): Promise<SyncQueueItem[] | null> => {
      if (ids.length === 0) return [];
      try {
        const items = await queue.itemsById(ids);
        return Array.isArray(items) ? items : null;
      } catch {
        return null;
      }
    };
    setSendState(undefined);
    setPrimaryActionBusy('syncNow');
    setSyncTargetFeedback([]);
    try {
      const before = await readById(
        syncNowTargetItems(attemptedProblem, recoveryParityItems, nowMs).map((item) => item.id),
      );
      let madeDue: MadeDueRow[] = [];
      let auditId: string | null = null;
      const waiting = before ? rowsWaitingOutRetry(before, nowMs) : [];
      if (waiting.length > 0) {
        try {
          const result = await queue.makeDue(waiting, syncNowIssueCode(attemptedProblem));
          madeDue = Array.isArray(result?.madeDue) ? result.madeDue : [];
          auditId = result?.auditId ?? null;
        } catch (error) {
          // Nothing recorded, nothing changed: the cycle runs on what is due.
          console.warn('[SyncStatusIndicator] Sync now could not make its rows due:', error);
        }
      }
      if (!auditId) {
        try {
          await bridge.recovery.recordActionLog({
            id: attemptId,
            actionId: 'syncNow',
            issueCode: syncNowIssueCode(attemptedProblem),
            success: false,
            outcome: 'pending',
            timestamp: startedAt,
            actor: { staffId: null, staffName: null },
            targetRefs: { queueRowIds: (before ?? []).map(item => item.id).slice(0, 20) },
          });
        } catch (error) {
          console.warn('[SyncStatusIndicator] Sync now start was not logged:', error);
        }
      }
      const attempt = await handleForceSync(true);
      let refreshed = attempt.healthRefreshed;
      if (refreshed === null) {
        refreshed = await loadSystemHealth();
      }
      const after = before ? await readById(before.map((item) => item.id)) : null;
      setSyncVerification({ problem: attemptedProblem, before, after, auditId: auditId ?? attemptId, madeDue, startedAt, completed: refreshed === true, acknowledgedIds: attempt.acknowledgedIds });
    } finally {
      setPrimaryActionBusy(null);
    }
  };

  // --- System health helpers ---

  const totalBacklog = countDesktopBacklog(systemHealth);
  // The last backlog read failed: the card says so, never "clear".
  const backlogUnavailable = healthReadFailures.includes('syncBacklog') || systemHealth?.syncBacklogStatus === 'unavailable';

  // P1 Health signals (shared rules in shared/pos/health).
  // Queue rows pending 30+ minutes after an attempt (or blocking the Z) are
  // stuck. Re-aged at every fresh check (lastHealthCheckedAt).
  const stuckSignal = useMemo(() => {
    const nowMs = Date.now();
    return summarizeStuckRows(
      recoveryParityItems.map((item) => {
        const createdMs = parseQueueTimestampMs(item.createdAt ?? null);
        return {
          status: classifyParityQueueItem(item, nowMs),
          ageMs: createdMs === null ? null : Math.max(0, nowMs - createdMs),
          tableName: item.tableName,
          moduleType: item.moduleType ?? null,
        };
      }),
    );
  }, [recoveryParityItems, lastHealthCheckedAt]);

  // Day close (Z). The renderer only sees the checkout payment blockers; open
  // shifts, drawers and the fiscal queue are checked in Rust (zreport.rs), so
  // this is a partial check that can say "blocked" but never "ready".
  const posDayOpenTooLong = isPosDayOpenTooLong(endOfDayStatus.dayStartAt, clockNow.getTime());
  const closeoutSummary = useMemo(() => {
    const blocking = (systemHealth?.checkoutPaymentBlockers?.details ?? []).filter(
      (blocker) => blocker.severity !== 'warning',
    );
    const blockers: CloseoutBlockerInput[] =
      blocking.length > 0
        ? [
            {
              key: 'unpaid_finalized_orders',
              count: blocking.length,
              orderIds: [
                ...new Set(
                  blocking
                    .map((blocker) => blocker.orderId)
                    .filter((orderId): orderId is string => Boolean(orderId)),
                ),
              ],
            },
          ]
        : [];
    return summarizeCloseout({
      applicable: !isMobileWaiter,
      checked: systemHealth !== null,
      complete: false,
      blockers,
      // The POS day runs from its first check-in to its Z (13/10/2026), so a
      // pending Z right after the last checkout is the normal day close. Only
      // a day open for more than 24 hours is overdue: a reminder that never
      // blocks anything (Android mirrors the same threshold).
      overdue: posDayOpenTooLong,
      submitted: endOfDayStatus.status === 'submitted_pending_admin',
      reportDate:
        endOfDayStatus.pendingReportDate ??
        (posDayOpenTooLong ? endOfDayStatus.activeReportDate ?? null : null),
    });
  }, [
    endOfDayStatus.activeReportDate,
    endOfDayStatus.pendingReportDate,
    endOfDayStatus.status,
    isMobileWaiter,
    posDayOpenTooLong,
    systemHealth,
  ]);

  const terminalAuthInvalid =
    !!effectiveCredentialState &&
    (!effectiveCredentialState.hasAdminUrl || !effectiveCredentialState.hasApiKey);

  // Print jobs still waiting (the whole queue, printerStatus.pendingJobs),
  // aged at every fresh check: waiting minutes after a print should have
  // finished means nothing is printing (store incident 30/09/2026, the Health
  // view said "Printer: Ready" while every job stayed pending). Aged when the
  // queue was read (lastHealthCheckedAt), not when a render rebuilds it, as
  // Android does with its snapshot's capturedAt.
  const printQueueSignal = useMemo(() => {
    const readAtMs = lastHealthCheckedAt ? Date.parse(lastHealthCheckedAt) : Number.NaN;
    return desktopPrintQueueSignal(systemHealth, Number.isFinite(readAtMs) ? readAtMs : Date.now());
  }, [systemHealth, lastHealthCheckedAt]);
  // The print stall as the operator's alarm (shared rule: during a shift).
  // The heart shows it too, so staff see receipts are not printing without
  // opening Health (review 30/09/2026).
  const printingStallActive = isPrintingStallActive({
    isShiftActive,
    printQueue: printQueueSignal,
  });

  const healthSignalExtras = useMemo<HealthSignalExtras>(
    () => ({
      availability: healthAvailability,
      stuck: stuckSignal,
      closeout: closeoutSummary,
      terminalAuthInvalid,
      printQueue: printQueueSignal,
      courierCashIssues: recoveryIntegrity.issues.filter(issue => issue.reasonCode.startsWith('courier_cash_')).length,
    }),
    [closeoutSummary, healthAvailability, printQueueSignal, stuckSignal, terminalAuthInvalid, recoveryIntegrity],
  );

  const simpleHealthSummary = useMemo(() => {
    const input = {
      health: systemHealth,
      syncStatus,
      isShiftActive,
      parityItems: recoveryParityItems,
    };
    const draft = buildSimpleHealthSummary({
      ...input,
      supportStatus: 'not_sent',
      extras: healthSignalExtras,
    });
    const supportStatus = resolveSupportStatus({
      incidentSucceeded: incidentReport ? verifiedSupportReceipt(incidentReport) : undefined,
      incidentFailed: Boolean(incidentReport?.error),
      state: draft.state,
    });

    return buildSimpleHealthSummary({
      ...input,
      supportStatus,
      extras: {
        ...healthSignalExtras,
        // The problem never depends on this flag, so the draft's is final.
        repeatedFailure:
          repeatedFailureProblem !== null && repeatedFailureProblem === draft.problem,
      },
    });
  }, [
    healthSignalExtras,
    incidentReport,
    isShiftActive,
    recoveryParityItems,
    repeatedFailureProblem,
    syncStatus,
    systemHealth,
  ]);

  useEffect(() => registerSupportHealthObservation({ problem: simpleHealthSummary.problem, realtime: realtimeStatus,
    stale: healthAvailability !== 'ready' }), [simpleHealthSummary.problem, realtimeStatus, healthAvailability]);

  // After a primary "Sync now" and a fresh check, the shared rule both apps
  // apply (judgeSyncAttempt), on the rows it worked on as Android does: only
  // a verified failure — a row the cycle tried that is still stuck, failed
  // or in conflict — is a repeated failure; rows it did not reach are
  // pending, and anything else clears the memory. The manual cycle always
  // runs here (missing credentials show as a different problem), so `ran`
  // is true.
  useEffect(() => {
    if (!syncVerification) return;
    const problem = simpleHealthSummary.problem;
    const remaining = syncNowRemainder({
      before: syncVerification.before,
      after: syncVerification.after,
      problemStillThere: problem === syncVerification.problem,
      nowMs: Date.now(),
    });
    const targetOutcomes = syncNowTargetOutcomes(syncVerification.before, syncVerification.after, syncVerification.acknowledgedIds);
    setSyncTargetFeedback(targetOutcomes);
    const outcome = judgeSyncAttempt({
      freshCheck: remaining !== null && syncVerification.completed && targetOutcomes.length > 0
        && targetOutcomes.every(target => target.outcome !== 'unknown'),
      ran: true,
      remaining: targetOutcomes.some(target => target.outcome === 'refused') ? 'problem'
        : targetOutcomes.every(target => target.outcome === 'sent') ? 'none' : 'progressing',
    });
    setSendState(outcome === 'resolved' ? 'solved' : outcome === 'failed' ? 'failed' : 'pending');
    setSendVerifiedAt(outcome === 'resolved' ? new Date().toISOString() : undefined);
    setRepeatedFailureProblem(outcome === 'failed' && SYNC_PROBLEMS.has(problem) ? problem : null);
    if (syncVerification.auditId) {
      // The entry that recorded the retry times gets the outcome.
      const entry: RecoveryActionLogEntry & { targetOutcomes: typeof targetOutcomes } = {
        id: syncVerification.auditId,
        actionId: 'syncNow',
        issueCode: syncNowIssueCode(syncVerification.problem),
        success: outcome === 'resolved',
        outcome,
        timestamp: syncVerification.startedAt,
        actor: { staffId: null, staffName: null },
        targetRefs: {
          queueRowIds: (syncVerification.before ?? []).map((item) => item.id).slice(0, 20),
        },
        madeDue: syncVerification.madeDue,
        targetOutcomes,
      };
      void Promise.resolve()
        .then(() => bridge.recovery.recordActionLog(entry))
        .catch((error) => console.warn('[SyncStatusIndicator] Sync now outcome not logged:', error));
    }
    setSyncVerification(null);
  }, [bridge.recovery, simpleHealthSummary.problem, syncVerification]);

  useEffect(() => {
    if (repeatedFailureProblem !== null && simpleHealthSummary.problem !== repeatedFailureProblem) {
      setRepeatedFailureProblem(null);
    }
  }, [repeatedFailureProblem, simpleHealthSummary.problem]);

  // The checkout-blocker card renders the classifier's own sentence. Hand it
  // the operator's language, or a Greek till reads its money in English.
  const localizePaymentBlocker = useCallback(
    (blocker: UnsettledPaymentBlocker) => ({
      reason: getLocalizedPaymentBlockerReason(blocker, t, formatCurrency),
      fix: getLocalizedPaymentBlockerFix(blocker, t, formatCurrency),
    }),
    [t],
  );
  const sharedRecoveryIssues = useMemo(
    () =>
      buildSyncRecoveryIssues({
        systemHealth,
        lastParitySync: effectiveLastParitySync ?? null,
        financialItems: recoveryFinancialItems,
        integrity: recoveryIntegrity,
        parityItems: recoveryParityItems,
        localizePaymentBlocker,
      }).issues,
    [
      effectiveLastParitySync,
      localizePaymentBlocker,
      recoveryFinancialItems,
      recoveryIntegrity,
      recoveryParityItems,
      systemHealth,
    ],
  );

  /** health_view.json for the diagnostics bundle: exactly what this view shows. */
  const buildExportHealthView = () =>
    buildHealthView({
      platform: 'windows',
      source: 'health_modal',
      availability: healthAvailability,
      // No valid observation yet: the summary would describe an empty snapshot.
      summary: systemHealth !== null ? simpleHealthSummary : null,
      issues: sharedRecoveryIssues,
      closeout: closeoutSummary,
      lastActions: recentRecoveryActions,
      counts: {
        localPending: syncStatus.pendingItems,
        parityPending: parityPendingCount,
        parityFailed: parityFailedCount,
        parityConflicts: parityConflictCount,
        financialPending: financialPendingCount,
        financialFailed: financialFailedCount,
        // Left out when the read failed: absent is not zero.
        ...(backlogUnavailable ? {} : { syncBacklog: totalBacklog }),
        stuckRows: stuckSignal?.count ?? 0,
        invalidOrders: systemHealth?.invalidOrders?.count ?? 0,
        printerFailures: countDesktopPrinterFailures(systemHealth),
        // Left out when the queue was not read: absent is not zero.
        ...(printQueueSignal
          ? {
              printJobsWaiting: printQueueSignal.waitingCount,
              ...(printQueueSignal.oldestWaitingAgeMs !== null
                ? { oldestPrintJobWaitingMs: printQueueSignal.oldestWaitingAgeMs }
                : {}),
            }
          : {}),
        crashCount: systemHealth?.panicCount ?? 0,
        recoveryIssues: sharedRecoveryIssues.length,
      },
      // Desktop extra: the incoming-order alert's watchdog and render-failure
      // entries (Tomikro, 30/09/2026), which otherwise live only in this
      // register's local storage.
      extra: { incomingOrderAlerts: buildIncomingOrderAlertSupportEvidence() },
    });


  const closeHealth = () => {
    healthReadId.current += 1;
    setSystemLoading(false);
    setShowFinancialPanel(false);
    setShowDetailPanel(false);
    setFocus(null);
  };
  const retainAction = (entry: RecoveryActionLogEntry) => {
    setRecentRecoveryActions(current => [entry, ...current.filter(old => old.id !== entry.id)].slice(0, 25));
  };
  const actions = useTillHealthActions({
    terminalContext, recentActions: recentRecoveryActions, diagnosticsStale: healthAvailability !== 'ready' || systemLoading,
    onRefresh: loadSystemHealth, onNavigate: closeHealth, onActionResolved: retainAction, onReport: recordReport,
  });

  const focusedIssues = useMemo(() => {
    if (!focus?.orderId) return sharedRecoveryIssues;
    const focusId = focus.orderId;
    const matching = orderRecoveryIssues(sharedRecoveryIssues, focusId, systemHealth?.orderNotices ?? [],
      recoveryParityItems.filter(item => item.recordId === focusId),
      recoveryFinancialItems.filter(item => item.entityId === focusId));
    const existing = new Set(sharedRecoveryIssues.map(issue => issue.id));
    return [...sharedRecoveryIssues, ...matching.filter(issue => !existing.has(issue.id))];
  }, [focus?.orderId, recoveryFinancialItems, recoveryParityItems, sharedRecoveryIssues, systemHealth?.orderNotices]);

  useEffect(() => {
    if (!showDetailPanel || typeof bridge.orders?.getById !== 'function') return;
    const ids = [...new Set(focusedIssues.map(issue => issue.orderId).filter((id): id is string => !!id))];
    if (!ids.length) return;
    let cancelled = false;
    void Promise.allSettled(ids.map(async id => {
      const result = await bridge.orders.getById(id) as unknown as
        (Record<string, unknown> & { order?: Record<string, unknown>; data?: Record<string, unknown> }) | null;
      if (!result || result.success === false) return null;
      const fields = result.order ?? result.data ?? result;
      const rawType = fields.orderType ?? fields.order_type;
      const type = rawType === 'delivery' || rawType === 'pickup' || rawType === 'dine_in' ? rawType
        : rawType === 'takeaway' ? 'pickup' : rawType === 'dine-in' ? 'dine_in' : null;
      const amount = fields.total ?? fields.totalAmount ?? fields.total_amount;
      const currency = fields.currency ?? fields.currency_code;
      const total = typeof amount === 'number' && Number.isFinite(amount)
        ? formatCurrency(amount, typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : undefined, i18n?.resolvedLanguage || i18n?.language) : null;
      return [id, { number: safeOrderNumber(fields.orderNumber ?? fields.order_number), type, total }] as const;
    })).then(results => {
      if (cancelled) return;
      setOrderDetails(current => new Map([...current, ...results.flatMap(result =>
        result.status === 'fulfilled' && result.value ? [result.value] : [])]));
    });
    return () => { cancelled = true; };
  }, [bridge.orders, focusedIssues, showDetailPanel, i18n?.resolvedLanguage, i18n?.language]);

  const services = simpleHealthSummary.serviceStatuses;
  const online = services.internet !== 'offline';
  const availableToAsk = canAskSupport && online && !remoteSupportUnavailable;
  const parkedOnly = parityQueueStatus.total > 0 && parityQueueStatus.conflicts === parityQueueStatus.total;
  const canSend = simpleHealthSummary.primaryAction === 'syncNow' && !parkedOnly;
  const currentSendState = primaryActionBusy ? 'working' : sendState;
  const cards = buildTillHealthCards({
    issues: focusedIssues, attempts: actions.attempts, problem: simpleHealthSummary.problem, focus,
    printerNeedsAttention: services.printer === 'failed' || (isShiftActive && services.printer === 'attention'),
    canSend: canSend || currentSendState === 'working',
    sendResult: currentSendState ? { state: currentSendState, verifiedAt: sendVerifiedAt } : undefined,
    printCount: printingStallActive ? printQueueSignal?.waitingCount : undefined,
  });
  for (const card of cards) {
    if (card.family === 'printing') {
      card.copyDetail = t('tillHealth.families.printing.detail', { count: printQueueSignal?.waitingCount ?? 0 });
    } else if (card.localAction === 'send' && stuckSignal) {
      const duration = healthDuration(stuckSignal.oldestAgeMs);
      card.copyDetail = t('tillHealth.families.waiting.stuck', { count: stuckSignal.count, duration: t(duration.key, { count: duration.count }) });
    }
  }
  const state = tillHealthState({
    availability: healthAvailability, online, cards, sendState: currentSendState,
    supportUnavailable: Boolean(remoteSupportUnavailable),
  });
  const tone = tillHealthTone(state);
  useEffect(() => { onHealthState?.(state); }, [onHealthState, state]);
  useBlockerRegistration({ id: 'sync-status-detail-panel', label: 'Till health', source: 'sync-status', active: showDetailPanel });

  const handleReport = async () => {
    if (sendingSupport) return;
    setSendingSupport(true);
    try {
      const healthView = buildExportHealthView();
      recordReport(await bridge.diagnostics.sendRemoteIncident({ includeLogs: true, redactSensitive: true, healthView }));
    } catch {
      recordReport({ success: false, error: 'INCIDENT_PREPARATION_FAILED' });
    } finally {
      setSendingSupport(false);
    }
  };

  const copyFolder = (path: string) => { void bridge.diagnostics.openExportDir(path).catch(error => {
    console.warn('Failed to open diagnostics export folder:', error);
  }); };
  const technicalControls = <>
    <ZGateSetAsidePanel refreshEpoch={zRefreshEpoch} />
    <div className="flex flex-wrap gap-2">
      <TillHealthButton onClick={() => void handleForceSync()} disabled={syncStatus.syncInProgress}>{t('sync.actions.retry')}</TillHealthButton>
      <TillHealthButton onClick={() => void handlePrimarySyncNow()} disabled={!!primaryActionBusy || systemLoading || healthAvailability !== 'ready' || parkedOnly}>
        {t('tillHealth.action.send')}
      </TillHealthButton>
      <TillHealthButton onClick={() => setShowFinancialPanel(true)}>{t('sync.dashboard.financialSummaryTitle')}</TillHealthButton>
      <TillHealthButton onClick={handleOpenPrinterSettings}>{t('tillHealth.action.printer')}</TillHealthButton>
      <TillHealthButton onClick={() => {
        closeHealth();
        window.dispatchEvent(new CustomEvent('pos:recovery-route', { detail: { screen: 'connectionSettings' } }));
      }}>{t('tillHealth.action.openConnection')}</TillHealthButton>
    </div>
  </>;
  const diagnostics = <div className="space-y-2">
    {remoteSupportUnavailable && <code data-testid="health-remote-support-details">{remoteSupportUnavailable.code} · {remoteSupportUnavailable.status}</code>}
    {healthReadFailures.length > 0 && <code>{healthReadFailures.join(', ')}</code>}
    <p>{t('sync.healthModal.advanced.fields.lastSync')} · {systemHealth?.lastSyncTime || syncStatus.lastSync || t('sync.healthModal.advanced.values.never')}</p>
    <p><span>{t('sync.healthModal.advanced.fields.syncBacklog')}</span> · {backlogUnavailable ? t('sync.healthModal.status.unavailable') : formatNumber(totalBacklog)}</p>
    <p>{t('sync.healthModal.advanced.fields.financialFailed')} · {formatNumber(financialFailedCount)}</p>
    <p>{t('sync.healthModal.advanced.fields.printerFailures')} · {formatNumber(countDesktopPrinterFailures(systemHealth))}</p>
    <p>{t('sync.healthModal.advanced.fields.crashCount')} · {formatNumber(systemHealth?.panicCount ?? 0)}</p>
    <code>{[realtimeStatus, effectiveLastParitySync?.error, effectiveLastParitySync?.reason, syncStatus.error].map(value => sanitizeOperationalError(value)).filter(Boolean).join(' · ')}</code>
    {recoveryParityItems.length > 0 && <h4>{t('sync.healthModal.syncDetails')}</h4>}
    {recoveryParityItems.slice(0, 10).map(item => {
      const queueStatus = String(item.status);
      const status = queueStatus === 'pending' || queueStatus === 'deferred' ? 'waiting'
        : queueStatus === 'failed' || queueStatus === 'conflict' || queueStatus === 'dead_letter' ? 'failed' : 'unknown';
      return <div key={item.id}>
        <p>{t(`tillHealth.status.${status}`)} · <code>{item.id}</code></p>
        {item.nextRetryAt && <p>{t('sync.healthModal.failure.nextRetryValue', {
          value: formatDateTime(item.nextRetryAt, {}, i18n?.resolvedLanguage || i18n?.language),
        })}</p>}
      </div>;
    })}
    {syncTargetFeedback.map(result => <p key={result.id}><code>{result.id}</code> · {t(`recovery.actionStatus.${result.outcome}`)}</p>)}
  </div>;

  return <div className={`relative flex items-center ${inRail ? 'flex-col gap-2' : 'gap-1.5'} ${className}`}>
      <button type="button" className={`till-health-launcher flex min-h-touch min-w-touch items-center justify-center p-2 ${inRail ? 'h-12 w-12 rounded-xl' : 'rounded-full'}`}
      onClick={() => { if (showDetailPanel) closeHealth(); else { setFocus(null); setShowDetailPanel(true); void loadSystemHealth(); } }}
      aria-label={`${t('tillHealth.title')} · ${t(`tillHealth.states.${state}.title`)}`}
      data-heart-tone={tone === 'ok' ? 'healthy' : tone === 'bad' ? 'error' : 'attention'} data-health-tone={tone}
      aria-haspopup="dialog" aria-expanded={showDetailPanel} aria-controls={showDetailPanel ? healthDialogId : undefined}>
      <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.218l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
      </svg>
    </button>
    {capacityWarning && <button type="button" onClick={() => { setShowDetailPanel(true); void loadSystemHealth(); }}
      className="flex min-h-touch min-w-touch items-center justify-center rounded-xl active:bg-(--pos-s-surface-2)"
      aria-label={t('tillHealth.capacity')}><AlertTriangle className="h-4 w-4" aria-hidden="true" /></button>}
    {showDetailPanel && <TillHealthWindow id={healthDialogId} state={state} availability={healthAvailability} cards={cards} services={services}
      isShiftActive={isShiftActive} online={online} lastChecked={lastHealthCheckedAt} dayStart={endOfDayStatus.dayStartAt ?? null}
      busy={systemLoading || actions.busy || Boolean(primaryActionBusy)} canAskSupport={availableToAsk}
      supportCanConnect={supportProtocolAvailable && online && !remoteSupportUnavailable}
      supportUnavailable={Boolean(remoteSupportUnavailable)} supportFlowOpen={!focus?.orderId && supportLive} focusKey={focus?.orderId} orderDetails={orderDetails}
      onClose={closeHealth} onRefresh={() => void loadSystemHealth()} onAskSupport={() => { void supportSession?.start(); }}
      onCardAction={(card, action) => {
        if (action && card.issue) actions.handleActionClick(card.issue, action);
        else if (card.localAction === 'printer') handleOpenPrinterSettings();
        else if (card.localAction === 'send') void handlePrimarySyncNow();
      }}
      onDismissSolved={card => {
        if (card.sendPhase === 'solved') setSendState(undefined);
        else if (card.issue) actions.dismissAttempt(card.issue.id);
      }}
      overlays={<>
        {actions.busy && actions.confirmationModal}
        <TillHealthConfirmation confirmation={actions.confirmingAction} busy={actions.busy}
          onClose={() => actions.setConfirmingAction(null)} onConfirm={actions.handleConfirmDestructiveAction} />
        {showFinancialPanel && <FinancialSyncPanel isOpen onClose={() => setShowFinancialPanel(false)} onRefresh={() => { void loadSyncStatus(); }}
          queueSummary={{ pending: financialPendingCount, failed: financialFailedCount }} />}
      </>}
      support={<TillHealthSupport issues={focusedIssues} recentActions={recentRecoveryActions} terminal={terminalContext}
        online={online} stale={healthAvailability !== 'ready' || systemLoading} busy={actions.busy}
        supportTools={technicalControls} diagnostics={diagnostics} previousReports={previousReports} lastReport={lastReport}
        historyUnavailable={historyUnavailable} sending={sendingSupport}
        onOpenCopy={copyFolder} onIssueAction={actions.handleActionClick}
        onReport={(issue, action) => {
          if (issue && action) actions.handleActionClick(issue, action);
          else void handleReport();
        }} />} />}
  </div>;
};
