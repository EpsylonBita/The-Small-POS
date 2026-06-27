import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// orderSummary is a leaf module (no imports), so the explicit .ts extension keeps
// this test runnable under a direct `node --test`.
import { resolveStrikethroughSubtotal } from '../../src/renderer/utils/orderSummary.ts';

const modalSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'OrderDetailsModal.tsx'),
  'utf8',
);

test('resolveStrikethroughSubtotal never fabricates an original subtotal from subtotal + discount', () => {
  // Live repro: subtotal 18.50 with a 1.85 (10%) discount and total 16.65, but NO
  // distinct pre-discount subtotal field -> no strikethrough (never the bogus 20.35).
  assert.equal(resolveStrikethroughSubtotal({ subtotal: 18.5, originalSubtotal: 0 }), null);
  assert.equal(resolveStrikethroughSubtotal({ subtotal: 18.5 }), null);
  // Equal or lower reported original -> nothing meaningful to strike.
  assert.equal(resolveStrikethroughSubtotal({ subtotal: 18.5, originalSubtotal: 18.5 }), null);
  assert.equal(resolveStrikethroughSubtotal({ subtotal: 18.5, originalSubtotal: 17 }), null);
});

test('resolveStrikethroughSubtotal shows a real distinct pre-discount subtotal greater than subtotal', () => {
  assert.equal(resolveStrikethroughSubtotal({ subtotal: 18.5, originalSubtotal: 20.35 }), 20.35);
  assert.equal(resolveStrikethroughSubtotal({ subtotal: 16, originalSubtotal: 18.5 }), 18.5);
});

test('OrderDetailsModal subtotal strikethrough is driven by a real value, not subtotal + discount', () => {
  assert.match(
    modalSource,
    /import \{ resolveStrikethroughSubtotal \} from '\.\.\/\.\.\/utils\/orderSummary';/,
  );
  assert.match(modalSource, /resolveStrikethroughSubtotal\(\{/);
  assert.match(modalSource, /\{strikethroughSubtotal !== null && \(/);
  // The bogus "subtotal + discountAmount" original-subtotal fabrication is gone.
  assert.doesNotMatch(modalSource, /subtotal \+ discountAmount/);
  assert.doesNotMatch(modalSource, /const originalSubtotal =/);
});

// --- Round 253 (live review of the running POS Order Details modal): the visible card surfaces were
// already neutral (the blue tint on the Total card was just the pointer highlight), but source review
// found the loading spinner still used off-theme blue/cyan accents (dark `border-t-cyan-300`, light
// `border-t-blue-600`). The spinner now uses the POS yellow/amber top border on a neutral base;
// behaviour/layout/order/payment logic unchanged. ---

test('Round 253: OrderDetailsModal loading spinner uses the POS yellow/amber accent, not blue/cyan', () => {
  // No off-theme blue/cyan spinner accent remains anywhere in the modal.
  assert.doesNotMatch(modalSource, /border-t-cyan/);
  assert.doesNotMatch(modalSource, /border-t-blue/);
  // The loading spinner keeps its shape (neutral base ring) with a yellow (dark) / amber (light) top accent.
  assert.match(modalSource, /h-12 w-12 animate-spin rounded-full border-2/);
  assert.match(
    modalSource,
    /isDarkTheme\s*\?\s*'border-white\/15 border-t-yellow-400'\s*:\s*'border-zinc-200 border-t-amber-500'/,
  );
});

// Round 284 (live QA, Greek/light): the natural-language section/eyebrow labels in OrderDetailsModal
// (Order Information / Order Type / Created / Payment Method / Total / Customer / Delivery Address /
// Delivery Fulfillment / Service Notes / Items / Cancellation / item category / "without") were forced
// uppercase + letter-spaced, which reads shouted in Greek and longer locales. They now use normal case
// (weight + color + spacing carry the hierarchy). True status chips keep their uppercase badge style.
test('Round 284: OrderDetailsModal natural-language section labels are normal case (no uppercase/tracking)', () => {
  // The shared eyebrow class (Order Information / Order Type / Created / Payment Method / Total) is now
  // normal-case (no uppercase, no tracking-[...]).
  assert.match(modalSource, /const mutedEyebrowClass =\s*'text-\[11px\] font-semibold liquid-glass-modal-text-muted';/);

  // The section headers (Customer / Delivery Address / Delivery Fulfillment / Service Notes / Items) are
  // normal-case (font-bold + muted) -- the old uppercase + tracking-[0.2x em] treatment is gone.
  assert.match(modalSource, /text-sm font-bold liquid-glass-modal-text-muted/);
  assert.doesNotMatch(modalSource, /font-bold uppercase tracking-\[0\.2\d?em\]/);
  assert.doesNotMatch(modalSource, /font-semibold uppercase tracking-\[0\.32em\]/);

  // No uppercase/letter-spacing utility survives on any natural-language label: the ONLY lines that may
  // still carry `uppercase` are the rounded-full status chips (intentional badges).
  const uppercaseLines = modalSource.split('\n').filter((line) => /\buppercase\b/.test(line));
  for (const line of uppercaseLines) {
    assert.match(line, /rounded-full/, `uppercase is only allowed on status chips, found: ${line.trim()}`);
  }
  assert.ok(uppercaseLines.length >= 1, 'the status chips should still keep their uppercase badge style');
});
