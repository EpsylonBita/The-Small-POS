import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShiftFinancialOpeningView } from '../../../../lib/ipc-contracts';

const fixture = vi.hoisted(() => ({
  scope: { organizationId: '10000000-0000-4000-8000-000000000001', branchId: '20000000-0000-4000-8000-000000000001', terminalId: 'register-public-01' },
  staffId: '30000000-0000-4000-8000-000000000001',
  sessionStaff: {} as any,
  getStatus: vi.fn(), setStaff: vi.fn(), setActiveShiftImmediate: vi.fn(), refreshActiveShift: vi.fn(), onClose: vi.fn(),
  t: (key: string, fallback?: string | { defaultValue?: string }) => typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key,
  bridge: {
    terminalConfig: { getTerminalId: vi.fn(), getBranchId: vi.fn(), getOrganizationId: vi.fn() },
    settings: { get: vi.fn(), updateLocal: vi.fn() },
    staffAuth: { refreshDirectory: vi.fn(), verifyCheckInPin: vi.fn() }, staffSchedule: { list: vi.fn() },
    shifts: { getActive: vi.fn(), getActiveForBranch: vi.fn(), getCheckInEligibility: vi.fn(), getActiveCashierByTerminal: vi.fn(), open: vi.fn(), getById: vi.fn() },
    shiftFinancialOpening: { begin: vi.fn(), status: vi.fn(), authorize: vi.fn(), clearAuthorization: vi.fn() },
    secureSession: { set: vi.fn(), clear: vi.fn() },
  },
}));
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: fixture.t }) }));
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: fixture.t }) }));
vi.mock('../../../contexts/shift-context', () => ({ useShift: () => ({ staff: fixture.sessionStaff, activeShift: null, isShiftActive: false,
  setStaff: fixture.setStaff, setActiveShiftImmediate: fixture.setActiveShiftImmediate, refreshActiveShift: fixture.refreshActiveShift }) }));
vi.mock('../../../hooks/useTerminalSettings', () => {
  const useTerminalSettings = () => ({ settings: {}, loading: false, error: null, refresh: vi.fn(),
    getSetting: (_category: string, key: string) => ({ organization_id: fixture.scope.organizationId, branch_id: fixture.scope.branchId, terminal_id: fixture.scope.terminalId })[key] });
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
import { parseOpeningCents } from '../../../lib/financial-opening';
import { getSecureSessionSync, setSecureSession, __resetForTesting } from '../../../lib/secure-session-cache';
import { setBridge, resetBridge } from '../../../../lib/ipc-adapter';

const bridge = fixture.bridge;
const props = { isOpen: true, onClose: fixture.onClose, mode: 'checkin' as const };
const role = { role_id: 'cashier-role', role_name: 'cashier', role_display_name: 'Cashier', is_primary: true };
const member = (id = fixture.staffId, name = 'Cashier Alice') => ({ id, name, first_name: name, last_name: '', role_name: 'cashier', roles: [role], can_login_pos: true, has_pin: true, is_active: true });
const capability = (currency: string | null = 'CHF') => ({ ok: true, data: { enabled: true, moduleEnabled: true, terminalEnabled: true, configured: true, unavailable: false, currency } });
function opening(patch: Partial<ShiftFinancialOpeningView> = {}): ShiftFinancialOpeningView {
  return { openingKey: '40000000-0000-4000-8000-000000000001', shiftId: '50000000-0000-4000-8000-000000000001',
    drawerId: '60000000-0000-4000-8000-000000000001', staffId: fixture.staffId, ...fixture.scope,
    openingCents: 1250, currency: 'CHF', businessDate: '2026-09-29', checkedInAt: '2026-09-29T08:10:11.000Z',
    isDayStart: true, calculationVersion: 2, state: 'pending', usable: false,
    hostedAuthorization: { state: 'authorized', expiresAt: '2026-09-29T16:10:11.000Z' }, lastPendingCode: null, drawer: null, ...patch };
}
function shift(original: ShiftFinancialOpeningView) {
  return { id: original.shiftId, staff_id: original.staffId, staff_name: 'Cashier Alice', branch_id: original.branchId,
    terminal_id: original.terminalId, role_type: 'cashier', check_in_time: original.checkedInAt, opening_cash_amount: original.openingCents / 100,
    status: 'active', total_orders_count: 0, total_sales_amount: 0, total_cash_sales: 0, total_card_sales: 0,
    created_at: original.checkedInAt, updated_at: original.checkedInAt };
}
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
let nativeOriginal: ShiftFinancialOpeningView | undefined;
let mainSession: Record<string, string>;
async function enterCash(name = 'Cashier Alice') {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }));
  const digit = await screen.findByRole('button', { name: '1', exact: true });
  for (let count = 0; count < 4; count += 1) fireEvent.click(digit);
  fireEvent.click(screen.getByRole('button', { name: 'modals.staffShift.continue' }));
  fireEvent.click(await screen.findByRole('button', { name: /cashier.*modals.staffShift.cashierRoleHelper/i }));
  await screen.findByTestId('staff-cash-section');
  await waitFor(() => expect(screen.queryByText('modals.staffShift.financialOpeningChecking')).toBeNull());
}
function cash(value = '1250') {
  const input = within(screen.getByTestId('staff-cash-section')).getByRole('textbox');
  fireEvent.change(input, { target: { value } });
  return input;
}
function submit() { fireEvent.click(screen.getByRole('button', { name: 'modals.staffShift.startShift' })); }
function resume() { fireEvent.click(screen.getByRole('button', { name: 'modals.staffShift.financialOpeningResume' })); }
function unpublished() {
  expect(bridge.shifts.open).not.toHaveBeenCalled();
  expect(fixture.setStaff).not.toHaveBeenCalled();
  expect(fixture.setActiveShiftImmediate).not.toHaveBeenCalled();
  expect(fixture.refreshActiveShift).not.toHaveBeenCalled();
}

describe('StaffShiftModal native financial opening', () => {
  beforeEach(async () => {
    vi.resetAllMocks(); nativeOriginal = undefined;
    fixture.scope.organizationId = '10000000-0000-4000-8000-000000000001';
    fixture.scope.branchId = '20000000-0000-4000-8000-000000000001'; fixture.scope.terminalId = 'register-public-01';
    fixture.sessionStaff = { staffId: '70000000-0000-4000-8000-000000000001', ...fixture.scope };
    mainSession = { ...fixture.scope, staffId: fixture.sessionStaff.staffId, sessionId: 'main-login-session' };
    setBridge(bridge as any);
    __resetForTesting();
    await setSecureSession(mainSession);
    bridge.secureSession.set.mockClear();
    bridge.terminalConfig.getOrganizationId.mockImplementation(async () => fixture.scope.organizationId);
    bridge.terminalConfig.getBranchId.mockImplementation(async () => fixture.scope.branchId);
    bridge.terminalConfig.getTerminalId.mockImplementation(async () => fixture.scope.terminalId);
    const members = [member(), member('30000000-0000-4000-8000-000000000002', 'Cashier Bob')];
    bridge.settings.get.mockResolvedValue(JSON.stringify({ branch_id: fixture.scope.branchId, staff: members }));
    bridge.settings.updateLocal.mockResolvedValue({ success: true });
    bridge.staffSchedule.list.mockResolvedValue({ success: true, data: { staff: members } });
    bridge.staffAuth.refreshDirectory.mockResolvedValue({ success: true, currentTerminalId: fixture.scope.terminalId, staff: [] });
    bridge.staffAuth.verifyCheckInPin.mockResolvedValue({ success: true });
    bridge.shifts.getActive.mockResolvedValue(null); bridge.shifts.getActiveForBranch.mockResolvedValue([]);
    bridge.shifts.getCheckInEligibility.mockResolvedValue({ requiresCashierFirst: false });
    bridge.shifts.getActiveCashierByTerminal.mockResolvedValue({ id: 'ordinary-cashier' });
    fixture.getStatus.mockResolvedValue(capability());
    bridge.shiftFinancialOpening.status.mockImplementation(async () => ({ success: true, openings: nativeOriginal ? [nativeOriginal] : [] }));
    bridge.shiftFinancialOpening.begin.mockImplementation(async (input) => {
      nativeOriginal = opening({ openingKey: input.openingKey, openingCents: input.openingCents, currency: input.currency });
      return { success: true, opening: nativeOriginal };
    });
    bridge.shiftFinancialOpening.authorize.mockImplementation(async () => {
      nativeOriginal = { ...nativeOriginal!, hostedAuthorization: { state: 'authorized', expiresAt: null } };
      return { success: true, opening: nativeOriginal };
    });
    bridge.shiftFinancialOpening.clearAuthorization.mockImplementation(async () => {
      if (nativeOriginal) nativeOriginal = { ...nativeOriginal, hostedAuthorization: { state: 'required', expiresAt: null } };
      return { success: true };
    });
    bridge.shifts.getById.mockImplementation(async () => nativeOriginal ? { success: true, data: shift(nativeOriginal) } : null);
  });
  afterEach(() => {
    cleanup();
    expect(getSecureSessionSync()).toEqual(mainSession);
    expect(bridge.secureSession.set).not.toHaveBeenCalled();
    expect(bridge.secureSession.clear).not.toHaveBeenCalled();
    __resetForTesting(); resetBridge(); localStorage.clear();
  });

  it('captures displayed 12,50 as exact cents with explicit ISO, issues once, and never publishes pending', async () => {
    render(<StaffShiftModal {...props} />); await enterCash();
    expect(screen.getByTestId('financial-opening-currency')).toHaveTextContent('CHF');
    expect(cash()).toHaveValue('12,50');
    const start = screen.getByRole('button', { name: 'modals.staffShift.startShift' });
    fireEvent.click(start); fireEvent.click(start);
    await waitFor(() => expect(bridge.shiftFinancialOpening.begin).toHaveBeenCalledTimes(1));
    expect(bridge.shiftFinancialOpening.begin).toHaveBeenCalledWith(expect.objectContaining({ staffId: fixture.staffId, openingCents: 1250, currency: 'CHF', pin: '1111' }));
    await screen.findByRole('button', { name: 'modals.staffShift.financialOpeningResume' });
    unpublished(); expect(fixture.onClose).not.toHaveBeenCalled();
  });

  it('publishes only the matching actual usable confirmed row and does not clear successful authorization', async () => {
    bridge.shiftFinancialOpening.begin.mockImplementation(async (input) => {
      nativeOriginal = opening({ openingKey: input.openingKey, state: 'confirmed_usable', usable: true });
      return { success: true, opening: nativeOriginal };
    });
    const view = render(<StaffShiftModal {...props} />); await enterCash(); cash(); submit();
    await waitFor(() => expect(fixture.onClose).toHaveBeenCalledTimes(1));
    expect(bridge.shifts.getById).toHaveBeenCalledWith(nativeOriginal!.shiftId);
    expect(fixture.setActiveShiftImmediate).toHaveBeenCalledExactlyOnceWith(shift(nativeOriginal!));
    expect(fixture.setStaff).toHaveBeenCalledWith(expect.objectContaining({ ...fixture.scope, staffId: fixture.staffId, role: 'cashier' }));
    expect(bridge.shifts.open).not.toHaveBeenCalled(); expect(fixture.refreshActiveShift).not.toHaveBeenCalled();
    expect(getSecureSessionSync()).toEqual(mainSession);
    view.rerender(<StaffShiftModal {...props} isOpen={false} />);
    expect(bridge.shiftFinancialOpening.clearAuthorization).not.toHaveBeenCalled();
  });

  it('requires explicit zero confirmation and sends exact zero', async () => {
    render(<StaffShiftModal {...props} />); await enterCash(); cash('0'); submit();
    await screen.findByText('modals.staffShift.zeroCashConfirmTitle'); expect(bridge.shiftFinancialOpening.begin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'modals.staffShift.confirmZeroCash' }));
    await waitFor(() => expect(bridge.shiftFinancialOpening.begin).toHaveBeenCalledWith(expect.objectContaining({ openingCents: 0, currency: 'CHF' })));
    unpublished();
  });

  it.each(['', '12,', '-1250', '12abc', '100000000'])('refuses invalid displayed opening %j without ordinary fallback', async (input) => {
    render(<StaffShiftModal {...props} />); await enterCash(); cash(input); submit();
    await screen.findByText('modals.staffShift.invalidOpeningCash'); expect(bridge.shiftFinancialOpening.begin).not.toHaveBeenCalled(); unpublished();
  });

  it('refuses enabled financial opening when the explicit currency is missing', async () => {
    fixture.getStatus.mockResolvedValue(capability(null)); render(<StaffShiftModal {...props} />); await enterCash();
    await screen.findByText('modals.staffShift.financialOpeningUnavailable'); cash(); submit();
    expect(bridge.shiftFinancialOpening.begin).not.toHaveBeenCalled(); unpublished();
  });

  it('recovers a lost reply through the same native original after cancel/reopen and renews its authorization', async () => {
    bridge.shiftFinancialOpening.begin.mockImplementation(async (input) => {
      nativeOriginal = opening({ openingKey: input.openingKey }); throw new Error('lost IPC reply');
    });
    const view = render(<StaffShiftModal {...props} />); await enterCash(); cash(); submit();
    await screen.findByText('modals.staffShift.financialOpeningUnknown'); const key = nativeOriginal!.openingKey;
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss modal' }));
    await waitFor(() => expect(bridge.shiftFinancialOpening.clearAuthorization).toHaveBeenCalledTimes(1));
    view.rerender(<StaffShiftModal {...props} isOpen={false} />); fixture.getStatus.mockResolvedValue(capability('EUR'));
    view.rerender(<StaffShiftModal {...props} />); await enterCash();
    const input = within(screen.getByTestId('staff-cash-section')).getByRole('textbox');
    expect(input).toHaveValue('12,50'); expect(input).toHaveAttribute('readonly');
    expect(screen.getByTestId('financial-opening-currency')).toHaveTextContent('CHF'); resume();
    await waitFor(() => expect(bridge.shiftFinancialOpening.authorize).toHaveBeenCalledExactlyOnceWith({ openingKey: key, pin: '1111' }));
    expect(bridge.shiftFinancialOpening.begin).toHaveBeenCalledTimes(1); unpublished();
  });

  it('retains a possibly-sent key even when status cannot yet find it', async () => {
    bridge.shiftFinancialOpening.begin.mockRejectedValue(new Error('unknown'));
    const view = render(<StaffShiftModal {...props} />); await enterCash(); cash(); submit();
    await screen.findByText('modals.staffShift.financialOpeningUnknown');
    const key = bridge.shiftFinancialOpening.begin.mock.calls[0][0].openingKey;
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss modal' }));
    view.rerender(<StaffShiftModal {...props} isOpen={false} />); view.rerender(<StaffShiftModal {...props} />); await enterCash(); resume();
    await screen.findByText('modals.staffShift.financialOpeningUnknown');
    expect(bridge.shiftFinancialOpening.status).toHaveBeenLastCalledWith({ openingKey: key });
    expect(bridge.shiftFinancialOpening.begin).toHaveBeenCalledTimes(1); unpublished();
  });

  it('allows a fresh PIN after definite hosted rejection, retaining the same key, amount and ISO', async () => {
    bridge.shiftFinancialOpening.begin.mockResolvedValueOnce({ success: false, code: 'HOSTED_CHECK_IN_REFUSED', error: 'Hosted cashier authorization was not accepted' });
    render(<StaffShiftModal {...props} />); await enterCash(); cash(); submit();
    await screen.findByTestId('staff-pin-section');
    expect(bridge.shiftFinancialOpening.begin).toHaveBeenCalledTimes(1);
    const first = bridge.shiftFinancialOpening.begin.mock.calls[0][0];
    const digit = await screen.findByRole('button', { name: '2', exact: true });
    for (let count = 0; count < 4; count += 1) fireEvent.click(digit);
    fireEvent.click(screen.getByRole('button', { name: 'modals.staffShift.continue' }));
    fireEvent.click(await screen.findByRole('button', { name: /cashier.*modals.staffShift.cashierRoleHelper/i }));
    await screen.findByRole('button', { name: 'modals.staffShift.financialOpeningResume' }); resume();
    await waitFor(() => expect(bridge.shiftFinancialOpening.begin).toHaveBeenCalledTimes(2));
    expect(bridge.shiftFinancialOpening.begin.mock.calls[1][0]).toEqual({ ...first, pin: '2222' });
    expect(bridge.shiftFinancialOpening.authorize).not.toHaveBeenCalled(); unpublished();
  });

  it.each(['confirmed_unusable', 'confirmed_usable'] as const)('refuses a restored %s original with unusable current scope/mirror', async (state) => {
    nativeOriginal = opening({ state, usable: false }); render(<StaffShiftModal {...props} />); await enterCash(); resume();
    await waitFor(() => expect(screen.getAllByText('modals.staffShift.financialOpeningUnusable').length).toBeGreaterThan(0));
    expect(bridge.shiftFinancialOpening.authorize).not.toHaveBeenCalled(); unpublished();
  });

  it('refuses an unrelated local active mirror', async () => {
    nativeOriginal = opening({ state: 'confirmed_usable', usable: true });
    bridge.shifts.getById.mockResolvedValue({ ...shift(nativeOriginal), id: 'wrong-shift' });
    render(<StaffShiftModal {...props} />); await enterCash(); resume();
    await screen.findByText('modals.staffShift.financialOpeningUnusable'); unpublished();
  });

  it('rechecks original usability after the actual shift read', async () => {
    nativeOriginal = opening({ state: 'confirmed_usable', usable: true }); const pending = deferred();
    bridge.shifts.getById.mockReturnValue(pending.promise);
    render(<StaffShiftModal {...props} />); await enterCash(); resume();
    await waitFor(() => expect(bridge.shifts.getById).toHaveBeenCalledTimes(1));
    const row = shift(nativeOriginal); nativeOriginal = { ...nativeOriginal, usable: false };
    await act(async () => pending.resolve(row)); await screen.findByText('modals.staffShift.financialOpeningUnusable'); unpublished();
  });

  it('fences a late begin reply after cancellation and reopen', async () => {
    const pending = deferred(); bridge.shiftFinancialOpening.begin.mockReturnValue(pending.promise);
    const view = render(<StaffShiftModal {...props} />); await enterCash(); cash(); submit();
    await waitFor(() => expect(bridge.shiftFinancialOpening.begin).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss modal' }));
    expect(fixture.onClose).toHaveBeenCalledTimes(1); expect(bridge.shiftFinancialOpening.clearAuthorization).toHaveBeenCalledTimes(1);
    view.rerender(<StaffShiftModal {...props} isOpen={false} />); view.rerender(<StaffShiftModal {...props} />);
    await act(async () => pending.resolve({ success: true, opening: opening({ state: 'confirmed_usable', usable: true }) }));
    await screen.findByText('Cashier Alice'); unpublished(); expect(fixture.onClose).toHaveBeenCalledTimes(1);
  });

  it('fences a late renewal reply after cancellation', async () => {
    nativeOriginal = opening({ hostedAuthorization: { state: 'required', expiresAt: null } });
    const pending = deferred(); bridge.shiftFinancialOpening.authorize.mockReturnValue(pending.promise);
    render(<StaffShiftModal {...props} />); await enterCash(); resume();
    await waitFor(() => expect(bridge.shiftFinancialOpening.authorize).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss modal' }));
    expect(bridge.shiftFinancialOpening.clearAuthorization).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ success: true, opening: opening({ state: 'confirmed_usable', usable: true }) }));
    unpublished(); expect(fixture.onClose).toHaveBeenCalledTimes(1);
  });

  it('fences deferred capability discovery when another cashier is selected', async () => {
    const pending = deferred(); fixture.getStatus.mockReturnValueOnce(pending.promise);
    render(<StaffShiftModal {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /Cashier Alice/ }));
    const digit = await screen.findByRole('button', { name: '1', exact: true });
    for (let count = 0; count < 4; count += 1) fireEvent.click(digit);
    fireEvent.click(screen.getByRole('button', { name: 'modals.staffShift.continue' }));
    fireEvent.click(await screen.findByRole('button', { name: /cashier.*modals.staffShift.cashierRoleHelper/i }));
    await waitFor(() => expect(fixture.getStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.back' }));
    await enterCash('Cashier Bob');
    await act(async () => pending.resolve(capability('USD')));
    expect(screen.getByTestId('financial-opening-currency')).toHaveTextContent('CHF');
    expect(bridge.shiftFinancialOpening.begin).not.toHaveBeenCalled(); unpublished();
  });

  it.each(['scope', 'staff'] as const)('fences a late begin reply after %s replacement', async (replacement) => {
    const pending = deferred(); bridge.shiftFinancialOpening.begin.mockReturnValue(pending.promise);
    const view = render(<StaffShiftModal {...props} />); await enterCash(); cash(); submit();
    await waitFor(() => expect(bridge.shiftFinancialOpening.begin).toHaveBeenCalledTimes(1));
    const old = opening({ state: 'confirmed_usable', usable: true });
    if (replacement === 'scope') fixture.scope.terminalId = 'other-terminal';
    else fixture.sessionStaff = { ...fixture.sessionStaff, staffId: 'different-session-staff' };
    view.rerender(<StaffShiftModal {...props} />);
    await act(async () => pending.resolve({ success: true, opening: old })); unpublished(); expect(fixture.onClose).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'offline'] as const)('preserves ordinary cashier opening when Gift Cards is %s and no original exists', async (state) => {
    fixture.getStatus.mockResolvedValue(state === 'offline' ? { ok: false, kind: 'unavailable', status: null, code: null }
      : { ok: true, data: { ...capability().data, enabled: false, moduleEnabled: false } });
    bridge.shifts.open.mockResolvedValue({ success: false, error: 'ordinary-control' });
    render(<StaffShiftModal {...props} />); await enterCash(); cash(); submit();
    await screen.findByText('ordinary-control');
    expect(bridge.shifts.open).toHaveBeenCalledWith(expect.objectContaining({ roleType: 'cashier', openingCash: 12.5 }));
    expect(bridge.shiftFinancialOpening.begin).not.toHaveBeenCalled();
  });

  it('parses the full displayed range including exact zero without partial-value coercion', () => {
    expect(parseOpeningCents('0,00')).toBe(0); expect(parseOpeningCents('12,50')).toBe(1250);
    expect(parseOpeningCents('999999,99')).toBe(99_999_999);
    for (const input of ['', '1,', '-1', '1e2', '2 euros', 'NaN', '0.001', '1000000,00']) expect(parseOpeningCents(input)).toBeNull();
  });
});
