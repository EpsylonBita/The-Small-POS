import { describe, expect, it } from 'vitest';
import { buildShiftCheckoutPrintSnapshot } from '../staffShiftCheckoutPrint';

describe('cashier checkout physical drawer cash across handovers', () => {
  it('keeps the issued float deducted on the Tomikro first drawer', () => {
    const snapshot = buildShiftCheckoutPrintSnapshot({
      shift: { role_type: 'cashier', opening_cash_amount: 158.58, calculation_version: 2 },
      shiftSummary: {
        cashierCash: { cashCollections: 97.33, cashRefunds: 0 },
        cashDrawer: { driver_cash_given: 20, driver_cash_returned: 0 },
        driverDeliveries: [{ starting_amount: 20 }],
      },
      closingCash: '231.46',
    });
    expect(snapshot).toMatchObject({ expectedAmount: 235.91, closingAmount: 231.46, varianceAmount: -4.45 });
  });

  it('does not add an inherited outstanding wallet to the next drawer', () => {
    const snapshot = buildShiftCheckoutPrintSnapshot({
      shift: { role_type: 'cashier', opening_cash_amount: 231.46, calculation_version: 2 },
      shiftSummary: {
        cashDrawer: { driver_cash_given: 0, driver_cash_returned: 0 },
        driverDeliveries: [{ starting_amount: 20 }],
        transferredDrivers: [{ starting_amount: 20, net_cash_amount: 68.5 }],
      },
      closingCash: '231.46',
    });
    expect(snapshot).toMatchObject({ expectedAmount: 231.46, varianceAmount: 0 });
  });

  it('credits the full return once and deducts only the newly issued float', () => {
    const snapshot = buildShiftCheckoutPrintSnapshot({
      shift: { role_type: 'cashier', opening_cash_amount: 231.46, calculation_version: 2 },
      shiftSummary: { cashDrawer: { driver_cash_given: 20, driver_cash_returned: 88.5 } },
      closingCash: '300.97',
    });
    expect(snapshot).toMatchObject({ expectedAmount: 299.96, varianceAmount: 1.01 });
  });

  it('uses a recorded zero given after the inherited driver has returned', () => {
    const snapshot = buildShiftCheckoutPrintSnapshot({
      shift: { role_type: 'cashier', opening_cash_amount: 80, calculation_version: 2 },
      shiftSummary: {
        cashDrawer: { driver_cash_given: 0, driver_cash_returned: 20 },
        driverDeliveries: [{ starting_amount: 20 }],
        transferredDrivers: [],
      },
      closingCash: '100.00',
    });
    expect(snapshot).toMatchObject({ expectedAmount: 100, varianceAmount: 0 });
  });

  it('preserves the same-cashier return baseline', () => {
    const snapshot = buildShiftCheckoutPrintSnapshot({
      shift: { role_type: 'cashier', opening_cash_amount: 100, calculation_version: 2 },
      shiftSummary: { cashDrawer: { driver_cash_given: 20, driver_cash_returned: 20 } },
      closingCash: '100.00',
    });
    expect(snapshot).toMatchObject({ expectedAmount: 100, varianceAmount: 0 });
  });
});
