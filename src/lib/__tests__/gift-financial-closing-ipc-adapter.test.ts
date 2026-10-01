import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { CHANNEL_MAP, TauriBridge } from '../ipc-adapter';
import type {
  ShiftFinancialClosingAuthorizationView,
  ShiftFinancialClosingAuthorizeRequest,
  ShiftFinancialClosingAuthorizeResponse,
  ShiftFinancialClosingListPendingResponse,
  ShiftFinancialClosingRecoveryView,
  ShiftFinancialClosingRetryResponse,
  ShiftFinancialClosingStatusResponse,
} from '../ipc-contracts';

beforeEach(() => {
  invoke.mockReset();
});

const closing: ShiftFinancialClosingAuthorizationView = {
  closingKey: '5d6e7f8a-9b0c-4d1e-8f2a-4b5c6d7e8f9a',
  openingKey: '2f6d8f7a-3c1b-4d2e-9a0b-1c2d3e4f5a6b',
  shiftId: '3a7e9b8c-4d2c-4e3f-8b1c-2d3e4f5a6b7c',
  drawerId: '4b8fac9d-5e3d-4f40-9c2d-3e4f5a6b7c8d',
  staffId: '5c90bdae-6f4e-4a51-8d3e-4f5a6b7c8d9e',
  organizationId: '6da1cebf-7a5f-4b62-9e4f-5a6b7c8d9eaf',
  branchId: '7eb2dfc0-8b6a-4c73-8f5a-6b7c8d9eafb0',
  terminalId: 'terminal-main-01',
  state: 'pending',
  hostedAuthorization: { state: 'authorized', expiresAt: '2026-09-30T16:00:00.000Z' },
};

const pending: ShiftFinancialClosingRecoveryView = {
  closingKey: closing.closingKey,
  openingKey: closing.openingKey,
  shiftId: closing.shiftId,
  state: 'pending',
  code: 'TRANSPORT_UNCONFIRMED',
  authorizationRequired: false,
  currency: 'EUR',
  countedCents: 12345,
  queue: { status: 'pending', nextRetryAt: '2026-09-30T18:00:31.000Z' },
  localPreview: {
    closedAt: '2026-09-30T18:00:00.000Z',
    ordinaryExpectedCents: 10000,
    giftCashCents: 2000,
    expectedCents: 12000,
    varianceCents: 345,
  },
  canonical: null,
};

const keyed = { closingKey: closing.closingKey, staffId: closing.staffId };

describe('bridge.shiftFinancialClosing', () => {
  it('renews the retained closing by key with a transient PIN only', async () => {
    const payload: ShiftFinancialClosingAuthorizeRequest = { closingKey: closing.closingKey, pin: '1234' };
    const response: ShiftFinancialClosingAuthorizeResponse = { success: true, closing };
    invoke.mockResolvedValue(response);

    await expect(new TauriBridge().shiftFinancialClosing.authorize(payload)).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('shift_financial_closing_authorize', { arg0: payload });
    const args = invoke.mock.calls[0]?.[1] as { arg0: Record<string, unknown> };
    expect(Object.keys(args)).toEqual(['arg0']);
    expect(Object.keys(args.arg0).sort()).toEqual(['closingKey', 'pin']);
  });

  it('returns a native refusal unchanged without falling back to the opening authorization', async () => {
    const refusal: ShiftFinancialClosingAuthorizeResponse = {
      success: false,
      code: 'CLOSING_NOT_PENDING',
      error: 'This financial closing is no longer pending',
    };
    invoke.mockResolvedValue(refusal);
    await expect(
      new TauriBridge().shiftFinancialClosing.authorize({ closingKey: closing.closingKey, pin: '1234' }),
    ).resolves.toEqual(refusal);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith('shift_financial_opening_authorize', expect.anything());
  });

  it('surfaces a native invocation rejection to the caller', async () => {
    invoke.mockRejectedValue(new Error('lock: poisoned'));
    await expect(
      new TauriBridge().shiftFinancialClosing.authorize({ closingKey: closing.closingKey, pin: '1234' }),
    ).rejects.toThrow('lock: poisoned');
  });

  it('declares no PIN or staff session in the closing authorization view', () => {
    expect(Object.keys(closing).filter((key) => /pin|session/i.test(key))).toEqual([]);
    expect(Object.keys(closing.hostedAuthorization).sort()).toEqual(['expiresAt', 'state']);
  });

  it('registers the four distinct closing channels beside the four opening channels', () => {
    expect(Object.entries(CHANNEL_MAP).filter(([channel]) => channel.startsWith('shift:financial-closing'))).toEqual([
      ['shift:financial-closing-authorize', 'shiftFinancialClosing.authorize'],
      ['shift:financial-closing-list-pending', 'shiftFinancialClosing.listPending'],
      ['shift:financial-closing-status', 'shiftFinancialClosing.status'],
      ['shift:financial-closing-retry', 'shiftFinancialClosing.retry'],
    ]);
    expect(
      Object.entries(CHANNEL_MAP).filter(([channel]) => channel.startsWith('shift:financial-opening')),
    ).toHaveLength(4);
  });
});

describe('bridge.shiftFinancialClosing recovery', () => {
  it("lists the selected original cashier's retained closings by staff id only", async () => {
    const response: ShiftFinancialClosingListPendingResponse = {
      success: true,
      closings: [pending],
      truncated: false,
    };
    invoke.mockResolvedValue(response);

    await expect(
      new TauriBridge().shiftFinancialClosing.listPending({ staffId: closing.staffId }),
    ).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('shift_financial_closing_list_pending', {
      arg0: { staffId: closing.staffId },
    });
  });

  it('reads one closing by key and cashier and passes the canonical view through unchanged', async () => {
    const response: ShiftFinancialClosingStatusResponse = {
      success: true,
      closing: {
        ...pending,
        state: 'confirmed',
        code: null,
        queue: null,
        localPreview: null,
        canonical: {
          closedAt: '2026-09-30T18:00:07.250Z',
          confirmedAt: '2026-09-30T18:02:00.000Z',
          countedCents: 14000,
          ordinaryExpectedCents: 12345,
          giftCashCents: 2000,
          expectedCents: 14345,
          varianceCents: -345,
        },
      },
    };
    invoke.mockResolvedValue(response);

    await expect(new TauriBridge().shiftFinancialClosing.status(keyed)).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('shift_financial_closing_status', { arg0: keyed });
    const args = invoke.mock.calls[0]?.[1] as { arg0: Record<string, unknown> };
    expect(Object.keys(args.arg0).sort()).toEqual(['closingKey', 'staffId']);
  });

  it('retries only through the native closing retry and reports queued, not completion', async () => {
    const response: ShiftFinancialClosingRetryResponse = {
      success: true,
      closing: { closingKey: closing.closingKey, shiftId: closing.shiftId, state: 'queued' },
    };
    invoke.mockResolvedValue(response);

    await expect(new TauriBridge().shiftFinancialClosing.retry(keyed)).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('shift_financial_closing_retry', { arg0: keyed });
  });

  it('returns native recovery refusals unchanged', async () => {
    for (const [method, code] of [
      ['listPending', 'TERMINAL_SCOPE_UNAVAILABLE'],
      ['status', 'CLOSING_NOT_FOUND'],
      ['retry', 'HOSTED_REAUTH_REQUIRED'],
    ] as const) {
      invoke.mockReset();
      const refusal = { success: false as const, code, error: 'refused' };
      invoke.mockResolvedValue(refusal);
      await expect(new TauriBridge().shiftFinancialClosing[method](keyed)).resolves.toEqual(refusal);
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  });

  it('declares only nonsecret identity, count, state and money views', () => {
    expect(Object.keys(pending).sort()).toEqual([
      'authorizationRequired',
      'canonical',
      'closingKey',
      'code',
      'countedCents',
      'currency',
      'localPreview',
      'openingKey',
      'queue',
      'shiftId',
      'state',
    ]);
    expect(Object.keys(pending).filter((key) => /pin|session|body|request|diagnostic|staff/i.test(key))).toEqual(
      [],
    );
  });
});
