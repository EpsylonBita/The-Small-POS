import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as paymentModalModule from '../../src/renderer/components/modals/PaymentModal';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'PaymentModal.tsx'),
  'utf8',
);
const glassSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'styles', 'glassmorphism.css'),
  'utf8',
);

test('cash, card, and split options share the same raised visual contract with distinct accents', () => {
  assert.match(source, /type AccentedPaymentOption = 'cash' \| 'card' \| 'split';/);
  assert.match(source, /option: 'payment-option-cash active:scale-\[0\.98\]'/);
  assert.match(source, /icon: 'payment-option-cash-icon'/);
  assert.match(source, /option: 'payment-option-card active:scale-\[0\.98\]'/);
  assert.match(source, /icon: 'payment-option-card-icon'/);
  assert.match(source, /option: 'payment-option-split active:scale-\[0\.98\]'/);
  assert.match(source, /icon: 'payment-option-split-icon'/);
  assert.match(source, /const cashVisualClasses = getPaymentOptionVisualClasses\(/);
  assert.match(source, /\$\{cashVisualClasses\.option\}/);
  assert.match(source, /\$\{cashVisualClasses\.icon\}/);
  for (const method of ['cash', 'card', 'split']) {
    assert.match(
      glassSource,
      new RegExp(`button\\.payment-option-${method} \\{[\\s\\S]*?box-shadow:`),
      `${method} should use the same raised-card depth contract`,
    );
  }
});

test('tip action renders the colored icon directly without a square icon wrapper', () => {
  assert.match(
    source,
    /<span className="flex items-center gap-3">\s*<HandCoins className="h-6 w-6 shrink-0 text-emerald-500 dark:text-emerald-300" \/>/,
  );
  assert.doesNotMatch(
    source,
    /<span className="rounded-xl bg-emerald-500\/15 p-2">\s*<HandCoins/,
  );
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

test('cash input keeps the light-theme surface neutral and reserves color for high-contrast state accents', () => {
  const getCashInputVisualClasses = (
    paymentModalModule as unknown as {
      getCashInputVisualClasses?: (hasEnoughCash: boolean) => Record<string, string>;
    }
  ).getCashInputVisualClasses;

  assert.equal(
    typeof getCashInputVisualClasses,
    'function',
    'PaymentModal should expose the cash-input visual contract used by the rendered controls',
  );

  const enoughCash = getCashInputVisualClasses!(true);
  const shortCash = getCashInputVisualClasses!(false);

  assert.match(enoughCash.quickAmountsPanel, /border-slate-200\/80/);
  assert.match(enoughCash.quickAmountsPanel, /bg-slate-50\/70/);
  assert.doesNotMatch(enoughCash.quickAmountsPanel, /green|emerald/);

  assert.match(enoughCash.quickAmountSelected, /bg-yellow-400/);
  assert.match(enoughCash.quickAmountSelected, /text-slate-950/);
  assert.match(enoughCash.quickAmountSelected, /dark:bg-yellow-400\/20/);

  assert.match(enoughCash.cashInput, /border-slate-300\/90/);
  assert.match(enoughCash.cashInput, /bg-white\/90/);
  assert.match(enoughCash.cashInput, /focus:border-yellow-400/);
  assert.doesNotMatch(enoughCash.cashInput, /border-green|bg-green/);

  assert.match(enoughCash.summary, /border-slate-200\/90/);
  assert.match(enoughCash.summary, /bg-white\/80/);
  assert.doesNotMatch(enoughCash.summary, /bg-green|bg-emerald/);
  assert.match(enoughCash.changeTone, /text-emerald-700/);
  assert.match(enoughCash.completeButton, /(?:^|\s)!bg-emerald-700(?:\s|$)/);
  assert.doesNotMatch(enoughCash.completeButton, /(?:^|\s)!bg-emerald-600(?:\s|$)/);
  assert.match(enoughCash.completeButton, /!text-white/);
  assert.match(shortCash.summary, /bg-red-50\/80/);
  assert.match(shortCash.changeTone, /text-red-700/);
});

test('suggested-change chips keep one visual contract for English, Greek, and every formatted locale', () => {
  const CashChangeChip = (
    paymentModalModule as unknown as {
      CashChangeChip?: ComponentType<{
        item: { value: number; count: number; type: 'bill' | 'coin' };
        formattedValue: string;
      }>;
    }
  ).CashChangeChip;

  assert.equal(
    typeof CashChangeChip,
    'function',
    'PaymentModal should render denominations through one locale-independent chip component',
  );

  const item = { value: 20, count: 1, type: 'bill' as const };
  const englishMarkup = renderToStaticMarkup(
    createElement(CashChangeChip!, { item, formattedValue: '€20.00' }),
  );
  const greekMarkup = renderToStaticMarkup(
    createElement(CashChangeChip!, { item, formattedValue: '20,00 €' }),
  );
  const chipClass = (markup: string): string =>
    markup.match(/^<span class="([^"]+)"/)?.[1] ?? '';

  assert.equal(chipClass(greekMarkup), chipClass(englishMarkup));
  assert.match(chipClass(englishMarkup), /min-h-8/);
  assert.match(chipClass(englishMarkup), /whitespace-nowrap/);
  assert.match(chipClass(englishMarkup), /border-slate-200\/90/);
  assert.match(chipClass(englishMarkup), /bg-white\/90/);
  assert.match(chipClass(englishMarkup), /text-slate-700/);
  assert.match(chipClass(englishMarkup), /dark:bg-white\/5/);
  assert.match(englishMarkup, /€20\.00/);
  assert.match(greekMarkup, /20,00 €/);
});
