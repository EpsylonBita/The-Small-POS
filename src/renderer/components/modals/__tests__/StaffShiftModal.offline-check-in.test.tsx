/**
 * The desktop's staff check-in without a connection (founder decision
 * 13/10/2026, Android parity with PR #356). The native verify asks the server
 * first; only when it cannot be reached does the till check the PIN itself
 * and answer `source: 'offline'`. Then every role opens (founder, 15/10/2026),
 * a gift-card store's cashier opening is refused (never an ordinary one), and
 * the renderer never handles a PIN hash or writes the staff directory cache.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  scope: { organizationId: '10000000-0000-4000-8000-000000000001', branchId: '20000000-0000-4000-8000-000000000001', terminalId: 'register-public-01' },
  staffId: '30000000-0000-4000-8000-000000000001',
  getStatus: vi.fn(), setStaff: vi.fn(), setActiveShiftImmediate: vi.fn(), refreshActiveShift: vi.fn(), onClose: vi.fn(),
  toast: vi.fn(),
  t: (key: string, fallback?: string | { defaultValue?: string }) => typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key,
  bridge: {
    terminalConfig: { getTerminalId: vi.fn(), getBranchId: vi.fn(), getOrganizationId: vi.fn(), getSetting: vi.fn() },
    settings: { get: vi.fn(), updateLocal: vi.fn() },
    staffAuth: { refreshDirectory: vi.fn(), verifyCheckInPin: vi.fn() }, staffSchedule: { list: vi.fn() },
    shifts: { getActive: vi.fn(), getActiveForBranch: vi.fn(), getCheckInEligibility: vi.fn(), getActiveCashierByTerminal: vi.fn(), open: vi.fn(), getById: vi.fn() },
    shiftFinancialOpening: { begin: vi.fn(), status: vi.fn(), authorize: vi.fn(), clearAuthorization: vi.fn() },
    modules: { getCached: vi.fn() },
    secureSession: { set: vi.fn(), clear: vi.fn() },
  },
}));
vi.mock('react-hot-toast', async (original) => {
  const actual = await original<typeof import('react-hot-toast')>();
  const toast = Object.assign(fixture.toast, { error: vi.fn(), success: vi.fn(), dismiss: vi.fn(), loading: vi.fn() });
  return { ...actual, toast, default: toast };
});
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: fixture.t }) }));
vi.mock('../../../contexts/i18n-context', () => ({ useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: fixture.t }) }));
vi.mock('../../../contexts/shift-context', () => ({ useShift: () => ({ staff: { staffId: 'main-login', ...fixture.scope }, activeShift: null, isShiftActive: false,
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
import { setBridge, resetBridge } from '../../../../lib/ipc-adapter';

const bridge = fixture.bridge;
const props = { isOpen: true, onClose: fixture.onClose, mode: 'checkin' as const };
const roleRow = (name: string) => ({ role_id: `${name}-role`, role_name: name, role_display_name: name, is_primary: true });
const member = (roles: string[]) => ({ id: fixture.staffId, name: 'Alice', first_name: 'Alice', last_name: '',
  role_name: roles[0], roles: roles.map(roleRow), can_login_pos: true, has_pin: true, is_active: true });
const unreadable = { ok: false, kind: 'unavailable', status: null, code: 'GIFT_CARD_UNAVAILABLE' };
const giftCardsStore = { success: true, modules: { modules: [{ module_id: 'gift_cards' }, { module_id: 'tables' }] } };
const ordinaryStore = { success: true, modules: { modules: [{ module_id: 'tables' }] } };
const ON_TILL = { success: true, staffId: fixture.staffId, source: 'offline', offlineCheckIn: true };

async function enterPin() {
  fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
  const digit = await screen.findByRole('button', { name: '1', exact: true });
  for (let count = 0; count < 4; count += 1) fireEvent.click(digit);
  fireEvent.click(screen.getByRole('button', { name: 'modals.staffShift.continue' }));
}
async function chooseRole(helper: string) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`modals.staffShift.${helper}`) }));
}
async function cash(value = '5000') {
  const section = await screen.findByTestId('staff-cash-section');
  fireEvent.change(within(section).getByRole('textbox'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'modals.staffShift.startShift' }));
}

describe('StaffShiftModal check-in without a connection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setBridge(bridge as any);
    bridge.terminalConfig.getOrganizationId.mockResolvedValue(fixture.scope.organizationId);
    bridge.terminalConfig.getBranchId.mockResolvedValue(fixture.scope.branchId);
    bridge.terminalConfig.getTerminalId.mockResolvedValue(fixture.scope.terminalId);
    bridge.settings.updateLocal.mockResolvedValue({ success: true });
    bridge.staffAuth.refreshDirectory.mockResolvedValue({ success: true, currentTerminalId: fixture.scope.terminalId, staff: [] });
    bridge.shifts.getActive.mockResolvedValue(null);
    bridge.shifts.getActiveForBranch.mockResolvedValue([]);
    bridge.shifts.getCheckInEligibility.mockResolvedValue({ requiresCashierFirst: false });
    bridge.shifts.getActiveCashierByTerminal.mockResolvedValue({ id: 'cashier-shift' });
    bridge.shiftFinancialOpening.status.mockResolvedValue({ success: true, openings: [] });
    bridge.modules.getCached.mockResolvedValue(ordinaryStore);
    fixture.getStatus.mockResolvedValue(unreadable);
    bridge.staffAuth.verifyCheckInPin.mockResolvedValue(ON_TILL);
  });
  afterEach(() => { cleanup(); resetBridge(); localStorage.clear(); });

  const staff = (roles: string[]) => {
    const members = [member(roles)];
    bridge.settings.get.mockResolvedValue(JSON.stringify({ branch_id: fixture.scope.branchId, staff: members }));
    bridge.staffSchedule.list.mockResolvedValue({ success: true, data: { staff: members } });
  };

  it('never writes the staff directory cache: only the native directory refresh does', async () => {
    staff(['cashier']);
    render(<StaffShiftModal {...props} />);
    await screen.findByRole('button', { name: /Alice/ });
    await waitFor(() => expect(bridge.staffAuth.refreshDirectory).toHaveBeenCalled());
    await waitFor(() => expect(bridge.staffSchedule.list).toHaveBeenCalled());
    expect(bridge.settings.updateLocal).not.toHaveBeenCalledWith(expect.objectContaining({ category: 'staff_auth_cache' }));
  });

  it('opens a kitchen shift when this till checked the PIN: every role checks in offline', async () => {
    // Before 15/10/2026 only a cashier, manager or driver opened this way.
    staff(['kitchen', 'server']);
    bridge.shifts.open.mockResolvedValue({ success: true, shiftId: 'kitchen-offline', offlineCheckIn: true });
    render(<StaffShiftModal {...props} />);
    await enterPin();
    await chooseRole('kitchenRoleHelper');
    await waitFor(() => expect(bridge.shifts.open).toHaveBeenCalledWith(expect.objectContaining({ roleType: 'kitchen' })));
    await waitFor(() => expect(fixture.toast).toHaveBeenCalledWith(
      'Checked in without a connection. The server checks this check-in once the connection is back.',
      expect.anything(),
    ));
    expect(screen.queryByText(/only a cashier, manager or driver/)).toBeNull();
  });

  it('lets the server decide a role when it checked the PIN', async () => {
    staff(['kitchen']);
    bridge.staffAuth.verifyCheckInPin.mockResolvedValue({ success: true, staffId: fixture.staffId, source: 'server' });
    bridge.shifts.open.mockResolvedValue({ success: true, shiftId: 'kitchen-shift' });
    render(<StaffShiftModal {...props} />);
    await enterPin();
    await chooseRole('kitchenRoleHelper');
    await waitFor(() => expect(bridge.shifts.open).toHaveBeenCalledWith(expect.objectContaining({ roleType: 'kitchen' })));
  });

  it.each([
    ['checked on this till', ON_TILL],
    ['checked by the server, which then went away', { success: true, staffId: fixture.staffId, source: 'server' }],
  ])('refuses a gift-card store cashier opening without the server (%s), never an ordinary one', async (_case, answer) => {
    staff(['cashier']);
    bridge.modules.getCached.mockResolvedValue(giftCardsStore);
    bridge.staffAuth.verifyCheckInPin.mockResolvedValue(answer);
    render(<StaffShiftModal {...props} />);
    await enterPin();
    await chooseRole('cashierRoleHelper');
    await screen.findByText('With gift cards, opening the drawer needs the server. Check in once the connection is back.');
    await cash();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.shifts.open).not.toHaveBeenCalled();
    expect(bridge.shiftFinancialOpening.begin).not.toHaveBeenCalled();
  });

  it('opens an ordinary drawer offline outside a gift-card store and tells the cashier', async () => {
    staff(['cashier']);
    bridge.shifts.open.mockResolvedValue({ success: true, shiftId: 'offline-shift', offlineCheckIn: true });
    render(<StaffShiftModal {...props} />);
    await enterPin();
    await chooseRole('cashierRoleHelper');
    await waitFor(() => expect(screen.queryByText('modals.staffShift.financialOpeningChecking')).toBeNull());
    await cash();
    await waitFor(() => expect(bridge.shifts.open).toHaveBeenCalledWith(expect.objectContaining({ roleType: 'cashier', openingCash: 50 })));
    await waitFor(() => expect(fixture.toast).toHaveBeenCalledWith(
      'Checked in without a connection. The server checks this check-in once the connection is back.',
      expect.anything(),
    ));
  });

  it("words the native offline opening refusals in the store's language", async () => {
    staff(['cashier']);
    bridge.shifts.open.mockRejectedValue('OFFLINE_CHECK_IN_GIFT_CARDS_NEED_SERVER');
    render(<StaffShiftModal {...props} />);
    await enterPin();
    await chooseRole('cashierRoleHelper');
    await waitFor(() => expect(screen.queryByText('modals.staffShift.financialOpeningChecking')).toBeNull());
    await cash();
    await screen.findByText('With gift cards, opening the drawer needs the server. Check in once the connection is back.');
  });

  it.each([
    ['offline_pin_locked', 'Too many wrong PINs. Try again in 15 minutes, or once the connection is back.'],
    ['offline_waiter_terminal', 'A waiter phone checks staff in through the server. Try again once the connection is back.'],
    ['staff_not_available_offline', "This till holds no PIN for this person, so they can't check in without a connection."],
    ['pin_locked', 'This PIN is locked for now. Try again later.'],
  ])('words the %s refusal instead of showing native text', async (reasonCode, message) => {
    staff(['cashier']);
    bridge.staffAuth.verifyCheckInPin.mockResolvedValue({
      success: false, reasonCode, source: reasonCode === 'pin_locked' ? 'server' : 'offline', error: 'NATIVE_TEXT',
    });
    render(<StaffShiftModal {...props} />);
    await enterPin();
    await screen.findByText(message);
    expect(screen.queryByText('NATIVE_TEXT')).toBeNull();
  });
});
