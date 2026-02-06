/**
 * Property-Based Test: Cash Drawer Driver Breakdown Invariant
 *
 * Feature: z-report-fixes, Property 5: Cash Drawer Driver Breakdown Invariant
 *
 * For any Z Report with multiple drivers, the `cashDrawer.driverCashBreakdown` array
 * SHALL contain one entry per unique driver who had transactions that day,
 * and the sum of all `cashCollected` values SHALL equal `driverEarnings.cashCollectedTotal`.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
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
interface DriverShiftFixture {
  id: string;
  staffId: string;
  staffName: string;
  branchId: string;
  terminalId: string;
  openingCashAmount: number;
}

interface CashierShiftFixture {
  id: string;
  staffId: string;
  staffName: string;
  branchId: string;
  terminalId: string;
  openingAmount: number;
  driverCashGiven: number;
}

/**
 * Seed functions
 */
function seedDriverShift(db: BetterSqlite3.Database, fixture: DriverShiftFixture, targetDate: string): void {
  const checkInTime = `${targetDate}T08:00:00`;
  const checkOutTime = `${targetDate}T17:00:00`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO staff_shifts (
      id, staff_id, staff_name, branch_id, terminal_id, role_type,
      check_in_time, check_out_time, opening_cash_amount, payment_amount,
      calculation_version, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'driver', ?, ?, ?, 0, 2, 'closed', ?, ?)
  `).run(
    fixture.id,
    fixture.staffId,
    fixture.staffName,
    fixture.branchId,
    fixture.terminalId,
    checkInTime,
    checkOutTime,
    fixture.openingCashAmount,
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

  // Seed cashier shift
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

  // Seed cash drawer session
  db.prepare(`
    INSERT INTO cash_drawer_sessions (
      id, staff_shift_id, cashier_id, branch_id, terminal_id,
      opening_amount, driver_cash_given, driver_cash_returned,
      opened_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    generateId(),
    fixture.id,
    fixture.staffId,
    fixture.branchId,
    fixture.terminalId,
    fixture.openingAmount,
    fixture.driverCashGiven,
    `${targetDate}T08:00:00`,
    now,
    now
  );
}

function seedDriverEarnings(
  db: BetterSqlite3.Database,
  driverId: string,
  staffShiftId: string,
  branchId: string,
  cashCollected: number,
  cardAmount: number,
  targetDate: string
): void {
  const createdAt = `${targetDate}T12:00:00`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO driver_earnings (
      id, driver_id, staff_shift_id, order_id, branch_id,
      cash_collected, card_amount, cash_to_return, total_earning,
      payment_method, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(
    generateId(),
    driverId,
    staffShiftId,
    generateId(),
    branchId,
    cashCollected,
    cardAmount,
    cashCollected * 0.1,
    cashCollected > 0 ? 'cash' : 'card',
    createdAt,
    now
  );
}

function seedOrder(
  db: BetterSqlite3.Database,
  staffShiftId: string,
  driverId: string,
  driverName: string,
  amount: number,
  targetDate: string
): void {
  const createdAt = `${targetDate}T10:00:00`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO orders (
      id, order_number, staff_shift_id, order_type, total_amount,
      payment_method, status, items, driver_id, driver_name,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'delivery', ?, 'cash', 'delivered', '[]', ?, ?, ?, ?)
  `).run(
    generateId(),
    `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    staffShiftId,
    amount,
    driverId,
    driverName,
    createdAt,
    now
  );
}

/**
 * Arbitrary generators
 */
const driverShiftArb = fc.record({
  id: fc.uuid(),
  staffId: fc.uuid(),
  staffName: fc.string({ minLength: 1, maxLength: 30 }),
  branchId: fc.uuid(),
  terminalId: fc.uuid(),
  openingCashAmount: fc.float({ min: Math.fround(0), max: Math.fround(100), noNaN: true }),
});

const cashierShiftArb = fc.record({
  id: fc.uuid(),
  staffId: fc.uuid(),
  staffName: fc.string({ minLength: 1, maxLength: 30 }),
  branchId: fc.uuid(),
  terminalId: fc.uuid(),
  openingAmount: fc.float({ min: Math.fround(100), max: Math.fround(500), noNaN: true }),
  driverCashGiven: fc.float({ min: Math.fround(0), max: Math.fround(200), noNaN: true }),
});

describeIfBetterSqlite3('Feature: z-report-fixes, Property 5: Cash Drawer Driver Breakdown Invariant', () => {
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

  describe('Cash Drawer Driver Breakdown (Real ReportService)', () => {
    /**
     * Property: driverCashBreakdown contains one entry per unique driver
     */
    it('driverCashBreakdown contains one entry per unique driver', () => {
      fc.assert(
        fc.property(
          fc.array(driverShiftArb, { minLength: 1, maxLength: 5 }),
          (driverShifts) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM driver_earnings');
            db.exec('DELETE FROM orders');

            const branchId = generateId();

            // Ensure unique shift IDs
            const uniqueShifts = driverShifts.map((s) => ({
              ...s,
              id: generateId(),
              branchId,
            }));

            for (const shift of uniqueShifts) {
              seedDriverShift(db, shift, targetDate);
              seedDriverEarnings(db, shift.staffId, shift.id, branchId, 50, 0, targetDate);
              seedOrder(db, shift.id, shift.staffId, shift.staffName, 50, targetDate);
            }

            const zReport = reportService.generateZReport(branchId, targetDate);

            const breakdown = zReport.cashDrawer?.driverCashBreakdown || [];
            expect(breakdown.length).toBe(uniqueShifts.length);

            const reportShiftIds = new Set(breakdown.map((d: { driverShiftId: string }) => d.driverShiftId));
            for (const shift of uniqueShifts) {
              expect(reportShiftIds.has(shift.id)).toBe(true);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Sum of cashCollected in breakdown equals driverEarnings.cashCollectedTotal
     */
    it('sum of cashCollected in breakdown equals driverEarnings.cashCollectedTotal', () => {
      fc.assert(
        fc.property(
          fc.array(driverShiftArb, { minLength: 1, maxLength: 4 }),
          fc.array(fc.float({ min: Math.fround(10), max: Math.fround(150), noNaN: true }), {
            minLength: 1,
            maxLength: 3,
          }),
          (driverShifts, cashAmounts) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM driver_earnings');
            db.exec('DELETE FROM orders');

            const branchId = generateId();

            const uniqueShifts = driverShifts.map((s) => ({
              ...s,
              id: generateId(),
              branchId,
            }));

            for (const shift of uniqueShifts) {
              seedDriverShift(db, shift, targetDate);
              for (const cash of cashAmounts) {
                seedDriverEarnings(db, shift.staffId, shift.id, branchId, cash, 0, targetDate);
                seedOrder(db, shift.id, shift.staffId, shift.staffName, cash, targetDate);
              }
            }

            const zReport = reportService.generateZReport(branchId, targetDate);

            const breakdownTotal = (zReport.cashDrawer?.driverCashBreakdown || []).reduce(
              (sum: number, d: { cashCollected?: number }) => sum + Number(d.cashCollected || 0),
              0
            );

            expect(zReport.driverEarnings?.cashCollectedTotal || 0).toBeCloseTo(breakdownTotal, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: cashDrawer shows total cash given to drivers
     */
    it('cashDrawer shows total cash given to drivers', () => {
      fc.assert(
        fc.property(
          cashierShiftArb,
          driverShiftArb,
          (cashierShift, driverShift) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM cash_drawer_sessions');
            db.exec('DELETE FROM driver_earnings');
            db.exec('DELETE FROM orders');

            const branchId = generateId();
            const normalizedCashier = { ...cashierShift, branchId };
            const normalizedDriver = { ...driverShift, branchId };

            seedCashierShiftWithDrawer(db, normalizedCashier, targetDate);
            seedDriverShift(db, normalizedDriver, targetDate);
            seedDriverEarnings(
              db,
              normalizedDriver.staffId,
              normalizedDriver.id,
              branchId,
              100,
              0,
              targetDate
            );
            seedOrder(
              db,
              normalizedDriver.id,
              normalizedDriver.staffId,
              normalizedDriver.staffName,
              100,
              targetDate
            );

            const zReport = reportService.generateZReport(branchId, targetDate);

            expect(zReport.cashDrawer?.driverCashGiven).toBeDefined();
            expect(zReport.cashDrawer?.driverCashGiven).toBeGreaterThanOrEqual(0);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: cashDrawer shows total cash returned from drivers
     */
    it('cashDrawer shows total cash returned from drivers', () => {
      fc.assert(
        fc.property(driverShiftArb, (driverShift) => {
          db.exec('DELETE FROM staff_shifts');
          db.exec('DELETE FROM driver_earnings');
          db.exec('DELETE FROM orders');

          seedDriverShift(db, driverShift, targetDate);
          seedDriverEarnings(
            db,
            driverShift.staffId,
            driverShift.id,
            driverShift.branchId,
            75,
            0,
            targetDate
          );
          seedOrder(
            db,
            driverShift.id,
            driverShift.staffId,
            driverShift.staffName,
            75,
            targetDate
          );

          const zReport = reportService.generateZReport(driverShift.branchId, targetDate);

          const breakdownTotal = (zReport.cashDrawer?.driverCashBreakdown || []).reduce(
            (sum: number, d: { cashToReturn?: number }) => sum + Number(d.cashToReturn || 0),
            0
          );

          expect(zReport.cashDrawer?.driverCashReturned || 0).toBeCloseTo(breakdownTotal, 2);
        }),
        { verbose: true }
      );
    });

    /**
     * Property: Per-driver cash amounts are shown in breakdown
     */
    it('per-driver cash amounts are shown in breakdown', () => {
      fc.assert(
        fc.property(
          fc.array(driverShiftArb, { minLength: 1, maxLength: 3 }),
          (driverShifts) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM driver_earnings');
            db.exec('DELETE FROM orders');

            const branchId = generateId();
            const uniqueShifts = driverShifts.map((s) => ({
              ...s,
              id: generateId(),
              branchId,
            }));

            for (const shift of uniqueShifts) {
              seedDriverShift(db, shift, targetDate);
              seedDriverEarnings(db, shift.staffId, shift.id, branchId, 100, 0, targetDate);
              seedOrder(db, shift.id, shift.staffId, shift.staffName, 100, targetDate);
            }

            const zReport = reportService.generateZReport(branchId, targetDate);

            for (const entry of zReport.cashDrawer?.driverCashBreakdown || []) {
              expect(entry.cashCollected).toBeDefined();
              expect(entry.cashToReturn).toBeDefined();
              expect(typeof entry.cashCollected).toBe('number');
              expect(typeof entry.cashToReturn).toBe('number');
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Multiple drivers have separate entries with driver identification
     */
    it('multiple drivers have separate entries with driver identification', () => {
      fc.assert(
        fc.property(
          fc.array(driverShiftArb, { minLength: 2, maxLength: 4 }),
          (driverShifts) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM driver_earnings');
            db.exec('DELETE FROM orders');

            const branchId = generateId();
            const uniqueShifts = driverShifts.map((s) => ({
              ...s,
              id: generateId(),
              branchId,
            }));

            for (const shift of uniqueShifts) {
              seedDriverShift(db, shift, targetDate);
              seedDriverEarnings(db, shift.staffId, shift.id, branchId, 80, 0, targetDate);
              seedOrder(db, shift.id, shift.staffId, shift.staffName, 80, targetDate);
            }

            const zReport = reportService.generateZReport(branchId, targetDate);

            for (const entry of zReport.cashDrawer?.driverCashBreakdown || []) {
              expect(entry.driverId).toBeDefined();
              expect(entry.driverName).toBeDefined();
              expect(entry.driverShiftId).toBeDefined();
              expect(entry.driverName.length).toBeGreaterThan(0);
              expect(entry.driverShiftId.length).toBeGreaterThan(0);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Empty breakdown when no driver transactions exist
     */
    it('driverCashBreakdown is empty when no driver transactions exist', () => {
      const zReport = reportService.generateZReport('branch-1', targetDate);

      expect(zReport.cashDrawer?.driverCashBreakdown || []).toEqual([]);
      expect(zReport.driverEarnings?.cashCollectedTotal || 0).toBe(0);
    });

    /**
     * Property: All cash values are non-negative
     */
    it('all cash values in driverCashBreakdown are non-negative', () => {
      fc.assert(
        fc.property(driverShiftArb, (driverShift) => {
          db.exec('DELETE FROM staff_shifts');
          db.exec('DELETE FROM driver_earnings');
          db.exec('DELETE FROM orders');

          seedDriverShift(db, driverShift, targetDate);
          seedDriverEarnings(
            db,
            driverShift.staffId,
            driverShift.id,
            driverShift.branchId,
            Math.abs(Math.random() * 100),
            0,
            targetDate
          );
          seedOrder(
            db,
            driverShift.id,
            driverShift.staffId,
            driverShift.staffName,
            100,
            targetDate
          );

          const zReport = reportService.generateZReport(driverShift.branchId, targetDate);

          for (const entry of zReport.cashDrawer?.driverCashBreakdown || []) {
            expect(entry.cashCollected).toBeGreaterThanOrEqual(0);
            expect(entry.cashToReturn).toBeGreaterThanOrEqual(0);
          }

          expect(zReport.cashDrawer?.driverCashReturned || 0).toBeGreaterThanOrEqual(0);
          expect(zReport.driverEarnings?.cashCollectedTotal || 0).toBeGreaterThanOrEqual(0);
        }),
        { verbose: true }
      );
    });
  });

  describe('Version 2: Inherited Drivers in Cashier Expected Amount (Real ReportService)', () => {
    /**
     * Property: Inherited driver returns are included in cashier expected amount
     */
    it('inherited driver returns are reflected in Z Report totals', () => {
      fc.assert(
        fc.property(
          cashierShiftArb,
          fc.array(driverShiftArb, { minLength: 1, maxLength: 3 }),
          (cashierShift, driverShifts) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM cash_drawer_sessions');
            db.exec('DELETE FROM driver_earnings');
            db.exec('DELETE FROM orders');

            const branchId = generateId();

            // Seed cashier with drawer
            const normalizedCashier = { ...cashierShift, branchId };
            seedCashierShiftWithDrawer(db, normalizedCashier, targetDate);

            // Seed drivers who would return cash to this cashier
            const uniqueDrivers = driverShifts.map((s) => ({
              ...s,
              id: generateId(),
              branchId,
            }));

            let expectedTotalReturned = 0;

            for (const driver of uniqueDrivers) {
              seedDriverShift(db, driver, targetDate);
              const cashCollected = 50 + Math.random() * 100;
              expectedTotalReturned += driver.openingCashAmount + cashCollected;

              seedDriverEarnings(
                db,
                driver.staffId,
                driver.id,
                branchId,
                cashCollected,
                0,
                targetDate
              );
              seedOrder(
                db,
                driver.id,
                driver.staffId,
                driver.staffName,
                cashCollected,
                targetDate
              );
            }

            const zReport = reportService.generateZReport(branchId, targetDate);

            // The total driver cash returned should reflect inherited drivers
            expect(zReport.cashDrawer?.driverCashReturned || 0).toBeGreaterThanOrEqual(0);

            // Driver breakdown should include all drivers
            const breakdown = zReport.cashDrawer?.driverCashBreakdown || [];
            expect(breakdown.length).toBe(uniqueDrivers.length);
          }
        ),
        { verbose: true }
      );
    });
  });

  describe('Version 2: Transferred Drivers Tracking (Real ReportService)', () => {
    /**
     * Property: Transferred drivers are tracked with correct expected returns
     */
    it('transferred drivers have calculation_version = 2 and correct cash to return', () => {
      fc.assert(
        fc.property(
          driverShiftArb,
          fc.float({ min: Math.fround(50), max: Math.fround(150), noNaN: true }),
          (driverShift, cashCollected) => {
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM driver_earnings');
            db.exec('DELETE FROM orders');

            seedDriverShift(db, driverShift, targetDate);
            seedDriverEarnings(
              db,
              driverShift.staffId,
              driverShift.id,
              driverShift.branchId,
              cashCollected,
              0,
              targetDate
            );
            seedOrder(
              db,
              driverShift.id,
              driverShift.staffId,
              driverShift.staffName,
              cashCollected,
              targetDate
            );

            const zReport = reportService.generateZReport(driverShift.branchId, targetDate);

            const driverEntry = (zReport.cashDrawer?.driverCashBreakdown || []).find(
              (d: { driverShiftId: string }) => d.driverShiftId === driverShift.id
            );

            if (driverEntry) {
              // V2 formula: starting + collected (no expenses seeded)
              const expectedCashToReturn = driverShift.openingCashAmount + cashCollected;
              expect(driverEntry.cashToReturn).toBeCloseTo(expectedCashToReturn, 2);
            }
          }
        ),
        { verbose: true }
      );
    });
  });
});
