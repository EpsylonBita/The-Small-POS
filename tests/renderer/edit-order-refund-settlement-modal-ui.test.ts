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
  // 26/07/2026 (1.4.40): the payment card, "Use Remaining" and both fields moved from
  // dark-only white/10 utilities to the shared glass tokens, which carry the light and the
  // dark theme. The amount is digit entry in cents behind the payment's own currency code.
  assert.match(source, /className="liquid-glass-modal-inset space-y-3 rounded-2xl p-4"/);
  assert.match(source, /className="liquid-glass-modal-button rounded-2xl px-3 py-1\.5 text-xs font-semibold"/);
  assert.match(source, /<CentsMoneyInput[\s\S]*?className="liquid-glass-modal-input w-full rounded-2xl py-2 pl-12 pr-3/);
  assert.match(source, /\{payment\.currency \?\? '—'\}/);
  assert.match(source, /<textarea[\s\S]*?className="liquid-glass-modal-input w-full rounded-2xl px-3 py-2/);
  assert.doesNotMatch(
    source,
    /border-white\/10 bg-white\/5|border-white\/20 bg-white\/10|&euro;|€/,
    'no dark-only chrome or hard-coded euro sign',
  );
});

test('EditOrderRefundSettlementModal has no legacy hover, blue, or small-radius chrome', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /cyan-|purple-|sky-/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
});
