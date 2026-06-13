import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCompactOrderNumberForDisplay } from '../../src/renderer/utils/orderNumberUtils';

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
