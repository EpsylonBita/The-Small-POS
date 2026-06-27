import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
// orderNumberUtils is a leaf module (no imports), so the explicit .ts extension
// keeps this test runnable under a direct `node --test`.
import {
  formatCompactOrderNumberForDisplay,
  isBusinessOrderNumber,
  resolveMergedOrderNumber,
} from '../../src/renderer/utils/orderNumberUtils.ts';

const ordersPageSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'pages', 'OrdersPage.tsx'),
    'utf8',
  );

const tablesPageSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'pages', 'TablesPage.tsx'),
    'utf8',
  );

const newOrderPageSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'pages', 'NewOrderPage.tsx'),
    'utf8',
  );

const orderDashboardSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderDashboard.tsx'),
    'utf8',
  );

const orderFlowSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderFlow.tsx'),
    'utf8',
  );

const foodDashboardSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'dashboards', 'FoodDashboard.tsx'),
    'utf8',
  );

const orderGridSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderGrid.tsx'),
    'utf8',
  );

const orderCardSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'order', 'OrderCard.tsx'),
    'utf8',
  );

const mainLayoutSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'RefactoredMainLayout.tsx'),
    'utf8',
  );

const contentContainerSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'ui', 'ContentContainer.tsx'),
    'utf8',
  );

const tablesDashboardSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'tables', 'TablesDashboard.tsx'),
    'utf8',
  );

const tableFloorPlanSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'tables', 'TableFloorPlanView.tsx'),
    'utf8',
  );

const orderTabsBarSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderTabsBar.tsx'),
    'utf8',
  );

const globalsSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'styles', 'globals.css'),
    'utf8',
  );

const glassmorphismSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'styles', 'glassmorphism.css'),
    'utf8',
  );

const tableCheckManagerSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'tables', 'TableCheckManagerModal.tsx'),
    'utf8',
  );

const tableActionModalSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'tables', 'TableActionModal.tsx'),
    'utf8',
  );

const floatingActionButtonSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'ui', 'FloatingActionButton.tsx'),
    'utf8',
  );

test('OrdersPage hides the orders-list scrollbar without disabling scroll', () => {
  const source = ordersPageSource();

  assert.match(
    source,
    /flex-1 overflow-y-auto scrollbar-hide p-6/,
    'orders list should keep vertical scrolling and hide the visible scrollbar',
  );
});

test('OrdersPage refresh action is an accessible icon-only inverted theme button', () => {
  const source = ordersPageSource();

  assert.match(source, /aria-label=\{refreshLabel\}/);
  // Round 182 (touch-first): the refresh button no longer carries a native title tooltip.
  assert.doesNotMatch(source, /title=\{refreshLabel\}/);
  assert.match(source, /h-12 w-12/);
  assert.match(source, /bg-white text-black/);
  assert.match(source, /bg-black text-white/);
  assert.doesNotMatch(source, /\{syncing \? 'Syncing\.\.\.' : 'Refresh'\}/);
});

test('OrdersPage uses neutral header chrome and compact order numbers', () => {
  const source = ordersPageSource();

  assert.match(source, /formatCompactOrderNumberForDisplay/);
  assert.match(source, /const displayOrderNumber = getDisplayOrderNumber\(order\);/);
  assert.match(source, /<span className="font-mono font-bold text-lg">\{displayOrderNumber\}<\/span>/);
  assert.match(source, /<div className=\{isDark \? 'bg-black' : 'bg-\[#fffaf1\]'\}>/);
  assert.doesNotMatch(source, /bg-gradient-to-br from-zinc-950 via-slate-950 to-zinc-900/);
  assert.doesNotMatch(source, /<div className=\{`border-b/);
  assert.doesNotMatch(source, /#\{order\.order_number\}/);
});

const REMOTE_INTERNAL_ORDER_NUMBER = 'ORD-20260621-7ce29a007ce29a007ce29a007ce29a00'; // ORD-YYYYMMDD-<32 hex>

test('isBusinessOrderNumber separates business numbers from internal id/hash fallbacks', () => {
  assert.equal(isBusinessOrderNumber('ORD-21062026-00013'), true);
  assert.equal(isBusinessOrderNumber('ORD-20260517-00002'), true);
  assert.equal(isBusinessOrderNumber('K-0002'), true);
  assert.equal(isBusinessOrderNumber('K-d28cef2e-20260610-060003-0001'), true);
  // Internal: a uuid-tail order number and a bare id slice are NOT business numbers.
  assert.equal(isBusinessOrderNumber(REMOTE_INTERNAL_ORDER_NUMBER), false);
  assert.equal(isBusinessOrderNumber('7ce29a12'), false); // id.slice(0, 8)
  assert.equal(isBusinessOrderNumber(''), false);
  assert.equal(isBusinessOrderNumber(null), false);
});

test('a local business order number survives a merge/refresh with a remote internal id (ORD #00013)', () => {
  const local = 'ORD-21062026-00013';
  // The remote row for the same order brings an internal ORD-YYYYMMDD-<uuid> value.
  const kept = resolveMergedOrderNumber(local, REMOTE_INTERNAL_ORDER_NUMBER);
  assert.equal(kept, local, 'remote internal id must not overwrite the local business number');
  // And it still renders the staff-facing compact number, not the internal hash.
  assert.equal(formatCompactOrderNumberForDisplay(kept), 'ORD #00013');
});

test('resolveMergedOrderNumber never promotes an id/hash internal when a business number exists', () => {
  const business = 'ORD-21062026-00013';
  // Business existing is kept over internal incoming (uuid-tail or id slice).
  assert.equal(resolveMergedOrderNumber(business, REMOTE_INTERNAL_ORDER_NUMBER), business);
  assert.equal(resolveMergedOrderNumber(business, '7ce29a12'), business);
  // A real incoming business number still wins when existing was an internal fallback.
  assert.equal(resolveMergedOrderNumber('7ce29a12', business), business);
  // Two business numbers: the incoming (fresher remote) value wins.
  assert.equal(resolveMergedOrderNumber(business, 'ORD-21062026-00014'), 'ORD-21062026-00014');
  // Neither is a business number: present incoming wins, else fall back to existing.
  assert.equal(resolveMergedOrderNumber('7ce29a12', 'd4f5a6b7'), 'd4f5a6b7');
  assert.equal(resolveMergedOrderNumber('7ce29a12', ''), '7ce29a12');
});

test('OrdersPage prefers a visible business order number and preserves it across hydration', () => {
  const source = ordersPageSource();
  // normalizeOrder prefers display_order_number/displayOrderNumber before order_number/id slice.
  assert.match(
    source,
    /asString\(raw\.display_order_number\)[\s\S]*?asString\(raw\.displayOrderNumber\)[\s\S]*?asString\(raw\.order_number\)[\s\S]*?id\.slice\(0, 8\)/,
  );
  // The merge keeps the business number instead of blindly spreading the remote one.
  assert.match(source, /order_number: resolveMergedOrderNumber\(existing\.order_number, incoming\.order_number\)/);
  // The compact display passes created_at so a truly-internal order shows a time, not a fake hash #.
  assert.match(source, /formatCompactOrderNumberForDisplay\(order\.order_number, order\.created_at\)/);
});

test('OrdersPage keeps the filter toggle inside the search bar', () => {
  const source = ordersPageSource();

  assert.match(
    source,
    /<input[\s\S]*<button\s+type="button"\s+onClick=\{\(\) => setShowFilters\(!showFilters\)\}[\s\S]*aria-label=\{filterLabel\}[\s\S]*<Filter className="w-5 h-5" \/>/,
    'filter toggle should render as an icon-only action at the right side of the search control',
  );
  assert.match(source, /const filterLabel = showFilters[\s\S]*orders\.hideFilters[\s\S]*orders\.showFilters/);
  assert.doesNotMatch(source, /\{\/\* Filter Toggle \*\/\}/);
  assert.doesNotMatch(source, /flex items-center gap-2 px-4 py-2\.5 rounded-xl text-sm border/);
  assert.doesNotMatch(source, /\{showFilters \? 'Hide Filters' : 'Show Filters'\}/);
  assert.doesNotMatch(source, /rounded-lg border px-3 text-sm font-semibold/);
});

test('Round 432: OrdersPage filter fields and pagination arrows use smooth touch radii', () => {
  const source = ordersPageSource();

  const roundedFilterFields =
    source.match(/w-full px-3 py-2 rounded-2xl text-sm border/g) || [];
  assert.ok(roundedFilterFields.length >= 3, `expected at least 3 rounded filter fields, found ${roundedFilterFields.length}`);
  assert.match(source, /className=\{`px-3 py-2 rounded-2xl border \$\{currentPage === 1/);
  assert.match(source, /className=\{`px-3 py-2 rounded-2xl border \$\{currentPage === totalPages/);
  assert.doesNotMatch(source, /rounded-lg/);
});

test('OrdersPage search clear button exposes a localized accessible name', () => {
  const source = ordersPageSource();

  // The label is derived once from a localized key (English fallback only).
  assert.match(source, /const clearSearchLabel = t\('orders\.clearSearch', \{ defaultValue: 'Clear search' \}\);/);
  // The icon-only clear control must carry an explicit accessible name (aria-label, no native
  // title tooltip) and stay a real button so it remains keyboard/click usable.
  assert.match(
    source,
    /<button\s+type="button"\s+onClick=\{\(\) => setSearchTerm\(''\)\}\s+aria-label=\{clearSearchLabel\}/,
    'the clear-search button must have a localized aria-label',
  );
  // The original unlabeled icon-only button (rendered as a blank "button" in the
  // a11y tree) must be gone.
  assert.doesNotMatch(
    source,
    /<button onClick=\{\(\) => setSearchTerm\(''\)\} className=/,
    'the clear-search button must not be an unlabeled icon-only control',
  );
});

test('OrdersPage filter controls have explicit localized accessible labels', () => {
  const source = ordersPageSource();

  // Each native control name comes from the same localized key its visible label uses.
  assert.match(source, /const statusFilterLabel = t\('orders\.filters\.status', \{ defaultValue: 'Status' \}\);/);
  assert.match(source, /const orderTypeFilterLabel = t\('orders\.filters\.orderType', \{ defaultValue: 'Order Type' \}\);/);
  assert.match(source, /const dateFromFilterLabel = t\('orders\.filters\.dateFrom', \{ defaultValue: 'Date From' \}\);/);

  // Status select, order-type select, and date input each get an explicit aria-label (no native
  // title tooltip) so none of them are exposed as blank/ambiguous controls.
  assert.match(
    source,
    /value=\{statusFilter\}[\s\S]*?aria-label=\{statusFilterLabel\}/,
    'the status select must expose the localized Status label',
  );
  assert.match(
    source,
    /value=\{orderTypeFilter\}[\s\S]*?aria-label=\{orderTypeFilterLabel\}/,
    'the order-type select must expose the localized Order Type label',
  );
  assert.match(
    source,
    /type="date"[\s\S]*?aria-label=\{dateFromFilterLabel\}/,
    'the date input must expose the localized Date From label',
  );
});

// Round 182 (touch-first, live QA): native title= tooltips are hover-dependent and must not exist on
// the touchscreen OrdersPage (the refresh button surfaced as "... Description: ..." in accessibility).
// Accessible names come from aria-label only. Scoped to OrdersPage source -- the unrelated TablesPage
// title assertions elsewhere in this file read a different source and are left intact.
test('OrdersPage has no native title tooltips; the six controls keep aria-label only', () => {
  const source = ordersPageSource();

  // No native DOM title attribute anywhere in OrdersPage.
  assert.doesNotMatch(source, /\btitle=/);

  // The six controls keep their accessible names via aria-label.
  assert.match(source, /aria-label=\{refreshLabel\}/);
  assert.match(source, /aria-label=\{clearSearchLabel\}/);
  assert.match(source, /aria-label=\{filterLabel\}/);
  assert.match(source, /aria-label=\{statusFilterLabel\}/);
  assert.match(source, /aria-label=\{orderTypeFilterLabel\}/);
  assert.match(source, /aria-label=\{dateFromFilterLabel\}/);
});

test('orders.clearSearch accessible label is localized in every POS locale', () => {
  const localesDir = path.join(process.cwd(), 'src', 'locales');
  const loadLocale = (lng: string): Record<string, any> =>
    JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

  const en = loadLocale('en').orders.clearSearch;
  assert.equal(typeof en, 'string', 'en missing orders.clearSearch');

  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const value = loadLocale(lng).orders?.clearSearch;
    assert.equal(typeof value, 'string', `${lng} missing orders.clearSearch`);
    assert.ok(value.length > 0, `${lng} empty orders.clearSearch`);
  }
  // Greek + de/fr/it must be real translations, not the English fallback (an
  // invisible leak that source-key parity alone cannot catch).
  for (const lng of ['el', 'de', 'fr', 'it']) {
    assert.notEqual(
      loadLocale(lng).orders.clearSearch,
      en,
      `${lng} orders.clearSearch must be a real translation, not English`,
    );
  }
});

test('OrdersPage renders row chips without wrappers and uses yellow metadata icons', () => {
  const source = ordersPageSource();

  // Round 220 (+ live-QA correction): the row status label is a compact but STRONG semantic PILL
  // (rounded-full, bordered, px-3 py-1.5, text-[13px] leading-none font-bold whitespace-nowrap), driven by
  // getOrderStatusPillClasses -- not the old loose `text-xs font-semibold` text, and not the first quiet
  // `px-2.5 py-1 text-xs` pill.
  assert.match(source, /getOrderStatusPillClasses/);
  assert.match(
    source,
    /<span className=\{`inline-flex items-center justify-center rounded-full border px-3 py-1\.5 text-\[13px\] leading-none font-bold whitespace-nowrap \$\{getOrderStatusPillClasses\(order\.status\)\}`\}>/,
  );
  assert.doesNotMatch(source, /getOrderStatusTextClasses/);
  assert.doesNotMatch(source, /<span className=\{`text-xs font-semibold \$\{getOrderStatus\w+\(order\.status\)\}`\}>/);
  // The first too-quiet pill treatment is gone.
  assert.doesNotMatch(source, /px-2\.5 py-1 text-xs font-semibold \$\{getOrderStatusPillClasses/);
  assert.match(source, /\{getOrderStatusLabel\(order\.status\)\}/);
  assert.match(source, /\{getOrderTypeLabel\(order\.order_type\)\}/);
  assert.match(source, /flex items-center gap-1 text-xs font-medium/);
  assert.match(source, /<User className=\{`w-4 h-4 \$\{isDark \? 'text-yellow-300' : 'text-yellow-600'\}`\} \/>/);
  assert.match(source, /<Phone className=\{`w-4 h-4 \$\{isDark \? 'text-yellow-300' : 'text-yellow-600'\}`\} \/>/);
  assert.match(source, /<Package className=\{`w-4 h-4 \$\{isDark \? 'text-yellow-300' : 'text-yellow-600'\}`\} \/>/);
  assert.doesNotMatch(source, /getOrderStatusBadgeClasses/);
  assert.doesNotMatch(source, /\{\s*order\.status\s*\}/);
  assert.doesNotMatch(source, /<span>\{order\.order_type\}<\/span>/);
  assert.doesNotMatch(source, /px-2 py-1 rounded-full text-xs font-medium \$\{getStatusBadge\(order\.status\)\}/);
  assert.doesNotMatch(source, /flex items-center gap-1 px-2 py-1 rounded-full text-xs/);
  assert.doesNotMatch(source, /<User className="w-4 h-4 opacity-50" \/>/);
  assert.doesNotMatch(source, /<Phone className="w-4 h-4 opacity-50" \/>/);
  assert.doesNotMatch(source, /<Package className="w-4 h-4 opacity-50" \/>/);
});

// Round 220 (+ live-QA correction): the row status label is a compact but STRONG semantic pill so it
// reads clearly at 1282x802 without bloating the row. The pill span carries the stronger treatment
// (px-3 py-1.5 text-[13px] leading-none font-bold whitespace-nowrap, no hover/active), and the per-status
// skins in ORDER_STATUS_PILL_CLASSES must each be readable in light + dark with completed grey NOT faded.
test('OrdersPage status pill uses the strong compact treatment and readable light+dark semantic skins, no hover', () => {
  const source = ordersPageSource();

  // --- The pill span treatment (sliced from the getOrderStatusPillClasses usage) ---
  const pillIdx = source.indexOf('${getOrderStatusPillClasses(order.status)}');
  assert.notEqual(pillIdx, -1, 'status pill span must use getOrderStatusPillClasses');
  const pillStart = source.lastIndexOf('<span', pillIdx);
  assert.notEqual(pillStart, -1, 'status pill <span> must exist');
  const pillEnd = source.indexOf('>', pillIdx);
  const pill = source.slice(pillStart, pillEnd + 1);

  // Stronger, still-compact sizing/weight; single line so long localized labels never wrap.
  assert.match(pill, /px-3/);
  assert.match(pill, /py-1\.5/);
  assert.match(pill, /text-\[13px\]/);
  assert.match(pill, /leading-none/);
  assert.match(pill, /font-bold/);
  assert.match(pill, /whitespace-nowrap/);
  assert.match(pill, /rounded-full/);
  assert.match(pill, /\bborder\b/);
  // Informational pill: no hover and no press/active feedback on it.
  assert.doesNotMatch(pill, /hover:/);
  assert.doesNotMatch(pill, /active:/);
  // The earlier quiet treatment is gone.
  assert.doesNotMatch(pill, /text-xs/);
  assert.doesNotMatch(pill, /font-semibold/);

  // --- The per-status skins ---
  const mapStart = source.indexOf('const ORDER_STATUS_PILL_CLASSES');
  assert.notEqual(mapStart, -1, 'ORDER_STATUS_PILL_CLASSES map must exist');
  const mapEnd = source.indexOf('};', mapStart);
  assert.notEqual(mapEnd, -1, 'ORDER_STATUS_PILL_CLASSES map must close');
  const map = source.slice(mapStart, mapEnd);

  // Every supervisor-listed status has its own skin: a light background, a border colour, and a dark:
  // variant so it is readable in both themes.
  for (const status of ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled', 'out_for_delivery']) {
    const line = map.split('\n').find((l) => new RegExp(`^\\s*${status}:`).test(l));
    assert.ok(line, `pill map must define a skin for ${status}`);
    assert.match(line, /bg-[a-z]+-\d{2,3}/, `${status} pill needs a light background`);
    assert.match(line, /border-/, `${status} pill needs a border colour`);
    assert.match(line, /dark:/, `${status} pill needs a dark variant`);
  }

  // Completed/delivered grey must read as solid/done, not the old faded `gray-100 text-gray-600` skin
  // (which looked disabled on the live screen).
  assert.doesNotMatch(map, /completed: 'bg-gray-100 text-gray-600/);
  assert.doesNotMatch(map, /delivered: 'bg-gray-100 text-gray-600/);

  // No hover utilities anywhere in the pill skins (informational, not an action).
  assert.doesNotMatch(map, /hover:/);
  // Round 423: the Orders page uses the current POS palette for status skins; blue/cyan/purple
  // were old web-dashboard accents and should not return here.
  assert.doesNotMatch(map, /\b(?:bg|text|border)-(?:blue|cyan|purple)-/);
  assert.match(map, /confirmed: 'bg-yellow-200 text-yellow-950 border-yellow-300/);
  assert.match(map, /out_for_delivery: 'bg-amber-300 text-amber-950 border-amber-400/);
  assert.match(map, /preparing: 'bg-zinc-200 text-zinc-900 border-zinc-300/);

  // Unknown statuses fall back to the yellow/amber pending skin (the app-palette base).
  assert.match(source, /ORDER_STATUS_PILL_CLASSES\[normalized\] \|\| ORDER_STATUS_PILL_CLASSES\.pending/);
});

test('Round 423: OrdersPage loading spinner is yellow, not legacy blue/cyan', () => {
  const source = ordersPageSource();

  assert.match(
    source,
    /<RefreshCw className=\{`w-12 h-12 animate-spin mx-auto mb-4 \$\{isDark \? 'text-yellow-300' : 'text-yellow-600'\}`\} \/>/,
  );
  assert.doesNotMatch(source, /text-cyan-500|text-blue-500/);
});

// Round 181 → 216 → 217b (pickup row icon consistency, founder screenshot): the Orders-list ORDER-TYPE
// icon must use the shared PickupOrderIcon for pickup/takeaway -- and, like the order-type chooser, as a
// PLAIN bag silhouette at row scale (w-6 h-6, matching the delivery/table siblings). The earlier green
// rounded badge/holder (h-7 w-7 bg-green-600 chip wrapping a white bag) is gone: it read as a separate
// boxed treatment. A semantic green stroke (light text-green-600 / dark text-green-400) keeps the bag
// readable on the cream and dark rows. Never a Package/Store/storefront glyph or a raw ShoppingBag for
// the order-type icon. The items-count <Package> + empty-state <ShoppingBag> live elsewhere, so this
// guard is scoped to the pickupRowIcon definition + getOrderTypeIcon switch body.
test('OrdersPage pickup/default row order-type icon is the shared plain bag at row scale, no green badge', () => {
  const source = ordersPageSource();

  // Shared chooser icon is imported and rendered in the row via getOrderTypeIcon.
  assert.match(source, /import PickupOrderIcon from '\.\.\/components\/icons\/PickupOrderIcon';/);
  assert.match(source, /\{getOrderTypeIcon\(order\.order_type\)\}/);

  // Scope to the pickupRowIcon definition + the getOrderTypeIcon switch body so the assertions do not
  // collide with the legitimate items-count <Package> or the empty-state <ShoppingBag> elsewhere.
  const start = source.indexOf('const pickupRowIcon = (');
  assert.notEqual(start, -1, 'pickupRowIcon must exist');
  const end = source.indexOf('};', source.indexOf('const getOrderTypeIcon = (type: string) =>'));
  assert.notEqual(end, -1, 'getOrderTypeIcon must close');
  const iconFn = source.slice(start, end);

  // The pickup row icon is the shared PickupOrderIcon rendered as a plain bag at row scale (w-6 h-6,
  // matching the sibling delivery/table icons) with a theme-aware semantic green stroke and no wrapper.
  assert.match(
    iconFn,
    /<PickupOrderIcon\s+className=\{`w-6 h-6 \$\{isDark \? 'text-green-400' : 'text-green-600'\}`\}\s+strokeWidth=\{2\}\s*\/>/,
  );
  // The boxed green badge/holder treatment must be gone: no green chip wrapping the bag, and the bag is
  // never forced white-on-green any more.
  assert.doesNotMatch(iconFn, /bg-green-600/);
  assert.doesNotMatch(iconFn, /rounded-\[10px\]/);
  assert.doesNotMatch(iconFn, /text-white/);

  // Pickup + the default fall-through reuse that plain bag; delivery/table keep their icons unchanged.
  assert.match(iconFn, /case 'pickup': return pickupRowIcon;/);
  assert.match(iconFn, /default: return pickupRowIcon;/);
  assert.match(iconFn, /case 'delivery': return <Truck className="w-6 h-6" \/>;/);
  assert.match(iconFn, /case 'dine-in': return <TableOrderIcon className="w-6 h-6" \/>;/);

  // The order-type icon path must NOT use a Package/Store/storefront glyph or a raw ShoppingBag for
  // pickup/takeaway (the bag always goes through the shared PickupOrderIcon wrapper).
  assert.doesNotMatch(iconFn, /Package/);
  assert.doesNotMatch(iconFn, /\bStore\b/);
  assert.doesNotMatch(iconFn, /<ShoppingBag/);
});

// Round 213 → 218 (founder screenshot, supervisor review): the live Dashboard order-ROW pickup icon
// lives in components/order/OrderCard.tsx (NOT OrdersPage.tsx). Round 213 boxed it in a green badge;
// the supervisor confirmed on the live Dashboard row that the filled green chip still reads as a
// separate boxed treatment apart from the unboxed delivery/table siblings. It must now match the
// standalone OrdersPage row (round 218): the shared PickupOrderIcon rendered as a PLAIN bag at row
// scale (w-6 h-6) with a theme-aware semantic green stroke and no holder. The shared glyph is preserved
// (no raw ShoppingBag, no Store/Package/storefront), with delivery + table icons unchanged.
test('OrderCard pickup row icon is the shared plain bag at row scale, no green badge (matches OrdersPage)', () => {
  const source = orderCardSource();

  // Shared chooser icons are imported (same bag/table source the chooser modal uses).
  assert.match(source, /import PickupOrderIcon from '\.\.\/icons\/PickupOrderIcon';/);
  assert.match(source, /import TableOrderIcon from '\.\.\/icons\/TableOrderIcon';/);

  // Scope to the OrderTypeIcon body so the assertions target the order-type icon, not unrelated UI.
  const start = source.indexOf('const OrderTypeIcon = ({ orderType }');
  assert.notEqual(start, -1, 'OrderTypeIcon must exist');
  const end = source.indexOf('\n  };', start);
  assert.notEqual(end, -1, 'OrderTypeIcon must close');
  const iconFn = source.slice(start, end);

  // Pickup/default branch: the shared PickupOrderIcon as a PLAIN bag at row scale (w-6 h-6, matching the
  // sibling delivery/table icons) with a theme-aware semantic green stroke (light text-green-600 / dark
  // text-green-400) and stroke weight 2 -- no wrapper.
  assert.match(
    iconFn,
    /<PickupOrderIcon\s+className=\{`w-6 h-6 \$\{resolvedTheme === 'light' \? 'text-green-600' : 'text-green-400'\}`\}\s+strokeWidth=\{2\}\s*\/>/,
  );
  // The boxed green badge/holder treatment (round 213) must be gone: no green chip wrapping the bag, and
  // the bag is never forced white-on-green any more.
  assert.doesNotMatch(iconFn, /bg-green-600/);
  assert.doesNotMatch(iconFn, /rounded-\[10px\]/);
  assert.doesNotMatch(iconFn, /text-white/);

  // Never a Store/Package/storefront glyph, and never a separate direct lucide ShoppingBag render
  // (pickup must go through the shared PickupOrderIcon wrapper). Scoped to JSX elements so a prose
  // mention of "lucide ShoppingBag" in a comment does not false-match.
  assert.doesNotMatch(iconFn, /<Store|<Package|<Storefront/);
  assert.doesNotMatch(iconFn, /<ShoppingBag/);

  // Delivery + table icons unchanged: orange delivery truck stroke + the table icon's own treatment.
  assert.match(iconFn, /stroke="#d97706"/);
  assert.match(
    iconFn,
    /<TableOrderIcon\s+className=\{`w-6 h-6 \$\{resolvedTheme === 'light' \? 'text-gray-700' : 'text-gray-300'\}`\}\s+strokeWidth=\{1\.6\}\s*\/>/,
  );

  // No native title tooltip / hover utilities introduced in the icon path.
  assert.doesNotMatch(iconFn, /\btitle=/);
  assert.doesNotMatch(iconFn, /hover:/);
});

// Round 221 (live QA, multilingual polish): the raw slug "room_service" leaked as an order-type label in
// the Greek UI. OrdersPage must localize room_service / room-service / room service to
// orders.type.roomService (one key via the ZReportModal slug-collapse idea) and give it a dedicated room
// icon (lucide Bed) -- never the pickup bag. Every POS locale must define orders.type.roomService with a
// real translation (Greek must be Greek, not the raw slug or the English label).
test('OrdersPage localizes room_service order type and gives it a Bed icon, never the pickup bag', () => {
  const source = ordersPageSource();
  const localesDir = path.join(process.cwd(), 'src', 'locales');
  const loadLocale = (lng: string): Record<string, any> =>
    JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

  // The Bed icon is imported from lucide.
  const lucideImport = source.slice(0, source.indexOf("} from 'lucide-react'"));
  assert.match(lucideImport, /\bBed\b/);

  // --- Label: separators are collapsed and room_service resolves to the roomService key ---
  const labelStart = source.indexOf('const getOrderTypeLabel = useCallback');
  assert.notEqual(labelStart, -1, 'getOrderTypeLabel must exist');
  const labelEnd = source.indexOf('}, [t]);', labelStart);
  assert.notEqual(labelEnd, -1, 'getOrderTypeLabel must close');
  const labelFn = source.slice(labelStart, labelEnd);
  assert.ok(labelFn.includes("replace(/[\\s_-]+/g, '_')"), 'label must collapse -/_/space separators');
  assert.ok(labelFn.includes("collapsed === 'room_service' ? 'roomService'"), 'room_service maps to roomService key');
  assert.match(labelFn, /t\(`orders\.type\.\$\{key\}`/);

  // --- Icon: a dedicated room-service branch resolves to <Bed>, ahead of the pickup fallthrough ---
  const iconStart = source.indexOf('const getOrderTypeIcon = (type: string) =>');
  assert.notEqual(iconStart, -1, 'getOrderTypeIcon must exist');
  const iconEnd = source.indexOf('\n  };', iconStart);
  assert.notEqual(iconEnd, -1, 'getOrderTypeIcon must close');
  const iconFn = source.slice(iconStart, iconEnd);
  assert.ok(iconFn.includes("collapsed === 'room_service'"), 'icon must match room_service via the collapsed slug');
  assert.match(iconFn, /<Bed className="w-6 h-6" \/>/);
  // The room-service branch must come before the switch's pickup default, so it never falls back to the bag.
  assert.ok(
    iconFn.indexOf("collapsed === 'room_service'") < iconFn.indexOf('default: return pickupRowIcon;'),
    'room_service icon branch must resolve before the pickup default',
  );
  // Delivery / pickup / dine-in icons are unchanged (round 218 preserved).
  assert.match(iconFn, /case 'delivery': return <Truck className="w-6 h-6" \/>;/);
  assert.match(iconFn, /case 'pickup': return pickupRowIcon;/);
  assert.match(iconFn, /case 'dine-in': return <TableOrderIcon className="w-6 h-6" \/>;/);

  // --- Locales: every POS locale defines orders.type.roomService; Greek is a real translation ---
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const val = loadLocale(lng).orders.type.roomService;
    assert.equal(typeof val, 'string', `${lng} orders.type.roomService must be a string`);
    assert.ok(val.trim().length > 0, `${lng} orders.type.roomService must be non-empty`);
    assert.doesNotMatch(val, /room[_-]service/i, `${lng} roomService must not be the raw slug`);
  }
  const elRoom = loadLocale('el').orders.type.roomService;
  assert.match(elRoom, new RegExp('[\\u0370-\\u03FF]'), 'Greek orders.type.roomService must contain Greek letters');
  assert.notEqual(
    elRoom,
    loadLocale('en').orders.type.roomService,
    'Greek orders.type.roomService must not equal the English label',
  );
});

test('OrdersPage localizes list chrome, filters, status labels, and pagination', () => {
  const source = ordersPageSource();

  for (const key of [
    'orders.loadingOrders',
    'orders.ordersTotal',
    'orders.refreshOrders',
    'orders.syncingOrders',
    'orders.searchPlaceholder',
    'orders.filters.status',
    'orders.filters.orderType',
    'orders.filters.allStatuses',
    'orders.filters.allTypes',
    'orders.filters.dateFrom',
    'orders.filters.clearAll',
    'orders.itemsCount',
    'orders.emptyTitle',
    'orders.emptyDescription',
    'orders.pageOf',
    'orders.pagination.previous',
    'orders.pagination.next',
  ]) {
    assert.match(source, new RegExp(key.replace('.', '\\.')));
  }

  assert.match(source, /const getOrderStatusLabel = useCallback/);
  assert.match(source, /t\(`orders\.status\.\$\{normalized\}`/);
  assert.match(source, /const getOrderTypeLabel = useCallback/);
  // Round 221: getOrderTypeLabel collapses separators and maps dine_in -> dineIn and
  // room_service -> roomService (the room_service mapping is asserted in depth by its own guard above).
  assert.match(source, /collapsed === 'dine_in' \? 'dineIn'/);
  assert.match(source, /collapsed === 'room_service' \? 'roomService'/);
  assert.doesNotMatch(source, />Loading orders\.\.\.<\/p>/);
  assert.doesNotMatch(source, /placeholder="Search by order number, customer name, or phone\.\.\."/);
  assert.doesNotMatch(source, />Status<\/label>/);
  assert.doesNotMatch(source, />Order Type<\/label>/);
  assert.doesNotMatch(source, />All Statuses<\/option>/);
  assert.doesNotMatch(source, />All Types<\/option>/);
  assert.doesNotMatch(source, />No Orders Found<\/h3>/);
  assert.doesNotMatch(source, /Page \{currentPage\} of \{totalPages\}/);
});

// Round 219 (touch UX, supervisor design QA): the filters-panel "Clear all filters" control used to be a
// naked text button (mt-2 text-sm) that read as small loose text ("Καθαρισμός όλων των φίλτρων" in Greek)
// and was an unreliable touch target. It must be a real ~44px button: type=button, inline-flex with a
// min-h touch target, a lucide reset icon + the localized label centered with a gap, amber/yellow neutral
// styling, press feedback only (active:), no hover utilities. handleClearFilters + the locale key are
// unchanged.
test('OrdersPage clear-filters action is a real touch-sized button, not a naked text link', () => {
  const source = ordersPageSource();

  // handleClearFilters logic is still present and wired to the button (behaviour unchanged).
  assert.match(source, /const handleClearFilters = \(\) => \{/);

  // The reset icon is imported from lucide (not emoji / not a custom inline SVG).
  const lucideImport = source.slice(0, source.indexOf("} from 'lucide-react'"));
  assert.match(lucideImport, /\bRotateCcw\b/);

  // Scope to the clear-filters <button> element (anchored on its onClick) so the assertions target that
  // control and nothing else on the page.
  const clickIdx = source.indexOf('onClick={handleClearFilters}');
  assert.notEqual(clickIdx, -1, 'clear-filters button must wire handleClearFilters');
  const btnStart = source.lastIndexOf('<button', clickIdx);
  assert.notEqual(btnStart, -1, 'clear-filters <button> open tag must exist');
  const btnEnd = source.indexOf('</button>', clickIdx);
  assert.notEqual(btnEnd, -1, 'clear-filters </button> must close');
  const btn = source.slice(btnStart, btnEnd + '</button>'.length);

  // It is a real button: explicit type=button + the unchanged handler.
  assert.match(btn, /type="button"/);
  assert.match(btn, /onClick=\{handleClearFilters\}/);

  // Touch target: inline-flex, ~44px min height, rounded-2xl, icon+label centered with a gap.
  assert.match(btn, /inline-flex/);
  assert.match(btn, /min-h-\[44px\]/);
  assert.match(btn, /rounded-2xl/);
  assert.match(btn, /items-center/);
  assert.match(btn, /justify-center/);
  assert.match(btn, /gap-2/);

  // A real lucide icon render inside the button, not emoji or a custom inline SVG.
  assert.match(btn, /<RotateCcw\b/);
  assert.doesNotMatch(btn, /<svg/);

  // Press feedback only -- active: utilities, never hover:.
  assert.match(btn, /active:/);
  assert.doesNotMatch(btn, /hover:/);

  // Label still comes from the existing locale key (no hardcoded UI text, no behaviour change).
  assert.match(btn, /t\('orders\.filters\.clearAll', \{ defaultValue: 'Clear all filters' \}\)/);
  // Not a naked hardcoded text link any more.
  assert.doesNotMatch(btn, />Clear all filters</);
});

// Round 183 (touch-first a11y): the icon-only pagination arrow buttons were unnamed in the
// accessibility tree ("button" / "button (disabled)"). Both must carry a localized aria-label so
// assistive tech names them; no native title tooltip is added (the whole-file no-title guard above
// covers that these buttons stay title-free).
test('OrdersPage pagination arrow buttons carry localized aria-labels', () => {
  const source = ordersPageSource();

  // Previous-page button: disabled-on-first-page preserved, localized aria-label, ChevronLeft icon.
  assert.match(
    source,
    /onClick=\{\(\) => setCurrentPage\(prev => Math\.max\(1, prev - 1\)\)\}\s*disabled=\{currentPage === 1\}\s*aria-label=\{t\('orders\.pagination\.previous', \{ defaultValue: 'Previous page' \}\)\}/,
    'the previous-page button must keep its disabled logic and expose a localized aria-label',
  );
  // Next-page button: disabled-on-last-page preserved, localized aria-label, ChevronRight icon.
  assert.match(
    source,
    /onClick=\{\(\) => setCurrentPage\(prev => Math\.min\(totalPages, prev \+ 1\)\)\}\s*disabled=\{currentPage === totalPages\}\s*aria-label=\{t\('orders\.pagination\.next', \{ defaultValue: 'Next page' \}\)\}/,
    'the next-page button must keep its disabled logic and expose a localized aria-label',
  );
  // The arrows are icon-only (aria-label is their only accessible name).
  assert.match(source, /<ChevronLeft className="w-4 h-4" \/>/);
  assert.match(source, /<ChevronRight className="w-4 h-4" \/>/);
});

// Round 282 (live QA, Greek/light, standalone Orders route): tapping Next stranded currentPage past the
// available page count after the filtered/fetched result count shrank, so the list rendered "No orders
// found" while the header still said "1 order total". paginateOrders now clamps the page to the data
// (never slices past the array) and a focused effect resets currentPage to the last available page when
// the result count shrinks -- so page-1 data shows whenever filtered orders exist, and the empty state
// only when there are truly zero filtered orders.
test('Round 282: OrdersPage clamps a stranded currentPage so shrunk results never show the empty state with orders', () => {
  const source = ordersPageSource();

  // The visible-page derivation clamps to the data, never slicing past the array (Round 283 moved this
  // from paginateOrders into the derived visibleOrders useMemo, so it reads orders.length not input.length).
  assert.match(source, /const maxPage = Math\.max\(1, Math\.ceil\(orders\.length \/ pageSize\)\)/);
  assert.match(source, /const safePage = Math\.min\(currentPage, maxPage\)/);
  assert.match(source, /const start = \(safePage - 1\) \* pageSize/);
  // The old unclamped slice (the stranding source) is gone.
  assert.doesNotMatch(source, /const start = \(currentPage - 1\) \* pageSize/);

  // A dedicated clamp effect resets the stale page from the result count (total), not a generic effect.
  assert.match(
    source,
    /const maxPage = Math\.max\(1, Math\.ceil\(total \/ pageSize\)\);\s*if \(currentPage > maxPage\) \{\s*setCurrentPage\(maxPage\);\s*\}/,
  );
  assert.match(source, /\}, \[total, pageSize, currentPage\]\)/);

  // Behavioural proof: replicate the clamped pagination + the clamp effect; a page-2 over a 1-item result
  // must still render that order (page-1 data), truly-empty stays empty, and healthy multi-page nav is
  // unaffected.
  const pageSize = 20;
  const paginate = (input: number[], currentPage: number): number[] => {
    const maxPage = Math.max(1, Math.ceil(input.length / pageSize));
    const safePage = Math.min(currentPage, maxPage);
    const start = (safePage - 1) * pageSize;
    return input.slice(start, start + pageSize);
  };
  const clampPage = (total: number, currentPage: number): number => {
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    return currentPage > maxPage ? maxPage : currentPage;
  };

  assert.deepEqual(paginate([1], 2), [1], 'page-2 over a 1-item result must still render that order');
  assert.equal(clampPage(1, 2), 1, 'a stale page-2 clamps to 1 when total shrinks to 1');
  assert.equal(clampPage(0, 2), 1, 'with zero results the page clamps to 1 (empty state shows only then)');
  assert.deepEqual(paginate([], 1), [], 'zero filtered orders renders the empty state');
  assert.equal(clampPage(40, 2), 2, 'page 2 of 2 stays page 2 (no spurious reset)');
  assert.deepEqual(
    paginate(Array.from({ length: 25 }, (_, i) => i + 1), 2),
    [21, 22, 23, 24, 25],
    'a genuine page 2 still returns its slice',
  );
});

// Round 283 (live QA after Round 282, Greek/light, standalone Orders route): header said "21 orders
// total", footer "Page 1 of 2", Next was enabled/labelled but tapping it did NOTHING -- the page stayed
// 1. Cause: `orders` state held only the current PAGE SLICE and the page changed only via a refetch
// side effect (paginateOrders was a fetchOrders dependency), which did not re-slice in live POS. The fix
// is a deterministic data model: store the FULL filtered/sorted list in `orders`, derive the visible
// page in a useMemo from currentPage + pageSize, base the empty state on the full list, and drop the
// pagination->refetch dependency so Next/Previous advance the slice immediately.
test('Round 283: OrdersPage stores the full filtered list and derives the visible page (Next advances without a refetch)', () => {
  const source = ordersPageSource();

  // The FULL filtered/sorted list is stored in state -- not a pre-sliced page.
  assert.match(source, /setOrders\(filtered\)/);
  assert.doesNotMatch(source, /setOrders\(paginateOrders\(/, 'orders state must not be a stale paginated slice');
  assert.doesNotMatch(source, /paginateOrders/, 'the slice-on-fetch helper + its fetch dependency are gone (no refetch on page change)');

  // The visible page is derived in a useMemo from the full list + currentPage + pageSize (clamped), and
  // the list renders that derived slice -- never the full array, never a stale slice.
  assert.match(
    source,
    /const visibleOrders = useMemo\(\(\) => \{[\s\S]*?const start = \(safePage - 1\) \* pageSize;[\s\S]*?return orders\.slice\(start, start \+ pageSize\);[\s\S]*?\}, \[orders, currentPage, pageSize\]\)/,
  );
  assert.match(source, /\{visibleOrders\.map\(/, 'the list must render the derived page slice');
  assert.doesNotMatch(source, /\{orders\.map\(/, 'the list must not map the full orders array directly');

  // The empty state is based on the FULL filtered list count (orders.length), not the current page slice.
  assert.match(source, /orders\.length === 0 \?/);

  // Behavioural proof of the exact live bug: a full 21-item filtered list shows 20 rows on page 1 and
  // item 21 on page 2, derived purely from currentPage -- so Next advances without any refetch.
  const pageSize = 20;
  const full = Array.from({ length: 21 }, (_, i) => i + 1);
  const visiblePage = (orders: number[], currentPage: number): number[] => {
    const maxPage = Math.max(1, Math.ceil(orders.length / pageSize));
    const safePage = Math.min(currentPage, maxPage);
    const start = (safePage - 1) * pageSize;
    return orders.slice(start, start + pageSize);
  };
  assert.equal(visiblePage(full, 1).length, 20, 'page 1 of a 21-item list shows 20 rows');
  assert.deepEqual(visiblePage(full, 2), [21], 'Next must derive page 2 (item 21) from the full list, no refetch');
  assert.equal(full.length, 21, 'the empty state is driven by the full list length (21), not the page slice');
});

test('OrderDashboard keeps tabs fixed while only the order area scrolls', () => {
  const dashboardSource = orderDashboardSource();
  const gridSource = orderGridSource();

  assert.match(
    dashboardSource,
    /relative flex h-full min-h-0 flex-col gap-4 overflow-hidden/,
    'dashboard should occupy the container and prevent the tab header from becoming the page scroll root',
  );
  assert.match(
    dashboardSource,
    /<div className="shrink-0">\s*<OrderTabsBar/,
    'tabs should live in the non-scrolling header region',
  );
  assert.match(
    dashboardSource,
    /<div className="min-h-0 flex-1 overflow-hidden">/,
    'the grid region should be the only flexible body area',
  );
  assert.match(
    gridSource,
    /flex h-full min-h-0 flex-col[^`]*overflow-y-auto/,
    'order cards should scroll inside the body region',
  );
  assert.doesNotMatch(
    gridSource,
    /max-h-\[calc\(100[dv]*h-280px\)\]/,
    'order grid should not use a viewport max-height that makes the header scroll with the page',
  );
});

test('OrderDashboard keeps table controls fixed while only the table grid scrolls', () => {
  const dashboardSource = orderDashboardSource();
  const foodSource = foodDashboardSource();
  const standaloneSource = tablesDashboardSource();

  assert.match(
    dashboardSource,
    /className=\{`flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border p-4/,
    'tables tab should be a bounded flex shell, not a page-height content stack',
  );
  assert.match(
    dashboardSource,
    /data-testid="order-dashboard-table-scroll-region"/,
    'table cards should scroll in a dedicated body region',
  );
  assert.match(
    dashboardSource,
    /<div className="shrink-0 space-y-2">/,
    'table filters should live in a non-scrolling header region',
  );
  assert.match(
    dashboardSource,
    /<div className="flex h-full min-h-0 flex-col gap-3">/,
    'embedded table dashboard should use fixed controls plus a bounded flex scroll body',
  );
  assert.match(
    standaloneSource,
    /<div className="mb-4 shrink-0 space-y-3">/,
    'standalone table filters should live in a non-scrolling header region',
  );
  assert.match(
    standaloneSource,
    /<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" onWheel=\{handleTableGridWheel\}>/,
    'standalone table dashboard should use fixed controls plus a bounded flex scroll body',
  );
  assert.match(
    foodSource,
    /className=\{`flex h-full min-h-0 flex-col gap-4 overflow-hidden p-4 md:gap-6 md:p-6 \$\{className\}`\}/,
    'the food dashboard wrapper must give OrderDashboard a bounded flex height',
  );
  assert.doesNotMatch(
    foodSource,
    /space-y-4 md:space-y-6/,
    'the food dashboard wrapper must not size itself from table-grid content',
  );

  for (const [testIdPrefix, source] of [
    ['order-dashboard', dashboardSource],
    ['tables-dashboard', standaloneSource],
  ] as const) {
    assert.match(
      source,
      /const tableGridScrollRef = useRef<HTMLDivElement>\(null\);/,
      'table dashboards should keep a direct ref to the card scroll region',
    );
    assert.match(
      source,
      /const handleTableGridWheel = useCallback\(\(event: React\.WheelEvent<HTMLDivElement>\) => \{[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\);[\s\S]*scrollTarget\.scrollTop = nextScrollTop;/,
      'wheel movement anywhere in the table pane should be redirected into the card scroller',
    );
    assert.match(
      source,
      /onWheel=\{handleTableGridWheel\}/,
      'the table pane should intercept wheel events before the page wrapper can scroll',
    );
    assert.match(
      source,
      new RegExp(
        `data-testid="${testIdPrefix}-table-grid-container"[\\s\\S]*className="min-h-0 flex-1 overflow-hidden"`,
      ),
      'the table cards should live in the bounded grid row below the fixed controls',
    );
    assert.match(
      source,
      new RegExp(
        `data-testid="${testIdPrefix}-table-grid-container"[\\s\\S]*ref=\\{tableGridScrollRef\\}[\\s\\S]*data-testid="${testIdPrefix}-table-scroll-region"[\\s\\S]*className="h-full min-h-0 overflow-y-auto overflow-x-hidden pb-28 pr-24 scrollbar-hide touch-scroll"`,
      ),
      'the grid container should expose one full-size scroll surface with room around the floating action button',
    );
    assert.doesNotMatch(
      source,
      /h-\[calc\(100dvh-30rem\)\]/,
      'the table grid should not use a fixed viewport-height guess that clips card actions',
    );
    assert.doesNotMatch(
      source,
      new RegExp(
        `data-testid="${testIdPrefix}-table-scroll-region"[\\s\\S]*className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto`,
      ),
      'the scroll region must not combine h-full with flex-1, which makes the fixed controls scroll away',
    );
    assert.doesNotMatch(
      source,
      /tableViewMode === ['"]floorplan['"][\s\S]{0,120}overflow-hidden/,
      'table body scrolling should not depend on view mode',
    );
    assert.doesNotMatch(
      source,
      /<div className="grid min-h-full grid-cols-\[repeat\(auto-fill,minmax\(/,
      'list cards should not force the table grid to a full-height minimum inside the scroll region',
    );
  }
});

test('main layout does not wrap order and table dashboards in a page scroll root', () => {
  const layoutSource = mainLayoutSource();
  const containerSource = contentContainerSource();

  assert.match(
    containerSource,
    /contentClassName\?: string;/,
    'ContentContainer should let route layouts opt out of the default inner scroll root',
  );
  assert.match(
    containerSource,
    /className=\{`relative h-full min-h-0 \$\{contentClassName \?\? 'overflow-y-auto scrollbar-hide'\}`\}/,
    'ContentContainer should default to page scrolling unless a route opts out',
  );
  assert.match(
    layoutSource,
    /const locksPageScroll = currentView === 'orders' \|\| currentView === 'tables';/,
    'orders and table dashboards should not inherit the outer page scroll container',
  );
  assert.match(
    layoutSource,
    /<ContentContainer\s+className="flex-1 min-h-0 overflow-hidden relative"\s+contentClassName=\{locksPageScroll \? 'overflow-hidden' : undefined\}/,
    'the content shell should clip order/table dashboards instead of scrolling the whole page',
  );
  assert.match(
    layoutSource,
    /className=\{locksPageScroll\s+\? 'h-full min-h-0'\s+: 'h-full min-h-\[400px\] sm:min-h-\[500px\] md:min-h-\[600px\]'\}/,
    'locked-scroll views should not keep the fallback route min-height that forces page scrolling',
  );
});

test('table dashboards expose list and 2D floor-plan modes', () => {
  const dashboardSource = orderDashboardSource();
  const standaloneSource = tablesDashboardSource();

  for (const source of [dashboardSource, standaloneSource]) {
    assert.match(source, /TableFloorPlanView/);
    assert.match(source, /tableViewMode/);
    assert.match(source, /tablesDashboard\.viewMode\.list/);
    assert.match(source, /tablesDashboard\.viewMode\.floorPlan/);
    assert.match(
      source,
      /useState<[^>]*['"]list['"][^>]*['"]floorplan['"][^>]*>\(\s*['"]list['"]\s*,?\s*\)/,
      'table dashboards should open in List mode, not the 2D floor plan',
    );
  }

  // Round 204: the visible toggle labels come from the table-check overlay locale files, which
  // previously lacked the viewMode keys -- so the toggle showed the English fallback "List" even in
  // Greek (live defect). All five overlays must now define non-empty list/floorPlan labels, and the
  // non-English list labels must be real translations, not the English fallback.
  const loadOverlay = (lng: string): Record<string, any> =>
    JSON.parse(
      readFileSync(path.join(process.cwd(), 'src', 'locales', 'overlays', `${lng}.table-check.json`), 'utf8'),
    );
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const viewMode = loadOverlay(lng).tablesDashboard?.viewMode;
    assert.ok(viewMode, `${lng} overlay missing tablesDashboard.viewMode`);
    assert.equal(typeof viewMode.list, 'string', `${lng} viewMode.list must be a string`);
    assert.ok(viewMode.list.trim().length > 0, `${lng} viewMode.list must be non-empty`);
    assert.equal(typeof viewMode.floorPlan, 'string', `${lng} viewMode.floorPlan must be a string`);
    assert.ok(viewMode.floorPlan.trim().length > 0, `${lng} viewMode.floorPlan must be non-empty`);
  }
  // Greek "List" must be real Greek, not the English fallback "List".
  const elList = loadOverlay('el').tablesDashboard.viewMode.list as string;
  assert.match(elList, GREEK, `el viewMode.list should be Greek: "${elList}"`);
  assert.notEqual(elList, 'List', 'el viewMode.list must not be the English fallback');
  // No non-English locale may leave the list label as the English fallback "List".
  for (const lng of ['el', 'de', 'fr', 'it']) {
    assert.notEqual(
      loadOverlay(lng).tablesDashboard.viewMode.list,
      'List',
      `${lng} viewMode.list must be translated, not the English fallback`,
    );
  }
});

// Round 205: the Tables floor label surfaces forced Tailwind `uppercase`, so localized microcopy
// rendered as harsh all-caps (Greek "ΌΡΟΦΟΣ" / "ΌΡΟΦΟΣ 1") next to the natural-case floor buttons.
// The floor filter prefix + the per-table/detail floor labels must keep localized case (no forced
// uppercase) while stats/status labels may still use uppercase.
test('table floor labels keep localized case (no forced uppercase); stats/status may stay uppercase', () => {
  const dashboardSource = orderDashboardSource();
  const standaloneSource = tablesDashboardSource();

  // For a floor-label render token, return the nearest enclosing className (the label container) so we
  // can assert it does not force uppercase. Icons use className="..." (quotes), not className={...}
  // (braces), so lastIndexOf('className={') lands on the label container, not the icon.
  const enclosingClassName = (source: string, renderToken: string): string => {
    const renderIdx = source.indexOf(renderToken);
    assert.notEqual(renderIdx, -1, `expected to find floor render token: ${renderToken}`);
    const classIdx = source.lastIndexOf('className={', renderIdx);
    assert.notEqual(classIdx, -1, `expected a className before: ${renderToken}`);
    return source.slice(classIdx, renderIdx);
  };

  const floorSurfaces: ReadonlyArray<{ source: string; token: string; label: string }> = [
    { source: dashboardSource, token: 't("tablesDashboard.floor", "Floor")', label: 'OrderDashboard floor filter prefix' },
    { source: dashboardSource, token: 'getTableFloorLabel(getTableFloorValue(table))', label: 'OrderDashboard per-table floor label' },
    { source: standaloneSource, token: "t('tablesDashboard.floor', { defaultValue: 'Floor' })", label: 'TablesDashboard floor filter prefix' },
    { source: standaloneSource, token: 'floorLabel(getFloorValue(table))', label: 'TablesDashboard per-table floor label' },
    { source: standaloneSource, token: 'floorLabel(getFloorValue(selectedTable))', label: 'TablesDashboard selected-table floor label' },
  ];

  for (const { source, token, label } of floorSurfaces) {
    const cls = enclosingClassName(source, token);
    assert.doesNotMatch(cls, /\buppercase\b/, `${label} must not force uppercase (keep localized case)`);
    // Only `uppercase` was removed -- the small / weighted / tracked treatment is preserved.
    assert.match(cls, /tracking-wide/, `${label} should keep its tracking-wide treatment`);
  }

  // The floor buttons were already natural-case and must stay that way (not regress to uppercase).
  assert.match(dashboardSource, /\{getTableFloorLabel\("all"\)\}/);

  // Stats/status labels may still use uppercase -- the change is scoped to floor labels, not global.
  assert.match(dashboardSource, /uppercase/);
  assert.match(standaloneSource, /uppercase/);
});

// Round 303 (live QA): in the embedded 2D floor plan the partially-styled native rail still
// drew thick WebView2 arrow-button scrollbars (vertical rail + bottom horizontal rail). The
// viewport must hide the native rails in every engine while keeping overflow pan/scroll, and a
// touchscreen POS must not carry pointer-only :hover scrollbar styling.
test('Round 303: the 2D floor plan hides native scrollbar rails while keeping pan/scroll (touch-first)', () => {
  const floorPlanSource = tableFloorPlanSource();
  const cssSource = globalsSource();

  // The scroll container pairs the scoped class with the shared scrollbar-hide utility and keeps
  // overflow scrolling, so panning/scrolling stays functional with no visible rail.
  assert.match(
    floorPlanSource,
    /floor-plan-scrollbar scrollbar-hide[^`]*overflow-auto/,
    'the floor-plan viewport should combine floor-plan-scrollbar + scrollbar-hide and keep overflow scrolling',
  );
  // The removed light/dark colored-thumb variants must no longer be referenced.
  assert.doesNotMatch(
    floorPlanSource,
    /floor-plan-scrollbar-(light|dark)/,
    'the colored-thumb floor-plan variants were removed and should no longer be applied',
  );

  // Firefox + legacy Edge: the rail is suppressed at the box level.
  assert.match(cssSource, /\.floor-plan-scrollbar\s*\{[^}]*scrollbar-width:\s*none;/);
  assert.match(cssSource, /\.floor-plan-scrollbar\s*\{[^}]*-ms-overflow-style:\s*none;/);

  // WebKit/Chromium/WebView2: the rail AND the arrow-button rail are fully hidden.
  assert.match(
    cssSource,
    /\.floor-plan-scrollbar::-webkit-scrollbar,[^}]*display:\s*none;/,
    'the WebKit scrollbar pseudo-element must be display:none',
  );
  assert.match(
    cssSource,
    /\.floor-plan-scrollbar::-webkit-scrollbar-button[^}]*display:\s*none;/,
    'the scrollbar-button pseudo-element must be hidden so WebView2 cannot draw arrow rails',
  );

  // The old visible thin/8px rail is gone.
  assert.doesNotMatch(cssSource, /\.floor-plan-scrollbar\s*\{[^}]*scrollbar-width:\s*thin/);
  assert.doesNotMatch(cssSource, /\.floor-plan-scrollbar::-webkit-scrollbar\s*\{[^}]*8px/);

  // Touch-first: no pointer-only scrollbar styling for the floor-plan class, and the view
  // introduces no hover utilities of its own.
  assert.doesNotMatch(
    cssSource,
    /\.floor-plan-scrollbar[^\n{]*:hover/,
    'the floor-plan scrollbar must not carry pointer-hover styling on a touchscreen POS',
  );
  assert.doesNotMatch(floorPlanSource, /hover:/);
});

test('TablesPage grid search matches visible table numbers case-insensitively', () => {
  const source = tablesPageSource();

  assert.match(
    source,
    /t\.tableNumber\.toString\(\)\.toLowerCase\(\)\.includes\(term\)/,
    'table-number search should lower-case the visible table number before matching',
  );
  assert.doesNotMatch(
    source,
    /t\.tableNumber\.toString\(\)\.includes\(term\)/,
    'case-sensitive table-number matching makes B01 disappear when searching b01',
  );
});

// Round 206/208: the compact TablesPage card rendered raw table.notes, leaking English/admin seed text
// ("Bar table seeded for testing.") as primary microcopy in Greek/light. The card must show structured
// table.section instead (only when present), and grid search must match table number + section, not the
// hidden notes. Round 208: the section sits in a calm two-line metadata stack and may use the full card
// width / wrap gracefully -- the old max-w-[60px] truncation (which clipped "Dining Room" to "Dining R...")
// is gone. Notes stay in the data model and any modal/details path (only this page's card + search change).
test('TablesPage compact card shows table.section (wrapping, no 60px cap), not raw table.notes', () => {
  const source = tablesPageSource();

  // The compact grid card renders the structured section line (MapPin), gated on section presence.
  assert.match(source, /\{table\.section && \(/);
  // Round 208: the section span uses the available width and wraps gracefully -- no hard truncation cap.
  assert.match(source, /<span className="min-w-0 break-words leading-snug">\{table\.section\}<\/span>/);
  assert.doesNotMatch(source, /max-w-\[60px\]/);
  // The raw notes render is gone from the card.
  assert.doesNotMatch(source, /\{table\.notes\}/);
  assert.doesNotMatch(source, /\{table\.notes && \(/);

  // Grid search matches table number + section, and no longer searches the hidden notes field.
  assert.match(source, /t\.section\?\.toLowerCase\(\)\.includes\(term\)/);
  assert.doesNotMatch(source, /t\.notes\?\.toLowerCase\(\)\.includes\(term\)/);
});

// Round 207 (touch-first, live QA): native DOM title= tooltips are hover-dependent and surface as
// doubled "Description:" entries in the Windows accessibility tree on a touchscreen POS. TablesPage
// must expose its icon-button names via aria-label (or visible text) only -- no title= anywhere.
test('TablesPage filter and view icon buttons are labeled via aria-label and use no native title tooltips', () => {
  const source = tablesPageSource();

  assert.doesNotMatch(
    source,
    /t\('tables\.status',\s*'Status'\)/,
    'tables.status is an object and must not be rendered as a scalar label',
  );
  assert.match(source, /t\('tables\.filters\.status',\s*'Filter by Status'\)/);

  // Accessible names stay on the icon buttons via aria-label (view toggle, filter, refresh, close).
  assert.match(source, /aria-label=\{\s*viewMode === 'grid'[\s\S]*tables\.layout\.switchToFloorPlan/);
  assert.match(source, /aria-label=\{t\('tables\.filters\.title',\s*'Filter Tables'\)\}/);
  assert.match(source, /aria-label=\{t\('common\.refresh',\s*'Refresh'\)\}/);
  assert.match(source, /aria-label=\{t\('common\.actions\.close',\s*'Close'\)\}/);

  // No native title tooltip anywhere in TablesPage (touchscreen-first).
  assert.doesNotMatch(source, /\btitle=/);

  // The disabled New Order button keeps its disabled/aria-disabled logic and surfaces its reason via
  // the visible inline message, not a hover-only title tooltip.
  assert.match(source, /disabled=\{isNewOrderActionDisabled\}/);
  assert.match(source, /aria-disabled=\{isNewOrderActionDisabled\}/);
  assert.match(source, /\{isNewOrderActionDisabled && \([\s\S]*?\{orderCreationDisabledMessage\}/);
});

test('TablesPage new-order action routes to the order-entry route with table context', () => {
  const source = tablesPageSource();

  assert.match(source, /const params = new URLSearchParams\(\{[\s\S]*orderType: 'dine-in'[\s\S]*tableNumber: String\(table\.tableNumber\)[\s\S]*tableId: table\.id/);
  assert.match(source, /navigate\(`\/new-order\?\$\{params\.toString\(\)\}`\)/);
  assert.doesNotMatch(source, /navigate\(`\/menu\?orderType=dine-in/);
});

test('NewOrderPage hydrates dine-in table context from the Tables grid route', () => {
  const source = newOrderPageSource();

  assert.match(source, /const \[searchParams\] = useSearchParams\(\);/);
  assert.match(source, /requestedOrderType !== 'dine-in'/);
  assert.match(source, /setSelectedOrderType\('dine-in'\)/);
  assert.match(source, /setTableNumber\(searchParams\.get\('tableNumber'\) \|\| ''\)/);
  assert.match(source, /setTableId\(searchParams\.get\('tableId'\) \|\| ''\)/);
  assert.match(source, /setShowMenuModal\(true\)/);
  assert.match(source, /buildTableOrderCreateFields\(\{[\s\S]*serviceOrderType: currentOrderType[\s\S]*tableNumber[\s\S]*guestCount: 1/);
  assert.match(source, /orderType=\{orderType\}/);
});

test('table check manager renders as an app-level modal overlay', () => {
  const source = tableCheckManagerSource();

  assert.match(
    source,
    /import ReactDOM from 'react-dom';/,
    'table check manager should use a portal so it is not clipped by the table grid container',
  );
  assert.match(
    source,
    /const modalContent = \(\s*<motion\.div[\s\S]*className="liquid-glass-modal-viewport"/,
    'the modal viewport should remain the top-level rendered content',
  );
  assert.match(
    source,
    /<div className="liquid-glass-modal-backdrop" aria-hidden="true" \/>/,
    'the app-level overlay should keep the liquid glass backdrop blur',
  );
  assert.match(
    source,
    /return ReactDOM\.createPortal\(modalContent, document\.body\);/,
    'the table check manager must portal into document.body outside the scroll-locked route shell',
  );
});

test('TableActionModal turns cleaning tables into cleaned-only order flow', () => {
  const source = tableActionModalSource();
  const dashboardSource = orderDashboardSource();
  const tablesPage = tablesPageSource();

  assert.match(
    source,
    /const isCleaningTable = table\.status === 'cleaning';/,
    'modal should derive a cleaning-table branch from the table status',
  );
  assert.match(
    source,
    /disabled=\{blocksGuestActions\}/,
    'cleaning tables should not allow the new-order action',
  );
  assert.match(
    source,
    /aria-disabled=\{blocksGuestActions\}/,
    'the disabled new-order state should be exposed to assistive tech',
  );
  assert.match(
    source,
    /handleSetAvailable/,
    'modal should expose a dedicated cleaned action for cleaning tables',
  );
  assert.match(
    source,
    /tableActionModal\.markCleaned/,
    'cleaned action should have its own translatable label',
  );
  assert.match(
    dashboardSource,
    /const handleTableSetAvailable = useCallback\(async \(\) => \{[\s\S]*updateTableStatus\(selectedTable\.id, "available"\)[\s\S]*setShowTableActionModal\(false\)/,
    'main table action flow should mark the selected cleaning table available and close the modal',
  );
  assert.match(
    dashboardSource,
    /onSetAvailable=\{handleTableSetAvailable\}/,
    'dashboard should pass the cleaned handler into TableActionModal',
  );
  assert.match(
    tablesPage,
    /table\.status === 'cleaning'\s*\?\s*t\('tables\.actions\.markCleaned', 'Cleaned'\)\s*:\s*table\.status === 'maintenance'\s*\?\s*t\('tables\.actions\.markBackInService', 'Back in service'\)\s*:\s*t\('tables\.actions\.markAvailable', 'Set Available'\)/,
    'the standalone table status modal should label the available transition as Cleaned for cleaning tables',
  );
});

test('TableActionModal treats maintenance tables as out of service', () => {
  const source = tableActionModalSource();
  const dashboardSource = orderDashboardSource();
  const tablesPage = tablesPageSource();

  assert.match(
    source,
    /const isMaintenanceTable = table\.status === 'maintenance';/,
    'modal should derive a maintenance-table branch from the table status',
  );
  assert.match(
    source,
    /const blocksGuestActions = isCleaningTable \|\| isMaintenanceTable \|\| isUnavailableTable;/,
    'maintenance tables should share the blocked guest-action path',
  );
  assert.match(
    source,
    /disabled=\{blocksGuestActions\}/,
    'maintenance tables should not allow the new-order action',
  );
  assert.match(
    source,
    /disabled=\{isMaintenanceTable \|\| isUnavailableTable\}/,
    'maintenance tables should not allow reservation creation',
  );
  assert.match(
    source,
    /tableActionModal\.markBackInService/,
    'maintenance tables should expose a Back in service action',
  );
  assert.match(
    dashboardSource,
    /const handleTableSetAvailable = useCallback\(async \(\) => \{[\s\S]*updateTableStatus\(selectedTable\.id, "available"\)[\s\S]*setShowTableActionModal\(false\)/,
    'main flow should return maintenance tables to available through updateTableStatus',
  );
  assert.match(
    tablesPage,
    /status: 'maintenance', label: t\('tables\.actions\.markMaintenance', 'Set Maintenance'\)/,
    'standalone status modal should expose setting a table to maintenance',
  );
  assert.match(
    tablesPage,
    /table\.status === 'maintenance'\s*\?\s*t\('tables\.actions\.markBackInService', 'Back in service'\)/,
    'standalone status modal should label the available transition as Back in service for maintenance tables',
  );
});

test('TableActionModal exposes management actions for reserved tables', () => {
  const source = tableActionModalSource();
  const dashboardSource = orderDashboardSource();

  assert.match(
    source,
    /const isReservedTable = table\.status === 'reserved';/,
    'modal should derive a reserved-table branch from the table status',
  );
  assert.match(
    source,
    /tableActionModal\.editReservation/,
    'reserved tables should expose an edit reservation action',
  );
  assert.match(
    source,
    /tableActionModal\.noShowReservation/,
    'reserved tables should expose a no-show action',
  );
  assert.match(
    source,
    /tableActionModal\.cancelReservation/,
    'reserved tables should expose a cancel reservation action',
  );
  assert.match(
    source,
    /\{!isReservedTable && \(/,
    'reserved tables should not show the create-new-reservation action',
  );
  assert.match(
    dashboardSource,
    /const handleTableEditReservation = useCallback\(async \(\) => \{[\s\S]*getTodayReservationForTable\(selectedTable\.id\)[\s\S]*setEditingReservation\(reservation\)[\s\S]*setShowReservationForm\(true\)/,
    'main flow should load the table reservation before opening the edit form',
  );
  assert.match(
    dashboardSource,
    /const handleTableNoShowReservation = useCallback\(async \(\) => \{[\s\S]*updateStatus\(reservation\.id, "no_show"\)[\s\S]*updateTableStatus\(selectedTable\.id, "available", \{ __release: true \}\)/,
    'main flow should mark no-show reservations and durably release the table',
  );
  assert.match(
    dashboardSource,
    /const handleTableCancelReservation = useCallback\(async \(\) => \{[\s\S]*cancelReservation\(reservation\.id[\s\S]*updateTableStatus\(selectedTable\.id, "available", \{ __release: true \}\)/,
    'main flow should cancel reservations and durably release the table',
  );
  assert.match(
    dashboardSource,
    /initialReservation=\{editingReservation\}/,
    'reservation form should receive the reservation being edited',
  );
  assert.match(
    dashboardSource,
    /updateReservationDetails\(editingReservation\.id/,
    'reservation form submit should save edits when editing an existing reservation',
  );
});

test('reservation edit saves details with table identity compatibility and surfaces real failures', () => {
  const dashboardSource = orderDashboardSource();
  const flowSource = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderFlow.tsx'),
    'utf8',
  );

  assert.match(
    dashboardSource,
    /tableId:\s*data\.tableId,/,
    'dashboard reservation edits should keep the current table id for POS reservation PATCH compatibility',
  );
  assert.match(
    flowSource,
    /tableId:\s*data\.tableId,/,
    'order flow reservation edits should keep the current table id for POS reservation PATCH compatibility',
  );
  assert.match(
    dashboardSource,
    /const reservationUpdateError = extractOrderDashboardErrorMessage\(error\);[\s\S]*reservationUpdateError \|\|[\s\S]*defaultValue: "Failed to update reservation"/,
    'dashboard should show the actual reservation update error or a default message, not a raw i18n key',
  );
  assert.match(
    flowSource,
    /const reservationUpdateError = error instanceof Error && error\.message\.trim\(\)[\s\S]*reservationUpdateError \|\|[\s\S]*defaultValue: 'Failed to update reservation'/,
    'order flow should show the actual reservation update error or a default message, not a raw i18n key',
  );
});

test('FloatingActionButton opens on taps even when drag pointer capture retargets the click', () => {
  const source = floatingActionButtonSource();

  assert.match(
    source,
    /fixed z-\[900\]/,
    'FAB should float over page content but stay below modal backdrops so it is blurred behind open modals',
  );
  assert.doesNotMatch(
    source,
    /z-\[2147482500\]/,
    'FAB must not use an always-on-top z-index above modal overlays',
  );
  assert.match(
    source,
    /const handleWrapperClick = React\.useCallback/,
    'movable FAB needs a wrapper click fallback because pointer capture can retarget tap clicks',
  );
  assert.match(
    source,
    /event\.target !== event\.currentTarget/,
    'wrapper fallback should only run when the click lands on the wrapper itself',
  );
  assert.match(
    source,
    /onClick\?\.\(event as unknown as React\.MouseEvent<HTMLButtonElement>\)/,
    'wrapper fallback should invoke the same consumer onClick handler as the inner button',
  );
  assert.match(
    source,
    /onClick=\{handleWrapperClick\}/,
    'wrapper must wire the fallback click handler',
  );
});

test('FloatingActionButton always renders a visible default Plus icon so the orb is identifiable', () => {
  const source = floatingActionButtonSource();

  assert.match(
    source,
    /import \{ Plus \} from 'lucide-react';/,
    'the FAB should import the Plus icon used as the default affordance',
  );
  assert.match(
    source,
    /<span aria-hidden="true" className="pos-fab__overlay">\s*\{icon \?\? <Plus aria-hidden="true" \/>\}\s*<\/span>/,
    'the overlay must render unconditionally and fall back to a Plus icon when no icon prop is supplied',
  );
  assert.doesNotMatch(
    source,
    /\{icon \? \(\s*<span aria-hidden="true" className="pos-fab__overlay">/,
    'the FAB must not leave the orb empty when no icon prop is provided',
  );
});

// Round 173 (touch-first): the FAB forwards all button props, so a caller's `title=` would render a
// native hover tooltip on the touchscreen orb. `title` (and `aria-label`) are pulled out of the
// spread props; the title string is preserved as the accessible-name fallback.
test('FloatingActionButton does not forward a native title tooltip but keeps an accessible label fallback', () => {
  const source = floatingActionButtonSource();

  // title + aria-label are destructured out, so they cannot reach the <button> via {...props}.
  assert.match(
    source,
    /onClick, title, 'aria-label': ariaLabel, \.\.\.props \}/,
    'title and aria-label must be pulled out of the forwarded props',
  );
  // When no aria-label is supplied, the title string becomes the accessible name.
  assert.match(source, /const resolvedAriaLabel = ariaLabel \?\? title;/);
  assert.match(source, /aria-label=\{resolvedAriaLabel\}/);
  // No native title attribute is rendered anywhere in the component.
  assert.doesNotMatch(source, /\btitle=/);
});

// Round 209 (touch-first, static audit): TablesDashboard still had source-level title= on the refresh
// button and passed title= to the Add Order FloatingActionButton. Even though the shared FAB converts
// title->aria-label, this component must be clean itself: expose accessible names via aria-label, with
// no native DOM title tooltips anywhere.
test('TablesDashboard uses aria-labels, not native title tooltips, for refresh + Add Order FAB', () => {
  const source = tablesDashboardSource();

  // No native title attribute anywhere in TablesDashboard.
  assert.doesNotMatch(source, /\btitle=/);

  // Refresh button: accessible name via aria-label (same tablesDashboard.refresh translation), with its
  // handler/disabled/icon intact.
  assert.match(source, /aria-label=\{t\('tablesDashboard\.refresh', \{ defaultValue: 'Refresh' \}\)\}/);
  assert.match(source, /disabled=\{isRefreshing \|\| ordersLoading \|\| tablesLoading\}/);
  assert.match(source, /<RefreshCw className=\{`w-5 h-5 \$\{isRefreshing \? 'animate-spin' : ''\}`\} \/>/);

  // Add Order FAB: passes aria-label (not title), keeping its onClick handler.
  assert.match(
    source,
    /<FloatingActionButton[\s\S]*?onClick=\{onAddOrder\}[\s\S]*?aria-label=\{t\('tablesDashboard\.addOrder', \{ defaultValue: 'Add Order' \}\)\}[\s\S]*?\/>/,
  );
  // The FAB no longer receives a title prop.
  assert.doesNotMatch(source, /title=\{t\('tablesDashboard\.addOrder'/);
  assert.doesNotMatch(source, /title=\{t\('tablesDashboard\.refresh'/);
});

// Round 210 (touch-first, static audit): the MOUNTED dashboard (OrderDashboard.tsx) New Order
// FloatingActionButton still passed a native title=. The shared FAB converts title->aria-label, so
// it was not a live DOM-tooltip bug, but the mounted source must be clean: the FAB exposes its
// (conditional) accessible name via aria-label, not title. The visible LiquidGlassModal /
// ReceiptPreviewModal `title` props are component heading text and stay allowed.
test('OrderDashboard New Order FAB uses aria-label (conditional), not a native title tooltip', () => {
  const source = orderDashboardSource();

  // Slice just the mounted New Order FAB block (identified by its onClick + position storage key).
  const clickIdx = source.indexOf('onClick={handleNewOrderClick}');
  assert.notEqual(clickIdx, -1, 'New Order FAB onClick must exist');
  const fabOpen = source.lastIndexOf('<FloatingActionButton', clickIdx);
  assert.notEqual(fabOpen, -1, 'New Order FAB opening tag must exist');
  const fabClose = source.indexOf('/>', clickIdx);
  assert.notEqual(fabClose, -1, 'New Order FAB must self-close');
  const fab = source.slice(fabOpen, fabClose + 2);

  // This is the visible/mounted New Order FAB.
  assert.match(fab, /positionStorageKey="pos-orders-new-order-fab-position"/);
  // Accessible name via aria-label, preserving the exact conditional text (start-shift-first when
  // disabled, orders.newOrder otherwise).
  assert.match(
    fab,
    /aria-label=\{\s*!isShiftActive\s*\?\s*t\(\s*"orders\.startShiftFirst",[\s\S]*?\)\s*:\s*t\("orders\.newOrder"\)\s*\}/,
  );
  // No native title tooltip on the FAB, and onClick/disabled/movable/position-key are preserved.
  assert.doesNotMatch(fab, /\btitle=/);
  assert.match(fab, /onClick=\{handleNewOrderClick\}/);
  assert.match(fab, /disabled=\{!isShiftActive\}/);
  assert.match(fab, /\bmovable\b/);

  // The visible modal HEADING title props (component headings, not DOM tooltips) remain allowed.
  assert.match(source, /title=\{t\("orderFlow\.selectOrderType"\)/);
  assert.match(source, /title=\{t\("orderDashboard\.receiptPreview"\)/);
});

// Round 211 → 214 (live QA): the waiter value used to clip as "Χωρίς αν…" in a half-width boxed tile.
// Round 214 v3 re-laid the metadata as a compact one-line two-chip strip where the WAITER chip takes
// the remaining row width (flex-1 min-w-0), so a value like "Χωρίς ανάθεση" reads on one line without
// wrapping into a tall tile (truncating only if pathologically long). No tall boxed tile remains.
test('OrderDashboard table-card waiter value reads on one line via a width-taking chip, no tall tile', () => {
  const source = orderDashboardSource();

  // The waiter chip takes the remaining row width; its value lives in a truncating span (one line).
  assert.match(
    source,
    /inline-flex min-w-0 flex-1 items-center gap-1 rounded-lg border px-2 py-1 font-semibold[\s\S]*?<span className="truncate">\{waiterName\}<\/span>/,
  );
  // The old boxed waiter tile (wrapping value / half-width grid tile) is gone.
  assert.doesNotMatch(source, /mt-1 break-words leading-tight font-black/);
  assert.doesNotMatch(source, /mt-1 truncate font-black/);
  assert.doesNotMatch(source, /min-w-0 rounded-xl border px-3 py-1\.5/);

  // The covers + waiter values are preserved as compact chips with their Users / UserCheck icons.
  assert.match(source, /<Users className="h-3\.5 w-3\.5 shrink-0" \/>\s*\{guestCount\}\/\{table\.capacity\}/);
  assert.match(source, /<UserCheck className="h-3\.5 w-3\.5 shrink-0" \/>\s*<span className="truncate">\{waiterName\}<\/span>/);
});

// Round 212 (a11y / touch hierarchy, live QA): the mounted Dashboard list-mode table card wrapper was
// a giant role="button" that also contained inner action buttons (New order, New reservation, Mark
// cleaned, Pay/Edit) -- the accessibility tree read each card as a button-with-nested-buttons, which is
// invalid and bad for touch clarity. The wrapper must be a non-interactive semantic <article>: no
// role="button", tabIndex, outer onClick/onKeyDown, cursor-pointer, or focus ring. Inner action
// buttons + handlers are unchanged.
test('OrderDashboard list-mode table card is a non-interactive <article>, not a nested role="button"', () => {
  const source = orderDashboardSource();

  // The card wrapper is a semantic, non-interactive <article> carrying the card visual classes (minus
  // cursor-pointer, the focus ring, AND the press feedback -- a passive container must not animate).
  assert.match(
    source,
    /<article\s+key=\{table\.id\}\s+className=\{`min-h-\[180px\] rounded-2xl border p-3 backdrop-blur-xl transition-all duration-200 \$\{visual\.card\}`\}\s*>/,
  );

  // Slice the card wrapper region and prove it is not an interactive container.
  const idx = source.indexOf('min-h-[180px] rounded-2xl border p-3 backdrop-blur-xl');
  assert.notEqual(idx, -1, 'table card wrapper must exist');
  const open = source.lastIndexOf('<article', idx);
  const close = source.indexOf('</article>', idx);
  assert.notEqual(open, -1, 'card <article> opening must exist');
  assert.notEqual(close, -1, 'card </article> close must exist');
  const card = source.slice(open, close + '</article>'.length);

  // No role=button / focusable / pointer / focus-ring / keyboard-activation on the wrapper.
  assert.doesNotMatch(card, /role="button"/);
  assert.doesNotMatch(card, /tabIndex=\{0\}/);
  assert.doesNotMatch(card, /cursor-pointer/);
  assert.doesNotMatch(card, /focus:ring-yellow-400\/45/);
  assert.doesNotMatch(card, /onKeyDown=/);
  // The passive wrapper has no press/tap feedback; only the inner action buttons animate
  // (active:scale-95). The wrapper's old active:scale-[0.99] is gone.
  const wrapperOpenTag = card.slice(0, card.indexOf('>') + 1);
  assert.doesNotMatch(wrapperOpenTag, /active:scale/);
  assert.doesNotMatch(card, /active:scale-\[0\.99\]/);
  assert.match(card, /active:scale-95/);

  // Inner visible action buttons + their handlers are preserved (attention / new-or-open order via
  // handleTableSelect; reserve/pay/edit via handleTableReserve or handleTableSelect as branched).
  assert.ok(
    (card.match(/handleTableSelect\(table\)/g) || []).length >= 2,
    'inner action buttons still call handleTableSelect',
  );
  assert.match(card, /handleTableReserve\(table\)/);
});

// Round 214 (live QA, third pass): the mounted Dashboard list-mode table card was clipped at 1282x802
// because it was structurally too tall. It is re-laid genuinely short: the boxed Covers/Waiter tiles
// become a compact one-line two-chip strip, the duplicate lower status line is removed (the top badge
// already carries the status), the number is smaller, and the wrapper min-height/padding are reduced --
// so the first row's action buttons are fully visible without scrolling. The wrapper stays the passive
// <article> and the real action buttons keep their handlers + active:scale-95.
test('OrderDashboard list-mode table card is genuinely short: chip strip, no boxed tiles, no duplicate status line', () => {
  const source = orderDashboardSource();

  // Slice the card wrapper region (article -> matching close).
  const idx = source.indexOf('min-h-[180px] rounded-2xl border p-3 backdrop-blur-xl');
  assert.notEqual(idx, -1, 'compact table card wrapper must exist');
  const open = source.lastIndexOf('<article', idx);
  const close = source.indexOf('</article>', idx);
  assert.notEqual(open, -1, 'card <article> opening must exist');
  assert.notEqual(close, -1, 'card </article> close must exist');
  const card = source.slice(open, close + '</article>'.length);

  // The card is genuinely shorter (round 214 follow-up): smaller min-height + padding so the first row
  // fits at 1280x800 without the action area being clipped. The old 230px/p-4 sizing is gone.
  assert.match(card, /min-h-\[180px\] rounded-2xl border p-3 backdrop-blur-xl/);
  assert.doesNotMatch(card, /min-h-\[230px\]/);

  // The bulky status PANEL and the duplicate lower status LINE are both gone -- the top status badge
  // already carries Available/Cleaning/Out-of-service, so the card no longer restates it below.
  assert.doesNotMatch(card, /mt-4 rounded-xl border px-3 py-3/);
  assert.doesNotMatch(card, /text-sm font-black text-amber-700 dark:text-amber-300/);
  assert.doesNotMatch(card, /text-sm font-black text-emerald-700 dark:text-emerald-300/);

  // The boxed Covers/Waiter metadata tiles are replaced by a compact one-line two-chip info strip
  // (covers chip fixed, waiter chip taking the remaining width). The old boxed tiles are gone.
  assert.match(card, /mt-2 flex items-center gap-1\.5 text-xs/);
  assert.match(card, /inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 font-bold/);
  assert.match(card, /inline-flex min-w-0 flex-1 items-center gap-1 rounded-lg border px-2 py-1 font-semibold/);
  assert.doesNotMatch(card, /rounded-xl border px-3 py-1\.5/);

  // Tightened density: table number text-2xl (not the bulkier 3xl/4xl), and the occupied-only chips
  // row is conditional so available/clean cards don't reserve its band.
  assert.match(card, /mt-1 truncate text-2xl font-black/);
  assert.doesNotMatch(card, /mt-1 truncate text-3xl font-black/);
  assert.doesNotMatch(card, /mt-1 truncate text-4xl font-black/);
  assert.match(card, /\{occupiedSinceLabel \|\| table\.currentOrderId \? \(/);

  // The wrapper stays the passive <article> (Round 212): no role=button / wrapper press feedback.
  const wrapperOpenTag = card.slice(0, card.indexOf('>') + 1);
  assert.match(wrapperOpenTag, /^<article\b/);
  assert.doesNotMatch(card, /role="button"/);
  assert.doesNotMatch(wrapperOpenTag, /active:scale/);

  // The real inner action buttons remain centered, keep active:scale-95, and keep their handlers.
  assert.match(card, /justify-center gap-1\.5 rounded-xl[\s\S]*?active:scale-95/);
  assert.ok(
    (card.match(/active:scale-95/g) || []).length >= 2,
    'inner action buttons keep their active:scale-95 press feedback',
  );
  assert.ok(
    (card.match(/handleTableSelect\(table\)/g) || []).length >= 2,
    'inner action buttons still call handleTableSelect',
  );
  assert.match(card, /handleTableReserve\(table\)/);
});

test('stale reserved-table actions self-heal instead of dead-ending on reservationNotFound', () => {
  const dashboardSource = orderDashboardSource();

  // A shared recovery helper releases the table durably, refetches, toasts staff
  // and closes/clears the modal — replacing the old toast-and-return dead end.
  assert.match(
    dashboardSource,
    /const releaseStaleReservedTable = useCallback\(async \(\) => \{[\s\S]*?updateTableStatus\(selectedTable\.id, "available", \{[\s\S]*?refetchTables\(\)[\s\S]*?tableActionModal\.reservationReleased[\s\S]*?setShowTableActionModal\(false\)[\s\S]*?setSelectedTable\(null\)[\s\S]*?\}, \[refetchTables, selectedTable, t, updateTableStatus\]\)/,
    'releaseStaleReservedTable should durably release the table, refetch, toast and close the modal',
  );

  // The release must be DURABLE: every reserved -> available release passes the
  // __release flag so useTables stores a surviving override (the live bug was a
  // plain release that the immediate stale refetch resurrected as reserved).
  const durableReleases = dashboardSource.match(/updateTableStatus\(selectedTable\.id, "available", \{\s*__release: true,?\s*\}\)/g) ?? [];
  assert.ok(
    durableReleases.length >= 3,
    `expected the stale-recovery, no-show and cancel paths to pass __release, found ${durableReleases.length}`,
  );

  // The old bare "reservationNotFound" toast-and-return is gone from the handlers.
  assert.doesNotMatch(
    dashboardSource,
    /tableActionModal\.reservationNotFound/,
    'reserved-action handlers must recover the stale table, not just toast reservationNotFound',
  );

  // Each reserved-action handler routes the not-found branch through the recovery
  // helper AND keeps its success path intact.
  assert.match(
    dashboardSource,
    /const handleTableEditReservation = useCallback\(async \(\) => \{[\s\S]*?if \(!reservation\) \{\s*\/\/[\s\S]*?await releaseStaleReservedTable\(\);\s*return;\s*\}[\s\S]*?setEditingReservation\(reservation\)[\s\S]*?setShowReservationForm\(true\)/,
    'edit handler should recover when no reservation, then still open the edit form on success',
  );
  assert.match(
    dashboardSource,
    /const handleTableNoShowReservation = useCallback\(async \(\) => \{[\s\S]*?if \(!reservation\) \{\s*\/\/[\s\S]*?await releaseStaleReservedTable\(\);\s*return;\s*\}[\s\S]*?updateStatus\(reservation\.id, "no_show"\)/,
    'no-show handler should recover when no reservation, then still mark no-show on success',
  );
  assert.match(
    dashboardSource,
    /const handleTableCancelReservation = useCallback\(async \(\) => \{[\s\S]*?if \(!reservation\) \{\s*\/\/[\s\S]*?await releaseStaleReservedTable\(\);\s*return;\s*\}[\s\S]*?cancelReservation\(reservation\.id/,
    'cancel handler should recover when no reservation, then still cancel on success',
  );

  // Helper definition + one call and one dependency reference in each of the
  // three handlers = 7 occurrences.
  const occurrences = dashboardSource.match(/releaseStaleReservedTable/g) ?? [];
  assert.ok(
    occurrences.length >= 7,
    `expected helper definition + 3 calls + 3 deps refs, found ${occurrences.length}`,
  );
});

test('reservationReleased recovery toast is localized in every POS locale', () => {
  const localesDir = path.join(process.cwd(), 'src', 'locales');
  const loadLocale = (lng: string): Record<string, any> =>
    JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

  const en = loadLocale('en').tableActionModal.reservationReleased;

  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const value = loadLocale(lng).tableActionModal?.reservationReleased;
    assert.equal(typeof value, 'string', `${lng} missing tableActionModal.reservationReleased`);
    assert.ok(value.length > 0, `${lng} empty tableActionModal.reservationReleased`);
  }
  // Greek + de/fr/it must be real translations, not the English fallback.
  for (const lng of ['el', 'de', 'fr', 'it']) {
    assert.notEqual(
      loadLocale(lng).tableActionModal.reservationReleased,
      en,
      `${lng} reservationReleased must be a real translation, not English`,
    );
  }
});

// Restoration guard (round 186, updated round 190): order tabs are neutral GREY when inactive (a
// dark-safe zinc in dark, not white/70) and only the ACTIVE tab gets its distinct neon color/glow
// (orders green, delivered orange, tables blue, canceled red).
test('OrderTabsBar inactive labels/counters are neutral grey; only the active tab uses neon', () => {
  const source = orderTabsBarSource();

  // Inactive tab text is neutral grey: zinc-400 in dark, gray-600 in light (no neon when inactive).
  assert.match(
    source,
    /const tabTextClass = \(color: string, isActive: boolean, isDark: boolean, withGlow: boolean\): string => \{\s*if \(!isActive\) \{[\s\S]*?return isDark \? 'text-zinc-400' : 'text-gray-600';/,
  );
  // Inactive dark must NOT be white/white-70 (the over-bright value being corrected).
  assert.doesNotMatch(source, /return isDark \? 'text-white\/70'/);
  // The active neon palette (green/orange/blue/red only) + glow, applied after the !isActive return.
  assert.match(source, /green: 'text-green-500'/);
  assert.match(source, /orange: 'text-\[#f97316\]'/);
  assert.match(source, /blue: 'text-\[#3b82f6\]'/);
  assert.match(source, /red: 'text-red-500'/);
  assert.match(source, /const base = TAB_ACTIVE_TEXT\[color\] \?\? TAB_ACTIVE_TEXT\.red;/);
});

// Round 201 (dashboard shell selected-state semantics, live QA): the order-status tab strip exposed
// only plain buttons, so assistive tech couldn't tell which tab is selected. The wrapper is now a
// role="tablist" and each tab is a role="tab" type="button" with aria-selected tied to activeTab.
// Visuals (labels/counters/neon/active:scale) are unchanged.
test('OrderTabsBar exposes tablist/tab selection semantics tied to activeTab', () => {
  const source = orderTabsBarSource();

  // Wrapper is a labelled tablist (localized aria-label with an English fallback).
  assert.match(source, /role="tablist"/);
  assert.match(source, /aria-label=\{t\('dashboard\.tabs\.tablistLabel', 'Order status tabs'\)\}/);

  // Each tab button is a real button with tab semantics and selection bound to activeTab === tab.id.
  assert.match(source, /type="button"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /aria-selected=\{activeTab === tab\.id\}/);

  // Selection state must be derived, not hardcoded, and no native title tooltip / hover introduced.
  assert.doesNotMatch(source, /aria-selected=\{true\}/);
  assert.doesNotMatch(source, /aria-selected="true"/);
  assert.doesNotMatch(source, /\btitle=\{/);
  assert.doesNotMatch(source, /hover:/);

  // Touch feedback + neon active palette preserved (no visual regression).
  assert.match(source, /active:scale-95/);
  assert.match(source, /const base = TAB_ACTIVE_TEXT\[color\] \?\? TAB_ACTIVE_TEXT\.red;/);
});

// Round 201 correction (live QA): the Windows UIA tree did not expose aria-selected as a state, so the
// selected tab's accessible NAME must announce it. Each tab gets an aria-label derived from
// activeTab === tab.id: the selected tab uses the localized selectedTab key, inactive uses the plain
// label+count key. Visible label/counter unchanged.
test('OrderTabsBar bakes the selected state into each tab accessible name (derived, not hardcoded)', () => {
  const source = orderTabsBarSource();

  // The aria-label branches on activeTab === tab.id: selected -> selectedTab key, else -> tab key.
  assert.match(
    source,
    /aria-label=\{\s*activeTab === tab\.id\s*\?\s*t\('dashboard\.tabs\.selectedTab', \{[\s\S]*?label: tab\.label,[\s\S]*?value: tab\.count,[\s\S]*?\}\)\s*:\s*t\('dashboard\.tabs\.tab', \{[\s\S]*?label: tab\.label,[\s\S]*?value: tab\.count,/,
  );
  // The visible label + counter still render tab.label / tab.count unchanged.
  assert.match(source, /\{tab\.label\}/);
  assert.match(source, /\{tab\.count\}/);

  // The two new keys exist with both placeholders, and selectedTab carries a state suffix, in every locale.
  const loadLocale = (lng: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${lng}.json`), 'utf8'));
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const tabs = (loadLocale(lng).dashboard as Record<string, Record<string, unknown>>).tabs;
    const tab = tabs.tab as string;
    const selectedTab = tabs.selectedTab as string;
    assert.equal(typeof tab, 'string', `${lng} dashboard.tabs.tab missing`);
    assert.equal(typeof selectedTab, 'string', `${lng} dashboard.tabs.selectedTab missing`);
    assert.ok(tab.includes('{{label}}') && tab.includes('{{value}}'), `${lng} tab must interpolate label+value`);
    assert.ok(
      selectedTab.includes('{{label}}') && selectedTab.includes('{{value}}'),
      `${lng} selectedTab must interpolate label+value`,
    );
    // selectedTab must add something beyond the plain tab label (the "selected" state marker).
    assert.notEqual(selectedTab, tab, `${lng} selectedTab must differ from the plain tab label`);
  }
});

// Restoration guard (round 186): the order-type chooser modal must render the supplied Flaticon
// TableOrderIcon (not Utensils/fork/cake) for the table card, at the same large w-full h-full
// footprint as the pickup card's PickupOrderIcon.
test('OrderDashboard order-type modal table card uses TableOrderIcon at the pickup footprint, no Utensils', () => {
  const source = orderDashboardSource();

  // Both order-type cards use the shared icons at full footprint; the dine-in card scales the supplied
  // table PNG to the pickup bag's optical weight via opticalScale, in the SAME w-full h-full box.
  assert.match(source, /<PickupOrderIcon className="w-full h-full text-white" \/>/);
  assert.match(source, /<TableOrderIcon\s+className="w-full h-full text-white"\s+strokeWidth=\{1\.6\}\s+opticalScale=\{1\.62\}/);
  assert.match(source, /import TableOrderIcon from ['"]\.\/icons\/TableOrderIcon['"]/);
  assert.match(source, /import PickupOrderIcon from ['"]\.\/icons\/PickupOrderIcon['"]/);

  // Scope to the chooser card region (pickup button -> table button close) and assert no
  // Utensils/fork/cake glyph is used there. UtensilsCrossed exists elsewhere in OrderDashboard, so
  // the region slice keeps this guard precise without flagging unrelated usage.
  const pickupIdx = source.indexOf('handleOrderTypeSelect("pickup")');
  assert.notEqual(pickupIdx, -1, 'pickup order-type card should exist');
  const tableSelectIdx = source.indexOf('handleOrderTypeSelect("dine-in")', pickupIdx);
  assert.notEqual(tableSelectIdx, -1, 'table (dine-in) order-type card should exist');
  const regionEnd = source.indexOf('</button>', tableSelectIdx);
  assert.notEqual(regionEnd, -1, 'table order-type card button should close');
  const chooserRegion = source.slice(pickupIdx, regionEnd + '</button>'.length);
  assert.doesNotMatch(chooserRegion, /Utensils|UtensilsCrossed|\bFork\b|\bCake\b/);
});

// Round 306 (restoration hardening): OrderFlow is the SECOND path into order taking, with a parallel
// order-type chooser that duplicates OrderDashboard's pickup/table cards. It was previously unguarded, so
// a refactor could reintroduce an off-theme glyph on this path alone. It must render the SAME restored
// icons -- the Flaticon TableOrderIcon (chair/table, not Utensils/fork/cake/store/package) for dine-in and
// the shared PickupOrderIcon bag for pickup -- at the SAME w-16 h-16 footprint, so the bag and the
// table/chair match size.
test('Round 306: OrderFlow order-type chooser uses TableOrderIcon + PickupOrderIcon at a matching footprint, no off-theme glyphs', () => {
  const source = orderFlowSource();

  // Shared icons imported and rendered (no raw lucide order-type glyph for dine-in/pickup).
  assert.match(source, /import TableOrderIcon from ['"]\.\/icons\/TableOrderIcon['"]/);
  assert.match(source, /import PickupOrderIcon from ['"]\.\/icons\/PickupOrderIcon['"]/);
  assert.match(source, /<PickupOrderIcon className="w-full h-full text-white" \/>/);
  // Round 345/361: dine-in card scales the table glyph to the pickup bag's optical weight via opticalScale.
  assert.match(source, /<TableOrderIcon\s+className="w-full h-full text-white"\s+strokeWidth=\{1\.6\}\s+opticalScale=\{1\.62\}/);

  // Scope to the chooser region (pickup card -> dine-in card close). UtensilsCrossed exists elsewhere in
  // OrderFlow, so the slice keeps this guard precise.
  const pickupIdx = source.indexOf("handleSelectOrderType('pickup')");
  assert.notEqual(pickupIdx, -1, 'OrderFlow pickup order-type card should exist');
  const tableIdx = source.indexOf("handleSelectOrderType('dine-in')", pickupIdx);
  assert.notEqual(tableIdx, -1, 'OrderFlow dine-in order-type card should exist');
  const regionEnd = source.indexOf('</button>', tableIdx);
  assert.notEqual(regionEnd, -1, 'OrderFlow table order-type card button should close');
  const chooserRegion = source.slice(pickupIdx, regionEnd + '</button>'.length);

  // Pickup bag + table/chair share the same w-16 h-16 icon box (matching footprint).
  const iconBoxes = chooserRegion.match(/w-16 h-16 flex items-center justify-center/g) ?? [];
  assert.ok(
    iconBoxes.length >= 2,
    `pickup + table icon boxes must share the w-16 h-16 footprint (found ${iconBoxes.length})`,
  );
  // No Cake/Utensils/Store/Package/fork fallback for the order-type selection.
  assert.doesNotMatch(chooserRegion, /Utensils|UtensilsCrossed|\bFork\b|\bCake\b|\bStore\b|\bPackage\b/);
});

// Round 346 (live QA): the secondary OrderFlow order-type chooser (FoodDashboard/ProductDashboard/
// ServiceDashboard/ProductCatalogView path) used the older narrow modal. It is now aligned with the approved
// main OrderDashboard ergonomics -- count-driven modal width + responsive grid, full type=button + composed
// aria-labels on all three cards, roomier descriptions -- and the FloatingActionButton drops its native title
// tooltip (touch-first). Presentation/a11y only; handlers, icons, and workflows are unchanged.
test('Round 346: OrderFlow order-type chooser matches the OrderDashboard responsive + a11y ergonomics', () => {
  const source = orderFlowSource();

  // Local aria helper + count-driven width/grid (mirrors OrderDashboard).
  assert.match(source, /const composeOrderTypeAriaLabel = \(title: string, description: string\): string =>/);
  assert.match(source, /const visibleOrderTypeCardCount = 1 \+ \(hasDeliveryModule \? 1 : 0\) \+ \(hasTablesModule \? 1 : 0\);/);
  assert.match(source, /const orderTypeModalWidthClass =/);
  assert.match(source, /'!max-w-3xl'/);
  assert.match(source, /'!max-w-xl'/);
  assert.match(source, /'!max-w-lg'/);
  assert.match(source, /const orderTypeGridColsClass =/);
  assert.match(source, /'grid-cols-1 sm:grid-cols-3'/);

  // Modal uses the computed width class plus the transparent-shell trial class; grid uses gap-4
  // sm:gap-5 + the computed cols class.
  assert.match(source, /className=\{`\$\{orderTypeModalWidthClass\} order-type-transparent-modal`\}/);
  assert.match(source, /contentClassName="!p-0 !overflow-visible"/);
  assert.match(source, /<div className=\{`grid gap-4 sm:gap-5 \$\{orderTypeGridColsClass\}`\}>/);

  // Scope card-level a11y/touch guards to the order-type modal region (open -> close).
  const modalIdx = source.indexOf('isOpen={isOrderTypeModalOpen}');
  assert.notEqual(modalIdx, -1, 'OrderFlow order-type modal should exist');
  const modalEnd = source.indexOf('</LiquidGlassModal>', modalIdx);
  assert.notEqual(modalEnd, -1, 'OrderFlow order-type modal should close');
  const modalRegion = source.slice(modalIdx, modalEnd);

  // All three cards are real buttons with composed aria-labels (delivery/pickup/table).
  const typeButtons = modalRegion.match(/type="button"/g) ?? [];
  assert.ok(typeButtons.length >= 3, `all three chooser cards must be type=button (found ${typeButtons.length})`);
  assert.match(modalRegion, /aria-label=\{composeOrderTypeAriaLabel\(deliveryTitle, deliveryDescription\)\}/);
  assert.match(modalRegion, /aria-label=\{composeOrderTypeAriaLabel\(pickupTitle, pickupDescription\)\}/);
  assert.match(modalRegion, /aria-label=\{composeOrderTypeAriaLabel\(tableTitle, tableDescription\)\}/);

  // Descriptions breathe (text-sm leading-snug); no narrow text-xs description remains in the chooser.
  const descriptions = modalRegion.match(/text-sm leading-snug text-white\/60/g) ?? [];
  assert.ok(descriptions.length >= 3, `all three card descriptions must be text-sm leading-snug (found ${descriptions.length})`);
  assert.doesNotMatch(modalRegion, /text-xs text-white\/60/);

  // Touch-first: no stale group/hover utilities inside the chooser.
  assert.doesNotMatch(modalRegion, /\bgroup\b/);
  assert.doesNotMatch(modalRegion, /hover:/);

  // The FloatingActionButton no longer uses a native title tooltip; the disabled reason now rides on the
  // aria-label, and the disabled visual class is preserved.
  assert.doesNotMatch(source, /title=\{!isShiftActive \? t\('orders\.startShiftFirst'/);
  assert.match(
    source,
    /aria-label=\{!isShiftActive \? t\('orders\.startShiftFirst'[\s\S]*?: t\('orderFlow\.startNewOrder'\)\}/,
  );
  assert.match(source, /className=\{!isShiftActive \? 'bg-gray-400 cursor-not-allowed opacity-50' : ''\}/);
});

test('Round 362: New Order chooser can render as transparent shell with only floating cards visible', () => {
  const dashboard = orderDashboardSource();
  const flow = orderFlowSource();
  const css = glassmorphismSource();

  for (const [name, source] of [
    ['OrderDashboard', dashboard],
    ['OrderFlow', flow],
  ] as const) {
    const modalIdx = source.indexOf('order-type-transparent-modal');
    assert.notEqual(modalIdx, -1, `${name} order-type modal must use the transparent trial class`);
    const modalRegion = source.slice(Math.max(0, modalIdx - 260), source.indexOf('>', modalIdx) + 1);
    assert.match(
      modalRegion,
      /className=\{`\$\{orderTypeModalWidthClass\} order-type-transparent-modal`\}/,
      `${name} must preserve computed width while adding transparent shell styling`,
    );
    assert.match(
      source.slice(modalIdx, modalIdx + 220),
      /contentClassName="!p-0 !overflow-visible"/,
      `${name} must remove the inherited modal content padding for floating cards`,
    );
    for (const cardType of ['delivery', 'pickup', 'table']) {
      assert.match(source, new RegExp(`data-order-type-card="${cardType}"`), `${name} must expose ${cardType} card styling hook`);
    }
  }
  for (const cardType of ['room', 'service']) {
    assert.match(dashboard, new RegExp(`data-order-type-card="${cardType}"`), `OrderDashboard must expose ${cardType} card styling hook`);
  }

  const start = css.indexOf('Trial: New Order chooser as a transparent command palette.');
  assert.notEqual(start, -1, 'transparent chooser CSS block must exist');
  const block = css.slice(start, css.indexOf('@keyframes modalEnter', start));

  assert.match(block, /\.liquid-glass-modal-viewport:has\(\.order-type-transparent-modal\) \.liquid-glass-modal-backdrop/);
  assert.match(block, /background: rgba\(0, 0, 0, 0\.2\) !important;/);
  assert.match(block, /backdrop-filter: blur\(22px\) saturate\(0\.96\) brightness\(0\.82\) !important;/);
  assert.match(block, /-webkit-backdrop-filter: blur\(22px\) saturate\(0\.96\) brightness\(0\.82\) !important;/);
  assert.match(block, /\.dark \.liquid-glass-modal-viewport:has\(\.order-type-transparent-modal\) \.liquid-glass-modal-backdrop/);
  assert.match(block, /\.dark \.liquid-glass-modal-viewport:has\(\.order-type-transparent-modal\) \.liquid-glass-modal-backdrop \{[\s\S]*?background: rgba\(0, 0, 0, 0\.08\) !important;[\s\S]*?backdrop-filter: blur\(18px\) saturate\(1\.08\) !important;/);
  assert.match(block, /\.order-type-transparent-modal\.liquid-glass-modal-shell/);
  assert.match(block, /\.order-type-transparent-modal\.liquid-glass-modal-shell,[\s\S]*?background: transparent !important;/);
  assert.match(block, /\.order-type-transparent-modal\.liquid-glass-modal-shell,[\s\S]*?backdrop-filter: none !important;/);
  assert.match(block, /border: 0 !important;/);
  assert.match(block, /box-shadow: none !important;/);
  assert.match(block, /\.order-type-transparent-modal \.liquid-glass-modal-title \{\s*display: none;/);
  assert.match(block, /\.order-type-transparent-modal \.liquid-glass-modal-close \{\s*display: none !important;/);
  assert.match(block, /\.order-type-transparent-modal \.liquid-glass-modal-content/);
  assert.match(block, /\[data-order-type-card="delivery"\][\s\S]*?rgba\(74, 57, 0, 0\.76\)/);
  assert.match(block, /\[data-order-type-card="pickup"\][\s\S]*?rgba\(3, 70, 45, 0\.76\)/);
  assert.match(block, /\[data-order-type-card="table"\][\s\S]*?rgba\(20, 58, 103, 0\.76\)/);
  assert.match(block, /\[data-order-type-card\] svg,[\s\S]*?\[data-order-type-card\] \[aria-hidden="true"\] \{[\s\S]*?color: rgba\(24, 24, 27, 0\.9\) !important;/);
  assert.match(block, /\[data-order-type-card\] p \{[\s\S]*?color: rgba\(24, 24, 27, 0\.72\) !important;/);
  assert.match(block, /\.dark \.order-type-transparent-modal \[data-order-type-card="delivery"\][\s\S]*?rgba\(250, 204, 21, 0\.16\)/);
  assert.match(block, /\.dark \.order-type-transparent-modal \[data-order-type-card="pickup"\][\s\S]*?rgba\(52, 211, 153, 0\.16\)/);
  assert.match(block, /\.dark \.order-type-transparent-modal \[data-order-type-card="table"\][\s\S]*?rgba\(96, 165, 250, 0\.16\)/);
  assert.match(block, /\.dark \.order-type-transparent-modal \[data-order-type-card\] svg,[\s\S]*?color: #fff !important;/);
  assert.match(block, /\.dark \.order-type-transparent-modal \[data-order-type-card\] p \{[\s\S]*?color: rgba\(255, 255, 255, 0\.6\) !important;/);
  assert.doesNotMatch(block, /hover:/);

  const fallbackStart = css.indexOf('Late fallback: transparent New Order chooser must stay readable');
  assert.notEqual(fallbackStart, -1, 'transparent chooser needs a late non-data-attribute fallback for already-running windows');
  const fallbackBlock = css.slice(fallbackStart);
  assert.match(
    fallbackBlock,
    /html:not\(\.dark\) \.order-type-transparent-modal \.liquid-glass-modal-content button\[type="button"\] svg,[\s\S]*?span\[aria-hidden="true"\] \{[\s\S]*?color: rgba\(24, 24, 27, 0\.92\) !important;/,
  );
  assert.match(
    fallbackBlock,
    /html:not\(\.dark\) \.order-type-transparent-modal \.liquid-glass-modal-content button\[type="button"\] p \{[\s\S]*?color: rgba\(24, 24, 27, 0\.78\) !important;/,
  );
  assert.match(
    fallbackBlock,
    /\.dark \.order-type-transparent-modal \.liquid-glass-modal-content button\[type="button"\] svg,[\s\S]*?span\[aria-hidden="true"\] \{[\s\S]*?color: #fff !important;/,
  );
});

// Round 345/360 (live QA optical polish): the dine-in/table card must use the founder-supplied
// transparent PNG artwork, painted as currentColor through an alpha mask.
test('Round 345/360: TableOrderIcon uses the founder transparent PNG as a currentColor alpha mask', () => {
  const iconSource = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'icons', 'TableOrderIcon.tsx'),
    'utf8',
  );
  const png = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'assets', 'table-order-icon.png'),
  );

  // Optional prop exists; a provided scale transforms the mask after layout so the wide supplied PNG
  // matches the apparent height of the lucide-style chooser icons without clipping.
  assert.match(iconSource, /opticalScale\?:\s*number/);
  assert.match(iconSource, /opticalScale = 1\.62/);
  assert.match(iconSource, /import tableIconUrl from '\.\.\/\.\.\/assets\/table-order-icon\.png'/);
  assert.match(iconSource, /backgroundColor: 'currentColor'/);
  assert.match(iconSource, /WebkitMaskImage: `url\(\$\{tableIconUrl\}\)`/);
  assert.match(iconSource, /WebkitMaskMode: 'alpha'/);
  assert.match(iconSource, /WebkitMaskSize: '100%'/);
  assert.match(iconSource, /transform: `scale\(\$\{scale\}\)`/);
  assert.match(iconSource, /overflow: 'visible'/);
  assert.match(iconSource, /aria-hidden="true"/);
  assert.doesNotMatch(iconSource, /viewBox="0 0 64 64"|<path d=/);

  // PNG signature + IHDR: 512x512, truecolor with alpha (color type 6), so the mask shape is not a
  // full opaque square.
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.equal(png[25], 6);

  // The bundled mask is normalized to white-on-transparent. Black opaque pixels can disappear in
  // Chromium/WebView mask rendering because mask luminance is considered alongside alpha.
  let offset = 8;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const rowBytes = 512 * 4;
  const rgba = Buffer.alloc(rowBytes * 512);
  for (let y = 0; y < 512; y += 1) {
    const filter = inflated[y * (rowBytes + 1)];
    assert.equal(filter, 0, 'table icon PNG rows should stay unfiltered after normalization');
    inflated.copy(rgba, y * rowBytes, y * (rowBytes + 1) + 1, y * (rowBytes + 1) + 1 + rowBytes);
  }
  const firstOpaque = (() => {
    for (let index = 0; index < rgba.length; index += 4) {
      if (rgba[index + 3] > 0) {
        return rgba.subarray(index, index + 4);
      }
    }
    return null;
  })();
  assert.ok(firstOpaque, 'table icon PNG must contain visible pixels');
  assert.ok(
    firstOpaque[0] > 240 && firstOpaque[1] > 240 && firstOpaque[2] > 240,
    'table icon visible pixels must be white for reliable CSS mask luminance',
  );
});

// Round 215 (live QA): with delivery + pickup + table all enabled, the order-type chooser was cramped
// in a max-w-lg modal at 1282x802, so the three cards became skinny columns and Greek descriptions
// wrapped badly. The 3-option chooser now uses a wider glass modal (max-w-3xl) + a responsive grid
// (stacked on tiny widths, 3-up on normal) with more readable description text, while 1/2-option
// choosers stay compact and the card icons / semantic colours / aria-labels are unchanged.
test('OrderDashboard order-type chooser adapts its width/grid for up to five cards (Round 236)', () => {
  const source = orderDashboardSource();

  // Width + grid are now driven by the visible card count (pickup always present; delivery/table/
  // room/service optional), so the modal stays roomy for 4-5 cards instead of a fixed 3-up.
  assert.match(source, /const visibleOrderTypeCardCount =/);
  assert.match(source, /visibleOrderTypeCardCount >= 5\s*\?\s*"!max-w-5xl"/);
  assert.match(source, /const orderTypeGridColsClass =/);
  assert.match(source, /className=\{`\$\{orderTypeModalWidthClass\} order-type-transparent-modal`\}/);
  assert.match(source, /contentClassName="!p-0 !overflow-visible"/);
  assert.match(source, /grid gap-4 sm:gap-5 \$\{orderTypeGridColsClass\}/);
  // The old delivery+table-only fixed width/grid expressions are gone.
  assert.doesNotMatch(source, /hasDeliveryModule && hasTablesModule \? "!max-w-3xl" : "!max-w-lg"/);

  // Round 322: the chooser grid is intentionally composed for 4 and 5 cards (no 3+1 / no orphaned
  // bottom-left row leaving an empty bottom-right hole).
  // FIVE cards: a 6-col lg track (each card spans 2) so it reads as a centered 3+2.
  assert.match(source, /visibleOrderTypeCardCount >= 5\s*\?\s*"grid-cols-1 sm:grid-cols-2 lg:grid-cols-6"/);
  // FOUR cards: a clean 4-up lg row, never 3+1.
  assert.match(source, /visibleOrderTypeCardCount === 4\s*\?\s*"grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"/);
  // 1/2/3 cards keep the existing compact behavior.
  assert.match(source, /visibleOrderTypeCardCount === 3\s*\?\s*"grid-cols-1 sm:grid-cols-3"/);
  // The old unconditional >=4 three-column track is gone (it caused the 3+2 hole at five cards).
  assert.doesNotMatch(source, /visibleOrderTypeCardCount >= 4\s*\?\s*"grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"/);

  // Each card spans two of the six columns on lg, and the 4th visible card opens the centered bottom row
  // at column 2 -- computed by visible index, so it is correct for any module combination (no card-name
  // hardcoding). Every visible card threads its span class through the helper.
  assert.match(source, /const orderTypeCardSpanClass = \(visibleIndex: number\): string =>/);
  assert.match(source, /visibleIndex === 4\s*\?\s*"lg:col-span-2 lg:col-start-2"\s*:\s*"lg:col-span-2"/);
  assert.match(source, /orderTypeCardSpanClass\(deliveryCardVisibleIndex\)/);
  assert.match(source, /orderTypeCardSpanClass\(pickupCardVisibleIndex\)/);
  assert.match(source, /orderTypeCardSpanClass\(tableCardVisibleIndex\)/);
  assert.match(source, /orderTypeCardSpanClass\(roomCardVisibleIndex\)/);
  assert.match(source, /orderTypeCardSpanClass\(serviceCardVisibleIndex\)/);
  // The visible index follows the live card order (Delivery, Pickup, Table, Room, Service) and pickup is
  // always counted, so the helper never depends on a specific card being present.
  assert.match(source, /const pickupCardVisibleIndex = deliveryCardVisibleIndex \+ 1;/);

  // Touch ergonomics intact: cards keep the active-tap micro-animation and no hover utilities sneak in.
  assert.match(source, /transition-transform duration-150 active:scale-95/);

  // Descriptions are more readable (text-sm leading-snug), not the cramped text-xs.
  assert.ok(
    (source.match(/<p className="text-sm leading-snug text-white\/60 transition-colors">/g) || []).length >= 3,
    'all three order-type cards should use the readable text-sm leading-snug description',
  );

  // Card icons keep their full footprint. The delivery glyph itself is neutral white; accent belongs
  // to the card/title, matching pickup/table/room/service.
  assert.match(source, /<PickupOrderIcon className="w-full h-full text-white" \/>/);
  assert.match(source, /<TableOrderIcon\s+className="w-full h-full text-white"/);
  assert.match(source, /<svg\s+className="w-full h-full text-white"/);
  assert.doesNotMatch(source, /<svg\s+className="w-full h-full text-yellow-400/);
  assert.match(source, /border-\[#facc15\]\/45 bg-\[linear-gradient\(135deg,rgba\(250,204,21,0\.16\),rgba\(234,179,8,0\.06\)\)\]/);
  assert.match(source, /border-\[#34d399\]\/45 bg-\[linear-gradient\(135deg,rgba\(52,211,153,0\.16\),rgba\(22,163,74,0\.06\)\)\]/);
  assert.match(source, /border-\[#60a5fa\]\/45 bg-\[linear-gradient\(135deg,rgba\(96,165,250,0\.16\),rgba\(37,99,235,0\.06\)\)\]/);
  assert.match(source, /border-\[#a855f7\]\/45 bg-\[linear-gradient\(135deg,rgba\(168,85,247,0\.16\),rgba\(126,34,206,0\.06\)\)\]/);
  assert.match(source, /border-\[#22d3ee\]\/45 bg-\[linear-gradient\(135deg,rgba\(34,211,238,0\.16\),rgba\(8,145,178,0\.06\)\)\]/);
  assert.match(source, /text-yellow-400 transition-colors mb-1/);
  assert.match(source, /text-green-400 transition-colors mb-1/);
  assert.match(source, /text-\[#60a5fa\] transition-colors mb-1/);

  // Accessibility labels still come from composeOrderTypeAriaLabel for every card.
  assert.ok(
    (source.match(/aria-label=\{composeOrderTypeAriaLabel\(/g) || []).length >= 3,
    'each order-type card keeps its composeOrderTypeAriaLabel accessible name',
  );
});

// --- Round 236: Order-taking hub IA migration (tables/rooms/services) --------------------------

test('OrderDashboard adds conditional Room + Service order-type cards wired to the hub flows', () => {
  const source = orderDashboardSource();

  // Module flags drive the new cards + tabs.
  assert.match(source, /hasRoomsModule,/);
  assert.match(source, /const hasServicesModule = hasAppointmentsModule \|\| hasServiceCatalogModule;/);

  // Room card (purple, BedDouble) opens the room flow chooser; Service card (teal, CalendarClock)
  // opens the services hub. Both are module-gated and keep centered icon/text.
  assert.match(source, /\{hasRoomsModule && \(/);
  assert.match(source, /onClick=\{handleSelectRoomFlow\}/);
  assert.match(source, /<BedDouble className="w-full h-full text-white" strokeWidth=\{1\.5\} \/>/);
  assert.match(source, /text-\[#a855f7\] transition-colors mb-1/);
  assert.match(source, /\{hasServicesModule && \(/);
  assert.match(source, /onClick=\{handleSelectServiceFlow\}/);
  assert.match(source, /<CalendarClock className="w-full h-full text-white" strokeWidth=\{1\.5\} \/>/);
  assert.match(source, /text-\[#22d3ee\] transition-colors mb-1/);

  // Both new cards build their accessible name via the shared helper.
  assert.match(source, /composeOrderTypeAriaLabel\(roomTitle, roomDescription\)/);
  assert.match(source, /composeOrderTypeAriaLabel\(serviceTitle, serviceDescription\)/);

  // Existing pickup/delivery/table flow entry points are untouched.
  assert.match(source, /onClick=\{\(\) => handleOrderTypeSelect\("dine-in"\)\}/);
});

test('OrderDashboard Room flow chooser sets a dine-in room-charge order and reuses MenuModal', () => {
  const source = orderDashboardSource();

  // The three room options route to the right places. Round 238: check-in/reservation open focused
  // selector modules (reserved-only / available-only), NOT an embedded RoomsView; Room Order opens
  // its occupied-room selector.
  assert.match(source, /const handleSelectRoomFlow = \(\) => \{[\s\S]*?setShowRoomFlowModal\(true\);/);
  assert.match(source, /const handleRoomFlowOrder = \(\) => \{[\s\S]*?setShowRoomOrderSelector\(true\);/);
  assert.match(source, /const handleRoomFlowCheckin = \(\) => \{[\s\S]*?setShowRoomCheckinSelector\(true\);/);
  assert.match(source, /const handleRoomFlowReservation = \(\) => \{[\s\S]*?setShowRoomReservationSelector\(true\);/);
  // The rejected hubPreset arming is gone from both handlers.
  assert.doesNotMatch(source, /setRoomsHubPreset\(/);
  assert.doesNotMatch(source, /setShowRoomWorkflowModal\(/);

  // Room Order: selecting a room sets up a dine-in cart charged to the folio, then opens MenuModal.
  assert.match(source, /const handleRoomOrderRoomSelect = \(room: Room\) => \{/);
  assert.match(source, /const activeFolioId = room\.activeFolio\?\.id \|\| null;/);
  assert.match(source, /if \(!activeFolioId\) return;/);
  assert.match(source, /setSelectedOrderType\("dine-in"\);/);
  assert.match(source, /setRoomChargeContext\(\{[\s\S]*?roomId: room\.id,[\s\S]*?activeFolioId,[\s\S]*?\}\);/);
  assert.match(source, /setShowMenuModal\(true\);/);

  // roomChargeContext flows into the new-order MenuModal and is cleared on close (no leak to later orders).
  assert.match(source, /roomChargeContext=\{roomChargeContext\}/);
  assert.match(source, /setRoomChargeContext\(null\);/);

  // The Room Order selector disables rooms without an active folio rather than making a broken order.
  assert.match(source, /disabled=\{!folioId\}/);
  assert.match(source, /roomOrderNoFolio/);
});

test('OrderDashboard embeds RoomsView/AppointmentsView as hub tabs with bounded scroll', () => {
  const source = orderDashboardSource();

  // Conditional tab visibility passed to OrderTabsBar, with a live rooms count + 0 services count.
  assert.match(source, /showRoomsTab=\{hasRoomsModule\}/);
  assert.match(source, /showServicesTab=\{hasServicesModule\}/);
  assert.match(source, /rooms: roomsHubCount,/);
  assert.match(source, /const roomsHubCount = hubRoomStats\.occupiedRooms \+ hubRoomStats\.reservedRooms;/);

  // The tab content branches render the embedded views. Round 238: the Rooms tab is browse-only
  // (an embedded RoomsView with no preset); the focused check-in / reservation flows are separate
  // selector modules, not a preset-armed RoomsView. Round 239: each content branch is also module-gated.
  assert.match(source, /activeTab === "rooms" && hasRoomsModule \? \(/);
  assert.match(source, /<RoomsView embedded \/>/);
  assert.match(source, /activeTab === "services" && hasServicesModule \? \(/);
  assert.match(source, /<AppointmentsView\s+embedded\s+openCreateSignal=\{servicesOpenCreateSignal\}/);

  // No hover-only styling in the Room flow modal region, and no native DOM title tooltip on the
  // option buttons (the LiquidGlassModal `title=` prop is a visible heading, which is allowed).
  const roomFlowStart = source.indexOf('Room Flow Modal (Round 236)');
  const roomFlowEnd = source.indexOf('Table Selector Modal (for table orders)');
  assert.ok(roomFlowStart >= 0 && roomFlowEnd > roomFlowStart, 'room flow modal region must exist');
  const roomFlowRegion = source.slice(roomFlowStart, roomFlowEnd);
  assert.doesNotMatch(roomFlowRegion, /hover:/);
  assert.doesNotMatch(roomFlowRegion, /<button[^>]*\stitle=/);
});

// --- Round 238: New Order check-in / reservation use focused selector MODULES, never RoomsView ----

test('Round 238: the New Order room workflow modal never renders RoomsView or arms a hubPreset', () => {
  const source = orderDashboardSource();

  // The rejected approach (an embedded RoomsView armed with a hubPreset, inside the workflow modal)
  // is fully gone: no hubPreset/hubPresetSignal prop is passed on any RoomsView tag, and the
  // preset-workflow state/modal no longer exist. (Prose comments may still name them as rejected.)
  assert.doesNotMatch(source, /<RoomsView\b[^>]*hubPreset/);
  assert.doesNotMatch(source, /hubPresetSignal=\{/);
  assert.doesNotMatch(source, /showRoomWorkflowModal/);
  assert.doesNotMatch(source, /setRoomsHubPreset/);

  // The ONLY RoomsView usage left is the browse-only Rooms hub tab (no props beyond `embedded`).
  const roomsViewUsages = source.match(/<RoomsView\b[^/]*\/>/g) || [];
  assert.deepEqual(roomsViewUsages, ['<RoomsView embedded />'],
    'RoomsView may only appear as the browse-only Rooms tab');

  // Neither check-in nor reservation navigates to the Rooms hub tab.
  assert.doesNotMatch(source, /const handleRoomFlowCheckin = \(\) => \{[\s\S]*?setActiveTab\(/);
  assert.doesNotMatch(source, /const handleRoomFlowReservation = \(\) => \{[\s\S]*?setActiveTab\(/);
});

test('Round 238: check-in lists RESERVED rooms and reservation lists AVAILABLE rooms via focused modules', () => {
  const source = orderDashboardSource();

  // The dashboard imports the focused, purpose-built modules (not RoomsView) for the two flows.
  assert.match(
    source,
    /import \{[\s\S]*?RoomStaySelectorModal,[\s\S]*?RoomCheckinModal,[\s\S]*?RoomReservationModal,[\s\S]*?\} from "\.\/modals\/RoomStayWorkflowModals";/,
  );

  // Candidate lists are derived by EFFECTIVE status: reserved -> check-in, available -> reservation.
  assert.match(
    source,
    /const reservedRoomsForCheckin = useMemo\(\s*\(\) => hubRooms\.filter\(\(room\) => getRoomEffectiveStatus\(room\) === "reserved"\)/,
  );
  assert.match(
    source,
    /const availableRoomsForReservation = useMemo\(\s*\(\) => hubRooms\.filter\(\(room\) => getRoomEffectiveStatus\(room\) === "available"\)/,
  );

  // Check-in selector: variant="checkin" fed the reserved rooms; selecting one opens the check-in form.
  assert.match(
    source,
    /<RoomStaySelectorModal\s+isOpen=\{showRoomCheckinSelector\}\s+variant="checkin"\s+rooms=\{reservedRoomsForCheckin\}/,
  );
  assert.match(source, /<RoomCheckinModal\s+room=\{checkinRoom\}/);

  // Reservation selector: variant="reservation" fed the available rooms; selecting one opens the form.
  assert.match(
    source,
    /<RoomStaySelectorModal\s+isOpen=\{showRoomReservationSelector\}\s+variant="reservation"\s+rooms=\{availableRoomsForReservation\}/,
  );
  assert.match(source, /<RoomReservationModal\s+room=\{reservationRoom\}/);

  // Room Order is unchanged: it still opens MenuModal with the room charge and a clear empty state.
  assert.match(source, /onClick=\{\(\) => handleRoomOrderRoomSelect\(room\)\}/);
  assert.match(source, /roomChargeContext=\{roomChargeContext\}/);
  assert.match(source, /roomOrderEmpty/);
});

test('Round 238: the focused room selector/form module is not RoomsView and carries clear empty states + glass + i18n', () => {
  const moduleSource = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'RoomStayWorkflowModals.tsx'),
    'utf8',
  );

  // The module is self-contained: it must NOT import or render the RoomsView shell, nor route a
  // tap through a hubPreset prop. (Doc comments may name them as the rejected/sibling approach.)
  assert.doesNotMatch(moduleSource, /import[^\n;]*RoomsView/);
  assert.doesNotMatch(moduleSource, /<RoomsView/);
  assert.doesNotMatch(moduleSource, /hubPreset=\{/);

  // Compact glass shells (LiquidGlassModal portals + blurs); no hub stats/search/filter/floor chrome.
  assert.match(moduleSource, /import \{ LiquidGlassModal \} from '\.\.\/ui\/pos-glass-components';/);
  assert.doesNotMatch(moduleSource, /StatCard|StatusFilterButtons|FloorSelect|searchPlaceholder/);

  // The selector filters to the eligible status and shows a clear, localized empty state.
  assert.match(moduleSource, /isCheckin \? UserCheck : CalendarPlus/);
  assert.match(moduleSource, /orderFlow\.roomCheckinEmpty/);
  // Round 342: the check-in empty state also renders a helper that explains the reservation prerequisite so the
  // cashier is not dead-ended. It is gated to the check-in variant and renders below the empty title.
  assert.match(moduleSource, /orderFlow\.roomCheckinEmptyHint/);
  assert.match(moduleSource, /const emptyHelper = isCheckin/);
  assert.match(moduleSource, /\{emptyHelper && \(/);
  assert.match(moduleSource, /orderFlow\.roomReservationEmpty/);
  assert.match(moduleSource, /orderFlow\.roomCheckinSelectTitle/);
  assert.match(moduleSource, /orderFlow\.roomReservationSelectTitle/);

  // Touch-first, no hover-only affordances anywhere in the module.
  assert.doesNotMatch(moduleSource, /hover:/);
  assert.match(moduleSource, /active:scale-95/);

  // The forms reuse the existing check-in / reservation i18n + service paths (parity with RoomsView).
  assert.match(moduleSource, /roomsView\.newCheckin/);
  assert.match(moduleSource, /roomsView\.newReservation/);
  assert.match(moduleSource, /roomsView\.completeCheckin/);
  assert.match(moduleSource, /roomsView\.createReservation/);
  assert.match(moduleSource, /\/pos\/rooms\/\$\{encodeURIComponent\(room\.id\)\}\/checkin/);
  assert.match(moduleSource, /reservationsService\.createReservation\(/);
});

test('Round 238: the new selector titles + empty states exist in every POS locale', () => {
  const localesDir = path.join(process.cwd(), 'src', 'locales');
  const loadLocale = (lng: string): Record<string, any> =>
    JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));
  const keys = [
    'roomCheckinSelectTitle',
    'roomReservationSelectTitle',
    'roomCheckinEmpty',
    'roomCheckinEmptyHint',
    'roomReservationEmpty',
  ];
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const orderFlow = loadLocale(lng).orderFlow;
    for (const key of keys) {
      assert.equal(typeof orderFlow?.[key], 'string', `${lng} missing orderFlow.${key}`);
      assert.ok(orderFlow[key].length > 0, `${lng} empty orderFlow.${key}`);
    }
  }
  // Greek values are real translations (contain Greek letters), not the English source.
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const key of keys) {
    assert.match(loadLocale('el').orderFlow[key], GREEK, `el orderFlow.${key} should be Greek`);
  }

  // Round 342: the check-in helper names the reservation prerequisite in English, and Greek uses arrival
  // language (άφιξη), never the Latin word "check-in".
  assert.match(loadLocale('en').orderFlow.roomCheckinEmptyHint, /reservation/i);
  assert.match(loadLocale('el').orderFlow.roomCheckinEmptyHint, /άφιξ/, 'el check-in helper should use arrival language');
  assert.doesNotMatch(loadLocale('el').orderFlow.roomCheckinEmptyHint, /check-?in/i, 'el check-in helper must not use Latin "check-in"');
});

// --- Round 238 follow-up (live QA): floor selector + hidden scrollbars on the room pickers --------

const roomStayModuleSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'RoomStayWorkflowModals.tsx'),
    'utf8',
  );

test('Round 238: every New Order room picker has a floor selector that filters the displayed rooms', () => {
  const source = orderDashboardSource();
  const moduleSource = roomStayModuleSource();

  // Shared, compact floor control lives in the module and is reused by all three pickers.
  assert.match(moduleSource, /export const RoomFloorChips: React\.FC<RoomFloorChipsProps>/);
  assert.match(moduleSource, /export const deriveRoomFloors = \(rooms: Room\[\]\): number\[\] =>/);
  // Floor chips: "All floors" + each actual floor, localized via the existing floor keys.
  assert.match(moduleSource, /t\('roomsView\.allFloors', \{ defaultValue: 'All Floors' \}\)/);
  assert.match(moduleSource, /t\('roomsView\.floor', \{ floor, defaultValue: 'Floor \{\{floor\}\}' \}\)/);
  // Nothing meaningful to filter with 0-1 floors -> the control hides itself.
  assert.match(moduleSource, /if \(floors\.length < 2\) return null;/);
  // Touch-first chips, active feedback, no hover-only styling.
  assert.match(moduleSource, /active:scale-95/);
  assert.doesNotMatch(moduleSource, /hover:/);

  // Check-in / reservation selector (module): derives floors, holds a floor filter, resets on reopen,
  // and renders only the rooms on the selected floor.
  assert.match(moduleSource, /const floors = useMemo\(\(\) => deriveRoomFloors\(rooms\), \[rooms\]\);/);
  assert.match(moduleSource, /const \[floorFilter, setFloorFilter\] = useState<number \| 'all'>\('all'\);/);
  assert.match(moduleSource, /if \(isOpen\) setFloorFilter\('all'\);/);
  assert.match(
    moduleSource,
    /floorFilter === 'all' \? rooms : rooms\.filter\(\(room\) => room\.floor === floorFilter\)/,
  );
  assert.match(moduleSource, /<RoomFloorChips floors=\{floors\} value=\{floorFilter\} onChange=\{setFloorFilter\} \/>/);
  assert.match(moduleSource, /\{visibleRooms\.map\(\(room\) => \{/);

  // Room Order selector (dashboard): same shared control, filtering the occupied-room cards by floor.
  assert.match(
    source,
    /import \{[\s\S]*?RoomFloorChips,[\s\S]*?deriveRoomFloors,[\s\S]*?\} from "\.\/modals\/RoomStayWorkflowModals";/,
  );
  assert.match(source, /const roomOrderFloors = useMemo\(\(\) => deriveRoomFloors\(roomOrderRooms\), \[roomOrderRooms\]\);/);
  assert.match(
    source,
    /roomOrderFloor === "all"\s*\? roomOrderRooms\s*: roomOrderRooms\.filter\(\(room\) => room\.floor === roomOrderFloor\)/,
  );
  assert.match(
    source,
    /<RoomFloorChips\s+floors=\{roomOrderFloors\}\s+value=\{roomOrderFloor\}\s+onChange=\{setRoomOrderFloor\}\s*\/>/,
  );
  // The Room Order grid maps the floor-filtered list, not the raw occupied set.
  assert.match(source, /\{visibleRoomOrderRooms\.map\(\(room\) => \{/);
  // Floor is reset to "all" each time the picker opens.
  assert.match(source, /const handleRoomFlowOrder = \(\) => \{[\s\S]*?setRoomOrderFloor\("all"\);/);
});

test('Round 238: the room picker scroll containers hide the native scrollbar (touch POS)', () => {
  const source = orderDashboardSource();
  const moduleSource = roomStayModuleSource();

  // Every scrollable room grid hides the native rail while keeping scroll (overflow-y-auto).
  assert.match(source, /grid max-h-\[60vh\][^"]*overflow-y-auto scrollbar-hide/);
  assert.match(moduleSource, /grid max-h-\[60vh\][^"]*overflow-y-auto scrollbar-hide/);
  // The horizontal floor-chip row also hides its rail.
  assert.match(moduleSource, /flex gap-1\.5 overflow-x-auto scrollbar-hide/);
  // No naked overflow-y-auto room grid is left without scrollbar-hide.
  assert.doesNotMatch(source, /grid max-h-\[60vh\][^"]*overflow-y-auto sm:grid-cols-2"/);
  assert.doesNotMatch(moduleSource, /grid max-h-\[60vh\][^"]*overflow-y-auto sm:grid-cols-2"/);
});

test('Round 238: Room Order empty state explains the open-folio requirement + a Check-in hint, in every locale', () => {
  const source = orderDashboardSource();
  const localesDir = path.join(process.cwd(), 'src', 'locales');
  const loadLocale = (lng: string): Record<string, any> =>
    JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

  // The empty state renders both the primary copy and the secondary Check-in hint.
  assert.match(source, /t\("orderFlow\.roomOrderEmpty"/);
  assert.match(source, /t\("orderFlow\.roomOrderEmptyHint"/);

  // Both keys exist in every locale; English names the folio requirement + Check-in; Greek is translated.
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const orderFlow = loadLocale(lng).orderFlow;
    for (const key of ['roomOrderEmpty', 'roomOrderEmptyHint']) {
      assert.equal(typeof orderFlow?.[key], 'string', `${lng} missing orderFlow.${key}`);
      assert.ok(orderFlow[key].length > 0, `${lng} empty orderFlow.${key}`);
    }
  }
  assert.match(loadLocale('en').orderFlow.roomOrderEmptyHint, /folio/i);
  assert.match(loadLocale('en').orderFlow.roomOrderEmptyHint, /Check-in/i);
  assert.match(loadLocale('el').orderFlow.roomOrderEmptyHint, GREEK);
});

test('Round 238: room workflow buttons follow the cancel=red / confirm=green rule', () => {
  const moduleSource = roomStayModuleSource();

  // Cancel = red destructive glass on both the check-in and reservation forms, with active
  // feedback (active:scale + darker red) and a disabled state.
  const redCancel =
    moduleSource.match(
      /border border-red-400\/40 bg-red-500\/15 py-3 font-medium text-red-300 transition-transform duration-150 active:scale-95 active:bg-red-500\/25 disabled:opacity-50/g,
    ) || [];
  assert.ok(redCancel.length >= 2, `both Cancel buttons must use the red glass treatment (found ${redCancel.length})`);
  assert.match(moduleSource, /onClick=\{onClose\}/);
  // The previous neutral cancel fill is gone.
  assert.doesNotMatch(moduleSource, /bg-white\/10 py-3 font-medium text-white\/80/);

  // Confirm/create = enabled emerald: BOTH Complete Check-in and Create Reservation are emerald.
  // (Round 255 swapped the disabled state from a dimmed-green disabled:opacity-50 to neutral glass.)
  const greenConfirm =
    moduleSource.match(
      /border border-emerald-500 bg-emerald-600 py-3 font-medium text-white transition-transform duration-150 active:scale-95 disabled:bg-zinc-400\/20 disabled:text-zinc-400 disabled:border-zinc-400\/30 disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100/g,
    ) || [];
  assert.ok(greenConfirm.length >= 2, `both submit buttons must be enabled-emerald with neutral disabled glass (found ${greenConfirm.length})`);
  assert.match(moduleSource, /onClick=\{handleCheckin\}/);
  assert.match(moduleSource, /onClick=\{handleReservation\}/);
  // The purple reservation submit is gone (confirm actions are never purple).
  assert.doesNotMatch(moduleSource, /bg-purple-500 py-3/);
  // No emerald confirm button keeps the old dimmed-green disabled:opacity-50 (Cancel still uses red opacity).
  assert.doesNotMatch(moduleSource, /bg-emerald-600[^"]*disabled:opacity-50/);
});

// --- Round 255 (live QA, 1282x802 Greek/dark): roomier room pickers (no clipped last card) +
// neutral disabled room confirm buttons -----------------------------------------------------------

test('Round 255: New Order room pickers are roomier (wider modal, 3-col grid, bottom padding, hidden rail)', () => {
  const source = orderDashboardSource();
  const moduleSource = roomStayModuleSource();

  // The shared selector module (check-in / reservation) uses a wider glass modal + a 3-column grid at
  // large widths, with bottom padding so the final card scrolls fully into view; the hidden native
  // scrollbar is preserved.
  assert.match(
    moduleSource,
    /<LiquidGlassModal isOpen=\{isOpen\} onClose=\{onClose\} title=\{title\} className="!max-w-(2xl|3xl)">/,
  );
  assert.match(
    moduleSource,
    /grid max-h-\[60vh\][^"]*overflow-y-auto scrollbar-hide pb-2 sm:grid-cols-2 lg:grid-cols-3/,
  );
  // The dashboard Room Order selector uses the same roomier treatment.
  assert.match(source, /title=\{t\("orderFlow\.roomOrderTitle"[^}]*\}\)\}\s*className="!max-w-(2xl|3xl)"/);
  assert.match(
    source,
    /grid max-h-\[60vh\][^"]*overflow-y-auto scrollbar-hide pb-2 sm:grid-cols-2 lg:grid-cols-3/,
  );
  // The old narrow 2-column-only grid (no lg:grid-cols-3) is gone.
  assert.doesNotMatch(moduleSource, /grid max-h-\[60vh\][^"]*scrollbar-hide sm:grid-cols-2"/);
  assert.doesNotMatch(source, /grid max-h-\[60vh\][^"]*scrollbar-hide sm:grid-cols-2"/);
});

test('Round 255: room confirm buttons stay enabled-emerald but are neutral/muted glass when disabled', () => {
  const moduleSource = roomStayModuleSource();

  // Both Complete Check-in and Create Reservation: enabled emerald (with border), disabled neutral glass.
  const neutralDisabled =
    moduleSource.match(
      /border border-emerald-500 bg-emerald-600[^"]*disabled:bg-zinc-400\/20 disabled:text-zinc-400 disabled:border-zinc-400\/30 disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100/g,
    ) || [];
  assert.ok(neutralDisabled.length >= 2, `both room confirm buttons must be neutral when disabled (found ${neutralDisabled.length})`);
  // No emerald confirm carries the old dimmed-green opacity; Cancel stays red (its opacity is untouched).
  assert.doesNotMatch(moduleSource, /bg-emerald-600[^"]*disabled:opacity-50/);
  assert.match(
    moduleSource,
    /border border-red-400\/40 bg-red-500\/15[^"]*disabled:opacity-50/,
  );
});

test('Round 255: New Order -> Room module gates are unchanged (Rooms / Orders / Reservations / Check-in)', () => {
  const source = orderDashboardSource();

  // Room card stays Rooms-gated; Room Order stays Orders-gated; Create Reservation stays Reservations-gated.
  assert.match(source, /const hasOrdersModule = hasModule\(MODULE_IDS\.ORDERS\);/);
  assert.match(source, /const hasReservationsModule = hasModule\(MODULE_IDS\.RESERVATIONS\);/);
  assert.match(source, /\{hasOrdersModule && \(\s*<button\s+type="button"\s+onClick=\{handleRoomFlowOrder\}/);
  assert.match(source, /\{hasReservationsModule && \(\s*<button\s+type="button"\s+onClick=\{handleRoomFlowReservation\}/);
  // Check-in is NOT separately gated by Orders/Reservations — it stays under the Rooms card gate only.
  assert.doesNotMatch(source, /\{hasOrdersModule && \(\s*<button\s+type="button"\s+onClick=\{handleRoomFlowCheckin\}/);
  assert.doesNotMatch(source, /\{hasReservationsModule && \(\s*<button\s+type="button"\s+onClick=\{handleRoomFlowCheckin\}/);
  // The Rooms tab content + Services entry gates remain intact.
  assert.match(source, /activeTab === "rooms" && hasRoomsModule \? \(/);
});

// --- Round 239: module-gating hardening for the New Order verticals -------------------------------

test('Round 239: Room workflow actions are gated by their source-of-truth modules', () => {
  const source = orderDashboardSource();

  // Derived gates come from useAcquiredModules / MODULE_IDS — not just a visual flag.
  assert.match(source, /const hasOrdersModule = hasModule\(MODULE_IDS\.ORDERS\);/);
  assert.match(source, /const hasReservationsModule = hasModule\(MODULE_IDS\.RESERVATIONS\);/);

  // Scope to the Room flow chooser modal so adjacency checks are unambiguous.
  const start = source.indexOf('Room Flow Modal (Round 236)');
  const end = source.indexOf('Room Order Selector (Round 236)');
  assert.ok(start >= 0 && end > start, 'room flow chooser region must exist');
  const region = source.slice(start, end);

  // Room Order is the immediate child of the Orders gate; Create Reservation of the Reservations gate.
  assert.match(region, /\{hasOrdersModule && \(\s*<button\s+type="button"\s+onClick=\{handleRoomFlowOrder\}/);
  assert.match(region, /\{hasReservationsModule && \(\s*<button\s+type="button"\s+onClick=\{handleRoomFlowReservation\}/);
  // Check-in is rendered unconditionally inside the (Rooms-gated) chooser — never wrapped by the
  // Orders/Reservations gates.
  assert.match(region, /Rooms-gated\)\. \*\/\}\s*<button\s+type="button"\s+onClick=\{handleRoomFlowCheckin\}/);
  assert.doesNotMatch(region, /\{hasOrdersModule && \(\s*<button\s+type="button"\s+onClick=\{handleRoomFlowCheckin\}/);
  assert.doesNotMatch(region, /\{hasReservationsModule && \(\s*<button\s+type="button"\s+onClick=\{handleRoomFlowCheckin\}/);
});

test('Round 239: vertical tab CONTENT branches require their module, not just the tab button', () => {
  const source = orderDashboardSource();

  // Each content branch is gated by its module.
  assert.match(source, /activeTab === "tables" && hasTablesModule \? \(/);
  assert.match(source, /activeTab === "rooms" && hasRoomsModule \? \(/);
  assert.match(source, /activeTab === "services" && hasServicesModule \? \(/);
  // The bare (module-less) content conditions are gone, so an out-of-band tab can't surface content.
  assert.doesNotMatch(source, /activeTab === "tables" \? \(/);
  assert.doesNotMatch(source, /activeTab === "rooms" \? \(/);
  assert.doesNotMatch(source, /activeTab === "services" \? \(/);
});

test('Round 239: tab changes ignore unavailable modules and reset to orders when a module vanishes', () => {
  const source = orderDashboardSource();

  // handleTabChange refuses module tabs whose module is not acquired (incl. Delivered/Delivery).
  assert.match(
    source,
    /const handleTabChange = useCallback\(\s*\(tab: TabId\) => \{[\s\S]*?if \(tab === "tables" && !hasTablesModule\) return;[\s\S]*?if \(tab === "rooms" && !hasRoomsModule\) return;[\s\S]*?if \(tab === "services" && !hasServicesModule\) return;[\s\S]*?if \(tab === "delivered" && !hasDeliveryModule\) return;/,
  );
  // The callback deps include the module flags so the guard stays current.
  assert.match(source, /\[clearBulkSelection, setFilter, hasTablesModule, hasRoomsModule, hasServicesModule, hasDeliveryModule\]/);

  // A reset effect falls back to the always-available Orders tab if the active vertical's module
  // (tables/rooms/services OR delivered) becomes unavailable mid-session.
  assert.match(
    source,
    /if \(\s*\(activeTab === "tables" && !hasTablesModule\) \|\|\s*\(activeTab === "rooms" && !hasRoomsModule\) \|\|\s*\(activeTab === "services" && !hasServicesModule\) \|\|\s*\(activeTab === "delivered" && !hasDeliveryModule\)\s*\) \{\s*setActiveTab\("orders"\);/,
  );
});

test('Round 239: OrderTypeSelector gates dine-in by Tables, pickup always, delivery by Delivery', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'forms', 'OrderTypeSelector.tsx'),
    'utf8',
  );

  assert.match(source, /const \{ hasDeliveryModule, hasTablesModule \} = useAcquiredModules\(\);/);
  // dine-in only with Tables; pickup unconditional; delivery only with Delivery.
  assert.match(source, /if \(hasTablesModule\) \{\s*types\.push\("dine-in"\);\s*\}/);
  assert.match(source, /types\.push\("pickup"\);/);
  assert.match(source, /if \(hasDeliveryModule\) \{\s*types\.push\("delivery"\);\s*\}/);
  // The old always-include-dine-in seed is gone.
  assert.doesNotMatch(source, /\["dine-in", "pickup"\]/);
  // Grid columns adapt to 1, 2, or 3 options.
  assert.match(
    source,
    /availableOrderTypes\.length === 3[\s\S]*?'grid-cols-3'[\s\S]*?availableOrderTypes\.length === 2[\s\S]*?'grid-cols-2'[\s\S]*?'grid-cols-1'/,
  );
  // The supplied table/pickup icons are unchanged (no fallback to emoji/cake glyphs).
  assert.match(source, /<TableOrderIcon className="w-6 h-6" \/>/);
  assert.match(source, /<PickupOrderIcon className="w-6 h-6" \/>/);
});

// Round 264 (live QA): the legacy forms/OrderTypeSelector still used blue selected styling + a blue
// focus ring. It now uses the POS yellow/amber selected treatment (yellow + black text in light, warm
// yellow glass in dark), neutral glass inactive, rounded-2xl modern cards, and active-only press
// feedback (no blue, no hover, no native title). Module gating + the supplied icons are unchanged.
test('Round 264: legacy OrderTypeSelector uses POS yellow selection (no blue), modern cards, active-only', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'forms', 'OrderTypeSelector.tsx'),
    'utf8',
  );

  // No blue selected fill or blue focus ring anywhere on the component.
  assert.doesNotMatch(source, /blue/);
  // Selected = yellow/amber with black text (light) + warm yellow glass (dark); yellow focus ring.
  assert.match(source, /border-yellow-400 bg-yellow-400 text-black/);
  assert.match(source, /border-yellow-400\/50 bg-yellow-400\/15 text-yellow-200/);
  assert.match(source, /focus:ring-yellow-400\/40/);
  // Modern touch-first cards: rounded-2xl, centered, min touch size, active press only (no hover).
  assert.match(source, /rounded-2xl/);
  assert.match(source, /flex flex-col items-center justify-center min-h-\[88px\]/);
  assert.match(source, /active:scale-\[0\.98\]/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /\btitle=/);

  // Module gating preserved: dine-in with Tables, pickup always, delivery with Delivery.
  assert.match(source, /if \(hasTablesModule\) \{\s*types\.push\("dine-in"\);\s*\}/);
  assert.match(source, /types\.push\("pickup"\);/);
  assert.match(source, /if \(hasDeliveryModule\) \{\s*types\.push\("delivery"\);\s*\}/);

  // Supplied icons preserved (TableOrderIcon / PickupOrderIcon / Truck); no Utensils/Cake/Store/Package.
  assert.match(source, /<TableOrderIcon className="w-6 h-6" \/>/);
  assert.match(source, /<PickupOrderIcon className="w-6 h-6" \/>/);
  assert.match(source, /<Truck className="w-6 h-6" \/>/);
  assert.doesNotMatch(source, /Utensils|Cake|Store|Package/);
});

test('Round 236 fix: a room-charge dine-in order opens PaymentModal instead of bypassing to a table payment', () => {
  const menuModalSource = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'MenuModal.tsx'),
    'utf8',
  );
  const tableFlowSource = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'utils', 'tableOrderFlow.ts'),
    'utf8',
  );

  // The bypass helper now short-circuits to false when a room charge is present, so a room-charge
  // dine-in order is NOT auto-submitted as a pending table payment.
  assert.match(tableFlowSource, /hasRoomCharge\?: boolean;/);
  assert.match(tableFlowSource, /if \(input\.hasRoomCharge\) \{\s*return false;\s*\}/);
  // Normal dine-in/table orders (no room charge) still bypass to a pending table payment.
  assert.match(tableFlowSource, /return input\.orderType === 'dine-in' \|\| Boolean\(String\(input\.tableNumber \|\| ''\)\.trim\(\)\);/);

  // MenuModal passes hasRoomCharge derived from a valid roomChargeContext (roomId + active folio).
  assert.match(
    menuModalSource,
    /shouldBypassPaymentForTableOrder\(\{[\s\S]*?hasRoomCharge: Boolean\(roomChargeContext\?\.roomId && roomChargeContext\?\.activeFolioId\),[\s\S]*?\}\)/,
  );

  // The payment path is exposed (PaymentModal opens) and PaymentModal receives roomChargeContext so
  // the room_charge tender can be selected and charged to the folio.
  assert.match(menuModalSource, /setShowPaymentModal\(true\);/);
  assert.match(menuModalSource, /<PaymentModal[\s\S]*?roomChargeContext=\{roomChargeContext\}/);
});

test('Round 236 fix: room-order handler clears stale table context before opening the menu', () => {
  const source = orderDashboardSource();
  const start = source.indexOf('const handleRoomOrderRoomSelect = (room: Room) => {');
  const end = source.indexOf('setShowMenuModal(true);', start);
  assert.ok(start >= 0 && end > start, 'handleRoomOrderRoomSelect must exist');
  const handler = source.slice(start, end);

  // Stale table flow state is explicitly cleared so a prior table order cannot leak
  // table_number / table_id / table_session into the room-charge order.
  assert.match(handler, /setSelectedTable\(null\);/);
  assert.match(handler, /setTableNumber\(""\);/);
  assert.match(handler, /setTableGuestCount\(1\);/);

  // The clears happen before the room-charge context is set and the menu opens.
  assert.ok(
    handler.indexOf('setSelectedTable(null)') < handler.indexOf('setRoomChargeContext('),
    'table state must be cleared before roomChargeContext is set',
  );
});

// Round 231 (live QA): the standalone Τραπέζια page (TablesPage.tsx) showed status filters but no visible
// floor selector (floor was not even in the filter popover). It now has a direct, touch-first floor strip
// under the stats row and above the grid, deriving floors from real table metadata and composing with the
// status + search filters. Localized via the existing (fully-translated) tableSelector.floor* keys.
test('Round 231: standalone TablesPage has a touch-first floor selector composing with status/search', () => {
  const source = tablesPageSource();

  // Floor-value helper using the shared convention (floorLevel ?? floor_level ?? 1).
  assert.match(source, /const getTableFloorValue = \(table: RestaurantTable\): string => \{/);
  assert.match(source, /table\.floorLevel \?\? \(table as \{ floor_level\?: number \| null \}\)\.floor_level \?\? 1/);

  // Local floorFilter state defaults to 'all'.
  assert.match(source, /const \[floorFilter, setFloorFilter\] = useState<string>\('all'\)/);

  // Floor options derived from real table metadata, numeric-then-lexical sort.
  assert.match(source, /const floorOptions = useMemo\(\(\) => \{/);
  assert.match(source, /Array\.from\(new Set\(tables\.map\(getTableFloorValue\)\)\)/);
  assert.match(source, /Number\.isFinite\(na\) && Number\.isFinite\(nb\)\) return na - nb/);

  // Floor filtering composes with status + search inside filteredTables, and is in its deps.
  assert.match(source, /if \(floorFilter !== 'all'\) \{\s*result = result\.filter\(t => getTableFloorValue\(t\) === floorFilter\);/);
  assert.match(source, /\}, \[tables, filter, searchTerm, floorFilter\]\)/);
  assert.match(source, /if \(filter\.statusFilter && filter\.statusFilter !== 'all'\)/);
  assert.match(source, /if \(searchTerm\) \{/);

  // floorFilter participates in hasActiveFilters and is reset by handleClearFilters.
  assert.match(source, /const hasActiveFilters = filter\.statusFilter !== 'all' \|\| searchTerm !== '' \|\| floorFilter !== 'all'/);
  assert.match(source, /const handleClearFilters = useCallback\(\(\) => \{[\s\S]*?setFloorFilter\('all'\);/);

  // The visible floor selector strip (own marker) with All floors + a button per floor.
  const selStart = source.indexOf('data-tables-floor-selector');
  assert.notEqual(selStart, -1, 'floor selector strip marker must exist');
  const sel = source.slice(selStart, source.indexOf('{/* Error Banner */}', selStart));
  assert.match(sel, /onClick=\{\(\) => setFloorFilter\('all'\)\}/);
  assert.match(sel, /aria-pressed=\{floorFilter === 'all'\}/);
  assert.match(sel, /floorOptions\.map\(\(floor\) =>/);
  assert.match(sel, /onClick=\{\(\) => setFloorFilter\(floor\)\}/);
  assert.match(sel, /aria-pressed=\{floorFilter === floor\}/);

  // Touch-safe: 44px centred buttons with active feedback; no hover / no native title in the strip.
  assert.match(sel, /min-h-\[44px\] items-center justify-center/);
  assert.match(sel, /active:scale-95/);
  assert.doesNotMatch(sel, /hover:/);
  assert.doesNotMatch(sel, /\btitle=/);

  // Localized labels (existing, fully-translated floor keys), no hardcoded Greek in the strip.
  assert.match(sel, /t\('tableSelector\.floor', \{ defaultValue: 'Floor' \}\)/);
  assert.match(sel, /t\('tableSelector\.allFloors', \{ defaultValue: 'All floors' \}\)/);
  assert.match(sel, /t\('tableSelector\.floorNumber', \{ defaultValue: 'Floor \{\{floor\}\}', floor \}\)/);
  assert.doesNotMatch(sel, new RegExp('[\\u0370-\\u03FF]'));

  // The used floor labels exist in all five POS locales (Greek a real translation, {{floor}} preserved).
  const localesDir = path.join(process.cwd(), 'src', 'locales');
  const loadLocale = (lng: string): Record<string, any> =>
    JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const ts = loadLocale(lng).tableSelector;
    for (const key of ['floor', 'allFloors', 'floorNumber']) {
      assert.equal(typeof ts[key], 'string', `${lng} tableSelector.${key} missing`);
      assert.ok(ts[key].length > 0, `${lng} tableSelector.${key} empty`);
    }
    assert.match(ts.floorNumber, /\{\{floor\}\}/, `${lng} tableSelector.floorNumber must interpolate {{floor}}`);
  }
  assert.notEqual(
    loadLocale('el').tableSelector.allFloors,
    loadLocale('en').tableSelector.allFloors,
    'el tableSelector.allFloors must be a Greek translation',
  );
  assert.match(loadLocale('el').tableSelector.floor, new RegExp('[\\u0370-\\u03FF]'));
});

// --- Round 246 (live QA): Orders bulk-action bar palette/touch polish ----------------------------
// The non-semantic toolbar actions (Edit, View, Clear, Assign/Return/Map) read off-theme blue/slate.
// They are re-themed to neutral glass / amber (Edit), with green/red kept for success/destructive.
// Behaviour, handlers and localized labels are unchanged.

const bulkActionsBarSource = () =>
  readFileSync(path.join(process.cwd(), 'src', 'renderer', 'components', 'BulkActionsBar.tsx'), 'utf8');

test('Round 246: bulk-action bar has no off-theme blue/slate, no hover/title, and 44px touch targets', () => {
  const source = bulkActionsBarSource();

  // No off-theme blue/slate colour CLASSES anywhere (comments may still mention the words).
  assert.doesNotMatch(source, /(?:bg|text|border|ring|shadow|from|to|via)-(?:slate|blue|indigo|sky|cyan|violet|purple)-\d/);

  // Touch POS: press feedback only, no hover-only utilities, no native title tooltips.
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /[^a-zA-Z]title=/);
  assert.match(source, /active:scale-95/);
  // Normal buttons keep a >=44px touch target with centered icon+text.
  assert.match(source, /min-h-\[40px\] sm:min-h-\[44px\]/);
  assert.match(source, /flex items-center justify-center/);
});

test('Round 246: bulk-action variants encode meaning — green success, red danger, amber Edit, neutral utilities', () => {
  const source = bulkActionsBarSource();

  // Success (Delivered) stays green; danger (Cancel) stays red.
  assert.match(source, /case 'success':[\s\S]*?bg-emerald-600[\s\S]*?bg-emerald-500\/90/);
  assert.match(source, /case 'danger':[\s\S]*?bg-red-500[\s\S]*?bg-red-500\/90/);

  // Warning = amber utility — used by Edit.
  assert.match(source, /case 'warning':[\s\S]*?bg-amber-500[\s\S]*?bg-amber-500\/90/);
  // Both Edit buttons (delivery + pickup selection) use the amber warning variant, not info/slate.
  const editButtons = source.match(/getButtonStyles\('warning'\)\} onClick=\{\(e\) => \{ e\.preventDefault\(\); onBulkAction\('edit'\); \}\}/g) || [];
  assert.ok(editButtons.length >= 2, `both Edit buttons must use the amber warning variant (found ${editButtons.length})`);

  // Non-semantic utility actions (Assign/Return/Map/View/Clear) collapse to one neutral glass (zinc),
  // never an off-theme fill.
  assert.match(
    source,
    /const neutralGlass =[\s\S]*?bg-white\/80 text-zinc-700 border-zinc-300[\s\S]*?bg-zinc-800\/80 text-zinc-100 border-zinc-600\/50/,
  );
  assert.match(
    source,
    /case 'primary':\s*case 'secondary':\s*case 'info':\s*case 'map':\s*case 'neutral':\s*return `\$\{baseStyles\} \$\{neutralGlass\}`;/,
  );
  // View and Clear render through the neutral variant (View compact); Assign/Map through neutral too.
  assert.match(source, /getButtonStyles\('neutral', true\)\} onClick=\{\(e\) => \{ e\.preventDefault\(\); onBulkAction\('view'\); \}\}/);
  assert.match(source, /onClearSelection\(\);[\s\S]*?className=\{getButtonStyles\('neutral'\)\}/);
  assert.match(source, /getButtonStyles\('primary'\)\} onClick=\{\(e\) => \{ e\.preventDefault\(\); onBulkAction\('assign'\)/);
  assert.match(source, /getButtonStyles\('map'\)\} onClick=\{\(e\) => \{ e\.preventDefault\(\); onBulkAction\('map'\)/);
});

test('Round 246: selection-count chip is on-theme (neutral + amber ring), and labels/handlers are preserved', () => {
  const source = bulkActionsBarSource();

  // Count chip: neutral fill + a subtle amber ring (no slate).
  assert.match(source, /bg-zinc-100\/80 border-amber-400\/50 text-zinc-800/);
  assert.match(source, /bg-zinc-800\/60 border-amber-400\/40 text-zinc-100/);

  // Localized labels + bulk handlers are unchanged (no behaviour/data-flow change).
  for (const key of ['delivered', 'edit', 'cancel', 'map', 'view', 'clear', 'driver']) {
    assert.match(source, new RegExp(`t\\('bulkActions\\.${key}'\\)`), `bulkActions.${key} label must be preserved`);
  }
  for (const action of ['assign', 'delivered', 'edit', 'cancel', 'map', 'view']) {
    assert.match(source, new RegExp(`onBulkAction\\('${action}'\\)`), `onBulkAction('${action}') must be preserved`);
  }
  assert.match(source, /onClearSelection\(\)/);
});

// Round 285: module-gate verification. The Service card opens the embedded AppointmentsView booking flow,
// and its gate is INTENTIONALLY `appointments || service_catalog` (OR), not tightened: appointment
// CREATION is independently backend-validated in handleCreateAppointment, so a service-catalog org that
// lacks the appointments backend cannot persist a booking. The room-flow gates stay strict per action.
test('Round 285: Service card OR-gate is intentional + documented, and room gates stay strict per action', () => {
  const source = orderDashboardSource();

  // Services gate stays OR, and the source documents WHY it is not overexposed (booking is backend-gated).
  assert.match(source, /const hasServicesModule = hasAppointmentsModule \|\| hasServiceCatalogModule;/);
  assert.match(source, /Round 285[\s\S]*?handleCreateAppointment[\s\S]*?gate stays OR/);

  // Room-flow gates remain strict: Room card = Rooms; Room Order = Orders; Create Reservation =
  // Reservations; Check-in is NOT separately Orders/Reservations gated (it stays under the Rooms card).
  assert.match(source, /\{hasRoomsModule && \(/);
  assert.match(source, /\{hasOrdersModule && \(\s*<button\s+type="button"\s+onClick=\{handleRoomFlowOrder\}/);
  assert.match(source, /\{hasReservationsModule && \(\s*<button\s+type="button"\s+onClick=\{handleRoomFlowReservation\}/);
  assert.doesNotMatch(source, /\{hasOrdersModule && \(\s*<button\s+type="button"\s+onClick=\{handleRoomFlowCheckin\}/);
  assert.doesNotMatch(source, /\{hasReservationsModule && \(\s*<button\s+type="button"\s+onClick=\{handleRoomFlowCheckin\}/);
});

// Round 348 (live QA regression hardening): OrderTabsBar keeps all six semantic tab colors; inactive label
// AND counter are grey; only the active tab glows; no hover utilities. Source already matches; this locks it.
test('Round 348: OrderTabsBar full color map, inactive label+counter grey, active-only neon, no hover', () => {
  const source = orderTabsBarSource();

  // Full active text-color map (all six tab identities).
  assert.match(source, /green: 'text-green-500'/);
  assert.match(source, /orange: 'text-\[#f97316\]'/);
  assert.match(source, /blue: 'text-\[#3b82f6\]'/);
  assert.match(source, /red: 'text-red-500'/);
  assert.match(source, /purple: 'text-\[#a855f7\]'/);
  assert.match(source, /teal: 'text-\[#14b8a6\]'/);

  // Each tab id keeps its semantic color (orders/delivered/tables/rooms/services/canceled).
  assert.match(source, /id: 'orders',[\s\S]*?color: 'green'/);
  assert.match(source, /id: 'delivered',[\s\S]*?color: 'orange'/);
  assert.match(source, /id: 'tables',[\s\S]*?color: 'blue'/);
  assert.match(source, /id: 'rooms',[\s\S]*?color: 'purple'/);
  assert.match(source, /id: 'services',[\s\S]*?color: 'teal'/);
  assert.match(source, /id: 'canceled',[\s\S]*?color: 'red'/);

  // Inactive (label and counter) is neutral grey; only the active tab gets neon.
  assert.match(source, /if \(!isActive\) \{[\s\S]*?return isDark \? 'text-zinc-400' : 'text-gray-600';/);
  // Both the label (withGlow=true) and the counter (withGlow=false) route through tabTextClass.
  assert.match(source, /\{tab\.label\}/);
  assert.match(source, /\{tab\.count\}/);
  assert.match(source, /tabTextClass\(tab\.color, activeTab === tab\.id, resolvedTheme === 'dark', true\)/);
  assert.match(source, /tabTextClass\(tab\.color, activeTab === tab\.id, resolvedTheme === 'dark', false\)/);

  // Touch-first: no hover utilities in the tab bar.
  assert.doesNotMatch(source, /hover:/);
});

// Round 348: the main order-type modal table card uses TableOrderIcon with a blue title and no food/store
// placeholder glyph -- guarded on BOTH order-taking paths (OrderDashboard + OrderFlow), scoped to the card.
test('Round 348: order-type table card uses TableOrderIcon + blue title (OrderDashboard + OrderFlow)', () => {
  const checks = [
    { name: 'OrderDashboard', src: orderDashboardSource(), open: 'handleOrderTypeSelect("dine-in")' },
    { name: 'OrderFlow', src: orderFlowSource(), open: "handleSelectOrderType('dine-in')" },
  ];
  for (const { name, src, open } of checks) {
    const start = src.indexOf(open);
    assert.notEqual(start, -1, `${name} dine-in card must exist`);
    const card = src.slice(start, src.indexOf('</button>', start) + '</button>'.length);
    assert.match(card, /<TableOrderIcon/, `${name} table card must use the shared TableOrderIcon`);
    assert.match(card, /text-\[#60a5fa\]/, `${name} table card title must stay blue`);
    assert.doesNotMatch(card, /Cake|Utensils|Fork|\bStore\b|\bPackage\b/, `${name} table card must not use a food/store glyph`);
  }
});
