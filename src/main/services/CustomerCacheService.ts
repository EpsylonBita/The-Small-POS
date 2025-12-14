import Database from 'better-sqlite3';
import { Customer } from '../../shared/types/customer';
import { BaseService } from './BaseService';

/**
 * CustomerCacheService - SQLite-based customer cache
 *
 * Provides offline fallback for customer lookups with 24-hour TTL.
 * Uses BaseService for database operations.
 *
 * Schema:
 * - customer_cache table with phone, data (JSON), expires_at
 * - Index on phone for fast lookups
 * - Index on expires_at for cleanup
 *
 * NOTE: This service is self-managed and creates its own tables/indexes
 * on construction. It is NOT managed by DatabaseService.createTables().
 * This is intentional to keep customer cache logic isolated and allow
 * CustomerService to be used independently of the main DatabaseService.
 */
export class CustomerCacheService extends BaseService {
  private readonly CACHE_TTL_HOURS = 24;

  constructor(database: Database.Database) {
    super(database);
    this.initializeCache();
  }

  /**
   * Initialize customer_cache table if it doesn't exist
   *
   * This is called automatically on construction and creates:
   * - customer_cache table
   * - Index on expires_at for efficient cleanup
   */
  private initializeCache(): void {
    // Create table
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS customer_cache (
        phone TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // Create index on expires_at for efficient cleanup
    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_customer_cache_expires_at 
      ON customer_cache(expires_at)
    `).run();

    console.info('Customer cache initialized');
  }

  /**
   * Cache a customer record
   * 
   * @param customer - Customer object to cache
   */
  public cacheCustomer(customer: Customer): void {
    if (!customer.phone) {
      console.warn('Cannot cache customer without phone number');
      return;
    }

    const expiresAt = this.calculateExpiryTime(this.CACHE_TTL_HOURS);

    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO customer_cache (phone, data, expires_at)
        VALUES (?, ?, ?)
      `).run(
        customer.phone,
        JSON.stringify(customer),
        expiresAt
      );

      console.debug(`Cached customer ${customer.phone} until ${expiresAt}`);
    } catch (error) {
      console.error('Failed to cache customer:', error);
      throw error;
    }
  }

  /**
   * Get cached customer by phone number
   *
   * @param phone - Phone number to lookup
   * @param options - Optional parameters
   * @returns Customer object or null if not found/expired
   */
  public getCachedCustomer(phone: string, options?: { skipExpiry?: boolean }): Customer | null {
    try {
      const row = this.db.prepare(`
        SELECT data, expires_at
        FROM customer_cache
        WHERE phone = ?
      `).get(phone) as { data: string; expires_at: string } | undefined;

      if (!row) {
        return null;
      }

      // Check if expired (unless skipExpiry is true)
      if (!options?.skipExpiry && this.isCacheExpired(row.expires_at)) {
        console.debug(`Cache expired for ${phone}`);
        // Delete expired entry
        this.db.prepare('DELETE FROM customer_cache WHERE phone = ?').run(phone);
        return null;
      }

      return JSON.parse(row.data) as Customer;
    } catch (error) {
      console.error('Failed to get cached customer:', error);
      return null;
    }
  }

  /**
   * Invalidate (delete) cache entry by customer ID
   * Scans all cache entries to find matching customer ID
   *
   * @param customerId - Customer ID to invalidate
   */
  public invalidateCustomerById(customerId: string): void {
    try {
      // Get all cache entries
      const rows = this.db.prepare(`
        SELECT phone, data FROM customer_cache
      `).all() as Array<{ phone: string; data: string }>;

      // Find and delete entries matching the customer ID
      let deletedCount = 0;
      for (const row of rows) {
        try {
          const customer = JSON.parse(row.data) as Customer;
          if (customer.id === customerId) {
            this.db.prepare('DELETE FROM customer_cache WHERE phone = ?').run(row.phone);
            deletedCount++;
            console.debug(`Invalidated cache for customer ${customerId} (phone: ${row.phone})`);
          }
        } catch (parseError) {
          console.warn(`Failed to parse cached customer data for phone ${row.phone}:`, parseError);
        }
      }

      if (deletedCount === 0) {
        console.debug(`No cache entries found for customer ${customerId}`);
      }
    } catch (error) {
      console.error('Failed to invalidate customer cache by ID:', error);
    }
  }

  /**
   * Invalidate (delete) cache entry by phone number
   *
   * @param phone - Phone number to invalidate
   */
  public invalidateCustomer(phone: string): void {
    try {
      const result = this.db.prepare('DELETE FROM customer_cache WHERE phone = ?').run(phone);
      if (result.changes > 0) {
        console.debug(`Invalidated cache for customer ${phone}`);
      }
    } catch (error) {
      console.error('Failed to invalidate customer cache:', error);
    }
  }

  /**
   * Update cached customer with refreshed TTL
   * Alias for cacheCustomer for clarity
   *
   * @param customer - Customer object to update in cache
   */
  public updateCachedCustomer(customer: Customer): void {
    this.cacheCustomer(customer);
  }

  /**
   * Clear all expired cache entries
   * 
   * Should be called periodically (e.g., on app startup, daily)
   */
  public clearExpiredCache(): void {
    const now = new Date().toISOString();

    try {
      const result = this.db.prepare(`
        DELETE FROM customer_cache
        WHERE expires_at < ?
      `).run(now);

      console.info(`Cleared ${result.changes} expired cache entries`);
    } catch (error) {
      console.error('Failed to clear expired cache:', error);
    }
  }

  /**
   * Clear all cache entries (for testing/debugging)
   */
  public clearAllCache(): void {
    try {
      const result = this.db.prepare('DELETE FROM customer_cache').run();
      console.info(`Cleared all cache entries (${result.changes} rows)`);
    } catch (error) {
      console.error('Failed to clear cache:', error);
    }
  }

  /**
   * Get cache statistics
   *
   * @returns Object with total, expired, valid counts and timestamps
   */
  public getCacheStats(): {
    total: number;
    expired: number;
    valid: number;
    oldestEntry?: string;
    newestEntry?: string;
  } {
    const now = new Date().toISOString();

    try {
      const total = this.db.prepare('SELECT COUNT(*) as count FROM customer_cache')
        .get() as { count: number };

      const expired = this.db.prepare('SELECT COUNT(*) as count FROM customer_cache WHERE expires_at < ?')
        .get(now) as { count: number };

      const oldest = this.db.prepare('SELECT MIN(created_at) as oldest FROM customer_cache')
        .get() as { oldest: string | null };

      const newest = this.db.prepare('SELECT MAX(created_at) as newest FROM customer_cache')
        .get() as { newest: string | null };

      return {
        total: total.count,
        expired: expired.count,
        valid: total.count - expired.count,
        oldestEntry: oldest.oldest || undefined,
        newestEntry: newest.newest || undefined,
      };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return { total: 0, expired: 0, valid: 0 };
    }
  }
}

