/**
 * Phone shifts hand over to the Main (founder rule 13/10/2026). The Main's
 * staff screen lists the closed phone tills it still has to receive and every
 * open phone shift no staff card reaches, and its cashier/manager close waits
 * for both. Everything comes from `GET /api/pos/shifts/unit-readiness`; a read
 * that fails is never "no phone shifts", and only a server without the
 * endpoint (or a till that is not a Main) keeps the legacy remote-checkout
 * gate. Contract: docs/architecture/phone-shift-handover.md.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  scope: { organizationId: '10000000-0000-4000-8000-000000000001', branchId: '20000000-0000-4000-8000-000000000001', terminalId: 'register-public-01' },
  staffId: '30000000-0000-4000-8000-000000000001',
  sessionStaff: {} as any,
  activeShift: null as any,
  getStatus: vi.fn(), setStaff: vi.fn(), setActiveShiftImmediate: vi.fn(), refreshActiveShift: vi.fn(), onClose: vi.fn(),
  // Like the other StaffShiftModal suites, plus interpolation, so the named
  // blockers can be read whole.
  t: (key: string, fallback?: string | Record<string, unknown>) => {
    if (typeof fallback === 'string') return fallback;
    const text = typeof fallback?.defaultValue === 'string' ? fallback.defaultValue : key;
    return text.replace(/\{\{(\w+)\}\}/g, (match, name) => (fallback && name in fallback ? String(fallback[name]) : match));
  },
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
import { formatTime } from '../../../utils/format';
import { parseUnitReadiness, rememberUnitReadiness } from '../../../utils/unit-shift-readiness';

const MAIN = fixture.scope.terminalId;
const SHIFT_ID = '50000000-0000-4000-8000-000000000001';
const WAITER_ID = '30000000-0000-4000-8000-000000000002';
const role = (name: string) => ({ role_id: `${name}-role`, role_name: name, role_display_name: name, is_primary: true });
const member = (id: string, name: string, roleName: string) => ({ id, name, first_name: name, last_name: '', role_name: roleName,
  roles: [role(roleName)], can_login_pos: true, has_pin: true, is_active: true });
const members = [member(fixture.staffId, 'Cashier Alice', 'cashier'), member(WAITER_ID, 'Waiter Eva', 'waiter')];

function shift(patch: Record<string, unknown> = {}) {
  return { id: SHIFT_ID, staff_id: fixture.staffId, staff_name: 'Cashier Alice', branch_id: fixture.scope.branchId,
    terminal_id: MAIN, role_type: 'cashier', check_in_time: '2026-10-14T08:00:00.000Z', opening_cash_amount: 0,
    status: 'active', total_orders_count: 0, total_sales_amount: 0, total_cash_sales: 0, total_card_sales: 0,
    created_at: '2026-10-14T08:00:00.000Z', updated_at: '2026-10-14T08:00:00.000Z', currency: 'EUR', ...patch };
}
function summary() {
  const channel = { cashTotal: 0, cardTotal: 0, total: 0, count: 0, cashCount: 0, cardCount: 0 };
  return { shift: shift(), breakdown: { instore: channel, delivery: channel, takeaway: channel, overall: channel },
    cashDrawer: {}, cashRefunds: 0, totalExpenses: 0, expenses: [], staffPayments: [], driverDeliveries: [], transferredDrivers: [],
    transferredWaiters: [], waiterTables: [], canceledOrders: [], cancelledOrders: [], currency: 'EUR',
    cashierCash: { cashCollections: 0, cashRefunds: 0, currency: 'EUR' } };
}

/** A `UnitShift` as the readiness endpoint sends it. */
function openPhoneShift(patch: Record<string, unknown> = {}) {
  return { id: 'phone-shift-1', staff_id: 'waiter-maria', staff_name: 'Maria', role_type: 'waiter', terminal_id: 'phone-1',
    terminal_name: 'Phone 1', terminal_active: true, check_in_time: '2026-10-14T09:00:00.000Z', currency: 'EUR',
    opening_cash_amount: 0, ...patch };
}
/** A `UnitClosedShift`: a till the phone closed, its cash not taken yet. */
function closedPhoneTill(patch: Record<string, unknown> = {}) {
  return { ...openPhoneShift({ id: 'phone-close-1', staff_id: 'waiter-luca', staff_name: 'Luca', terminal_id: 'phone-2', terminal_name: 'Phone 2' }),
    status: 'closed', check_out_time: '2026-10-14T15:00:00.000Z', closing_cash_amount: 10.5, expected_cash_amount: 10.5,
    cash_variance: 0, total_orders_count: 3, total_sales_amount: 42, total_cash_sales: 10.5, total_card_sales: 31.5,
    handover: 'pending', closed_by: 'phone', received_at: null, receivable: true, ...patch };
}
const readiness = (body: Record<string, unknown> = {}) => ({ success: true, data: { success: true, main_terminal_id: MAIN,
  checked_at: '2026-10-14T16:00:00.000Z', since: '2026-10-14T06:00:00.000Z', open_shifts: [], closed_shifts: [],
  pending_returns: [], terminals: [], ...body } });
const UNAVAILABLE = { success: false, status: 503, code: 'UNIT_READINESS_UNAVAILABLE', error: 'Phone shifts unavailable' };
const NOT_FOUND = { success: false, status: 404, error: 'Not found' };
const NOT_MAIN = { success: false, status: 403, code: 'UNIT_READINESS_MAIN_ONLY', error: 'Main only' };
const PREVIEW = { success: true, figures: { currency: 'EUR', total_orders_count: 3, total_sales_amount: 42, total_cash_sales: 10.5,
  total_card_sales: 31.5, opening_cash_amount: 0, expected_cash_amount: 10.5 } };
const UNAVAILABLE_TEXT = 'Phone shifts could not be checked. Check the connection and try again.';
const CHECKED_AT = '2026-10-14T16:00:00.000Z';
const PHONE = { terminal_id: 'phone-1', name: 'Phone 1', is_active: true, terminal_type: 'mobile_waiter' };
const KIOSK = { terminal_id: 'kiosk-1', name: 'Kiosk', is_active: true, terminal_type: 'kiosk' };
const hhmm = (iso: string) => formatTime(iso, { hour: '2-digit', minute: '2-digit' });
const LAST_CHECKED_TEXT = `No connection. Phone shifts as last checked at ${hhmm(CHECKED_AT)}.`;
/** A good read this terminal remembers from an earlier session (localStorage). */
function rememberRead(body: Record<string, unknown>) {
  const parsed = parseUnitReadiness(readiness(body).data);
  if (!parsed) throw new Error('fixture readiness must parse');
  rememberUnitReadiness(MAIN, parsed);
}
/** Satellite shift ids whose local claim a manager released (native journal). */
let releasedIds: string[] = [];
const REMOTE_RETRY = 'REMOTE_HANDOVER_RETRY';
const CLOSED_WITHOUT_HANDOVER = { success: true, closedWithoutHandover: true, alreadyClosed: false,
  shift: { id: 'phone-shift-1', status: 'abandoned', check_out_time: '2026-10-14T17:00:00.000Z' }, auditId: 'audit-1' };

/** Typed fake IPC for the namespaces under test; any other call fails closed. */
function makeBridge() {
  // `shift_satellite_handover_recovery`: released claims and the close
  // without handover (coordinator review 14/10/2026).
  const invoke = vi.fn(async (channel: string, payload?: { action?: string }) => {
    if (channel !== 'shift_satellite_handover_recovery') return undefined;
    if (payload?.action === 'released_sources') return { success: true, satelliteShiftIds: releasedIds };
    if (payload?.action === 'close_without_handover') return CLOSED_WITHOUT_HANDOVER;
    if (payload?.action === 'list') return { success: true, handovers: [] };
    return undefined;
  });
  const explicit: Record<string, Record<string, any>> = {
    terminalConfig: { getTerminalId: vi.fn(async () => MAIN), getBranchId: vi.fn(async () => fixture.scope.branchId),
      getOrganizationId: vi.fn(async () => fixture.scope.organizationId), getSetting: vi.fn(async (_category: string, key: string) => key === 'name' ? 'Till 1' : null) },
    settings: { get: vi.fn(async () => JSON.stringify({ branch_id: fixture.scope.branchId, staff: members })), updateLocal: vi.fn(async () => ({ success: true })) },
    staffAuth: { refreshDirectory: vi.fn(async () => ({ success: true, currentTerminalId: MAIN, staff: [] })), verifyCheckInPin: vi.fn(async () => ({ success: true })) },
    staffSchedule: { list: vi.fn(async () => ({ success: true, data: { staff: members } })) },
    shifts: {
      unitReadiness: vi.fn(async () => readiness()),
      pendingCashReturns: vi.fn(async () => ({ success: true, requires_receipt_check: true, active_waiter_count: 0, returns: [] })),
      remoteCheckout: vi.fn(async () => PREVIEW),
      recordSatelliteHandover: vi.fn(async () => ({ success: true, applied: true, handover: { currency: 'EUR',
        expected_cash_cents: 1050, counted_cash_cents: 1050, cash_variance_cents: 0 } })),
      getActive: vi.fn(async () => null), getActiveForBranch: vi.fn(async () => []), getCheckInEligibility: vi.fn(async () => ({ requiresCashierFirst: false })),
      getActiveCashierByTerminal: vi.fn(async () => ({ id: 'ordinary-cashier' })), open: vi.fn(), getById: vi.fn(async () => null),
      getSummary: vi.fn(async () => ({ success: true, data: summary() })), getExpenses: vi.fn(async () => []),
      getStaffPayments: vi.fn(async () => []), getStaffPaymentsByStaff: vi.fn(async () => []), getStaffPaymentTotalForDate: vi.fn(async () => 0),
      close: vi.fn(async () => ({ success: true, message: 'Shift closed' })), printCheckout: vi.fn(async () => ({ success: true })),
    },
    shiftFinancialOpening: { status: vi.fn(async () => ({ success: true, openings: [] })), begin: vi.fn(), authorize: vi.fn(), clearAuthorization: vi.fn() },
    shiftFinancialClosing: { listPending: vi.fn(async () => ({ success: true, closings: [], truncated: false })) },
    giftFunding: { closeBlocker: vi.fn(async () => ({ success: true, blocked: false, shiftId: SHIFT_ID, unresolved: [] })) },
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
      if (key === 'invoke') return invoke;
      if (!namespaces[key]) namespaces[key] = namespace(target[key] ?? (target[key] = {}));
      return namespaces[key];
    },
  }) as any;
}

let bridge: any;
const checkin = { isOpen: true, onClose: fixture.onClose, mode: 'checkin' as const };
const checkout = { isOpen: true, onClose: fixture.onClose, mode: 'checkout' as const };

/** The Main cashier's ordinary close: press End Shift (zero cash asks first). */
async function pressEndShift() {
  const closeButton = await screen.findByTestId('staff-checkout-confirm-button');
  await waitFor(() => expect(closeButton).toBeEnabled());
  fireEvent.click(closeButton);
}
// The glass modal is stubbed, so the zero-cash confirmation shows as its message.
const zeroCashDialog = () => screen.queryByText('Are you sure you want to close the shift with zero closing cash?');

describe('StaffShiftModal phone shifts hand over to the Main', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    fixture.sessionStaff = { staffId: '70000000-0000-4000-8000-000000000001', ...fixture.scope };
    fixture.activeShift = null;
    fixture.getStatus.mockResolvedValue({ ok: true, data: { enabled: false } });
    releasedIds = [];
    localStorage.clear();
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

  describe('the staff screen', () => {
    it('shows a till the phone closed itself with its orders, sales, cash and card, and receives it by shift id', async () => {
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ pending_returns: [closedPhoneTill()] }));
      render(<StaffShiftModal {...checkin} />);

      const receive = await screen.findByTestId('phone-till-receive-phone-close-1');
      expect(receive).toHaveTextContent(/Luca · .*10[.,]50/);
      expect(receive).toHaveTextContent('Phone 2');
      fireEvent.click(receive);

      await waitFor(() => expect(bridge.shifts.remoteCheckout).toHaveBeenCalledWith({ shiftId: 'phone-close-1', action: 'preview' }));
      const pane = await screen.findByTestId('satellite-checkout-section');
      for (const label of ['Orders', 'Total sales', 'Cash sales', 'Card sales', 'Opening float', 'Expected cash']) {
        expect(within(pane).getByText(label)).toBeInTheDocument();
      }
      expect(within(pane).getByText('3')).toBeInTheDocument();
      expect(within(pane).getByText(/42[.,]00/)).toBeInTheDocument();
      expect(within(pane).getByText(/31[.,]50/)).toBeInTheDocument();
      expect(within(pane).getByText(/^on Phone 2/)).toBeInTheDocument();

      // Founder decision 15/10/2026: the till's own count is received, shown, not typed.
      expect(screen.queryByTestId('satellite-counted-cash')).toBeNull();
      expect(screen.getByTestId('satellite-recorded-count')).toHaveTextContent(/10[.,]50/);
      fireEvent.click(screen.getByTestId('satellite-checkout-confirm'));
      await waitFor(() => expect(bridge.shifts.recordSatelliteHandover).toHaveBeenCalledWith(expect.objectContaining({
        satelliteShiftId: 'phone-close-1', countedCash: 10.5, currency: 'EUR', openingCash: 0,
      })));
      expect(await screen.findByTestId('satellite-checkout-success')).toBeInTheDocument();
      // The receipt is read again so the till leaves the list.
      await waitFor(() => expect(bridge.shifts.unitReadiness).toHaveBeenCalledTimes(2));
      expect(bridge.shifts.pendingCashReturns).not.toHaveBeenCalled();
    });

    it('receives a driver till with a float at its own count and float, a count of 0 included (founder 15/10/2026)', async () => {
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ terminals: [PHONE], pending_returns: [
        closedPhoneTill({ id: 'driver-float', staff_name: 'Dino', role_type: 'driver', opening_cash_amount: 20,
          closing_cash_amount: 0, expected_cash_amount: 20, cash_variance: -20, receivable: true, settle: 'receive',
          receiving_cashier_shift_id: 'cashier-shift' }),
      ] }));
      bridge.shifts.remoteCheckout.mockResolvedValue({ success: true, already_closed: true,
        shift: { id: 'driver-float', role_type: 'driver', opening_cash_amount: 20, closing_cash_amount: 0, expected_cash_amount: 20 },
        figures: { currency: 'EUR', opening_cash_amount: 20, expected_cash_amount: 20, total_orders_count: 2,
          total_sales_amount: 30, total_cash_sales: 0, total_card_sales: 30 } });
      bridge.shifts.recordSatelliteHandover.mockResolvedValue({ success: true, applied: true, handover: { currency: 'EUR',
        opening_cash_cents: 2000, expected_cash_cents: 2000, counted_cash_cents: 0, cash_variance_cents: -2000 } });
      render(<StaffShiftModal {...checkin} />);

      const receive = await screen.findByTestId('phone-till-receive-driver-float');
      expect(receive).toHaveTextContent(/Dino · .*0[.,]00/);
      fireEvent.click(receive);
      await waitFor(() => expect(bridge.shifts.remoteCheckout).toHaveBeenCalledWith({ shiftId: 'driver-float', action: 'preview' }));
      expect(await screen.findByTestId('satellite-recorded-count')).toHaveTextContent(/0[.,]00/);
      fireEvent.click(screen.getByTestId('satellite-checkout-confirm'));
      await waitFor(() => expect(bridge.shifts.recordSatelliteHandover).toHaveBeenCalledWith(expect.objectContaining({
        satelliteShiftId: 'driver-float', openingCash: 20, countedCash: 0, currency: 'EUR',
      })));
      expect(bridge.shifts.recordSatelliteHandover).toHaveBeenCalledTimes(1);
      expect(await screen.findByTestId('satellite-checkout-success')).toBeInTheDocument();
    });

    it('says a till waiting for a cashier is received here once one is checked in', async () => {
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ terminals: [PHONE], pending_returns: [
        closedPhoneTill({ id: 'later-till', staff_name: 'Dino', role_type: 'driver', opening_cash_amount: 20,
          closing_cash_amount: 35, receivable: false, settle: 'needs_cashier' }),
      ] }));
      render(<StaffShiftModal {...checkin} />);
      const info = await screen.findByTestId('phone-till-info-later-till');
      expect(info).toHaveTextContent('Received here once a cashier is checked in.');
      expect(info).not.toHaveTextContent('A manager settles it');
      expect(within(info).queryByRole('button')).toBeNull();
    });

    it('lists a till only a manager can settle without a Receive button', async () => {
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ pending_returns: [
        closedPhoneTill({ id: 'driver-close', staff_name: 'Dino', role_type: 'driver', closing_cash_amount: 25, receivable: false }),
      ] }));
      render(<StaffShiftModal {...checkin} />);

      const info = await screen.findByTestId('phone-till-info-driver-close');
      expect(info).toHaveTextContent(/Dino · .*25[.,]00/);
      expect(info).toHaveTextContent('Phone 2');
      expect(info).toHaveTextContent("This till can't be received here. A manager settles it.");
      expect(within(info).queryByRole('button')).toBeNull();
      expect(screen.queryByTestId('phone-till-receive-driver-close')).toBeNull();
    });

    it('lists an open phone shift no staff card reaches and closes it from the Main by shift id', async () => {
      bridge.staffAuth.refreshDirectory.mockResolvedValue({ success: true, currentTerminalId: MAIN, staff: [{
        id: WAITER_ID, currentShift: { shiftId: 'carded-shift', terminalId: 'phone-1', parentTerminalId: MAIN, role: 'waiter',
          terminalName: 'Phone 1', checkedInAt: '2026-10-14T09:00:00.000Z' },
      }] });
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ open_shifts: [
        openPhoneShift({ id: 'carded-shift', staff_id: WAITER_ID, staff_name: 'Waiter Eva' }),
        openPhoneShift({ id: 'ghost-shift', staff_id: 'staff-no-longer-active', staff_name: 'Nikos', role_type: 'driver',
          terminal_id: 'phone-x', terminal_name: null, terminal_active: null, opening_cash_amount: 20 }),
      ] }));
      render(<StaffShiftModal {...checkin} />);

      const section = await screen.findByTestId('phone-shifts-open');
      // Eva's shift already has her staff card; only the unreachable one is listed.
      await waitFor(() => expect(within(section).queryByTestId('phone-shift-close-carded-shift')).toBeNull());
      expect(screen.getByRole('button', { name: /Waiter Eva/ })).toBeInTheDocument();
      const ghost = within(section).getByTestId('phone-shift-close-ghost-shift');
      expect(ghost).toHaveTextContent('Nikos');
      expect(ghost).toHaveTextContent('driver');
      expect(ghost).toHaveTextContent('on phone-x · phone removed');
      expect(ghost).toHaveTextContent('checked in');

      fireEvent.click(ghost);
      await waitFor(() => expect(bridge.shifts.remoteCheckout).toHaveBeenCalledWith({ shiftId: 'ghost-shift', action: 'preview' }));
      const pane = await screen.findByTestId('satellite-checkout-section');
      expect(within(pane).getByText('Cash handover — Nikos')).toBeInTheDocument();
      expect(within(pane).getByText(/^on phone-x/)).toBeInTheDocument();
      expect(screen.getByTestId('satellite-checkout-confirm')).toHaveTextContent('Close shift & receive cash');
    });

    it('marks a deactivated phone on an open shift', async () => {
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ open_shifts: [openPhoneShift({ terminal_active: false })] }));
      render(<StaffShiftModal {...checkin} />);
      expect(await screen.findByTestId('phone-shift-close-phone-shift-1')).toHaveTextContent('on Phone 1 · phone deactivated');
    });

    it('says when phone shifts cannot be checked, never that there are none, and retries', async () => {
      bridge.shifts.unitReadiness.mockResolvedValueOnce(UNAVAILABLE).mockResolvedValue(readiness({ open_shifts: [openPhoneShift()] }));
      render(<StaffShiftModal {...checkin} />);

      const section = await screen.findByTestId('phone-shifts-unavailable');
      expect(within(section).getByRole('alert')).toHaveTextContent(UNAVAILABLE_TEXT);
      fireEvent.click(within(section).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByTestId('phone-shift-close-phone-shift-1')).toBeInTheDocument();
      expect(bridge.shifts.pendingCashReturns).not.toHaveBeenCalled();
    });

    it('lists a receivable till whose claim a manager released as information, without Receive', async () => {
      releasedIds = ['phone-close-1'];
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ terminals: [PHONE], pending_returns: [closedPhoneTill()] }));
      render(<StaffShiftModal {...checkin} />);

      const info = await screen.findByTestId('phone-till-info-phone-close-1');
      expect(info).toHaveTextContent(/Luca · .*10[.,]50/);
      expect(info).toHaveTextContent('Phone 2');
      expect(info).toHaveTextContent("This till can't be received here. A manager settles it.");
      expect(within(info).queryByRole('button')).toBeNull();
      expect(screen.queryByTestId('phone-till-receive-phone-close-1')).toBeNull();
      expect(bridge.invoke).toHaveBeenCalledWith('shift_satellite_handover_recovery', { action: 'released_sources' });
    });

    it('keeps the good read on a Refresh that fails, saying when it was last checked', async () => {
      bridge.shifts.unitReadiness
        .mockResolvedValueOnce(readiness({ terminals: [PHONE], pending_returns: [closedPhoneTill()] }))
        .mockResolvedValue(UNAVAILABLE);
      render(<StaffShiftModal {...checkin} />);

      const tills = await screen.findByTestId('phone-tills-awaiting');
      expect(screen.queryByTestId('phone-shifts-last-checked')).toBeNull();
      fireEvent.click(within(tills).getByRole('button', { name: 'common.refresh' }));

      expect(await screen.findByTestId('phone-shifts-last-checked')).toHaveTextContent(LAST_CHECKED_TEXT);
      expect(bridge.shifts.unitReadiness).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('phone-till-receive-phone-close-1')).toBeInTheDocument();
      expect(screen.queryByTestId('phone-shifts-unavailable')).toBeNull();
    });

    it('opened offline, shows the read this terminal remembers with its time', async () => {
      rememberRead({ terminals: [PHONE], open_shifts: [openPhoneShift()] });
      bridge.shifts.unitReadiness.mockResolvedValue(UNAVAILABLE);
      render(<StaffShiftModal {...checkin} />);

      expect(await screen.findByTestId('phone-shift-close-phone-shift-1')).toBeInTheDocument();
      expect(screen.getByTestId('phone-shifts-last-checked')).toHaveTextContent(LAST_CHECKED_TEXT);
      expect(screen.queryByTestId('phone-shifts-unavailable')).toBeNull();
    });

    it('opened offline with a quiet remembered read and paired phones, says only when it was last checked', async () => {
      rememberRead({ terminals: [PHONE] });
      bridge.shifts.unitReadiness.mockResolvedValue(UNAVAILABLE);
      render(<StaffShiftModal {...checkin} />);

      expect(await screen.findByTestId('phone-shifts-last-checked')).toHaveTextContent(LAST_CHECKED_TEXT);
      expect(screen.queryByTestId('phone-shifts-unavailable')).toBeNull();
      expect(screen.queryByTestId('phone-tills-awaiting')).toBeNull();
      expect(screen.queryByTestId('phone-shifts-open')).toBeNull();
    });

    it('hides the phone sections of a unit without phones that has nothing open or pending, online or offline', async () => {
      rememberRead({ terminals: [KIOSK] });
      bridge.shifts.unitReadiness.mockResolvedValue(UNAVAILABLE);
      const view = render(<StaffShiftModal {...checkin} />);
      await screen.findByRole('button', { name: /Cashier Alice/ });
      await waitFor(() => expect(bridge.shifts.unitReadiness).toHaveBeenCalledTimes(1));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      for (const id of ['phone-shifts-unavailable', 'phone-shifts-last-checked', 'phone-tills-awaiting', 'phone-shifts-open']) {
        expect(screen.queryByTestId(id)).toBeNull();
      }

      view.unmount();
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ terminals: [KIOSK] }));
      render(<StaffShiftModal {...checkin} />);
      await screen.findByRole('button', { name: /Cashier Alice/ });
      await waitFor(() => expect(bridge.shifts.unitReadiness).toHaveBeenCalledTimes(2));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      for (const id of ['phone-shifts-unavailable', 'phone-shifts-last-checked', 'phone-tills-awaiting', 'phone-shifts-open']) {
        expect(screen.queryByTestId(id)).toBeNull();
      }
    });
  });

  // Coordinator review 14/10/2026: an open phone shift whose cash cannot be
  // handed over here, or that counts no cash, closes without a handover.
  describe('close without handover', () => {
    async function openPhonePane(patch: Record<string, unknown> = {}) {
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ terminals: [PHONE], open_shifts: [openPhoneShift(patch)] }));
      render(<StaffShiftModal {...checkin} />);
      fireEvent.click(await screen.findByTestId('phone-shift-close-phone-shift-1'));
      return screen.findByTestId('satellite-checkout-section');
    }
    const refusedPreview = (code: string, status = 409) => ({ success: false, status, code, error: code });
    async function fillAndConfirm(pin: string, reason: string) {
      if (!screen.queryByTestId('close-without-handover-pin')) {
        fireEvent.click(await screen.findByTestId('close-without-handover-open'));
      }
      fireEvent.change(screen.getByTestId('close-without-handover-pin'), { target: { value: pin } });
      fireEvent.change(screen.getByTestId('close-without-handover-reason'), { target: { value: reason } });
      fireEvent.click(screen.getByTestId('close-without-handover-confirm'));
    }

    it('is offered when the preview is refused for good, sends the manager PIN and reason, and leaves the pane', async () => {
      bridge.shifts.remoteCheckout.mockResolvedValue(refusedPreview('REMOTE_HANDOVER_MOVEMENTS_UNAVAILABLE'));
      const pane = await openPhonePane();

      const offer = await within(pane).findByTestId('close-without-handover');
      expect(offer).toHaveTextContent('The shift closes without cash: nothing is added to this drawer. A manager settles its money.');
      fireEvent.click(within(offer).getByTestId('close-without-handover-open'));
      const confirm = within(offer).getByTestId('close-without-handover-confirm');
      expect(confirm).toBeDisabled();
      // Digits only, like the release panel.
      fireEvent.change(within(offer).getByTestId('close-without-handover-pin'), { target: { value: '12a4' } });
      expect(within(offer).getByTestId('close-without-handover-pin')).toHaveValue('124');
      expect(confirm).toBeDisabled();
      fireEvent.change(within(offer).getByTestId('close-without-handover-reason'), { target: { value: '  Phone lost  ' } });
      expect(within(offer).getByTestId('close-without-handover-reason')).toHaveAttribute('maxLength', '500');
      const directoryReads = bridge.staffAuth.refreshDirectory.mock.calls.length;
      fireEvent.click(confirm);

      await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith('shift_satellite_handover_recovery', {
        action: 'close_without_handover', satelliteShiftId: 'phone-shift-1', managerPin: '124', reason: 'Phone lost',
      }));
      expect(await screen.findByText(
        "Maria's shift is closed without a handover and its cash is marked not counted. Nothing was added to this drawer; a manager settles its money.",
      )).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByTestId('satellite-checkout-section')).toBeNull());
      await waitFor(() => expect(bridge.shifts.unitReadiness).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(bridge.staffAuth.refreshDirectory.mock.calls.length).toBeGreaterThan(directoryReads));
      expect(bridge.shifts.recordSatelliteHandover).not.toHaveBeenCalled();
    });

    it('says a non-cash shift closed without a handover as closed', async () => {
      bridge.invoke.mockImplementation(async (_channel: string, payload?: { action?: string }) => (
        payload?.action === 'close_without_handover'
          ? { ...CLOSED_WITHOUT_HANDOVER, shift: { ...CLOSED_WITHOUT_HANDOVER.shift, status: 'closed' } }
          : { success: true, satelliteShiftIds: [] }));
      const pane = await openPhonePane({ role_type: 'kitchen' });

      // Offered for a role that counts no cash, next to the ordinary figures.
      expect(await within(pane).findByTestId('satellite-checkout-confirm')).toBeInTheDocument();
      expect(within(pane).getByTestId('close-without-handover')).toBeInTheDocument();
      await fillAndConfirm('2468', 'Kitchen shift');
      expect(await screen.findByText("Maria's shift is closed without a handover. Nothing was added to this drawer.")).toBeInTheDocument();
    });

    it('is offered when the close is refused for good', async () => {
      bridge.shifts.recordSatelliteHandover.mockResolvedValue({ success: false, applied: false, pending: false, refused: true,
        errorCode: 'SATELLITE_HANDOVER_REFUSED', refusalCode: 'REMOTE_HANDOVER_SOURCE_DRAWER_UNAVAILABLE',
        error: 'SATELLITE_HANDOVER_REFUSED: REMOTE_HANDOVER_SOURCE_DRAWER_UNAVAILABLE' });
      const pane = await openPhonePane();
      await within(pane).findByTestId('satellite-checkout-confirm');
      expect(within(pane).queryByTestId('close-without-handover')).toBeNull();

      fireEvent.change(screen.getByTestId('satellite-counted-cash'), { target: { value: '1050' } });
      fireEvent.click(screen.getByTestId('satellite-checkout-confirm'));
      expect(await within(pane).findByTestId('close-without-handover')).toBeInTheDocument();
    });

    it('is not offered on REMOTE_HANDOVER_RETRY, a server outage or a till the phone closed itself', async () => {
      bridge.shifts.remoteCheckout.mockResolvedValue(refusedPreview('REMOTE_HANDOVER_RETRY'));
      let pane = await openPhonePane();
      expect(await within(pane).findByText('The server is busy with this shift right now. Try again in a moment.')).toBeInTheDocument();
      expect(within(pane).queryByTestId('close-without-handover')).toBeNull();
      cleanup();

      bridge.shifts.remoteCheckout.mockResolvedValue(refusedPreview('REMOTE_HANDOVER_FIGURES_UNAVAILABLE', 503));
      pane = await openPhonePane();
      await within(pane).findByText(/couldn't be loaded from the server/);
      expect(within(pane).queryByTestId('close-without-handover')).toBeNull();
      cleanup();

      // A close refused with the retry code is not final either.
      bridge.shifts.remoteCheckout.mockResolvedValue(PREVIEW);
      bridge.shifts.recordSatelliteHandover.mockResolvedValue({ success: false, refused: true,
        refusalCode: REMOTE_RETRY, error: `SATELLITE_HANDOVER_REFUSED: ${REMOTE_RETRY}` });
      pane = await openPhonePane();
      fireEvent.change(await within(pane).findByTestId('satellite-counted-cash'), { target: { value: '1050' } });
      fireEvent.click(screen.getByTestId('satellite-checkout-confirm'));
      await waitFor(() => expect(bridge.shifts.recordSatelliteHandover).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByTestId('satellite-checkout-confirm')).toBeEnabled());
      expect(within(pane).queryByTestId('close-without-handover')).toBeNull();
      cleanup();

      bridge.shifts.remoteCheckout.mockResolvedValue(refusedPreview('REMOTE_HANDOVER_MOVEMENTS_UNAVAILABLE'));
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ terminals: [PHONE], pending_returns: [closedPhoneTill({ role_type: 'kitchen' })] }));
      render(<StaffShiftModal {...checkin} />);
      fireEvent.click(await screen.findByTestId('phone-till-receive-phone-close-1'));
      pane = await screen.findByTestId('satellite-checkout-section');
      await within(pane).findByText(/cash movements have not reached the server/);
      expect(within(pane).queryByTestId('close-without-handover')).toBeNull();
      expect(within(pane).queryByTestId('phone-last-seen-warning')).toBeNull();
    });

    it('says why a close without handover failed, in plain words', async () => {
      bridge.shifts.remoteCheckout.mockResolvedValue(refusedPreview('REMOTE_HANDOVER_ROLE_UNSUPPORTED', 403));
      const pane = await openPhonePane();
      await within(pane).findByTestId('close-without-handover');
      const cases: Array<[string, string]> = [
        ['Invalid PIN', "That PIN can't approve it. A manager with the right to cancel orders enters their own PIN."],
        ['MANAGER_APPROVAL_REQUIRED', "That PIN can't approve it. A manager with the right to cancel orders enters their own PIN."],
        ['PHONE_SHIFT_CLOSE_REASON_REQUIRED', 'Enter a reason, up to 500 characters.'],
        ['SATELLITE_HANDOVER_MANAGER_PIN_REQUIRED', 'A manager enters their own PIN.'],
        ['REMOTE_HANDOVER_RECEIVER_MISMATCH', "That PIN belongs to no active staff member of this business, so it can't approve it."],
        ['REMOTE_HANDOVER_APPROVAL_REQUIRED', "This manager can't approve closing a shift without a handover."],
        ['REMOTE_CHECKOUT_NOT_UNIT_CHILD', "Only the main till of this phone's register can close its shifts."],
        ['PHONE_SHIFT_CLOSE_OFFLINE', 'No connection. The shift closes only online: check the connection and try again.'],
        ['PHONE_SHIFT_CLOSE_FAILED', "The shift couldn't be closed. Nothing changed; try again."],
      ];
      for (const [code, text] of cases) {
        bridge.invoke.mockImplementation(async (_channel: string, payload?: { action?: string }) => {
          if (payload?.action === 'close_without_handover') throw code;
          return { success: true, satelliteShiftIds: [] };
        });
        await fillAndConfirm('2468', 'Phone broken');
        expect(await within(pane).findByRole('alert')).toHaveTextContent(text);
        // The PIN is cleared, the reason kept, the pane stays.
        expect(screen.getByTestId('close-without-handover-pin')).toHaveValue('');
        expect(screen.getByTestId('close-without-handover-reason')).toHaveValue('Phone broken');
      }
      expect(document.body.textContent).not.toMatch(/PHONE_SHIFT_CLOSE|REMOTE_CHECKOUT|REMOTE_HANDOVER_RECEIVER|REMOTE_HANDOVER_APPROVAL/);
      expect(screen.getByTestId('satellite-checkout-section')).toBeInTheDocument();
    });
  });

  // Coordinator review 14/10/2026: a phone silent for over five minutes may
  // hold orders or payments the remote checkout figures do not have.
  describe('a phone not heard from lately', () => {
    async function openPane(lastSeen: string | null) {
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ terminals: [PHONE],
        open_shifts: [openPhoneShift({ terminal_last_seen_at: lastSeen })] }));
      render(<StaffShiftModal {...checkin} />);
      fireEvent.click(await screen.findByTestId('phone-shift-close-phone-shift-1'));
      const pane = await screen.findByTestId('satellite-checkout-section');
      await within(pane).findByTestId('satellite-checkout-confirm');
      return pane;
    }

    it('warns with the last time the phone was online', async () => {
      const lastSeen = new Date(Date.now() - 20 * 60_000).toISOString();
      const pane = await openPane(lastSeen);
      expect(within(pane).getByTestId('phone-last-seen-warning')).toHaveTextContent(
        `This phone was last online at ${hhmm(lastSeen)}. Orders or payments it has not sent are not in these figures.`,
      );
    });

    it('warns when the phone was never heard from', async () => {
      const pane = await openPane(null);
      expect(within(pane).getByTestId('phone-last-seen-warning')).toHaveTextContent(
        "This phone's last connection is unknown. Orders or payments it has not sent may be missing from these figures.",
      );
    });

    it('does not warn for a phone online a minute ago', async () => {
      const pane = await openPane(new Date(Date.now() - 60_000).toISOString());
      expect(within(pane).queryByTestId('phone-last-seen-warning')).toBeNull();
    });

    it('does not warn when the shift is in no readiness answer (an old server)', async () => {
      bridge.shifts.unitReadiness.mockResolvedValue(NOT_FOUND);
      bridge.staffAuth.refreshDirectory.mockResolvedValue({ success: true, currentTerminalId: MAIN, staff: [{
        id: WAITER_ID, currentShift: { shiftId: 'carded-shift', terminalId: 'phone-1', parentTerminalId: MAIN, role: 'waiter',
          terminalName: 'Phone 1', checkedInAt: '2026-10-14T09:00:00.000Z' },
      }] });
      render(<StaffShiftModal {...checkin} />);
      fireEvent.click(await screen.findByRole('button', { name: /Waiter Eva/ }));
      const pane = await screen.findByTestId('satellite-checkout-section');
      await within(pane).findByTestId('satellite-checkout-confirm');
      expect(within(pane).queryByTestId('phone-last-seen-warning')).toBeNull();
    });
  });

  describe("the Main cashier's close", () => {
    beforeEach(() => {
      fixture.activeShift = shift();
    });

    it('holds while any phone shift is open, whatever its role, naming it from a fresh read', async () => {
      bridge.shifts.unitReadiness
        .mockResolvedValueOnce(readiness())
        .mockResolvedValue(readiness({ open_shifts: [openPhoneShift({ role_type: 'driver', terminal_active: false })] }));
      render(<StaffShiftModal {...checkout} />);
      await pressEndShift();

      expect(await screen.findByText(
        'Close the phone shifts before closing this shift: Maria (driver, Phone 1 · phone deactivated). Close them on the phone, or here in staff selection.',
      )).toBeInTheDocument();
      expect(bridge.shifts.unitReadiness).toHaveBeenCalledTimes(2);
      expect(zeroCashDialog()).toBeNull();
      expect(bridge.shifts.close).not.toHaveBeenCalled();
      expect(bridge.shifts.pendingCashReturns).not.toHaveBeenCalled();
    });

    it('holds while a closed phone till waits to be received here', async () => {
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ pending_returns: [closedPhoneTill()] }));
      render(<StaffShiftModal {...checkout} />);
      await pressEndShift();

      expect(await screen.findByText(
        /^Receive the cash from these phone tills in staff selection before closing this shift: Luca \(Phone 2, .*10[.,]50\)\.$/,
      )).toBeInTheDocument();
      expect(zeroCashDialog()).toBeNull();
      expect(bridge.shifts.close).not.toHaveBeenCalled();
    });

    it('does not hold for a till only a manager can settle', async () => {
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ pending_returns: [closedPhoneTill({ receivable: false })] }));
      render(<StaffShiftModal {...checkout} />);
      await pressEndShift();

      await waitFor(() => expect(zeroCashDialog()).not.toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'common.actions.confirm' }));
      await waitFor(() => expect(bridge.shifts.close).toHaveBeenCalledTimes(1));
    });

    it('does not hold for a till waiting for a cashier (founder 15/10/2026)', async () => {
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ pending_returns: [
        closedPhoneTill({ receivable: false, settle: 'needs_cashier', role_type: 'driver', opening_cash_amount: 20 }),
      ] }));
      render(<StaffShiftModal {...checkout} />);
      await pressEndShift();

      await waitFor(() => expect(zeroCashDialog()).not.toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'common.actions.confirm' }));
      await waitFor(() => expect(bridge.shifts.close).toHaveBeenCalledTimes(1));
    });

    it('never reads a failed readiness check as no phone shifts', async () => {
      bridge.shifts.unitReadiness.mockResolvedValue(UNAVAILABLE);
      render(<StaffShiftModal {...checkout} />);
      await pressEndShift();

      expect(await screen.findByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
      expect(zeroCashDialog()).toBeNull();
      expect(bridge.shifts.close).not.toHaveBeenCalled();
      expect(bridge.shifts.pendingCashReturns).not.toHaveBeenCalled();
    });

    it('lets a unit that had no phone when the list opened close offline, as before', async () => {
      bridge.shifts.unitReadiness
        .mockResolvedValueOnce(readiness({ terminals: [KIOSK] }))
        .mockResolvedValue(UNAVAILABLE);
      render(<StaffShiftModal {...checkout} />);
      await waitFor(() => expect(bridge.shifts.unitReadiness).toHaveBeenCalledTimes(1));
      await pressEndShift();

      await waitFor(() => expect(zeroCashDialog()).not.toBeNull());
      expect(screen.queryByText(UNAVAILABLE_TEXT)).toBeNull();
    });

    // Coordinator review 14/10/2026: the rule "no phone at all when the list
    // opened" is gone; the last good read decides, whatever idle phones are paired.
    it('closes offline after a quiet read with idle phones paired', async () => {
      bridge.shifts.unitReadiness
        .mockResolvedValueOnce(readiness({ terminals: [PHONE] }))
        .mockResolvedValue(UNAVAILABLE);
      render(<StaffShiftModal {...checkout} />);
      await waitFor(() => expect(bridge.shifts.unitReadiness).toHaveBeenCalledTimes(1));
      await pressEndShift();

      await waitFor(() => expect(zeroCashDialog()).not.toBeNull());
      expect(bridge.shifts.unitReadiness).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(UNAVAILABLE_TEXT)).toBeNull();
    });

    it('closes offline with a quiet remembered read: a till only a manager settles does not hold it', async () => {
      rememberRead({ terminals: [PHONE], pending_returns: [closedPhoneTill({ receivable: false, settle: 'manager' })] });
      bridge.shifts.unitReadiness.mockResolvedValue(UNAVAILABLE);
      render(<StaffShiftModal {...checkout} />);
      await pressEndShift();

      await waitFor(() => expect(zeroCashDialog()).not.toBeNull());
      expect(screen.queryByText(UNAVAILABLE_TEXT)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'common.actions.confirm' }));
      await waitFor(() => expect(bridge.shifts.close).toHaveBeenCalledTimes(1));
    });

    it('holds offline when the remembered read had an open phone shift, naming it as of the last check', async () => {
      rememberRead({ terminals: [PHONE], open_shifts: [openPhoneShift()] });
      bridge.shifts.unitReadiness.mockResolvedValue(UNAVAILABLE);
      render(<StaffShiftModal {...checkout} />);
      await pressEndShift();

      expect(await screen.findByText(
        `No connection. As last checked at ${hhmm(CHECKED_AT)}: Close the phone shifts before closing this shift: Maria (waiter, Phone 1). Close them on the phone, or here in staff selection.`,
      )).toBeInTheDocument();
      expect(zeroCashDialog()).toBeNull();
      expect(bridge.shifts.close).not.toHaveBeenCalled();
    });

    it('holds offline when the remembered read had a till to receive, unless a manager released its claim', async () => {
      rememberRead({ terminals: [PHONE], pending_returns: [closedPhoneTill()] });
      bridge.shifts.unitReadiness.mockResolvedValue(UNAVAILABLE);
      const view = render(<StaffShiftModal {...checkout} />);
      await pressEndShift();

      expect(await screen.findByText(new RegExp(
        `^No connection\\. As last checked at ${hhmm(CHECKED_AT)}: Receive the cash from these phone tills in staff selection before closing this shift: Luca \\(Phone 2, .*10[.,]50\\)\\.$`,
      ))).toBeInTheDocument();
      expect(bridge.shifts.close).not.toHaveBeenCalled();

      view.unmount();
      releasedIds = ['phone-close-1'];
      render(<StaffShiftModal {...checkout} />);
      await pressEndShift();
      await waitFor(() => expect(zeroCashDialog()).not.toBeNull());
    });

    it('waits only for tills this Main can receive whose claim no manager released', async () => {
      releasedIds = ['till-released'];
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ terminals: [PHONE], pending_returns: [
        closedPhoneTill({ id: 'till-released', staff_name: 'Rita' }),
        closedPhoneTill({ id: 'till-manager', staff_name: 'Dino', role_type: 'driver', receivable: false, settle: 'manager' }),
        closedPhoneTill(),
      ] }));
      render(<StaffShiftModal {...checkout} />);
      await pressEndShift();

      const blocker = await screen.findByText(/^Receive the cash from these phone tills/);
      expect(blocker).toHaveTextContent(/: Luca \(Phone 2, .*10[.,]50\)\.$/);
      expect(blocker.textContent).not.toMatch(/Rita|Dino/);
      expect(bridge.invoke).toHaveBeenCalledWith('shift_satellite_handover_recovery', { action: 'released_sources' });
      expect(bridge.shifts.close).not.toHaveBeenCalled();
    });

    it('does not wait for a receivable till whose claim a manager released', async () => {
      releasedIds = ['phone-close-1'];
      bridge.shifts.unitReadiness.mockResolvedValue(readiness({ terminals: [PHONE], pending_returns: [closedPhoneTill()] }));
      render(<StaffShiftModal {...checkout} />);
      await pressEndShift();

      await waitFor(() => expect(zeroCashDialog()).not.toBeNull());
      expect(screen.queryByText(/^Receive the cash from these phone tills/)).toBeNull();
    });

    it('keeps the legacy gate on a server without the readiness endpoint', async () => {
      bridge.shifts.unitReadiness.mockResolvedValue(NOT_FOUND);
      bridge.shifts.pendingCashReturns.mockResolvedValue({ success: true, requires_receipt_check: true, active_waiter_count: 0, returns: [{
        id: 'waiter-close', staff_id: 'waiter', staff_name: 'Luca', terminal_id: 'phone', currency: 'EUR',
        closing_cash_amount: 10.5, expected_cash_amount: 10.5, receiving_cashier_shift_id: SHIFT_ID,
      }] });
      render(<StaffShiftModal {...checkout} />);
      await pressEndShift();

      expect(await screen.findByText('modals.staffShift.satelliteCheckout.receiveBeforeClose')).toBeInTheDocument();
      expect(bridge.shifts.pendingCashReturns).toHaveBeenCalledTimes(2);
      expect(bridge.shifts.close).not.toHaveBeenCalled();
    });

    it('lets a till the server called "not a Main" close offline, as the legacy gate did', async () => {
      bridge.shifts.unitReadiness.mockResolvedValueOnce(NOT_MAIN).mockResolvedValue(UNAVAILABLE);
      bridge.shifts.pendingCashReturns.mockResolvedValue({ success: true, requires_receipt_check: false, active_waiter_count: 0, returns: [] });
      render(<StaffShiftModal {...checkout} />);
      await waitFor(() => expect(bridge.shifts.pendingCashReturns).toHaveBeenCalledTimes(1));
      await pressEndShift();

      await waitFor(() => expect(zeroCashDialog()).not.toBeNull());
      expect(screen.queryByText(UNAVAILABLE_TEXT)).toBeNull();
      expect(bridge.shifts.pendingCashReturns).toHaveBeenCalledTimes(1);
    });
  });
});
