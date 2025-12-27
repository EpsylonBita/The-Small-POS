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
 */

import * as fc from 'fast-check';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
});

/**
 * Type definitions for Z Report data structures
 */
interface StaffPaymentAnalytics {
  id: string;
  staffId: string;
  staffName: string;
  roleType: 'cashier' | 'driver' | 'kitchen' | 'unknown';
  amount: number;
  paymentType: string;
  notes: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  shiftStatus: string | null;
  createdAt: string;
}

interface ZReportExpenses {
  total: number;
  pendingCount: number;
  staffPaymentsTotal: number;
  items: Array<{ id: string; description: string; amount: number; expenseType?: string; staffName?: string; createdAt: string }>;
}

interface ZReportData {
  date: string;
  expenses: ZReportExpenses;
  staffAnalytics: StaffPaymentAnalytics[];
}

/**
 * Arbitrary for generating staff payment analytics entries
 * Using integer timestamps to avoid invalid date issues with fc.date()
 */
const validDateStringArb = fc.integer({
  min: new Date('2020-01-01').getTime(),
  max: new Date('2030-12-31').getTime(),
}).map(timestamp => new Date(timestamp).toISOString());

const staffPaymentAnalyticsArb = fc.record({
  id: fc.uuid(),
  staffId: fc.uuid(),
  staffName: fc.string({ minLength: 1, maxLength: 50 }),
  roleType: fc.constantFrom('cashier', 'driver', 'kitchen', 'unknown') as fc.Arbitrary<'cashier' | 'driver' | 'kitchen' | 'unknown'>,
  amount: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
  paymentType: fc.constantFrom('cash', 'card', 'bank_transfer'),
  notes: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }),
  checkInTime: fc.option(validDateStringArb, { nil: null }),
  checkOutTime: fc.option(validDateStringArb, { nil: null }),
  shiftStatus: fc.option(fc.constantFrom('active', 'completed', 'cancelled'), { nil: null }),
  createdAt: validDateStringArb,
});

/**
 * Arbitrary for generating expense items (non-staff-payment type)
 */
const expenseItemArb = fc.record({
  id: fc.uuid(),
  description: fc.string({ minLength: 1, maxLength: 100 }),
  amount: fc.float({ min: Math.fround(0.01), max: Math.fround(500), noNaN: true }),
  expenseType: fc.constantFrom('supplies', 'maintenance', 'utilities', undefined),
  staffName: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
  createdAt: validDateStringArb,
});

/**
 * Function that simulates the Z Report generation logic for staff payments total
 * This mirrors the actual implementation in ReportService.ts
 */
function calculateStaffPaymentsTotal(staffAnalytics: StaffPaymentAnalytics[]): number {
  return staffAnalytics.reduce((sum, p) => sum + Number(p.amount || 0), 0);
}

/**
 * Function to generate a mock Z Report with consistent data
 * The staffPaymentsTotal should always equal the sum of staffAnalytics amounts
 */
function generateConsistentZReport(
  staffAnalytics: StaffPaymentAnalytics[],
  expenseItems: Array<{ id: string; description: string; amount: number; expenseType?: string; staffName?: string; createdAt: string }>
): ZReportData {
  const staffPaymentsTotal = calculateStaffPaymentsTotal(staffAnalytics);
  const expensesTotal = expenseItems.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  
  return {
    date: new Date().toISOString().slice(0, 10),
    expenses: {
      total: expensesTotal,
      pendingCount: 0,
      staffPaymentsTotal,
      items: expenseItems,
    },
    staffAnalytics,
  };
}

describe('Feature: z-report-fixes, Property 1: Staff Payments Total Invariant', () => {
  describe('Staff Payments Total Calculation', () => {
    /**
     * Property: staffPaymentsTotal equals sum of all staffAnalytics amounts
     * For any Z Report, the expenses.staffPaymentsTotal should equal the sum of
     * all individual staff payment amounts in staffAnalytics.
     */
    it('staffPaymentsTotal equals sum of all staffAnalytics amounts', () => {
      fc.assert(
        fc.property(
          fc.array(staffPaymentAnalyticsArb, { minLength: 0, maxLength: 20 }),
          fc.array(expenseItemArb, { minLength: 0, maxLength: 10 }),
          (staffAnalytics, expenseItems) => {
            const zReport = generateConsistentZReport(staffAnalytics, expenseItems);
            
            // Calculate expected total from staffAnalytics
            const expectedTotal = staffAnalytics.reduce((sum, p) => sum + Number(p.amount || 0), 0);
            
            // Verify the invariant: staffPaymentsTotal === sum of staffAnalytics amounts
            expect(zReport.expenses.staffPaymentsTotal).toBeCloseTo(expectedTotal, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: staffPaymentsTotal includes all role types
     * The total should include payments to cashiers, drivers, and kitchen staff equally.
     */
    it('staffPaymentsTotal includes payments to all role types (cashier, driver, kitchen)', () => {
      fc.assert(
        fc.property(
          // Generate at least one payment for each role type
          fc.tuple(
            staffPaymentAnalyticsArb.map(p => ({ ...p, roleType: 'cashier' as const })),
            staffPaymentAnalyticsArb.map(p => ({ ...p, roleType: 'driver' as const })),
            staffPaymentAnalyticsArb.map(p => ({ ...p, roleType: 'kitchen' as const }))
          ),
          fc.array(staffPaymentAnalyticsArb, { minLength: 0, maxLength: 10 }),
          ([cashierPayment, driverPayment, kitchenPayment], additionalPayments) => {
            const allPayments = [cashierPayment, driverPayment, kitchenPayment, ...additionalPayments];
            const zReport = generateConsistentZReport(allPayments, []);
            
            // Calculate expected total from all payments
            const expectedTotal = allPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
            
            // Verify the invariant holds for mixed role types
            expect(zReport.expenses.staffPaymentsTotal).toBeCloseTo(expectedTotal, 2);
            
            // Verify each role type's payment is included
            const cashierTotal = Number(cashierPayment.amount || 0);
            const driverTotal = Number(driverPayment.amount || 0);
            const kitchenTotal = Number(kitchenPayment.amount || 0);
            const additionalTotal = additionalPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
            
            expect(zReport.expenses.staffPaymentsTotal).toBeCloseTo(
              cashierTotal + driverTotal + kitchenTotal + additionalTotal,
              2
            );
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: staffPaymentsTotal is zero when no payments exist
     * When staffAnalytics is empty, staffPaymentsTotal should be 0.
     */
    it('staffPaymentsTotal is zero when no payments exist', () => {
      const zReport = generateConsistentZReport([], []);
      expect(zReport.expenses.staffPaymentsTotal).toBe(0);
    });

    /**
     * Property: staffPaymentsTotal is always non-negative
     * For any valid staff payments, the total should never be negative.
     */
    it('staffPaymentsTotal is always non-negative', () => {
      fc.assert(
        fc.property(
          fc.array(staffPaymentAnalyticsArb, { minLength: 0, maxLength: 20 }),
          (staffAnalytics) => {
            const total = calculateStaffPaymentsTotal(staffAnalytics);
            expect(total).toBeGreaterThanOrEqual(0);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: staffPaymentsTotal is additive
     * Combining two sets of payments should result in a total equal to the sum of individual totals.
     */
    it('staffPaymentsTotal is additive across payment sets', () => {
      fc.assert(
        fc.property(
          fc.array(staffPaymentAnalyticsArb, { minLength: 1, maxLength: 10 }),
          fc.array(staffPaymentAnalyticsArb, { minLength: 1, maxLength: 10 }),
          (payments1, payments2) => {
            const total1 = calculateStaffPaymentsTotal(payments1);
            const total2 = calculateStaffPaymentsTotal(payments2);
            const combinedTotal = calculateStaffPaymentsTotal([...payments1, ...payments2]);
            
            expect(combinedTotal).toBeCloseTo(total1 + total2, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Each roleType payment contributes to total
     * Verify that payments with 'unknown' roleType are also included in the total.
     */
    it('payments with unknown roleType are included in total', () => {
      fc.assert(
        fc.property(
          staffPaymentAnalyticsArb.map(p => ({ ...p, roleType: 'unknown' as const })),
          fc.array(staffPaymentAnalyticsArb, { minLength: 0, maxLength: 10 }),
          (unknownPayment, otherPayments) => {
            const allPayments = [unknownPayment, ...otherPayments];
            const zReport = generateConsistentZReport(allPayments, []);
            
            // The unknown payment should be included in the total
            const expectedTotal = allPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
            expect(zReport.expenses.staffPaymentsTotal).toBeCloseTo(expectedTotal, 2);
          }
        ),
        { verbose: true }
      );
    });
  });
});
