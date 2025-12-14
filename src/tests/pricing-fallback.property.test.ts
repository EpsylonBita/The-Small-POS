/**
 * Property-Based Tests for Price Fallback Logic
 * 
 * **Feature: pos-tables-reservations-sync, Property 14: Price Fallback Logic**
 * **Validates: Requirements 9.8**
 * 
 * Property: For any menu item where the order-type-specific price is null or undefined,
 * the system SHALL use pickup_price as the fallback.
 */

import * as fc from 'fast-check';

// Configure fast-check for minimum 100 iterations as per design document
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

// =============================================
// TYPES
// =============================================

export type OrderType = 'delivery' | 'pickup' | 'dine-in';

export interface PriceableItem {
  /** Base price (legacy field) */
  price?: number | null;
  /** Price for pickup orders */
  pickup_price?: number | null;
  /** Price for delivery orders - only available when Delivery module is acquired */
  delivery_price?: number | null;
  /** Price for in-store/table orders - only available when Tables module is acquired */
  instore_price?: number | null;
}

// =============================================
// FUNCTIONS UNDER TEST
// =============================================

/**
 * Check if a price value is valid (defined and not NaN)
 */
function isValidPrice(price: number | null | undefined): price is number {
  return typeof price === 'number' && !isNaN(price);
}

/**
 * Get the effective price for a menu item based on order type.
 * 
 * Price selection logic:
 * - 'delivery' orders: use delivery_price if available, otherwise fallback to pickup_price
 * - 'pickup' orders: use pickup_price if available, otherwise fallback to price
 * - 'dine-in' orders: use instore_price if available, otherwise fallback to pickup_price
 * 
 * Fallback chain: order-type-specific price -> pickup_price -> price -> 0
 * 
 * @param item - The menu item with price fields
 * @param orderType - The type of order ('delivery', 'pickup', or 'dine-in')
 * @returns The effective price for the given order type
 * 
 * **Validates: Requirements 9.5, 9.6, 9.7, 9.8**
 */
function getMenuItemPrice(item: PriceableItem, orderType: OrderType): number {
  // Get the order-type-specific price
  let specificPrice: number | null | undefined;
  
  switch (orderType) {
    case 'delivery':
      specificPrice = item.delivery_price;
      break;
    case 'pickup':
      specificPrice = item.pickup_price;
      break;
    case 'dine-in':
      specificPrice = item.instore_price;
      break;
  }
  
  // If specific price is available (not null/undefined and is a valid number), use it
  if (isValidPrice(specificPrice)) {
    return specificPrice;
  }
  
  // Fallback to pickup_price (as per Requirements 9.8)
  if (isValidPrice(item.pickup_price)) {
    return item.pickup_price;
  }
  
  // Final fallback to base price
  if (isValidPrice(item.price)) {
    return item.price;
  }
  
  // Default to 0 if no price is available
  return 0;
}

/**
 * Get the fallback price for an item (pickup_price or price)
 */
function getFallbackPrice(item: PriceableItem): number {
  if (isValidPrice(item.pickup_price)) {
    return item.pickup_price;
  }
  if (isValidPrice(item.price)) {
    return item.price;
  }
  return 0;
}

// =============================================
// ARBITRARIES
// =============================================

/**
 * Arbitrary for generating valid positive prices
 */
const validPriceArb = fc.double({ min: 0.01, max: 1000, noNaN: true });

/**
 * Arbitrary for generating null/undefined prices
 */
const nullishPriceArb = fc.constantFrom(null, undefined);

/**
 * Arbitrary for generating any price (valid, null, or undefined)
 */
const anyPriceArb = fc.oneof(
  validPriceArb,
  nullishPriceArb
);

/**
 * Arbitrary for generating order types
 */
const orderTypeArb: fc.Arbitrary<OrderType> = fc.constantFrom('delivery', 'pickup', 'dine-in');

/**
 * Arbitrary for generating a PriceableItem with all prices defined
 */
const priceableItemWithAllPricesArb: fc.Arbitrary<PriceableItem> = fc.record({
  price: validPriceArb,
  pickup_price: validPriceArb,
  delivery_price: validPriceArb,
  instore_price: validPriceArb,
});

/**
 * Arbitrary for generating a PriceableItem with some prices potentially null/undefined
 */
const priceableItemArb: fc.Arbitrary<PriceableItem> = fc.record({
  price: anyPriceArb,
  pickup_price: anyPriceArb,
  delivery_price: anyPriceArb,
  instore_price: anyPriceArb,
});

/**
 * Arbitrary for generating a PriceableItem with only pickup_price defined
 */
const priceableItemOnlyPickupArb: fc.Arbitrary<PriceableItem> = fc.record({
  price: nullishPriceArb,
  pickup_price: validPriceArb,
  delivery_price: nullishPriceArb,
  instore_price: nullishPriceArb,
});

/**
 * Arbitrary for generating a PriceableItem with no prices defined
 */
const priceableItemNoPricesArb: fc.Arbitrary<PriceableItem> = fc.record({
  price: nullishPriceArb,
  pickup_price: nullishPriceArb,
  delivery_price: nullishPriceArb,
  instore_price: nullishPriceArb,
});

// =============================================
// PROPERTY TESTS
// =============================================

describe('PricingService Property Tests', () => {
  /**
   * **Feature: pos-tables-reservations-sync, Property 14: Price Fallback Logic**
   * **Validates: Requirements 9.8**
   * 
   * Property: For any menu item where the order-type-specific price is null or undefined,
   * the system SHALL use pickup_price as the fallback.
   */
  describe('Property 14: Price Fallback Logic', () => {
    it('when delivery_price is null/undefined, SHALL fallback to pickup_price', () => {
      fc.assert(
        fc.property(
          fc.record({
            price: anyPriceArb,
            pickup_price: validPriceArb, // pickup_price is defined
            delivery_price: nullishPriceArb, // delivery_price is null/undefined
            instore_price: anyPriceArb,
          }),
          (item) => {
            const result = getMenuItemPrice(item, 'delivery');
            // Should fallback to pickup_price
            expect(result).toBe(item.pickup_price);
          }
        ),
        { verbose: true }
      );
    });

    it('when instore_price is null/undefined, SHALL fallback to pickup_price', () => {
      fc.assert(
        fc.property(
          fc.record({
            price: anyPriceArb,
            pickup_price: validPriceArb, // pickup_price is defined
            delivery_price: anyPriceArb,
            instore_price: nullishPriceArb, // instore_price is null/undefined
          }),
          (item) => {
            const result = getMenuItemPrice(item, 'dine-in');
            // Should fallback to pickup_price
            expect(result).toBe(item.pickup_price);
          }
        ),
        { verbose: true }
      );
    });

    it('when pickup_price is null/undefined, SHALL fallback to base price', () => {
      fc.assert(
        fc.property(
          fc.record({
            price: validPriceArb, // base price is defined
            pickup_price: nullishPriceArb, // pickup_price is null/undefined
            delivery_price: nullishPriceArb,
            instore_price: nullishPriceArb,
          }),
          (item) => {
            const result = getMenuItemPrice(item, 'pickup');
            // Should fallback to base price
            expect(result).toBe(item.price);
          }
        ),
        { verbose: true }
      );
    });

    it('when all prices are null/undefined, SHALL return 0', () => {
      fc.assert(
        fc.property(
          priceableItemNoPricesArb,
          orderTypeArb,
          (item, orderType) => {
            const result = getMenuItemPrice(item, orderType);
            expect(result).toBe(0);
          }
        ),
        { verbose: true }
      );
    });

    it('when order-type-specific price is defined, SHALL use it (no fallback)', () => {
      fc.assert(
        fc.property(
          priceableItemWithAllPricesArb,
          orderTypeArb,
          (item, orderType) => {
            const result = getMenuItemPrice(item, orderType);
            
            // Should use the specific price for the order type
            switch (orderType) {
              case 'delivery':
                expect(result).toBe(item.delivery_price);
                break;
              case 'pickup':
                expect(result).toBe(item.pickup_price);
                break;
              case 'dine-in':
                expect(result).toBe(item.instore_price);
                break;
            }
          }
        ),
        { verbose: true }
      );
    });

    it('fallback chain: specific -> pickup_price -> price -> 0', () => {
      fc.assert(
        fc.property(
          priceableItemArb,
          orderTypeArb,
          (item, orderType) => {
            const result = getMenuItemPrice(item, orderType);
            
            // Get the specific price for this order type
            let specificPrice: number | null | undefined;
            switch (orderType) {
              case 'delivery':
                specificPrice = item.delivery_price;
                break;
              case 'pickup':
                specificPrice = item.pickup_price;
                break;
              case 'dine-in':
                specificPrice = item.instore_price;
                break;
            }
            
            // Verify fallback chain
            if (isValidPrice(specificPrice)) {
              expect(result).toBe(specificPrice);
            } else if (isValidPrice(item.pickup_price)) {
              expect(result).toBe(item.pickup_price);
            } else if (isValidPrice(item.price)) {
              expect(result).toBe(item.price);
            } else {
              expect(result).toBe(0);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('result is always a non-negative number', () => {
      fc.assert(
        fc.property(
          priceableItemArb,
          orderTypeArb,
          (item, orderType) => {
            const result = getMenuItemPrice(item, orderType);
            expect(typeof result).toBe('number');
            expect(result).toBeGreaterThanOrEqual(0);
            expect(Number.isNaN(result)).toBe(false);
          }
        ),
        { verbose: true }
      );
    });
  });

  describe('isValidPrice helper', () => {
    it('returns true for valid positive numbers', () => {
      fc.assert(
        fc.property(
          validPriceArb,
          (price) => {
            expect(isValidPrice(price)).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    it('returns false for null', () => {
      expect(isValidPrice(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isValidPrice(undefined)).toBe(false);
    });

    it('returns false for NaN', () => {
      expect(isValidPrice(NaN)).toBe(false);
    });
  });

  describe('getFallbackPrice helper', () => {
    it('returns pickup_price when available', () => {
      fc.assert(
        fc.property(
          priceableItemOnlyPickupArb,
          (item) => {
            const result = getFallbackPrice(item);
            expect(result).toBe(item.pickup_price);
          }
        ),
        { verbose: true }
      );
    });

    it('returns base price when pickup_price is not available', () => {
      fc.assert(
        fc.property(
          fc.record({
            price: validPriceArb,
            pickup_price: nullishPriceArb,
            delivery_price: anyPriceArb,
            instore_price: anyPriceArb,
          }),
          (item) => {
            const result = getFallbackPrice(item);
            expect(result).toBe(item.price);
          }
        ),
        { verbose: true }
      );
    });

    it('returns 0 when no prices are available', () => {
      fc.assert(
        fc.property(
          priceableItemNoPricesArb,
          (item) => {
            const result = getFallbackPrice(item);
            expect(result).toBe(0);
          }
        ),
        { verbose: true }
      );
    });
  });
});
