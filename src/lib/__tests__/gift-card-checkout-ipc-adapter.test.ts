import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { CHANNEL_MAP, TauriBridge } from '../ipc-adapter';
import type {
  GiftCardFiscalDisposition,
  GiftCardReconcileOrderResponse,
  GiftCardRedeemForOrderRequest,
  GiftCardRedeemForOrderResponse,
} from '../ipc-contracts';

beforeEach(() => {
  invoke.mockReset();
});

const canonicalPayment = {
  localPaymentId: 'pay-local-1',
  remotePaymentId: 'pay-remote-1',
  method: 'gift_card' as const,
  amountCents: 1250,
  currency: 'EUR',
  transactionRef: 'gift_card:tx-1',
};

describe('bridge.giftCardCheckout', () => {
  it('sends the redeem payload as the single arg0 envelope and adds no renderer key', async () => {
    const payload: GiftCardRedeemForOrderRequest = {
      orderId: 'order-1',
      cardNumber: '4111222233334444',
      amount: 12.5,
      currency: 'EUR',
      split: { groupId: 'group-1', portionId: 'portion-1' },
    };
    const response: GiftCardRedeemForOrderResponse = {
      success: true,
      replayed: false,
      recovered: false,
      reconciliationPending: false,
      orderId: 'order-1',
      remoteOrderId: 'remote-order-1',
      idempotencyKey: 'native-owned',
      payment: canonicalPayment,
      localSettlement: { outstandingAmount: 0 },
      fiscal: {
        success: false,
        status: 'ready',
        requiresFinalize: true,
        certified: false,
        fiscalReceiptNumber: null,
      },
    };
    invoke.mockResolvedValue(response);

    await expect(new TauriBridge().giftCardCheckout.redeemForOrder(payload)).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('gift_card_redeem_for_order', { arg0: payload });
    const args = invoke.mock.calls[0]?.[1] as { arg0: Record<string, unknown> };
    expect(Object.keys(args)).toEqual(['arg0']);
    expect(Object.keys(args.arg0).sort()).toEqual(['amount', 'cardNumber', 'currency', 'orderId', 'split']);
  });

  it.each([
    ['reconcileOrder', 'gift_card_reconcile_order'],
    ['fiscalFinalize', 'gift_card_fiscal_finalize'],
    ['fiscalReconcile', 'gift_card_fiscal_reconcile'],
  ] as const)('maps %s onto %s with an {orderId} arg0', async (method, command) => {
    invoke.mockResolvedValue({ success: true });
    await new TauriBridge().giftCardCheckout[method]({ orderId: 'order-1' });
    expect(invoke).toHaveBeenCalledWith(command, { arg0: { orderId: 'order-1' } });
  });

  it('always sends readiness an arg0 object and returns ready with success:false unchanged', async () => {
    const ready: GiftCardFiscalDisposition = {
      success: false,
      status: 'ready',
      requiresFinalize: true,
      certified: false,
      fiscalReceiptNumber: null,
    };
    invoke.mockResolvedValue(ready);
    const bridge = new TauriBridge();

    await expect(bridge.giftCardCheckout.fiscalReadiness({ orderId: 'order-1' })).resolves.toEqual(ready);
    await bridge.giftCardCheckout.fiscalReadiness();
    expect(invoke).toHaveBeenNthCalledWith(1, 'gift_card_fiscal_readiness', { arg0: { orderId: 'order-1' } });
    expect(invoke).toHaveBeenNthCalledWith(2, 'gift_card_fiscal_readiness', { arg0: {} });
  });

  it('returns a reconcile answer without fiscal or idempotency key fields unchanged', async () => {
    const response: GiftCardReconcileOrderResponse = {
      success: true,
      applied: [],
      abandoned: 0,
      unresolved: 0,
      reconciliationPending: false,
      localSettlement: {},
    };
    invoke.mockResolvedValue(response);

    const result = await new TauriBridge().giftCardCheckout.reconcileOrder({ orderId: 'order-1' });
    expect(result).toEqual(response);
    expect(result).not.toHaveProperty('fiscal');
    expect(result).not.toHaveProperty('idempotencyKeys');
  });

  it('surfaces a native invocation rejection to the caller', async () => {
    invoke.mockRejectedValue(new Error('GIFT_CARD_LOCAL_STATE_UNAVAILABLE'));
    await expect(
      new TauriBridge().giftCardCheckout.fiscalFinalize({ orderId: 'order-1' }),
    ).rejects.toThrow('GIFT_CARD_LOCAL_STATE_UNAVAILABLE');
  });

  it('registers exactly the five gift checkout channels', () => {
    expect(Object.entries(CHANNEL_MAP).filter(([channel]) => channel.startsWith('gift-card:'))).toEqual([
      ['gift-card:redeem-for-order', 'giftCardCheckout.redeemForOrder'],
      ['gift-card:reconcile-order', 'giftCardCheckout.reconcileOrder'],
      ['gift-card:fiscal-readiness', 'giftCardCheckout.fiscalReadiness'],
      ['gift-card:fiscal-finalize', 'giftCardCheckout.fiscalFinalize'],
      ['gift-card:fiscal-reconcile', 'giftCardCheckout.fiscalReconcile'],
    ]);
  });
});
