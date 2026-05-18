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
