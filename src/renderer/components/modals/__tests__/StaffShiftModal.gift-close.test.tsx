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
async function recoveryState(state: string) {
  await waitFor(() => expect(screen.getByTestId('gift-close-recovery')).toHaveAttribute('data-state', state));
}

describe('StaffShiftModal gift-bound close', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    fixture.scope.organizationId = '10000000-0000-4000-8000-000000000001';
    fixture.scope.branchId = '20000000-0000-4000-8000-000000000001'; fixture.scope.terminalId = 'register-public-01';
    fixture.sessionStaff = { staffId: '70000000-0000-4000-8000-000000000001', ...fixture.scope };
    fixture.activeShift = shift();
    fixture.getStatus.mockResolvedValue(capability());
    bridge = makeBridge();
    fixture.bridge = bridge;
    setBridge(bridge);
    __resetForTesting();
    await setSecureSession({ ...fixture.scope, staffId: fixture.sessionStaff.staffId, sessionId: 'main-login-session' });
  });
  afterEach(() => {
    cleanup();
    __resetForTesting(); resetBridge(); localStorage.clear();
  });

  it('shows 12345 + 2000 = 14345 once, counts 14000 as -345, closes the exact approval and keeps the original pending across remount', async () => {
    const view = await renderReady();
    expect(cents('gift-close-ordinary')).toBe('12345');
    expect(cents('gift-close-gift-cash')).toBe('2000');
    expect(cents('gift-close-expected')).toBe('14345');
    expect(screen.getAllByTestId('gift-close-expected')).toHaveLength(1);
    expect(screen.getByTestId('gift-close-expected')).toHaveTextContent('CHF');
    expect(bridge.giftFunding.refreshDrawer).toHaveBeenCalledWith({ staffId: fixture.staffId });
    count('14000');
    expect(screen.getByTestId('gift-close-count')).toHaveValue('140,00');
    expect(cents('gift-close-variance')).toBe('-345');
    fireEvent.click(screen.getByTestId('staff-checkout-confirm-button'));
    const approval = await screen.findByTestId('gift-close-approval');
    expect(within(approval).queryByText(/CHF/)).toBeNull();
    expect(bridge.shifts.close).not.toHaveBeenCalled();
    fireEvent.click(within(approval).getByTestId('gift-close-approve'));

    await recoveryState('pending');
    expect(bridge.shifts.close).toHaveBeenCalledTimes(1);
    expect(bridge.shifts.close.mock.calls[0][0]).toEqual(expect.objectContaining({
      shiftId: SHIFT_ID,
      closingCash: 140,
      giftClosing: { countedCents: 14000, approvedOrdinaryExpectedCents: 12345,
        drawer: { version: 3, acknowledgementId: 'ack-1', giftCashCents: 2000, ordinaryExpectedCents: 12345, expectedCents: 14345 } },
    }));
    expect(screen.getByTestId('gift-close-recovery')).toHaveAttribute('data-closing-key', CLOSING_KEY);
    expect(cents('gift-close-retained-count')).toBe('14000');
    expect(cents('gift-close-preview-variance')).toBe('-345');
    expect(screen.queryByTestId('gift-close-print')).toBeNull();
    expect(screen.getByTestId('staff-checkout-confirm-button')).toBeDisabled();
    expect(bridge.shifts.printCheckout).not.toHaveBeenCalled();
    expect(fixture.onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('SECRET-BODY');

    bridge.shiftFinancialClosing.listPending.mockResolvedValue({ success: true, closings: [closing()], truncated: false });
    view.rerender(<StaffShiftModal {...props} isOpen={false} />);
    view.rerender(<StaffShiftModal {...props} />);
    await recoveryState('pending');
    expect(screen.getByTestId('gift-close-recovery')).toHaveAttribute('data-closing-key', CLOSING_KEY);
    fireEvent.click(screen.getByTestId('gift-close-retry'));
    await waitFor(() => expect(screen.getByTestId('gift-close-notice')).toHaveAttribute('data-tone', 'info'));
    expect(bridge.shiftFinancialClosing.retry).toHaveBeenCalledWith({ closingKey: CLOSING_KEY, staffId: fixture.staffId });
    expect(bridge.shifts.close).toHaveBeenCalledTimes(1);
    expect(bridge.shifts.printCheckout).not.toHaveBeenCalled();
  });

  it('rejects changed ordinary terms, refreshes the preview and requires a renewed count and approval', async () => {
    bridge.shifts.close.mockResolvedValueOnce({ success: false, code: 'GIFT_CLOSING_TERMS_CHANGED', error: 'GIFT_CLOSING_TERMS_CHANGED: changed' });
    await renderReady();
    count('14000');
    bridge.shifts.getSummary.mockResolvedValue({ success: true, data: summary(130) });
    await approve();
    await waitFor(() => expect(cents('gift-close-ordinary')).toBe('13000'));
    expect(cents('gift-close-expected')).toBe('15000');
    expect(screen.getByText('The close terms changed. Review the refreshed terms, count again and approve again.')).toBeInTheDocument();
    expect(screen.getByTestId('gift-close-count')).toHaveValue('');
    expect(screen.queryByTestId('gift-close-approval')).toBeNull();
    count('15000');
    expect(cents('gift-close-variance')).toBe('0');
    await approve();
    await recoveryState('pending');
    expect(bridge.shifts.close).toHaveBeenCalledTimes(2);
    expect(bridge.shifts.close.mock.calls[0][0].giftClosing).toMatchObject({ countedCents: 14000, approvedOrdinaryExpectedCents: 12345 });
    expect(bridge.shifts.close.mock.calls[1][0].giftClosing).toMatchObject({ countedCents: 15000, approvedOrdinaryExpectedCents: 13000 });
  });

  it('renews only the original authorization, clears the PIN, retries the exact original and prints once on canonical terms that differ', async () => {
    let reads = 0;
    bridge.shiftFinancialClosing.status.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? { success: true, closing: closing({ authorizationRequired: true, code: 'HOSTED_REAUTH_REQUIRED' }) }
        : { success: true, closing: closing({ state: 'confirmed', code: null, localPreview: null, canonical: canonicalTerms }) };
    });
    await renderReady();
    count('14000');
    await approve();
    const pin = await screen.findByTestId('gift-close-pin');
    expect(screen.getByTestId('gift-close-authorize')).toBeDisabled();
    fireEvent.change(pin, { target: { value: '4321' } });
    fireEvent.click(screen.getByTestId('gift-close-authorize'));
    expect(pin).toHaveValue('');

    await recoveryState('confirmed');
    expect(bridge.shiftFinancialClosing.authorize).toHaveBeenCalledWith({ closingKey: CLOSING_KEY, pin: '4321' });
    expect(bridge.shiftFinancialClosing.retry).toHaveBeenCalledWith({ closingKey: CLOSING_KEY, staffId: fixture.staffId });
    expect(screen.getByTestId('gift-close-canonical-differs')).toBeInTheDocument();
    expect(cents('gift-close-canonical-ordinary')).toBe('12000');
    expect(cents('gift-close-canonical-counted')).toBe('14000');
    expect(cents('gift-close-canonical-variance')).toBe('0');
    await waitFor(() => expect(screen.getByTestId('gift-close-print-state')).toHaveAttribute('data-print', 'queued'));
    expect(bridge.shifts.printCheckout).toHaveBeenCalledTimes(1);
    expect(bridge.shifts.printCheckout).toHaveBeenCalledWith({ shiftId: SHIFT_ID, roleType: 'cashier', terminalName: 'Till 1' });
    expect(document.body.innerHTML).not.toContain('4321');
    expect(document.body.textContent).not.toContain('SECRET-BODY');
    fireEvent.click(screen.getByTestId('gift-close-done'));
    expect(fixture.onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks instead of implying zero when attempts, the projection or the ordinary summary cannot be read', async () => {
    bridge.giftFunding.closeBlocker.mockResolvedValueOnce({ success: true, blocked: true, shiftId: SHIFT_ID, unresolved: [{ id: 'a' }, { id: 'b' }] });
    render(<StaffShiftModal {...props} />);
    expect(await screen.findByTestId('gift-close-blocked')).toHaveAttribute('data-code', 'GIFT_FUNDING_UNRESOLVED');
    bridge.giftFunding.refreshDrawer.mockResolvedValueOnce({ success: false, code: 'GIFT_FUNDING_DRAWER_UNAVAILABLE', error: 'unavailable' });
    fireEvent.click(screen.getByTestId('gift-close-refresh'));
    await waitFor(() => expect(screen.getByTestId('gift-close-blocked')).toHaveAttribute('data-code', 'GIFT_CLOSING_DRAWER_UNAVAILABLE'));
    bridge.shifts.getSummary.mockResolvedValueOnce({ success: false, error: 'summary failed' });
    fireEvent.click(screen.getByTestId('gift-close-refresh'));
    await waitFor(() => expect(screen.getByTestId('gift-close-blocked')).toHaveAttribute('data-code', 'ORDINARY_SUMMARY_UNAVAILABLE'));
    expect(screen.queryByTestId('gift-close-expected')).toBeNull();
    expect(screen.queryByTestId('gift-close-count')).toBeNull();
    expect(screen.getByTestId('staff-checkout-confirm-button')).toBeDisabled();
    expect(bridge.shifts.close).not.toHaveBeenCalled();
  });

  it('drops a held close reply after the modal closes and reopens', async () => {
    const held = deferred();
    bridge.shifts.close.mockImplementationOnce(() => held.promise);
    const view = await renderReady();
    count('14000');
    await approve();
    await waitFor(() => expect(bridge.shifts.close).toHaveBeenCalledTimes(1));
    view.rerender(<StaffShiftModal {...props} isOpen={false} />);
    view.rerender(<StaffShiftModal {...props} />);
    await screen.findByTestId('gift-close-ordinary');
    await act(async () => { held.resolve(pendingCloseResult()); await held.promise; });
    expect(screen.queryByTestId('gift-close-recovery')).toBeNull();
    expect(fixture.refreshActiveShift).not.toHaveBeenCalled();
    expect(screen.queryByTestId('gift-close-approval')).toBeNull();
  });

  it('drops held gift discovery after an actor switch', async () => {
    const held = deferred();
    bridge.giftFunding.refreshDrawer.mockImplementationOnce(() => held.promise);
    const view = render(<StaffShiftModal {...props} />);
    await waitFor(() => expect(bridge.giftFunding.refreshDrawer).toHaveBeenCalledTimes(1));
    // A different logged-in actor, with the same original checkout target still displayed.
    fixture.sessionStaff = { ...fixture.sessionStaff, staffId: OTHER_STAFF_ID };
    bridge.giftFunding.refreshDrawer.mockResolvedValue({ success: true,
      drawer: drawer({ giftCashCents: 3000, expectedCents: 15345 }) });
    view.rerender(<StaffShiftModal {...props} />);
    await waitFor(() => expect(cents('gift-close-expected')).toBe('15345'));
    await act(async () => { held.resolve({ success: true, drawer: drawer() }); await held.promise; });
    expect(cents('gift-close-expected')).toBe('15345');
    expect(bridge.giftFunding.refreshDrawer).toHaveBeenCalledTimes(2);
  });

  it.each(['close-intent', 'actor'] as const)('drops a held close on %s while the same shift and open prop remain', async change => {
    const held = deferred();
    bridge.shifts.close.mockImplementationOnce(() => held.promise);
    const view = await renderReady();
    count('14000');
    await approve();
    await waitFor(() => expect(bridge.shifts.close).toHaveBeenCalledTimes(1));
    if (change === 'actor') {
      fixture.sessionStaff = { ...fixture.sessionStaff, staffId: OTHER_STAFF_ID };
      view.rerender(<StaffShiftModal {...props} />);
      await screen.findByTestId('gift-close-ordinary');
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss modal' }));
      expect(fixture.onClose).toHaveBeenCalledTimes(1);
    }
    await act(async () => { held.resolve(pendingCloseResult()); await held.promise; });
    expect(screen.queryByTestId('gift-close-recovery')).toBeNull();
    expect(fixture.refreshActiveShift).not.toHaveBeenCalled();
    expect(bridge.shifts.printCheckout).not.toHaveBeenCalled();
  });

  it.each(['close-intent', 'actor', 'done'] as const)('does not enqueue a confirmed print after %s during terminal lookup', async change => {
    const view = await renderReady();
    count('14000');
    await approve();
    await recoveryState('pending');
    const heldName = deferred<string>();
    bridge.terminalConfig.getSetting.mockImplementation(async (_category: string, key: string) => key === 'name' ? heldName.promise : null);
    bridge.shiftFinancialClosing.status.mockResolvedValue({ success: true,
      closing: closing({ state: 'confirmed', code: null, localPreview: null, canonical: canonicalTerms }) });
    fireEvent.click(screen.getByTestId('gift-close-status'));
    await waitFor(() => expect(bridge.terminalConfig.getSetting).toHaveBeenCalledWith('terminal', 'name'));
    if (change === 'actor') {
      fixture.sessionStaff = { ...fixture.sessionStaff, staffId: OTHER_STAFF_ID };
      view.rerender(<StaffShiftModal {...props} />);
    } else if (change === 'done') {
      fireEvent.click(screen.getByTestId('gift-close-done'));
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss modal' }));
    }
    await act(async () => { heldName.resolve('Old terminal'); await heldName.promise; });
    expect(bridge.shifts.printCheckout).not.toHaveBeenCalled();
  });

  it('reaches the selected cashier original from ordinary check-in by explicit selection', async () => {
    fixture.activeShift = null;
    bridge.shiftFinancialClosing.listPending.mockImplementation(async ({ staffId }: { staffId: string }) => ({
      success: true, closings: staffId === fixture.staffId ? [closing()] : [], truncated: false }));
    render(<StaffShiftModal {...props} mode="checkin" />);
    fireEvent.click(await screen.findByRole('button', { name: /Cashier Alice/ }));
    const open = await screen.findByTestId('gift-close-pending-open');
    expect(open).toHaveAttribute('data-closing-key', CLOSING_KEY);
    expect(bridge.shiftFinancialClosing.listPending).toHaveBeenCalledWith({ staffId: fixture.staffId });
    fireEvent.click(open);
    await recoveryState('pending');
    expect(bridge.shiftFinancialClosing.status).toHaveBeenCalledWith({ closingKey: CLOSING_KEY, staffId: fixture.staffId });
    expect(screen.queryByTestId('staff-pin-section')).toBeNull();
    fireEvent.click(screen.getByTestId('gift-close-done'));
    expect(await screen.findByTestId('staff-pin-section')).toBeInTheDocument();
    expect(bridge.shifts.close).not.toHaveBeenCalled();
    expect(fixture.onClose).not.toHaveBeenCalled();
  });

  it('drops a held pending list after a terminal switch', async () => {
    fixture.activeShift = null;
    const held = deferred();
    bridge.shiftFinancialClosing.listPending.mockImplementationOnce(() => held.promise);
    const view = render(<StaffShiftModal {...props} mode="checkin" />);
    fireEvent.click(await screen.findByRole('button', { name: /Cashier Alice/ }));
    await waitFor(() => expect(bridge.shiftFinancialClosing.listPending).toHaveBeenCalledTimes(1));
    fixture.scope.terminalId = 'other-terminal';
    view.rerender(<StaffShiftModal {...props} mode="checkin" />);
    await act(async () => { held.resolve({ success: true, closings: [closing()], truncated: false }); await held.promise; });
    expect(screen.queryByTestId('gift-close-pending-list')).toBeNull();
    expect(screen.queryByTestId('gift-close-pending-open')).toBeNull();
  });

  it('keeps ordinary cashier and driver checkout free of the gift close', async () => {
    bridge.shiftFinancialOpening.status.mockResolvedValue({ success: true, openings: [] });
    bridge.shifts.close.mockResolvedValue({ success: true, variance: 0 });
    const view = render(<StaffShiftModal {...props} />);
    const [label] = await screen.findAllByText('modals.staffShift.closingCashLabel');
    expect(screen.queryByTestId('gift-close-checkout')).toBeNull();
    fireEvent.change(label.parentElement!.querySelector('input')!, { target: { value: '12345' } });
    fireEvent.click(screen.getByTestId('staff-checkout-confirm-button'));
    await waitFor(() => expect(bridge.shifts.close).toHaveBeenCalledTimes(1));
    expect(bridge.shifts.close.mock.calls[0][0]).not.toHaveProperty('giftClosing');
    expect(bridge.shiftFinancialClosing.listPending).not.toHaveBeenCalled();
    view.unmount();

    fixture.activeShift = shift({ id: OTHER_SHIFT_ID, role_type: 'driver' });
    render(<StaffShiftModal {...props} />);
    await screen.findByTestId('staff-checkout-confirm-button');
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('gift-close-checkout')).toBeNull();
    expect(bridge.shiftFinancialClosing.listPending).not.toHaveBeenCalled();
    expect(bridge.giftFunding.refreshDrawer).not.toHaveBeenCalled();
  });
});
