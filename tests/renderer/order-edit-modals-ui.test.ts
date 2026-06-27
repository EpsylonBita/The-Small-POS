import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const editPaymentPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'EditPaymentMethodModal.tsx');
const cancellationPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'OrderCancellationModal.tsx');
const editPayment = readFileSync(editPaymentPath, 'utf8');
const cancellation = readFileSync(cancellationPath, 'utf8');

// Touch-first POS glass: both reachable order-edit modals use active/tap feedback only (no hover),
// stay in the semantic palette (no off-theme blue/cyan/...), and keep their LiquidGlassModal title=
// as a component prop (heading) with no native DOM title tooltip.
for (const [name, source] of [
  ['EditPaymentMethodModal', editPayment],
  ['OrderCancellationModal', cancellation],
] as const) {
  test(`${name} is touch-first and on-theme (no hover, no off-theme blue, component-prop title only)`, () => {
    assert.doesNotMatch(source, /hover:/, 'no hover utilities (active tap feedback only)');
    assert.doesNotMatch(source, /group-hover:|dark:hover:/);
    assert.doesNotMatch(
      source,
      /\b(?:bg|text|border|ring|from|to|via)-(?:blue|cyan|indigo|violet|purple|sky|slate)-/,
      'no off-theme blue/cyan/indigo/violet/purple/sky/slate tokens',
    );

    // The only title= is the LiquidGlassModal component prop (heading), not a native DOM tooltip.
    assert.match(source, /<LiquidGlassModal[\s\S]*?title=\{/);
    const titleAttrs = source.match(/\btitle=/g) ?? [];
    assert.equal(titleAttrs.length, 1, 'only the LiquidGlassModal component-prop title= may remain');
  });
}

test('EditPaymentMethodModal: green save, soft-red cancel, amber/non-blue card, neutral-grey disabled save', () => {
  // Save = semantic green primary when enabled.
  assert.match(editPayment, /bg-green-600 active:bg-green-700 text-white/);
  assert.doesNotMatch(editPayment, /bg-blue-500/);

  // Disabled save = explicit neutral zinc / white-transparent glass that cannot read blue in light or
  // dark (subtle neutral border + zinc text + disabled cursor). No gray-300/gray-600/slate.
  assert.match(
    editPayment,
    /!hasChanged \|\| isSaving[\s\S]*?bg-zinc-100 text-zinc-400 border border-zinc-200\/80 dark:bg-white\/\[0\.06\] dark:text-zinc-500 dark:border-white\/10 cursor-not-allowed/,
  );
  assert.doesNotMatch(editPayment, /bg-gray-300|dark:bg-gray-600/, 'disabled save must not use the blue-leaning grey tokens');

  // Cancel/back = soft red glass per the app rule.
  assert.match(
    editPayment,
    /border-red-300\/70 bg-red-50 text-red-700 dark:border-red-500\/25 dark:bg-red-500\/10 dark:text-red-200/,
  );
  assert.match(editPayment, /active:bg-red-100 dark:active:bg-red-500\/15/);

  // Card option is amber glass (cash stays green); neither uses blue.
  assert.match(
    editPayment,
    /selectedMethod === 'card'[\s\S]*?border-amber-300\/70 dark:border-amber-400\/40 bg-amber-100\/50 dark:bg-amber-500\/20/,
  );
  assert.match(editPayment, /active:bg-amber-100\/50 dark:active:bg-amber-500\/20/);
  assert.match(editPayment, /selectedMethod === 'cash'[\s\S]*?border-green-300\/70/);

  // Touch-safe buttons: rounded smooth, centered, min touch height.
  assert.match(editPayment, /rounded-2xl font-medium flex items-center justify-center min-h-\[44px\]/); // save
  assert.match(editPayment, /rounded-2xl border font-medium flex items-center justify-center min-h-\[44px\]/); // cancel
});

test('Round 310: OrderCancellationModal uses the shared glass footer -- red confirm enabled, subdued when disabled, neutral safe close', () => {
  // Actions live in the LiquidGlassModal footer prop (same fixed glass action bar as the newer form modals),
  // not a hand-rolled row inside the scroll body.
  const footerStart = cancellation.indexOf('footer={(');
  assert.notEqual(footerStart, -1, 'OrderCancellationModal must use the LiquidGlassModal footer prop');
  // The footer prop closes before the modal body (the intro paragraph is the first body node).
  const footerEnd = cancellation.indexOf("t('modals.orderCancellation.message'", footerStart);
  assert.ok(footerEnd > footerStart, 'the footer prop must close before the modal body');
  const footer = cancellation.slice(footerStart, footerEnd);

  // Subtle glass action bar: top divider + translucent bg + backdrop blur.
  assert.match(footer, /border-t/);
  assert.match(footer, /backdrop-blur/);

  // Safe close = neutral secondary glass (visually lighter than the destructive confirm), flex-1 + rounded.
  assert.match(footer, /onClick=\{handleClose\}/);
  assert.match(footer, /liquid-glass-modal-button liquid-glass-modal-secondary flex-1 rounded-xl/);

  // Destructive confirm = red error glass when enabled; disabled until a reason is typed, then subdued
  // (desaturated + dimmed) but clearly disabled. Same width (flex-1), rounded, touch-sized.
  assert.match(footer, /onClick=\{handleConfirm\}/);
  assert.match(footer, /disabled=\{!cancelReason\.trim\(\)\}/);
  assert.match(
    footer,
    /liquid-glass-modal-button liquid-glass-modal-error flex-1 rounded-xl disabled:opacity-50 disabled:saturate-0 disabled:cursor-not-allowed/,
  );

  // The old flat solid-red confirm block + its conditional neutral-zinc disabled twin are gone, and no
  // blue-leaning grey tokens slipped in.
  assert.doesNotMatch(cancellation, /bg-red-600 active:bg-red-700 text-white/, 'the flat solid-red confirm block must be gone');
  assert.doesNotMatch(cancellation, /bg-gray-300|dark:bg-gray-600/);
});

test('both order-edit modals preserve LiquidGlassModal title props + business callbacks (visual-only round)', () => {
  assert.match(
    editPayment,
    /title=\{orderNumber \? `\$\{t\('modals\.editPaymentMethod\.title'\)\} - #\$\{orderNumber\}` : t\('modals\.editPaymentMethod\.title'\)\}/,
  );
  assert.match(cancellation, /title=\{t\('modals\.orderCancellation\.title'\)\}/);

  // Callbacks / handlers untouched (no business/data-flow change).
  assert.match(editPayment, /onClick=\{handleSubmit\}/);
  assert.match(editPayment, /onSave\(selectedMethod\)/);
  assert.match(cancellation, /onClick=\{handleConfirm\}/);
  assert.match(cancellation, /onConfirmCancel\(cancelReason\)/);
});

// --- Round 316 (live QA, Greek/dark): inside OrderCancellationModal the SAFE/dismiss footer button read
// "Ακύρωση" -- the exact same word the modal uses for the destructive cancellation concept -- so cashiers
// could not tell the safe action from the dangerous one. The safe button now uses a dedicated, clearly
// non-destructive key (`keepOrder`, e.g. EN "Keep order"); the reused generic `cancel` key is removed so it
// cannot be re-wired. The red/error destructive confirm ("Confirm Cancel") and every guard
// (disabled-until-reason, reasonRequired toast, maxLength, focus, onConfirmCancel) are unchanged. ---
const localesDir = path.join(projectRoot, 'src', 'locales');
const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));
const POS_LOCALES = ['en', 'el', 'de', 'fr', 'it'] as const;

test('Round 316: OrderCancellationModal safe button is keep/dismiss copy; red confirm + all guards unchanged', () => {
  // SAFE/dismiss button now reads the dedicated non-destructive key, NOT the reused generic cancel word.
  assert.match(cancellation, /onClick=\{handleClose\}[\s\S]*?\{t\('modals\.orderCancellation\.keepOrder'\)\}/);
  assert.doesNotMatch(
    cancellation,
    /t\('modals\.orderCancellation\.cancel'\)/,
    'the safe button must not reuse the ambiguous orderCancellation.cancel key',
  );

  // Destructive confirm stays red/error glass, keyed to the destructive label, and disabled until a reason
  // is typed -- never recolored green/yellow/amber/emerald.
  assert.match(cancellation, /onClick=\{handleConfirm\}/);
  assert.match(cancellation, /\{t\('modals\.orderCancellation\.confirm'\)\}/);
  assert.match(
    cancellation,
    /liquid-glass-modal-button liquid-glass-modal-error flex-1 rounded-xl disabled:opacity-50 disabled:saturate-0 disabled:cursor-not-allowed/,
  );
  assert.match(cancellation, /disabled=\{!cancelReason\.trim\(\)\}/);
  assert.doesNotMatch(
    cancellation,
    /bg-(?:green|emerald|yellow|amber|lime)-/,
    'the destructive confirm must not be recolored green/yellow',
  );

  // Cancellation guards/behavior preserved exactly (no API/flow change).
  assert.match(cancellation, /onConfirmCancel\(cancelReason\)/);
  assert.match(cancellation, /toast\.error\(t\('modals\.orderCancellation\.reasonRequired'\)\)/);
  assert.match(cancellation, /maxLength=\{500\}/);
  assert.match(cancellation, /reasonInputRef\.current\?\.focus\(\)/);
});

test('Round 316: orderCancellation locale parity -- keepOrder present everywhere, Greek safe action is non-destructive', () => {
  for (const lng of POS_LOCALES) {
    const oc = loadLocale(lng).modals?.orderCancellation;
    assert.ok(oc, `${lng} missing modals.orderCancellation`);

    // The dedicated safe-action key exists and is non-empty in every supported locale.
    assert.equal(typeof oc.keepOrder, 'string', `${lng} missing orderCancellation.keepOrder`);
    assert.ok(oc.keepOrder.trim().length > 0, `${lng} empty orderCancellation.keepOrder`);

    // The reused generic cancel key is gone so it cannot be wired back to the safe button.
    assert.equal(oc.cancel, undefined, `${lng} must drop the ambiguous orderCancellation.cancel key`);

    // The destructive confirm label is still present (the destructive concept stays).
    assert.equal(typeof oc.confirm, 'string', `${lng} missing orderCancellation.confirm`);
  }

  // Greek: the safe button must NOT carry the cancellation word stem, while the destructive confirm
  // legitimately still does -- proving only the safe action lost the ambiguous word. The char class
  // [υύ] tolerates the tonos accent (Ακύρωση has ύ; the verb form ακυρώσετε has plain υ), since the /i
  // flag does not strip Greek accents.
  const CANCEL_STEM = /ακ[υύ]ρ/i;
  const el = loadLocale('el').modals.orderCancellation;
  assert.doesNotMatch(el.keepOrder, CANCEL_STEM, 'el safe button must not use the cancellation word (Ακύρωση)');
  assert.match(el.confirm, CANCEL_STEM, 'el destructive confirm should still read as a cancellation');
});
