import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next, { type TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localeBundles } from '../../../../locales/bundles';
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
  localizedT: undefined as TFunction | undefined,
  bridge: null as any,
}));
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: fixture.localizedT ?? fixture.t }) }));
vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ language: fixture.localizedT ? 'el' : 'en', setLanguage: vi.fn(), t: fixture.localizedT ?? fixture.t }),
}));
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
import { configureSlowRunnerWaits, SLOW_RUNNER_TEST_TIMEOUT_MS } from '../../../test/slow-runner';

configureSlowRunnerWaits();

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
      pendingCashReturns: vi.fn(async () => ({ success: true, requires_receipt_check: false, active_waiter_count: 0, returns: [] })),
      // These close-gate cases pin the legacy remote-checkout gate: a server without
      // the unit readiness endpoint (404) falls back to it unchanged (founder 13/10/2026).
      unitReadiness: vi.fn(async () => ({ success: false, status: 404, error: 'Not found' })),
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
const recordableBlocker = {
  orderId: 'order-1', orderNumber: 'A-0120', totalAmount: 13, settledAmount: 0,
  paymentStatus: 'pending', paymentMethod: 'cash', reasonCode: 'no_persisted_payment',
  reasonText: 'Recorded payment missing.', suggestedFix: 'Record the missing payment.',
};
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

describe('StaffShiftModal ordinary cashier ledger and confirmation', { timeout: SLOW_RUNNER_TEST_TIMEOUT_MS }, () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    fixture.localizedT = undefined;
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
    vi.restoreAllMocks();
    __resetForTesting(); resetBridge(); localStorage.clear();
  });

  it.each([
    { role: 'driver', roleType: 'driver', paymentAmount: 0, countLabel: 'Cash Actually Handed Over' },
    { role: 'cashier', roleType: 'cashier', paymentAmount: undefined, countLabel: 'modals.staffShift.closingCashLabel' },
    { role: 'waiter', roleType: 'server', paymentAmount: undefined, countLabel: 'Cash Actually Handed Over' },
  ])('sends the release Checkout request for a $role', async ({ roleType, paymentAmount, countLabel }) => {
    fixture.sessionStaff = { ...fixture.sessionStaff, databaseStaffId: 's1' };
    fixture.activeShift = shift({ id: 'sh1', staff_id: 's1', role_type: roleType, currency: 'EUR' });
    bridge.shifts.getSummary.mockResolvedValue({
      success: true, data: { ...summary(0), shift: fixture.activeShift, currency: 'EUR' },
    });
    bridge.shifts.close.mockResolvedValue({ success: true });
    render(<StaffShiftModal {...props} />);

    fireEvent.change(await screen.findByRole('textbox', { name: countLabel }), { target: { value: '2500' } });
    const button = await screen.findByTestId('staff-checkout-confirm-button');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(fixture.onClose).toHaveBeenCalledOnce());

    // Strict literal snapshot of the call in 6fa259b66, including the undefined key.
    expect(bridge.shifts.close.mock.calls).toStrictEqual([[
      { shiftId: 'sh1', closingCash: 25, closedBy: 's1', paymentAmount },
    ]]);
  });

  it('shows delivery rows without a Τα έφερε control', async () => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng: 'el', resources: { el: { translation: localeBundles.el } } });
    fixture.localizedT = i18n.getFixedT('el');
    fixture.activeShift = shift({ id: 'sh1', role_type: 'driver', currency: 'EUR' });
    bridge.shifts.getSummary.mockResolvedValue({
      success: true, data: {
        ...summary(0), shift: fixture.activeShift, currency: 'EUR',
        driverDeliveries: [
          { id: 'd1', order_id: 'o1', customer_name: 'Μαρία', payment_method: 'cash', status: 'delivered',
            platform_cash_confirmable_cents: 1250, platform_cash_confirmable_currency: 'EUR' },
          { id: 'd2', order_id: 'o2', customer_name: 'Λίνα', payment_method: 'card', status: 'delivered' },
        ],
      },
    });
    render(<StaffShiftModal {...props} />);
    expect(await screen.findByText('Μαρία')).toBeInTheDocument();
    expect(screen.getByText('Λίνα')).toBeInTheDocument();
    expect(screen.queryByText(/Τα έφερε|modals\.staffShift\.platformCash/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Ο διανομέας έφερε|modals\.staffShift\.platformCash/ })).toBeNull();
  });

  it.each(['returned', 'thrown'] as const)('uses localized cashier refusal text for a %s response', async (kind) => {
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: 'el',
      resources: { el: { translation: localeBundles.el } },
      interpolation: { escapeValue: false },
    });
    const t = i18n.getFixedT('el');
    fixture.localizedT = t;
    bridge.shifts.getSummary.mockResolvedValue({
      success: true, data: { ...summary(0), currency: 'EUR' },
    });
    const refusal = {
      success: false, errorCode: 'UNSETTLED_PAYMENT_BLOCKER',
      error: 'Native close error.', message: 'Native close message.',
      blockers: [recordableBlocker],
    };
    const raw = kind === 'returned' ? refusal : new Error(JSON.stringify(refusal));
    if (kind === 'returned') bridge.shifts.close.mockResolvedValueOnce(raw);
    else bridge.shifts.close.mockRejectedValueOnce(raw);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<StaffShiftModal {...props} />);

    const close = await screen.findByTestId('staff-checkout-confirm-button');
    await waitFor(() => expect(close).toBeEnabled());
    fireEvent.click(close);
    const zero = await screen.findByRole('dialog', { name: t('modals.staffShift.confirmZeroTitle') });
    fireEvent.click(within(zero).getByRole('button', { name: t('common.actions.confirm') }));

    const reason = 'Η παραγγελία A-0120 έκλεισε χωρίς να γραφτεί η πληρωμή της.';
    const fix = 'Αν ο πελάτης έχει ήδη πληρώσει και βλέπετε το κουμπί, πατήστε το για να καταγράψετε την πληρωμή.';
    expect(await screen.findByText(`A-0120: ${reason} ${fix}`)).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.getByText(fix)).toBeInTheDocument();
    for (const value of [refusal.error, refusal.message, recordableBlocker.reasonText, recordableBlocker.suggestedFix]) {
      expect(document.body).not.toHaveTextContent(value);
    }
    expect([...warn.mock.calls, ...log.mock.calls].filter(([, value]) => value === raw)).toEqual([
      ['[StaffShiftModal] Cashier close refused:', raw],
    ]);
    expect(bridge.shifts.close).toHaveBeenCalledOnce();
  });

  it.each([
    'SHIFT_CURRENCY_SETTLEMENT_REQUIRED: Settle active staff cash first.',
    new Error('SHIFT_CURRENCY_SETTLEMENT_REQUIRED: Settle active staff cash first.'),
    { code: 'SHIFT_CURRENCY_SETTLEMENT_REQUIRED' },
  ])('shows the Greek settlement instruction for thrown cashier refusal %s', async (refusal) => {
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: 'el',
      resources: { el: { translation: localeBundles.el } },
      interpolation: { escapeValue: false },
    });
    const t = i18n.getFixedT('el');
    fixture.localizedT = t;
    bridge.shifts.getSummary.mockResolvedValue({
      success: true, data: { ...summary(0), currency: 'EUR' },
    });
    bridge.shifts.close.mockRejectedValueOnce(refusal);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<StaffShiftModal {...props} />);

    const close = await screen.findByTestId('staff-checkout-confirm-button');
    await waitFor(() => expect(close).toBeEnabled());
    fireEvent.click(close);
    const zero = await screen.findByRole('dialog', { name: t('modals.staffShift.confirmZeroTitle') });
    fireEvent.click(within(zero).getByRole('button', { name: t('common.actions.confirm') }));

    expect(await screen.findByText(
      'Τακτοποιήστε και κλείστε τις βάρδιες προσωπικού στο αρχικό τους νόμισμα πριν κλείσετε αυτή τη βάρδια ταμείου.',
    )).toBeInTheDocument();
    expect(screen.queryByText('Η βάρδια δεν έκλεισε. Ενημερώστε τον υπεύθυνο.')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SHIFT_CURRENCY_SETTLEMENT_REQUIRED');
    expect(bridge.shifts.close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'a refusal without blockers',
      respond: () => bridge.reports.resolvePaymentBlocker.mockResolvedValueOnce({
        success: false, errorCode: 'UNSETTLED_PAYMENT_BLOCKER', error: 'raw record refusal',
      }),
      expected: 'Η πληρωμή δεν καταγράφηκε. Πατήστε ξανά «Καταγραφή πληρωμής μετρητών».',
      raw: 'raw record refusal',
    },
    {
      name: 'an expired sign-in after PIN approval',
      respond: () => {
        bridge.auth.confirmPrivilegedAction.mockResolvedValue({ success: true });
        bridge.reports.resolvePaymentBlocker
          .mockRejectedValueOnce({ code: 'REAUTH_REQUIRED', reason: 'Fresh PIN confirmation required' })
          .mockRejectedValueOnce({ code: 'AUTH_SESSION_EXPIRED', reason: 'raw expired session' });
      },
      approval: true,
      expected: 'Η σύνδεση του ταμείου έληξε. Πληκτρολογήστε ξανά το PIN του ταμείου.',
      raw: 'raw expired session',
    },
    {
      name: 'a missing store currency',
      respond: () => bridge.reports.resolvePaymentBlocker.mockRejectedValueOnce('STORE_CURRENCY_UNAVAILABLE'),
      expected: 'Η πληρωμή δεν καταγράφηκε. Ζητήστε από τον υπεύθυνο να ελέγξει τη χώρα του καταστήματος.',
      raw: 'STORE_CURRENCY_UNAVAILABLE',
    },
    {
      name: 'a stale refusal without blockers',
      respond: () => bridge.reports.resolvePaymentBlocker.mockResolvedValueOnce({
        success: false, errorCode: 'UNSETTLED_PAYMENT_BLOCKER', blockers: [],
        error: 'This order no longer has a payment blocker. Refresh the payment blockers and try again.',
      }),
      expected: 'Η πληρωμή δεν καταγράφηκε. Πατήστε ξανά «Λήξη».',
      raw: 'This order no longer has a payment blocker',
    },
    ...[
      'This order no longer has a collectible outstanding balance.',
      'The outstanding balance changed since it was confirmed.',
    ].map(reason => ({
      name: `${reason} (with the same blocker)`,
      respond: () => bridge.reports.resolvePaymentBlocker.mockResolvedValueOnce({
        success: false, errorCode: 'UNSETTLED_PAYMENT_BLOCKER', blockers: [recordableBlocker],
        error: `${reason} Refresh the payment blockers and try again.`,
      }),
      expected: 'Η πληρωμή δεν καταγράφηκε. Πατήστε ξανά «Λήξη».',
      raw: reason,
    })),
    {
      name: 'an unknown failure',
      respond: () => bridge.reports.resolvePaymentBlocker.mockRejectedValueOnce(new Error('SQLITE_BUSY: raw write error')),
      expected: 'Η πληρωμή δεν καταγράφηκε. Πατήστε ξανά «Καταγραφή πληρωμής μετρητών».',
      raw: 'SQLITE_BUSY',
    },
  ])('shows Greek record feedback for $name', async ({ respond, expected, raw, approval }) => {
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: 'el',
      resources: { el: { translation: localeBundles.el } },
      interpolation: { escapeValue: false },
    });
    const t = i18n.getFixedT('el');
    fixture.localizedT = t;
    bridge.shifts.getSummary.mockResolvedValue({
      success: true, data: { ...summary(0), currency: 'EUR' },
    });
    bridge.shifts.close.mockResolvedValueOnce({
      success: false, errorCode: 'UNSETTLED_PAYMENT_BLOCKER', error: 'Close held',
      blockers: [recordableBlocker],
    });
    respond();
    render(<StaffShiftModal {...props} />);

    const close = await screen.findByTestId('staff-checkout-confirm-button');
    await waitFor(() => expect(close).toBeEnabled());
    fireEvent.click(close);
    const zero = await screen.findByRole('dialog', { name: t('modals.staffShift.confirmZeroTitle') });
    fireEvent.click(within(zero).getByRole('button', { name: t('common.actions.confirm') }));
    fireEvent.click(await screen.findByRole('button', { name: /Καταγραφή πληρωμής μετρητών/ }));
    fireEvent.click(screen.getByRole('button', { name: t('modals.zReport.recordConfirmAction') }));
    if (approval) {
      const pin = await screen.findByRole('dialog', { name: t('modals.zReport.recordApprovalTitle') });
      for (const digit of '123456') fireEvent.click(within(pin).getByRole('button', { name: digit }));
      fireEvent.click(within(pin).getByRole('button', { name: t('common.actions.confirm') }));
    }

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(raw);
    expect(bridge.reports.resolvePaymentBlocker).toHaveBeenCalledTimes(approval ? 2 : 1);
  });

  it('shows net collections with real tenders and tips, preserving expected cash', async () => {
    bridge.shifts.getSummary.mockResolvedValue({ success: true, data: {
      ...summary(100), currency: 'EUR',
      cashierCash: { cashCollections: 40, cashRefunds: 10, currency: 'EUR' },
      netCollections: { version: 1, total: 95, totalCents: 9500, refunded: 10, refundedCents: 1000,
        tips: 5, tipsCents: 500, tenders: [
          { tender: 'cash', kept: 35, keptCents: 3500 },
          { tender: 'twint', kept: 60, keptCents: 6000 },
        ] },
    } });
    render(<StaffShiftModal {...props} />);
    await screen.findByTestId('staff-checkout-confirm-button');
    const collections = await screen.findByTestId('shift-net-collections');
    expect(collections).toHaveTextContent('Net collections');
    expect(collections).toHaveTextContent(/95[,.]00/);
    expect(collections).toHaveTextContent('TWINT');
    expect(collections).toHaveTextContent('of which tips');
    for (const label of screen.getAllByText('Expected In Drawer')) {
      expect(label.parentElement).toHaveTextContent(/30[,.]00/);
    }
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

  it.each([false, true])('keeps inherited float out of expected cash (returned: %s)', async (returned) => {
    fixture.activeShift = shift({ currency: 'EUR', opening_cash_amount: 80 });
    bridge.shifts.getSummary.mockResolvedValue({ success: true, data: {
      ...summary(0), currency: 'EUR', shift: fixture.activeShift,
      cashDrawer: { driver_cash_given: 0, driver_cash_returned: returned ? 20 : 0 },
      driverDeliveries: [{ shift_id: 'inherited-driver', driver_id: 'driver-1', starting_amount: 20 }],
      transferredDrivers: returned ? [] : [{ shift_id: 'inherited-driver', driver_id: 'driver-1', starting_amount: 20, net_cash_amount: 20 }],
    } });
    render(<StaffShiftModal {...props} />);
    await screen.findByTestId('staff-checkout-confirm-button');
    const expected = returned ? /100[,.]00/ : /80[,.]00/;
    await waitFor(() => {
      for (const label of screen.getAllByText('Expected In Drawer')) {
        expect(label.parentElement).toHaveTextContent(expected);
      }
    });
    expect(bridge.shifts.close).not.toHaveBeenCalled();
  });

  it('holds Main close while a self-closed waiter till still awaits receipt', async () => {
    bridge.shifts.getSummary.mockResolvedValue({success:true,data:{...summary(0),currency:'EUR',cashierCash:{cashCollections:0,cashRefunds:0,currency:'EUR'}}});
    bridge.shifts.pendingCashReturns.mockResolvedValue({success:true,requires_receipt_check:true,active_waiter_count:0,returns:[{
      id:'waiter-close',staff_id:'waiter',staff_name:'Luca',terminal_id:'phone',currency:'EUR',
      closing_cash_amount:10.5,expected_cash_amount:10.5,receiving_cashier_shift_id:SHIFT_ID,
    }]});
    render(<StaffShiftModal {...props} />);
    const button=await screen.findByTestId('staff-checkout-confirm-button');
    await waitFor(()=>expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByText('modals.staffShift.satelliteCheckout.receiveBeforeClose');
    expect(bridge.shifts.pendingCashReturns).toHaveBeenCalledTimes(2);
    expect(bridge.shifts.close).not.toHaveBeenCalled();
  });

  it('does not mistake an offline pending-return check for zero cash', async () => {
    bridge.shifts.getSummary.mockResolvedValue({success:true,data:{...summary(0),currency:'EUR',cashierCash:{cashCollections:0,cashRefunds:0,currency:'EUR'}}});
    bridge.shifts.pendingCashReturns.mockRejectedValue(new Error('offline'));
    render(<StaffShiftModal {...props} />);
    const button=await screen.findByTestId('staff-checkout-confirm-button');
    await waitFor(()=>expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByText('modals.staffShift.satelliteCheckout.pendingReadFailed');
    expect(bridge.shifts.close).not.toHaveBeenCalled();
  });
  it('holds Main close while an active phone waiter can still collect cash', async () => {
    bridge.shifts.getSummary.mockResolvedValue({success:true,data:{...summary(0),currency:'EUR',cashierCash:{cashCollections:0,cashRefunds:0,currency:'EUR'}}});
    bridge.shifts.pendingCashReturns.mockResolvedValue({success:true,requires_receipt_check:true,active_waiter_count:1,returns:[]});
    render(<StaffShiftModal {...props} />);
    const button=await screen.findByTestId('staff-checkout-confirm-button');
    await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);
    await screen.findByText('modals.staffShift.satelliteCheckout.receiveBeforeClose');
    expect(bridge.shifts.close).not.toHaveBeenCalled();
  });

  it('drops a held cash-return check when the cashier actor changes', async () => {
    bridge.shifts.getSummary.mockResolvedValue({success:true,data:{...summary(0),currency:'EUR',cashierCash:{cashCollections:0,cashRefunds:0,currency:'EUR'}}});
    const clear = {success:true,requires_receipt_check:true,active_waiter_count:0,returns:[]};
    bridge.shifts.pendingCashReturns.mockResolvedValue(clear);
    const view = render(<StaffShiftModal {...props} />);
    const button = await screen.findByTestId('staff-checkout-confirm-button');
    await waitFor(() => expect(button).toBeEnabled());
    const held = deferred();
    bridge.shifts.pendingCashReturns.mockImplementationOnce(() => held.promise);
    fireEvent.click(button);
    await waitFor(() => expect(bridge.shifts.pendingCashReturns).toHaveBeenCalledTimes(2));
    fixture.sessionStaff = {...fixture.sessionStaff, staffId: OTHER_STAFF_ID};
    view.rerender(<StaffShiftModal {...props} />);
    await act(async () => {held.resolve(clear); await held.promise;});
    expect(screen.queryByRole('dialog', {name: 'Confirm Zero Closing Cash'})).toBeNull();
    expect(bridge.shifts.close).not.toHaveBeenCalled();
  });
});
