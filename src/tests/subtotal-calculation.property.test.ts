/**
 * Property-Based Test: Subtotal Calculation Consistency
 * 
 * Feature: pos-order-items-view-edit, Property 3: Subtotal Calculation Consistency
 * 
 * For any order with a non-empty items array, the calculated subtotal SHALL equal 
 * the sum of all item total_price values, and this calculation SHALL produce the 
 * same result on POS_Electron, POS_Mobile, and Admin_Dashboard.
 * 
 * **Validates: Requirements 2.3, 6.1, 6.3, 6.4, 8.3**
 */

import * as fc from 'fast-check';
import { calculateSubtotalFromItems } from '../renderer/components/order/OrderApprovalPanel';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
});

/**
 * Arbitrary for generating order items with various price configurations
 */
const orderItemArb = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 50 }),
  quantity: fc.integer({ min: 1, max: 100 }),
  unit_price: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
  total_price: fc.float({ min: Math.fround(0.01), max: Math.fround(10000), noNaN: true }),
  customizations: fc.option(
    fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 30 }),
        price: fc.float({ min: Math.fround(0), max: Math.fround(50), noNaN: true }),
      }),
      { minLength: 0, maxLength: 5 }
    ),
    { nil: undefined }
  ),
});

/**
 * Arbitrary for generating order items using alternative field names
 * (totalPrice instead of total_price, price instead of unit_price)
 */
const orderItemAltFieldsArb = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 50 }),
  quantity: fc.integer({ min: 1, max: 100 }),
  price: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
  totalPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(10000), noNaN: true }),
});

describe('Feature: pos-order-items-view-edit, Property 3: Subtotal Calculation Consistency', () => {
  describe('calculateSubtotalFromItems', () => {
    it('should return 0 for empty items array', () => {
      expect(calculateSubtotalFromItems([])).toBe(0);
    });

    it('should return 0 for non-array input', () => {
      expect(calculateSubtotalFromItems(null as any)).toBe(0);
      expect(calculateSubtotalFromItems(undefined as any)).toBe(0);
    });

    /**
     * Property: Subtotal equals sum of total_price values
     * For any array of order items with total_price, the subtotal should equal
     * the sum of all total_price values.
     */
    it('subtotal equals sum of all item total_price values', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 20 }),
          (items) => {
            const calculatedSubtotal = calculateSubtotalFromItems(items);
            
            // Manually calculate expected subtotal from total_price
            const expectedSubtotal = items.reduce((sum, item) => {
              return sum + (item.total_price || 0);
            }, 0);
            
            // Use toBeCloseTo for floating point comparison
            expect(calculatedSubtotal).toBeCloseTo(expectedSubtotal, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Subtotal handles alternative field names (totalPrice)
     * The calculation should work with both total_price and totalPrice field names.
     */
    it('subtotal handles totalPrice field name', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemAltFieldsArb, { minLength: 1, maxLength: 20 }),
          (items) => {
            const calculatedSubtotal = calculateSubtotalFromItems(items);
            
            // Manually calculate expected subtotal from totalPrice
            const expectedSubtotal = items.reduce((sum, item) => {
              return sum + (item.totalPrice || 0);
            }, 0);
            
            expect(calculatedSubtotal).toBeCloseTo(expectedSubtotal, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Subtotal falls back to unit_price * quantity when total_price is missing
     * When total_price is not available, the calculation should use unit_price * quantity.
     */
    it('subtotal falls back to unit_price * quantity when total_price is missing', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              id: fc.uuid(),
              name: fc.string({ minLength: 1, maxLength: 50 }),
              quantity: fc.integer({ min: 1, max: 100 }),
              unit_price: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
            }),
            { minLength: 1, maxLength: 20 }
          ),
          (items) => {
            const calculatedSubtotal = calculateSubtotalFromItems(items);
            
            // Manually calculate expected subtotal from unit_price * quantity
            const expectedSubtotal = items.reduce((sum, item) => {
              return sum + (item.unit_price * item.quantity);
            }, 0);
            
            expect(calculatedSubtotal).toBeCloseTo(expectedSubtotal, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Subtotal is always non-negative
     * For any valid order items, the subtotal should never be negative.
     */
    it('subtotal is always non-negative', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 0, maxLength: 20 }),
          (items) => {
            const calculatedSubtotal = calculateSubtotalFromItems(items);
            expect(calculatedSubtotal).toBeGreaterThanOrEqual(0);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Subtotal is additive (combining two item arrays)
     * The subtotal of combined arrays should equal the sum of individual subtotals.
     */
    it('subtotal is additive across item arrays', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
          fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
          (items1, items2) => {
            const subtotal1 = calculateSubtotalFromItems(items1);
            const subtotal2 = calculateSubtotalFromItems(items2);
            const combinedSubtotal = calculateSubtotalFromItems([...items1, ...items2]);
            
            expect(combinedSubtotal).toBeCloseTo(subtotal1 + subtotal2, 2);
          }
        ),
        { verbose: true }
      );
    });
  });
});
