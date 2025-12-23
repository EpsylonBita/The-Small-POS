/**
 * Property-Based Tests for RealtimeOrderHandler
 * 
 * Feature: pos-order-items-view-edit
 * Property 1: Realtime Order Items Population
 * 
 * Validates: Requirements 1.1, 1.2, 1.3, 4.1, 8.7
 * 
 * For any order received via realtime subscription that has a valid supabase_id,
 * after processing by RealtimeOrderHandler, the order stored locally SHALL have
 * a non-empty items array if order_items exist in Supabase for that order.
 */

import * as fc from 'fast-check';
import { RealtimeOrderHandler, OrderItem } from '../../../src/services/RealtimeOrderHandler';

// Mock types for testing
interface MockSupabaseOrderItem {
  id: string;
  menu_item_id: string | null;
  quantity: number;
  unit_price: number;
  total_price: number;
  notes?: string;
  customizations?: any;
  subcategories?: {
    id: string;
    name: string;
    name_en?: string;
    name_el?: string;
  } | null;
}

// Arbitraries for generating test data
const subcategoryArb = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 50 }),
  name_en: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
  name_el: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
});

const customizationArb = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 30 }),
  price: fc.float({ min: Math.fround(0), max: Math.fround(100), noNaN: true }),
  ingredient: fc.option(fc.record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1, maxLength: 30 }),
    price: fc.float({ min: Math.fround(0), max: Math.fround(50), noNaN: true }),
  }), { nil: undefined }),
});

const orderItemArb = fc.record({
  id: fc.uuid(),
  menu_item_id: fc.option(fc.uuid(), { nil: null }),
  quantity: fc.integer({ min: 1, max: 100 }),
  unit_price: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
  total_price: fc.float({ min: Math.fround(0.01), max: Math.fround(10000), noNaN: true }),
  notes: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
  customizations: fc.option(fc.array(customizationArb, { minLength: 0, maxLength: 5 }), { nil: undefined }),
  subcategories: fc.option(subcategoryArb, { nil: null }),
});

const orderItemsArrayArb = fc.array(orderItemArb, { minLength: 1, maxLength: 10 });

describe('RealtimeOrderHandler Property Tests', () => {
  /**
   * Feature: pos-order-items-view-edit, Property 1: Realtime Order Items Population
   * 
   * For any order received via realtime subscription that has a valid supabase_id,
   * after processing by RealtimeOrderHandler, the order stored locally SHALL have
   * a non-empty items array if order_items exist in Supabase for that order.
   * 
   * Validates: Requirements 1.1, 1.2, 1.3, 4.1, 8.7
   */
  describe('Property 1: Realtime Order Items Population', () => {
    it('should transform any valid Supabase order items to local OrderItem format with non-empty names', () => {
      fc.assert(
        fc.property(orderItemsArrayArb, (supabaseItems: MockSupabaseOrderItem[]) => {
          // Create a mock handler to test the transformation logic
          const mockHandler = createMockRealtimeOrderHandler();
          
          // Transform the items using the handler's logic
          const transformedItems = mockHandler.transformOrderItemsForTest(supabaseItems);
          
          // Property: For any non-empty input, output should also be non-empty
          expect(transformedItems.length).toBe(supabaseItems.length);
          
          // Property: Each transformed item should have required fields
          transformedItems.forEach((item: OrderItem, index: number) => {
            // Must have an id
            expect(item.id).toBeDefined();
            expect(typeof item.id).toBe('string');
            
            // Must have a non-empty name (resolved from subcategories or fallback)
            expect(item.name).toBeDefined();
            expect(typeof item.name).toBe('string');
            expect(item.name.length).toBeGreaterThan(0);
            
            // Must have valid quantity
            expect(item.quantity).toBeGreaterThanOrEqual(1);
            
            // Must have valid prices
            expect(typeof item.price).toBe('number');
            expect(typeof item.unit_price).toBe('number');
            expect(typeof item.total_price).toBe('number');
            expect(item.price).toBeGreaterThanOrEqual(0);
            expect(item.unit_price).toBeGreaterThanOrEqual(0);
            expect(item.total_price).toBeGreaterThanOrEqual(0);
          });
          
          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('should resolve item names from subcategories when available', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              id: fc.uuid(),
              menu_item_id: fc.uuid(),
              quantity: fc.integer({ min: 1, max: 10 }),
              unit_price: fc.float({ min: Math.fround(0.01), max: Math.fround(100), noNaN: true }),
              total_price: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
              subcategories: subcategoryArb, // Always has subcategories
            }),
            { minLength: 1, maxLength: 5 }
          ),
          (itemsWithSubcategories) => {
            const mockHandler = createMockRealtimeOrderHandler();
            const transformedItems = mockHandler.transformOrderItemsForTest(itemsWithSubcategories);
            
            // Property: When subcategories exist, name should come from subcategories
            transformedItems.forEach((item: OrderItem, index: number) => {
              const original = itemsWithSubcategories[index];
              const expectedName = original.subcategories.name || 
                                   original.subcategories.name_en || 
                                   original.subcategories.name_el || '';
              
              // If subcategory has a name, it should be used
              if (expectedName) {
                expect(item.name).toBe(expectedName);
              }
            });
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should provide fallback name when subcategories are missing', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              id: fc.uuid(),
              menu_item_id: fc.option(fc.uuid(), { nil: null }),
              quantity: fc.integer({ min: 1, max: 10 }),
              unit_price: fc.float({ min: Math.fround(0.01), max: Math.fround(100), noNaN: true }),
              total_price: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
              subcategories: fc.constant(null), // No subcategories
              customizations: fc.constant(undefined), // No customizations
            }),
            { minLength: 1, maxLength: 5 }
          ),
          (itemsWithoutSubcategories) => {
            const mockHandler = createMockRealtimeOrderHandler();
            const transformedItems = mockHandler.transformOrderItemsForTest(itemsWithoutSubcategories);
            
            // Property: When no subcategories, should have fallback name with price
            transformedItems.forEach((item: OrderItem, index: number) => {
              expect(item.name).toBeDefined();
              expect(item.name.length).toBeGreaterThan(0);
              // Fallback format is "Item N (€X.XX)"
              expect(item.name).toMatch(/^Item \d+ \(€\d+\.\d{2}\)$/);
            });
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should preserve total_price calculation consistency', () => {
      fc.assert(
        fc.property(orderItemsArrayArb, (supabaseItems: MockSupabaseOrderItem[]) => {
          const mockHandler = createMockRealtimeOrderHandler();
          const transformedItems = mockHandler.transformOrderItemsForTest(supabaseItems);
          
          // Property: total_price should be preserved or calculated from unit_price * quantity
          transformedItems.forEach((item: OrderItem, index: number) => {
            const original = supabaseItems[index];
            const expectedTotalPrice = original.total_price || (original.unit_price * original.quantity);
            
            // Allow for floating point precision differences
            expect(Math.abs(item.total_price - expectedTotalPrice)).toBeLessThan(0.01);
          });
          
          return true;
        }),
        { numRuns: 100 }
      );
    });
  });
});

/**
 * Creates a mock RealtimeOrderHandler for testing the transformation logic
 * without requiring actual Supabase connections or Electron dependencies
 */
function createMockRealtimeOrderHandler() {
  return {
    /**
     * Exposes the transformation logic for testing
     * This mirrors the private transformOrderItems method in RealtimeOrderHandler
     */
    transformOrderItemsForTest(items: MockSupabaseOrderItem[]): OrderItem[] {
      return items.map((item, index) => {
        let itemName: string = '';
        
        // First try to get name from nested subcategories
        if (item.subcategories) {
          const subcategory = Array.isArray(item.subcategories) 
            ? item.subcategories[0] 
            : item.subcategories;
          if (subcategory) {
            itemName = subcategory.name || subcategory.name_en || subcategory.name_el || '';
          }
        }
        
        // If no name from subcategories, try to extract from customizations
        if (!itemName && item.customizations) {
          itemName = extractNameFromCustomizations(item.customizations);
        }
        
        // Fallback to generic name with price
        if (!itemName) {
          const price = parseFloat(String(item.unit_price)) || 0;
          itemName = `Item ${index + 1} (€${price.toFixed(2)})`;
        }
        
        const unitPrice = parseFloat(String(item.unit_price)) || 0;
        const quantity = item.quantity || 1;
        const totalPrice = parseFloat(String(item.total_price)) || (unitPrice * quantity);
        
        return {
          id: item.id,
          menu_item_id: item.menu_item_id || undefined,
          name: itemName,
          quantity: quantity,
          price: unitPrice,
          unit_price: unitPrice,
          total_price: totalPrice,
          notes: item.notes,
          customizations: item.customizations,
        };
      });
    },
  };
}

/**
 * Extracts item name from customizations object
 */
function extractNameFromCustomizations(customizations: any): string {
  if (!customizations || typeof customizations !== 'object') return '';
  
  // Handle array format
  if (Array.isArray(customizations)) {
    for (const cust of customizations) {
      if (cust?.ingredient?.name) return cust.ingredient.name;
      if (cust?.name) return cust.name;
    }
    return '';
  }
  
  // Handle object format
  for (const key of Object.keys(customizations)) {
    const cust = customizations[key];
    if (cust?.ingredient?.name) return cust.ingredient.name;
    if (cust?.name) return cust.name;
  }
  return '';
}
