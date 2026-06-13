import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ordersPageSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'pages', 'OrdersPage.tsx'),
    'utf8',
  );

const orderDashboardSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderDashboard.tsx'),
    'utf8',
  );

const orderGridSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderGrid.tsx'),
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
  assert.match(source, /title=\{refreshLabel\}/);
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

test('OrdersPage keeps the filter toggle inside the search bar', () => {
  const source = ordersPageSource();

  assert.match(
    source,
    /<input[\s\S]*<button\s+type="button"\s+onClick=\{\(\) => setShowFilters\(!showFilters\)\}[\s\S]*aria-label=\{filterLabel\}[\s\S]*<Filter className="w-5 h-5" \/>/,
    'filter toggle should render as an icon-only action at the right side of the search control',
  );
  assert.match(source, /const filterLabel = showFilters \? 'Hide filters' : 'Show filters';/);
  assert.doesNotMatch(source, /\{\/\* Filter Toggle \*\/\}/);
  assert.doesNotMatch(source, /flex items-center gap-2 px-4 py-2\.5 rounded-xl text-sm border/);
  assert.doesNotMatch(source, /\{showFilters \? 'Hide Filters' : 'Show Filters'\}/);
  assert.doesNotMatch(source, /rounded-lg border px-3 text-sm font-semibold/);
});

test('OrdersPage renders row chips without wrappers and uses yellow metadata icons', () => {
  const source = ordersPageSource();

  assert.match(source, /getOrderStatusTextClasses/);
  assert.match(source, /<span className=\{`text-xs font-semibold \$\{getOrderStatusTextClasses\(order\.status\)\}`\}>/);
  assert.match(source, /flex items-center gap-1 text-xs font-medium/);
  assert.match(source, /<User className=\{`w-4 h-4 \$\{isDark \? 'text-yellow-300' : 'text-yellow-600'\}`\} \/>/);
  assert.match(source, /<Phone className=\{`w-4 h-4 \$\{isDark \? 'text-yellow-300' : 'text-yellow-600'\}`\} \/>/);
  assert.match(source, /<Package className=\{`w-4 h-4 \$\{isDark \? 'text-yellow-300' : 'text-yellow-600'\}`\} \/>/);
  assert.doesNotMatch(source, /getOrderStatusBadgeClasses/);
  assert.doesNotMatch(source, /px-2 py-1 rounded-full text-xs font-medium \$\{getStatusBadge\(order\.status\)\}/);
  assert.doesNotMatch(source, /flex items-center gap-1 px-2 py-1 rounded-full text-xs/);
  assert.doesNotMatch(source, /<User className="w-4 h-4 opacity-50" \/>/);
  assert.doesNotMatch(source, /<Phone className="w-4 h-4 opacity-50" \/>/);
  assert.doesNotMatch(source, /<Package className="w-4 h-4 opacity-50" \/>/);
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
