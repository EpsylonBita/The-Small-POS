import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GiftFundingDrawerView,
  ShiftFinancialClosingRecoveryView,
  ShiftFinancialOpeningView,
} from '../../../../lib/ipc-contracts';

const fixture = vi.hoisted(() => ({
  scope: { organizationId: '10000000-0000-4000-8000-000000000001', branchId: '20000000-0000-4000-8000-000000000001', terminalId: 'register-public-01' },
  staffId: '30000000-0000-4000-8000-000000000001',
  sessionStaff: {} as any,
  activeShift: null as any,
  getStatus: vi.fn(), setStaff: vi.fn(), setActiveShiftImmediate: vi.fn(), refreshActiveShift: vi.fn(), onClose: vi.fn(),
  t: (key: string, fallback?: string | { defaultValue?: string }) => typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key,
  bridge: null as any,
}));
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: fixture.t }) }));
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: fixture.t }) }));
vi.mock('../../../contexts/shift-context', () => ({ useShift: () => ({ staff: fixture.sessionStaff, activeShift: fixture.activeShift,
  isShiftActive: Boolean(fixture.activeShift), setStaff: fixture.setStaff, setActiveShiftImmediate: fixture.setActiveShiftImmediate,
  refreshActiveShift: fixture.refreshActiveShift }) }));
vi.mock('../../../hooks/useTerminalSettings', () => {
  const useTerminalSettings = () => ({ settings: {}, loading: false, error: null, refresh: vi.fn(),
    getSetting: (_category: string, key: string) => ({ organization_id: fixture.scope.organizationId, branch_id: fixture.scope.branchId, terminal_id: fixture.scope.terminalId } as Record<string, string>)[key] });
  return { default: useTerminalSettings, useTerminalSettings };
});
vi.mock('../../../services/terminal-credentials', () => ({ getCachedTerminalCredentials: () => ({ ...fixture.scope, apiKey: '' }) }));
vi.mock('../../../services/GiftCardsApiService', () => ({ GiftCardsApiService: class { getStatus = fixture.getStatus; } }));
vi.mock('../../../utils/api-helpers', () => ({ posApiGet: vi.fn(async () => ({ success: false })) }));
vi.mock('../../../utils/fiscal-integration-entitlement', async (original) => ({ ...(await original<typeof import('../../../utils/fiscal-integration-entitlement')>()), loadFiscalOrderReportingEntitlement: vi.fn(async () => false) }));
vi.mock('../../../../lib', async (original) => ({ ...(await original<typeof import('../../../../lib')>()), getBridge: () => fixture.bridge }));
import { StaffShiftModal } from '../StaffShiftModal';
import { setSecureSession, __resetForTesting } from '../../../lib/secure-session-cache';
import { setBridge, resetBridge } from '../../../../lib/ipc-adapter';

const SHIFT_ID = '50000000-0000-4000-8000-000000000001';
const OTHER_SHIFT_ID = '50000000-0000-4000-8000-000000000002';
const OTHER_STAFF_ID = '30000000-0000-4000-8000-000000000002';
const OPENING_KEY = '40000000-0000-4000-8000-000000000001';
const DRAWER_ID = '60000000-0000-4000-8000-000000000001';
const CLOSING_KEY = '80000000-0000-4000-8000-000000000001';
const props = { isOpen: true, onClose: fixture.onClose, mode: 'checkout' as const };
const role = { role_id: 'cashier-role', role_name: 'cashier', role_display_name: 'Cashier', is_primary: true };
const member = (id: string, name: string) => ({ id, name, first_name: name, last_name: '', role_name: 'cashier', roles: [role], can_login_pos: true, has_pin: true, is_active: true });
const members = [member(fixture.staffId, 'Cashier Alice'), member(OTHER_STAFF_ID, 'Cashier Bob')];
const capability = () => ({ ok: true, data: { enabled: true, moduleEnabled: true, terminalEnabled: true, configured: true, unavailable: false, currency: 'CHF' } });
const canonicalTerms = { closedAt: '2026-09-30T17:00:00.000Z', confirmedAt: '2026-09-30T17:05:00.000Z', countedCents: 14000,
  ordinaryExpectedCents: 12000, giftCashCents: 2000, expectedCents: 14000, varianceCents: 0 };

function opening(patch: Partial<ShiftFinancialOpeningView> = {}): ShiftFinancialOpeningView {
  return { openingKey: OPENING_KEY, shiftId: SHIFT_ID, drawerId: DRAWER_ID, staffId: fixture.staffId, ...fixture.scope,
    openingCents: 0, currency: 'CHF', businessDate: '2026-09-30', checkedInAt: '2026-09-30T08:00:00.000Z',
    isDayStart: true, calculationVersion: 2, state: 'confirmed_usable', usable: true,
    hostedAuthorization: { state: 'authorized', expiresAt: null }, lastPendingCode: null, drawer: null, ...patch } as ShiftFinancialOpeningView;
}
function shift(patch: Record<string, unknown> = {}) {
  return { id: SHIFT_ID, staff_id: fixture.staffId, staff_name: 'Cashier Alice', branch_id: fixture.scope.branchId,
    terminal_id: fixture.scope.terminalId, role_type: 'cashier', check_in_time: '2026-09-30T08:00:00.000Z', opening_cash_amount: 0,
    status: 'active', total_orders_count: 0, total_sales_amount: 0, total_cash_sales: 0, total_card_sales: 0,
    created_at: '2026-09-30T08:00:00.000Z', updated_at: '2026-09-30T08:00:00.000Z', ...patch };
}
function summary(cashTotal: number) {
  const channel = (cash: number) => ({ cashTotal: cash, cardTotal: 0, total: cash, count: 0, cashCount: 0, cardCount: 0 });
  return { shift: shift(), breakdown: { instore: channel(cashTotal), delivery: channel(0), takeaway: channel(0), overall: channel(cashTotal) },
    cashDrawer: {}, cashRefunds: 0, totalExpenses: 0, expenses: [], staffPayments: [], driverDeliveries: [], transferredDrivers: [],
    transferredWaiters: [], waiterTables: [], canceledOrders: [], cancelledOrders: [] };
}
function drawer(patch: Record<string, unknown> = {}): GiftFundingDrawerView {
  return { openingKey: OPENING_KEY, shiftId: SHIFT_ID, drawerId: DRAWER_ID, staffId: fixture.staffId, currency: 'CHF', version: 3,
    acknowledgementId: 'ack-1', giftCashCents: 2000, ordinaryExpectedCents: 12345, expectedCents: 14345, ...patch } as unknown as GiftFundingDrawerView;
}
function closing(patch: Record<string, unknown> = {}): ShiftFinancialClosingRecoveryView {
  return { closingKey: CLOSING_KEY, openingKey: OPENING_KEY, shiftId: SHIFT_ID, state: 'pending', code: 'PENDING_FINANCIAL_CONFIRMATION',
    authorizationRequired: false, currency: 'CHF', countedCents: 14000, queue: null,
    localPreview: { closedAt: '2026-09-30T17:00:00.000Z', ordinaryExpectedCents: 12345, giftCashCents: 2000, expectedCents: 14345, varianceCents: -345 },
    canonical: null, ...patch } as unknown as ShiftFinancialClosingRecoveryView;
}
const pendingCloseResult = () => ({ success: true, message: 'Shift closed', giftFinancialClosing: {
  state: 'pending_financial_confirmation', closingKey: CLOSING_KEY, countedCents: 14000, requestBody: 'SECRET-BODY' } });
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** Typed fake IPC for the namespaces under test; any other call fails closed. */
function makeBridge() {
  const explicit: Record<string, Record<string, any>> = {
    terminalConfig: { getTerminalId: vi.fn(async () => fixture.scope.terminalId), getBranchId: vi.fn(async () => fixture.scope.branchId),
      getOrganizationId: vi.fn(async () => fixture.scope.organizationId), getSetting: vi.fn(async (_category: string, key: string) => key === 'name' ? 'Till 1' : null) },
    settings: { get: vi.fn(async () => JSON.stringify({ branch_id: fixture.scope.branchId, staff: members })), updateLocal: vi.fn(async () => ({ success: true })) },
    staffAuth: { refreshDirectory: vi.fn(async () => ({ success: true, currentTerminalId: fixture.scope.terminalId, staff: [] })), verifyCheckInPin: vi.fn(async () => ({ success: true })) },
    staffSchedule: { list: vi.fn(async () => ({ success: true, data: { staff: members } })) },
    shifts: {
      getActive: vi.fn(async () => null), getActiveForBranch: vi.fn(async () => []), getCheckInEligibility: vi.fn(async () => ({ requiresCashierFirst: false })),
      getActiveCashierByTerminal: vi.fn(async () => ({ id: 'ordinary-cashier' })), open: vi.fn(), getById: vi.fn(async () => null),
      getSummary: vi.fn(async () => ({ success: true, data: summary(123.45) })), getExpenses: vi.fn(async () => []),
      getStaffPayments: vi.fn(async () => []), getStaffPaymentsByStaff: vi.fn(async () => []), getStaffPaymentTotalForDate: vi.fn(async () => 0),
      close: vi.fn(async () => pendingCloseResult()), printCheckout: vi.fn(async () => ({ success: true })),
    },
    shiftFinancialOpening: { status: vi.fn(async () => ({ success: true, openings: [opening()] })), begin: vi.fn(), authorize: vi.fn(), clearAuthorization: vi.fn() },
    shiftFinancialClosing: {
      listPending: vi.fn(async () => ({ success: true, closings: [], truncated: false })),
      status: vi.fn(async () => ({ success: true, closing: closing() })),
      retry: vi.fn(async () => ({ success: true, closing: { closingKey: CLOSING_KEY, shiftId: SHIFT_ID, state: 'queued' } })),
      authorize: vi.fn(async () => ({ success: true, closing: { closingKey: CLOSING_KEY, shiftId: SHIFT_ID } })),
    },
    giftFunding: {
      closeBlocker: vi.fn(async () => ({ success: true, blocked: false, shiftId: SHIFT_ID, unresolved: [] })),
      refreshDrawer: vi.fn(async () => ({ success: true, drawer: drawer() })),
    },
    secureSession: { set: vi.fn(), clear: vi.fn() },
  };
  const namespaces: Record<string, any> = {};
  const namespace = (methods: Record<string, any>) => new Proxy(methods, {
    get(target, key) {
      if (typeof key !== 'string' || key === 'then') return undefined;
      if (!(key in target)) target[key] = vi.fn(async () => ({ success: false }));
      return target[key];
    },
  });
  return new Proxy(explicit, {
    get(target, key) {
      if (typeof key !== 'string' || key === 'then') return undefined;
      if (!namespaces[key]) namespaces[key] = namespace(target[key] ?? (target[key] = {}));
      return namespaces[key];
    },
  }) as any;
}

let bridge: any;
const cents = (testId: string) => screen.getByTestId(testId).getAttribute('data-cents');
const count = (value: string) => fireEvent.change(screen.getByTestId('gift-close-count'), { target: { value } });
async function renderReady(overrides: Record<string, unknown> = {}) {
  const view = render(<StaffShiftModal {...props} {...overrides} />);
  await screen.findByTestId('gift-close-ordinary');
  return view;
}
async function approve() {
  fireEvent.click(screen.getByTestId('staff-checkout-confirm-button'));
  fireEvent.click(await screen.findByTestId('gift-close-approve'));
}
async function recoveryState(state: string) {
  await waitFor(() => expect(screen.getByTestId('gift-close-recovery')).toHaveAttribute('data-state', state));
}

describe('StaffShiftModal ordinary cashier ledger and confirmation', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    fixture.scope.organizationId = '10000000-0000-4000-8000-000000000001';
    fixture.scope.branchId = '20000000-0000-4000-8000-000000000001'; fixture.scope.terminalId = 'register-public-01';
    fixture.sessionStaff = { staffId: '70000000-0000-4000-8000-000000000001', ...fixture.scope };
    fixture.activeShift = shift({ currency: 'EUR' });
    fixture.getStatus.mockResolvedValue({ ok: true, data: { enabled: false } });
    bridge = makeBridge();
    bridge.shiftFinancialOpening.status.mockResolvedValue({ success: true, openings: [] });
    fixture.bridge = bridge;
    setBridge(bridge);
    __resetForTesting();
    await setSecureSession({ ...fixture.scope, staffId: fixture.sessionStaff.staffId, sessionId: 'main-login-session' });
  });
  afterEach(() => {
    cleanup();
    __resetForTesting(); resetBridge(); localStorage.clear();
  });


  it('keeps a zero-count confirmation above the recovery checkout, without closing before confirmation', async () => {
    bridge.shifts.getSummary.mockResolvedValue({ success: true, data: {
      ...summary(0), currency: 'EUR',
      cashierCash: { cashCollections: 21, cashRefunds: 21, currency: 'EUR' },
      cashRefunds: 21,
    } });
    render(<StaffShiftModal {...props} />);
    const closeButton = await screen.findByTestId('staff-checkout-confirm-button');
    await waitFor(() => expect(closeButton).toBeEnabled());
    fireEvent.click(closeButton);
    const confirm = await screen.findByRole('dialog', { name: 'Confirm Zero Closing Cash' });
    const shell = screen.getByTestId('staff-checkout-shell').closest('[data-liquid-glass-modal-viewport]') as HTMLElement;
    const confirmationLayer = confirm.closest('[data-liquid-glass-modal-viewport]') as HTMLElement;
    expect(confirmationLayer.dataset.cashierRecovery).toBe('true');
    expect(Number(confirmationLayer.style.zIndex)).toBeGreaterThanOrEqual(Number(shell.style.zIndex));
    expect(confirmationLayer).toBeVisible();
    expect(bridge.shifts.close).not.toHaveBeenCalled();
  });

  it('uses actual cash collected and returned even when cancelled sales breakdown is zero', async () => {
    bridge.shifts.getSummary.mockResolvedValue({ success: true, data: {
      ...summary(0), currency: null,
      cashierCash: { cashCollections: 15, cashRefunds: 21, currency: 'EUR' },
      cashRefunds: 21,
    } });
    render(<StaffShiftModal {...props} />);
    await screen.findByTestId('staff-checkout-confirm-button');
    await waitFor(() => expect(screen.getAllByText(/-[€\s]*6[,.]00/).length).toBeGreaterThan(0));
    expect(bridge.shifts.close).not.toHaveBeenCalled();
  });
});
