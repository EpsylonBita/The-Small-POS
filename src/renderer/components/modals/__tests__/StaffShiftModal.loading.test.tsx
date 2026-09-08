import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { bridge, translation } = vi.hoisted(() => ({
  translation: { t: (key: string, fallback?: string | { defaultValue?: string }) =>
    typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key },
  bridge: {
    sessionStaff: null as null | { staffId: string; branchId: string; terminalId: string },
    terminalConfig: { getTerminalId: vi.fn(async () => 'terminal-a'), getBranchId: vi.fn(async () => 'branch-a'), getOrganizationId: vi.fn(async () => 'org-a') },
    settings: { get: vi.fn(), updateLocal: vi.fn() },
    staffAuth: { refreshDirectory: vi.fn(), verifyCheckInPin: vi.fn() },
    staffSchedule: { list: vi.fn() },
    shifts: { getActive: vi.fn(), getActiveForBranch: vi.fn(), getCheckInEligibility: vi.fn(), getActiveCashierByTerminal: vi.fn(), open: vi.fn() },
  },
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => translation,
}));
vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ language: 'en', setLanguage: vi.fn(), t: translation.t }),
}));
vi.mock('../../../contexts/shift-context', () => ({
  useShift: () => ({ staff: bridge.sessionStaff, activeShift: null, isShiftActive: false,
    refreshActiveShift: vi.fn(), setStaff: vi.fn(), setActiveShiftImmediate: vi.fn() }),
}));
vi.mock('../../../hooks/useTerminalSettings', () => {
  const useTerminalSettings = () => ({ settings: {}, loading: false, error: null,
    refresh: vi.fn(), getSetting: (_category: string, key: string) => (
      key === 'branch_id' ? 'branch-a' : key === 'terminal_id' ? 'terminal-a' : undefined
    ) });
  return { default: useTerminalSettings, useTerminalSettings };
});
vi.mock('../../../utils/api-helpers', () => ({ posApiGet: vi.fn(async () => ({ success: false })) }));
vi.mock('../../../utils/fiscal-integration-entitlement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/fiscal-integration-entitlement')>()),
  loadFiscalOrderReportingEntitlement: vi.fn(async () => false),
}));
vi.mock('../../../../lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib')>()), getBridge: () => bridge,
}));
vi.mock('../../ui/pos-glass-components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ui/pos-glass-components')>()),
  LiquidGlassModal: ({ isOpen, children, footer, onClose }: any) => isOpen ? (
    <div><button aria-label="Dismiss modal" onClick={onClose} />{children}{footer}</div>
  ) : null,
}));

import { StaffShiftModal } from '../StaffShiftModal';

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const member = (id: string, name: string) => ({ id, name, first_name: name, last_name: '',
  role_name: 'driver', roles: [], can_login_pos: true, has_pin: true, is_active: true });
const cached = [member('a', 'Cached Alice'), member('b', 'Cached Bob')];
const schedule = (staff: any[]) => ({ success: true, data: { staff } });
const props = { isOpen: true, onClose: vi.fn(), mode: 'checkin' as const };

describe('StaffShiftModal staff loading', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    bridge.sessionStaff = null;
    bridge.settings.get.mockResolvedValue(JSON.stringify({ branch_id: 'branch-a', staff: cached }));
    bridge.settings.updateLocal.mockResolvedValue({ success: true });
    bridge.staffAuth.refreshDirectory.mockResolvedValue({ success: true, currentTerminalId: 'terminal-a', staff: [] });
    bridge.shifts.getActive.mockResolvedValue(null);
    bridge.shifts.getActiveForBranch.mockResolvedValue([
      { id: 'shift-b', staff_id: 'b', branch_id: 'branch-a', status: 'active', role_type: 'driver' },
    ]);
    bridge.staffSchedule.list.mockResolvedValue(schedule(cached));
    bridge.terminalConfig.getTerminalId.mockResolvedValue('terminal-a');
    bridge.terminalConfig.getBranchId.mockResolvedValue('branch-a');
    bridge.terminalConfig.getOrganizationId.mockResolvedValue('org-a');
  });
  afterEach(cleanup);

  it('renders offline cache immediately and shares one active-shift snapshot with the network refresh', async () => {
    const refresh = deferred();
    bridge.staffSchedule.list.mockReturnValue(refresh.promise);
    render(<StaffShiftModal {...props} />);
    await screen.findByText('Cached Alice');
    expect(bridge.shifts.getActiveForBranch).toHaveBeenCalledExactlyOnceWith('branch-a');
    expect(bridge.shifts.getActive).not.toHaveBeenCalled();
    await act(async () => refresh.resolve(schedule([...cached, member('c', 'Fresh Carol')])));
    await screen.findByText('Fresh Carol');
    expect(bridge.shifts.getActiveForBranch).toHaveBeenCalledTimes(1);
    expect(bridge.settings.get).toHaveBeenCalledTimes(1);
    expect(bridge.staffAuth.refreshDirectory).toHaveBeenCalledTimes(1);
  });

  it('retains cached staff and the same local shift snapshot when the network fails', async () => {
    bridge.staffSchedule.list.mockRejectedValue(new Error('offline'));
    render(<StaffShiftModal {...props} />);
    await screen.findByText('Cached Alice');
    await waitFor(() => expect(bridge.staffSchedule.list).toHaveBeenCalledTimes(1));
    expect(bridge.shifts.getActiveForBranch).toHaveBeenCalledTimes(1);
    expect(bridge.settings.get).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('offline')).toBeNull();
  });

  it('ignores old staff, shift, and directory responses after close and reopen', async () => {
    const oldSchedule = deferred();
    const oldShifts = deferred();
    const oldDirectory = deferred();
    bridge.staffSchedule.list.mockReturnValueOnce(oldSchedule.promise);
    bridge.shifts.getActiveForBranch.mockReturnValueOnce(oldShifts.promise);
    bridge.staffAuth.refreshDirectory.mockReturnValueOnce(oldDirectory.promise);
    const view = render(<StaffShiftModal {...props} />);
    await screen.findByText('Cached Alice');
    await waitFor(() => expect(bridge.staffSchedule.list).toHaveBeenCalledTimes(1));
    view.rerender(<StaffShiftModal {...props} isOpen={false} />);
    bridge.staffSchedule.list.mockResolvedValue(schedule([member('new', 'New Session')]));
    view.rerender(<StaffShiftModal {...props} />);
    await screen.findByText('New Session');
    bridge.settings.updateLocal.mockClear();
    await act(async () => {
      oldSchedule.resolve(schedule([member('old', 'Stale Session')]));
      oldShifts.resolve([{ id: 'old-shift', staff_id: 'new', status: 'active', role_type: 'driver' }]);
      oldDirectory.resolve({ success: true, currentTerminalId: 'terminal-a', staff: [{ id: 'new',
        currentShift: { terminalId: 'other', terminalName: 'Stale Terminal', role: 'driver' } }] });
    });
    expect(screen.getByText('New Session')).toBeInTheDocument();
    expect(screen.queryByText('Stale Session')).toBeNull();
    expect(screen.queryByText('Stale Terminal')).toBeNull();
    expect(bridge.settings.updateLocal).not.toHaveBeenCalled();
  });

  it('uses a cache populated by the parallel directory when an initially cold schedule request fails', async () => {
    const refresh = deferred();
    bridge.settings.get.mockResolvedValueOnce('');
    bridge.staffSchedule.list.mockReturnValue(refresh.promise);
    render(<StaffShiftModal {...props} />);
    await waitFor(() => expect(bridge.staffAuth.refreshDirectory).toHaveBeenCalledTimes(1));
    await act(async () => refresh.reject(new Error('schedule unavailable')));
    await screen.findByText('Cached Alice');
    expect(bridge.settings.get).toHaveBeenCalledTimes(2);
    expect(bridge.shifts.getActiveForBranch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('schedule unavailable')).toBeNull();
  });

  it('keeps PIN verification disabled when a background staff refresh finishes', async () => {
    const refresh = deferred();
    const verification = deferred();
    bridge.staffSchedule.list.mockReturnValue(refresh.promise);
    bridge.staffAuth.verifyCheckInPin.mockReturnValue(verification.promise);
    render(<StaffShiftModal {...props} />);
    fireEvent.click(await screen.findByText('Cached Alice'));
    const digit = await screen.findByRole('button', { name: '1', exact: true });
    for (let i = 0; i < 4; i += 1) fireEvent.click(digit);
    fireEvent.click(screen.getByRole('button', { name: 'modals.staffShift.continue' }));
    await waitFor(() => expect(bridge.staffAuth.verifyCheckInPin).toHaveBeenCalledTimes(1));
    await act(async () => refresh.resolve(schedule(cached)));
    expect(screen.getByRole('button', { name: 'modals.staffShift.authenticating' })).toBeDisabled();
    await act(async () => verification.resolve({ success: false, reasonCode: 'invalid_pin' }));
  });

  it('does not carry a cancelled cold load into a subsequent direct checkout open', async () => {
    const cache = deferred();
    bridge.settings.get.mockReturnValue(cache.promise);
    const onClose = vi.fn();
    const view = render(<StaffShiftModal {...props} onClose={onClose} />);
    await waitFor(() => expect(bridge.settings.get).toHaveBeenCalledTimes(1));
    view.rerender(<StaffShiftModal {...props} onClose={onClose} isOpen={false} />);
    view.rerender(<StaffShiftModal {...props} onClose={onClose} mode="checkout" />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss modal' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => cache.resolve(''));
    expect(bridge.staffSchedule.list).not.toHaveBeenCalled();
  });

  it('normalizes an authenticated waiter role before opening a shift and preserves native errors', async () => {
    bridge.sessionStaff = { staffId: 'manager', branchId: 'branch-a', terminalId: 'terminal-a' };
    const waiter = { ...member('waiter-a', 'Ana Waiter'), role_name: 'waiter', roles: [
      { role_id: 'waiter-role', role_name: 'waiter', role_display_name: 'Waiter', is_primary: true },
    ] };
    bridge.settings.get.mockResolvedValue(JSON.stringify({ branch_id: 'branch-a', staff: [waiter] }));
    bridge.staffSchedule.list.mockResolvedValue(schedule([waiter]));
    bridge.staffAuth.verifyCheckInPin.mockResolvedValue({ success: true });
    bridge.shifts.getCheckInEligibility.mockResolvedValue({ requiresCashierFirst: false });
    bridge.shifts.getActiveCashierByTerminal.mockResolvedValue({ id: 'cashier-shift' });
    bridge.shifts.open.mockRejectedValue('The cashier shift was closed. Open a cashier shift first.');
    render(<StaffShiftModal {...props} />);
    fireEvent.click(await screen.findByText('Ana Waiter'));
    const digit = await screen.findByRole('button', { name: '1', exact: true });
    for (let i = 0; i < 4; i += 1) fireEvent.click(digit);
    fireEvent.click(screen.getByRole('button', { name: 'modals.staffShift.continue' }));
    fireEvent.click(await screen.findByRole('button', { name: /waiter/i }));
    expect(bridge.shifts.open).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'modals.staffShift.skipCash' }));
    await waitFor(() => expect(bridge.shifts.open).toHaveBeenCalledWith(expect.objectContaining({ roleType: 'server' })));
    await screen.findByText('The cashier shift was closed. Open a cashier shift first.');
  });
});
