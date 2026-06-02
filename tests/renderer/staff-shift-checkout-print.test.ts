import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveCashierCheckoutExpenseTotal } from '../../src/renderer/utils/staffShiftCheckoutPrint';

const projectRoot = process.cwd();
const staffShiftModalPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'modals',
  'StaffShiftModal.tsx',
);

const source = (filePath: string) => readFileSync(filePath, 'utf8');

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

test('StaffShiftModal shows raw close-shift IPC rejection messages to the operator', () => {
  const modal = source(staffShiftModalPath);

  assert.match(
    modal,
    /catch \(err\) \{[\s\S]*setError\(\s*extractErrorMessage\(\s*err,\s*t\('modals\.staffShift\.closeShiftFailed'\)\s*\)\s*\)/,
    'close-shift failures must preserve raw string IPC errors instead of falling back to the generic translation',
  );
});
