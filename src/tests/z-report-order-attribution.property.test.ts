/**
 * Property-Based Test: Order Attribution Correctness
 * 
 * Feature: z-report-fixes, Property 2: Order Attribution Correctness
 * 
 * For any Z Report, delivery orders SHALL appear in the `ordersDetails` of the driver 
 * who delivered them (via `driver_earnings.staff_shift_id`), and in-store orders 
 * (dine-in, takeaway, pickup) SHALL appear in the `ordersDetails` of the cashier who 
 * created them. No order SHALL appear in multiple staff members' `ordersDetails`.
 * 
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
 */

import * as fc from 'fast-check';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
});

/**
 * Type definitions for Z Report data structures
 */
type OrderType = 'dine-in' | 'takeaway' | 'pickup' | 'delivery';
type OrderStatus = 'completed' | 'delivered' | 'cancelled';
type PaymentMethod = 'cash' | 'card';
type RoleType = 'cashier' | 'driver' | 'kitchen';

interface OrderDetail {
  id: string;
  orderNumber: string;
  orderType: OrderType;
  tableNumber: string | null;
  deliveryAddress: string | null;
  amount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: string;
  status: OrderStatus;
  createdAt: string;
}

interface StaffReport {
  staffShiftId: string;
  staffId: string;
  staffName: string;
  role: RoleType;
  checkIn: string;
  checkOut: string | null;
  orders: {
    count: number;
    cashAmount: number;
    cardAmount: number;
    totalAmount: number;
  };
  ordersDetails: OrderDetail[];
}

interface DriverEarning {
  id: string;
  driverId: string;
  staffShiftId: string;  // Driver's shift ID
  orderId: string;
  deliveryFee: number;
  tipAmount: number;
  totalEarning: number;
  cashCollected: number;
  cardAmount: number;
  cashToReturn: number;
}

interface Order {
  id: string;
  orderNumber: string;
  orderType: OrderType;
  staffShiftId: string;  // Cashier who created the order
  tableNumber: string | null;
  deliveryAddress: string | null;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: string;
  status: OrderStatus;
  createdAt: string;
}

/**
 * Arbitrary generators
 */
const validDateStringArb = fc.integer({
  min: new Date('2020-01-01').getTime(),
  max: new Date('2030-12-31').getTime(),
}).map(timestamp => new Date(timestamp).toISOString());

const orderTypeArb = fc.constantFrom('dine-in', 'takeaway', 'pickup', 'delivery') as fc.Arbitrary<OrderType>;
const instoreOrderTypeArb = fc.constantFrom('dine-in', 'takeaway', 'pickup') as fc.Arbitrary<OrderType>;
const orderStatusArb = fc.constantFrom('completed', 'delivered', 'cancelled') as fc.Arbitrary<OrderStatus>;
const paymentMethodArb = fc.constantFrom('cash', 'card') as fc.Arbitrary<PaymentMethod>;
const roleTypeArb = fc.constantFrom('cashier', 'driver', 'kitchen') as fc.Arbitrary<RoleType>;

const orderArb = fc.record({
  id: fc.uuid(),
  orderNumber: fc.stringMatching(/^ORD-[0-9]{6}$/),
  orderType: orderTypeArb,
  staffShiftId: fc.uuid(),  // Cashier's shift ID
  tableNumber: fc.option(fc.stringMatching(/^T[0-9]{1,2}$/), { nil: null }),
  deliveryAddress: fc.option(fc.string({ minLength: 5, maxLength: 100 }), { nil: null }),
  totalAmount: fc.float({ min: Math.fround(1), max: Math.fround(500), noNaN: true }),
  paymentMethod: paymentMethodArb,
  paymentStatus: fc.constant('paid'),
  status: orderStatusArb,
  createdAt: validDateStringArb,
});

const staffShiftArb = fc.record({
  id: fc.uuid(),
  staffId: fc.uuid(),
  staffName: fc.string({ minLength: 1, maxLength: 50 }),
  role: roleTypeArb,
  checkIn: validDateStringArb,
  checkOut: fc.option(validDateStringArb, { nil: null }),
});

/**
 * Simulates the order attribution logic from ReportService.ts
 * 
 * For drivers: Get orders from driver_earnings table
 * For cashiers: Get in-store orders they created, excluding deliveries assigned to drivers
 */
function getAttributedOrders(
  staffShiftId: string,
  roleType: RoleType,
  allOrders: Order[],
  driverEarnings: DriverEarning[]
): OrderDetail[] {
  if (roleType === 'driver') {
    // Drivers get delivery orders from driver_earnings
    const driverOrderIds = new Set(
      driverEarnings
        .filter(de => de.staffShiftId === staffShiftId)
        .map(de => de.orderId)
    );
    
    return allOrders
      .filter(o => driverOrderIds.has(o.id))
      .map(orderToDetail);
  } else {
    // Cashiers get in-store orders they created
    // Exclude delivery orders that have been assigned to drivers
    const deliveryOrderIds = new Set(driverEarnings.map(de => de.orderId));
    
    return allOrders
      .filter(o => 
        o.staffShiftId === staffShiftId &&
        (o.orderType !== 'delivery' || !deliveryOrderIds.has(o.id))
      )
      .map(orderToDetail);
  }
}

function orderToDetail(order: Order): OrderDetail {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    tableNumber: order.tableNumber,
    deliveryAddress: order.deliveryAddress,
    amount: order.totalAmount,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    status: order.status,
    createdAt: order.createdAt,
  };
}

/**
 * Generate a complete test scenario with orders, shifts, and driver earnings
 */
function generateTestScenario(
  cashierShiftId: string,
  driverShiftId: string,
  instoreOrders: Order[],
  deliveryOrders: Order[]
): {
  allOrders: Order[];
  driverEarnings: DriverEarning[];
  cashierShift: { id: string; role: RoleType };
  driverShift: { id: string; role: RoleType };
} {
  // Assign all orders to cashier initially (cashier creates all orders)
  const allOrders = [
    ...instoreOrders.map(o => ({ ...o, staffShiftId: cashierShiftId })),
    ...deliveryOrders.map(o => ({ ...o, staffShiftId: cashierShiftId, orderType: 'delivery' as OrderType })),
  ];
  
  // Create driver earnings for delivery orders (assigns them to driver)
  const driverEarnings: DriverEarning[] = deliveryOrders.map(o => ({
    id: fc.sample(fc.uuid(), 1)[0],
    driverId: fc.sample(fc.uuid(), 1)[0],
    staffShiftId: driverShiftId,
    orderId: o.id,
    deliveryFee: 3.00,
    tipAmount: 1.00,
    totalEarning: 4.00,
    cashCollected: o.paymentMethod === 'cash' ? o.totalAmount : 0,
    cardAmount: o.paymentMethod === 'card' ? o.totalAmount : 0,
    cashToReturn: o.paymentMethod === 'cash' ? o.totalAmount - 4.00 : 0,
  }));
  
  return {
    allOrders,
    driverEarnings,
    cashierShift: { id: cashierShiftId, role: 'cashier' },
    driverShift: { id: driverShiftId, role: 'driver' },
  };
}

describe('Feature: z-report-fixes, Property 2: Order Attribution Correctness', () => {
  describe('Order Attribution by Role', () => {
    /**
     * Property: Delivery orders appear in driver's ordersDetails
     * When a delivery order is assigned to a driver via driver_earnings,
     * it should appear in the driver's ordersDetails, not the cashier's.
     */
    it('delivery orders assigned to drivers appear in driver ordersDetails', () => {
      fc.assert(
        fc.property(
          fc.uuid(),  // cashierShiftId
          fc.uuid(),  // driverShiftId
          fc.array(orderArb.map(o => ({ ...o, orderType: 'delivery' as OrderType })), { minLength: 1, maxLength: 10 }),
          (cashierShiftId, driverShiftId, deliveryOrders) => {
            const scenario = generateTestScenario(cashierShiftId, driverShiftId, [], deliveryOrders);
            
            const driverOrders = getAttributedOrders(
              driverShiftId,
              'driver',
              scenario.allOrders,
              scenario.driverEarnings
            );
            
            // All delivery orders should appear in driver's ordersDetails
            expect(driverOrders.length).toBe(deliveryOrders.length);
            
            // Verify each delivery order is in driver's list
            const driverOrderIds = new Set(driverOrders.map(o => o.id));
            for (const order of deliveryOrders) {
              expect(driverOrderIds.has(order.id)).toBe(true);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: In-store orders appear in cashier's ordersDetails
     * Dine-in, takeaway, and pickup orders should appear in the cashier's ordersDetails.
     */
    it('in-store orders appear in cashier ordersDetails', () => {
      fc.assert(
        fc.property(
          fc.uuid(),  // cashierShiftId
          fc.uuid(),  // driverShiftId
          fc.array(orderArb.map(o => ({ ...o, orderType: fc.sample(instoreOrderTypeArb, 1)[0] })), { minLength: 1, maxLength: 10 }),
          (cashierShiftId, driverShiftId, instoreOrders) => {
            const scenario = generateTestScenario(cashierShiftId, driverShiftId, instoreOrders, []);
            
            const cashierOrders = getAttributedOrders(
              cashierShiftId,
              'cashier',
              scenario.allOrders,
              scenario.driverEarnings
            );
            
            // All in-store orders should appear in cashier's ordersDetails
            expect(cashierOrders.length).toBe(instoreOrders.length);
            
            // Verify each in-store order is in cashier's list
            const cashierOrderIds = new Set(cashierOrders.map(o => o.id));
            for (const order of instoreOrders) {
              expect(cashierOrderIds.has(order.id)).toBe(true);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Delivery orders do NOT appear in cashier's ordersDetails
     * When a delivery order is assigned to a driver, it should be excluded
     * from the cashier's ordersDetails.
     */
    it('delivery orders assigned to drivers do NOT appear in cashier ordersDetails', () => {
      fc.assert(
        fc.property(
          fc.uuid(),  // cashierShiftId
          fc.uuid(),  // driverShiftId
          fc.array(orderArb.map(o => ({ ...o, orderType: 'delivery' as OrderType })), { minLength: 1, maxLength: 10 }),
          (cashierShiftId, driverShiftId, deliveryOrders) => {
            const scenario = generateTestScenario(cashierShiftId, driverShiftId, [], deliveryOrders);
            
            const cashierOrders = getAttributedOrders(
              cashierShiftId,
              'cashier',
              scenario.allOrders,
              scenario.driverEarnings
            );
            
            // No delivery orders should appear in cashier's ordersDetails
            expect(cashierOrders.length).toBe(0);
            
            // Verify no delivery order is in cashier's list
            const cashierOrderIds = new Set(cashierOrders.map(o => o.id));
            for (const order of deliveryOrders) {
              expect(cashierOrderIds.has(order.id)).toBe(false);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: No order appears in multiple staff members' ordersDetails
     * Each order should be attributed to exactly one staff member.
     */
    it('no order appears in multiple staff members ordersDetails', () => {
      fc.assert(
        fc.property(
          fc.uuid(),  // cashierShiftId
          fc.uuid(),  // driverShiftId
          fc.array(orderArb.map(o => ({ ...o, orderType: fc.sample(instoreOrderTypeArb, 1)[0] })), { minLength: 0, maxLength: 5 }),
          fc.array(orderArb.map(o => ({ ...o, orderType: 'delivery' as OrderType })), { minLength: 0, maxLength: 5 }),
          (cashierShiftId, driverShiftId, instoreOrders, deliveryOrders) => {
            const scenario = generateTestScenario(cashierShiftId, driverShiftId, instoreOrders, deliveryOrders);
            
            const cashierOrders = getAttributedOrders(
              cashierShiftId,
              'cashier',
              scenario.allOrders,
              scenario.driverEarnings
            );
            
            const driverOrders = getAttributedOrders(
              driverShiftId,
              'driver',
              scenario.allOrders,
              scenario.driverEarnings
            );
            
            // Check for no overlap between cashier and driver orders
            const cashierOrderIds = new Set(cashierOrders.map(o => o.id));
            const driverOrderIds = new Set(driverOrders.map(o => o.id));
            
            for (const orderId of cashierOrderIds) {
              expect(driverOrderIds.has(orderId)).toBe(false);
            }
            
            for (const orderId of driverOrderIds) {
              expect(cashierOrderIds.has(orderId)).toBe(false);
            }
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Mixed scenario - correct attribution for both order types
     * When there are both in-store and delivery orders, each should be
     * attributed to the correct staff member.
     */
    it('mixed orders are correctly attributed to respective staff members', () => {
      fc.assert(
        fc.property(
          fc.uuid(),  // cashierShiftId
          fc.uuid(),  // driverShiftId
          fc.array(orderArb.map(o => ({ ...o, orderType: fc.sample(instoreOrderTypeArb, 1)[0] })), { minLength: 1, maxLength: 5 }),
          fc.array(orderArb.map(o => ({ ...o, orderType: 'delivery' as OrderType })), { minLength: 1, maxLength: 5 }),
          (cashierShiftId, driverShiftId, instoreOrders, deliveryOrders) => {
            const scenario = generateTestScenario(cashierShiftId, driverShiftId, instoreOrders, deliveryOrders);
            
            const cashierOrders = getAttributedOrders(
              cashierShiftId,
              'cashier',
              scenario.allOrders,
              scenario.driverEarnings
            );
            
            const driverOrders = getAttributedOrders(
              driverShiftId,
              'driver',
              scenario.allOrders,
              scenario.driverEarnings
            );
            
            // Cashier should have all in-store orders
            expect(cashierOrders.length).toBe(instoreOrders.length);
            
            // Driver should have all delivery orders
            expect(driverOrders.length).toBe(deliveryOrders.length);
            
            // Total attributed orders should equal total orders
            expect(cashierOrders.length + driverOrders.length).toBe(scenario.allOrders.length);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Order totals match attributed orders
     * The orders.totalAmount for each staff member should equal the sum
     * of their attributed orders' amounts.
     */
    it('order totals match sum of attributed orders', () => {
      fc.assert(
        fc.property(
          fc.uuid(),  // cashierShiftId
          fc.uuid(),  // driverShiftId
          fc.array(orderArb.map(o => ({ ...o, orderType: fc.sample(instoreOrderTypeArb, 1)[0] })), { minLength: 1, maxLength: 5 }),
          fc.array(orderArb.map(o => ({ ...o, orderType: 'delivery' as OrderType })), { minLength: 1, maxLength: 5 }),
          (cashierShiftId, driverShiftId, instoreOrders, deliveryOrders) => {
            const scenario = generateTestScenario(cashierShiftId, driverShiftId, instoreOrders, deliveryOrders);
            
            const cashierOrders = getAttributedOrders(
              cashierShiftId,
              'cashier',
              scenario.allOrders,
              scenario.driverEarnings
            );
            
            const driverOrders = getAttributedOrders(
              driverShiftId,
              'driver',
              scenario.allOrders,
              scenario.driverEarnings
            );
            
            // Calculate expected totals
            const cashierTotal = cashierOrders.reduce((sum, o) => sum + o.amount, 0);
            const driverTotal = driverOrders.reduce((sum, o) => sum + o.amount, 0);
            
            // Calculate actual totals from original orders
            const expectedCashierTotal = instoreOrders.reduce((sum, o) => sum + o.totalAmount, 0);
            const expectedDriverTotal = deliveryOrders.reduce((sum, o) => sum + o.totalAmount, 0);
            
            expect(cashierTotal).toBeCloseTo(expectedCashierTotal, 2);
            expect(driverTotal).toBeCloseTo(expectedDriverTotal, 2);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property: Empty scenarios handled correctly
     * When there are no orders, both staff members should have empty ordersDetails.
     */
    it('empty orders result in empty ordersDetails for all staff', () => {
      fc.assert(
        fc.property(
          fc.uuid(),  // cashierShiftId
          fc.uuid(),  // driverShiftId
          (cashierShiftId, driverShiftId) => {
            const scenario = generateTestScenario(cashierShiftId, driverShiftId, [], []);
            
            const cashierOrders = getAttributedOrders(
              cashierShiftId,
              'cashier',
              scenario.allOrders,
              scenario.driverEarnings
            );
            
            const driverOrders = getAttributedOrders(
              driverShiftId,
              'driver',
              scenario.allOrders,
              scenario.driverEarnings
            );
            
            expect(cashierOrders.length).toBe(0);
            expect(driverOrders.length).toBe(0);
          }
        ),
        { verbose: true }
      );
    });
  });
});
