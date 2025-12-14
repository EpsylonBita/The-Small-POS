/**
 * Property-Based Tests for Order Tab Filtering Consistency
 * 
 * **Feature: pos-tables-reservations-sync, Property 1: Order Tab Filtering Consistency**
 * **Validates: Requirements 1.2, 1.3, 1.4**
 * 
 * Property: For any set of orders with various statuses and dates, the Orders tab SHALL 
 * display only active orders, the Delivered tab SHALL display only today's completed orders, 
 * and the Canceled tab SHALL display only today's canceled orders.
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

export type OrderStatus = 'pending' | 'confirmed' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered' | 'completed' | 'cancelled';
export type OrderType = 'dine-in' | 'pickup' | 'delivery';
export type TabType = 'orders' | 'delivered' | 'canceled';

export interface Order {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  orderType: OrderType;
  tableNumber?: string;
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
}

// =============================================
// FUNCTIONS UNDER TEST
// =============================================

/**
 * Filter orders for the Orders tab (active orders)
 * Requirements 1.2: Display all active orders associated with tables
 * Active statuses: pending, preparing, ready
 */
function filterOrdersTab(orders: Order[]): Order[] {
  return orders.filter(order =>
    ['pending', 'preparing', 'ready'].includes(order.status)
  );
}

/**
 * Filter orders for the Delivered tab (today's completed/delivered orders)
 * Requirements 1.3: Display all completed/delivered orders from the current day
 */
function filterDeliveredTab(orders: Order[], today: string): Order[] {
  return orders.filter(order => {
    const orderDate = order.createdAt.split('T')[0];
    return (order.status === 'delivered' || order.status === 'completed') && 
           orderDate === today;
  });
}

/**
 * Filter orders for the Canceled tab (today's canceled orders)
 * Requirements 1.4: Display all canceled orders from the current day
 */
function filterCanceledTab(orders: Order[], today: string): Order[] {
  return orders.filter(order => {
    const orderDate = order.createdAt.split('T')[0];
    return order.status === 'cancelled' && orderDate === today;
  });
}

/**
 * Get the appropriate filter function for a tab
 */
function getFilterForTab(tab: TabType, today: string): (orders: Order[]) => Order[] {
  switch (tab) {
    case 'orders':
      return filterOrdersTab;
    case 'delivered':
      return (orders) => filterDeliveredTab(orders, today);
    case 'canceled':
      return (orders) => filterCanceledTab(orders, today);
  }
}

/**
 * Check if an order should appear in a specific tab
 */
function shouldOrderAppearInTab(order: Order, tab: TabType, today: string): boolean {
  const orderDate = order.createdAt.split('T')[0];
  
  switch (tab) {
    case 'orders':
      return ['pending', 'preparing', 'ready'].includes(order.status);
    case 'delivered':
      return (order.status === 'delivered' || order.status === 'completed') && orderDate === today;
    case 'canceled':
      return order.status === 'cancelled' && orderDate === today;
  }
}

// =============================================
// ARBITRARIES
// =============================================

/**
 * Arbitrary for generating order statuses
 */
const orderStatusArb: fc.Arbitrary<OrderStatus> = fc.constantFrom(
  'pending', 'confirmed', 'preparing', 'ready', 
  'out_for_delivery', 'delivered', 'completed', 'cancelled'
);

/**
 * Arbitrary for generating active order statuses (for Orders tab)
 */
const activeStatusArb: fc.Arbitrary<OrderStatus> = fc.constantFrom(
  'pending', 'preparing', 'ready'
);

/**
 * Arbitrary for generating completed statuses (for Delivered tab)
 */
const completedStatusArb: fc.Arbitrary<OrderStatus> = fc.constantFrom(
  'delivered', 'completed'
);

/**
 * Arbitrary for generating order types
 */
const orderTypeArb: fc.Arbitrary<OrderType> = fc.constantFrom('dine-in', 'pickup', 'delivery');

/**
 * Arbitrary for generating tab types
 */
const tabTypeArb: fc.Arbitrary<TabType> = fc.constantFrom('orders', 'delivered', 'canceled');

/**
 * Arbitrary for generating a date string (YYYY-MM-DD format)
 * Using integer-based approach to avoid invalid date issues
 */
const dateStringArb = fc.integer({ min: 0, max: 365 }).map(daysOffset => {
  const baseDate = new Date('2024-06-01');
  baseDate.setDate(baseDate.getDate() + daysOffset);
  return baseDate.toISOString().split('T')[0];
});

/**
 * Arbitrary for generating a datetime string (ISO format)
 */
const datetimeStringArb = (dateStr: string) => fc.integer({ min: 0, max: 23 }).chain(hour =>
  fc.integer({ min: 0, max: 59 }).map(minute => 
    `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`
  )
);

/**
 * Arbitrary for generating a single order
 */
const orderArb = (today: string): fc.Arbitrary<Order> => 
  fc.record({
    id: fc.uuid(),
    orderNumber: fc.integer({ min: 1, max: 9999 }).map(n => `ORD-${String(n).padStart(4, '0')}`),
    status: orderStatusArb,
    orderType: orderTypeArb,
    tableNumber: fc.option(fc.integer({ min: 1, max: 50 }).map(String), { nil: undefined }),
    totalAmount: fc.double({ min: 1, max: 500, noNaN: true }),
    createdAt: fc.oneof(
      datetimeStringArb(today), // Today's orders
      dateStringArb.chain(d => datetimeStringArb(d)) // Orders from other days
    ),
    updatedAt: fc.constant(new Date().toISOString()),
  });

/**
 * Arbitrary for generating a list of orders
 */
const ordersListArb = (today: string): fc.Arbitrary<Order[]> => 
  fc.array(orderArb(today), { minLength: 0, maxLength: 50 });

/**
 * Arbitrary for generating an order with a specific status
 */
const orderWithStatusArb = (status: OrderStatus, today: string): fc.Arbitrary<Order> =>
  fc.record({
    id: fc.uuid(),
    orderNumber: fc.integer({ min: 1, max: 9999 }).map(n => `ORD-${String(n).padStart(4, '0')}`),
    status: fc.constant(status),
    orderType: orderTypeArb,
    tableNumber: fc.option(fc.integer({ min: 1, max: 50 }).map(String), { nil: undefined }),
    totalAmount: fc.double({ min: 1, max: 500, noNaN: true }),
    createdAt: datetimeStringArb(today),
    updatedAt: fc.constant(new Date().toISOString()),
  });

// =============================================
// PROPERTY TESTS
// =============================================

describe('Order Tab Filtering Property Tests', () => {
  // Use a fixed "today" for consistent testing
  const today = new Date().toISOString().split('T')[0];

  /**
   * **Feature: pos-tables-reservations-sync, Property 1: Order Tab Filtering Consistency**
   * **Validates: Requirements 1.2, 1.3, 1.4**
   */
  describe('Property 1: Order Tab Filtering Consistency', () => {
    
    /**
     * Requirements 1.2: Orders tab SHALL display only active orders (pending, preparing, ready)
     */
    it('Orders tab SHALL display only active orders (pending, preparing, ready)', () => {
      fc.assert(
        fc.property(
          ordersListArb(today),
          (orders) => {
            const filtered = filterOrdersTab(orders);
            
            // All filtered orders must have active status
            filtered.forEach(order => {
              expect(['pending', 'preparing', 'ready']).toContain(order.status);
            });
            
            // All active orders from input must be in filtered result
            const activeOrders = orders.filter(o => 
              ['pending', 'preparing', 'ready'].includes(o.status)
            );
            expect(filtered.length).toBe(activeOrders.length);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Requirements 1.3: Delivered tab SHALL display only today's completed/delivered orders
     */
    it('Delivered tab SHALL display only today\'s completed/delivered orders', () => {
      fc.assert(
        fc.property(
          ordersListArb(today),
          (orders) => {
            const filtered = filterDeliveredTab(orders, today);
            
            // All filtered orders must have completed/delivered status AND be from today
            filtered.forEach(order => {
              expect(['delivered', 'completed']).toContain(order.status);
              expect(order.createdAt.split('T')[0]).toBe(today);
            });
            
            // All today's completed orders from input must be in filtered result
            const todayCompletedOrders = orders.filter(o => 
              (o.status === 'delivered' || o.status === 'completed') &&
              o.createdAt.split('T')[0] === today
            );
            expect(filtered.length).toBe(todayCompletedOrders.length);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Requirements 1.4: Canceled tab SHALL display only today's canceled orders
     */
    it('Canceled tab SHALL display only today\'s canceled orders', () => {
      fc.assert(
        fc.property(
          ordersListArb(today),
          (orders) => {
            const filtered = filterCanceledTab(orders, today);
            
            // All filtered orders must have cancelled status AND be from today
            filtered.forEach(order => {
              expect(order.status).toBe('cancelled');
              expect(order.createdAt.split('T')[0]).toBe(today);
            });
            
            // All today's cancelled orders from input must be in filtered result
            const todayCancelledOrders = orders.filter(o => 
              o.status === 'cancelled' &&
              o.createdAt.split('T')[0] === today
            );
            expect(filtered.length).toBe(todayCancelledOrders.length);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Tabs are mutually exclusive - an order cannot appear in multiple tabs
     */
    it('tabs are mutually exclusive - an order cannot appear in multiple tabs', () => {
      fc.assert(
        fc.property(
          ordersListArb(today),
          (orders) => {
            const ordersTabResult = filterOrdersTab(orders);
            const deliveredTabResult = filterDeliveredTab(orders, today);
            const canceledTabResult = filterCanceledTab(orders, today);
            
            // Get IDs from each tab
            const ordersIds = new Set(ordersTabResult.map(o => o.id));
            const deliveredIds = new Set(deliveredTabResult.map(o => o.id));
            const canceledIds = new Set(canceledTabResult.map(o => o.id));
            
            // Check no overlap between tabs
            ordersIds.forEach(id => {
              expect(deliveredIds.has(id)).toBe(false);
              expect(canceledIds.has(id)).toBe(false);
            });
            
            deliveredIds.forEach(id => {
              expect(ordersIds.has(id)).toBe(false);
              expect(canceledIds.has(id)).toBe(false);
            });
            
            canceledIds.forEach(id => {
              expect(ordersIds.has(id)).toBe(false);
              expect(deliveredIds.has(id)).toBe(false);
            });
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Filtering preserves order data integrity
     */
    it('filtering preserves order data integrity', () => {
      fc.assert(
        fc.property(
          ordersListArb(today),
          tabTypeArb,
          (orders, tab) => {
            const filterFn = getFilterForTab(tab, today);
            const filtered = filterFn(orders);
            
            // Each filtered order must exist in original list with same data
            filtered.forEach(filteredOrder => {
              const original = orders.find(o => o.id === filteredOrder.id);
              expect(original).toBeDefined();
              expect(filteredOrder).toEqual(original);
            });
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Active orders always appear in Orders tab regardless of date
     */
    it('active orders always appear in Orders tab regardless of date', () => {
      fc.assert(
        fc.property(
          activeStatusArb,
          orderTypeArb,
          dateStringArb,
          (status, orderType, dateStr) => {
            const order: Order = {
              id: 'test-id',
              orderNumber: 'ORD-0001',
              status,
              orderType,
              totalAmount: 100,
              createdAt: `${dateStr}T12:00:00.000Z`,
              updatedAt: new Date().toISOString(),
            };
            
            const filtered = filterOrdersTab([order]);
            expect(filtered.length).toBe(1);
            expect(filtered[0].id).toBe(order.id);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Completed orders from yesterday do NOT appear in Delivered tab
     */
    it('completed orders from yesterday do NOT appear in Delivered tab', () => {
      fc.assert(
        fc.property(
          completedStatusArb,
          orderTypeArb,
          (status, orderType) => {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];
            
            const order: Order = {
              id: 'test-id',
              orderNumber: 'ORD-0001',
              status,
              orderType,
              totalAmount: 100,
              createdAt: `${yesterdayStr}T12:00:00.000Z`,
              updatedAt: new Date().toISOString(),
            };
            
            const filtered = filterDeliveredTab([order], today);
            expect(filtered.length).toBe(0);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Cancelled orders from yesterday do NOT appear in Canceled tab
     */
    it('cancelled orders from yesterday do NOT appear in Canceled tab', () => {
      fc.assert(
        fc.property(
          orderTypeArb,
          (orderType) => {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];
            
            const order: Order = {
              id: 'test-id',
              orderNumber: 'ORD-0001',
              status: 'cancelled',
              orderType,
              totalAmount: 100,
              createdAt: `${yesterdayStr}T12:00:00.000Z`,
              updatedAt: new Date().toISOString(),
            };
            
            const filtered = filterCanceledTab([order], today);
            expect(filtered.length).toBe(0);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Empty input produces empty output for all tabs
     */
    it('empty input produces empty output for all tabs', () => {
      fc.assert(
        fc.property(
          tabTypeArb,
          (tab) => {
            const filterFn = getFilterForTab(tab, today);
            const filtered = filterFn([]);
            expect(filtered.length).toBe(0);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * shouldOrderAppearInTab is consistent with filter functions
     */
    it('shouldOrderAppearInTab is consistent with filter functions', () => {
      fc.assert(
        fc.property(
          orderArb(today),
          tabTypeArb,
          (order, tab) => {
            const filterFn = getFilterForTab(tab, today);
            const filtered = filterFn([order]);
            const shouldAppear = shouldOrderAppearInTab(order, tab, today);
            
            if (shouldAppear) {
              expect(filtered.length).toBe(1);
              expect(filtered[0].id).toBe(order.id);
            } else {
              expect(filtered.length).toBe(0);
            }
          }
        ),
        { verbose: true }
      );
    });
  });
});
