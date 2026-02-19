/**
 * IPC Abstraction Layer - Public API
 *
 * Import from this barrel to access all platform bridge functionality.
 *
 * Quick start:
 *   import { installElectronCompat, startEventBridge, getBridge } from './lib';
 *
 *   // At app startup (before React renders):
 *   installElectronCompat();
 *   startEventBridge();
 *
 *   // For new code, prefer the typed bridge:
 *   const bridge = getBridge();
 *   const result = await bridge.auth.login({ pin: '1234' });
 */

// Platform detection
export {
  detectPlatform,
  getPlatform,
  isTauri,
  isElectron,
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
  ElectronBridge,
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

// Electron compatibility shim
export {
  installElectronCompat,
  resetElectronCompat,
  eventBus,
} from './electron-compat';

// Tauri event bridge
export {
  startEventBridge,
  stopEventBridge,
  onEvent,
  offEvent,
  emitCompatEvent,
} from './event-bridge';
