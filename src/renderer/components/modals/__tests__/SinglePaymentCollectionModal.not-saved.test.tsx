import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix review 30/09/2026 (Android 1.0.13 parity). The terminal approved the
// card, then the payment write failed. Native keeps a durable record, retries,
// and answers PAYMENT_NOT_SAVED. The cashier must read, in the store's
// language, that the card was charged and must not be charged again; the
// banner stays with "Save payment again" (the same write, no new charge), and
// no new tender starts while the record stands.

const mock = vi.hoisted(() => {
  const recordPayment = vi.fn();
  const listUnsavedPayments = vi.fn();
  const saveUnsavedPayments = vi.fn();
  const processPayment = vi.fn();
  const bridge = {
    payments: { recordPayment, listUnsavedPayments, saveUnsavedPayments },
    ecr: {
      getDefaultTerminal: vi.fn(async () => ({ device: { id: 'eft-1', name: 'EFT' } })),
      getDeviceStatus: vi.fn(async () => ({ connected: true, ready: true, busy: false })),
      processPayment,
    },
    orders: { getById: vi.fn(async () => ({ id: 'order-1', plugin: 'pos' })) },
  };
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { bridge, recordPayment, listUnsavedPayments, saveUnsavedPayments, processPayment, toast };
});

vi.mock('../../../../lib', () => ({
  getBridge: () => mock.bridge,
}));
vi.mock('react-hot-toast', () => ({ default: mock.toast }));
vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ children, isOpen }: any) => (isOpen ? <div>{children}</div> : null),
}));

import en from '../../../../locales/en.json';
import el from '../../../../locales/el.json';
import { SinglePaymentCollectionModal } from '../SinglePaymentCollectionModal';

const LOCALES = { en, el } as const;
type Lng = keyof typeof LOCALES;

const createI18n = async (lng: Lng) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    resources: Object.fromEntries(
      Object.entries(LOCALES).map(([code, translation]) => [code, { translation }]),
    ),
    interpolation: { escapeValue: false },
  });
  return instance;
};

const NATIVE_ENGLISH =
  'The card was charged 13.00, but the payment could not be saved on this till yet. Do not charge again: save the payment again.';

const RECORD = {
  idempotencyKey: 'terminal-card:txn-approved-1',
  orderId: 'order-1',
  method: 'card',
  amount: 13,
  amountCents: 1300,
  currency: 'EUR',
  transactionRef: 'txn-approved-1',
  kind: 'single',
  capturedAt: '2026-09-30T10:05:00Z',
  attempts: 4,
  canSaveAgain: true,
};

const notSavedAnswer = {
  success: false,
  errorCode: 'PAYMENT_NOT_SAVED',
  paymentNotSaved: true,
  paymentApproved: true,
  paymentPersisted: false,
  requiresReconciliation: true,
  orderId: 'order-1',
  method: 'card',
  amount: 13,
  amountCents: 1300,
  unsavedPayment: RECORD,
  error: NATIVE_ENGLISH,
  message: NATIVE_ENGLISH,
};

const renderModal = async (
  lng: Lng,
  method: 'cash' | 'card',
  handlers: { onClose?: () => void; onPaymentCollected?: () => void } = {},
) => {
  const i18n = await createI18n(lng);
  const onClose = handlers.onClose ?? vi.fn();
  const onPaymentCollected = handlers.onPaymentCollected ?? vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <SinglePaymentCollectionModal
        isOpen
        onClose={onClose}
        onPaymentCollected={onPaymentCollected}
        orderId="order-1"
        orderNumber="A-0077"
        method={method}
        outstandingAmount={13}
      />
    </I18nextProvider>,
  );
  return { i18n, onClose, onPaymentCollected };
};

const collectButton = (i18n: typeof i18next, method: 'cash' | 'card') =>
  screen.getByRole('button', {
    name: method === 'card'
      ? i18n.t('orderDashboard.collectCardNow', { defaultValue: 'Collect card payment' })
      : i18n.t('orderDashboard.collectCashNow', { defaultValue: 'Collect cash payment' }),
  });

describe('SinglePaymentCollectionModal: a card charged but not saved', () => {
  beforeEach(() => {
    mock.recordPayment.mockReset();
    mock.listUnsavedPayments.mockReset();
    mock.saveUnsavedPayments.mockReset();
    mock.processPayment.mockReset();
    mock.toast.mockReset();
    mock.toast.success.mockReset();
    mock.toast.error.mockReset();
    mock.processPayment.mockResolvedValue({
      success: true,
      transaction: { status: 'approved', transactionId: 'txn-approved-1' },
    });
  });

  afterEach(() => cleanup());

  it('says it in the store language, keeps the record in view, and never charges again', async () => {
    let listed: unknown[] = [];
    mock.listUnsavedPayments.mockImplementation(async () => ({ success: true, payments: listed }));
    mock.recordPayment.mockImplementation(async () => {
      listed = [RECORD];
      return notSavedAnswer;
    });
    const onPaymentCollected = vi.fn();
    const { i18n, onClose } = await renderModal('el', 'card', { onPaymentCollected });

    await act(async () => {
      fireEvent.click(collectButton(i18n, 'card'));
    });

    const expected = i18n.t('payment.notSaved.message', { amount: '€13.00' });
    await waitFor(() => expect(mock.toast.error).toHaveBeenCalled());
    const shown = String(mock.toast.error.mock.calls[0][0]);
    expect(shown).not.toContain('could not be saved on this till');
    expect(shown).not.toContain(i18n.t('orderDashboard.collectPaymentFailed', { defaultValue: 'Failed to collect payment.' }));
    expect(shown.startsWith(expected.split('13')[0])).toBe(true);
    expect(await screen.findByTestId('unsaved-charged-payment-banner')).toBeTruthy();
    expect(onPaymentCollected).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The collection stays closed to a second charge.
    expect((collectButton(i18n, 'card') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(collectButton(i18n, 'card'));
    });
    expect(mock.processPayment).toHaveBeenCalledTimes(1);
  });

  it('refuses cash while a charged payment is not saved, and Save payment again saves it without charging', async () => {
    mock.listUnsavedPayments.mockResolvedValue({ success: true, payments: [RECORD] });
    mock.saveUnsavedPayments.mockResolvedValue({
      success: true,
      saved: 1,
      setAside: [],
      unsaved: [],
      results: [],
    });
    const { i18n, onClose } = await renderModal('en', 'cash');

    expect(await screen.findByTestId('unsaved-charged-payment-banner')).toBeTruthy();
    expect((collectButton(i18n, 'cash') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(collectButton(i18n, 'cash'));
    });
    expect(mock.recordPayment).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('payment.notSaved.saveAgain') }));
    });
    await waitFor(() =>
      expect(mock.saveUnsavedPayments).toHaveBeenCalledWith({ orderId: 'order-1' }),
    );
    expect(mock.processPayment).not.toHaveBeenCalled();
    expect(mock.toast.success).toHaveBeenCalledWith(i18n.t('payment.notSaved.saved'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
