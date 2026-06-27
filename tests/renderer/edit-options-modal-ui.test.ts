import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const modalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'EditOptionsModal.tsx');
const source = readFileSync(modalPath, 'utf8');

// Touch-first POS language: glass modal, rounded-2xl option cards, active press feedback only (no
// hover), no native title tooltips, neutral grey icon chips, and semantic accents -- green for the
// "edit items" action, amber/yellow for the payment + order-type utility, neutral for customer info,
// muted grey for disabled payment. No off-theme blue/violet survives.
test('EditOptionsModal uses the touch POS palette: glass modal, rounded-2xl cards, active press, no hover/blue/violet', () => {
  // Glass modal shell with its component-prop heading preserved (a React prop, not a DOM tooltip).
  assert.match(source, /<LiquidGlassModal/);
  assert.match(source, /title=\{t\('modals\.editOptions\.title'\)\}/);

  // rounded-2xl option cards and icon chips; the old rounded-lg modal chrome is gone.
  const rounded2xl = source.match(/rounded-2xl/g) ?? [];
  assert.ok(rounded2xl.length >= 8, `expected rounded-2xl cards and icon chips, found ${rounded2xl.length}`);
  assert.doesNotMatch(source, /rounded-lg|rounded-md/);

  // Active press feedback only -- no hover-era classes anywhere.
  assert.match(source, /active:bg-white\/10 active:scale-\[0\.99\]/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  assert.doesNotMatch(source, /dark:hover:/);

  // No off-theme blue/violet/indigo/cyan/purple anywhere in this modal.
  assert.doesNotMatch(source, /blue-|violet-|indigo-|cyan-|purple-/);
});

test('EditOptionsModal accents are semantic (neutral customer, green items, amber payment + order-type, yellow active, muted disabled)', () => {
  // Customer info: neutral outline + neutral grey icon (was blue).
  assert.match(source, /onClick=\{onEditInfo\}[\s\S]*?border-white\/15 dark:border-white\/10 bg-white\/5 active:bg-white\/10/);
  assert.match(source, /w-6 h-6 text-gray-600 dark:text-zinc-300/);

  // Edit order items: semantic green outline + green icon.
  assert.match(source, /border-green-200\/50 dark:border-green-400\/30 bg-white\/5 active:bg-white\/10/);
  assert.match(source, /w-6 h-6 text-green-600 dark:text-green-400/);

  // Payment: amber when editable; muted grey + cursor-not-allowed when disabled.
  assert.match(source, /border-amber-200\/50 dark:border-amber-400\/30 bg-white\/5 active:bg-white\/10/);
  assert.match(source, /text-amber-600 dark:text-amber-400/);
  assert.match(source, /border-gray-200\/50 dark:border-white\/10 bg-white\/5 opacity-70 cursor-not-allowed/);
  assert.match(source, /text-gray-500 dark:text-gray-400/);

  // Change order type: amber utility container + amber icon (was violet); the selected type chip is
  // the yellow POS "selected" treatment.
  assert.match(source, /border-amber-200\/50 dark:border-amber-400\/30 bg-white\/5 liquid-glass-modal-text/);
  assert.match(source, /border-yellow-400 bg-yellow-400 text-black cursor-default/);

  // Neutral grey icon chips for every option.
  assert.match(source, /bg-gray-200\/70 dark:bg-zinc-800\/80/);
});

test('EditOptionsModal keeps all callbacks + i18n keys and carries no native title tooltips', () => {
  // The only title= is the LiquidGlassModal component prop -- no native DOM tooltips on the cards.
  const titleAttrs = source.match(/\btitle=/g) ?? [];
  assert.equal(titleAttrs.length, 1, 'only the LiquidGlassModal title prop may use title=');

  // Business callbacks preserved (visual-only redesign).
  assert.match(source, /onClick=\{onEditInfo\}/);
  assert.match(source, /onClick=\{onEditOrder\}/);
  assert.match(source, /onClick=\{onEditPayment\}/);
  assert.match(source, /onClick=\{\(\) => onChangeOrderType\(type\)\}/);
  assert.match(source, /disabled=\{!canEditPayment\}/);

  // i18n keys preserved.
  for (const key of [
    'modals.editOptions.title',
    'modals.editOptions.message',
    'modals.editOptions.editCustomerInfo',
    'modals.editOptions.editOrderItems',
    'modals.editOptions.editPaymentMethod',
    'modals.editOptions.changeOrderType',
  ]) {
    assert.ok(source.includes(key), `i18n key ${key} must be preserved`);
  }
});
