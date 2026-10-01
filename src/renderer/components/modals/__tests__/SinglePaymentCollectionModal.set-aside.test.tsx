import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix review 30/09/2026 (Android 1.0.13 parity). A card the payment terminal
// already approved can find its order covered by the time it is recorded (a
// restore, or another terminal's payment, landed during the card interaction).
// The money moved: native records it set aside for a manager to give back and
// answers PAYMENT_SET_ASIDE_FOR_REVIEW. The cashier must read that in the
// store's language, must not be told the card failed, and must not be invited
// to charge again.

const mock = vi.hoisted(() => {
  const recordPayment = vi.fn();
  const processPayment = vi.fn();
  const bridge = {
    payments: { recordPayment },
    ecr: {
      getDefaultTerminal: vi.fn(async () => ({ device: { id: 'eft-1', name: 'EFT' } })),
      getDeviceStatus: vi.fn(async () => ({ connected: true, ready: true, busy: false })),
      processPayment,
    },
    orders: { getById: vi.fn(async () => ({ id: 'order-1', plugin: 'pos' })) },
  };
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { bridge, recordPayment, processPayment, toast };
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
import sq from '../../../../locales/sq.json';
import { SinglePaymentCollectionModal } from '../SinglePaymentCollectionModal';

const LOCALES = { en, el, sq } as const;
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
  'This order was already paid. The 13.00 just taken is recorded for a manager to give back and is not counted. Do not charge it again.';

describe('SinglePaymentCollectionModal: an approved card that found the order paid', () => {
  beforeEach(() => {
    mock.recordPayment.mockReset();
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

  it.each(['el', 'sq'] as Lng[])(
    'tells the cashier in %s that it was set aside, closes, and never reports a collection',
    async (lng) => {
      mock.recordPayment.mockResolvedValue({
        success: false,
        errorCode: 'PAYMENT_SET_ASIDE_FOR_REVIEW',
        paymentSetAside: true,
        paymentApproved: true,
        paymentPersisted: true,
        paymentId: 'pay-set-aside-1',
        amount: 13,
        amountDue: 0,
        reason: 'order_already_covered',
        error: NATIVE_ENGLISH,
        message: NATIVE_ENGLISH,
      });
      const i18n = await createI18n(lng);
      const onClose = vi.fn();
      const onPaymentCollected = vi.fn();
      render(
        <I18nextProvider i18n={i18n}>
          <SinglePaymentCollectionModal
            isOpen
            onClose={onClose}
            onPaymentCollected={onPaymentCollected}
            orderId="order-1"
            orderNumber="A-0042"
            method="card"
            outstandingAmount={13}
          />
        </I18nextProvider>,
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: i18n.t('orderDashboard.collectCardNow', { defaultValue: 'Collect card payment' }) }));
      });

      await waitFor(() => expect(mock.toast.error).toHaveBeenCalled());
      const [message] = mock.toast.error.mock.calls[0];
      expect(message).toContain('13');
      expect(message).not.toContain('Do not charge it again');
      expect(message).not.toMatch(/\{\{\w+\}\}/);
      expect(message.startsWith(i18n.t('payment.setAside.message', { amount: '§' }).split('§')[0])).toBe(true);
      expect(onClose).toHaveBeenCalled();
      expect(onPaymentCollected).not.toHaveBeenCalled();
      expect(mock.toast.success).not.toHaveBeenCalled();
      // It is sent once: a set-aside answer is never retried.
      expect(mock.recordPayment).toHaveBeenCalledTimes(1);
      expect(mock.recordPayment.mock.calls[0][0]).toMatchObject({
        terminalApproved: true,
        transactionRef: 'txn-approved-1',
      });
    },
  );

  it('says what was still due when the card was worth more than the balance', async () => {
    mock.recordPayment.mockResolvedValue({
      success: false,
      errorCode: 'PAYMENT_SET_ASIDE_FOR_REVIEW',
      paymentId: 'pay-set-aside-2',
      amount: 13,
      amountDue: 8,
      reason: 'exceeds_amount_due',
      error: 'native english',
    });
    const i18n = await createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <SinglePaymentCollectionModal
          isOpen
          onClose={() => {}}
          onPaymentCollected={() => {}}
          orderId="order-1"
          method="card"
          outstandingAmount={13}
        />
      </I18nextProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('orderDashboard.collectCardNow', { defaultValue: 'Collect card payment' }) }));
    });

    await waitFor(() => expect(mock.toast.error).toHaveBeenCalled());
    const [message] = mock.toast.error.mock.calls[0];
    expect(message).toContain('Only');
    expect(message).toContain('8');
    expect(message).toContain('Collect only what is due');
  });
});
