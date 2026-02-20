/**
 * Tauri Event Bridge
 *
 * Subscribes to Tauri backend events and re-emits them on the compat
 * event bus so that existing `ipcRenderer.on(channel, callback)` calls
 * work transparently.
 *
 * Electron pushes events from main -> renderer via `ipcRenderer.on`.
 * Tauri pushes events via `@tauri-apps/api/event::listen()`.
 * This bridge translates between the two models.
 *
 * The EVENT_MAP is derived from the ALLOWED_CHANNELS array in the Electron
 * preload script (pos-system/src/preload/index.ts).
 *
 * Usage:
 *   import { startEventBridge, stopEventBridge } from './lib/event-bridge';
 *   // Call after installElectronCompat()
 *   startEventBridge();
 */

import { eventBus } from './electron-compat';
import { isTauri } from './platform-detect';

type UnlistenFn = () => void;

/** All Tauri event subscriptions so we can clean up. */
const unlisteners: UnlistenFn[] = [];

/**
 * Maps Tauri event names (snake_case) to Electron IPC channel names.
 *
 * Tauri events use snake_case by convention.
 * Electron channels use kebab-case or colon-separated names.
 *
 * The bridge listens for the Tauri event (left) and emits on the
 * Electron channel (right) via the eventBus.
 *
 * Complete list derived from the Electron preload ALLOWED_CHANNELS array.
 */
const EVENT_MAP: Record<string, string> = {
  // --- App lifecycle / control ---
  'control_command_received': 'control-command-received',
  'app_shutdown_initiated': 'app-shutdown-initiated',
  'app_restart_initiated': 'app-restart-initiated',
  'app_close': 'app-close',
  'terminal_disabled': 'terminal-disabled',
  'terminal_enabled': 'terminal-enabled',
  'app_reset': 'app:reset',

  // --- Auto-updater events ---
  'update_checking': 'update-checking',
  'update_available': 'update-available',
  'update_not_available': 'update-not-available',
  'update_error': 'update-error',
  'download_progress': 'download-progress',
  'update_downloaded': 'update-downloaded',

  // --- Order events ---
  'order_realtime_update': 'order-realtime-update',
  'order_status_updated': 'order-status-updated',
  'order_created': 'order-created',
  'order_deleted': 'order-deleted',
  'order_payment_updated': 'order-payment-updated',

  // --- Customer events ---
  'customer_created': 'customer-created',
  'customer_updated': 'customer-updated',
  'customer_deleted': 'customer-deleted',
  'customer_realtime_update': 'customer-realtime-update',
  'customer_sync_conflict': 'customer-sync-conflict',
  'customer_conflict_resolved': 'customer-conflict-resolved',

  // --- Conflict and retry events ---
  'order_sync_conflict': 'order-sync-conflict',
  'order_conflict_resolved': 'order-conflict-resolved',
  'sync_retry_scheduled': 'sync-retry-scheduled',
  'orders_cleared': 'orders-cleared',

  // --- Sync events ---
  'sync_status': 'sync:status',
  'network_status': 'network:status',
  'settings_update': 'settings:update',
  'staff_permission_update': 'staff:permission-update',
  'hardware_config_update': 'hardware-config:update',
  'app_restart_required': 'app:restart-required',
  'sync_error': 'sync:error',
  'sync_complete': 'sync:complete',

  // --- Shift events ---
  'shift_updated': 'shift-updated',

  // --- Database health ---
  'database_health_update': 'database-health-update',

  // --- Terminal settings ---
  'terminal_settings_updated': 'terminal-settings-updated',
  'terminal_credentials_updated': 'terminal-credentials-updated',

  // --- Session management ---
  'session_timeout': 'session-timeout',

  // --- Menu management ---
  'menu_sync': 'menu:sync',
  'menu_check_for_updates': 'menu:check-for-updates',

  // --- Screen capture ---
  'screen_capture_start': 'screen-capture:start',
  'screen_capture_stop': 'screen-capture:stop',

  // --- Module sync events ---
  'modules_sync_complete': 'modules:sync-complete',
  'modules_sync_error': 'modules:sync-error',
  'modules_refresh_needed': 'modules:refresh-needed',

  // --- Printer status events ---
  'printer_status_changed': 'printer:status-changed',

  // --- Terminal config events (heartbeat updates) ---
  'terminal_config_updated': 'terminal-config-updated',

  // --- ECR (Payment Terminal) events ---
  'ecr_event_device_connected': 'ecr:event:device-connected',
  'ecr_event_device_disconnected': 'ecr:event:device-disconnected',
  'ecr_event_device_status_changed': 'ecr:event:device-status-changed',
  'ecr_event_transaction_started': 'ecr:event:transaction-started',
  'ecr_event_transaction_status': 'ecr:event:transaction-status',
  'ecr_event_transaction_completed': 'ecr:event:transaction-completed',
  'ecr_event_display_message': 'ecr:event:display-message',
  'ecr_event_error': 'ecr:event:error',
};

/**
 * Start listening to Tauri events and forwarding them to the compat event bus.
 *
 * No-op if not running in Tauri.
 */
export async function startEventBridge(): Promise<void> {
  if (!isTauri()) return;

  // Clean up any existing listeners first (idempotent — prevents HMR accumulation)
  stopEventBridge();

  const { listen } = await import('@tauri-apps/api/event');

  for (const [tauriEvent, electronChannel] of Object.entries(EVENT_MAP)) {
    const unlisten = await listen<any>(tauriEvent, (event) => {
      eventBus.emit(electronChannel, event.payload);
    });
    unlisteners.push(unlisten);
  }

  console.log(
    `[EventBridge] Listening to ${Object.keys(EVENT_MAP).length} Tauri events`
  );
}

/**
 * Stop all Tauri event subscriptions.
 */
export function stopEventBridge(): void {
  for (const unlisten of unlisteners) {
    unlisten();
  }
  unlisteners.length = 0;
  console.log('[EventBridge] All listeners removed');
}

/**
 * Convenience: subscribe to an event channel using the Electron channel name.
 * Works on both Tauri (via eventBus) and Electron (via eventBus).
 */
export function onEvent(channel: string, callback: (data: any) => void): void {
  eventBus.on(channel, callback);
}

/**
 * Convenience: unsubscribe from an event channel.
 */
export function offEvent(channel: string, callback: (data: any) => void): void {
  eventBus.removeListener(channel, callback);
}

/**
 * Emit an event on the compat bus (useful for testing or for Rust -> JS
 * communication that bypasses the standard Tauri event system).
 */
export function emitCompatEvent(electronChannel: string, data: any): void {
  eventBus.emit(electronChannel, data);
}
