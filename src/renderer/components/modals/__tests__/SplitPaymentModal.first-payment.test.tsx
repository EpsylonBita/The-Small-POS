import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Founder 01/11/2026 («Τίποτα»): a counter order that starts with Split is saved only with its first payment.
// The split window opens on the cart with no order; the first portion creates the order together with that
// payment (the menu's checkout create, `draft.createOrder`), and every later portion records on that order.
// Backing out with nothing paid leaves nothing: no order, no payment, no read of an order that does not exist.

const mocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  const t = (key: string, fallback?: string | { defaultValue?: string }) => (
    typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
  );
  return {
    t,
    toast,
    askForPaymentPrint: vi.fn(),
    bridge: {
      payments: {
        listUnsavedPayments: vi.fn(),
        getOrderPayments: vi.fn(),
        getPaidItems: vi.fn(),
        getSettlementSnapshot: vi.fn(),
        printSplitReceipt: vi.fn(),
        printReceipt: vi.fn(),
        recordPayment: vi.fn(),
      },
      orders: { getById: vi.fn(), updateFinancials: vi.fn() },
      settings: { get: vi.fn() },
      adminApi: { fetchFromAdmin: vi.fn() },
      ecr: {
        fiscalPrint: vi.fn(),
        getDefaultTerminal: vi.fn(),
        getDeviceStatus: vi.fn(),
        processPayment: vi.fn(),
        checkoutDirectSale: vi.fn(),
      },
    },
  };
});

vi.mock('react-hot-toast', () => ({ default: mocks.toast, toast: mocks.toast }));
vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: (_key: string, fallback?: string) => fallback ?? 'Close' }),
}));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: mocks.t }) };
});
vi.mock('../../../../lib', () => ({
  getBridge: () => mocks.bridge,
  emitCompatEvent: vi.fn(),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));
vi.mock('../../../hooks/usePaymentPrintPrompt', () => ({
  usePaymentPrintPrompt: () => ({ askForPaymentPrint: mocks.askForPaymentPrint, paymentPrintPromptModal: null }),
}));

import { SplitPaymentModal } from '../SplitPaymentModal';
import { clearTerminalCredentialCache, updateTerminalCredentialCache } from '../../../services/terminal-credentials';

const NEW_ORDER = 'order-created-at-first-payment';
const CHECKOUT = 'checkout-first-payment';
const confirmButton = () => {
  const button = screen.getAllByRole('button').find((candidate) => /confirm split/i.test(candidate.textContent ?? ''));
  if (!button) throw new Error('confirm button not rendered');
  return button;
};
const personCard = (person: number) => {
  // founder 11/11/2026: the portion panel now uses the shared frosted card.
  const card = screen.getByRole('textbox', { name: `Person ${person}` }).closest('.pos-glass-form-card');
  if (!(card instanceof HTMLElement)) throw new Error(`Person ${person} card not rendered`);
  return card;
};

describe('SplitPaymentModal on a cart with no order yet', () => {
  let createOrder: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.askForPaymentPrint.mockResolvedValue(false);
    mocks.bridge.payments.listUnsavedPayments.mockResolvedValue({ success: true, payments: [] });
    mocks.bridge.payments.getPaidItems.mockResolvedValue([]);
    mocks.bridge.payments.getSettlementSnapshot.mockResolvedValue({ unresolvedDirectSale: null });
    // The ledger of the order the first portion created holds exactly that portion.
    mocks.bridge.payments.getOrderPayments.mockImplementation(async (orderId: string) => (orderId === NEW_ORDER
      ? [{ id: 'pay-first', orderId, method: 'cash', amount: 25, status: 'completed' }]
      : []));
    let paymentNumber = 0;
    mocks.bridge.payments.recordPayment.mockImplementation(async () => ({ success: true, paymentId: `pay-${++paymentNumber}`, paymentPersisted: true }));
    mocks.bridge.orders.getById.mockResolvedValue({ total_amount: 50, subtotal: 50, discount_amount: 0, tax_amount: 0, delivery_fee: 0, tip_amount: 0 });
    mocks.bridge.orders.updateFinancials.mockResolvedValue({ success: true });
    mocks.bridge.settings.get.mockResolvedValue(false);
    mocks.bridge.ecr.checkoutDirectSale.mockResolvedValue({ success: true, directSale: null });
    createOrder = vi.fn(async () => NEW_ORDER);
  });

  afterEach(() => {
    cleanup();
    clearTerminalCredentialCache();
  });

  const renderDraft = (onSplitComplete = vi.fn()) => render(
    <SplitPaymentModal
      isOpen
      onClose={vi.fn()}
      orderId=""
      orderTotal={50}
      items={[{ name: 'Menu', quantity: 1, totalPrice: 50 }]}
      onSplitComplete={onSplitComplete}
      draft={{ reference: CHECKOUT, createOrder }}
    />,
  );

  it('opens on the cart: no order is read, checked or written before a payment', async () => {
    renderDraft();
    await screen.findByRole('textbox', { name: 'Person 1' });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    expect(mocks.bridge.orders.getById).not.toHaveBeenCalled();
    expect(mocks.bridge.payments.getOrderPayments).not.toHaveBeenCalled();
    expect(mocks.bridge.payments.getPaidItems).not.toHaveBeenCalled();
    expect(mocks.bridge.payments.getSettlementSnapshot).not.toHaveBeenCalled();
    expect(mocks.bridge.payments.recordPayment).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('Confirm creates the order with the first portion, then records the second portion on it', async () => {
    const onSplitComplete = vi.fn();
    renderDraft(onSplitComplete);
    await screen.findByRole('textbox', { name: 'Person 1' });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onSplitComplete).toHaveBeenCalledTimes(1));
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ method: 'cash', amount: 25, discountAmount: 0, cashReceived: 25 }));
    expect(mocks.bridge.payments.recordPayment).toHaveBeenCalledTimes(1);
    expect(mocks.bridge.payments.recordPayment).toHaveBeenCalledWith(expect.objectContaining({ orderId: NEW_ORDER, method: 'cash', amount: 25 }));
    expect(onSplitComplete).toHaveBeenCalledWith(expect.objectContaining({ paymentIds: ['pay-first', 'pay-1'], paymentStatus: 'paid' }));
  });

  it('charges a first card portion against the checkout, then creates the order with that card', async () => {
    mocks.bridge.ecr.getDefaultTerminal.mockResolvedValue({ success: true, device: { id: 'eft-1', name: 'EFT' } });
    mocks.bridge.ecr.getDeviceStatus.mockResolvedValue({ connected: true, ready: true, busy: false });
    mocks.bridge.ecr.processPayment.mockResolvedValue({ success: true, transaction: { status: 'approved', transactionId: 'txn-first' } });
    mocks.bridge.payments.getOrderPayments.mockImplementation(async (orderId: string) => (orderId === NEW_ORDER
      ? [{ id: 'pay-card-first', orderId, method: 'card', amount: 25, status: 'completed', transactionRef: 'txn-first' }]
      : []));
    renderDraft();
    await screen.findByRole('textbox', { name: 'Person 1' });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(within(personCard(1)).getByRole('button', { name: /card/i }));

    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1));
    const [amount, options] = mocks.bridge.ecr.processPayment.mock.calls[0];
    expect(amount).toBe(25);
    // Bound to the checkout until the order exists (native refuses a SALE naming an order that is not there).
    expect(options).toEqual(expect.objectContaining({ deviceId: 'eft-1', checkoutRequestId: CHECKOUT }));
    expect(options.orderId).toBeUndefined();
    expect(String(options.reference)).toMatch(new RegExp(`^${CHECKOUT}:`));
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({
      method: 'card', amount: 25, transactionRef: 'txn-first', paymentOrigin: 'terminal', terminalApproved: true, terminalDeviceId: 'eft-1',
    }));
    expect(mocks.bridge.payments.recordPayment).not.toHaveBeenCalled();
    expect(mocks.bridge.payments.getSettlementSnapshot).not.toHaveBeenCalledWith('');
  });

  // Founder 01/11/2026: without a connected card plugin (every store today) Card is a plain record, like cash. The
  // till never calls a terminal or waits for one, and the first card portion creates the order with that card.
  it('without a connected card plugin, a first card portion is a plain record: no terminal, no wait, the order is created with it', async () => {
    // Native answers no admitted card terminal (no payment plugin connected), and the server says no provider.
    mocks.bridge.ecr.getDefaultTerminal.mockResolvedValue({ success: true, device: null });
    updateTerminalCredentialCache({ organizationId: 'org-split', branchId: 'branch-split', terminalId: 'term-split' });
    mocks.bridge.adminApi.fetchFromAdmin.mockResolvedValue({
      success: true, status: 200, meta: { source: 'remote' },
      data: { success: true, admission_version: 1, organization_id: 'org-split', branch_id: 'branch-split', terminal_id: 'term-split', provider_connected: false },
    });
    mocks.bridge.payments.getOrderPayments.mockImplementation(async (orderId: string) => (orderId === NEW_ORDER
      ? [{ id: 'pay-card-first', orderId, method: 'card', amount: 25, status: 'completed' }]
      : []));
    const onSplitComplete = vi.fn();
    renderDraft(onSplitComplete);
    await screen.findByRole('textbox', { name: 'Person 1' });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(within(personCard(1)).getByRole('button', { name: /card/i }));
    await waitFor(() => expect(within(personCard(1)).getByRole('status')).toHaveTextContent('recorded as a manual card payment'));
    expect(createOrder).not.toHaveBeenCalled();

    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onSplitComplete).toHaveBeenCalledTimes(1));
    // The order and its card payment are created together at the first portion; the second portion records on it.
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({
      method: 'card', amount: 25, paymentOrigin: 'manual',
      // The admission travels with the card for the admin's review (founder 01/11/2026).
      metadata: { admission_basis: 'live', admission_checked_at: expect.any(String) },
    }));
    expect(mocks.bridge.payments.recordPayment).toHaveBeenCalledTimes(1);
    expect(mocks.bridge.payments.recordPayment).toHaveBeenCalledWith(expect.objectContaining({ orderId: NEW_ORDER, method: 'cash', amount: 25 }));
    expect(mocks.bridge.payments.recordPayment.mock.calls[0][0].metadata).toBeUndefined();
    // No terminal anywhere: no status read, no SALE, no checkout SALE readback holding the order.
    expect(mocks.bridge.ecr.getDeviceStatus).not.toHaveBeenCalled();
    expect(mocks.bridge.ecr.processPayment).not.toHaveBeenCalled();
    expect(onSplitComplete).toHaveBeenCalledWith(expect.objectContaining({ paymentIds: ['pay-card-first', 'pay-1'], paymentStatus: 'paid' }));
  });

  it('keeps portion discounts until the order exists', async () => {
    renderDraft();
    await screen.findByRole('textbox', { name: 'Person 1' });
    expect(within(personCard(1)).queryByRole('button', { name: 'Discount' })).toBeNull();
  });

  it('a create that saved nothing leaves the cart unpaid and the window open', async () => {
    createOrder.mockRejectedValueOnce(new Error('The order was not saved'));
    const onSplitComplete = vi.fn();
    renderDraft(onSplitComplete);
    await screen.findByRole('textbox', { name: 'Person 1' });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(confirmButton());

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('The order was not saved'));
    expect(mocks.bridge.payments.recordPayment).not.toHaveBeenCalled();
    expect(onSplitComplete).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Person 1' })).toBeTruthy();
  });

  it('a first card charged but not saved is held on its portion, shown, and never charged again', async () => {
    mocks.bridge.ecr.getDefaultTerminal.mockResolvedValue({ success: true, device: { id: 'eft-1', name: 'EFT' } });
    mocks.bridge.ecr.getDeviceStatus.mockResolvedValue({ connected: true, ready: true, busy: false });
    mocks.bridge.ecr.processPayment.mockResolvedValue({ success: true, transaction: { status: 'approved', transactionId: 'txn-held' } });
    createOrder.mockRejectedValueOnce(Object.assign(
      new Error('The card was charged 25,00. The payment could not be saved on this till yet. Do NOT charge again: save the payment again.'),
      { paymentNotSaved: true },
    ));
    renderDraft();
    await screen.findByRole('textbox', { name: 'Person 1' });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    // Native holds the charge under the checkout once the terminal has charged it.
    mocks.bridge.payments.listUnsavedPayments.mockImplementation(async () => ({
      success: true,
      payments: mocks.bridge.ecr.processPayment.mock.calls.length > 0 ? [{ orderId: CHECKOUT, amount: 25, currency: 'EUR', canSaveAgain: true }] : [],
    }));
    fireEvent.click(within(personCard(1)).getByRole('button', { name: /card/i }));

    expect(await screen.findByTestId(/^split-portion-unsaved-/)).toBeTruthy();
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringMatching(/Do NOT charge again/), expect.anything());
    expect(mocks.bridge.payments.listUnsavedPayments).toHaveBeenCalledWith(CHECKOUT);
    // The held portion is no chargeable draft, and the other person waits while the charge stands.
    fireEvent.click(within(personCard(2)).getByRole('button', { name: /card/i }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(2));
    expect(mocks.bridge.ecr.processPayment).toHaveBeenCalledTimes(1);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  // Coordinator decision (A), 01/11/2026: a card SALE the checkout already took (a crash between the approval and
  // the create) is read back and recorded with the order; it is never charged a second time.
  it('a card already charged for the checkout is shown and saved with the order, never charged again', async () => {
    mocks.bridge.ecr.checkoutDirectSale.mockResolvedValue({ success: true, directSale: {
      recoverable: true, id: 'sale-held', deviceId: 'eft-1', amount: 25, amountCents: 2500, currency: 'EUR', status: 'approved',
    } });
    mocks.bridge.ecr.getDefaultTerminal.mockResolvedValue({ success: true, device: { id: 'eft-1', name: 'EFT' } });
    mocks.bridge.ecr.getDeviceStatus.mockResolvedValue({ connected: true, ready: true, busy: false });
    renderDraft();
    const notice = await screen.findByTestId('split-checkout-sale');
    expect(notice.textContent).toMatch(/already charged/);
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(within(notice).getByRole('button', { name: 'Save card payment' }));

    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1));
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({
      method: 'card', amount: 25, transactionRef: 'sale-held', paymentOrigin: 'terminal', terminalApproved: true, terminalDeviceId: 'eft-1',
    }));
    expect(mocks.bridge.ecr.processPayment).not.toHaveBeenCalled();
  });

  it('a card whose outcome is not known holds the split: no new charge and no Confirm', async () => {
    mocks.bridge.ecr.checkoutDirectSale.mockResolvedValue({ success: true, directSale: {
      recoverable: false, requiresReconciliation: true, amountCents: 2500, currency: 'EUR', status: 'error',
    } });
    mocks.bridge.ecr.getDefaultTerminal.mockResolvedValue({ success: true, device: { id: 'eft-1', name: 'EFT' } });
    mocks.bridge.ecr.getDeviceStatus.mockResolvedValue({ connected: true, ready: true, busy: false });
    renderDraft();
    const notice = await screen.findByTestId('split-checkout-sale');
    expect(notice.textContent).toMatch(/did not answer/);
    expect(within(notice).getByRole('button', { name: 'Check again' })).toBeTruthy();
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());

    fireEvent.click(within(personCard(1)).getByRole('button', { name: /card/i }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(2));
    expect(mocks.bridge.ecr.processPayment).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
  });
});

