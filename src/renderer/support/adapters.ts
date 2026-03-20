import type {
  HealthSupportContext,
  PrinterSupportContext,
  QueueFailureSupportSnapshot,
} from './types';
import type { DiagnosticsSystemHealth } from '../../lib';

interface SyncStatusInput {
  isOnline: boolean;
  lastSync: string | null;
  error: string | null;
  pendingItems: number;
  queuedRemote: number;
  backpressureDeferred: number;
  pendingPaymentItems: number;
  failedPaymentItems: number;
  terminalHealth: number;
  lastQueueFailure: {
    entityType: string;
    entityId: string;
    status: string;
    classification: string;
    lastError: string;
    retryCount: number;
    maxRetries: number;
    nextRetryAt: string | null;
  } | null;
}

interface FinancialStatsInput {
  driver_earnings?: { pending?: number; failed?: number };
  staff_payments?: { pending?: number; failed?: number };
  shift_expenses?: { pending?: number; failed?: number };
}

interface HealthSupportAdapterInput {
  syncStatus: SyncStatusInput;
  systemHealth: DiagnosticsSystemHealth | null;
  financialStats?: FinancialStatsInput | null;
  totalBacklog: number;
  isTelemetryStale: boolean;
  hasBlockedQueue: boolean;
  hasScheduledRetry: boolean;
  pendingReportDate?: string | null;
}

interface PrinterConfigInput {
  id: string;
  name: string;
  role: string;
  isDefault: boolean;
  enabled: boolean;
  connectionDetails?: {
    capabilities?: {
      status?: string | null;
      resolvedTransport?: string | null;
      resolved_transport?: string | null;
      resolvedAddress?: string | null;
      resolved_address?: string | null;
    };
  };
}

interface PrinterStatusInput {
  state?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  queueLength?: number | null;
  verificationStatus?: string | null;
  resolvedTransport?: string | null;
  resolvedAddress?: string | null;
  transportReachable?: boolean | null;
}

interface PrinterDiagnosticsInput {
  printerId: string;
  verificationStatus?: string | null;
  resolvedTransport?: string | null;
  resolvedAddress?: string | null;
  transportReachable?: boolean | null;
  recentJobs?: {
    total?: number | null;
    failed?: number | null;
  };
}

interface PrinterSupportAdapterInput {
  view: 'list' | 'diagnostics';
  printers: PrinterConfigInput[];
  statuses: Record<string, PrinterStatusInput>;
  diagnostics?: PrinterDiagnosticsInput | null;
  selectedPrinterId?: string | null;
}

const asFiniteNumber = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const normalizeQueueFailure = (
  value: SyncStatusInput['lastQueueFailure'],
): QueueFailureSupportSnapshot | null => {
  if (!value) return null;
  return {
    entityType: value.entityType,
    entityId: value.entityId,
    status: value.status,
    classification: value.classification,
    lastError: value.lastError,
    retryCount: value.retryCount,
    maxRetries: value.maxRetries,
    nextRetryAt: value.nextRetryAt,
  };
};

export function buildHealthSupportContext(
  input: HealthSupportAdapterInput,
): HealthSupportContext {
  const financialStats = input.financialStats || {};
  const financialPendingCount =
    asFiniteNumber(financialStats.driver_earnings?.pending) +
    asFiniteNumber(financialStats.staff_payments?.pending) +
    asFiniteNumber(financialStats.shift_expenses?.pending);
  const financialFailedCount =
    asFiniteNumber(financialStats.driver_earnings?.failed) +
    asFiniteNumber(financialStats.staff_payments?.failed) +
    asFiniteNumber(financialStats.shift_expenses?.failed);
  const invalidOrders = input.systemHealth?.invalidOrders?.details || [];

  return {
    isOnline: input.syncStatus.isOnline,
    lastSync: input.syncStatus.lastSync,
    telemetryLastSync: input.systemHealth?.lastSyncTime ?? null,
    syncError: input.syncStatus.error,
    pendingItems: input.syncStatus.pendingItems,
    queuedRemote: input.syncStatus.queuedRemote,
    backpressureDeferred: input.syncStatus.backpressureDeferred,
    pendingPaymentItems: input.syncStatus.pendingPaymentItems,
    failedPaymentItems: input.syncStatus.failedPaymentItems,
    terminalHealth: input.syncStatus.terminalHealth,
    totalBacklog: input.totalBacklog,
    isTelemetryStale: input.isTelemetryStale,
    financialPendingCount,
    financialFailedCount,
    invalidOrdersCount: invalidOrders.length,
    invalidOrderIds: invalidOrders
      .map((item) => item.order_id)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
    pendingReportDate: input.pendingReportDate || null,
    hasBlockedQueue: input.hasBlockedQueue,
    hasScheduledRetry: input.hasScheduledRetry,
    lastQueueFailure: normalizeQueueFailure(input.syncStatus.lastQueueFailure),
    systemHealth: input.systemHealth,
  };
}

const readCapabilityValue = (
  printer: PrinterConfigInput | undefined,
  key:
    | 'status'
    | 'resolvedTransport'
    | 'resolved_transport'
    | 'resolvedAddress'
    | 'resolved_address',
) => {
  return printer?.connectionDetails?.capabilities?.[key] ?? null;
};

const getDefaultPrinterCandidate = (printers: PrinterConfigInput[]) =>
  printers.find((printer) => printer.isDefault) ||
  printers.find((printer) => printer.role === 'receipt') ||
  printers[0] ||
  null;

export function buildPrinterSupportContext(
  input: PrinterSupportAdapterInput,
): PrinterSupportContext {
  const candidateId =
    input.selectedPrinterId ||
    input.diagnostics?.printerId ||
    getDefaultPrinterCandidate(input.printers)?.id ||
    null;
  const selectedPrinter =
    (candidateId
      ? input.printers.find((printer) => printer.id === candidateId)
      : null) || null;
  const selectedStatus = candidateId ? input.statuses[candidateId] || null : null;

  return {
    view: input.view,
    printersCount: input.printers.length,
    hasDefaultPrinter: input.printers.some((printer) => printer.isDefault),
    selectedPrinterId: selectedPrinter?.id || candidateId,
    selectedPrinterName: selectedPrinter?.name || null,
    selectedPrinterRole: selectedPrinter?.role || null,
    selectedPrinterEnabled: selectedPrinter?.enabled ?? false,
    statusState: selectedStatus?.state || null,
    statusError:
      selectedStatus?.errorMessage ||
      selectedStatus?.errorCode ||
      null,
    queueLength: asFiniteNumber(selectedStatus?.queueLength),
    verificationStatus:
      input.diagnostics?.verificationStatus ||
      selectedStatus?.verificationStatus ||
      readCapabilityValue(selectedPrinter || undefined, 'status'),
    resolvedTransport:
      input.diagnostics?.resolvedTransport ||
      selectedStatus?.resolvedTransport ||
      readCapabilityValue(selectedPrinter || undefined, 'resolvedTransport') ||
      readCapabilityValue(selectedPrinter || undefined, 'resolved_transport'),
    resolvedAddress:
      input.diagnostics?.resolvedAddress ||
      selectedStatus?.resolvedAddress ||
      readCapabilityValue(selectedPrinter || undefined, 'resolvedAddress') ||
      readCapabilityValue(selectedPrinter || undefined, 'resolved_address'),
    transportReachable:
      input.diagnostics?.transportReachable ??
      selectedStatus?.transportReachable ??
      null,
    recentJobsFailed: asFiniteNumber(input.diagnostics?.recentJobs?.failed),
    recentJobsTotal: asFiniteNumber(input.diagnostics?.recentJobs?.total),
  };
}
