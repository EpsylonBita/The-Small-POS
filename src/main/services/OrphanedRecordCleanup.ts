import Database from 'better-sqlite3';
import { DataIntegrityService, IntegrityReport, OrphanedRecord } from './DataIntegrityService';

/**
 * OrphanedRecordCleanup - Automated cleanup of orphaned records
 *
 * This service runs periodically to clean up orphaned records that result from:
 * - Cascade delete failures (when FKs are disabled)
 * - Sync timing issues between local and Supabase data
 * - Application bugs that leave dangling references
 *
 * The service is conservative by default - it logs issues but only cleans up
 * records that are clearly orphaned and safe to delete.
 */

export interface CleanupResult {
  timestamp: string;
  recordsCleaned: number;
  cleanupDetails: CleanupDetail[];
  errors: CleanupError[];
  skipped: SkippedRecord[];
}

export interface CleanupDetail {
  table: string;
  recordId: string;
  reason: string;
}

export interface CleanupError {
  table: string;
  recordId: string;
  error: string;
}

export interface SkippedRecord {
  table: string;
  recordId: string;
  reason: string;
}

export interface CleanupConfig {
  /** Delete payment_transactions without valid order */
  cleanupOrphanedPayments: boolean;
  /** Delete payment_receipts without valid transaction */
  cleanupOrphanedReceipts: boolean;
  /** Delete payment_refunds without valid transaction */
  cleanupOrphanedRefunds: boolean;
  /** Delete driver_earnings without valid order */
  cleanupOrphanedDriverEarnings: boolean;
  /** Delete shift_expenses without valid staff_shift */
  cleanupOrphanedShiftExpenses: boolean;
  /** Delete staff_payments without valid staff_shift references */
  cleanupOrphanedStaffPayments: boolean;
  /** Delete cash_drawer_sessions without valid staff_shift */
  cleanupOrphanedCashDrawers: boolean;
  /** Delete sync_queue entries older than N days with > 10 attempts */
  cleanupStaleSyncEntries: boolean;
  /** Maximum age in days for stale sync entries */
  staleSyncMaxAgeDays: number;
  /** Dry run - log actions without actually deleting */
  dryRun: boolean;
}

const DEFAULT_CONFIG: CleanupConfig = {
  cleanupOrphanedPayments: true,
  cleanupOrphanedReceipts: true,
  cleanupOrphanedRefunds: true,
  cleanupOrphanedDriverEarnings: true,
  cleanupOrphanedShiftExpenses: true,
  cleanupOrphanedStaffPayments: true,
  cleanupOrphanedCashDrawers: true,
  cleanupStaleSyncEntries: true,
  staleSyncMaxAgeDays: 7,
  dryRun: false
};

export class OrphanedRecordCleanup {
  private db: Database.Database;
  private integrityService: DataIntegrityService;
  private config: CleanupConfig;

  constructor(db: Database.Database, config: Partial<CleanupConfig> = {}) {
    this.db = db;
    this.integrityService = new DataIntegrityService(db);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Update cleanup configuration
   */
  setConfig(config: Partial<CleanupConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): CleanupConfig {
    return { ...this.config };
  }

  /**
   * Run cleanup based on current configuration
   * Returns detailed report of what was cleaned up
   */
  runCleanup(): CleanupResult {
    const result: CleanupResult = {
      timestamp: new Date().toISOString(),
      recordsCleaned: 0,
      cleanupDetails: [],
      errors: [],
      skipped: []
    };

    console.log(`[OrphanedRecordCleanup] Starting cleanup at ${result.timestamp}`);
    console.log(`[OrphanedRecordCleanup] Dry run mode: ${this.config.dryRun}`);

    // Run each cleanup task
    if (this.config.cleanupOrphanedPayments) {
      this.cleanupOrphanedPaymentTransactions(result);
    }

    if (this.config.cleanupOrphanedReceipts) {
      this.cleanupOrphanedPaymentReceipts(result);
    }

    if (this.config.cleanupOrphanedRefunds) {
      this.cleanupOrphanedPaymentRefunds(result);
    }

    if (this.config.cleanupOrphanedDriverEarnings) {
      this.cleanupOrphanedDriverEarnings(result);
    }

    if (this.config.cleanupOrphanedShiftExpenses) {
      this.cleanupOrphanedShiftExpenses(result);
    }

    if (this.config.cleanupOrphanedStaffPayments) {
      this.cleanupOrphanedStaffPayments(result);
    }

    if (this.config.cleanupOrphanedCashDrawers) {
      this.cleanupOrphanedCashDrawerSessions(result);
    }

    if (this.config.cleanupStaleSyncEntries) {
      this.cleanupStaleSyncQueueEntries(result);
    }

    console.log(`[OrphanedRecordCleanup] Cleanup complete. ${result.recordsCleaned} records cleaned, ${result.errors.length} errors, ${result.skipped.length} skipped`);

    return result;
  }

  /**
   * Run integrity check without cleanup
   * Useful for reporting without taking action
   */
  runIntegrityCheck(): IntegrityReport {
    return this.integrityService.findOrphanedRecords();
  }

  // ============================================================================
  // CLEANUP METHODS
  // ============================================================================

  private cleanupOrphanedPaymentTransactions(result: CleanupResult): void {
    try {
      const orphaned = this.db.prepare(`
        SELECT pt.id, pt.order_id
        FROM payment_transactions pt
        LEFT JOIN orders o ON pt.order_id = o.id
        WHERE o.id IS NULL
      `).all() as Array<{ id: string; order_id: string }>;

      for (const record of orphaned) {
        try {
          if (!this.config.dryRun) {
            this.db.prepare('DELETE FROM payment_transactions WHERE id = ?').run(record.id);
          }
          result.cleanupDetails.push({
            table: 'payment_transactions',
            recordId: record.id,
            reason: `Order ${record.order_id} does not exist`
          });
          result.recordsCleaned++;
        } catch (error) {
          result.errors.push({
            table: 'payment_transactions',
            recordId: record.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      console.log(`[OrphanedRecordCleanup] payment_transactions: ${orphaned.length} orphaned records ${this.config.dryRun ? 'found' : 'cleaned'}`);
    } catch (error) {
      console.error('[OrphanedRecordCleanup] Error checking payment_transactions:', error);
    }
  }

  private cleanupOrphanedPaymentReceipts(result: CleanupResult): void {
    try {
      const orphaned = this.db.prepare(`
        SELECT pr.id, pr.transaction_id
        FROM payment_receipts pr
        LEFT JOIN payment_transactions pt ON pr.transaction_id = pt.id
        WHERE pt.id IS NULL
      `).all() as Array<{ id: string; transaction_id: string }>;

      for (const record of orphaned) {
        try {
          if (!this.config.dryRun) {
            this.db.prepare('DELETE FROM payment_receipts WHERE id = ?').run(record.id);
          }
          result.cleanupDetails.push({
            table: 'payment_receipts',
            recordId: record.id,
            reason: `Transaction ${record.transaction_id} does not exist`
          });
          result.recordsCleaned++;
        } catch (error) {
          result.errors.push({
            table: 'payment_receipts',
            recordId: record.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      console.log(`[OrphanedRecordCleanup] payment_receipts: ${orphaned.length} orphaned records ${this.config.dryRun ? 'found' : 'cleaned'}`);
    } catch (error) {
      console.error('[OrphanedRecordCleanup] Error checking payment_receipts:', error);
    }
  }

  private cleanupOrphanedPaymentRefunds(result: CleanupResult): void {
    try {
      const orphaned = this.db.prepare(`
        SELECT pr.id, pr.transaction_id
        FROM payment_refunds pr
        LEFT JOIN payment_transactions pt ON pr.transaction_id = pt.id
        WHERE pt.id IS NULL
      `).all() as Array<{ id: string; transaction_id: string }>;

      for (const record of orphaned) {
        try {
          if (!this.config.dryRun) {
            this.db.prepare('DELETE FROM payment_refunds WHERE id = ?').run(record.id);
          }
          result.cleanupDetails.push({
            table: 'payment_refunds',
            recordId: record.id,
            reason: `Transaction ${record.transaction_id} does not exist`
          });
          result.recordsCleaned++;
        } catch (error) {
          result.errors.push({
            table: 'payment_refunds',
            recordId: record.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      console.log(`[OrphanedRecordCleanup] payment_refunds: ${orphaned.length} orphaned records ${this.config.dryRun ? 'found' : 'cleaned'}`);
    } catch (error) {
      console.error('[OrphanedRecordCleanup] Error checking payment_refunds:', error);
    }
  }

  private cleanupOrphanedDriverEarnings(result: CleanupResult): void {
    try {
      // Clean up driver_earnings with non-existent orders
      const orphanedOrders = this.db.prepare(`
        SELECT de.id, de.order_id
        FROM driver_earnings de
        LEFT JOIN orders o ON de.order_id = o.id
        WHERE o.id IS NULL
      `).all() as Array<{ id: string; order_id: string }>;

      for (const record of orphanedOrders) {
        try {
          if (!this.config.dryRun) {
            this.db.prepare('DELETE FROM driver_earnings WHERE id = ?').run(record.id);
          }
          result.cleanupDetails.push({
            table: 'driver_earnings',
            recordId: record.id,
            reason: `Order ${record.order_id} does not exist`
          });
          result.recordsCleaned++;
        } catch (error) {
          result.errors.push({
            table: 'driver_earnings',
            recordId: record.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Clean up driver_earnings with non-existent staff_shifts (when not null)
      const orphanedShifts = this.db.prepare(`
        SELECT de.id, de.staff_shift_id
        FROM driver_earnings de
        LEFT JOIN staff_shifts ss ON de.staff_shift_id = ss.id
        WHERE de.staff_shift_id IS NOT NULL AND ss.id IS NULL
      `).all() as Array<{ id: string; staff_shift_id: string }>;

      for (const record of orphanedShifts) {
        // For shift references, we just null out the reference rather than delete
        try {
          if (!this.config.dryRun) {
            this.db.prepare('UPDATE driver_earnings SET staff_shift_id = NULL WHERE id = ?').run(record.id);
          }
          result.cleanupDetails.push({
            table: 'driver_earnings',
            recordId: record.id,
            reason: `Nullified staff_shift_id - shift ${record.staff_shift_id} does not exist`
          });
          result.recordsCleaned++;
        } catch (error) {
          result.errors.push({
            table: 'driver_earnings',
            recordId: record.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      console.log(`[OrphanedRecordCleanup] driver_earnings: ${orphanedOrders.length + orphanedShifts.length} orphaned records ${this.config.dryRun ? 'found' : 'cleaned'}`);
    } catch (error) {
      console.error('[OrphanedRecordCleanup] Error checking driver_earnings:', error);
    }
  }

  private cleanupOrphanedShiftExpenses(result: CleanupResult): void {
    try {
      const orphaned = this.db.prepare(`
        SELECT se.id, se.staff_shift_id
        FROM shift_expenses se
        LEFT JOIN staff_shifts ss ON se.staff_shift_id = ss.id
        WHERE ss.id IS NULL
      `).all() as Array<{ id: string; staff_shift_id: string }>;

      for (const record of orphaned) {
        try {
          if (!this.config.dryRun) {
            this.db.prepare('DELETE FROM shift_expenses WHERE id = ?').run(record.id);
          }
          result.cleanupDetails.push({
            table: 'shift_expenses',
            recordId: record.id,
            reason: `Staff shift ${record.staff_shift_id} does not exist`
          });
          result.recordsCleaned++;
        } catch (error) {
          result.errors.push({
            table: 'shift_expenses',
            recordId: record.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      console.log(`[OrphanedRecordCleanup] shift_expenses: ${orphaned.length} orphaned records ${this.config.dryRun ? 'found' : 'cleaned'}`);
    } catch (error) {
      console.error('[OrphanedRecordCleanup] Error checking shift_expenses:', error);
    }
  }

  private cleanupOrphanedStaffPayments(result: CleanupResult): void {
    try {
      // Check for orphaned paid_by_cashier_shift_id (required field)
      const orphanedCashier = this.db.prepare(`
        SELECT sp.id, sp.paid_by_cashier_shift_id
        FROM staff_payments sp
        LEFT JOIN staff_shifts ss ON sp.paid_by_cashier_shift_id = ss.id
        WHERE ss.id IS NULL
      `).all() as Array<{ id: string; paid_by_cashier_shift_id: string }>;

      for (const record of orphanedCashier) {
        try {
          if (!this.config.dryRun) {
            this.db.prepare('DELETE FROM staff_payments WHERE id = ?').run(record.id);
          }
          result.cleanupDetails.push({
            table: 'staff_payments',
            recordId: record.id,
            reason: `Cashier shift ${record.paid_by_cashier_shift_id} does not exist`
          });
          result.recordsCleaned++;
        } catch (error) {
          result.errors.push({
            table: 'staff_payments',
            recordId: record.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Check for orphaned staff_shift_id (optional field - just nullify)
      const orphanedShift = this.db.prepare(`
        SELECT sp.id, sp.staff_shift_id
        FROM staff_payments sp
        LEFT JOIN staff_shifts ss ON sp.staff_shift_id = ss.id
        WHERE sp.staff_shift_id IS NOT NULL AND ss.id IS NULL
      `).all() as Array<{ id: string; staff_shift_id: string }>;

      for (const record of orphanedShift) {
        try {
          if (!this.config.dryRun) {
            this.db.prepare('UPDATE staff_payments SET staff_shift_id = NULL WHERE id = ?').run(record.id);
          }
          result.cleanupDetails.push({
            table: 'staff_payments',
            recordId: record.id,
            reason: `Nullified staff_shift_id - shift ${record.staff_shift_id} does not exist`
          });
          result.recordsCleaned++;
        } catch (error) {
          result.errors.push({
            table: 'staff_payments',
            recordId: record.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      console.log(`[OrphanedRecordCleanup] staff_payments: ${orphanedCashier.length + orphanedShift.length} orphaned records ${this.config.dryRun ? 'found' : 'cleaned'}`);
    } catch (error) {
      console.error('[OrphanedRecordCleanup] Error checking staff_payments:', error);
    }
  }

  private cleanupOrphanedCashDrawerSessions(result: CleanupResult): void {
    try {
      const orphaned = this.db.prepare(`
        SELECT cds.id, cds.staff_shift_id
        FROM cash_drawer_sessions cds
        LEFT JOIN staff_shifts ss ON cds.staff_shift_id = ss.id
        WHERE ss.id IS NULL
      `).all() as Array<{ id: string; staff_shift_id: string }>;

      for (const record of orphaned) {
        try {
          if (!this.config.dryRun) {
            this.db.prepare('DELETE FROM cash_drawer_sessions WHERE id = ?').run(record.id);
          }
          result.cleanupDetails.push({
            table: 'cash_drawer_sessions',
            recordId: record.id,
            reason: `Staff shift ${record.staff_shift_id} does not exist`
          });
          result.recordsCleaned++;
        } catch (error) {
          result.errors.push({
            table: 'cash_drawer_sessions',
            recordId: record.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      console.log(`[OrphanedRecordCleanup] cash_drawer_sessions: ${orphaned.length} orphaned records ${this.config.dryRun ? 'found' : 'cleaned'}`);
    } catch (error) {
      console.error('[OrphanedRecordCleanup] Error checking cash_drawer_sessions:', error);
    }
  }

  private cleanupStaleSyncQueueEntries(result: CleanupResult): void {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.staleSyncMaxAgeDays);

      const staleEntries = this.db.prepare(`
        SELECT id, table_name, record_id, attempts, created_at, error_message
        FROM sync_queue
        WHERE attempts > 10
          AND created_at < ?
      `).all(cutoffDate.toISOString()) as Array<{
        id: string;
        table_name: string;
        record_id: string;
        attempts: number;
        created_at: string;
        error_message: string | null;
      }>;

      for (const entry of staleEntries) {
        try {
          if (!this.config.dryRun) {
            this.db.prepare('DELETE FROM sync_queue WHERE id = ?').run(entry.id);
          }
          result.cleanupDetails.push({
            table: 'sync_queue',
            recordId: entry.id,
            reason: `Stale entry: ${entry.attempts} attempts, created ${entry.created_at}. Last error: ${entry.error_message || 'unknown'}`
          });
          result.recordsCleaned++;
        } catch (error) {
          result.errors.push({
            table: 'sync_queue',
            recordId: entry.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      console.log(`[OrphanedRecordCleanup] sync_queue: ${staleEntries.length} stale entries ${this.config.dryRun ? 'found' : 'cleaned'}`);
    } catch (error) {
      console.error('[OrphanedRecordCleanup] Error checking sync_queue:', error);
    }
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Run cleanup before enabling foreign keys
   * This ensures the database is in a clean state before FK enforcement
   */
  prepareForForeignKeyEnablement(): CleanupResult {
    console.log('[OrphanedRecordCleanup] Preparing database for FK enablement...');

    // Run with all cleanup options enabled
    const fullConfig: CleanupConfig = {
      cleanupOrphanedPayments: true,
      cleanupOrphanedReceipts: true,
      cleanupOrphanedRefunds: true,
      cleanupOrphanedDriverEarnings: true,
      cleanupOrphanedShiftExpenses: true,
      cleanupOrphanedStaffPayments: true,
      cleanupOrphanedCashDrawers: true,
      cleanupStaleSyncEntries: true,
      staleSyncMaxAgeDays: 30,
      dryRun: false
    };

    const originalConfig = this.config;
    this.config = fullConfig;

    try {
      const result = this.runCleanup();
      console.log('[OrphanedRecordCleanup] Database prepared for FK enablement');
      return result;
    } finally {
      this.config = originalConfig;
    }
  }

  /**
   * Get summary statistics about orphaned records
   */
  getOrphanedRecordSummary(): Record<string, number> {
    const summary: Record<string, number> = {};

    const queries = [
      {
        name: 'payment_transactions_orphaned',
        query: `
          SELECT COUNT(*) as count
          FROM payment_transactions pt
          LEFT JOIN orders o ON pt.order_id = o.id
          WHERE o.id IS NULL
        `
      },
      {
        name: 'payment_receipts_orphaned',
        query: `
          SELECT COUNT(*) as count
          FROM payment_receipts pr
          LEFT JOIN payment_transactions pt ON pr.transaction_id = pt.id
          WHERE pt.id IS NULL
        `
      },
      {
        name: 'payment_refunds_orphaned',
        query: `
          SELECT COUNT(*) as count
          FROM payment_refunds pr
          LEFT JOIN payment_transactions pt ON pr.transaction_id = pt.id
          WHERE pt.id IS NULL
        `
      },
      {
        name: 'driver_earnings_orphaned_orders',
        query: `
          SELECT COUNT(*) as count
          FROM driver_earnings de
          LEFT JOIN orders o ON de.order_id = o.id
          WHERE o.id IS NULL
        `
      },
      {
        name: 'driver_earnings_orphaned_shifts',
        query: `
          SELECT COUNT(*) as count
          FROM driver_earnings de
          LEFT JOIN staff_shifts ss ON de.staff_shift_id = ss.id
          WHERE de.staff_shift_id IS NOT NULL AND ss.id IS NULL
        `
      },
      {
        name: 'shift_expenses_orphaned',
        query: `
          SELECT COUNT(*) as count
          FROM shift_expenses se
          LEFT JOIN staff_shifts ss ON se.staff_shift_id = ss.id
          WHERE ss.id IS NULL
        `
      },
      {
        name: 'staff_payments_orphaned',
        query: `
          SELECT COUNT(*) as count
          FROM staff_payments sp
          LEFT JOIN staff_shifts ss ON sp.paid_by_cashier_shift_id = ss.id
          WHERE ss.id IS NULL
        `
      },
      {
        name: 'cash_drawer_sessions_orphaned',
        query: `
          SELECT COUNT(*) as count
          FROM cash_drawer_sessions cds
          LEFT JOIN staff_shifts ss ON cds.staff_shift_id = ss.id
          WHERE ss.id IS NULL
        `
      },
      {
        name: 'sync_queue_stale',
        query: `
          SELECT COUNT(*) as count
          FROM sync_queue
          WHERE attempts > 10
            AND created_at < datetime('now', '-7 days')
        `
      }
    ];

    for (const { name, query } of queries) {
      try {
        const result = this.db.prepare(query).get() as { count: number };
        summary[name] = result.count;
      } catch (error) {
        summary[name] = -1; // Error indicator
      }
    }

    return summary;
  }
}
