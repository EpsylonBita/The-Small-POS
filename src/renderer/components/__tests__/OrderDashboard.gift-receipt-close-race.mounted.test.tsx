import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real OrderDashboard host, Outstanding/Payment modals, gift card Tender,
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
    returnedCustomer: null as any,
    menuProps: null as any,
    menuCreateId: undefined as string | undefined,
    menuSubmission: null as any,
    restoreContext: null as any,
    restoreError: '' as string,
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
  const giftPaymentId = () => `6c1f4d3f-9d2e-4f8b-8a21-${serialHex()}`;
  const giftKey = () => `8f7e6d5c-4b3a-4c2d-9e1f-${serialHex()}`;

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
    validateAddress: vi.fn(async () => null),
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
    orders: { previewEditSettlement: vi.fn(), applyEditSettlement: vi.fn(async () => ({ success: true })) },
    payments: {
      listUnsavedPayments: vi.fn(async () => []),
      getSettlementSnapshot: native.getSettlementSnapshot,
      recordPayment: native.recordPayment,
      printReceipt: native.printReceipt,
    },
    ecr: { fiscalPrint: native.fiscalPrint },
    settings: { get: native.settingsGet },
    sync: { getNetworkStatus: native.getNetworkStatus },
    customers: { lookupById: vi.fn(async () => null) },
    giftCardCheckout: {
      redeemForOrder: native.redeemForOrder,
      reconcileOrder: native.reconcileOrder,
      fiscalReadiness: native.fiscalReadiness,
      fiscalFinalize: native.fiscalFinalize,
      fiscalReconcile: native.fiscalReconcile,
    },
  };

  const store = {
    pendingExternalOrders: [],
    initializeOrders: vi.fn(),
    filter: {},
    setFilter: vi.fn(),
    isLoading: false,
    updateOrderStatusDetailed: vi.fn(),
    loadOrders: vi.fn(async () => undefined),
    silentRefresh: vi.fn(() => {
      if (!state.refreshArmed) return Promise.resolve();
      state.refreshArmed = false;
      return take(state.refresh, undefined);
    }),
    getLastError: () => null,
    clearError: vi.fn(),
    approveOrder: vi.fn(),
    declineOrder: vi.fn(),
    assignDriver: vi.fn(),
    conflicts: [],
    resolveConflict: vi.fn(),
    createOrder: vi.fn(async () => ({ success: true, orderId: state.orderId, orderNumber: '42' })),
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
    return typeof defaultValue === 'string'
      ? defaultValue.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String((fallback as Record<string, unknown>)[name] ?? ''))
      : key;
  };

  const pickupCards = [{ id: 'pickup', enabled: true }];

  return {
    state,
    native,
    bridge,
    store,
    printPrompt,
    translate,
    hold,
    pickupCards,
    modules: { hasDeliveryModule: false, hasTablesModule: false },
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

const none = vi.hoisted(() => () => null);

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
// Each hook answers with the same references across renders, as the real
// hooks do, so the dashboard's effects settle instead of looping.
vi.mock('../../contexts/i18n-context', () => {
  const value = { t: h.translate, language: 'en', setLanguage: vi.fn() };
  return { useI18n: () => value };
});
vi.mock('../../contexts/theme-context', () => {
  const value = { theme: 'dark', resolvedTheme: 'dark', setTheme: vi.fn() };
  return { useTheme: () => value };
});
vi.mock('../../contexts/shift-context', () => {
  const value = {
    staff: { staffId: 'staff-1', terminalId: 'term-1', branchId: 'branch-1' },
    activeShift: { id: '50000000-0000-4000-8000-000000000001', staff_id: '30000000-0000-4000-8000-000000000001', role_type: 'cashier' },
    isShiftActive: true,
  };
  return { useShift: () => value };
});
vi.mock('../../contexts/module-context', () => {
  const value = { organizationId: 'org-1', businessType: 'restaurant' };
  return { useModules: () => value };
});
vi.mock('../../hooks/useFeatures', () => {
  const value = { isFeatureEnabled: () => true, isMobileWaiter: false, loading: false };
  return { useFeatures: () => value };
});
vi.mock('../../hooks/useAcquiredModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useAcquiredModules')>();
  const value = {
    modules: [],
    get hasDeliveryModule() { return h.modules.hasDeliveryModule; },
    get hasTablesModule() { return h.modules.hasTablesModule; },
    hasRoomsModule: false,
    hasAppointmentsModule: false,
    hasServiceCatalogModule: false,
    hasModule: (id: string) => id === actual.MODULE_IDS.GIFT_CARDS,
  };
  return { ...actual, useAcquiredModules: () => value };
});
vi.mock('../../hooks/useTables', () => {
  const value = { tables: [], refetch: vi.fn(), updateTableStatus: vi.fn() };
  return { useTables: () => value };
});
vi.mock('../../hooks/useRooms', () => {
  const value = {
    allRooms: [],
    stats: { occupiedRooms: 0, reservedRooms: 0 },
    refetch: vi.fn(),
    updateStatus: vi.fn(),
  };
  return { useRooms: () => value };
});
vi.mock('../../hooks/useDeliveryValidation', () => {
  const value = { requestOverride: vi.fn(), validateAddress: h.native.validateAddress };
  return { useDeliveryValidation: () => value };
});
vi.mock('../../hooks/useTerminalSettings', () => {
  const value = { getSetting: h.getSetting, refresh: vi.fn() };
  return { useTerminalSettings: () => value };
});
vi.mock('../../hooks/useResolvedPosIdentity', () => ({
  useResolvedPosIdentity: () => h.identity.current,
}));
vi.mock('../../hooks/useKioskOrderAutoPrint', () => {
  const value = { printApprovedKioskOrder: vi.fn() };
  return { useKioskOrderAutoPrint: () => value, isKioskOrder: () => false };
});
vi.mock('../../hooks/usePaymentPrintPrompt', () => ({
  usePaymentPrintPrompt: () => h.printPrompt,
}));
vi.mock('../../hooks/useOrderStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useOrderStore')>();
  return { ...actual, useOrderStore: () => h.store };
});
vi.mock('../../new-work-cards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../new-work-cards')>()),
  resolveNewWorkCards: () => h.pickupCards,
  hasLaunchableNewWork: () => true,
  resolveDirectNewWorkCard: () => h.pickupCards[0],
}));
vi.mock('../../features/repairs/store', () => ({
  useRepairStore: (selector: (state: { settings: null }) => unknown) => selector({ settings: null }),
  repairStore: {
    getState: () => ({ settings: null, clearSession: vi.fn(), loadSettings: vi.fn(async () => undefined) }),
  },
}));
vi.mock('../../lib/secure-session-cache', () => ({ getSecureSessionSync: () => null }));
vi.mock('../../services/appAudio', () => ({
  isAppAudioEnabled: () => false,
  playAppAudioTones: vi.fn(),
  useAppAudioEnabled: () => false,
}));
vi.mock('../../services/platformNotificationSound', () => ({ playSelectedPlatformSound: vi.fn() }));
vi.mock('../../services/caller-id-order-flow', () => ({
  resolveCallerIdOrderSelection: vi.fn(),
  subscribeToCallerIdOrderIntents: () => () => undefined,
}));
vi.mock('../../services/RoomsService', () => ({ getRoomEffectiveStatus: () => 'available' }));
// Background services the dashboard polls on mount; each call quietly resolves.
vi.mock('../../services/CouponRedemptionService', () => ({
  couponRedemptionService: new Proxy({}, {
    get: (_target, key) => (typeof key === 'string' && key !== 'then' ? vi.fn(async () => undefined) : undefined),
  }),
}));
vi.mock('../../services/ReservationsService', () => ({
  reservationsService: new Proxy({}, {
    get: (_target, key) => (typeof key === 'string' && key !== 'then' ? vi.fn(async () => undefined) : undefined),
  }),
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
// Expose the host's filtered list; retain the real tab bar and its selection.
vi.mock('../OrderGrid', () => ({
  default: ({ orders }: { orders: Array<{ id: string }> }) => (
    <div data-testid="history-orders">
      {orders.map(order => <div key={order.id} data-testid={`row-${order.id}`}>{order.id}</div>)}
    </div>
  ),
}));
vi.mock('../BulkActionsBar', () => ({ default: none }));
vi.mock('../modals/DriverAssignmentModal', () => ({ default: none }));
vi.mock('../modals/OrderCancellationModal', () => ({ default: none }));
vi.mock('../modals/EditOptionsModal', () => ({ default: none }));
vi.mock('../modals/EditPaymentMethodModal', () => ({ default: none }));
vi.mock('../modals/EditCustomerInfoModal', () => ({ EditCustomerInfoModal: none }));
vi.mock('../modals/EditOrderItemsModal', () => ({ default: none }));
vi.mock('../modals/CustomerSearchModal', () => ({ CustomerSearchModal: none }));
vi.mock('../modals/CustomerInfoModal', () => ({ CustomerInfoModal: none }));
vi.mock('../modals/AddCustomerModal', () => ({ AddCustomerModal: ({ isOpen, onCustomerAdded }: any) => isOpen ? <button data-testid="save-address-edit" onClick={() => onCustomerAdded(h.state.returnedCustomer)}>save address</button> : null }));
vi.mock('../modals/EditOrderRefundSettlementModal', () => ({ EditOrderRefundSettlementModal: none }));
vi.mock('../modals/EditSettlementDeltaModal', () => ({ EditSettlementDeltaModal: ({ isOpen, onConfirm }: any) => isOpen ? <button data-testid="edit-settlement-delta-cash" onClick={() => { void onConfirm('cash'); }}>collect edit difference</button> : null }));
vi.mock('../modals/SinglePaymentCollectionModal', () => ({ SinglePaymentCollectionModal: none }));
vi.mock('../modals/OrderDetailsModal', () => ({ default: none }));
vi.mock('../modals/PrintPreviewModal', () => ({ PrintPreviewModal: none }));
vi.mock('../order/OrderApprovalPanel', () => ({ OrderApprovalPanel: none }));
vi.mock('../OrderConflictBanner', () => ({ OrderConflictBanner: none }));
vi.mock('../modals/RoomStayWorkflowModals', () => ({
  RoomStaySelectorModal: none,
  RoomCheckinModal: none,
  RoomReservationModal: none,
  RoomFloorChips: none,
  deriveRoomFloors: () => [],
}));
vi.mock('../tables', () => ({
  TableSelector: none,
  TableActionModal: none,
  TableCheckManagerModal: none,
  ReservationForm: none,
  TableFloorPlanView: none,
  TableFloorPlanModal: none,
}));
vi.mock('../skeletons', () => ({ OrderDashboardSkeleton: () => <div data-testid="dashboard-skeleton" /> }));
vi.mock('../error', () => ({ ErrorDisplay: () => <div data-testid="dashboard-error" /> }));
vi.mock('../ui/FloatingActionButton', () => ({
  FloatingActionButton: ({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) => (
    <button type="button" data-testid="new-order" onClick={onClick} disabled={disabled}>new order</button>
  ),
}));
vi.mock('../modals/MenuModal', () => ({
  MenuModal: (props: any) => { if (props.isOpen) h.state.menuProps = props; const { isOpen, onOrderComplete, onEditComplete, onClose, onDraftRestore, editMode } = props; return (
    isOpen
      ? <><button data-testid="edit-address" onClick={props.onRepickDeliveryAddress}>edit address</button><button type="button" data-testid={editMode ? 'edit-complete' : 'menu-complete'} onClick={() => {
        if (editMode) {
          void onEditComplete(h.state.checkoutDraft.submission).then(() => { h.state.checkoutDraft = null; onClose(); });
        } else void onOrderComplete({ ...h.orderData(), ...h.state.menuSubmission, ...(h.state.menuCreateId ? { clientRequestId: h.state.menuCreateId } : {}) });
      }}>complete order</button><button data-testid="menu-close" onClick={() => { h.state.checkoutDraft = null; onClose(); }}>close editor</button>
      <button data-testid="restore-context" onClick={() => {
        try { onDraftRestore(h.state.restoreContext); } catch (error) { h.state.restoreError = String(error); }
      }}>restore context</button></>
      : null
  ); },
}));
vi.mock('../../services/CheckoutDraftStore', () => ({ getCheckoutDraftStore: async () => ({ load: async () => h.state.checkoutDraft }) }));
vi.mock('../modals/SplitPaymentModal', () => ({
  SplitPaymentModal: ({ orderId, onClose }: { orderId: string; onClose: () => void }) => (
    <div data-testid="split-payment-modal" data-order-id={orderId}>
      <button type="button" onClick={onClose}>close split</button>
    </div>
  ),
}));

import OrderDashboard from '../OrderDashboard';
import FoodDashboard from '../dashboards/FoodDashboard';
import {
  claimOrdinaryCollectionOwner,
  releaseOrdinaryOwnerBeforeSend,
  retainedOrdinaryOwner,
} from '../../hooks/useOrderStore';

const SCOPE = { organizationId: 'org-1', terminalId: 'term-1' };

const targetOrder = (orderId: string): string => {
  h.state.serial += 1;
  h.state.orderId = orderId;
  h.state.orders = [{
    id: orderId,
    orderNumber: '42',
    order_number: '42',
    status: 'preparing',
    orderType: 'pickup',
    order_type: 'pickup',
    items: [],
    totalAmount: 12.5,
    total_amount: 12.5,
    paymentStatus: 'pending',
    payment_status: 'pending',
    createdAt: '2026-09-29T10:00:00.000Z',
    created_at: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    updated_at: '2026-09-29T10:00:00.000Z',
    supabase_id: `remote-${orderId}`,
    sync_status: 'synced',
  }];
  return orderId;
};

// Real-timer settle for chained native answers.
const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 25));
});

// (+) straight into the lone pickup card -> pending split -> dismissed split
// -> unpaid outstanding.
const openOutstanding = async () => {
  fireEvent.click(screen.getByTestId('new-order'));
  const complete = await screen.findByTestId('menu-complete');
  finishLeavingModals();
  fireEvent.click(complete);
  await screen.findByTestId('split-payment-modal');
  finishLeavingModals();
  fireEvent.click(screen.getByRole('button', { name: 'close split' }));
  await screen.findByRole('button', { name: /gift card/i });
};

// jsdom runs no CSS animations: end the glass modals' exit so they unmount
// and release the page they hid.
function finishLeavingModals() {
  document.querySelectorAll('.liquid-glass-modal-shell.leaving').forEach((shell) => {
    // React binds a vendor-prefixed name when jsdom lacks AnimationEvent.
    for (const type of ['animationend', 'webkitAnimationEnd', 'mozAnimationEnd']) {
      fireEvent(shell, new Event(type, { bubbles: true }));
    }
  });
}

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

describe('OrderDashboard gift receipt kept across an early Close (mounted host)', () => {
  beforeEach(() => {
    Object.assign(h.modules, { hasDeliveryModule: false, hasTablesModule: false });
    Object.assign(h.state, {
      orderId: '',
      checkoutDraft: null,
      returnedCustomer: null,
      menuProps: null,
      menuCreateId: undefined,
      menuSubmission: null,
      restoreContext: null,
      restoreError: '',
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

  it.each([false, true])('keeps the current delivery verdict only for an unchanged destination (changed=%s)', async changed => {
    const point = { lat: 40.61, lng: 22.96 };
    const address = { id: 'address-owned', street_address: 'Test Street 5', city: 'Test City', postal_code: '55133', latitude: point.lat, longitude: point.lng, floor_number: '1' };
    const customer = { id: 'customer-owned', name: 'Test', phone: '6900000000', selected_address_id: address.id, addresses: [address] };
    const zone = { success: true, isValid: true, validation_status: 'in_zone', coordinates: point, zone: { id: 'zone-owned', deliveryFee: 2.5, minimumOrderAmount: 7 } };
    h.state.checkoutDraft = { phase: 'editing', checkoutRequestId: 'address-editor', cartItems: [{ id: 'cart-line' }],
      context: { orderType: 'delivery', selectedCustomer: customer, selectedAddress: address, deliveryZoneInfo: zone } };
    h.state.returnedCustomer = { ...customer, delivery_destination_unchanged: !changed,
      addresses: [{ ...address, floor_number: '2', ...(changed ? { street_address: 'Different Street 9', latitude: 40.65 } : {}) }] };
    render(<OrderDashboard />);
    fireEvent.click(await screen.findByTestId('edit-address'));
    fireEvent.click(await screen.findByTestId('save-address-edit'));
    await waitFor(() => expect(screen.queryByTestId('save-address-edit')).toBeNull());
    if (changed) {
      expect(h.state.menuProps.deliveryZoneInfo).not.toEqual(zone);
      expect(h.native.validateAddress).toHaveBeenCalledWith({ lat: 40.65, lng: 22.96 }, 0);
    } else {
      expect(h.state.menuProps.deliveryZoneInfo).toEqual(zone);
      expect(h.state.menuProps.deliveryZoneInfo.zone.deliveryFee).toBe(2.5);
      expect(h.state.menuProps.selectedAddress.floor_number).toBe('2');
      expect(h.native.validateAddress).not.toHaveBeenCalled();
    }
    expect(h.state.menuProps.selectedCustomer).not.toHaveProperty('delivery_destination_unchanged');
    expect(h.state.checkoutDraft.cartItems).toEqual([{ id: 'cart-line' }]);
    expect(h.store.createOrder).not.toHaveBeenCalled();
    expect(h.native.recordPayment).not.toHaveBeenCalled();
  });

  it('preserves the cashier collector when a restored delivery edit collects an extra amount', async () => {
    targetOrder('cashier-delivery-edit');
    h.state.checkoutDraft = { draftId: 'delivery-edit', checkoutRequestId: 'delivery-edit-event', phase: 'editing', cartItems: [{}],
      context: { orderType: 'delivery', editMode: true, editOrderId: 'cashier-delivery-edit' } };
    h.bridge.orders.previewEditSettlement.mockResolvedValue({ success: true, paidTotal: 12.5, nextTotal: 17,
      requiredAction: 'collect', completedPayments: [{ id: 'original', method: 'cash', amount: 12.5 }], paymentStatus: 'paid',
      canonicalExpectedVersion: 1, localExpectedVersion: 1, quotedFinancials: { totalAmount: 17, quote: 'proof' } });
    render(<OrderDashboard />);
    await screen.findByTestId('edit-complete');
    const beforeCommit = vi.fn(async () => undefined);
    let completion!: Promise<void>;
    await act(async () => { completion = h.state.menuProps.onEditComplete({ orderId: 'cashier-delivery-edit',
      client_event_id: 'delivery-edit-event', expected_version: 1, expected_local_version: 1, items: [], total: 17 }, { beforeCommit }); });
    fireEvent.click(await screen.findByTestId('edit-settlement-delta-cash'));
    await act(async () => { await completion; });
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(h.bridge.orders.applyEditSettlement).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: 'collect', payments: [expect.objectContaining({ amount: 4.5, method: 'cash', collectedBy: 'cashier_drawer',
        staffId: '30000000-0000-4000-8000-000000000001', staffShiftId: '50000000-0000-4000-8000-000000000001' })] },
    }));
  });

  it('attributes an upfront delivery receipt to the collecting cashier without assigning courier custody', async () => {
    targetOrder('cashier-paid-delivery');
    const address = { id: 'address-owned', street_address: 'Street 5', city: 'City', postal_code: '55133', latitude: 40.61, longitude: 22.96 };
    h.state.checkoutDraft = { draftId: 'cashier-delivery', checkoutRequestId: 'cashier-delivery-create', phase: 'editing', cartItems: [{}],
      context: { orderType: 'delivery', editMode: false, selectedAddress: address,
        selectedCustomer: { id: 'customer-1', name: 'Person', phone: '123', addresses: [address] } } };
    render(<OrderDashboard />);
    await screen.findByTestId('menu-complete');
    await act(async () => { await h.state.menuProps.onOrderComplete({ ...h.orderData(), clientRequestId: 'cashier-delivery-create', address,
      deliveryFee: 0, deliveryZoneInfo: { zone: { id: 'zone-1', name: 'Zone', estimatedTime: 15 } },
      paymentData: { method: 'cash', amount: 12.5, currency: 'EUR', cashReceived: 12.5, change: 0 } }); });
    expect(h.store.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      initialPayment: expect.objectContaining({ method: 'cash', collectedBy: 'cashier_drawer', staffId: '30000000-0000-4000-8000-000000000001',
        staffShiftId: '50000000-0000-4000-8000-000000000001' }),
    }));
  });

  it('creates a delivery order with the exact frozen address point while filtering its legacy placeholder ID', async () => {
    targetOrder('saved-delivery-point');
    const address = { id: 'legacy:81ecd4e9-1738-4835-acc4-b9c8f4bbc069', street_address: 'Test street 12', city: 'City', postal_code: '54321',
      coordinates: { lat: 40.6138032, lng: 22.9601881 }, address_fingerprint: 'frozen-address-proof', floor_number: '2', name_on_ringer: 'Person' };
    h.state.checkoutDraft = { draftId: 'delivery-draft', checkoutRequestId: 'original-delivery-create', phase: 'checkout_pending', cartItems: [{}],
      context: { orderType: 'delivery', editMode: false, selectedAddress: address, selectedCustomer: { id: '81ecd4e9-1738-4835-acc4-b9c8f4bbc069', name: 'Person', phone: '123' } } };
    h.state.menuSubmission = { address, deliveryZoneInfo: { zone: { id: 'zone-1', name: 'Zone', estimatedTime: 15 } }, deliveryFee: 0 };
    h.state.menuCreateId = 'original-delivery-create';
    render(<OrderDashboard />);
    fireEvent.click(await screen.findByTestId('menu-complete'));
    await waitFor(() => expect(h.store.createOrder).toHaveBeenCalledTimes(1));
    expect(h.store.createOrder).toHaveBeenCalledWith(expect.objectContaining({ clientRequestId: 'original-delivery-create', delivery_address: 'Test street 12',
      delivery_address_id: null, delivery_latitude: 40.6138032, delivery_longitude: 22.9601881, delivery_address_fingerprint: 'frozen-address-proof',
      delivery_zone_id: 'zone-1', delivery_floor: '2', delivery_fee: 0 }));
  });

  it('restores one pending checkout in the paired FoodDashboard and hidden OrderFlow hosts', async () => {
    h.state.checkoutDraft = { draftId: 'original-draft', checkoutRequestId: 'original-frozen-cash', phase: 'checkout_pending', cartItems: [{}],
      context: { orderType: 'pickup', editMode: false } };
    const original = JSON.stringify(h.state.checkoutDraft);
    render(<FoodDashboard />);
    await screen.findAllByTestId('menu-complete');
    await settle();
    expect(screen.getAllByTestId('menu-complete')).toHaveLength(1);
    expect(JSON.stringify(h.state.checkoutDraft)).toBe(original);
    expect(h.store.createOrder).not.toHaveBeenCalled();
    expect(h.native.recordPayment).not.toHaveBeenCalled();
  });

  it('restores and completes an edit, then creates the next checkout using its new persisted identity', async () => {
    targetOrder('dashboard-next-create');
    const settlementRequest = { orderId:'old-paid-order',client_event_id:'restored-edit-event',expected_version:3,expected_local_version:1,items:[],action:{type:'none'} };
    h.state.checkoutDraft = { phase:'checkout_pending',checkoutRequestId:'restored-edit-event',cartItems:[{id:'line'}],
      context:{editMode:true,editOrderId:'old-paid-order',orderType:'pickup'},
      submission:{...settlementRequest,action:'edit_settlement',settlementAction:settlementRequest.action,settlementRequest} };
    render(<OrderDashboard />);
    fireEvent.click(await screen.findByTestId('edit-complete'));
    await waitFor(() => expect(screen.queryByTestId('edit-complete')).toBeNull());
    expect(h.bridge.orders.applyEditSettlement).toHaveBeenCalledWith(settlementRequest);
    h.state.menuCreateId='new-delivery-durable-id';
    const calls=h.store.createOrder.mock.calls.length;
    fireEvent.click(screen.getByTestId('new-order'));
    fireEvent.click(await screen.findByTestId('menu-complete'));
    await waitFor(() => expect(h.store.createOrder.mock.calls.length).toBe(calls+1));
    expect(h.store.createOrder).toHaveBeenLastCalledWith(expect.objectContaining({clientRequestId:'new-delivery-durable-id'}));
  });

  it('discards an unsubmitted restored cart and admits a new durable checkout identity', async () => {
    targetOrder('dashboard-after-discard');
    h.state.checkoutDraft={phase:'editing',checkoutRequestId:'discarded-editor',cartItems:[{id:'line'}],context:{orderType:'pickup'}};
    render(<OrderDashboard />);
    await screen.findByTestId('menu-complete');
    fireEvent.click(screen.getByTestId('menu-close'));
    h.state.menuCreateId='after-discard';
    const calls=h.store.createOrder.mock.calls.length;
    fireEvent.click(screen.getByTestId('new-order'));
    fireEvent.click(await screen.findByTestId('menu-complete'));
    await waitFor(() => expect(h.store.createOrder.mock.calls.length).toBe(calls+1));
    expect(h.store.createOrder).toHaveBeenLastCalledWith(expect.objectContaining({clientRequestId:'after-discard'}));
  });

  it('keeps a pending original through customer/type context changes and ignores forged persisted renewal proof', async () => {
    targetOrder('dashboard-original-recovery');
    h.state.checkoutDraft = { draftId: 'pending-draft', checkoutRequestId: 'original-frozen-cash', phase: 'checkout_pending', cartItems: [{}],
      context: { orderType: 'pickup', editMode: false } };
    render(<OrderDashboard />);
    await screen.findByTestId('menu-complete');
    h.state.restoreContext = { orderType: 'delivery', selectedCustomer: { id: 'customer-2', name: 'Customer' },
      checkoutRequestId: 'wrong-id', checkoutPhase: 'editing', renewedFrom: 'original-frozen-cash', previousCheckoutRequestId: 'original-frozen-cash' };
    fireEvent.click(screen.getByTestId('restore-context'));
    expect(h.state.restoreError).toContain('CHECKOUT_REQUEST_ID_CHANGED');
    h.state.restoreContext = { ...h.state.restoreContext, orderType: 'pickup', checkoutRequestId: 'original-frozen-cash' };
    h.state.restoreError = '';
    fireEvent.click(screen.getByTestId('restore-context'));
    expect(h.state.restoreError).toBe('');
    h.state.menuCreateId = 'original-frozen-cash';
    const calls = h.store.createOrder.mock.calls.length;
    fireEvent.click(screen.getByTestId('menu-complete'));
    await waitFor(() => expect(h.store.createOrder).toHaveBeenCalledTimes(calls + 1));
    expect(h.store.createOrder).toHaveBeenLastCalledWith(expect.objectContaining({ clientRequestId: 'original-frozen-cash' }));
  });

  it('keeps the booked receipt reachable when Close beats the ledger reread, then reopens the same Tender', async () => {
    const orderId = targetOrder('dash-gift-close-race');
    render(<OrderDashboard />);
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
    targetOrder('dash-gift-late-failure');
    render(<OrderDashboard />);
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
    targetOrder('dash-gift-no-action');
    h.state.fiscalNext = 'none';
    render(<OrderDashboard />);
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
    const orderId = targetOrder('dash-ordinary-late-refresh');
    const view = render(<OrderDashboard />);
    await openOutstanding();
    h.state.holdRefreshOn = 'record';
    const refresh = h.hold<void>();
    h.state.refresh = refresh;

    fireEvent.click(cardOption());
    await waitFor(() => expect(refresh.taken).toBe(true));
    expect(h.native.recordPayment).toHaveBeenCalledTimes(1);

    // A newer scope takes the screen while the original's final refresh is pending.
    h.identity.current = { branchId: 'branch-1', organizationId: 'org-1', terminalId: 'term-2' };
    view.rerender(<OrderDashboard className="newer-scope" />);
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
    const orderId = targetOrder('dash-ordinary-unmount');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(<OrderDashboard />);
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
    const orderId = targetOrder('dash-ordinary-unknown');
    render(<OrderDashboard />);
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

// Reuse the mounted host's native/store boundary above, avoiding a second copy
// of the dashboard's large fixture for this history regression.
describe('OrderDashboard completion history without delivery (mounted host)', () => {
  beforeEach(() => {
    Object.assign(h.modules, { hasDeliveryModule: false, hasTablesModule: true });
    h.state.orders = [
      { id: 'pickup', status: 'completed', orderType: 'pickup' },
      { id: 'table', status: 'completed', orderType: 'dine-in', table_id: 'table-1' },
      { id: 'room', status: 'completed', orderType: 'dine-in', room_number: '101' },
      { id: 'service', status: 'completed', orderType: 'service' },
      { id: 'delivery', status: 'delivered', orderType: 'delivery' },
      { id: 'pending', status: 'pending', orderType: 'pickup' },
      { id: 'cancelled', status: 'cancelled', orderType: 'pickup' },
    ].map(order => ({ ...order, orderNumber: order.id, items: [], totalAmount: 5 }));
  });

  afterEach(() => cleanup());

  const expectHistory = async () => {
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Delivered 5 — Selected' })).toBeInTheDocument());
    for (const id of ['pickup', 'table', 'room', 'service', 'delivery']) {
      expect(screen.getByTestId(`row-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('row-pending')).toBeNull();
    expect(screen.queryByTestId('row-cancelled')).toBeNull();
  };

  it('opens all completed fulfillment types without acquiring delivery', async () => {
    render(<OrderDashboard />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Delivered 5' }));
    await expectHistory();
    expect(screen.queryByRole('tab', { name: /Rooms|Services/ })).toBeNull();
  });

  it('retains the selected history when delivery or tables becomes unavailable', async () => {
    h.modules.hasDeliveryModule = true;
    const { rerender } = render(<OrderDashboard />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Delivered 5' }));
    await expectHistory();

    h.modules.hasDeliveryModule = false;
    // Mocked contexts have no provider notification; changing a prop lets the
    // memoized host observe the new module values without remounting.
    rerender(<OrderDashboard className="delivery-revoked" />);
    await expectHistory();

    h.modules.hasTablesModule = false;
    rerender(<OrderDashboard className="tables-revoked" />);
    await expectHistory();
    expect(screen.queryByRole('tab', { name: /Tables/ })).toBeNull();
  });
});
