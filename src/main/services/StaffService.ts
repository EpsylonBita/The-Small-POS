import Database from 'better-sqlite3';
import { getWaiterShiftData } from './helpers/ShiftHelpers';
import { BaseService } from './BaseService';
import * as crypto from 'crypto';
import type { StaffPayment } from '../../renderer/types/shift';

// Database row interfaces
interface StaffSessionRow {
  id: string;
  staff_id: string;
  pin_hash: string;
  role: 'admin' | 'staff';
  login_time: string;
  logout_time?: string;
  is_active: boolean;
}

interface StaffFilter {
  staffId?: string;
  role?: string;
  active?: boolean;
}

export interface StaffSession {
  id: string;
  staff_id: string;
  pin_hash: string;
  role: 'admin' | 'staff';
  login_time: string;
  logout_time?: string;
  is_active: boolean;
}

export interface StaffInfo {
  id: string;
  name: string;
  role: string;
  permissions: string[];
}

// Shift management interfaces

export interface StaffShift {
  id: string;
  staff_id: string;
  branch_id?: string;
  terminal_id?: string;
  role_type: 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server';
  check_in_time: string;
  check_out_time?: string;
  scheduled_start?: string;
  scheduled_end?: string;
  opening_cash_amount: number;
  closing_cash_amount?: number;
  expected_cash_amount?: number;
  cash_variance?: number;
  status: 'active' | 'closed' | 'abandoned';
  total_orders_count: number;
  total_sales_amount: number;
  total_cash_sales: number;
  total_card_sales: number;
  /** Payment amount recorded for driver wage during checkout */
  payment_amount?: number;
  notes?: string;
  closed_by?: string;
  /**
   * For driver shifts only: The cashier shift ID this driver was attached to
   * after being transferred. NULL when:
   * - Driver is not transferred (normal checkout)
   * - Driver is pending transfer (is_transfer_pending = true, no cashier yet)
   * Set to actual cashier shift ID when the next cashier checks in and claims this driver.
   */
  transferred_to_cashier_shift_id?: string;
  /**
   * Boolean flag: true if this driver is pending transfer to next cashier.
   * This is the primary transfer state indicator, stored directly in the database.
   */
  is_transfer_pending?: boolean;
  created_at: string;
  updated_at: string;
}

export interface CashDrawerSession {
  id: string;
  staff_shift_id: string;
  cashier_id: string;
  branch_id: string;
  terminal_id: string;
  opening_amount: number;
  closing_amount?: number;
  expected_amount?: number;
  variance_amount?: number;
  total_cash_sales: number;
  total_card_sales: number;
  total_refunds: number;
  total_expenses: number;
  cash_drops: number;
  driver_cash_given: number;
  driver_cash_returned: number;
  total_staff_payments: number;
  opened_at: string;
  closed_at?: string;
  reconciled: boolean;
  reconciled_at?: string;
  reconciled_by?: string;
  reconciliation_notes?: string;
  created_at: string;
  updated_at: string;
}

export interface ShiftExpense {
  id: string;
  staff_shift_id: string;
  staff_id: string;
  branch_id: string;
  expense_type: 'supplies' | 'maintenance' | 'petty_cash' | 'refund' | 'other';
  amount: number;
  description: string;
  receipt_number?: string;
  status: 'pending' | 'approved' | 'rejected';
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface OpenShiftParams {
  staffId: string;
  staffName?: string;
  branchId: string;
  terminalId: string;
  roleType: 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server';
  /**
   * Initial cash amount in the drawer (for cashiers).
   * @deprecated Use startingAmount for drivers.
   */
  openingCash?: number;
  /**
   * Optional starting amount for drivers.
   * Semantically distinct from openingCash (which implies a drawer count),
   * but maps to the same underlying logic for now.
   */
  startingAmount?: number;
}

export interface CloseShiftParams {
  shiftId: string;
  closingCash: number;
  closedBy: string;
  /** Optional payment amount for driver wage recording during checkout */
  paymentAmount?: number;
}

export class StaffService extends BaseService {
  constructor(database: Database.Database) {
    super(database);
    // Disable foreign keys - staff data is managed in Supabase, not locally
    // This prevents foreign key constraint failures when staff_id doesn't exist in local staff table
    this.db.pragma('foreign_keys = OFF');
  }

  createSession(staffId: string, pin: string, role: 'admin' | 'staff'): StaffSession {
    return this.executeTransaction(() => {
      this.validateRequired({ staffId, pin, role }, ['staffId', 'pin', 'role']);

      // Normalize role to local enum to satisfy CHECK constraint
      const localRole: 'admin' | 'staff' = role === 'admin' ? 'admin' : 'staff';

      // Hash the PIN for security
      const pinHash = this.hashPin(pin);

      // End any existing active sessions for this staff member
      this.endActiveSession(staffId);

      const session: StaffSession = {
        id: this.generateId(),
        staff_id: staffId,
        pin_hash: pinHash,
        role: localRole,
        login_time: this.getCurrentTimestamp(),
        is_active: true
      };

      const stmt = this.db.prepare(`
        INSERT INTO staff_sessions (
          id, staff_id, pin_hash, role, login_time, is_active
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        session.id, session.staff_id, session.pin_hash,
        session.role, session.login_time, session.is_active ? 1 : 0
      );

      return session;
    });
  }

  validatePin(staffId: string, pin: string): StaffSession | null {
    const pinHash = this.hashPin(pin);

    const stmt = this.db.prepare(`
      SELECT * FROM staff_sessions
      WHERE staff_id = ? AND pin_hash = ? AND is_active = 1
      ORDER BY login_time DESC
      LIMIT 1
    `);

    const row = stmt.get(staffId, pinHash) as StaffSessionRow | undefined;

    if (!row) return null;

    return this.mapRowToSession(row);
  }

  getActiveSession(staffId: string): StaffSession | null {
    const stmt = this.db.prepare(`
      SELECT * FROM staff_sessions
      WHERE staff_id = ? AND is_active = 1
      ORDER BY login_time DESC
      LIMIT 1
    `);

    const row = stmt.get(staffId) as StaffSessionRow | undefined;

    if (!row) return null;

    return this.mapRowToSession(row);
  }

  getAllActiveSessions(): StaffSession[] {
    const stmt = this.db.prepare(`
      SELECT * FROM staff_sessions
      WHERE is_active = 1
      ORDER BY login_time DESC
    `);

    const rows = stmt.all() as StaffSessionRow[];

    return rows.map(row => this.mapRowToSession(row));
  }

  endSession(sessionId: string): boolean {
    return this.executeTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE staff_sessions SET
          is_active = 0,
          logout_time = ?
        WHERE id = ?
      `);

      const result = stmt.run(this.getCurrentTimestamp(), sessionId);
      return result.changes > 0;
    });
  }

  endActiveSession(staffId: string): boolean {
    return this.executeTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE staff_sessions SET
          is_active = 0,
          logout_time = ?
        WHERE staff_id = ? AND is_active = 1
      `);

      const result = stmt.run(this.getCurrentTimestamp(), staffId);
      return result.changes > 0;
    });
  }

  endAllActiveSessions(): number {
    return this.executeTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE staff_sessions SET
          is_active = 0,
          logout_time = ?
        WHERE is_active = 1
      `);

      const result = stmt.run(this.getCurrentTimestamp());
      return result.changes;
    });
  }

  getSessionHistory(staffId?: string, limit: number = 50): StaffSession[] {
    let query = 'SELECT * FROM staff_sessions';
    const params: (string | number | boolean)[] = [];

    if (staffId) {
      query += ' WHERE staff_id = ?';
      params.push(staffId);
    }

    query += ' ORDER BY login_time DESC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as StaffSessionRow[];

    return rows.map(row => this.mapRowToSession(row));
  }

  isStaffLoggedIn(staffId: string): boolean {
    const session = this.getActiveSession(staffId);
    return session !== null;
  }

  getStaffRole(staffId: string): 'admin' | 'staff' | null {
    const session = this.getActiveSession(staffId);
    return session?.role || null;
  }

  hasPermission(staffId: string, permission: string): boolean {
    const role = this.getStaffRole(staffId);

    if (role === 'admin') {
      return true; // Admins have all permissions
    }

    // For staff members, check specific permissions
    // This could be extended to check against a permissions table
    const staffPermissions = this.getStaffPermissions(staffId);
    return staffPermissions.includes(permission);
  }

  private getStaffPermissions(staffId: string): string[] {
    // This is a simplified implementation
    // In a real application, you would query a permissions table
    const role = this.getStaffRole(staffId);

    if (role === 'admin') {
      return [
        'process_orders',
        'refund_orders',
        'void_transactions',
        'access_reports',
        'manage_staff',
        'modify_prices',
        'open_cash_drawer'
      ];
    }

    return [
      'process_orders',
      'open_cash_drawer'
    ];
  }

  private hashPin(pin: string): string {
    return crypto.createHash('sha256').update(pin).digest('hex');
  }

  private mapRowToSession(row: StaffSessionRow): StaffSession {
    return {
      id: row.id,
      staff_id: row.staff_id,
      pin_hash: row.pin_hash,
      role: row.role,
      login_time: row.login_time,
      logout_time: row.logout_time,
      is_active: Boolean(row.is_active)
    };
  }

  // Cleanup old sessions (older than 30 days)
  cleanupOldSessions(): number {
    return this.executeTransaction(() => {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const cutoffDate = thirtyDaysAgo.toISOString();

      const stmt = this.db.prepare(`
        DELETE FROM staff_sessions
        WHERE is_active = 0 AND login_time < ?
      `);

      const result = stmt.run(cutoffDate);
      return result.changes;
    });
  }

  // Shift Management Methods

  private isValidUuid(v: any): boolean {
    return typeof v === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
  }

  openShift(params: OpenShiftParams): { success: boolean; shiftId?: string; error?: string; message?: string } {
    return this.executeTransaction(() => {
      this.validateRequired(params, ['staffId', 'branchId', 'terminalId', 'roleType']);

      // Check if staff already has an active shift
      const activeShiftStmt = this.db.prepare(`
        SELECT id FROM staff_shifts
        WHERE staff_id = ? AND status = 'active'
      `);
      const activeShift = activeShiftStmt.get(params.staffId);

      if (activeShift) {
        return { success: false, error: 'Staff member already has an active shift' };
      }

      const shiftId = this.generateId();
      const now = this.getCurrentTimestamp();

      // Determine the effective opening cash amount.
      // - For cashiers: 'openingCash' represents the counted drawer amount.
      // - For drivers: 'startingAmount' represents cash taken FROM the cashier.
      // We support both for backward compatibility, but 'startingAmount' is preferred for drivers.
      const openingCash = params.startingAmount !== undefined ? params.startingAmount : (params.openingCash || 0);


      // Determine if this shift starts the POS day (first cashier check-in for the date)
      let isDayStart = 0;
      if (params.roleType === 'cashier') {
        const existingCashierToday = this.db.prepare(`
          SELECT COUNT(*) as c
          FROM staff_shifts
          WHERE branch_id = ?
            AND terminal_id = ?
            AND role_type = 'cashier'
            AND date(check_in_time) = date(?)
        `).get(params.branchId, params.terminalId, now) as any;
        if (Number(existingCashierToday?.c || 0) === 0) {
          isDayStart = 1;
        }
      }

      // Check if this is a local-only shift (won't be synced to Supabase)
      const isLocalOnly = !this.isValidUuid(shiftId) || !this.isValidUuid(params.staffId) || params.staffId === 'local-simple-pin';

      // Insert into staff_shifts
      const shiftStmt = this.db.prepare(`
        INSERT INTO staff_shifts (
          id, staff_id, staff_name, branch_id, terminal_id, role_type,
          check_in_time, opening_cash_amount, status,
          total_orders_count, total_sales_amount, total_cash_sales, total_card_sales,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      shiftStmt.run(
        shiftId, params.staffId, params.staffName || null, params.branchId, params.terminalId, params.roleType,
        now, openingCash, 'active',
        0, 0, 0, 0,
        now, now
      );

      // Mark this cashier shift as the day start if applicable
      if (isDayStart === 1) {
        this.db.prepare(`UPDATE staff_shifts SET is_day_start = 1 WHERE id = ?`).run(shiftId);
      }


      // If cashier, also create cash drawer session
      if (params.roleType === 'cashier') {
        const drawerId = this.generateId();
        const drawerStmt = this.db.prepare(`
          INSERT INTO cash_drawer_sessions (
            id, staff_shift_id, cashier_id, branch_id, terminal_id,
            opening_amount, total_cash_sales, total_card_sales, total_refunds,
            total_expenses, cash_drops, driver_cash_given, driver_cash_returned,
            total_staff_payments, opened_at, reconciled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        drawerStmt.run(
          drawerId, shiftId, params.staffId, params.branchId, params.terminalId,
          openingCash, 0, 0, 0,
          0, 0, 0, 0,
          0, now, 0, now, now
        );

        // Add cash drawer to sync queue (skip local-only sessions)
        if (!isLocalOnly) {
          this.addToSyncQueue('cash_drawer_sessions', drawerId, 'insert', {
            id: drawerId,
            staff_shift_id: shiftId,
            cashier_id: params.staffId,
            branch_id: params.branchId,
            terminal_id: params.terminalId,
            opening_amount: openingCash,
            opened_at: now
          });
        }

        // Inherit transferred driver shifts from previous cashier
        // These are drivers with is_transfer_pending = 1 who haven't checked out yet
        const transferredDriversStmt = this.db.prepare(`
          SELECT
            ss.id as shift_id,
            ss.staff_id as driver_id,
            ss.opening_cash_amount as starting_amount,
            (s.first_name || ' ' || s.last_name) as driver_name
          FROM staff_shifts ss
          LEFT JOIN staff s ON ss.staff_id = s.id
          WHERE ss.branch_id = ?
            AND ss.terminal_id = ?
            AND ss.role_type = 'driver'
            AND ss.status = 'active'
            AND ss.is_transfer_pending = 1
        `);
        const transferredDrivers = transferredDriversStmt.all(params.branchId, params.terminalId) as any[];

        if (transferredDrivers.length > 0) {
          let totalInheritedDriverCashGiven = 0;

          for (const driver of transferredDrivers) {
            // Update driver shift to point to the new cashier shift and clear pending flag
            const updateDriverShiftStmt = this.db.prepare(`
              UPDATE staff_shifts
              SET transferred_to_cashier_shift_id = ?,
                  is_transfer_pending = 0,
                  updated_at = ?
              WHERE id = ?
            `);
            updateDriverShiftStmt.run(shiftId, now, driver.shift_id);

            // Add to sync queue
            if (!isLocalOnly) {
              this.addToSyncQueue('staff_shifts', driver.shift_id, 'update', {
                transferred_to_cashier_shift_id: shiftId,
                is_transfer_pending: false,
                updated_at: now
              });
            }

            // Accumulate the driver's starting amount (what they took from previous cashier)
            totalInheritedDriverCashGiven += driver.starting_amount || 0;
          }

          // Update the new cashier's drawer with inherited driver amounts
          if (totalInheritedDriverCashGiven > 0) {
            const updateDrawerStmt = this.db.prepare(`
              UPDATE cash_drawer_sessions
              SET driver_cash_given = ?,
                  updated_at = ?
              WHERE id = ?
            `);
            updateDrawerStmt.run(totalInheritedDriverCashGiven, now, drawerId);

            if (!isLocalOnly) {
              this.addToSyncQueue('cash_drawer_sessions', drawerId, 'update', {
                driver_cash_given: totalInheritedDriverCashGiven,
                updated_at: now
              });
            }
          }

          console.log(`[StaffService] Inherited ${transferredDrivers.length} transferred driver(s) from previous cashier:`,
            transferredDrivers.map(d => ({ name: d.driver_name, starting: d.starting_amount })));
        }
      }

      // If driver with opening cash, deduct from active cashier drawer
      if (params.roleType === 'driver' && openingCash > 0) {
        // Validation: Ensure an active cashier exists before allowing driver to take money
        const activeCashierDrawerStmt = this.db.prepare(`
          SELECT cds.id, cds.driver_cash_given
          FROM cash_drawer_sessions cds
          INNER JOIN staff_shifts ss ON cds.staff_shift_id = ss.id
          WHERE cds.branch_id = ?
            AND cds.terminal_id = ?
            AND ss.status = 'active'
            AND ss.role_type = 'cashier'
            AND cds.closed_at IS NULL
          LIMIT 1
        `);
        const cashierDrawer = activeCashierDrawerStmt.get(params.branchId, params.terminalId) as any;

        if (!cashierDrawer) {
          // If no active cashier, we cannot process the starting amount
          // We must return an error so the UI can prompt the user to skip starting amount or check in a cashier
          return {
            success: false,
            error: 'No active cashier found. A cashier must be checked in before drivers can take starting amounts.'
          };
        }

        try {
          console.log(`[StaffService] Processing driver starting amount: ${openingCash} from cashier drawer ${cashierDrawer.id}`);

          const newDriverCashGiven = (cashierDrawer.driver_cash_given || 0) + openingCash;

          // Update cashier drawer
          const updateDrawerStmt = this.db.prepare(`
            UPDATE cash_drawer_sessions
            SET driver_cash_given = ?, updated_at = ?
            WHERE id = ?
          `);
          updateDrawerStmt.run(newDriverCashGiven, now, cashierDrawer.id);

          // Add drawer update to sync queue (skip local-only)
          if (!isLocalOnly) {
            this.addToSyncQueue('cash_drawer_sessions', cashierDrawer.id, 'update', {
              driver_cash_given: newDriverCashGiven,
              updated_at: now
            });
          }
        } catch (err) {
          console.error('[StaffService] Error updating cashier drawer for driver starting amount:', err);
          // We log the error but proceed with opening the shift to avoid blocking the driver completely,
          // though ideally this should be transactional. Since we are in a transaction, this error will bubble up
          // if we re-throw, or we can return failure. Let's re-throw to rollback everything.
          throw err;
        }
      }

      // Add shift to sync queue (skip local-only shifts)
      if (!isLocalOnly) {
        this.addToSyncQueue('staff_shifts', shiftId, 'insert', {
          id: shiftId,
          staff_id: params.staffId,
          staff_name: params.staffName || null,
          branch_id: params.branchId,
          terminal_id: params.terminalId,
          role_type: params.roleType,
          check_in_time: now,
          opening_cash_amount: openingCash,
          status: 'active',
          is_day_start: isDayStart === 1
        });
      }

      return { success: true, shiftId, message: 'Shift opened successfully' };
    });
  }

  closeShift(params: CloseShiftParams): { success: boolean; variance?: number; error?: string; message?: string } {
    return this.executeTransaction(() => {
      this.validateRequired(params, ['shiftId', 'closingCash', 'closedBy']);

      // Get shift data
      const shiftStmt = this.db.prepare('SELECT * FROM staff_shifts WHERE id = ?');
      const shift = shiftStmt.get(params.shiftId) as any;

      if (!shift) {
        return { success: false, error: 'Shift not found' };
      }

      // Calculate expected cash amount
      const openingAmount = shift.opening_cash_amount || 0;

      // Get total cash sales - use status-based filtering for consistency
      const cashSalesStmt = this.db.prepare(`
        SELECT COALESCE(SUM(total_amount), 0) as total
        FROM orders
        WHERE staff_shift_id = ? AND payment_method = 'cash' AND status IN ('delivered', 'completed')
      `);
      const cashSales = (cashSalesStmt.get(params.shiftId) as any)?.total || 0;

      // Get cash refunds
      const cashRefundsStmt = this.db.prepare(`
        SELECT COALESCE(SUM(total_amount), 0) as total
        FROM orders
        WHERE staff_shift_id = ? AND status = 'refunded' AND payment_method = 'cash'
      `);
      const cashRefunds = (cashRefundsStmt.get(params.shiftId) as any)?.total || 0;

      // Get approved expenses
      const expensesStmt = this.db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM shift_expenses
        WHERE staff_shift_id = ? AND status = 'approved' AND expense_type != 'staff_payment'
      `);
      const expenses = (expensesStmt.get(params.shiftId) as any)?.total || 0;

      // Get cash drawer data if exists
      let cashDrops = 0, driverCashGiven = 0, driverCashReturned = 0, staffPayments = 0;
      const drawerStmt = this.db.prepare(`
        SELECT id, cash_drops, driver_cash_given, driver_cash_returned, total_staff_payments, total_expenses
        FROM cash_drawer_sessions
        WHERE staff_shift_id = ?
      `);
      const drawer = drawerStmt.get(params.shiftId) as any;
      console.log('[closeShift] Drawer data:', { shiftId: params.shiftId, drawer });
      if (drawer) {
        cashDrops = drawer.cash_drops || 0;
        driverCashGiven = drawer.driver_cash_given || 0;
        driverCashReturned = drawer.driver_cash_returned || 0;
        staffPayments = drawer.total_staff_payments || 0;
      }
      console.log('[closeShift] Calculated values:', { openingAmount, cashSales, cashRefunds, expenses, cashDrops, driverCashGiven, driverCashReturned, staffPayments });

      const now = this.getCurrentTimestamp();

      // For cashier shifts, transfer active drivers BEFORE calculating expected amount
      // This removes their starting amounts from driverCashGiven so they don't affect this cashier's variance
      let transferredDriverStartingTotal = 0;
      let transferredDrivers: Array<{
        shiftId: string;
        driverId: string;
        driverName: string;
        startingAmount: number;
        cashCollected: number;
        cardAmount: number;
        expenses: number;
        netCashAmount: number;
      }> = [];

      if (shift.role_type === 'cashier' && drawer) {
        // Transfer active driver shifts to the next cashier BEFORE calculating expected
        // This marks them as transferred and returns their amounts
        transferredDrivers = this.transferActiveDriverShifts(shift.branch_id, shift.terminal_id, params.shiftId);

        if (transferredDrivers.length > 0) {
          // Calculate total starting amounts for transferred drivers
          transferredDriverStartingTotal = transferredDrivers.reduce((sum, d) => sum + d.startingAmount, 0);

          // Subtract transferred driver starting amounts from driverCashGiven
          // This ensures the closing cashier is not held liable for cash given to drivers who haven't returned
          driverCashGiven = driverCashGiven - transferredDriverStartingTotal;

          // Update the drawer's driver_cash_given to remove transferred driver amounts
          const updateTransferredDrawerStmt = this.db.prepare(`
            UPDATE cash_drawer_sessions
            SET driver_cash_given = ?,
                updated_at = ?
            WHERE id = ?
          `);
          updateTransferredDrawerStmt.run(driverCashGiven, now, drawer.id);

          // Add sync queue entry for the driver_cash_given update
          this.addToSyncQueue('cash_drawer_sessions', drawer.id, 'update', {
            driver_cash_given: driverCashGiven,
            updated_at: now
          });

          console.log(`[StaffService] Transferred ${transferredDrivers.length} active driver(s) to next cashier:`,
            transferredDrivers.map(d => ({ name: d.driverName, starting: d.startingAmount, netCash: d.netCashAmount })));
          console.log(`[StaffService] Adjusted driverCashGiven from ${driverCashGiven + transferredDriverStartingTotal} to ${driverCashGiven} (removed ${transferredDriverStartingTotal} for transferred drivers)`);
        }
      }

      // Payment amount (for driver wage recording)
      const paymentAmount = params.paymentAmount ?? 0;

      // Calculate expected amount and variance based on role type
      let expected: number;
      let variance: number;

      if (shift.role_type === 'driver') {
        // Driver-specific variance calculation:
        // The driver's closingCash parameter represents cash RETURNED to the cashier, not cash on hand.
        // expectedDriverReturn = cashCollected - startingAmount - driverExpenses - paymentAmount
        // This aligns with the UI's formula and the cashier drawer's driver_cash_returned calculation.
        const driverEarningsStmt = this.db.prepare(`
          SELECT COALESCE(SUM(cash_collected), 0) as cash_collected
          FROM driver_earnings
          WHERE staff_shift_id = ?
        `);
        const driverEarnings = driverEarningsStmt.get(params.shiftId) as any;
        const cashCollected = driverEarnings?.cash_collected || 0;

        // Get driver-specific expenses
        const driverExpensesStmt = this.db.prepare(`
          SELECT COALESCE(SUM(amount), 0) as total
          FROM shift_expenses
          WHERE staff_shift_id = ? AND status = 'approved'
        `);
        const driverExpenses = (driverExpensesStmt.get(params.shiftId) as any)?.total || 0;

        // Driver formula: expected return = cashCollected - startingAmount - expenses - wage
        // This is the amount the driver should return to the cashier's drawer
        const expectedDriverReturn = cashCollected - openingAmount - driverExpenses - paymentAmount;
        expected = expectedDriverReturn;
        variance = params.closingCash - expectedDriverReturn;
      } else {
        // Cashier/Manager formula (now with adjusted driverCashGiven that excludes transferred drivers)
        expected = openingAmount + cashSales - cashRefunds - expenses - cashDrops - driverCashGiven + driverCashReturned - staffPayments;
        variance = params.closingCash - expected;
      }
      const updateShiftStmt = this.db.prepare(`
        UPDATE staff_shifts SET
          check_out_time = ?,
          closing_cash_amount = ?,
          expected_cash_amount = ?,
          cash_variance = ?,
          payment_amount = ?,
          status = 'closed',
          closed_by = ?,
          updated_at = ?
        WHERE id = ?
      `);

      updateShiftStmt.run(now, params.closingCash, expected, variance, paymentAmount, params.closedBy, now, params.shiftId);

      // If cashier, update cash drawer session with closing amounts
      if (shift.role_type === 'cashier' && drawer) {
        const updateDrawerStmt = this.db.prepare(`
          UPDATE cash_drawer_sessions SET
            closing_amount = ?,
            expected_amount = ?,
            variance_amount = ?,
            closed_at = ?,
            updated_at = ?
          WHERE staff_shift_id = ?
        `);

        updateDrawerStmt.run(params.closingCash, expected, variance, now, now, params.shiftId);

        // Add cash drawer update to sync queue
        this.addToSyncQueue('cash_drawer_sessions', drawer.id || params.shiftId, 'update', {
          closing_amount: params.closingCash,
          expected_amount: expected,
          variance_amount: variance,
          closed_at: now,
          updated_at: now
        });
      }

      // If driver, update related cashier drawer with the expected return amount
      if (shift.role_type === 'driver') {
        // Reuse the `expected` value calculated above, which is the driver's expected return
        // Formula: expectedDriverReturn = cashCollected - startingAmount - expenses - wage
        // This same value is used for the driver's variance AND for the cashier drawer update
        const expectedReturn = expected;

        // Find active cashier drawer for same branch/terminal
        const activeCashierDrawerStmt = this.db.prepare(`
          SELECT cds.id, cds.driver_cash_returned, cds.total_expenses, cds.total_staff_payments
          FROM cash_drawer_sessions cds
          INNER JOIN staff_shifts ss ON cds.staff_shift_id = ss.id
          WHERE cds.branch_id = ?
            AND cds.terminal_id = ?
            AND ss.status = 'active'
            AND ss.role_type = 'cashier'
            AND cds.closed_at IS NULL
          LIMIT 1
        `);
        const cashierDrawer = activeCashierDrawerStmt.get(shift.branch_id, shift.terminal_id) as any;

        if (cashierDrawer) {
          // Use expectedReturn (derived from formula: cashCollected - startingAmount - expenses - paymentAmount)
          // for updating the cashier drawer's driver_cash_returned field.
          // This value may be negative if driver owes money (shortage).
          // closingCash is kept for the driver shift's own variance calculation but decoupled from cashier drawer.
          const newDriverCashReturned = (cashierDrawer.driver_cash_returned || 0) + expectedReturn;

          // Record driver payment (wage) ONLY in total_staff_payments, NOT in total_expenses
          // This prevents double-counting when later phases introduce dedicated staff_payments handling
          const newTotalStaffPayments = (cashierDrawer.total_staff_payments || 0) + paymentAmount;

          const updateCashierDrawerStmt = this.db.prepare(`
            UPDATE cash_drawer_sessions
            SET driver_cash_returned = ?, total_staff_payments = ?, updated_at = ?
            WHERE id = ?
          `);
          updateCashierDrawerStmt.run(newDriverCashReturned, newTotalStaffPayments, now, cashierDrawer.id);

          // Add drawer update to sync queue
          this.addToSyncQueue('cash_drawer_sessions', cashierDrawer.id, 'update', {
            driver_cash_returned: newDriverCashReturned,
            total_staff_payments: newTotalStaffPayments,
            updated_at: now
          });
        }
      }

      // Add shift to sync queue
      this.addToSyncQueue('staff_shifts', params.shiftId, 'update', {
        check_out_time: now,
        closing_cash_amount: params.closingCash,
        expected_cash_amount: expected,
        cash_variance: variance,
        payment_amount: paymentAmount,
        status: 'closed',
        closed_by: params.closedBy,
        is_day_start: !!shift.is_day_start
      });

      return { success: true, variance, message: 'Shift closed successfully' };
    });
  }

  /**
   * Transfer active driver shifts when a cashier checks out.
   * Marks driver shifts with a pending transfer and flags their earnings as transferred.
   * These drivers will be inherited by the next cashier who checks in.
   *
   * @param branchId - The branch ID
   * @param terminalId - The terminal ID
   * @param closingCashierShiftId - The shift ID of the cashier who is checking out
   * @returns Array of transferred driver info with their cash amounts
   */
  transferActiveDriverShifts(branchId: string, terminalId: string, closingCashierShiftId: string): Array<{
    shiftId: string;
    driverId: string;
    driverName: string;
    startingAmount: number;
    cashCollected: number;
    cardAmount: number;
    expenses: number;
    netCashAmount: number;
  }> {
    const now = this.getCurrentTimestamp();
    const transferredDrivers: Array<{
      shiftId: string;
      driverId: string;
      driverName: string;
      startingAmount: number;
      cashCollected: number;
      cardAmount: number;
      expenses: number;
      netCashAmount: number;
    }> = [];

    // Query for active driver shifts on the same branch/terminal
    const activeDriversStmt = this.db.prepare(`
      SELECT
        ss.id as shift_id,
        ss.staff_id as driver_id,
        ss.opening_cash_amount as starting_amount,
        (s.first_name || ' ' || s.last_name) as driver_name
      FROM staff_shifts ss
      LEFT JOIN staff s ON ss.staff_id = s.id
      WHERE ss.branch_id = ?
        AND ss.terminal_id = ?
        AND ss.role_type = 'driver'
        AND ss.status = 'active'
        AND ss.is_transfer_pending = 0
        AND ss.transferred_to_cashier_shift_id IS NULL
    `);
    const activeDrivers = activeDriversStmt.all(branchId, terminalId) as any[];

    for (const driver of activeDrivers) {
      // Get driver earnings amounts
      const earningsStmt = this.db.prepare(`
        SELECT
          COALESCE(SUM(cash_collected), 0) as cash_collected,
          COALESCE(SUM(card_amount), 0) as card_amount
        FROM driver_earnings
        WHERE staff_shift_id = ?
      `);
      const earnings = earningsStmt.get(driver.shift_id) as any;

      // Get driver expenses (excluding staff_payment type)
      const expensesStmt = this.db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM shift_expenses
        WHERE staff_shift_id = ? AND status = 'approved' AND expense_type != 'staff_payment'
      `);
      const expenses = (expensesStmt.get(driver.shift_id) as any)?.total || 0;

      const startingAmount = driver.starting_amount || 0;
      const cashCollected = earnings?.cash_collected || 0;
      const cardAmount = earnings?.card_amount || 0;

      // Net cash amount = what driver took (starting) + cash collected - expenses
      // This is what would need to be returned to cashier
      const netCashAmount = startingAmount + cashCollected - expenses;

      // Mark the driver shift as transferred (set is_transfer_pending = 1, leave transferred_to_cashier_shift_id NULL)
      const updateShiftStmt = this.db.prepare(`
        UPDATE staff_shifts
        SET is_transfer_pending = 1,
            transferred_to_cashier_shift_id = NULL,
            updated_at = ?
        WHERE id = ?
      `);
      updateShiftStmt.run(now, driver.shift_id);

      // Mark all driver earnings as transferred
      const updateEarningsStmt = this.db.prepare(`
        UPDATE driver_earnings
        SET is_transferred = 1,
            updated_at = ?
        WHERE staff_shift_id = ?
      `);
      updateEarningsStmt.run(now, driver.shift_id);

      // Add sync queue entries
      this.addToSyncQueue('staff_shifts', driver.shift_id, 'update', {
        is_transfer_pending: true,
        transferred_to_cashier_shift_id: null,
        updated_at: now
      });

      transferredDrivers.push({
        shiftId: driver.shift_id,
        driverId: driver.driver_id,
        driverName: driver.driver_name || `Driver ${driver.driver_id.slice(-6)}`,
        startingAmount,
        cashCollected,
        cardAmount,
        expenses,
        netCashAmount
      });
    }

    return transferredDrivers;
  }

  /**
   * Get transferred driver amounts for inheritance by new cashier
   * @param driverShiftId - The driver's shift ID
   * @returns Object with cash amounts
   */
  getTransferredDriverAmounts(driverShiftId: string): {
    startingAmount: number;
    cashCollected: number;
    cardAmount: number;
    expenses: number;
    netCashAmount: number;
  } {
    // Get driver shift starting amount
    const shiftStmt = this.db.prepare('SELECT opening_cash_amount FROM staff_shifts WHERE id = ?');
    const shift = shiftStmt.get(driverShiftId) as any;
    const startingAmount = shift?.opening_cash_amount || 0;

    // Get driver earnings amounts
    const earningsStmt = this.db.prepare(`
      SELECT
        COALESCE(SUM(cash_collected), 0) as cash_collected,
        COALESCE(SUM(card_amount), 0) as card_amount
      FROM driver_earnings
      WHERE staff_shift_id = ?
    `);
    const earnings = earningsStmt.get(driverShiftId) as any;
    const cashCollected = earnings?.cash_collected || 0;
    const cardAmount = earnings?.card_amount || 0;

    // Get driver expenses (excluding staff_payment type)
    const expensesStmt = this.db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM shift_expenses
      WHERE staff_shift_id = ? AND status = 'approved' AND expense_type != 'staff_payment'
    `);
    const expenses = (expensesStmt.get(driverShiftId) as any)?.total || 0;

    // Net cash amount = starting + cash collected - expenses
    const netCashAmount = startingAmount + cashCollected - expenses;

    return {
      startingAmount,
      cashCollected,
      cardAmount,
      expenses,
      netCashAmount
    };
  }

  getActiveShift(staffId: string): StaffShift | null {
    const stmt = this.db.prepare(`
      SELECT * FROM staff_shifts
      WHERE staff_id = ? AND status = 'active'
      ORDER BY check_in_time DESC
      LIMIT 1
    `);

    const row = stmt.get(staffId) as any;
    if (!row) return null;

    return this.mapRowToShift(row);
  }

  getActiveShiftByTerminal(branchId: string, terminalId: string): StaffShift | null {
    const stmt = this.db.prepare(`
      SELECT * FROM staff_shifts
      WHERE branch_id = ? AND terminal_id = ? AND status = 'active'
      ORDER BY check_in_time DESC
      LIMIT 1
    `);
    const row = stmt.get(branchId, terminalId) as any;
    if (!row) return null;
    return this.mapRowToShift(row);
  }

  getActiveCashierShiftByTerminal(branchId: string, terminalId: string): StaffShift | null {
    const stmt = this.db.prepare(`
      SELECT * FROM staff_shifts
      WHERE branch_id = ? AND terminal_id = ? AND status = 'active' AND role_type = 'cashier'
      ORDER BY check_in_time DESC
      LIMIT 1
    `);
    const row = stmt.get(branchId, terminalId) as any;
    if (!row) return null;
    return this.mapRowToShift(row);
  }

  getActiveShiftByTerminalLoose(terminalId: string): StaffShift | null {
    const stmt = this.db.prepare(`
      SELECT * FROM staff_shifts
      WHERE terminal_id = ? AND status = 'active'
      ORDER BY check_in_time DESC
      LIMIT 1
    `);
    const row = stmt.get(terminalId) as any;
    if (!row) return null;
    return this.mapRowToShift(row);
  }

  /**
   * Get all locally active shifts (for debugging/cleanup)
   */
  getAllActiveShifts(): StaffShift[] {
    const stmt = this.db.prepare(`
      SELECT * FROM staff_shifts WHERE status = 'active'
      ORDER BY check_in_time DESC
    `);
    const rows = stmt.all() as any[];
    return rows.map(row => this.mapRowToShift(row));
  }

  /**
   * Close all local active shifts (cleanup utility)
   * Useful when local DB is out of sync with Supabase
   */
  closeAllActiveShifts(): { closed: number } {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE staff_shifts
      SET status = 'abandoned',
          check_out_time = ?,
          updated_at = ?
      WHERE status = 'active'
    `);
    const result = stmt.run(now, now);
    console.log(`[StaffService] Closed ${result.changes} stale active shifts`);
    return { closed: result.changes };
  }


  recordExpense(params: {
    shiftId: string;
    staffId: string;
    branchId: string;
    expenseType: string;
    amount: number;
    description: string;
    receiptNumber?: string;
  }): { success: boolean; expenseId?: string; error?: string } {
    return this.executeTransaction(() => {
      this.validateRequired(params, ['shiftId', 'staffId', 'branchId', 'expenseType', 'amount', 'description']);

      // Validate shift is active and get branch/terminal
      const shiftStmt = this.db.prepare('SELECT status, branch_id, terminal_id FROM staff_shifts WHERE id = ?');
      const shift = shiftStmt.get(params.shiftId) as any;

      if (!shift) {
        return { success: false, error: 'Shift not found' };
      }

      if (shift.status !== 'active') {
        return { success: false, error: 'Cannot record expense on inactive shift' };
      }

      const expenseId = this.generateId();
      const now = this.getCurrentTimestamp();

      const stmt = this.db.prepare(`
        INSERT INTO shift_expenses (
          id, staff_shift_id, staff_id, branch_id, expense_type,
          amount, description, receipt_number, status, approved_by, approved_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        expenseId, params.shiftId, params.staffId, params.branchId, params.expenseType,
        params.amount, params.description, params.receiptNumber || null, 'approved', params.staffId, now,
        now, now
      );

      // Add to sync queue
      this.addToSyncQueue('shift_expenses', expenseId, 'insert', {
        id: expenseId,
        staff_shift_id: params.shiftId,
        staff_id: params.staffId,
        branch_id: params.branchId,
        expense_type: params.expenseType,
        amount: params.amount,
        description: params.description,
        receipt_number: params.receiptNumber,
        status: 'approved',
        approved_by: params.staffId,
        approved_at: now
      });

      // Update cash drawer with new expense totals
      const drawerStmt = this.db.prepare(`
        SELECT cds.id, cds.total_expenses, cds.total_staff_payments
        FROM cash_drawer_sessions cds
        WHERE cds.staff_shift_id = ?
      `);
      const drawer = drawerStmt.get(params.shiftId) as any;

      if (drawer) {
        // Update total_expenses on the drawer (staff payments are handled separately via recordStaffPayment)
        const newTotalExpenses = (drawer.total_expenses || 0) + params.amount;

        const updateDrawerStmt = this.db.prepare(`
          UPDATE cash_drawer_sessions
          SET total_expenses = ?, updated_at = ?
          WHERE id = ?
        `);
        updateDrawerStmt.run(newTotalExpenses, now, drawer.id);

        // Add drawer update to sync queue
        this.addToSyncQueue('cash_drawer_sessions', drawer.id, 'update', {
          total_expenses: newTotalExpenses,
          updated_at: now
        });
      }
      // Note: Staff payments are now handled exclusively via recordStaffPayment() and the staff_payments table

      return { success: true, expenseId };
    });
  }

  getShiftExpenses(shiftId: string): ShiftExpense[] {
    const stmt = this.db.prepare(`
      SELECT * FROM shift_expenses
      WHERE staff_shift_id = ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(shiftId) as any[];
    return rows.map(row => this.mapRowToExpense(row));
  }

  /**
   * Record a staff payment from the cashier's drawer.
   *
   * The `staff_shift_id` column references the RECIPIENT's active shift (if any),
   * while `paid_by_cashier_shift_id` references the cashier who made the payment.
   * This allows querying payments by either the recipient's shift or the paying cashier's shift.
   *
   * @param params Payment parameters including cashier shift ID, recipient staff ID, amount, type, and optional notes
   */
  recordStaffPayment(params: {
    cashierShiftId: string;
    paidToStaffId: string;
    amount: number;
    paymentType: string;
    notes?: string;
  }): { success: boolean; paymentId?: string; error?: string } {
    console.log('[StaffService.recordStaffPayment] Called with:', params);
    return this.executeTransaction(() => {
      this.validateRequired(params, ['cashierShiftId', 'paidToStaffId', 'amount', 'paymentType']);

      if (params.amount <= 0) {
        console.log('[StaffService.recordStaffPayment] Amount must be positive:', params.amount);
        return { success: false, error: 'Amount must be positive' };
      }

      // Validate cashier shift exists and is active
      const cashierShift = this.db.prepare('SELECT * FROM staff_shifts WHERE id = ? AND status = ?').get(params.cashierShiftId, 'active') as any;
      console.log('[StaffService.recordStaffPayment] Cashier shift lookup:', { cashierShiftId: params.cashierShiftId, found: !!cashierShift, status: cashierShift?.status });
      if (!cashierShift) {
        return { success: false, error: 'Cashier shift not found or not active' };
      }

      // Note: Staff validation removed because staff data is in Supabase, not local SQLite.
      // The staff member was validated during check-in via pos_checkin_staff RPC.
      // We trust the paidToStaffId because it comes from the authenticated shift context.
      console.log('[StaffService.recordStaffPayment] Using staff ID:', params.paidToStaffId);

      // Find recipient's active or most recent shift (if any)
      // This ensures staff_shift_id references the recipient's shift, not the cashier's
      const recipientShiftStmt = this.db.prepare(`
        SELECT id FROM staff_shifts
        WHERE staff_id = ?
        ORDER BY
          CASE WHEN status = 'active' THEN 0 ELSE 1 END,
          check_in_time DESC
        LIMIT 1
      `);
      const recipientShift = recipientShiftStmt.get(params.paidToStaffId) as any;
      const recipientShiftId = recipientShift?.id || null;
      console.log('[StaffService.recordStaffPayment] Recipient shift:', { recipientShiftId });

      // Dev-time logging: track payments without recipient shift for monitoring
      if (!recipientShiftId) {
        console.log('[StaffService.recordStaffPayment] Off-shift payment: staff_shift_id is NULL', {
          paidToStaffId: params.paidToStaffId,
          amount: params.amount,
          paymentType: params.paymentType
        });
      }

      const paymentId = this.generateId();
      const now = this.getCurrentTimestamp();
      console.log('[StaffService.recordStaffPayment] Inserting payment:', { paymentId, recipientShiftId, paidToStaffId: params.paidToStaffId, cashierShiftId: params.cashierShiftId, amount: params.amount });

      // Insert into staff_payments table
      // staff_shift_id = recipient's shift (for querying by recipient)
      // paid_by_cashier_shift_id = cashier's shift (for querying by payer)
      const insertStmt = this.db.prepare(`
        INSERT INTO staff_payments (
          id, staff_shift_id, paid_to_staff_id, paid_by_cashier_shift_id,
          amount, payment_type, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertResult = insertStmt.run(
        paymentId,
        recipientShiftId, // The recipient's shift (can be NULL if no shift found)
        params.paidToStaffId,
        params.cashierShiftId, // The cashier who made the payment
        params.amount,
        params.paymentType,
        params.notes || null,
        now,
        now // updated_at
      );
      console.log('[StaffService.recordStaffPayment] Insert result:', { changes: insertResult.changes });

      // Update cash_drawer_sessions.total_staff_payments
      const updateDrawerStmt = this.db.prepare(`
        UPDATE cash_drawer_sessions
        SET total_staff_payments = COALESCE(total_staff_payments, 0) + ?,
            updated_at = ?
        WHERE staff_shift_id = ?
      `);
      const drawerUpdateResult = updateDrawerStmt.run(params.amount, now, params.cashierShiftId);
      console.log('[StaffService.recordStaffPayment] Drawer update result:', { changes: drawerUpdateResult.changes, cashierShiftId: params.cashierShiftId, amount: params.amount });

      // Add to sync queue for Supabase synchronization
      this.addToSyncQueue('staff_payments', paymentId, 'insert', {
        id: paymentId,
        staff_shift_id: recipientShiftId,
        paid_to_staff_id: params.paidToStaffId,
        paid_by_cashier_shift_id: params.cashierShiftId,
        amount: params.amount,
        payment_type: params.paymentType,
        notes: params.notes || null,
        created_at: now
      });

      return { success: true, paymentId };
    });
  }

  /**
   * Get all staff payments recorded by a specific cashier shift
   * @param cashierShiftId The cashier's shift ID
   */
  getStaffPayments(cashierShiftId: string): any[] {
    const stmt = this.db.prepare(`
      SELECT
        sp.id,
        sp.staff_shift_id,
        sp.paid_to_staff_id as staff_id,
        sp.paid_by_cashier_shift_id,
        sp.amount,
        sp.payment_type,
        sp.notes,
        sp.created_at,
        (s.first_name || ' ' || s.last_name) as staff_name,
        ss.role_type,
        ss.check_in_time,
        ss.check_out_time
      FROM staff_payments sp
      LEFT JOIN staff s ON sp.paid_to_staff_id = s.id
      LEFT JOIN staff_shifts ss ON ss.staff_id = sp.paid_to_staff_id AND ss.status = 'active'
      WHERE sp.paid_by_cashier_shift_id = ?
      ORDER BY sp.created_at DESC
    `);

    return stmt.all(cashierShiftId) as any[];
  }

  /**
   * Get all payments made to a specific staff member within a date range
   * Used for displaying payment history and calculating daily totals
   */
  getStaffPaymentsByStaffAndDate(params: {
    staffId: string;
    dateFrom?: string; // ISO date string (YYYY-MM-DD)
    dateTo?: string;   // ISO date string (YYYY-MM-DD)
  }): StaffPayment[] {
    try {
      let query = `
        SELECT 
          sp.*,
          ss.check_in_time,
          ss.check_out_time,
          s.first_name || ' ' || s.last_name as cashier_name
        FROM staff_payments sp
        LEFT JOIN staff_shifts ss ON sp.staff_shift_id = ss.id
        LEFT JOIN staff_shifts cashier_ss ON sp.paid_by_cashier_shift_id = cashier_ss.id
        LEFT JOIN staff cashier_s ON cashier_ss.staff_id = cashier_s.id
        WHERE sp.paid_to_staff_id = ?
      `;

      const queryParams: any[] = [params.staffId];

      // Add date filtering if provided
      if (params.dateFrom) {
        query += ` AND date(sp.created_at) >= ?`;
        queryParams.push(params.dateFrom);
      }

      if (params.dateTo) {
        query += ` AND date(sp.created_at) <= ?`;
        queryParams.push(params.dateTo);
      }

      query += ` ORDER BY sp.created_at DESC`;

      const stmt = this.db.prepare(query);
      const rows = stmt.all(...queryParams);

      return rows.map(row => this.mapRowToStaffPayment(row));
    } catch (error) {
      console.error('[StaffService] Error getting staff payments by staff and date:', error);
      return [];
    }
  }

  /**
   * Calculate total payments made to a staff member for a specific date
   */
  getStaffPaymentTotalForDate(staffId: string, date: string): number {
    try {
      const stmt = this.db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM staff_payments
        WHERE paid_to_staff_id = ?
          AND date(created_at) = ?
      `);

      const result = stmt.get(staffId, date) as { total: number };
      return result?.total || 0;
    } catch (error) {
      console.error('[StaffService] Error calculating payment total:', error);
      return 0;
    }
  }

  private mapRowToStaffPayment(row: any): StaffPayment {
    return {
      id: row.id,
      staff_shift_id: row.staff_shift_id,
      paid_to_staff_id: row.paid_to_staff_id,
      paid_by_cashier_shift_id: row.paid_by_cashier_shift_id,
      amount: row.amount,
      payment_type: row.payment_type,
      notes: row.notes,
      created_at: row.created_at,
      // Additional fields from JOIN
      cashier_name: row.cashier_name,
      check_in_time: row.check_in_time,
      check_out_time: row.check_out_time
    };
  }

  /**
   * Get a summary of a shift including expenses, payments, and breakdowns.
   * @param shiftId The shift ID to get summary for
   * @param options Optional configuration
   * @param options.skipBackfill If true, skips driver earnings backfill (faster for non-checkout reads)
   */
  getShiftSummary(shiftId: string, options?: { skipBackfill?: boolean }): any {
    const shift = this.db.prepare('SELECT * FROM staff_shifts WHERE id = ?').get(shiftId) as any;
    if (!shift) return null;

    const cashDrawer = this.db.prepare('SELECT * FROM cash_drawer_sessions WHERE staff_shift_id = ?').get(shiftId) as any;

    const expenses = this.getShiftExpenses(shiftId);
    // All expenses are now regular expenses (staff_payment is handled separately via staff_payments table)
    const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

    // Debug logging
    console.log('[getShiftSummary] Expenses:', { shiftId, expenseCount: expenses.length, totalExpenses, expenses });

    // Staff payments (details) - now from staff_payments table instead of shift_expenses
    const staffPaymentsStmt = this.db.prepare(`
      SELECT
        sp.id,
        sp.paid_to_staff_id as staff_id,
        sp.amount,
        sp.notes as description,
        sp.created_at,
        sp.payment_type,
        (s.first_name || ' ' || s.last_name) as staff_name,
        ss.role_type,
        ss.check_in_time,
        ss.check_out_time
      FROM staff_payments sp
      LEFT JOIN staff s ON sp.paid_to_staff_id = s.id
      LEFT JOIN staff_shifts ss ON ss.staff_id = sp.paid_to_staff_id
        AND DATE(ss.check_in_time) = DATE(sp.created_at)
      WHERE sp.paid_by_cashier_shift_id = ?
      ORDER BY sp.created_at DESC
    `);
    const staffPayments = staffPaymentsStmt.all(shiftId) as any[];

    // Aggregate orders by type and payment method for detailed breakdown
    // Include all orders (not just completed) to show all sales during shift
    const breakdownStmt = this.db.prepare(`
      SELECT order_type as type, payment_method as method,
             COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
      FROM orders
      WHERE staff_shift_id = ? AND status != 'cancelled'
      GROUP BY order_type, payment_method
    `);
    const rows = breakdownStmt.all(shiftId) as any[];

    // Debug: Show orders for this shift
    const ordersForShift = this.db.prepare(`SELECT id, order_number, status, staff_shift_id, total_amount FROM orders WHERE staff_shift_id = ? LIMIT 10`).all(shiftId) as any[];
    console.log('[getShiftSummary] Orders for shift', shiftId, ':', ordersForShift);
    console.log('[getShiftSummary] Breakdown rows:', rows);

    const toNumber = (v: any) => (typeof v === 'number' && isFinite(v) ? v : 0);
    const sumBy = (cond: (r: any) => boolean) => rows.filter(cond).reduce((s, r) => s + toNumber(r.total), 0);
    const countBy = (cond: (r: any) => boolean) => rows.filter(cond).reduce((s, r) => s + (r.count || 0), 0);

    const instoreTypes = ['dine-in', 'takeaway', 'pickup'];
    const isInstore = (t: string) => instoreTypes.includes(t);

    const breakdown = {
      instore: {
        cashTotal: sumBy(r => isInstore(r.type) && r.method === 'cash'),
        cardTotal: sumBy(r => isInstore(r.type) && r.method === 'card'),
        cashCount: countBy(r => isInstore(r.type) && r.method === 'cash'),
        cardCount: countBy(r => isInstore(r.type) && r.method === 'card'),
      },
      delivery: {
        cashTotal: sumBy(r => r.type === 'delivery' && r.method === 'cash'),
        cardTotal: sumBy(r => r.type === 'delivery' && r.method === 'card'),
        cashCount: countBy(r => r.type === 'delivery' && r.method === 'cash'),
        cardCount: countBy(r => r.type === 'delivery' && r.method === 'card'),
      },
      overall: {
        cashTotal: sumBy(r => r.method === 'cash'),
        cardTotal: sumBy(r => r.method === 'card'),
        totalCount: countBy(_ => true),
        totalAmount: sumBy(_ => true)
      }
    };

    // Also compute refunds in cash (if any)
    const cashRefundsStmt = this.db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total
      FROM orders
      WHERE staff_shift_id = ? AND status = 'refunded' AND payment_method = 'cash'
    `);
    const cashRefunds = (cashRefundsStmt.get(shiftId) as any)?.total || 0;

    // Get canceled orders breakdown (cash and card)
    const canceledStmt = this.db.prepare(`
      SELECT payment_method as method,
             COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
      FROM orders
      WHERE staff_shift_id = ? AND status = 'cancelled'
      GROUP BY payment_method
    `);
    const canceledRows = canceledStmt.all(shiftId) as any[];
    const canceledCashTotal = canceledRows.find(r => r.method === 'cash')?.total || 0;
    const canceledCardTotal = canceledRows.find(r => r.method === 'card')?.total || 0;
    // Backfill: ensure driver_earnings exist for this driver shift based on delivered/completed orders
    // This can be skipped for faster reads when backfill is not critical (e.g., during polling)
    if (shift.role_type === 'driver' && !options?.skipBackfill) {
      this.backfillDriverEarnings(shift);
    }

    const canceledCashCount = canceledRows.find(r => r.method === 'cash')?.count || 0;
    const canceledCardCount = canceledRows.find(r => r.method === 'card')?.count || 0;

    // Get driver shifts and their summary data
    let driverSummaries: any[] = [];
    let transferredDrivers: any[] = [];

    if (shift.role_type === 'cashier') {
      // For cashier checkout, get all driver shifts from the same day/terminal
      // Use time range instead of DATE function for better compatibility
      const startOfDay = new Date(shift.check_in_time);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(shift.check_in_time);
      endOfDay.setHours(23, 59, 59, 999);

      // Only include CLOSED driver shifts to avoid counting unclosed (active) driver shifts
      // in the cashier's checkout totals. Active shifts are still in progress and shouldn't be included.
      // Also exclude transferred drivers (they have is_transfer_pending=1 or transferred_to_cashier_shift_id set)
      const driverShiftsStmt = this.db.prepare(`
        SELECT
          ds.id as shift_id,
          ds.staff_id as driver_id,
          (s.first_name || ' ' || s.last_name) as driver_name,
          ds.opening_cash_amount as starting_amount,
          ds.payment_amount as driver_payment,
          ds.check_in_time,
          ds.check_out_time
        FROM staff_shifts ds
        LEFT JOIN staff s ON ds.staff_id = s.id
        WHERE ds.check_in_time >= ?
          AND ds.check_in_time <= ?
          AND ds.branch_id = ?
          AND ds.terminal_id = ?
          AND ds.role_type = 'driver'
          AND ds.status = 'closed'
          AND ds.is_transfer_pending = 0
          AND ds.transferred_to_cashier_shift_id IS NULL
        ORDER BY ds.check_in_time ASC
      `);
      const driverShifts = driverShiftsStmt.all(startOfDay.toISOString(), endOfDay.toISOString(), shift.branch_id, shift.terminal_id) as any[];

      // For each driver shift, get their expenses
      driverSummaries = driverShifts.map((ds: any) => {
        const expensesStmt = this.db.prepare(`
          SELECT COALESCE(SUM(amount), 0) as total_expenses
          FROM shift_expenses
          WHERE staff_shift_id = ? AND expense_type != 'staff_payment'
        `);
        const expenseResult = expensesStmt.get(ds.shift_id) as any;

        return {
          driver_id: ds.driver_id,
          driver_name: ds.driver_name,
          starting_amount: ds.starting_amount || 0,
          driver_payment: ds.driver_payment || 0,
          expenses: expenseResult?.total_expenses || 0,
          shift_id: ds.shift_id
        };
      });

      // Get transferred drivers (active drivers inherited from previous cashier)
      // These are drivers with transferred_to_cashier_shift_id = this cashier's shift ID
      const transferredDriversStmt = this.db.prepare(`
        SELECT
          ds.id as shift_id,
          ds.staff_id as driver_id,
          (s.first_name || ' ' || s.last_name) as driver_name,
          ds.opening_cash_amount as starting_amount,
          ds.check_in_time,
          ds.transferred_to_cashier_shift_id
        FROM staff_shifts ds
        LEFT JOIN staff s ON ds.staff_id = s.id
        WHERE ds.transferred_to_cashier_shift_id = ?
          AND ds.role_type = 'driver'
          AND ds.status = 'active'
        ORDER BY ds.check_in_time ASC
      `);
      const transferredRows = transferredDriversStmt.all(shiftId) as any[];

      // For each transferred driver, calculate their current amounts
      transferredDrivers = transferredRows.map((ds: any) => {
        const amounts = this.getTransferredDriverAmounts(ds.shift_id);
        return {
          driver_id: ds.driver_id,
          driver_name: ds.driver_name || `Driver ${ds.driver_id.slice(-6)}`,
          shift_id: ds.shift_id,
          starting_amount: amounts.startingAmount,
          current_earnings: amounts.cashCollected + amounts.cardAmount,
          cash_collected: amounts.cashCollected,
          card_amount: amounts.cardAmount,
          expenses: amounts.expenses,
          net_cash_amount: amounts.netCashAmount,
          transferred_from_cashier_shift_id: null, // Could be tracked if needed
          check_in_time: ds.check_in_time
        };
      });
    } else {
      // For driver checkout, get ALL orders for this driver shift (including canceled)
      // Use orders table directly with LEFT JOIN to driver_earnings to include canceled orders
      const driverDeliveriesStmt = this.db.prepare(`
        SELECT
          de.id,
          o.id as order_id,
          COALESCE(de.delivery_fee, 0) as delivery_fee,
          COALESCE(de.tip_amount, 0) as tip_amount,
          COALESCE(de.total_earning, 0) as total_earning,
          COALESCE(de.payment_method, o.payment_method) as payment_method,
          COALESCE(de.cash_collected, CASE WHEN o.payment_method = 'cash' THEN o.total_amount ELSE 0 END) as cash_collected,
          COALESCE(de.card_amount, CASE WHEN o.payment_method != 'cash' THEN o.total_amount ELSE 0 END) as card_amount,
          COALESCE(de.cash_to_return, 0) as cash_to_return,
          o.order_number,
          o.customer_name,
          o.customer_phone,
          o.customer_email,
          o.delivery_address,
          o.total_amount,
          o.payment_status,
          o.status,
          o.status as order_status,
          ss.staff_id as driver_id,
          (s.first_name || ' ' || s.last_name) as driver_name,
          ss.opening_cash_amount as starting_amount,
          ss.payment_amount as driver_payment
        FROM orders o
        LEFT JOIN driver_earnings de ON de.order_id = o.id AND de.staff_shift_id = ?
        JOIN staff_shifts ss ON o.staff_shift_id = ss.id
        LEFT JOIN staff s ON ss.staff_id = s.id
        WHERE o.driver_id = (SELECT staff_id FROM staff_shifts WHERE id = ?)
          AND o.staff_shift_id = ?
        ORDER BY o.created_at DESC
      `);
      driverSummaries = driverDeliveriesStmt.all(shiftId, shiftId, shiftId) as any[];
    }

    // Get waiter tables summary if role is server
    let waiterTables: any[] = [];
    if (shift.role_type === 'server') {
      waiterTables = getWaiterShiftData(this.db, shiftId);
    }

    // Map driverSummaries to ensure both status and order_status are present for backward compatibility
    const driverDeliveries = driverSummaries.map((d: any) => ({
      ...d,
      status: d.status || d.order_status,
      order_status: d.order_status || d.status
    }));

    const mappedCashDrawer = cashDrawer ? this.mapRowToCashDrawer(cashDrawer) : null;

    // Override total_expenses with calculated value to ensure it's always current
    if (mappedCashDrawer) {
      mappedCashDrawer.total_expenses = totalExpenses;
    }

    return {
      shift: this.mapRowToShift(shift),
      cashDrawer: mappedCashDrawer,
      expenses,
      totalExpenses,
      staffPayments,
      ordersCount: breakdown.overall.totalCount,
      salesAmount: breakdown.overall.totalAmount,
      breakdown,
      cashRefunds,
      canceledOrders: {
        cashTotal: canceledCashTotal,
        cardTotal: canceledCardTotal,
        cashCount: canceledCashCount,
        cardCount: canceledCardCount
      },
      driverDeliveries,
      // Transferred drivers are active drivers inherited from the previous cashier
      // Their amounts are excluded from this cashier's expected amount calculations
      transferredDrivers: transferredDrivers.length > 0 ? transferredDrivers : undefined,
      waiterTables: waiterTables.length > 0 ? waiterTables : undefined
    };
  }

  private mapRowToShift(row: any): StaffShift {
    return {
      id: row.id,
      staff_id: row.staff_id,
      branch_id: row.branch_id,
      terminal_id: row.terminal_id,
      role_type: row.role_type,
      check_in_time: row.check_in_time,
      check_out_time: row.check_out_time,
      scheduled_start: row.scheduled_start,
      scheduled_end: row.scheduled_end,
      opening_cash_amount: row.opening_cash_amount,
      closing_cash_amount: row.closing_cash_amount,
      expected_cash_amount: row.expected_cash_amount,
      cash_variance: row.cash_variance,
      status: row.status,
      total_orders_count: row.total_orders_count,
      total_sales_amount: row.total_sales_amount,
      total_cash_sales: row.total_cash_sales,
      total_card_sales: row.total_card_sales,
      payment_amount: row.payment_amount,
      notes: row.notes,
      closed_by: row.closed_by,
      // For driver shifts: the cashier shift ID this driver was transferred to (if any)
      transferred_to_cashier_shift_id: row.transferred_to_cashier_shift_id || undefined,
      // Boolean from database column: true if driver is awaiting transfer to next cashier
      is_transfer_pending: Boolean(row.is_transfer_pending),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private mapRowToCashDrawer(row: any): CashDrawerSession {
    return {
      id: row.id,
      staff_shift_id: row.staff_shift_id,
      cashier_id: row.cashier_id,
      branch_id: row.branch_id,
      terminal_id: row.terminal_id,
      opening_amount: row.opening_amount,
      closing_amount: row.closing_amount,
      expected_amount: row.expected_amount,
      variance_amount: row.variance_amount,
      total_cash_sales: row.total_cash_sales,
      total_card_sales: row.total_card_sales,
      total_refunds: row.total_refunds,
      total_expenses: row.total_expenses,
      cash_drops: row.cash_drops,
      driver_cash_given: row.driver_cash_given,
      driver_cash_returned: row.driver_cash_returned,
      total_staff_payments: row.total_staff_payments,
      opened_at: row.opened_at,
      closed_at: row.closed_at,
      reconciled: Boolean(row.reconciled),
      reconciled_at: row.reconciled_at,
      reconciled_by: row.reconciled_by,
      reconciliation_notes: row.reconciliation_notes,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private mapRowToExpense(row: any): ShiftExpense {
    return {
      id: row.id,
      staff_shift_id: row.staff_shift_id,
      staff_id: row.staff_id,
      branch_id: row.branch_id,
      expense_type: row.expense_type,
      amount: row.amount,
      description: row.description,
      receipt_number: row.receipt_number,
      status: row.status,
      approved_by: row.approved_by,
      approved_at: row.approved_at,
      rejection_reason: row.rejection_reason,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  // Driver Earnings Methods

  /**
   * Backfill driver earnings for orders that are missing earning records.
   * This ensures that all delivered/completed orders during a driver's shift
   * have corresponding driver_earnings entries.
   *
   * @param shift The driver's shift to backfill earnings for
   */
  private backfillDriverEarnings(shift: StaffShift): void {
    try {
      const startTime = shift.check_in_time;
      const endTime = shift.check_out_time || null;

      // Find delivery orders for this driver within the shift window that are missing earnings
      const missingStmt = this.db.prepare(`
        SELECT o.id, o.payment_method, o.total_amount, COALESCE(o.tip_amount, 0) AS tip_amount
        FROM orders o
        WHERE o.driver_id = ?
          AND LOWER(COALESCE(o.order_type, '')) = 'delivery'
          AND LOWER(COALESCE(o.status, '')) IN ('delivered','completed')
          AND date(COALESCE(o.updated_at, o.created_at)) >= date(?)
          AND ( ? IS NULL OR date(COALESCE(o.updated_at, o.created_at)) <= date(?) )
          AND NOT EXISTS (
            SELECT 1 FROM driver_earnings de WHERE de.order_id = o.id
          )
        ORDER BY COALESCE(o.updated_at, o.created_at) ASC
      `);
      const candidates = missingStmt.all(shift.staff_id, startTime, endTime, endTime) as any[];

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return;
      }

      for (const o of candidates) {
        const pmLower = String(o.payment_method || '').toLowerCase();
        let paymentMethod: 'cash' | 'card' | 'mixed' = 'mixed';
        let cashCollected = 0;
        let cardAmount = 0;

        if (pmLower.includes('card')) {
          paymentMethod = 'card';
          cardAmount = Number(o.total_amount || 0);
        } else if (pmLower.includes('cash')) {
          paymentMethod = 'cash';
          cashCollected = Number(o.total_amount || 0);
        }

        const res = this.recordDriverEarning({
          driverId: shift.staff_id,
          shiftId: shift.id,
          orderId: o.id,
          deliveryFee: 0,
          tipAmount: Number(o.tip_amount || 0),
          paymentMethod,
          cashCollected,
          cardAmount
        });

        if (!res.success && !(res.error || '').toLowerCase().includes('earning already')) {
          console.warn('[StaffService.backfillDriverEarnings] Failed to backfill driver earning', {
            orderId: o.id,
            error: res.error
          });
        }
      }
    } catch (e) {
      console.warn('[StaffService.backfillDriverEarnings] Error (ignored):', e);
    }
  }

  recordDriverEarning(params: {
    driverId: string;
    shiftId: string;
    orderId: string;
    deliveryFee: number;
    tipAmount: number;
    paymentMethod: 'cash' | 'card' | 'mixed';
    cashCollected: number;
    cardAmount: number;
  }): { success: boolean; earningId?: string; error?: string } {
    return this.executeTransaction(() => {
      this.validateRequired(params, ['driverId', 'shiftId', 'orderId', 'paymentMethod']);

      // Validate shift exists and is active
      const shiftStmt = this.db.prepare('SELECT * FROM staff_shifts WHERE id = ?');
      const shift = shiftStmt.get(params.shiftId) as any;

      if (!shift) {
        return { success: false, error: 'Shift not found' };
      }

      if (shift.status !== 'active') {
        return { success: false, error: 'Cannot record earnings on inactive shift' };
      }

      // Check if earning already exists for this order
      const existingStmt = this.db.prepare('SELECT id FROM driver_earnings WHERE order_id = ?');
      const existing = existingStmt.get(params.orderId);

      if (existing) {
        return { success: false, error: 'Earning already recorded for this order' };
      }

      // Fetch order details for the JSONB column
      const orderStmt = this.db.prepare(
        'SELECT order_number, delivery_address, table_number, total_amount, payment_method, status FROM orders WHERE id = ?'
      );
      const order = orderStmt.get(params.orderId) as any;

      const orderDetails = order ? JSON.stringify({
        order_number: order.order_number,
        address: order.delivery_address || order.table_number || 'N/A',
        price: order.total_amount || 0,
        payment_type: order.payment_method || params.paymentMethod,
        status: order.status
      }) : null;

      const earningId = this.generateId();
      const now = this.getCurrentTimestamp();
      const totalEarning = params.deliveryFee + params.tipAmount;
      const cashToReturn = params.cashCollected - params.cardAmount;

      const stmt = this.db.prepare(`
        INSERT INTO driver_earnings (
          id, driver_id, staff_shift_id, order_id, branch_id,
          delivery_fee, tip_amount, total_earning,
          payment_method, cash_collected, card_amount, cash_to_return,
          order_details,
          settled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        earningId, params.driverId, params.shiftId, params.orderId, shift.branch_id,
        params.deliveryFee, params.tipAmount, totalEarning,
        params.paymentMethod, params.cashCollected, params.cardAmount, cashToReturn,
        orderDetails,
        0, now, now
      );

      // Add to sync queue
      this.addToSyncQueue('driver_earnings', earningId, 'insert', {
        id: earningId,
        driver_id: params.driverId,
        staff_shift_id: params.shiftId,
        order_id: params.orderId,
        branch_id: shift.branch_id,
        delivery_fee: params.deliveryFee,
        tip_amount: params.tipAmount,
        total_earning: totalEarning,
        payment_method: params.paymentMethod,
        cash_collected: params.cashCollected,
        card_amount: params.cardAmount,
        cash_to_return: cashToReturn,
        order_details: orderDetails ? JSON.parse(orderDetails) : null,
        settled: false
      });

      return { success: true, earningId };
    });
  }

  getDriverEarnings(shiftId: string): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM driver_earnings
      WHERE staff_shift_id = ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(shiftId) as any[];
    return rows.map(row => ({
      id: row.id,
      driver_id: row.driver_id,
      staff_shift_id: row.staff_shift_id,
      order_id: row.order_id,
      branch_id: row.branch_id,
      delivery_fee: row.delivery_fee,
      tip_amount: row.tip_amount,
      total_earning: row.total_earning,
      payment_method: row.payment_method,
      cash_collected: row.cash_collected,
      card_amount: row.card_amount,
      cash_to_return: row.cash_to_return,
      settled: Boolean(row.settled),
      settled_at: row.settled_at,
      settlement_batch_id: row.settlement_batch_id,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));
  }

  getDriverShiftSummary(shiftId: string): any {
    const earningsStmt = this.db.prepare(`
      SELECT
        COUNT(*) as total_deliveries,
        COALESCE(SUM(delivery_fee), 0) as total_delivery_fees,
        COALESCE(SUM(tip_amount), 0) as total_tips,
        COALESCE(SUM(total_earning), 0) as total_earnings,
        COALESCE(SUM(cash_collected), 0) as total_cash_collected,
        COALESCE(SUM(card_amount), 0) as total_card_amount,
        COALESCE(SUM(cash_to_return), 0) as total_cash_to_return
      FROM driver_earnings
      WHERE staff_shift_id = ?
    `);

    const summary = earningsStmt.get(shiftId) as any;

    return {
      totalDeliveries: summary?.total_deliveries || 0,
      totalDeliveryFees: summary?.total_delivery_fees || 0,
      totalTips: summary?.total_tips || 0,
      totalEarnings: summary?.total_earnings || 0,
      totalCashCollected: summary?.total_cash_collected || 0,
      totalCardAmount: summary?.total_card_amount || 0,
      totalCashToReturn: summary?.total_cash_to_return || 0
    };
  }

  // Cache for driver data (30 second TTL)
  private driverCache: Map<string, { data: any[]; timestamp: number }> = new Map();
  private readonly DRIVER_CACHE_TTL = 30000; // 30 seconds

  async getActiveDrivers(branchId: string): Promise<any[]> {
    try {
      // Check cache first
      const cached = this.driverCache.get(branchId);
      if (cached && Date.now() - cached.timestamp < this.DRIVER_CACHE_TTL) {
        const hasSynthetic = Array.isArray(cached.data) && cached.data.some((d: any) => !d?.name || /^Driver\s/i.test(String(d.name)));
        if (!hasSynthetic) {
          return cached.data;
        }
        // If cached names are synthetic, refresh immediately
        console.debug('[StaffService] getActiveDrivers: refreshing due to synthetic names in cache', { branchId });
      }

      console.debug('[StaffService] getActiveDrivers: branchId', branchId);

      // Get active driver shifts from local DB
      const stmt = this.db.prepare(`
        SELECT
          ss.id as shift_id,
          ss.staff_id,
          ss.status,
          ss.check_in_time,
          ss.staff_name
        FROM staff_shifts ss
        WHERE ss.branch_id = ?
          AND ss.role_type = 'driver'
          AND ss.status = 'active'
        ORDER BY ss.check_in_time DESC
      `);

      const rows = stmt.all(branchId) as any[];

      console.debug('[StaffService] active driver shifts rows:', rows.length);
      console.debug('[StaffService] staffIds:', rows.map(r => r.staff_id));

      if (rows.length === 0) {
        return [];
      }

      // Get staff IDs
      const staffIds = rows.map(row => row.staff_id);

      // Fetch driver details from Supabase with RPC fallback (handles RLS)
      let driverDetails: any[] = [];
      try {
        const { getSupabaseClient, SUPABASE_CONFIG } = require('../../shared/supabase-config');
        const supabase = getSupabaseClient();

        // First try direct select (may be blocked by RLS in some environments)
        let directData: any[] | null = null;
        let directErr: any = null;
        try {
          const res = await supabase
            .from('staff')
            .select('id, first_name, last_name, phone, email')
            .in('id', staffIds);
          directData = res.data || null;
          directErr = res.error || null;
        } catch (e) {
          directErr = e;
        }

        if (directData && directData.length > 0 && !directErr) {
          driverDetails = directData.map((s: any) => ({
            ...s,
            name: `${s.first_name || ''} ${s.last_name || ''}`.trim()
          }));

          console.debug('[StaffService] direct staff fetch OK, count:', driverDetails.length);

        } else {
          // Fallback: use SECURITY DEFINER RPC that is allowed for anon to list POS staff for this branch
          try {
            const rpcRes = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/rpc/pos_list_staff_for_checkin`, {
              method: 'POST',
              headers: {
                'apikey': SUPABASE_CONFIG.anonKey,
                'Authorization': `Bearer ${SUPABASE_CONFIG.anonKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ p_branch_id: branchId })
            });
            if (rpcRes.ok) {
              const rpcData = await rpcRes.json();
              const filtered = Array.isArray(rpcData) ? rpcData.filter((s: any) => staffIds.includes(s.id)) : [];
              driverDetails = filtered.map((s: any) => ({
                id: s.id,
                first_name: s.first_name,
                last_name: s.last_name,
                name: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
                phone: '',
                email: s.email || ''
              }));
              console.debug('[StaffService] staff via branch RPC, count:', driverDetails.length);
            }
          } catch (rpcErr) {
            console.warn('Fallback RPC fetch for staff failed:', rpcErr);
          }
        }
      } catch (supabaseError) {
        console.warn('Failed to fetch driver details from Supabase, using local data only:', supabaseError);
      }


      // If still missing details for some drivers (e.g., admin-enabled staff excluded by RPC),
      // fetch names via dedicated SECURITY DEFINER RPC that accepts IDs directly.
      try {
        const missingIds = staffIds.filter((id: string) => !driverDetails.some((d: any) => d.id === id));
        if (missingIds.length > 0) {
          const { SUPABASE_CONFIG } = require('../../shared/supabase-config');
          const rpc2 = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/rpc/pos_get_staff_names_by_ids`, {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_CONFIG.anonKey,
              'Authorization': `Bearer ${SUPABASE_CONFIG.anonKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ p_ids: missingIds })
          });
          if (rpc2.ok) {
            const list = await rpc2.json();
            console.debug('[StaffService] missing IDs before ID-RPC:', missingIds);

            const addl = Array.isArray(list) ? list.map((s: any) => ({
              id: s.id,
              first_name: s.first_name,
              last_name: s.last_name,
              name: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
              phone: '',
              email: s.email || ''
            })) : [];
            // merge
            console.debug('[StaffService] staff via ID RPC, added:', Array.isArray(list) ? list.length : 0);

            const byId = new Map(driverDetails.map((d: any) => [d.id, d]));
            for (const d of addl) {
              if (!byId.has(d.id)) byId.set(d.id, d);
            }
            driverDetails = Array.from(byId.values());
          }
        }
      } catch (e) {
        console.warn('Secondary staff name RPC fallback failed:', e);
      }

      // Count active orders per driver
      const orderCountStmt = this.db.prepare(`
        SELECT driver_id, COUNT(*) as count
        FROM orders
        WHERE driver_id IN (${staffIds.map(() => '?').join(',')})
          AND status IN ('ready', 'out_for_delivery')
        GROUP BY driver_id
      `);

      const orderCounts = orderCountStmt.all(...staffIds) as any[];
      const orderCountMap = new Map(orderCounts.map(row => [row.driver_id, row.count]));

      // Merge data
      const enrichedDrivers = rows.map(row => {
        const details = driverDetails.find(d => d.id === row.staff_id);
        const currentOrders = orderCountMap.get(row.staff_id) || 0;

        const fullName = [details?.first_name, details?.last_name].filter(Boolean).join(' ').trim();
        const displayName = (details?.name && String(details?.name).trim())
          || (fullName && fullName.length > 0 ? fullName : '')
          || (row.staff_name && String(row.staff_name).trim())
          || `Driver ${row.staff_id.slice(-6)}`;

        if (/^Driver\s/i.test(displayName)) {
          console.warn('[StaffService] Synthetic driver name used for', row.staff_id, { staff_name: row.staff_name, details });
        }


        return {
          id: row.staff_id,
          name: displayName,
          phone: details?.phone || '',
          email: details?.email || '',
          shiftId: row.shift_id,
          status: currentOrders >= 3 ? 'busy' : 'available',
          checkInTime: row.check_in_time,
          current_orders: currentOrders
        };
      });

      // Update cache
      this.driverCache.set(branchId, {
        data: enrichedDrivers,
        timestamp: Date.now()
      });

      return enrichedDrivers;
    } catch (error) {
      console.error('Failed to get active drivers:', error);

      // Return cached data if available, even if expired
      const cached = this.driverCache.get(branchId);
      if (cached) {
        return cached.data;
      }

      return [];
    }
  }
}
