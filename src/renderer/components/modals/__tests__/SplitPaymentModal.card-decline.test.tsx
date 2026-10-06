import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 06/10/2026 money review.
// C1: a split portion whose card the terminal DECLINED went back to a draft
// that still said "card" (manual origin, no notice), and Confirm Split then
// booked a manual card payment for money the terminal had refused.
// D: with no ready terminal the portion became a manual card at once, even when
// a terminal was configured but busy or disconnected, and without the fresh
// server admission Android requires (requireNoConnectedPaymentProvider).

const DECLINED_TEXT = 'The card was declined. Nothing was charged.';
const NOT_READY_TEXT = 'The card terminal is busy or not connected.';
const PROVIDER_TEXT = 'A card payment provider is connected for this store';
const UNAVAILABLE_TEXT = 'Could not confirm that a manual card is allowed on this till.';
const ALREADY_TAKEN_TEXT = "If the card was already taken on the shop's own card machine, do not charge it again.";

const mocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  // One stable translator: a new function per render would re-run the
  // modal's loading effect forever.
  const t = (key: string, fallback?: string | { defaultValue?: string }) => (
    typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
  );
  return {
    t,
    toast,
    askForPaymentPrint: vi.fn(),
    bridge: {
      invoke: vi.fn(),
      giftCardCheckout: { reconcileOrder: vi.fn(), redeemForOrder: vi.fn() },
      adminApi: { fetchFromAdmin: vi.fn() },
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
import {
  clearTerminalCredentialCache,
  updateTerminalCredentialCache,
} from '../../../services/terminal-credentials';

const SCOPE = { organizationId: 'org-split-card', terminalId: 'term-split-card' };
const BRANCH = 'branch-split-card';
const EFT = { id: 'eft-1', name: 'EFT' };
const READY = { connected: true, ready: true, busy: false };

let sequence = 0;
const nextOrderId = (label: string) => `split-card-${label}-${++sequence}`;

const admissionAnswer = (providerConnected: boolean, meta: Record<string, unknown> = { source: 'remote' }) => ({
  success: true,
  status: 200,
  meta,
  data: {
    success: true,
    admission_version: 1,
    organization_id: SCOPE.organizationId,
    branch_id: BRANCH,
    terminal_id: SCOPE.terminalId,
    provider_connected: providerConnected,
  },
});

/** A terminal reply that proves no money moved: exact transaction, final decline. */
const DECLINED_REPLY = {
  success: false,
  transaction: { status: 'declined', transactionId: 'txn-declined-1', errorMessage: 'Insufficient funds' },
};

const renderSplit = (orderId: string, collectionScope?: typeof SCOPE) => render(
  <SplitPaymentModal
    isOpen
    onClose={vi.fn()}
    orderId={orderId}
    orderTotal={20}
    items={[{ name: 'Coffee', quantity: 1, totalPrice: 20 }]}
    onSplitComplete={vi.fn()}
    collectionScope={collectionScope}
  />,
);

const confirmButton = () => {
  const button = screen.getAllByRole('button').find((candidate) => /confirm split/i.test(candidate.textContent ?? ''));
  if (!button) throw new Error('confirm button not rendered');
  return button;
};
const methodButtons = (person: number) => {
  const [cash, card] = Array.from(screen.getByRole('group', { name: `Person ${person}` }).querySelectorAll('button'));
  return { cash, card };
};
const errorToasts = () => mocks.toast.error.mock.calls.map((call) => String(call[0]));
const cardRecords = () => mocks.bridge.payments.recordPayment.mock.calls
  .map((call) => call[0] as Record<string, unknown>)
  .filter((input) => input.method === 'card');

describe('SplitPaymentModal card portions only book money the card actually moved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateTerminalCredentialCache({ organizationId: SCOPE.organizationId, branchId: BRANCH, terminalId: SCOPE.terminalId });
    mocks.askForPaymentPrint.mockResolvedValue(false);
    mocks.bridge.invoke.mockResolvedValue({ success: true });
    mocks.bridge.giftCardCheckout.reconcileOrder.mockResolvedValue({
      success: true, applied: [], abandoned: 0, unresolved: 0, reconciliationPending: false,
    });
    mocks.bridge.payments.listUnsavedPayments.mockResolvedValue({ success: true, payments: [] });
    mocks.bridge.payments.getOrderPayments.mockResolvedValue([]);
    mocks.bridge.payments.getPaidItems.mockResolvedValue([]);
    mocks.bridge.payments.getSettlementSnapshot.mockImplementation(async (orderId: string) => ({
      success: true, orderId, orderTotal: 20, netPaid: 0, outstandingAmount: 20,
      completedPayments: [], generation: '0'.repeat(64), unresolvedDirectSale: null,
    }));
    let paymentNumber = 0;
    mocks.bridge.payments.recordPayment.mockImplementation(async () => ({
      success: true, paymentId: `pay-${++paymentNumber}`, paymentPersisted: true,
    }));
    mocks.bridge.orders.getById.mockResolvedValue({
      total_amount: 20, subtotal: 20, discount_amount: 0, tax_amount: 0, delivery_fee: 0, tip_amount: 0,
    });
    mocks.bridge.orders.updateFinancials.mockResolvedValue({ success: true });
    mocks.bridge.settings.get.mockResolvedValue(false);
    mocks.bridge.ecr.getDefaultTerminal.mockResolvedValue({ success: true, device: EFT });
    mocks.bridge.ecr.getDeviceStatus.mockResolvedValue(READY);
    mocks.bridge.ecr.processPayment.mockResolvedValue(DECLINED_REPLY);
    mocks.bridge.adminApi.fetchFromAdmin.mockResolvedValue(admissionAnswer(false));
  });

  afterEach(() => {
    cleanup();
    clearTerminalCredentialCache();
  });

  describe('C1: a declined card', () => {
    it.each([
      ['without a collection scope', undefined],
      ['under the ordinary collection guard', SCOPE],
    ])('puts the portion back to its earlier method and Confirm never books it as a card (%s)', async (_label, scope) => {
      renderSplit(nextOrderId('declined'), scope);
      await waitFor(() => expect(confirmButton()).toBeEnabled());

      await act(async () => {
        fireEvent.click(methodButtons(1).card);
      });
      await waitFor(() => expect(errorToasts()).toContain(DECLINED_TEXT));
      expect(mocks.bridge.ecr.processPayment).toHaveBeenCalledTimes(1);

      // The portion is cash again, with no manual-card notice.
      await waitFor(() => expect(methodButtons(1).cash).toHaveAttribute('aria-pressed', 'true'));
      expect(methodButtons(1).card).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryByRole('status')).not.toBeInTheDocument();

      await waitFor(() => expect(confirmButton()).toBeEnabled());
      await act(async () => {
        fireEvent.click(confirmButton());
      });
      await waitFor(() => expect(mocks.bridge.payments.recordPayment).toHaveBeenCalledTimes(2));
      expect(cardRecords()).toEqual([]);
      expect(mocks.bridge.payments.recordPayment).toHaveBeenNthCalledWith(1, expect.objectContaining({ method: 'cash', amount: 10, terminalDeviceId: undefined }));
      expect(mocks.bridge.ecr.processPayment).toHaveBeenCalledTimes(1);
    });

    it.each<[string, () => void]>([
      ['a lost terminal reply', () => mocks.bridge.ecr.processPayment.mockRejectedValue(new Error('ECR link lost'))],
      ['a cancelled sale', () => mocks.bridge.ecr.processPayment.mockResolvedValue({
        success: false, transaction: { status: 'cancelled', transactionId: 'txn-cancelled-1', errorMessage: 'Cancelled on terminal' },
      })],
    ])('never claims "declined, nothing charged" after %s, and still never books a card on Confirm', async (_label, arrange) => {
      arrange();
      renderSplit(nextOrderId('unknown'));
      await waitFor(() => expect(confirmButton()).toBeEnabled());

      await act(async () => {
        fireEvent.click(methodButtons(1).card);
      });
      await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
      expect(errorToasts()).not.toContain(DECLINED_TEXT);
      await waitFor(() => expect(methodButtons(1).card).toHaveAttribute('aria-pressed', 'false'));

      await waitFor(() => expect(confirmButton()).toBeEnabled());
      await act(async () => {
        fireEvent.click(confirmButton());
      });
      await waitFor(() => expect(mocks.bridge.payments.recordPayment).toHaveBeenCalled());
      expect(cardRecords()).toEqual([]);
    });
  });

  describe('D: a manual card portion needs no terminal on this till and a fresh admission', () => {
    it.each([
      ['busy', { connected: true, ready: true, busy: true }],
      ['disconnected', { connected: false, ready: false, busy: false }],
    ])('refuses a configured terminal that is %s and never turns the portion into a manual card', async (_label, status) => {
      mocks.bridge.ecr.getDeviceStatus.mockResolvedValue(status);
      renderSplit(nextOrderId('not-ready'));
      await waitFor(() => expect(confirmButton()).toBeEnabled());

      await act(async () => {
        fireEvent.click(methodButtons(1).card);
      });
      await waitFor(() => expect(errorToasts().some((message) => message.startsWith(NOT_READY_TEXT))).toBe(true));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      await waitFor(() => expect(methodButtons(1).card).toHaveAttribute('aria-pressed', 'false'));
      expect(mocks.bridge.ecr.processPayment).not.toHaveBeenCalled();
      expect(mocks.bridge.adminApi.fetchFromAdmin).not.toHaveBeenCalled();

      await waitFor(() => expect(confirmButton()).toBeEnabled());
      await act(async () => {
        fireEvent.click(confirmButton());
      });
      await waitFor(() => expect(mocks.bridge.payments.recordPayment).toHaveBeenCalledTimes(2));
      expect(cardRecords()).toEqual([]);
    });

    it.each<[string, () => void, string]>([
      ['a connected payment provider', () => mocks.bridge.adminApi.fetchFromAdmin.mockResolvedValue(admissionAnswer(true)), PROVIDER_TEXT],
      ['a cached admission answer', () => mocks.bridge.adminApi.fetchFromAdmin.mockResolvedValue(admissionAnswer(false, { source: 'cache', offlineFallback: true })), UNAVAILABLE_TEXT],
      ['a failed admission request', () => mocks.bridge.adminApi.fetchFromAdmin.mockRejectedValue(new Error('offline')), UNAVAILABLE_TEXT],
    ])('with no terminal, refuses the manual card after %s', async (_label, arrange, expected) => {
      mocks.bridge.ecr.getDefaultTerminal.mockResolvedValue({ success: false, device: null });
      arrange();
      renderSplit(nextOrderId('refused'));
      await waitFor(() => expect(confirmButton()).toBeEnabled());

      await act(async () => {
        fireEvent.click(methodButtons(1).card);
      });
      await waitFor(() => expect(errorToasts().some((message) => message.startsWith(expected))).toBe(true));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      await waitFor(() => expect(methodButtons(1).card).toHaveAttribute('aria-pressed', 'false'));
      expect(mocks.bridge.ecr.processPayment).not.toHaveBeenCalled();

      await waitFor(() => expect(confirmButton()).toBeEnabled());
      await act(async () => {
        fireEvent.click(confirmButton());
      });
      await waitFor(() => expect(mocks.bridge.payments.recordPayment).toHaveBeenCalledTimes(2));
      expect(cardRecords()).toEqual([]);
    });

    it('with no terminal and a fresh admission, shows the manual notice and asks again before Confirm records it', async () => {
      mocks.bridge.ecr.getDefaultTerminal.mockResolvedValue({ success: false, device: null });
      renderSplit(nextOrderId('admitted'), SCOPE);
      await waitFor(() => expect(confirmButton()).toBeEnabled());

      await act(async () => {
        fireEvent.click(methodButtons(1).card);
      });
      expect(await screen.findByRole('status')).toHaveTextContent("shop's own card machine");
      expect(mocks.bridge.adminApi.fetchFromAdmin).toHaveBeenCalledTimes(1);
      expect(mocks.bridge.payments.recordPayment).not.toHaveBeenCalled();

      await waitFor(() => expect(confirmButton()).toBeEnabled());
      await act(async () => {
        fireEvent.click(confirmButton());
      });
      await waitFor(() => expect(mocks.bridge.payments.recordPayment).toHaveBeenCalledTimes(2));
      expect(mocks.bridge.adminApi.fetchFromAdmin).toHaveBeenCalledTimes(2);
      expect(mocks.bridge.payments.recordPayment).toHaveBeenNthCalledWith(1, expect.objectContaining({
        method: 'card', amount: 10, paymentOrigin: 'manual', terminalApproved: false, terminalDeviceId: undefined,
      }));
      expect(mocks.bridge.ecr.processPayment).not.toHaveBeenCalled();
    });

    it('records nothing when the admission is withdrawn between the offer and Confirm', async () => {
      mocks.bridge.ecr.getDefaultTerminal.mockResolvedValue({ success: false, device: null });
      renderSplit(nextOrderId('withdrawn'));
      await waitFor(() => expect(confirmButton()).toBeEnabled());

      await act(async () => {
        fireEvent.click(methodButtons(1).card);
      });
      await screen.findByRole('status');
      mocks.bridge.adminApi.fetchFromAdmin.mockResolvedValue(admissionAnswer(true));

      await waitFor(() => expect(confirmButton()).toBeEnabled());
      await act(async () => {
        fireEvent.click(confirmButton());
      });
      await waitFor(() => expect(mocks.bridge.adminApi.fetchFromAdmin).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(errorToasts().some((message) => message.startsWith(PROVIDER_TEXT) && message.endsWith(ALREADY_TAKEN_TEXT))).toBe(true));
      expect(mocks.bridge.payments.recordPayment).not.toHaveBeenCalled();
      // The withdrawn manual card is no longer offered; Confirm stays closed until the cashier chooses again.
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      expect(confirmButton()).toBeDisabled();
    });
  });
});
