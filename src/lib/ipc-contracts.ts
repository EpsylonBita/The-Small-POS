/**
 * Shared IPC DTO contracts for renderer/native bridge calls.
 * These types are intentionally runtime-agnostic and reusable by any caller.
 */

// -- Auth --------------------------------------------------------------------

export interface AuthSetupPinRequest {
  adminPin?: string;
  staffPin?: string;
}

// -- Settings / Terminal Config ----------------------------------------------

export interface SettingsConfiguredResponse {
  configured: boolean;
  reason?: string;
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
  [key: string]: unknown;
}

export interface ScreenCaptureSignalBatchPayload {
  requestId?: string;
  request?: ScreenCaptureRequestState | null;
  signals?: ScreenCaptureSignal[];
  lastSignalTimestamp?: string | null;
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

export interface DiagnosticsSystemHealth {
  schemaVersion: number;
  syncBacklog: Record<string, Record<string, number>>;
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
