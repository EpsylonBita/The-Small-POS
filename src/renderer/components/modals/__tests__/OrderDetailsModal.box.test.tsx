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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriverCashForNotice } from '../../../../lib/ipc-contracts';
import { formatCurrency } from '../../../utils/format';
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
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  bridge: {
    orders: { getById: vi.fn(), getByCustomerPhone: vi.fn(), getDriverCashForNotice: vi.fn() },
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
  onEvent: mocks.onEvent,
  offEvent: mocks.offEvent,
}));

vi.mock('../RefundVoidModal', () => ({
  default: ({ onRefundComplete }: { onRefundComplete: () => void }) => (
    <button data-testid="complete-refund" onClick={() => onRefundComplete()}>Complete refund</button>
  ),
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
  mocks.bridge.orders.getDriverCashForNotice.mockReset().mockResolvedValue(null);
  mocks.bridge.orders.getById.mockImplementation(async () => row);
  mocks.bridge.orders.getByCustomerPhone.mockResolvedValue({ success: true, orders: [] });
  mocks.bridge.payments.getOrderPayments.mockResolvedValue([]);
  mocks.bridge.payments.getPaidItems.mockResolvedValue([]);
  mocks.bridge.payments.getSettlementSnapshot.mockResolvedValue({ success: false });
  mocks.bridge.payments.listUnsavedPayments.mockResolvedValue({ payments: [] });
});

describe('OrderDetailsModal cancelled platform payment', () => {
  const cash = (collectorName: string | null, amountCents = 1250): DriverCashForNotice =>
    ({ state: 'driver_cash', amountCents, currency: 'CHF', collectorName });
  const cancelledOrder = (overrides: Record<string, unknown> = {}) =>
    orderRow({ status: 'cancelled', items: [{ name: 'Pita', quantity: 1, total_price: 4 }], ...overrides });
  const details = (isOpen = true, orderId = ORDER_ID) =>
    <OrderDetailsModal isOpen={isOpen} orderId={orderId} onClose={vi.fn()} />;
  const review = tr('cancellationNotice.paymentInReview');
  const check = tr('cancellationNotice.checkPayments');
  const cashText = (amount: number) =>
    tr('cancellationNotice.driverCashNoName', { amount: formatCurrency(amount, 'CHF') }).replace(/\s+/g, ' ');

  function deferredCash() {
    let resolve!: (answer: DriverCashForNotice) => void;
    const promise = new Promise<DriverCashForNotice>(done => { resolve = done; });
    return { promise, resolve };
  }

  it('offers the void entry for a cancelled platform order with a paid header', async () => {
    row = cancelledOrder({ payment_status: 'paid' });
    await renderDetails();
    expect(await screen.findByTestId('order-details-void-refund')).toBeEnabled();
  });

  it.each([
    { label: 'driver cash', answer: cash('Μαρία'),
      wording: () => tr('cancellationNotice.driverCash', { amount: formatCurrency(12.5, 'CHF'), name: 'Μαρία' }) },
    { label: 'driver cash without a name', answer: cash(null),
      wording: () => tr('cancellationNotice.driverCashNoName', { amount: formatCurrency(12.5, 'CHF') }) },
    { label: 'review', answer: { state: 'review' }, wording: () => review },
    { label: 'check', answer: { state: 'check' }, wording: () => check },
  ])('shows $label in the payment panel', async ({ answer, wording }) => {
    row = cancelledOrder();
    mocks.bridge.orders.getDriverCashForNotice.mockResolvedValueOnce(answer);
    await renderDetails();

    // The money formatter separates code and amount with a no-break space; the page text is matched with plain spaces.
    const text = wording().replace(/\s+/g, ' ');
    const line = await screen.findByText(text);
    expect(line.parentElement).toHaveTextContent('Payment status');
    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(mocks.bridge.orders.getDriverCashForNotice.mock.calls).toStrictEqual([[ORDER_ID]]);
  });

  it.each([
    { label: 'a non-cancelled platform order', overrides: { status: 'confirmed' } },
    { label: 'a cancelled non-platform order', overrides: { plugin: 'pos' } },
  ])('makes no read for $label', async ({ overrides }) => {
    row = cancelledOrder(overrides);
    await renderDetails();
    expect(mocks.bridge.orders.getDriverCashForNotice).not.toHaveBeenCalled();
  });

  it.each(['null', 'rejected'] as const)('shows no line when the read is %s', async outcome => {
    row = cancelledOrder();
    if (outcome === 'rejected') {
      mocks.bridge.orders.getDriverCashForNotice.mockRejectedValueOnce(new Error('read failed'));
    }
    await renderDetails();
    await waitFor(() => expect(mocks.bridge.orders.getDriverCashForNotice).toHaveBeenCalledOnce());
    expect(screen.queryByText(review)).toBeNull();
    expect(screen.queryByText(check)).toBeNull();
    expect(screen.queryByText(/^The till has recorded/)).toBeNull();
  });

  it('drops a late payment reply after opening another order', async () => {
    row = cancelledOrder();
    let resolveFirst!: (answer: DriverCashForNotice) => void;
    mocks.bridge.orders.getDriverCashForNotice
      .mockReturnValueOnce(new Promise<DriverCashForNotice>(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ state: 'check' });
    const { rerender } = render(details());
    await waitFor(() => expect(mocks.bridge.orders.getDriverCashForNotice.mock.calls).toStrictEqual([[ORDER_ID]]));

    row = cancelledOrder({ id: 'b', order_number: 'BOX-0043' });
    rerender(details(true, 'b'));
    expect(await screen.findByText(check)).toBeInTheDocument();
    await act(async () => resolveFirst({ state: 'review' }));
    expect(screen.queryByText(review)).toBeNull();
    expect(screen.getByText(check)).toBeInTheDocument();
    expect(mocks.bridge.orders.getDriverCashForNotice.mock.calls).toStrictEqual([[ORDER_ID], ['b']]);
  });

  it('reads again on reopening the same order after the receipt arrives', async () => {
    row = cancelledOrder();
    mocks.bridge.orders.getDriverCashForNotice.mockResolvedValueOnce(null).mockResolvedValueOnce(cash('Μαρία'));
    const { rerender } = render(details());
    await waitFor(() => expect(mocks.bridge.orders.getDriverCashForNotice).toHaveBeenCalledOnce());
    expect(screen.queryByText(/Μαρία/)).toBeNull();
    rerender(details(false));
    rerender(details());

    expect(await screen.findByText(/Μαρία/)).toBeInTheDocument();
    expect(mocks.bridge.orders.getDriverCashForNotice.mock.calls).toStrictEqual([[ORDER_ID], [ORDER_ID]]);
  });

  it.each(['already shown', 'still pending'])('refreshes the same order after a refund when the first amount is %s', async firstState => {
    row = cancelledOrder({ payment_status: 'paid' });
    const payment = { id: 'cash-1', method: 'cash', status: 'completed', amount: 12.5 };
    mocks.bridge.payments.getOrderPayments
      .mockResolvedValueOnce([payment])
      .mockResolvedValueOnce([{ ...payment, refundedAmount: 4 }]);
    const beforeRefund = deferredCash();
    const afterRefund = deferredCash();
    mocks.bridge.orders.getDriverCashForNotice
      .mockReturnValueOnce(beforeRefund.promise)
      .mockReturnValueOnce(afterRefund.promise);
    await renderDetails();
    await waitFor(() => expect(mocks.bridge.orders.getDriverCashForNotice.mock.calls).toStrictEqual([[ORDER_ID]]));

    if (firstState === 'already shown') {
      await act(async () => beforeRefund.resolve(cash(null)));
      expect(screen.getByText(cashText(12.5))).toBeInTheDocument();
    }

    fireEvent.click(screen.getByTestId('order-details-void-refund'));
    fireEvent.click(screen.getByTestId('complete-refund'));
    await waitFor(() => expect(mocks.bridge.orders.getDriverCashForNotice.mock.calls).toStrictEqual([[ORDER_ID], [ORDER_ID]]));
    expect(mocks.bridge.payments.getOrderPayments.mock.calls).toStrictEqual([[ORDER_ID], [ORDER_ID]]);
    expect(screen.queryByText(cashText(12.5))).toBeNull();

    await act(async () => afterRefund.resolve(cash(null, 850)));
    expect(screen.getByText(cashText(8.5))).toBeInTheDocument();
    if (firstState === 'still pending') {
      await act(async () => beforeRefund.resolve(cash(null)));
      expect(screen.getByText(cashText(8.5))).toBeInTheDocument();
      expect(screen.queryByText(cashText(12.5))).toBeNull();
    }
  });

  it('drops the old terminal reply when the same cancelled order stays open', async () => {
    row = cancelledOrder();
    const previousTerminal = deferredCash();
    mocks.bridge.orders.getDriverCashForNotice
      .mockReturnValueOnce(previousTerminal.promise)
      .mockResolvedValueOnce({ state: 'check' });
    await renderDetails();
    await waitFor(() => expect(mocks.bridge.orders.getDriverCashForNotice.mock.calls).toStrictEqual([[ORDER_ID]]));

    await act(async () => {
      for (const [event, listener] of mocks.onEvent.mock.calls) {
        if (event === 'terminal-credentials-updated') listener();
      }
    });
    expect(await screen.findByText(check)).toBeInTheDocument();
    await act(async () => previousTerminal.resolve(cash(null)));
    expect(screen.getByText(check)).toBeInTheDocument();
    expect(screen.queryByText(cashText(12.5))).toBeNull();
    expect(mocks.bridge.orders.getDriverCashForNotice.mock.calls).toStrictEqual([[ORDER_ID], [ORDER_ID]]);
  });
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
