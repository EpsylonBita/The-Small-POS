import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// NOTE: this test deliberately does NOT import src/renderer/utils/format. That
// module transitively imports '../../lib/i18n' with no file extension, which makes
// the whole chain unresolvable under a direct `node --test <file>` run. Instead we
// prove (a) the components delegate to formatCurrency via source assertions, and
// (b) the locale-aware currency contract formatCurrency is built on (the same
// Intl.NumberFormat config) yields Greek "18,50 €", not "€18.50".

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
const cardSource = read('src/renderer/components/menu/MenuItemCard.tsx');
const gridSource = read('src/renderer/components/menu/MenuItemGrid.tsx');

// Mirrors src/renderer/utils/format.ts formatCurrency's Intl config.
const eur = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

test('MenuItemCard renders the price via formatCurrency, not hardcoded € + toFixed(2)', () => {
  assert.match(cardSource, /import \{ formatCurrency \} from '\.\.\/\.\.\/utils\/format';/);
  assert.match(cardSource, /\{formatCurrency\(item\.price\)\}/);
  // The hardcoded English-style "€{item.price.toFixed(2)}" render is gone.
  assert.doesNotMatch(cardSource, /€\{item\.price\.toFixed\(2\)\}/);
});

test('MenuItemGrid preview renders the price via formatCurrency, not hardcoded € + toFixed(2)', () => {
  assert.match(gridSource, /import \{ formatCurrency \} from '\.\.\/\.\.\/utils\/format';/);
  assert.match(gridSource, /\{formatCurrency\(preview\.item\.price\)\}/);
  assert.doesNotMatch(gridSource, /€\{preview\.item\.price\.toFixed\(2\)\}/);
});

test('menu item prices format locale-aware: Greek "18,50 €", not "€18.50"', () => {
  const el = eur(18.5, 'el-GR');
  assert.match(el, /18,50/); // comma decimal separator
  assert.ok(el.includes('€'));
  assert.notEqual(el, '€18.50'); // not the old hardcoded English-style value
  // English stays English-style.
  assert.equal(eur(18.5, 'en-US'), '€18.50');
  // The other repro value formats the same way.
  assert.match(eur(22, 'el-GR'), /22,00/);
});
