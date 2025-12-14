import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export abstract class BaseService {
  protected db: Database.Database;

  constructor(database: Database.Database) {
    this.db = database;
  }

  protected generateId(): string {
    // Use RFC4122 UUIDs so sync to Supabase (UUID PKs) works reliably
    return randomUUID();
  }

  protected getCurrentTimestamp(): string {
    return new Date().toISOString();
  }

  protected validateRequired(data: any, requiredFields: string[]): void {
    for (const field of requiredFields) {
      if (data == null || data[field] === undefined || data[field] === null) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
  }

  protected executeTransaction<T>(callback: () => T): T {
    const transaction = this.db.transaction(callback);
    return transaction();
  }

  /**
   * Get the database instance
   * Used by services that need direct database access
   */
  protected getDatabase(): Database.Database {
    return this.db;
  }

  /**
   * Calculate expiry time based on hours from now
   * @param hours - Number of hours until expiry
   * @returns ISO timestamp for expiry
   */
  protected calculateExpiryTime(hours: number): string {
    const now = new Date();
    now.setHours(now.getHours() + hours);
    return now.toISOString();
  }

  /**
   * Check if a timestamp is expired
   * @param expiresAt - ISO timestamp to check
   * @returns true if expired
   */
  protected isCacheExpired(expiresAt: string): boolean {
    return new Date(expiresAt) < new Date();
  }

  /**
   * Queue a record for syncing with the server
   */
  protected addToSyncQueue(
    tableName: string,
    recordId: string,
    operation: 'insert' | 'update' | 'delete',
    data: Record<string, unknown>
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO sync_queue (id, table_name, record_id, operation, data, created_at, attempts)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `);
    stmt.run(
      this.generateId(),
      tableName,
      recordId,
      operation,
      JSON.stringify(data ?? {}),
      this.getCurrentTimestamp()
    );
  }
}
