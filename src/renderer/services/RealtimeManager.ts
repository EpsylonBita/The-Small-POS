/**
 * DesktopRealtimeManager
 *
 * Manages Supabase Realtime subscriptions for the desktop POS client.
 * Subscribes to tables defined in POS_REALTIME_SUBSCRIPTIONS (orders,
 * pos_terminal_settings, organization_modules) filtered by organization_id.
 *
 * Features:
 * - Exponential backoff reconnection (initial 1s, max 30s)
 * - Polling fallback when realtime is unavailable
 * - One-time full sync on reconnection
 * - Graceful close on API key revocation
 * - Connection status for UI indicator
 *
 * @see shared/config/realtimeConfig.ts for subscription definitions
 */

import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import {
  POS_REALTIME_SUBSCRIPTIONS,
  calculateReconnectDelay,
  getRealtimeChannelName,
  type RealtimeReconnectConfig,
  type RealtimeTableSubscriptionConfig,
} from '../../../../shared/config/realtimeConfig';

// ============================================================
// TYPES
// ============================================================

/** Connection status exposed to UI components */
export type SubscriptionConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'reconnecting'
  | 'polling';

/** Payload shape for realtime change events */
export interface RealtimePayload {
  eventType: string;
  table: string;
  schema: string;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
  commit_timestamp?: string;
}

/** Configuration accepted by the DesktopRealtimeManager constructor */
export interface DesktopRealtimeManagerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  organizationId: string;
  /** Callback for order table changes */
  onOrderChange: (payload: RealtimePayload) => void;
  /** Callback for pos_terminal_settings changes */
  onConfigChange: (payload: RealtimePayload) => void;
  /** Callback for organization_modules changes */
  onModuleChange: (payload: RealtimePayload) => void;
  /** Optional callback invoked on reconnection so the caller can perform a full sync */
  onFullSyncNeeded?: () => void;
  /** Optional callback when API key is revoked / invalid */
  onApiKeyRevoked?: () => void;
  /** Optional callback whenever the connection status changes */
  onStatusChange?: (status: SubscriptionConnectionStatus) => void;
  /** Reconnect configuration override */
  reconnectConfig?: Partial<RealtimeReconnectConfig>;
  /** Polling interval in milliseconds when realtime is unavailable (default 30000) */
  pollingIntervalMs?: number;
  /** Optional pre-built Supabase client (useful for testing) */
  client?: SupabaseClient;
}

// ============================================================
// CONSTANTS
// ============================================================

const DEFAULT_POLLING_INTERVAL_MS = 30_000;

/** Reconnect config tuned for desktop: initial 1s, max 30s */
const DESKTOP_RECONNECT_CONFIG: RealtimeReconnectConfig = {
  maxReconnectAttempts: 5,
  reconnectDelayMs: 1_000,
  maxReconnectDelayMs: 30_000,
};

// ============================================================
// IMPLEMENTATION
// ============================================================

/**
 * Map subscription IDs to their respective callbacks.
 * The IDs come from POS_REALTIME_SUBSCRIPTIONS.
 */
function getCallbackForSubscription(
  id: string,
  config: DesktopRealtimeManagerConfig
): ((payload: RealtimePayload) => void) | null {
  switch (id) {
    case 'orders':
      return config.onOrderChange;
    case 'terminal-settings':
      return config.onConfigChange;
    case 'organization-modules':
      return config.onModuleChange;
    default:
      return null;
  }
}

export class DesktopRealtimeManager {
  private supabaseClient: SupabaseClient;
  private config: DesktopRealtimeManagerConfig;
  private reconnectConfig: RealtimeReconnectConfig;

  /** Active realtime channels keyed by subscription ID */
  private channels: Map<string, RealtimeChannel> = new Map();
  /** Current connection status */
  private connectionStatus: SubscriptionConnectionStatus = 'disconnected';
  /** Current reconnection attempt counter */
  private reconnectAttempt = 0;
  /** Reconnect timer handle */
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Polling timer handle */
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  /** Whether the manager has been intentionally disconnected */
  private intentionalDisconnect = false;
  /** Whether we have ever successfully connected (used for reconnect full-sync) */
  private hasConnectedBefore = false;

  constructor(config: DesktopRealtimeManagerConfig) {
    this.config = config;
    this.reconnectConfig = {
      ...DESKTOP_RECONNECT_CONFIG,
      ...config.reconnectConfig,
    };

    // Use provided client or create a fresh one
    this.supabaseClient =
      config.client ??
      createClient(config.supabaseUrl, config.supabaseKey);
  }

  // ----------------------------------------------------------
  // PUBLIC API
  // ----------------------------------------------------------

  /**
   * Establish Supabase realtime subscriptions for all POS tables.
   * Subscriptions are filtered by organization_id.
   */
  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.setConnectionStatus('connecting');

    try {
      await this.subscribeAll();
    } catch (err) {
      console.error('[RealtimeManager] Failed to connect:', err);
      this.handleConnectionFailure();
    }
  }

  /**
   * Gracefully close all subscriptions and stop reconnection / polling.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.clearReconnectTimeout();
    this.stopPolling();

    for (const [id, channel] of this.channels) {
      try {
        this.supabaseClient.removeChannel(channel);
        console.log(`[RealtimeManager] Removed channel: ${id}`);
      } catch (err) {
        console.error(`[RealtimeManager] Error removing channel ${id}:`, err);
      }
    }

    this.channels.clear();
    this.setConnectionStatus('disconnected');
    this.reconnectAttempt = 0;
  }

  /** Current connection status for UI indicator */
  getConnectionStatus(): SubscriptionConnectionStatus {
    return this.connectionStatus;
  }

  /** Whether the manager currently has active subscriptions */
  isConnected(): boolean {
    return this.connectionStatus === 'connected';
  }

  // ----------------------------------------------------------
  // SUBSCRIPTION MANAGEMENT
  // ----------------------------------------------------------

  /**
   * Subscribe to every table listed in POS_REALTIME_SUBSCRIPTIONS,
   * filtered by `organization_id`.
   */
  private async subscribeAll(): Promise<void> {
    const channelName = getRealtimeChannelName('POS_TAURI', this.config.organizationId);

    for (const sub of POS_REALTIME_SUBSCRIPTIONS) {
      await this.subscribeToTable(sub, channelName);
    }
  }

  /**
   * Create a single Supabase channel for a table subscription config.
   */
  private async subscribeToTable(
    sub: RealtimeTableSubscriptionConfig,
    baseChannelName: string
  ): Promise<void> {
    const callback = getCallbackForSubscription(sub.id, this.config);
    if (!callback) {
      console.warn(`[RealtimeManager] No callback registered for subscription: ${sub.id}`);
      return;
    }

    // Remove existing channel if re-subscribing
    const existing = this.channels.get(sub.id);
    if (existing) {
      try {
        this.supabaseClient.removeChannel(existing);
      } catch {
        // best-effort cleanup
      }
    }

    const uniqueChannelName = `${baseChannelName}-${sub.id}-${Date.now()}`;

    // Build per-event listeners on a single channel
    const channel = this.supabaseClient.channel(uniqueChannelName);

    for (const event of sub.events) {
      const pgEvent = event === '*' ? '*' : event;
      channel.on(
        'postgres_changes' as any,
        {
          event: pgEvent,
          schema: sub.schema,
          table: sub.table,
          filter: `${sub.filterColumn}=eq.${this.config.organizationId}`,
        },
        (payload: any) => {
          try {
            callback({
              eventType: payload.eventType ?? payload.type ?? event,
              table: sub.table,
              schema: sub.schema,
              new: payload.new ?? {},
              old: payload.old ?? {},
              commit_timestamp: payload.commit_timestamp,
            });
          } catch (err) {
            console.error(`[RealtimeManager] Callback error for ${sub.id}:`, err);
          }
        }
      );
    }

    channel.subscribe((status: string, err?: Error) => {
      this.handleChannelStatus(sub.id, status, err);
    });

    this.channels.set(sub.id, channel);
    console.log(`[RealtimeManager] Subscribed to ${sub.table} (${sub.id})`);
  }

  // ----------------------------------------------------------
  // STATUS & RECONNECTION
  // ----------------------------------------------------------

  /**
   * React to channel status changes from Supabase realtime.
   */
  private handleChannelStatus(subscriptionId: string, status: string, err?: Error): void {
    console.log(`[RealtimeManager] Channel ${subscriptionId} status: ${status}`);

    if (status === 'SUBSCRIBED') {
      // If we were reconnecting, trigger a full sync once all channels are subscribed
      if (this.hasConnectedBefore && this.connectionStatus !== 'connected') {
        this.config.onFullSyncNeeded?.();
      }

      this.hasConnectedBefore = true;
      this.reconnectAttempt = 0;
      this.stopPolling();
      this.setConnectionStatus('connected');
    } else if (status === 'CLOSED') {
      if (!this.intentionalDisconnect) {
        this.handleConnectionFailure();
      }
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      // Check for API key revocation (401 / invalid key patterns)
      if (this.isApiKeyError(err)) {
        this.handleApiKeyRevocation();
        return;
      }

      if (!this.intentionalDisconnect) {
        this.handleConnectionFailure();
      }
    }
  }

  /**
   * Determine whether an error is caused by an invalid or revoked API key.
   */
  private isApiKeyError(err?: Error): boolean {
    if (!err) return false;
    const msg = err.message?.toLowerCase() ?? '';
    return (
      msg.includes('invalid api key') ||
      msg.includes('api key') ||
      msg.includes('401') ||
      msg.includes('unauthorized') ||
      msg.includes('jwt expired') ||
      msg.includes('invalid claim')
    );
  }

  /**
   * Handle API key revocation: close everything and notify the operator.
   */
  private handleApiKeyRevocation(): void {
    console.error('[RealtimeManager] API key revoked or invalid. Closing all subscriptions.');
    this.disconnect();
    this.setConnectionStatus('error');
    this.config.onApiKeyRevoked?.();
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   * If max attempts exceeded, fall back to polling.
   */
  private handleConnectionFailure(): void {
    if (this.intentionalDisconnect) return;

    if (this.reconnectAttempt >= this.reconnectConfig.maxReconnectAttempts) {
      console.warn(
        '[RealtimeManager] Max reconnect attempts reached. Falling back to polling.'
      );
      this.startPolling();
      return;
    }

    this.setConnectionStatus('reconnecting');

    const delay = calculateReconnectDelay(this.reconnectAttempt, this.reconnectConfig);
    this.reconnectAttempt++;

    console.log(
      `[RealtimeManager] Reconnect attempt ${this.reconnectAttempt}/${this.reconnectConfig.maxReconnectAttempts} in ${delay}ms`
    );

    this.clearReconnectTimeout();
    this.reconnectTimeout = setTimeout(() => {
      if (!this.intentionalDisconnect) {
        this.connect();
      }
    }, delay);
  }

  // ----------------------------------------------------------
  // POLLING FALLBACK
  // ----------------------------------------------------------

  /**
   * Start polling as a fallback when realtime is unavailable.
   */
  private startPolling(): void {
    if (this.pollingInterval) return;

    const intervalMs = this.config.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    this.setConnectionStatus('polling');

    console.log(`[RealtimeManager] Starting polling fallback every ${intervalMs}ms`);

    this.pollingInterval = setInterval(() => {
      if (!this.intentionalDisconnect) {
        this.config.onFullSyncNeeded?.();
      }
    }, intervalMs);
  }

  /**
   * Stop the polling fallback.
   */
  private stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  private setConnectionStatus(status: SubscriptionConnectionStatus): void {
    this.connectionStatus = status;
    this.config.onStatusChange?.(status);
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }
}
