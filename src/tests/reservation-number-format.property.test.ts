/**
 * Property-Based Tests for Reservation Number Format
 * 
 * **Feature: pos-tables-reservations-sync, Property 5: Reservation Number Format**
 * **Validates: Requirements 4.6**
 * 
 * Property: For any created reservation, the generated reservation_number SHALL match 
 * the pattern RES-YYYYMMDD-XXXX where YYYY is year, MM is month, DD is day, 
 * and XXXX is a sequential number.
 */

import * as fc from 'fast-check';
import { 
  generateReservationNumber, 
  validateReservationNumberFormat,
  parseReservationNumber 
} from '../renderer/utils/reservationUtils';

// Configure fast-check for minimum 100 iterations as per design document
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

// =============================================
// ARBITRARIES
// =============================================

/** Arbitrary for valid years (2020-2030) */
const yearArb = fc.integer({ min: 2020, max: 2030 });

/** Arbitrary for valid months (1-12) */
const monthArb = fc.integer({ min: 1, max: 12 });

/** Arbitrary for valid days (1-28 to avoid month-specific issues) */
const dayArb = fc.integer({ min: 1, max: 28 });

/** Arbitrary for valid sequence numbers (1-9999) */
const sequenceArb = fc.integer({ min: 1, max: 9999 });

/** Arbitrary for generating valid dates */
const validDateArb = fc.record({
  year: yearArb,
  month: monthArb,
  day: dayArb,
}).map(({ year, month, day }) => new Date(year, month - 1, day));

/** Arbitrary for invalid reservation number formats */
const invalidReservationNumberArb = fc.oneof(
  fc.constant(''),
  fc.constant('RES'),
  fc.constant('RES-'),
  fc.constant('RES-20231225'),
  fc.constant('RES-20231225-'),
  fc.constant('RES-20231225-123'), // Only 3 digits
  fc.constant('RES-20231225-12345'), // 5 digits
  fc.constant('res-20231225-1234'), // lowercase
  fc.constant('RES-2023125-1234'), // Invalid date format
  fc.constant('RES-20231325-1234'), // Invalid month (13)
  fc.constant('RES-20231232-1234'), // Invalid day (32)
  fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.startsWith('RES-')),
);

// =============================================
// PROPERTY TESTS
// =============================================

describe('Reservation Number Format Property Tests', () => {
  /**
   * **Feature: pos-tables-reservations-sync, Property 5: Reservation Number Format**
   * **Validates: Requirements 4.6**
   */
  describe('Property 5: Reservation Number Format', () => {
    
    /**
     * Requirements 4.6: Generated reservation number matches pattern RES-YYYYMMDD-XXXX
     */
    it('generated reservation number SHALL match pattern RES-YYYYMMDD-XXXX', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const reservationNumber = generateReservationNumber(date, sequence);
            expect(validateReservationNumberFormat(reservationNumber)).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Generated number starts with RES-
     */
    it('generated reservation number SHALL start with RES-', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const reservationNumber = generateReservationNumber(date, sequence);
            expect(reservationNumber.startsWith('RES-')).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Generated number has correct length (RES-YYYYMMDD-XXXX = 17 characters)
     * RES- (4) + YYYYMMDD (8) + - (1) + XXXX (4) = 17
     */
    it('generated reservation number SHALL have exactly 17 characters', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const reservationNumber = generateReservationNumber(date, sequence);
            expect(reservationNumber.length).toBe(17);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Generated number contains correct date components
     */
    it('generated reservation number SHALL contain correct date components', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const reservationNumber = generateReservationNumber(date, sequence);
            const parsed = parseReservationNumber(reservationNumber);
            
            expect(parsed).not.toBeNull();
            if (parsed) {
              expect(parsed.year).toBe(date.getFullYear());
              expect(parsed.month).toBe(date.getMonth() + 1);
              expect(parsed.day).toBe(date.getDate());
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Generated number contains correct sequence number
     */
    it('generated reservation number SHALL contain correct sequence number', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const reservationNumber = generateReservationNumber(date, sequence);
            const parsed = parseReservationNumber(reservationNumber);
            
            expect(parsed).not.toBeNull();
            if (parsed) {
              expect(parsed.sequence).toBe(sequence);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Sequence number is zero-padded to 4 digits
     */
    it('sequence number SHALL be zero-padded to 4 digits', () => {
      fc.assert(
        fc.property(
          validDateArb,
          fc.integer({ min: 1, max: 999 }), // Small numbers that need padding
          (date, sequence) => {
            const reservationNumber = generateReservationNumber(date, sequence);
            const sequencePart = reservationNumber.split('-')[2];
            
            expect(sequencePart.length).toBe(4);
            expect(parseInt(sequencePart, 10)).toBe(sequence);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Month is zero-padded to 2 digits
     */
    it('month SHALL be zero-padded to 2 digits', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2020, max: 2030 }),
          fc.integer({ min: 1, max: 9 }), // Single digit months
          fc.integer({ min: 1, max: 28 }),
          sequenceArb,
          (year, month, day, sequence) => {
            const date = new Date(year, month - 1, day);
            const reservationNumber = generateReservationNumber(date, sequence);
            const datePart = reservationNumber.split('-')[1];
            const monthPart = datePart.substring(4, 6);
            
            expect(monthPart.length).toBe(2);
            expect(parseInt(monthPart, 10)).toBe(month);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Day is zero-padded to 2 digits
     */
    it('day SHALL be zero-padded to 2 digits', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2020, max: 2030 }),
          fc.integer({ min: 1, max: 12 }),
          fc.integer({ min: 1, max: 9 }), // Single digit days
          sequenceArb,
          (year, month, day, sequence) => {
            const date = new Date(year, month - 1, day);
            const reservationNumber = generateReservationNumber(date, sequence);
            const datePart = reservationNumber.split('-')[1];
            const dayPart = datePart.substring(6, 8);
            
            expect(dayPart.length).toBe(2);
            expect(parseInt(dayPart, 10)).toBe(day);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Invalid formats are rejected by validator
     */
    it('invalid formats SHALL be rejected by validator', () => {
      fc.assert(
        fc.property(
          invalidReservationNumberArb,
          (invalidNumber) => {
            expect(validateReservationNumberFormat(invalidNumber)).toBe(false);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Valid formats are accepted by validator
     */
    it('valid formats SHALL be accepted by validator', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const reservationNumber = generateReservationNumber(date, sequence);
            expect(validateReservationNumberFormat(reservationNumber)).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Round-trip: generate then parse returns original values
     */
    it('round-trip: generate then parse SHALL return original values', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const reservationNumber = generateReservationNumber(date, sequence);
            const parsed = parseReservationNumber(reservationNumber);
            
            expect(parsed).not.toBeNull();
            if (parsed) {
              expect(parsed.year).toBe(date.getFullYear());
              expect(parsed.month).toBe(date.getMonth() + 1);
              expect(parsed.day).toBe(date.getDate());
              expect(parsed.sequence).toBe(sequence);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Sequence numbers outside valid range are clamped
     */
    it('sequence numbers outside valid range SHALL be clamped', () => {
      const date = new Date(2024, 0, 15);
      
      // Test sequence < 1
      const lowSequence = generateReservationNumber(date, 0);
      expect(lowSequence).toBe('RES-20240115-0001');
      
      // Test sequence > 9999
      const highSequence = generateReservationNumber(date, 10000);
      expect(highSequence).toBe('RES-20240115-9999');
    });

    /**
     * Generation is deterministic
     */
    it('generation SHALL be deterministic', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const result1 = generateReservationNumber(date, sequence);
            const result2 = generateReservationNumber(date, sequence);
            expect(result1).toBe(result2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Different dates produce different reservation numbers
     */
    it('different dates SHALL produce different reservation numbers', () => {
      fc.assert(
        fc.property(
          validDateArb,
          validDateArb,
          sequenceArb,
          (date1, date2, sequence) => {
            // Only test if dates are actually different
            if (date1.getTime() !== date2.getTime()) {
              const result1 = generateReservationNumber(date1, sequence);
              const result2 = generateReservationNumber(date2, sequence);
              expect(result1).not.toBe(result2);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Different sequences produce different reservation numbers
     */
    it('different sequences SHALL produce different reservation numbers', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          sequenceArb,
          (date, seq1, seq2) => {
            // Only test if sequences are actually different
            if (seq1 !== seq2) {
              const result1 = generateReservationNumber(date, seq1);
              const result2 = generateReservationNumber(date, seq2);
              expect(result1).not.toBe(result2);
            }
          }
        ),
        { verbose: true }
      );
    });
  });
});
