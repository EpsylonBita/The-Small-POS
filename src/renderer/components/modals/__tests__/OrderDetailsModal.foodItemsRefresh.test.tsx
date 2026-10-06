import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrderDetailsModal from '../OrderDetailsModal';

// Symptom (desktop 1.4.123): a food print waiting for its efood items told the
// operator to "open this order to refresh its items", but opening the order
// only re-read the local row, so the items never arrived and the print waited
// until the Z. Opening a platform order whose items are missing now asks the
// native item fetch (which persists the items and releases the waiting print)
// and shows the refreshed items.

type Listener = (payload?: unknown) => void;

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(payload?: unknown) => void>>(),
  shift: {
    staff: { staffId: 'staff-1', name: 'Ana', databaseStaffId: 'staff-1' },
    activeShift: { id: 'shift-1', staff_id: 'staff-1' },
  },
  bridge: {
    orders: { getById: vi.fn(), getByCustomerPhone: vi.fn(), fetchItemsFromSupabase: vi.fn() },
    payments: {
      getOrderPayments: vi.fn(),
      getPaidItems: vi.fn(),
      getSettlementSnapshot: vi.fn(),
      listUnsavedPayments: vi.fn(),
      voidPayment: vi.fn(),
    },
    refunds: {
      getPaymentBalance: vi.fn(),
      listOrderAdjustments: vi.fn(),
      refundPayment: vi.fn(),
    },
    giftReturns: { authorize: vi.fn(), status: vi.fn(), begin: vi.fn(), recover: vi.fn() },
    terminalConfig: { getOrganizationId: vi.fn(), getBranchId: vi.fn(), getTerminalId: vi.fn() },
  },
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const t = (key: string, options?: unknown): string => {
    if (typeof options === 'string') return options;
    const values = options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
    return typeof values.defaultValue === 'string' ? values.defaultValue : key;
  };
  const i18n = { language: 'en', resolvedLanguage: 'en', changeLanguage: async () => undefined };
  return { ...actual, useTranslation: () => ({ t, i18n, ready: true }) };
});

vi.mock('../../../../lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBridge: () => mocks.bridge,
  onEvent: (event: string, handler: Listener) => {
    const handlers = mocks.listeners.get(event) ?? new Set<Listener>();
    handlers.add(handler);
    mocks.listeners.set(event, handlers);
  },
  offEvent: (event: string, handler: Listener) => {
    mocks.listeners.get(event)?.delete(handler);
  },
}));

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: () => undefined }),
}));

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key, language: 'en', setLanguage: () => undefined }),
}));

vi.mock('../../../contexts/shift-context', () => ({ useShift: () => mocks.shift }));

vi.mock('../../../services/MenuService', () => ({
  menuService: {
    getMenuItems: async () => [],
    getMenuCategories: async () => [],
    getIngredients: async () => [],
  },
}));

vi.mock('../../ui/PlatformHeldPaymentNotice', () => ({
  PlatformHeldPaymentNotice: () => null,
  usePlatformHeldNotice: () => null,
}));

const ORDER_ID = 'order-food-1';
const FETCHED_ITEMS = [
  { id: 'item-1', name: 'Waffle Bueno', quantity: 1, price: 8, total_price: 8 },
  { id: 'item-2', name: 'Freddo Espresso', quantity: 2, price: 2, total_price: 4 },
];

const world = {
  plugin: 'efood' as string | null,
  items: [] as unknown,
};

const orderRow = () => ({
  id: ORDER_ID,
  order_number: 'ORD-77',
  status: 'confirmed',
  order_type: 'delivery',
  total_amount: 12,
  payment_status: 'paid',
  plugin: world.plugin,
  items: world.items,
  created_at: '2026-10-06T10:00:00.000Z',
});

afterEach(cleanup);

beforeEach(() => {
  world.plugin = 'efood';
  world.items = [];
  mocks.listeners.clear();
  const { bridge } = mocks;
  bridge.orders.getById.mockImplementation(async () => orderRow());
  bridge.orders.getByCustomerPhone.mockImplementation(async () => ({ success: true, orders: [] }));
  // Native persists fetched food items under the order's identity, then the
  // next local read returns them.
  bridge.orders.fetchItemsFromSupabase.mockImplementation(async () => {
    world.items = FETCHED_ITEMS;
    return FETCHED_ITEMS;
  });
  bridge.payments.getOrderPayments.mockImplementation(async () => []);
  bridge.payments.getPaidItems.mockImplementation(async () => []);
  bridge.payments.listUnsavedPayments.mockImplementation(async () => ({ payments: [] }));
  bridge.payments.getSettlementSnapshot.mockImplementation(async () => ({
    success: true,
    orderId: ORDER_ID,
    netPaid: 12,
    outstandingAmount: 0,
  }));
  bridge.refunds.listOrderAdjustments.mockImplementation(async () => []);
  bridge.giftReturns.status.mockImplementation(async () => ({ success: false }));
  bridge.terminalConfig.getOrganizationId.mockImplementation(() => 'org-1');
  bridge.terminalConfig.getBranchId.mockImplementation(() => 'branch-1');
  bridge.terminalConfig.getTerminalId.mockImplementation(() => 'terminal-1');
});

const renderDetails = () =>
  render(<OrderDetailsModal isOpen orderId={ORDER_ID} onClose={vi.fn()} />);

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

describe('OrderDetailsModal food items refresh on open', () => {
  it.each([
    ['an empty list', []],
    ['rows without a quantity', [{ name: 'Waffle' }]],
    ['rows without a name', [{ name: '  ', quantity: 1 }]],
  ])('fetches missing platform items once and shows them (%s)', async (_label, localItems) => {
    world.items = localItems;
    renderDetails();

    await waitFor(() =>
      expect(mocks.bridge.orders.fetchItemsFromSupabase).toHaveBeenCalledWith(ORDER_ID),
    );
    expect(await screen.findByText('Waffle Bueno')).toBeInTheDocument();
    expect(screen.getByText('Freddo Espresso')).toBeInTheDocument();
    await settle();
    expect(mocks.bridge.orders.fetchItemsFromSupabase).toHaveBeenCalledTimes(1);
    // The refreshed items come from a fresh local read, never from the reply alone.
    expect(mocks.bridge.orders.getById.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not fetch when the platform order already has usable items', async () => {
    world.items = FETCHED_ITEMS;
    renderDetails();

    expect(await screen.findByText('Waffle Bueno')).toBeInTheDocument();
    await settle();
    expect(mocks.bridge.orders.fetchItemsFromSupabase).not.toHaveBeenCalled();
  });

  it('does not fetch for the store\'s own orders', async () => {
    world.plugin = 'pos';
    world.items = [];
    renderDetails();

    await waitFor(() => expect(mocks.bridge.orders.getById).toHaveBeenCalled());
    await settle();
    expect(mocks.bridge.orders.fetchItemsFromSupabase).not.toHaveBeenCalled();
  });

  it('keeps the modal usable when the item fetch fails', async () => {
    mocks.bridge.orders.fetchItemsFromSupabase.mockRejectedValue(new Error('offline'));
    renderDetails();

    await waitFor(() => expect(mocks.bridge.orders.fetchItemsFromSupabase).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.queryByText('Waffle Bueno')).toBeNull();
    expect(mocks.bridge.orders.fetchItemsFromSupabase).toHaveBeenCalledTimes(1);
  });
});
