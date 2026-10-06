/**
 * BOX (box.gr) orders in the desktop order details (06/10/2026):
 * - a pending BOX order has no order items until BOX confirms the accept, so
 *   its provider lines (`ghost_metadata.box_display_items`) are shown, display
 *   only; with no lines at all the ingest's item text stays in the notes;
 * - the cancellation reasons the server or this till writes when a BOX
 *   decision closes are codes, shown by their label;
 * - a pending BOX order whose decision the server closed says so (with an
 *   unknown outcome: check it with BOX).
 * `t` answers from the real merged English bundle.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrderDetailsModal from '../OrderDetailsModal';

const i18nMock = vi.hoisted(() => ({
  translator(dictionary: Record<string, unknown>) {
    const lookup = (key: string): unknown =>
      key.split('.').reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
        dictionary,
      );
    return (key: string, options?: unknown): string => {
      const values =
        options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
      const found = lookup(key);
      const template =
        typeof found === 'string'
          ? found
          : typeof values.defaultValue === 'string'
            ? values.defaultValue
            : typeof options === 'string'
              ? options
              : key;
      return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) =>
        values[name] === undefined ? '' : String(values[name]),
      );
    };
  },
}));

const mocks = vi.hoisted(() => ({
  bridge: {
    orders: { getById: vi.fn(), getByCustomerPhone: vi.fn() },
    payments: {
      getOrderPayments: vi.fn(),
      getPaidItems: vi.fn(),
      getSettlementSnapshot: vi.fn(),
      listUnsavedPayments: vi.fn(),
    },
    customers: { lookupById: vi.fn(), lookupByPhone: vi.fn() },
    clipboard: { writeText: vi.fn() },
  },
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const { localeBundles } = await import('../../../../locales/bundles');
  const t = i18nMock.translator(localeBundles.en as unknown as Record<string, unknown>);
  const i18n = { language: 'en', resolvedLanguage: 'en', changeLanguage: async () => undefined };
  return { ...actual, useTranslation: () => ({ t, i18n, ready: true }) };
});

vi.mock('../../../../lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBridge: () => mocks.bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: () => undefined }),
}));

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key, language: 'en', setLanguage: () => undefined }),
}));

vi.mock('../../../contexts/shift-context', () => ({
  useShift: () => ({ staff: null, activeShift: null }),
}));

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

import { localeBundles } from '../../../../locales/bundles';

const tr = i18nMock.translator(localeBundles.en as unknown as Record<string, unknown>);

const ORDER_ID = 'box-order-1';

const DISPLAY_ITEMS = [
  {
    name: 'Souvlaki pita',
    quantity: 2,
    unit_price: 4.5,
    total_price: 9,
    notes: 'Well done',
    modifiers: [
      { name: 'Extra feta', price: 0.5 },
      { name: 'Onion', price: 0, without: true },
    ],
  },
  { name: 'Souvlaki pita', quantity: 2, unit_price: 4.5, total_price: 9, notes: null, modifiers: [] },
  { name: 'Coca-Cola 330ml', quantity: 1, unit_price: 1.8, total_price: 1.8, notes: null, modifiers: [] },
];

const ITEM_TEXT = '--- Order Items ---\n2x Souvlaki pita (4.50)\n1x Coca-Cola 330ml (1.80)';

const closedDecision = (outcome: 'unknown' | 'not_accepted') => ({
  version: 1,
  state: 'closed',
  closure: {
    reason: 'expired',
    outcome,
    manual_check: outcome === 'unknown',
    code: 'BOX_DECISION_EXPIRED',
    closed_at: '2026-10-06T10:00:00Z',
  },
});

const orderRow = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  order_number: 'BOX-0042',
  status: 'pending',
  order_type: 'delivery',
  plugin: 'box',
  external_plugin_order_id: 'A1B2C3D4E5F6',
  total_amount: 21.3,
  subtotal: 19.8,
  payment_status: 'pending',
  items: [],
  created_at: '2026-10-06T09:30:00.000Z',
  ghost_metadata: { food_delivery: { platform: 'box' } },
  ...overrides,
});

let row: Record<string, unknown> = orderRow();

const renderDetails = async () => {
  render(<OrderDetailsModal isOpen orderId={ORDER_ID} onClose={vi.fn()} />);
  await waitFor(() => expect(mocks.bridge.orders.getById).toHaveBeenCalled());
  await waitFor(() => expect(screen.getAllByText('BOX-0042').length).toBeGreaterThan(0));
};

afterEach(cleanup);

beforeEach(() => {
  row = orderRow();
  mocks.bridge.orders.getById.mockImplementation(async () => row);
  mocks.bridge.orders.getByCustomerPhone.mockResolvedValue({ success: true, orders: [] });
  mocks.bridge.payments.getOrderPayments.mockResolvedValue([]);
  mocks.bridge.payments.getPaidItems.mockResolvedValue([]);
  mocks.bridge.payments.getSettlementSnapshot.mockResolvedValue({ success: false });
  mocks.bridge.payments.listUnsavedPayments.mockResolvedValue({ payments: [] });
});

describe('OrderDetailsModal — BOX display-only lines', () => {
  it('shows the provider lines of a pending BOX order without order items', async () => {
    row = orderRow({
      special_instructions: `Ring twice\n${ITEM_TEXT}`,
      ghost_metadata: { food_delivery: { platform: 'box' }, box_display_items: DISPLAY_ITEMS },
    });
    await renderDetails();

    const lines = await screen.findAllByTestId('order-details-box-display-line');
    expect(lines).toHaveLength(3);
    expect(within(lines[0]).getByText('Souvlaki pita')).toBeInTheDocument();
    expect(within(lines[0]).getByText('2x')).toBeInTheDocument();
    expect(within(lines[0]).getByText('Extra feta', { exact: false })).toBeInTheDocument();
    expect(within(lines[0]).getByText('- Onion')).toHaveClass('line-through');
    expect(within(lines[0]).getByText('Well done')).toBeInTheDocument();
    expect(within(lines[1]).getByText('Souvlaki pita')).toBeInTheDocument();
    expect(within(lines[2]).getByText('Coca-Cola 330ml')).toBeInTheDocument();
    expect(screen.queryByText(tr('modals.orderDetails.noItems'))).toBeNull();
    // The lines render structured, so only the customer's words stay in the notes.
    expect(screen.getByText('Ring twice')).toBeInTheDocument();
    expect(screen.queryByText((content) => content.includes('--- Order Items ---'))).toBeNull();
  });

  it('keeps the ingest item text in the notes when a BOX order has no line to show', async () => {
    row = orderRow({ special_instructions: `Ring twice\n${ITEM_TEXT}` });
    await renderDetails();

    await waitFor(() =>
      expect(screen.getByText((content) => content.includes('--- Order Items ---'))).toBeInTheDocument(),
    );
    expect(screen.getByText(tr('modals.orderDetails.noItems'))).toBeInTheDocument();
    expect(screen.queryAllByTestId('order-details-box-display-line')).toHaveLength(0);
  });

  it('shows the order items once BOX confirmed the accept', async () => {
    row = orderRow({
      status: 'confirmed',
      items: [{ id: 'item-1', name: 'Gyros plate', quantity: 1, unit_price: 9.5, total_price: 9.5 }],
      ghost_metadata: { food_delivery: { platform: 'box' }, box_display_items: DISPLAY_ITEMS },
    });
    await renderDetails();

    await waitFor(() => expect(screen.getByText('Gyros plate')).toBeInTheDocument());
    expect(screen.queryAllByTestId('order-details-box-display-line')).toHaveLength(0);
    expect(screen.queryByText('Coca-Cola 330ml')).toBeNull();
  });

  it('leaves other platforms as they were', async () => {
    row = orderRow({
      plugin: 'efood',
      external_plugin_order_id: 'EF-1',
      special_instructions: `Ring twice\n${ITEM_TEXT}`,
      ghost_metadata: { box_display_items: DISPLAY_ITEMS },
    });
    await renderDetails();

    await waitFor(() => expect(screen.getByText('Ring twice')).toBeInTheDocument());
    expect(screen.queryAllByTestId('order-details-box-display-line')).toHaveLength(0);
    expect(screen.queryByText((content) => content.includes('--- Order Items ---'))).toBeNull();
  });
});

describe('OrderDetailsModal — BOX closed-decision reasons', () => {
  it.each(['box_decision_expired', 'box_decision_refused', 'box_manual_check_closed'])(
    'shows the label of %s, never the code',
    async (code) => {
      row = orderRow({ status: 'cancelled', cancellation_reason: code, ghost_metadata: { _the_small_box_decision: closedDecision('not_accepted') } });
      await renderDetails();

      const label = tr(`boxOrder.closedReasons.${code}`);
      expect(label).not.toBe(`boxOrder.closedReasons.${code}`);
      // The reason panel and the cancellation summary both read the label.
      await waitFor(() => expect(screen.getAllByText(label, { exact: false })).toHaveLength(2));
      expect(screen.queryByText(code, { exact: false })).toBeNull();
    },
  );

  it('shows any other reason as written', async () => {
    row = orderRow({ status: 'cancelled', cancellation_reason: 'Customer left' });
    await renderDetails();
    await waitFor(() => expect(screen.getAllByText('Customer left', { exact: false })).toHaveLength(2));
  });
});

describe('OrderDetailsModal — a pending BOX order whose decision the server closed', () => {
  it('says to check it with BOX when the outcome is unknown', async () => {
    row = orderRow({ ghost_metadata: { _the_small_box_decision: closedDecision('unknown') } });
    await renderDetails();

    const notice = await screen.findByTestId('order-details-box-decision-closed');
    expect(notice).toHaveTextContent(tr('boxOrder.manualCheckTitle'));
    expect(notice).toHaveTextContent(tr('boxOrder.manualCheck'));
  });

  it('says BOX closed it when the outcome is known', async () => {
    row = orderRow({ ghost_metadata: JSON.stringify({ _the_small_box_decision: closedDecision('not_accepted') }) });
    await renderDetails();

    const notice = await screen.findByTestId('order-details-box-decision-closed');
    expect(notice).toHaveTextContent(tr('boxOrder.decisionClosed'));
    expect(notice).not.toHaveTextContent(tr('boxOrder.manualCheckTitle'));
  });

  it('says nothing for an open decision or a decided order', async () => {
    row = orderRow({ ghost_metadata: { _the_small_box_decision: { version: 1, state: 'pending', action: 'accepted' } } });
    await renderDetails();
    expect(screen.queryByTestId('order-details-box-decision-closed')).toBeNull();
    cleanup();

    row = orderRow({ status: 'cancelled', cancellation_reason: 'box_decision_expired', ghost_metadata: { _the_small_box_decision: closedDecision('unknown') } });
    await renderDetails();
    expect(screen.queryByTestId('order-details-box-decision-closed')).toBeNull();
  });
});
