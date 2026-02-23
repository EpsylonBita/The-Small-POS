/**
 * Native event bridge for POS Tauri.
 *
 * `onEvent/offEvent` remain stable for renderer consumers while event delivery
 * is now wired directly to Tauri listeners.
 */

import { isTauri } from './platform-detect';

type UnlistenFn = () => void;
type EventCallback = (data: any) => void;

/**
 * Maps Tauri event names (snake_case) to renderer channel names.
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

  // --- Window state ---
  'window_state_changed': 'window-state-changed',

  // --- Menu management ---
  'menu_sync': 'menu:sync',
  'menu_check_for_updates': 'menu:check-for-updates',
  'menu_version_checked': 'menu:version-checked',

  // --- Screen capture ---
  'screen_capture_start': 'screen-capture:start',
  'screen_capture_stop': 'screen-capture:stop',
  'screen_capture_signal_batch': 'screen-capture:signal-batch',
  'screen_capture_signal_poll_error': 'screen-capture:signal-poll-error',
  'screen_capture_signal_poll_stopped': 'screen-capture:signal-poll-stopped',

  // --- Module sync events ---
  'modules_sync_complete': 'modules:sync-complete',
  'modules_sync_error': 'modules:sync-error',
  'modules_refresh_needed': 'modules:refresh-needed',

  // --- Printer status events ---
  'printer_status_changed': 'printer:status-changed',

  // --- Terminal config events ---
  'terminal_config_updated': 'terminal-config-updated',

  // --- ECR events ---
  'ecr_event_device_connected': 'ecr:event:device-connected',
  'ecr_event_device_disconnected': 'ecr:event:device-disconnected',
  'ecr_event_device_status_changed': 'ecr:event:device-status-changed',
  'ecr_event_transaction_started': 'ecr:event:transaction-started',
  'ecr_event_transaction_status': 'ecr:event:transaction-status',
  'ecr_event_transaction_completed': 'ecr:event:transaction-completed',
  'ecr_event_display_message': 'ecr:event:display-message',
  'ecr_event_error': 'ecr:event:error',
};

const CHANNEL_TO_TAURI_EVENT = Object.entries(EVENT_MAP).reduce<Record<string, string>>(
  (acc, [tauriEvent, channel]) => {
    if (!acc[channel]) {
      acc[channel] = tauriEvent;
    }
    return acc;
  },
  {}
);

const listenersByChannel = new Map<string, Set<EventCallback>>();
const unlistenByChannel = new Map<string, UnlistenFn>();
const pendingAttachByChannel = new Map<string, Promise<void>>();

function dispatch(channel: string, payload: any): void {
  const listeners = listenersByChannel.get(channel);
  if (!listeners || listeners.size === 0) return;

  for (const callback of listeners) {
    try {
      callback(payload);
    } catch (error) {
      console.error(`[EventBridge] listener failed for channel "${channel}"`, error);
    }
  }
}

async function attachChannelListener(channel: string): Promise<void> {
  if (!isTauri()) return;
  if (unlistenByChannel.has(channel) || pendingAttachByChannel.has(channel)) return;

  const tauriEvent = CHANNEL_TO_TAURI_EVENT[channel];
  if (!tauriEvent) return;

  const attachPromise = (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<any>(tauriEvent, (event) => {
      dispatch(channel, event.payload);
    });

    const listeners = listenersByChannel.get(channel);
    if (!listeners || listeners.size === 0) {
      unlisten();
      return;
    }

    unlistenByChannel.set(channel, unlisten);
  })()
    .catch((error) => {
      console.error(`[EventBridge] failed to attach "${channel}"`, error);
    })
    .finally(() => {
      pendingAttachByChannel.delete(channel);
    });

  pendingAttachByChannel.set(channel, attachPromise);
  await attachPromise;
}

function detachChannelListener(channel: string): void {
  const unlisten = unlistenByChannel.get(channel);
  if (!unlisten) return;
  unlisten();
  unlistenByChannel.delete(channel);
}

/**
 * Deprecated compatibility shim.
 *
 * Legacy startup code used this to start a bus forwarding layer. In the
 * native-only runtime, `onEvent` subscribes lazily per channel.
 */
export async function startEventBridge(): Promise<void> {
  if (!isTauri()) return;
}

/**
 * Removes all active Tauri listener bindings.
 * Renderer channel subscriptions remain registered.
 */
export function stopEventBridge(): void {
  for (const unlisten of unlistenByChannel.values()) {
    unlisten();
  }
  unlistenByChannel.clear();
  pendingAttachByChannel.clear();
}

export function onEvent(channel: string, callback: EventCallback): void {
  let listeners = listenersByChannel.get(channel);
  if (!listeners) {
    listeners = new Set<EventCallback>();
    listenersByChannel.set(channel, listeners);
  }

  listeners.add(callback);
  void attachChannelListener(channel);
}

export function offEvent(channel: string, callback: EventCallback): void {
  const listeners = listenersByChannel.get(channel);
  if (!listeners) return;

  listeners.delete(callback);
  if (listeners.size > 0) return;

  listenersByChannel.delete(channel);
  detachChannelListener(channel);
}

export function emitCompatEvent(channel: string, data: any): void {
  dispatch(channel, data);
}
