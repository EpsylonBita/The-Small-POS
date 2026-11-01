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

  // rounded-2xl option cards; the old rounded-lg modal chrome is gone.
  const rounded2xl = source.match(/rounded-2xl/g) ?? [];
  assert.ok(rounded2xl.length >= 5, `expected rounded-2xl option cards, found ${rounded2xl.length}`);
  // Founder 31/10: the icons stand without chips, a little bigger (28 px), and never shrink, so every
  // option's icon sits on the same vertical line.
  assert.doesNotMatch(source, /w-12 h-12|backdrop-blur-sm/, 'no icon chip remains');
  // The change-driver icon is the founder's scooter rider (31/10), the same bare 28 px treatment.
  const icons = source.match(/<(?:svg aria-hidden="true"|DeliveryScooterIcon) className=\{?[`"]h-7 w-7 shrink-0/g) ?? [];
  assert.equal(icons.length, 5, 'every option icon is a bare 28 px svg that does not shrink');
  assert.doesNotMatch(source, /rounded-lg|rounded-md/);

  // Theme-specific active feedback and visible keyboard focus; no hover-era classes anywhere.
  assert.match(source, /active:bg-slate-100[^"']*dark:active:bg-slate-800/);
  assert.match(source, /active:bg-emerald-100[^"']*dark:active:bg-zinc-800/);
  assert.match(source, /active:bg-\(--pos-s-surface-2\)/);
  assert.match(source, /focus-visible:outline-hidden focus-visible:ring-2/);
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
  assert.match(source, /h-7 w-7 shrink-0 text-slate-600 dark:text-slate-300/);

  // Edit order items: semantic success surface and matching high-contrast icon chip.
  assert.match(source, /onClick=\{onEditOrder\}[\s\S]*?liquidGlassModalTone\('success'\)/);
  assert.match(source, /h-7 w-7 shrink-0 text-emerald-700 dark:text-emerald-300/);

  // Payment: shared warning tone when editable; neutral readable surface when disabled.
  assert.match(source, /canEditPayment\s*\? `[\s\S]*?liquidGlassModalTone\('warning'\)/);
  assert.match(source, /: `[^`]*liquidGlassModalTone\('neutral'\)[^`]*cursor-not-allowed/);
  assert.doesNotMatch(source, /liquidGlassModalTone\('neutral'\)[^`]*opacity-/);
  assert.match(source, /text-amber-700 dark:text-amber-300/);
  assert.match(source, /text-slate-500 dark:text-slate-400/);

  // Change order type: warning surface + amber icon; selected = the kit selection, inactive choices are
  // solid kit controls (never glass on glass).
  assert.match(source, /orderCount === 1[\s\S]*?liquidGlassModalTone\('warning'\)/);
  assert.match(source, /border-\(--pos-s-sel-bg\) bg-\(--pos-s-sel-bg\) text-\(--pos-s-sel-fg\) cursor-default/);
  assert.match(source, /: 'border-\(--pos-s-border\) bg-\(--pos-s-surface\) text-\(--pos-s-fg\) active:bg-\(--pos-s-surface-2\)/);
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
