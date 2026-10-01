import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix review 30/09/2026 (Android 1.0.13 parity). A split portion charged on
// the terminal whose payment could not be saved used to go back to a draft
// with an error, ready to be charged again. It now stays "charged, not saved",
// the order's other portions wait, and the banner offers Save payment again.

const RECORD = {
  idempotencyKey: 'terminal-card:txn-portion-1',
  orderId: 'order-1',
  method: 'card',
  amount: 10,
  amountCents: 1000,
  currency: 'EUR',
  transactionRef: 'txn-portion-1',
  kind: 'split_portion',
  capturedAt: '2026-09-30T10:05:00Z',
  attempts: 4,
  canSaveAgain: true,
};

const mocks = vi.hoisted(() => {
  const getOrderPayments = vi.fn();
  const getPaidItems = vi.fn();
  const getOrderById = vi.fn();
  const recordPayment = vi.fn();
  // #308: every card collection first reads the order's unresolved direct SALE.
  const getSettlementSnapshot = vi.fn();
  const listUnsavedPayments = vi.fn();
  const saveUnsavedPayments = vi.fn();
  const processPayment = vi.fn();
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  // One stable translator: a new function per render would re-run the
  // modal's loading effect forever.
  const t = (key: string, fallback?: string | { defaultValue?: string }) => (
    typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
  );
  return {
    t,
    getOrderPayments,
    getPaidItems,
    getOrderById,
    recordPayment,
    getSettlementSnapshot,
    listUnsavedPayments,
    saveUnsavedPayments,
    processPayment,
    toast,
    askForPaymentPrint: vi.fn().mockResolvedValue(false),
    bridge: {
      payments: {
        getOrderPayments,
        getPaidItems,
        printSplitReceipt: vi.fn(),
        printReceipt: vi.fn(),
        recordPayment,
        getSettlementSnapshot,
        listUnsavedPayments,
        saveUnsavedPayments,
      },
      orders: {
        getById: getOrderById,
        updateFinancials: vi.fn(),
      },
      settings: { get: vi.fn().mockResolvedValue(false) },
      ecr: {
        fiscalPrint: vi.fn(),
        getDefaultTerminal: vi.fn(async () => ({ device: { id: 'eft-1', name: 'EFT' } })),
        getDeviceStatus: vi.fn(async () => ({ connected: true, ready: true, busy: false })),
        processPayment,
      },
    },
  };
});

vi.mock('react-hot-toast', () => ({ default: mocks.toast }));

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({
    language: 'en',
    setLanguage: vi.fn(),
    t: (_key: string, fallback?: string) => fallback ?? 'Close',
  }),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: mocks.t }),
  };
});

vi.mock('../../../../lib', () => ({
  getBridge: () => mocks.bridge,
  emitCompatEvent: vi.fn(),
}));

vi.mock('../../../hooks/usePaymentPrintPrompt', () => ({
  usePaymentPrintPrompt: () => ({
    askForPaymentPrint: mocks.askForPaymentPrint,
    paymentPrintPromptModal: null,
  }),
}));

import { SplitPaymentModal } from '../SplitPaymentModal';

const notSavedAnswer = {
  success: false,
  errorCode: 'PAYMENT_NOT_SAVED',
  paymentNotSaved: true,
  paymentApproved: true,
  paymentPersisted: false,
  requiresReconciliation: true,
  orderId: 'order-1',
  method: 'card',
  amount: 10,
  amountCents: 1000,
  unsavedPayment: RECORD,
  error: 'The card was charged 10.00, but the payment could not be saved on this till yet. Do not charge again: save the payment again.',
};

describe('SplitPaymentModal: a terminal portion charged but not saved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettlementSnapshot.mockResolvedValue({ unresolvedDirectSale: null });
    mocks.getOrderPayments.mockResolvedValue([]);
    mocks.getPaidItems.mockResolvedValue([]);
    mocks.getOrderById.mockResolvedValue({
      total_amount: 20,
      subtotal: 20,
      discount_amount: 0,
      tax_amount: 0,
      delivery_fee: 0,
      tip_amount: 0,
    });
    mocks.processPayment.mockResolvedValue({
      success: true,
      transaction: { status: 'approved', transactionId: 'txn-portion-1' },
    });
  });

  afterEach(() => cleanup());

  it('keeps the portion charged-not-saved, never a chargeable draft, and holds every other portion', async () => {
    let listed: unknown[] = [];
    mocks.listUnsavedPayments.mockImplementation(async () => ({ success: true, payments: listed }));
    mocks.recordPayment.mockImplementation(async () => {
      listed = [RECORD];
      return notSavedAnswer;
    });

    render(
      <SplitPaymentModal
        isOpen
        onClose={vi.fn()}
        orderId="order-1"
        orderTotal={20}
        items={[]}
        onSplitComplete={vi.fn()}
        initialMode="by-amount"
      />,
    );

    // The loaded order opens with two portions of 10.00.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Card' })).toHaveLength(2));
    const cardButtons = () => screen.getAllByRole('button', { name: 'Card' });
    await act(async () => {
      fireEvent.click(cardButtons()[0]);
    });

    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.querySelector('[data-testid^="split-portion-unsaved-"]')).not.toBeNull(),
    );
    expect(await screen.findByTestId('unsaved-charged-payment-banner')).toBeTruthy();
    const shown = mocks.toast.error.mock.calls.map((call) => String(call[0]));
    expect(shown.some((message) => message.includes('Do NOT charge again'))).toBe(true);
    expect(shown.some((message) => message.includes('Card payment failed'))).toBe(false);

    // Neither the charged portion nor the other one can be charged now.
    for (const button of cardButtons()) {
      await act(async () => {
        fireEvent.click(button);
      });
    }
    expect(mocks.processPayment).toHaveBeenCalledTimes(1);
  });
});
