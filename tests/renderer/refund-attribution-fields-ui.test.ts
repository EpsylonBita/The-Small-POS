import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sourcePath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'RefundAttributionFields.tsx');

test('RefundAttributionFields uses semantic refund-route colors without blue drift', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /refundMethod === 'cash'[\s\S]*?bg-green-600\/20 text-green-300 border-green-500\/30/);
  assert.match(source, /refundMethod === 'card'[\s\S]*?bg-amber-600\/20 text-amber-300 border-amber-500\/30/);
  assert.match(source, /refundMethod === 'other'[\s\S]*?bg-emerald-600\/20 text-emerald-300 border-emerald-500\/30/);
  assert.match(source, /cashHandler === 'driver_shift'[\s\S]*?text-emerald-300[\s\S]*?text-amber-300/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue/);
});

test('RefundAttributionFields preserves route callbacks and disabled state guards', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /onClick=\{\(\) => onRefundMethodChange\('cash'\)\}/);
  assert.match(source, /onClick=\{\(\) => onRefundMethodChange\('card'\)\}/);
  assert.match(source, /onClick=\{\(\) => onRefundMethodChange\('other'\)\}/);
  assert.match(source, /disabled=\{disabled\}/);
  assert.match(source, /opacity-50 cursor-not-allowed/);
  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /cyan-|purple-|sky-/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
});

// Shared rule R2 (round 3 review, 01/10/2026): who hands a cash refund back
// is the till's rule, shown and never chosen. The picker let a cashier book a
// refund on the drawer while the courier still held the order's cash.
test('RefundAttributionFields shows the cash handler and never offers to choose it', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.doesNotMatch(source, /onCashHandlerChange/);
  assert.match(source, /data-testid="refund-cash-handler"/);
  assert.match(source, /modals\.refund\.cashReturnedBy/);
});
