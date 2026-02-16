import Database from 'better-sqlite3';
import { BaseService } from './BaseService';

// Database row interfaces
interface SyncQueueRow {
  id: string;
  table_name: string;
  record_id: string;
  operation: 'insert' | 'update' | 'delete';
  data: string; // JSON string
  created_at: string;
  attempts: number;
  last_attempt?: string;
  error_message?: string;
  next_retry_at?: string;
  retry_delay_ms?: number;
  has_conflict?: number;
  conflict_id?: string;
  count?: number; // For COUNT(*) queries
}

interface SyncStatsRow {
  count: number;
}

interface SyncFilter {
  tableName?: string;
  recordId?: string;
  operation?: string;
  maxAttempts?: number;
}

export interface SyncQueue {
  id: string;
  table_name: string;
  record_id: string;
  operation: 'insert' | 'update' | 'delete';
  data: string; // JSON string
  created_at: string;
  attempts: number;
  last_attempt?: string;
  error_message?: string;
  next_retry_at?: string;
  retry_delay_ms?: number;
  has_conflict?: number;
  conflict_id?: string;
}

export interface SyncResult {
  success: boolean;
  processed: number;
  failed: number;
  errors: string[];
}

export class SyncQueueService extends BaseService {
  private maxRetries = 5; // Increased from 3
  private initialDelay = 5000; // 5 seconds
  private maxDelay = 300000; // 5 minutes
  private backoffMultiplier = 2;

  constructor(database: Database.Database) {
    super(database);
  }

  addToSyncQueue(
    tableName: string,
    recordId: string,
    operation: 'insert' | 'update' | 'delete',
    data: Record<string, unknown>
  ): void {
    this.executeTransaction(() => {
      // Normalize operation to satisfy CHECK constraint (defensive against upstream callers)
      const op = (operation as unknown as string).toLowerCase() as 'insert' | 'update' | 'delete';
      if (op !== 'insert' && op !== 'update' && op !== 'delete') {
        console.warn('SyncQueueService.addToSyncQueue: invalid operation received, coercing to insert:', operation);
      }
      const normalizedOp = (op === 'insert' || op === 'update' || op === 'delete') ? op : 'insert';

      const queueItem: SyncQueue = {
        id: this.generateId(),
        table_name: tableName,
        record_id: recordId,
        operation: normalizedOp,
        data: JSON.stringify(data),
        created_at: this.getCurrentTimestamp(),
        attempts: 0,
        retry_delay_ms: this.initialDelay,
        next_retry_at: this.getCurrentTimestamp()
      };

      const stmt = this.db.prepare(`
        INSERT INTO sync_queue (
          id, table_name, record_id, operation, data, created_at, attempts, retry_delay_ms, next_retry_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        queueItem.id, queueItem.table_name, queueItem.record_id,
        queueItem.operation, queueItem.data, queueItem.created_at,
        queueItem.attempts, queueItem.retry_delay_ms, queueItem.next_retry_at
      );
    });
  }

  getPendingSyncItems(limit: number = 50): SyncQueue[] {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT * FROM sync_queue
      WHERE attempts < ?
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
        AND (has_conflict = 0 OR has_conflict IS NULL)
      ORDER BY next_retry_at ASC, created_at ASC
      LIMIT ?
    `);

    const rows = stmt.all(this.maxRetries, now, limit) as SyncQueueRow[];

    return rows.map(row => this.mapRowToSyncItem(row));
  }

  markSyncSuccess(syncId: string): void {
    this.executeTransaction(() => {
      const stmt = this.db.prepare('DELETE FROM sync_queue WHERE id = ?');
      stmt.run(syncId);
    });
  }

  markSyncFailed(syncId: string, errorMessage: string): void {
    this.executeTransaction(() => {
      // Get current item to calculate next retry
      const getStmt = this.db.prepare('SELECT * FROM sync_queue WHERE id = ?');
      const item = getStmt.get(syncId) as SyncQueueRow | undefined;

      if (!item) return;

      // For transient API backpressure/rate-limit errors, defer retry without consuming retry attempts.
      if (this.isTransientBackpressureError(errorMessage)) {
        const retryDelay = this.extractRetryAfterMs(errorMessage) ?? Math.max(item.retry_delay_ms || this.initialDelay, this.initialDelay);
        const clampedDelay = Math.min(Math.max(retryDelay, this.initialDelay), this.maxDelay);
        const jitteredDelay = this.applyDeterministicJitter(clampedDelay, item.id || syncId);
        const finalDelay = Math.min(Math.max(jitteredDelay, this.initialDelay), this.maxDelay);
        const nextRetryAt = new Date(Date.now() + finalDelay).toISOString();

        const stmt = this.db.prepare(`
          UPDATE sync_queue SET
            last_attempt = ?,
            error_message = ?,
            retry_delay_ms = ?,
            next_retry_at = ?
          WHERE id = ?
        `);

        stmt.run(this.getCurrentTimestamp(), errorMessage, finalDelay, nextRetryAt, syncId);
        return;
      }

      const attempts = item.attempts + 1;
      const currentDelay = item.retry_delay_ms || this.initialDelay;
      const nextDelay = Math.min(currentDelay * this.backoffMultiplier, this.maxDelay);
      const nextRetryAt = new Date(Date.now() + nextDelay).toISOString();

      const stmt = this.db.prepare(`
        UPDATE sync_queue SET
          attempts = ?,
          last_attempt = ?,
          error_message = ?,
          retry_delay_ms = ?,
          next_retry_at = ?
        WHERE id = ?
      `);

      stmt.run(attempts, this.getCurrentTimestamp(), errorMessage, nextDelay, nextRetryAt, syncId);
    });
  }

  private isTransientBackpressureError(errorMessage: string): boolean {
    const message = (errorMessage || '').toLowerCase();
    return (
      /api error\s*\(429\)/i.test(message) ||
      /queue is backed up/i.test(message) ||
      /retry_after_seconds/i.test(message) ||
      /too many requests/i.test(message) ||
      /rate limit/i.test(message)
    );
  }

  private extractRetryAfterMs(errorMessage: string): number | null {
    const message = errorMessage || '';

    const retryAfterMatch = message.match(/retry_after_seconds["']?\s*[:=]\s*(\d+(?:\.\d+)?)/i);
    if (retryAfterMatch?.[1]) {
      const seconds = Number.parseFloat(retryAfterMatch[1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.ceil(seconds * 1000);
      }
    }

    const bracketStart = message.indexOf('{');
    const bracketEnd = message.lastIndexOf('}');
    if (bracketStart >= 0 && bracketEnd > bracketStart) {
      const jsonCandidate = message.slice(bracketStart, bracketEnd + 1);
      try {
        const parsed = JSON.parse(jsonCandidate) as { retry_after_seconds?: unknown };
        const raw = parsed.retry_after_seconds;
        const seconds = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
        if (Number.isFinite(seconds) && seconds > 0) {
          return Math.ceil(seconds * 1000);
        }
      } catch {
        // Ignore parse failures and fall through.
      }
    }

    return null;
  }

  private applyDeterministicJitter(delayMs: number, seed: string): number {
    if (!seed) return delayMs;

    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }

    // Spread retries by +/-15% in a deterministic way per sync item.
    const normalized = ((Math.abs(hash) % 31) - 15) / 100;
    return Math.round(delayMs * (1 + normalized));
  }

  getFailedSyncItems(): SyncQueue[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_queue
      WHERE attempts >= ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(this.maxRetries) as SyncQueueRow[];

    return rows.map(row => this.mapRowToSyncItem(row));
  }

  retrySyncItem(syncId: string): void {
    this.executeTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE sync_queue SET
          attempts = 0,
          error_message = NULL
        WHERE id = ?
      `);

      stmt.run(syncId);
    });
  }

  retryAllFailedSyncs(): void {
    this.executeTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE sync_queue SET
          attempts = 0,
          error_message = NULL
        WHERE attempts >= ?
      `);

      stmt.run(this.maxRetries);
    });
  }

  clearSyncQueue(): void {
    this.executeTransaction(() => {
      const stmt = this.db.prepare('DELETE FROM sync_queue');
      stmt.run();
    });
  }

  getSyncStats(): {
    pending: number;
    failed: number;
    total: number;
    scheduled_retries: number;
    conflicts: number;
  } {
    const now = new Date().toISOString();

    const pendingStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM sync_queue WHERE attempts < ?
    `);
    const pending = (pendingStmt.get(this.maxRetries) as SyncStatsRow).count;

    const failedStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM sync_queue WHERE attempts >= ?
    `);
    const failed = (failedStmt.get(this.maxRetries) as SyncStatsRow).count;

    const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM sync_queue');
    const total = (totalStmt.get() as SyncStatsRow).count;

    const scheduledRetriesStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM sync_queue
      WHERE next_retry_at > ? AND attempts < ?
    `);
    const scheduled_retries = (scheduledRetriesStmt.get(now, this.maxRetries) as SyncStatsRow).count;

    const conflictsStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM sync_queue WHERE has_conflict = 1
    `);
    const conflicts = (conflictsStmt.get() as SyncStatsRow).count;

    return { pending, failed, total, scheduled_retries, conflicts };
  }

  getTableSyncStats(tableName: string): {
    pending: number;
    failed: number;
  } {
    const pendingStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM sync_queue
      WHERE table_name = ? AND attempts < ?
    `);
    const pending = (pendingStmt.get(tableName, this.maxRetries) as SyncStatsRow).count;

    const failedStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM sync_queue
      WHERE table_name = ? AND attempts >= ?
    `);
    const failed = (failedStmt.get(tableName, this.maxRetries) as SyncStatsRow).count;

    return { pending, failed };
  }

  getFinancialSyncStats(): {
    driver_earnings: { pending: number, failed: number };
    staff_payments: { pending: number, failed: number };
    shift_expenses: { pending: number, failed: number };
  } {
    return this.executeTransaction(() => {
      const result = {
        driver_earnings: { pending: 0, failed: 0 },
        staff_payments: { pending: 0, failed: 0 },
        shift_expenses: { pending: 0, failed: 0 }
      };

      const stmt = this.db.prepare(`
            SELECT table_name,
                   SUM(CASE WHEN attempts < ? THEN 1 ELSE 0 END) as pending,
                   SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END) as failed
            FROM sync_queue
            WHERE table_name IN ('driver_earnings', 'staff_payments', 'shift_expenses')
            GROUP BY table_name
        `);

      const rows = stmt.all(this.maxRetries, this.maxRetries) as any[];

      rows.forEach(row => {
        if (row.table_name === 'driver_earnings') {
          result.driver_earnings.pending = row.pending;
          result.driver_earnings.failed = row.failed;
        } else if (row.table_name === 'staff_payments') {
          result.staff_payments.pending = row.pending;
          result.staff_payments.failed = row.failed;
        } else if (row.table_name === 'shift_expenses') {
          result.shift_expenses.pending = row.pending;
          result.shift_expenses.failed = row.failed;
        }
      });

      return result;
    });
  }

  getFailedFinancialSyncItems(limit: number = 100): SyncQueue[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_queue
      WHERE table_name IN ('driver_earnings', 'staff_payments', 'shift_expenses')
        AND attempts >= ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(this.maxRetries, limit) as SyncQueueRow[];
    return rows.map(row => this.mapRowToSyncItem(row));
  }

  retryFinancialSyncItem(syncId: string): void {
    this.executeTransaction(() => {
      const item = this.getSyncQueueItem(syncId);
      if (item && ['driver_earnings', 'staff_payments', 'shift_expenses'].includes(item.table_name)) {
        this.retrySyncItem(syncId);
      }
    });
  }

  retryAllFailedFinancialSyncs(): void {
    this.executeTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE sync_queue SET
          attempts = 0,
          error_message = NULL
        WHERE table_name IN ('driver_earnings', 'staff_payments', 'shift_expenses')
          AND attempts >= ?
      `);

      stmt.run(this.maxRetries);
    });
  }

  /**
   * Re-queue orphaned financial records that have no supabase_id and no pending sync queue entry.
   * This helps recover from situations where sync failed and the queue item was cleaned up.
   */
  requeueOrphanedFinancialRecords(): number {
    return this.executeTransaction(() => {
      let requeued = 0;
      const tables = ['driver_earnings', 'staff_payments', 'shift_expenses'];

      for (const tableName of tables) {
        // Find records with no supabase_id and no pending sync queue entry
        const orphans = this.db.prepare(`
          SELECT t.* FROM ${tableName} t
          LEFT JOIN sync_queue sq ON sq.record_id = t.id AND sq.table_name = ?
          WHERE (t.supabase_id IS NULL OR t.supabase_id = '')
            AND sq.id IS NULL
        `).all(tableName) as any[];

        for (const record of orphans) {
          const queueId = this.generateId();
          const now = this.getCurrentTimestamp();
          this.db.prepare(`
            INSERT INTO sync_queue (id, table_name, record_id, operation, data, created_at, attempts, retry_delay_ms)
            VALUES (?, ?, ?, 'insert', ?, ?, 0, ?)
          `).run(queueId, tableName, record.id, JSON.stringify(record), now, this.initialDelay);
          requeued++;
        }
      }

      console.log(`[SyncQueueService] Re-queued ${requeued} orphaned financial records`);
      return requeued;
    });
  }

  cleanupOldSyncItems(daysOld: number = 7): number {
    return this.executeTransaction(() => {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);
      const cutoffTimestamp = cutoffDate.toISOString();

      const stmt = this.db.prepare(`
        DELETE FROM sync_queue
        WHERE created_at < ? AND attempts >= ?
      `);

      const result = stmt.run(cutoffTimestamp, this.maxRetries);
      return result.changes;
    });
  }

  getSyncHistory(tableName?: string, limit: number = 100): SyncQueue[] {
    let query = 'SELECT * FROM sync_queue';
    const params: (string | number)[] = [];

    if (tableName) {
      query += ' WHERE table_name = ?';
      params.push(tableName);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as SyncQueueRow[];

    return rows.map(row => this.mapRowToSyncItem(row));
  }

  // Utility method to check if a record has pending sync operations
  hasPendingSync(tableName: string, recordId: string): boolean {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM sync_queue
      WHERE table_name = ? AND record_id = ? AND attempts < ?
    `);

    const result = stmt.get(tableName, recordId, this.maxRetries) as SyncStatsRow | undefined;
    return result ? result.count > 0 : false;
  }

  // Get sync items for a specific record
  getRecordSyncItems(tableName: string, recordId: string): SyncQueue[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_queue
      WHERE table_name = ? AND record_id = ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(tableName, recordId) as SyncQueueRow[];

    return rows.map(row => this.mapRowToSyncItem(row));
  }

  // Remove sync items for a specific record (useful when record is deleted)
  removeSyncItemsForRecord(tableName: string, recordId: string): number {
    return this.executeTransaction(() => {
      const stmt = this.db.prepare(`
        DELETE FROM sync_queue
        WHERE table_name = ? AND record_id = ?
      `);

      const result = stmt.run(tableName, recordId);
      return result.changes;
    });
  }

  // Mark sync item as having a conflict
  markSyncItemAsConflict(id: string, conflictId: string): void {
    this.executeTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE sync_queue
        SET has_conflict = 1, conflict_id = ?
        WHERE id = ?
      `);
      stmt.run(conflictId, id);
    });
  }

  // Get retry info for a record
  getRetryInfo(recordId: string): { nextRetryAt: string; retryDelayMs: number } | null {
    const stmt = this.db.prepare(`
      SELECT next_retry_at, retry_delay_ms
      FROM sync_queue
      WHERE record_id = ? AND has_conflict = 0
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(recordId) as SyncQueueRow | undefined;
    if (!row || !row.next_retry_at || !row.retry_delay_ms) return null;
    return {
      nextRetryAt: row.next_retry_at,
      retryDelayMs: row.retry_delay_ms
    };
  }

  // Get sync queue item by ID
  getSyncQueueItem(id: string): SyncQueue | null {
    const stmt = this.db.prepare('SELECT * FROM sync_queue WHERE id = ?');
    const row = stmt.get(id) as SyncQueueRow | undefined;
    return row ? this.mapRowToSyncItem(row) : null;
  }

  private mapRowToSyncItem(row: SyncQueueRow): SyncQueue {
    return {
      id: row.id,
      table_name: row.table_name,
      record_id: row.record_id,
      operation: row.operation,
      data: row.data,
      created_at: row.created_at,
      attempts: row.attempts,
      last_attempt: row.last_attempt,
      error_message: row.error_message,
      next_retry_at: row.next_retry_at,
      retry_delay_ms: row.retry_delay_ms,
      has_conflict: row.has_conflict,
      conflict_id: row.conflict_id
    };
  }

  /**
   * Clear all items from the sync queue (useful after factory reset or to clear stuck items)
   */
  clearAllSyncQueue(): number {
    return this.executeTransaction(() => {
      const stmt = this.db.prepare('DELETE FROM sync_queue');
      const result = stmt.run();
      console.log(`[SyncQueueService] Cleared ${result.changes} items from sync queue`);
      return result.changes;
    });
  }

  /**
   * Clear failed sync items for specific table types
   */
  clearFailedSyncItems(tableNames?: string[]): number {
    return this.executeTransaction(() => {
      let stmt;
      let result;

      if (tableNames && tableNames.length > 0) {
        const placeholders = tableNames.map(() => '?').join(', ');
        stmt = this.db.prepare(`
          DELETE FROM sync_queue
          WHERE table_name IN (${placeholders})
        `);
        result = stmt.run(...tableNames);
      } else {
        stmt = this.db.prepare('DELETE FROM sync_queue WHERE attempts >= ?');
        result = stmt.run(this.maxRetries);
      }

      console.log(`[SyncQueueService] Cleared ${result.changes} failed items from sync queue`);
      return result.changes;
    });
  }
}
