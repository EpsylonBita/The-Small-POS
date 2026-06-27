import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const menuManagementPageSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'pages', 'MenuManagementPage.tsx'),
    'utf8',
  );

test('MenuManagementPage uses yellow selected tabs with strong black text', () => {
  const source = menuManagementPageSource();

  assert.match(source, /useState<'categories' \| 'subcategories' \| 'ingredients' \| 'combos'>\('categories'\)/);
  assert.match(source, /const getTabClass = \(tab: typeof activeTab\)/);
  assert.match(source, /'bg-yellow-500 text-black font-semibold border border-yellow-400'/);
  assert.match(source, /className=\{getTabClass\('categories'\)\}/);
  assert.match(source, /className=\{getTabClass\('subcategories'\)\}/);
  assert.match(source, /className=\{getTabClass\('ingredients'\)\}/);
  assert.match(source, /className=\{getTabClass\('combos'\)\}/);
  assert.doesNotMatch(source, /bg-blue-500\/30 text-blue-200 border border-blue-500\/50/);
  assert.doesNotMatch(source, /bg-blue-500 text-white/);
});

// Regression contract for the mislabeled tab (2026-06-21 live QA): the 'subcategories' tab
// renders menu-item cards with prices (historical data model), so its staff-facing label
// must read "Menu Items". Round 165 localized the label via i18n; the internal key + bridge
// naming are still preserved.
test('MenuManagementPage labels the menu-items tab via i18n, not "Subcategories"', () => {
  const source = menuManagementPageSource();

  // The visible tab button (keyed on the historical 'subcategories' tab) renders the
  // localized menuItems label, not hardcoded English and not "Subcategories".
  assert.match(
    source,
    /onClick=\{\(\) => setActiveTab\('subcategories'\)\}[\s\S]*?>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?\{t\('menu\.managementTabs\.menuItems', 'Menu Items'\)\}\s*<\/button>/,
    'the subcategories tab button must render t("menu.managementTabs.menuItems")',
  );
  // The staff-facing "Subcategories" label is gone (the internal key/class stays).
  assert.doesNotMatch(source, />\s*Subcategories\s*</);

  // The historical data flow is intentionally preserved: internal key, bridge calls, render.
  assert.match(source, /className=\{getTabClass\('subcategories'\)\}/);
  assert.match(source, /activeTab === 'subcategories'/);
  assert.match(source, /bridge\.menu\.getSubcategories\(\)/);
});

test('MenuManagementPage uses neutral grey controls, white search outline, and yellow grid cards', () => {
  const source = menuManagementPageSource();

  // Round 165: inactive tabs use active: (touch) instead of hover:.
  assert.match(source, /bg-zinc-900 text-zinc-200 active:bg-zinc-800/);
  assert.match(source, /bg-gray-100 text-gray-700 active:bg-gray-200/);
  assert.match(source, /px-4 py-2 rounded-2xl transition-transform active:scale-\[0\.98\]/);
  assert.match(source, /w-full pl-10 pr-4 py-2 rounded-2xl border/);
  assert.match(source, /bg-zinc-900 border-white text-white placeholder-zinc-400/);
  assert.match(source, /bg-gray-100 border-white text-gray-900 placeholder-gray-500/);
  assert.match(source, /focus:outline-none focus:ring-2 focus:ring-white\/70/);
  assert.match(source, /const gridCardClass = `p-4 rounded-xl border/);
  assert.match(source, /bg-yellow-500\/10 border-yellow-500\/45/);
  assert.match(source, /bg-yellow-50 border-yellow-200/);
  assert.match(source, /className=\{`\$\{gridCardClass\} \$\{!category\.is_active \? 'opacity-60 grayscale' : ''\}`\}/);
  assert.match(source, /className=\{`\$\{gridCardClass\} \$\{!item\.is_available \? 'opacity-60 grayscale' : ''\}`\}/);
  assert.match(source, /className=\{`\$\{gridCardClass\} \$\{!ingredient\.is_available \? 'opacity-60 grayscale' : ''\}`\}/);
  assert.match(source, /className=\{`\$\{gridCardClass\} \$\{!combo\.is_active \? 'opacity-60 grayscale' : ''\}`\}/);
  assert.doesNotMatch(source, /bg-gray-800\/50 border-gray-700/);
  assert.doesNotMatch(source, /bg-white border-gray-200/);
  assert.doesNotMatch(source, /bg-slate-800\/70/);
  assert.doesNotMatch(source, /bg-slate-100/);
  assert.doesNotMatch(source, /focus:ring-blue-500/);
  assert.doesNotMatch(source, /rounded-lg|rounded-md/);
});

test('MenuManagementPage places refresh as an icon-only header action like Orders', () => {
  const source = menuManagementPageSource();

  // Round 165: refresh label comes from translated keys (with English defaultValue fallbacks).
  assert.match(source, /const refreshLabel = loading/);
  assert.match(source, /t\('menu\.refreshingMenu', 'Refreshing menu'\)/);
  assert.match(source, /t\('menu\.refreshMenu', 'Refresh menu'\)/);
  assert.match(source, /className="mb-6 flex items-start justify-between gap-4"/);
  assert.match(source, /aria-label=\{refreshLabel\}/);
  // Round 166 (live QA): native title tooltip removed; aria-label carries the accessible name.
  assert.doesNotMatch(source, /title=\{refreshLabel\}/);
  // Round 233: the refresh button is now a 48x48 icon-centered GLASS button (was a stark white/black
  // square that read like a default admin button). Translucent + backdrop blur + amber accent in both
  // themes -- NOT the old opaque dark-mode bg-white / light-mode bg-black inversion.
  assert.match(source, /inline-flex h-12 w-12 items-center justify-center rounded-2xl/);
  assert.match(source, /backdrop-blur-xl/);
  assert.match(source, /border-amber-400\/30 bg-white\/10 text-amber-300 active:bg-white\/20/);
  assert.match(source, /border-amber-400\/40 bg-black\/5 text-amber-600 active:bg-black\/10/);
  assert.doesNotMatch(source, /border border-white\/80 bg-white text-black/);
  assert.doesNotMatch(source, /border border-black bg-black text-white/);
  // No hover-only styling and no native title on the refresh control; touch active feedback only.
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /title=\{refreshLabel\}/);
  // Round 166: enabled tap transform presses down (active:scale-95), not grows (active:scale-[1.03]).
  assert.match(source, /active:scale-95/);
  assert.doesNotMatch(source, /active:scale-\[1\.03\]/);
  assert.match(source, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);
  assert.match(source, /text-yellow-400/);
  assert.doesNotMatch(source, />\s*Refresh\s*<\/button>/);
  assert.doesNotMatch(source, /px-4 py-2 rounded-lg flex items-center gap-2/);
  assert.doesNotMatch(source, /text-blue-500/);
});

// Round 234 (live QA): the per-card availability toggles (categories / menu items / ingredients /
// offers) were borderless p-2 eye glyphs that read like decoration on a touchscreen. They are now
// explicit ~44x44 glass touch targets with semantic green (enabled) / red (disabled) tints.
test('MenuManagementPage renders availability toggles as 44px semantic glass touch targets', () => {
  const source = menuManagementPageSource();

  // Single shared helper drives all four call-sites (DRY + stable test anchor).
  assert.match(source, /const getAvailabilityToggleClass = \(active: boolean\) =>/);
  assert.match(source, /className=\{getAvailabilityToggleClass\(category\.is_active\)\}/);
  assert.match(source, /className=\{getAvailabilityToggleClass\(item\.is_available\)\}/);
  assert.match(source, /className=\{getAvailabilityToggleClass\(ingredient\.is_available\)\}/);
  assert.match(source, /className=\{getAvailabilityToggleClass\(combo\.is_active\)\}/);

  // 44px, inline-flex centered, rounded glass surface with active press feedback + disabled state.
  assert.match(source, /inline-flex h-11 w-11 items-center justify-center rounded-2xl border backdrop-blur-md/);
  assert.match(source, /disabled:opacity-50 disabled:cursor-not-allowed active:scale-95/);

  // Semantic colors preserved: green = enabled, red = disabled (translucent tinted glass, not text-only).
  assert.match(source, /border-green-500\/40 bg-green-500\/15 text-green-500 active:bg-green-500\/25/);
  assert.match(source, /border-red-500\/40 bg-red-500\/15 text-red-500 active:bg-red-500\/25/);

  // The old tiny borderless p-2 button styling is gone.
  assert.doesNotMatch(source, /p-2 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed/);
  assert.doesNotMatch(source, /text-green-500 active:bg-green-500\/10/);
  assert.doesNotMatch(source, /text-red-500 active:bg-red-500\/10/);

  // Touch-first: no hover-only styling and no native title tooltip on the toggles.
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /\btitle=\{/);

  // Eye / EyeOff icons and the disabled-from-offline behavior are preserved.
  assert.match(source, /\? <Eye className="w-5 h-5" \/> : <EyeOff className="w-5 h-5" \/>/);
  assert.match(source, /disabled=\{toggleAction\.disabled\}/);
});

// Round 235 (live QA): Menu Management -> Offers used to render a bare black grid when there were no
// offers/combos (none synced, or filtered to nothing). It now renders a small centered glass empty
// state that distinguishes no-data from no-search-results, with localized copy in all five locales.
const MENU_LOCALES = ['en', 'el', 'de', 'fr', 'it'];
const loadMenuLocale = (lang: string) =>
  JSON.parse(
    readFileSync(path.join(process.cwd(), 'src', 'locales', `${lang}.json`), 'utf8'),
  );

test('MenuManagementPage renders a localized glass empty state for the offers tab', () => {
  const source = menuManagementPageSource();

  // Empty branch keyed on the filtered list, distinguishing search vs no-search.
  assert.match(source, /if \(filteredCombos\.length === 0\)/);
  assert.match(source, /const isSearching = searchTerm\.trim\(\)\.length > 0/);
  assert.match(source, /data-menu-offers-empty/);

  // Lucide offers/discount icon imported and used (no emoji / custom SVG / ASCII art).
  assert.match(source, /import \{ Eye, EyeOff, Search, RefreshCw, BadgePercent \} from 'lucide-react'/);
  assert.match(source, /<BadgePercent className="w-7 h-7" \/>/);

  // Search-no-results copy + a clear-search button that only resets the search term.
  assert.match(source, /t\('menu\.offersEmpty\.searchTitle', 'No offers match the search'\)/);
  assert.match(source, /t\('menu\.offersEmpty\.searchSubtitle', 'Clear the search or try another term'\)/);
  assert.match(source, /onClick=\{\(\) => setSearchTerm\(''\)\}/);
  assert.match(source, /t\('menu\.offersEmpty\.clearSearch', 'Clear search'\)/);

  // No-data copy (no data-creation action).
  assert.match(source, /t\('menu\.offersEmpty\.title', 'No offers configured'\)/);
  assert.match(source, /t\('menu\.offersEmpty\.subtitle', 'Create offers in the admin dashboard or refresh after syncing\.'\)/);

  // Small centered glass surface (not a giant nested card): centered, rounded, blurred, amber accent.
  const emptyStart = source.indexOf('data-menu-offers-empty');
  const emptyEnd = source.indexOf('filteredCombos.map', emptyStart);
  assert.ok(emptyStart >= 0 && emptyEnd > emptyStart, 'empty-state region must precede the grid');
  const emptyRegion = source.slice(emptyStart, emptyEnd);
  assert.match(emptyRegion, /flex justify-center py-12/);
  assert.match(emptyRegion, /rounded-2xl border px-8 py-10 text-center backdrop-blur-md/);
  assert.match(emptyRegion, /text-amber-300/);
  assert.match(emptyRegion, /active:scale-95/);
  // Touch-first within the empty state: no hover-only styling and no native title tooltip.
  assert.doesNotMatch(emptyRegion, /hover:/);
  assert.doesNotMatch(emptyRegion, /\btitle=/);
});

test('MenuManagementPage offers empty-state keys exist in all five POS locales', () => {
  for (const lang of MENU_LOCALES) {
    const menu = loadMenuLocale(lang).menu;
    assert.ok(menu, `${lang}.json must have a menu namespace`);
    const empty = menu.offersEmpty;
    assert.ok(empty, `${lang}.json must have menu.offersEmpty`);
    for (const key of ['title', 'subtitle', 'searchTitle', 'searchSubtitle', 'clearSearch']) {
      assert.equal(
        typeof empty[key],
        'string',
        `${lang}.json menu.offersEmpty.${key} must be a string`,
      );
      assert.ok(empty[key].trim().length > 0, `${lang}.json menu.offersEmpty.${key} must be non-empty`);
      // No leftover translation placeholders.
      assert.doesNotMatch(empty[key], /NEEDS TRANSLATION/i, `${lang}.json menu.offersEmpty.${key}`);
    }
  }
});

// --- Round 165 — Menu Management localization + touch cleanup contract ---

test('MenuManagementPage localizes tab labels via menu.managementTabs.* keys', () => {
  const source = menuManagementPageSource();

  assert.match(source, /\{t\('menu\.managementTabs\.categories', 'Categories'\)\}/);
  assert.match(source, /\{t\('menu\.managementTabs\.menuItems', 'Menu Items'\)\}/);
  assert.match(source, /\{t\('menu\.managementTabs\.ingredients', 'Ingredients'\)\}/);
  assert.match(source, /\{t\('menu\.managementTabs\.offers', 'Offers'\)\}/);

  // No hardcoded English tab labels rendered as bare JSX button text.
  assert.doesNotMatch(source, />\s*Categories\s*<\/button>/);
  assert.doesNotMatch(source, />\s*Menu Items\s*<\/button>/);
  assert.doesNotMatch(source, />\s*Ingredients\s*<\/button>/);
  assert.doesNotMatch(source, />\s*Offers\s*<\/button>/);
});

test('MenuManagementPage has no hover utilities (touch-first)', () => {
  const source = menuManagementPageSource();

  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /group-hover:/);
});

test('MenuManagementPage renders prices via formatCurrency, with no euro literal or mojibake', () => {
  const source = menuManagementPageSource();

  assert.match(source, /import \{ formatCurrency \} from '\.\.\/utils\/format'/);
  assert.match(source, /formatCurrency\(item\.base_price \|\| 0, 'EUR', language\)/);
  assert.match(source, /formatCurrency\(ingredient\.price, 'EUR', language\)/);
  assert.match(source, /formatCurrency\(combo\.base_price \|\| 0, 'EUR', language\)/);

  // No raw euro glyph (U+20AC), no toFixed currency rendering, no UTF-8-as-cp1252 euro mojibake.
  assert.doesNotMatch(source, /€/);
  assert.doesNotMatch(source, /\.toFixed\(2\)/);
  assert.doesNotMatch(source, /â‚¬/);
});

test('MenuManagementPage localizes status labels and toast fallbacks via menu.* keys', () => {
  const source = menuManagementPageSource();

  assert.match(source, /t\('menu\.unnamed', 'Unnamed'\)/);
  assert.match(source, /t\('menu\.featured', 'Featured'\)/);
  assert.match(source, /t\('menu\.disable', 'Disable'\)/);
  assert.match(source, /t\('menu\.enable', 'Enable'\)/);
  assert.match(source, /t\('menu\.onlineRequired', 'This action requires an online connection\.'\)/);
  assert.match(source, /t\('menu\.failedToLoadData', 'Failed to load data'\)/);
  assert.match(source, /t\('menu\.categoryUpdated', 'Category updated successfully'\)/);
  assert.match(source, /t\('menu\.offerUpdated', 'Offer updated successfully'\)/);
});

// Round 166 (live QA): the native `title` tooltip is hover behaviour on a touchscreen, so it is
// removed from this page's controls; accessible names are provided via aria-label only.
test('MenuManagementPage uses aria-label, not native title tooltips, for icon-button names', () => {
  const source = menuManagementPageSource();

  // No native browser tooltip anywhere on the page.
  assert.doesNotMatch(source, /\btitle=\{/);

  // Refresh icon button keeps its accessible name via aria-label.
  assert.match(source, /aria-label=\{refreshLabel\}/);

  // Each availability/toggle icon button (category / menu item / ingredient / combo) carries an
  // aria-label with the translated disable/enable action (or the offline-disabled message).
  assert.match(source, /aria-label=\{toggleAction\.message \|\| \(category\.is_active \? t\('menu\.disable', 'Disable'\) : t\('menu\.enable', 'Enable'\)\)\}/);
  assert.match(source, /aria-label=\{toggleAction\.message \|\| \(item\.is_available \? t\('menu\.disable', 'Disable'\) : t\('menu\.enable', 'Enable'\)\)\}/);
  assert.match(source, /aria-label=\{toggleAction\.message \|\| \(ingredient\.is_available \? t\('menu\.disable', 'Disable'\) : t\('menu\.enable', 'Enable'\)\)\}/);
  assert.match(source, /aria-label=\{toggleAction\.message \|\| \(combo\.is_active \? t\('menu\.disable', 'Disable'\) : t\('menu\.enable', 'Enable'\)\)\}/);
});
