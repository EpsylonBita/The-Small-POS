/**
 * IPC Abstraction Layer - Public API
 *
 * Import from this barrel to access all platform bridge functionality.
 */

// Platform detection
export {
  detectPlatform,
  getPlatform,
  isTauri,
  isBrowser,
  resetPlatformCache,
  type Platform,
} from './platform-detect';

// Typed platform bridge
export {
  getBridge,
  setBridge,
  resetBridge,
  createBridge,
  TauriBridge,
  CHANNEL_MAP,
  type PlatformBridge,
  type IpcResult,
  type AuthLoginPayload,
  type AuthLoginResponse,
  type SessionValidationResponse,
  type TerminalSettings,
  type UpdateTerminalCredentialsPayload,
  type OrderItem,
  type Order,
  type CreateOrderPayload,
  type SyncStatus,
  type NetworkStatus,
  type Customer,
  type CustomerAddress,
  type OpenShiftParams,
  type CloseShiftParams,
  type RecordExpenseParams,
  type RecordStaffPaymentParams,
  type MenuCategory,
  type MenuUpdatePayload,
  type ModuleSyncResponse,
  type EcrPaymentOptions,
  type EcrRefundOptions,
  type WindowState,
  type UpdateState,
  type PrinterConfig,
} from './ipc-adapter';

export type {
  AuthSetupPinRequest,
  SettingsConfiguredResponse,
  SettingsGetRequest,
  SettingsSetRequest,
  SettingsUpdateLocalRequest,
  SyncRemoveInvalidOrdersResponse,
  SyncValidatePendingOrdersResponse,
  TerminalConfigGetSettingRequest,
  DiagnosticsAboutInfo,
  DiagnosticsSystemHealth,
  DiagnosticsExportOptions,
  DiagnosticsExportResponse,
} from './ipc-contracts';

// Tauri event bridge
export {
  startEventBridge,
  stopEventBridge,
  onEvent,
  offEvent,
  emitCompatEvent,
} from './event-bridge';
