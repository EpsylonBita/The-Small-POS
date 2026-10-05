import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real OrderFlow host, Outstanding/Payment modals, gift card Tender,
// checkout service and ordinary collection controller; only the native
// bridge, store hook, contexts and unrelated child surfaces are replaced.
const h = vi.hoisted(() => {
  interface Held<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
    taken: boolean;
  }
  function hold<T>(): Held<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject, taken: false };
  }
  function take<T>(held: Held<T> | null, fallback: T): Promise<T> {
    if (held && !held.taken) {
      held.taken = true;
      return held.promise;
    }
    return Promise.resolve(fallback);
  }

  const state = {
    orderId: '',
    checkoutDraft: null as any,
    serial: 0,
    orderTotal: 12.5,
    giftBooked: false,
    importPending: false,
    imports: 0,
    fiscalNext: 'finalize' as 'finalize' | 'none',
    ledger: 'normal' as 'normal' | 'fail' | 'nonmatching',
    recordPayment: 'ok' as 'ok' | 'lost',
    ordinaryBooked: null as null | { id: string; ref: string },
    orders: [] as Array<Record<string, unknown>>,
    // The one host reread to hold: after the gift import or the ordinary write.
    holdRefreshOn: null as null | 'import' | 'record',
    refreshArmed: false,
    refresh: null as null | Held<void>,
    askPrint: null as null | Held<boolean>,
  };
  const serialHex = () => String(state.serial).padStart(12, '0');
  const giftPaymentId = () => `5b0f3c2e-8c1d-4e7a-9f10-${serialHex()}`;
  const giftKey = () => `9e8d7c6b-5a4f-4e3d-8c2b-${serialHex()}`;

  const snapshot = (orderId: string) => {
    if (state.ledger === 'fail') return Promise.reject(new Error('ledger unavailable'));
    const completedPayments: Array<Record<string, unknown>> = [];
    if (state.giftBooked) {
      completedPayments.push({
        id: giftPaymentId(),
        method: 'gift_card',
        amount: state.orderTotal,
        currency: 'EUR',
        status: 'completed',
      });
    }
    if (state.ordinaryBooked) {
      completedPayments.push({
        id: state.ordinaryBooked.id,
        method: 'card',
        amount: state.orderTotal,
        currency: 'EUR',
        status: 'completed',
        transactionRef: state.ordinaryBooked.ref,
      });
    }
    if (state.ledger === 'nonmatching') {
      completedPayments.push({
        id: 'foreign-payment',
        method: 'cash',
        amount: 1,
        currency: 'EUR',
        status: 'completed',
        transactionRef: 'FOREIGN-REF',
      });
    }
    const paid = completedPayments.reduce((sum, row) => sum + Number(row.amount), 0);
    const netPaid = Math.min(state.orderTotal, paid);
    return Promise.resolve({
      success: true as const,
      orderId,
      orderTotal: state.orderTotal,
      netPaid,
      outstandingAmount: Math.round((state.orderTotal - netPaid) * 100) / 100,
      completedPayments,
      generation: (netPaid > 0 ? 'b' : 'a').repeat(64),
    });
  };

  const fiscalReply = (orderId: string) => (state.fiscalNext === 'finalize'
    ? { status: 'ready', orderId, order: { orderId, status: 'ready', requiresFinalize: true } }
    : { status: 'ready', orderId, order: { orderId, status: 'approved', certified: true } });

  const native = {
    getSettlementSnapshot: vi.fn((orderId: string) => snapshot(orderId)),
    recordPayment: vi.fn(async (payload: { transactionRef?: string }) => {
      if (state.holdRefreshOn === 'record') state.refreshArmed = true;
      if (state.recordPayment === 'lost') throw new Error('reply lost');
      state.ordinaryBooked = { id: 'card-payment-1', ref: String(payload.transactionRef ?? '') };
      return { success: true, paymentId: 'card-payment-1', paymentApproved: true, paymentPersisted: true };
    }),
    printReceipt: vi.fn(async () => ({ success: true })),
    fiscalPrint: vi.fn(async () => ({ success: true })),
    settingsGet: vi.fn(async () => true),
    getBranchId: vi.fn(async () => 'branch-1'),
    getTerminalId: vi.fn(async () => 'term-1'),
    getNetworkStatus: vi.fn(async () => ({ isOnline: true })),
    redeemForOrder: vi.fn(async () => {
      throw new Error('no gift debit may run here');
    }),
    reconcileOrder: vi.fn(async ({ orderId }: { orderId: string }) => {
      const applied = state.importPending && orderId === state.orderId
        ? [{
            idempotencyKey: giftKey(),
            localPaymentId: giftPaymentId(),
            remotePaymentId: null,
            amountCents: Math.round(state.orderTotal * 100),
            currency: 'EUR',
          }]
        : [];
      if (applied.length > 0) {
        state.importPending = false;
        state.imports += 1;
        if (state.holdRefreshOn === 'import') state.refreshArmed = true;
      }
      return { success: true, orderId, applied, unresolved: [], reconciliationPending: false };
    }),
    fiscalReadiness: vi.fn(async ({ orderId }: { orderId: string }) => fiscalReply(orderId)),
    fiscalFinalize: vi.fn(async ({ orderId }: { orderId: string }) => {
      state.fiscalNext = 'none';
      return fiscalReply(orderId);
    }),
    fiscalReconcile: vi.fn(async ({ orderId }: { orderId: string }) => fiscalReply(orderId)),
  };

  const bridge = {
    payments: {
      getSettlementSnapshot: native.getSettlementSnapshot,
      recordPayment: native.recordPayment,
      printReceipt: native.printReceipt,
    },
    ecr: { fiscalPrint: native.fiscalPrint },
    settings: { get: native.settingsGet },
    terminalConfig: { getBranchId: native.getBranchId, getTerminalId: native.getTerminalId },
    sync: { getNetworkStatus: native.getNetworkStatus },
    giftCardCheckout: {
      redeemForOrder: native.redeemForOrder,
      reconcileOrder: native.reconcileOrder,
      fiscalReadiness: native.fiscalReadiness,
      fiscalFinalize: native.fiscalFinalize,
      fiscalReconcile: native.fiscalReconcile,
    },
    loyalty: { redeemPoints: vi.fn(async () => ({ success: true })) },
  };

  const store = {
    createOrder: vi.fn(async () => ({ success: true, orderId: state.orderId, orderNumber: '42' })),
    silentRefresh: vi.fn(() => {
      if (!state.refreshArmed) return Promise.resolve();
      state.refreshArmed = false;
      return take(state.refresh, undefined);
    }),
    get orders() {
      return state.orders;
    },
  };

  const printPrompt = {
    askForPaymentPrint: vi.fn(async () => false),
    shouldAskPaymentPrint: vi.fn(() => take(state.askPrint, false)),
    paymentPrintPromptModal: null,
  };

  const translate = (key: string, fallback?: unknown): string => {
    if (key === 'common.actions.close') return 'Close';
    if (typeof fallback === 'string') return fallback;
    const defaultValue = (fallback as { defaultValue?: unknown } | undefined)?.defaultValue;
    return typeof defaultValue === 'string' ? defaultValue : key;
  };

  return {
    state,
    native,
    bridge,
    store,
    printPrompt,
    translate,
    hold,
    identity: { current: { branchId: 'branch-1', organizationId: 'org-1', terminalId: 'term-1' } },
    toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }),
    getSetting: (_category: string, _key: string, fallback: unknown) => fallback,
    giftStatus: {
      ok: true,
      data: { moduleEnabled: true, enabled: true, unavailable: false, supportsLookup: true, currency: 'EUR' },
    },
    orderData: () => ({
      items: [{
        id: 'line-1',
        menuItemId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        menu_item_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        name: 'Coffee',
        quantity: 1,
        price: 12.5,
        unitPrice: 12.5,
        unit_price: 12.5,
        totalPrice: 12.5,
        total_price: 12.5,
      }],
      total: 12.5,
      paymentData: { method: 'pending' },
    }),
  };
});

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: h.translate, i18n: { language: 'en' } }) };
});
vi.mock('react-hot-toast', () => ({ default: h.toast, toast: h.toast }));
vi.mock('../../../lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib')>()),
  getBridge: () => h.bridge,
  onEvent: vi.fn(() => () => undefined),
  offEvent: vi.fn(),
  emitCompatEvent: vi.fn(),
}));
vi.mock('../../contexts/i18n-context', () => ({
  useI18n: () => ({ t: h.translate, language: 'en', setLanguage: vi.fn() }),
}));
vi.mock('../../contexts/shift-context', () => ({
  useShift: () => ({
    staff: { staffId: 'staff-1', terminalId: 'term-1', branchId: 'branch-1' },
    activeShift: { id: 'shift-1' },
    isShiftActive: true,
  }),
}));
vi.mock('../../contexts/module-context', () => ({
  useModules: () => ({ organizationId: 'org-1', businessType: 'restaurant' }),
}));
vi.mock('../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isFeatureEnabled: () => true, isMobileWaiter: false, loading: false }),
}));
vi.mock('../../hooks/useAcquiredModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useAcquiredModules')>();
  return {
    ...actual,
    useAcquiredModules: () => ({
      modules: [],
      hasDeliveryModule: false,
      hasTablesModule: false,
      hasModule: (id: string) => id === actual.MODULE_IDS.GIFT_CARDS,
    }),
  };
});
vi.mock('../../hooks/useTables', () => ({
  useTables: () => ({ tables: [], refetch: vi.fn(), updateTableStatus: vi.fn() }),
}));
vi.mock('../../hooks/useDeliveryValidation', () => ({
  useDeliveryValidation: () => ({ requestOverride: vi.fn(), validateAddress: vi.fn() }),
}));
vi.mock('../../hooks/useTerminalSettings', () => ({
  useTerminalSettings: () => ({ getSetting: h.getSetting, refresh: vi.fn() }),
}));
vi.mock('../../hooks/useResolvedPosIdentity', () => ({
  useResolvedPosIdentity: () => h.identity.current,
}));
vi.mock('../../hooks/usePaymentPrintPrompt', () => ({
  usePaymentPrintPrompt: () => h.printPrompt,
}));
vi.mock('../../hooks/useOrderStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useOrderStore')>();
  return { ...actual, useOrderStore: () => h.store };
});
vi.mock('../../services/ActivityTracker', () => ({
  ActivityTracker: { trackOrderCreated: vi.fn(), trackDiscount: vi.fn(), trackPaymentCompleted: vi.fn() },
}));
vi.mock('../../services/ReservationsService', () => ({
  reservationsService: {},
  buildChangedReservationUpdate: vi.fn(),
}));
vi.mock('../../services/terminal-credentials', () => ({
  getCachedTerminalCredentials: () => ({ branchId: 'branch-1', organizationId: 'org-1' }),
  refreshTerminalCredentialCache: async () => ({ branchId: 'branch-1', organizationId: 'org-1' }),
}));
vi.mock('../../services/GiftCardsApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/GiftCardsApiService')>();
  return { ...actual, giftCardsApiService: { getStatus: async () => h.giftStatus } };
});
vi.mock('../../utils/active-cashier', () => ({
  resolveActiveCashierShift: async () => ({ id: 'shift-1' }),
}));
vi.mock('../../../shared/utils/pos-order-items', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/utils/pos-order-items')>();
  return { ...actual, hasValidSyncedPosMenuItemId: () => true };
});
vi.mock('../ui/FloatingActionButton', () => ({
  FloatingActionButton: ({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) => (
    <button type="button" data-testid="new-order" onClick={onClick} disabled={disabled}>new order</button>
  ),
}));
vi.mock('../../services/CheckoutDraftStore', () => ({ getCheckoutDraftStore: async () => ({ load: async () => h.state.checkoutDraft }) }));
vi.mock('../modals/MenuModal', () => ({
  MenuModal: ({ isOpen, onOrderComplete, orderType, draftContext }: any) => (
    isOpen
      ? <button type="button" data-testid="menu-complete" data-order-type={orderType} data-table-id={draftContext?.selectedTable?.id} onClick={() => { void onOrderComplete(h.state.checkoutDraft ? { ...h.orderData(), clientRequestId: h.state.checkoutDraft.checkoutRequestId, paymentData: { method: 'table', status: 'pending', amount: 0 } } : h.orderData()); }}>complete order</button>
      : null
  ),
}));
vi.mock('../modals/ProductCatalogModal', () => ({ ProductCatalogModal: () => null }));
vi.mock('../modals/CustomerSearchModal', () => ({ CustomerSearchModal: () => null }));
vi.mock('../modals/AddCustomerModal', () => ({ AddCustomerModal: () => null }));
vi.mock('../modals/SplitPaymentModal', () => ({
  SplitPaymentModal: ({ orderId, onClose }: { orderId: string; onClose: () => void }) => (
    <div data-testid="split-payment-modal" data-order-id={orderId}>
      <button type="button" onClick={onClose}>close split</button>
    </div>
  ),
}));
vi.mock('../delivery/ZoneValidationAlert', () => ({ ZoneValidationAlert: () => null }));
vi.mock('../tables', () => ({ TableSelector: () => null, TableActionModal: () => null, ReservationForm: () => null }));

import OrderFlow from '../OrderFlow';
import {
  claimOrdinaryCollectionOwner,
  releaseOrdinaryOwnerBeforeSend,
  retainedOrdinaryOwner,
} from '../../hooks/useOrderStore';

const SCOPE = { organizationId: 'org-1', terminalId: 'term-1' };

const targetOrder = (orderId: string): string => {
  h.state.serial += 1;
  h.state.orderId = orderId;
  h.state.orders = [{ id: orderId, supabase_id: `remote-${orderId}`, sync_status: 'synced' }];
  return orderId;
};

// Real-timer settle for chained native answers.
const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 25));
});

// jsdom runs no CSS animations: end the glass modals' exit so they unmount
// and release the page they hid.
const finishLeavingModals = () => {
  document.querySelectorAll('.liquid-glass-modal-shell.leaving').forEach((shell) => {
    // React binds a vendor-prefixed name when jsdom lacks AnimationEvent.
    for (const type of ['animationend', 'webkitAnimationEnd', 'mozAnimationEnd']) {
      fireEvent(shell, new Event(type, { bubbles: true }));
    }
  });
};

// New pickup order -> pending split -> dismissed split -> unpaid outstanding.
const openOutstanding = async () => {
  fireEvent.click(screen.getByTestId('new-order'));
  await waitFor(() => expect(document.querySelector('[data-order-type-card="pickup"]')).not.toBeNull());
  fireEvent.click(document.querySelector('[data-order-type-card="pickup"]') as HTMLElement);
  const complete = await screen.findByTestId('menu-complete');
  finishLeavingModals();
  fireEvent.click(complete);
  await screen.findByTestId('split-payment-modal');
  finishLeavingModals();
  fireEvent.click(screen.getByRole('button', { name: 'close split' }));
  await screen.findByRole('button', { name: /gift card/i });
};

const cardOption = (): HTMLElement => {
  const button = screen.getAllByRole('button').find((candidate) => {
    const text = candidate.textContent ?? '';
    return /\bcard\b/i.test(text) && !/gift/i.test(text);
  });
  if (!button) throw new Error('card option missing');
  return button;
};

const closeModal = () => {
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
  finishLeavingModals();
};

// An earlier gift debit of this order is booked natively; the Tender's
// recovery imports it once and reports the trusted full-gift event. The
// host's reread after that import is held.
const openTenderOverBookedGift = async () => {
  h.state.giftBooked = true;
  h.state.importPending = true;
  h.state.holdRefreshOn = 'import';
  const refresh = h.hold<void>();
  h.state.refresh = refresh;
  fireEvent.click(screen.getByRole('button', { name: /gift card/i }));
  await waitFor(() => expect(refresh.taken).toBe(true));
  return refresh;
};

const recoveryBanner = () => screen.getByTestId('gift-receipt-recovery');

const expectOnlyTheOriginalImport = () => {
  expect(h.state.imports).toBe(1);
  expect(h.native.redeemForOrder).not.toHaveBeenCalled();
  expect(h.native.recordPayment).not.toHaveBeenCalled();
  expect(h.native.printReceipt).not.toHaveBeenCalled();
  expect(h.native.fiscalPrint).not.toHaveBeenCalled();
};

describe('OrderFlow gift receipt kept across an early Close (mounted host)', () => {
  beforeEach(() => {
    Object.assign(h.state, {
      orderId: '',
      checkoutDraft: null,
      giftBooked: false,
      importPending: false,
      imports: 0,
      fiscalNext: 'finalize',
      ledger: 'normal',
      recordPayment: 'ok',
      ordinaryBooked: null,
      orders: [],
      holdRefreshOn: null,
      refreshArmed: false,
      refresh: null,
      askPrint: null,
    });
    h.identity.current = { branchId: 'branch-1', organizationId: 'org-1', terminalId: 'term-1' };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps the booked receipt reachable when Close beats the ledger reread, then reopens the same Tender', async () => {
    const orderId = targetOrder('flow-gift-close-race');
    render(<OrderFlow />);
    await openOutstanding();
    const refresh = await openTenderOverBookedGift();
    expect(await screen.findByRole('button', { name: 'Issue receipt' })).toBeInTheDocument();

    // Close while the reread is still pending: no split, only the receipt entry.
    closeModal();
    expect(screen.queryByTestId('split-payment-modal')).toBeNull();
    expect(within(recoveryBanner()).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /gift card/i })).toBeNull();

    // The old reread lands for a closed target and changes nothing.
    await act(async () => {
      refresh.resolve();
      await refresh.promise;
    });
    await settle();
    expect(screen.queryByTestId('split-payment-modal')).toBeNull();
    expect(recoveryBanner()).toBeInTheDocument();

    // Reentry opens the same order's own Tender at zero with only its receipt step.
    fireEvent.click(within(recoveryBanner()).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Issue receipt' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /CASH/ })).toBeNull();
    expect(h.native.reconcileOrder).toHaveBeenCalled();
    expect(h.native.reconcileOrder.mock.calls.every(([payload]) => payload.orderId === orderId)).toBe(true);
    expect(h.native.fiscalFinalize).not.toHaveBeenCalled();

    // The receipt step runs once, for the original order only.
    fireEvent.click(screen.getByRole('button', { name: 'Issue receipt' }));
    await waitFor(() => expect(h.native.fiscalFinalize).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(h.native.fiscalFinalize.mock.calls[0])).toContain(orderId);
    await settle();
    expect(h.native.fiscalFinalize).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('split-payment-modal')).toBeNull();
    expectOnlyTheOriginalImport();
  });

  it('keeps the receipt reachable when the late reread fails and invents no success', async () => {
    targetOrder('flow-gift-late-failure');
    render(<OrderFlow />);
    await openOutstanding();
    const refresh = await openTenderOverBookedGift();
    await screen.findByRole('button', { name: 'Issue receipt' });
    const successToasts = h.toast.success.mock.calls.length;

    closeModal();
    h.state.ledger = 'fail';
    await act(async () => {
      refresh.reject(new Error('refresh failed'));
      await refresh.promise.catch(() => undefined);
    });
    await settle();

    expect(recoveryBanner()).toBeInTheDocument();
    expect(screen.queryByTestId('split-payment-modal')).toBeNull();
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.toast.success).toHaveBeenCalledTimes(successToasts);

    h.state.ledger = 'normal';
    fireEvent.click(within(recoveryBanner()).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Issue receipt' })).toBeInTheDocument();
    expectOnlyTheOriginalImport();
  });

  it('ends a completed gift receipt with no reentry, split or receipt action', async () => {
    targetOrder('flow-gift-no-action');
    h.state.fiscalNext = 'none';
    render(<OrderFlow />);
    await openOutstanding();
    const refresh = await openTenderOverBookedGift();
    await waitFor(() => expect(h.native.fiscalReadiness).toHaveBeenCalled());
    await settle();
    expect(screen.queryByRole('button', { name: 'Issue receipt' })).toBeNull();

    if (screen.queryAllByRole('button', { name: 'Close' }).length > 0) closeModal();
    expect(screen.queryByTestId('gift-receipt-recovery')).toBeNull();
    expect(screen.queryByTestId('split-payment-modal')).toBeNull();

    await act(async () => {
      refresh.resolve();
      await refresh.promise;
    });
    await settle();
    expect(screen.queryByTestId('gift-receipt-recovery')).toBeNull();
    expect(screen.queryByTestId('split-payment-modal')).toBeNull();
    expect(h.native.fiscalFinalize).not.toHaveBeenCalled();
    expectOnlyTheOriginalImport();
  });

  it('lets a late ordinary result settle its owner but never touch a newer scope', async () => {
    const orderId = targetOrder('flow-ordinary-late-refresh');
    const view = render(<OrderFlow />);
    await openOutstanding();
    h.state.holdRefreshOn = 'record';
    const refresh = h.hold<void>();
    h.state.refresh = refresh;

    fireEvent.click(cardOption());
    await waitFor(() => expect(refresh.taken).toBe(true));
    expect(h.native.recordPayment).toHaveBeenCalledTimes(1);

    // A newer scope takes the screen while the original's final refresh is pending.
    h.identity.current = { branchId: 'branch-1', organizationId: 'org-1', terminalId: 'term-2' };
    view.rerender(<OrderFlow className="newer-scope" />);
    await act(async () => {
      refresh.resolve();
      await refresh.promise;
    });
    await settle();

    expect(retainedOrdinaryOwner(SCOPE, orderId)).toBeNull();
    expect(cardOption()).toBeInTheDocument();
    expect(screen.queryByTestId('split-payment-modal')).toBeNull();
    expect(h.native.recordPayment).toHaveBeenCalledTimes(1);
    expect(h.native.fiscalPrint).not.toHaveBeenCalled();
    expect(h.native.printReceipt).not.toHaveBeenCalled();
    expect(h.printPrompt.askForPaymentPrint).not.toHaveBeenCalled();
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it('drops a failed continuation after unmount: no toast, no write, and its unsent claim ends', async () => {
    const orderId = targetOrder('flow-ordinary-unmount');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(<OrderFlow />);
    await openOutstanding();
    const ask = h.hold<boolean>();
    h.state.askPrint = ask;

    fireEvent.click(cardOption());
    await waitFor(() => expect(ask.taken).toBe(true));
    view.unmount();
    await act(async () => {
      ask.reject(new Error('prompt unavailable'));
      await ask.promise.catch(() => undefined);
    });
    await settle();

    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.native.recordPayment).not.toHaveBeenCalled();
    const claim = claimOrdinaryCollectionOwner(SCOPE, orderId);
    expect(claim.claimed).toBe(true);
    if (claim.claimed) releaseOrdinaryOwnerBeforeSend(claim.owner);
    consoleError.mockRestore();
  });

  it('keeps a retained unknown collection quiet across its 3 s snapshot-only retries', async () => {
    const orderId = targetOrder('flow-ordinary-unknown');
    render(<OrderFlow />);
    await openOutstanding();
    h.state.recordPayment = 'lost';
    const errorsBefore = h.toast.error.mock.calls.length;
    const successBefore = h.toast.success.mock.calls.length;

    vi.useFakeTimers();
    fireEvent.click(cardOption());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(h.native.recordPayment).toHaveBeenCalledTimes(1);
    expect(h.toast.error.mock.calls.length - errorsBefore).toBe(1);
    expect(retainedOrdinaryOwner(SCOPE, orderId)).not.toBeNull();

    // Unreadable, empty and nonmatching canonical ledgers all stay quiet.
    for (const ledger of ['fail', 'normal', 'nonmatching'] as const) {
      h.state.ledger = ledger;
      const reads = h.native.getSettlementSnapshot.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(h.native.getSettlementSnapshot.mock.calls.length).toBeGreaterThan(reads);
    }

    expect(h.native.recordPayment).toHaveBeenCalledTimes(1);
    expect(h.toast.error.mock.calls.length - errorsBefore).toBe(1);
    expect(h.toast.success.mock.calls.length).toBe(successBefore);
    expect(retainedOrdinaryOwner(SCOPE, orderId)).not.toBeNull();
    expect(screen.queryByTestId('split-payment-modal')).toBeNull();
  });
});


describe('OrderFlow table draft restart contract', () => {
  afterEach(() => { cleanup(); h.state.checkoutDraft = null; });
  it('restores table UUID/session/context and creates the same original dine-in order without a payment claim', async () => {
    h.state.orderId = 'restored-table-order';
    h.state.checkoutDraft = { phase: 'editing', checkoutRequestId: 'original-table-checkout', cartItems: h.orderData().items,
      context: { orderType: 'dine-in', selectedTable: { id: 'table-uuid', tableNumber: '8', tableSessionId: 'check-uuid' },
        tableNumber: '8', selectedCustomer: { id: 'table-customer', name: 'Table 8', phone: '', addresses: [] } } };
    h.identity.current = { branchId: 'branch-1', organizationId: 'org-1', terminalId: 'term-1' };
    render(<OrderFlow />);
    const complete = await screen.findByTestId('menu-complete');
    expect(complete).toHaveAttribute('data-order-type', 'dine-in');
    expect(complete).toHaveAttribute('data-table-id', 'table-uuid');
    fireEvent.click(complete);
    await waitFor(() => expect(h.store.createOrder).toHaveBeenCalled());
    expect(h.store.createOrder.mock.calls.at(-1)?.[0]).toMatchObject({ clientRequestId: 'original-table-checkout',
      orderType: 'dine-in', order_type: 'dine-in', table_id: 'table-uuid', table_session_id: 'check-uuid',
      payment_method: null, paymentStatus: 'pending' });
  });
});
