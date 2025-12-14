/**
 * Property-Based Tests for Reservation Capacity Validation
 * 
 * **Feature: pos-tables-reservations-sync, Property 4: Reservation Capacity Validation**
 * **Validates: Requirements 4.2**
 * 
 * Property: For any reservation request with a party size and selected table, 
 * the system SHALL reject the reservation if party_size exceeds table.capacity.
 */

import * as fc from 'fast-check';
import { validateCapacity } from '../renderer/components/tables/ReservationForm';

// Configure fast-check for minimum 100 iterations as per design document
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

// =============================================
// ARBITRARIES
// =============================================

/** Arbitrary for valid party sizes (1-100) */
const partySizeArb = fc.integer({ min: 1, max: 100 });

/** Arbitrary for valid table capacities (1-50) */
const tableCapacityArb = fc.integer({ min: 1, max: 50 });

/** Arbitrary for invalid party sizes (0 or negative) */
const invalidPartySizeArb = fc.integer({ min: -100, max: 0 });

// =============================================
// PROPERTY TESTS
// =============================================

describe('Reservation Capacity Validation Property Tests', () => {
  /**
   * **Feature: pos-tables-reservations-sync, Property 4: Reservation Capacity Validation**
   * **Validates: Requirements 4.2**
   */
  describe('Property 4: Reservation Capacity Validation', () => {
    
    /**
     * Requirements 4.2: Validate that selected table has sufficient capacity
     * Party size within capacity should be accepted
     */
    it('SHALL accept party size when it does not exceed table capacity', () => {
      fc.assert(
        fc.property(
          tableCapacityArb,
          (capacity) => {
            // Generate party size that is within capacity
            const partySize = fc.sample(fc.integer({ min: 1, max: capacity }), 1)[0];
            const result = validateCapacity(partySize, capacity);
            expect(result).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Requirements 4.2: Reject if party size exceeds capacity
     * Party size exceeding capacity should be rejected
     */
    it('SHALL reject party size when it exceeds table capacity', () => {
      fc.assert(
        fc.property(
          tableCapacityArb,
          (capacity) => {
            // Generate party size that exceeds capacity
            const partySize = capacity + fc.sample(fc.integer({ min: 1, max: 50 }), 1)[0];
            const result = validateCapacity(partySize, capacity);
            expect(result).toBe(false);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Party size equal to capacity should be accepted
     */
    it('SHALL accept party size when it equals table capacity', () => {
      fc.assert(
        fc.property(
          tableCapacityArb,
          (capacity) => {
            const result = validateCapacity(capacity, capacity);
            expect(result).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Party size of 1 should always be valid for any table
     */
    it('SHALL accept party size of 1 for any table capacity', () => {
      fc.assert(
        fc.property(
          tableCapacityArb,
          (capacity) => {
            const result = validateCapacity(1, capacity);
            expect(result).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Invalid party sizes (0 or negative) should be rejected
     */
    it('SHALL reject invalid party sizes (0 or negative)', () => {
      fc.assert(
        fc.property(
          invalidPartySizeArb,
          tableCapacityArb,
          (partySize, capacity) => {
            const result = validateCapacity(partySize, capacity);
            expect(result).toBe(false);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Validation is deterministic - same inputs produce same output
     */
    it('validation SHALL be deterministic', () => {
      fc.assert(
        fc.property(
          partySizeArb,
          tableCapacityArb,
          (partySize, capacity) => {
            const result1 = validateCapacity(partySize, capacity);
            const result2 = validateCapacity(partySize, capacity);
            expect(result1).toBe(result2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Boundary test: party size exactly one more than capacity should fail
     */
    it('SHALL reject party size that is exactly one more than capacity', () => {
      fc.assert(
        fc.property(
          tableCapacityArb,
          (capacity) => {
            const result = validateCapacity(capacity + 1, capacity);
            expect(result).toBe(false);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Boundary test: party size exactly one less than capacity should pass
     */
    it('SHALL accept party size that is exactly one less than capacity', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 50 }), // capacity must be at least 2 for this test
          (capacity) => {
            const result = validateCapacity(capacity - 1, capacity);
            expect(result).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * For any valid party size and capacity, the result is boolean
     */
    it('SHALL return a boolean value for any input', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -100, max: 200 }),
          fc.integer({ min: 1, max: 100 }),
          (partySize, capacity) => {
            const result = validateCapacity(partySize, capacity);
            expect(typeof result).toBe('boolean');
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Larger capacity should accept more party sizes
     */
    it('larger capacity SHALL accept more party sizes', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 25 }),
          fc.integer({ min: 1, max: 25 }),
          (smallCapacity, additionalCapacity) => {
            const largeCapacity = smallCapacity + additionalCapacity;
            const partySize = smallCapacity; // Use small capacity as party size
            
            // If small capacity accepts, large capacity must also accept
            const smallResult = validateCapacity(partySize, smallCapacity);
            const largeResult = validateCapacity(partySize, largeCapacity);
            
            if (smallResult) {
              expect(largeResult).toBe(true);
            }
          }
        ),
        { verbose: true }
      );
    });
  });
});
