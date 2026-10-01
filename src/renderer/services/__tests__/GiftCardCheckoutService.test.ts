import { describe, expect, it, vi } from 'vitest';

// GiftCardsApiService builds its singleton at import; every checkout call here uses an injected bridge.
vi.mock('../../../lib', () => ({ getBridge: () => ({}) }));

import * as checkout from '../GiftCardCheckoutService';
import {
  GiftCardCheckoutService,
  classifyGiftCardFiscal,
  type GiftCardAdmission,
  type GiftCardCheckoutBridge,
  type GiftCardOrdinaryHold,
  type GiftCardOrdinaryResolution,
  type GiftCardTenderInput,
} from '../GiftCardCheckoutService';

const SCOPE = { organizationId: 'org-1', terminalId: 'term-1' };
const CARD_NUMBER = '4111222233334444';
const CARD = { balance: 50, currency: 'EUR', status: 'active', expiresAt: null };
/** The direct redeem `payment`, which states its method and reference. */
const PAYMENT = {
  localPaymentId: 'pay-1',
  remotePaymentId: 'remote-pay-1',
  method: 'gift_card',
  amountCents: 2000,
  currency: 'EUR',
  transactionRef: 'gift_card:tx-1',
};
/** One `applied` row exactly as native gift_card_reconcile_order reports it: no method or reference. */
const NATIVE_ROW = {
  idempotencyKey: 'native-owned-key-1',
  localPaymentId: 'pay-1',
  remotePaymentId: 'remote-pay-1',
  amountCents: 2000,
  currency: 'EUR',
};
/** That row as adopted: the command implies the gift method, and no reference or key is carried. */
const RECOVERED = {
  localPaymentId: 'pay-1',
  remotePaymentId: 'remote-pay-1',
  method: 'gift_card',
  amountCents: 2000,
  currency: 'EUR',
  transactionRef: null,
};
const GIFT_ROW = {
  id: 'pay-1',
  method: 'gift_card',
  amount: 20,
  currency: 'EUR',
  transactionRef: 'gift_card:tx-1',
  refundedAmount: 0,
};
const CLEAR = { success: true, applied: [], abandoned: 0, unresolved: 0, reconciliationPending: false };

/** The full native gift_card_reconcile_order answer. */
function reconciled(applied: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    code: null,
    error: null,
    orderId: 'order-1',
    applied,
    abandoned: 0,
    unresolved: 0,
    reconciliationPending: false,
    localSettlement: {},
    ...overrides,
  };
}

/** Fields native `disposition()` puts on every order-scoped fiscal state. */
const DISPOSITION = { code: null, error: null, certified: false, fiscalReceiptNumber: null, orderId: 'order-1' };
const ORDER = {
  ready: { ...DISPOSITION, status: 'ready', requiresFinalize: true },
  partial: {
    ...DISPOSITION,
    status: 'partial',
    code: 'GIFT_CARD_FISCAL_PARTIAL_SETTLEMENT',
    requiresFinalize: false,
  },
  pending: {
    ...DISPOSITION,
    status: 'pending',
    code: 'GIFT_CARD_FISCAL_RECONCILIATION_REQUIRED',
    operationId: 'op-1',
    requiresReconciliation: true,
  },
  approved: {
    ...DISPOSITION,
    status: 'approved',
    operationId: 'op-1',
    alreadyIssued: true,
    requiresReconciliation: false,
  },
  prior: {
    ...DISPOSITION,
    status: 'pending',
    code: 'GIFT_CARD_FISCAL_PRIOR_RECEIPT_UNRESOLVED',
    requiresReconciliation: true,
    requiresFinalize: false,
  },
  unavailable: { ...DISPOSITION, status: 'unavailable', code: 'GIFT_CARD_LOCAL_STATE_UNAVAILABLE' },
  issued: { ...DISPOSITION, status: 'not_required', code: 'GIFT_CARD_FISCAL_ALREADY_ISSUED' },
};
/** Top-level readiness: whether the route would take a fresh gift debit now. */
const ROUTE = {
  ready: { status: 'ready', code: null, cloudRoute: 'allowed' },
  started: { status: 'unsupported', code: 'GIFT_CARD_FISCAL_ALREADY_STARTED', cloudRoute: 'allowed' },
  aade: { status: 'unsupported', code: 'GIFT_CARD_FISCAL_DIRECT_AADE_UNSUPPORTED', cloudRoute: 'direct_aade' },
  voucher: { status: 'unsupported', code: 'GIFT_CARD_FISCAL_VOUCHER_NOT_CONFIGURED', cloudRoute: 'allowed' },
  unavailable: { status: 'unavailable', code: 'GIFT_CARD_FISCAL_ROUTE_UNAVAILABLE', cloudRoute: 'unavailable' },
  prior: { status: 'pending', code: 'GIFT_CARD_FISCAL_PRIOR_RECEIPT_UNRESOLVED', cloudRoute: 'allowed' },
};

/** Order-scoped native gift_card_fiscal_readiness: the route answer wrapping this order's state. */
function readiness(route: Record<string, unknown>, order?: unknown) {
  return {
    success: route.status === 'ready',
    error: null,
    certified: false,
    fiscalReceiptNumber: null,
    orderId: 'order-1',
    ...route,
    ...(order === undefined ? {} : { order }),
  };
}

const fn = (value?: unknown) => vi.fn(async (..._args: unknown[]): Promise<unknown> => value);

function deferred() {
  let settle: (value: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: unknown) => settle(value) };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function snapshot(orderId: string, total: number, paid: number, rows: unknown[] = []) {
  return {
    success: true,
    orderId,
    orderTotal: total,
    netPaid: paid,
    outstandingAmount: Math.round((total - paid) * 100) / 100,
    completedPayments: rows,
    generation: `gen-${paid}`,
  };
}

function harness() {
  const bridge = {
    giftCardCheckout: {
      redeemForOrder: fn(),
      reconcileOrder: fn(CLEAR),
      fiscalReadiness: fn(),
      fiscalFinalize: fn(),
      fiscalReconcile: fn(),
    },
    payments: {
      getSettlementSnapshot: vi.fn(
        async (orderId: unknown): Promise<unknown> => snapshot(String(orderId), 20, 0),
      ),
      recordPayment: fn(),
      processPayment: fn(),
    },
    ecr: { processPayment: fn() },
  };
  const service = new GiftCardCheckoutService({
    bridge: () => bridge as unknown as GiftCardCheckoutBridge,
    now: () => Date.parse('2026-09-29T12:00:00Z'),
  });
  const admissions: GiftCardAdmission[] = [];
  service.subscribe((admission) => admissions.push(admission));
  return { bridge, service, admissions };
}

type Harness = ReturnType<typeof harness>;

const tender = (overrides: Partial<GiftCardTenderInput> = {}): GiftCardTenderInput => ({
  orderId: 'order-1',
  cardNumber: CARD_NUMBER,
  amountCents: 2000,
  currency: 'EUR',
  card: CARD,
  ...overrides,
});

function expectNoGenericWrites(bridge: Harness['bridge']) {
  expect(bridge.payments.recordPayment).not.toHaveBeenCalled();
  expect(bridge.payments.processPayment).not.toHaveBeenCalled();
  expect(bridge.ecr.processPayment).not.toHaveBeenCalled();
}

function storageText(storage: Storage | undefined): string {
  if (!storage) return '';
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index);
    return key === null ? '' : `${key}=${storage.getItem(key) ?? ''}`;
  }).join('\n');
}

describe('GiftCardCheckoutService admission', () => {
  it('refuses a debit until native recovery ran in this session', async () => {
    const { bridge, service } = harness();

    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      kind: 'refused',
      refusal: 'admission',
      sent: false,
    });
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();

    const recovery = await service.recoverOrder(SCOPE, 'order-1');
    expect(bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledWith({ orderId: 'order-1' });
    expect(recovery.admission).toMatchObject({
      state: 'clear',
      giftDebitAllowed: true,
      ordinaryCollectionAllowed: true,
    });
  });

  it('adopts a full gift from native once, with no renderer key, generic write or EFT', async () => {
    const { bridge, service } = harness();
    bridge.payments.getSettlementSnapshot
      .mockResolvedValueOnce(snapshot('order-1', 20, 0))
      .mockResolvedValueOnce(snapshot('order-1', 20, 0))
      .mockResolvedValueOnce(snapshot('order-1', 20, 20, [GIFT_ROW]));
    bridge.giftCardCheckout.redeemForOrder.mockResolvedValueOnce({
      success: true,
      replayed: false,
      recovered: false,
      reconciliationPending: false,
      orderId: 'order-1',
      remoteOrderId: 'remote-order-1',
      idempotencyKey: 'native-owned-key',
      payment: PAYMENT,
      localSettlement: { outstandingAmount: 0 },
      fiscal: {
        success: false,
        status: 'ready',
        requiresFinalize: true,
        certified: false,
        fiscalReceiptNumber: null,
      },
    });
    await service.recoverOrder(SCOPE, 'order-1');

    const outcome = await service.redeem(SCOPE, tender({ cardNumber: '4111 2222-3333 4444' }));

    expect(bridge.giftCardCheckout.redeemForOrder).toHaveBeenCalledTimes(1);
    expect(bridge.giftCardCheckout.redeemForOrder).toHaveBeenCalledWith({
      orderId: 'order-1',
      cardNumber: CARD_NUMBER,
      amount: 20,
      currency: 'EUR',
    });
    expect(outcome).toMatchObject({
      kind: 'applied',
      payment: PAYMENT,
      replayed: false,
      coverage: {
        outstandingCents: 0,
        fullyCovered: true,
        giftPayments: [{ paymentId: 'pay-1', amountCents: 2000 }],
      },
      fiscal: { status: 'ready', nextAction: 'finalize', certified: false },
      admission: { state: 'clear', ordinaryCollectionAllowed: true },
    });
    expectNoGenericWrites(bridge);

    bridge.giftCardCheckout.fiscalFinalize.mockResolvedValueOnce({
      success: true,
      status: 'approved',
      certified: false,
      fiscalReceiptNumber: null,
    });
    await expect(service.finalizeFiscal(SCOPE, 'order-1')).resolves.toMatchObject({
      sent: true,
      current: true,
      fiscal: { status: 'approved', nextAction: 'none', certified: false },
    });
    expect(bridge.giftCardCheckout.fiscalFinalize).toHaveBeenCalledWith({ orderId: 'order-1' });
    // The approval is retained: no second receipt.
    await expect(service.finalizeFiscal(SCOPE, 'order-1')).resolves.toEqual({
      sent: false,
      code: 'GIFT_CARD_FISCAL_FINALIZE_NOT_PERMITTED',
    });
    expect(bridge.giftCardCheckout.fiscalFinalize).toHaveBeenCalledTimes(1);
  });

  it('keeps a partial gift remainder on the ordinary cash or card path', async () => {
    const { bridge, service } = harness();
    bridge.payments.getSettlementSnapshot
      .mockResolvedValueOnce(snapshot('order-1', 30, 0))
      .mockResolvedValueOnce(snapshot('order-1', 30, 0))
      .mockResolvedValueOnce(snapshot('order-1', 30, 20, [GIFT_ROW]));
    bridge.giftCardCheckout.redeemForOrder.mockResolvedValueOnce({
      success: true,
      orderId: 'order-1',
      payment: PAYMENT,
      reconciliationPending: false,
      fiscal: { success: false, status: 'partial' },
    });
    await service.recoverOrder(SCOPE, 'order-1');

    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      kind: 'applied',
      coverage: { outstandingCents: 1000, fullyCovered: false },
      fiscal: { status: 'partial', nextAction: 'none' },
      admission: { ordinaryCollectionAllowed: true },
    });
    await expect(service.finalizeFiscal(SCOPE, 'order-1')).resolves.toMatchObject({ sent: false });
    expect(bridge.giftCardCheckout.fiscalFinalize).not.toHaveBeenCalled();
    expectNoGenericWrites(bridge);
  });

  it('blocks gift and ordinary collection after an uncertain answer until native recovery clears it', async () => {
    const { bridge, service } = harness();
    await service.recoverOrder(SCOPE, 'order-1');
    bridge.giftCardCheckout.redeemForOrder.mockRejectedValueOnce(new Error('ipc closed'));

    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      kind: 'unresolved',
      code: 'GIFT_CARD_REDEEM_OUTCOME_UNCERTAIN',
      admission: { state: 'unresolved', giftDebitAllowed: false, ordinaryCollectionAllowed: false },
    });
    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      kind: 'refused',
      refusal: 'admission',
      sent: false,
    });
    expect(bridge.giftCardCheckout.redeemForOrder).toHaveBeenCalledTimes(1);

    bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(
      reconciled([], {
        success: false,
        code: 'GIFT_CARD_ATTEMPT_UNRESOLVED',
        unresolved: 1,
        reconciliationPending: true,
      }),
    );
    await expect(service.admitOrdinaryCollection(SCOPE, 'order-1')).resolves.toMatchObject({
      state: 'unresolved',
      ordinaryCollectionAllowed: false,
      code: 'GIFT_CARD_ATTEMPT_UNRESOLVED',
    });

    bridge.payments.getSettlementSnapshot.mockResolvedValueOnce(snapshot('order-1', 20, 20, [GIFT_ROW]));
    bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(reconciled([NATIVE_ROW]));
    const recovered = await service.recoverOrder(SCOPE, 'order-1');
    expect(recovered.adopted).toEqual([RECOVERED]);
    expect(recovered).toMatchObject({
      code: null,
      coverage: { outstandingCents: 0, fullyCovered: true },
      admission: { state: 'clear', ordinaryCollectionAllowed: true },
    });
    expect(JSON.stringify(recovered)).not.toContain('native-owned-key');
    expectNoGenericWrites(bridge);
  });

  it('treats an unknown, mismatched or non-canonical native answer as unresolved', async () => {
    const unknown = harness();
    await unknown.service.recoverOrder(SCOPE, 'order-1');
    unknown.bridge.giftCardCheckout.redeemForOrder.mockResolvedValueOnce({
      success: false,
      code: 'GIFT_CARD_OUTCOME_UNKNOWN',
      serverCode: 'UPSTREAM_TIMEOUT',
      reconciliationPending: true,
    });
    await expect(unknown.service.redeem(SCOPE, tender())).resolves.toMatchObject({
      kind: 'unresolved',
      code: 'GIFT_CARD_OUTCOME_UNKNOWN',
    });

    const mismatch = harness();
    await mismatch.service.recoverOrder(SCOPE, 'order-1');
    mismatch.bridge.giftCardCheckout.redeemForOrder.mockResolvedValueOnce({
      success: true,
      orderId: 'order-9',
      payment: PAYMENT,
    });
    await expect(mismatch.service.redeem(SCOPE, tender())).resolves.toMatchObject({
      kind: 'unresolved',
      code: 'GIFT_CARD_REDEEM_ORDER_MISMATCH',
    });

    const wrongMethod = harness();
    await wrongMethod.service.recoverOrder(SCOPE, 'order-1');
    wrongMethod.bridge.giftCardCheckout.redeemForOrder.mockResolvedValueOnce({
      success: true,
      orderId: 'order-1',
      payment: { ...PAYMENT, method: 'cash' },
    });
    await expect(wrongMethod.service.redeem(SCOPE, tender())).resolves.toMatchObject({ kind: 'unresolved' });

    // Direct redeem stays strict: a payment that does not state its gift method is not adopted.
    const unstated = harness();
    await unstated.service.recoverOrder(SCOPE, 'order-1');
    unstated.bridge.giftCardCheckout.redeemForOrder.mockResolvedValueOnce({
      success: true,
      orderId: 'order-1',
      payment: NATIVE_ROW,
    });
    await expect(unstated.service.redeem(SCOPE, tender())).resolves.toMatchObject({ kind: 'unresolved' });
  });

  it('never treats an empty, unreadable or failed recovery as clear', async () => {
    const { bridge, service } = harness();
    bridge.giftCardCheckout.reconcileOrder
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true, unresolved: 'several' })
      .mockRejectedValueOnce(new Error('ipc closed'));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { admission } = await service.recoverOrder(SCOPE, 'order-1');
      expect(admission).toMatchObject({
        state: 'unresolved',
        giftDebitAllowed: false,
        ordinaryCollectionAllowed: false,
      });
    }
    expect(service.getAdmission(SCOPE, 'order-1').code).toBe('GIFT_CARD_RECOVERY_UNAVAILABLE');
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
  });

  it('adopts exact native recovery rows once, inferring only the gift method', async () => {
    const { bridge, service } = harness();
    bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(
      reconciled(
        [
          NATIVE_ROW,
          { ...NATIVE_ROW },
          { ...NATIVE_ROW, localPaymentId: 'pay-2', remotePaymentId: null, method: 'gift_card' },
        ],
        { abandoned: 1 },
      ),
    );

    const recovered = await service.recoverOrder(SCOPE, 'order-1');
    expect(recovered.adopted).toEqual([RECOVERED, { ...RECOVERED, localPaymentId: 'pay-2', remotePaymentId: null }]);
    expect(recovered).toMatchObject({ code: null, admission: { state: 'clear' } });
    expect(recovered.coverage).toMatchObject({ orderId: 'order-1', outstandingCents: 2000 });
    expect(JSON.stringify(recovered)).not.toContain('native-owned-key');
    expectNoGenericWrites(bridge);
  });

  it('drops malformed or contradictory recovery rows and flags them without inventing payments', async () => {
    const { bridge, service } = harness();
    bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(
      reconciled([
        { ...NATIVE_ROW, localPaymentId: 'pay-cash', method: 'cash' },
        { ...NATIVE_ROW, localPaymentId: 'pay-fraction', amountCents: 1999.5 },
        { ...NATIVE_ROW, localPaymentId: 'pay-text', amountCents: '2000' },
        { ...NATIVE_ROW, localPaymentId: 'pay-zero', amountCents: 0 },
        { ...NATIVE_ROW, localPaymentId: 'pay-lower', currency: 'eur' },
        { ...NATIVE_ROW, localPaymentId: 'pay-long', currency: 'EURO' },
        { ...NATIVE_ROW, localPaymentId: 'pay-remote', remotePaymentId: 42 },
        { ...NATIVE_ROW, localPaymentId: ' ' },
        { payment: PAYMENT },
        null,
        NATIVE_ROW,
      ]),
    );

    const recovered = await service.recoverOrder(SCOPE, 'order-1');
    expect(recovered.adopted).toEqual([RECOVERED]);
    expect(recovered.code).toBe('GIFT_CARD_RECOVERY_PAYMENT_UNREADABLE');
    // Native reported nothing unresolved; the settlement snapshot stays the paid authority.
    expect(recovered.admission).toMatchObject({ state: 'clear', ordinaryCollectionAllowed: true });
    expect(recovered.coverage).toMatchObject({ outstandingCents: 2000 });

    bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(reconciled([NATIVE_ROW], { orderId: 'order-9' }));
    await expect(service.recoverOrder(SCOPE, 'order-1')).resolves.toMatchObject({
      adopted: [],
      code: 'GIFT_CARD_RECOVERY_ORDER_MISMATCH',
      admission: { state: 'unresolved', ordinaryCollectionAllowed: false },
    });
  });

  it('admits ordinary collection for an order with no gift journal after one native check', async () => {
    const { bridge, service } = harness();

    const [first, second] = await Promise.all([
      service.admitOrdinaryCollection(SCOPE, 'order-1'),
      service.admitOrdinaryCollection(SCOPE, 'order-1'),
    ]);
    expect(first).toMatchObject({ state: 'clear', ordinaryCollectionAllowed: true });
    expect(second).toMatchObject({ state: 'clear', ordinaryCollectionAllowed: true });
    await service.admitOrdinaryCollection(SCOPE, 'order-1');
    expect(bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledTimes(1);
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
    expectNoGenericWrites(bridge);
  });

  it('returns the admission after its last await, never a clear read before a newer uncertain debit', async () => {
    const { bridge, service } = harness();
    const coverageRead = deferred();
    bridge.payments.getSettlementSnapshot.mockImplementationOnce(() => coverageRead.promise);
    bridge.giftCardCheckout.redeemForOrder.mockRejectedValueOnce(new Error('ipc closed'));

    const admitted = service.admitOrdinaryCollection(SCOPE, 'order-1');
    await tick();
    expect(service.getAdmission(SCOPE, 'order-1').state).toBe('clear');
    // A debit starts while that check still reads coverage, and its answer is lost.
    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({ kind: 'unresolved' });
    coverageRead.resolve(snapshot('order-1', 20, 0));

    await expect(admitted).resolves.toMatchObject({
      state: 'unresolved',
      giftDebitAllowed: false,
      ordinaryCollectionAllowed: false,
    });
    // Only a fresh native answer may release the order.
    bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(
      reconciled([], { success: false, code: 'GIFT_CARD_ATTEMPT_UNRESOLVED', unresolved: 1 }),
    );
    await expect(service.admitOrdinaryCollection(SCOPE, 'order-1')).resolves.toMatchObject({
      state: 'unresolved',
      ordinaryCollectionAllowed: false,
    });
    expect(bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledTimes(2);
    expectNoGenericWrites(bridge);
  });

  it('never reports clear over a debit that started while recovery was still reading', async () => {
    const { bridge, service } = harness();
    const coverageRead = deferred();
    const debit = deferred();
    bridge.payments.getSettlementSnapshot.mockImplementationOnce(() => coverageRead.promise);
    bridge.giftCardCheckout.redeemForOrder.mockImplementationOnce(() => debit.promise);

    const recovery = service.recoverOrder(SCOPE, 'order-1');
    await tick();
    const redeem = service.redeem(SCOPE, tender());
    await tick();
    expect(service.getAdmission(SCOPE, 'order-1').state).toBe('submitting');
    await expect(service.admitOrdinaryCollection(SCOPE, 'order-1')).resolves.toMatchObject({
      state: 'submitting',
      ordinaryCollectionAllowed: false,
    });

    coverageRead.resolve(snapshot('order-1', 20, 0));
    await expect(recovery).resolves.toMatchObject({
      admission: { state: 'submitting', giftDebitAllowed: false, ordinaryCollectionAllowed: false },
    });

    debit.resolve({ success: false, code: 'GIFT_CARD_OUTCOME_UNKNOWN', orderId: 'order-1', reconciliationPending: true });
    await expect(redeem).resolves.toMatchObject({ kind: 'unresolved', admission: { state: 'unresolved' } });
    expect(bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledTimes(1);
  });

  it('fences admission by organization, terminal and order', async () => {
    const { bridge, service } = harness();
    await service.recoverOrder(SCOPE, 'order-1');

    expect(service.getAdmission(SCOPE, 'order-1').state).toBe('clear');
    expect(service.getAdmission({ organizationId: 'org-2', terminalId: 'term-1' }, 'order-1').state).toBe('unknown');
    expect(service.getAdmission({ organizationId: 'org-1', terminalId: 'term-2' }, 'order-1').state).toBe('unknown');
    expect(service.getAdmission(SCOPE, 'order-2').state).toBe('unknown');
    await expect(
      service.redeem({ organizationId: 'org-2', terminalId: 'term-1' }, tender()),
    ).resolves.toMatchObject({ refusal: 'admission', sent: false });
    await expect(service.redeem({ organizationId: 'org-1' }, tender())).resolves.toMatchObject({
      refusal: 'scope',
      sent: false,
    });
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
  });
});

describe('GiftCardCheckoutService tender validation', () => {
  it('pays amount splits only and refuses a selected-item split instead of dropping it', async () => {
    const { bridge, service } = harness();
    await service.recoverOrder(SCOPE, 'order-1');

    await expect(service.redeem(SCOPE, tender({ selectedItemIds: ['item-1'] }))).resolves.toMatchObject({
      refusal: 'item_split',
      sent: false,
    });
    await expect(
      service.redeem(SCOPE, tender({ split: { groupId: 'group-1', portionId: ' ' } })),
    ).resolves.toMatchObject({ refusal: 'split', sent: false });
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();

    bridge.giftCardCheckout.redeemForOrder.mockResolvedValueOnce({
      success: true,
      orderId: 'order-1',
      payment: PAYMENT,
    });
    await service.redeem(SCOPE, tender({ split: { groupId: 'group-1', portionId: 'portion-2' } }));
    expect(bridge.giftCardCheckout.redeemForOrder).toHaveBeenCalledWith({
      orderId: 'order-1',
      cardNumber: CARD_NUMBER,
      amount: 20,
      currency: 'EUR',
      split: { groupId: 'group-1', portionId: 'portion-2' },
    });
  });

  it.each([
    ['a lowercase order currency', { currency: 'eur' }, 'currency'],
    ['a card in another currency', { card: { ...CARD, currency: 'USD' } }, 'currency'],
    ['an expired card', { card: { ...CARD, status: 'expired' } }, 'expired'],
    ['a card past its expiry date', { card: { ...CARD, expiresAt: '2026-09-01T00:00:00Z' } }, 'expired'],
    ['a blocked card', { card: { ...CARD, status: 'blocked' } }, 'inactive'],
    ['too low a balance', { card: { ...CARD, balance: 19.99 } }, 'balance'],
    ['a fractional cent amount', { amountCents: 1999.5 }, 'amount'],
    ['a zero amount', { amountCents: 0 }, 'amount'],
    ['an invalid card number', { cardNumber: '12' }, 'card_number'],
  ] as Array<[string, Partial<GiftCardTenderInput>, string]>)(
    'refuses %s before anything reaches native',
    async (_label, overrides, refusal) => {
      const { bridge, service } = harness();
      await service.recoverOrder(SCOPE, 'order-1');

      await expect(service.redeem(SCOPE, tender(overrides))).resolves.toMatchObject({
        kind: 'refused',
        refusal,
        sent: false,
      });
      expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
      expect(service.getAdmission(SCOPE, 'order-1').state).toBe('clear');
    },
  );

  it('refuses more than the native snapshot says is outstanding', async () => {
    const { bridge, service } = harness();
    await service.recoverOrder(SCOPE, 'order-1');

    bridge.payments.getSettlementSnapshot.mockResolvedValueOnce(snapshot('order-1', 20, 15));
    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      refusal: 'exceeds_outstanding',
      sent: false,
      admission: { state: 'clear' },
    });
    bridge.payments.getSettlementSnapshot.mockResolvedValueOnce(snapshot('order-1', 20, 20));
    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({ refusal: 'nothing_due', sent: false });
    bridge.payments.getSettlementSnapshot.mockRejectedValueOnce(new Error('db locked'));
    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      refusal: 'coverage_unavailable',
      sent: false,
    });
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
  });

  it('reports native staff and fiscal refusals without inventing local authority', async () => {
    const { bridge, service } = harness();
    await service.recoverOrder(SCOPE, 'order-1');
    bridge.giftCardCheckout.redeemForOrder
      .mockResolvedValueOnce({ success: false, code: 'GIFT_CARD_STAFF_SESSION_REQUIRED', error: 'Sign in' })
      .mockResolvedValueOnce({ success: false, code: 'GIFT_CARD_FISCAL_DIRECT_AADE_UNSUPPORTED' })
      .mockResolvedValueOnce({ success: false, code: 'SOMETHING_NEW' });

    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      refusal: 'staff',
      sent: true,
      admission: { state: 'clear' },
    });
    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      refusal: 'readiness',
      sent: true,
      admission: { state: 'clear' },
    });
    // An unclassified refusal needs a fresh native recovery before anything else.
    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      refusal: 'rejected',
      admission: { state: 'unknown', ordinaryCollectionAllowed: false },
    });
    const payload = bridge.giftCardCheckout.redeemForOrder.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['amount', 'cardNumber', 'currency', 'orderId']);
  });

  it('keeps the card number and native key out of results, admission events, logs and storage', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      const { bridge, service, admissions } = harness();
      await service.recoverOrder(SCOPE, 'order-1');
      bridge.giftCardCheckout.redeemForOrder.mockRejectedValueOnce(new Error(`native echoed ${CARD_NUMBER}`));
      const uncertain = await service.redeem(SCOPE, tender());
      bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(reconciled([NATIVE_ROW]));
      const recovered = await service.recoverOrder(SCOPE, 'order-1');

      expect(recovered.adopted).toEqual([RECOVERED]);
      const text = JSON.stringify([uncertain, recovered, admissions]);
      expect(text).not.toContain(CARD_NUMBER);
      expect(text).not.toContain('native-owned-key');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      const local = typeof localStorage === 'undefined' ? undefined : localStorage;
      const session = typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
      expect(storageText(local)).not.toContain(CARD_NUMBER);
      expect(storageText(session)).not.toContain(CARD_NUMBER);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

describe('GiftCardCheckoutService fiscal', () => {
  it.each([
    [{ success: false, status: 'ready' }, 'ready', 'finalize'],
    [{ success: false, status: 'ready', requiresFinalize: true }, 'ready', 'finalize'],
    [{ status: 'pending' }, 'pending', 'reconcile'],
    [{ status: 'pending', requiresFinalize: true }, 'pending', 'finalize'],
    [
      {
        status: 'pending',
        code: 'GIFT_CARD_FISCAL_PRIOR_RECEIPT_UNRESOLVED',
        requiresFinalize: false,
        requiresReconciliation: true,
      },
      'pending',
      'reconcile',
    ],
    [{ status: 'error', code: 'GIFT_CARD_FISCAL_REGISTER_ERROR', retryable: true }, 'error', 'finalize'],
    [{ status: 'error', code: 'GIFT_CARD_LOCAL_STATE_UNAVAILABLE' }, 'error', 'none'],
    [{ status: 'unavailable', code: 'GIFT_CARD_FISCAL_REGISTER_UNAVAILABLE' }, 'unavailable', 'recheck'],
    [{ status: 'unsupported', code: 'GIFT_CARD_FISCAL_CURRENCY_UNSUPPORTED' }, 'unsupported', 'none'],
    [{ success: true, status: 'approved' }, 'approved', 'none'],
    [{ success: true, status: 'not_required' }, 'not_required', 'none'],
    [{ status: 'partial' }, 'partial', 'none'],
    [{ success: true }, 'unrecognized', 'recheck'],
    [null, 'unrecognized', 'recheck'],
  ])('classifies the flat redeem disposition %j as %s, next %s', (raw, status, nextAction) => {
    expect(classifyGiftCardFiscal(raw, 'redeem', 'order-1')).toMatchObject({ status, nextAction, freshDebit: null });
  });

  it.each([
    ['a full order on a ready route', ROUTE.ready, ORDER.ready, 'ready', 'finalize'],
    ['a partial order on a ready route', ROUTE.ready, ORDER.partial, 'partial', 'none'],
    ['a started receipt still pending', ROUTE.started, ORDER.pending, 'pending', 'reconcile'],
    ['a pending receipt on an unverified route', ROUTE.unavailable, ORDER.pending, 'pending', 'reconcile'],
    ['the original approved operation replayed', ROUTE.started, ORDER.approved, 'approved', 'none'],
    ['an earlier unresolved receipt of the order', ROUTE.prior, ORDER.prior, 'pending', 'reconcile'],
    ['a full order on a direct AADE branch', ROUTE.aade, ORDER.ready, 'unsupported', 'none'],
    ['a full order without a voucher tender', ROUTE.voucher, ORDER.ready, 'unsupported', 'none'],
    ['a full order on an unverified route', ROUTE.unavailable, ORDER.ready, 'unavailable', 'recheck'],
    ['unreadable local order state', ROUTE.ready, ORDER.unavailable, 'unavailable', 'recheck'],
    ['an already issued receipt', ROUTE.ready, ORDER.issued, 'not_required', 'none'],
  ] as Array<[string, Record<string, unknown>, Record<string, unknown>, string, string]>)(
    'reads readiness for %s from the nested order state',
    (_label, route, order, status, nextAction) => {
      expect(classifyGiftCardFiscal(readiness(route, order), 'readiness', 'order-1')).toMatchObject({
        status,
        nextAction,
        requiresFinalize: nextAction === 'finalize',
        operationId: order.operationId ?? null,
        freshDebit: { status: route.status, code: route.code },
      });
    },
  );

  it.each([
    ['no nested order state', readiness(ROUTE.ready), 'recheck'],
    ['a flat legacy answer', { status: 'ready', requiresFinalize: true, orderId: 'order-1' }, 'recheck'],
    ["another order's state", readiness(ROUTE.ready, { ...ORDER.ready, orderId: 'order-9' }), 'recheck'],
    ['an answer for another order', { ...readiness(ROUTE.ready, ORDER.ready), orderId: 'order-9' }, 'recheck'],
    ['an unknown order status', readiness(ROUTE.ready, { ...ORDER.ready, status: 'issued' }), 'recheck'],
    ['a ready order not asking to finalize', readiness(ROUTE.ready, { ...ORDER.ready, requiresFinalize: false }), 'recheck'],
    ['a ready order under a started receipt', readiness(ROUTE.started, ORDER.ready), 'reconcile'],
    ['an approval asking to finalize', readiness(ROUTE.ready, { ...ORDER.approved, requiresFinalize: true }), 'reconcile'],
    ['a partial order asking to finalize', readiness(ROUTE.ready, { ...ORDER.partial, requiresFinalize: true }), 'recheck'],
  ] as Array<[string, unknown, string]>)('never finalizes readiness with %s', (_label, raw, nextAction) => {
    expect(classifyGiftCardFiscal(raw, 'readiness', 'order-1')).toMatchObject({
      status: 'unrecognized',
      nextAction,
      requiresFinalize: false,
    });
  });

  it('never reports certification the native answer did not state', () => {
    expect(
      classifyGiftCardFiscal({ status: 'approved', certified: false, fiscalReceiptNumber: null }, 'finalize', 'o')
        .certified,
    ).toBe(false);
    expect(classifyGiftCardFiscal({ status: 'approved', certified: 'yes' }, 'finalize', 'o').certified).toBe(false);
    expect(classifyGiftCardFiscal({ status: 'approved', dispatchError: 'x' }, 'finalize', 'o')).not.toHaveProperty(
      'dispatchError',
    );
  });

  it('probes a lost finalize answer instead of resending it', async () => {
    const { bridge, service } = harness();
    await expect(service.finalizeFiscal(SCOPE, 'order-1')).resolves.toEqual({
      sent: false,
      code: 'GIFT_CARD_FISCAL_FINALIZE_NOT_PERMITTED',
    });

    bridge.giftCardCheckout.fiscalReadiness.mockResolvedValueOnce(readiness(ROUTE.ready, ORDER.ready));
    await expect(service.fiscalReadiness(SCOPE, 'order-1')).resolves.toMatchObject({
      sent: true,
      current: true,
      fiscal: { status: 'ready', nextAction: 'finalize', freshDebit: { status: 'ready' } },
    });
    expect(bridge.giftCardCheckout.fiscalReadiness).toHaveBeenCalledWith({ orderId: 'order-1' });

    bridge.giftCardCheckout.fiscalFinalize.mockRejectedValueOnce(new Error('ipc closed'));
    await expect(service.finalizeFiscal(SCOPE, 'order-1')).resolves.toMatchObject({
      sent: true,
      fiscal: { status: 'invocation_failed', nextAction: 'reconcile' },
    });
    await expect(service.finalizeFiscal(SCOPE, 'order-1')).resolves.toMatchObject({ sent: false });
    expect(bridge.giftCardCheckout.fiscalFinalize).toHaveBeenCalledTimes(1);

    // The probe returns the original operation; nothing is issued again.
    bridge.giftCardCheckout.fiscalReconcile.mockResolvedValueOnce({ ...ORDER.approved, success: true });
    await expect(service.reconcileFiscal(SCOPE, 'order-1')).resolves.toMatchObject({
      sent: true,
      fiscal: { status: 'approved', operationId: 'op-1', nextAction: 'none' },
    });
    bridge.giftCardCheckout.fiscalReadiness.mockResolvedValueOnce(readiness(ROUTE.started, ORDER.approved));
    await expect(service.fiscalReadiness(SCOPE, 'order-1')).resolves.toMatchObject({
      fiscal: {
        status: 'approved',
        operationId: 'op-1',
        nextAction: 'none',
        freshDebit: { status: 'unsupported', code: 'GIFT_CARD_FISCAL_ALREADY_STARTED' },
      },
    });
    await expect(service.finalizeFiscal(SCOPE, 'order-1')).resolves.toMatchObject({ sent: false });
    expect(bridge.giftCardCheckout.fiscalFinalize).toHaveBeenCalledTimes(1);
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
    expectNoGenericWrites(bridge);
  });

  it('applies only the latest fiscal answer and spends a finalize permission on dispatch', async () => {
    const { bridge, service } = harness();
    const older = deferred();
    bridge.giftCardCheckout.fiscalReadiness
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce(readiness(ROUTE.started, ORDER.pending));

    const first = service.fiscalReadiness(SCOPE, 'order-1');
    await expect(service.fiscalReadiness(SCOPE, 'order-1')).resolves.toMatchObject({
      current: true,
      fiscal: { status: 'pending', nextAction: 'reconcile' },
    });
    older.resolve(readiness(ROUTE.ready, ORDER.ready));
    await expect(first).resolves.toMatchObject({ sent: true, current: false, fiscal: { nextAction: 'finalize' } });
    // The older ready answer cannot reopen a finalize over the newer pending receipt.
    await expect(service.finalizeFiscal(SCOPE, 'order-1')).resolves.toMatchObject({ sent: false });
    expect(service.getAdmission(SCOPE, 'order-1').fiscalPending).toBe(true);

    bridge.giftCardCheckout.fiscalReadiness.mockResolvedValueOnce(readiness(ROUTE.ready, ORDER.ready));
    await service.fiscalReadiness(SCOPE, 'order-1');
    const dispatch = deferred();
    bridge.giftCardCheckout.fiscalFinalize.mockImplementationOnce(() => dispatch.promise);
    const finalizing = service.finalizeFiscal(SCOPE, 'order-1');
    await expect(service.finalizeFiscal(SCOPE, 'order-1')).resolves.toEqual({
      sent: false,
      code: 'GIFT_CARD_FISCAL_FINALIZE_NOT_PERMITTED',
    });
    dispatch.resolve({ ...ORDER.approved, success: true, operationId: 'op-2' });
    await expect(finalizing).resolves.toMatchObject({
      sent: true,
      current: true,
      fiscal: { status: 'approved', operationId: 'op-2' },
    });
    expect(bridge.giftCardCheckout.fiscalFinalize).toHaveBeenCalledTimes(1);
  });

  it('blocks a new gift debit while a prior receipt is unresolved, but not ordinary collection', async () => {
    const { bridge, service } = harness();
    await service.recoverOrder(SCOPE, 'order-1');
    bridge.giftCardCheckout.fiscalReadiness
      .mockResolvedValueOnce(readiness(ROUTE.prior, ORDER.prior))
      .mockRejectedValueOnce(new Error('ipc closed'));
    await expect(service.fiscalReadiness(SCOPE, 'order-1')).resolves.toMatchObject({
      fiscal: { status: 'pending', nextAction: 'reconcile', freshDebit: { status: 'pending' } },
    });
    // An unreadable answer never releases a receipt already known to be pending.
    await expect(service.fiscalReadiness(SCOPE, 'order-1')).resolves.toMatchObject({
      fiscal: { status: 'invocation_failed', nextAction: 'recheck' },
    });

    expect(service.getAdmission(SCOPE, 'order-1')).toMatchObject({
      state: 'clear',
      fiscalPending: true,
      giftDebitAllowed: false,
      ordinaryCollectionAllowed: true,
    });
    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      refusal: 'fiscal_pending',
      sent: false,
    });
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
  });

  it('freezes the runtime exports the mount slice consumes', () => {
    expect(Object.keys(checkout).sort()).toEqual([
      'GiftCardCheckoutService',
      'classifyGiftCardFiscal',
      'classifyGiftCardRefusal',
      'default',
      'giftCardAdmissionKey',
      'giftCardCheckoutService',
      'giftCardOrderKey',
    ]);
  });
});

function claimHold(
  service: GiftCardCheckoutService,
  scope: { organizationId: string; terminalId: string } = SCOPE,
  orderId = 'order-1',
): GiftCardOrdinaryHold {
  const claim = service.claimOrdinaryCollection(scope, orderId);
  if (!claim.claimed) throw new Error(`claim refused: ${claim.code}`);
  return claim.hold;
}

describe('GiftCardCheckoutService collection hold', () => {
  it('blocks a gift debit from an ordinary claim made before its delayed native check', async () => {
    const { bridge, service } = harness();
    const check = deferred();
    bridge.giftCardCheckout.reconcileOrder.mockImplementationOnce(() => check.promise);

    const claim = service.claimOrdinaryCollection(SCOPE, 'order-1');
    expect(claim).toMatchObject({
      claimed: true,
      admission: { state: 'unknown', reservation: { kind: 'ordinary', status: 'busy', code: null } },
    });
    if (!claim.claimed) throw new Error('claim refused');
    const preflight = service.preflightOrdinaryCollection(claim.hold);
    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      kind: 'refused',
      refusal: 'admission',
      code: 'GIFT_CARD_COLLECTION_IN_PROGRESS',
      sent: false,
    });

    check.resolve(CLEAR);
    // The holder may proceed while every other caller still sees the order reserved.
    await expect(preflight).resolves.toMatchObject({
      proceed: true,
      code: null,
      admission: { state: 'clear', giftDebitAllowed: false, ordinaryCollectionAllowed: false },
    });
    expect(service.getAdmission(SCOPE, 'order-1')).toMatchObject({
      state: 'clear',
      giftDebitAllowed: false,
      ordinaryCollectionAllowed: false,
      reservation: { kind: 'ordinary', status: 'busy' },
    });
    await expect(service.admitOrdinaryCollection(SCOPE, 'order-1')).resolves.toMatchObject({
      ordinaryCollectionAllowed: false,
    });
    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      refusal: 'admission',
      code: 'GIFT_CARD_COLLECTION_IN_PROGRESS',
    });
    expect(service.ordinaryHoldStatus(claim.hold)).toBe('busy');
    expect(bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledTimes(1);
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
    expectNoGenericWrites(bridge);
  });

  it('blocks ordinary collection from a gift debit through its coverage read, native reply and adoption', async () => {
    const { bridge, service } = harness();
    await service.recoverOrder(SCOPE, 'order-1');
    const coverageRead = deferred();
    const debit = deferred();
    bridge.payments.getSettlementSnapshot.mockImplementationOnce(() => coverageRead.promise);
    bridge.giftCardCheckout.redeemForOrder.mockImplementationOnce(() => debit.promise);

    const redeem = service.redeem(SCOPE, tender());
    expect(service.claimOrdinaryCollection(SCOPE, 'order-1')).toMatchObject({
      claimed: false,
      code: 'GIFT_CARD_COLLECTION_IN_PROGRESS',
      admission: { state: 'submitting', reservation: { kind: 'gift', status: 'busy' } },
    });
    coverageRead.resolve(snapshot('order-1', 20, 0));
    await tick();
    expect(bridge.giftCardCheckout.redeemForOrder).toHaveBeenCalledTimes(1);
    expect(service.claimOrdinaryCollection(SCOPE, 'order-1').claimed).toBe(false);
    await expect(service.admitOrdinaryCollection(SCOPE, 'order-1')).resolves.toMatchObject({
      ordinaryCollectionAllowed: false,
    });

    bridge.payments.getSettlementSnapshot.mockResolvedValueOnce(snapshot('order-1', 20, 20, [GIFT_ROW]));
    debit.resolve({ success: true, orderId: 'order-1', payment: PAYMENT, replayed: false, reconciliationPending: false });
    await expect(redeem).resolves.toMatchObject({
      kind: 'applied',
      admission: { state: 'clear', ordinaryCollectionAllowed: true, reservation: null },
    });
    expect(service.claimOrdinaryCollection(SCOPE, 'order-1').claimed).toBe(true);
    expect(bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledTimes(1);
    expectNoGenericWrites(bridge);
  });

  it('admits one claimant per order in the same tick, for either kind', async () => {
    const { bridge, service } = harness();
    const first = service.claimOrdinaryCollection(SCOPE, 'order-1');
    expect(first.claimed).toBe(true);
    expect(service.claimOrdinaryCollection(SCOPE, 'order-1')).toMatchObject({
      claimed: false,
      code: 'GIFT_CARD_COLLECTION_IN_PROGRESS',
    });
    // Each organization, terminal and order has its own hold; a hold needs both identities.
    expect(service.claimOrdinaryCollection(SCOPE, 'order-2').claimed).toBe(true);
    expect(service.claimOrdinaryCollection({ organizationId: 'org-1', terminalId: 'term-2' }, 'order-1').claimed).toBe(true);
    expect(service.claimOrdinaryCollection({ organizationId: 'org-1' }, 'order-3')).toMatchObject({
      claimed: false,
      code: 'GIFT_CARD_TERMINAL_SCOPE_REQUIRED',
    });

    await service.recoverOrder(SCOPE, 'order-4');
    const taps = [service.redeem(SCOPE, tender({ orderId: 'order-4' })), service.redeem(SCOPE, tender({ orderId: 'order-4' }))];
    expect(service.claimOrdinaryCollection(SCOPE, 'order-4').claimed).toBe(false);
    await expect(taps[1]).resolves.toMatchObject({
      kind: 'refused',
      refusal: 'admission',
      code: 'GIFT_CARD_COLLECTION_IN_PROGRESS',
      sent: false,
    });
    await taps[0];
    expect(bridge.giftCardCheckout.redeemForOrder).toHaveBeenCalledTimes(1);
  });

  it('settles only through the current hold: copies, stale holds and other orders change nothing', async () => {
    const { bridge, service } = harness();
    const first = claimHold(service);
    const other = claimHold(service, SCOPE, 'order-2');
    expect(Object.isFrozen(first)).toBe(true);

    expect(service.resolveOrdinaryCollection({ ...first }, { outcome: 'completed' })).toMatchObject({
      applied: false,
      code: 'GIFT_CARD_HOLD_NOT_CURRENT',
    });
    expect(service.ordinaryHoldStatus({ ...first })).toBeNull();
    const forged = { ...other, orderId: 'order-1' };
    expect(service.resolveOrdinaryCollection(forged, { outcome: 'not_sent', basis: 'before_send' }).applied).toBe(false);
    expect(service.ordinaryHoldStatus(first)).toBe('busy');

    expect(service.resolveOrdinaryCollection(first, { outcome: 'not_sent', basis: 'before_send' })).toMatchObject({
      applied: true,
      admission: { reservation: null },
    });
    const newer = claimHold(service);
    expect(newer.generation).toBeGreaterThan(first.generation);
    // The older hold can neither settle, mark nor run the newer holder's check.
    expect(service.resolveOrdinaryCollection(first, { outcome: 'completed' }).applied).toBe(false);
    expect(service.resolveOrdinaryCollection(first, { outcome: 'unknown' }).applied).toBe(false);
    await expect(service.preflightOrdinaryCollection(first)).resolves.toMatchObject({
      proceed: false,
      code: 'GIFT_CARD_HOLD_NOT_CURRENT',
    });
    expect(service.ordinaryHoldStatus(newer)).toBe('busy');
    expect(service.ordinaryHoldStatus(other)).toBe('busy');
    expect(bridge.giftCardCheckout.reconcileOrder).not.toHaveBeenCalled();
  });

  it('releases on a truthful not-sent or a completed canonical outcome', async () => {
    const { bridge, service } = harness();
    const first = claimHold(service);
    await expect(service.preflightOrdinaryCollection(first)).resolves.toMatchObject({ proceed: true });
    // Stopped before any terminal or payment write.
    expect(service.resolveOrdinaryCollection(first, { outcome: 'not_sent', basis: 'before_send' })).toMatchObject({
      applied: true,
      code: null,
      admission: { state: 'clear', giftDebitAllowed: true, ordinaryCollectionAllowed: true, reservation: null },
    });

    const second = claimHold(service);
    await expect(service.preflightOrdinaryCollection(second)).resolves.toMatchObject({ proceed: true });
    // Recorded and canonically reconciled by the ordinary payment authority.
    expect(service.resolveOrdinaryCollection(second, { outcome: 'completed' })).toMatchObject({
      applied: true,
      admission: { ordinaryCollectionAllowed: true, reservation: null },
    });
    expect(service.ordinaryHoldStatus(second)).toBeNull();
    expect(bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledTimes(1);
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
    expectNoGenericWrites(bridge);
  });

  it('keeps a possibly-sent ordinary collection blocked until its owner proves the original outcome', async () => {
    const { bridge, service } = harness();
    const hold = claimHold(service);
    await expect(service.preflightOrdinaryCollection(hold)).resolves.toMatchObject({ proceed: true });

    // The terminal rejected or timed out after the send may have started.
    expect(service.resolveOrdinaryCollection(hold, { outcome: 'unknown', code: 'ECR_TIMEOUT' })).toMatchObject({
      applied: true,
      code: 'ECR_TIMEOUT',
      admission: {
        state: 'clear',
        giftDebitAllowed: false,
        ordinaryCollectionAllowed: false,
        reservation: { kind: 'ordinary', status: 'unknown', code: 'ECR_TIMEOUT' },
      },
    });
    await expect(service.preflightOrdinaryCollection(hold)).resolves.toMatchObject({
      proceed: false,
      code: 'GIFT_CARD_COLLECTION_OUTCOME_UNKNOWN',
    });
    expect(service.claimOrdinaryCollection(SCOPE, 'order-1')).toMatchObject({
      claimed: false,
      code: 'GIFT_CARD_COLLECTION_OUTCOME_UNKNOWN',
    });
    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      refusal: 'admission',
      code: 'GIFT_CARD_COLLECTION_OUTCOME_UNKNOWN',
      sent: false,
    });
    // "Nothing was sent" is no longer truthful, and an unrecognized resolution changes nothing.
    expect(service.resolveOrdinaryCollection(hold, { outcome: 'not_sent', basis: 'before_send' })).toMatchObject({
      applied: false,
      code: 'GIFT_CARD_COLLECTION_OUTCOME_UNKNOWN',
    });
    const bogus = { outcome: 'released' } as unknown as GiftCardOrdinaryResolution;
    expect(service.resolveOrdinaryCollection(hold, bogus).applied).toBe(false);
    // A code that is not a plain native-style code is never carried.
    service.resolveOrdinaryCollection(hold, { outcome: 'unknown', code: CARD_NUMBER });
    expect(service.getAdmission(SCOPE, 'order-1').reservation).toEqual({
      kind: 'ordinary',
      status: 'unknown',
      code: 'GIFT_CARD_ORDINARY_OUTCOME_UNKNOWN',
    });
    expect(service.ordinaryHoldStatus(hold)).toBe('unknown');

    expect(service.resolveOrdinaryCollection(hold, { outcome: 'not_sent', basis: 'original_operation' })).toMatchObject({
      applied: true,
      admission: { ordinaryCollectionAllowed: true, reservation: null },
    });
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
    expectNoGenericWrites(bridge);
  });

  it('never lets native gift recovery clear an uncertain ordinary collection', async () => {
    const { bridge, service } = harness();
    const hold = claimHold(service);
    await service.preflightOrdinaryCollection(hold);
    service.resolveOrdinaryCollection(hold, { outcome: 'unknown' });

    bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(reconciled([NATIVE_ROW]));
    const recovered = await service.recoverOrder(SCOPE, 'order-1');
    expect(recovered.adopted).toEqual([RECOVERED]);
    expect(recovered.admission).toMatchObject({
      state: 'clear',
      giftDebitAllowed: false,
      ordinaryCollectionAllowed: false,
      reservation: { kind: 'ordinary', status: 'unknown' },
    });
    // An unpaid ledger says nothing about the ordinary attempt either.
    await expect(service.admitOrdinaryCollection(SCOPE, 'order-1')).resolves.toMatchObject({
      ordinaryCollectionAllowed: false,
    });
    expect(service.ordinaryHoldStatus(hold)).toBe('unknown');
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
  });

  it('never lets a recovery that began earlier settle a newer ordinary hold', async () => {
    const { bridge, service } = harness();
    const check = deferred();
    bridge.giftCardCheckout.reconcileOrder.mockImplementationOnce(() => check.promise);

    const recovery = service.recoverOrder(SCOPE, 'order-1');
    const hold = claimHold(service);
    check.resolve(reconciled([NATIVE_ROW]));
    await expect(recovery).resolves.toMatchObject({
      admission: { state: 'clear', ordinaryCollectionAllowed: false, reservation: { kind: 'ordinary', status: 'busy' } },
    });
    expect(service.ordinaryHoldStatus(hold)).toBe('busy');
    await expect(service.preflightOrdinaryCollection(hold)).resolves.toMatchObject({ proceed: true });
    expect(bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledTimes(1);
  });

  it('settles an uncertain gift hold only through native recovery of that attempt, with no new debit', async () => {
    const { bridge, service } = harness();
    await service.recoverOrder(SCOPE, 'order-1');
    bridge.giftCardCheckout.redeemForOrder.mockRejectedValueOnce(new Error('ipc closed'));
    await expect(service.redeem(SCOPE, tender())).resolves.toMatchObject({
      kind: 'unresolved',
      admission: { reservation: { kind: 'gift', status: 'unknown', code: 'GIFT_CARD_REDEEM_OUTCOME_UNCERTAIN' } },
    });
    expect(service.claimOrdinaryCollection(SCOPE, 'order-1')).toMatchObject({
      claimed: false,
      code: 'GIFT_CARD_COLLECTION_OUTCOME_UNKNOWN',
    });

    bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(
      reconciled([], { success: false, code: 'GIFT_CARD_ATTEMPT_UNRESOLVED', unresolved: 1 }),
    );
    await expect(service.recoverOrder(SCOPE, 'order-1')).resolves.toMatchObject({
      admission: { state: 'unresolved', reservation: { kind: 'gift', status: 'unknown' } },
    });

    bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(reconciled([NATIVE_ROW]));
    const recovered = await service.recoverOrder(SCOPE, 'order-1');
    expect(recovered.adopted).toEqual([RECOVERED]);
    expect(recovered.admission).toMatchObject({ state: 'clear', ordinaryCollectionAllowed: true, reservation: null });
    expect(bridge.giftCardCheckout.redeemForOrder).toHaveBeenCalledTimes(1);
    expect(service.claimOrdinaryCollection(SCOPE, 'order-1').claimed).toBe(true);
    expectNoGenericWrites(bridge);
  });

  it('keeps holds in memory only, with no card number, native key or storage write', async () => {
    const local = typeof localStorage === 'undefined' ? undefined : localStorage;
    const session = typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
    const before = [storageText(local), storageText(session)];
    const { bridge, service, admissions } = harness();

    const claim = service.claimOrdinaryCollection(SCOPE, 'order-1');
    if (!claim.claimed) throw new Error('claim refused');
    expect(Object.keys(claim.hold).sort()).toEqual(['generation', 'orderId', 'organizationId', 'terminalId']);
    await service.preflightOrdinaryCollection(claim.hold);
    service.resolveOrdinaryCollection(claim.hold, { outcome: 'completed' });
    bridge.giftCardCheckout.redeemForOrder.mockRejectedValueOnce(new Error(`native echoed ${CARD_NUMBER}`));
    const uncertain = await service.redeem(SCOPE, tender());
    bridge.giftCardCheckout.reconcileOrder.mockResolvedValueOnce(reconciled([NATIVE_ROW]));
    const recovered = await service.recoverOrder(SCOPE, 'order-1');

    const text = JSON.stringify([claim, uncertain, recovered, admissions]);
    expect(text).not.toContain(CARD_NUMBER);
    expect(text).not.toContain('native-owned-key');
    expect([storageText(local), storageText(session)]).toEqual(before);
    // Memory only: a new instance (a restart) has no hold and starts from native recovery.
    const restarted = new GiftCardCheckoutService({ bridge: () => bridge as unknown as GiftCardCheckoutBridge });
    expect(restarted.getAdmission(SCOPE, 'order-1')).toMatchObject({ state: 'unknown', reservation: null });
  });
});
