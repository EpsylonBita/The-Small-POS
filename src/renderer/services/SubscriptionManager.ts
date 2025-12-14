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
}

interface SubscriptionStatus {
  key: string;
  table: string;
  status: 'active' | 'error';
  callbackCount: number;
  error?: string;
}

class SubscriptionManager {
  private static instance: SubscriptionManager;
  private subscriptions = new Map<string, any>();
  private callbacks = new Map<string, Set<(payload: any) => void>>();
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

      // Return unsubscribe function
      return () => {
        this.removeCallback(subscriptionKey, config.callback);
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
        .subscribe();

      this.subscriptions.set(subscriptionKey, channel);

      // Initialize callbacks set
      if (!this.callbacks.has(subscriptionKey)) {
        this.callbacks.set(subscriptionKey, new Set());
      }
      this.callbacks.get(subscriptionKey)!.add(config.callback);

      // Track subscription status
      this.subscriptionStatus.set(subscriptionKey, {
        key: subscriptionKey,
        table: config.table,
        status: 'active',
        callbackCount: 1
      });

      console.log(`✅ Created new subscription: ${subscriptionKey}`);

      // Return unsubscribe function
      return () => {
        this.removeCallback(subscriptionKey, config.callback);
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

      // If no more callbacks, unsubscribe completely
      if (callbacks.size === 0) {
        this.unsubscribe(subscriptionKey);
      }
    }
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
