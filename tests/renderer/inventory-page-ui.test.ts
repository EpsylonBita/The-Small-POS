import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const inventoryPagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'InventoryPage.tsx');
const localesDir = path.join(projectRoot, 'src', 'locales');

const inventoryPageSource = () => readFileSync(inventoryPagePath, 'utf8');

function flattenKeys(value: unknown, prefix = '', out = new Set<string>()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      flattenKeys(nested, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }

  out.add(prefix);
  return out;
}

test('InventoryPage opens item price and movement history from table rows', () => {
  const source = inventoryPageSource();

  assert.match(source, /pos\/inventory\/\$\{encodeURIComponent\(item\.id\)\}\/history/);
  assert.match(source, /onClick=\{\(\) => void openHistoryModal\(item\)\}/);
  assert.match(source, /inventory\.history\.priceHistory/);
  assert.match(source, /inventory\.history\.movements/);
  assert.match(source, /formatHistoryLoadError/);
  assert.match(source, /inventory\.history\.errors\.endpointUnavailable/);
  assert.match(source, /overflow-y-auto scrollbar-hide/);
  assert.match(source, /event\.stopPropagation\(\)/);
});

test('InventoryPage renders header and stat icons without wrapper boxes', () => {
  const source = inventoryPageSource();

  assert.match(source, /<h1 className="truncate text-3xl font-bold tracking-tight">\{t\('inventory\.title', 'Inventory'\)\}<\/h1>/);
  assert.match(source, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  // Round 261: the header refresh button is amber glass (was a stark black/white inversion square),
  // touch-first with active press feedback and no hover/native title.
  assert.match(source, /border border-amber-400\/30 bg-amber-500\/15 text-amber-300 active:bg-amber-500\/25/);
  assert.match(source, /border border-amber-400\/40 bg-amber-50 text-amber-600 active:bg-amber-100/);
  assert.match(source, /active:scale-95/);
  // The old stark black/white refresh square is gone (refresh-scoped: the `border border-...` prefix
  // distinguishes it from the status-filter pills, which intentionally keep their selected styling).
  assert.doesNotMatch(source, /border border-white\/80 bg-white text-black/);
  assert.doesNotMatch(source, /border border-black bg-black text-white/);
  // aria-label only - no native title, no hover/group-hover utilities.
  assert.doesNotMatch(source, /\btitle=/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  // Behaviour/shape preserved: same handler, 44px square, spinner, neutral disabled.
  assert.match(source, /onClick=\{fetchInventory\}/);
  assert.match(source, /h-12 w-12/);
  assert.match(source, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);
  assert.match(source, /loading \? 'opacity-60 cursor-not-allowed' : 'active:scale-95'/);
  assert.match(source, /<Boxes className=\{`w-5 h-5 shrink-0/);
  assert.match(source, /<XCircle className=\{`w-5 h-5 shrink-0/);
  assert.match(source, /<AlertTriangle className=\{`w-5 h-5 shrink-0/);
  assert.match(source, /<CheckCircle className=\{`w-5 h-5 shrink-0/);
  assert.match(source, /<BarChart3 className=\{`w-5 h-5 shrink-0/);
  assert.doesNotMatch(source, /<Package className=\{`w-8 h-8 shrink-0/);
  assert.doesNotMatch(source, /<div className=\{`[^`]*p-3 rounded-xl[^`]*`\}>\s*<Package className/);
  assert.doesNotMatch(source, /<div className=\{`[^`]*p-2 rounded-lg[^`]*`\}>\s*<Boxes className/);
  assert.doesNotMatch(source, /<div className=\{`[^`]*p-2 rounded-lg[^`]*`\}>\s*<XCircle className/);
  assert.doesNotMatch(source, /<div className=\{`[^`]*p-2 rounded-lg[^`]*`\}>\s*<AlertTriangle className/);
  assert.doesNotMatch(source, /<div className=\{`[^`]*p-2 rounded-lg[^`]*`\}>\s*<CheckCircle className/);
  assert.doesNotMatch(source, /<div className=\{`[^`]*p-2 rounded-lg[^`]*`\}>\s*<BarChart3 className/);
});

test('InventoryPage stock-status filter labels use localized inventory.filter keys', () => {
  const source = inventoryPageSource();
  assert.match(source, /t\(`inventory\.filter\.\$\{status\}`/);
});

test('InventoryPage history and adjustment overlays portal above the page container with a blurred app backdrop', () => {
  const source = inventoryPageSource();

  assert.match(source, /import \{ renderModalPortal \} from '\.\.\/utils\/render-modal-portal';/);
  // Both overlays portal to the app shell (document.body) instead of rendering inline.
  assert.match(source, /\{historyItem && renderModalPortal\(\s*<div/);
  assert.match(source, /\{showAdjustModal && selectedItem && renderModalPortal\(\s*<div/);

  // High-z, full-screen, blurred backdrops for both overlays.
  const highZBlur = source.match(
    /className="fixed inset-0 bg-black\/[0-9]+ backdrop-blur-sm[^"]*z-\[1200\][^"]*"/g,
  );
  assert.ok(highZBlur && highZBlur.length >= 2, 'both overlays should use high-z blurred backdrops');

  // The old inline, page-contained z-50 overlays must be gone.
  assert.doesNotMatch(source, /\{historyItem && \(\s*<div/);
  assert.doesNotMatch(source, /\{showAdjustModal && selectedItem && \(\s*<div/);
  assert.doesNotMatch(source, /className="fixed inset-0 bg-black\/[0-9]+ flex items-center justify-center z-50/);

  // Existing backdrop-click close behavior is preserved, now routed through the
  // close-only callbacks shared by the X/Cancel buttons and the Escape handlers.
  assert.match(source, /onClick=\{closeHistoryModal\}/);
  assert.match(source, /onClick=\{closeAdjustModal\}/);
});

test('InventoryPage history translation keys exist in every POS locale', () => {
  const requiredKeys = [
    'filter.all',
    'filter.critical',
    'filter.low',
    'filter.good',
    'noCategory',
    'history.open',
    'history.title',
    'history.currentStock',
    'history.currentCost',
    'history.purchased',
    'history.used',
    'history.priceHistory',
    'history.priceHistoryDescription',
    'history.noPriceHistory',
    'history.movements',
    'history.noMovements',
    'history.date',
    'history.invoice',
    'history.supplier',
    'history.quantity',
    'history.unitCost',
    'history.change',
    'history.priceChange.initial',
    'history.priceChange.same',
    'history.movementTypes.purchase',
    'history.movementTypes.adjustment',
    'history.movementTypes.count',
    'history.movementTypes.sale',
    'history.movementTypes.waste',
    'history.movementTypes.transfer',
    'history.movementTypes.return',
    'history.errors.loadFailed',
    'history.errors.endpointUnavailable',
    'history.errors.itemNotFound',
  ];

  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();

  for (const file of localeFiles) {
    const locale = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
    const available = flattenKeys(locale.inventory);
    const missing = requiredKeys.filter(key => !available.has(key));

    assert.deepEqual(
      missing,
      [],
      `${file} is missing InventoryPage translations:\n${missing.map(key => `  - inventory.${key}`).join('\n')}`,
    );
  }
});

// Regression contract for unnamed stock-adjustment controls (2026-06-21 review): the
// decrement/increment buttons and the quantity input had no accessible name, so
// keyboard/assistive-tech staff could not tell which control adjusts the quantity.
test('InventoryPage adjustment quantity controls expose localized accessible labels', () => {
  const source = inventoryPageSource();

  // Decrement button: localized accessible name, adjacent to its decrement handler.
  assert.match(
    source,
    /aria-label=\{t\('common\.actions\.decrease', \{ defaultValue: 'Decrease' \}\)\} onClick=\{\(\) => setAdjustmentQty\(q => q - 1\)\}/,
  );
  // Quantity input: localized accessible name.
  assert.match(
    source,
    /aria-label=\{t\('inventory\.adjustmentQuantity', \{ defaultValue: 'Adjustment quantity' \}\)\}\s*value=\{adjustmentQty\}/,
  );
  // Increment button: localized accessible name, adjacent to its increment handler.
  assert.match(
    source,
    /aria-label=\{t\('common\.actions\.increase', \{ defaultValue: 'Increase' \}\)\} onClick=\{\(\) => setAdjustmentQty\(q => q \+ 1\)\}/,
  );
});

test('Inventory adjustment-control label keys exist in every locale (Greek translated)', () => {
  const loadLocale = (lng: string) =>
    JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const root = loadLocale(lng);
    assert.equal(typeof root.inventory?.adjustmentQuantity, 'string', `${lng} missing inventory.adjustmentQuantity`);
    assert.ok(root.inventory.adjustmentQuantity.length > 0, `${lng} empty inventory.adjustmentQuantity`);
    assert.equal(typeof root.common?.actions?.decrease, 'string', `${lng} missing common.actions.decrease`);
    assert.equal(typeof root.common?.actions?.increase, 'string', `${lng} missing common.actions.increase`);
  }
  // Greek must be a real translation, not the English source.
  assert.notEqual(
    loadLocale('el').inventory.adjustmentQuantity,
    loadLocale('en').inventory.adjustmentQuantity,
  );
});

// Regression contract for unreadable adjustment modal text (2026-06-21 review): after
// portaling to document.body, the adjustment panel lost the page-root inherited text
// color, so heading/item/labels rendered near-black on the dark bg-zinc-950 panel. The
// portaled panel must set explicit dark/light foreground classes (like the history modal).
test('InventoryPage adjustment modal panel sets explicit dark/light foreground text after portaling', () => {
  const source = inventoryPageSource();

  // The portaled adjustment panel carries explicit readable text classes for both modes (the glass
  // chrome around them may vary; what matters is text-white on dark and text-gray-950 on light).
  assert.match(
    source,
    /p-6 rounded-2xl border[\s\S]*?isDark \? '[^']*text-white[^']*' : '[^']*text-gray-950[^']*'[\s\S]*?w-full max-w-md/,
  );
  // It is still portaled with the blurred backdrop (no regression).
  assert.match(source, /\{showAdjustModal && selectedItem && renderModalPortal\(/);
  assert.match(source, /fixed inset-0 bg-black\/50 backdrop-blur-sm[^"]*z-\[1200\]/);
});

// Round 185 (touch-first a11y): InventoryPage icon-only controls exposed native title descriptions
// ("... Description: ...") in accessibility. Native title tooltips are hover-dependent and must not
// exist on the touchscreen POS; accessible names come from aria-label, with handlers/disabled gates
// preserved. The Total Value stat card's cyan top border is replaced by the amber palette.
test('InventoryPage has no native title/hover/cyan; controls keep handlers + localized aria-labels', () => {
  const source = inventoryPageSource();

  // No native title, no hover utilities, and no off-palette color chrome on stat cards/controls.
  assert.doesNotMatch(source, /\btitle=/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /dark:hover:/);
  assert.doesNotMatch(source, /group-hover:/);
  // Explicit cyan + blue checks (the stat-card stripes that were neutralized in round 185).
  assert.doesNotMatch(source, /border-t-cyan|text-cyan|bg-cyan|border-cyan/);
  assert.doesNotMatch(source, /border-t-blue|text-blue|bg-blue|border-blue/);
  // Broad scan: no blue/cyan/purple-family color UTILITY tokens anywhere in the InventoryPage
  // source (matches a utility prefix + off-palette hue, so it ignores any prose). Stat stripes use
  // neutral zinc + the semantic red/amber/green stock-status palette only.
  assert.doesNotMatch(
    source,
    /(?:border-t-|border-|text-|bg-|ring-|from-|to-|via-)(?:blue|cyan|purple|violet|pink|sky|indigo)-/,
  );

  // Refresh keeps its handler + localized aria-label.
  assert.match(source, /onClick=\{fetchInventory\}/);
  assert.match(source, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);

  // History row keeps its open handler + accessible name (no title).
  assert.match(source, /onClick=\{\(\) => void openHistoryModal\(item\)\}/);
  assert.match(source, /aria-label=\{t\('inventory\.history\.open', 'View price and movement history'\)\}/);

  // Adjust-stock icon button keeps its handler (stopPropagation + openAdjustModal) + localized aria-label.
  assert.match(source, /event\.stopPropagation\(\);\s*openAdjustModal\(item\);/);
  assert.match(source, /aria-label=\{adjustAction\.message \|\| t\('inventory\.adjustStock', 'Adjust Stock'\)\}/);

  // Adjust modal Save button keeps its handler + disabled gate + visible "Save", with a reason-aware
  // aria-label (no native title for the disabled reason).
  assert.match(source, /onClick=\{\(\) => void handleAdjustStock\(\)\}/);
  assert.match(source, /disabled=\{adjustmentQty === 0 \|\| adjustAction\.disabled\}/);
  assert.match(
    source,
    /aria-label=\{adjustAction\.message \? `\$\{t\('common\.save', 'Save'\)\}: \$\{adjustAction\.message\}` : t\('common\.save', 'Save'\)\}/,
  );
  assert.match(source, /\{t\('common\.save', 'Save'\)\}/);
});

test('InventoryPage supervisor polish keeps controls rounded and touch-first', () => {
  const source = inventoryPageSource();

  assert.doesNotMatch(source, /rounded-lg|rounded-md/);
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/);
  assert.doesNotMatch(source, /bg-blue|text-blue|border-blue|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /bg-purple|text-purple|border-purple|ring-purple/);
  assert.match(source, /shrink-0 rounded-2xl px-3 py-2 text-sm font-medium border transition-transform active:scale-\[0\.98\]/);
  assert.match(source, /px-4 py-2 rounded-2xl font-medium transition-transform active:scale-\[0\.98\] border/);
  assert.match(source, /p-2 rounded-2xl transition-transform active:scale-\[0\.96\]/);
  assert.match(source, /inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border transition-transform active:scale-95/);
  assert.match(source, /w-full px-3 py-2 rounded-2xl border/);
  assert.match(source, /w-full px-3 py-2 rounded-2xl resize-none border/);
});

// Regression contract for inaccessible Inventory modals (2026-06-21 live QA): both
// the history and the stock-adjustment overlays looked modal (portaled + blurred)
// but exposed no role="dialog"/aria-modal/aria-labelledby, so assistive tech never
// announced them as dialogs and they could not be reasoned about as modal surfaces.
test('Inventory history and adjustment modals expose labelled dialog semantics', () => {
  const source = inventoryPageSource();

  // Stable per-modal title ids come from useId at the top level of the component.
  assert.match(source, /import React, \{[^}]*\buseId\b[^}]*\} from 'react';/);
  assert.match(source, /const historyTitleId = useId\(\);/);
  assert.match(source, /const adjustTitleId = useId\(\);/);

  // History modal panel: dialog role + aria-modal + aria-labelledby wired to its heading.
  assert.match(
    source,
    /ref=\{historyDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{historyTitleId\}/,
    'history modal panel must declare a labelled dialog',
  );
  assert.match(source, /<h3 id=\{historyTitleId\}[^>]*>\{isGreek \? historyItem\.name_el : historyItem\.name_en\}<\/h3>/);

  // Adjustment modal panel: dialog role + aria-modal + aria-labelledby wired to its heading.
  assert.match(
    source,
    /ref=\{adjustDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{adjustTitleId\}/,
    'adjustment modal panel must declare a labelled dialog',
  );
  assert.match(source, /<h3 id=\{adjustTitleId\}[^>]*>\{t\('inventory\.adjustStock', 'Adjust Stock'\)\}<\/h3>/);
});

test('Escape closes the topmost open Inventory modal using the shared topmost-dialog gate', () => {
  const source = inventoryPageSource();

  // Two Escape effects, each gated on its own open-state so listeners are only live
  // while the relevant modal is open (InventoryPage is always mounted).
  assert.match(source, /if \(!historyItem\) \{\s*return;\s*\}/);
  assert.match(source, /if \(!showAdjustModal\) \{\s*return;\s*\}/);

  // Both handlers only react to the Escape key.
  assert.match(source, /if \(event\.key !== 'Escape'\) \{\s*return;\s*\}/);

  // Topmost-[role="dialog"] gating for each panel (mirrors TableActionModal/RoomsView):
  // a dialog opened above one of these closes first, and an underlying modal is never
  // dismissed instead.
  const dialogStackQueries = source.match(
    /const dialogs = Array\.from\(document\.querySelectorAll\('\[role="dialog"\]'\)\);/g,
  ) ?? [];
  assert.ok(dialogStackQueries.length >= 2, 'each Escape handler should compute the live dialog stack');
  assert.match(source, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== historyDialogRef\.current/);
  assert.match(source, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== adjustDialogRef\.current/);

  // Escape prevents default and routes through the close-only callbacks.
  assert.match(source, /event\.preventDefault\(\);\s*closeHistoryModal\(\);/);
  assert.match(source, /event\.preventDefault\(\);\s*closeAdjustModal\(\);/);

  // Listener registration + cleanup for both effects.
  const adds = source.match(/document\.addEventListener\('keydown', handleEscape\)/g) ?? [];
  const removes = source.match(/document\.removeEventListener\('keydown', handleEscape\)/g) ?? [];
  assert.ok(adds.length >= 2, 'both modals should register an Escape keydown listener');
  assert.ok(removes.length >= 2, 'both Escape listeners should be cleaned up on close/unmount');
});

test('Dismissing an Inventory modal (Escape/backdrop/X/Cancel) never triggers the adjustment submit', () => {
  const source = inventoryPageSource();

  // closeHistoryModal only clears the open history item.
  assert.match(
    source,
    /const closeHistoryModal = useCallback\(\(\) => \{\s*setHistoryItem\(null\);\s*\}, \[\]\);/,
  );
  // closeAdjustModal closes + resets the form (mirrors the old Cancel handler) and
  // crucially does NOT call handleAdjustStock - so no dismissal path can save.
  assert.match(
    source,
    /const closeAdjustModal = useCallback\(\(\) => \{\s*setShowAdjustModal\(false\);\s*setAdjustmentReason\('count'\);\s*setAdjustmentNotes\(''\);\s*\}, \[\]\);/,
  );
  assert.doesNotMatch(
    source,
    /const closeAdjustModal = useCallback\(\(\) => \{[\s\S]*?handleAdjustStock[\s\S]*?\}, \[\]\);/,
    'the adjustment close path must never invoke the save/adjust submit',
  );

  // The Save button remains the only caller of the adjustment submit, and no Escape
  // handler routes to it.
  assert.match(source, /onClick=\{\(\) => void handleAdjustStock\(\)\}/);
  assert.doesNotMatch(source, /event\.preventDefault\(\);\s*void handleAdjustStock\(\)/);

  // The close-only callbacks back every non-save dismissal affordance (backdrop, X, Cancel).
  assert.match(source, /onClick=\{closeHistoryModal\}/);
  assert.match(source, /onClick=\{closeAdjustModal\}/);
});
