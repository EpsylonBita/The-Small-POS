import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider } from '../../src/renderer/contexts/theme-context';
import { I18nProvider } from '../../src/renderer/contexts/i18n-context';
import { resetBridge, setBridge } from '../../src/lib';
import OrderDetailsModal from '../../src/renderer/components/modals/OrderDetailsModal';

const projectRoot = process.cwd();
const orderDetailsModalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'OrderDetailsModal.tsx');

function installOrderDetailsBridgeMock() {
  setBridge({
    orders: {
      getById: async () => ({ success: true, order: null }),
      getByCustomerPhone: async () => ({ success: true, orders: [] }),
    },
    payments: {
      getOrderPayments: async () => [],
      getPaidItems: async () => [],
    },
    settings: {
      getLanguage: async () => 'en',
      setLanguage: async () => ({ success: true }),
    },
  } as any);
}

function renderOrderDetails(order: any) {
  installOrderDetailsBridgeMock();

  return renderToStaticMarkup(
    <I18nProvider>
      <ThemeProvider>
        <OrderDetailsModal
          isOpen
          orderId={order.id}
          order={order}
          onClose={() => undefined}
        />
      </ThemeProvider>
    </I18nProvider>,
  );
}

test('OrderDetailsModal gives cancelled pickup orders a clear three-card layout', () => {
  try {
    const html = renderOrderDetails({
      id: 'order-1',
      order_number: 'ORD-11052026-00004',
      order_type: 'pickup',
      status: 'cancelled',
      payment_method: 'card',
      payment_status: 'paid',
      cancellation_reason: 'deleted',
      created_at: '2026-05-11T18:22:00.000Z',
      subtotal: 4.2,
      total_amount: 4.2,
      items: [
        {
          id: 'item-1',
          name: 'Hawaiian',
          quantity: 1,
          price: 4.2,
          total_price: 4.2,
          category_path: 'Crepe',
        },
      ],
    });

    assert.match(html, /Order Information/);
    assert.match(html, /Items/);
    assert.match(html, /Order History/);
    assert.match(html, /Cancellation Reason/);
    assert.match(html, /deleted/);
    assert.match(html, /Cancelled/);
    assert.doesNotMatch(html, />Pending</);
    assert.doesNotMatch(html, />Processing</);
    assert.doesNotMatch(html, /Customer[\s\S]{0,160}Pickup/);
    assert.match(html, /ORD #00004/);
    assert.doesNotMatch(html, /ORD-11052026-00004/);
    assert.doesNotMatch(html, /bg-gradient-to-br/);
    assert.match(html, /absolute right-4 top-3/);
    // Compact restyle: the scroll body uses px-6 pt-16 pb-24 (was px-6 pb-6 pt-16).
    assert.match(html, /px-6 pt-16 pb-24/);
    assert.doesNotMatch(html, /overflow-hidden p-6 pr-24/);
    assert.match(html, /border-red-500\/70[\s\S]*bg-black[\s\S]*text-center[\s\S]*text-red-400[\s\S]*Cancellation Reason[\s\S]*text-2xl[\s\S]*text-white[\s\S]*deleted/);
  } finally {
    resetBridge();
  }
});

test('OrderDetailsModal formats kiosk order numbers and hides routing metadata notes', () => {
  try {
    const html = renderOrderDetails({
      id: 'order-3',
      order_number: 'K-d28cef2e-20260611-090934-0002',
      order_type: 'pickup',
      status: 'confirmed',
      payment_method: 'cash',
      payment_status: 'pending',
      special_instructions: 'Kiosk source: Pickup - Alex -> Test Terminal',
      customer_name: 'Alex',
      customer_phone: '69478128412',
      created_at: '2026-06-12T11:19:00.000Z',
      total_amount: 2.36,
      items: [
        {
          id: 'item-1',
          name: 'Sweet Crepe',
          quantity: 1,
          price: 2.36,
          total_price: 2.36,
        },
      ],
    });

    assert.match(html, /K #0002/);
    assert.doesNotMatch(html, /K-d28cef2e-20260611-090934-0002/);
    assert.doesNotMatch(html, /Kiosk source/);
    assert.doesNotMatch(html, /Service Notes/);
    assert.match(html, /Payment Method/);
    assert.match(html, /Payment status: Pending/);
    // Compact restyle: the Payment Method info icon is semantic emerald (was blue).
    assert.match(html, /flex h-5 w-5 shrink-0 items-center justify-center text-emerald-600/);
    assert.doesNotMatch(html, /flex h-11 w-11 items-center justify-center rounded-2xl/);
    assert.doesNotMatch(html, /bg-blue-500\/15/);
    assert.doesNotMatch(html, /bg-sky-500\/15/);
    assert.doesNotMatch(html, /bg-emerald-500\/15/);
    assert.doesNotMatch(html, /bg-violet-500\/15/);
  } finally {
    resetBridge();
  }
});

test('OrderDetailsModal resolves kiosk item categories and customization ingredients from menu catalog', () => {
  const source = readFileSync(orderDetailsModalPath, 'utf8');

  assert.match(source, /menuService\.getMenuItems\(\)/);
  assert.match(source, /menuService\.getMenuCategories\(\)/);
  assert.match(source, /menuService\.getIngredients\(\)/);
  assert.match(source, /flattenOrderCustomizationInput/);
  assert.match(source, /parsed\.added/);
  assert.match(source, /catalogLookups\.ingredientsById\.get/);
  assert.match(source, /catalogMenuItem\?\.categoryName/);
  assert.match(source, /catalogLookups\.categoriesById\.get/);
  assert.match(source, /item\.customizations \?\? item\.modifiers \?\? item\.ingredients \?\? item\.selectedIngredients/);
  assert.match(source, /resolveItemName\(item\)/);
});

test('OrderDetailsModal keeps item totals and history labels visually clean', () => {
  const source = readFileSync(orderDetailsModalPath, 'utf8');

  assert.match(source, /min-w-8 shrink-0 pt-0\.5 text-sm font-bold text-orange-600 dark:text-orange-200/);
  assert.doesNotMatch(source, /rounded-2xl border border-orange-300\/60 bg-orange-50/);
  assert.doesNotMatch(source, /@\s*\{formatCurrency\(item\.unit_price \|\| item\.price \|\| 0\)\}/);
  assert.match(source, /text-yellow-500 dark:text-yellow-300/);
  assert.match(source, /text-xs font-semibold text-emerald-600 dark:text-emerald-300/);
  assert.doesNotMatch(source, /rounded-full border border-emerald-300\/70 bg-emerald-50 px-3 py-1/);
});

// Touch POS scrollbar policy: the inner item list used a styled native `custom-scrollbar`; it now
// uses the same hidden rail as the modal body. Every scroll region keeps its scroll but hides the
// native scrollbar.
test('OrderDetailsModal scroll regions use the hidden touch rail (no custom-scrollbar)', () => {
  const source = readFileSync(orderDetailsModalPath, 'utf8');

  assert.doesNotMatch(source, /custom-scrollbar/, 'custom-scrollbar must be replaced by scrollbar-hide');
  // The inner item list keeps overflow-y-auto (scroll preserved) but hides the rail.
  assert.match(source, /flex-1 overflow-y-auto space-y-3 scrollbar-hide/);

  const classAttrs = source.match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) ?? [];
  const scrollers = classAttrs.filter((cls) => /\boverflow-y-auto\b/.test(cls));
  assert.ok(scrollers.length >= 2, `expected the order-details scroll regions, found ${scrollers.length}`);
  for (const cls of scrollers) {
    assert.match(cls, /\bscrollbar-hide\b/, `order-details scroll region must hide its native scrollbar: ${cls}`);
  }
});

test('OrderDetailsModal shows a history empty state for pickup orders without customer contact data', () => {
  try {
    const html = renderOrderDetails({
      id: 'order-2',
      order_number: 'ORD-11052026-00005',
      order_type: 'pickup',
      status: 'cancelled',
      payment_method: 'card',
      payment_status: 'paid',
      created_at: '2026-05-11T18:25:00.000Z',
      total_amount: 6,
      items: [],
    });

    assert.match(html, /No customer history available/);
    assert.match(html, /Reason not recorded/);
  } finally {
    resetBridge();
  }
});
