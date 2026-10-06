import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 06/10/2026 money review, C2. Split amounts use digit entry in cents, so
// retyping a portion as 25,00 passes through 0,02, 0,25 and 2,50. Each
// keystroke re-applied the portion's financials and clamped the stored
// discount to that intermediate gross: a 5,00 discount became 0,02 after the
// first digit and never came back. The operator's discount is now kept as
// asked and only the effective discount follows the gross.

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
      ecr: {
        fiscalPrint: vi.fn(),
        getDefaultTerminal: vi.fn(),
        getDeviceStatus: vi.fn(),
        processPayment: vi.fn(),
      },
    },
  };
});

vi.mock('react-hot-toast', () => ({ default: mocks.toast, toast: mocks.toast }));

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({
    language: 'en',
    setLanguage: vi.fn(),
    t: (_key: string, fallback?: string) => fallback ?? 'Close',
  }),
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
  usePaymentPrintPrompt: () => ({
    askForPaymentPrint: mocks.askForPaymentPrint,
    paymentPrintPromptModal: null,
  }),
}));

import { SplitPaymentModal } from '../SplitPaymentModal';
import { formatCurrency } from '../../../utils/format';

const confirmButton = () => {
  const button = screen.getAllByRole('button').find((candidate) => /confirm split/i.test(candidate.textContent ?? ''));
  if (!button) throw new Error('confirm button not rendered');
  return button;
};
const personCard = (person: number) => {
  const card = screen.getByRole('textbox', { name: `Person ${person}` }).closest('.split-payment-person');
  if (!(card instanceof HTMLElement)) throw new Error(`Person ${person} card not rendered`);
  return card;
};
const payableOf = (person: number) => personCard(person).querySelector('.split-payment-payable span:last-child')?.textContent ?? '';

describe('SplitPaymentModal portion discount survives digit entry of the amount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.askForPaymentPrint.mockResolvedValue(false);
    mocks.bridge.payments.listUnsavedPayments.mockResolvedValue({ success: true, payments: [] });
    mocks.bridge.payments.getOrderPayments.mockResolvedValue([]);
    mocks.bridge.payments.getPaidItems.mockResolvedValue([]);
    mocks.bridge.payments.getSettlementSnapshot.mockResolvedValue({ unresolvedDirectSale: null });
    let paymentNumber = 0;
    mocks.bridge.payments.recordPayment.mockImplementation(async () => ({
      success: true, paymentId: `pay-${++paymentNumber}`, paymentPersisted: true,
    }));
    mocks.bridge.orders.getById.mockResolvedValue({
      total_amount: 50, subtotal: 50, discount_amount: 0, tax_amount: 0, delivery_fee: 0, tip_amount: 0,
    });
    mocks.bridge.orders.updateFinancials.mockResolvedValue({ success: true });
    mocks.bridge.settings.get.mockResolvedValue(false);
  });

  afterEach(() => cleanup());

  it('keeps a 5,00 discount while the amount is retyped digit by digit to 25,00, and books 20,00', async () => {
    render(
      <SplitPaymentModal
        isOpen
        onClose={vi.fn()}
        orderId="order-discount-entry"
        orderTotal={50}
        items={[{ name: 'Menu', quantity: 1, totalPrice: 50 }]}
        onSplitComplete={vi.fn()}
      />,
    );
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Person 1' })).toHaveValue('25,00');

    // Apply a 5,00 discount to Person 1 (digit entry: 500).
    fireEvent.click(within(personCard(1)).getByRole('button', { name: 'Discount' }));
    fireEvent.change(within(personCard(1)).getByRole('textbox', { name: 'Discount' }), { target: { value: '500' } });
    fireEvent.click(within(personCard(1)).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(payableOf(1)).toBe(formatCurrency(20)));

    // Retype the amount the way the till's digit entry delivers it: 0,02 → 0,25 → 2,50 → 25,00.
    const amount = screen.getByRole('textbox', { name: 'Person 1' });
    for (const typed of ['2', '0,025', '0,250', '2,500']) {
      fireEvent.change(amount, { target: { value: typed } });
    }
    expect(amount).toHaveValue('25,00');
    expect(payableOf(1)).toBe(formatCurrency(20));
    expect(within(personCard(1)).getByText(`-${formatCurrency(5)}`)).toBeInTheDocument();

    // The booked payment is the gross minus the effective discount, and the
    // order keeps the same 5,00 discount once.
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    await waitFor(() => expect(mocks.bridge.payments.recordPayment).toHaveBeenCalledTimes(2));
    expect(mocks.bridge.payments.recordPayment).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'cash', amount: 20, discountAmount: 5,
    }));
    expect(mocks.bridge.payments.recordPayment).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'cash', amount: 25, discountAmount: 0,
    }));
    expect(mocks.bridge.orders.updateFinancials).toHaveBeenCalledTimes(1);
    expect(mocks.bridge.orders.updateFinancials).toHaveBeenCalledWith(expect.objectContaining({
      totalAmount: 45, discountAmount: 5,
    }));
  });

  it('shows the discount within a smaller amount without losing it when the amount grows again', async () => {
    render(
      <SplitPaymentModal
        isOpen
        onClose={vi.fn()}
        orderId="order-discount-shrink"
        orderTotal={50}
        items={[{ name: 'Menu', quantity: 1, totalPrice: 50 }]}
        onSplitComplete={vi.fn()}
      />,
    );
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(within(personCard(1)).getByRole('button', { name: 'Discount' }));
    fireEvent.change(within(personCard(1)).getByRole('textbox', { name: 'Discount' }), { target: { value: '500' } });
    fireEvent.click(within(personCard(1)).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(payableOf(1)).toBe(formatCurrency(20)));

    const amount = screen.getByRole('textbox', { name: 'Person 1' });
    // 3,00 is below the 5,00 discount: the effective discount is the whole 3,00, nothing payable.
    fireEvent.change(amount, { target: { value: '300' } });
    expect(payableOf(1)).toBe(formatCurrency(0));
    expect(within(personCard(1)).getByText(`-${formatCurrency(3)}`)).toBeInTheDocument();
    // Back to 25,00: the 5,00 the cashier asked for applies again.
    fireEvent.change(amount, { target: { value: '2500' } });
    expect(payableOf(1)).toBe(formatCurrency(20));
    expect(within(personCard(1)).getByText(`-${formatCurrency(5)}`)).toBeInTheDocument();
  });
});
