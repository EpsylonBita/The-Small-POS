import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCompactOrderNumberForDisplay, isBusinessOrderNumber, resolveMergedOrderNumber } from '../../src/renderer/utils/orderNumberUtils';

test('formatCompactOrderNumberForDisplay removes the embedded order date', () => {
  assert.equal(formatCompactOrderNumberForDisplay('ORD-17052026-00002'), 'ORD #00002');
  assert.equal(formatCompactOrderNumberForDisplay('#ORD-17052026-00002'), 'ORD #00002');
});

test('formatCompactOrderNumberForDisplay keeps kiosk numbers visibly prefixed', () => {
  assert.equal(
    formatCompactOrderNumberForDisplay('K-d28cef2e-20260610-060003-0001'),
    'K #0001',
  );
  assert.equal(formatCompactOrderNumberForDisplay('K-0002'), 'K #0002');
});

test('formatCompactOrderNumberForDisplay leaves non-standard labels untouched', () => {
  assert.equal(formatCompactOrderNumberForDisplay('ORD-20260517-d181775dcf'), 'ORD-20260517-d181775dcf');
  assert.equal(formatCompactOrderNumberForDisplay('TABLE-7'), 'TABLE-7');
});

test('configured kiosk prefixes retain their own canonical sequence through display and sync', () => {
  for (const prefix of ['QR', 'K2', 'Κ', 'A-B']) {
    const number = `${prefix}-d28cef2e-20261009-060000-0123`;
    assert.equal(formatCompactOrderNumberForDisplay(number), `${prefix} #0123`);
    assert.equal(isBusinessOrderNumber(number), true);
    assert.equal(resolveMergedOrderNumber(number, 'ORD-20261009-1234567890abcdef1234567890abcdef'), number);
  }
});
