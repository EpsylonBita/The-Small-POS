import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const deliveryZonesPagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'DeliveryZonesPage.tsx');

const source = () => readFileSync(deliveryZonesPagePath, 'utf8');

test('DeliveryZonesPage hides native scrollbars while preserving vertical scroll', () => {
  const page = source();

  assert.match(
    page,
    /h-full overflow-y-auto overflow-x-hidden scrollbar-hide p-4 md:p-5/,
    'delivery zones page should keep vertical scroll but hide the visible native scrollbar',
  );
  assert.doesNotMatch(
    page,
    /h-full overflow-auto p-4 md:p-5/,
    'delivery zones page should avoid generic overflow-auto because it exposes native scrollbars',
  );
});

test('DeliveryZonesPage uses the shared page header treatment', () => {
  const page = source();

  assert.match(
    page,
    /<h1 className="truncate text-3xl font-bold tracking-tight">\{t\('deliveryZones\.title', 'Delivery Zones'\)\}<\/h1>/,
  );
  assert.match(page, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  // Round 259: the refresh button is amber glass with active press feedback (was a stark
  // black/white square with hover utilities).
  assert.match(page, /border border-amber-400\/30 bg-amber-500\/15 text-amber-300 active:bg-amber-500\/25/);
  assert.match(page, /border border-amber-400\/40 bg-amber-50 text-amber-600 active:bg-amber-100/);
  assert.match(page, /active:scale-95/);
  assert.match(page, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);
  assert.doesNotMatch(page, /<h1 className="text-xl font-bold">\{t\('deliveryZones\.title', 'Delivery Zones'\)\}<\/h1>/);
  assert.doesNotMatch(page, /<div className=\{`p-2 rounded-xl[\s\S]*<MapPin className=\{`w-6 h-6/);
  assert.doesNotMatch(page, /h-10 w-10 inline-flex items-center justify-center rounded-xl border/);
});

test('DeliveryZonesPage uses neutral stat icon wrappers with colored icons', () => {
  const page = source();

  assert.match(page, /<CheckCircle className="w-5 h-5 text-green-500" \/>/);
  assert.match(page, /<Activity className="w-5 h-5 text-yellow-400" \/>/);
  assert.match(page, /<Truck className="w-5 h-5 text-emerald-500" \/>/);
  assert.match(page, /<Flame className="w-5 h-5 text-red-500" \/>/);
  assert.match(page, /p-2 rounded-2xl \$\{isDark \? 'bg-zinc-800' : 'bg-gray-100'\}/);
  assert.doesNotMatch(page, /rounded-lg/);
});

test('DeliveryZonesPage uses text-only status and colored zone-card icons', () => {
  const page = source();

  assert.match(page, /className=\{`text-xs font-semibold \$\{/);
  assert.match(page, /\? 'text-green-500'\s*: isDark \? 'text-zinc-500' : 'text-gray-500'/);
  assert.doesNotMatch(page, /px-2\.5 py-1 text-xs rounded-lg/);
  assert.match(page, /<DollarSign className="w-4 h-4 text-green-500" \/>/);
  assert.match(page, /<Activity className="w-4 h-4 text-yellow-400" \/>/);
  assert.match(page, /<Clock className="w-4 h-4 text-amber-500" \/>/);
  assert.match(page, /<Info className="w-4 h-4 text-red-500 mt-0\.5" \/>/);
  assert.match(page, /<MapPin className="w-5 h-5 text-green-500" \/>/);
  assert.match(page, /<Info className="w-5 h-5 mt-0\.5 text-zinc-400" \/>/);
});

// --- Round 259 (live QA, 1282x802 Greek/dark): the VISIBLE Delivery Pro route renders
// DeliveryZonesPage ("Ζώνες Διανομής"), not DeliveryPage (Round 148 stays blocked). The header refresh
// button was a stark black/white square carrying a native title= that duplicated the accessible
// description in the live tree ("button Ανανέωση  Description: Ανανέωση"). It is now amber glass with an
// aria-label only, no native title, and no hover-only utilities — matching the SuppliersPage Round 257
// refresh. The semantic stat/zone icon colors (emerald/amber/zinc, plus green/yellow/red) are current. ---

test('Round 259: DeliveryZonesPage refresh is amber glass, aria-label only, no native title, no hover', () => {
  const page = source();
  // Amber glass in both themes (matches Suppliers Round 257).
  assert.match(page, /border border-amber-400\/30 bg-amber-500\/15 text-amber-300 active:bg-amber-500\/25/);
  assert.match(page, /border border-amber-400\/40 bg-amber-50 text-amber-600 active:bg-amber-100/);
  // The stark black/white square is gone.
  assert.doesNotMatch(page, /bg-white text-black/);
  assert.doesNotMatch(page, /bg-black text-white/);
  // Accessible name via aria-label only; the native title= that duplicated the description is gone.
  assert.match(page, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.doesNotMatch(page, /\btitle=/);
  // Touch-first: no hover / dark:hover / group-hover anywhere on the page.
  assert.doesNotMatch(page, /hover:/);
  // Behaviour/shape preserved: same handler, 44px square, spinner, active feedback, neutral disabled.
  assert.match(page, /onClick=\{\(\) => void fetchData\(\)\}/);
  assert.match(page, /h-12 w-12/);
  assert.match(page, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);
  assert.match(page, /loading \? 'opacity-60 cursor-not-allowed' : 'active:scale-95'/);
});

test('Round 259: DeliveryZonesPage semantic icon colors are current (no stale blue)', () => {
  const page = source();
  // Stat row: success-rate Truck = emerald, estimated-time Clock = amber, bottom info = neutral zinc.
  assert.match(page, /<Truck className="w-5 h-5 text-emerald-500" \/>/);
  assert.match(page, /<Clock className="w-4 h-4 text-amber-500" \/>/);
  assert.match(page, /<Info className="w-5 h-5 mt-0\.5 text-zinc-400" \/>/);
  // The other semantic colors stay alive: green active/success, yellow validations, red hotspots.
  assert.match(page, /<CheckCircle className="w-5 h-5 text-green-500" \/>/);
  assert.match(page, /<Activity className="w-5 h-5 text-yellow-400" \/>/);
  assert.match(page, /<Flame className="w-5 h-5 text-red-500" \/>/);
  // No stale blue icon classes survive anywhere on this page.
  assert.doesNotMatch(page, /text-blue-500/);
});
