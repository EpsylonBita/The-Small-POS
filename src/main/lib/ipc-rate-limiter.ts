/**
 * IPC Rate Limiter
 *
 * Prevents DoS attacks via IPC flooding from compromised renderer process.
 * Uses token bucket algorithm for fair rate limiting.
 */

interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
}

export class IPCRateLimiter {
  private buckets: Map<string, RateLimitBucket> = new Map();
  private globalBucket: RateLimitBucket;

  // Default limits
  private readonly DEFAULT_RATE = 100; // requests per window
  private readonly DEFAULT_WINDOW = 60000; // 60 seconds
  private readonly GLOBAL_RATE = 1000; // global limit across all channels
  private readonly REFILL_INTERVAL = 1000; // refill every second

  // Custom limits for specific channels
  private channelLimits: Map<string, { rate: number; window: number }> = new Map([
    // High-frequency channels
    ['order:get-all', { rate: 30, window: 60000 }], // 30/min
    ['sync:get-status', { rate: 60, window: 60000 }],
    ['database:health-check', { rate: 10, window: 60000 }],

    // Expensive operations
    ['order:create', { rate: 100, window: 60000 }], // 100 orders/min max
    ['order:update-status', { rate: 200, window: 60000 }],
    ['payment:print-receipt', { rate: 50, window: 60000 }],
    ['kitchen:print-ticket', { rate: 50, window: 60000 }],

    // Critical operations (stricter limits)
    ['database:reset', { rate: 1, window: 3600000 }], // 1/hour
    ['database:clear-operational-data', { rate: 1, window: 3600000 }],
    ['settings:factory-reset', { rate: 1, window: 3600000 }],
    ['orders:clear-all', { rate: 1, window: 3600000 }],

    // Auth operations
    ['auth:login', { rate: 10, window: 60000 }], // 10 login attempts/min
    ['auth:logout', { rate: 20, window: 60000 }],

    // File operations
    ['modules:fetch-from-admin', { rate: 10, window: 60000 }],
    ['modules:save-cache', { rate: 20, window: 60000 }],
  ]);

  constructor() {
    // Initialize global bucket
    this.globalBucket = {
      tokens: this.GLOBAL_RATE,
      lastRefill: Date.now()
    };

    // Start periodic refill
    this.startRefillTimer();
  }

  /**
   * Check if a request should be allowed
   * @param channel - IPC channel name
   * @param cost - Token cost (default 1, can be higher for expensive operations)
   * @returns true if allowed, false if rate limit exceeded
   */
  public check(channel: string, cost: number = 1): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();

    // Check global rate limit first
    this.refillBucket(this.globalBucket, this.GLOBAL_RATE, now);
    if (this.globalBucket.tokens < cost) {
      const retryAfter = Math.ceil((cost - this.globalBucket.tokens) * (this.REFILL_INTERVAL / this.GLOBAL_RATE));
      console.warn(`[IPC RateLimit] Global limit exceeded. Retry after ${retryAfter}ms`);
      return { allowed: false, retryAfter };
    }

    // Check channel-specific rate limit
    const limits = this.channelLimits.get(channel) || {
      rate: this.DEFAULT_RATE,
      window: this.DEFAULT_WINDOW
    };

    let bucket = this.buckets.get(channel);
    if (!bucket) {
      bucket = {
        tokens: limits.rate,
        lastRefill: now
      };
      this.buckets.set(channel, bucket);
    }

    this.refillBucket(bucket, limits.rate, now, limits.window);

    if (bucket.tokens < cost) {
      const retryAfter = Math.ceil((cost - bucket.tokens) * (limits.window / limits.rate));
      console.warn(`[IPC RateLimit] Channel ${channel} limit exceeded. Retry after ${retryAfter}ms`);
      return { allowed: false, retryAfter };
    }

    // Consume tokens
    bucket.tokens -= cost;
    this.globalBucket.tokens -= cost;

    return { allowed: true };
  }

  /**
   * Refill tokens in a bucket based on elapsed time
   */
  private refillBucket(
    bucket: RateLimitBucket,
    maxTokens: number,
    now: number,
    window: number = this.REFILL_INTERVAL
  ): void {
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = (elapsed / window) * maxTokens;

    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(maxTokens, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }
  }

  /**
   * Start periodic refill timer
   */
  private startRefillTimer(): void {
    setInterval(() => {
      const now = Date.now();

      // Refill global bucket
      this.refillBucket(this.globalBucket, this.GLOBAL_RATE, now);

      // Refill channel buckets
      for (const [channel, bucket] of this.buckets.entries()) {
        const limits = this.channelLimits.get(channel) || {
          rate: this.DEFAULT_RATE,
          window: this.DEFAULT_WINDOW
        };
        this.refillBucket(bucket, limits.rate, now, limits.window);
      }

      // Cleanup old buckets (haven't been used in 5 minutes)
      for (const [channel, bucket] of this.buckets.entries()) {
        if (now - bucket.lastRefill > 300000) {
          this.buckets.delete(channel);
        }
      }
    }, this.REFILL_INTERVAL);
  }

  /**
   * Get current rate limit status for a channel
   */
  public getStatus(channel?: string): any {
    if (channel) {
      const bucket = this.buckets.get(channel);
      const limits = this.channelLimits.get(channel) || {
        rate: this.DEFAULT_RATE,
        window: this.DEFAULT_WINDOW
      };
      return {
        channel,
        tokens: bucket?.tokens || limits.rate,
        maxTokens: limits.rate,
        window: limits.window
      };
    }

    return {
      global: {
        tokens: this.globalBucket.tokens,
        maxTokens: this.GLOBAL_RATE
      },
      channels: Array.from(this.buckets.entries()).map(([ch, bucket]) => ({
        channel: ch,
        tokens: bucket.tokens,
        lastRefill: bucket.lastRefill
      }))
    };
  }

  /**
   * Reset rate limits (for testing or emergency)
   */
  public reset(channel?: string): void {
    if (channel) {
      this.buckets.delete(channel);
    } else {
      this.buckets.clear();
      this.globalBucket.tokens = this.GLOBAL_RATE;
      this.globalBucket.lastRefill = Date.now();
    }
  }
}

// Singleton instance
export const rateLimiter = new IPCRateLimiter();
