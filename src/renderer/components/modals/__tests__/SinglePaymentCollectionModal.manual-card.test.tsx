import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 06/10/2026 money review, D. With no ready terminal the collect modal booked
// a manual card at once: also for a configured terminal that was only busy or
// disconnected, and without the fresh server admission Android requires
// (POSSystemMobile requireNoConnectedPaymentProvider). A manual card is now
// offered only with no terminal on this till and a fresh, exact-scope "no
// provider connected" answer, the cashier confirms it explicitly, and the
// admission is asked again on that confirm before anything is recorded.

const NOT_READY_TEXT = 'The card terminal is busy or not connected.';
const PROVIDER_TEXT = 'A card payment provider is connected for this store';
const UNAVAILABLE_TEXT = 'Could not confirm that a manual card is allowed on this till.';
const ALREADY_TAKEN_TEXT = "If the card was already taken on the shop's own card machine, do not charge it again.";
const CONFIRM_TITLE = 'Record a manual card payment?';

// The real ordinary collection controller and gift checkout service run
// against one faked native bridge; only native and UI chrome boundaries are faked.
const { bridge, toastMock } = vi.hoisted(() => ({
  bridge: {
    invoke: vi.fn(),
    giftCardCheckout: {
      redeemForOrder: vi.fn(),
      reconcileOrder: vi.fn(),
      fiscalReadiness: vi.fn(),
      fiscalFinalize: vi.fn(),
      fiscalReconcile: vi.fn(),
    },
    adminApi: { fetchFromAdmin: vi.fn() },
    payments: {
      getSettlementSnapshot: vi.fn(),
      recordPayment: vi.fn(),
      listUnsavedPayments: vi.fn(),
    },
    ecr: {
      processPayment: vi.fn(),
      getDefaultTerminal: vi.fn(),
      getDeviceStatus: vi.fn(),
    },
  },
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../../lib', () => ({
  getBridge: () => bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

vi.mock('../../../../services/OrderService', () => ({
  OrderService: { getInstance: () => ({ fetchOrders: vi.fn() }) },
}));

vi.mock('react-hot-toast', () => ({ default: toastMock, toast: toastMock }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: unknown) =>
      typeof options === 'string'
        ? options
        : ((options as { defaultValue?: string } | undefined)?.defaultValue ?? key),
  }),
}));

vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}));

vi.mock('../../ui/PlatformHeldPaymentNotice', () => ({
  PlatformHeldPaymentNotice: () => null,
  usePlatformHeldNoticeForOrderId: () => null,
}));

import { claimOrdinaryCollectionOwner, releaseOrdinaryOwnerBeforeSend } from '../../../hooks/useOrderStore';
import {
  clearTerminalCredentialCache,
  updateTerminalCredentialCache,
} from '../../../services/terminal-credentials';
import { SinglePaymentCollectionModal } from '../SinglePaymentCollectionModal';

const SCOPE = { organizationId: 'org-manual-card', terminalId: 'term-manual-card' };
const BRANCH = 'branch-manual-card';
const CLEAR = { success: true, applied: [], abandoned: 0, unresolved: 0, reconciliationPending: false };

let sequence = 0;
const nextOrderId = (label: string): string => `manual-card-${label}-${++sequence}`;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

const ledger = (orderId: string) => ({
  success: true,
  orderId,
  orderTotal: 12.5,
  netPaid: 0,
  outstandingAmount: 12.5,
  completedPayments: [],
  generation: 'c'.repeat(64),
  unresolvedDirectSale: null,
});

type SingleProps = React.ComponentProps<typeof SinglePaymentCollectionModal>;
const renderSingle = (orderId: string, overrides: Partial<SingleProps> = {}) => render(
  <SinglePaymentCollectionModal
    isOpen
    onClose={vi.fn()}
    onPaymentCollected={vi.fn()}
    orderId={orderId}
    method="card"
    outstandingAmount={12.5}
    totalAmount={12.5}
    collectionScope={SCOPE}
    {...overrides}
  />,
);

const collectButton = () => screen.getByRole('button', { name: 'Collect card payment' });
const errorToasts = () => toastMock.error.mock.calls.map((call) => String(call[0]));
const settle = async () => {
  await act(async () => {
    await tick();
    await tick();
  });
};

describe('SinglePaymentCollectionModal manual card admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateTerminalCredentialCache({ organizationId: SCOPE.organizationId, branchId: BRANCH, terminalId: SCOPE.terminalId });
    bridge.invoke.mockResolvedValue({ success: true });
    bridge.giftCardCheckout.reconcileOrder.mockResolvedValue(CLEAR);
    bridge.payments.listUnsavedPayments.mockResolvedValue({ success: true, payments: [] });
    bridge.payments.getSettlementSnapshot.mockImplementation(async (orderId: string) => ledger(orderId));
    bridge.payments.recordPayment.mockResolvedValue({ success: true, paymentId: 'pay-manual-1', paymentPersisted: true });
    bridge.ecr.getDefaultTerminal.mockResolvedValue({ success: false, device: null });
    bridge.ecr.getDeviceStatus.mockResolvedValue({ connected: true, ready: true, busy: false });
    bridge.adminApi.fetchFromAdmin.mockResolvedValue(admissionAnswer(false));
  });

  afterEach(() => {
    cleanup();
    clearTerminalCredentialCache();
  });

  it.each([
    ['busy', { connected: true, ready: true, busy: true }],
    ['disconnected', { connected: false, ready: false, busy: false }],
  ])('refuses a configured terminal that is %s and records nothing', async (_label, status) => {
    const orderId = nextOrderId('not-ready');
    bridge.ecr.getDefaultTerminal.mockResolvedValue({ success: true, device: { id: 'eft-1', name: 'EFT' } });
    bridge.ecr.getDeviceStatus.mockResolvedValue(status);
    const onPaymentCollected = vi.fn();
    renderSingle(orderId, { onPaymentCollected });

    fireEvent.click(collectButton());
    await waitFor(() => expect(errorToasts().some((message) => message.startsWith(NOT_READY_TEXT))).toBe(true));
    await settle();

    expect(bridge.payments.recordPayment).not.toHaveBeenCalled();
    expect(bridge.ecr.processPayment).not.toHaveBeenCalled();
    expect(bridge.adminApi.fetchFromAdmin).not.toHaveBeenCalled();
    expect(screen.queryByText(CONFIRM_TITLE)).not.toBeInTheDocument();
    expect(onPaymentCollected).not.toHaveBeenCalled();
    // Nothing was sent: the order is free again.
    const next = claimOrdinaryCollectionOwner(SCOPE, orderId);
    expect(next.claimed).toBe(true);
    if (next.claimed) releaseOrdinaryOwnerBeforeSend(next.owner);
  });

  it.each<[string, () => void, string]>([
    ['a connected payment provider', () => bridge.adminApi.fetchFromAdmin.mockResolvedValue(admissionAnswer(true)), PROVIDER_TEXT],
    ['a cached admission answer', () => bridge.adminApi.fetchFromAdmin.mockResolvedValue(admissionAnswer(false, { source: 'cache', offlineFallback: true })), UNAVAILABLE_TEXT],
    ['a failed admission request', () => bridge.adminApi.fetchFromAdmin.mockRejectedValue(new Error('offline')), UNAVAILABLE_TEXT],
    ['another branch in the answer', () => bridge.adminApi.fetchFromAdmin.mockResolvedValue({ ...admissionAnswer(false), data: { ...admissionAnswer(false).data, branch_id: 'other-branch' } }), UNAVAILABLE_TEXT],
  ])('with no terminal, refuses the manual card after %s and records nothing', async (_label, arrange, expected) => {
    arrange();
    const onPaymentCollected = vi.fn();
    renderSingle(nextOrderId('refused'), { onPaymentCollected });

    fireEvent.click(collectButton());
    await waitFor(() => expect(errorToasts().some((message) => message.startsWith(expected))).toBe(true));
    await settle();

    expect(bridge.adminApi.fetchFromAdmin).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(CONFIRM_TITLE)).not.toBeInTheDocument();
    expect(bridge.payments.recordPayment).not.toHaveBeenCalled();
    expect(onPaymentCollected).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('with no terminal and a fresh admission, asks the cashier, asks the server again on Confirm, then records the manual card', async () => {
    const orderId = nextOrderId('admitted');
    const onPaymentCollected = vi.fn();
    renderSingle(orderId, { onPaymentCollected });

    fireEvent.click(collectButton());
    expect(await screen.findByText(CONFIRM_TITLE)).toBeInTheDocument();
    expect(screen.getByText(/shop's own card machine/)).toBeInTheDocument();
    expect(bridge.adminApi.fetchFromAdmin).toHaveBeenCalledTimes(1);
    expect(bridge.payments.recordPayment).not.toHaveBeenCalled();
    // The order is not held while the cashier decides.
    const meanwhile = claimOrdinaryCollectionOwner(SCOPE, orderId);
    expect(meanwhile.claimed).toBe(true);
    if (meanwhile.claimed) releaseOrdinaryOwnerBeforeSend(meanwhile.owner);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm manual card' }));
    await waitFor(() => expect(bridge.payments.recordPayment).toHaveBeenCalledTimes(1));
    expect(bridge.adminApi.fetchFromAdmin).toHaveBeenCalledTimes(2);
    expect(bridge.payments.recordPayment).toHaveBeenCalledWith(expect.objectContaining({
      orderId, method: 'card', amount: 12.5, paymentOrigin: 'manual', terminalApproved: false,
    }));
    expect(bridge.payments.recordPayment.mock.calls[0][0].terminalDeviceId).toBeUndefined();
    await waitFor(() => expect(onPaymentCollected).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: 'pay-manual-1', method: 'card', paymentOrigin: 'manual',
    })));
    expect(bridge.ecr.processPayment).not.toHaveBeenCalled();
  });

  it('records nothing when the admission is withdrawn between the offer and Confirm', async () => {
    const onPaymentCollected = vi.fn();
    renderSingle(nextOrderId('withdrawn'), { onPaymentCollected });

    fireEvent.click(collectButton());
    await screen.findByText(CONFIRM_TITLE);
    bridge.adminApi.fetchFromAdmin.mockResolvedValue(admissionAnswer(true));

    fireEvent.click(screen.getByRole('button', { name: 'Confirm manual card' }));
    await waitFor(() => expect(errorToasts().some((message) => message.startsWith(PROVIDER_TEXT) && message.endsWith(ALREADY_TAKEN_TEXT))).toBe(true));
    await settle();

    expect(bridge.adminApi.fetchFromAdmin).toHaveBeenCalledTimes(2);
    expect(bridge.payments.recordPayment).not.toHaveBeenCalled();
    expect(onPaymentCollected).not.toHaveBeenCalled();
    expect(screen.queryByText(CONFIRM_TITLE)).not.toBeInTheDocument();
  });

  it('Cancel on the confirmation records nothing and leaves the order free', async () => {
    const orderId = nextOrderId('cancel');
    renderSingle(orderId);

    fireEvent.click(collectButton());
    await screen.findByText(CONFIRM_TITLE);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText(CONFIRM_TITLE)).not.toBeInTheDocument();
    expect(collectButton()).toBeEnabled();
    await settle();
    expect(bridge.payments.recordPayment).not.toHaveBeenCalled();
    const next = claimOrdinaryCollectionOwner(SCOPE, orderId);
    expect(next.claimed).toBe(true);
    if (next.claimed) releaseOrdinaryOwnerBeforeSend(next.owner);
  });

  it('applies the same rule without a collection scope', async () => {
    const onPaymentCollected = vi.fn();
    renderSingle(nextOrderId('unscoped'), { collectionScope: undefined, onPaymentCollected });

    // A busy configured terminal: refused, nothing recorded.
    bridge.ecr.getDefaultTerminal.mockResolvedValueOnce({ success: true, device: { id: 'eft-1', name: 'EFT' } });
    bridge.ecr.getDeviceStatus.mockResolvedValueOnce({ connected: true, ready: true, busy: true });
    fireEvent.click(collectButton());
    await waitFor(() => expect(errorToasts().some((message) => message.startsWith(NOT_READY_TEXT))).toBe(true));
    await settle();
    expect(bridge.payments.recordPayment).not.toHaveBeenCalled();

    // No terminal and a fresh admission: confirmation first, a second admission, then the record.
    await waitFor(() => expect(collectButton()).toBeEnabled());
    fireEvent.click(collectButton());
    await screen.findByText(CONFIRM_TITLE);
    expect(bridge.payments.recordPayment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm manual card' }));
    await waitFor(() => expect(bridge.payments.recordPayment).toHaveBeenCalledTimes(1));
    expect(bridge.adminApi.fetchFromAdmin).toHaveBeenCalledTimes(2);
    expect(bridge.payments.recordPayment).toHaveBeenCalledWith(expect.objectContaining({
      method: 'card', paymentOrigin: 'manual', terminalApproved: false,
    }));
    await waitFor(() => expect(onPaymentCollected).toHaveBeenCalledTimes(1));
  });
});
