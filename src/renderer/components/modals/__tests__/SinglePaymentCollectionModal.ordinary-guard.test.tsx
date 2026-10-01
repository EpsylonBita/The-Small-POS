import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    payments: {
      getSettlementSnapshot: vi.fn(),
      recordPayment: vi.fn(),
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
  OrderService: {
    getInstance: () => ({ fetchOrders: vi.fn() }),
  },
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

import {
  claimOrdinaryCollectionOwner,
  releaseOrdinaryOwnerBeforeSend,
  retainedOrdinaryOwner,
} from '../../../hooks/useOrderStore';
import { SinglePaymentCollectionModal } from '../SinglePaymentCollectionModal';

const SCOPE = { organizationId: 'org-single', terminalId: 'term-single' };
/** Native gift_card_reconcile_order reporting nothing unresolved. */
const CLEAR = { success: true, applied: [], abandoned: 0, unresolved: 0, reconciliationPending: false };
const ADMISSION_TEXT = 'Earlier gift card attempts must be checked first.';
const FAILED_TEXT = 'Failed to collect payment.';

// Controller state is module-level and unknown holds never clear, so every
// test works on its own order.
let sequence = 0;
const nextOrderId = (label: string): string => `single-${label}-${++sequence}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const collectButton = (container: HTMLElement): HTMLButtonElement => {
  const button = container.querySelector('button');
  if (!button) throw new Error('collect button missing');
  return button;
};

/** The native settlement snapshot of a 12.50 order. */
function ledger(orderId: string, rows: unknown[] = [], paid = 0) {
  return {
    success: true,
    orderId,
    orderTotal: 12.5,
    netPaid: paid,
    outstandingAmount: Math.round((12.5 - paid) * 100) / 100,
    completedPayments: rows,
    generation: 'b'.repeat(64),
  };
}

function cardRow(id: string, transactionRef: string) {
  return {
    id,
    method: 'card',
    amount: 12.5,
    status: 'completed',
    transactionRef,
    paymentOrigin: 'terminal',
    terminalApproved: true,
    terminalDeviceId: 'ecr-1',
    refundedAmount: 0,
    remainingRefundable: 12.5,
  };
}

type SingleProps = React.ComponentProps<typeof SinglePaymentCollectionModal>;

const renderSingle = (orderId: string, overrides: Partial<SingleProps> = {}) =>
  render(
    <SinglePaymentCollectionModal
      isOpen
      onClose={vi.fn()}
      onPaymentCollected={vi.fn()}
      orderId={orderId}
      method="cash"
      outstandingAmount={12.5}
      totalAmount={12.5}
      collectionScope={SCOPE}
      {...overrides}
    />,
  );

describe('SinglePaymentCollectionModal existing-order ordinary guard', () => {
  beforeEach(() => {
    bridge.invoke.mockImplementation(async () => ({ success: true }));
    bridge.giftCardCheckout.reconcileOrder.mockImplementation(async () => CLEAR);
    bridge.payments.recordPayment.mockReset();
    bridge.payments.getSettlementSnapshot.mockReset();
    bridge.payments.getSettlementSnapshot.mockImplementation(async (orderId: string) => ledger(orderId));
    bridge.ecr.processPayment.mockReset();
    bridge.ecr.getDefaultTerminal.mockReset();
    bridge.ecr.getDeviceStatus.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('fails closed without a confirmed organization and terminal scope', async () => {
    const orderId = nextOrderId('scope');
    const view = renderSingle(orderId, { collectionScope: null });

    fireEvent.click(collectButton(view.container));
    await act(async () => {
      await tick();
    });

    expect(toastMock.error).toHaveBeenCalledWith(
      'This terminal has no confirmed organization or terminal identity. Pair the POS again.',
    );
    expect(bridge.payments.recordPayment).not.toHaveBeenCalled();
    expect(bridge.ecr.processPayment).not.toHaveBeenCalled();
  });

  it('claims before the first await, so a second surface on the same order is refused and one write is sent', async () => {
    const orderId = nextOrderId('two-surfaces');
    const write = deferred<unknown>();
    bridge.payments.recordPayment.mockImplementation(() => write.promise);
    const firstCollected = vi.fn();
    const secondCollected = vi.fn();
    const first = renderSingle(orderId, { onPaymentCollected: firstCollected });
    const second = renderSingle(orderId, { onPaymentCollected: secondCollected });

    fireEvent.click(collectButton(first.container));
    fireEvent.click(collectButton(second.container));

    expect(toastMock.error).toHaveBeenCalledWith(ADMISSION_TEXT);
    await waitFor(() => expect(bridge.payments.recordPayment).toHaveBeenCalledTimes(1));
    expect(bridge.payments.recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ orderId, method: 'cash', amount: 12.5, paymentOrigin: 'manual' }),
    );

    await act(async () => {
      write.resolve({ success: true, paymentId: 'pay-single-1' });
      await tick();
    });

    await waitFor(() =>
      expect(firstCollected).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: 'pay-single-1', method: 'cash', paymentOrigin: 'manual' }),
      ),
    );
    expect(secondCollected).not.toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith('Cash payment recorded.');
    expect(bridge.payments.recordPayment).toHaveBeenCalledTimes(1);

    // The completed original frees the order for a later collection.
    const next = claimOrdinaryCollectionOwner(SCOPE, orderId);
    expect(next.claimed).toBe(true);
    if (next.claimed) releaseOrdinaryOwnerBeforeSend(next.owner);
  });

  it('keeps a lost cash reply unknown and later only reads the ledger, never writing again', async () => {
    const orderId = nextOrderId('lost-cash');
    bridge.payments.recordPayment.mockRejectedValueOnce(new Error('IPC transport lost'));
    bridge.payments.getSettlementSnapshot.mockResolvedValue(ledger(orderId));
    const onPaymentCollected = vi.fn();
    const onClose = vi.fn();
    const view = renderSingle(orderId, { onPaymentCollected, onClose });

    fireEvent.click(collectButton(view.container));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(FAILED_TEXT));
    expect(onPaymentCollected).not.toHaveBeenCalled();
    expect(retainedOrdinaryOwner(SCOPE, orderId)).not.toBeNull();

    await waitFor(() => expect(collectButton(view.container).disabled).toBe(false));
    const readsBeforeProbe = bridge.payments.getSettlementSnapshot.mock.calls.length;
    fireEvent.click(collectButton(view.container));
    await waitFor(() =>
      expect(bridge.payments.getSettlementSnapshot.mock.calls.length).toBeGreaterThan(readsBeforeProbe),
    );
    await act(async () => {
      await tick();
      await tick();
    });

    // An unpaid ledger cannot prove the lost write unsent: still held, nothing resent.
    expect(bridge.payments.recordPayment).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onPaymentCollected).not.toHaveBeenCalled();
    expect(retainedOrdinaryOwner(SCOPE, orderId)).not.toBeNull();
  });

  it('keeps an approved but unbooked card charge unknown until the ledger shows that original charge', async () => {
    const orderId = nextOrderId('card');
    bridge.ecr.getDefaultTerminal.mockResolvedValue({ device: { id: 'ecr-1', name: 'Front desk' } });
    bridge.ecr.getDeviceStatus.mockResolvedValue({ connected: true, ready: true, busy: false });
    bridge.ecr.processPayment.mockResolvedValue({
      success: true,
      transaction: { status: 'approved', transactionId: 'TX-single-1' },
    });
    bridge.payments.recordPayment.mockRejectedValueOnce(new Error('IPC transport lost'));
    // The ledger stays unpaid until the test books the original charge's row.
    let ledgerRows: unknown[] = [];
    let ledgerPaid = 0;
    bridge.payments.getSettlementSnapshot.mockImplementation(async () => ledger(orderId, ledgerRows, ledgerPaid));
    const onPaymentCollected = vi.fn();
    const onClose = vi.fn();
    const view = renderSingle(orderId, { method: 'card', onPaymentCollected, onClose });

    fireEvent.click(collectButton(view.container));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(FAILED_TEXT));
    expect(bridge.ecr.processPayment).toHaveBeenCalledTimes(1);
    expect(bridge.payments.recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ orderId, method: 'card', transactionRef: 'TX-single-1', paymentOrigin: 'terminal' }),
    );
    expect(onPaymentCollected).not.toHaveBeenCalled();
    expect(retainedOrdinaryOwner(SCOPE, orderId)).not.toBeNull();

    // An unpaid ledger never releases the approved charge.
    await waitFor(() => expect(collectButton(view.container).disabled).toBe(false));
    const readsBeforeProbe = bridge.payments.getSettlementSnapshot.mock.calls.length;
    fireEvent.click(collectButton(view.container));
    await waitFor(() =>
      expect(bridge.payments.getSettlementSnapshot.mock.calls.length).toBeGreaterThan(readsBeforeProbe),
    );
    await act(async () => {
      await tick();
      await tick();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(retainedOrdinaryOwner(SCOPE, orderId)).not.toBeNull();

    // Only the original charge's own ledger row settles it; nothing is charged or written again.
    ledgerRows = [cardRow('pay-card-late', 'TX-single-1')];
    ledgerPaid = 12.5;
    fireEvent.click(collectButton(view.container));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(toastMock.success).toHaveBeenCalledWith('Card payment recorded.');
    expect(bridge.ecr.processPayment).toHaveBeenCalledTimes(1);
    expect(bridge.payments.recordPayment).toHaveBeenCalledTimes(1);
    expect(retainedOrdinaryOwner(SCOPE, orderId)).toBeNull();
  });

  it('books a saved approved original after remount without requiring a connected terminal', async () => {
    const orderId = nextOrderId('restart-approved');
    bridge.payments.getSettlementSnapshot.mockResolvedValue({
      ...ledger(orderId),
      unresolvedDirectSale: { recoverable: true, id: 'saved-sale-1', deviceId: 'disconnected-ecr', amountCents: 1250, currency: 'EUR', status: 'approved' },
    });
    bridge.payments.recordPayment.mockResolvedValue({ success: true, paymentId: 'saved-payment-1' });
    const onPaymentCollected = vi.fn();
    const view = renderSingle(orderId, { method: 'card', onPaymentCollected });
    fireEvent.click(collectButton(view.container));
    await waitFor(() => expect(onPaymentCollected).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: 'saved-payment-1', method: 'card', transactionRef: 'saved-sale-1', terminalDeviceId: 'disconnected-ecr',
    })));
    expect(bridge.ecr.getDefaultTerminal).not.toHaveBeenCalled();
    expect(bridge.ecr.processPayment).not.toHaveBeenCalled();
    expect(bridge.payments.recordPayment).toHaveBeenCalledTimes(1);
  });

  it('holds fresh cash when a restarted direct SALE is pending or ambiguous', async () => {
    const orderId = nextOrderId('restart-unknown');
    bridge.payments.getSettlementSnapshot.mockResolvedValue({
      ...ledger(orderId), unresolvedDirectSale: { recoverable: false, requiresReconciliation: true },
    });
    const view = renderSingle(orderId);
    fireEvent.click(collectButton(view.container));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(ADMISSION_TEXT));
    expect(bridge.payments.recordPayment).not.toHaveBeenCalled();
    expect(bridge.ecr.processPayment).not.toHaveBeenCalled();
  });

  it('does not book a recovered SALE after the active terminal scope changes during the read', async () => {
    const orderId = nextOrderId('restart-scope-switch');
    const pending = deferred<unknown>();
    bridge.payments.getSettlementSnapshot.mockReturnValue(pending.promise);
    const onPaymentCollected = vi.fn();
    const onClose = vi.fn();
    const props = { isOpen: true, onClose, onPaymentCollected, orderId, method: 'card' as const,
      outstandingAmount: 12.5, totalAmount: 12.5, collectionScope: SCOPE };
    const view = render(<SinglePaymentCollectionModal {...props} />);
    fireEvent.click(collectButton(view.container));
    await waitFor(() => expect(bridge.payments.getSettlementSnapshot).toHaveBeenCalledTimes(1));
    view.rerender(<SinglePaymentCollectionModal {...props}
      collectionScope={{ organizationId: SCOPE.organizationId, terminalId: 'different-terminal' }} />);
    await act(async () => {
      pending.resolve({ ...ledger(orderId), unresolvedDirectSale: {
        recoverable: true, id: 'saved-sale-stale', deviceId: 'offline-ecr', amountCents: 1250,
        currency: 'EUR', status: 'approved',
      } });
      await tick();
    });
    expect(bridge.payments.recordPayment).not.toHaveBeenCalled();
    expect(bridge.ecr.processPayment).not.toHaveBeenCalled();
    expect(onPaymentCollected).not.toHaveBeenCalled();
  });
});
