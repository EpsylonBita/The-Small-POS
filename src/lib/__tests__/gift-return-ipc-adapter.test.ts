import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { CHANNEL_MAP, TauriBridge } from '../ipc-adapter';
import type {
  GiftReturnAuthorizeResponse,
  GiftReturnBeginRequest,
  GiftReturnResponse,
  GiftReturnStatusResponse,
  GiftReturnView,
} from '../ipc-contracts';

beforeEach(() => {
  invoke.mockReset();
});

const STAFF = '5c90bdae-6f4e-4a51-8d3e-4f5a6b7c8d9e';
const RETURN_KEY = '0f8b5c1e-3f7a-4c2d-9b6e-1a2b3c4d5e6f';

const view: GiftReturnView = {
  returnKey: RETURN_KEY,
  localPaymentId: 'local-gift-payment',
  localOrderId: 'local-order',
  action: 'refund',
  state: 'completed',
  currency: 'EUR',
  grossCents: 3000,
  requestedCents: 1200,
  reason: 'Customer returned an item',
  staffId: STAFF,
  sendCount: 1,
  lastCode: null,
  authRequired: false,
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:01.000Z',
  proof: {
    returnId: '6f7a8b9c-0000-4000-8000-000000000001',
    paymentAdjustmentId: '6f7a8b9c-0000-4000-8000-000000000002',
    returnedCents: 1200,
    totalReturnedCents: 1200,
    remainingCents: 1800,
    paymentStatus: 'completed',
    orderPaymentStatus: 'partially_paid',
    orderRemainingCents: 1200,
    cardBalanceCents: 6200,
    replayed: false,
    completedAt: '2026-09-30T10:00:01.000Z',
  },
};

describe('giftReturns IPC namespace (atomic_return_v1)', () => {
  it('maps each typed method to its native gift_return command with arg0', async () => {
    const bridge = new TauriBridge();
    const authorized: GiftReturnAuthorizeResponse = {
      success: true,
      contract: 'atomic_return_v1',
      staffId: STAFF,
      usableUntil: '2026-09-30T10:05:00.000Z',
    };
    invoke.mockResolvedValueOnce(authorized);
    await expect(bridge.giftReturns.authorize({ staffId: STAFF, pin: '1234' })).resolves.toEqual(authorized);
    expect(invoke).toHaveBeenLastCalledWith('gift_return_authorize', { arg0: { staffId: STAFF, pin: '1234' } });

    const completed: GiftReturnResponse = {
      success: true,
      contract: 'atomic_return_v1',
      outcome: 'completed',
      return: view,
    };
    const request: GiftReturnBeginRequest = {
      localPaymentId: 'local-gift-payment',
      action: 'refund',
      amountCents: 1200,
      reason: 'Customer returned an item',
    };
    invoke.mockResolvedValueOnce(completed);
    await expect(bridge.giftReturns.begin(request)).resolves.toEqual(completed);
    expect(invoke).toHaveBeenLastCalledWith('gift_return_begin', { arg0: request });

    const pending: GiftReturnResponse = {
      success: false,
      code: 'GIFT_RETURN_OUTCOME_UNKNOWN',
      error: 'The return outcome is unknown; it stays pending and can be recovered',
      outcome: 'pending',
      return: { ...view, state: 'pending', proof: null },
    };
    invoke.mockResolvedValueOnce(pending);
    await expect(bridge.giftReturns.recover({ returnKey: RETURN_KEY })).resolves.toEqual(pending);
    expect(invoke).toHaveBeenLastCalledWith('gift_return_recover', { arg0: { returnKey: RETURN_KEY } });

    const status: GiftReturnStatusResponse = {
      success: true,
      contract: 'atomic_return_v1',
      advisory: true,
      authorization: { active: false, staffId: null, usableUntil: null },
      original: null,
      returns: [view],
    };
    invoke.mockResolvedValueOnce(status);
    await expect(bridge.giftReturns.status()).resolves.toEqual(status);
    expect(invoke).toHaveBeenLastCalledWith('gift_return_status', { arg0: {} });

    invoke.mockResolvedValueOnce(status);
    await bridge.giftReturns.status({ localPaymentId: 'local-gift-payment' });
    expect(invoke).toHaveBeenLastCalledWith('gift_return_status', {
      arg0: { localPaymentId: 'local-gift-payment' },
    });
    expect(invoke).toHaveBeenCalledTimes(5);
  });

  it('registers exactly the four gift return channels', () => {
    expect(Object.keys(new TauriBridge().giftReturns)).toEqual(['authorize', 'begin', 'recover', 'status']);
    const channels = Object.entries(CHANNEL_MAP).filter(([, target]) => String(target).startsWith('giftReturns.'));
    expect(channels).toEqual([
      ['gift-return:authorize', 'giftReturns.authorize'],
      ['gift-return:begin', 'giftReturns.begin'],
      ['gift-return:recover', 'giftReturns.recover'],
      ['gift-return:status', 'giftReturns.status'],
    ]);
  });

  it('propagates native rejections unchanged', async () => {
    invoke.mockRejectedValueOnce(new Error('lock: poisoned'));
    await expect(
      new TauriBridge().giftReturns.begin({ localPaymentId: 'local-gift-payment', action: 'void', reason: 'Mistake' }),
    ).rejects.toThrow('lock: poisoned');
  });

  it('keeps PIN and staff session out of the typed return view', () => {
    const keys = [...Object.keys(view), ...Object.keys(view.proof ?? {})];
    expect(keys.some((key) => /pin|session/i.test(key))).toBe(false);
  });
});
