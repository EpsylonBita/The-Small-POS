import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Order VAT (founder rule 07/10/2026): every order's VAT is computed natively
// from its lines, as the server computes it, and a screen shows only the VAT
// its slip prints. The renderer is no VAT source, keeps today's checkout
// readiness (`tax.tax_rate_percentage`, "Try again"), and never adds VAT to
// a total.

const rendererSource = (...segments: string[]): string =>
  readFileSync(path.join(process.cwd(), 'src', 'renderer', ...segments), 'utf8');

const sliceBetween = (source: string, startMarker: string, endMarker: string): string => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
};

test('new-order checkouts keep their readiness gate and send no renderer VAT', () => {
  for (const [segments, endMarker] of [
    [['components', 'OrderFlow.tsx'], 'const visibleOrderTypeCardCount'],
    [['pages', 'NewOrderPage.tsx'], 'const handleSplitClose'],
  ] as const) {
    const source = rendererSource(...segments);
    const handler = sliceBetween(source, 'const handleOrderComplete = useCallback(', endMarker);
    assert.match(
      handler,
      /if \(taxRatePercentage === null\) \{\s*notifyMoneySettingsUnavailable\(t, reloadTerminalSettings\);\s*return false;\s*\}/,
      `${segments.join('/')} keeps the readiness pause`,
    );
    assert.doesNotMatch(handler, /tax_amount\s*:/, `${segments.join('/')} sends no tax_amount`);
    assert.doesNotMatch(handler, /taxDivisor/, `${segments.join('/')} computes no single-rate VAT`);
    assert.match(handler, /pricing_mode: 'tax_inclusive'/);
  }
});

test('order details show the printed VAT and never split it as a line', () => {
  const source = rendererSource('components', 'modals', 'OrderDetailsModal.tsx');
  assert.match(source, /const tax = readPrintedVatAmount\(displayOrder\);/);
  assert.doesNotMatch(source, /displayOrder\.tax_amount|displayOrder\.taxAmount/);
  const split = sliceBetween(source, 'items={buildSplitPaymentItems({', 'initialMode="by-items"');
  assert.doesNotMatch(split, /taxAmount|taxLabel/);
});

test('no renderer total ever gains VAT on top', () => {
  const menu = rendererSource('pages', 'MenuPage.tsx');
  assert.match(menu, /const finalTotal = Number\(\(subtotal \+ deliveryFee\)\.toFixed\(2\)\);/);
  assert.doesNotMatch(menu, /tax_amount\s*:|tax_rate\s*:|tax_rate_percentage/);
  const cart = rendererSource('components', 'menu', 'CartSummary.tsx');
  assert.match(cart, /const total = subtotalAfterDiscount \+ deliveryFee;/);
  assert.doesNotMatch(cart, /taxRatePercentage/);
  const split = rendererSource('components', 'modals', 'SplitPaymentModal.tsx');
  assert.match(split, /order\?\.subtotal \?\? \(totalAmount \+ discountAmount - deliveryFee - tipAmount\)/);
});
