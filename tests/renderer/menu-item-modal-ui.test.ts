import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'menu', 'MenuItemModal.tsx'),
  'utf8',
);

test('quantity stepper decrement icon inherits the theme text color instead of hardcoded white', () => {
  // The hardcoded text-white/95 made the Minus icon invisible on the light-mode
  // glass button, so the control looked like a blank square before adding to cart.
  assert.doesNotMatch(
    source,
    /w-9 h-9 rounded-full flex items-center justify-center text-base font-bold text-white\/95/,
    'the decrement button must not hardcode white text that disappears in light mode',
  );
});

test('main quantity stepper buttons are accessibly labeled with matching lucide icons', () => {
  assert.match(
    source,
    /import \{ Ban, Check, MessageSquare, Minus, Plus, Search, ShoppingCart, X \} from 'lucide-react';/,
    'Plus must be imported for the consistent increment icon',
  );
  assert.match(
    source,
    /aria-label=\{t\('common\.actions\.decrease', \{ defaultValue: 'Decrease quantity' \}\)\}[\s\S]*?<Minus className="h-5 w-5 text-white drop-shadow-\[0_1px_2px_rgba\(0,0,0,0\.7\)\]" strokeWidth=\{3\.5\} aria-hidden="true" \/>/,
    'the decrement button needs an accessible label and a visible Minus icon',
  );
  assert.match(
    source,
    /aria-label=\{t\('common\.actions\.increase', \{ defaultValue: 'Increase quantity' \}\)\}[\s\S]*?<Plus className="h-5 w-5 text-white drop-shadow-\[0_1px_2px_rgba\(0,0,0,0\.7\)\]" strokeWidth=\{3\.5\} aria-hidden="true" \/>/,
    'the increment button needs an accessible label and a visible Plus icon',
  );
  assert.match(
    source,
    /border border-white\/45 bg-white\/20 text-white shadow-\[0_0_0_1px_rgba\(255,255,255,0\.12\)\]/,
    'the footer stepper buttons need enough contrast to keep the icon glyph visible',
  );
});

test('icon-only ingredient quantity and toggle controls expose aria-labels', () => {
  const decreaseLabels = source.match(/aria-label=\{t\('common\.actions\.decrease'\)\}/g);
  const increaseLabels = source.match(/aria-label=\{t\('common\.actions\.increase'\)\}/g);
  assert.ok(
    decreaseLabels && decreaseLabels.length >= 1,
    'the ingredient decrement control should expose an aria-label',
  );
  assert.ok(
    increaseLabels && increaseLabels.length >= 1,
    'the ingredient increment control should expose an aria-label',
  );
  assert.match(
    source,
    /aria-label=\{t\('common\.actions\.add'\)\}/,
    'the ingredient add control should expose an aria-label',
  );
});

const localesDir = path.join(process.cwd(), 'src', 'locales');
const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

test('notes overlay is portaled app-level above the modal, not an in-container absolute overlay', () => {
  // The notes editor must mount outside the MenuItemModal (LiquidGlassModal, z-index 20000)
  // so its footer/actions are not clipped by the modal's sticky footer.
  assert.match(source, /import \{ renderModalPortal \} from '\.\.\/\.\.\/utils\/render-modal-portal';/);
  assert.match(source, /\{showNotesOverlay && renderModalPortal\(\s*<div/);
  // Full-screen, blurred backdrop above the parent modal layer.
  assert.match(source, /className="fixed inset-0 z-\[20050\][^"]*bg-black\/60 backdrop-blur-sm/);

  // The clipped in-container overlay is gone.
  assert.doesNotMatch(source, /\{showNotesOverlay && \(\s*<div/);
  assert.doesNotMatch(source, /className="absolute inset-0 z-50[^"]*backdrop-blur-sm rounded-2xl"/);
});

// Regression contract for the swallowed Escape (2026-06-21 live QA): the notes textarea
// stopPropagation'd all key events, so Escape never reached any parent/topmost handler and
// the overlay would not close from the focused textarea. Escape must be handled IN the
// textarea: close only the notes overlay, stop it reaching the parent modals, keep typing.
test('notes textarea handles Escape to close only the notes overlay (not the parent modals)', () => {
  // The textarea's onKeyDown intercepts Escape, prevents default, stops propagation, and
  // closes the notes overlay, so the item-customization / order-entry modals stay open.
  assert.match(
    source,
    /onKeyDown=\{\(e\) => \{[\s\S]*?if \(e\.key === 'Escape'\) \{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*setShowNotesOverlay\(false\);\s*return;\s*\}[\s\S]*?e\.stopPropagation\(\);\s*\}\}/,
    'the notes textarea must close only the overlay on Escape and stop the event reaching parents',
  );
  // Non-Escape keys still stop propagation (typing is preserved, keystrokes do not leak).
  assert.match(source, /onKeyUp=\{\(e\) => e\.stopPropagation\(\)\}/);
  assert.match(source, /onKeyPress=\{\(e\) => e\.stopPropagation\(\)\}/);
  // The old blanket onKeyDown that swallowed Escape with no handling is gone.
  assert.doesNotMatch(source, /onKeyDown=\{\(e\) => e\.stopPropagation\(\)\}/);
  // The overlay stays portaled with the blurred backdrop (no regression).
  assert.match(source, /\{showNotesOverlay && renderModalPortal\(/);
  assert.match(source, /className="fixed inset-0 z-\[20050\][^"]*bg-black\/60 backdrop-blur-sm/);
});

test('notes overlay action uses a localized key present in every POS locale', () => {
  assert.match(source, /t\('common\.actions\.done'/);
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const done = loadLocale(lng)?.common?.actions?.done;
    assert.equal(typeof done, 'string', `${lng} missing common.actions.done`);
    assert.ok(done.length > 0, `${lng} empty common.actions.done`);
  }
  // Greek must be a real translation, not the English fallback "Done".
  assert.notEqual(loadLocale('el').common.actions.done, loadLocale('en').common.actions.done);
});

test('ingredient empty-state strings are routed through i18n (no hardcoded English)', () => {
  // The "no ingredients for this filter" empty state must use locale keys, and the
  // hint must interpolate the localized "All" label (menu.itemModal.all), so the
  // Greek UI never shows the raw English copy.
  assert.match(source, /t\('menu\.itemModal\.noIngredientsForFilter'/);
  assert.match(
    source,
    /t\('menu\.itemModal\.noIngredientsForFilterHint', \{ all: t\('menu\.itemModal\.all'/,
  );
  // The previously hardcoded literals are gone.
  assert.doesNotMatch(source, /<p>No ingredients available for this filter\.<\/p>/);
  assert.doesNotMatch(source, /Try selecting "All" to see all ingredients\./);
});

test('ingredient empty-state keys exist in every locale, Greek is translated, and {{all}} is preserved', () => {
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const im = loadLocale(lng)?.menu?.itemModal ?? {};
    assert.equal(typeof im.noIngredientsForFilter, 'string', `${lng} missing menu.itemModal.noIngredientsForFilter`);
    assert.equal(typeof im.noIngredientsForFilterHint, 'string', `${lng} missing menu.itemModal.noIngredientsForFilterHint`);
    // The hint must keep the {{all}} interpolation placeholder in every locale.
    assert.match(im.noIngredientsForFilterHint, /\{\{all\}\}/, `${lng} hint must keep {{all}} placeholder`);
  }
  const el = loadLocale('el').menu.itemModal;
  const en = loadLocale('en').menu.itemModal;
  assert.match(el.noIngredientsForFilter, GREEK, 'el noIngredientsForFilter should be Greek');
  assert.notEqual(el.noIngredientsForFilter, en.noIngredientsForFilter);
  assert.match(el.noIngredientsForFilterHint, GREEK, 'el noIngredientsForFilterHint should be Greek');
  assert.notEqual(el.noIngredientsForFilterHint, en.noIngredientsForFilterHint);
});
