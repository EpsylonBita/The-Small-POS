import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

const globalsSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'styles', 'globals.css'),
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

test('OrderDashboard keeps table controls fixed while only the table grid scrolls', () => {
  const dashboardSource = orderDashboardSource();
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
    /<div className="shrink-0 space-y-3">/,
    'table filters should live in a non-scrolling header region',
  );
  assert.match(
    dashboardSource,
    /<div className="grid h-full min-h-0 grid-rows-\[auto_minmax\(0,1fr\)\] gap-4">/,
    'embedded table dashboard should use a fixed header row plus a bounded scroll row',
  );
  assert.match(
    standaloneSource,
    /<div className="mb-4 shrink-0 space-y-3">/,
    'standalone table filters should live in a non-scrolling header region',
  );
  assert.match(
    standaloneSource,
    /<div className="grid min-h-0 min-w-0 flex-1 grid-rows-\[auto_minmax\(0,1fr\)\] overflow-hidden" onWheel=\{handleTableGridWheel\}>/,
    'standalone table dashboard should use a fixed header row plus a bounded scroll row',
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
        `data-testid="${testIdPrefix}-table-grid-container"[\\s\\S]*className="h-\\[calc\\(100dvh-30rem\\)\\] min-h-56 overflow-hidden"`,
      ),
      'the table cards should be clipped by a bounded grid container below the controls',
    );
    assert.match(
      source,
      new RegExp(
        `data-testid="${testIdPrefix}-table-grid-container"[\\s\\S]*ref=\\{tableGridScrollRef\\}[\\s\\S]*data-testid="${testIdPrefix}-table-scroll-region"[\\s\\S]*className="h-full min-h-0 overflow-y-auto overflow-x-hidden pr-1 scrollbar-hide touch-scroll"`,
      ),
      'the grid container should expose one full-size scroll surface',
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
});

test('table floor plan uses scoped modern scrollbars instead of native rails', () => {
  const floorPlanSource = tableFloorPlanSource();
  const cssSource = globalsSource();

  assert.match(
    floorPlanSource,
    /floor-plan-scrollbar/,
    'the 2D floor plan should opt into scoped scrollbar styling',
  );
  assert.match(cssSource, /\.floor-plan-scrollbar\s*\{/);
  assert.match(cssSource, /scrollbar-width:\s*thin;/);
  assert.match(cssSource, /\.floor-plan-scrollbar::-webkit-scrollbar\s*\{[\s\S]*width:\s*8px;[\s\S]*height:\s*8px;/);
  assert.match(cssSource, /\.floor-plan-scrollbar::-webkit-scrollbar-track,[\s\S]*background:\s*transparent;/);
  assert.doesNotMatch(
    floorPlanSource,
    /className=\{`h-full min-h-\[360px\] overflow-auto rounded-xl/,
    'the floor plan should not expose unstyled native overflow scrollbars',
  );
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
    /table\.status === 'cleaning'\s*\?\s*t\('tables\.setCleaned', 'Cleaned'\)\s*:\s*table\.status === 'maintenance'\s*\?\s*t\('tables\.markBackInService', 'Back in service'\)\s*:\s*t\('tables\.setAvailable', 'Set Available'\)/,
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
    /status: 'maintenance', label: t\('tables\.setMaintenance', 'Set Maintenance'\)/,
    'standalone status modal should expose setting a table to maintenance',
  );
  assert.match(
    tablesPage,
    /table\.status === 'maintenance'\s*\?\s*t\('tables\.markBackInService', 'Back in service'\)/,
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
    /const handleTableNoShowReservation = useCallback\(async \(\) => \{[\s\S]*updateStatus\(reservation\.id, "no_show"\)[\s\S]*updateTableStatus\(selectedTable\.id, "available"\)/,
    'main flow should mark no-show reservations and release the table',
  );
  assert.match(
    dashboardSource,
    /const handleTableCancelReservation = useCallback\(async \(\) => \{[\s\S]*cancelReservation\(reservation\.id[\s\S]*updateTableStatus\(selectedTable\.id, "available"\)/,
    'main flow should cancel reservations and release the table',
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
