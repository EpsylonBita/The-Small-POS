import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';

import { resolveTableServiceCustomerNumber } from '../../src/renderer/utils/tableOrderFlow';

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
const ordersPageSource = read('src/renderer/pages/OrdersPage.tsx');
const orderDetailsSource = read('src/renderer/components/modals/OrderDetailsModal.tsx');
const orderFlowSource = read('src/renderer/components/OrderFlow.tsx');
const newOrderPageSource = read('src/renderer/pages/NewOrderPage.tsx');

const localesDir = path.join(process.cwd(), 'src', 'locales');
const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

const createT = async (lng: string) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: loadLocale('en') },
      el: { translation: loadLocale('el') },
      de: { translation: loadLocale('de') },
      fr: { translation: loadLocale('fr') },
      it: { translation: loadLocale('it') },
    },
    interpolation: { escapeValue: false },
  });
  return instance.getFixedT(lng);
};

test('resolveTableServiceCustomerNumber formats table-service orders via the shared convention', () => {
  assert.equal(resolveTableServiceCustomerNumber({ order_type: 'dine-in', table_number: 'B01' }), '#TB01');
  assert.equal(resolveTableServiceCustomerNumber({ order_type: 'dine-in', table_number: 'P01' }), '#TP01');
  assert.equal(resolveTableServiceCustomerNumber({ order_type: 'dine-in', table_number: 'TP01' }), '#TP01');
  assert.equal(resolveTableServiceCustomerNumber({ order_type: 'dine-in', table_number: 'T06' }), '#T06');
  // camelCase table number is handled too.
  assert.equal(resolveTableServiceCustomerNumber({ order_type: 'dine-in', tableNumber: 'B01' }), '#TB01');
});

test('resolveTableServiceCustomerNumber returns null for pickup/delivery/normal orders (real customer kept)', () => {
  assert.equal(resolveTableServiceCustomerNumber({ order_type: 'pickup', customer_name: 'John Smith' }), null);
  assert.equal(resolveTableServiceCustomerNumber({ order_type: 'delivery', customer_name: 'Maria' }), null);
  assert.equal(resolveTableServiceCustomerNumber({ customer_name: 'Walk-in' }), null);
  // A real customer name that happens to contain a digit is still not reformatted.
  assert.equal(resolveTableServiceCustomerNumber({ order_type: 'pickup', customer_name: 'Agent 7' }), null);
});

test('resolveTableServiceCustomerNumber recovers the table from the pseudo-customer name when table_number is absent', () => {
  // Live repro shape: stored customer_name "Τραπέζι B01" with no separate table_number.
  assert.equal(
    resolveTableServiceCustomerNumber({ order_type: 'dine-in', customer_name: 'Τραπέζι B01' }),
    '#TB01',
  );
  // An already-formatted label is idempotent.
  assert.equal(
    resolveTableServiceCustomerNumber({ order_type: 'dine-in', customer_name: 'Τραπέζι #TB01' }),
    '#TB01',
  );
});

test('table pseudo-customer renders localized "Τραπέζι #TB01", never raw "Τραπέζι B01" or English', async () => {
  const order = { order_type: 'dine-in', table_number: 'B01', customer_name: 'Τραπέζι B01' };
  const tableNumber = resolveTableServiceCustomerNumber(order);
  assert.equal(tableNumber, '#TB01');

  const el = await createT('el');
  const en = await createT('en');
  assert.equal(el('orderFlow.tableCustomer', { table: tableNumber }), 'Τραπέζι #TB01');
  assert.equal(en('orderFlow.tableCustomer', { table: tableNumber }), 'Table #TB01');
  // The pre-fix raw label must not be what staff see.
  assert.notEqual(el('orderFlow.tableCustomer', { table: tableNumber }), 'Τραπέζι B01');
});

test('OrdersPage row renders the derived table-customer label, not the raw customer_name', () => {
  assert.match(ordersPageSource, /import \{ resolveTableServiceCustomerNumber \} from '\.\.\/utils\/tableOrderFlow';/);
  assert.match(ordersPageSource, /const tableCustomerNumber = resolveTableServiceCustomerNumber\(order as any\)/);
  assert.match(ordersPageSource, /t\('orderFlow\.tableCustomer', \{ table: tableCustomerNumber \}\)/);
  assert.match(ordersPageSource, /<span>\{customerDisplayName\}<\/span>/);
  // The raw customer_name is no longer rendered straight into the row.
  assert.doesNotMatch(ordersPageSource, /<span>\{order\.customer_name\}<\/span>/);
});

test('OrderDetailsModal customer panel uses the shared table-customer display', () => {
  assert.match(orderDetailsSource, /import \{ resolveTableServiceCustomerNumber \} from '\.\.\/\.\.\/utils\/tableOrderFlow';/);
  assert.match(orderDetailsSource, /const tableCustomerNumber = resolveTableServiceCustomerNumber\(displayOrder\)/);
  assert.match(
    orderDetailsSource,
    /customerIdentityName = tableCustomerNumber[\s\S]*?t\('orderFlow\.tableCustomer', \{ table: tableCustomerNumber \}\)/,
  );
});

test('dine-in order creation builds the table pseudo-customer through formatTableDisplayNumber', () => {
  assert.match(
    orderFlowSource,
    /t\('orderFlow\.tableCustomer', \{ table: formatTableDisplayNumber\(selectedTable\.tableNumber\) \}\)/,
  );
  assert.match(
    newOrderPageSource,
    /t\('orderFlow\.tableCustomer', \{ table: formatTableDisplayNumber\(tableNumber\) \}\)/,
  );
  // The old raw-number / wrong-key creation paths are gone.
  assert.doesNotMatch(orderFlowSource, /tableCustomer', \{ table: selectedTable\.tableNumber \}/);
  assert.doesNotMatch(newOrderPageSource, /t\('tables\.tableNumber', 'Table \{\{number\}\}', \{ number: tableNumber \}\)/);
});
