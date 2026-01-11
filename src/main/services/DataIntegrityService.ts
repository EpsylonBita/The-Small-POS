import Database from 'better-sqlite3';

/**
 * DataIntegrityService - Validates data integrity for SQLite database
 *
 * This service provides validation for references to Supabase-managed tables
 * where foreign key constraints cannot be applied due to data synchronization timing.
 *
 * Strategy:
 * - For local-only table references: Rely on FK constraints
 * - For Supabase-managed references: Application-level validation with graceful degradation
 */

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  message: string;
  value: unknown;
}

export interface ValidationWarning {
  field: string;
  message: string;
  value: unknown;
}

export interface IntegrityReport {
  timestamp: string;
  tablesChecked: string[];
  orphanedRecords: OrphanedRecord[];
  totalOrphaned: number;
  recommendations: string[];
}

export interface OrphanedRecord {
  table: string;
  recordId: string;
  field: string;
  missingReference: string;
  referenceTable: string;
}

export class DataIntegrityService {
  private db: Database.Database;
  private isOnline: boolean = false;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Set online status - affects validation behavior
   * When offline, Supabase reference validation is skipped
   */
  setOnlineStatus(online: boolean): void {
    this.isOnline = online;
  }

  // ============================================================================
  // LOCAL TABLE REFERENCE VALIDATION
  // ============================================================================

  /**
   * Validate that an order exists in the local database
   */
  validateOrderExists(orderId: string): boolean {
    const result = this.db.prepare(
      'SELECT id FROM orders WHERE id = ?'
    ).get(orderId);
    return !!result;
  }

  /**
   * Validate that a staff shift exists in the local database
   */
  validateStaffShiftExists(shiftId: string): boolean {
    const result = this.db.prepare(
      'SELECT id FROM staff_shifts WHERE id = ?'
    ).get(shiftId);
    return !!result;
  }

  /**
   * Validate that a payment transaction exists
   */
  validatePaymentTransactionExists(transactionId: string): boolean {
    const result = this.db.prepare(
      'SELECT id FROM payment_transactions WHERE id = ?'
    ).get(transactionId);
    return !!result;
  }

  // ============================================================================
  // SUPABASE REFERENCE VALIDATION (Best-effort, graceful degradation)
  // ============================================================================

  /**
   * Validate staff ID exists in local cache
   * Returns true if staff exists locally OR if we're offline (graceful degradation)
   */
  validateStaffReference(staffId: string): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: []
    };

    if (!staffId) {
      return result; // Null references are valid
    }

    // Check local staff cache
    const staff = this.db.prepare(
      'SELECT id FROM staff WHERE id = ?'
    ).get(staffId);

    if (!staff) {
      if (this.isOnline) {
        // When online but staff not found, it's a warning (might not be synced yet)
        result.warnings.push({
          field: 'staff_id',
          message: 'Staff reference not found in local cache. May need sync.',
          value: staffId
        });
      }
      // When offline, we allow the reference without validation
      // This is intentional - offline mode must be permissive
    }

    return result;
  }

  /**
   * Validate customer reference in local cache
   */
  validateCustomerReference(customerId: string): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: []
    };

    if (!customerId) {
      return result;
    }

    const customer = this.db.prepare(
      'SELECT id FROM customers WHERE id = ?'
    ).get(customerId);

    if (!customer && this.isOnline) {
      result.warnings.push({
        field: 'customer_id',
        message: 'Customer reference not found in local cache. May need sync.',
        value: customerId
      });
    }

    return result;
  }

  // ============================================================================
  // COMPOSITE VALIDATION
  // ============================================================================

  /**
   * Validate driver earnings record before insert
   */
  validateDriverEarnings(data: {
    driver_id: string;
    staff_shift_id?: string | null;
    order_id: string;
  }): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: []
    };

    // Validate order_id (local table - strict)
    if (!this.validateOrderExists(data.order_id)) {
      result.valid = false;
      result.errors.push({
        field: 'order_id',
        message: 'Referenced order does not exist',
        value: data.order_id
      });
    }

    // Validate staff_shift_id if provided (local table - strict)
    if (data.staff_shift_id && !this.validateStaffShiftExists(data.staff_shift_id)) {
      result.valid = false;
      result.errors.push({
        field: 'staff_shift_id',
        message: 'Referenced staff shift does not exist',
        value: data.staff_shift_id
      });
    }

    // Validate driver_id (Supabase reference - soft validation)
    const staffValidation = this.validateStaffReference(data.driver_id);
    result.warnings.push(...staffValidation.warnings);

    return result;
  }

  /**
   * Validate shift expense record before insert
   */
  validateShiftExpense(data: {
    staff_shift_id: string;
    staff_id: string;
  }): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: []
    };

    // Validate staff_shift_id (local table - strict)
    if (!this.validateStaffShiftExists(data.staff_shift_id)) {
      result.valid = false;
      result.errors.push({
        field: 'staff_shift_id',
        message: 'Referenced staff shift does not exist',
        value: data.staff_shift_id
      });
    }

    // Validate staff_id (Supabase reference - soft validation)
    const staffValidation = this.validateStaffReference(data.staff_id);
    result.warnings.push(...staffValidation.warnings);

    return result;
  }

  /**
   * Validate staff payment record before insert
   */
  validateStaffPayment(data: {
    staff_shift_id?: string | null;
    paid_to_staff_id: string;
    paid_by_cashier_shift_id: string;
  }): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: []
    };

    // Validate staff_shift_id if provided (local table - strict)
    if (data.staff_shift_id && !this.validateStaffShiftExists(data.staff_shift_id)) {
      result.valid = false;
      result.errors.push({
        field: 'staff_shift_id',
        message: 'Referenced staff shift does not exist',
        value: data.staff_shift_id
      });
    }

    // Validate paid_by_cashier_shift_id (local table - strict)
    if (!this.validateStaffShiftExists(data.paid_by_cashier_shift_id)) {
      result.valid = false;
      result.errors.push({
        field: 'paid_by_cashier_shift_id',
        message: 'Referenced cashier shift does not exist',
        value: data.paid_by_cashier_shift_id
      });
    }

    // Validate paid_to_staff_id (Supabase reference - soft validation)
    const staffValidation = this.validateStaffReference(data.paid_to_staff_id);
    result.warnings.push(...staffValidation.warnings);

    return result;
  }

  /**
   * Validate payment transaction before insert
   */
  validatePaymentTransaction(data: {
    order_id: string;
  }): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: []
    };

    // Validate order_id (local table - strict)
    if (!this.validateOrderExists(data.order_id)) {
      result.valid = false;
      result.errors.push({
        field: 'order_id',
        message: 'Referenced order does not exist',
        value: data.order_id
      });
    }

    return result;
  }

  // ============================================================================
  // DATA INTEGRITY CHECKS
  // ============================================================================

  /**
   * Find orphaned records in the database
   * Returns a comprehensive report of data integrity issues
   */
  findOrphanedRecords(): IntegrityReport {
    const orphanedRecords: OrphanedRecord[] = [];
    const tablesChecked: string[] = [];

    // Check payment_transactions -> orders
    tablesChecked.push('payment_transactions');
    const orphanedPayments = this.db.prepare(`
      SELECT pt.id, pt.order_id
      FROM payment_transactions pt
      LEFT JOIN orders o ON pt.order_id = o.id
      WHERE o.id IS NULL
    `).all() as Array<{ id: string; order_id: string }>;

    for (const row of orphanedPayments) {
      orphanedRecords.push({
        table: 'payment_transactions',
        recordId: row.id,
        field: 'order_id',
        missingReference: row.order_id,
        referenceTable: 'orders'
      });
    }

    // Check driver_earnings -> orders
    tablesChecked.push('driver_earnings');
    const orphanedEarnings = this.db.prepare(`
      SELECT de.id, de.order_id
      FROM driver_earnings de
      LEFT JOIN orders o ON de.order_id = o.id
      WHERE o.id IS NULL
    `).all() as Array<{ id: string; order_id: string }>;

    for (const row of orphanedEarnings) {
      orphanedRecords.push({
        table: 'driver_earnings',
        recordId: row.id,
        field: 'order_id',
        missingReference: row.order_id,
        referenceTable: 'orders'
      });
    }

    // Check driver_earnings -> staff_shifts (nullable, but check for invalid refs)
    const orphanedEarningsShifts = this.db.prepare(`
      SELECT de.id, de.staff_shift_id
      FROM driver_earnings de
      LEFT JOIN staff_shifts ss ON de.staff_shift_id = ss.id
      WHERE de.staff_shift_id IS NOT NULL AND ss.id IS NULL
    `).all() as Array<{ id: string; staff_shift_id: string }>;

    for (const row of orphanedEarningsShifts) {
      orphanedRecords.push({
        table: 'driver_earnings',
        recordId: row.id,
        field: 'staff_shift_id',
        missingReference: row.staff_shift_id,
        referenceTable: 'staff_shifts'
      });
    }

    // Check shift_expenses -> staff_shifts
    tablesChecked.push('shift_expenses');
    const orphanedExpenses = this.db.prepare(`
      SELECT se.id, se.staff_shift_id
      FROM shift_expenses se
      LEFT JOIN staff_shifts ss ON se.staff_shift_id = ss.id
      WHERE ss.id IS NULL
    `).all() as Array<{ id: string; staff_shift_id: string }>;

    for (const row of orphanedExpenses) {
      orphanedRecords.push({
        table: 'shift_expenses',
        recordId: row.id,
        field: 'staff_shift_id',
        missingReference: row.staff_shift_id,
        referenceTable: 'staff_shifts'
      });
    }

    // Check staff_payments -> staff_shifts
    tablesChecked.push('staff_payments');
    const orphanedPaymentsShift = this.db.prepare(`
      SELECT sp.id, sp.staff_shift_id
      FROM staff_payments sp
      LEFT JOIN staff_shifts ss ON sp.staff_shift_id = ss.id
      WHERE sp.staff_shift_id IS NOT NULL AND ss.id IS NULL
    `).all() as Array<{ id: string; staff_shift_id: string }>;

    for (const row of orphanedPaymentsShift) {
      orphanedRecords.push({
        table: 'staff_payments',
        recordId: row.id,
        field: 'staff_shift_id',
        missingReference: row.staff_shift_id,
        referenceTable: 'staff_shifts'
      });
    }

    // Check staff_payments -> staff_shifts (paid_by)
    const orphanedPaymentsCashier = this.db.prepare(`
      SELECT sp.id, sp.paid_by_cashier_shift_id
      FROM staff_payments sp
      LEFT JOIN staff_shifts ss ON sp.paid_by_cashier_shift_id = ss.id
      WHERE ss.id IS NULL
    `).all() as Array<{ id: string; paid_by_cashier_shift_id: string }>;

    for (const row of orphanedPaymentsCashier) {
      orphanedRecords.push({
        table: 'staff_payments',
        recordId: row.id,
        field: 'paid_by_cashier_shift_id',
        missingReference: row.paid_by_cashier_shift_id,
        referenceTable: 'staff_shifts'
      });
    }

    // Check cash_drawer_sessions -> staff_shifts
    tablesChecked.push('cash_drawer_sessions');
    const orphanedDrawers = this.db.prepare(`
      SELECT cds.id, cds.staff_shift_id
      FROM cash_drawer_sessions cds
      LEFT JOIN staff_shifts ss ON cds.staff_shift_id = ss.id
      WHERE ss.id IS NULL
    `).all() as Array<{ id: string; staff_shift_id: string }>;

    for (const row of orphanedDrawers) {
      orphanedRecords.push({
        table: 'cash_drawer_sessions',
        recordId: row.id,
        field: 'staff_shift_id',
        missingReference: row.staff_shift_id,
        referenceTable: 'staff_shifts'
      });
    }

    // Check sync_queue for stale entries
    tablesChecked.push('sync_queue');
    const staleSyncEntries = this.db.prepare(`
      SELECT sq.id, sq.table_name, sq.record_id
      FROM sync_queue sq
      WHERE sq.attempts > 10
        AND sq.created_at < datetime('now', '-7 days')
    `).all() as Array<{ id: string; table_name: string; record_id: string }>;

    // Generate recommendations
    const recommendations: string[] = [];

    if (orphanedRecords.length > 0) {
      recommendations.push(
        `Found ${orphanedRecords.length} orphaned records. Consider running cleanup.`
      );
    }

    if (staleSyncEntries.length > 0) {
      recommendations.push(
        `Found ${staleSyncEntries.length} stale sync queue entries (>10 attempts, >7 days old). Consider cleanup.`
      );
    }

    if (orphanedRecords.length === 0 && staleSyncEntries.length === 0) {
      recommendations.push('Database integrity is healthy. No orphaned records found.');
    }

    return {
      timestamp: new Date().toISOString(),
      tablesChecked,
      orphanedRecords,
      totalOrphaned: orphanedRecords.length,
      recommendations
    };
  }

  /**
   * Get statistics about table references
   */
  getReferenceStats(): Record<string, { total: number; withReference: number; withoutReference: number }> {
    const stats: Record<string, { total: number; withReference: number; withoutReference: number }> = {};

    // Orders with staff_id
    const orderStaffStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN staff_id IS NOT NULL THEN 1 END) as with_ref,
        COUNT(CASE WHEN staff_id IS NULL THEN 1 END) as without_ref
      FROM orders
    `).get() as { total: number; with_ref: number; without_ref: number };

    stats['orders.staff_id'] = {
      total: orderStaffStats.total,
      withReference: orderStaffStats.with_ref,
      withoutReference: orderStaffStats.without_ref
    };

    // Driver earnings with driver_id in staff cache
    const driverEarningsStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN s.id IS NOT NULL THEN 1 END) as with_ref,
        COUNT(CASE WHEN s.id IS NULL THEN 1 END) as without_ref
      FROM driver_earnings de
      LEFT JOIN staff s ON de.driver_id = s.id
    `).get() as { total: number; with_ref: number; without_ref: number };

    stats['driver_earnings.driver_id'] = {
      total: driverEarningsStats.total,
      withReference: driverEarningsStats.with_ref,
      withoutReference: driverEarningsStats.without_ref
    };

    // Staff shifts with staff_id in staff cache
    const shiftStaffStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN s.id IS NOT NULL THEN 1 END) as with_ref,
        COUNT(CASE WHEN s.id IS NULL THEN 1 END) as without_ref
      FROM staff_shifts ss
      LEFT JOIN staff s ON ss.staff_id = s.id
    `).get() as { total: number; with_ref: number; without_ref: number };

    stats['staff_shifts.staff_id'] = {
      total: shiftStaffStats.total,
      withReference: shiftStaffStats.with_ref,
      withoutReference: shiftStaffStats.without_ref
    };

    return stats;
  }
}
