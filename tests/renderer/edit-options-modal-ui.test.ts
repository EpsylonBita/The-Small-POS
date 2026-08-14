import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const modalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'EditOptionsModal.tsx');
const source = readFileSync(modalPath, 'utf8');

// Touch-first POS language: glass modal, rounded-2xl option cards, active/focus feedback only (no
// hover), no native title tooltips, and semantic contrast-safe surfaces -- green for the "edit items"
// action, amber/yellow for payment + order-type, neutral for customer info and disabled payment.
test('EditOptionsModal uses the touch POS palette: glass modal, rounded-2xl cards, active press, no hover/blue/violet', () => {
  // Glass modal shell with its component-prop heading preserved (a React prop, not a DOM tooltip).
  assert.match(source, /<LiquidGlassModal/);
  assert.match(source, /title=\{t\('modals\.editOptions\.title'\)\}/);

  // rounded-2xl option cards and icon chips; the old rounded-lg modal chrome is gone.
  const rounded2xl = source.match(/rounded-2xl/g) ?? [];
  assert.ok(rounded2xl.length >= 8, `expected rounded-2xl cards and icon chips, found ${rounded2xl.length}`);
  assert.doesNotMatch(source, /rounded-lg|rounded-md/);

  // Theme-specific active feedback and visible keyboard focus; no hover-era classes anywhere.
  assert.match(source, /active:bg-slate-100[^"']*dark:active:bg-slate-800/);
  assert.match(source, /active:bg-emerald-100[^"']*dark:active:bg-emerald-500\/20/);
  assert.match(source, /active:bg-amber-100[^"']*dark:active:bg-amber-500\/20/);
  assert.match(source, /focus-visible:outline-none focus-visible:ring-2/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  assert.doesNotMatch(source, /dark:hover:/);

  // No off-theme blue/violet/indigo/cyan/purple anywhere in this modal.
  assert.doesNotMatch(source, /blue-|violet-|indigo-|cyan-|purple-/);
});

test('EditOptionsModal accents are semantic (neutral customer, green items, amber payment + order-type, yellow active, muted disabled)', () => {
  assert.match(source, /import \{ liquidGlassModalTone \} from '\.\.\/\.\.\/styles\/designSystem'/);

  // Customer info: the shared neutral tone supplies an opaque light card and a dark counterpart.
  assert.match(source, /onClick=\{onEditInfo\}[\s\S]*?liquidGlassModalTone\('neutral'\)/);
  assert.match(source, /border-slate-300 bg-white\/80 dark:border-white\/10 dark:bg-slate-800\/80/);
  assert.match(source, /w-6 h-6 text-slate-600 dark:text-slate-300/);

  // Edit order items: semantic success surface and matching high-contrast icon chip.
  assert.match(source, /onClick=\{onEditOrder\}[\s\S]*?liquidGlassModalTone\('success'\)/);
  assert.match(source, /border-emerald-200 bg-emerald-100\/80 dark:border-emerald-400\/30 dark:bg-emerald-500\/15/);
  assert.match(source, /w-6 h-6 text-emerald-700 dark:text-emerald-300/);

  // Payment: shared warning tone when editable; neutral readable surface when disabled.
  assert.match(source, /canEditPayment\s*\? `[\s\S]*?liquidGlassModalTone\('warning'\)/);
  assert.match(source, /: `[^`]*liquidGlassModalTone\('neutral'\)[^`]*cursor-not-allowed/);
  assert.doesNotMatch(source, /liquidGlassModalTone\('neutral'\)[^`]*opacity-/);
  assert.match(source, /border-amber-200 bg-amber-100\/80 dark:border-amber-400\/30 dark:bg-amber-500\/15/);
  assert.match(source, /text-amber-700 dark:text-amber-300/);
  assert.match(source, /text-slate-500 dark:text-slate-400/);

  // Change order type: warning surface + amber chip; selected stays yellow and inactive choices own
  // explicit light/dark surfaces instead of white-on-white glass.
  assert.match(source, /orderCount === 1[\s\S]*?liquidGlassModalTone\('warning'\)/);
  assert.match(source, /border-yellow-400 bg-yellow-400 text-black cursor-default/);
  assert.match(source, /border-slate-300 bg-white\/80 text-slate-900[^`]*dark:border-white\/20 dark:bg-white\/10 dark:text-slate-100/);
});

test('EditOptionsModal descriptions remain fully opaque and no light-theme content falls back to white text', () => {
  assert.doesNotMatch(source, /text-sm opacity-75 liquid-glass-modal-text-muted/);
  assert.match(source, /text-sm liquid-glass-modal-text-muted/);
  assert.doesNotMatch(source, /(?<!dark:)text-white(?:\/\d+)?/);
  assert.doesNotMatch(source, /(?<!dark:)border-white(?:\/\d+)?/);
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
