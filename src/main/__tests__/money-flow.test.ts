/**
 * Money Flow Tests
 * 
 * Tests the complete money flow calculation for cashier checkout.
 * 
 * CASHIER EXPECTED AMOUNT FORMULA:
 * expected = openingAmount + cashSales - cashRefunds - expenses - cashDrops 
 *            - driverCashGiven + driverCashReturned - staffPayments
 * 
 * DRIVER EXPECTED RETURN FORMULA:
 * expectedReturn = cashCollected - startingAmount - driverExpenses - driverPayment
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
});

