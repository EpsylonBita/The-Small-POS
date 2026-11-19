// Read-only source extraction: execute the real pure line mappers, without booting Next/Supabase.
// Run from pos-tauri: node scripts/generate-order-header-shape-fixtures.cjs [--check]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.resolve(root, p), 'utf8');
function evaluate(source, expression) {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, Map };
  vm.runInNewContext(js + '\nexports.result = ' + expression, context);
  return context.exports.result;
}
const route = read('../admin-dashboard/src/app/api/pos/orders/sync/route.ts');
const ast = ts.createSourceFile('route.ts', route, ts.ScriptTarget.Latest, true);
const names = new Set(['normalizeOptionalText', 'normalizeNumberField', 'asRecord', 'asRecordArray',
  'firstNonEmptyText', 'normalizePosOrderItemsForSync', 'ordinaryItemFiscalFacts', 'folioSettlementItemFacts',
  'ORDINARY_ITEM_FISCAL_FIELDS', 'FOLIO_SETTLEMENT_ITEM_FIELDS']);
const nodes = ast.statements.filter(n => names.has(n.name?.text) ||
  (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.has(d.name.text))));
if (nodes.length !== names.size) throw Error('Route mapper dependency list changed');
const hydrate = evaluate(nodes.map(n => n.getText(ast)).join('\n'), 'normalizePosOrderItemsForSync');
const service = read('../admin-dashboard/src/services/pos/pos-orders-api-service.ts');
const serviceAst = ts.createSourceFile('service.ts', service, ts.ScriptTarget.Latest, true);
const methods = new Map();
function visit(n) { if (ts.isMethodDeclaration(n)) methods.set(n.name?.getText(serviceAst), n); ts.forEachChild(n, visit); }
visit(serviceAst);
function mapper(name) {
  const method = methods.get(name);
  if (!method) throw Error(`${name} mapper not found`);
  return evaluate('class Mapper { ' + method.getText(serviceAst) + ' }', `(new Mapper()).${name}.bind(new Mapper())`);
}
const insert = mapper('mapOrderItemsForInsert');
const mapAck = mapper('mapOrderItem');
const normalize = evaluate(read('src/shared/utils/pos-order-items.ts'), 'normalizePosOrderItem');
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const menu = id(10), retail = id(20), combo = id(30);
const base = { id: 'cart-line', menuItemId: menu, name: 'Item', quantity: 1, price: 14.5, customizations: [] };
const cases = [
  ['menu_ingredients', { customizations: [{ ingredient: { id: id(40), name: 'Extra', price: 1, category_id: id(41) }, quantity: 1, isExtra: true }] }],
  ['manual_tomikro', { id: 'manual-1794879583843-z0t3gg2w0', menuItemId: null, isManual: true, is_manual: true, fiscalDocumentProfile: 'manual_item' }],
  ['price_override', { price: 12, originalUnitPrice: 14.5, isPriceOverridden: true }],
  ['combo', { id: 'combo-cart', menuItemId: combo, is_combo: true, combo_id: combo, combo_type: 'fixed', combo_items: [{ subcategory_id: menu, name: 'Item', quantity: 2, unit_price: 7.25 }] }],
  ['deposit', { id: 'manual', menuItemId: null, is_manual: true, line_role: 'deposit' }],
  ['retail_product', { id: retail, menuItemId: retail, retail_product_id: retail }],
  ['retail_variant', { id: retail, menuItemId: retail, retail_product_id: retail, retail_variant_id: id(21), quantity: 0.5 }],
  ['service', { id: id(49), menuItemId: null, service_id: id(50), staff_id: id(51) }],
  ['appointment', { id: id(49), menuItemId: null, service_id: id(50), appointment_id: id(52), staff_id: id(51) }],
  ['notes', { notes: 'No salt' }],
  ['quantity_many', { quantity: 3 }],
  ['voided_line', {}],
  ['hydrated_name', {}],
];
const fixtures = cases.map(([name, patch], index) => {
  const local = normalize({ ...base, ...patch });
  const source = { ...local };
  // Native normalize_order_insert_items converts an ingredient array to a map.
  source.customizations = Array.isArray(local.customizations)
    ? Object.fromEntries(local.customizations.map((v, i) => [v.ingredient?.id || `item-${i}`, v])) : local.customizations;
  // sanitizer: explicit retail IDs move out of menu_item_id; an unknown combo
  // UUID is not a menu/subcategory/retail UUID. Native insertion drops combo fields.
  if (source.retail_product_id || name === 'combo') source.menu_item_id = null;
  const computed = { source, quantity: local.quantity, unitPrice: local.unit_price,
    grossUnitPrice: local.unit_price, netUnitPrice: local.unit_price, grossAmount: local.total_price,
    netAmount: local.total_price, vatAmount: 0, vatRate: 0, vatCategoryCode: null,
    priceIncludesVat: true, taxExemptionReason: null, fiscalDocumentProfile: local.fiscal_document_profile,
    lineKind: source.menu_item_id || source.service_id ? 'item' : 'manual_item' };
  const raw = insert(id(100), [computed]);
  raw[0].id = id(200 + index);
  raw[0].is_voided = false;
  raw[0].notes ??= null;
  // The current insert mapper omits these DB columns; existing stored combo
  // columns are covered separately, without claiming the create path writes them.
  // 20260128192309_menu_combos_system.sql: is_combo defaults false, ids/contents null.
  Object.assign(raw[0], { is_combo: false, combo_id: null, combo_items: null });
  if (name === 'hydrated_name') raw[0].menu_item_name = null;
  const databaseRows = JSON.parse(JSON.stringify(raw));
  if (name === 'voided_line') databaseRows.push({ ...raw[0], id: id(299), is_voided: true, quantity: 2 });
  const hydrated = hydrate(databaseRows, new Map([[menu, { name: 'Item' }]]));
  // hydrateOrderItemsForPos applies exactly this filter to the raw relation too.
  const filteredRaw = databaseRows.filter(item => item.is_voided !== true);
  return { name, local: [local], ackItems: filteredRaw.map(mapAck), raw: filteredRaw, hydrated, databaseRows,
    createMatches: !['combo', 'retail_product', 'retail_variant'].includes(name) };
});
const output = JSON.stringify({ sources: ['normalizePosOrderItem', 'mapOrderItemsForInsert', 'mapOrderItem', 'normalizePosOrderItemsForSync'], fixtures }, null, 2) + '\n';
const target = path.join(root, 'src-tauri/src/tests/fixtures/order-header-shapes.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== output) throw Error('Line fixture stale: regenerate from current mappers');
} else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, output); }
console.log(`${fixtures.length} line-shape fixtures ${process.argv.includes('--check') ? 'verified' : 'generated'} from production mappers`);
