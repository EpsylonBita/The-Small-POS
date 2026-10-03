/**
 * BOX (box.gr) order decisions from the desktop order status controls.
 *
 * A pending BOX order is accepted or rejected only through the approval panel
 * (prep time on accept, one of BOX's exact Greek reasons on reject) and the
 * store's approve / decline calls — never a bare status change. BOX has no
 * ready callback and its decision is final, so the controls offer neither
 * "Notify ready" nor "Reactivate" for it. Other platforms keep their existing
 * buttons. The real OrderApprovalPanel is rendered; `t` answers from the real
 * merged English bundle.
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

  // Resolves against the merged English bundle (base + overlays), then the
  // caller's default value, then the key itself.
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
        notifyPlatformReady: vi.fn(),
      },
      customers: { lookupByPhone: vi.fn() },
      payments: { printReceipt: vi.fn() },
    },
    store: {
      updatePreparationProgress: vi.fn(),
      approveOrder: vi.fn(),
      declineOrder: vi.fn(),
    },
  };
});

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: mocks.t, language: 'en' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'en' } }),
  // `src/lib/i18n.ts` registers this plugin at import time.
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('react-hot-toast', () => {
  const toast = Object.assign((...args: unknown[]) => mocks.toastBlank(...args), {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  });
  return { default: toast, toast };
});

vi.mock('../../../../lib', () => ({
  getBridge: () => mocks.bridge,
}));

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: () => {} }),
}));

vi.mock('../../../hooks/useOrderStore', () => ({
  useOrderStore: () => mocks.store,
}));

vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({
    isOpen,
    title,
    ariaLabel,
    header,
    footer,
    children,
  }: {
    isOpen: boolean;
    title?: string;
    ariaLabel?: string;
    header?: React.ReactNode;
    footer?: React.ReactNode;
    children?: React.ReactNode;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label={ariaLabel || title}>
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
  formatDate: () => '01/10/2026',
  formatTime: () => '12:00',
}));

import { localeBundles } from '../../../../locales/bundles';
import type { Order, OrderStatus } from '../../../types/orders';
import { OrderStatusControls } from '../OrderStatusControls';

mocks.i18n.bundle = localeBundles.en;
const { t } = mocks;

const OUTSIDE_SERVICE_AREA = 'Εκτός ορίων εξυπηρέτησης';
const REVIEW_DIALOG = t('orderApprovalPanel.reviewOrder');
const DECLINE_DIALOG = t('orderApprovalPanel.declineReason');

function makeOrder(overrides: Record<string, unknown> = {}): Order {
  return {
    id: 'order-1',
    order_number: 'ORD-0042',
    status: 'pending',
    order_type: 'delivery',
    customer_name: 'Maria',
    customer_phone: '',
    delivery_address: 'Iliados 10, Athens',
    total_amount: 12.5,
    created_at: '2026-10-01T09:30:00.000Z',
    items: [{ id: 'item-1', name: 'Souvlaki', quantity: 2, unit_price: 6.25, total_price: 12.5 }],
    ...overrides,
  } as unknown as Order;
}

const boxOrder = (overrides: Record<string, unknown> = {}) =>
  makeOrder({ id: 'box-order-1', plugin: 'box', external_plugin_order_id: 'BX1001', ...overrides });

const efoodOrder = (overrides: Record<string, unknown> = {}) =>
  makeOrder({ id: 'efood-order-1', plugin: 'efood', external_plugin_order_id: 'EF2002', ...overrides });

function renderControls(order: Order, wrap?: (controls: React.ReactElement) => React.ReactElement) {
  const onStatusChange = vi.fn(async (_orderId: string, _status: OrderStatus) => undefined);
  const onDriverAssign = vi.fn();
  const controls = (
    <OrderStatusControls
      order={order}
      onStatusChange={onStatusChange}
      onDriverAssign={onDriverAssign}
      onConvertToPickup={vi.fn()}
    />
  );
  render(wrap ? wrap(controls) : controls);
  return { onStatusChange, onDriverAssign };
}

const controlButton = (key: string) => screen.getByRole('button', { name: t(key) });
const declineDialog = () => screen.getByRole('dialog', { name: DECLINE_DIALOG });
const confirmDeclineButton = () =>
  within(declineDialog()).getByRole('button', { name: t('orderApprovalPanel.confirmDecline') });
const notifyReadyLabel = (platform: string) => t('orders.actions.notifyPlatformReady', { platform });

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  mocks.store.updatePreparationProgress.mockReset().mockResolvedValue(undefined);
  mocks.store.approveOrder.mockReset().mockResolvedValue(true);
  mocks.store.declineOrder.mockReset().mockResolvedValue(true);
  mocks.bridge.orders.getById.mockResolvedValue(null);
  mocks.bridge.orders.fetchItemsFromSupabase.mockResolvedValue([]);
  mocks.bridge.orders.notifyPlatformReady.mockResolvedValue(undefined);
  mocks.bridge.customers.lookupByPhone.mockResolvedValue(null);
  mocks.bridge.payments.printReceipt.mockResolvedValue({ success: true });
});

// RTL auto-cleanup is off in this repo's vitest setup.
afterEach(() => {
  cleanup();
});

describe('OrderStatusControls — pending BOX order', () => {
  it('opens the BOX decision panel instead of changing the status', () => {
    const { onStatusChange } = renderControls(boxOrder());

    fireEvent.click(controlButton('orders.actions.approve'));
    expect(screen.getByRole('dialog', { name: REVIEW_DIALOG })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: DECLINE_DIALOG })).toBeNull();

    // Dismiss without deciding, then take the decline path.
    fireEvent.click(screen.getByRole('button', { name: t('common.actions.close') }));
    expect(screen.queryAllByRole('dialog')).toHaveLength(0);

    fireEvent.click(controlButton('orders.actions.decline'));
    expect(within(declineDialog()).getAllByRole('radio')).toHaveLength(7);
    expect(within(declineDialog()).queryByRole('textbox')).toBeNull();

    expect(onStatusChange).not.toHaveBeenCalled();
    expect(mocks.store.approveOrder).not.toHaveBeenCalled();
    expect(mocks.store.declineOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['order_platform', 'BOX'],
    ['orderPlatform', 'Box'],
  ])('treats %s = %j as BOX', (field, value) => {
    const { onStatusChange } = renderControls(makeOrder({ id: 'box-alias-1', [field]: value }));
    fireEvent.click(controlButton('orders.actions.decline'));
    expect(within(declineDialog()).getAllByRole('radio')).toHaveLength(7);
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('declines through the store with the exact Greek reason', async () => {
    const { onStatusChange } = renderControls(boxOrder());

    fireEvent.click(controlButton('orders.actions.decline'));
    expect(confirmDeclineButton()).toBeDisabled();
    fireEvent.click(screen.getByTestId('box-reject-reason-3'));
    fireEvent.click(confirmDeclineButton());

    await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));
    expect(mocks.store.declineOrder).toHaveBeenCalledTimes(1);
    expect(mocks.store.declineOrder).toHaveBeenCalledWith('box-order-1', OUTSIDE_SERVICE_AREA);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t('orderApprovalPanel.declined'));
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('keeps the panel open when the store reports the decline failed', async () => {
    mocks.store.declineOrder.mockResolvedValue(false);
    const { onStatusChange } = renderControls(boxOrder());

    fireEvent.click(controlButton('orders.actions.decline'));
    fireEvent.click(screen.getByTestId('box-reject-reason-0'));
    fireEvent.click(confirmDeclineButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('boxOrder.decisionUnconfirmed')));
    expect(mocks.store.declineOrder).toHaveBeenCalledWith('box-order-1', 'Υψηλός Φόρτος Παραγγελιών');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: REVIEW_DIALOG })).toBeInTheDocument();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('approves through the store with the prep time, staying open while the store fails', async () => {
    mocks.store.approveOrder.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { onStatusChange } = renderControls(boxOrder());

    fireEvent.click(controlButton('orders.actions.approve'));
    const approveInPanel = within(screen.getByRole('dialog', { name: REVIEW_DIALOG })).getByRole('button', {
      name: t('orderApprovalPanel.approveButton'),
    });

    fireEvent.click(approveInPanel);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('boxOrder.decisionUnconfirmed')));
    expect(screen.getByRole('dialog', { name: REVIEW_DIALOG })).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByRole('dialog', { name: REVIEW_DIALOG })).getByRole('button', {
        name: t('orderApprovalPanel.approveButton'),
      }),
    );
    await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));
    expect(mocks.store.approveOrder).toHaveBeenCalledTimes(2);
    expect(mocks.store.approveOrder).toHaveBeenLastCalledWith('box-order-1', 20);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t('orderApprovalPanel.approved'));
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('keeps clicks inside the decision panel away from the order card', () => {
    const cardClick = vi.fn();
    const cardDoubleClick = vi.fn();
    const cardMouseDown = vi.fn();
    const cardPointerDown = vi.fn();
    renderControls(boxOrder(), (controls) => (
      <div
        data-testid="order-card"
        onClick={cardClick}
        onDoubleClick={cardDoubleClick}
        onMouseDown={cardMouseDown}
        onPointerDown={cardPointerDown}
      >
        {controls}
      </div>
    ));

    fireEvent.click(controlButton('orders.actions.decline'));
    cardClick.mockClear();

    const reason = screen.getByTestId('box-reject-reason-6');
    fireEvent.pointerDown(reason);
    fireEvent.mouseDown(reason);
    fireEvent.click(reason);
    fireEvent.doubleClick(reason);

    expect(reason).toHaveAttribute('aria-checked', 'true');
    expect(cardClick).not.toHaveBeenCalled();
    expect(cardDoubleClick).not.toHaveBeenCalled();
    expect(cardMouseDown).not.toHaveBeenCalled();
    expect(cardPointerDown).not.toHaveBeenCalled();
  });
});

describe('OrderStatusControls — pending order from another platform', () => {
  it.each([
    ['orders.actions.approve', 'confirmed'],
    ['orders.actions.decline', 'cancelled'],
  ] as const)('%s still changes the status to %s directly', async (key, status) => {
    const { onStatusChange } = renderControls(efoodOrder());

    fireEvent.click(controlButton(key));

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1));
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith('efood-order-1', status);
    expect(screen.queryAllByRole('dialog')).toHaveLength(0);
    expect(mocks.store.approveOrder).not.toHaveBeenCalled();
    expect(mocks.store.declineOrder).not.toHaveBeenCalled();
  });
});

describe('OrderStatusControls — platform ready notification', () => {
  const READY_STAGES = [
    ['preparing', {}, 1],
    ['ready', { order_type: 'delivery' }, 2],
  ] as const;

  it.each(READY_STAGES)('offers no ready notification for a %s BOX order', (status, extra, baseButtons) => {
    renderControls(boxOrder({ status, ...extra }));
    expect(screen.queryByRole('button', { name: notifyReadyLabel('BOX') })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(baseButtons);
  });

  it.each(READY_STAGES)('still offers it for a %s efood order', (status, extra, baseButtons) => {
    renderControls(efoodOrder({ status, ...extra }));
    expect(screen.getByRole('button', { name: notifyReadyLabel('efood') })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(baseButtons + 1);
  });
});

describe('OrderStatusControls — cancelled order', () => {
  it('shows a BOX decision as final with no way to reopen it', () => {
    const { onStatusChange } = renderControls(boxOrder({ status: 'cancelled' }));

    expect(screen.getByTestId('box-decision-final')).toHaveTextContent(t('boxOrder.decisionFinal'));
    expect(screen.queryByRole('button', { name: t('orders.actions.reactivate') })).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('still reactivates an order from another platform', async () => {
    const { onStatusChange } = renderControls(efoodOrder({ status: 'cancelled' }));

    expect(screen.queryByTestId('box-decision-final')).toBeNull();
    fireEvent.click(controlButton('orders.actions.reactivate'));

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1));
    expect(onStatusChange).toHaveBeenCalledWith('efood-order-1', 'pending');
  });
});
