import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCompactOrderNumberForDisplay } from '../../src/renderer/utils/orderNumberUtils';

test('formatCompactOrderNumberForDisplay removes the embedded order date', () => {
  assert.equal(formatCompactOrderNumberForDisplay('ORD-17052026-00002'), 'ORD #00002');
  assert.equal(formatCompactOrderNumberForDisplay('#ORD-17052026-00002'), 'ORD #00002');
});

test('formatCompactOrderNumberForDisplay leaves non-standard labels untouched', () => {
  assert.equal(formatCompactOrderNumberForDisplay('ORD-20260517-d181775dcf'), 'ORD-20260517-d181775dcf');
  assert.equal(formatCompactOrderNumberForDisplay('TABLE-7'), 'TABLE-7');
});
