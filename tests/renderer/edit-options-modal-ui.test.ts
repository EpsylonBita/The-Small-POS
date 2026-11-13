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
// founder 11/11/2026: glass cards replace the opaque tone surfaces; the kit owns press depth.
test('EditOptionsModal uses frosted touch cards, visible focus and no hover/blue/violet', () => {
  assert.match(source, /<LiquidGlassModal/);
  assert.match(source, /title=\{t\('modals\.editOptions\.title'\)\}/);
  assert.equal((source.match(/pos-glass-tap-card min-h-touch w-full p-4 text-left/g) ?? []).length, 4);
  assert.doesNotMatch(source, /w-12 h-12|backdrop-blur-sm/, 'no icon chip remains');
  const icons = source.match(/<(?:svg aria-hidden="true"|DeliveryScooterIcon) className=\{?[`"]h-7 w-7 shrink-0/g) ?? [];
  assert.equal(icons.length, 5, 'every option icon is a bare 28 px svg that does not shrink');
  assert.doesNotMatch(source, /rounded-lg|rounded-md/);
  assert.match(source, /focus-visible:outline-2 focus-visible:outline-yellow-400/);
  assert.match(source, /focus-visible:outline-hidden focus-visible:ring-2/);
  const css = readFileSync(path.join(projectRoot, 'src/renderer/styles/glassmorphism.css'), 'utf8');
  assert.match(css, /\.pos-glass-tap-card:is\(:active, \[data-pressed\]\):not\(:disabled\)[\s\S]*?box-shadow: var\(--pos-s-depth-press\)/);
  assert.match(css, /button\.pos-glass-field:is\(:active, \[data-pressed\]\):not\(:disabled\)[\s\S]*?translate: 0 1px/);
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/);
  assert.doesNotMatch(source, /blue-|violet-|indigo-|cyan-|purple-/);
});

test('EditOptionsModal keeps semantic icons, yellow selected state and disabled payment guard', () => {
  assert.doesNotMatch(source, /liquidGlassModalTone/);
  assert.match(source, /onClick=\{onEditInfo\}[\s\S]*?pos-glass-tap-card/);
  assert.match(source, /h-7 w-7 shrink-0 text-slate-600 dark:text-slate-300/);
  assert.match(source, /onClick=\{onEditOrder\}[\s\S]*?pos-glass-tap-card/);
  assert.match(source, /h-7 w-7 shrink-0 text-emerald-700 dark:text-emerald-300/);
  assert.match(source, /disabled=\{!canEditPayment\}/);
  assert.match(source, /canEditPayment \? '' : 'cursor-not-allowed'/);
  assert.match(source, /text-amber-700 dark:text-amber-300/);
  assert.match(source, /text-slate-500 dark:text-slate-400/);
  assert.match(source, /orderCount === 1[\s\S]*?pos-glass-form-card w-full text-left/);
  assert.match(source, /border-\(--pos-s-sel-bg\) bg-\(--pos-s-sel-bg\) text-\(--pos-s-sel-fg\) cursor-default/);
  assert.match(source, /: 'pos-glass-field focus-visible:outline-hidden focus-visible:ring-2/);
  assert.match(source, /min-h-touch rounded-xl border px-3 py-2 text-sm font-semibold/);
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
