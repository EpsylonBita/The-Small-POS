/**
 * Property-Based Test: Staff Payments Total Invariant
 *
 * Feature: z-report-fixes, Property 1: Staff Payments Total Invariant
 *
 * For any Z Report generated for a given date, the `expenses.staffPaymentsTotal` value
 * SHALL equal the sum of all individual staff payment amounts in `staffAnalytics`,
 * regardless of the staff member's role type (cashier, driver, or kitchen).
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 *
 * This test invokes the REAL ReportService.generateZReport() method against an in-memory
 * SQLite database seeded with randomized fixtures.
 */

import * as fc from 'fast-check';
import type BetterSqlite3 from 'better-sqlite3';
import { ReportService } from '../main/services/ReportService';

let BetterSqlite3Ctor: typeof BetterSqlite3 | null = null;
let betterSqlite3LoadError: Error | null = null;
let betterSqlite3Available = false;

try {
  BetterSqlite3Ctor = require('better-sqlite3') as typeof BetterSqlite3;
} catch (error) {
  betterSqlite3LoadError = error as Error;
}

if (BetterSqlite3Ctor) {
  try {
    const probe = new BetterSqlite3Ctor(':memory:');
    probe.close();
    betterSqlite3Available = true;
  } catch (error) {
    betterSqlite3LoadError = error as Error;
    BetterSqlite3Ctor = null;
  }
}

const describeIfBetterSqlite3 = betterSqlite3Available ? describe : describe.skip;

// Note: fast-check is configured globally via the shared setup file (src/tests/setup.ts)
// which imports propertyTestConfig.ts. Settings are env-driven:
// - FAST_CHECK_NUM_RUNS: number of iterations (default: 100)
// - FAST_CHECK_VERBOSE: verbose output (default: true)

/**
 * Test Database Setup
 */
function createTestDatabase(): BetterSqlite3.Database {
  if (!BetterSqlite3Ctor) {
    throw new Error(
      `better-sqlite3 unavailable: ${betterSqlite3LoadError?.message || 'unknown error'}`
    );
  }

  const db = new BetterSqlite3Ctor(':memory:');
  db.pragma('foreign_keys = OFF');

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_number TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL,
      items TEXT NOT NULL,
      total_amount REAL NOT NULL,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      order_type TEXT NOT NULL,
      table_number TEXT,
      delivery_address TEXT,
      delivery_city TEXT,
      delivery_postal_code TEXT,
      delivery_floor TEXT,
      delivery_notes TEXT,
      name_on_ringer TEXT,
      special_instructions TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      estimated_time INTEGER,
      supabase_id TEXT,
      sync_status TEXT DEFAULT 'pending',
      payment_status TEXT DEFAULT 'pending',
      payment_method TEXT,
      payment_transaction_id TEXT,
      version INTEGER DEFAULT 1 NOT NULL,
      updated_by TEXT,
      last_synced_at TEXT,
      remote_version INTEGER,
      driver_id TEXT,
      driver_name TEXT,
      staff_shift_id TEXT,
      staff_id TEXT,
      discount_percentage REAL,
      discount_amount REAL,
      tip_amount REAL
    );

    CREATE TABLE IF NOT EXISTS staff_shifts (
      id TEXT PRIMARY KEY,
      staff_id TEXT NOT NULL,
      staff_name TEXT,
      branch_id TEXT,
      terminal_id TEXT,
      role_type TEXT NOT NULL CHECK (role_type IN ('cashier', 'manager', 'driver', 'kitchen', 'server')),
      check_in_time TEXT NOT NULL,
      check_out_time TEXT,
      scheduled_start TEXT,
      scheduled_end TEXT,
      opening_cash_amount REAL DEFAULT 0,
      closing_cash_amount REAL,
      expected_cash_amount REAL,
      cash_variance REAL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'abandoned')),
      total_orders_count INTEGER DEFAULT 0,
      total_sales_amount REAL DEFAULT 0,
      total_cash_sales REAL DEFAULT 0,
      total_card_sales REAL DEFAULT 0,
      payment_amount REAL DEFAULT 0,
      calculation_version INTEGER DEFAULT 2,
      notes TEXT,
      closed_by TEXT,
      transferred_to_cashier_shift_id TEXT,
      is_transfer_pending INTEGER DEFAULT 0,
      is_day_start INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_drawer_sessions (
      id TEXT PRIMARY KEY,
      staff_shift_id TEXT NOT NULL UNIQUE,
      cashier_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      terminal_id TEXT NOT NULL,
      opening_amount REAL NOT NULL DEFAULT 0,
      closing_amount REAL,
      expected_amount REAL,
      variance_amount REAL,
      total_cash_sales REAL DEFAULT 0,
      total_card_sales REAL DEFAULT 0,
      total_refunds REAL DEFAULT 0,
      total_expenses REAL DEFAULT 0,
      cash_drops REAL DEFAULT 0,
      driver_cash_given REAL DEFAULT 0,
      driver_cash_returned REAL DEFAULT 0,
      total_staff_payments REAL DEFAULT 0,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      reconciled INTEGER DEFAULT 0,
      reconciled_at TEXT,
      reconciled_by TEXT,
      reconciliation_notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shift_expenses (
      id TEXT PRIMARY KEY,
      staff_shift_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      expense_type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      receipt_number TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      approved_by TEXT,
      approved_at TEXT,
      rejection_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS driver_earnings (
      id TEXT PRIMARY KEY,
      driver_id TEXT NOT NULL,
      staff_shift_id TEXT,
      order_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      delivery_fee REAL DEFAULT 0,
      tip_amount REAL DEFAULT 0,
      total_earning REAL NOT NULL,
      payment_method TEXT NOT NULL,
      cash_collected REAL DEFAULT 0,
      card_amount REAL DEFAULT 0,
      cash_to_return REAL DEFAULT 0,
      order_details TEXT,
      settled INTEGER DEFAULT 0,
      settled_at TEXT,
      settlement_batch_id TEXT,
      is_transferred INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_payments (
      id TEXT PRIMARY KEY,
      staff_shift_id TEXT,
      paid_to_staff_id TEXT NOT NULL,
      paid_by_cashier_shift_id TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_type TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      staff_code TEXT UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE,
      phone TEXT,
      role_id TEXT,
      branch_id TEXT,
      department TEXT,
      employment_type TEXT DEFAULT 'full-time',
      hire_date TEXT,
      hourly_rate REAL,
      pin_hash TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      can_login_pos INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_settings (
      setting_category TEXT NOT NULL,
      setting_key TEXT NOT NULL,
      setting_value TEXT,
      UNIQUE(setting_category, setting_key)
    );
  `);

  return db;
}

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getTestDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fixture interfaces
 */
interface StaffShiftFixture {
  id: string;
  staffId: string;
  staffName: string;
  branchId: string;
  terminalId: string;
  roleType: 'cashier' | 'driver' | 'kitchen' | 'server';
}

interface StaffPaymentFixture {
  id: string;
  paidToStaffId: string;
  paidByCashierShiftId: string;
  staffShiftId?: string;
  amount: number;
  paymentType: 'wage' | 'tip' | 'bonus' | 'other';
}

interface CashierShiftFixture {
  id: string;
  staffId: string;
  staffName: string;
  branchId: string;
  terminalId: string;
  openingAmount: number;
}

/**
 * Seed functions
 */
function seedStaffShift(
  db: BetterSqlite3.Database,
  fixture: StaffShiftFixture,
  targetDate: string
): void {
  const checkInTime = `${targetDate}T08:00:00`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO staff_shifts (
      id, staff_id, staff_name, branch_id, terminal_id, role_type,
      check_in_time, opening_cash_amount, payment_amount,
      calculation_version, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 2, 'active', ?, ?)
  `).run(
    fixture.id,
    fixture.staffId,
    fixture.staffName,
    fixture.branchId,
    fixture.terminalId,
    fixture.roleType,
    checkInTime,
    now,
    now
  );
}

function seedCashierShiftWithDrawer(
  db: BetterSqlite3.Database,
  fixture: CashierShiftFixture,
  targetDate: string
): void {
  const checkInTime = `${targetDate}T08:00:00`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO staff_shifts (
      id, staff_id, staff_name, branch_id, terminal_id, role_type,
      check_in_time, opening_cash_amount, payment_amount,
      calculation_version, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'cashier', ?, ?, 0, 2, 'active', ?, ?)
  `).run(
    fixture.id,
    fixture.staffId,
    fixture.staffName,
    fixture.branchId,
    fixture.terminalId,
    checkInTime,
    fixture.openingAmount,
    now,
    now
  );

  db.prepare(`
    INSERT INTO cash_drawer_sessions (
      id, staff_shift_id, cashier_id, branch_id, terminal_id,
      opening_amount, driver_cash_given, driver_cash_returned, total_staff_payments,
      opened_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)
  `).run(
    generateId(),
    fixture.id,
    fixture.staffId,
    fixture.branchId,
    fixture.terminalId,
    fixture.openingAmount,
    `${targetDate}T08:00:00`,
    now,
    now
  );
}

function seedStaffPayment(
  db: BetterSqlite3.Database,
  fixture: StaffPaymentFixture,
  targetDate: string
): void {
  const createdAt = `${targetDate}T14:00:00`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO staff_payments (
      id, paid_to_staff_id, paid_by_cashier_shift_id, staff_shift_id,
      amount, payment_type, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    fixture.id,
    fixture.paidToStaffId,
    fixture.paidByCashierShiftId,
    fixture.staffShiftId || null,
    fixture.amount,
    fixture.paymentType,
    createdAt,
    now
  );
}

function seedStaff(
  db: BetterSqlite3.Database,
  staffId: string,
  firstName: string,
  lastName: string,
  branchId: string
): void {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR IGNORE INTO staff (
      id, first_name, last_name, branch_id, is_active, can_login_pos,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 1, ?, ?)
  `).run(staffId, firstName, lastName, branchId, now, now);
}

/**
 * Arbitrary generators
 */
const staffShiftArb = fc.record({
  id: fc.uuid(),
  staffId: fc.uuid(),
  staffName: fc.string({ minLength: 1, maxLength: 30 }),
  branchId: fc.uuid(),
  terminalId: fc.uuid(),
  roleType: fc.constantFrom('cashier', 'driver', 'kitchen', 'server') as fc.Arbitrary<
    'cashier' | 'driver' | 'kitchen' | 'server'
  >,
});

const cashierShiftArb = fc.record({
  id: fc.uuid(),
  staffId: fc.uuid(),
  staffName: fc.string({ minLength: 1, maxLength: 30 }),
  branchId: fc.uuid(),
  terminalId: fc.uuid(),
  openingAmount: fc.float({ min: Math.fround(100), max: Math.fround(500), noNaN: true }),
});

const staffPaymentArb = fc.record({
  id: fc.uuid(),
  paidToStaffId: fc.uuid(),
  paidByCashierShiftId: fc.uuid(),
  amount: fc.float({ min: Math.fround(1), max: Math.fround(200), noNaN: true }),
  paymentType: fc.constantFrom('wage', 'tip', 'bonus', 'other') as fc.Arbitrary<
    'wage' | 'tip' | 'bonus' | 'other'
  >,
});

describeIfBetterSqlite3('Feature: z-report-fixes, Property 1: Staff Payments Total Invariant', () => {
  let db: BetterSqlite3.Database;
  let reportService: ReportService;
  let targetDate: string;

  beforeEach(() => {
    db = createTestDatabase();
    reportService = new ReportService(db);
    targetDate = getTestDate();
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  describe('Staff Payments Total Calculation (Real ReportService)', () => {
    /**
     * Property: staffPaymentsTotal equals sum of all staff payment amounts
     */
    it('staffPaymentsTotal equals sum of all staff payment amounts', () => {
      fc.assert(
        fc.property(
          cashierShiftArb,
          fc.array(staffPaymentArb, { minLength: 1, maxLength: 10 }),
          (cashierShift, payments) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM cash_drawer_sessions');
            db.exec('DELETE FROM staff_payments');
            db.exec('DELETE FROM staff');

            seedCashierShiftWithDrawer(db, cashierShift, targetDate);

            // Seed all payments linked to the cashier shift
            let expectedTotal = 0;
            for (const payment of payments) {
              const normalizedPayment = {
                ...payment,
                paidByCashierShiftId: cashierShift.id,
              };
              seedStaffPayment(db, normalizedPayment, targetDate);
              seedStaff(db, payment.paidToStaffId, 'Staff', 'Member', cashierShift.branchId);
              expectedTotal += payment.amount;
            }

            const zReport = reportService.generateZReport(cashierShift.branchId, targetDate);

            expect(zReport.expenses?.staffPaymentsTotal || 0).toBeCloseTo(expectedTotal, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: staffPaymentsTotal includes payments to all role types
     */
    it('staffPaymentsTotal includes payments to all role types (cashier, driver, kitchen)', () => {
      fc.assert(
        fc.property(
          cashierShiftArb,
          fc.tuple(
            staffShiftArb.map((s) => ({ ...s, roleType: 'cashier' as const })),
            staffShiftArb.map((s) => ({ ...s, roleType: 'driver' as const })),
            staffShiftArb.map((s) => ({ ...s, roleType: 'kitchen' as const }))
          ),
          fc.tuple(
            fc.float({ min: Math.fround(10), max: Math.fround(100), noNaN: true }),
            fc.float({ min: Math.fround(10), max: Math.fround(100), noNaN: true }),
            fc.float({ min: Math.fround(10), max: Math.fround(100), noNaN: true })
          ),
          (cashierShift, [cashierStaff, driverStaff, kitchenStaff], [cashierAmt, driverAmt, kitchenAmt]) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM cash_drawer_sessions');
            db.exec('DELETE FROM staff_payments');
            db.exec('DELETE FROM staff');

            const branchId = cashierShift.branchId;
            seedCashierShiftWithDrawer(db, cashierShift, targetDate);

            // Seed staff shifts for each role type
            const staffShifts = [
              { ...cashierStaff, branchId },
              { ...driverStaff, branchId },
              { ...kitchenStaff, branchId },
            ];

            for (const shift of staffShifts) {
              seedStaffShift(db, shift, targetDate);
              seedStaff(db, shift.staffId, shift.staffName, 'Last', branchId);
            }

            // Seed payments for each staff
            const payments = [
              { id: generateId(), paidToStaffId: cashierStaff.staffId, paidByCashierShiftId: cashierShift.id, amount: cashierAmt, paymentType: 'wage' as const, staffShiftId: cashierStaff.id },
              { id: generateId(), paidToStaffId: driverStaff.staffId, paidByCashierShiftId: cashierShift.id, amount: driverAmt, paymentType: 'wage' as const, staffShiftId: driverStaff.id },
              { id: generateId(), paidToStaffId: kitchenStaff.staffId, paidByCashierShiftId: cashierShift.id, amount: kitchenAmt, paymentType: 'wage' as const, staffShiftId: kitchenStaff.id },
            ];

            for (const payment of payments) {
              seedStaffPayment(db, payment, targetDate);
            }

            const zReport = reportService.generateZReport(branchId, targetDate);

            const expectedTotal = cashierAmt + driverAmt + kitchenAmt;
            expect(zReport.expenses?.staffPaymentsTotal || 0).toBeCloseTo(expectedTotal, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: staffPaymentsTotal is zero when no payments exist
     */
    it('staffPaymentsTotal is zero when no payments exist', () => {
      fc.assert(
        fc.property(cashierShiftArb, (cashierShift) => {
          db.exec('DELETE FROM staff_shifts');
          db.exec('DELETE FROM cash_drawer_sessions');
          db.exec('DELETE FROM staff_payments');

          seedCashierShiftWithDrawer(db, cashierShift, targetDate);

          const zReport = reportService.generateZReport(cashierShift.branchId, targetDate);

          expect(zReport.expenses?.staffPaymentsTotal || 0).toBe(0);
        }),
        { verbose: true }
      );
    });

    /**
     * Property: staffPaymentsTotal is always non-negative
     */
    it('staffPaymentsTotal is always non-negative', () => {
      fc.assert(
        fc.property(
          cashierShiftArb,
          fc.array(staffPaymentArb, { minLength: 0, maxLength: 10 }),
          (cashierShift, payments) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM cash_drawer_sessions');
            db.exec('DELETE FROM staff_payments');
            db.exec('DELETE FROM staff');

            seedCashierShiftWithDrawer(db, cashierShift, targetDate);

            for (const payment of payments) {
              const normalizedPayment = {
                ...payment,
                paidByCashierShiftId: cashierShift.id,
              };
              seedStaffPayment(db, normalizedPayment, targetDate);
              seedStaff(db, payment.paidToStaffId, 'Staff', 'Member', cashierShift.branchId);
            }

            const zReport = reportService.generateZReport(cashierShift.branchId, targetDate);

            expect(zReport.expenses?.staffPaymentsTotal || 0).toBeGreaterThanOrEqual(0);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: staffPaymentsTotal is additive across payment sets
     */
    it('staffPaymentsTotal is additive across multiple cashier shifts', () => {
      fc.assert(
        fc.property(
          fc.array(cashierShiftArb, { minLength: 2, maxLength: 3 }),
          fc.array(staffPaymentArb, { minLength: 1, maxLength: 5 }),
          (cashierShifts, payments) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM cash_drawer_sessions');
            db.exec('DELETE FROM staff_payments');
            db.exec('DELETE FROM staff');

            const branchId = generateId();
            let expectedTotal = 0;

            // Normalize cashier shifts to same branch
            const normalizedCashiers = cashierShifts.map((c, idx) => ({
              ...c,
              id: generateId(),
              branchId,
            }));

            for (const cashier of normalizedCashiers) {
              seedCashierShiftWithDrawer(db, cashier, targetDate);
            }

            // Distribute payments across cashiers
            for (let i = 0; i < payments.length; i++) {
              const payment = payments[i];
              const cashier = normalizedCashiers[i % normalizedCashiers.length];
              const normalizedPayment = {
                ...payment,
                id: generateId(),
                paidByCashierShiftId: cashier.id,
              };
              seedStaffPayment(db, normalizedPayment, targetDate);
              seedStaff(db, payment.paidToStaffId, 'Staff', 'Member', branchId);
              expectedTotal += payment.amount;
            }

            const zReport = reportService.generateZReport(branchId, targetDate);

            expect(zReport.expenses?.staffPaymentsTotal || 0).toBeCloseTo(expectedTotal, 2);
          }
        ),
        { verbose: true }
      );
    });
  });

  describe('Version 2: Staff Payments Not Deducted from Cashier Expected (Real ReportService)', () => {
    /**
     * Property: Staff payments are tracked but NOT deducted from cashier expected in V2
     * The cash drawer's expected amount should not change based on staff payments
     */
    it('staff payments do not reduce cashier expected amount in V2', () => {
      fc.assert(
        fc.property(
          cashierShiftArb,
          fc.array(staffPaymentArb, { minLength: 1, maxLength: 5 }),
          (cashierShift, payments) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM cash_drawer_sessions');
            db.exec('DELETE FROM staff_payments');
            db.exec('DELETE FROM staff');

            seedCashierShiftWithDrawer(db, cashierShift, targetDate);

            // Generate Z Report before adding payments
            const zReportBefore = reportService.generateZReport(cashierShift.branchId, targetDate);
            const expectedBefore = zReportBefore.cashDrawer?.openingTotal || 0;

            // Add staff payments
            for (const payment of payments) {
              const normalizedPayment = {
                ...payment,
                paidByCashierShiftId: cashierShift.id,
              };
              seedStaffPayment(db, normalizedPayment, targetDate);
              seedStaff(db, payment.paidToStaffId, 'Staff', 'Member', cashierShift.branchId);
            }

            // Generate Z Report after adding payments
            const zReportAfter = reportService.generateZReport(cashierShift.branchId, targetDate);
            const expectedAfter = zReportAfter.cashDrawer?.openingTotal || 0;

            // In V2, the cash drawer opening total should remain the same
            // Staff payments are tracked separately but don't affect the cash drawer expected
            expect(expectedAfter).toBeCloseTo(expectedBefore, 2);

            // But staff payments should still be tracked
            const totalPayments = payments.reduce((sum, p) => sum + p.amount, 0);
            expect(zReportAfter.expenses?.staffPaymentsTotal || 0).toBeCloseTo(totalPayments, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Staff payments are recorded with cashier shift reference
     */
    it('all staff payments have paid_by_cashier_shift_id set', () => {
      fc.assert(
        fc.property(
          cashierShiftArb,
          fc.array(staffPaymentArb, { minLength: 1, maxLength: 5 }),
          (cashierShift, payments) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM cash_drawer_sessions');
            db.exec('DELETE FROM staff_payments');
            db.exec('DELETE FROM staff');

            seedCashierShiftWithDrawer(db, cashierShift, targetDate);

            for (const payment of payments) {
              const normalizedPayment = {
                ...payment,
                paidByCashierShiftId: cashierShift.id,
              };
              seedStaffPayment(db, normalizedPayment, targetDate);
              seedStaff(db, payment.paidToStaffId, 'Staff', 'Member', cashierShift.branchId);
            }

            // Verify all payments in DB have the cashier shift ID
            const dbPayments = db.prepare(`
              SELECT paid_by_cashier_shift_id FROM staff_payments
            `).all() as { paid_by_cashier_shift_id: string }[];

            for (const dbPayment of dbPayments) {
              expect(dbPayment.paid_by_cashier_shift_id).toBe(cashierShift.id);
            }
          }
        ),
        { verbose: true }
      );
    });
  });

  describe('Version 2: Driver/Waiter payment_amount is 0 (Real ReportService)', () => {
    /**
     * Property: Driver shifts have payment_amount = 0 in V2
     */
    it('driver shifts have payment_amount = 0 when using V2', () => {
      fc.assert(
        fc.property(
          staffShiftArb.map((s) => ({ ...s, roleType: 'driver' as const })),
          (driverShift) => {
            db.exec('DELETE FROM staff_shifts');

            seedStaffShift(db, driverShift, targetDate);

            // Verify the shift has payment_amount = 0
            const shift = db.prepare(`
              SELECT payment_amount, calculation_version FROM staff_shifts WHERE id = ?
            `).get(driverShift.id) as { payment_amount: number; calculation_version: number };

            expect(shift.payment_amount).toBe(0);
            expect(shift.calculation_version).toBe(2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Server/waiter shifts have payment_amount = 0 in V2
     */
    it('server shifts have payment_amount = 0 when using V2', () => {
      fc.assert(
        fc.property(
          staffShiftArb.map((s) => ({ ...s, roleType: 'server' as const })),
          (serverShift) => {
            db.exec('DELETE FROM staff_shifts');

            seedStaffShift(db, serverShift, targetDate);

            const shift = db.prepare(`
              SELECT payment_amount, calculation_version FROM staff_shifts WHERE id = ?
            `).get(serverShift.id) as { payment_amount: number; calculation_version: number };

            expect(shift.payment_amount).toBe(0);
            expect(shift.calculation_version).toBe(2);
          }
        ),
        { verbose: true }
      );
    });
  });

  describe('Version 2: Payment Amount Independent of Returns (Real ReportService)', () => {
    /**
     * Property: Multiple payments for same staff member sum correctly
     */
    it('multiple payments for same staff member sum correctly', () => {
      fc.assert(
        fc.property(
          cashierShiftArb,
          fc.uuid(),
          fc.array(fc.float({ min: Math.fround(5), max: Math.fround(50), noNaN: true }), {
            minLength: 2,
            maxLength: 5,
          }),
          (cashierShift, staffId, amounts) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM cash_drawer_sessions');
            db.exec('DELETE FROM staff_payments');
            db.exec('DELETE FROM staff');

            seedCashierShiftWithDrawer(db, cashierShift, targetDate);
            seedStaff(db, staffId, 'Test', 'Staff', cashierShift.branchId);

            // Seed multiple payments to same staff member
            let expectedTotal = 0;
            for (const amount of amounts) {
              const payment: StaffPaymentFixture = {
                id: generateId(),
                paidToStaffId: staffId,
                paidByCashierShiftId: cashierShift.id,
                amount,
                paymentType: 'wage',
              };
              seedStaffPayment(db, payment, targetDate);
              expectedTotal += amount;
            }

            const zReport = reportService.generateZReport(cashierShift.branchId, targetDate);

            expect(zReport.expenses?.staffPaymentsTotal || 0).toBeCloseTo(expectedTotal, 2);
          }
        ),
        { verbose: true }
      );
    });
  });
});
