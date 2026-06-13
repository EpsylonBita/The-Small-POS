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

test('CustomerDisplayPage is connected to POS display API and desktop/TV outputs', () => {
  const source = customerDisplaySource();

  assert.match(source, /\/api\/pos\/customer-display\?limit=200/);
  assert.match(source, /useOrderStore/);
  assert.match(source, /getOrderIdentifier\(order, findLocalOrderForDisplayRow\(order\)\)/);
  assert.match(source, /formatCompactOrderNumberForDisplay/);
  assert.match(source, /client_order_id/);
  assert.match(source, /break-words/);
  assert.match(source, /contentType: CUSTOMER_DISPLAY_CONTENT_TYPE/);
  assert.match(source, /\/display\/customer\/\$\{encodeURIComponent/);
  assert.match(source, /externalDisplay'\) === CUSTOMER_DISPLAY_CONTENT_TYPE/);
  assert.match(source, /scrollbar-hide/);
  assert.match(source, /pending', 'preparing', 'ready'/);
  assert.doesNotMatch(source, /<Tv className=/);
  assert.match(source, /'truncate text-3xl font-bold tracking-tight'/);
  assert.match(source, /title=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.match(source, /border border-white\/80 bg-white text-black hover:bg-zinc-200/);
  assert.match(source, /border border-black bg-black text-white hover:bg-zinc-800/);
  assert.match(source, /<RefreshCw className=\{`w-5 h-5 \$\{isRefreshing \? 'animate-spin' : ''\}`\} \/>/);
  assert.match(source, /border border-cyan-500\/40 bg-transparent px-3 py-2 text-sm font-semibold text-white/);
  assert.match(source, /rounded-xl border bg-transparent px-4 py-3 \$\{meta\.border\}/);
  assert.match(source, /isDark \? 'border-zinc-800 bg-transparent' : 'border-slate-200 bg-transparent'/);
  assert.match(source, /rounded-full bg-transparent/);
  assert.doesNotMatch(source, /border-cyan-500\/40 bg-cyan-500\/10/);
  assert.doesNotMatch(source, /bg-sky-500\/10/);
  assert.doesNotMatch(source, /bg-amber-500\/10/);
  assert.doesNotMatch(source, /phase\.bg/);
});

test('KitchenDisplayPage keeps API-scoped tickets and exposes desktop/TV outputs', () => {
  const source = kitchenDisplaySource();

  assert.match(source, /\/api\/pos\/kds\?status=\$\{statusParam\}&include_live_drafts=true&scope=terminal/);
  assert.match(source, /terminalId\s*\?\s*matchesKdsTerminal\(ticket, terminalId, localOrder\)\s*:\s*true/);
  assert.match(source, /localOrderLookup\.get\(readKdsString\(ticket, 'client_order_id'\)\)/);
  assert.match(source, /getKdsVisibleOrderNumber\(localOrder, ticket\)/);
  assert.match(source, /formatCompactOrderNumberForDisplay\(order\.order_number\)/);
  assert.match(source, /dedupeKeys/);
  assert.match(source, /grid-cols-\[repeat\(auto-fit,minmax\(320px,1fr\)\)\]/);
  assert.match(source, /contentType: KITCHEN_DISPLAY_CONTENT_TYPE/);
  assert.match(source, /\/api\/pos\/kds-display/);
  assert.match(source, /\/display\/kds\/\$\{encodeURIComponent/);
  assert.match(source, /scrollbar-hide/);
  assert.doesNotMatch(source, /<ChefHat className=\{`w-6 h-6/);
  assert.doesNotMatch(source, /<h1 className="text-xl font-bold">\{t\('kitchen\.title', 'Kitchen Display'\)\}<\/h1>/);
  assert.match(source, /<h1 className="truncate text-3xl font-bold tracking-tight">/);
  assert.match(source, /title=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.match(source, /border border-white\/80 bg-white text-black hover:bg-zinc-200/);
  assert.match(source, /border border-black bg-black text-white hover:bg-zinc-800/);
  assert.match(source, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);
  assert.match(source, /p-3 rounded-xl border border-cyan-500\/40 bg-transparent text-white disabled:opacity-60/);
  assert.doesNotMatch(source, /p-3 rounded-xl border border-cyan-500\/40 bg-cyan-500\/10 text-cyan-300 hover:bg-cyan-500\/20 disabled:opacity-60/);
  assert.match(source, /bg-yellow-400 text-black border-yellow-400/);
  assert.match(source, /const getOrderTypeTextColor = \(type: string\): string =>/);
  assert.match(source, /<span className=\{`text-xs font-medium \$\{getOrderTypeTextColor\(order\.order_type\)\}`\}>/);
  assert.match(source, /<span className="text-xs font-medium text-cyan-400">/);
  assert.doesNotMatch(source, /getOrderTypeBadgeColor/);
  assert.doesNotMatch(source, /px-2 py-1 rounded-full text-xs font-medium \$\{getOrderType/);
  assert.doesNotMatch(source, /px-2 py-1 rounded-full text-xs font-medium \$\{isDark \? 'bg-cyan-500\/20 text-cyan-300' : 'bg-cyan-100 text-cyan-700'\}/);
  assert.match(source, /<AlertTriangle className="w-5 h-5 text-yellow-500" \/>/);
  assert.match(source, /<ChefHat className="w-5 h-5 text-blue-500" \/>/);
  assert.match(source, /<CheckCircle className="w-5 h-5 text-green-500" \/>/);
  assert.match(source, /<Timer className="w-5 h-5 text-cyan-500" \/>/);
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
    'externalDisplay.copyTvLink',
    'externalDisplay.open',
    'externalDisplay.stop',
    'externalDisplay.connectedDisplays',
    'externalDisplay.help',
    'externalDisplay.running',
    'externalDisplay.stopped',
    'externalDisplay.openFailed',
    'externalDisplay.closeFailed',
    'externalDisplay.tvLinkCopied',
    'externalDisplay.tvLinkFailed',
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
