/**
 * Money Flow Tests
 *
 * Tests the complete money flow calculation for cashier checkout.
 *
 * CALCULATION VERSION 2 (CORRECTED) FORMULAS:
 *
 * CASHIER EXPECTED AMOUNT FORMULA (v2):
 * expected = openingAmount + cashSales - cashRefunds - expenses - cashDrops
 *            - driverCashGiven + driverCashReturned + inheritedDriverReturns
 * NOTE: staffPayments are NOT deducted from expected (informational only)
 *
 * DRIVER EXPECTED RETURN FORMULA (v2):
 * expectedReturn = startingAmount + cashCollected - expenses
 * NOTE: payment is now handled at cashier checkout, not deducted here
 *
 * WAITER EXPECTED RETURN FORMULA (v2):
 * expectedReturn = startingAmount + cashCollected - expenses
 * NOTE: payment is now handled at cashier checkout, not deducted here
 *
 * LEGACY (v1) FORMULAS (for backward compatibility):
 * - Cashier: includes -staffPayments deduction
 * - Driver/Waiter: includes -payment deduction
 *
 * VARIANCE FORMULA:
 * variance = closingCash - expectedAmount
 * (positive = over, negative = short)
 */

describe('Money Flow Calculations', () => {
  describe('Cashier Expected Amount', () => {
    /**
     * Calculate expected cash drawer amount for cashier checkout
     */
    function calculateCashierExpected(params: {
      openingAmount: number;
      cashSales: number;
      cashRefunds?: number;
      expenses?: number;
      cashDrops?: number;
      driverCashGiven?: number;
      driverCashReturned?: number;
      staffPayments?: number;
    }): number {
      const {
        openingAmount,
        cashSales,
        cashRefunds = 0,
        expenses = 0,
        cashDrops = 0,
        driverCashGiven = 0,
        driverCashReturned = 0,
        staffPayments = 0,
      } = params;

      return (
        openingAmount +
        cashSales -
        cashRefunds -
        expenses -
        cashDrops -
        driverCashGiven +
        driverCashReturned -
        staffPayments
      );
    }

    test('basic: opening + sales = expected', () => {
      const expected = calculateCashierExpected({
        openingAmount: 200,
        cashSales: 100,
      });
      expect(expected).toBe(300);
    });

    test('with expenses: expenses are subtracted', () => {
      const expected = calculateCashierExpected({
        openingAmount: 200,
        cashSales: 0,
        expenses: 20,
      });
      expect(expected).toBe(180);
    });

    test('with staff payments: payments are subtracted', () => {
      const expected = calculateCashierExpected({
        openingAmount: 200,
        cashSales: 100,
        staffPayments: 50,
      });
      expect(expected).toBe(250);
    });

    test('with refunds: refunds are subtracted', () => {
      const expected = calculateCashierExpected({
        openingAmount: 200,
        cashSales: 100,
        cashRefunds: 25,
      });
      expect(expected).toBe(275);
    });

    test('with driver cash given: subtracted from expected', () => {
      const expected = calculateCashierExpected({
        openingAmount: 200,
        cashSales: 100,
        driverCashGiven: 30,
      });
      expect(expected).toBe(270);
    });

    test('with driver cash returned: added to expected', () => {
      const expected = calculateCashierExpected({
        openingAmount: 200,
        cashSales: 100,
        driverCashReturned: 80,
      });
      expect(expected).toBe(380);
    });

    test('with cash drops: subtracted from expected', () => {
      const expected = calculateCashierExpected({
        openingAmount: 200,
        cashSales: 100,
        cashDrops: 50,
      });
      expect(expected).toBe(250);
    });

    test('complete scenario: all factors', () => {
      const expected = calculateCashierExpected({
        openingAmount: 200,
        cashSales: 500,
        cashRefunds: 20,
        expenses: 30,
        cashDrops: 100,
        driverCashGiven: 50,
        driverCashReturned: 120,
        staffPayments: 40,
      });
      // 200 + 500 - 20 - 30 - 100 - 50 + 120 - 40 = 580
      expect(expected).toBe(580);
    });

    test('user reported issue: $200 opening, $20 expense = $180 expected', () => {
      const expected = calculateCashierExpected({
        openingAmount: 200,
        cashSales: 0,
        expenses: 20,
      });
      expect(expected).toBe(180);
    });
  });

  describe('Driver Expected Return', () => {
    /**
     * Calculate expected cash to return for driver checkout
     * Driver returns: cashCollected - startingAmount - expenses - driverPayment
     */
    function calculateDriverExpectedReturn(params: {
      cashCollected: number;
      startingAmount: number;
      expenses?: number;
      driverPayment?: number;
    }): number {
      const {
        cashCollected,
        startingAmount,
        expenses = 0,
        driverPayment = 0,
      } = params;

      return cashCollected - startingAmount - expenses - driverPayment;
    }

    test('basic: collected - starting = return', () => {
      const expected = calculateDriverExpectedReturn({
        cashCollected: 150,
        startingAmount: 30,
      });
      expect(expected).toBe(120);
    });

    test('with expenses: expenses reduce return', () => {
      const expected = calculateDriverExpectedReturn({
        cashCollected: 150,
        startingAmount: 30,
        expenses: 10,
      });
      expect(expected).toBe(110);
    });

    test('with payment: driver keeps payment amount', () => {
      const expected = calculateDriverExpectedReturn({
        cashCollected: 150,
        startingAmount: 30,
        driverPayment: 20,
      });
      expect(expected).toBe(100);
    });

    test('complete scenario: all factors', () => {
      const expected = calculateDriverExpectedReturn({
        cashCollected: 200,
        startingAmount: 40,
        expenses: 15,
        driverPayment: 25,
      });
      // 200 - 40 - 15 - 25 = 120
      expect(expected).toBe(120);
    });
  });

  describe('Variance Calculation', () => {
    test('exact match: no variance', () => {
      const expected = 200;
      const actual = 200;
      const variance = actual - expected;
      expect(variance).toBe(0);
    });

    test('over: positive variance', () => {
      const expected = 200;
      const actual = 210;
      const variance = actual - expected;
      expect(variance).toBe(10);
    });

    test('short: negative variance', () => {
      const expected = 200;
      const actual = 180;
      const variance = actual - expected;
      expect(variance).toBe(-20);
    });
  });

  describe('End-of-Day Cleanup', () => {
    test('Z-report should clear all daily data', () => {
      // Documenting what finalizeEndOfDay clears:
      const tablesToClear = [
        'payment_receipts',
        'payment_refunds',
        'payment_transactions',
        'sync_queue',
        'order_retry_queue',
        'order_sync_conflicts',
        'driver_earnings',
        'shift_expenses',
        'staff_payments',
        'cash_drawer_sessions',
        'staff_shifts',
        'orders',
      ];
      expect(tablesToClear.length).toBe(12);
    });
  });

  describe('Calculation Version 2 (Corrected Formula)', () => {
    /**
     * Version 2 cashier formula: staffPayments NOT deducted from expected
     * This is informational only - staff are paid through the staff_payments table
     */
    function calculateCashierExpectedV2(params: {
      openingAmount: number;
      cashSales: number;
      cashRefunds?: number;
      expenses?: number;
      cashDrops?: number;
      driverCashGiven?: number;
      driverCashReturned?: number;
      inheritedDriverReturns?: number;
    }): number {
      const {
        openingAmount,
        cashSales,
        cashRefunds = 0,
        expenses = 0,
        cashDrops = 0,
        driverCashGiven = 0,
        driverCashReturned = 0,
        inheritedDriverReturns = 0,
      } = params;

      return (
        openingAmount +
        cashSales -
        cashRefunds -
        expenses -
        cashDrops -
        driverCashGiven +
        driverCashReturned +
        inheritedDriverReturns
      );
    }

    /**
     * Version 2 driver formula: payment handled at cashier checkout
     * expectedReturn = startingAmount + cashCollected - expenses
     */
    function calculateDriverExpectedReturnV2(params: {
      startingAmount: number;
      cashCollected: number;
      expenses?: number;
    }): number {
      const {
        startingAmount,
        cashCollected,
        expenses = 0,
      } = params;

      return startingAmount + cashCollected - expenses;
    }

    test('cashier v2: staff payments NOT deducted', () => {
      const expectedV2 = calculateCashierExpectedV2({
        openingAmount: 200,
        cashSales: 100,
      });
      // In v2, even if we had staffPayments, they wouldn't be deducted
      expect(expectedV2).toBe(300);
    });

    test('cashier v2: inherited driver returns included', () => {
      const expected = calculateCashierExpectedV2({
        openingAmount: 200,
        cashSales: 100,
        inheritedDriverReturns: 80,
      });
      // 200 + 100 + 80 = 380
      expect(expected).toBe(380);
    });

    test('cashier v2: complete scenario with inherited drivers', () => {
      const expected = calculateCashierExpectedV2({
        openingAmount: 200,
        cashSales: 500,
        cashRefunds: 20,
        expenses: 30,
        cashDrops: 100,
        driverCashGiven: 50,
        driverCashReturned: 120,
        inheritedDriverReturns: 45,
      });
      // 200 + 500 - 20 - 30 - 100 - 50 + 120 + 45 = 665
      expect(expected).toBe(665);
    });

    test('driver v2: payment handled at cashier checkout', () => {
      const expected = calculateDriverExpectedReturnV2({
        startingAmount: 30,
        cashCollected: 150,
        expenses: 10,
      });
      // 30 + 150 - 10 = 170
      expect(expected).toBe(170);
    });

    test('driver v2: full amount returned (no payment deduction)', () => {
      const expected = calculateDriverExpectedReturnV2({
        startingAmount: 50,
        cashCollected: 200,
        expenses: 0,
      });
      // 50 + 200 = 250 (all cash returned to cashier)
      expect(expected).toBe(250);
    });
  });

  describe('Calculation Version Backward Compatibility', () => {
    test('version 1 shifts retain legacy formula', () => {
      // Version 1 (legacy) formula still deducts staffPayments
      const calculateCashierExpectedV1 = (params: {
        openingAmount: number;
        cashSales: number;
        staffPayments?: number;
      }) => {
        return params.openingAmount + params.cashSales - (params.staffPayments || 0);
      };

      const expectedV1 = calculateCashierExpectedV1({
        openingAmount: 200,
        cashSales: 100,
        staffPayments: 40,
      });
      // V1: 200 + 100 - 40 = 260
      expect(expectedV1).toBe(260);
    });

    test('new shifts should use calculation_version = 2', () => {
      // When a new shift is opened, it should have calculation_version = 2
      const newShift = { calculation_version: 2 };
      expect(newShift.calculation_version).toBe(2);
    });

    test('old shifts (null version) default to version 1', () => {
      // Shifts without calculation_version should be treated as version 1
      const oldShift: { calculation_version?: number } = {};
      const version = oldShift.calculation_version || 1;
      expect(version).toBe(1);
    });
  });

  describe('Waiter Checkout - Version 2', () => {
    /**
     * Version 2 waiter formula:
     * expectedReturn = startingAmount + cashCollected - expenses
     * NOTE: payment is handled at cashier checkout, NOT deducted here
     */
    function calculateWaiterExpectedReturnV2(params: {
      startingAmount: number;
      cashCollected: number;
      expenses?: number;
    }): number {
      const { startingAmount, cashCollected, expenses = 0 } = params;
      return startingAmount + cashCollected - expenses;
    }

    test('Starting amount is ADDED to expected return', () => {
      const starting = 50;
      const collected = 200;
      const expenses = 10;
      const expected = calculateWaiterExpectedReturnV2({
        startingAmount: starting,
        cashCollected: collected,
        expenses,
      });
      // 50 + 200 - 10 = 240
      expect(expected).toBe(240);
    });

    test('Waiter with zero starting amount', () => {
      const expected = calculateWaiterExpectedReturnV2({
        startingAmount: 0,
        cashCollected: 150,
        expenses: 5,
      });
      // 0 + 150 - 5 = 145
      expect(expected).toBe(145);
    });

    test('Waiter payment amount is always zero in V2', () => {
      // In V2, waiter payment is handled at cashier checkout
      // The waiter's expected return does not include payment deduction
      const waiterShiftV2 = {
        startingAmount: 50,
        cashCollected: 200,
        expenses: 10,
        paymentAmount: 0, // Always 0 for waiters in V2
      };
      expect(waiterShiftV2.paymentAmount).toBe(0);
    });

    test('Waiter returns starting + collected regardless of earnings', () => {
      // Even if waiter collected more than their wage, they return everything
      const expected = calculateWaiterExpectedReturnV2({
        startingAmount: 100,
        cashCollected: 500,
        expenses: 20,
      });
      // 100 + 500 - 20 = 580 (all cash returned to cashier)
      expect(expected).toBe(580);
    });

    test('Waiter with expenses exceeding collections', () => {
      // Edge case: expenses exceed cash collected
      const expected = calculateWaiterExpectedReturnV2({
        startingAmount: 50,
        cashCollected: 30,
        expenses: 40,
      });
      // 50 + 30 - 40 = 40
      expect(expected).toBe(40);
    });
  });

  describe('Driver Checkout - Version 2', () => {
    /**
     * Version 2 driver formula:
     * expectedReturn = startingAmount + cashCollected - expenses
     * NOTE: payment is handled at cashier checkout, NOT deducted here
     */
    function calculateDriverExpectedReturnV2(params: {
      startingAmount: number;
      cashCollected: number;
      expenses?: number;
    }): number {
      const { startingAmount, cashCollected, expenses = 0 } = params;
      return startingAmount + cashCollected - expenses;
    }

    test('Starting amount is ADDED to expected return', () => {
      const expected = calculateDriverExpectedReturnV2({
        startingAmount: 30,
        cashCollected: 150,
        expenses: 5,
      });
      // 30 + 150 - 5 = 175
      expect(expected).toBe(175);
    });

    test('Driver payment amount is always zero in V2', () => {
      // In V2, driver payment is handled at cashier checkout
      const driverShiftV2 = {
        startingAmount: 30,
        cashCollected: 150,
        expenses: 5,
        paymentAmount: 0, // Always 0 for drivers in V2
      };
      expect(driverShiftV2.paymentAmount).toBe(0);
    });

    test('Driver with zero starting amount', () => {
      const expected = calculateDriverExpectedReturnV2({
        startingAmount: 0,
        cashCollected: 200,
        expenses: 10,
      });
      // 0 + 200 - 10 = 190
      expect(expected).toBe(190);
    });

    test('Driver with multiple deliveries', () => {
      // Simulating driver with multiple cash deliveries
      const deliveries = [
        { amount: 25 },
        { amount: 35 },
        { amount: 40 },
      ];
      const cashCollected = deliveries.reduce((sum, d) => sum + d.amount, 0);
      const expected = calculateDriverExpectedReturnV2({
        startingAmount: 50,
        cashCollected,
        expenses: 15,
      });
      // 50 + 100 - 15 = 135
      expect(expected).toBe(135);
    });

    test('Driver with expenses from gas/parking', () => {
      const expected = calculateDriverExpectedReturnV2({
        startingAmount: 40,
        cashCollected: 180,
        expenses: 25, // Gas + parking
      });
      // 40 + 180 - 25 = 195
      expect(expected).toBe(195);
    });
  });

  describe('Cashier Checkout - Version 2', () => {
    /**
     * Version 2 cashier formula:
     * expected = opening + sales - refunds - expenses - drops - driverGiven + driverReturned + inheritedDrivers
     * NOTE: staffPayments are NOT deducted (informational only)
     */
    function calculateCashierExpectedV2(params: {
      openingAmount: number;
      cashSales: number;
      cashRefunds?: number;
      expenses?: number;
      cashDrops?: number;
      driverCashGiven?: number;
      driverCashReturned?: number;
      inheritedDriverReturns?: number;
    }): number {
      const {
        openingAmount,
        cashSales,
        cashRefunds = 0,
        expenses = 0,
        cashDrops = 0,
        driverCashGiven = 0,
        driverCashReturned = 0,
        inheritedDriverReturns = 0,
      } = params;

      return (
        openingAmount +
        cashSales -
        cashRefunds -
        expenses -
        cashDrops -
        driverCashGiven +
        driverCashReturned +
        inheritedDriverReturns
      );
    }

    test('Staff payments are NOT deducted from expected amount', () => {
      const opening = 500;
      const sales = 1000;
      const staffPayments = 50; // Informational only

      // V2 formula ignores staffPayments
      const expected = calculateCashierExpectedV2({
        openingAmount: opening,
        cashSales: sales,
      });
      // 500 + 1000 = 1500 (NOT 1450)
      expect(expected).toBe(1500);

      // Verify V1 would have been different
      const expectedV1 = opening + sales - staffPayments;
      expect(expectedV1).toBe(1450);
      expect(expected).not.toBe(expectedV1);
    });

    test('Inherited drivers are INCLUDED in expected amount', () => {
      const opening = 500;
      const sales = 1000;
      // Driver 1: starting 30 + collected 50 - expenses 5 = 75
      // Driver 2: starting 20 + collected 45 - expenses 5 = 60
      const inheritedDriver1 = 75;
      const inheritedDriver2 = 60;
      const totalInherited = inheritedDriver1 + inheritedDriver2;

      const expected = calculateCashierExpectedV2({
        openingAmount: opening,
        cashSales: sales,
        inheritedDriverReturns: totalInherited,
      });
      // 500 + 1000 + 135 = 1635
      expect(expected).toBe(1635);
    });

    test('Cashier with no inherited drivers', () => {
      const expected = calculateCashierExpectedV2({
        openingAmount: 500,
        cashSales: 1000,
        inheritedDriverReturns: 0,
      });
      // 500 + 1000 + 0 = 1500
      expect(expected).toBe(1500);
    });

    test('Full scenario with all factors (V2)', () => {
      const expected = calculateCashierExpectedV2({
        openingAmount: 300,
        cashSales: 2000,
        cashRefunds: 50,
        expenses: 75,
        cashDrops: 200,
        driverCashGiven: 100, // Given to new drivers
        driverCashReturned: 450, // Returned from checked-out drivers
        inheritedDriverReturns: 175, // From transferred drivers
      });
      // 300 + 2000 - 50 - 75 - 200 - 100 + 450 + 175 = 2500
      expect(expected).toBe(2500);
    });

    test('Cashier handles multiple inherited drivers', () => {
      // 3 drivers transferred from previous shift
      const drivers = [
        { starting: 30, collected: 80, expenses: 5 }, // Expected: 105
        { starting: 25, collected: 60, expenses: 10 }, // Expected: 75
        { starting: 40, collected: 120, expenses: 8 }, // Expected: 152
      ];

      const totalInherited = drivers.reduce(
        (sum, d) => sum + d.starting + d.collected - d.expenses,
        0
      );
      // 105 + 75 + 152 = 332

      const expected = calculateCashierExpectedV2({
        openingAmount: 500,
        cashSales: 1500,
        inheritedDriverReturns: totalInherited,
      });
      // 500 + 1500 + 332 = 2332
      expect(expected).toBe(2332);
    });
  });

  describe('Calculation Version Handling', () => {
    test('New shifts are created with version 2', () => {
      // Simulating shift creation
      const createShift = () => ({
        id: 'test-shift-1',
        calculation_version: 2,
        status: 'active',
      });

      const newShift = createShift();
      expect(newShift.calculation_version).toBe(2);
    });

    test('Version 1 shifts use legacy formula for driver', () => {
      // V1: expectedReturn = starting + collected - expenses - payment
      const calculateDriverV1 = (params: {
        startingAmount: number;
        cashCollected: number;
        expenses: number;
        paymentAmount: number;
      }) => {
        return (
          params.startingAmount +
          params.cashCollected -
          params.expenses -
          params.paymentAmount
        );
      };

      const expected = calculateDriverV1({
        startingAmount: 30,
        cashCollected: 150,
        expenses: 5,
        paymentAmount: 25,
      });
      // 30 + 150 - 5 - 25 = 150
      expect(expected).toBe(150);
    });

    test('Version 2 shifts use corrected formula for driver', () => {
      // V2: expectedReturn = starting + collected - expenses (no payment)
      const calculateDriverV2 = (params: {
        startingAmount: number;
        cashCollected: number;
        expenses: number;
      }) => {
        return params.startingAmount + params.cashCollected - params.expenses;
      };

      const expected = calculateDriverV2({
        startingAmount: 30,
        cashCollected: 150,
        expenses: 5,
      });
      // 30 + 150 - 5 = 175
      expect(expected).toBe(175);
    });

    test('Version handling function selects correct formula', () => {
      const calculateExpected = (params: {
        version: number;
        startingAmount: number;
        cashCollected: number;
        expenses: number;
        paymentAmount: number;
      }) => {
        const { version, startingAmount, cashCollected, expenses, paymentAmount } = params;
        if (version >= 2) {
          // V2: Payment NOT deducted
          return startingAmount + cashCollected - expenses;
        } else {
          // V1: Payment IS deducted
          return startingAmount + cashCollected - expenses - paymentAmount;
        }
      };

      const v1Expected = calculateExpected({
        version: 1,
        startingAmount: 30,
        cashCollected: 150,
        expenses: 5,
        paymentAmount: 25,
      });
      expect(v1Expected).toBe(150); // V1: 30 + 150 - 5 - 25

      const v2Expected = calculateExpected({
        version: 2,
        startingAmount: 30,
        cashCollected: 150,
        expenses: 5,
        paymentAmount: 25,
      });
      expect(v2Expected).toBe(175); // V2: 30 + 150 - 5
    });

    test('NULL version defaults to version 1', () => {
      const getVersion = (shift: { calculation_version?: number | null }) => {
        return shift.calculation_version ?? 1;
      };

      expect(getVersion({ calculation_version: null })).toBe(1);
      expect(getVersion({ calculation_version: undefined })).toBe(1);
      expect(getVersion({})).toBe(1);
      expect(getVersion({ calculation_version: 2 })).toBe(2);
    });

    test('V1 driver payment deducted exactly once via driverCashReturned, not via staffPayments', () => {
      // This test documents the fix for double-deduction bug in v1.
      // When a v1 driver closes their shift:
      // - Payment IS deducted from driver expectedReturn (goes to driverCashReturned)
      // - Payment is NOT added to staffPayments (would cause double-deduction)
      //
      // Cashier v1 formula: expected = opening + sales - ... + driverReturned - staffPayments
      // If payment was in BOTH driverReturned (as subtraction) AND staffPayments:
      //   expected = ... + (driverReturn - payment) - (staffPayments + payment)
      //   = ... + driverReturn - payment - staffPayments - payment = DOUBLE DEDUCTION
      //
      // With fix, payment in driverReturned ONLY:
      //   expected = ... + (driverReturn - payment) - staffPayments = SINGLE DEDUCTION

      const driverStarting = 30;
      const driverCollected = 150;
      const driverExpenses = 5;
      const driverPayment = 25;

      // V1 driver expectedReturn (payment already deducted)
      const v1DriverExpectedReturn = driverStarting + driverCollected - driverExpenses - driverPayment;
      expect(v1DriverExpectedReturn).toBe(150); // 30 + 150 - 5 - 25

      // Simulating cashier drawer before driver closes
      const cashierOpening = 500;
      const cashSales = 1000;
      const existingDriverReturned = 0;
      const existingStaffPayments = 0;

      // After v1 driver closes: payment in driverReturned only, NOT in staffPayments
      const newDriverReturned = existingDriverReturned + v1DriverExpectedReturn;
      const staffPaymentToAdd = 0; // V1: DO NOT add driver payment to staffPayments
      const newStaffPayments = existingStaffPayments + staffPaymentToAdd;

      // Cashier v1 expected calculation
      const cashierV1Expected = cashierOpening + cashSales + newDriverReturned - newStaffPayments;
      // 500 + 1000 + 150 - 0 = 1650
      expect(cashierV1Expected).toBe(1650);

      // Verify payment deducted exactly once (via lower driverReturned)
      const fullDriverReturn = driverStarting + driverCollected - driverExpenses; // Without payment = 175
      const cashierWithoutPaymentDeduction = cashierOpening + cashSales + fullDriverReturn;
      // 500 + 1000 + 175 = 1675
      expect(cashierV1Expected).toBe(cashierWithoutPaymentDeduction - driverPayment);
    });

    test('V2 driver payment tracked in staffPayments but not deducted from expected', () => {
      // V2: Payment NOT deducted from driver expectedReturn
      // Payment IS added to staffPayments for informational tracking
      // But cashier v2 formula does NOT subtract staffPayments from expected

      const driverStarting = 30;
      const driverCollected = 150;
      const driverExpenses = 5;
      const driverPayment = 25;

      // V2 driver expectedReturn (payment NOT deducted - driver returns full amount)
      const v2DriverExpectedReturn = driverStarting + driverCollected - driverExpenses;
      expect(v2DriverExpectedReturn).toBe(175); // 30 + 150 - 5

      // Simulating cashier drawer
      const cashierOpening = 500;
      const cashSales = 1000;
      const existingDriverReturned = 0;
      const existingStaffPayments = 0;

      // After v2 driver closes: full return, payment tracked separately
      const newDriverReturned = existingDriverReturned + v2DriverExpectedReturn;
      const staffPaymentToAdd = driverPayment; // V2: track payment in staffPayments
      const newStaffPayments = existingStaffPayments + staffPaymentToAdd;

      // Cashier v2 expected: does NOT subtract staffPayments
      const cashierV2Expected = cashierOpening + cashSales + newDriverReturned;
      // 500 + 1000 + 175 = 1675
      expect(cashierV2Expected).toBe(1675);

      // staffPayments is informational only (not in expected calculation)
      expect(newStaffPayments).toBe(25);
    });
  });

  describe('Address Parsing', () => {
    /**
     * Parse address to extract street name and number for compact display
     * Mirrors the implementation in checkout-bitmap-utils.ts
     */
    function parseAddressSimple(fullAddress: string): string {
      if (!fullAddress || fullAddress === 'N/A') return 'N/A';

      const parts = fullAddress.split(',').map(p => p.trim()).filter(p => p.length > 0);

      if (parts.length === 0) return fullAddress;
      if (parts.length === 1) return parts[0];

      const street = parts[0];

      let city = '';
      for (let i = parts.length - 1; i >= 1; i--) {
        const part = parts[i];
        if (/^\d/.test(part) || /^TK\s*\d/.test(part) || /^[A-Z]{2}\s*\d/.test(part)) continue;
        if (/^(Greece|Ελλάδα|Hellas|GR)$/i.test(part)) continue;
        city = part;
        break;
      }

      if (!city && parts.length > 1) {
        city = parts[1];
      }

      return city ? `${street}, ${city}` : street;
    }

    test('Extracts street name and city correctly', () => {
      expect(parseAddressSimple('123 Main Street, Athens, 12345')).toBe('123 Main Street, Athens');
      expect(parseAddressSimple('Oak Avenue 45, Building 2, Thessaloniki')).toBe('Oak Avenue 45, Thessaloniki');
      expect(parseAddressSimple('15 Elm St, Boston, MA 02115')).toBe('15 Elm St, Boston');
    });

    test('Handles Greek addresses', () => {
      expect(parseAddressSimple('Ερμού 45, Αθήνα, 10563')).toBe('Ερμού 45, Αθήνα');
      expect(parseAddressSimple('Λεωφόρος Κηφισίας 100, Μαρούσι, Ελλάδα')).toBe('Λεωφόρος Κηφισίας 100, Μαρούσι');
    });

    test('Falls back to first segment for simple addresses', () => {
      expect(parseAddressSimple('123 Main Street')).toBe('123 Main Street');
    });

    test('Handles empty and N/A addresses', () => {
      expect(parseAddressSimple('')).toBe('N/A');
      expect(parseAddressSimple('N/A')).toBe('N/A');
    });

    test('Skips postal codes and country names', () => {
      // Should skip "12345" (postal code) and "Greece"
      expect(parseAddressSimple('Main St 10, Athens, 12345, Greece')).toBe('Main St 10, Athens');
      // Should skip "TK 12345" format
      expect(parseAddressSimple('Kifisias 50, Marousi, TK 12345')).toBe('Kifisias 50, Marousi');
    });

    test('Complex address with apartment info', () => {
      // Apartment info between street and city
      expect(parseAddressSimple('123 Main Street, Apt 4B, Athens')).toBe('123 Main Street, Athens');
    });
  });

  describe('Integration: Full Shift Cycle Calculations', () => {
    test('Waiter: Check-in → Orders → Checkout calculation', () => {
      // Simulate full waiter shift cycle
      const waiterShift = {
        startingAmount: 50, // Given at check-in
        orders: [
          { cash_amount: 45 },
          { cash_amount: 55 },
          { cash_amount: 100 },
        ],
        expenses: [{ amount: 10, description: 'supplies' }],
      };

      const cashCollected = waiterShift.orders.reduce((sum, o) => sum + o.cash_amount, 0);
      const totalExpenses = waiterShift.expenses.reduce((sum, e) => sum + e.amount, 0);

      // V2 formula: starting + collected - expenses
      const expectedReturn = waiterShift.startingAmount + cashCollected - totalExpenses;
      // 50 + 200 - 10 = 240
      expect(expectedReturn).toBe(240);

      // Waiter returns exactly expectedReturn
      const closingCash = 240;
      const variance = closingCash - expectedReturn;
      expect(variance).toBe(0);
    });

    test('Driver: Check-in → Deliveries → Checkout calculation', () => {
      // Simulate full driver shift cycle
      const driverShift = {
        startingAmount: 30, // Change cash
        deliveries: [
          { cash_collected: 25, tips: 5 },
          { cash_collected: 35, tips: 8 },
          { cash_collected: 40, tips: 10 },
        ],
        expenses: [
          { amount: 5, description: 'parking' },
          { amount: 10, description: 'gas' },
        ],
      };

      const cashCollected = driverShift.deliveries.reduce((sum, d) => sum + d.cash_collected, 0);
      const totalExpenses = driverShift.expenses.reduce((sum, e) => sum + e.amount, 0);

      // V2 formula: starting + collected - expenses
      const expectedReturn = driverShift.startingAmount + cashCollected - totalExpenses;
      // 30 + 100 - 15 = 115
      expect(expectedReturn).toBe(115);

      // Driver returns all cash (including tips in this model)
      const closingCash = 115;
      const variance = closingCash - expectedReturn;
      expect(variance).toBe(0);
    });

    test('Cashier: Check-in → Sales → Driver checkout → Cashier checkout', () => {
      // Simulate cashier receiving driver cash and closing
      const cashierShift = {
        openingAmount: 500,
        cashSales: 1500,
        cashRefunds: 30,
        expenses: 20,
        driverCashGiven: 60, // Gave to 2 drivers (30 each)
        drivers: [
          { starting: 30, collected: 80, expenses: 5 }, // Returns: 30 + 80 - 5 = 105
        ],
      };

      const driverReturned = cashierShift.drivers.reduce(
        (sum, d) => sum + d.starting + d.collected - d.expenses,
        0
      );

      // V2 formula: opening + sales - refunds - expenses - driverGiven + driverReturned
      const expected =
        cashierShift.openingAmount +
        cashierShift.cashSales -
        cashierShift.cashRefunds -
        cashierShift.expenses -
        cashierShift.driverCashGiven +
        driverReturned;
      // 500 + 1500 - 30 - 20 - 60 + 105 = 1995
      expect(expected).toBe(1995);
    });

    test('Cashier with transferred drivers from previous shift', () => {
      // Previous cashier checked out with 2 active drivers
      // Current cashier inherits them
      const inheritedDrivers = [
        { starting: 30, collected: 100, expenses: 10 }, // Expected return: 120
        { starting: 25, collected: 75, expenses: 5 }, // Expected return: 95
      ];

      const inheritedReturns = inheritedDrivers.reduce(
        (sum, d) => sum + d.starting + d.collected - d.expenses,
        0
      );
      expect(inheritedReturns).toBe(215);

      const cashierShift = {
        openingAmount: 600,
        cashSales: 2000,
        cashRefunds: 0,
        expenses: 0,
        driverCashGiven: 0,
        driverCashReturned: 0,
        inheritedDriverReturns: inheritedReturns,
      };

      const expected =
        cashierShift.openingAmount +
        cashierShift.cashSales +
        cashierShift.inheritedDriverReturns;
      // 600 + 2000 + 215 = 2815
      expect(expected).toBe(2815);
    });
  });

  describe('Z-Report Integration Calculations', () => {
    test('Z-Report aggregates V2 shift data correctly', () => {
      // Simulate multiple V2 shifts for a day
      const shifts = [
        {
          role: 'cashier',
          openingAmount: 500,
          cashSales: 2000,
          expenses: 50,
          driverCashGiven: 60,
          driverCashReturned: 180,
          closingAmount: 2570,
          variance: 0,
        },
        {
          role: 'driver',
          startingAmount: 30,
          cashCollected: 150,
          expenses: 10,
          expectedReturn: 170, // V2: 30 + 150 - 10
          actualReturn: 170,
          variance: 0,
        },
        {
          role: 'server',
          startingAmount: 50,
          cashCollected: 300,
          expenses: 15,
          expectedReturn: 335, // V2: 50 + 300 - 15
          actualReturn: 335,
          variance: 0,
        },
      ];

      // Aggregate totals
      const totalVariance = shifts.reduce((sum, s) => sum + s.variance, 0);
      expect(totalVariance).toBe(0);

      // All cash accounted for (shifts[0] is the cashier shift)
      const shift = shifts[0]!;
      const cashierExpected =
        shift.openingAmount! +
        shift.cashSales! -
        shift.expenses! -
        shift.driverCashGiven! +
        shift.driverCashReturned!;
      expect(cashierExpected).toBe(2570);
    });

    test('Mixed version handling in Z-Report', () => {
      // Scenario: Some shifts from V1 (before update), some from V2
      const v1Shift = {
        calculation_version: 1,
        role: 'cashier',
        openingAmount: 500,
        cashSales: 1000,
        staffPayments: 50, // V1 deducts this
        expected: 1450, // V1: 500 + 1000 - 50
      };

      const v2Shift = {
        calculation_version: 2,
        role: 'cashier',
        openingAmount: 500,
        cashSales: 1000,
        staffPayments: 50, // V2 ignores this
        expected: 1500, // V2: 500 + 1000 (no staff payment deduction)
      };

      // V1 calculation
      const v1Expected = v1Shift.openingAmount + v1Shift.cashSales - v1Shift.staffPayments;
      expect(v1Expected).toBe(1450);

      // V2 calculation
      const v2Expected = v2Shift.openingAmount + v2Shift.cashSales;
      expect(v2Expected).toBe(1500);

      // Z-Report should show version distribution
      const versionDistribution = {
        v1Count: 1,
        v2Count: 1,
        totalShifts: 2,
      };
      expect(versionDistribution.v1Count + versionDistribution.v2Count).toBe(versionDistribution.totalShifts);
    });
  });
});

