import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Item E, fix review 30/09/2026 (Android 1.0.13 parity). A card charged at
// new-order checkout whose order the till could not save is held in a
// durable record. The order dashboard reads those records (so they are back
// after a restart) and offers "Save payment again", which writes the order
// and its payment with the same keys: no new charge. The Z names the record
// "New order, not saved yet", never the checkout's internal request id.

const mock = vi.hoisted(() => ({
  listUnsavedPayments: vi.fn(),
  saveUnsavedPayments: vi.fn(),
}));

vi.mock('../../../../lib', () => ({
  getBridge: () => ({
    payments: {
      listUnsavedPayments: mock.listUnsavedPayments,
      saveUnsavedPayments: mock.saveUnsavedPayments,
    },
  }),
}));

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

import en from '../../../../locales/en.json';
import el from '../../../../locales/el.json';
import de from '../../../../locales/de.json';
import fr from '../../../../locales/fr.json';
import it_ from '../../../../locales/it.json';
import sq from '../../../../locales/sq.json';
import type { UnsettledPaymentBlocker } from '../../../../lib/ipc-contracts';
import {
  getLocalizedPaymentBlockerFix,
  getLocalizedPaymentBlockerReason,
} from '../../../../lib/payment-integrity';
import {
  UNSAVED_CHECKOUT_CHANGED_EVENT,
  announceUnsavedCheckoutChanged,
  useUnsavedCheckoutPayments,
} from '../../../utils/unsavedPayments';
import { UnsavedChargedPaymentBanner } from '../UnsavedChargedPaymentBanner';
import { UnsettledPaymentBlockersPanel } from '../UnsettledPaymentBlockersPanel';

const LOCALES = { en, el, de, fr, it: it_, sq } as const;
type Lng = keyof typeof LOCALES;

const createI18n = async (lng: Lng) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: false,
    resources: { [lng]: { translation: LOCALES[lng] } },
    interpolation: { escapeValue: false },
  });
  return instance;
};

const CHECKOUT_KEY = 'terminal-card:fiscal-txn-checkout-1';

const checkoutRecord = {
  idempotencyKey: CHECKOUT_KEY,
  orderId: 'checkout-request-0001',
  method: 'card',
  amount: 13,
  amountCents: 1300,
  currency: 'EUR',
  kind: 'new_order_checkout',
  capturedAt: '2026-09-30T12:00:05Z',
  attempts: 4,
  canSaveAgain: true,
};

const orderRecord = {
  ...checkoutRecord,
  idempotencyKey: 'terminal-card:txn-order-2',
  orderId: 'order-2',
  kind: 'single',
};

function DashboardBanner() {
  const { t } = useTranslation();
  const unsaved = useUnsavedCheckoutPayments(true, t, (amount) => `${amount.toFixed(2)} €`);
  return (
    <UnsavedChargedPaymentBanner
      payments={unsaved.payments}
      onSaveAgain={unsaved.saveAgain}
      isSaving={unsaved.isSaving}
    />
  );
}

const renderBanner = async (lng: Lng) => {
  const i18n = await createI18n(lng);
  render(
    <I18nextProvider i18n={i18n}>
      <DashboardBanner />
    </I18nextProvider>,
  );
  return i18n;
};

describe('the dashboard banner for a checkout charged and not saved', () => {
  beforeEach(() => {
    mock.listUnsavedPayments.mockReset();
    mock.saveUnsavedPayments.mockReset();
  });

  afterEach(() => cleanup());

  it('reads the durable records (after a restart too) and shows only the new-order checkouts', async () => {
    mock.listUnsavedPayments.mockResolvedValue({
      success: true,
      payments: [orderRecord, checkoutRecord],
    });
    const i18n = await renderBanner('el');

    const banner = await screen.findByTestId('unsaved-charged-payment-banner');
    expect(mock.listUnsavedPayments).toHaveBeenCalledWith();
    expect(banner.textContent).toContain(i18n.t('payment.notSaved.newOrder'));
    expect(banner.textContent).toContain('13.00');
    // The other order's record belongs on that order's payment screen.
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('Save payment again replays the checkout by its key, then reads again', async () => {
    mock.listUnsavedPayments
      .mockResolvedValueOnce({ success: true, payments: [checkoutRecord] })
      .mockResolvedValue({ success: true, payments: [] });
    mock.saveUnsavedPayments.mockResolvedValue({
      success: true,
      saved: 1,
      setAside: [],
      unsaved: [],
      results: [],
    });
    const i18n = await renderBanner('en');

    await screen.findByTestId('unsaved-charged-payment-banner');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('payment.notSaved.saveAgain') }));
    });

    await waitFor(() =>
      expect(mock.saveUnsavedPayments).toHaveBeenCalledWith({ idempotencyKey: CHECKOUT_KEY }),
    );
    expect(mock.saveUnsavedPayments).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('unsaved-charged-payment-banner')).toBeNull());
  });

  it('appears as soon as a checkout ends charged and not saved', async () => {
    mock.listUnsavedPayments
      .mockResolvedValueOnce({ success: true, payments: [] })
      .mockResolvedValue({ success: true, payments: [checkoutRecord] });
    await renderBanner('en');

    await waitFor(() => expect(mock.listUnsavedPayments).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('unsaved-charged-payment-banner')).toBeNull();
    expect(UNSAVED_CHECKOUT_CHANGED_EVENT).toBe('pos:unsaved-checkout-changed');
    await act(async () => {
      announceUnsavedCheckoutChanged();
    });

    expect(await screen.findByTestId('unsaved-charged-payment-banner')).toBeTruthy();
  });
});

const newOrderBlocker = (canSaveAgain: boolean): UnsettledPaymentBlocker => ({
  orderId: 'checkout-request-0001',
  orderNumber: 'checkout-request-0001',
  totalAmount: 0,
  settledAmount: 0,
  paymentStatus: 'pending',
  paymentMethod: 'card',
  reasonCode: 'payments_not_saved',
  reasonText:
    'A EUR 13.00 card payment charged at 2026-09-30T12:00:05Z for a new order is not saved on this till yet.',
  suggestedFix: 'Save the payment again: it saves the order and its payment, with no new charge.',
  severity: 'blocking',
  differenceCents: 0,
  reasonAmounts: { paymentAmount: 1300 },
  reasonVariant: canSaveAgain ? 'new_order' : 'new_order_cannot_save',
  unsavedPayment: { ...checkoutRecord, canSaveAgain },
});

describe('the Z blocker of a checkout charged and not saved', () => {
  afterEach(() => cleanup());

  it.each(Object.keys(LOCALES) as Lng[])(
    '%s: names a new order and its money, never the internal request id',
    async (lng) => {
      const i18n = await createI18n(lng);
      const money = (amount: number) => `${amount.toFixed(2)} €`;
      for (const canSaveAgain of [true, false]) {
        const blocker = newOrderBlocker(canSaveAgain);
        const reason = getLocalizedPaymentBlockerReason(blocker, i18n.t, money);
        expect(reason).toContain('13.00 €');
        expect(reason).not.toContain('checkout-request-0001');
        expect(reason).not.toMatch(/\{\{\w+\}\}/);
        const fix = getLocalizedPaymentBlockerFix(blocker, i18n.t, money);
        expect(fix).not.toEqual(i18n.t('paymentIntegrity.fixCodes.payments_not_saved'));
        expect(fix.length).toBeGreaterThan(20);
      }
      expect(
        getLocalizedPaymentBlockerFix(newOrderBlocker(true), i18n.t, money),
      ).not.toEqual(getLocalizedPaymentBlockerFix(newOrderBlocker(false), i18n.t, money));
    },
  );

  it('titles the blocker with the new-order label in the panel', async () => {
    const i18n = await createI18n('sq');
    render(
      <I18nextProvider i18n={i18n}>
        <UnsettledPaymentBlockersPanel blockers={[newOrderBlocker(true)]} onSaveUnsavedPayment={() => {}} />
      </I18nextProvider>,
    );

    const card = screen.getByTestId(`unsaved-payment-${CHECKOUT_KEY}`);
    expect(card.textContent).toContain(i18n.t('payment.notSaved.newOrder'));
    expect(card.textContent).not.toContain('checkout-request-0001');
  });
});
