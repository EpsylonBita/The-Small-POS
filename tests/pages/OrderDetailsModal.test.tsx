import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider } from '../../src/renderer/contexts/theme-context';
import { I18nProvider } from '../../src/renderer/contexts/i18n-context';
import { resetBridge, setBridge } from '../../src/lib';
import OrderDetailsModal from '../../src/renderer/components/modals/OrderDetailsModal';

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
    assert.equal(html.match(/ORD-11052026-00004/g)?.length, 1);
    assert.doesNotMatch(html, /bg-gradient-to-br/);
  assert.match(html, /absolute right-4 top-3/);
    assert.match(html, /px-6 pb-6 pt-16/);
    assert.doesNotMatch(html, /overflow-hidden p-6 pr-24/);
    assert.match(html, /border-red-500\/70[\s\S]*bg-black[\s\S]*text-center[\s\S]*text-red-400[\s\S]*Cancellation Reason[\s\S]*text-2xl[\s\S]*text-white[\s\S]*deleted/);
  } finally {
    resetBridge();
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
