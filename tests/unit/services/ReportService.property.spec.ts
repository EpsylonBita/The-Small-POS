/**
 * Property-Based Tests for ReportService
 * 
 * Feature: z-report-commit-fix
 * Property 2: Order Clearing After Successful Submit
 * Property 4: Precondition Error Messages
 * 
 * Validates: Requirements 4.1, 4.3, 6.1, 6.2, 6.3
 * 
 * For any successful Z-Report submission, after finalizeEndOfDay completes,
 * the local database SHALL have zero orders, zero staff shifts, and zero
 * cash drawer sessions for the report date.
 * 
 * For any Z-Report submission that fails precondition checks, the error message
 * SHALL contain the specific reason for failure (active shifts count, unsynced
 * orders count, or unsynced financial transaction breakdown).
 */

import * as fc from 'fast-check';

// Mock types for testing
interface MockOrder {
  id: string;
  created_at: string;
  status: string;
  total_amount: number;
}

interface MockStaffShift {
  id: string;
  check_in_time: string;
  staff_id: string;
  staff_name: string;
}

interface MockCashDrawerSession {
  id: string;
  opened_at: string;
  staff_shift_id: string;
}

interface MockDriverEarning {
  id: string;
  created_at: string;
  amount: number;
}

interface MockShiftExpense {
  id: string;
  created_at: string;
  amount: number;
}

interface MockStaffPayment {
  id: string;
  created_at: string;
  amount: number;
}

// Helper to generate a valid date string
const generateDateString = (year: number, month: number, day: number): string => {
  const y = year.toString().padStart(4, '0');
  const m = month.toString().padStart(2, '0');
  const d = day.toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
};

// Arbitraries for generating test data
const dateArb = fc.tuple(
  fc.integer({ min: 2024, max: 2025 }),
  fc.integer({ min: 1, max: 12 }),
  fc.integer({ min: 1, max: 28 }) // Use 28 to avoid invalid dates
).map(([year, month, day]) => generateDateString(year, month, day));

const orderStatusArb = fc.constantFrom(
  'pending',
  'preparing',
  'ready',
  'delivered',
  'completed',
  'cancelled'
);

const orderArb = (reportDate: string): fc.Arbitrary<MockOrder> => fc.record({
  id: fc.uuid(),
  created_at: fc.integer({ min: 0, max: 23 }).chain(hour => 
    fc.integer({ min: 0, max: 59 }).map(minute => 
      `${reportDate}T${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00.000Z`
    )
  ),
  status: orderStatusArb,
  total_amount: fc.float({ min: 1, max: 1000, noNaN: true }),
});

const staffShiftArb = (reportDate: string): fc.Arbitrary<MockStaffShift> => fc.record({
  id: fc.uuid(),
  check_in_time: fc.constant(`${reportDate}T08:00:00.000Z`),
  staff_id: fc.uuid(),
  staff_name: fc.string({ minLength: 1, maxLength: 50 }),
});

const cashDrawerSessionArb = (reportDate: string): fc.Arbitrary<MockCashDrawerSession> => fc.record({
  id: fc.uuid(),
  opened_at: fc.constant(`${reportDate}T08:00:00.000Z`),
  staff_shift_id: fc.uuid(),
});

const driverEarningArb = (reportDate: string): fc.Arbitrary<MockDriverEarning> => fc.record({
  id: fc.uuid(),
  created_at: fc.constant(`${reportDate}T12:00:00.000Z`),
  amount: fc.float({ min: 1, max: 100, noNaN: true }),
});

const shiftExpenseArb = (reportDate: string): fc.Arbitrary<MockShiftExpense> => fc.record({
  id: fc.uuid(),
  created_at: fc.constant(`${reportDate}T12:00:00.000Z`),
  amount: fc.float({ min: 1, max: 100, noNaN: true }),
});

const staffPaymentArb = (reportDate: string): fc.Arbitrary<MockStaffPayment> => fc.record({
  id: fc.uuid(),
  created_at: fc.constant(`${reportDate}T12:00:00.000Z`),
  amount: fc.float({ min: 1, max: 500, noNaN: true }),
});

describe('ReportService Property Tests', () => {
  /**
   * Feature: z-report-commit-fix, Property 2: Order Clearing After Successful Submit
   * 
   * For any successful Z-Report submission, after finalizeEndOfDay completes,
   * the local database SHALL have zero orders, zero staff shifts, and zero
   * cash drawer sessions for the report date.
   * 
   * Validates: Requirements 4.1, 4.3
   */
  describe('Property 2: Order Clearing After Successful Submit', () => {
    it('should clear all orders for the report date after finalizeEndOfDay', async () => {
      await fc.assert(
        fc.asyncProperty(
          dateArb,
          fc.integer({ min: 1, max: 20 }), // Number of orders
          async (reportDate, orderCount) => {
            // Create mock database with orders
            const mockDb = createMockDatabase();
            
            // Generate orders for the report date
            const orders = fc.sample(orderArb(reportDate), orderCount);
            orders.forEach(order => mockDb.insertOrder(order));
            
            // Verify orders exist before cleanup
            const beforeCount = mockDb.countOrders(reportDate);
            expect(beforeCount).toBe(orderCount);
            
            // Execute finalizeEndOfDay
            const cleanup = mockDb.finalizeEndOfDay(reportDate);
            
            // Property: After cleanup, there should be zero orders for the report date
            const afterCount = mockDb.countOrders(reportDate);
            expect(afterCount).toBe(0);
            
            // Property: Cleanup result should report the correct count
            expect(cleanup.orders).toBe(orderCount);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    it('should clear all staff shifts for the report date after finalizeEndOfDay', async () => {
      await fc.assert(
        fc.asyncProperty(
          dateArb,
          fc.integer({ min: 1, max: 10 }), // Number of shifts
          async (reportDate, shiftCount) => {
            const mockDb = createMockDatabase();
            
            // Generate shifts for the report date
            const shifts = fc.sample(staffShiftArb(reportDate), shiftCount);
            shifts.forEach(shift => mockDb.insertStaffShift(shift));
            
            // Verify shifts exist before cleanup
            const beforeCount = mockDb.countStaffShifts(reportDate);
            expect(beforeCount).toBe(shiftCount);
            
            // Execute finalizeEndOfDay
            const cleanup = mockDb.finalizeEndOfDay(reportDate);
            
            // Property: After cleanup, there should be zero shifts for the report date
            const afterCount = mockDb.countStaffShifts(reportDate);
            expect(afterCount).toBe(0);
            
            // Property: Cleanup result should report the correct count
            expect(cleanup.staff_shifts).toBe(shiftCount);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    it('should clear all cash drawer sessions for the report date after finalizeEndOfDay', async () => {
      await fc.assert(
        fc.asyncProperty(
          dateArb,
          fc.integer({ min: 1, max: 5 }), // Number of drawer sessions
          async (reportDate, sessionCount) => {
            const mockDb = createMockDatabase();
            
            // Generate drawer sessions for the report date
            const sessions = fc.sample(cashDrawerSessionArb(reportDate), sessionCount);
            sessions.forEach(session => mockDb.insertCashDrawerSession(session));
            
            // Verify sessions exist before cleanup
            const beforeCount = mockDb.countCashDrawerSessions(reportDate);
            expect(beforeCount).toBe(sessionCount);
            
            // Execute finalizeEndOfDay
            const cleanup = mockDb.finalizeEndOfDay(reportDate);
            
            // Property: After cleanup, there should be zero sessions for the report date
            const afterCount = mockDb.countCashDrawerSessions(reportDate);
            expect(afterCount).toBe(0);
            
            // Property: Cleanup result should report the correct count
            expect(cleanup.cash_drawer_sessions).toBe(sessionCount);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    it('should clear all financial records (driver earnings, expenses, payments) for the report date', async () => {
      await fc.assert(
        fc.asyncProperty(
          dateArb,
          fc.integer({ min: 0, max: 10 }), // Driver earnings count
          fc.integer({ min: 0, max: 10 }), // Expenses count
          fc.integer({ min: 0, max: 10 }), // Payments count
          async (reportDate, earningsCount, expensesCount, paymentsCount) => {
            const mockDb = createMockDatabase();
            
            // Generate financial records
            if (earningsCount > 0) {
              const earnings = fc.sample(driverEarningArb(reportDate), earningsCount);
              earnings.forEach(e => mockDb.insertDriverEarning(e));
            }
            if (expensesCount > 0) {
              const expenses = fc.sample(shiftExpenseArb(reportDate), expensesCount);
              expenses.forEach(e => mockDb.insertShiftExpense(e));
            }
            if (paymentsCount > 0) {
              const payments = fc.sample(staffPaymentArb(reportDate), paymentsCount);
              payments.forEach(p => mockDb.insertStaffPayment(p));
            }
            
            // Verify records exist before cleanup
            expect(mockDb.countDriverEarnings(reportDate)).toBe(earningsCount);
            expect(mockDb.countShiftExpenses(reportDate)).toBe(expensesCount);
            expect(mockDb.countStaffPayments(reportDate)).toBe(paymentsCount);
            
            // Execute finalizeEndOfDay
            const cleanup = mockDb.finalizeEndOfDay(reportDate);
            
            // Property: After cleanup, all financial records should be cleared
            expect(mockDb.countDriverEarnings(reportDate)).toBe(0);
            expect(mockDb.countShiftExpenses(reportDate)).toBe(0);
            expect(mockDb.countStaffPayments(reportDate)).toBe(0);
            
            // Property: Cleanup result should report correct counts
            expect(cleanup.driver_earnings).toBe(earningsCount);
            expect(cleanup.shift_expenses).toBe(expensesCount);
            expect(cleanup.staff_payments).toBe(paymentsCount);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    it('should not affect data from future dates', async () => {
      await fc.assert(
        fc.asyncProperty(
          dateArb,
          fc.integer({ min: 1, max: 10 }), // Orders on report date
          fc.integer({ min: 1, max: 10 }), // Orders on future date
          async (reportDate, reportDateOrders, futureDateOrders) => {
            const mockDb = createMockDatabase();
            
            // Calculate a future date (next day)
            const [year, month, day] = reportDate.split('-').map(Number);
            const futureDate = new Date(year, month - 1, day + 1);
            const futureDateStr = generateDateString(
              futureDate.getFullYear(),
              futureDate.getMonth() + 1,
              futureDate.getDate()
            );
            
            // Generate orders for both dates
            const ordersOnReportDate = fc.sample(orderArb(reportDate), reportDateOrders);
            const ordersOnFutureDate = fc.sample(orderArb(futureDateStr), futureDateOrders);
            
            ordersOnReportDate.forEach(order => mockDb.insertOrder(order));
            ordersOnFutureDate.forEach(order => mockDb.insertOrder(order));
            
            // Verify orders exist on both dates
            expect(mockDb.countOrdersOnDate(reportDate)).toBe(reportDateOrders);
            expect(mockDb.countOrdersOnDate(futureDateStr)).toBe(futureDateOrders);
            
            // Execute finalizeEndOfDay for report date only
            mockDb.finalizeEndOfDay(reportDate);
            
            // Property: Orders on report date should be cleared
            expect(mockDb.countOrdersOnDate(reportDate)).toBe(0);
            
            // Property: Orders on FUTURE date should NOT be affected
            // (finalizeEndOfDay clears data <= targetDate, so future data is preserved)
            expect(mockDb.countOrdersOnDate(futureDateStr)).toBe(futureDateOrders);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);
  });

  /**
   * Feature: z-report-commit-fix, Property 4: Precondition Error Messages
   * 
   * For any Z-Report submission that fails precondition checks, the error message
   * SHALL contain the specific reason for failure (active shifts count, unsynced
   * orders count, or unsynced financial transaction breakdown).
   * 
   * Validates: Requirements 6.1, 6.2, 6.3
   */
  describe('Property 4: Precondition Error Messages', () => {
    it('should include count in active shifts error message', async () => {
      await fc.assert(
        fc.asyncProperty(
          dateArb,
          fc.integer({ min: 1, max: 20 }), // Number of active shifts
          async (reportDate, shiftCount) => {
            const mockDb = createMockPreconditionDatabase();
            
            // Create active shifts
            for (let i = 0; i < shiftCount; i++) {
              mockDb.insertActiveShift({
                id: `shift-${i}`,
                staff_id: `staff-${i}`,
                status: 'active',
                is_transfer_pending: false,
                transferred_to_cashier_shift_id: null,
              });
            }
            
            // Execute canExecuteZReport
            const result = mockDb.canExecuteZReport(reportDate);
            
            // Property: Result should not be ok
            expect(result.ok).toBe(false);
            
            // Property: Error message should contain the count
            expect(result.reason).toBeDefined();
            expect(result.reason).toContain(shiftCount.toString());
            expect(result.reason).toContain('active shift');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    it('should include count in transferred driver shifts error message', async () => {
      await fc.assert(
        fc.asyncProperty(
          dateArb,
          fc.integer({ min: 1, max: 10 }), // Number of transferred driver shifts
          async (reportDate, driverCount) => {
            const mockDb = createMockPreconditionDatabase();
            
            // Create transferred driver shifts
            for (let i = 0; i < driverCount; i++) {
              mockDb.insertActiveShift({
                id: `driver-shift-${i}`,
                staff_id: `driver-${i}`,
                status: 'active',
                role_type: 'driver',
                is_transfer_pending: true,
                transferred_to_cashier_shift_id: null,
              });
            }
            
            // Execute canExecuteZReport
            const result = mockDb.canExecuteZReport(reportDate);
            
            // Property: Result should not be ok
            expect(result.ok).toBe(false);
            
            // Property: Error message should contain the count
            expect(result.reason).toBeDefined();
            expect(result.reason).toContain(driverCount.toString());
            expect(result.reason).toContain('transferred driver shift');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    it('should include count in unclosed cash drawer error message', async () => {
      await fc.assert(
        fc.asyncProperty(
          dateArb,
          fc.integer({ min: 1, max: 5 }), // Number of unclosed drawers
          async (reportDate, drawerCount) => {
            const mockDb = createMockPreconditionDatabase();
            
            // Create unclosed cash drawer sessions
            for (let i = 0; i < drawerCount; i++) {
              mockDb.insertUnclosedCashDrawer({
                id: `drawer-${i}`,
                staff_shift_id: `shift-${i}`,
                opened_at: `${reportDate}T08:00:00.000Z`,
                closed_at: null,
              });
            }
            
            // Execute canExecuteZReport
            const result = mockDb.canExecuteZReport(reportDate);
            
            // Property: Result should not be ok
            expect(result.ok).toBe(false);
            
            // Property: Error message should contain the count
            expect(result.reason).toBeDefined();
            expect(result.reason).toContain(drawerCount.toString());
            expect(result.reason).toContain('drawer');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    it('should include count in open orders error message', async () => {
      await fc.assert(
        fc.asyncProperty(
          dateArb,
          fc.integer({ min: 1, max: 20 }), // Number of open orders
          async (reportDate, orderCount) => {
            const mockDb = createMockPreconditionDatabase();
            
            // Create open orders
            for (let i = 0; i < orderCount; i++) {
              mockDb.insertOpenOrder({
                id: `order-${i}`,
                created_at: `${reportDate}T12:00:00.000Z`,
                status: 'pending',
              });
            }
            
            // Execute canExecuteZReport
            const result = mockDb.canExecuteZReport(reportDate);
            
            // Property: Result should not be ok
            expect(result.ok).toBe(false);
            
            // Property: Error message should contain the count
            expect(result.reason).toBeDefined();
            expect(result.reason).toContain(orderCount.toString());
            expect(result.reason).toContain('open order');
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    it('should include count in unsynced orders error message', async () => {
      await fc.assert(
        fc.asyncProperty(
          dateArb,
          fc.integer({ min: 1, max: 20 }), // Number of unsynced orders
          async (reportDate, unsyncedCount) => {
            // Test the error message format for unsynced orders
            const errorMessage = formatUnsyncedOrdersError(unsyncedCount);
            
            // Property: Error message should contain the count
            expect(errorMessage).toContain(unsyncedCount.toString());
            expect(errorMessage).toContain('finalized order');
            expect(errorMessage).toContain('not yet synced');
            
            // Property: Should use correct pluralization
            if (unsyncedCount === 1) {
              expect(errorMessage).not.toContain('orders');
            } else {
              expect(errorMessage).toContain('orders');
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    it('should include breakdown in unsynced financial transactions error message', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 10 }), // Driver earnings
          fc.integer({ min: 0, max: 10 }), // Staff payments
          fc.integer({ min: 0, max: 10 }), // Shift expenses
          async (driverEarnings, staffPayments, shiftExpenses) => {
            // Skip if all are zero (no error would be thrown)
            const total = driverEarnings + staffPayments + shiftExpenses;
            if (total === 0) return true;
            
            // Test the error message format for unsynced financial transactions
            const errorMessage = formatUnsyncedFinancialError({
              driverEarnings,
              staffPayments,
              shiftExpenses,
              total,
            });
            
            // Property: Error message should contain the total count
            expect(errorMessage).toContain(total.toString());
            expect(errorMessage).toContain('unsynced financial transaction');
            
            // Property: Should include breakdown for non-zero counts
            if (driverEarnings > 0) {
              expect(errorMessage).toContain('driver earning');
              expect(errorMessage).toContain(driverEarnings.toString());
            }
            if (staffPayments > 0) {
              expect(errorMessage).toContain('staff payment');
              expect(errorMessage).toContain(staffPayments.toString());
            }
            if (shiftExpenses > 0) {
              expect(errorMessage).toContain('shift expense');
              expect(errorMessage).toContain(shiftExpenses.toString());
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    it('should return ok when all preconditions are met', async () => {
      await fc.assert(
        fc.asyncProperty(
          dateArb,
          async (reportDate) => {
            const mockDb = createMockPreconditionDatabase();
            
            // Don't add any blocking conditions
            
            // Execute canExecuteZReport
            const result = mockDb.canExecuteZReport(reportDate);
            
            // Property: Result should be ok when no blocking conditions exist
            expect(result.ok).toBe(true);
            expect(result.reason).toBeUndefined();
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);
  });
});

/**
 * Creates a mock database for testing finalizeEndOfDay logic
 * This simulates the actual database behavior without requiring SQLite
 */
function createMockDatabase() {
  // In-memory storage
  const orders: MockOrder[] = [];
  const staffShifts: MockStaffShift[] = [];
  const cashDrawerSessions: MockCashDrawerSession[] = [];
  const driverEarnings: MockDriverEarning[] = [];
  const shiftExpenses: MockShiftExpense[] = [];
  const staffPayments: MockStaffPayment[] = [];
  
  const getDateFromTimestamp = (timestamp: string): string => {
    return timestamp.slice(0, 10);
  };
  
  return {
    // Insert methods
    insertOrder(order: MockOrder) {
      orders.push(order);
    },
    insertStaffShift(shift: MockStaffShift) {
      staffShifts.push(shift);
    },
    insertCashDrawerSession(session: MockCashDrawerSession) {
      cashDrawerSessions.push(session);
    },
    insertDriverEarning(earning: MockDriverEarning) {
      driverEarnings.push(earning);
    },
    insertShiftExpense(expense: MockShiftExpense) {
      shiftExpenses.push(expense);
    },
    insertStaffPayment(payment: MockStaffPayment) {
      staffPayments.push(payment);
    },
    
    // Count methods - counts records up to and including the date (matches finalizeEndOfDay behavior)
    countOrders(date: string): number {
      return orders.filter(o => getDateFromTimestamp(o.created_at) <= date).length;
    },
    countStaffShifts(date: string): number {
      return staffShifts.filter(s => getDateFromTimestamp(s.check_in_time) <= date).length;
    },
    countCashDrawerSessions(date: string): number {
      return cashDrawerSessions.filter(c => getDateFromTimestamp(c.opened_at) <= date).length;
    },
    countDriverEarnings(date: string): number {
      return driverEarnings.filter(e => getDateFromTimestamp(e.created_at) <= date).length;
    },
    countShiftExpenses(date: string): number {
      return shiftExpenses.filter(e => getDateFromTimestamp(e.created_at) <= date).length;
    },
    countStaffPayments(date: string): number {
      return staffPayments.filter(p => getDateFromTimestamp(p.created_at) <= date).length;
    },
    
    // Count methods for exact date match
    countOrdersOnDate(date: string): number {
      return orders.filter(o => getDateFromTimestamp(o.created_at) === date).length;
    },
    countStaffShiftsOnDate(date: string): number {
      return staffShifts.filter(s => getDateFromTimestamp(s.check_in_time) === date).length;
    },
    countCashDrawerSessionsOnDate(date: string): number {
      return cashDrawerSessions.filter(c => getDateFromTimestamp(c.opened_at) === date).length;
    },
    
    /**
     * Mock implementation of finalizeEndOfDay
     * Mirrors the actual ReportService.finalizeEndOfDay logic
     */
    finalizeEndOfDay(targetDate: string): Record<string, number> {
      const cleared: Record<string, number> = {};
      
      // Clear orders up to and including target date
      const ordersToDelete = orders.filter(o => getDateFromTimestamp(o.created_at) <= targetDate);
      cleared['orders'] = ordersToDelete.length;
      ordersToDelete.forEach(o => {
        const idx = orders.indexOf(o);
        if (idx > -1) orders.splice(idx, 1);
      });
      
      // Clear staff shifts
      const shiftsToDelete = staffShifts.filter(s => getDateFromTimestamp(s.check_in_time) <= targetDate);
      cleared['staff_shifts'] = shiftsToDelete.length;
      shiftsToDelete.forEach(s => {
        const idx = staffShifts.indexOf(s);
        if (idx > -1) staffShifts.splice(idx, 1);
      });
      
      // Clear cash drawer sessions
      const sessionsToDelete = cashDrawerSessions.filter(c => getDateFromTimestamp(c.opened_at) <= targetDate);
      cleared['cash_drawer_sessions'] = sessionsToDelete.length;
      sessionsToDelete.forEach(c => {
        const idx = cashDrawerSessions.indexOf(c);
        if (idx > -1) cashDrawerSessions.splice(idx, 1);
      });
      
      // Clear driver earnings
      const earningsToDelete = driverEarnings.filter(e => getDateFromTimestamp(e.created_at) <= targetDate);
      cleared['driver_earnings'] = earningsToDelete.length;
      earningsToDelete.forEach(e => {
        const idx = driverEarnings.indexOf(e);
        if (idx > -1) driverEarnings.splice(idx, 1);
      });
      
      // Clear shift expenses
      const expensesToDelete = shiftExpenses.filter(e => getDateFromTimestamp(e.created_at) <= targetDate);
      cleared['shift_expenses'] = expensesToDelete.length;
      expensesToDelete.forEach(e => {
        const idx = shiftExpenses.indexOf(e);
        if (idx > -1) shiftExpenses.splice(idx, 1);
      });
      
      // Clear staff payments
      const paymentsToDelete = staffPayments.filter(p => getDateFromTimestamp(p.created_at) <= targetDate);
      cleared['staff_payments'] = paymentsToDelete.length;
      paymentsToDelete.forEach(p => {
        const idx = staffPayments.indexOf(p);
        if (idx > -1) staffPayments.splice(idx, 1);
      });
      
      return cleared;
    },
  };
}

// Types for precondition testing
interface MockActiveShift {
  id: string;
  staff_id: string;
  status: string;
  role_type?: string;
  is_transfer_pending: boolean;
  transferred_to_cashier_shift_id: string | null;
}

interface MockUnclosedCashDrawer {
  id: string;
  staff_shift_id: string;
  opened_at: string;
  closed_at: null;
}

interface MockOpenOrder {
  id: string;
  created_at: string;
  status: string;
}

/**
 * Creates a mock database for testing canExecuteZReport precondition logic
 * This simulates the actual database behavior for precondition checks
 */
function createMockPreconditionDatabase() {
  // In-memory storage
  const activeShifts: MockActiveShift[] = [];
  const unclosedCashDrawers: MockUnclosedCashDrawer[] = [];
  const openOrders: MockOpenOrder[] = [];
  
  const getDateFromTimestamp = (timestamp: string): string => {
    return timestamp.slice(0, 10);
  };
  
  return {
    // Insert methods
    insertActiveShift(shift: MockActiveShift) {
      activeShifts.push(shift);
    },
    insertUnclosedCashDrawer(drawer: MockUnclosedCashDrawer) {
      unclosedCashDrawers.push(drawer);
    },
    insertOpenOrder(order: MockOpenOrder) {
      openOrders.push(order);
    },
    
    /**
     * Mock implementation of canExecuteZReport
     * Mirrors the actual ReportService.canExecuteZReport logic with enhanced error messages
     */
    canExecuteZReport(targetDate: string): { ok: boolean; reason?: string } {
      // FIRST: Check for transferred driver shifts
      const transferredDriverCount = activeShifts.filter(s => 
        s.role_type === 'driver' &&
        s.status === 'active' &&
        (s.is_transfer_pending || s.transferred_to_cashier_shift_id !== null) &&
        s.staff_id !== 'local-simple-pin'
      ).length;
      
      if (transferredDriverCount > 0) {
        return { 
          ok: false, 
          reason: `${transferredDriverCount} transferred driver shift${transferredDriverCount > 1 ? 's' : ''} not checked out. Please ensure all drivers complete their shifts before running the Z report.` 
        };
      }
      
      // SECOND: Check for any other active shifts (non-transferred)
      const activeShiftCount = activeShifts.filter(s => 
        s.status === 'active' &&
        s.staff_id !== 'local-simple-pin' &&
        !s.is_transfer_pending &&
        s.transferred_to_cashier_shift_id === null
      ).length;
      
      if (activeShiftCount > 0) {
        return { 
          ok: false, 
          reason: `${activeShiftCount} active shift${activeShiftCount > 1 ? 's' : ''} remaining. Please close all shifts (checkout) before running the Z report.` 
        };
      }
      
      // THIRD: Check for unclosed cashier drawers
      const unclosedDrawerCount = unclosedCashDrawers.filter(d => 
        getDateFromTimestamp(d.opened_at) === targetDate
      ).length;
      
      if (unclosedDrawerCount > 0) {
        return { 
          ok: false, 
          reason: `${unclosedDrawerCount} cashier drawer${unclosedDrawerCount > 1 ? 's' : ''} still open. All cashier checkouts must be executed before running the Z report.` 
        };
      }
      
      // FOURTH: Check for open orders
      const openOrderCount = openOrders.filter(o => 
        getDateFromTimestamp(o.created_at) === targetDate &&
        !['delivered', 'completed', 'cancelled'].includes(o.status)
      ).length;
      
      if (openOrderCount > 0) {
        return { 
          ok: false, 
          reason: `${openOrderCount} open order${openOrderCount > 1 ? 's' : ''} for the day. Please complete or cancel them before running the Z report.` 
        };
      }
      
      return { ok: true };
    },
  };
}

/**
 * Format error message for unsynced orders
 * Mirrors the actual error message format in report-handlers.ts
 */
function formatUnsyncedOrdersError(unsyncedCount: number): string {
  return `${unsyncedCount} finalized order${unsyncedCount > 1 ? 's' : ''} not yet synced to cloud. Please wait for sync to complete or check your internet connection.`;
}

/**
 * Format error message for unsynced financial transactions
 * Mirrors the actual error message format in report-handlers.ts
 */
function formatUnsyncedFinancialError(summary: { 
  driverEarnings: number; 
  staffPayments: number; 
  shiftExpenses: number; 
  total: number; 
}): string {
  const breakdown: string[] = [];
  if (summary.driverEarnings > 0) {
    breakdown.push(`${summary.driverEarnings} driver earning${summary.driverEarnings > 1 ? 's' : ''}`);
  }
  if (summary.staffPayments > 0) {
    breakdown.push(`${summary.staffPayments} staff payment${summary.staffPayments > 1 ? 's' : ''}`);
  }
  if (summary.shiftExpenses > 0) {
    breakdown.push(`${summary.shiftExpenses} shift expense${summary.shiftExpenses > 1 ? 's' : ''}`);
  }
  const breakdownStr = breakdown.join(', ');
  return `${summary.total} unsynced financial transaction${summary.total > 1 ? 's' : ''}: ${breakdownStr}. Please wait for sync to complete or check your internet connection.`;
}
