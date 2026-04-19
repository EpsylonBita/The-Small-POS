/**
 * Shared IPC DTO contracts for renderer/native bridge calls.
 * These types are intentionally runtime-agnostic and reusable by any caller.
 */

// -- Auth --------------------------------------------------------------------

export interface AuthSetupPinRequest {
  adminPin?: string;
  staffPin?: string;
}

export type PrivilegedActionScope = 'system_control' | 'cash_drawer_control';

export interface PrivilegedActionConfirmRequest {
  pin: string;
  scope: PrivilegedActionScope;
}

export interface PrivilegedActionConfirmResponse {
  success: boolean;
  scope: PrivilegedActionScope;
  sessionId: string;
  ttlSeconds: number;
  expiresAt: string;
}

export interface PrivilegedActionErrorPayload {
  code: 'UNAUTHORIZED' | 'REAUTH_REQUIRED' | string;
  scope?: string;
  reason?: string;
  ttlSeconds?: number | null;
}

export interface StaffCheckInPinVerifyRequest {
  staffId: string;
  branchId: string;
  pin: string;
}

export interface StaffCheckInPinVerifyResponse {
  success: boolean;
  staffId?: string;
  branchId?: string;
  reasonCode?: string;
  error?: string;
}

// -- Settings / Terminal Config ----------------------------------------------

export interface SettingsConfiguredResponse {
  configured: boolean;
  reason?: string;
}

export interface ResetStartResponse {
  success: boolean;
  started?: boolean;
  operationId?: string | null;
  mode?: string | null;
  error?: string;
}

export interface ResetStatus {
  operationId: string;
  mode: string;
  phase: string;
  state: string;
  updatedAt: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  failingKey?: string | null;
  failingPath?: string | null;
}

export interface SettingsGetRequest {
  category?: string;
  key?: string;
  settingType?: string;
  settingKey?: string;
  defaultValue?: unknown;
  default?: unknown;
}

export interface SettingsSetRequest {
  category?: string;
  key?: string;
  settingType?: string;
  settingKey?: string;
  value?: unknown;
  settingValue?: unknown;
}

export interface SettingsUpdateLocalObjectRequest {
  settingType: string;
  settings: Record<string, unknown>;
}

export interface SettingsUpdateLocalCategoryRequest {
  category: string;
  settings: Record<string, unknown>;
}

export interface SettingsUpdateLocalKeyValueRequest {
  key: string;
  value: unknown;
}

export type SettingsUpdateLocalRequest =
  | SettingsUpdateLocalObjectRequest
  | SettingsUpdateLocalCategoryRequest
  | SettingsUpdateLocalKeyValueRequest;

export interface TerminalConfigGetSettingRequest {
  category?: string;
  key?: string;
  settingType?: string;
  settingKey?: string;
  fullKey?: string;
  setting?: string;
  name?: string;
}

export type SyncHealthState = 'polling' | 'stale' | 'offline';

export interface TerminalRuntimeConfig {
  terminal_id?: string | null;
  branch_id?: string | null;
  organization_id?: string | null;
  admin_dashboard_url?: string | null;
  admin_url?: string | null;
  business_type?: string | null;
  terminal_type?: string | null;
  parent_terminal_id?: string | null;
  owner_terminal_id?: string | null;
  owner_terminal_db_id?: string | null;
  source_terminal_id?: string | null;
  source_terminal_db_id?: string | null;
  pos_operating_mode?: string | null;
  enabled_features?: Record<string, boolean>;
  last_config_sync_at?: string | null;
  ghost_mode_feature_enabled?: string | boolean | null;
  sync_health?: SyncHealthState;
  // Compatibility aliases while the renderer migrates.
  terminalType?: string | null;
  parentTerminalId?: string | null;
  ownerTerminalId?: string | null;
  ownerTerminalDbId?: string | null;
  sourceTerminalId?: string | null;
  sourceTerminalDbId?: string | null;
  posOperatingMode?: string | null;
  features?: Record<string, boolean>;
}

// -- Sync --------------------------------------------------------------------

export interface SyncValidatePendingOrdersResponse {
  success: boolean;
  total_pending: number;
  valid: number;
  invalid: number;
  invalid_orders: DiagnosticsInvalidOrder[];
}

export interface SyncRemoveInvalidOrdersResponse {
  success: boolean;
  removed: number;
  message?: string;
  order_ids?: string[];
}

export type SyncFinancialQueueStatus =
  | 'failed'
  | 'pending'
  | 'in_progress'
  | 'deferred'
  | 'queued_remote'
  | 'synced'
  | 'applied'
  | string;

export interface SyncFinancialQueueItem {
  queueId: number;
  entityType: string;
  entityId: string;
  operation: string;
  status: SyncFinancialQueueStatus;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  payload: string;
  parentShiftId?: string | null;
  parentShiftSyncStatus?: string | null;
  parentShiftQueueId?: number | null;
  parentShiftQueueStatus?: string | null;
  dependencyBlockReason?: string | null;
}

export interface SyncFinancialQueueItemsResponse {
  items: SyncFinancialQueueItem[];
}

export interface SyncFinancialIntegrityIssue {
  entityType: string;
  entityId: string;
  orderId?: string | null;
  orderNumber?: string | null;
  paymentId?: string | null;
  adjustmentId?: string | null;
  queueId?: number | null;
  queueStatus?: string | null;
  reasonCode: string;
  suggestedFix: string;
  syncState?: string | null;
  parentSyncState?: string | null;
  parentHasRemoteIdentity?: boolean | null;
  lastError?: string | null;
  details?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  legacyParityRowId?: string | null;
}

export interface SyncFinancialIntegrityResponse {
  valid: boolean;
  issues: SyncFinancialIntegrityIssue[];
}

export interface UnsettledPaymentBlocker {
  orderId: string;
  orderNumber: string;
  totalAmount: number;
  settledAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  reasonCode: string;
  reasonText: string;
  suggestedFix: string;
}

export interface PaymentIntegrityErrorPayload {
  errorCode?: string;
  error?: string;
  message?: string;
  blockers?: UnsettledPaymentBlocker[];
}

export interface SyncBlockerDetail {
  queueId: number;
  entityType: string;
  entityId: string;
  operation: string;
  queueStatus: string;
  blockerReason: string;
  orderId?: string | null;
  orderNumber?: string | null;
  paymentId?: string | null;
  adjustmentId?: string | null;
  lastError?: string | null;
  paymentMethod?: string | null;
  paymentAmount?: number | null;
  paymentTransactionRef?: string | null;
  paymentSyncState?: string | null;
  paymentSyncStatus?: string | null;
  remotePaymentIdPresent?: boolean | null;
  orderTotalAmount?: number | null;
  orderSettledAmount?: number | null;
  orderOutstandingAmount?: number | null;
  paymentCreatedAt?: string | null;
  paymentUpdatedAt?: string | null;
}

export type ZReportSyncState =
  | 'pending'
  | 'syncing'
  | 'applied'
  | 'failed'
  | string;

export type EndOfDayStatus =
  | 'idle'
  | 'pending_local_submit'
  | 'submitted_pending_admin'
  | string;

export interface EndOfDayStatusResponse {
  status: EndOfDayStatus;
  pendingReportDate?: string | null;
  cutoffAt?: string | null;
  periodStartAt?: string | null;
  activeReportDate?: string | null;
  activePeriodStartAt?: string | null;
  latestZReportId?: string | null;
  latestZReportSyncState?: string | null;
  canOpenPendingZReport?: boolean;
}

export interface ZReportSubmitResponse extends PaymentIntegrityErrorPayload {
  success: boolean;
  data?: unknown;
  cleanup?: Record<string, number>;
  lastZReportTimestamp?: string;
  zReportId?: string | null;
  localDayClosed?: boolean;
  syncQueued?: boolean;
  syncState?: ZReportSyncState | null;
  stage?: string;
  stageCode?: string;
  syncItemCount?: number;
  blockersSummary?: string;
  syncBlockerDetails?: SyncBlockerDetail[];
  message?: string;
  error?: string;
}

// -- Screen Capture ----------------------------------------------------------

export interface ScreenCaptureGetSourcesRequest {
  types: string[];
}

export interface ScreenCaptureSource {
  id: string;
  name: string;
  display_id?: string;
}

export interface ScreenCaptureGetSourcesResponse {
  success: boolean;
  requestedTypes?: string[];
  sources?: ScreenCaptureSource[];
  error?: string;
}

export interface ScreenCaptureSignalPollingResponse {
  success: boolean;
  requestId?: string;
  intervalMs?: number;
  stopped?: boolean;
  error?: string;
}

export interface ScreenCaptureSignal {
  id?: string;
  type?: string;
  sender?: string;
  data?: unknown;
  created_at?: string;
}

export interface ScreenCaptureRequestState {
  status?: string;
  error_message?: string | null;
  control_status?: string;
  control_requested_at?: string | null;
  control_responded_at?: string | null;
  control_denial_reason?: string | null;
  [key: string]: unknown;
}

export interface ScreenCaptureSignalBatchPayload {
  requestId?: string;
  request?: ScreenCaptureRequestState | null;
  signals?: ScreenCaptureSignal[];
  lastSignalTimestamp?: string | null;
}

// -- Recovery ----------------------------------------------------------------

export type RecoveryPointKind =
  | 'scheduled'
  | 'manual'
  | 'pre_factory_reset'
  | 'pre_emergency_reset'
  | 'pre_clear_operational_data'
  | 'pre_restore'
  | 'pre_migration'
  | 'quarantined_open_failure';

export interface RecoveryPoint {
  id: string;
  kind: RecoveryPointKind;
  createdAt: string;
  path: string;
  snapshotPath: string;
  walPath?: string | null;
  shmPath?: string | null;
  schemaVersion: number;
  terminalId?: string | null;
  branchId?: string | null;
  organizationId?: string | null;
  dbSizeBytes: number;
  snapshotSizeBytes: number;
  fingerprint: string;
  tableCounts: Record<string, number>;
  syncBacklog: Record<string, Record<string, number>>;
  activePeriodStartAt?: string | null;
  activeReportDate?: string | null;
  latestZReportId?: string | null;
  latestZReportDate?: string | null;
  latestZReportGeneratedAt?: string | null;
  latestZReportSyncState?: string | null;
  lastZReportTimestamp?: string | null;
  error?: string | null;
}

export interface RecoveryListResponse {
  success: boolean;
  points: RecoveryPoint[];
}

export interface RecoveryExportResponse {
  success: boolean;
  path: string;
  exportKind: string;
  pointId?: string | null;
}

export interface RecoveryRestoreResponse {
  success: boolean;
  staged: boolean;
  restartRequired: boolean;
  pointId: string;
  preRestorePointId?: string | null;
  message: string;
}

// -- Diagnostics --------------------------------------------------------------

export interface DiagnosticsAboutInfo {
  version: string;
  buildTimestamp: string;
  gitSha: string;
  platform: string;
  arch: string;
  rustVersion: string;
}

export interface DiagnosticsRecentPrintJob {
  id: string;
  entityType: string;
  status: string;
  createdAt: string;
  warningCode: string | null;
}

export interface DiagnosticsInvalidOrder {
  order_id: string;
  queue_id: number;
  invalid_menu_items: string[];
  created_at: string | null;
  reason: string;
}

export interface DiagnosticsPaymentAdjustmentBacklog {
  genericDeferred: number;
  waitingForParentPayment: number;
  waitingForCanonicalRemotePaymentId: number;
}

export interface DiagnosticsSyncStatusSummary {
  isOnline: boolean;
  lastSync?: string | null;
  lastSyncAt?: string | null;
  pendingItems: number;
  pendingChanges: number;
  syncInProgress: boolean;
  error?: string | null;
  syncErrors: number;
  queuedRemote: number;
  backpressureDeferred: number;
  oldestNextRetryAt?: string | null;
  lastQueueFailure?: Record<string, unknown> | null;
  historicalZReportConflicts: number;
  pendingPaymentItems: number;
  failedPaymentItems: number;
  financialStats?: Record<string, unknown>;
}

export interface DiagnosticsParityQueueStatus {
  total: number;
  pending: number;
  failed: number;
  conflicts: number;
  oldestItemAge?: number | null;
}

export interface DiagnosticsFinancialQueueBucket {
  pending: number;
  failed: number;
}

export interface DiagnosticsFinancialQueueStatus {
  driver_earnings: DiagnosticsFinancialQueueBucket;
  staff_payments: DiagnosticsFinancialQueueBucket;
  shift_expenses: DiagnosticsFinancialQueueBucket;
  payments?: DiagnosticsFinancialQueueBucket;
  pendingPaymentItems?: number;
  failedPaymentItems?: number;
  totalPending?: number;
  totalFailed?: number;
}

export interface DiagnosticsCredentialState {
  hasAdminUrl: boolean;
  hasApiKey: boolean;
}

export type DiagnosticsParitySyncStatus =
  | 'idle'
  | 'started'
  | 'completed'
  | 'skipped_missing_credentials'
  | 'failed';

export interface DiagnosticsLastParitySync {
  status: DiagnosticsParitySyncStatus;
  trigger?: string;
  startedAt: string;
  finishedAt?: string | null;
  processed: number;
  failed: number;
  conflicts: number;
  remaining: number;
  error?: string | null;
  reason?: string | null;
  legacySyncTriggered: boolean;
  credentialState?: DiagnosticsCredentialState;
  queueStatus?: DiagnosticsParityQueueStatus | null;
}

export interface DiagnosticsCheckoutPaymentBlockers {
  count: number;
  details: UnsettledPaymentBlocker[];
  sourceWindow: 'active_shift' | 'z_report';
}

export interface DiagnosticsSystemHealth {
  schemaVersion: number;
  syncBacklog: Record<string, Record<string, number>>;
  paymentAdjustmentBacklog: DiagnosticsPaymentAdjustmentBacklog;
  syncBlockerDetails?: SyncBlockerDetail[];
  terminalContext?: DiagnosticsTerminalContext;
  syncStatusSummary?: DiagnosticsSyncStatusSummary;
  lastSyncTimes: Record<string, string | null>;
  printerStatus: {
    configured: boolean;
    profileCount: number;
    defaultProfile: string | null;
    recentJobs: DiagnosticsRecentPrintJob[];
  };
  lastZReport: {
    id: string;
    shiftId: string;
    generatedAt: string;
    syncState: string;
    totalGrossSales: number;
    totalNetSales: number;
  } | null;
  pendingOrders: number;
  dbSizeBytes: number;
  invalidOrders?: {
    count: number;
    details: DiagnosticsInvalidOrder[];
  };
  parityQueueStatus?: DiagnosticsParityQueueStatus | null;
  financialQueueStatus?: DiagnosticsFinancialQueueStatus | null;
  lastParitySync?: DiagnosticsLastParitySync | null;
  credentialState?: DiagnosticsCredentialState | null;
  checkoutPaymentBlockers?: DiagnosticsCheckoutPaymentBlockers | null;
  isOnline: boolean;
  lastSyncTime: string | null;
}

export interface DiagnosticsExportOptions {
  includeLogs?: boolean;
  redactSensitive?: boolean;
}

export interface DiagnosticsExportResponse {
  success: boolean;
  path: string;
  options?: {
    includeLogs: boolean;
    redactSensitive: boolean;
  };
  error?: string;
}

export interface DiagnosticsOpenExportDirResponse {
  success: boolean;
  path?: string;
  error?: string;
}

// -- Recovery Center ---------------------------------------------------------

export interface DiagnosticsTerminalContext {
  terminalId: string | null;
  branchId: string | null;
  branchName?: string | null;
  organizationId: string | null;
  organizationName?: string | null;
  terminalType?: string | null;
  parentTerminalId?: string | null;
  ownerTerminalId?: string | null;
  ownerTerminalDbId?: string | null;
  sourceTerminalId?: string | null;
  sourceTerminalDbId?: string | null;
  posOperatingMode?: string | null;
  enabledFeatures?: Record<string, unknown>;
  lastConfigSyncAt?: string | null;
  syncHealth?: string | null;
  syncHealthState?: string | null;
  businessType?: string | null;
  ghostModeFeatureEnabled?: boolean | string | null;
  adminDashboardUrl?: string | null;
}

export type RecoveryIssueSeverity = 'critical' | 'error' | 'warning' | 'info';
export type RecoveryIssueStatus = 'blocking' | 'recovering' | 'resolved';

export interface RecoveryRouteTarget {
  screen: string;
  orderId?: string | null;
  orderNumber?: string | null;
  shiftId?: string | null;
  zReportDate?: string | null;
  params?: Record<string, unknown>;
}

export type RecoveryActionSafetyLevel =
  | 'safe'
  | 'destructive_local'
  | 'destructive_server';

export interface RecoveryActionDescriptor {
  id: string;
  labelKey: string;
  safetyLevel: RecoveryActionSafetyLevel;
  requiresOnline: boolean;
  confirmationRequired: boolean;
  confirmTitleKey?: string;
  confirmMessageKey?: string;
  confirmCheckboxKey?: string;
  routeTarget?: RecoveryRouteTarget | null;
}

export interface RecoveryIssue {
  id: string;
  code: string;
  severity: RecoveryIssueSeverity;
  status: RecoveryIssueStatus;
  entityType: string;
  entityId: string;
  titleKey: string;
  summaryKey: string;
  guidanceKey: string;
  actions: RecoveryActionDescriptor[];
  params?: Record<string, unknown>;
  orderId?: string | null;
  orderNumber?: string | null;
  paymentId?: string | null;
  adjustmentId?: string | null;
  zReportId?: string | null;
  shiftId?: string | null;
  queueId?: number | null;
}

export interface RecoveryActionRequest {
  actionId: string;
  issueId: string;
  issueCode: string;
  queueId: number | null;
  entityType: string;
  entityId: string;
  orderId: string | null;
  orderNumber: string | null;
  paymentId: string | null;
  adjustmentId: string | null;
  zReportId: string | null;
  shiftId: string | null;
  reportDate: string | null;
  params?: Record<string, unknown>;
}

export interface RecoveryActionResult {
  success: boolean;
  requiresRefresh: boolean;
  routeTarget?: RecoveryRouteTarget | null;
  message?: string;
}

export interface RecoveryActionLogEntry {
  id: string;
  actionId: string;
  issueCode: string;
  success: boolean;
  timestamp: string;
  actor: {
    staffId: string | null;
    staffName: string | null;
  };
  targetRefs: {
    entityId?: string;
    orderId?: string | null;
    orderNumber?: string | null;
    shiftId?: string | null;
  };
}
