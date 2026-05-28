import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCashierCheckoutExpenseTotal } from '../../src/renderer/utils/staffShiftCheckoutPrint';

test('resolveCashierCheckoutExpenseTotal keeps checkout display aligned with persisted summary total', () => {
  const summary = { totalExpenses: 0 };
  const staleExpenses = [
    { shiftId: 'previous-shift', amount: 15 },
  ];

  assert.equal(
    resolveCashierCheckoutExpenseTotal(summary, staleExpenses, 'current-shift'),
    0,
  );
});

test('resolveCashierCheckoutExpenseTotal can fall back to current-shift expense rows when summary has no total', () => {
  const expenses = [
    { shiftId: 'current-shift', amount: 10 },
    { staff_shift_id: 'current-shift', amount: 5 },
    { shiftId: 'other-shift', amount: 99 },
  ];

  assert.equal(
    resolveCashierCheckoutExpenseTotal({}, expenses, 'current-shift'),
    15,
  );
});
