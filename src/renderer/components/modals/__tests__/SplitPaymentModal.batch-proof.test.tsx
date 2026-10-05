import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One shared native bridge for the modal and the real ordinary controller it
// drives; only this boundary is faked.
const mocks = vi.hoisted(() => {
  const recordPayment = vi.fn();
  const getOrderById = vi.fn();
  return {
    recordPayment,
    getOrderById,
    askForPaymentPrint: vi.fn().mockResolvedValue(false),
    bridge: {
      invoke: vi.fn(async () => ({ success: true })),
      giftCardCheckout: {
        reconcileOrder: vi.fn(async () => ({
          success: true, applied: [], abandoned: 0, unresolved: 0, reconciliationPending: false,
        })),
        redeemForOrder: vi.fn(),
      },
      payments: {
        listUnsavedPayments: vi.fn(async () => ({ payments: [] })),
        getOrderPayments: vi.fn(async () => []),
        getPaidItems: vi.fn(async () => []),
        getSettlementSnapshot: vi.fn(),
        printSplitReceipt: vi.fn(),
        printReceipt: vi.fn(),
        recordPayment,
      },
      orders: {
        getById: getOrderById,
        updateFinancials: vi.fn(),
      },
      settings: { get: vi.fn().mockResolvedValue(false) },
      ecr: {
        fiscalPrint: vi.fn(),
        getDefaultTerminal: vi.fn(),
        getDeviceStatus: vi.fn(),
        processPayment: vi.fn(),
      },
    },
  };
});

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({
    language: 'en',
    setLanguage: vi.fn(),
    t: (_key: string, fallback?: string) => fallback ?? 'Close',
  }),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const t = (key: string, fallback?: string | { defaultValue?: string }) => (
    typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
  );
  return {
    ...actual,
    useTranslation: () => ({
      t,
    }),
  };
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
import { probeOrdinaryOwner, retainedOrdinaryOwner } from '../../../hooks/useOrderStore';

const SCOPE = { organizationId: 'org-split', terminalId: 'term-split' };
const ORDER_ID = 'order-split-batch';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const ledgerRow = (id: string) => ({ id, status: 'completed', method: 'cash', amount: 10, transactionRef: null });
const confirmButton = () => {
  const button = screen.getAllByRole('button').find((candidate) => /confirm/i.test(candidate.textContent ?? ''));
  if (!button) throw new Error('confirm button not rendered');
  return button;
};

describe('split batch proof through the real ordinary controller', () => {
  beforeEach(() => {
    mocks.recordPayment.mockReset();
    mocks.bridge.ecr.processPayment.mockReset();
    mocks.bridge.ecr.getDefaultTerminal.mockReset();
    mocks.bridge.ecr.getDeviceStatus.mockReset();
    mocks.bridge.payments.getSettlementSnapshot.mockImplementation(async (orderId: string) => ({
      success: true, orderId, orderTotal: 20, netPaid: 0, outstandingAmount: 20,
      completedPayments: [], generation: '0'.repeat(64), unresolvedDirectSale: null,
    }));
    mocks.getOrderById.mockResolvedValue({
      total_amount: 20,
      subtotal: 20,
      discount_amount: 0,
      tax_amount: 0,
      delivery_fee: 0,
      tip_amount: 0,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it.each([true, false])('formats cent entry and books the numeric values without charging a missing terminal (discounts=%s)', async (allowDiscounts) => {
    mocks.bridge.ecr.getDefaultTerminal.mockResolvedValue({ device: null });
    mocks.recordPayment.mockResolvedValue({ success: true, paymentId: 'ui-money-payment', paymentPersisted: true });
    render(<SplitPaymentModal isOpen onClose={vi.fn()} orderId="ui-currency-order" orderTotal={20}
      items={[{ name: 'Coffee', quantity: 1, totalPrice: 20 }]} onSplitComplete={vi.fn()} allowDiscounts={allowDiscounts} />);
    await tick();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    const first = screen.getByRole('textbox', { name: 'Person 1' });
    fireEvent.change(first, { target: { value: '1050' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Person 2' }), { target: { value: '950' } });
    expect(first).toHaveValue('10,50');
    fireEvent.change(first, { target: { value: '-100' } });
    expect(first).toHaveValue('10,50');
    const firstGroup = screen.getByRole('group', { name: 'Person 1' });
    fireEvent.click(firstGroup.querySelectorAll('button')[1]);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('manual card payment on confirm'));
    expect(mocks.bridge.ecr.processPayment).not.toHaveBeenCalled();
    expect(mocks.recordPayment).not.toHaveBeenCalled();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalledTimes(2));
    expect(mocks.recordPayment).toHaveBeenNthCalledWith(1, expect.objectContaining({ method: 'card', amount: 10.5, paymentOrigin: 'manual' }));
    expect(mocks.recordPayment).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: 'cash', amount: 9.5 }));
  });

  it('clears the portion notice when returning to cash', async () => {
    mocks.bridge.ecr.getDefaultTerminal.mockResolvedValue({ device: null });
    render(<SplitPaymentModal isOpen onClose={vi.fn()} orderId="ui-cash-order" orderTotal={20}
      items={[{ name: 'Coffee', quantity: 1, totalPrice: 20 }]} onSplitComplete={vi.fn()} />);
    await tick();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    const firstGroup = screen.getByRole('group', { name: 'Person 1' });
    fireEvent.click(firstGroup.querySelectorAll('button')[1]);
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('group', { name: 'Person 1' }).querySelectorAll('button')[0]);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(mocks.bridge.ecr.processPayment).not.toHaveBeenCalled();
  });

  it('keeps a batch whose second reply was lost held; the first booked row never releases it', async () => {
    // Portion one is booked as pay-A; portion two was sent but its reply was lost.
    mocks.recordPayment
      .mockResolvedValueOnce({ success: true, paymentId: 'pay-A', paymentPersisted: true })
      .mockRejectedValueOnce(new Error('IPC reply lost'));
    const onSplitComplete = vi.fn();
    const props = {
      isOpen: true,
      onClose: vi.fn(),
      orderId: ORDER_ID,
      orderTotal: 20,
      items: [{ name: 'Coffee', quantity: 1, totalPrice: 20 }],
      onSplitComplete,
      collectionScope: SCOPE,
    };
    const view = render(<SplitPaymentModal {...props} />);

    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(retainedOrdinaryOwner(SCOPE, ORDER_ID)).not.toBeNull());
    const owner = retainedOrdinaryOwner(SCOPE, ORDER_ID)!;
    expect(onSplitComplete).not.toHaveBeenCalled();

    // Close; each probe then stands for one reopen reading the canonical ledger.
    // The lost write has no reference of its own, so no ledger can prove it.
    view.unmount();
    for (const rows of [[], [ledgerRow('pay-A')], [ledgerRow('pay-A'), ledgerRow('pay-B')]]) {
      const probe = await probeOrdinaryOwner(owner, async () => ({ completedPayments: rows, value: rows.length }));
      expect(probe.status).toBe('unknown');
      expect(retainedOrdinaryOwner(SCOPE, ORDER_ID)).toBe(owner);
    }

    // Reopen: the held original still refuses any fresh money.
    const reads = mocks.getOrderById.mock.calls.length;
    render(<SplitPaymentModal {...props} />);
    await waitFor(() => expect(mocks.getOrderById.mock.calls.length).toBeGreaterThan(reads));
    await tick();
    fireEvent.click(confirmButton());
    await tick();
    await tick();
    expect(mocks.recordPayment).toHaveBeenCalledTimes(2);
    expect(mocks.bridge.ecr.processPayment).not.toHaveBeenCalled();
    expect(mocks.bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
    expect(retainedOrdinaryOwner(SCOPE, ORDER_ID)).toBe(owner);
  });

  it('books the exact saved split SALE after restart without terminal discovery or another charge', async () => {
    const orderId = 'order-split-restart-original';
    mocks.bridge.payments.getSettlementSnapshot.mockImplementation(async () => ({
      success: true, orderId, orderTotal: 20, netPaid: 0, outstandingAmount: 20,
      completedPayments: [], generation: '0'.repeat(64),
      unresolvedDirectSale: { recoverable: true, id: 'split-saved-sale', deviceId: 'offline-ecr', amountCents: 1000, currency: 'EUR', status: 'approved' },
    }));
    mocks.recordPayment.mockResolvedValue({ success: true, paymentId: 'split-saved-ledger' });
    render(<SplitPaymentModal isOpen onClose={vi.fn()} orderId={orderId} orderTotal={20}
      items={[{ name: 'Coffee', quantity: 1, totalPrice: 20 }]} onSplitComplete={vi.fn()} collectionScope={SCOPE} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Card' })[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole('button', { name: 'Card' })[0]);
    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalledWith(expect.objectContaining({
      orderId, method: 'card', amount: 10, transactionRef: 'split-saved-sale',
      paymentOrigin: 'terminal', terminalDeviceId: 'offline-ecr',
    })));
    expect(mocks.bridge.ecr.getDefaultTerminal).not.toHaveBeenCalled();
    expect(mocks.bridge.ecr.processPayment).not.toHaveBeenCalled();
    expect(mocks.recordPayment).toHaveBeenCalledTimes(1);
  });

  it('blocks fresh split confirm while a restarted direct SALE is ambiguous', async () => {
    const orderId = 'order-split-restart-unknown';
    mocks.bridge.payments.getSettlementSnapshot.mockImplementation(async () => ({
      success: true, orderId, orderTotal: 20, netPaid: 0, outstandingAmount: 20,
      completedPayments: [], generation: '0'.repeat(64),
      unresolvedDirectSale: { recoverable: false, requiresReconciliation: true },
    }));
    render(<SplitPaymentModal isOpen onClose={vi.fn()} orderId={orderId} orderTotal={20}
      items={[{ name: 'Coffee', quantity: 1, totalPrice: 20 }]} onSplitComplete={vi.fn()} collectionScope={SCOPE} />);
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mocks.bridge.payments.getSettlementSnapshot).toHaveBeenCalledWith(orderId));
    expect(mocks.recordPayment).not.toHaveBeenCalled();
    expect(mocks.bridge.ecr.processPayment).not.toHaveBeenCalled();
  });
});
