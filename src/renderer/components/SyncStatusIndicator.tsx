import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Send,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { OrderSyncRouteIndicator } from './OrderSyncRouteIndicator';
import { FinancialSyncPanel } from './FinancialSyncPanel';
import { HealthSupportEntryPoint } from './support/HealthSupportEntryPoint';
import { RecoveryCenterPanel } from './recovery/RecoveryCenterPanel';
import type { SyncRecoveryOpenContext } from './recovery/SyncRecoveryModal';
import {
  buildSyncRecoveryIssues,
  getRepresentativeParityFailureReason,
} from './recovery/sync-recovery-issues';
import { useBlockerRegistration } from '../hooks/useBlockerRegistration';
import { useFeatures } from '../hooks/useFeatures';
import { useShift } from '../contexts/shift-context';
import { useEndOfDayStatus } from '../hooks/useEndOfDayStatus';
import { formatDate } from '../utils/format';
import { cn } from '../utils/cn';
import { buildHealthSupportContext } from '../support';
import { getLocalizedSyncBlockerReason } from '../../lib/payment-integrity';
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
} from '../../../../shared/pos/sync-queue-types';
import { getSyncQueueBridge } from '../services/SyncQueueBridge';
import type { SubscriptionConnectionStatus } from '../services/RealtimeManager';

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
  onOpenRecovery?: (context: SyncRecoveryOpenContext) => void;
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

type SyncHealthState = 'healthy' | 'pending' | 'blocked' | 'error' | 'stale';

interface SyncHealthPresentation {
  label: string;
  badgeClassName: string;
  textClassName: string;
  dotClassName: string;
  detail: string;
  panelClassName: string;
  iconClassName: string;
}

type SimpleHealthState = 'healthy' | 'attention' | 'support_needed';
type SimpleServiceStatus = {
  orders: 'working' | 'limited' | 'blocked' | 'start_shift';
  internet: 'connected' | 'offline' | 'unknown';
  sync: 'healthy' | 'waiting' | 'failed';
  printer: 'ready' | 'attention' | 'failed' | 'not_configured';
  support: 'not_needed' | 'notified' | 'not_sent' | 'failed_to_notify';
};

interface SimpleHealthSummary {
  state: SimpleHealthState;
  canContinueOrders: boolean;
  orderGuidance: string;
  title: string;
  message: string;
  recommendedActions: string[];
  problemExplanation: string;
  primaryAction: 'refresh' | 'send_support' | 'export';
  secondaryAction: 'send_support' | 'export' | 'advanced';
  serviceStatuses: SimpleServiceStatus;
  advanced: DiagnosticsSystemHealth | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createDefaultFinancialStats = (): DiagnosticsFinancialQueueStatus => ({
  driver_earnings: { pending: 0, failed: 0 },
  staff_payments: { pending: 0, failed: 0 },
  shift_expenses: { pending: 0, failed: 0 },
});

const countBacklog = (health: DiagnosticsSystemHealth | null): number => {
  if (!health?.syncBacklog) return 0;
  return Object.values(health.syncBacklog).reduce((sum, statuses) => {
    return (
      sum +
      Object.entries(statuses)
        .filter(([status]) => status !== 'synced' && status !== 'applied')
        .reduce((inner, [, count]) => inner + count, 0)
    );
  }, 0);
};

const countPrinterFailures = (health: DiagnosticsSystemHealth | null): number => {
  return (
    health?.printerStatus?.recentJobs?.filter((job) =>
      String(job.status || '').toLowerCase().includes('fail'),
    ).length ?? 0
  );
};

const buildSimpleHealthSummary = ({
  health,
  syncStatus,
  supportStatus,
  isShiftActive,
}: {
  health: DiagnosticsSystemHealth | null;
  syncStatus: SyncStatus;
  supportStatus: SimpleServiceStatus['support'];
  isShiftActive: boolean;
}): SimpleHealthSummary => {
  const backlog = countBacklog(health);
  const failedFinancialItems =
    (health?.financialQueueStatus?.totalFailed ?? 0) ||
    (health?.financialQueueStatus?.failedPaymentItems ?? 0) ||
    syncStatus.failedPaymentItems;
  const invalidOrders = health?.invalidOrders?.count ?? 0;
  const panicCount = health?.panicCount ?? 0;
  const printerFailures = countPrinterFailures(health);
  const printerConfigured = health?.printerStatus?.configured ?? false;
  const isOnline =
    typeof health?.isOnline === 'boolean' ? health.isOnline : syncStatus.isOnline;
  const syncFailed =
    failedFinancialItems > 0 ||
    invalidOrders > 0 ||
    (health?.parityQueueStatus?.failed ?? 0) > 0 ||
    (health?.parityQueueStatus?.conflicts ?? 0) > 0 ||
    (health?.syncStatusSummary?.syncErrors ?? 0) > 0;

  const supportNeeded = failedFinancialItems > 0 || invalidOrders > 0 || panicCount > 0;
  // Printer jobs can remain failed from the last shift/session. Before a shift
  // starts, keep printer-only noise out of the top-level operator alarm.
  const activePrinterIssue = isShiftActive && printerFailures > 0;
  const attentionNeeded =
    !supportNeeded &&
    (!isOnline || backlog > 0 || syncStatus.pendingItems > 0 || activePrinterIssue || syncFailed);
  const orderGuidance = isShiftActive
    ? 'Can continue taking orders'
    : 'Start a shift to take orders';
  const orderStatus: SimpleServiceStatus['orders'] = isShiftActive ? 'working' : 'start_shift';

  if (supportNeeded) {
    const problemExplanation =
      failedFinancialItems > 0
        ? 'Some payments are waiting for support to review. The POS saved them locally.'
        : invalidOrders > 0
          ? 'Some saved orders need support to review before they sync.'
          : 'The POS noticed an app crash and support should review it.';

    return {
      state: 'support_needed',
      canContinueOrders: isShiftActive,
      orderGuidance: isShiftActive ? 'Can continue taking orders' : 'Call support before starting orders',
      title: 'Support needed',
      message: 'The POS saved your work, but support should check this terminal.',
      recommendedActions: isShiftActive
        ? [
            'Keep the POS open.',
            'Do not clear data.',
            'Contact support if they have not already called.',
          ]
        : [
            'Keep the POS open.',
            'Do not clear data.',
            'Contact support before starting orders.',
          ],
      problemExplanation,
      primaryAction: 'send_support',
      secondaryAction: 'export',
      serviceStatuses: {
        orders: isShiftActive ? 'limited' : 'blocked',
        internet: isOnline ? 'connected' : 'offline',
        sync: 'failed',
        printer: printerFailures >= 3 ? 'failed' : printerConfigured ? 'ready' : 'not_configured',
        support: supportStatus,
      },
      advanced: health,
    };
  }

  if (attentionNeeded) {
    const problemExplanation = !isOnline
      ? 'The POS is not connected to the admin system right now. It will retry automatically.'
      : printerFailures > 0
        ? 'The printer is not responding. Orders are still saved, but receipts may not print until it is fixed.'
        : 'Some data is waiting to sync. The POS saved it locally and will retry automatically.';

    return {
      state: 'attention',
      canContinueOrders: isShiftActive,
      orderGuidance,
      title: 'Needs attention',
      message: 'The POS is working, but something needs a quick check.',
      recommendedActions: isShiftActive
        ? [
            'Keep taking orders.',
            'Keep the POS open.',
            'Check the internet connection if this warning stays.',
          ]
        : [
            'Start a shift before taking orders.',
            'Keep the POS open.',
            'Check the connection if this warning stays.',
          ],
      problemExplanation,
      primaryAction: 'refresh',
      secondaryAction: 'send_support',
      serviceStatuses: {
        orders: orderStatus,
        internet: isOnline ? 'connected' : 'offline',
        sync: syncFailed ? 'failed' : backlog > 0 || syncStatus.pendingItems > 0 ? 'waiting' : 'healthy',
        printer: activePrinterIssue
          ? printerFailures >= 3
            ? 'failed'
            : 'attention'
          : printerConfigured
            ? 'ready'
            : 'not_configured',
        support: supportStatus,
      },
      advanced: health,
    };
  }

  return {
    state: 'healthy',
    canContinueOrders: isShiftActive,
    orderGuidance,
    title: 'Everything is working',
    message: isShiftActive
      ? 'The POS is ready for orders.'
      : 'The POS is ready. Start a shift before taking orders.',
    recommendedActions: isShiftActive
      ? ['Keep using the POS normally.']
      : ['Start a shift when you are ready.', 'Keep the POS open.'],
    problemExplanation: isShiftActive
      ? 'Orders, sync, internet, and printer checks look good.'
      : 'No staff shift is active yet. Start a shift before taking orders.',
    primaryAction: 'refresh',
    secondaryAction: 'export',
    serviceStatuses: {
      orders: orderStatus,
      internet: isOnline ? 'connected' : 'unknown',
      sync: 'healthy',
      printer: printerConfigured ? 'ready' : 'not_configured',
      support: supportStatus,
    },
    advanced: health,
  };
};

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

const resolveSyncErrorMessage = (
  error: string | null,
  t: ReturnType<typeof useTranslation>['t'],
) => {
  if (!error) {
    return null;
  }

  if (error === 'sync_queue_failed_items') {
    return t('sync.health.errorDetail', {
      defaultValue: 'Failed sync rows are blocking a clean state.',
    });
  }

  return t(`sync.errors.${error}`, { defaultValue: error });
};

const getSyncHealthPresentation = (
  t: ReturnType<typeof useTranslation>['t'],
  state: SyncHealthState,
): SyncHealthPresentation => {
  switch (state) {
    case 'error':
      return {
        label: t('sync.health.error', { defaultValue: 'Sync Error' }),
        badgeClassName:
          'bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300',
        textClassName: 'text-red-700 dark:text-red-300',
        dotClassName: 'bg-red-500',
        panelClassName:
          'border-red-200/80 bg-red-50/80 dark:border-red-400/25 dark:bg-red-500/10',
        iconClassName: 'text-red-600 dark:text-red-300',
        detail: t('sync.health.errorDetail', {
          defaultValue: 'Failed sync rows are blocking a clean state.',
        }),
      };
    case 'blocked':
      return {
        label: t('sync.health.blocked', { defaultValue: 'Blocked' }),
        badgeClassName:
          'bg-orange-500/10 border border-orange-500/30 text-orange-700 dark:text-orange-300',
        textClassName: 'text-orange-700 dark:text-orange-300',
        dotClassName: 'bg-orange-500',
        panelClassName:
          'border-orange-200/80 bg-orange-50/80 dark:border-orange-400/25 dark:bg-orange-500/10',
        iconClassName: 'text-orange-600 dark:text-orange-300',
        detail: t('sync.health.blockedDetail', {
          defaultValue: 'A queue item is stuck and needs intervention.',
        }),
      };
    case 'pending':
      return {
        label: t('sync.health.pending', { defaultValue: 'Pending' }),
        badgeClassName:
          'bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300',
        textClassName: 'text-amber-700 dark:text-amber-300',
        dotClassName: 'bg-amber-500',
        panelClassName:
          'border-amber-200/80 bg-amber-50/80 dark:border-amber-400/25 dark:bg-amber-500/10',
        iconClassName: 'text-amber-600 dark:text-amber-300',
        detail: t('sync.health.pendingDetail', {
          defaultValue: 'Sync work is queued or currently processing.',
        }),
      };
    case 'stale':
      return {
        label: t('sync.health.stale', { defaultValue: 'Telemetry Stale' }),
        badgeClassName:
          'bg-slate-500/10 border border-slate-500/30 text-slate-700 dark:text-slate-300',
        textClassName: 'text-slate-700 dark:text-slate-300',
        dotClassName: 'bg-slate-500',
        panelClassName:
          'border-slate-200/80 bg-slate-50/80 dark:border-white/10 dark:bg-white/[0.05]',
        iconClassName: 'text-slate-600 dark:text-slate-300',
        detail: t('sync.health.staleDetail', {
          defaultValue:
            'Reachability looks fine, but sync telemetry is older than expected.',
        }),
      };
    case 'healthy':
    default:
      return {
        label: t('sync.health.healthy', { defaultValue: 'Healthy' }),
        badgeClassName:
          'bg-green-500/10 border border-green-500/30 text-green-700 dark:text-green-300',
        textClassName: 'text-green-700 dark:text-green-300',
        dotClassName: 'bg-green-500',
        panelClassName:
          'border-emerald-200/80 bg-emerald-50/80 dark:border-emerald-400/25 dark:bg-emerald-500/10',
        iconClassName: 'text-emerald-600 dark:text-emerald-300',
        detail: t('sync.health.healthyDetail', {
          defaultValue: 'No local sync backlog or failures are currently visible.',
        }),
      };
  }
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SyncStatusIndicator: React.FC<SyncStatusIndicatorProps> = ({
  className = '',
  showDetails = false,
  onOpenRecovery,
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
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
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [retryingBlockedOrder, setRetryingBlockedOrder] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  // --- System health state (eager on modal open) ---
  const [systemHealth, setSystemHealth] =
    useState<DiagnosticsSystemHealth | null>(null);
  const [lastHealthCheckedAt, setLastHealthCheckedAt] = useState<string | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const systemLoaded = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [sendingSupport, setSendingSupport] = useState(false);
  const [incidentReport, setIncidentReport] =
    useState<RemoteIncidentReportResponse | null>(null);
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

  const { isMobileWaiter, parentTerminalId } = useFeatures();
  const { endOfDayStatus, isPendingLocalSubmit } = useEndOfDayStatus(
    staff?.branchId || null,
  );

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
      setFinancialStats(normalizeFinancialStats((status as any)?.financialStats));
    } catch (error) {
      console.error('Failed to load sync status:', error);
    }
  }, [bridge.sync, loadFinancialStats]);

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
      offEvent(PARITY_QUEUE_STATUS_EVENT, handleParityQueueStatus);
      offEvent(PARITY_SYNC_STATUS_EVENT, handleParitySyncStatus);
      offEvent(REALTIME_STATUS_EVENT, handleRealtimeStatus);
      window.removeEventListener(
        'menu-sync:refreshed',
        handleMenuRefreshed as EventListener,
      );
    };
  }, [loadSyncStatus, loadFinancialStats]);

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

  const loadSystemHealth = useCallback(async () => {
    setSystemLoading(true);
    try {
      const [data, financialItems, integrity, parityItems, recoveryActions] = await Promise.all([
        bridge.diagnostics.getSystemHealth(),
        bridge.sync.getFailedFinancialItems(250),
        bridge.sync.validateFinancialIntegrity(),
        getSyncQueueBridge().listItems({ limit: 250 }),
        bridge.recovery.listActionLog(25).catch(() => []),
      ]);
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
      setRecoveryFinancialItems(
        Array.isArray(financialItems) ? financialItems : [],
      );
      setRecoveryIntegrity(
        integrity ?? {
          valid: true,
          issues: [],
        },
      );
      setRecoveryParityItems(Array.isArray(parityItems) ? parityItems : []);
      setRecentRecoveryActions(
        Array.isArray(recoveryActions) ? recoveryActions : [],
      );
      setLastHealthCheckedAt(new Date().toISOString());
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
        setFinancialStats(
          normalizeFinancialStats(
            (candidate as DiagnosticsSystemHealth).financialQueueStatus ??
              (candidate as DiagnosticsSystemHealth).syncStatusSummary?.financialStats,
          ),
        );
        setParityQueueStatus(
          normalizeParityQueueStatus(
            ((candidate as DiagnosticsSystemHealth).parityQueueStatus ??
              (candidate as DiagnosticsSystemHealth).lastParitySync?.queueStatus) as
              | QueueStatus
              | null,
          ),
        );
        setLastParitySync(
          normalizeLastParitySync((candidate as DiagnosticsSystemHealth).lastParitySync),
        );
        setLastHealthCheckedAt(new Date().toISOString());
        void bridge.sync
          .getFailedFinancialItems(250)
          .then((items) => setRecoveryFinancialItems(Array.isArray(items) ? items : []))
          .catch(() => {});
        void bridge.sync
          .validateFinancialIntegrity()
          .then((result) =>
            setRecoveryIntegrity(result ?? { valid: true, issues: [] }),
          )
          .catch(() => {});
        void getSyncQueueBridge()
          .listItems({ limit: 250 })
          .then((items) => setRecoveryParityItems(Array.isArray(items) ? items : []))
          .catch(() => {});
        void bridge.recovery
          .listActionLog(25)
          .then((items) => setRecentRecoveryActions(Array.isArray(items) ? items : []))
          .catch(() => {});
      }
    };
    const handleIncidentUpdate = (payload: any) => {
      if (payload && typeof payload === 'object') {
        setIncidentReport({
          success: Boolean(payload.success),
          candidate: payload.candidate,
          incidentId:
            payload.response?.incidentId ?? payload.incidentId ?? null,
          status: payload.response?.status ?? payload.status,
          deduped: payload.response?.deduped ?? payload.deduped,
          alertSent: payload.response?.alertSent ?? payload.alertSent,
          lastSentAt: payload.lastSentAt ?? payload.lastAttemptAt,
          error: payload.error,
        });
      }
    };
    onEvent('database-health-update', handleHealthUpdate);
    onEvent('incident-reporting-update', handleIncidentUpdate);
    return () => {
      offEvent('database-health-update', handleHealthUpdate);
      offEvent('incident-reporting-update', handleIncidentUpdate);
    };
  }, [loadSystemHealth]);

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
  // Whichever capacity dimension (replayable rows vs conflict rows) is
  // closer to its fail-closed ceiling drives the chip percentage.
  const capacityWarningPercent = capacityWarning
    ? Math.max(
        capacityWarning.replayablePercent,
        capacityWarning.conflictPercent,
      )
    : 0;

  const hasErrors =
    !!syncStatus.error ||
    financialFailedCount > 0 ||
    parityFailedCount > 0 ||
    parityConflictCount > 0;

  const hasPending =
    syncStatus.pendingItems > 0 ||
    syncStatus.backpressureDeferred > 0 ||
    syncStatus.queuedRemote > 0 ||
    syncStatus.syncInProgress ||
    financialPendingCount > 0 ||
    parityPendingCount > 0;

  const queueFailure = syncStatus.lastQueueFailure;
  const queueFailureNextRetryTs = queueFailure?.nextRetryAt
    ? toTimestamp(queueFailure.nextRetryAt)
    : null;
  const hasScheduledRetryableQueueFailure =
    !!queueFailure &&
    queueFailure.status.toLowerCase() === 'pending' &&
    (queueFailure.classification === 'transient' ||
      queueFailure.classification === 'backpressure') &&
    queueFailureNextRetryTs !== null &&
    queueFailureNextRetryTs > Date.now();

  const hasBlockedQueue =
    !!queueFailure &&
    !hasScheduledRetryableQueueFailure &&
    (queueFailure.classification === 'permanent' ||
      queueFailure.status.toLowerCase() === 'failed' ||
      queueFailure.status.toLowerCase() === 'in_progress' ||
      queueFailureNextRetryTs === null ||
      queueFailureNextRetryTs <= Date.now());

  const lastSyncTimestamp = toTimestamp(syncStatus.lastSync);
  const telemetrySyncTimestamp = toTimestamp(systemHealth?.lastSyncTime);
  const onlineMismatch =
    systemHealth !== null &&
    typeof systemHealth.isOnline === 'boolean' &&
    systemHealth.isOnline !== syncStatus.isOnline;
  const localSyncTelemetryLag =
    lastSyncTimestamp !== null &&
    telemetrySyncTimestamp !== null &&
    Math.abs(lastSyncTimestamp - telemetrySyncTimestamp) > STALE_TELEMETRY_MS;
  const actionableLocalState =
    hasErrors ||
    hasPending ||
    hasBlockedQueue ||
    queueFailure !== null;
  const missingTelemetryWhileActionable =
    syncStatus.isOnline &&
    actionableLocalState &&
    telemetrySyncTimestamp === null &&
    lastSyncTimestamp === null;
  const staleHeartbeatTelemetry =
    syncStatus.isOnline &&
    actionableLocalState &&
    telemetrySyncTimestamp !== null &&
    Date.now() - telemetrySyncTimestamp > STALE_TELEMETRY_MS;
  const isTelemetryStale =
    onlineMismatch ||
    localSyncTelemetryLag ||
    missingTelemetryWhileActionable ||
    staleHeartbeatTelemetry;

  const syncHealthState: SyncHealthState = hasBlockedQueue
    ? 'blocked'
    : hasErrors
      ? 'error'
      : isTelemetryStale
        ? 'stale'
        : hasPending
          ? 'pending'
          : 'healthy';

  const syncHealthPresentation = getSyncHealthPresentation(
    t,
    syncHealthState,
  );

  const isSynced =
    syncStatus.isOnline &&
    syncHealthState === 'healthy';

  const getTransportText = () =>
    syncStatus.isOnline
      ? t('sync.labels.online')
      : t('sync.labels.offline');

  const getStatusText = () =>
    `${getTransportText()} | ${t('sync.health.label', {
      defaultValue: 'Sync health',
    })}: ${syncHealthPresentation.label}`;

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

  const syncHealthDetail = isTelemetryStale
    ? onlineMismatch
      ? t('sync.health.staleMismatch', {
          defaultValue:
            'Transport reachability and backend telemetry disagree.',
        })
      : staleHeartbeatTelemetry || localSyncTelemetryLag
        ? t('sync.health.staleAge', {
            defaultValue:
              'Backend telemetry is older than the current local queue state.',
          })
        : t('sync.health.staleMissing', {
            defaultValue:
              'The queue still has actionable work, but telemetry freshness is unavailable.',
          })
    : syncHealthPresentation.detail;

  const effectiveLastParitySync = useMemo(
    () => lastParitySync ?? normalizeLastParitySync(systemHealth?.lastParitySync),
    [lastParitySync, systemHealth?.lastParitySync],
  );
  const representativeParityFailureReason = useMemo(
    () =>
      getRepresentativeParityFailureReason(
        effectiveLastParitySync ?? null,
        recoveryParityItems,
      ),
    [effectiveLastParitySync, recoveryParityItems],
  );

  const effectiveCredentialState = useMemo(
    () =>
      effectiveLastParitySync?.credentialState ??
      normalizeCredentialState(systemHealth?.credentialState),
    [effectiveLastParitySync?.credentialState, systemHealth?.credentialState],
  );

  const missingCredentialLabels = useMemo(() => {
    if (!effectiveCredentialState) {
      return [] as string[];
    }

    const missing: string[] = [];
    if (!effectiveCredentialState.hasAdminUrl) {
      missing.push(
        t('sync.dashboard.missingAdminUrl', { defaultValue: 'Admin URL' }),
      );
    }
    if (!effectiveCredentialState.hasApiKey) {
      missing.push(
        t('sync.dashboard.missingApiKey', { defaultValue: 'POS API key' }),
      );
    }
    return missing;
  }, [effectiveCredentialState, t]);

  const parityProcessorSummary = useMemo(() => {
    if (missingCredentialLabels.length > 0) {
      return {
        value: t('sync.dashboard.parityCredentialsMissing', {
          defaultValue: 'Credentials missing',
        }),
        detail: t('sync.dashboard.parityCredentialsMissingDetail', {
          defaultValue:
            '{{items}} must be configured before the parity queue can drain.',
          items: missingCredentialLabels.join(', '),
        }),
        accentClassName: 'text-red-600 dark:text-red-300',
      };
    }

    if (!effectiveLastParitySync) {
      return {
        value: t('sync.dashboard.parityNoAttempts', {
          defaultValue: 'No parity attempt recorded',
        }),
        detail: t('sync.dashboard.parityNoAttemptsDetail', {
          defaultValue:
            'The parity processor has not reported a startup or retry cycle yet.',
        }),
        accentClassName: 'text-slate-700 dark:text-slate-200',
      };
    }

    if (effectiveLastParitySync.status === 'started') {
      return {
        value: t('sync.dashboard.parityRunning', {
          defaultValue: 'Running now',
        }),
        detail: t('sync.dashboard.parityRunningDetail', {
          defaultValue: 'The terminal is currently draining the parity queue.',
        }),
        accentClassName: 'text-amber-600 dark:text-amber-300',
      };
    }

    if (effectiveLastParitySync.status === 'failed') {
      return {
        value: t('sync.dashboard.parityFailed', {
          defaultValue: 'Last parity sync failed',
        }),
        detail:
          representativeParityFailureReason ||
          t('sync.dashboard.parityFailedDetail', {
            defaultValue: 'The last parity sync attempt ended with an error.',
          }),
        accentClassName: 'text-red-600 dark:text-red-300',
      };
    }

    if (effectiveLastParitySync.status === 'skipped_missing_credentials') {
      return {
        value: t('sync.dashboard.paritySkipped', {
          defaultValue: 'Sync skipped',
        }),
        detail:
          effectiveLastParitySync.reason ||
          t('sync.dashboard.paritySkippedDetail', {
            defaultValue:
              'Parity sync could not start because terminal credentials are incomplete.',
          }),
        accentClassName: 'text-red-600 dark:text-red-300',
      };
    }

    return {
      value: t('sync.dashboard.parityCompleted', {
        defaultValue: 'Last parity sync completed',
      }),
      detail: t('sync.dashboard.parityCompletedDetail', {
        defaultValue: 'Processed {{processed}} item(s); {{remaining}} remaining.',
        processed: effectiveLastParitySync.processed,
        remaining: effectiveLastParitySync.remaining,
      }),
      accentClassName:
        effectiveLastParitySync.remaining > 0
          ? 'text-amber-600 dark:text-amber-300'
          : 'text-emerald-600 dark:text-emerald-300',
    };
  }, [
    effectiveLastParitySync,
    missingCredentialLabels,
    representativeParityFailureReason,
    t,
  ]);

  // --- Actions ---

  const handleForceSync = async () => {
    try {
      setSyncStatus((prev) => ({ ...prev, syncInProgress: true }));
      const result = await runParitySyncCycle({ trigger: 'manual' });
      const parityResult = normalizeLastParitySync(result.paritySyncStatus);
      setLastParitySync(parityResult);

      if (parityResult?.status === 'failed') {
        toast.error(
          parityResult.error ||
            parityResult.reason ||
            (t('sync.messages.syncFailed') || 'Sync failed'),
        );
      } else if (parityResult?.status === 'skipped_missing_credentials') {
        toast.error(
          parityResult.reason ||
            t('sync.dashboard.paritySkippedDetail', {
              defaultValue:
                'Parity sync could not start because terminal credentials are incomplete.',
            }),
        );
      } else {
        toast.success(
          t('sync.dashboard.parityCompletedDetail', {
            defaultValue: 'Processed {{processed}} item(s); {{remaining}} remaining.',
            processed: parityResult?.processed ?? 0,
            remaining: parityResult?.remaining ?? result.queueStatus?.total ?? 0,
          }),
        );
      }

      await loadSyncStatus();
      if (systemLoaded.current) {
        await loadSystemHealth();
      }
    } catch (error) {
      console.error('Failed to force sync:', error);
      toast.error(t('sync.messages.syncFailed') || 'Sync failed');
    } finally {
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

  const handleSendDiagnosticsToSupport = async () => {
    setSendingSupport(true);
    try {
      const result = await bridge.diagnostics.sendRemoteIncident();
      setIncidentReport(result);
      toast.success('Diagnostics sent to support. You can continue using the POS.');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Diagnostics could not be sent right now.';
      setIncidentReport({
        success: false,
        error: message,
        lastSentAt: new Date().toISOString(),
      });
      toast.error('Diagnostics could not be sent right now. The POS will keep working.');
    } finally {
      setSendingSupport(false);
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

  const handleOpenRecovery = () => {
    setShowFinancialPanel(false);
    setShowDetailPanel(false);
    onOpenRecovery?.({
      systemHealth,
      lastParitySync: effectiveLastParitySync ?? null,
    });
  };

  const handleRecoveryPanelRefresh = useCallback(async () => {
    await Promise.all([loadSyncStatus(), loadSystemHealth()]);
  }, [loadSyncStatus, loadSystemHealth]);

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

  const handleRetryBlockedOrder = async () => {
    const blocker = syncStatus.lastQueueFailure;
    if (!blocker || blocker.entityType !== 'order' || !blocker.entityId) {
      return;
    }
    try {
      setRetryingBlockedOrder(true);
      await bridge.orders.forceSyncRetry(blocker.entityId);
      await runParitySyncCycle();
      toast.success(
        t('sync.blocker.retryScheduled', {
          defaultValue: 'Order retry scheduled',
        }),
      );
      setTimeout(async () => {
        await loadSyncStatus();
      }, 1200);
    } catch (error) {
      console.error('Failed to retry blocked order sync:', error);
      toast.error(
        t('sync.blocker.retryFailed', {
          defaultValue: 'Failed to retry blocked order',
        }),
      );
    } finally {
      setRetryingBlockedOrder(false);
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
  const simpleHealthSummary = useMemo(() => {
    const draft = buildSimpleHealthSummary({
      health: systemHealth,
      syncStatus,
      supportStatus: 'not_sent',
      isShiftActive,
    });
    const supportStatus: SimpleServiceStatus['support'] = incidentReport?.success
      ? 'notified'
      : incidentReport?.error
        ? 'failed_to_notify'
        : draft.state === 'healthy'
          ? 'not_needed'
          : 'not_sent';

    return buildSimpleHealthSummary({
      health: systemHealth,
      syncStatus,
      supportStatus,
      isShiftActive,
    });
  }, [incidentReport, isShiftActive, syncStatus, systemHealth]);
  const syncBlockerDetails = systemHealth?.syncBlockerDetails ?? [];
  const sharedRecoveryIssues = useMemo(
    () =>
      buildSyncRecoveryIssues({
        systemHealth,
        lastParitySync: effectiveLastParitySync ?? null,
        financialItems: recoveryFinancialItems,
        integrity: recoveryIntegrity,
        parityItems: recoveryParityItems,
      }).issues,
    [
      effectiveLastParitySync,
      recoveryFinancialItems,
      recoveryIntegrity,
      recoveryParityItems,
      systemHealth,
    ],
  );

  const totalPending =
    syncStatus.pendingItems + financialPendingCount + parityPendingCount;
  const nextRetryAt = syncStatus.oldestNextRetryAt ?? queueFailure?.nextRetryAt ?? null;
  const hasInvalidOrders = (systemHealth?.invalidOrders?.count ?? 0) > 0;
  const advancedIssueCount =
    sharedRecoveryIssues.length +
    (systemHealth === null && !systemLoading ? 1 : 0);
  const shouldOpenAdvancedByDefault =
    sharedRecoveryIssues.length > 0 || (systemHealth === null && !systemLoading);
  const syncErrorDisplay = useMemo(
    () => resolveSyncErrorMessage(syncStatus.error, t),
    [syncStatus.error, t],
  );

  const healthSupportContext = useMemo(
    () =>
      buildHealthSupportContext({
        syncStatus: {
          ...syncStatus,
          error: syncErrorDisplay,
        },
        systemHealth,
        financialStats,
        totalBacklog,
        isTelemetryStale,
        hasBlockedQueue,
        hasScheduledRetry: hasScheduledRetryableQueueFailure,
        pendingReportDate: isPendingLocalSubmit
          ? endOfDayStatus.pendingReportDate
          : null,
      }),
    [
      syncStatus,
      syncErrorDisplay,
      systemHealth,
      financialStats,
      totalBacklog,
      isTelemetryStale,
      hasBlockedQueue,
      hasScheduledRetryableQueueFailure,
      isPendingLocalSubmit,
      endOfDayStatus.pendingReportDate,
    ],
  );

  const handleRefreshSupport = useCallback(async () => {
    await Promise.all([
      loadSyncStatus(),
      loadFinancialStats(),
      systemLoaded.current ? loadSystemHealth() : Promise.resolve(),
    ]);
  }, [loadFinancialStats, loadSyncStatus, loadSystemHealth]);

  const healthColor =
    syncStatus.terminalHealth >= 80
      ? 'text-green-600 dark:text-green-400'
      : syncStatus.terminalHealth >= 60
        ? 'text-yellow-600 dark:text-yellow-400'
        : 'text-red-600 dark:text-red-400';

  const heartStatusClass =
    syncHealthState === 'healthy' && syncStatus.isOnline
      ? 'text-green-400 drop-shadow-[0_0_8px_rgba(34,197,94,0.6)]'
      : syncHealthState === 'error'
        ? 'text-red-400 drop-shadow-[0_0_8px_rgba(239,68,68,0.6)]'
        : 'text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.55)]';

  useEffect(() => {
    if (showDetailPanel) {
      setAdvancedExpanded(shouldOpenAdvancedByDefault);
    }
  }, [showDetailPanel, shouldOpenAdvancedByDefault]);

  const modalSurfaceClass =
    'rounded-[28px] border border-slate-200/80 bg-white/92 p-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-white/[0.04] dark:shadow-[0_18px_40px_rgba(2,6,23,0.28)]';
  const modalInsetClass =
    'rounded-[22px] border border-slate-200/80 bg-slate-50/90 p-4 shadow-[0_10px_24px_rgba(15,23,42,0.05)] dark:border-white/10 dark:bg-black/20 dark:shadow-none';
  const modalEyebrowClass =
    'text-[11px] uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400';
  const modalMutedTextClass = 'text-sm text-slate-600 dark:text-slate-300/80';
  const metaChipClass =
    'inline-flex items-center gap-2 rounded-full border border-slate-200/90 bg-white/88 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200';
  const footerClass =
    'sticky bottom-0 z-10 mt-5 border-t border-slate-200/80 bg-white/88 px-6 py-4 backdrop-blur-xl dark:border-white/10 dark:bg-[#071018]/88';
  const detailPanelBlockerMetadata = useMemo(
    () => ({
      advancedExpanded,
      showFinancialPanel,
    }),
    [advancedExpanded, showFinancialPanel],
  );

  useBlockerRegistration({
    id: 'sync-status-detail-panel',
    label: 'Sync detail panel',
    source: 'sync-status',
    active: showDetailPanel,
    metadata: detailPanelBlockerMetadata,
  });

  const renderMetricTile = ({
    label,
    value,
    detail,
    valueClassName,
    surfaceClassName,
  }: {
    label: string;
    value: React.ReactNode;
    detail?: string;
    valueClassName?: string;
    surfaceClassName?: string;
  }) => (
    <div className={cn(modalInsetClass, 'space-y-2', surfaceClassName)}>
      <div className={modalEyebrowClass}>{label}</div>
      <div className={cn('text-2xl font-black tracking-tight text-slate-900 dark:text-white', valueClassName)}>
        {value}
      </div>
      {detail ? <p className="text-xs text-slate-500 dark:text-slate-400">{detail}</p> : null}
    </div>
  );

  const renderStatusTile = ({
    label,
    value,
    detail,
    accentClassName,
  }: {
    label: string;
    value: React.ReactNode;
    detail?: React.ReactNode;
    accentClassName?: string;
  }) => (
    <div className={modalInsetClass}>
      <div className={modalEyebrowClass}>{label}</div>
      <div className={cn('mt-2 text-lg font-black text-slate-900 dark:text-white', accentClassName)}>
        {value}
      </div>
      {detail ? <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail}</div> : null}
    </div>
  );

  const renderOverviewSection = () => (
    <section className={cn(modalSurfaceClass, syncHealthPresentation.panelClassName)}>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.95fr)]">
        <div className="space-y-4">
          <div className={modalEyebrowClass}>{t('sync.dashboard.overviewEyebrow')}</div>
          <div className="flex items-start gap-4">
            <div className={cn('flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] border', syncHealthPresentation.panelClassName)}>
              <svg
                className={cn('h-7 w-7', syncHealthPresentation.iconClassName)}
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
              </svg>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">
                  {t('sync.dashboard.overviewTitle')}
                </h3>
                <span
                  className={cn(
                    'inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-semibold',
                    syncHealthPresentation.badgeClassName,
                  )}
                >
                  <span className={cn('h-2.5 w-2.5 rounded-full', syncHealthPresentation.dotClassName)} />
                  {syncHealthPresentation.label}
                </span>
              </div>
              <p className="mt-3 max-w-3xl text-sm text-slate-600 dark:text-slate-300/85">
                {syncHealthDetail}
              </p>
              {capacityWarning && (
                <div className="mt-3 flex max-w-3xl items-start gap-2.5 rounded-[18px] border border-orange-500/30 bg-orange-500/10 px-4 py-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-orange-600 dark:text-orange-300" />
                  <div className="min-w-0 text-sm text-orange-800 dark:text-orange-200">
                    <p className="font-semibold">
                      {t('sync.capacity.title', { defaultValue: 'Sync backlog growing' })}
                    </p>
                    <p className="mt-1 text-xs text-orange-700/90 dark:text-orange-200/80">
                      {t('sync.capacity.detail', {
                        defaultValue:
                          'New sales stop when the offline queue is full. Reconnect this terminal so the backlog can drain.',
                      })}
                    </p>
                    <p className="mt-1 text-xs font-medium tabular-nums">
                      {t('sync.capacity.replayable', {
                        defaultValue: 'Queued for replay: {{current}} of {{max}}',
                        current: capacityWarning.replayable,
                        max: capacityWarning.maxReplayable,
                      })}
                      {capacityWarning.conflicts > 0
                        ? ` · ${t('sync.capacity.conflicts', {
                            defaultValue: 'Unresolved conflicts: {{current}} of {{max}}',
                            current: capacityWarning.conflicts,
                            max: capacityWarning.maxConflicts,
                          })}`
                        : null}
                    </p>
                  </div>
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <span className={metaChipClass}>
                  <span className={cn('h-2 w-2 rounded-full', syncStatus.isOnline ? 'bg-green-500' : 'bg-red-500')} />
                  {t('sync.dashboard.transportLabel')}: {syncStatus.isOnline ? t('sync.labels.online') : t('sync.labels.offline')}
                </span>
                <span className={metaChipClass}>
                  {t('sync.dashboard.lastSyncLabel')}: {formatLastSync()}
                </span>
                <span className={cn(metaChipClass, healthColor)}>
                  {t('sync.dashboard.healthScoreLabel')}: {Math.round(syncStatus.terminalHealth)}%
                </span>
                <span className={metaChipClass}>
                  {t('sync.dashboard.realtimeLabel', { defaultValue: 'Realtime' })}: {realtimeStatus}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          {renderStatusTile({
            label: t('sync.dashboard.statusSummaryTitle'),
            value: isSynced ? t('sync.dashboard.allClear') : syncHealthPresentation.label,
            detail: t('sync.dashboard.statusSummarySubtitle'),
            accentClassName: syncHealthPresentation.textClassName,
          })}
          {renderStatusTile({
            label: t('sync.dashboard.parityProcessorTitle', {
              defaultValue: 'Parity processor',
            }),
            value: parityProcessorSummary.value,
            detail: parityProcessorSummary.detail,
            accentClassName: parityProcessorSummary.accentClassName,
          })}
          <HealthSupportEntryPoint
            context={healthSupportContext}
            onExportDiagnostics={handleExport}
            onRefreshStatus={handleRefreshSupport}
            onOpenFinancialPanel={() => setShowFinancialPanel(true)}
            showWhenFallback
            className="w-full"
            buttonClassName="w-full justify-center rounded-[18px] border border-slate-200/90 bg-white/88 px-4 py-3 text-sm font-semibold text-slate-700 active:bg-slate-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:active:bg-white/[0.08]"
          />
          <button
            type="button"
            onClick={handleOpenRecovery}
            className="w-full justify-center rounded-[18px] border border-slate-200/90 bg-white/88 px-4 py-3 text-sm font-semibold text-slate-700 active:bg-slate-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:active:bg-white/[0.08] inline-flex items-center gap-2"
          >
            <Database className="h-4 w-4" />
            {t('sync.dashboard.openRecovery', { defaultValue: 'Open Recovery Center' })}
          </button>
        </div>
      </div>
    </section>
  );

  const renderActionableSection = () => (
    <section className={cn(modalSurfaceClass, 'space-y-4')}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className={modalEyebrowClass}>{t('sync.dashboard.actionableTitle')}</div>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/80">
            {t('sync.dashboard.actionableSubtitle')}
          </p>
        </div>
        <span
          className={cn(
            'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold',
            isSynced
              ? 'border border-emerald-200/90 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-200'
              : syncHealthPresentation.badgeClassName,
          )}
        >
          {isSynced ? t('sync.dashboard.allClear') : t('sync.system.pending', { count: totalPending })}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {renderMetricTile({
          label: t('sync.dashboard.localQueue'),
          value: syncStatus.pendingItems,
          valueClassName:
            syncStatus.pendingItems > 0
              ? 'text-amber-600 dark:text-amber-300'
              : 'text-emerald-600 dark:text-emerald-300',
        })}
        {renderMetricTile({
          label: t('sync.dashboard.parityQueue', {
            defaultValue: 'Parity Queue Pending',
          }),
          value: parityPendingCount,
          valueClassName:
            parityPendingCount > 0
              ? 'text-amber-600 dark:text-amber-300'
              : 'text-emerald-600 dark:text-emerald-300',
        })}
        {renderMetricTile({
          label: t('sync.dashboard.parityConflicts', {
            defaultValue: 'Parity Queue Conflicts',
          }),
          value: parityConflictCount,
          valueClassName:
            parityConflictCount > 0
              ? 'text-red-600 dark:text-red-300'
              : 'text-emerald-600 dark:text-emerald-300',
        })}
        {renderMetricTile({
          label: t('sync.dashboard.pendingPayments'),
          value: financialPendingCount,
          valueClassName:
            financialPendingCount > 0
              ? 'text-amber-600 dark:text-amber-300'
              : 'text-emerald-600 dark:text-emerald-300',
        })}
        {renderMetricTile({
          label: t('sync.dashboard.failedPayments'),
          value: financialFailedCount,
          valueClassName:
            financialFailedCount > 0
              ? 'text-red-600 dark:text-red-300'
              : 'text-emerald-600 dark:text-emerald-300',
        })}
        {renderMetricTile({
          label: t('sync.dashboard.queuedRemote'),
          value: syncStatus.queuedRemote,
          valueClassName:
            syncStatus.queuedRemote > 0
              ? 'text-cyan-600 dark:text-cyan-300'
              : 'text-slate-700 dark:text-slate-200',
        })}
        {renderMetricTile({
          label: t('sync.dashboard.historicalZReportConflicts', {
            defaultValue: 'Historical Z-report Conflicts',
          }),
          value: syncStatus.historicalZReportConflicts,
          valueClassName:
            syncStatus.historicalZReportConflicts > 0
              ? 'text-slate-600 dark:text-slate-300'
              : 'text-emerald-600 dark:text-emerald-300',
        })}
        {renderMetricTile({
          label: t('sync.dashboard.deferred'),
          value: syncStatus.backpressureDeferred,
          valueClassName:
            syncStatus.backpressureDeferred > 0
              ? 'text-amber-600 dark:text-amber-300'
              : 'text-slate-700 dark:text-slate-200',
        })}
        {renderMetricTile({
          label: t('sync.dashboard.nextRetry'),
          value: nextRetryAt ? new Date(nextRetryAt).toLocaleTimeString() : t('sync.dashboard.notAvailable'),
          valueClassName: nextRetryAt ? 'text-amber-600 dark:text-amber-300 text-lg' : 'text-slate-700 dark:text-slate-200 text-lg',
        })}
      </div>

      {queueFailure && hasBlockedQueue && (
        <div className="rounded-[22px] border border-orange-200/90 bg-orange-50/90 p-4 dark:border-orange-400/30 dark:bg-orange-500/10">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className={modalEyebrowClass}>{t('sync.blocker.title')}</div>
                <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
                  {ENTITY_TYPE_KEYS[queueFailure.entityType]
                    ? t(ENTITY_TYPE_KEYS[queueFailure.entityType], { defaultValue: queueFailure.entityType })
                    : queueFailure.entityType}{' '}
                  {queueFailure.entityId}
                </div>
              </div>
              <span className="text-xs font-bold uppercase tracking-wide text-orange-700 dark:text-orange-300">
                {t(`sync.blocker.classification.${queueFailure.classification}`, {
                  defaultValue: queueFailure.classification,
                })}
              </span>
            </div>

            <p className="break-words text-sm font-medium text-orange-800 dark:text-orange-100/90">
              {queueFailure.lastError}
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="text-xs text-slate-700 dark:text-slate-200">
                <span className="font-semibold">{t('sync.blocker.retryProgress')}:</span>{' '}
                <span className="font-mono">{queueFailure.retryCount}/{queueFailure.maxRetries}</span>
              </div>
              <div className="text-xs text-slate-700 dark:text-slate-200">
                <span className="font-semibold">{t('sync.blocker.status')}:</span>{' '}
                <span className="font-mono">{queueFailure.status}</span>
              </div>
              {queueFailure.nextRetryAt && (
                <div className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                  {t('sync.blocker.nextRetry')}: {new Date(queueFailure.nextRetryAt).toLocaleTimeString()}
                </div>
              )}
            </div>

            {queueFailure.entityType === 'order' && (
              <button
                onClick={handleRetryBlockedOrder}
                disabled={retryingBlockedOrder || syncStatus.syncInProgress}
                className="inline-flex items-center justify-center rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-semibold text-black transition-all active:bg-yellow-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {retryingBlockedOrder ? t('sync.blocker.retrying') : t('sync.blocker.retryOrderNow')}
              </button>
            )}
          </div>
        </div>
      )}

      {queueFailure && hasScheduledRetryableQueueFailure && (
        <div className="rounded-[22px] border border-amber-200/90 bg-amber-50/90 p-4 dark:border-amber-400/30 dark:bg-amber-500/10">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className={modalEyebrowClass}>{t('sync.blocker.recoveryTitle')}</div>
              <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">
                {t('sync.blocker.recoveryDetail')}
              </p>
            </div>
            <span className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
              {t(`sync.blocker.classification.${queueFailure.classification}`, {
                defaultValue: queueFailure.classification,
              })}
            </span>
          </div>
        </div>
      )}

      {syncErrorDisplay && (
        <div className="rounded-[22px] border border-red-200/90 bg-red-50/90 p-4 dark:border-red-400/30 dark:bg-red-500/10">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-300" />
            <div>
              <div className="text-sm font-semibold text-red-700 dark:text-red-300">
                {t('sync.labels.error')}
              </div>
              <p className="mt-1 text-sm text-red-700 dark:text-red-200/90">
                {syncErrorDisplay}
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );

  const renderOperationsSection = () => (
    <section className={cn(modalSurfaceClass, 'space-y-4')}>
      <div>
        <div className={modalEyebrowClass}>{t('sync.dashboard.operationsTitle')}</div>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/80">
          {t('sync.dashboard.operationsSubtitle')}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {renderStatusTile({
          label: t('sync.labels.settings'),
          value: `v${syncStatus.settingsVersion}`,
          accentClassName: 'text-purple-700 dark:text-purple-300',
        })}
        {renderStatusTile({
          label: t('sync.labels.menu'),
          value: `v${syncStatus.menuVersion}`,
          accentClassName: 'text-cyan-700 dark:text-cyan-300',
        })}
        <div className={cn(modalInsetClass, 'sm:col-span-2')}>
          <div className={modalEyebrowClass}>{t('sync.dashboard.versionsTitle')}</div>
          <div className="mt-2 text-lg font-black text-slate-900 dark:text-white">
            {isMobileWaiter
              ? t('terminal.type.mobile_waiter', { defaultValue: 'Mobile POS' })
              : t('terminal.type.main', { defaultValue: 'Main' })}
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t('sync.dashboard.versionsSubtitle')}
          </p>
          {isMobileWaiter && parentTerminalId && (
            <div className="mt-3 inline-flex items-center rounded-full border border-slate-200/90 bg-white/90 px-3 py-1 text-xs font-semibold text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200">
              {t('terminal.labels.parentTerminal', { defaultValue: 'Parent' })}: {parentTerminalId.substring(0, 8)}...
            </div>
          )}
        </div>
      </div>

      <OrderSyncRouteIndicator variant="dashboard" className="mt-0" />

      <div className={modalInsetClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={modalEyebrowClass}>{t('sync.dashboard.financialSummaryTitle')}</div>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/80">
              {t('sync.dashboard.financialSummarySubtitle')}
            </p>
          </div>
          <div className="flex items-center gap-2">
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
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-emerald-200/90 bg-emerald-50 text-emerald-700 transition-colors active:bg-emerald-100 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-200 dark:active:bg-emerald-500/16"
              aria-label={t('sync.actions.refresh', { defaultValue: 'Refresh' })}
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              onClick={() => setShowFinancialPanel(true)}
              className="inline-flex items-center rounded-full border border-slate-200/90 bg-white/90 px-3 py-2 text-xs font-semibold text-slate-700 transition-colors active:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:active:bg-white/[0.08]"
            >
              {t('sync.actions.manage')}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {(
            [
              ['driver_earnings', 'sync.financial.driver'],
              ['staff_payments', 'sync.financial.staff'],
              ['shift_expenses', 'sync.financial.expenses'],
            ] as const
          ).map(([key, label]) => {
            const stats = financialStats[key];
            const hasFailed = stats.failed > 0;
            const hasPendingItems = stats.pending > 0;

            return (
              <div
                key={key}
                className={cn(
                  'rounded-[18px] border px-4 py-3',
                  hasFailed
                    ? 'border-red-200/90 bg-red-50/85 dark:border-red-400/30 dark:bg-red-500/10'
                    : hasPendingItems
                      ? 'border-amber-200/90 bg-amber-50/85 dark:border-amber-400/30 dark:bg-amber-500/10'
                      : 'border-emerald-200/90 bg-emerald-50/85 dark:border-emerald-400/30 dark:bg-emerald-500/10',
                )}
              >
                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                  {t(label)}
                </div>
                <div className="mt-3 text-sm font-semibold text-slate-900 dark:text-white">
                  {hasFailed
                    ? `${stats.failed} ${t('sync.financial.failed')}`
                    : hasPendingItems
                      ? `${stats.pending} ${t('sync.financial.pending')}`
                      : t('sync.financial.complete')}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );

  const renderAdvancedDiagnosticsSection = () => (
    <section className={modalSurfaceClass}>
      <button
        type="button"
        onClick={() => setAdvancedExpanded((current) => !current)}
        className="flex w-full items-start justify-between gap-4 text-left"
      >
        <div>
          <div className={modalEyebrowClass}>{t('sync.dashboard.advancedTitle')}</div>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/80">
            {t('sync.dashboard.advancedSubtitle')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold',
              advancedIssueCount > 0
                ? 'border border-amber-200/90 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200'
                : 'border border-emerald-200/90 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-200',
            )}
          >
            {advancedIssueCount > 0 ? t('sync.system.pending', { count: advancedIssueCount }) : t('sync.dashboard.allClear')}
          </span>
          <ChevronDown
            className={cn(
              'h-5 w-5 text-slate-500 transition-transform dark:text-slate-300',
              advancedExpanded && 'rotate-180',
            )}
          />
        </div>
      </button>

      {advancedExpanded && (
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          {systemLoading && !systemHealth ? (
            <div className="xl:col-span-2 flex items-center justify-center rounded-[22px] border border-slate-200/80 bg-slate-50/90 py-10 dark:border-white/10 dark:bg-black/20">
              <div className="flex items-center gap-3 text-sm font-semibold text-slate-600 dark:text-slate-300">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {t('sync.dashboard.loadingDiagnostics')}
              </div>
            </div>
          ) : systemHealth ? (
            <>
              <div className={cn(modalInsetClass, 'xl:col-span-2')}>
                <div className="flex items-center justify-between">
                  <div className={modalEyebrowClass}>
                    {t('sync.recoveryCenter.title', { defaultValue: 'Recovery Center' })}
                  </div>
                  <span className={cn(
                    'text-xs font-semibold',
                    sharedRecoveryIssues.length > 0
                      ? 'text-amber-600 dark:text-amber-300'
                      : 'text-emerald-600 dark:text-emerald-300',
                  )}>
                    {sharedRecoveryIssues.length > 0
                      ? t('sync.system.pending', { count: sharedRecoveryIssues.length })
                      : t('sync.dashboard.allClear')}
                  </span>
                </div>
                <div className="mt-4 space-y-3">
                  {sharedRecoveryIssues.length > 0 ? (
                    sharedRecoveryIssues.slice(0, 6).map((issue) => (
                      <div
                        key={issue.id}
                        className={cn(
                          'rounded-[18px] border px-4 py-3',
                          issue.status === 'recovering'
                            ? 'border-sky-200/80 bg-sky-50/80 dark:border-sky-400/25 dark:bg-sky-500/10'
                            : issue.severity === 'critical'
                              ? 'border-red-200/80 bg-red-50/80 dark:border-red-400/25 dark:bg-red-500/10'
                              : issue.severity === 'error'
                                ? 'border-amber-200/80 bg-amber-50/80 dark:border-amber-400/25 dark:bg-amber-500/10'
                                : 'border-slate-200/80 bg-slate-50/80 dark:border-white/10 dark:bg-black/20',
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-slate-900 dark:text-white">
                              {t(issue.titleKey, {
                                ...issue.params,
                                defaultValue: issue.code,
                              })}
                            </div>
                            <div className="mt-1 text-xs text-slate-600 dark:text-slate-300/80">
                              {t(issue.summaryKey, {
                                ...issue.params,
                                defaultValue: issue.entityId,
                              })}
                            </div>
                          </div>
                          <span className="rounded-full border border-white/60 bg-white/80 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-700 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-200">
                            {t(`recovery.status.${issue.status}`, {
                              defaultValue: issue.status,
                            })}
                          </span>
                        </div>
                        <div className="mt-2 text-xs text-slate-600 dark:text-slate-300/80">
                          {t(issue.guidanceKey, {
                            ...issue.params,
                            defaultValue: issue.code,
                          })}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {t('sync.recoveryCenter.noIssues', {
                        defaultValue: 'No actionable recovery issues are currently visible.',
                      })}
                    </p>
                  )}
                </div>
              </div>

              <div className={modalInsetClass}>
                <div className="flex items-center justify-between">
                  <div className={modalEyebrowClass}>{t('sync.system.syncBacklog')}</div>
                  <span className={cn(
                    'text-xs font-semibold',
                    totalBacklog > 0 ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300',
                  )}>
                    {totalBacklog > 0 ? t('sync.system.pending', { count: totalBacklog }) : t('sync.system.clear')}
                  </span>
                </div>
                <div className="mt-4 space-y-2">
                  {totalBacklog > 0 ? (
                    Object.entries(systemHealth.syncBacklog).map(([type, statuses]) => {
                      const pending = Object.entries(statuses)
                        .filter(([s]) => s !== 'synced' && s !== 'applied')
                        .reduce((sum, [, count]) => sum + count, 0);
                      if (pending === 0) return null;
                      return (
                        <div key={type} className="flex items-center justify-between text-sm text-slate-700 dark:text-slate-200">
                          <span>{ENTITY_TYPE_KEYS[type] ? t(ENTITY_TYPE_KEYS[type], { defaultValue: type }) : type}</span>
                          <span className="font-mono font-semibold">{pending}</span>
                        </div>
                      );
                    })
                  ) : (
                    <p className="text-sm text-slate-500 dark:text-slate-400">{t('sync.dashboard.allClear')}</p>
                  )}
                </div>
              </div>

              {syncBlockerDetails.length > 0 && (
                <div className={cn(modalInsetClass, 'xl:col-span-2')}>
                  <div className="flex items-center justify-between">
                    <div className={modalEyebrowClass}>{t('sync.system.blockingItems', { defaultValue: 'Blocking Items' })}</div>
                    <span className="text-xs font-semibold text-amber-600 dark:text-amber-300">
                      {t('sync.system.pending', { count: syncBlockerDetails.length })}
                    </span>
                  </div>
                  <div className="mt-4 space-y-3">
                    {syncBlockerDetails.map((blocker) => {
                      const orderReference =
                        blocker.orderNumber || blocker.orderId || blocker.entityId;
                      return (
                        <div
                          key={`${blocker.queueId}-${blocker.entityType}-${blocker.entityId}`}
                          className="rounded-[18px] border border-amber-200/80 bg-amber-50/80 px-4 py-3 text-sm dark:border-amber-400/25 dark:bg-amber-500/10"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="font-semibold text-slate-900 dark:text-white">
                              {ENTITY_TYPE_KEYS[blocker.entityType]
                                ? t(ENTITY_TYPE_KEYS[blocker.entityType], { defaultValue: blocker.entityType })
                                : blocker.entityType}
                            </div>
                            <div className="font-mono text-xs text-amber-700 dark:text-amber-200">
                              {blocker.queueStatus}
                            </div>
                          </div>
                          <div className="mt-2 text-sm text-slate-700 dark:text-slate-200">
                            {orderReference}
                          </div>
                          <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                            {getLocalizedSyncBlockerReason(blocker, t)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {(systemHealth.invalidOrders?.count ?? 0) > 0 && (
                <div className="rounded-[22px] border border-red-200/90 bg-red-50/90 p-4 dark:border-red-400/30 dark:bg-red-500/10">
                  <div className="flex items-center justify-between gap-3">
                    <div className={modalEyebrowClass}>{t('sync.system.invalidOrders')}</div>
                    <span className="text-sm font-semibold text-red-700 dark:text-red-300">
                      {t('sync.system.invalidCount', {
                        count: systemHealth.invalidOrders!.count,
                        defaultValue: '{{count}} invalid',
                      })}
                    </span>
                  </div>
                  <p className="mt-3 text-sm text-red-700 dark:text-red-100/90">
                    {t('sync.system.invalidOrdersDesc')}
                  </p>
                  <button
                    onClick={handleRemoveInvalidOrders}
                    className="mt-4 inline-flex items-center justify-center rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors active:bg-red-700"
                  >
                    {t('sync.system.removeInvalidOrders')}
                  </button>
                  <div className="mt-4 space-y-2">
                    {systemHealth.invalidOrders!.details.slice(0, 5).map((order) => (
                      <div key={order.order_id} className="flex items-center justify-between text-xs text-red-700 dark:text-red-200/90">
                        <span className="font-mono">{order.order_id.substring(0, 8)}...</span>
                        <span>{order.invalid_menu_items.length} {t('sync.system.items')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className={modalInsetClass}>
                <div className="flex items-center justify-between">
                  <div className={modalEyebrowClass}>{t('sync.system.printers')}</div>
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    {systemHealth.printerStatus.configured
                      ? t('sync.system.configured', {
                          count: systemHealth.printerStatus.profileCount,
                          defaultValue: '{{count}} configured',
                        })
                      : t('sync.system.notConfigured')}
                  </span>
                </div>
                {systemHealth.printerStatus.defaultProfile && (
                  <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                    {t('sync.system.defaultPrinter')}: {systemHealth.printerStatus.defaultProfile}
                  </div>
                )}
                {systemHealth.printerStatus.recentJobs.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {systemHealth.printerStatus.recentJobs.slice(0, 3).map((job) => (
                      <div key={job.id} className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-200">
                        <span>
                          {ENTITY_TYPE_KEYS[job.entityType]
                            ? t(ENTITY_TYPE_KEYS[job.entityType], { defaultValue: job.entityType })
                            : job.entityType}
                        </span>
                        <span
                          className={cn(
                            'font-mono',
                            job.status === 'printed' || job.status === 'dispatched'
                              ? 'text-emerald-600 dark:text-emerald-300'
                              : job.status === 'failed'
                                ? 'text-red-600 dark:text-red-300'
                                : 'text-amber-600 dark:text-amber-300',
                          )}
                        >
                          {job.status}
                          {job.warningCode ? ' !' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className={modalInsetClass}>
                <div className="flex items-center justify-between">
                  <div className={modalEyebrowClass}>{t('sync.system.lastZReport')}</div>
                  {systemHealth.lastZReport && <FileText className="h-4 w-4 text-blue-600 dark:text-blue-300" />}
                </div>
                {systemHealth.lastZReport ? (
                  <div className="mt-4 space-y-2 text-sm text-slate-700 dark:text-slate-200">
                    <div className="flex justify-between">
                      <span>{t('sync.system.gross')}</span>
                      <span className="font-semibold">{formatCurrency(systemHealth.lastZReport.totalGrossSales)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>{t('sync.system.net')}</span>
                      <span className="font-semibold">{formatCurrency(systemHealth.lastZReport.totalNetSales)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>{t('sync.system.generated')}</span>
                      <span className="font-mono text-xs">{new Date(systemHealth.lastZReport.generatedAt).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>{t('sync.system.syncState')}</span>
                      <span className={cn(
                        'font-mono',
                        systemHealth.lastZReport.syncState === 'applied'
                          ? 'text-emerald-600 dark:text-emerald-300'
                          : 'text-amber-600 dark:text-amber-300',
                      )}>
                        {systemHealth.lastZReport.syncState}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
                    {t('sync.system.noReports')}
                  </p>
                )}
              </div>

              <div className={modalInsetClass}>
                <div className={modalEyebrowClass}>{t('sync.system.database')}</div>
                <div className="mt-4 flex items-center gap-3">
                  <Database className="h-5 w-5 text-purple-600 dark:text-purple-300" />
                  <div>
                    <div className="text-lg font-black text-purple-700 dark:text-purple-300">
                      v{systemHealth.schemaVersion}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {formatBytes(systemHealth.dbSizeBytes)}
                    </div>
                  </div>
                </div>
                <div className="mt-4 border-t border-slate-200/80 pt-4 dark:border-white/10">
                  <div className={modalEyebrowClass}>{t('sync.labels.pending')}</div>
                  <div className="mt-2 flex items-center gap-2 text-lg font-black text-slate-900 dark:text-white">
                    {systemHealth.pendingOrders === 0 ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
                    ) : (
                      <Clock className="h-5 w-5 text-amber-600 dark:text-amber-300" />
                    )}
                    <span>{systemHealth.pendingOrders}</span>
                  </div>
                </div>
              </div>

              {Object.keys(systemHealth.lastSyncTimes).length > 0 && (
                <div className={cn(modalInsetClass, 'xl:col-span-2')}>
                  <div className={modalEyebrowClass}>{t('sync.system.lastSyncByEntity')}</div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {Object.entries(systemHealth.lastSyncTimes).map(([entity, ts]) => (
                      <div key={entity} className="rounded-[18px] border border-slate-200/80 bg-white/80 px-3 py-3 dark:border-white/10 dark:bg-white/[0.03]">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                          {ENTITY_TYPE_KEYS[entity] ? t(ENTITY_TYPE_KEYS[entity], { defaultValue: entity }) : entity}
                        </div>
                        <div className="mt-2 break-words text-xs font-mono text-slate-700 dark:text-slate-200">
                          {ts ? new Date(ts).toLocaleString() : '\u2014'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="xl:col-span-2 rounded-[22px] border border-amber-200/90 bg-amber-50/90 p-5 dark:border-amber-400/30 dark:bg-amber-500/10">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300" />
                <div>
                  <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                    {t('sync.dashboard.advancedTitle')}
                  </div>
                  <p className="mt-1 text-sm text-amber-700 dark:text-amber-100/90">
                    {t('sync.system.retry')}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );

  const renderDetailModal = () => {
    const summary = simpleHealthSummary;
    const visual = {
      healthy: {
        icon: CheckCircle2,
        shell: 'border-yellow-300/45 bg-[#101008] text-white',
        iconBox: 'bg-white text-black ring-1 ring-yellow-300/70',
        title: 'Everything is working',
      },
      attention: {
        icon: AlertTriangle,
        shell: 'border-yellow-400/55 bg-[#1a1212] text-yellow-50',
        iconBox: 'bg-yellow-400 text-black',
        title: 'Needs attention',
      },
      support_needed: {
        icon: AlertTriangle,
        shell: 'border-red-500/55 bg-[#1d0e0e] text-white',
        iconBox: 'bg-red-600 text-white',
        title: 'Support needed',
      },
    }[summary.state];
    const StatusIcon = visual.icon;
    const statusLabels: Record<string, string> = {
      working: 'Working',
      limited: 'Limited',
      blocked: 'Blocked',
      start_shift: 'Start shift',
      connected: 'Connected',
      offline: 'Offline',
      unknown: 'Unknown',
      healthy: 'Healthy',
      waiting: 'Waiting',
      failed: 'Failed',
      ready: 'Ready',
      attention: 'Check',
      not_configured: 'Not set',
      not_needed: 'Not needed',
      notified: 'Notified',
      not_sent: 'Not sent',
      failed_to_notify: 'Try again',
    };
    const serviceItems = [
      { label: 'Orders', value: summary.serviceStatuses.orders },
      { label: 'Internet', value: summary.serviceStatuses.internet },
      { label: 'Sync', value: summary.serviceStatuses.sync },
      { label: 'Printer', value: summary.serviceStatuses.printer },
      { label: 'Support', value: summary.serviceStatuses.support },
    ];
    const lastChecked = lastHealthCheckedAt ? formatDate(lastHealthCheckedAt) : 'Not checked yet';

    return ReactDOM.createPortal(
      <div className="fixed inset-0 z-[10000]" style={{ isolation: 'isolate' }}>
        <div
          className="absolute inset-0 bg-black/45 backdrop-blur-md"
          onClick={() => setShowDetailPanel(false)}
        />

        <div
          className="absolute inset-0 z-[10050] flex items-center justify-center px-3 py-4 sm:px-6 sm:py-8"
          onClick={() => setShowDetailPanel(false)}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-yellow-400/25 bg-[#050505] shadow-2xl shadow-black/70"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-yellow-400/15 px-5 py-4">
              <div className="min-w-0">
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-yellow-200/70">
                  Health Status
                </div>
                <h3 className="truncate text-xl font-black text-white">
                  POS status
                </h3>
              </div>
              <button
                onClick={() => setShowDetailPanel(false)}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/[0.06] text-white active:bg-white/[0.12]"
                aria-label="Close health status"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <section className={cn('rounded-3xl border p-5', visual.shell)}>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <div className={cn('flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl', visual.iconBox)}>
                    <StatusIcon className="h-9 w-9" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold">Status: {visual.title}</div>
                    <h2 className="mt-1 text-2xl font-black tracking-tight">{summary.title}</h2>
                    <p className="mt-2 max-w-2xl text-base leading-7">{summary.message}</p>
                    <div className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-white/10 px-4 text-sm font-black text-white">
                      {summary.canContinueOrders ? (
                        <CheckCircle2 className="h-4 w-4 text-yellow-300" />
                      ) : summary.state === 'support_needed' ? (
                        <AlertTriangle className="h-4 w-4 text-red-500" />
                      ) : (
                        <Clock className="h-4 w-4 text-yellow-300" />
                      )}
                      {summary.orderGuidance}
                    </div>
                    <div className="mt-3 text-sm opacity-80">Last checked: {lastChecked}</div>
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {serviceItems.map((item) => (
                    <div key={item.label} className="rounded-2xl border border-yellow-400/10 bg-white/[0.08] px-3 py-3">
                      <div className="text-xs font-bold uppercase tracking-wide text-yellow-100/70">{item.label}</div>
                      <div className="mt-1 text-sm font-black">{statusLabels[item.value] ?? item.value}</div>
                    </div>
                  ))}
                </div>
              </section>

              <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1fr]">
                <section className="rounded-3xl border border-yellow-400/15 bg-[#0c0c0c] p-5">
                  <h4 className="text-lg font-black text-white">What you should do</h4>
                  <ol className="mt-4 space-y-3">
                    {summary.recommendedActions.slice(0, 3).map((action, index) => (
                      <li key={action} className="flex gap-3 text-base text-white/85">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-yellow-300/50 bg-white text-sm font-black text-black">
                          {index + 1}
                        </span>
                        <span className="pt-1">{action}</span>
                      </li>
                    ))}
                  </ol>
                </section>

                <section className="rounded-3xl border border-yellow-400/15 bg-[#0c0c0c] p-5">
                  <h4 className="text-lg font-black text-white">What is happening</h4>
                  <p className="mt-4 text-base leading-7 text-white/85">
                    {summary.problemExplanation}
                  </p>
                  {incidentReport?.success && (
                    <div className="mt-4 rounded-2xl border border-yellow-400/30 bg-yellow-400/10 p-3 text-sm font-semibold text-yellow-50">
                      Support has received the diagnostic report.
                      {incidentReport.incidentId ? (
                        <span className="mt-1 block text-xs font-medium">Incident ID: {incidentReport.incidentId}</span>
                      ) : null}
                    </div>
                  )}
                  {incidentReport?.error && (
                    <div className="mt-4 rounded-2xl border border-yellow-400/30 bg-yellow-400/10 p-3 text-sm font-semibold text-yellow-50">
                      Diagnostics could not be sent right now. The POS will keep working and you can try again later.
                    </div>
                  )}
                </section>
              </div>

              <section className="mt-5 rounded-3xl border border-yellow-400/15 bg-[#0c0c0c] p-5">
                <h4 className="text-lg font-black text-white">Support actions</h4>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <button
                    onClick={loadSystemHealth}
                    disabled={systemLoading}
                    className="inline-flex min-h-[54px] items-center justify-center gap-2 rounded-2xl bg-white px-4 text-sm font-black text-black active:bg-yellow-50 disabled:opacity-50"
                  >
                    <RefreshCw className={cn('h-5 w-5', systemLoading && 'animate-spin')} />
                    Refresh status
                  </button>
                  <button
                    onClick={handleSendDiagnosticsToSupport}
                    disabled={sendingSupport}
                    className="inline-flex min-h-[54px] items-center justify-center gap-2 rounded-2xl border border-yellow-300 bg-yellow-400 px-4 text-sm font-black text-black active:bg-yellow-300 disabled:opacity-50"
                  >
                    <Send className={cn('h-5 w-5', sendingSupport && 'animate-pulse')} />
                    {sendingSupport ? 'Sending...' : 'Send diagnostics to support'}
                  </button>
                  <button
                    onClick={handleExport}
                    disabled={exporting}
                    className="inline-flex min-h-[54px] items-center justify-center gap-2 rounded-2xl border border-white/15 bg-white/[0.07] px-4 text-sm font-black text-white active:bg-white/[0.12] disabled:opacity-50"
                  >
                    <Download className={cn('h-5 w-5', exporting && 'animate-bounce')} />
                    Export diagnostics file
                  </button>
                  <button
                    onClick={() => setAdvancedExpanded((value) => !value)}
                    className="inline-flex min-h-[54px] items-center justify-center gap-2 rounded-2xl border border-white/15 bg-white/[0.07] px-4 text-sm font-black text-white active:bg-white/[0.12]"
                  >
                    <ChevronDown className={cn('h-5 w-5 transition-transform', advancedExpanded && 'rotate-180')} />
                    Open advanced details
                  </button>
                </div>
                <p className="mt-4 text-sm leading-6 text-white/55">
                  The POS can continue working locally. Do not reset or clear data unless support asks.
                </p>
                {exportPath && (
                  <button
                    onClick={handleOpenExportDir}
                    className="mt-3 inline-flex min-h-[46px] items-center gap-2 rounded-2xl border border-white/15 bg-white/[0.07] px-4 text-sm font-semibold text-white active:bg-white/[0.12]"
                  >
                    <FolderOpen className="h-4 w-4" />
                    Open diagnostics folder
                  </button>
                )}
              </section>

              {advancedExpanded && (
                <section className="mt-5 space-y-4 rounded-3xl border border-yellow-400/15 bg-[#0c0c0c] p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-lg font-black text-white">Advanced details for support</h4>
                      <p className="mt-1 text-sm text-white/55">Only use this section when support asks.</p>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {[
                      ['Terminal ID', systemHealth?.terminalContext?.terminalId || 'Unknown'],
                      ['Branch ID', systemHealth?.terminalContext?.branchId || 'Unknown'],
                      ['Organization ID', systemHealth?.terminalContext?.organizationId || 'Unknown'],
                      ['Last sync', systemHealth?.lastSyncTime || syncStatus.lastSync || 'Never'],
                      ['Sync backlog', totalBacklog],
                      ['Financial failed', financialFailedCount],
                      ['Printer failures', countPrinterFailures(systemHealth)],
                      ['Crash count', systemHealth?.panicCount ?? 0],
                      ['Incident ID', incidentReport?.incidentId || 'None'],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="rounded-2xl border border-yellow-400/10 bg-white/[0.05] p-3">
                        <div className="text-xs font-bold uppercase tracking-wide text-yellow-100/60">{label}</div>
                        <div className="mt-1 break-words text-sm font-black text-white">{String(value)}</div>
                      </div>
                    ))}
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div>
                      <div className="mb-2 text-sm font-black text-white">Health JSON</div>
                      <pre className="max-h-80 overflow-auto rounded-2xl border border-yellow-400/10 bg-black p-4 text-xs leading-5 text-white/80">
                        {JSON.stringify(summary.advanced ?? {}, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <div className="mb-2 text-sm font-black text-white">Recent support report</div>
                      <pre className="max-h-80 overflow-auto rounded-2xl border border-yellow-400/10 bg-black p-4 text-xs leading-5 text-white/80">
                        {JSON.stringify(incidentReport ?? { state: 'not_sent' }, null, 2)}
                      </pre>
                    </div>
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );
  };

  // =========================================================================
  // Render
  // =========================================================================

  return (
    <div className={`relative flex items-center gap-1.5 ${className}`}>
      {/* Heart Icon Status Indicator */}
      <button
        className="group relative rounded-full p-2 transition-all duration-200 active:bg-slate-100/80 dark:active:bg-white/10"
        onClick={() => setShowDetailPanel(!showDetailPanel)}
        aria-label={getStatusText()}
      >
        <svg
          className={`w-6 h-6 transition-all duration-300 ${heartStatusClass} ${
            syncStatus.syncInProgress ? 'animate-pulse' : ''
          }`}
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

      {/* Offline Mode Indicator — visible in collapsed view */}
      {!syncStatus.isOnline && (
        <div className="flex items-center gap-1.5">
          <span className="flex items-center gap-1 text-xs font-semibold text-red-500 dark:text-red-400">
            <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
            {t('sync.labels.offline')}
          </span>
          <button
            onClick={handleForceSync}
            disabled={syncStatus.syncInProgress}
            className="p-1 rounded-md text-red-400 active:bg-red-500/20 transition-colors disabled:opacity-50"
            aria-label={t('sync.actions.retry', { defaultValue: 'Retry sync' })}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncStatus.syncInProgress ? 'animate-spin' : ''}`} />
          </button>
        </div>
      )}

      {/* Queue capacity early warning — visible in collapsed view so staff
          see the backlog growing long before enqueue fail-closes checkout. */}
      {capacityWarning && (
        <button
          onClick={() => setShowDetailPanel(true)}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold text-orange-600 transition-colors active:bg-orange-500/15 dark:text-orange-300"
          aria-label={t('sync.capacity.title', { defaultValue: 'Sync backlog growing' })}
        >
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {t('sync.capacity.badge', {
            defaultValue: 'Backlog {{percent}}%',
            percent: capacityWarningPercent,
          })}
        </button>
      )}

      {showDetailPanel && renderDetailModal()}

      <FinancialSyncPanel
        isOpen={showFinancialPanel}
        onClose={() => setShowFinancialPanel(false)}
        onRefresh={() => {
          void loadSyncStatus();
        }}
        queueSummary={{
          pending: financialPendingCount,
          failed: financialFailedCount,
        }}
      />
    </div>
  );
};
