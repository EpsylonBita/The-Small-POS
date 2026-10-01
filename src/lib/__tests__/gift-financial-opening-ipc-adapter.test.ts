import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { CHANNEL_MAP, TauriBridge } from '../ipc-adapter';
import type {
  ShiftFinancialOpeningBeginRequest,
  ShiftFinancialOpeningClearAuthorizationResponse,
  ShiftFinancialOpeningResponse,
  ShiftFinancialOpeningStatusResponse,
  ShiftFinancialOpeningView,
} from '../ipc-contracts';

beforeEach(() => {
  invoke.mockReset();
});

const view: ShiftFinancialOpeningView = {
  openingKey: '2f6d8f7a-3c1b-4d2e-9a0b-1c2d3e4f5a6b',
  shiftId: '3a7e9b8c-4d2c-4e3f-8b1c-2d3e4f5a6b7c',
  drawerId: '4b8fac9d-5e3d-4f40-9c2d-3e4f5a6b7c8d',
  staffId: '5c90bdae-6f4e-4a51-8d3e-4f5a6b7c8d9e',
  organizationId: '6da1cebf-7a5f-4b62-9e4f-5a6b7c8d9eaf',
  branchId: '7eb2dfc0-8b6a-4c73-8f5a-6b7c8d9eafb0',
  terminalId: 'terminal-main-01',
  openingCents: 15000,
  currency: 'EUR',
  businessDate: '2026-09-29',
  checkedInAt: '2026-09-29T08:00:00.000Z',
  isDayStart: true,
  calculationVersion: 2,
  state: 'pending',
  usable: false,
  hostedAuthorization: { state: 'authorized', expiresAt: '2026-09-29T16:00:00.000Z' },
  lastPendingCode: null,
  drawer: null,
};

describe('bridge.shiftFinancialOpening', () => {
  it('sends begin as the single arg0 envelope with the transient PIN and no native-owned ids', async () => {
    const payload: ShiftFinancialOpeningBeginRequest = {
      staffId: view.staffId,
      staffName: 'Maria',
      openingCents: 15000,
      currency: 'EUR',
      pin: '1234',
    };
    const response: ShiftFinancialOpeningResponse = { success: true, opening: view };
    invoke.mockResolvedValue(response);

    await expect(new TauriBridge().shiftFinancialOpening.begin(payload)).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('shift_financial_opening_begin', { arg0: payload });
    const args = invoke.mock.calls[0]?.[1] as { arg0: Record<string, unknown> };
    expect(Object.keys(args)).toEqual(['arg0']);
    expect(Object.keys(args.arg0).sort()).toEqual(['currency', 'openingCents', 'pin', 'staffId', 'staffName']);
  });

  it('re-authorizes the same original by key with a transient PIN only', async () => {
    invoke.mockResolvedValue({ success: true, opening: view });
    await new TauriBridge().shiftFinancialOpening.authorize({ openingKey: view.openingKey, pin: '1234' });
    expect(invoke).toHaveBeenCalledWith('shift_financial_opening_authorize', {
      arg0: { openingKey: view.openingKey, pin: '1234' },
    });
  });

  it('always sends status an arg0 object and returns the openings unchanged', async () => {
    const response: ShiftFinancialOpeningStatusResponse = { success: true, openings: [view] };
    invoke.mockResolvedValue(response);
    const bridge = new TauriBridge();

    await expect(bridge.shiftFinancialOpening.status({ openingKey: view.openingKey })).resolves.toEqual(response);
    await bridge.shiftFinancialOpening.status();
    expect(invoke).toHaveBeenNthCalledWith(1, 'shift_financial_opening_status', {
      arg0: { openingKey: view.openingKey },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'shift_financial_opening_status', { arg0: {} });
  });

  it('clears the dedicated hosted authorization natively with no credential in or out', async () => {
    const response: ShiftFinancialOpeningClearAuthorizationResponse = { success: true };
    invoke.mockResolvedValue(response);
    await expect(new TauriBridge().shiftFinancialOpening.clearAuthorization()).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('shift_financial_opening_clear_authorization', { arg0: {} });
  });

  it('returns a native refusal unchanged', async () => {
    const refusal: ShiftFinancialOpeningResponse = {
      success: false,
      code: 'HOSTED_REAUTH_REQUIRED',
      error: 'Hosted cashier authorization was not accepted',
    };
    invoke.mockResolvedValue(refusal);
    await expect(
      new TauriBridge().shiftFinancialOpening.authorize({ openingKey: view.openingKey, pin: '1234' }),
    ).resolves.toEqual(refusal);
  });

  it('surfaces a native invocation rejection to the caller', async () => {
    invoke.mockRejectedValue(new Error('lock: poisoned'));
    await expect(new TauriBridge().shiftFinancialOpening.status()).rejects.toThrow('lock: poisoned');
  });

  it('declares no PIN or staff session in the native opening view', () => {
    expect(Object.keys(view).filter((key) => /pin|session/i.test(key))).toEqual([]);
    expect(Object.keys(view.hostedAuthorization).sort()).toEqual(['expiresAt', 'state']);
  });

  it('registers exactly the four financial opening channels and keeps the gift checkout channels', () => {
    expect(Object.entries(CHANNEL_MAP).filter(([channel]) => channel.startsWith('shift:financial-opening'))).toEqual([
      ['shift:financial-opening-begin', 'shiftFinancialOpening.begin'],
      ['shift:financial-opening-authorize', 'shiftFinancialOpening.authorize'],
      ['shift:financial-opening-status', 'shiftFinancialOpening.status'],
      ['shift:financial-opening-clear-authorization', 'shiftFinancialOpening.clearAuthorization'],
    ]);
    expect(Object.entries(CHANNEL_MAP).filter(([channel]) => channel.startsWith('gift-card:'))).toHaveLength(5);
  });
});
