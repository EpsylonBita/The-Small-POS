import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShiftFinancialOpeningView } from '../../../lib/ipc-contracts';
import type { StaffShift } from '../../types';

const fixture = vi.hoisted(() => ({
  scope: { organizationId: '', branchId: '', terminalId: '' },
  bridge: {
    terminalConfig: { getOrganizationId: vi.fn(), getBranchId: vi.fn(), getTerminalId: vi.fn(), getSetting: vi.fn(), getSettings: vi.fn() },
    shifts: { getActive: vi.fn(), getActiveByTerminal: vi.fn(), getActiveByTerminalLoose: vi.fn(), getById: vi.fn() },
    shiftFinancialOpening: { begin: vi.fn(), authorize: vi.fn(), status: vi.fn(), clearAuthorization: vi.fn() },
  },
}));
vi.mock('../../../lib', async (original) => ({ ...(await original<typeof import('../../../lib')>()), getBridge: () => fixture.bridge }));

import { ShiftProvider, useShift } from '../shift-context';
import { emitCompatEvent } from '../../../lib';
import { getCachedTerminalCredentials } from '../../services/terminal-credentials';
import { financialOpening, FinancialOpeningInvalidatedError } from '../../lib/financial-opening';

const SCOPE = { organizationId: 'org-1', branchId: 'branch-1', terminalId: 'register-public-01' };
const CASHIER = 'cashier-1';
const bridge = fixture.bridge;
const native = bridge.shiftFinancialOpening;
const probe: { current: ReturnType<typeof useShift> | null } = { current: null };
function Probe() { probe.current = useShift(); return null; }
const shiftApi = () => probe.current!;
const staffFor = (staffId: string, role = 'cashier') => ({ staffId, name: staffId, role, ...SCOPE });
function opening(patch: Partial<ShiftFinancialOpeningView> = {}): ShiftFinancialOpeningView {
  return { openingKey: 'key-1', shiftId: 'shift-1', drawerId: 'drawer-1', staffId: CASHIER, ...SCOPE, openingCents: 1250,
    currency: 'CHF', businessDate: '2026-09-29', checkedInAt: '2026-09-29T08:10:11.000Z', isDayStart: true,
    calculationVersion: 2, state: 'confirmed_usable', usable: true, hostedAuthorization: { state: 'authorized', expiresAt: null },
    lastPendingCode: null, drawer: null, ...patch };
}
function row(view = opening()) {
  return { id: view.shiftId, staff_id: view.staffId, staff_name: 'Cashier', branch_id: view.branchId, terminal_id: view.terminalId,
    role_type: 'cashier', check_in_time: view.checkedInAt, opening_cash_amount: view.openingCents / 100, status: 'active',
    total_orders_count: 0, total_sales_amount: 0, total_cash_sales: 0, total_card_sales: 0,
    created_at: view.checkedInAt, updated_at: view.checkedInAt } as unknown as StaffShift;
}
const beginInput = { openingKey: 'key-1', openingCents: 1250, currency: 'CHF', staffId: CASHIER, staffName: 'Cashier', pin: '1111' } as
  Parameters<typeof financialOpening.begin>[0];
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const clears = () => native.clearAuthorization.mock.calls.length;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
async function emit(event: string) {
  await act(async () => { emitCompatEvent(event, {}); });
  await settle();
}
async function mount() {
  render(<ShiftProvider><Probe /></ShiftProvider>);
  await settle(); await settle();
}

describe('ShiftProvider dedicated financial authority lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    Object.assign(fixture.scope, SCOPE);
    bridge.terminalConfig.getOrganizationId.mockImplementation(async () => fixture.scope.organizationId);
    bridge.terminalConfig.getBranchId.mockImplementation(async () => fixture.scope.branchId);
    bridge.terminalConfig.getTerminalId.mockImplementation(async () => fixture.scope.terminalId);
    bridge.terminalConfig.getSetting.mockResolvedValue(null);
    bridge.terminalConfig.getSettings.mockResolvedValue(null);
    bridge.shifts.getActive.mockResolvedValue(null);
    bridge.shifts.getActiveByTerminal.mockResolvedValue(null);
    bridge.shifts.getActiveByTerminalLoose.mockResolvedValue(null);
    bridge.shifts.getById.mockResolvedValue(null);
    native.begin.mockResolvedValue({ success: true, opening: opening({ state: 'pending', usable: false }) });
    native.authorize.mockResolvedValue({ success: true, opening: opening() });
    native.status.mockResolvedValue({ success: true, openings: [opening()] });
    native.clearAuthorization.mockResolvedValue({ success: true });
  });
  afterEach(async () => {
    cleanup();
    // An explicit successful clear leaves the module-level barrier clean for the next case.
    native.clearAuthorization.mockResolvedValue({ success: true });
    await financialOpening.clearAuthorization();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it.each(['terminal-settings-updated', 'terminal-config-updated', 'terminal-credentials-updated'])(
    '%s re-reads canonical scope: unchanged keeps authority, each changed component invalidates', async (event) => {
      await mount();
      await emit(event);
      expect(clears()).toBe(0);
      for (const key of ['organizationId', 'branchId', 'terminalId'] as const) {
        const before = clears();
        fixture.scope[key] = `${fixture.scope[key]}-next`;
        await emit(event);
        expect(clears()).toBe(before + 1);
        await emit(event);
        expect(clears()).toBe(before + 1);
      }
    });

  it('invalidates on missing, placeholder or failed canonical reads instead of trusting the cached scope', async () => {
    await mount();
    expect(getCachedTerminalCredentials()).toMatchObject(SCOPE);
    fixture.scope.branchId = '';
    await emit('terminal-config-updated');
    expect(clears()).toBe(1);
    fixture.scope.branchId = SCOPE.branchId;
    fixture.scope.terminalId = 'default-terminal';
    await emit('terminal-config-updated');
    expect(clears()).toBe(2);
    fixture.scope.terminalId = SCOPE.terminalId;
    bridge.terminalConfig.getOrganizationId.mockRejectedValue(new Error('ipc unavailable'));
    await emit('terminal-config-updated');
    expect(clears()).toBe(3);
    expect(getCachedTerminalCredentials()).toMatchObject(SCOPE);
    bridge.terminalConfig.getOrganizationId.mockImplementation(async () => fixture.scope.organizationId);
    await emit('terminal-config-updated');
    expect(clears()).toBe(3);
  });

  it('fences overlapping reads: only the latest decides and a late old reply cannot restore the old baseline', async () => {
    await mount();
    const held = deferred<string>();
    bridge.terminalConfig.getTerminalId.mockImplementationOnce(() => held.promise);
    await act(async () => { emitCompatEvent('terminal-config-updated', {}); });
    fixture.scope.terminalId = 'register-public-02';
    await emit('terminal-config-updated');
    expect(clears()).toBe(1);
    held.resolve(SCOPE.terminalId);
    await settle();
    expect(clears()).toBe(1);
    await emit('terminal-config-updated');
    expect(clears()).toBe(1);
    fixture.scope.terminalId = SCOPE.terminalId;
    await emit('terminal-config-updated');
    expect(clears()).toBe(2);
  });

  it('verifies scope while an active shift exists and keeps that shift', async () => {
    await mount();
    act(() => shiftApi().setActiveShiftImmediate(row()));
    fixture.scope.organizationId = 'org-2';
    await emit('terminal-settings-updated');
    expect(clears()).toBe(1);
    expect(shiftApi().activeShift?.id).toBe('shift-1');
  });

  it('invalidates synchronously on staff replacement, null staff and clearShift but not on unchanged staff', async () => {
    await mount();
    act(() => { shiftApi().setStaff(staffFor('manager-1', 'manager')); expect(clears()).toBe(1); });
    await settle();
    act(() => shiftApi().setStaff(staffFor('manager-1', 'manager')));
    expect(clears()).toBe(1);
    act(() => { shiftApi().setStaff(staffFor('other-2')); expect(clears()).toBe(2); });
    act(() => { shiftApi().setStaff(null); expect(clears()).toBe(3); });
    act(() => { shiftApi().setStaff(staffFor('other-2')); shiftApi().setActiveShiftImmediate(row()); });
    await settle();
    expect(shiftApi().activeShift?.id).toBe('shift-1');
    const before = clears();
    act(() => { shiftApi().clearShift(); expect(clears()).toBe(before + 1); });
    expect(shiftApi().staff).toBeNull();
    expect(shiftApi().activeShift).toBeNull();
  });

  it('keeps authority for null or manager -> the exact authorized cashier tuple and clears for unrelated staff', async () => {
    await mount();
    await act(async () => { await financialOpening.status('key-1'); });
    act(() => { shiftApi().setStaff(staffFor(CASHIER)); shiftApi().setActiveShiftImmediate(row()); });
    expect(clears()).toBe(0);
    expect(shiftApi().staff?.staffId).toBe(CASHIER);
    expect(shiftApi().activeShift?.id).toBe('shift-1');

    act(() => shiftApi().setStaff(staffFor('manager-1', 'manager')));
    expect(clears()).toBe(1);
    await act(async () => { await financialOpening.status('key-1'); });
    act(() => shiftApi().setStaff(staffFor(CASHIER)));
    expect(clears()).toBe(1);

    act(() => shiftApi().setStaff(staffFor('other-2')));
    expect(clears()).toBe(2);
  });

  it.each([
    ['a different organization', { organizationId: 'org-2' }],
    ['a different branch', { branchId: 'branch-2' }],
    ['a different public terminal', { terminalId: 'register-public-02' }],
    ['required hosted authorization', { hostedAuthorization: { state: 'required', expiresAt: null } }],
    ['an unusable original', { usable: false }],
  ] as const)('does not preserve publication from %s', async (_label, patch) => {
    await mount();
    act(() => shiftApi().setStaff(staffFor('manager-1', 'manager')));
    native.status.mockResolvedValue({ success: true, openings: [opening(patch as Partial<ShiftFinancialOpeningView>)] });
    await act(async () => { await financialOpening.status('key-1'); });
    act(() => shiftApi().setStaff(staffFor(CASHIER)));
    expect(clears()).toBe(2);
  });

  it('starts clearing beside a pending begin, refuses its late reply and blocks issuance after a failed clear', async () => {
    await mount();
    const pendingBegin = deferred();
    native.begin.mockReturnValueOnce(pendingBegin.promise);
    const lateBegin = financialOpening.begin(beginInput);
    expect(native.begin).toHaveBeenCalledTimes(1);
    const heldClear = deferred();
    native.clearAuthorization.mockReturnValueOnce(heldClear.promise);
    act(() => shiftApi().setStaff(staffFor('other-2')));
    expect(clears()).toBe(1);
    const nextBegin = financialOpening.begin(beginInput);
    await settle();
    expect(native.begin).toHaveBeenCalledTimes(1);
    pendingBegin.resolve({ success: true, opening: opening() });
    await expect(lateBegin).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    heldClear.resolve({ success: true });
    await expect(nextBegin).resolves.toMatchObject({ success: true });
    expect(native.begin).toHaveBeenCalledTimes(2);

    native.clearAuthorization.mockRejectedValueOnce(new Error('clear failed'));
    act(() => shiftApi().setStaff(staffFor('third-3')));
    await expect(financialOpening.begin(beginInput)).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    await expect(financialOpening.authorize('key-1', '1111')).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    await expect(financialOpening.status('key-1')).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    await expect(financialOpening.readConfirmedShift(opening())).resolves.toBeNull();
    expect(native.begin).toHaveBeenCalledTimes(2);
    expect(native.authorize).not.toHaveBeenCalled();
    expect(native.status).not.toHaveBeenCalled();
    expect(bridge.shifts.getById).not.toHaveBeenCalled();

    native.clearAuthorization.mockResolvedValueOnce({ success: false });
    await financialOpening.clearAuthorization();
    await expect(financialOpening.begin(beginInput)).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    await financialOpening.clearAuthorization();
    await expect(financialOpening.begin(beginInput)).resolves.toMatchObject({ success: true });
    expect(native.begin).toHaveBeenCalledTimes(3);
  });

  it('refuses late status and actual-row replies after invalidation so they cannot authorize publication', async () => {
    await mount();
    const heldStatus = deferred();
    const heldRow = deferred();
    native.status.mockReturnValueOnce(heldStatus.promise);
    bridge.shifts.getById.mockReturnValueOnce(heldRow.promise);
    const lateStatus = financialOpening.status('key-1');
    const lateRow = financialOpening.readConfirmedShift(opening());
    expect(bridge.shifts.getById).toHaveBeenCalledWith('shift-1');
    act(() => shiftApi().clearShift());
    expect(clears()).toBe(1);
    heldStatus.resolve({ success: true, openings: [opening()] });
    heldRow.resolve({ success: true, data: row() });
    await expect(lateStatus).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    await expect(lateRow).resolves.toBeNull();
    act(() => shiftApi().setStaff(staffFor(CASHIER)));
    expect(clears()).toBe(2);
  });

  it('lets only the latest clear attempt decide, so an older success cannot erase a newer failure', async () => {
    await mount();
    const older = deferred();
    const newer = deferred();
    native.clearAuthorization.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    act(() => shiftApi().setStaff(staffFor('a-1')));
    act(() => shiftApi().setStaff(staffFor('b-2')));
    expect(clears()).toBe(2);
    newer.reject(new Error('clear failed'));
    await settle();
    older.resolve({ success: true });
    await settle();
    await expect(financialOpening.begin(beginInput)).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    expect(native.begin).not.toHaveBeenCalled();
  });
});
