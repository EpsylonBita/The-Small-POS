/**
 * Subscription Manager
 * Handles Supabase real-time subscriptions to prevent "tried to subscribe multiple times" errors
 */

import { supabase } from '../../shared/supabase';

interface SubscriptionConfig {
  table: string;
  event: string;
  callback: (payload: any) => void;
  filter?: string;
  onStatusChange?: (status: SubscriptionStatus) => void;
}

export interface SubscriptionStatus {
  key: string;
  table: string;
  status: 'connecting' | 'active' | 'error' | 'closed';
  callbackCount: number;
  channelStatus?: string;
  error?: string;
}

class SubscriptionManager {
  private static instance: SubscriptionManager;
  private subscriptions = new Map<string, any>();
  private callbacks = new Map<string, Set<(payload: any) => void>>();
  private statusCallbacks = new Map<string, Set<(status: SubscriptionStatus) => void>>();
  private subscriptionStatus = new Map<string, SubscriptionStatus>();

  private constructor() {}

  static getInstance(): SubscriptionManager {
    if (!SubscriptionManager.instance) {
      SubscriptionManager.instance = new SubscriptionManager();
    }
    return SubscriptionManager.instance;
  }

  /**
   * Subscribe to a table with automatic deduplication
   */
  subscribe(
    subscriptionKey: string,
    config: SubscriptionConfig
  ): () => void {
    console.log(`📡 Subscribing to: ${subscriptionKey}`);

    // If subscription already exists, just add the callback
    if (this.subscriptions.has(subscriptionKey)) {
      console.log(`📡 Reusing existing subscription: ${subscriptionKey}`);
      
      if (!this.callbacks.has(subscriptionKey)) {
        this.callbacks.set(subscriptionKey, new Set());
      }
      this.callbacks.get(subscriptionKey)!.add(config.callback);
      this.addStatusCallback(subscriptionKey, config.onStatusChange);
      this.emitStatusToCallbacks(subscriptionKey);

      // Return unsubscribe function
      return () => {
        this.removeCallback(subscriptionKey, config.callback);
        this.removeStatusCallback(subscriptionKey, config.onStatusChange);
      };
    }

    // Create new subscription
    try {
      const subscriptionConfig: any = {
        event: config.event as any,
        schema: 'public',
        table: config.table,
      };

      // Add filter if provided
      if (config.filter) {
        subscriptionConfig.filter = config.filter;
      }

      const channel = supabase
        .channel(`${subscriptionKey}-${Date.now()}`)
        .on(
          'postgres_changes',
          subscriptionConfig,
          (payload) => {
            // Call all registered callbacks
            const callbacks = this.callbacks.get(subscriptionKey);
            if (callbacks) {
              callbacks.forEach(callback => {
                try {
                  callback(payload);
                } catch (error) {
                  console.error(`Error in subscription callback for ${subscriptionKey}:`, error);
                }
              });
            }
          }
        )
        .subscribe((status, err) => {
          this.handleChannelStatus(subscriptionKey, config.table, status, err);
        });

      this.subscriptions.set(subscriptionKey, channel);

      // Initialize callbacks set
      if (!this.callbacks.has(subscriptionKey)) {
        this.callbacks.set(subscriptionKey, new Set());
      }
      this.callbacks.get(subscriptionKey)!.add(config.callback);
      this.addStatusCallback(subscriptionKey, config.onStatusChange);

      // Track subscription status
      this.subscriptionStatus.set(subscriptionKey, {
        key: subscriptionKey,
        table: config.table,
        status: 'connecting',
        callbackCount: 1
      });
      this.emitStatusToCallbacks(subscriptionKey);

      console.log(`✅ Created new subscription: ${subscriptionKey}`);

      // Return unsubscribe function
      return () => {
        this.removeCallback(subscriptionKey, config.callback);
        this.removeStatusCallback(subscriptionKey, config.onStatusChange);
      };

    } catch (error) {
      console.error(`❌ Failed to create subscription ${subscriptionKey}:`, error);

      // Track error status
      this.subscriptionStatus.set(subscriptionKey, {
        key: subscriptionKey,
        table: config.table,
        status: 'error',
        callbackCount: 0,
        error: error instanceof Error ? error.message : String(error)
      });
      this.emitStatusToCallbacks(subscriptionKey);

      // Return no-op unsubscribe instead of throwing
      return () => {
        console.log(`No-op unsubscribe for failed subscription: ${subscriptionKey}`);
      };
    }
  }

  /**
   * Remove a callback from a subscription
   */
  private removeCallback(subscriptionKey: string, callback: (payload: any) => void): void {
    const callbacks = this.callbacks.get(subscriptionKey);
    if (callbacks) {
      callbacks.delete(callback);

      // Update status
      const status = this.subscriptionStatus.get(subscriptionKey);
      if (status) {
        status.callbackCount = callbacks.size;
      }

      this.maybeUnsubscribe(subscriptionKey);
    }
  }

  private addStatusCallback(
    subscriptionKey: string,
    callback?: (status: SubscriptionStatus) => void
  ): void {
    if (!callback) {
      return;
    }
    if (!this.statusCallbacks.has(subscriptionKey)) {
      this.statusCallbacks.set(subscriptionKey, new Set());
    }
    this.statusCallbacks.get(subscriptionKey)!.add(callback);
  }

  private removeStatusCallback(
    subscriptionKey: string,
    callback?: (status: SubscriptionStatus) => void
  ): void {
    if (!callback) {
      return;
    }
    const callbacks = this.statusCallbacks.get(subscriptionKey);
    if (callbacks) {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.statusCallbacks.delete(subscriptionKey);
      }
    }
    this.maybeUnsubscribe(subscriptionKey);
  }

  private maybeUnsubscribe(subscriptionKey: string): void {
    const callbackCount = this.callbacks.get(subscriptionKey)?.size ?? 0;
    const statusCallbackCount = this.statusCallbacks.get(subscriptionKey)?.size ?? 0;
    if (callbackCount === 0 && statusCallbackCount === 0) {
      this.unsubscribe(subscriptionKey);
    }
  }

  private handleChannelStatus(
    subscriptionKey: string,
    table: string,
    status: string,
    err?: Error
  ): void {
    const current = this.subscriptionStatus.get(subscriptionKey) || {
      key: subscriptionKey,
      table,
      status: 'connecting' as const,
      callbackCount: this.callbacks.get(subscriptionKey)?.size ?? 0,
    };

    const next: SubscriptionStatus = {
      ...current,
      callbackCount: this.callbacks.get(subscriptionKey)?.size ?? 0,
      channelStatus: status,
      error: err?.message || current.error,
    };

    if (status === 'SUBSCRIBED') {
      next.status = 'active';
      next.error = undefined;
    } else if (status === 'CLOSED') {
      next.status = 'closed';
      next.error = err?.message || 'Channel closed';
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      next.status = 'error';
      next.error = err?.message || status;
    } else {
      next.status = 'connecting';
    }

    this.subscriptionStatus.set(subscriptionKey, next);
    this.emitStatusToCallbacks(subscriptionKey);
  }

  private emitStatusToCallbacks(subscriptionKey: string): void {
    const status = this.subscriptionStatus.get(subscriptionKey);
    const callbacks = this.statusCallbacks.get(subscriptionKey);
    if (!status || !callbacks || callbacks.size === 0) {
      return;
    }

    callbacks.forEach(callback => {
      try {
        callback({ ...status });
      } catch (error) {
        console.error(`Error in status callback for ${subscriptionKey}:`, error);
      }
    });
  }

  /**
   * Unsubscribe from a specific subscription
   */
  private unsubscribe(subscriptionKey: string): void {
    const channel = this.subscriptions.get(subscriptionKey);
    if (channel) {
      try {
        supabase.removeChannel(channel);
        this.subscriptions.delete(subscriptionKey);
        this.callbacks.delete(subscriptionKey);
        this.statusCallbacks.delete(subscriptionKey);
        this.subscriptionStatus.delete(subscriptionKey);
        console.log(`📡 Unsubscribed from: ${subscriptionKey}`);
      } catch (error) {
        console.error(`❌ Error unsubscribing from ${subscriptionKey}:`, error);
      }
    }
  }

  /**
   * Clean up all subscriptions
   */
  cleanup(): void {
    console.log('🧹 Cleaning up all subscriptions...');

    for (const [key, channel] of this.subscriptions) {
      try {
        supabase.removeChannel(channel);
      } catch (error) {
        console.error(`Error cleaning up subscription ${key}:`, error);
      }
    }

    this.subscriptions.clear();
    this.callbacks.clear();
    this.statusCallbacks.clear();
    this.subscriptionStatus.clear();
    console.log('✅ All subscriptions cleaned up');
  }

  /**
   * Get subscription status for debugging
   */
  getStatus(): {
    activeSubscriptions: string[],
    totalCallbacks: number,
    subscriptionDetails: SubscriptionStatus[]
  } {
    const activeSubscriptions = Array.from(this.subscriptions.keys());
    const totalCallbacks = Array.from(this.callbacks.values())
      .reduce((sum, callbacks) => sum + callbacks.size, 0);
    const subscriptionDetails = Array.from(this.subscriptionStatus.values());

    return { activeSubscriptions, totalCallbacks, subscriptionDetails };
  }
}

export const subscriptionManager = SubscriptionManager.getInstance();
