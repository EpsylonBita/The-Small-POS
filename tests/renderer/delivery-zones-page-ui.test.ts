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
  assert.match(page, /border border-white\/80 bg-white text-black hover:bg-zinc-200/);
  assert.match(page, /border border-black bg-black text-white hover:bg-zinc-800/);
  assert.match(page, /hover:scale-\[1\.03\]/);
  assert.match(page, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);
  assert.doesNotMatch(page, /<h1 className="text-xl font-bold">\{t\('deliveryZones\.title', 'Delivery Zones'\)\}<\/h1>/);
  assert.doesNotMatch(page, /<div className=\{`p-2 rounded-xl[\s\S]*<MapPin className=\{`w-6 h-6/);
  assert.doesNotMatch(page, /h-10 w-10 inline-flex items-center justify-center rounded-xl border/);
});

test('DeliveryZonesPage uses neutral stat icon wrappers with colored icons', () => {
  const page = source();

  assert.match(page, /<CheckCircle className="w-5 h-5 text-green-500" \/>/);
  assert.match(page, /<Activity className="w-5 h-5 text-yellow-400" \/>/);
  assert.match(page, /<Truck className="w-5 h-5 text-blue-500" \/>/);
  assert.match(page, /<Flame className="w-5 h-5 text-red-500" \/>/);
  assert.match(page, /p-2 rounded-lg \$\{isDark \? 'bg-zinc-800' : 'bg-gray-100'\}/);
});

test('DeliveryZonesPage uses text-only status and colored zone-card icons', () => {
  const page = source();

  assert.match(page, /className=\{`text-xs font-semibold \$\{/);
  assert.match(page, /\? 'text-green-500'\s*: isDark \? 'text-zinc-500' : 'text-gray-500'/);
  assert.doesNotMatch(page, /px-2\.5 py-1 text-xs rounded-lg/);
  assert.match(page, /<DollarSign className="w-4 h-4 text-green-500" \/>/);
  assert.match(page, /<Activity className="w-4 h-4 text-yellow-400" \/>/);
  assert.match(page, /<Clock className="w-4 h-4 text-blue-500" \/>/);
  assert.match(page, /<Info className="w-4 h-4 text-red-500 mt-0\.5" \/>/);
  assert.match(page, /<MapPin className="w-5 h-5 text-green-500" \/>/);
  assert.match(page, /<Info className="w-5 h-5 mt-0\.5 text-blue-500" \/>/);
});
