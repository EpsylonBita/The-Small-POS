/**
 * A store that never bought the tables module has no Τραπέζια tab, so an order
 * classified as a table check had nowhere left to go: it left the Orders tab and
 * was simply gone. Two paid dine-in orders (29/08 and 03/09/2026) were still
 * pending at such a store weeks later, and a pickup whose note mentioned a table
 * used to leave the tab the same way.
 *
 * This mounts the real OrderGrid and OrderCard and checks what each tab renders
 * while the tables module is available, unavailable, still loading, and while it
 * changes with no restart.
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  orders: [] as Record<string, unknown>[],
  hasTablesModule: true,
}));

vi.mock('react-i18next', async () => {
  const { useTranslationEn } = await import('../../test/en-translate');
  return {
    useTranslation: useTranslationEn,
    initReactI18next: { type: '3rdParty', init: () => {} },
  };
});

vi.mock('../../contexts/theme-context', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: () => {} }),
}));

vi.mock('../../../lib', () => ({
  getBridge: () => ({
    customers: { lookupByPhone: vi.fn(async () => null) },
  }),
}));

vi.mock('../../utils/plugin-icons', () => ({
  PluginIcon: () => null,
  isExternalPlatform: () => false,
}));

vi.mock('../order/OrderStatusControls', () => ({
  OrderStatusControls: () => null,
}));

vi.mock('../../hooks/useOrderStore', () => ({
  useOrderStore: () => ({
    orders: mocks.orders,
    filter: { status: 'all', orderType: 'all', searchTerm: '' },
    isLoading: false,
  }),
}));

// The real module context, as the grid sees it. `hasTablesModule` is false while
// the module list is loading or a refresh failed, which is exactly the state the
// last test exercises.
vi.mock('../../hooks/useAcquiredModules', () => ({
  useAcquiredModules: () => ({ hasTablesModule: mocks.hasTablesModule }),
}));

import OrderGrid from '../OrderGrid';

afterEach(() => cleanup());
beforeEach(() => {
  mocks.hasTablesModule = true;
});

const createdAt = new Date(Date.now() - 5 * 60_000).toISOString();

function order(overrides: Record<string, unknown>) {
  return {
    status: 'pending',
    payment_method: 'cash',
    payment_status: 'paid',
    customer_phone: '',
    total_amount_cents: 500,
    created_at: createdAt,
    ...overrides,
  };
}

/** A real table check: dine-in, seated at a table the POS knows. */
const seatedCheck = order({
  id: 'ord-70',
  order_number: 'ORD-22092026-00070',
  order_type: 'dine-in',
  table_id: 'table-5',
  table_number: '5',
  customer_name: 'Τραπέζι 5',
});

/** A delivery whose note mentions a table, as delivery notes often do. */
const deliveryWithTableNote = order({
  id: 'ord-71',
  order_number: 'ORD-22092026-00071',
  order_type: 'pickup',
  customer_name: 'Μαρία',
  notes: 'τραπέζι 5, δίπλα στο παράθυρο',
});

function renderTab(activeTab: 'orders' | 'delivered' | 'canceled') {
  return render(
    <OrderGrid selectedOrders={[]} onToggleOrderSelection={() => {}} activeTab={activeTab} />,
  );
}

describe('Orders tab and the tables module', () => {
  it('keeps a pickup whose note mentions a table on the tab, module or not', () => {
    mocks.orders = [deliveryWithTableNote];

    const { rerender } = renderTab('orders');
    expect(screen.getByText(/#00071/)).toBeInTheDocument();

    mocks.hasTablesModule = false;
    rerender(
      <OrderGrid selectedOrders={[]} onToggleOrderSelection={() => {}} activeTab="orders" />,
    );
    expect(screen.getByText(/#00071/)).toBeInTheDocument();
  });

  it('keeps a delivery for a customer named with a number on the tab, module or not', () => {
    mocks.orders = [
      order({
        id: 'ord-44',
        order_number: 'ORD-21092026-00044',
        order_type: 'delivery',
        customer_name: '12',
        delivery_address: 'Iliados 10',
      }),
    ];

    renderTab('orders');
    expect(screen.getByText(/#00044/)).toBeInTheDocument();

    cleanup();
    mocks.hasTablesModule = false;
    renderTab('orders');
    expect(screen.getByText(/#00044/)).toBeInTheDocument();
  });

  it('sends a real table check to the Τραπέζια tab only when that tab exists', () => {
    mocks.orders = [seatedCheck];

    renderTab('orders');
    expect(screen.queryByText(/#00070/)).toBeNull();
    expect(screen.getByText('No orders found')).toBeInTheDocument();

    cleanup();
    mocks.hasTablesModule = false;
    renderTab('orders');
    expect(screen.getByText(/#00070/)).toBeInTheDocument();
  });

  it('moves the check between the lanes when the module changes, with no restart', () => {
    mocks.orders = [seatedCheck, deliveryWithTableNote];

    const { rerender } = renderTab('orders');
    expect(screen.queryByText(/#00070/)).toBeNull();
    expect(screen.getByText(/#00071/)).toBeInTheDocument();

    // The module is acquired (or its list finally loads) while the screen is up.
    mocks.hasTablesModule = false;
    rerender(
      <OrderGrid selectedOrders={[]} onToggleOrderSelection={() => {}} activeTab="orders" />,
    );
    expect(screen.getByText(/#00070/)).toBeInTheDocument();
    expect(screen.getByText(/#00071/)).toBeInTheDocument();

    mocks.hasTablesModule = true;
    rerender(
      <OrderGrid selectedOrders={[]} onToggleOrderSelection={() => {}} activeTab="orders" />,
    );
    expect(screen.queryByText(/#00070/)).toBeNull();
    expect(screen.getByText(/#00071/)).toBeInTheDocument();
  });

  it('leaves the delivered and cancelled tabs to their own statuses', () => {
    const settledCheck = order({
      ...seatedCheck,
      id: 'ord-72',
      order_number: 'ORD-22092026-00072',
      status: 'completed',
    });
    const cancelledCheck = order({
      ...seatedCheck,
      id: 'ord-73',
      order_number: 'ORD-22092026-00073',
      status: 'cancelled',
    });
    mocks.orders = [settledCheck, cancelledCheck];
    mocks.hasTablesModule = false;

    // A settled or cancelled check is never dragged back into the active lane:
    // the statuses a closed Z leaves behind stay where they were.
    renderTab('orders');
    expect(screen.getByText('No orders found')).toBeInTheDocument();

    cleanup();
    renderTab('delivered');
    expect(screen.getByText(/#00072/)).toBeInTheDocument();
    expect(screen.queryByText(/#00073/)).toBeNull();

    cleanup();
    renderTab('canceled');
    expect(screen.getByText(/#00073/)).toBeInTheDocument();
    expect(screen.queryByText(/#00072/)).toBeNull();

    // With the module back, the delivered tab hands its checks to Τραπέζια.
    cleanup();
    mocks.hasTablesModule = true;
    renderTab('delivered');
    expect(screen.queryByText(/#00072/)).toBeNull();

    // A cancelled order is never hidden by the tables module either way.
    cleanup();
    renderTab('canceled');
    expect(screen.getByText(/#00073/)).toBeInTheDocument();
  });

  it('shows every order while the module list is unavailable', () => {
    // Loading, offline, or a refresh that failed: the context reports no modules.
    // Nothing may disappear because module data was momentarily missing.
    mocks.orders = [seatedCheck, deliveryWithTableNote];
    mocks.hasTablesModule = false;

    renderTab('orders');
    expect(screen.getByText(/#00070/)).toBeInTheDocument();
    expect(screen.getByText(/#00071/)).toBeInTheDocument();
  });
});
