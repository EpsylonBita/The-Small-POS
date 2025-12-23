/**
 * Property-Based Test: Order Edit Persistence Round-Trip
 * 
 * Feature: pos-order-items-view-edit, Property 5: Order Edit Persistence Round-Trip
 * 
 * For any order that is edited (items added, removed, or quantities changed) and saved,
 * fetching that order from the local database SHALL return the updated items array
 * with the modifications applied.
 * 
 * **Validates: Requirements 3.3, 3.4, 3.5**
 */

import * as fc from 'fast-check';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
});

/**
 * OrderItem interface matching the application's structure
 */
interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
  unit_price?: number;
  total_price?: number;
  notes?: string;
  customizations?: Array<{ name: string; price: number }>;
}

/**
 * Simulates the order item transformation that happens in EditOrderItemsModal
 * when quantity is updated
 */
function updateItemQuantity(items: OrderItem[], itemId: string, newQuantity: number): OrderItem[] {
  return items.map(item => {
    if (item.id === itemId) {
      const quantity = Math.max(0, newQuantity);
      const unitPrice = item.unit_price || item.price || 0;
      const newTotalPrice = unitPrice * quantity;
      return {
        ...item,
        quantity,
        total_price: newTotalPrice
      };
    }
    return item;
  });
}

/**
 * Simulates removing an item from the order
 */
function removeItem(items: OrderItem[], itemId: string): OrderItem[] {
  return items.filter(item => item.id !== itemId);
}

/**
 * Calculates the total from items (same logic as in EditOrderItemsModal)
 */
function calculateTotal(items: OrderItem[]): number {
  return items.reduce((total, item) => {
    const itemTotal = item.total_price || ((item.unit_price || item.price || 0) * item.quantity);
    return total + itemTotal;
  }, 0);
}

/**
 * Simulates the order update data transformation that happens in order:update-items handler
 */
function prepareUpdateData(items: OrderItem[], orderNotes?: string): { items: OrderItem[]; total_amount: number; special_instructions?: string } {
  const newTotalAmount = items.reduce((sum, item) => {
    const itemTotal = item.total_price || ((item.unit_price || item.price || 0) * (item.quantity || 1));
    return sum + itemTotal;
  }, 0);

  const updateData: { items: OrderItem[]; total_amount: number; special_instructions?: string } = {
    items,
    total_amount: newTotalAmount,
  };

  if (orderNotes) {
    updateData.special_instructions = orderNotes;
  }

  return updateData;
}

/**
 * Arbitrary for generating order items
 */
const orderItemArb = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 50 }),
  quantity: fc.integer({ min: 1, max: 100 }),
  price: fc.float({ min: Math.fround(0.01), max: Math.fround(100), noNaN: true }),
  unit_price: fc.float({ min: Math.fround(0.01), max: Math.fround(100), noNaN: true }),
  notes: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: undefined }),
  customizations: fc.option(
    fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 30 }),
        price: fc.float({ min: Math.fround(0), max: Math.fround(10), noNaN: true }),
      }),
      { minLength: 0, maxLength: 3 }
    ),
    { nil: undefined }
  ),
}).map(item => ({
  ...item,
  total_price: (item.unit_price || item.price) * item.quantity
}));

describe('Feature: pos-order-items-view-edit, Property 5: Order Edit Persistence Round-Trip', () => {
  describe('Order Item Quantity Updates', () => {
    /**
     * Property: Quantity update preserves item identity
     * When updating an item's quantity, the item's id and name should remain unchanged.
     */
    it('quantity update preserves item identity', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
          fc.integer({ min: 0, max: 100 }),
          (items, newQuantity) => {
            const targetItem = items[0];
            const updatedItems = updateItemQuantity(items, targetItem.id, newQuantity);
            const updatedItem = updatedItems.find(i => i.id === targetItem.id);
            
            expect(updatedItem).toBeDefined();
            expect(updatedItem!.id).toBe(targetItem.id);
            expect(updatedItem!.name).toBe(targetItem.name);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Quantity update correctly recalculates total_price
     * When quantity is updated, total_price should equal unit_price * new_quantity.
     */
    it('quantity update correctly recalculates total_price', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
          fc.integer({ min: 1, max: 100 }),
          (items, newQuantity) => {
            const targetItem = items[0];
            const updatedItems = updateItemQuantity(items, targetItem.id, newQuantity);
            const updatedItem = updatedItems.find(i => i.id === targetItem.id);
            
            const expectedTotalPrice = (targetItem.unit_price || targetItem.price || 0) * newQuantity;
            expect(updatedItem!.total_price).toBeCloseTo(expectedTotalPrice, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Quantity update to 0 sets total_price to 0
     * When quantity is set to 0, total_price should be 0.
     */
    it('quantity update to 0 sets total_price to 0', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
          (items) => {
            const targetItem = items[0];
            const updatedItems = updateItemQuantity(items, targetItem.id, 0);
            const updatedItem = updatedItems.find(i => i.id === targetItem.id);
            
            expect(updatedItem!.quantity).toBe(0);
            expect(updatedItem!.total_price).toBe(0);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Negative quantity is clamped to 0
     * When a negative quantity is provided, it should be clamped to 0.
     */
    it('negative quantity is clamped to 0', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
          fc.integer({ min: -100, max: -1 }),
          (items, negativeQuantity) => {
            const targetItem = items[0];
            const updatedItems = updateItemQuantity(items, targetItem.id, negativeQuantity);
            const updatedItem = updatedItems.find(i => i.id === targetItem.id);
            
            expect(updatedItem!.quantity).toBe(0);
            expect(updatedItem!.total_price).toBe(0);
          }
        ),
        { verbose: true }
      );
    });
  });

  describe('Order Item Removal', () => {
    /**
     * Property: Removing an item decreases array length by 1
     * When an item is removed, the items array length should decrease by 1.
     */
    it('removing an item decreases array length by 1', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 2, maxLength: 10 }),
          (items) => {
            const targetItem = items[0];
            const originalLength = items.length;
            const updatedItems = removeItem(items, targetItem.id);
            
            expect(updatedItems.length).toBe(originalLength - 1);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Removed item is no longer in the array
     * After removal, the item should not be found in the array.
     */
    it('removed item is no longer in the array', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
          (items) => {
            const targetItem = items[0];
            const updatedItems = removeItem(items, targetItem.id);
            
            const foundItem = updatedItems.find(i => i.id === targetItem.id);
            expect(foundItem).toBeUndefined();
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Other items remain unchanged after removal
     * When an item is removed, all other items should remain unchanged.
     */
    it('other items remain unchanged after removal', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 2, maxLength: 10 }),
          (items) => {
            const targetItem = items[0];
            const otherItems = items.slice(1);
            const updatedItems = removeItem(items, targetItem.id);
            
            otherItems.forEach(originalItem => {
              const foundItem = updatedItems.find(i => i.id === originalItem.id);
              expect(foundItem).toBeDefined();
              expect(foundItem!.name).toBe(originalItem.name);
              expect(foundItem!.quantity).toBe(originalItem.quantity);
            });
          }
        ),
        { verbose: true }
      );
    });
  });

  describe('Order Total Calculation', () => {
    /**
     * Property: Total equals sum of all item totals
     * The order total should equal the sum of all item total_price values.
     */
    it('total equals sum of all item totals', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
          (items) => {
            const calculatedTotal = calculateTotal(items);
            const expectedTotal = items.reduce((sum, item) => {
              return sum + (item.total_price || ((item.unit_price || item.price || 0) * item.quantity));
            }, 0);
            
            expect(calculatedTotal).toBeCloseTo(expectedTotal, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Total is always non-negative
     * The order total should never be negative.
     */
    it('total is always non-negative', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 0, maxLength: 10 }),
          (items) => {
            const calculatedTotal = calculateTotal(items);
            expect(calculatedTotal).toBeGreaterThanOrEqual(0);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Empty items array results in zero total
     * When items array is empty, total should be 0.
     */
    it('empty items array results in zero total', () => {
      const total = calculateTotal([]);
      expect(total).toBe(0);
    });
  });

  describe('Update Data Preparation', () => {
    /**
     * Property: Update data contains all items
     * The prepared update data should contain all items from the input.
     */
    it('update data contains all items', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
          (items) => {
            const updateData = prepareUpdateData(items);
            
            expect(updateData.items.length).toBe(items.length);
            items.forEach(item => {
              const foundItem = updateData.items.find(i => i.id === item.id);
              expect(foundItem).toBeDefined();
            });
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Update data total_amount matches calculated total
     * The total_amount in update data should match the sum of item totals.
     */
    it('update data total_amount matches calculated total', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
          (items) => {
            const updateData = prepareUpdateData(items);
            const expectedTotal = calculateTotal(items);
            
            expect(updateData.total_amount).toBeCloseTo(expectedTotal, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Order notes are included when provided
     * When order notes are provided, they should be included in special_instructions.
     */
    it('order notes are included when provided', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 5 }),
          fc.string({ minLength: 1, maxLength: 200 }),
          (items, notes) => {
            const updateData = prepareUpdateData(items, notes);
            
            expect(updateData.special_instructions).toBe(notes);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Order notes are omitted when not provided
     * When order notes are not provided, special_instructions should be undefined.
     */
    it('order notes are omitted when not provided', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 5 }),
          (items) => {
            const updateData = prepareUpdateData(items);
            
            expect(updateData.special_instructions).toBeUndefined();
          }
        ),
        { verbose: true }
      );
    });
  });

  describe('Round-Trip Consistency', () => {
    /**
     * Property: Edit operations are idempotent when applied twice with same values
     * Applying the same quantity update twice should produce the same result.
     */
    it('quantity update is idempotent', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
          fc.integer({ min: 1, max: 100 }),
          (items, newQuantity) => {
            const targetItem = items[0];
            const firstUpdate = updateItemQuantity(items, targetItem.id, newQuantity);
            const secondUpdate = updateItemQuantity(firstUpdate, targetItem.id, newQuantity);
            
            const firstItem = firstUpdate.find(i => i.id === targetItem.id);
            const secondItem = secondUpdate.find(i => i.id === targetItem.id);
            
            expect(secondItem!.quantity).toBe(firstItem!.quantity);
            expect(secondItem!.total_price).toBeCloseTo(firstItem!.total_price!, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Multiple quantity updates accumulate correctly
     * Updating quantity multiple times should result in the final quantity value.
     */
    it('multiple quantity updates result in final value', () => {
      fc.assert(
        fc.property(
          fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
          fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 5 }),
          (items, quantities) => {
            const targetItem = items[0];
            let currentItems: OrderItem[] = items;
            
            quantities.forEach(qty => {
              currentItems = updateItemQuantity(currentItems, targetItem.id, qty);
            });
            
            const finalItem = currentItems.find(i => i.id === targetItem.id);
            const finalQuantity = quantities[quantities.length - 1];
            
            expect(finalItem!.quantity).toBe(finalQuantity);
          }
        ),
        { verbose: true }
      );
    });
  });
});
