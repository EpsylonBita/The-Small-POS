/**
 * BOX (box.gr) decline reasons in the desktop approval panel.
 *
 * BOX validates the reject `reason` against an exact Greek enum (staging
 * OpenAPI `OrderRejectionReason`), so a BOX decline is a choice from that list
 * and the value handed to `onDecline` is the enum string verbatim — never a
 * translation, free text or an invented "other". Other platforms keep the
 * free-text reason. `t` answers from the real merged English bundle, so these
 * tests also pin that the shipped copy exists.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import type { Order } from '../../../types/orders';
import { OrderApprovalPanel } from '../OrderApprovalPanel';
import {
  BOX_PLUGIN_ID,
  BOX_REJECTION_REASONS,
  BOX_REJECTION_REASON_LABEL_KEYS,
  isBoxOrder,
  isBoxRejectionReason,
} from '../box-order-decision';

mocks.i18n.bundle = localeBundles.en;
const { t } = mocks;

/** BOX staging OpenAPI `OrderRejectionReason` enum, in order. */
const EXPECTED_BOX_REASONS = [
  'Υψηλός Φόρτος Παραγγελιών',
  'Δεν υπάρχει διανομέας',
  'Μη Διαθέσιμο Προϊόν',
  'Εκτός ορίων εξυπηρέτησης',
  'Λάθος τιμή σε προϊόν',
  'Κλείνουμε Σύντομα',
  'Λόγω κακοκαιρίας',
] as const;

const EXPECTED_REASON_SLUGS = [
  'highOrderVolume',
  'noCourierAvailable',
  'productUnavailable',
  'outsideServiceArea',
  'wrongProductPrice',
  'closingSoon',
  'badWeather',
] as const;

const BOX_ORDER_TEXT_KEYS = ['reasonLabel', 'reasonPrompt', 'reasonRequired', 'reasonSentAs', 'decisionFinal', 'decisionUnconfirmed'] as const;

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

const declineDialog = () => screen.getByRole('dialog', { name: DECLINE_DIALOG });
const confirmDeclineButton = () =>
  within(declineDialog()).getByRole('button', { name: t('orderApprovalPanel.confirmDecline') });
const reasonRadios = () => within(declineDialog()).getAllByRole('radio');

function openDeclineStep() {
  fireEvent.click(screen.getByRole('button', { name: t('orderApprovalPanel.declineButton') }));
}

function expectNoReasonSelected() {
  for (const radio of reasonRadios()) {
    expect(radio).toHaveAttribute('aria-checked', 'false');
  }
  expect(confirmDeclineButton()).toBeDisabled();
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
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

describe('BOX reject reason contract', () => {
  it('matches the BOX OpenAPI enum exactly and in order', () => {
    expect([...BOX_REJECTION_REASONS]).toEqual([...EXPECTED_BOX_REASONS]);
    expect(Object.keys(BOX_REJECTION_REASON_LABEL_KEYS)).toEqual([...EXPECTED_BOX_REASONS]);
    expect(Object.values(BOX_REJECTION_REASON_LABEL_KEYS)).toEqual([...EXPECTED_REASON_SLUGS]);
    expect(BOX_PLUGIN_ID).toBe('box');
  });

  it('accepts only the exact enum strings', () => {
    for (const reason of EXPECTED_BOX_REASONS) {
      expect(isBoxRejectionReason(reason)).toBe(true);
    }
    for (const value of ['', 'other', 'OTHER', 'shop_has_high_load', 'High order volume', null, undefined, 3]) {
      expect(isBoxRejectionReason(value)).toBe(false);
    }
  });

  it('identifies BOX orders from the first non-empty platform field', () => {
    expect(isBoxOrder({ plugin: 'box' })).toBe(true);
    expect(isBoxOrder({ plugin: '   ', platform: 'BOX' })).toBe(true);
    expect(isBoxOrder({ plugin: 'efood', platform: 'box' })).toBe(false);
    expect(isBoxOrder({ plugin: 'boxer' })).toBe(false);
    expect(isBoxOrder({})).toBe(false);
    expect(isBoxOrder(null)).toBe(false);
    expect(isBoxOrder('box')).toBe(false);
  });
});

describe('OrderApprovalPanel — BOX decline', () => {
  it('refuses the BOX reason picker when the master money preflight refuses', async () => {
    const onBeforeDecline = vi.fn(async () => false);
    const { props } = renderPanel(boxOrder(), { onBeforeDecline });
    openDeclineStep();
    await waitFor(() => expect(onBeforeDecline).toHaveBeenCalledWith('box-order-1'));
    expect(screen.queryByRole('dialog', { name: DECLINE_DIALOG })).toBeNull();
    expect(props.onDecline).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('sends the exact BOX reason after the master preflight permits it, preserving a false outcome', async () => {
    const { props } = renderPanel(boxOrder(), {
      onBeforeDecline: vi.fn(async () => true),
      onDecline: vi.fn(async () => false),
    });
    openDeclineStep();
    await waitFor(() => expect(screen.getByRole('dialog', { name: DECLINE_DIALOG })).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('box-reject-reason-2'));
    fireEvent.click(confirmDeclineButton());
    await waitFor(() => expect(props.onDecline).toHaveBeenCalledWith('box-order-1', EXPECTED_BOX_REASONS[2]));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('keeps failed BOX acceptance open and shows the localized pending/refresh feedback', async () => {
    const { props } = renderPanel(boxOrder());
    vi.mocked(props.onApprove).mockRejectedValue(new Error('BOX decision pending'));
    fireEvent.click(screen.getByRole('button', { name: `30${t('common.units.minutesShort', { defaultValue: 'm' })}` }));
    fireEvent.click(screen.getByRole('button', { name: t('orderApprovalPanel.approveButton') }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('boxOrder.decisionUnconfirmed')));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('keeps failed BOX rejection open and shows one localized pending/refresh error', async () => {
    const { props } = renderPanel(boxOrder());
    vi.mocked(props.onDecline).mockRejectedValue(new Error('BOX decision pending'));
    openDeclineStep();
    fireEvent.click(screen.getByTestId('box-reject-reason-0'));
    fireEvent.click(confirmDeclineButton());
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('boxOrder.decisionUnconfirmed')));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
  it('offers the seven BOX reasons as a radio group, with no free-text box', () => {
    renderPanel(boxOrder());
    openDeclineStep();

    const dialog = declineDialog();
    expect(within(dialog).getByText(t('boxOrder.reasonPrompt'))).toBeInTheDocument();
    expect(within(dialog).getByRole('radiogroup', { name: t('boxOrder.reasonLabel') })).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).toBeNull();

    const radios = reasonRadios();
    expect(radios).toHaveLength(EXPECTED_BOX_REASONS.length);
    radios.forEach((radio, index) => {
      expect(radio).toBe(screen.getByTestId(`box-reject-reason-${index}`));
      expect(radio).toHaveAttribute('type', 'button');
      expect(radio).toHaveTextContent(t(`boxOrder.reasons.${EXPECTED_REASON_SLUGS[index]}`));
      // The English label differs from the Greek value, so the exact value
      // BOX receives is shown too, marked as Greek.
      const sentAs = radio.querySelector('[lang="el"]');
      expect(sentAs?.textContent).toBe(EXPECTED_BOX_REASONS[index]);
      expect(radio).toHaveTextContent(t('boxOrder.reasonSentAs', { value: EXPECTED_BOX_REASONS[index] }));
    });
    expectNoReasonSelected();
  });

  it.each(EXPECTED_BOX_REASONS.map((reason, index) => [index, reason] as const))(
    'sends reason %i to BOX verbatim (%s)',
    async (index, reason) => {
      const { props } = renderPanel(boxOrder());
      openDeclineStep();

      fireEvent.click(screen.getByTestId(`box-reject-reason-${index}`));
      expect(screen.getByTestId(`box-reject-reason-${index}`)).toHaveAttribute('aria-checked', 'true');
      expect(reasonRadios().filter((radio) => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1);
      expect(confirmDeclineButton()).toBeEnabled();

      fireEvent.click(confirmDeclineButton());

      await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
      expect(props.onDecline).toHaveBeenCalledTimes(1);
      expect(props.onDecline).toHaveBeenCalledWith('box-order-1', reason);
      expect(mocks.toastSuccess).toHaveBeenCalledWith(t('orderApprovalPanel.declined'));
      expect(mocks.toastError).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['plugin', 'BOX'],
    ['order_plugin', 'Box'],
    ['platform', ' box '],
    ['order_platform', 'BOX'],
    ['orderPlugin', 'box'],
    ['orderPlatform', 'bOx'],
  ])('recognises a BOX order from %s = %j', async (field, value) => {
    const { props } = renderPanel(makeOrder({ id: 'box-alias-1', [field]: value }));
    openDeclineStep();

    expect(reasonRadios()).toHaveLength(EXPECTED_BOX_REASONS.length);
    expect(within(declineDialog()).queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByTestId('box-reject-reason-5'));
    fireEvent.click(confirmDeclineButton());
    await waitFor(() => expect(props.onDecline).toHaveBeenCalledWith('box-alias-1', EXPECTED_BOX_REASONS[5]));
  });

  it('locks the reasons and the confirm button while the decline is in flight', async () => {
    let finishDecline: () => void = () => undefined;
    const onDecline = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDecline = resolve;
        }),
    );
    const { props } = renderPanel(boxOrder(), { onDecline, dismissible: true });
    openDeclineStep();
    fireEvent.click(screen.getByTestId('box-reject-reason-2'));

    const confirm = confirmDeclineButton();
    fireEvent.click(confirm);

    expect(confirm).toBeDisabled();
    expect(confirm).toHaveTextContent(t('orderApprovalPanel.declining'));
    for (const radio of reasonRadios()) {
      expect(radio).toBeDisabled();
    }
    expect(within(declineDialog()).getByRole('button', { name: t('common.actions.cancel') })).toBeDisabled();
    // A dismissible panel cannot be closed mid-decision either.
    expect(screen.getByRole('button', { name: t('common.actions.close') })).toBeDisabled();

    fireEvent.click(confirm);
    fireEvent.click(screen.getByTestId('box-reject-reason-4'));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onDecline).toHaveBeenCalledWith('box-order-1', EXPECTED_BOX_REASONS[2]);

    await act(async () => {
      finishDecline();
    });
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t('orderApprovalPanel.declined'));
  });

  it('keeps the order open after a failed decline and starts the next try with no reason', async () => {
    const onDecline = vi.fn(async () => {
      throw new Error('BOX rejected the request');
    });
    const { props } = renderPanel(boxOrder(), { onDecline });
    openDeclineStep();
    fireEvent.click(screen.getByTestId('box-reject-reason-1'));
    fireEvent.click(confirmDeclineButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(t('boxOrder.decisionUnconfirmed')));
    expect(onDecline).toHaveBeenCalledWith('box-order-1', EXPECTED_BOX_REASONS[1]);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: DECLINE_DIALOG })).toBeNull());
    expect(screen.getByRole('dialog', { name: REVIEW_DIALOG })).toBeInTheDocument();

    openDeclineStep();
    expectNoReasonSelected();
  });

  it('never carries a chosen reason over to another BOX order', async () => {
    const { props, rerender } = renderPanel(boxOrder());
    openDeclineStep();
    fireEvent.click(screen.getByTestId('box-reject-reason-4'));
    expect(screen.getByTestId('box-reject-reason-4')).toHaveAttribute('aria-checked', 'true');

    rerender(<OrderApprovalPanel {...props} order={boxOrder({ id: 'box-order-2', external_plugin_order_id: 'BX1002' })} />);

    expectNoReasonSelected();
    fireEvent.click(screen.getByTestId('box-reject-reason-0'));
    fireEvent.click(confirmDeclineButton());
    await waitFor(() => expect(props.onDecline).toHaveBeenCalledWith('box-order-2', EXPECTED_BOX_REASONS[0]));
    expect(props.onDecline).toHaveBeenCalledTimes(1);
  });

  it('starts on the decline step when asked to', () => {
    renderPanel(boxOrder(), { initialDeclineOpen: true });
    expect(reasonRadios()).toHaveLength(EXPECTED_BOX_REASONS.length);
    expectNoReasonSelected();
  });

  it('can be dismissed without a decision only when dismissible', () => {
    const { props } = renderPanel(boxOrder(), { dismissible: true });
    fireEvent.click(screen.getByRole('button', { name: t('common.actions.close') }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onApprove).not.toHaveBeenCalled();
    expect(props.onDecline).not.toHaveBeenCalled();

    cleanup();
    renderPanel(boxOrder());
    expect(screen.queryByRole('button', { name: t('common.actions.close') })).toBeNull();
  });
});

describe('OrderApprovalPanel — other platforms keep the free-text reason', () => {
  it('sends the trimmed free-text reason for an efood order', async () => {
    const { props } = renderPanel(efoodOrder());
    openDeclineStep();

    const dialog = declineDialog();
    expect(within(dialog).queryByRole('radiogroup')).toBeNull();
    expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
    expect(confirmDeclineButton()).toBeDisabled();

    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '  Out of stock tonight  ' } });
    expect(confirmDeclineButton()).toBeEnabled();
    fireEvent.click(confirmDeclineButton());

    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(props.onDecline).toHaveBeenCalledWith('efood-order-1', 'Out of stock tonight');
  });

  it('approves an efood order with the preparation time picked in the panel', async () => {
    const { props } = renderPanel(efoodOrder());

    const thirtyMinutes = screen.getByRole('button', {
      name: `30${t('common.units.minutesShort', { defaultValue: 'm' })}`,
    });
    fireEvent.click(thirtyMinutes);
    expect(thirtyMinutes).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: t('orderApprovalPanel.approveButton') }));

    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(props.onApprove).toHaveBeenCalledTimes(1);
    expect(props.onApprove).toHaveBeenCalledWith('efood-order-1', 30);
    expect(props.onDecline).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t('orderApprovalPanel.approved'));
  });
});

describe('boxOrder locale copy', () => {
  const LOCALES = ['en', 'el', 'de', 'fr', 'it', 'sq'] as const;

  it.each(LOCALES)('%s has every boxOrder key', (locale) => {
    const bundle = localeBundles[locale] as Record<string, unknown>;
    const boxOrderCopy = bundle.boxOrder as Record<string, unknown> | undefined;
    expect(boxOrderCopy).toBeDefined();
    for (const key of BOX_ORDER_TEXT_KEYS) {
      const value = boxOrderCopy?.[key];
      expect(typeof value, `${locale} boxOrder.${key}`).toBe('string');
      expect((value as string).trim(), `${locale} boxOrder.${key}`).not.toBe('');
    }
    expect(boxOrderCopy?.reasonSentAs).toContain('{{value}}');

    const reasons = boxOrderCopy?.reasons as Record<string, unknown> | undefined;
    expect(Object.keys(reasons ?? {}).sort()).toEqual([...EXPECTED_REASON_SLUGS].sort());
    for (const slug of EXPECTED_REASON_SLUGS) {
      const value = reasons?.[slug];
      expect(typeof value, `${locale} boxOrder.reasons.${slug}`).toBe('string');
      expect((value as string).trim(), `${locale} boxOrder.reasons.${slug}`).not.toBe('');
    }
  });

  it('labels each Greek reason with the exact value BOX accepts', () => {
    const reasons = (localeBundles.el as Record<string, any>).boxOrder.reasons as Record<string, string>;
    EXPECTED_REASON_SLUGS.forEach((slug, index) => {
      expect(reasons[slug]).toBe(EXPECTED_BOX_REASONS[index]);
    });
  });
});
