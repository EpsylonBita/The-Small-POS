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
  assert.match(source, /border border-white\/80 bg-white text-black hover:bg-zinc-200/);
  assert.match(source, /border border-black bg-black text-white hover:bg-zinc-800/);
  assert.match(source, /hover:scale-\[1\.03\]/);
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

test('InventoryPage history translation keys exist in every POS locale', () => {
  const requiredKeys = [
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
