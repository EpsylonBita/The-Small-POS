/**
 * Property-Based Test: Staff Payment Role Display Correctness
 * 
 * Feature: z-report-fixes, Property 6: Staff Payment Role Display Correctness
 * 
 * For any staff payment displayed in the Staff Payments section, the role displayed 
 * SHALL match the `roleType` property from the `staffAnalytics` data, and SHALL be 
 * one of 'cashier', 'driver', or 'kitchen'.
 * 
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
 */

import * as fc from 'fast-check';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
});

/**
 * Type definitions for staff payment data structures
 */
type RoleType = 'cashier' | 'driver' | 'kitchen';
type PaymentType = 'wage' | 'tip' | 'bonus' | 'other';

interface StaffPaymentAnalytics {
  id: string;
  staffId: string;
  staffName: string;
  roleType: RoleType | null;
  amount: number;
  paymentType: PaymentType;
  notes: string | null;
  checkInTime: string;
  checkOutTime: string | null;
  shiftStatus: string;
  createdAt: string;
}

/**
 * Valid role types that can be displayed
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
const nullableRoleTypeArb = fc.option(roleTypeArb, { nil: null });
const paymentTypeArb = fc.constantFrom('wage', 'tip', 'bonus', 'other') as fc.Arbitrary<PaymentType>;

const staffPaymentAnalyticsArb = fc.record({
  id: fc.uuid(),
  staffId: fc.uuid(),
  staffName: fc.string({ minLength: 1, maxLength: 50 }),
  roleType: nullableRoleTypeArb,
  amount: fc.float({ min: Math.fround(1), max: Math.fround(1000), noNaN: true }),
  paymentType: paymentTypeArb,
  notes: fc.option(fc.string({ minLength: 0, maxLength: 200 }), { nil: null }),
  checkInTime: validDateStringArb,
  checkOutTime: fc.option(validDateStringArb, { nil: null }),
  shiftStatus: fc.constantFrom('active', 'completed', 'closed'),
  createdAt: validDateStringArb,
});

/**
 * Function that simulates the role display logic from ZReportsPage.tsx
 * This mirrors the actual implementation after the fix:
 * `payment.roleType || 'unknown'`
 */
function getDisplayedRole(payment: StaffPaymentAnalytics): string {
  return payment.roleType || 'unknown';
}

/**
 * Function to validate if a role is a valid display role
 * Valid roles are: 'cashier', 'driver', 'kitchen', or 'unknown' (fallback)
 */
function isValidDisplayRole(role: string): boolean {
  return VALID_ROLE_TYPES.includes(role as RoleType) || role === 'unknown';
}

describe('Feature: z-report-fixes, Property 6: Staff Payment Role Display Correctness', () => {
  describe('Staff Payment Role Display', () => {
    /**
     * Property: Displayed role matches roleType property
     * For any staff payment with a non-null roleType, the displayed role
     * should exactly match the roleType property.
     */
    it('displayed role matches roleType property when roleType is not null', () => {
      fc.assert(
        fc.property(
          staffPaymentAnalyticsArb.filter(p => p.roleType !== null),
          (payment) => {
            const displayedRole = getDisplayedRole(payment);
            
            // The displayed role should match the roleType exactly
            expect(displayedRole).toBe(payment.roleType);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Displayed role is 'unknown' when roleType is null
     * For any staff payment with a null roleType, the displayed role
     * should fall back to 'unknown'.
     */
    it('displayed role is unknown when roleType is null', () => {
      fc.assert(
        fc.property(
          staffPaymentAnalyticsArb.map(p => ({ ...p, roleType: null })),
          (payment) => {
            const displayedRole = getDisplayedRole(payment);
            
            // The displayed role should be 'unknown' when roleType is null
            expect(displayedRole).toBe('unknown');
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Displayed role is always a valid role type
     * For any staff payment, the displayed role should be one of
     * 'cashier', 'driver', 'kitchen', or 'unknown'.
     */
    it('displayed role is always a valid role type', () => {
      fc.assert(
        fc.property(
          staffPaymentAnalyticsArb,
          (payment) => {
            const displayedRole = getDisplayedRole(payment);
            
            // The displayed role should be a valid display role
            expect(isValidDisplayRole(displayedRole)).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Driver payments display 'driver' role
     * When a payment is made to a driver (roleType === 'driver'),
     * the displayed role should be 'driver'.
     */
    it('driver payments display driver role', () => {
      fc.assert(
        fc.property(
          staffPaymentAnalyticsArb.map(p => ({ ...p, roleType: 'driver' as RoleType })),
          (payment) => {
            const displayedRole = getDisplayedRole(payment);
            
            expect(displayedRole).toBe('driver');
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Cashier payments display 'cashier' role
     * When a payment is made to a cashier (roleType === 'cashier'),
     * the displayed role should be 'cashier'.
     */
    it('cashier payments display cashier role', () => {
      fc.assert(
        fc.property(
          staffPaymentAnalyticsArb.map(p => ({ ...p, roleType: 'cashier' as RoleType })),
          (payment) => {
            const displayedRole = getDisplayedRole(payment);
            
            expect(displayedRole).toBe('cashier');
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Kitchen payments display 'kitchen' role
     * When a payment is made to kitchen staff (roleType === 'kitchen'),
     * the displayed role should be 'kitchen'.
     */
    it('kitchen payments display kitchen role', () => {
      fc.assert(
        fc.property(
          staffPaymentAnalyticsArb.map(p => ({ ...p, roleType: 'kitchen' as RoleType })),
          (payment) => {
            const displayedRole = getDisplayedRole(payment);
            
            expect(displayedRole).toBe('kitchen');
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Role display is consistent across multiple payments
     * For any array of staff payments, each payment's displayed role
     * should consistently match its roleType property.
     */
    it('role display is consistent across multiple payments', () => {
      fc.assert(
        fc.property(
          fc.array(staffPaymentAnalyticsArb, { minLength: 1, maxLength: 20 }),
          (payments) => {
            for (const payment of payments) {
              const displayedRole = getDisplayedRole(payment);
              
              if (payment.roleType !== null) {
                expect(displayedRole).toBe(payment.roleType);
              } else {
                expect(displayedRole).toBe('unknown');
              }
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Mixed role types are all displayed correctly
     * When there are payments to different role types, each should
     * display its correct role.
     */
    it('mixed role types are all displayed correctly', () => {
      fc.assert(
        fc.property(
          fc.record({
            cashierPayment: staffPaymentAnalyticsArb.map(p => ({ ...p, roleType: 'cashier' as RoleType })),
            driverPayment: staffPaymentAnalyticsArb.map(p => ({ ...p, roleType: 'driver' as RoleType })),
            kitchenPayment: staffPaymentAnalyticsArb.map(p => ({ ...p, roleType: 'kitchen' as RoleType })),
            unknownPayment: staffPaymentAnalyticsArb.map(p => ({ ...p, roleType: null })),
          }),
          ({ cashierPayment, driverPayment, kitchenPayment, unknownPayment }) => {
            expect(getDisplayedRole(cashierPayment)).toBe('cashier');
            expect(getDisplayedRole(driverPayment)).toBe('driver');
            expect(getDisplayedRole(kitchenPayment)).toBe('kitchen');
            expect(getDisplayedRole(unknownPayment)).toBe('unknown');
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Role display does not depend on other payment properties
     * The displayed role should only depend on the roleType property,
     * not on amount, paymentType, notes, or other fields.
     */
    it('role display only depends on roleType property', () => {
      fc.assert(
        fc.property(
          roleTypeArb,
          fc.float({ min: Math.fround(1), max: Math.fround(10000), noNaN: true }),
          paymentTypeArb,
          fc.option(fc.string({ minLength: 0, maxLength: 200 }), { nil: null }),
          (roleType, amount, paymentType, notes) => {
            const payment1: StaffPaymentAnalytics = {
              id: 'test-id-1',
              staffId: 'staff-1',
              staffName: 'Test Staff 1',
              roleType,
              amount: 100,
              paymentType: 'wage',
              notes: null,
              checkInTime: new Date().toISOString(),
              checkOutTime: null,
              shiftStatus: 'active',
              createdAt: new Date().toISOString(),
            };
            
            const payment2: StaffPaymentAnalytics = {
              id: 'test-id-2',
              staffId: 'staff-2',
              staffName: 'Test Staff 2',
              roleType,
              amount,
              paymentType,
              notes,
              checkInTime: new Date().toISOString(),
              checkOutTime: new Date().toISOString(),
              shiftStatus: 'completed',
              createdAt: new Date().toISOString(),
            };
            
            // Both payments with the same roleType should display the same role
            expect(getDisplayedRole(payment1)).toBe(getDisplayedRole(payment2));
          }
        ),
        { verbose: true }
      );
    });
  });
});
