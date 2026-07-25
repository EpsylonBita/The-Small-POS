import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as paymentModal from '../../src/renderer/components/modals/PaymentModal';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'PaymentModal.tsx'),
  'utf8',
);

test('card and split options keep distinct visible accents in light and dark themes', () => {
  const getPaymentOptionVisualClasses = (
    paymentModal as typeof paymentModal & {
      getPaymentOptionVisualClasses?: (
        method: 'card' | 'split',
        disabled: boolean,
      ) => { option: string; icon: string; label: string };
    }
  ).getPaymentOptionVisualClasses;

  assert.equal(
    typeof getPaymentOptionVisualClasses,
    'function',
    'payment options should expose their visual-state contract',
  );

  const card = getPaymentOptionVisualClasses!('card', false);
  assert.match(card.option, /\bpayment-option-card\b/);
  assert.match(card.icon, /\bpayment-option-card-icon\b/);
  assert.doesNotMatch(card.label, /\btext-blue-/);

  const split = getPaymentOptionVisualClasses!('split', false);
  assert.match(split.option, /\bpayment-option-split\b/);
  assert.match(split.icon, /\bpayment-option-split-icon\b/);
  assert.doesNotMatch(split.label, /\btext-purple-/);
});

test('payment method labels fit without clipping or per-letter Greek breaks', () => {
  // Long single-token labels such as the Greek split label need fixed compact text.
  assert.match(
    source,
    /const paymentMethodLabelBaseClass =\s*\n\s*'w-full text-center text-sm font-bold uppercase leading-tight tracking-normal hyphens-none whitespace-normal transition-colors duration-300';/,
    'payment labels should use compact, centered, non-breaking styling',
  );

  const fittedLabelUsages = source.match(/paymentMethodLabelBaseClass/g);
  assert.equal(
    fittedLabelUsages?.length,
    5,
    'the shared payment label class should be defined once and used by all four labels',
  );

  assert.doesNotMatch(
    source,
    /uppercase[^\n]*break-words/,
    'payment labels must not use break-words',
  );
  assert.doesNotMatch(
    source,
    /className=\{`text-2xl font-bold tracking-wide uppercase transition-colors duration-300/,
    'no payment label should keep the old single-line non-wrapping styling',
  );
});

test('payment method cards use moderate padding so labels fit the md-width modal', () => {
  assert.match(
    source,
    /const paymentOptionPaddingClass = paymentOptionCount === 3 \? 'p-4' : 'p-6';/,
    'three-option payment grids should use smaller card padding',
  );

  const paddingUsages = source.match(/paymentOptionPaddingClass/g);
  assert.equal(
    paddingUsages?.length,
    5,
    'the shared payment card padding class should be defined once and used by all four cards',
  );

  assert.doesNotMatch(
    source,
    /justify-center p-10 rounded-2xl/,
    'the oversized p-10 padding that squeezed long labels should be gone',
  );
});

test('payment method grid keeps card columns wide enough for localized labels', () => {
  assert.match(
    source,
    /paymentOptionCount >= 4\s*\n\s*\? 'grid-cols-2'/,
    'four payment options should stay in two columns inside the md-width modal',
  );
  assert.doesNotMatch(
    source,
    /xl:grid-cols-4/,
    'four payment options must not be squeezed into four columns in this modal',
  );
  assert.match(
    source,
    /const paymentGridGapClass = paymentOptionCount === 3 \? 'gap-4' : 'gap-6';/,
    'three-option payment grids should use the roomier gap',
  );
});
