import type {
  HealthSupportContext,
  PrinterSupportContext,
  SupportRuleResult,
} from './types';

const formatTimestamp = (value: string | null): string => {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

export function evaluateHealthSupportRules(
  context: HealthSupportContext,
): SupportRuleResult | null {
  const queueFailure = context.lastQueueFailure;

  if (!context.isOnline) {
    return {
      surface: 'health',
      issueCode: 'health.offline',
      severity: 'high',
      evidence: [
        {
          id: 'connectivity',
          labelKey: 'support.evidence.connectivity',
          fallbackLabel: 'Connectivity',
          value: 'Offline',
          tone: 'high',
        },
        {
          id: 'pending_queue',
          labelKey: 'support.evidence.pendingQueue',
          fallbackLabel: 'Pending queue',
          value: String(
            context.pendingItems +
              context.pendingPaymentItems +
              context.queuedRemote +
              context.backpressureDeferred,
          ),
        },
      ],
      actions: [
        { id: 'refresh_status', variant: 'secondary' },
        { id: 'export_diagnostics', variant: 'primary' },
      ],
    };
  }

  if (context.syncError || context.failedPaymentItems > 0) {
    return {
      surface: 'health',
      issueCode: 'health.sync_error_active',
      severity: 'critical',
      evidence: [
        {
          id: 'sync_error',
          labelKey: 'support.evidence.syncError',
          fallbackLabel: 'Sync error',
          value: context.syncError || 'Failed payment items are waiting',
          tone: 'critical',
        },
        {
          id: 'failed_payments',
          labelKey: 'support.evidence.failedPayments',
          fallbackLabel: 'Failed payments',
          value: String(context.failedPaymentItems),
        },
      ],
      actions: [
        { id: 'refresh_status', variant: 'secondary' },
        { id: 'export_diagnostics', variant: 'primary' },
      ],
    };
  }

  if (context.isTelemetryStale) {
    return {
      surface: 'health',
      issueCode: 'health.sync_stale',
      severity: 'warning',
      evidence: [
        {
          id: 'last_sync',
          labelKey: 'support.evidence.lastSync',
          fallbackLabel: 'Last sync',
          value: formatTimestamp(context.lastSync),
        },
        {
          id: 'telemetry_last_sync',
          labelKey: 'support.evidence.telemetryLastSync',
          fallbackLabel: 'Telemetry last sync',
          value: formatTimestamp(context.telemetryLastSync),
        },
      ],
      actions: [
        { id: 'refresh_status', variant: 'primary' },
        { id: 'export_diagnostics', variant: 'secondary' },
      ],
    };
  }

  if (context.hasBlockedQueue && queueFailure) {
    return {
      surface: 'health',
      issueCode: 'health.backlog_blocked',
      severity: 'critical',
      evidence: [
        {
          id: 'blocked_entity',
          labelKey: 'support.evidence.blockedEntity',
          fallbackLabel: 'Blocked entity',
          value: `${queueFailure.entityType} ${queueFailure.entityId}`.trim(),
          tone: 'critical',
        },
        {
          id: 'queue_failure',
          labelKey: 'support.evidence.queueFailure',
          fallbackLabel: 'Queue failure',
          value: queueFailure.lastError,
          tone: 'critical',
        },
        {
          id: 'retry_progress',
          labelKey: 'support.evidence.retryProgress',
          fallbackLabel: 'Retry progress',
          value: `${queueFailure.retryCount}/${queueFailure.maxRetries}`,
        },
      ],
      actions: [
        { id: 'refresh_status', variant: 'secondary' },
        { id: 'export_diagnostics', variant: 'primary' },
      ],
    };
  }

  if (context.financialFailedCount > 0) {
    return {
      surface: 'health',
      issueCode: 'health.financial_queue_failed',
      severity: 'high',
      evidence: [
        {
          id: 'financial_failed',
          labelKey: 'support.evidence.failedFinancialItems',
          fallbackLabel: 'Failed financial items',
          value: String(context.financialFailedCount),
          tone: 'high',
        },
        {
          id: 'financial_pending',
          labelKey: 'support.evidence.pendingFinancialItems',
          fallbackLabel: 'Pending financial items',
          value: String(context.financialPendingCount),
        },
      ],
      actions: [
        { id: 'open_financial_panel', variant: 'primary' },
        { id: 'export_diagnostics', variant: 'secondary' },
      ],
    };
  }

  if (context.invalidOrdersCount > 0) {
    return {
      surface: 'health',
      issueCode: 'health.invalid_orders_present',
      severity: 'high',
      evidence: [
        {
          id: 'invalid_orders',
          labelKey: 'support.evidence.invalidOrders',
          fallbackLabel: 'Invalid orders',
          value: String(context.invalidOrdersCount),
          tone: 'high',
        },
        {
          id: 'invalid_order_ids',
          labelKey: 'support.evidence.invalidOrderIds',
          fallbackLabel: 'Affected orders',
          value: context.invalidOrderIds.slice(0, 3).join(', '),
        },
      ],
      actions: [
        { id: 'refresh_status', variant: 'secondary' },
        { id: 'export_diagnostics', variant: 'primary' },
      ],
    };
  }

  if (context.pendingReportDate) {
    return {
      surface: 'health',
      issueCode: 'health.pending_zreport_submit',
      severity: 'warning',
      evidence: [
        {
          id: 'pending_report_date',
          labelKey: 'support.evidence.pendingReportDate',
          fallbackLabel: 'Pending report date',
          value: context.pendingReportDate,
          tone: 'warning',
        },
        {
          id: 'pending_queue',
          labelKey: 'support.evidence.pendingQueue',
          fallbackLabel: 'Pending queue',
          value: String(context.pendingItems + context.pendingPaymentItems),
        },
      ],
      actions: [
        { id: 'refresh_status', variant: 'primary' },
        { id: 'export_diagnostics', variant: 'secondary' },
      ],
    };
  }

  return null;
}

const normalizePrinterState = (value: string | null) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const normalizeVerification = (value: string | null) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

export function evaluatePrinterSupportRules(
  context: PrinterSupportContext,
): SupportRuleResult | null {
  const state = normalizePrinterState(context.statusState);
  const verification = normalizeVerification(context.verificationStatus);

  if (context.printersCount === 0) {
    return {
      surface: 'printer',
      issueCode: 'printer.not_configured',
      severity: 'warning',
      evidence: [
        {
          id: 'configured_printers',
          labelKey: 'support.evidence.configuredPrinters',
          fallbackLabel: 'Configured printers',
          value: '0',
          tone: 'warning',
        },
      ],
      actions: [{ id: 'open_quick_setup', variant: 'primary' }],
    };
  }

  if (!context.hasDefaultPrinter) {
    return {
      surface: 'printer',
      issueCode: 'printer.no_default_profile',
      severity: 'high',
      evidence: [
        {
          id: 'configured_printers',
          labelKey: 'support.evidence.configuredPrinters',
          fallbackLabel: 'Configured printers',
          value: String(context.printersCount),
        },
        {
          id: 'default_printer',
          labelKey: 'support.evidence.defaultPrinter',
          fallbackLabel: 'Default printer',
          value: 'Not assigned',
          tone: 'high',
        },
      ],
      actions: [{ id: 'edit_printer', variant: 'primary' }],
    };
  }

  if (state === 'offline' || state === 'error') {
    return {
      surface: 'printer',
      issueCode: 'printer.offline_or_error',
      severity: 'critical',
      evidence: [
        {
          id: 'printer_name',
          labelKey: 'support.evidence.printerName',
          fallbackLabel: 'Printer',
          value: context.selectedPrinterName || 'Unknown printer',
        },
        {
          id: 'printer_state',
          labelKey: 'support.evidence.printerState',
          fallbackLabel: 'Printer state',
          value: context.statusState || 'Unknown',
          tone: 'critical',
        },
        {
          id: 'printer_error',
          labelKey: 'support.evidence.printerError',
          fallbackLabel: 'Printer error',
          value: context.statusError || 'No detailed error reported',
          tone: 'critical',
        },
      ],
      actions: [
        { id: 'refresh_printer_diagnostics', variant: 'secondary' },
        { id: 'edit_printer', variant: 'primary' },
      ],
    };
  }

  if (
    (context.transportReachable === false && verification !== 'verified') ||
    (!context.resolvedTransport && context.view === 'diagnostics')
  ) {
    return {
      surface: 'printer',
      issueCode: 'printer.transport_unresolved',
      severity: 'high',
      evidence: [
        {
          id: 'resolved_transport',
          labelKey: 'support.evidence.resolvedTransport',
          fallbackLabel: 'Resolved transport',
          value: context.resolvedTransport || 'Not resolved',
          tone: 'high',
        },
        {
          id: 'resolved_address',
          labelKey: 'support.evidence.resolvedAddress',
          fallbackLabel: 'Resolved address',
          value: context.resolvedAddress || 'Not resolved',
        },
      ],
      actions: [
        { id: 'edit_printer', variant: 'primary' },
        { id: 'refresh_printer_diagnostics', variant: 'secondary' },
      ],
    };
  }

  if (
    verification === 'unverified' ||
    state === 'unverified' ||
    state === 'unresolved'
  ) {
    return {
      surface: 'printer',
      issueCode: 'printer.unverified',
      severity: 'warning',
      evidence: [
        {
          id: 'verification_status',
          labelKey: 'support.evidence.verificationStatus',
          fallbackLabel: 'Verification status',
          value: context.verificationStatus || 'Unverified',
          tone: 'warning',
        },
        {
          id: 'printer_name',
          labelKey: 'support.evidence.printerName',
          fallbackLabel: 'Printer',
          value: context.selectedPrinterName || 'Unknown printer',
        },
      ],
      actions: [
        { id: 'open_quick_setup', variant: 'primary' },
        { id: 'edit_printer', variant: 'secondary' },
      ],
    };
  }

  if (context.recentJobsFailed > 0) {
    return {
      surface: 'printer',
      issueCode: 'printer.recent_job_failures',
      severity: 'high',
      evidence: [
        {
          id: 'recent_jobs_failed',
          labelKey: 'support.evidence.recentJobsFailed',
          fallbackLabel: 'Failed recent jobs',
          value: `${context.recentJobsFailed}/${context.recentJobsTotal || context.recentJobsFailed}`,
          tone: 'high',
        },
        {
          id: 'printer_queue_length',
          labelKey: 'support.evidence.printerQueueLength',
          fallbackLabel: 'Printer queue',
          value: String(context.queueLength),
        },
      ],
      actions: [
        { id: 'refresh_printer_diagnostics', variant: 'secondary' },
        { id: 'edit_printer', variant: 'primary' },
      ],
    };
  }

  if (state === 'degraded' || verification === 'degraded') {
    return {
      surface: 'printer',
      issueCode: 'printer.degraded',
      severity: 'warning',
      evidence: [
        {
          id: 'printer_state',
          labelKey: 'support.evidence.printerState',
          fallbackLabel: 'Printer state',
          value: context.statusState || context.verificationStatus || 'Degraded',
          tone: 'warning',
        },
        {
          id: 'resolved_transport',
          labelKey: 'support.evidence.resolvedTransport',
          fallbackLabel: 'Resolved transport',
          value: context.resolvedTransport || 'Not resolved',
        },
      ],
      actions: [
        { id: 'refresh_printer_diagnostics', variant: 'primary' },
        { id: 'edit_printer', variant: 'secondary' },
      ],
    };
  }

  return null;
}
