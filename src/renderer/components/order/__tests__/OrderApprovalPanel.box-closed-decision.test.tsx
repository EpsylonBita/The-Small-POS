/**
 * BOX (box.gr) orders the server has not handed to the kitchen yet, in the
 * desktop approval panel (06/10/2026):
 *
 * - A pending BOX order has no order items until BOX confirms the accept; its
 *   provider lines arrive display-only in `ghost_metadata.box_display_items`.
 *   The panel shows them instead of "No items found", and derives no
 *   subtotal from them.
 * - The server owns the terminal state of the decision
 *   (`ghost_metadata._the_small_box_decision`, state `closed`). Such an order
 *   offers no approve, decline or prep time, says why, and can only be closed
 *   here: a plain local cancel through the order store, never a BOX call.
 * - A failed accept / decline says what the server's typed refusal means
 *   (BOX_DECISION_MANUAL_CHECK, BOX_DECISION_CLOSED / _EXPIRED / _REFUSED)
 *   instead of "retry if still pending".
 *
 * The real order store runs (its OrderService and the native bridge are
 * scripted); `t` answers from the real merged English bundle.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type TranslateOptions = Record<string, unknown> & { defaultValue?: string };
  const i18n: { bundle: unknown } = { bundle: {} };

  const lookup = (key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>(
        (current, segment) =>
          current && typeof current === 'object'
            ? (current as Record<string, unknown>)[segment]
            : undefined,
        i18n.bundle,
      );

  const interpolate = (template: string, options: TranslateOptions): string =>
    template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
      name !== 'defaultValue' && Object.prototype.hasOwnProperty.call(options, name)
        ? String(options[name])
        : match,
    );

  const t = (key: string, second?: string | TranslateOptions): string => {
    const options: TranslateOptions =
      second && typeof second === 'object' ? second : { defaultValue: second };
    const candidates: string[] = [];
    if (typeof options.count === 'number') {
      candidates.push(options.count === 1 ? `${key}_one` : `${key}_other`);
    }
    candidates.push(key);
    for (const candidate of candidates) {
      const value = lookup(candidate);
      if (typeof value === 'string') {
        return interpolate(value, options);
      }
    }
    return typeof options.defaultValue === 'string' ? interpolate(options.defaultValue, options) : key;
  };

  return {
    i18n,
    t,
    toastBlank: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    bridge: {
      orders: {
        getById: vi.fn(),
        fetchItemsFromSupabase: vi.fn(),
        approve: vi.fn(),
        decline: vi.fn(),
        updateStatus: vi.fn(),
      },
      customers: { lookupByPhone: vi.fn() },
      payments: { printReceipt: vi.fn() },
    },
    orderService: {
      updateOrderStatus: vi.fn(),
      fetchOrders: vi.fn(),
    },
  };
});

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: mocks.t, language: 'en' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('react-hot-toast', () => {
  const toast = Object.assign((...args: unknown[]) => mocks.toastBlank(...args), {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
    dismiss: vi.fn(),
  });
  return { default: toast, toast };
});

vi.mock('../../../../lib', () => ({
  getBridge: () => mocks.bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

vi.mock('../../../../services/OrderService', () => ({
  OrderService: { getInstance: () => mocks.orderService },
}));

vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({
    isOpen,
    title,
    ariaLabel,
    header,
    footer,
    children,
    onClose,
    closeOnEscape,
  }: {
    isOpen: boolean;
    title?: string;
    ariaLabel?: string;
    header?: React.ReactNode;
    footer?: React.ReactNode;
    children?: React.ReactNode;
    onClose?: () => void;
    closeOnEscape?: boolean;
  }) =>
    isOpen ? (
      <div
        role="dialog"
        aria-label={ariaLabel || title}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && closeOnEscape) onClose?.();
        }}
      >
        {title ? <h2>{title}</h2> : null}
        {header}
        {children}
        {footer}
      </div>
    ) : null,
}));

vi.mock('../../../utils/plugin-icons', () => {
  const names: Record<string, string> = { box: 'BOX', efood: 'efood' };
  const pluginKey = (plugin?: unknown) => String(plugin ?? '').trim().toLowerCase();
  const isExternal = (plugin?: unknown) =>
    Object.prototype.hasOwnProperty.call(names, pluginKey(plugin));
  const pluginName = (plugin?: unknown) =>
    isExternal(plugin) ? names[pluginKey(plugin)] : String(plugin ?? 'Unknown');
  return {
    isExternalPlugin: isExternal,
    isExternalPlatform: isExternal,
    getPluginName: pluginName,
    getPlatformName: pluginName,
    getPluginColor: () => '#6b7280',
  };
});

vi.mock('../../../utils/format', () => ({
  formatCurrency: (value: number) => `EUR ${Number(value || 0).toFixed(2)}`,
  formatDate: () => '06/10/2026',
  formatTime: () => '12:00',
}));

import { localeBundles } from '../../../../locales/bundles';
import type { Order } from '../../../types/orders';
import { useOrderStore } from '../../../hooks/useOrderStore';
import { ErrorFactory } from '../../../../shared/utils/error-handler';
import { INCOMING_ORDER_APPROVAL_MARKER_ATTR } from '../../../services/incomingOrderAlert';
import { OrderApprovalPanel } from '../OrderApprovalPanel';
import { BOX_REJECTION_REASONS, runBoxApprovalDecision } from '../box-order-decision';

mocks.i18n.bundle = localeBundles.en;
const { t } = mocks;

const REVIEW_DIALOG = t('orderApprovalPanel.reviewOrder');
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
  // The same dish again as its own line: never merged with the first.
  { name: 'Souvlaki pita', quantity: 2, unit_price: 4.5, total_price: 9, notes: null, modifiers: [] },
  { name: 'Coca-Cola 330ml', quantity: 1, unit_price: 1.8, total_price: 1.8, notes: null, modifiers: [] },
];

const closedDecision = (outcome: 'unknown' | 'not_accepted' = 'unknown') => ({
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

function boxOrder(overrides: Record<string, unknown> = {}): Order {
  return {
    id: ORDER_ID,
    order_number: 'BOX-0042',
    status: 'pending',
    order_type: 'delivery',
    customer_name: 'Maria',
    customer_phone: '',
    delivery_address: 'Iliados 10, Athens',
    plugin: 'box',
    external_plugin_order_id: 'A1B2C3D4E5F6',
    total_amount: 21.3,
    created_at: '2026-10-06T09:30:00.000Z',
    items: [],
    ghost_metadata: { food_delivery: { platform: 'box' } },
    ...overrides,
  } as unknown as Order;
}

const withMetadata = (metadata: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  boxOrder({ ghost_metadata: { food_delivery: { platform: 'box' }, ...metadata }, ...overrides });

type PanelProps = React.ComponentProps<typeof OrderApprovalPanel>;

function renderPanel(order: Order, overrides: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    order,
    onApprove: vi.fn(async () => undefined),
    onDecline: vi.fn(async () => undefined),
    onClose: vi.fn(),
    ...overrides,
  };
  const view = render(<OrderApprovalPanel {...props} />);
  return { ...view, props };
}

function seedStore(...orders: Order[]) {
  useOrderStore.setState({
    orders: orders as never,
    pendingExternalOrders: [],
    loadingOperations: new Set(),
    error: null,
  });
}

const reviewDialog = () => screen.getByRole('dialog', { name: REVIEW_DIALOG });
const approveButton = () => screen.queryByRole('button', { name: t('orderApprovalPanel.approveButton') });
const declineButton = () => screen.queryByRole('button', { name: t('orderApprovalPanel.declineButton') });
const closeOrderButton = () => screen.getByTestId('box-close-order');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.bridge.orders.getById.mockResolvedValue(null);
  mocks.bridge.orders.fetchItemsFromSupabase.mockResolvedValue([]);
  mocks.bridge.orders.approve.mockResolvedValue({ success: true });
  mocks.bridge.orders.decline.mockResolvedValue({ success: true });
  mocks.bridge.orders.updateStatus.mockResolvedValue({ success: true });
  mocks.bridge.customers.lookupByPhone.mockResolvedValue(null);
  mocks.bridge.payments.printReceipt.mockResolvedValue({ success: true });
  mocks.orderService.updateOrderStatus.mockResolvedValue(undefined);
  mocks.orderService.fetchOrders.mockResolvedValue([]);
  seedStore();
});

// RTL auto-cleanup is off in this repo's vitest setup.
afterEach(() => {
  cleanup();
});

describe('OrderApprovalPanel — display-only lines of a pending BOX order', () => {
  it('shows the provider lines from the local copy instead of "No items found", without a subtotal', async () => {
    mocks.bridge.orders.getById.mockResolvedValue({
      ...boxOrder(),
      ghost_metadata: { food_delivery: { platform: 'box' }, box_display_items: DISPLAY_ITEMS },
    });
    renderPanel(boxOrder());

    await waitFor(() => expect(screen.getByText('Coca-Cola 330ml')).toBeInTheDocument());
    // Both identical lines stay: they are the provider's own lines.
    expect(screen.getAllByText('Souvlaki pita')).toHaveLength(2);
    expect(screen.getAllByText('2x')).toHaveLength(2);
    expect(screen.getByText('+ Extra feta')).toBeInTheDocument();
    expect(screen.getByText('EUR 0.50')).toBeInTheDocument();
    expect(screen.getByText('Onion')).toHaveClass('line-through');
    expect(screen.getByText('Well done')).toBeInTheDocument();
    expect(screen.getAllByText('EUR 9.00')).toHaveLength(2);
    expect(screen.getByText(t('orderApprovalPanel.itemsCount', { count: 3 }))).toBeInTheDocument();
    expect(screen.queryByText(t('orderApprovalPanel.noItems'))).toBeNull();
    // No subtotal is derived from display lines; the total is the order's own.
    expect(screen.queryByText(t('orderApprovalPanel.subtotal'))).toBeNull();
    expect(within(reviewDialog()).getByText('EUR 21.30')).toBeInTheDocument();
    // The chain still looked for canonical items first.
    expect(mocks.bridge.orders.fetchItemsFromSupabase).toHaveBeenCalledTimes(1);
  });

  it('reads the lines from the order itself when the local read has none', async () => {
    renderPanel(withMetadata({ box_display_items: DISPLAY_ITEMS }));
    await waitFor(() => expect(screen.getByText('Coca-Cola 330ml')).toBeInTheDocument());
    expect(screen.queryByText(t('orderApprovalPanel.noItems'))).toBeNull();
  });

  it('prefers the order items once BOX confirmed the accept', async () => {
    renderPanel(withMetadata(
      { box_display_items: DISPLAY_ITEMS },
      { items: [{ id: 'item-1', name: 'Gyros plate', quantity: 1, unit_price: 9.5, total_price: 9.5 }] },
    ));
    await waitFor(() => expect(screen.getByText('Gyros plate')).toBeInTheDocument());
    expect(screen.queryByText('Coca-Cola 330ml')).toBeNull();
    expect(screen.getByText(t('orderApprovalPanel.subtotal'))).toBeInTheDocument();
  });

  it('still says "No items found" for a BOX order without any line', async () => {
    renderPanel(boxOrder());
    await waitFor(() => expect(screen.getByText(t('orderApprovalPanel.noItems'))).toBeInTheDocument());
  });

  it('never shows display lines of another platform', async () => {
    renderPanel(withMetadata(
      { box_display_items: DISPLAY_ITEMS },
      { id: 'efood-order-1', plugin: 'efood', external_plugin_order_id: 'EF-1', ghost_metadata: { box_display_items: DISPLAY_ITEMS } },
    ));
    await waitFor(() => expect(screen.getByText(t('orderApprovalPanel.noItems'))).toBeInTheDocument());
    expect(screen.queryByText('Coca-Cola 330ml')).toBeNull();
  });
});

describe('OrderApprovalPanel — a BOX decision the server closed', () => {
  it('offers no approve, decline or prep time on a manual-check order and says to check it with BOX', async () => {
    renderPanel(withMetadata({ _the_small_box_decision: closedDecision('unknown'), box_display_items: DISPLAY_ITEMS }));

    const notice = await screen.findByTestId('box-decision-closed');
    expect(notice).toHaveTextContent(t('boxOrder.manualCheckTitle'));
    expect(notice).toHaveTextContent(t('boxOrder.manualCheck'));
    expect(notice).not.toHaveTextContent(t('boxOrder.decisionClosed'));
    expect(approveButton()).toBeNull();
    expect(declineButton()).toBeNull();
    expect(screen.queryByTestId('order-approval-prep-20')).toBeNull();
    expect(closeOrderButton()).toHaveTextContent(t('boxOrder.closeOrder'));
    // What was ordered is still on screen, and the incoming-order marker stays.
    expect(await screen.findByText('Coca-Cola 330ml')).toBeInTheDocument();
    expect(document.querySelector(`[${INCOMING_ORDER_APPROVAL_MARKER_ATTR}="${ORDER_ID}"]`)).not.toBeNull();
  });

  it('says BOX closed it when the outcome is known (not accepted)', () => {
    renderPanel(withMetadata({ _the_small_box_decision: closedDecision('not_accepted') }));
    const notice = screen.getByTestId('box-decision-closed');
    expect(notice).toHaveTextContent(t('boxOrder.decisionClosed'));
    expect(notice).not.toHaveTextContent(t('boxOrder.manualCheckTitle'));
    expect(approveButton()).toBeNull();
  });

  it('switches to the closed state when only the newer local copy carries the closed record', async () => {
    mocks.bridge.orders.getById.mockResolvedValue(withMetadata({ _the_small_box_decision: closedDecision('unknown') }));
    renderPanel(boxOrder());
    expect(approveButton()).not.toBeNull();
    await screen.findByTestId('box-decision-closed');
    expect(approveButton()).toBeNull();
    expect(declineButton()).toBeNull();
  });

  it('keeps the decision buttons for an open decision, and closes nothing on a view-only panel', () => {
    renderPanel(withMetadata({ _the_small_box_decision: { version: 1, state: 'pending', action: 'accepted' } }));
    expect(screen.queryByTestId('box-decision-closed')).toBeNull();
    expect(approveButton()).not.toBeNull();
    expect(declineButton()).not.toBeNull();
    cleanup();

    renderPanel(withMetadata({ _the_small_box_decision: closedDecision('unknown') }), { viewOnly: true });
    expect(screen.queryByTestId('box-decision-closed')).toBeNull();
    expect(screen.queryByTestId('box-close-order')).toBeNull();
  });

  it('closes the order through the order store with the manual-check code, never a BOX decline', async () => {
    const order = withMetadata({ _the_small_box_decision: closedDecision('unknown') });
    seedStore(order);
    const { props } = renderPanel(order);

    fireEvent.click(closeOrderButton());

    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(mocks.orderService.updateOrderStatus).toHaveBeenCalledTimes(1);
    expect(mocks.orderService.updateOrderStatus).toHaveBeenCalledWith(ORDER_ID, 'cancelled', {
      cancellationReason: 'box_manual_check_closed',
    });
    expect(mocks.bridge.orders.decline).not.toHaveBeenCalled();
    expect(mocks.bridge.orders.approve).not.toHaveBeenCalled();
    expect(useOrderStore.getState().orders[0]).toMatchObject({
      status: 'cancelled',
      cancellation_reason: 'box_manual_check_closed',
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('re-reads a store copy that does not carry the closed record yet before closing', async () => {
    const closed = withMetadata({ _the_small_box_decision: closedDecision('unknown') });
    seedStore(boxOrder());
    mocks.orderService.fetchOrders.mockResolvedValue([closed]);
    const { props } = renderPanel(closed);

    fireEvent.click(closeOrderButton());

    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(mocks.orderService.fetchOrders).toHaveBeenCalled();
    expect(mocks.orderService.updateOrderStatus).toHaveBeenCalledWith(ORDER_ID, 'cancelled', {
      cancellationReason: 'box_manual_check_closed',
    });
  });

  it('keeps the panel open and says so when the close is refused', async () => {
    // The store's copy never learns of the closure: the store refuses the cancel.
    seedStore(boxOrder());
    mocks.orderService.fetchOrders.mockResolvedValue([boxOrder()]);
    const { props } = renderPanel(withMetadata({ _the_small_box_decision: closedDecision('unknown') }));

    fireEvent.click(closeOrderButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('boxOrder.closeOrderFailed')));
    expect(mocks.orderService.updateOrderStatus).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(closeOrderButton()).toBeEnabled();
  });

  it('keeps the panel open when the till refuses the close', async () => {
    const order = withMetadata({ _the_small_box_decision: closedDecision('unknown') });
    seedStore(order);
    let refuse: (error: unknown) => void = () => undefined;
    mocks.orderService.updateOrderStatus.mockImplementation(
      () => new Promise((_resolve, reject) => {
        refuse = reject;
      }),
    );
    const { props } = renderPanel(order);

    fireEvent.click(closeOrderButton());
    await waitFor(() => expect(closeOrderButton()).toBeDisabled());
    expect(closeOrderButton()).toHaveTextContent(t('boxOrder.closingOrder'));
    // Nothing else can close the panel mid-close.
    expect(screen.getByRole('button', { name: t('common.actions.close') })).toBeDisabled();

    refuse(new Error('BOX requires a pending accept with estimate or an exact rejection reason'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('boxOrder.closeOrderFailed')));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(useOrderStore.getState().orders[0]).toMatchObject({ status: 'pending' });
  });

  it('closes the panel without a new cancel when the order is already cancelled', async () => {
    const order = withMetadata({ _the_small_box_decision: closedDecision('not_accepted') });
    seedStore({ ...order, status: 'cancelled', cancellation_reason: 'box_decision_expired' } as Order);
    const { props } = renderPanel(order);

    fireEvent.click(closeOrderButton());

    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(mocks.orderService.updateOrderStatus).not.toHaveBeenCalled();
  });

  it('can be left without closing the order: there is nothing to decide', () => {
    const { props } = renderPanel(withMetadata({ _the_small_box_decision: closedDecision('unknown') }));
    fireEvent.click(screen.getByRole('button', { name: t('common.actions.close') }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mocks.orderService.updateOrderStatus).not.toHaveBeenCalled();
  });
});

describe('OrderApprovalPanel — what a failed BOX decision means', () => {
  const nativeRefusal = (code: string) => `BOX decision refused (HTTP 400, ${code}); refresh the order`;

  // As the dashboard and the order controls wire it: the store answers
  // false and the caller throws a bare error.
  const viaStore = {
    onApprove: async (orderId: string, estimatedTime?: number) =>
      runBoxApprovalDecision(() => useOrderStore.getState().approveOrder(orderId, estimatedTime), () => undefined),
    onDecline: async (orderId: string, reason: string) =>
      runBoxApprovalDecision(() => useOrderStore.getState().declineOrder(orderId, reason), () => undefined),
  };

  const approve = () => fireEvent.click(approveButton()!);
  const decline = () => {
    fireEvent.click(declineButton()!);
    fireEvent.click(screen.getByTestId('box-reject-reason-0'));
    const dialog = screen.getByRole('dialog', { name: t('orderApprovalPanel.declineReason') });
    fireEvent.click(within(dialog).getByRole('button', { name: t('orderApprovalPanel.confirmDecline') }));
  };

  it('says to check the order with BOX after BOX_DECISION_MANUAL_CHECK', async () => {
    seedStore(boxOrder());
    mocks.bridge.orders.approve.mockRejectedValue(nativeRefusal('BOX_DECISION_MANUAL_CHECK'));
    const { props } = renderPanel(boxOrder(), viaStore);

    approve();

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('boxOrder.manualCheck')));
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.bridge.orders.approve).toHaveBeenCalledWith(ORDER_ID, 20);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it.each(['BOX_DECISION_CLOSED', 'BOX_DECISION_EXPIRED', 'BOX_DECISION_REFUSED'])(
    'says the decision is closed after a decline refused with %s',
    async (code) => {
      seedStore(boxOrder());
      mocks.bridge.orders.decline.mockRejectedValue(nativeRefusal(code));
      renderPanel(boxOrder(), viaStore);

      decline();

      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('boxOrder.decisionClosed')));
      expect(mocks.bridge.orders.decline).toHaveBeenCalledWith(ORDER_ID, BOX_REJECTION_REASONS[0]);
      expect(mocks.toastError).toHaveBeenCalledTimes(1);
    },
  );

  it('reads a refusal the bridge answers as an unsuccessful result too', async () => {
    seedStore(boxOrder());
    mocks.bridge.orders.approve.mockResolvedValue({ success: false, error: nativeRefusal('BOX_DECISION_EXPIRED') });
    renderPanel(boxOrder(), viaStore);

    approve();

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('boxOrder.decisionClosed')));
  });

  it('keeps "retry if still pending" for an unconfirmed decision', async () => {
    seedStore(boxOrder());
    mocks.bridge.orders.approve.mockRejectedValue('BOX decision is not confirmed; check connection and retry if still pending');
    renderPanel(boxOrder(), viaStore);

    approve();

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('boxOrder.decisionUnconfirmed')));
  });

  it('never reads an earlier failure as this decision\'s answer', async () => {
    seedStore(boxOrder());
    useOrderStore.setState({
      error: ErrorFactory.businessLogic('Failed to approve order', { error: nativeRefusal('BOX_DECISION_CLOSED') }),
    });
    const onApprove = vi.fn(async () => {
      throw new Error('BOX decision failed');
    });
    renderPanel(boxOrder(), { onApprove });

    approve();

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('boxOrder.decisionUnconfirmed')));
  });

  it('keeps the existing messages of other platforms', async () => {
    seedStore();
    useOrderStore.setState({
      error: ErrorFactory.businessLogic('Failed to approve order', { error: nativeRefusal('BOX_DECISION_MANUAL_CHECK') }),
    });
    const onApprove = vi.fn(async () => {
      throw new Error('approve failed');
    });
    renderPanel(
      boxOrder({ id: 'efood-order-1', plugin: 'efood', external_plugin_order_id: 'EF-1', ghost_metadata: null }),
      { onApprove },
    );

    approve();

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('orderApprovalPanel.approveFailed')));
  });
});

describe('boxOrder closed-decision copy', () => {
  const LOCALES = ['en', 'el', 'de', 'fr', 'it', 'sq'] as const;
  const KEYS = ['decisionClosed', 'manualCheckTitle', 'manualCheck', 'closeOrder', 'closingOrder', 'closeOrderFailed'] as const;
  const CLOSED_REASONS = ['box_decision_expired', 'box_decision_refused', 'box_manual_check_closed'] as const;

  it.each(LOCALES)('%s has every closed-decision key', (locale) => {
    const boxOrderCopy = (localeBundles[locale] as Record<string, any>).boxOrder as Record<string, any>;
    for (const key of KEYS) {
      expect(typeof boxOrderCopy?.[key], `${locale} boxOrder.${key}`).toBe('string');
      expect((boxOrderCopy[key] as string).trim(), `${locale} boxOrder.${key}`).not.toBe('');
    }
    expect(Object.keys(boxOrderCopy.closedReasons ?? {}).sort()).toEqual([...CLOSED_REASONS].sort());
    for (const code of CLOSED_REASONS) {
      expect((boxOrderCopy.closedReasons[code] as string).trim(), `${locale} boxOrder.closedReasons.${code}`).not.toBe('');
    }
  });
});
