/**
 * Property-Based Tests for Order Number Format Consistency
 * 
 * **Feature: pos-order-items-view-edit, Property 7: Order Number Format Consistency**
 * **Validates: Requirements 7.1, 8.5**
 * 
 * Property: For any order created on any platform, the order_number SHALL match 
 * the format "ORD-YYYYMMDD-NNNN" where YYYYMMDD is the creation date and NNNN 
 * is a 4-digit sequence number.
 */

import * as fc from 'fast-check';
import {
  generateOrderNumber,
  validateOrderNumberFormat,
  validateOrderNumberFormatStrict,
  parseOrderNumber,
  getOrderNumber,
  formatOrderNumberForDisplay,
  ORDER_NUMBER_PATTERN,
  ORDER_NUMBER_STRICT_PATTERN,
} from '../renderer/utils/orderNumberUtils';

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

/** Arbitrary for invalid order number formats */
const invalidOrderNumberArb = fc.oneof(
  fc.constant(''),
  fc.constant('ORD'),
  fc.constant('ORD-'),
  fc.constant('ORD-20231225'),
  fc.constant('ORD-20231225-'),
  fc.constant('ORD-20231225-123'), // Only 3 digits
  fc.constant('ORD-20231225-12345678'), // 8 digits (too many)
  fc.constant('ord-20231225-1234'), // lowercase
  fc.constant('ORD-2023125-1234'), // Invalid date format (7 digits)
  fc.constant('ORD-20231325-1234'), // Invalid month (13)
  fc.constant('ORD-20231232-1234'), // Invalid day (32)
  fc.constant('ORDER-20231225-1234'), // Wrong prefix
  fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.startsWith('ORD-')),
);

/** Arbitrary for order objects with different field name conventions */
const orderWithOrderNumberArb = fc.record({
  id: fc.uuid(),
  order_number: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
  orderNumber: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
});

// =============================================
// PROPERTY TESTS
// =============================================

describe('Order Number Format Property Tests', () => {
  /**
   * **Feature: pos-order-items-view-edit, Property 7: Order Number Format Consistency**
   * **Validates: Requirements 7.1, 8.5**
   */
  describe('Property 7: Order Number Format Consistency', () => {
    
    /**
     * Requirements 7.1, 8.5: Generated order number matches pattern ORD-YYYYMMDD-NNNN
     */
    it('generated order number SHALL match pattern ORD-YYYYMMDD-NNNN', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const orderNumber = generateOrderNumber(date, sequence);
            expect(validateOrderNumberFormatStrict(orderNumber)).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Generated number starts with ORD-
     */
    it('generated order number SHALL start with ORD-', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const orderNumber = generateOrderNumber(date, sequence);
            expect(orderNumber.startsWith('ORD-')).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Generated number has correct length (ORD-YYYYMMDD-NNNN = 17 characters)
     * ORD- (4) + YYYYMMDD (8) + - (1) + NNNN (4) = 17
     */
    it('generated order number SHALL have exactly 17 characters', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const orderNumber = generateOrderNumber(date, sequence);
            expect(orderNumber.length).toBe(17);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Generated number contains correct date components
     */
    it('generated order number SHALL contain correct date components', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const orderNumber = generateOrderNumber(date, sequence);
            const parsed = parseOrderNumber(orderNumber);
            
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
    it('generated order number SHALL contain correct sequence number', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const orderNumber = generateOrderNumber(date, sequence);
            const parsed = parseOrderNumber(orderNumber);
            
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
            const orderNumber = generateOrderNumber(date, sequence);
            const sequencePart = orderNumber.split('-')[2];
            
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
            const orderNumber = generateOrderNumber(date, sequence);
            const datePart = orderNumber.split('-')[1];
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
            const orderNumber = generateOrderNumber(date, sequence);
            const datePart = orderNumber.split('-')[1];
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
          invalidOrderNumberArb,
          (invalidNumber) => {
            expect(validateOrderNumberFormat(invalidNumber)).toBe(false);
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
            const orderNumber = generateOrderNumber(date, sequence);
            expect(validateOrderNumberFormat(orderNumber)).toBe(true);
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
            const orderNumber = generateOrderNumber(date, sequence);
            const parsed = parseOrderNumber(orderNumber);
            
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
      const lowSequence = generateOrderNumber(date, 0);
      expect(lowSequence).toBe('ORD-20240115-0001');
      
      // Test sequence > 9999
      const highSequence = generateOrderNumber(date, 10000);
      expect(highSequence).toBe('ORD-20240115-9999');
      
      // Test negative sequence
      const negativeSequence = generateOrderNumber(date, -5);
      expect(negativeSequence).toBe('ORD-20240115-0001');
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
            const result1 = generateOrderNumber(date, sequence);
            const result2 = generateOrderNumber(date, sequence);
            expect(result1).toBe(result2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Different dates produce different order numbers
     */
    it('different dates SHALL produce different order numbers', () => {
      fc.assert(
        fc.property(
          validDateArb,
          validDateArb,
          sequenceArb,
          (date1, date2, sequence) => {
            // Only test if dates are actually different
            if (date1.getTime() !== date2.getTime()) {
              const result1 = generateOrderNumber(date1, sequence);
              const result2 = generateOrderNumber(date2, sequence);
              expect(result1).not.toBe(result2);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Different sequences produce different order numbers
     */
    it('different sequences SHALL produce different order numbers', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          sequenceArb,
          (date, seq1, seq2) => {
            // Only test if sequences are actually different
            if (seq1 !== seq2) {
              const result1 = generateOrderNumber(date, seq1);
              const result2 = generateOrderNumber(date, seq2);
              expect(result1).not.toBe(result2);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * getOrderNumber handles both snake_case and camelCase field names
     * Requirements: 7.6, 7.7
     */
    it('getOrderNumber SHALL handle both snake_case and camelCase field names', () => {
      // Test snake_case
      expect(getOrderNumber({ order_number: 'ORD-20240115-0001' })).toBe('ORD-20240115-0001');
      
      // Test camelCase
      expect(getOrderNumber({ orderNumber: 'ORD-20240115-0002' })).toBe('ORD-20240115-0002');
      
      // Test snake_case takes precedence
      expect(getOrderNumber({ order_number: 'ORD-20240115-0001', orderNumber: 'ORD-20240115-0002' })).toBe('ORD-20240115-0001');
      
      // Test null/undefined
      expect(getOrderNumber(null)).toBe('');
      expect(getOrderNumber(undefined)).toBe('');
      expect(getOrderNumber({})).toBe('');
    });

    /**
     * formatOrderNumberForDisplay adds # prefix
     */
    it('formatOrderNumberForDisplay SHALL add # prefix', () => {
      expect(formatOrderNumberForDisplay('ORD-20240115-0001')).toBe('#ORD-20240115-0001');
      expect(formatOrderNumberForDisplay('#ORD-20240115-0001')).toBe('#ORD-20240115-0001');
      expect(formatOrderNumberForDisplay('')).toBe('');
    });

    /**
     * Legacy 6-digit sequence format is accepted by non-strict validator
     */
    it('legacy 6-digit sequence format SHALL be accepted by non-strict validator', () => {
      // Legacy format from existing implementation
      expect(validateOrderNumberFormat('ORD-20240115-123456')).toBe(true);
      expect(validateOrderNumberFormat('ORD-20240115-000001')).toBe(true);
      
      // But strict validator rejects it
      expect(validateOrderNumberFormatStrict('ORD-20240115-123456')).toBe(false);
    });

    /**
     * Cross-platform consistency: same format on all platforms
     * Requirements: 7.3, 7.4, 7.5, 8.5
     */
    it('order number format SHALL be consistent across platforms', () => {
      fc.assert(
        fc.property(
          validDateArb,
          sequenceArb,
          (date, sequence) => {
            const orderNumber = generateOrderNumber(date, sequence);
            
            // Verify format matches expected pattern
            expect(orderNumber).toMatch(ORDER_NUMBER_STRICT_PATTERN);
            
            // Verify it can be parsed
            const parsed = parseOrderNumber(orderNumber);
            expect(parsed).not.toBeNull();
            
            // Verify regenerating from parsed values produces same result
            if (parsed) {
              const regenerated = generateOrderNumber(
                new Date(parsed.year, parsed.month - 1, parsed.day),
                parsed.sequence
              );
              expect(regenerated).toBe(orderNumber);
            }
          }
        ),
        { verbose: true }
      );
    });
  });
});
