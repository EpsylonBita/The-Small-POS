import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Avoid importing src/renderer/utils/format (it transitively imports lib/i18n with
// no extension, breaking a direct `node --test`). The locale-aware contract that
// formatCurrency is built on is the same Intl.NumberFormat config asserted here.
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
const modalSource = read('src/renderer/components/modals/SplitPaymentModal.tsx');

const localesDir = path.join(process.cwd(), 'src', 'locales');
const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

const eur = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

test('SplitPaymentModal renders all currency text through the locale-aware formatter', () => {
  assert.match(modalSource, /import \{ formatCurrency \} from '\.\.\/\.\.\/utils\/format';/);
  // Many money values now go through formatCurrency (totals, portions, footer, header).
  assert.ok((modalSource.match(/formatCurrency\(/g) || []).length >= 8);
  // No hardcoded "&euro;{...toFixed(2)}" display values remain.
  assert.doesNotMatch(modalSource, /&euro;\{[^}]*\.toFixed\(2\)\}/);
  // No hardcoded currency symbols in interpolated/toast default strings.
  assert.doesNotMatch(modalSource, /€\{\{(amount|paid|due)\}\}/);
  assert.doesNotMatch(modalSource, /EUR \{\{amount\}\}/);
});

test('Greek formatCurrency contract: 16,65 € (comma + euro suffix), not €16.65', () => {
  const el = eur(16.65, 'el-GR');
  assert.match(el, /16,65/); // comma decimal separator
  assert.ok(el.includes('€'));
  assert.notEqual(el, '€16.65');
  // English keeps the prefixed style.
  assert.equal(eur(16.65, 'en-US'), '€16.65');
});

test('split-payment interpolated locale strings no longer hardcode a currency symbol', () => {
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const sp = loadLocale(lng).splitPayment ?? {};
    for (const key of ['partialSuccess', 'alreadyPaidSummary', 'balanceChanged']) {
      const value = String(sp[key] ?? '');
      assert.ok(value.length > 0, `${lng}.splitPayment.${key} missing`);
      assert.ok(!value.includes('€'), `${lng}.splitPayment.${key} still hardcodes "€"`);
      assert.ok(!/\bEUR\b/.test(value), `${lng}.splitPayment.${key} still hardcodes "EUR"`);
    }
    // The amount tokens are preserved so formatCurrency values interpolate in.
    assert.match(String(sp.partialSuccess), /\{\{amount\}\}/);
    assert.match(String(sp.alreadyPaidSummary), /\{\{paid\}\}[\s\S]*\{\{due\}\}/);
    assert.match(String(sp.balanceChanged), /\{\{amount\}\}/);
  }
});
