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
vi.mock('../../ui/pos-glass-components', async (original) => ({ ...(await original<typeof import('../../ui/pos-glass-components')>()),
  LiquidGlassModal: ({ isOpen, children, footer, onClose }: any) => isOpen ? <div><button aria-label="Dismiss modal" onClick={onClose} />{children}{footer}</div> : null }));

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

// Fix review 06/10/2026: the main cashier's close held by a satellite cash
// handover showed the English-only SATELLITE_HANDOVER_PENDING (ordinary close)
// or "could not read the retained close" (gift-bound close), and a handover
// the server refused for good held the close with no way out.
const PENDING = 'SATELLITE_HANDOVER_PENDING: reconnect to finish receiving satellite cash before closing this cashier shift';
const REFUSED = 'SATELLITE_HANDOVER_REFUSED: REMOTE_HANDOVER_PROOF_UNAVAILABLE: the server refused this satellite cash handover for good; a manager can release it without crediting this drawer';
const PENDING_TEXT = 'Satellite cash is still being received. Reconnect to the internet so it can finish before this shift closes.';
const REFUSED_TEXT = "The satellite till already closed this shift itself, so its cash can't be received here. A manager can release it so this shift can close. The satellite cash is not added to this drawer.";
const HANDOVER_ID = '90000000-0000-4000-8000-000000000001';

function withInvoke(target: any) {
  const invoke = vi.fn(async (channel: string, payload?: { action?: string }) => {
    if (channel !== 'shift_satellite_handover_recovery') return undefined;
    if (payload?.action === 'list') {
      return { success: true, handovers: [{ handoverId: HANDOVER_ID, currency: 'CHF', countedCents: 4250, state: 'refused', refusalCode: 'REMOTE_HANDOVER_PROOF_UNAVAILABLE' }] };
    }
    return { success: true, released: true, drawerCredited: false };
  });
  return new Proxy(target, { get: (inner, key) => (key === 'invoke' ? invoke : inner[key as string]) });
}

/** An ordinary (not gift-bound) cashier close in EUR, as the ledger test sets it up. */
function ordinaryCashierClose() {
  fixture.getStatus.mockResolvedValue({ ok: true, data: { enabled: false } });
  fixture.activeShift = shift({ currency: 'EUR' });
  bridge.shiftFinancialOpening.status.mockResolvedValue({ success: true, openings: [] });
  bridge.shifts.getSummary.mockResolvedValue({ success: true, data: {
    ...summary(0), currency: 'EUR',
    cashierCash: { cashCollections: 21, cashRefunds: 21, currency: 'EUR' },
    cashRefunds: 21,
  } });
}

async function closeOrdinaryWithZeroCash() {
  const closeButton = await screen.findByTestId('staff-checkout-confirm-button');
  await waitFor(() => expect(closeButton).toBeEnabled());
  fireEvent.click(closeButton);
  fireEvent.click(await screen.findByRole('button', { name: 'common.actions.confirm' }));
  await waitFor(() => expect(bridge.shifts.close).toHaveBeenCalledTimes(1));
}

describe('StaffShiftModal close held by a satellite cash handover', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    fixture.scope.organizationId = '10000000-0000-4000-8000-000000000001';
    fixture.scope.branchId = '20000000-0000-4000-8000-000000000001'; fixture.scope.terminalId = 'register-public-01';
    fixture.sessionStaff = { staffId: '70000000-0000-4000-8000-000000000001', ...fixture.scope };
    fixture.activeShift = shift();
    bridge = withInvoke(makeBridge());
    fixture.bridge = bridge;
    setBridge(bridge);
    __resetForTesting();
    await setSecureSession({ ...fixture.scope, staffId: fixture.sessionStaff.staffId, sessionId: 'main-login-session' });
  });
  afterEach(() => {
    cleanup();
    __resetForTesting(); resetBridge(); localStorage.clear();
  });

  it('an ordinary close waiting for satellite cash says so in till language, not the code', async () => {
    ordinaryCashierClose();
    bridge.shifts.close.mockRejectedValue(PENDING);
    render(<StaffShiftModal {...props} />);
    await closeOrdinaryWithZeroCash();

    expect(await screen.findByText(PENDING_TEXT)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('SATELLITE_HANDOVER_PENDING');
    expect(screen.queryByTestId('satellite-handover-release')).toBeNull();
  });

  it('a refused handover offers the manager release, which credits no drawer and frees the close', async () => {
    ordinaryCashierClose();
    bridge.shifts.close.mockRejectedValue(REFUSED);
    render(<StaffShiftModal {...props} />);
    await closeOrdinaryWithZeroCash();

    expect(await screen.findByText(REFUSED_TEXT)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/SATELLITE_HANDOVER_REFUSED|REMOTE_HANDOVER_/);
    const panel = await screen.findByTestId('satellite-handover-release');
    expect(bridge.invoke).toHaveBeenCalledWith('shift_satellite_handover_recovery', { action: 'list', cashierShiftId: SHIFT_ID });
    fireEvent.change(within(panel).getByTestId(`satellite-handover-release-pin-${HANDOVER_ID}`), { target: { value: '2468' } });
    fireEvent.click(within(panel).getByTestId(`satellite-handover-release-${HANDOVER_ID}`));

    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith('shift_satellite_handover_recovery', {
      action: 'release', handoverId: HANDOVER_ID, cashierShiftId: SHIFT_ID, managerPin: '2468',
    }));
    expect(await screen.findByText('Released. The satellite cash was not added to this drawer. You can close the shift now.')).toBeInTheDocument();
    expect(screen.queryByText(REFUSED_TEXT)).toBeNull();
  });

  it('a gift-bound close waiting for satellite cash says so too, never that the close could not be read', async () => {
    fixture.getStatus.mockResolvedValue(capability());
    bridge.shifts.close.mockRejectedValue(PENDING);
    await renderReady();
    count('14000');
    await approve();
    await waitFor(() => expect(bridge.shifts.close).toHaveBeenCalledTimes(1));

    expect(await screen.findByText(PENDING_TEXT)).toBeInTheDocument();
    expect(screen.queryByText('This terminal could not read the retained close. Try again.')).toBeNull();
    expect(document.body.textContent).not.toContain('SATELLITE_HANDOVER_PENDING');
  });
});
