import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const customerDisplayPagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'CustomerDisplayPage.tsx');
const kitchenDisplayPagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'KitchenDisplayPage.tsx');
const systemUiPath = path.join(projectRoot, 'src-tauri', 'src', 'commands', 'system_ui.rs');
const localesDir = path.join(projectRoot, 'src', 'locales');

const customerDisplaySource = () => readFileSync(customerDisplayPagePath, 'utf8');
const kitchenDisplaySource = () => readFileSync(kitchenDisplayPagePath, 'utf8');
const systemUiSource = () => readFileSync(systemUiPath, 'utf8');

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

test('CustomerDisplayPage reads local orders and projects them natively to desktop/TV outputs', () => {
  const source = customerDisplaySource();

  // Local owner: a native read of the local SQLite orders, refreshed by local order events and the
  // central order store. The retired hosted display API and customer TV link must not return.
  assert.match(source, /const orders: unknown = await bridge\.orders\.getAll\(\);/);
  assert.match(source, /const LOCAL_ORDER_EVENTS = \['order-created', 'order-status-updated', 'order-deleted'\];/);
  assert.match(source, /useOrderStore/);
  assert.doesNotMatch(source, /\/api\/pos\//, 'the customer display must not read a hosted POS API');
  assert.doesNotMatch(source, /\/display\/customer\//, 'the hosted customer TV link is retired');
  assert.doesNotMatch(source, /\bfetch\(/, 'the customer display has no network transport');
  // Rows stay tenant- and terminal-scoped and are deduplicated across every order identity.
  assert.match(
    source,
    /!matchesKdsTenant\(organizationId \|\| null, branchId \|\| null, order\) \|\| !matchesKdsTerminal\(terminalId \|\| null, order\)/,
  );
  assert.match(source, /const keys = getKdsRecordIdentityKeys\(order\);/);
  assert.match(source, /order_number: getOrderIdentifier\(order, keys\[0\]\)/);
  assert.match(source, /formatCompactOrderNumberForDisplay/);
  assert.match(source, /break-words/);
  // Desktop/TV output: a native external window fed by a native snapshot, never a hosted page.
  assert.match(
    source,
    /bridge\.externalDisplay\.open\(externalOpenParams\(CUSTOMER_DISPLAY_CONTENT_TYPE, display, presentation\.ownedToken\)\)/,
  );
  assert.match(source, /publishCustomerDisplaySnapshot\(snapshot\)/);
  const projectionSource = readFileSync(path.join(projectRoot, 'src', 'renderer', 'services', 'CustomerDisplayQrOverlay.ts'), 'utf8');
  assert.match(projectionSource, /getBridge\(\)\.invoke\('customer-display-publish', snapshot\)/);
  assert.match(projectionSource, /lease\.scope === currentTwintScope\(\)/);
  assert.match(source, /getBridge\(\)\.invoke\('customer-display-snapshot'\)/);
  assert.match(source, /externalDisplay'\) === CUSTOMER_DISPLAY_CONTENT_TYPE/);
  assert.match(source, /scrollbar-hide/);
  assert.match(source, /pending', 'preparing', 'ready'/);
  assert.doesNotMatch(source, /<Tv className=/);
  assert.match(source, /'truncate text-3xl font-bold tracking-tight'/);
  assert.doesNotMatch(source, /\btitle=/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /blue-|cyan-|purple-|pink-|indigo-|orange-|sky-/);
  assert.match(source, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.match(source, /border border-white\/80 bg-white text-black active:bg-zinc-200/);
  assert.match(source, /border border-black bg-black text-white active:bg-zinc-800/);
  assert.match(source, /<RefreshCw className=\{`w-5 h-5 \$\{isRefreshing \? 'animate-spin' : ''\}`\} \/>/);
  assert.match(source, /border-amber-400\/40 bg-amber-500\/10 text-amber-200 active:bg-amber-500\/20/);
  assert.match(source, /rounded-xl border bg-transparent px-4 py-3 \$\{meta\.border\}/);
  assert.match(source, /isDark \? 'border-zinc-800 bg-transparent' : 'border-slate-200 bg-transparent'/);
  assert.match(source, /rounded-full bg-transparent/);
  assert.match(source, /color: 'text-yellow-400'/);
  assert.match(source, /border: 'border-yellow-400\/40'/);
  assert.match(source, /rounded-2xl border border-dashed px-4 text-center text-lg/);
  assert.match(source, /isDark \? 'border-white\/15' : 'border-slate-300'/);
  assert.doesNotMatch(source, /rounded-xl border border-dashed border-white\/15/);
  assert.doesNotMatch(source, /phase\.bg/);
});

test('KitchenDisplayPage keeps terminal-scoped local tickets and exposes desktop/TV outputs', () => {
  const source = kitchenDisplaySource();

  // Local owner: tickets come from the local order store plus same-scope in-memory live cart
  // drafts. The retired hosted KDS API, KDS display endpoint and TV link must not return.
  assert.match(source, /const localOrders = useOrderStore\(\(state\) => state\.orders\);/);
  assert.match(source, /useSyncExternalStore\(subscribeKdsLocalDrafts, getKdsLocalDrafts\)/);
  assert.match(source, /\.filter\(\(draft\) => draft\.scope === identityScope\)/);
  assert.doesNotMatch(source, /\/api\/pos\//, 'the kitchen display must not read a hosted POS API');
  assert.doesNotMatch(source, /\/display\/kds\//, 'the hosted kitchen TV link is retired');
  assert.doesNotMatch(source, /\bfetch\(/, 'the kitchen display has no network transport');
  assert.doesNotMatch(source, /copyTvLink|tvLinkCopied|tvLinkFailed/, 'the retired kitchen TV-link actions must not return');
  // Tickets stay terminal- and tenant-scoped and are deduplicated across every order identity.
  assert.match(
    source,
    /!matchesKdsTerminal\(terminalId, record\) \|\| !matchesKdsTenant\(organizationId, branchId, record\)/,
  );
  assert.match(source, /const keys = getKdsRecordIdentityKeys\(record\);\s*if \(keys\.some\(\(key\) => seen\.has\(key\)\)\) return;/);
  assert.match(source, /getKdsVisibleOrderNumber\(order\) \|\| id/);
  assert.match(source, /formatCompactOrderNumberForDisplay\(order\.order_number\)/);
  assert.match(source, /grid-cols-\[repeat\(auto-fit,minmax\(320px,1fr\)\)\]/);
  // Desktop/TV output: a native external window fed by a native snapshot, never a hosted page.
  assert.match(
    source,
    /bridge\.externalDisplay\.open\(externalOpenParams\(KITCHEN_DISPLAY_CONTENT_TYPE, display, presentation\.ownedToken\)\)/,
  );
  assert.match(source, /getBridge\(\)\.invoke\('kds-display-publish', snapshot\)/);
  assert.match(source, /getBridge\(\)\.invoke\('kds-display-snapshot'\)/);
  assert.match(source, /scrollbar-hide/);
  assert.doesNotMatch(source, /<ChefHat className=\{`w-6 h-6/);
  assert.doesNotMatch(source, /<h1 className="text-xl font-bold">\{t\('kitchen\.title', 'Kitchen Display'\)\}<\/h1>/);
  assert.match(source, /<h1 className="truncate text-3xl font-bold tracking-tight">/);
  assert.doesNotMatch(source, /\btitle=/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /blue-|cyan-|purple-|pink-|indigo-|orange-/);
  assert.match(source, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.match(source, /border border-white\/80 bg-white text-black active:bg-zinc-200/);
  assert.match(source, /border border-black bg-black text-white active:bg-zinc-800/);
  assert.match(source, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);
  assert.match(source, /border-amber-400\/40 bg-amber-500\/10 text-amber-200 active:bg-amber-500\/20/);
  assert.match(source, /bg-yellow-400 text-black border-yellow-400/);
  assert.match(source, /const getOrderTypeTextColor = \(type: string\): string =>/);
  assert.match(source, /<span className=\{`text-xs font-medium \$\{getOrderTypeTextColor\(order\.order_type\)\}`\}>/);
  assert.match(source, /<span className="text-xs font-medium text-amber-400">/);
  assert.doesNotMatch(source, /getOrderTypeBadgeColor/);
  assert.doesNotMatch(source, /px-2 py-1 rounded-full text-xs font-medium \$\{getOrderType/);
  assert.match(source, /<AlertTriangle className="w-5 h-5 text-yellow-500" \/>/);
  assert.match(source, /<ChefHat className="w-5 h-5 text-amber-500" \/>/);
  assert.match(source, /<CheckCircle className="w-5 h-5 text-green-500" \/>/);
  assert.match(source, /<Timer className="w-5 h-5 text-slate-500" \/>/);
  assert.doesNotMatch(source, /p-2 rounded-lg bg-(yellow|blue|green|cyan)-500\/20/);
});

test('Tauri native system UI commands can open dedicated display windows', () => {
  const source = systemUiSource();

  assert.match(source, /pub async fn display_list_monitors/);
  assert.match(source, /pub async fn display_open_window/);
  assert.match(source, /pub async fn display_close_window/);
  assert.match(source, /WebviewWindowBuilder::new/);
  assert.match(source, /index\.html\?externalDisplay=\{content_type\}/);
});

test('Display page translation keys exist in every POS locale', () => {
  const customerDisplayKeys = [
    'title',
    'subtitle',
    'loading',
    'empty',
    'orderLine',
    'displaySession',
    'phases.received',
    'phases.preparing',
    'phases.ready',
    'sentences.received',
    'sentences.preparing',
    'sentences.ready',
    'descriptions.received',
    'descriptions.preparing',
    'descriptions.ready',
    'actions.copyTvLink',
    'actions.externalDisplay',
    'actions.stopExternal',
    'external.monitors',
    'external.help',
    'status.connected',
    'status.enabled',
    'status.ready',
    'notices.externalRunning',
    'notices.externalStopped',
    'notices.tvLinkCopied',
    'errors.fetchRowsFailed',
    'errors.startExternalFailed',
    'errors.stopExternalFailed',
    'errors.createTvLinkFailed',
  ];
  // The kitchen TV-link actions are retired and the page no longer consumes their keys.
  const kitchenKeys = [
    'title',
    'subtitle',
    'pollingFallback',
    'pending',
    'preparing',
    'total',
    'avgTime',
    'min',
    'allStations',
    'justNow',
    'startPreparing',
    'markReady',
    'orderBumped',
    'bumpError',
    'loadError',
    'noOrders',
    'noOrdersDesc',
    'externalDisplay.open',
    'externalDisplay.stop',
    'externalDisplay.connectedDisplays',
    'externalDisplay.help',
    'externalDisplay.running',
    'externalDisplay.stopped',
    'externalDisplay.openFailed',
    'externalDisplay.closeFailed',
    'view.list',
    'view.grid',
    'sound.disable',
    'sound.enable',
    'autoRefresh.pause',
    'autoRefresh.resume',
  ];

  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();

  for (const file of localeFiles) {
    const locale = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
    const customerDisplayAvailable = flattenKeys(locale.customerDisplay);
    const kitchenAvailable = flattenKeys(locale.kitchen);
    const missingCustomerDisplay = customerDisplayKeys.filter(key => !customerDisplayAvailable.has(key));
    const missingKitchen = kitchenKeys.filter(key => !kitchenAvailable.has(key));

    assert.deepEqual(
      [...missingCustomerDisplay.map(key => `customerDisplay.${key}`), ...missingKitchen.map(key => `kitchen.${key}`)],
      [],
      `${file} is missing display translations`,
    );
  }
});
