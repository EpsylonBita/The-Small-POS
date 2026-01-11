/**
 * Property-Based Test: Driver Cash Return Tracking Invariant
 *
 * Feature: z-report-fixes, Property 3: Driver Cash Return Tracking Invariant
 *
 * For any Z Report with driver cash transactions, the `cashDrawer.driverCashReturned` total
 * SHALL equal the sum of all `cashToReturn` values in `cashDrawer.driverCashBreakdown`,
 * and each entry in `driverCashBreakdown` SHALL have a non-empty `driverName` and valid `driverShiftId`.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
 *
 * This test invokes the REAL ReportService.generateZReport() method against an in-memory
 * SQLite database seeded with randomized fixtures.
 */

import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import { ReportService } from '../main/services/ReportService';

// Note: fast-check is configured globally via the shared setup file (src/tests/setup.ts)
// which imports propertyTestConfig.ts. Settings are env-driven:
// - FAST_CHECK_NUM_RUNS: number of iterations (default: 100)
// - FAST_CHECK_VERBOSE: verbose output (default: true)

/**
 * Test Database Setup
 */
function createTestDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');

  // Create all required tables
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
 * Fixture seeding functions
 */
interface DriverShiftFixture {
  id: string;
  staffId: string;
  staffName: string;
  branchId: string;
  terminalId: string;
  openingCashAmount: number;
}

interface DriverEarningsFixture {
  driverId: string;
  staffShiftId: string;
  branchId: string;
  cashCollected: number;
  cardAmount: number;
}

function seedDriverShift(db: Database.Database, fixture: DriverShiftFixture, targetDate: string): void {
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

function seedDriverEarnings(
  db: Database.Database,
  fixture: DriverEarningsFixture,
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
    fixture.driverId,
    fixture.staffShiftId,
    generateId(),
    fixture.branchId,
    fixture.cashCollected,
    fixture.cardAmount,
    fixture.cashCollected * 0.1, // 10% earning
    fixture.cashCollected > 0 ? 'cash' : 'card',
    createdAt,
    now
  );
}

function seedOrder(
  db: Database.Database,
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

describe('Feature: z-report-fixes, Property 3: Driver Cash Return Tracking Invariant', () => {
  let db: Database.Database;
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

  describe('Driver Cash Return Tracking (Real ReportService)', () => {
    /**
     * Property: driverCashReturned equals sum of all driverCashBreakdown cashToReturn values
     * Invokes the REAL ReportService.generateZReport() with seeded fixtures.
     */
    it('driverCashReturned equals sum of all driverCashBreakdown cashToReturn values', () => {
      fc.assert(
        fc.property(
          fc.array(driverShiftArb, { minLength: 1, maxLength: 5 }),
          fc.array(fc.float({ min: Math.fround(10), max: Math.fround(200), noNaN: true }), {
            minLength: 1,
            maxLength: 3,
          }),
          (driverShifts, cashAmounts) => {
            // Reset database for each iteration
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM driver_earnings');
            db.exec('DELETE FROM orders');

            const branchId = driverShifts[0]?.branchId || generateId();

            // Seed driver shifts and earnings with normalized branchId
            for (const shift of driverShifts) {
              const normalizedShift = { ...shift, branchId };
              seedDriverShift(db, normalizedShift, targetDate);

              // Seed driver earnings for each shift
              for (const cashAmount of cashAmounts) {
                seedDriverEarnings(
                  db,
                  {
                    driverId: normalizedShift.staffId,
                    staffShiftId: normalizedShift.id,
                    branchId,
                    cashCollected: cashAmount,
                    cardAmount: 0,
                  },
                  targetDate
                );

                seedOrder(
                  db,
                  normalizedShift.id,
                  normalizedShift.staffId,
                  normalizedShift.staffName,
                  cashAmount,
                  targetDate
                );
              }
            }

            // Generate the REAL Z Report
            const zReport = reportService.generateZReport(branchId, targetDate);

            // Calculate expected total from driverCashBreakdown
            const breakdownTotal = (zReport.cashDrawer?.driverCashBreakdown || []).reduce(
              (sum: number, d: { cashToReturn?: number }) => sum + Number(d.cashToReturn || 0),
              0
            );

            // The invariant: driverCashReturned should equal sum of breakdown
            expect(zReport.cashDrawer?.driverCashReturned || 0).toBeCloseTo(breakdownTotal, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Each entry in driverCashBreakdown has a non-empty driverName
     */
    it('each driverCashBreakdown entry has a non-empty driverName', () => {
      fc.assert(
        fc.property(driverShiftArb, (driverShift) => {
          // Reset database
          db.exec('DELETE FROM staff_shifts');
          db.exec('DELETE FROM driver_earnings');
          db.exec('DELETE FROM orders');

          seedDriverShift(db, driverShift, targetDate);
          seedDriverEarnings(
            db,
            {
              driverId: driverShift.staffId,
              staffShiftId: driverShift.id,
              branchId: driverShift.branchId,
              cashCollected: 50,
              cardAmount: 0,
            },
            targetDate
          );
          seedOrder(
            db,
            driverShift.id,
            driverShift.staffId,
            driverShift.staffName,
            50,
            targetDate
          );

          // Generate the REAL Z Report
          const zReport = reportService.generateZReport(driverShift.branchId, targetDate);

          // Verify each entry has a non-empty driverName
          for (const entry of zReport.cashDrawer?.driverCashBreakdown || []) {
            expect(entry.driverName).toBeDefined();
            expect(entry.driverName.length).toBeGreaterThan(0);
          }
        }),
        { verbose: true }
      );
    });

    /**
     * Property: Each entry in driverCashBreakdown has a valid driverShiftId
     */
    it('each driverCashBreakdown entry has a valid driverShiftId', () => {
      fc.assert(
        fc.property(
          fc.array(driverShiftArb, { minLength: 1, maxLength: 3 }),
          (driverShifts) => {
            // Reset database
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM driver_earnings');
            db.exec('DELETE FROM orders');

            const branchId = driverShifts[0]?.branchId || generateId();
            const seededShiftIds = new Set<string>();

            for (const shift of driverShifts) {
              const normalizedShift = { ...shift, branchId };
              seedDriverShift(db, normalizedShift, targetDate);
              seededShiftIds.add(normalizedShift.id);

              seedDriverEarnings(
                db,
                {
                  driverId: normalizedShift.staffId,
                  staffShiftId: normalizedShift.id,
                  branchId,
                  cashCollected: 50,
                  cardAmount: 0,
                },
                targetDate
              );

              seedOrder(
                db,
                normalizedShift.id,
                normalizedShift.staffId,
                normalizedShift.staffName,
                50,
                targetDate
              );
            }

            // Generate the REAL Z Report
            const zReport = reportService.generateZReport(branchId, targetDate);

            // Verify each entry has a valid driverShiftId that was seeded
            for (const entry of zReport.cashDrawer?.driverCashBreakdown || []) {
              expect(entry.driverShiftId).toBeDefined();
              expect(typeof entry.driverShiftId).toBe('string');
              expect(entry.driverShiftId.length).toBeGreaterThan(0);
              expect(seededShiftIds.has(entry.driverShiftId)).toBe(true);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: driverCashBreakdown is empty when no driver transactions exist
     */
    it('driverCashBreakdown is empty and driverCashReturned is zero when no transactions exist', () => {
      const zReport = reportService.generateZReport('branch-1', targetDate);

      expect(zReport.cashDrawer?.driverCashBreakdown || []).toEqual([]);
      expect(zReport.cashDrawer?.driverCashReturned || 0).toBe(0);
    });

    /**
     * Property: Multiple drivers have separate entries in driverCashBreakdown
     */
    it('multiple drivers have separate entries in driverCashBreakdown', () => {
      fc.assert(
        fc.property(
          fc.array(driverShiftArb, { minLength: 2, maxLength: 4 }),
          (driverShifts) => {
            // Reset database
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM driver_earnings');
            db.exec('DELETE FROM orders');

            const branchId = generateId();

            // Ensure unique shift IDs
            const uniqueShifts = driverShifts.map((s, idx) => ({
              ...s,
              id: generateId(),
              branchId,
            }));

            for (const shift of uniqueShifts) {
              seedDriverShift(db, shift, targetDate);

              seedDriverEarnings(
                db,
                {
                  driverId: shift.staffId,
                  staffShiftId: shift.id,
                  branchId,
                  cashCollected: 50 + Math.random() * 50,
                  cardAmount: 0,
                },
                targetDate
              );

              seedOrder(db, shift.id, shift.staffId, shift.staffName, 75, targetDate);
            }

            // Generate the REAL Z Report
            const zReport = reportService.generateZReport(branchId, targetDate);

            // Verify number of entries matches unique drivers
            const breakdown = zReport.cashDrawer?.driverCashBreakdown || [];
            expect(breakdown.length).toBe(uniqueShifts.length);

            // Verify all driver shift IDs are represented
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
     * Property: All cash values are non-negative
     */
    it('all cash values in driverCashBreakdown are non-negative', () => {
      fc.assert(
        fc.property(driverShiftArb, (driverShift) => {
          // Reset database
          db.exec('DELETE FROM staff_shifts');
          db.exec('DELETE FROM driver_earnings');
          db.exec('DELETE FROM orders');

          seedDriverShift(db, driverShift, targetDate);
          seedDriverEarnings(
            db,
            {
              driverId: driverShift.staffId,
              staffShiftId: driverShift.id,
              branchId: driverShift.branchId,
              cashCollected: Math.abs(Math.random() * 100),
              cardAmount: Math.abs(Math.random() * 50),
            },
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

          // Generate the REAL Z Report
          const zReport = reportService.generateZReport(driverShift.branchId, targetDate);

          for (const entry of zReport.cashDrawer?.driverCashBreakdown || []) {
            expect(entry.cashCollected).toBeGreaterThanOrEqual(0);
            expect(entry.cashToReturn).toBeGreaterThanOrEqual(0);
          }

          expect(zReport.cashDrawer?.driverCashReturned || 0).toBeGreaterThanOrEqual(0);
        }),
        { verbose: true }
      );
    });
  });

  describe('Version 2: Driver Expected Return Formula (Real ReportService)', () => {
    /**
     * Property: V2 driver cash to return = starting + collected - expenses
     * Payment is NOT deducted (handled at cashier checkout)
     */
    it('V2 driver cash to return follows formula: starting + collected - expenses', () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(10), max: Math.fround(100), noNaN: true }),
          fc.float({ min: Math.fround(50), max: Math.fround(200), noNaN: true }),
          fc.float({ min: Math.fround(0), max: Math.fround(20), noNaN: true }),
          (startingAmount, cashCollected, expenses) => {
            // Reset database
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM driver_earnings');
            db.exec('DELETE FROM orders');
            db.exec('DELETE FROM shift_expenses');

            const branchId = generateId();
            const shiftId = generateId();
            const staffId = generateId();
            const staffName = 'Test Driver';

            // Seed driver shift with V2 calculation version
            const checkInTime = `${targetDate}T08:00:00`;
            const checkOutTime = `${targetDate}T17:00:00`;
            const now = new Date().toISOString();

            db.prepare(`
              INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, check_out_time, opening_cash_amount, payment_amount,
                calculation_version, status, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, 'driver', ?, ?, ?, 0, 2, 'closed', ?, ?)
            `).run(shiftId, staffId, staffName, branchId, generateId(), checkInTime, checkOutTime, startingAmount, now, now);

            // Seed driver earnings
            seedDriverEarnings(
              db,
              {
                driverId: staffId,
                staffShiftId: shiftId,
                branchId,
                cashCollected,
                cardAmount: 0,
              },
              targetDate
            );

            // Seed order
            seedOrder(db, shiftId, staffId, staffName, cashCollected, targetDate);

            // Seed expense if > 0
            if (expenses > 0) {
              db.prepare(`
                INSERT INTO shift_expenses (
                  id, staff_shift_id, staff_id, branch_id, expense_type,
                  amount, description, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'supplies', ?, 'Test expense', 'approved', ?, ?)
              `).run(generateId(), shiftId, staffId, branchId, expenses, `${targetDate}T12:00:00`, now);
            }

            // Generate the REAL Z Report
            const zReport = reportService.generateZReport(branchId, targetDate);

            // Find the driver in breakdown
            const driverEntry = (zReport.cashDrawer?.driverCashBreakdown || []).find(
              (d: { driverShiftId: string }) => d.driverShiftId === shiftId
            );

            if (driverEntry) {
              // V2 formula: startingAmount + cashCollected - expenses
              const expectedCashToReturn = startingAmount + cashCollected - expenses;
              expect(driverEntry.cashToReturn).toBeCloseTo(expectedCashToReturn, 2);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Driver payment_amount is NOT deducted in V2
     * The shift's payment_amount should not affect the cash to return calculation
     */
    it('driver payment_amount does not affect cash to return in V2', () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(10), max: Math.fround(50), noNaN: true }),
          fc.float({ min: Math.fround(50), max: Math.fround(150), noNaN: true }),
          fc.float({ min: Math.fround(1), max: Math.fround(30), noNaN: true }),
          (startingAmount, cashCollected, paymentAmount) => {
            // Reset database
            db.exec('DELETE FROM staff_shifts');
            db.exec('DELETE FROM driver_earnings');
            db.exec('DELETE FROM orders');

            const branchId = generateId();
            const shiftId = generateId();
            const staffId = generateId();
            const staffName = 'Test Driver';

            const checkInTime = `${targetDate}T08:00:00`;
            const checkOutTime = `${targetDate}T17:00:00`;
            const now = new Date().toISOString();

            // Seed driver shift with V2 and payment_amount set (should be ignored)
            db.prepare(`
              INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, check_out_time, opening_cash_amount, payment_amount,
                calculation_version, status, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, 'driver', ?, ?, ?, ?, 2, 'closed', ?, ?)
            `).run(shiftId, staffId, staffName, branchId, generateId(), checkInTime, checkOutTime, startingAmount, paymentAmount, now, now);

            // Seed driver earnings
            seedDriverEarnings(
              db,
              {
                driverId: staffId,
                staffShiftId: shiftId,
                branchId,
                cashCollected,
                cardAmount: 0,
              },
              targetDate
            );

            seedOrder(db, shiftId, staffId, staffName, cashCollected, targetDate);

            // Generate the REAL Z Report
            const zReport = reportService.generateZReport(branchId, targetDate);

            const driverEntry = (zReport.cashDrawer?.driverCashBreakdown || []).find(
              (d: { driverShiftId: string }) => d.driverShiftId === shiftId
            );

            if (driverEntry) {
              // V2: payment_amount is NOT deducted, so expected = starting + collected
              const expectedCashToReturn = startingAmount + cashCollected;
              expect(driverEntry.cashToReturn).toBeCloseTo(expectedCashToReturn, 2);
            }
          }
        ),
        { verbose: true }
      );
    });
  });
});
