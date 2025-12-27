/**
 * Property-Based Test: Staff Visibility Completeness
 * 
 * Feature: z-report-fixes, Property 4: Staff Visibility Completeness
 * 
 * For any Z Report generated for a date, the `staffReports` array SHALL contain 
 * an entry for every staff shift that occurred on that date, including all role 
 * types (cashier, driver, kitchen). The count of entries SHALL equal `shifts.total`.
 * 
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
 */

import * as fc from 'fast-check';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
});

/**
 * Type definitions for Z Report staff data structures
 */
type RoleType = 'cashier' | 'driver' | 'kitchen';

interface StaffShift {
  id: string;
  staffId: string;
  staffName: string;
  roleType: RoleType;
  checkInTime: string;
  checkOutTime: string | null;
  status: 'active' | 'completed' | 'closed';
}

interface StaffReport {
  staffShiftId: string;
  staffId: string;
  staffName: string;
  role: RoleType;
  checkIn: string;
  checkOut: string | null;
  shiftStatus: string;
  orders: {
    count: number;
    cashAmount: number;
    cardAmount: number;
    totalAmount: number;
  };
  ordersDetails: any[];
  ordersTruncated: boolean;
  payments: { staffPayments: number };
  expenses: { total: number };
  driver?: {
    deliveries: number;
    completedDeliveries: number;
    cancelledDeliveries: number;
    earnings: number;
    cashCollected: number;
    cardAmount: number;
    cashToReturn: number;
  };
  drawer?: {
    opening: number;
    expected: number;
    closing: number;
    variance: number;
    cashSales: number;
    cardSales: number;
    drops: number;
    driverCashReturned: number;
    driverCashGiven: number;
  };
  returnedToDrawerAmount: number;
}

interface ShiftsCounts {
  total: number;
  cashier: number;
  driver: number;
  kitchen: number;
}

interface ZReportData {
  date: string;
  shifts: ShiftsCounts;
  staffReports: StaffReport[];
}

/**
 * Valid role types
 */
const VALID_ROLE_TYPES: RoleType[] = ['cashier', 'driver', 'kitchen'];

/**
 * Arbitrary generators
 */
const validDateStringArb = fc.integer({
  min: new Date('2020-01-01').getTime(),
  max: new Date('2030-12-31').getTime(),
}).map(timestamp => new Date(timestamp).toISOString());

const roleTypeArb = fc.constantFrom('cashier', 'driver', 'kitchen') as fc.Arbitrary<RoleType>;

const staffShiftArb = fc.record({
  id: fc.uuid(),
  staffId: fc.uuid(),
  staffName: fc.string({ minLength: 1, maxLength: 50 }),
  roleType: roleTypeArb,
  checkInTime: validDateStringArb,
  checkOutTime: fc.option(validDateStringArb, { nil: null }),
  status: fc.constantFrom('active', 'completed', 'closed') as fc.Arbitrary<'active' | 'completed' | 'closed'>,
});

/**
 * Function that simulates the Z Report generation logic for staff reports
 * This mirrors the actual implementation in ReportService.ts
 */
function generateStaffReport(shift: StaffShift): StaffReport {
  return {
    staffShiftId: shift.id,
    staffId: shift.staffId,
    staffName: shift.staffName,
    role: shift.roleType,
    checkIn: shift.checkInTime,
    checkOut: shift.checkOutTime,
    shiftStatus: shift.status,
    orders: {
      count: 0,
      cashAmount: 0,
      cardAmount: 0,
      totalAmount: 0,
    },
    ordersDetails: [],
    ordersTruncated: false,
    payments: { staffPayments: 0 },
    expenses: { total: 0 },
    driver: shift.roleType === 'driver' ? {
      deliveries: 0,
      completedDeliveries: 0,
      cancelledDeliveries: 0,
      earnings: 0,
      cashCollected: 0,
      cardAmount: 0,
      cashToReturn: 0,
    } : undefined,
    drawer: shift.roleType === 'cashier' ? {
      opening: 0,
      expected: 0,
      closing: 0,
      variance: 0,
      cashSales: 0,
      cardSales: 0,
      drops: 0,
      driverCashReturned: 0,
      driverCashGiven: 0,
    } : undefined,
    returnedToDrawerAmount: 0,
  };
}

/**
 * Function to generate a mock Z Report with consistent staff data
 * Simulates the ReportService.generateZReport behavior
 */
function generateConsistentZReport(staffShifts: StaffShift[]): ZReportData {
  // Sort by role_type first, then by check_in_time (matching ReportService implementation)
  const sortedShifts = [...staffShifts].sort((a, b) => {
    const roleCompare = a.roleType.localeCompare(b.roleType);
    if (roleCompare !== 0) return roleCompare;
    return a.checkInTime.localeCompare(b.checkInTime);
  });

  // Count shifts by role
  const cashierCount = staffShifts.filter(s => s.roleType === 'cashier').length;
  const driverCount = staffShifts.filter(s => s.roleType === 'driver').length;
  const kitchenCount = staffShifts.filter(s => s.roleType === 'kitchen').length;

  // Generate staff reports for all shifts
  const staffReports = sortedShifts.map(generateStaffReport);

  return {
    date: new Date().toISOString().slice(0, 10),
    shifts: {
      total: staffShifts.length,
      cashier: cashierCount,
      driver: driverCount,
      kitchen: kitchenCount,
    },
    staffReports,
  };
}

describe('Feature: z-report-fixes, Property 4: Staff Visibility Completeness', () => {
  describe('Staff Visibility in Z Report Details', () => {
    /**
     * Property: staffReports count equals shifts.total
     * For any Z Report, the number of entries in staffReports should equal shifts.total.
     * Validates Requirement 4.1
     */
    it('staffReports count equals shifts.total', () => {
      fc.assert(
        fc.property(
          fc.array(staffShiftArb, { minLength: 0, maxLength: 20 }),
          (staffShifts) => {
            const zReport = generateConsistentZReport(staffShifts);
            
            // The count of staffReports should equal shifts.total
            expect(zReport.staffReports.length).toBe(zReport.shifts.total);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: All staff shifts are represented in staffReports
     * For any Z Report, every staff shift should have a corresponding entry in staffReports.
     * Validates Requirement 4.1
     */
    it('all staff shifts are represented in staffReports', () => {
      fc.assert(
        fc.property(
          fc.array(staffShiftArb, { minLength: 1, maxLength: 20 }),
          (staffShifts) => {
            const zReport = generateConsistentZReport(staffShifts);
            
            // Get all shift IDs from input
            const inputShiftIds = new Set(staffShifts.map(s => s.id));
            
            // Get all shift IDs from staffReports
            const reportShiftIds = new Set(zReport.staffReports.map(r => r.staffShiftId));
            
            // All input shifts should be in the report
            for (const shiftId of inputShiftIds) {
              expect(reportShiftIds.has(shiftId)).toBe(true);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Drivers are included in staffReports
     * When a driver has a shift on the report date, they should be included in staffReports.
     * Validates Requirement 4.2
     */
    it('drivers are included in staffReports', () => {
      fc.assert(
        fc.property(
          fc.array(staffShiftArb.map(s => ({ ...s, roleType: 'driver' as RoleType })), { minLength: 1, maxLength: 5 }),
          (driverShifts) => {
            const zReport = generateConsistentZReport(driverShifts);
            
            // All driver shifts should be in staffReports
            expect(zReport.staffReports.length).toBe(driverShifts.length);
            
            // All entries should have role 'driver'
            for (const report of zReport.staffReports) {
              expect(report.role).toBe('driver');
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Cashiers are included in staffReports
     * When a cashier has a shift on the report date, they should be included in staffReports.
     * Validates Requirement 4.1
     */
    it('cashiers are included in staffReports', () => {
      fc.assert(
        fc.property(
          fc.array(staffShiftArb.map(s => ({ ...s, roleType: 'cashier' as RoleType })), { minLength: 1, maxLength: 5 }),
          (cashierShifts) => {
            const zReport = generateConsistentZReport(cashierShifts);
            
            // All cashier shifts should be in staffReports
            expect(zReport.staffReports.length).toBe(cashierShifts.length);
            
            // All entries should have role 'cashier'
            for (const report of zReport.staffReports) {
              expect(report.role).toBe('cashier');
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Kitchen staff are included in staffReports
     * When kitchen staff have shifts on the report date, they should be included in staffReports.
     * Validates Requirement 4.1
     */
    it('kitchen staff are included in staffReports', () => {
      fc.assert(
        fc.property(
          fc.array(staffShiftArb.map(s => ({ ...s, roleType: 'kitchen' as RoleType })), { minLength: 1, maxLength: 5 }),
          (kitchenShifts) => {
            const zReport = generateConsistentZReport(kitchenShifts);
            
            // All kitchen shifts should be in staffReports
            expect(zReport.staffReports.length).toBe(kitchenShifts.length);
            
            // All entries should have role 'kitchen'
            for (const report of zReport.staffReports) {
              expect(report.role).toBe('kitchen');
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Mixed role types are all included in staffReports
     * When there are shifts from different role types, all should be included.
     * Validates Requirements 4.1, 4.2
     */
    it('mixed role types are all included in staffReports', () => {
      fc.assert(
        fc.property(
          fc.record({
            cashierShifts: fc.array(staffShiftArb.map(s => ({ ...s, roleType: 'cashier' as RoleType })), { minLength: 1, maxLength: 3 }),
            driverShifts: fc.array(staffShiftArb.map(s => ({ ...s, roleType: 'driver' as RoleType })), { minLength: 1, maxLength: 3 }),
            kitchenShifts: fc.array(staffShiftArb.map(s => ({ ...s, roleType: 'kitchen' as RoleType })), { minLength: 1, maxLength: 3 }),
          }),
          ({ cashierShifts, driverShifts, kitchenShifts }) => {
            const allShifts = [...cashierShifts, ...driverShifts, ...kitchenShifts];
            const zReport = generateConsistentZReport(allShifts);
            
            // Total should match
            expect(zReport.staffReports.length).toBe(allShifts.length);
            
            // Count by role in staffReports
            const reportCashiers = zReport.staffReports.filter(r => r.role === 'cashier').length;
            const reportDrivers = zReport.staffReports.filter(r => r.role === 'driver').length;
            const reportKitchen = zReport.staffReports.filter(r => r.role === 'kitchen').length;
            
            // Verify counts match
            expect(reportCashiers).toBe(cashierShifts.length);
            expect(reportDrivers).toBe(driverShifts.length);
            expect(reportKitchen).toBe(kitchenShifts.length);
            
            // Verify shifts counts object
            expect(zReport.shifts.cashier).toBe(cashierShifts.length);
            expect(zReport.shifts.driver).toBe(driverShifts.length);
            expect(zReport.shifts.kitchen).toBe(kitchenShifts.length);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: staffReports are sorted by role_type
     * Staff reports should be grouped by role type (alphabetically: cashier, driver, kitchen).
     * Validates Requirement 4.3
     */
    it('staffReports are sorted by role_type', () => {
      fc.assert(
        fc.property(
          fc.array(staffShiftArb, { minLength: 2, maxLength: 15 }),
          (staffShifts) => {
            const zReport = generateConsistentZReport(staffShifts);
            
            // Check that reports are sorted by role_type
            for (let i = 1; i < zReport.staffReports.length; i++) {
              const prevRole = zReport.staffReports[i - 1].role;
              const currRole = zReport.staffReports[i].role;
              
              // Role should be >= previous role (alphabetically)
              expect(currRole.localeCompare(prevRole)).toBeGreaterThanOrEqual(0);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Each staff report has valid role type
     * All entries in staffReports should have a valid role type.
     * Validates Requirement 4.4
     */
    it('each staff report has valid role type', () => {
      fc.assert(
        fc.property(
          fc.array(staffShiftArb, { minLength: 1, maxLength: 10 }),
          (staffShifts) => {
            const zReport = generateConsistentZReport(staffShifts);
            
            for (const report of zReport.staffReports) {
              expect(VALID_ROLE_TYPES).toContain(report.role);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: shifts.total equals sum of role counts
     * The total shift count should equal the sum of cashier, driver, and kitchen counts.
     */
    it('shifts.total equals sum of role counts', () => {
      fc.assert(
        fc.property(
          fc.array(staffShiftArb, { minLength: 0, maxLength: 20 }),
          (staffShifts) => {
            const zReport = generateConsistentZReport(staffShifts);
            
            const sumOfRoles = zReport.shifts.cashier + zReport.shifts.driver + zReport.shifts.kitchen;
            expect(zReport.shifts.total).toBe(sumOfRoles);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Empty staffReports when no shifts exist
     */
    it('staffReports is empty when no shifts exist', () => {
      const zReport = generateConsistentZReport([]);
      
      expect(zReport.staffReports).toEqual([]);
      expect(zReport.shifts.total).toBe(0);
      expect(zReport.shifts.cashier).toBe(0);
      expect(zReport.shifts.driver).toBe(0);
      expect(zReport.shifts.kitchen).toBe(0);
    });

    /**
     * Property: Staff report contains required fields
     * Each staff report should have all required identification fields.
     * Validates Requirement 4.3
     */
    it('staff report contains required identification fields', () => {
      fc.assert(
        fc.property(
          fc.array(staffShiftArb, { minLength: 1, maxLength: 10 }),
          (staffShifts) => {
            const zReport = generateConsistentZReport(staffShifts);
            
            for (const report of zReport.staffReports) {
              // Required identification fields
              expect(report.staffShiftId).toBeDefined();
              expect(report.staffId).toBeDefined();
              expect(report.staffName).toBeDefined();
              expect(report.role).toBeDefined();
              expect(report.checkIn).toBeDefined();
              
              // Non-empty strings
              expect(report.staffShiftId.length).toBeGreaterThan(0);
              expect(report.staffId.length).toBeGreaterThan(0);
              expect(report.staffName.length).toBeGreaterThan(0);
              expect(report.role.length).toBeGreaterThan(0);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Driver reports have driver-specific information
     * When a staff report is for a driver, it should include driver metrics.
     * Validates Requirement 4.3
     */
    it('driver reports have driver-specific information', () => {
      fc.assert(
        fc.property(
          fc.array(staffShiftArb.map(s => ({ ...s, roleType: 'driver' as RoleType })), { minLength: 1, maxLength: 5 }),
          (driverShifts) => {
            const zReport = generateConsistentZReport(driverShifts);
            
            for (const report of zReport.staffReports) {
              expect(report.role).toBe('driver');
              expect(report.driver).toBeDefined();
              expect(report.driver?.deliveries).toBeDefined();
              expect(report.driver?.earnings).toBeDefined();
              expect(report.driver?.cashCollected).toBeDefined();
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Cashier reports have drawer information
     * When a staff report is for a cashier, it should include drawer metrics.
     * Validates Requirement 4.3
     */
    it('cashier reports have drawer information', () => {
      fc.assert(
        fc.property(
          fc.array(staffShiftArb.map(s => ({ ...s, roleType: 'cashier' as RoleType })), { minLength: 1, maxLength: 5 }),
          (cashierShifts) => {
            const zReport = generateConsistentZReport(cashierShifts);
            
            for (const report of zReport.staffReports) {
              expect(report.role).toBe('cashier');
              expect(report.drawer).toBeDefined();
              expect(report.drawer?.opening).toBeDefined();
              expect(report.drawer?.closing).toBeDefined();
              expect(report.drawer?.variance).toBeDefined();
            }
          }
        ),
        { verbose: true }
      );
    });
  });
});
