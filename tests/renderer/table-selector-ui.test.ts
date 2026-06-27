import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const selectorPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'tables',
  'TableSelector.tsx',
);
const source = readFileSync(selectorPath, 'utf8');

const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(projectRoot, 'src', 'locales', `${lng}.json`), 'utf8'));

// Round 224 (live QA, glass consistency): the TableSelector modal (Dashboard -> New Order -> Table order)
// was an opaque white panel with flat pale-green cards, disconnected from the glass Settings / Order Type
// modals. It is redesigned onto the shared LiquidGlassModal glass shell with glass-token inner controls
// and restrained green (available) / amber (reserved) semantic accents -- no hover, no native tooltips.
test('TableSelector renders on the shared glass modal shell with glass-token controls', () => {
  // Uses the shared LiquidGlassModal shell (same glass surface as Settings / Order Type), not a hand-
  // rolled opaque panel. The old opaque/portal shell is gone.
  assert.match(source, /import \{ LiquidGlassModal \} from '\.\.\/ui\/pos-glass-components'/);
  assert.match(source, /<LiquidGlassModal\b/);
  assert.match(source, /isOpen=\{isOpen\}/);
  assert.match(source, /onClose=\{onClose\}/);
  assert.match(source, /size="lg"/);
  assert.doesNotMatch(source, /renderModalPortal/);
  assert.doesNotMatch(source, /bg-gray-900 border border-white\/10/);
  assert.doesNotMatch(source, /'bg-white'/);

  // Inner controls reuse the glass design tokens (input / text / muted / border) so they read as one
  // designed system rather than an admin-web dialog.
  assert.match(source, /liquid-glass-modal-input/);
  assert.match(source, /liquid-glass-modal-text\b/);
  assert.match(source, /liquid-glass-modal-text-muted/);
  assert.match(source, /liquid-glass-modal-border/);

  // Stable markers for tests / live QA.
  assert.match(source, /data-table-selector\b/);
  assert.match(source, /data-table-selector-capacity/);
  assert.match(source, /data-table-selector-grid/);
});

test('TableSelector uses no hover utilities and no native title tooltips (touch-first)', () => {
  // Touch-first: no hover-only styling anywhere. Active/tap scale is allowed.
  assert.doesNotMatch(source, /hover:/);
  assert.match(source, /active:scale-95/);

  // The only `title=` is the LiquidGlassModal heading PROP (a visible heading, the approved exception) --
  // no native DOM title tooltips on any element.
  const titleAttrs = source.match(/\btitle=/g) || [];
  assert.equal(titleAttrs.length, 1, 'only the LiquidGlassModal title prop should use title=');
  assert.match(source, /title=\{t\('tableSelector\.title'/);
});

test('TableSelector keeps semantic green/amber status colours and drops the old blue accents', () => {
  // available -> green, reserved -> amber/yellow (status fill + legend dot). Not everything yellow.
  assert.match(source, /available:\s*\{[\s\S]*?bgClass: 'border-green-500\/50 bg-green-500\/10'/);
  assert.match(source, /reserved:\s*\{[\s\S]*?bgClass: 'border-yellow-500\/50 bg-yellow-500\/10'/);
  assert.match(source, /status === 'available' \? 'bg-green-500' : 'bg-yellow-500'/);

  // The min-capacity active state is amber (the app accent), not the old blue button / blue focus ring.
  assert.match(source, /border-amber-400\/50 bg-amber-400\/20/);
  assert.doesNotMatch(source, /bg-blue-600/);
  assert.doesNotMatch(source, /focus:ring-blue/);
  assert.doesNotMatch(source, /focus:border-blue/);
});

test('TableSelector capacity filter structure + table grid behaviour are preserved', () => {
  // Min-capacity segmented control: All + one button per capacity option, single-select toggle semantics.
  assert.match(source, /setSelectedCapacity\('all'\)/);
  assert.match(source, /capacityOptions\.map\(\(capacity\) =>/);
  assert.match(source, /setSelectedCapacity\(capacity\)/);
  assert.match(source, /aria-pressed=\{selectedCapacity === 'all'\}/);
  assert.match(source, /aria-pressed=\{selectedCapacity === capacity\}/);
  // Large touch targets on the segmented buttons.
  assert.match(source, /min-h-\[40px\]/);

  // Data flow + filtering preserved: selection callback, status filtering, search.
  assert.match(source, /onTableSelect\(table\)/);
  assert.match(source, /export function filterSelectableTables/);
  assert.match(source, /filterSelectableTables\(tables, filterStatuses\)/);
  assert.match(source, /onChange=\{\(e\) => setSearchTerm\(e\.target\.value\)\}/);
});

// Round 224 correction (live QA): the Greek search placeholder clipped because search shared a row with
// min-capacity. The filters now stack vertically so search owns a full-width row (language-safe, no
// locale-specific widths), with the floor + capacity segmented controls below it.
test('TableSelector search has a full-width row stacked above the segmented filters (language-safe)', () => {
  assert.match(source, /data-table-selector-filters className="space-y-3"/);
  // The search wrapper is full-width, no longer squeezed into a shared flex row with min-capacity.
  assert.match(source, /<div className="relative w-full">/);
  assert.doesNotMatch(source, /relative min-w-\[200px\] flex-1/);
  assert.match(source, /className="liquid-glass-modal-input w-full !pl-10"/);
});

// Round 224 live-QA follow-up: cards show formatted display labels (e.g. "#TP03"), but search only checked
// the raw tableNumber + notes, so typing "TP03" returned 0 results. Search must match what the operator
// SEES: a pure normalized matcher searches the raw number, the formatTableDisplayNumber label, AND notes.
test('TableSelector search matches the formatted display label, not just the raw table number', () => {
  // A pure normalization helper strips punctuation/case so "#TP03" / "TP03" / "tp03" collapse to one form.
  assert.match(source, /export function normalizeTableSearch\(value: string\): string \{/);
  // Unicode-safe: preserves \p{L}/\p{N} (Greek/accented letters + numbers) with the u flag, strips the
  // rest -- so multi-language notes/terms are not mangled. The old ASCII-only /[^a-z0-9]/g form is gone.
  assert.ok(
    source.includes("toLowerCase().replace(/[^\\p{L}\\p{N}]/gu, '')"),
    'normalizeTableSearch must use the Unicode-safe \\p{L}\\p{N} form with the u flag',
  );
  assert.doesNotMatch(source, /\[\^a-z0-9\]/);

  // A pure matcher (operators search what they see) -- not buried inline so its logic is guardable.
  assert.match(source, /export function tableMatchesSearchTerm\(table: RestaurantTable, rawTerm: string\): boolean \{/);
  const matcherStart = source.indexOf('export function tableMatchesSearchTerm');
  assert.notEqual(matcherStart, -1, 'tableMatchesSearchTerm helper must exist');
  const matcherEnd = source.indexOf('\n}', matcherStart);
  assert.notEqual(matcherEnd, -1, 'tableMatchesSearchTerm must close');
  const matcher = source.slice(matcherStart, matcherEnd);

  // The matcher searches the raw number, the FORMATTED display label, and notes (all normalized) -- this
  // proves formatTableDisplayNumber participates in SEARCH, not only in the card render.
  assert.match(matcher, /normalizeTableSearch\(String\(table\.tableNumber\)\)/);
  assert.match(matcher, /normalizeTableSearch\(formatTableDisplayNumber\(table\.tableNumber\)\)/);
  assert.match(matcher, /table\.notes \? normalizeTableSearch\(table\.notes\) : ''/);
  // An empty/punctuation-only term matches everything; otherwise any haystack containing the term matches.
  assert.match(matcher, /if \(!term\) return true;/);
  assert.match(matcher, /haystacks\.some\(value => value\.includes\(term\)\)/);

  // The grid filter is wired to the matcher; the old raw-only filter (tableNumber.toString().includes) is gone.
  assert.match(source, /result = result\.filter\(table => tableMatchesSearchTerm\(table, searchTerm\)\)/);
  assert.doesNotMatch(source, /table\.tableNumber\.toString\(\)\.includes/);

  // formatTableDisplayNumber is now used at least twice (search matcher + card render), not only rendering.
  const formatterUses = source.match(/formatTableDisplayNumber\(table\.tableNumber\)/g) || [];
  assert.ok(formatterUses.length >= 2, 'formatTableDisplayNumber must be used in search AND rendering');
});

// Round 224 correction (user request): the table picker now includes a floor selector, reusing the
// established TablesDashboard floor pattern (floorLevel ?? floor_level ?? 1) and filtering selectable
// tables by the chosen floor.
test('TableSelector has a floor selector wired to floor data, state, and filtering', () => {
  // Floor-value helper mirrors the TablesDashboard pattern.
  assert.match(source, /export function getTableFloorValue\(table: RestaurantTable\): string \{/);
  assert.match(source, /table\.floorLevel \?\? \(table as \{ floor_level\?: number \| null \}\)\.floor_level \?\? 1/);

  // selectedFloor state (default 'all') + unique sorted floorOptions from the selectable tables.
  assert.match(source, /const \[selectedFloor, setSelectedFloor\] = useState<string>\('all'\)/);
  assert.match(source, /const floorOptions = useMemo\(\(\) => \{/);
  assert.match(source, /selectableTables\.map\(table => getTableFloorValue\(table\)\)/);

  // Floor filtering is applied inside filteredTables and tracked in its dependency list.
  assert.match(
    source,
    /if \(selectedFloor !== 'all'\) \{\s*result = result\.filter\(table => getTableFloorValue\(table\) === selectedFloor\);/,
  );
  assert.match(source, /\[selectableTables, searchTerm, selectedCapacity, selectedFloor\]/);

  // Glass segmented control: All floors + one button per floor, single-select via aria-pressed.
  assert.match(source, /data-table-selector-floor/);
  assert.match(source, /setSelectedFloor\('all'\)/);
  assert.match(source, /floorOptions\.map\(\(floor\) =>/);
  assert.match(source, /setSelectedFloor\(floor\)/);
  assert.match(source, /aria-pressed=\{selectedFloor === 'all'\}/);
  assert.match(source, /aria-pressed=\{selectedFloor === floor\}/);

  // Localized labels, with {{floor}} interpolation preserved.
  assert.match(source, /t\('tableSelector\.floor'/);
  assert.match(source, /t\('tableSelector\.allFloors'/);
  assert.match(source, /t\('tableSelector\.floorNumber', \{ defaultValue: 'Floor \{\{floor\}\}', floor \}\)/);
});

test('TableSelector floor labels are localized in every POS locale with {{floor}} interpolation', () => {
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const ts = loadLocale(lng).tableSelector;
    for (const key of ['floor', 'allFloors', 'floorNumber']) {
      assert.ok(typeof ts[key] === 'string' && ts[key].trim().length, `${lng} tableSelector.${key} missing/empty`);
    }
    assert.match(ts.floorNumber, /\{\{floor\}\}/, `${lng} tableSelector.floorNumber must interpolate {{floor}}`);
  }
  // Greek floor labels are real translations, not the English source.
  assert.notEqual(
    loadLocale('el').tableSelector.allFloors,
    loadLocale('en').tableSelector.allFloors,
    'el tableSelector.allFloors must be a Greek translation',
  );
  assert.match(loadLocale('el').tableSelector.floor, new RegExp('[\\u0370-\\u03FF]'));
});

// Round 332 (live QA, Greek/dark, 1282x802): the TableSelector modal grew past the usable viewport so its
// bottom edge (last row of table cards) was clipped by the window. The shared shell's base max-height:92vh
// resolves against a layout viewport taller than the visible WebView client area, pushing the content's
// scroll bottom off-screen. TableSelector now bounds THIS modal to the visible viewport via the shared
// LiquidGlassModal's className (dvh cap + safe margin + flex column + overflow hidden) and makes the content
// body the single hidden-scroll region with bottom + scroll padding -- no global modal change.
test('Round 332: TableSelector bounds the modal to the viewport and uses one hidden-scroll content region', () => {
  // Shell is bounded to the VISIBLE viewport (dvh -- avoids the WebView vh overshoot) with a safe margin,
  // as a flex column that hides its own overflow so only the content body scrolls.
  assert.match(source, /className="flex flex-col overflow-hidden !max-h-\[calc\(100dvh-2rem\)\]"/);
  // A dynamic-viewport cap with a safe margin (not the unbounded shared default that overshoots the window).
  assert.match(source, /!max-h-\[calc\(100dvh-2rem\)\]/);

  // The content body is the SINGLE scroll region: flex-1 + min-h-0 so it can shrink, overflow-y-auto +
  // scrollbar-hide (no visible native rail), with bottom + scroll padding so the last row clears the radius.
  assert.match(source, /contentClassName="flex-1 min-h-0 overflow-y-auto scrollbar-hide pb-6 scroll-pb-6"/);

  // Exactly one scroll region and one hidden-scrollbar region (no nested competing scrollers).
  assert.equal((source.match(/overflow-y-auto/g) || []).length, 1, 'exactly one scroll region');
  assert.equal((source.match(/scrollbar-hide/g) || []).length, 1, 'exactly one hidden-scrollbar region');

  // The viewport-bounding props sit on the same modal as the (fixed, shared-shell) title header.
  assert.match(
    source,
    /<LiquidGlassModal[\s\S]*?title=\{t\('tableSelector\.title'[\s\S]*?className="flex flex-col overflow-hidden !max-h-\[calc\(100dvh-2rem\)\]"[\s\S]*?contentClassName="flex-1 min-h-0 overflow-y-auto scrollbar-hide pb-6 scroll-pb-6"/,
  );

  // Touch-first preserved: no hover utilities sneaked in with the viewport bound.
  assert.doesNotMatch(source, /hover:/);
});

test('TableSelector text is localized via tableSelector.* keys (no hardcoded Greek; all POS locales present)', () => {
  // No hardcoded Greek (or any non-Latin) strings in the component source.
  assert.doesNotMatch(source, new RegExp('[\\u0370-\\u03FF]'));

  // Visible strings come from the tableSelector.* i18n namespace.
  for (const key of [
    "t('tableSelector.title'",
    "t('tableSelector.subtitle'",
    "t('tableSelector.searchPlaceholder'",
    "t('tableSelector.minCapacity'",
    "t('tableSelector.all'",
    "t('tableSelector.noTables'",
  ]) {
    assert.ok(source.includes(key), `TableSelector should localize via ${key})`);
  }

  // Every POS locale defines tableSelector.title + minCapacity, and Greek is a real translation.
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const ts = loadLocale(lng).tableSelector;
    assert.ok(ts && typeof ts.title === 'string' && ts.title.trim().length, `${lng} tableSelector.title`);
    assert.ok(typeof ts.minCapacity === 'string' && ts.minCapacity.trim().length, `${lng} tableSelector.minCapacity`);
  }
  assert.notEqual(
    loadLocale('el').tableSelector.title,
    loadLocale('en').tableSelector.title,
    'el tableSelector.title must be a Greek translation, not English',
  );
});
