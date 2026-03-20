import type { DiagnosticsSystemHealth } from '../../lib';

export type SupportSurface = 'health' | 'printer';

export type HealthSupportIssueCode =
  | 'health.offline'
  | 'health.sync_error_active'
  | 'health.sync_stale'
  | 'health.backlog_blocked'
  | 'health.financial_queue_failed'
  | 'health.invalid_orders_present'
  | 'health.pending_zreport_submit';

export type PrinterSupportIssueCode =
  | 'printer.not_configured'
  | 'printer.no_default_profile'
  | 'printer.offline_or_error'
  | 'printer.transport_unresolved'
  | 'printer.unverified'
  | 'printer.recent_job_failures'
  | 'printer.degraded';

export type SupportIssueCode = HealthSupportIssueCode | PrinterSupportIssueCode;

export type SupportSeverity = 'info' | 'warning' | 'high' | 'critical';

export type SupportActionId =
  | 'refresh_status'
  | 'export_diagnostics'
  | 'open_financial_panel'
  | 'refresh_printer_diagnostics'
  | 'open_quick_setup'
  | 'edit_printer'
  | 'back_to_printers';

export interface SupportEvidence {
  id: string;
  labelKey: string;
  fallbackLabel: string;
  value: string;
  tone?: 'neutral' | SupportSeverity;
}

export interface SupportAction {
  id: SupportActionId;
  label: string;
  variant: 'primary' | 'secondary';
}

export interface SupportExplanation {
  surface: SupportSurface;
  issueCode: SupportIssueCode | null;
  severity: SupportSeverity;
  title: string;
  summary: string;
  why: string;
  steps: string[];
  whenToEscalate: string[];
  evidence: SupportEvidence[];
  actions: SupportAction[];
  usedFallback: boolean;
}

export interface QueueFailureSupportSnapshot {
  entityType: string;
  entityId: string;
  status: string;
  classification: string;
  lastError: string;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
}

export interface HealthSupportContext {
  isOnline: boolean;
  lastSync: string | null;
  telemetryLastSync: string | null;
  syncError: string | null;
  pendingItems: number;
  queuedRemote: number;
  backpressureDeferred: number;
  pendingPaymentItems: number;
  failedPaymentItems: number;
  terminalHealth: number;
  totalBacklog: number;
  isTelemetryStale: boolean;
  financialPendingCount: number;
  financialFailedCount: number;
  invalidOrdersCount: number;
  invalidOrderIds: string[];
  pendingReportDate: string | null;
  hasBlockedQueue: boolean;
  hasScheduledRetry: boolean;
  lastQueueFailure: QueueFailureSupportSnapshot | null;
  systemHealth: DiagnosticsSystemHealth | null;
}

export interface PrinterSupportContext {
  view: 'list' | 'diagnostics';
  printersCount: number;
  hasDefaultPrinter: boolean;
  selectedPrinterId: string | null;
  selectedPrinterName: string | null;
  selectedPrinterRole: string | null;
  selectedPrinterEnabled: boolean;
  statusState: string | null;
  statusError: string | null;
  queueLength: number;
  verificationStatus: string | null;
  resolvedTransport: string | null;
  resolvedAddress: string | null;
  transportReachable: boolean | null;
  recentJobsFailed: number;
  recentJobsTotal: number;
}

export interface SupportRuleResult {
  surface: SupportSurface;
  issueCode: SupportIssueCode;
  severity: SupportSeverity;
  evidence: SupportEvidence[];
  actions: Array<{
    id: SupportActionId;
    variant: 'primary' | 'secondary';
  }>;
}

export interface SupportCopy {
  title: string;
  summary: string;
  why: string;
  steps: string[];
  whenToEscalate: string[];
  ctaLabels: Partial<Record<SupportActionId, string>>;
}
