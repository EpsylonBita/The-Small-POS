import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sourcePath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'modals',
  'EditOrderRefundSettlementModal.tsx',
);

test('EditOrderRefundSettlementModal keeps refund allocation behavior with rounded controls', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /<LiquidGlassModal/);
  assert.match(source, /closeOnBackdrop=\{false\}/);
  assert.match(source, /closeOnEscape=\{false\}/);
  assert.match(source, /onConfirm\(refunds\)/);
  assert.match(source, /handleFillRemaining\(payment\.id/);
  assert.match(source, /RefundAttributionFields/);
  assert.match(source, /rounded-2xl border border-white\/10 bg-white\/5 p-4/);
  assert.match(source, /rounded-2xl border border-white\/10 bg-white\/5 px-3 py-1\.5/);
  assert.match(source, /w-full rounded-2xl border border-white\/20 bg-white\/10 py-2 pl-7 pr-3/);
  assert.match(source, /w-full rounded-2xl border border-white\/20 bg-white\/10 px-3 py-2/);
});

test('EditOrderRefundSettlementModal has no legacy hover, blue, or small-radius chrome', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /cyan-|purple-|sky-/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
});
