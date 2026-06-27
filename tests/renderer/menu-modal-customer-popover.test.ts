import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'MenuModal.tsx'),
  'utf8',
);

test('pickup customer popover is portaled app-level above the LiquidGlassModal viewport (z-index 20000)', () => {
  // The parent MenuModal is a LiquidGlassModal whose viewport is z-index 20000, so a
  // z-[1200] in-modal layer was mounted underneath it and stayed invisible.
  assert.match(source, /import \{ renderModalPortal \} from '\.\.\/\.\.\/utils\/render-modal-portal';/);
  assert.match(source, /\{showCustomerPopover && renderModalPortal\(\s*<div/);
  assert.match(source, /className="fixed inset-0 z-\[20050\] flex items-center justify-center"/);
  // Full-screen blurred backdrop.
  assert.match(source, /absolute inset-0 bg-black\/50 backdrop-blur-md/);

  // The old in-modal layer that hid behind the modal is gone.
  assert.doesNotMatch(source, /\{showCustomerPopover && \(\s*<div/);
  assert.doesNotMatch(source, /z-\[1200\]/);
});

// Regression contract for the unnamed popover close control (2026-06-21 live QA): the
// customer popover X was an icon-only <button> with no accessible name, so the nested
// dialog exposed a blank "button" in the a11y tree.
test('pickup customer popover close button exposes a localized accessible name', () => {
  // The icon-only X close control carries aria-label + title from the same close key
  // the parent MenuModal close uses (common.actions.close -> "Κλείσιμο" in Greek).
  assert.match(
    source,
    /onClick=\{\(\) => setShowCustomerPopover\(false\)\}\s*aria-label=\{t\('common\.actions\.close', \{ defaultValue: 'Close' \}\)\}\s*title=\{t\('common\.actions\.close', \{ defaultValue: 'Close' \}\)\}\s*className="liquid-glass-modal-close/,
    'the popover close button must have a localized aria-label and title',
  );
  // The original unlabeled icon-only close button (blank "button" in the a11y tree) is gone.
  assert.doesNotMatch(
    source,
    /<button onClick=\{\(\) => setShowCustomerPopover\(false\)\} className="liquid-glass-modal-close/,
    'the popover close button must not be an unlabeled icon-only control',
  );
});

test('pickup customer popover close key is translated in every POS locale', () => {
  const localesDir = path.join(process.cwd(), 'src', 'locales');
  const loadLocale = (lng: string): Record<string, any> =>
    JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

  const en = loadLocale('en').common?.actions?.close;
  assert.equal(typeof en, 'string', 'en missing common.actions.close');

  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const value = loadLocale(lng).common?.actions?.close;
    assert.equal(typeof value, 'string', `${lng} missing common.actions.close`);
    assert.ok(value.length > 0, `${lng} empty common.actions.close`);
  }
  // Greek (the live UI) must be a real translation, not the English fallback.
  assert.notEqual(loadLocale('el').common.actions.close, en, 'el common.actions.close must be translated');
});

test('hasCustomerInfo counts locally entered pickup name/phone (chip shows after saving)', () => {
  const block = source.match(/const hasCustomerInfo = !!\([\s\S]*?\);/);
  assert.ok(block, 'hasCustomerInfo declaration not found');
  assert.match(block[0], /pickupCustomerName && pickupCustomerName\.trim\(\)/);
  assert.match(block[0], /pickupCustomerPhone && pickupCustomerPhone\.trim\(\)/);
});

test('customer/table chip label falls back to selectedCustomer so it never renders icon-only', () => {
  // A dine-in pseudo-customer (e.g. "Table #TB02") arrives via selectedCustomer
  // after the modal opens, so the chip must fall back to it when the locally
  // initialized pickup fields are empty - otherwise hasCustomerInfo is true but
  // the chip shows only the User icon with no text.
  assert.match(source, /const customerChipName = pickupCustomerName \|\| selectedCustomer\?\.name \|\| '';/);
  assert.match(
    source,
    /const customerChipPhone =\s*pickupCustomerPhone \|\| selectedCustomer\?\.phone \|\| selectedCustomer\?\.phone_number \|\| '';/,
  );
  // The hasCustomerInfo chip renders the fallback-aware label, not the raw pickup-only pair.
  assert.match(source, /\{customerChipName \|\| customerChipPhone\}/);
  assert.doesNotMatch(source, /\{pickupCustomerName \|\| pickupCustomerPhone\}/);
});

test('MenuModal header cannot horizontally clip the full/edit modal off the viewport', () => {
  // A flex-shrink-0 title forced the header (and the centered shell) wider than the
  // viewport, so a long edit title pushed the modal off the left edge (clipped title,
  // first category tab, and first product column).

  // The non-shrinking title class is gone; the title is shrinkable + truncates with a
  // hover tooltip, and the edit badge stays non-shrinking beside it.
  assert.doesNotMatch(source, /liquid-glass-modal-title text-xl flex-shrink-0/);
  assert.match(source, /className="liquid-glass-modal-title text-xl flex items-center gap-2 min-w-0"/);
  assert.match(source, /title=\{getModalTitle\(\)\}/);
  assert.match(source, /<span className="truncate">\{getModalTitle\(\)\}<\/span>/);
  assert.match(source, /flex-shrink-0 whitespace-nowrap[\s\S]*?editModeMessage/);

  // The header flex chain can shrink below its content so it never forces the shell wide.
  assert.match(source, /flex flex-col gap-1 px-5 py-2\.5 border-b border-white\/10 flex-shrink-0 min-w-0/);
  assert.match(source, /flex items-center justify-between gap-4 w-full min-w-0/);

  // The close control is always reachable (never the clipped element).
  assert.match(source, /liquid-glass-modal-button p-2 min-h-0 min-w-0 flex-shrink-0/);

  // The customer chips are width-bounded and truncate so a long name/phone can't
  // expand the header past the viewport. The older blue customer chip is gone;
  // both populated customer states now use the green customer accent.
  assert.match(source, /bg-green-500\/20[\s\S]*?max-w-\[16rem\]/);
  assert.match(source, /border-green-500\/40[\s\S]*?max-w-\[16rem\]/);
  assert.doesNotMatch(source, /border-blue-500\/40/);

  // The menu panel keeps its min-w-0/overflow guard so the grid/tabs start in-viewport.
  assert.match(source, /flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden/);
});

test('Escape closes the pickup customer popover only, leaving the parent MenuModal open', () => {
  // The popover renders role="dialog" above the MenuModal, so MenuModal's own
  // LiquidGlassModal Escape handler self-suppresses (isTopMostDialog). Previously the
  // popover had NO Escape handler, so Escape did nothing. This adds the missing close.
  assert.match(source, /role="dialog"/, 'popover must declare role="dialog" to be the topmost dialog');
  assert.match(
    source,
    /if \(!showCustomerPopover\) \{\s*return;\s*\}\s*const onEscape = \(event: KeyboardEvent\) => \{\s*if \(event\.key === 'Escape'\) \{\s*setShowCustomerPopover\(false\);/,
    'Escape must close the customer popover',
  );
  assert.match(source, /window\.addEventListener\('keydown', onEscape\)/);
  assert.match(source, /window\.removeEventListener\('keydown', onEscape\)/);
});

test('LiquidGlassModal Escape is gated on isTopMostDialog so only the topmost overlay closes', () => {
  // The whole fix relies on this: a nested overlay marked role="dialog" becomes the
  // last [role="dialog"], so the parent MenuModal (and the item-customization modal
  // stacking) only acts on Escape when it is itself the topmost dialog.
  const glassSource = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'ui', 'pos-glass-components.tsx'),
    'utf8',
  );
  assert.match(glassSource, /const isTopMostDialog = React\.useCallback\(/);
  assert.match(
    glassSource,
    /document\.querySelectorAll\('\[role="dialog"\]'\)/,
    'topmost detection scans [role="dialog"] elements',
  );
  assert.match(
    glassSource,
    /if \(e\.key !== 'Escape' \|\| !closeOnEscape \|\| !isTopMostDialog\(\)[\s\S]*?\) return/,
    'LiquidGlassModal must ignore Escape unless it is the topmost dialog',
  );
});

// Regression contract for the discarded dirty cart (2026-06-21 live QA): closing a new
// order with items in the cart via X/Escape dropped the draft with no warning. The close
// must route through a discard confirmation; only final discard/success paths close directly.
test('MenuModal routes the X / Escape close through a dirty-cart discard confirmation for new orders', () => {
  // requestClose shows the confirmation only for a NEW order with a populated cart; it
  // otherwise closes immediately (edit mode / empty cart).
  assert.match(
    source,
    /const requestClose = useCallback\(\(\) => \{\s*if \(!editMode && cartItems\.length > 0\) \{\s*setShowDiscardConfirm\(true\);\s*return;\s*\}\s*onClose\(\);\s*\}, \[editMode, cartItems\.length, onClose\]\);/,
  );

  // Both the header X and the LiquidGlassModal (its internal Escape) close via requestClose,
  // not the raw onClose.
  assert.match(source, /onClose=\{requestClose\}/, 'LiquidGlassModal must close via requestClose');
  assert.match(source, /onClick=\{requestClose\}/, 'the header X must close via requestClose');
  assert.doesNotMatch(source, /onClose=\{onClose\}/, 'LiquidGlassModal must no longer wire the raw onClose');

  // The success paths still call the raw onClose directly (after clearing the cart), so a
  // saved order/checkout is never blocked by the discard confirmation.
  assert.ok(
    (source.match(/^\s*onClose\(\);\s*$/gm) || []).length >= 2,
    'edit-save and complete-order success paths must still call onClose() directly',
  );
});

test('MenuModal discard confirmation is a topmost portaled blurred dialog with close-only paths', () => {
  // Portaled outside the container, blurred backdrop, topmost over MenuModal (z > 20000),
  // labelled role="dialog".
  assert.match(source, /\{showDiscardConfirm && renderModalPortal\(/);
  assert.match(source, /className="fixed inset-0 z-\[20060\][^"]*bg-black\/60 backdrop-blur-md/);
  assert.match(source, /ref=\{discardDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{discardTitleId\}/);
  assert.match(source, /<h3 id=\{discardTitleId\}[^>]*>\s*\{t\('modals\.menu\.discardOrder\.title'/);

  // Escape closes ONLY the confirmation (MenuModal/cart stay intact).
  assert.match(
    source,
    /if \(!showDiscardConfirm\) \{\s*return;\s*\}\s*const onEscape = \(event: KeyboardEvent\) => \{\s*if \(event\.key === 'Escape'\) \{\s*setShowDiscardConfirm\(false\);/,
  );

  // "Keep editing" closes only the confirmation; "Discard order" clears the cart then closes.
  assert.match(source, /onClick=\{\(\) => setShowDiscardConfirm\(false\)\}/);
  assert.match(
    source,
    /const handleDiscardOrder = useCallback\(\(\) => \{\s*setShowDiscardConfirm\(false\);\s*setCartItems\(\[\]\);\s*onClose\(\);\s*\}, \[onClose\]\);/,
  );
  assert.match(source, /onClick=\{handleDiscardOrder\}/);
  // No native confirm.
  assert.doesNotMatch(source, /window\.confirm/);
});

test('MenuModal discard confirmation copy exists in every POS locale (Greek translated)', () => {
  const localesDir = path.join(process.cwd(), 'src', 'locales');
  const load = (lng: string): Record<string, any> =>
    JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));
  const keys = ['title', 'message', 'keepEditing', 'discard'];
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const d = load(lng)?.modals?.menu?.discardOrder ?? {};
    for (const k of keys) {
      assert.equal(typeof d[k], 'string', `${lng} missing modals.menu.discardOrder.${k}`);
      assert.ok(d[k].length > 0, `${lng} empty modals.menu.discardOrder.${k}`);
    }
  }
  const en = load('en').modals.menu.discardOrder;
  const el = load('el').modals.menu.discardOrder;
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const k of keys) {
    assert.notEqual(el[k], en[k], `el discardOrder.${k} must be translated`);
    assert.match(el[k], GREEK, `el discardOrder.${k} should be Greek`);
  }
});
