/**
 * Order #00044 (2026-09-21): a paid delivery whose customer name was a two-digit
 * number was read as a table check and never appeared on the Orders tab, so
 * staff could not mark it delivered and it stayed pending through the Z. This
 * mounts the real OrderGrid and OrderCard with store orders and checks what the
 * Orders tab actually renders.
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  orders: [] as Record<string, unknown>[],
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

vi.mock('../../hooks/useAcquiredModules', () => ({
  useAcquiredModules: () => ({ hasTablesModule: true }),
}));

import OrderGrid from '../OrderGrid';

afterEach(() => cleanup());

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

function renderOrdersTab() {
  render(
    <OrderGrid selectedOrders={[]} onToggleOrderSelection={() => {}} activeTab="orders" />,
  );
}

describe('Orders tab with numeric customer names', () => {
  it('shows a delivery for a customer named with a number', () => {
    mocks.orders = [
      order({
        id: 'ord-44',
        order_number: 'ORD-21092026-00044',
        order_type: 'delivery',
        customer_name: '12',
        delivery_address: 'Iliados 10',
      }),
    ];

    renderOrdersTab();

    expect(screen.getByText(/#00044/)).toBeInTheDocument();
    expect(screen.queryByText('No orders found')).toBeNull();
  });

  it('shows a pickup named with a call number and keeps a real table check off the tab', () => {
    mocks.orders = [
      order({
        id: 'ord-45',
        order_number: 'ORD-21092026-00045',
        order_type: 'pickup',
        customer_name: '15',
      }),
      order({
        id: 'ord-50',
        order_number: 'ORD-21092026-00050',
        order_type: 'dine-in',
        table_number: '5',
        customer_name: 'Τραπέζι 5',
      }),
    ];

    renderOrdersTab();

    expect(screen.getByText(/#00045/)).toBeInTheDocument();
    expect(screen.queryByText(/#00050/)).toBeNull();
  });
});
