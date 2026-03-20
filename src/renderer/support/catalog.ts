import type { SupportActionId, SupportIssueCode } from './types';

export const SUPPORT_ACTION_IDS: SupportActionId[] = [
  'refresh_status',
  'export_diagnostics',
  'open_financial_panel',
  'refresh_printer_diagnostics',
  'open_quick_setup',
  'edit_printer',
  'back_to_printers',
];

export const SUPPORT_ISSUE_CODES: SupportIssueCode[] = [
  'health.offline',
  'health.sync_error_active',
  'health.sync_stale',
  'health.backlog_blocked',
  'health.financial_queue_failed',
  'health.invalid_orders_present',
  'health.pending_zreport_submit',
  'printer.not_configured',
  'printer.no_default_profile',
  'printer.offline_or_error',
  'printer.transport_unresolved',
  'printer.unverified',
  'printer.recent_job_failures',
  'printer.degraded',
];

export const SUPPORT_REQUIRED_COPY_FIELDS = [
  'title',
  'summary',
  'why',
  'steps',
  'whenToEscalate',
  'ctaLabels',
] as const;

export const SUPPORTED_POS_LOCALES = ['en', 'el', 'de', 'fr', 'it'] as const;
