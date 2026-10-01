import { beforeEach, describe, expect, it, vi } from 'vitest';

// One shared native bridge: the store binds it at import and the real gift
// checkout singleton asks for it on every call. Only this boundary is faked.
const { bridge } = vi.hoisted(() => ({
  bridge: {
    invoke: vi.fn(),
    giftCardCheckout: {
      redeemForOrder: vi.fn(),
      reconcileOrder: vi.fn(),
      fiscalReadiness: vi.fn(),
      fiscalFinalize: vi.fn(),
      fiscalReconcile: vi.fn(),
    },
    payments: {
      getSettlementSnapshot: vi.fn(),
      recordPayment: vi.fn(),
    },
    ecr: { processPayment: vi.fn() },
  },
}));

vi.mock('../../../lib', () => ({
  getBridge: () => bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

vi.mock('../../../services/OrderService', () => ({
  OrderService: {
    getInstance: () => ({ fetchOrders: vi.fn() }),
  },
}));

import {
  adoptGiftCardPaymentIds,
  claimOrdinaryCollectionOwner,
  classifyOrdinaryTerminalReply,
  classifyOrdinaryWrite,
  ledgerHasOriginalOrdinaryPayment,
  noteOrdinaryBatchWrite,
  noteOrdinaryTerminalTransaction,
  noteOrdinaryWriteFacts,
  ordinaryCollectionView,
  probeOrdinaryOwner,
  readOrdinaryWriteReply,
  releaseOrdinaryOwnerBeforeSend,
  retainedOrdinaryOwner,
  runOrdinaryCollection,
  useOrderStore,
  type OrdinaryCollectionOriginal,
  type OrdinaryCollectionOwner,
  type OrdinaryCollectionVerdict,
} from '../useOrderStore';
import { giftCardCheckoutService } from '../../services/GiftCardCheckoutService';

const SCOPE = { organizationId: 'org-ordinary', terminalId: 'term-ordinary' };
/** Native gift_card_reconcile_order reporting nothing unresolved. */
const CLEAR = { success: true, applied: [], abandoned: 0, unresolved: 0, reconciliationPending: false };

// Controller and service state are module-level and unknown holds never
// clear, so every test works on its own order.
let sequence = 0;
const nextOrderId = (label: string): string => `ordinary-${label}-${++sequence}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const original = (overrides: Partial<OrdinaryCollectionOriginal> = {}): OrdinaryCollectionOriginal => ({
  method: 'cash',
  amount: 12.5,
  transactionRef: null,
  idempotencyKey: null,
  settlementGeneration: null,
  terminalTransactionId: null,
  ...overrides,
});

const admission = (orderId: string) => giftCardCheckoutService.getAdmission(SCOPE, orderId);

function claim(orderId: string): OrdinaryCollectionOwner {
  const result = claimOrdinaryCollectionOwner(SCOPE, orderId);
  if (!result.claimed) throw new Error(`claim refused: ${result.code}`);
  return result.owner;
}

/** A completed row exactly as native get_order_settlement_snapshot lists it. */
function row(id: string, transactionRef: string | null, status = 'completed') {
  return {
    id,
    orderId: 'local-order',
    method: 'cash',
    amount: 12.5,
    currency: 'EUR',
    status,
    cashReceived: 20,
    changeGiven: 7.5,
    transactionRef,
    discountAmount: 0,
    paymentOrigin: 'manual',
    terminalApproved: false,
    terminalDeviceId: null,
    staffId: null,
    staffShiftId: null,
    syncStatus: 'pending',
    createdAt: '2026-09-29T12:00:00Z',
    updatedAt: '2026-09-29T12:00:00Z',
    refundedAmount: 0,
    remotePaymentId: null,
    remainingRefundable: 12.5,
    items: [],
  };
}

function nativeSnapshot(orderId: string, rows: unknown[] = [], total = 12.5, paid = 0) {
  return {
    success: true,
    orderId,
    orderTotal: total,
    netPaid: paid,
    outstandingAmount: Math.round((total - paid) * 100) / 100,
    completedPayments: rows,
    generation: 'a'.repeat(64),
  };
}

function expectNoWrites() {
  expect(bridge.invoke).not.toHaveBeenCalled();
  expect(bridge.payments.recordPayment).not.toHaveBeenCalled();
  expect(bridge.ecr.processPayment).not.toHaveBeenCalled();
  expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
}

/** Leaves the order's ordinary collection unknown: the send threw after the gate. */
async function unknownOwner(
  orderId: string,
  overrides: Partial<OrdinaryCollectionOriginal> = {},
  during?: (owner: OrdinaryCollectionOwner) => void,
): Promise<OrdinaryCollectionOwner> {
  const owner = claim(orderId);
  const run = await runOrdinaryCollection(owner, original(overrides), async () => {
    during?.(owner);
    throw new Error('IPC transport lost');
  });
  expect(run.status).toBe('unknown');
  return owner;
}

beforeEach(() => {
  bridge.invoke.mockImplementation(async () => ({ success: true }));
  bridge.giftCardCheckout.reconcileOrder.mockImplementation(async () => CLEAR);
  bridge.giftCardCheckout.redeemForOrder.mockImplementation(async () => undefined);
  bridge.payments.getSettlementSnapshot.mockImplementation(async (orderId: unknown) =>
    nativeSnapshot(String(orderId)),
  );
  bridge.payments.recordPayment.mockImplementation(async () => undefined);
  bridge.ecr.processPayment.mockImplementation(async () => undefined);
});

describe('claimOrdinaryCollectionOwner', () => {
  it('is refused without an organization or a public terminal, reserving nothing', () => {
    const orderId = nextOrderId('scope');
    const scopes = [
      { organizationId: null, terminalId: 'term-ordinary' },
      { organizationId: 'org-ordinary', terminalId: null },
      { organizationId: 'org-ordinary', terminalId: '   ' },
      {},
      null,
      undefined,
    ];
    for (const scope of scopes) {
      expect(claimOrdinaryCollectionOwner(scope, orderId)).toMatchObject({
        claimed: false,
        code: 'GIFT_CARD_TERMINAL_SCOPE_REQUIRED',
        retained: null,
      });
    }
    expect(claimOrdinaryCollectionOwner(SCOPE, '   ')).toMatchObject({
      claimed: false,
      code: 'GIFT_CARD_ORDER_REQUIRED',
      retained: null,
    });
    expect(admission(orderId).reservation).toBeNull();
    expectNoWrites();
  });

  it('synchronously makes the admission reservation ordinary and busy', () => {
    const orderId = nextOrderId('reserve');
    expect(admission(orderId).reservation).toBeNull();

    const result = claimOrdinaryCollectionOwner(SCOPE, orderId);

    expect(result.claimed).toBe(true);
    if (!result.claimed) return;
    expect(Object.isFrozen(result.owner)).toBe(true);
    expect(result.owner).toMatchObject({ orderId, scope: SCOPE });
    expect(admission(orderId)).toMatchObject({
      reservation: { kind: 'ordinary', status: 'busy', code: null },
      ordinaryCollectionAllowed: false,
      giftDebitAllowed: false,
    });
    expect(ordinaryCollectionView(result.owner)).toEqual({ phase: 'held', original: null, facts: null });
    // The claim itself asks native nothing; the preflight does, right before the send.
    expect(bridge.giftCardCheckout.reconcileOrder).not.toHaveBeenCalled();

    expect(releaseOrdinaryOwnerBeforeSend(result.owner)).toBe(true);
    expect(admission(orderId).reservation).toBeNull();
    expect(ordinaryCollectionView(result.owner)).toBeNull();
  });

  it('refuses a competing claim and a gift redeem while the order is held', async () => {
    const orderId = nextOrderId('compete');
    const owner = claim(orderId);

    expect(claimOrdinaryCollectionOwner(SCOPE, orderId)).toMatchObject({
      claimed: false,
      code: 'GIFT_CARD_COLLECTION_IN_PROGRESS',
      retained: null,
    });
    const redeem = await giftCardCheckoutService.redeem(SCOPE, {
      orderId,
      cardNumber: '4111222233334444',
      amountCents: 500,
      currency: 'EUR',
      card: { balance: 50, currency: 'EUR', status: 'active', expiresAt: null },
    });
    expect(redeem).toMatchObject({
      kind: 'refused',
      refusal: 'admission',
      code: 'GIFT_CARD_COLLECTION_IN_PROGRESS',
      sent: false,
    });
    expect(bridge.giftCardCheckout.redeemForOrder).not.toHaveBeenCalled();
    expect(admission(orderId).reservation).toEqual({ kind: 'ordinary', status: 'busy', code: null });

    expect(releaseOrdinaryOwnerBeforeSend(owner)).toBe(true);
  });
});

describe('runOrdinaryCollection', () => {
  it("runs the holder preflight after the caller's awaits and immediately before the send", async () => {
    const orderId = nextOrderId('preflight');
    const events: string[] = [];
    const recovery = deferred<unknown>();
    bridge.giftCardCheckout.reconcileOrder.mockImplementation(async () => {
      events.push('preflight');
      return recovery.promise;
    });
    const owner = claim(orderId);
    // Print policy, terminal discovery and similar caller awaits run under the claim.
    const callerWork = deferred<void>();
    const flow = (async () => {
      await callerWork.promise;
      events.push('caller-awaited');
      return runOrdinaryCollection(owner, original(), async () => {
        events.push('send');
        return { verdict: 'completed' as const, value: 'paid' };
      });
    })();

    await tick();
    expect(events).toEqual([]);
    callerWork.resolve();
    await tick();
    expect(events).toEqual(['caller-awaited', 'preflight']);
    expect(ordinaryCollectionView(owner)?.phase).toBe('preflight');
    expect(releaseOrdinaryOwnerBeforeSend(owner)).toBe(false);

    recovery.resolve(CLEAR);
    await expect(flow).resolves.toEqual({ status: 'completed', value: 'paid', code: null });
    expect(events).toEqual(['caller-awaited', 'preflight', 'send']);
    expect(bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledTimes(1);
    expect(bridge.giftCardCheckout.reconcileOrder).toHaveBeenCalledWith({ orderId });
    expect(admission(orderId).reservation).toBeNull();
    expect(ordinaryCollectionView(owner)).toBeNull();
  });

  it('refuses a second run sharing the owner and sends once (same-holder double callback)', async () => {
    const orderId = nextOrderId('double');
    const owner = claim(orderId);
    const reply = deferred<{ verdict: OrdinaryCollectionVerdict; value: number }>();
    const send = vi.fn(() => reply.promise);

    const first = runOrdinaryCollection(owner, original(), send);
    // Refused synchronously at the gate, while the first run is still in preflight.
    await expect(runOrdinaryCollection(owner, original({ amount: 99 }), send)).resolves.toEqual({
      status: 'refused',
      code: 'ORDINARY_COLLECTION_ALREADY_OWNED',
    });
    await tick();
    expect(ordinaryCollectionView(owner)?.phase).toBe('sending');
    // And again while the first run's send is in flight.
    await expect(runOrdinaryCollection(owner, original({ amount: 99 }), send)).resolves.toEqual({
      status: 'refused',
      code: 'ORDINARY_COLLECTION_ALREADY_OWNED',
    });
    expect(ordinaryCollectionView(owner)?.original?.amount).toBe(12.5);

    reply.resolve({ verdict: 'completed', value: 1 });
    await expect(first).resolves.toEqual({ status: 'completed', value: 1, code: null });
    expect(send).toHaveBeenCalledTimes(1);
    // The spent owner is no longer current.
    await expect(runOrdinaryCollection(owner, original(), send)).resolves.toEqual({
      status: 'refused',
      code: 'GIFT_CARD_HOLD_NOT_CURRENT',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a preflight refusal sends nothing and releases the claim before send', async () => {
    const orderId = nextOrderId('refuse');
    bridge.giftCardCheckout.reconcileOrder.mockImplementation(async () => ({
      ...CLEAR,
      unresolved: 1,
      reconciliationPending: true,
      code: 'GIFT_CARD_RECONCILIATION_PENDING',
    }));
    const owner = claim(orderId);
    const send = vi.fn(async () => ({ verdict: 'completed' as const, value: 1 }));

    await expect(runOrdinaryCollection(owner, original(), send)).resolves.toEqual({
      status: 'refused',
      code: 'GIFT_CARD_RECONCILIATION_PENDING',
    });
    expect(send).not.toHaveBeenCalled();
    expect(ordinaryCollectionView(owner)).toBeNull();
    expect(admission(orderId).reservation).toBeNull();
    expect(retainedOrdinaryOwner(SCOPE, orderId)).toBeNull();
    expectNoWrites();

    const again = claimOrdinaryCollectionOwner(SCOPE, orderId);
    expect(again.claimed).toBe(true);
    if (again.claimed) expect(releaseOrdinaryOwnerBeforeSend(again.owner)).toBe(true);
  });

  it('a lost native recovery answer also refuses before send and releases the claim', async () => {
    const orderId = nextOrderId('refuse-lost');
    bridge.giftCardCheckout.reconcileOrder.mockImplementation(async () => {
      throw new Error('native unavailable');
    });
    const owner = claim(orderId);
    const send = vi.fn(async () => ({ verdict: 'completed' as const, value: 1 }));

    await expect(runOrdinaryCollection(owner, original(), send)).resolves.toEqual({
      status: 'refused',
      code: 'GIFT_CARD_RECOVERY_UNAVAILABLE',
    });
    expect(send).not.toHaveBeenCalled();
    expect(admission(orderId).reservation).toBeNull();
  });

  it('refuses release once the send started, then settles by the original reply', async () => {
    const orderId = nextOrderId('release');
    const owner = claim(orderId);
    const reply = deferred<{ verdict: OrdinaryCollectionVerdict; value: string }>();
    const sendStarted = deferred<void>();

    const run = runOrdinaryCollection(owner, original({ transactionRef: 'ref-release' }), () => {
      sendStarted.resolve();
      return reply.promise;
    });
    await sendStarted.promise;

    expect(ordinaryCollectionView(owner)).toMatchObject({
      phase: 'sending',
      original: { transactionRef: 'ref-release' },
    });
    expect(releaseOrdinaryOwnerBeforeSend(owner)).toBe(false);
    expect(admission(orderId).reservation).toEqual({ kind: 'ordinary', status: 'busy', code: null });

    reply.resolve({ verdict: 'not_sent', value: 'declined' });
    await expect(run).resolves.toEqual({ status: 'not_sent', value: 'declined', code: null });
    expect(admission(orderId).reservation).toBeNull();
  });

  it('a send throw stays unknown and retains the same owner object for the order', async () => {
    const orderId = nextOrderId('throw');
    const owner = claim(orderId);
    const sent = original({ transactionRef: 'ref-throw', idempotencyKey: 'ref-throw' });

    await expect(
      runOrdinaryCollection(owner, sent, async () => {
        throw new Error('IPC transport lost');
      }),
    ).resolves.toEqual({ status: 'unknown', value: undefined, code: 'ORDINARY_COLLECTION_OUTCOME_UNKNOWN' });

    expect(ordinaryCollectionView(owner)).toEqual({ phase: 'unknown', original: sent, facts: null });
    expect(admission(orderId)).toMatchObject({
      reservation: { kind: 'ordinary', status: 'unknown', code: 'ORDINARY_COLLECTION_OUTCOME_UNKNOWN' },
      ordinaryCollectionAllowed: false,
      giftDebitAllowed: false,
    });
    expect(retainedOrdinaryOwner(SCOPE, orderId)).toBe(owner);
    expect(retainedOrdinaryOwner({ ...SCOPE }, `  ${orderId}  `)).toBe(owner);
    expect(retainedOrdinaryOwner({ organizationId: 'org-other', terminalId: 'term-ordinary' }, orderId)).toBeNull();

    const remount = claimOrdinaryCollectionOwner(SCOPE, orderId);
    expect(remount).toMatchObject({ claimed: false, code: 'GIFT_CARD_COLLECTION_OUTCOME_UNKNOWN' });
    expect(remount.claimed === false ? remount.retained : null).toBe(owner);

    expect(releaseOrdinaryOwnerBeforeSend(owner)).toBe(false);
    const resend = vi.fn(async () => ({ verdict: 'completed' as const, value: 1 }));
    await expect(runOrdinaryCollection(owner, sent, resend)).resolves.toEqual({
      status: 'refused',
      code: 'ORDINARY_COLLECTION_ALREADY_OWNED',
    });
    expect(resend).not.toHaveBeenCalled();
    expect(admission(orderId).reservation?.status).toBe('unknown');
  });

  it('a malformed send verdict stays unknown and keeps its owner record', async () => {
    const orderId = nextOrderId('malformed');
    const owner = claim(orderId);

    const run = await runOrdinaryCollection(owner, original(), async () => ({
      verdict: 'approved' as unknown as OrdinaryCollectionVerdict,
      value: 7,
    }));

    expect(run).toEqual({ status: 'unknown', value: 7, code: null });
    expect(admission(orderId).reservation).toEqual({
      kind: 'ordinary',
      status: 'unknown',
      code: 'GIFT_CARD_ORDINARY_OUTCOME_UNKNOWN',
    });
    expect(ordinaryCollectionView(owner)?.phase).toBe('unknown');
    expect(retainedOrdinaryOwner(SCOPE, orderId)).toBe(owner);
  });

  it('a late authoritative completion settles the original hold after the UI went stale', async () => {
    const orderId = nextOrderId('late');
    const owner = claim(orderId);
    const reply = deferred<unknown>();

    const run = runOrdinaryCollection(owner, original({ method: 'card', transactionRef: 'ref-late' }), async () => {
      const facts = readOrdinaryWriteReply(await reply.promise);
      noteOrdinaryWriteFacts(owner, facts);
      return { verdict: classifyOrdinaryWrite(facts), value: facts.paymentId, code: facts.code };
    });
    await tick();
    expect(ordinaryCollectionView(owner)?.phase).toBe('sending');

    // The modal unmounted; a remount sees the order reserved and gets no second owner.
    expect(claimOrdinaryCollectionOwner(SCOPE, orderId)).toMatchObject({
      claimed: false,
      code: 'GIFT_CARD_COLLECTION_IN_PROGRESS',
      retained: null,
    });

    reply.resolve({ success: true, orderId, paymentId: 'pay-late', method: 'card', amount: 12.5, settlement: {} });
    await expect(run).resolves.toEqual({ status: 'completed', value: 'pay-late', code: null });
    expect(admission(orderId).reservation).toBeNull();
    expect(retainedOrdinaryOwner(SCOPE, orderId)).toBeNull();

    const next = claimOrdinaryCollectionOwner(SCOPE, orderId);
    expect(next.claimed).toBe(true);
    if (next.claimed) {
      expect(next.owner).not.toBe(owner);
      expect(releaseOrdinaryOwnerBeforeSend(next.owner)).toBe(true);
    }
  });

  it('refuses a wrong or non-current owner', async () => {
    const orderId = nextOrderId('wrong');
    const owner = claim(orderId);
    const send = vi.fn(async () => ({ verdict: 'completed' as const, value: 1 }));
    const read = vi.fn(async () => ({ completedPayments: [row('pay-1', 'ref-1')], value: 1 }));
    const copy = { ...owner } as OrdinaryCollectionOwner;
    const forged = Object.freeze({ ...owner, hold: { ...owner.hold } }) as OrdinaryCollectionOwner;

    for (const impostor of [copy, forged]) {
      await expect(runOrdinaryCollection(impostor, original(), send)).resolves.toEqual({
        status: 'refused',
        code: 'GIFT_CARD_HOLD_NOT_CURRENT',
      });
      expect(releaseOrdinaryOwnerBeforeSend(impostor)).toBe(false);
      expect(ordinaryCollectionView(impostor)).toBeNull();
      await expect(probeOrdinaryOwner(impostor, read)).resolves.toEqual({ status: 'not_current', value: null });
      expect(ledgerHasOriginalOrdinaryPayment(impostor, [row('pay-1', 'ref-1')])).toBe(false);
    }
    expect(ordinaryCollectionView(null)).toBeNull();
    expect(releaseOrdinaryOwnerBeforeSend(undefined)).toBe(false);

    // Another order's owner never touches this order's hold.
    const other = claim(nextOrderId('wrong-other'));
    expect(releaseOrdinaryOwnerBeforeSend(other)).toBe(true);
    expect(admission(orderId).reservation).toEqual({ kind: 'ordinary', status: 'busy', code: null });

    // Once released, the old owner is spent, and it never settles a newer claim.
    expect(releaseOrdinaryOwnerBeforeSend(owner)).toBe(true);
    await expect(runOrdinaryCollection(owner, original(), send)).resolves.toEqual({
      status: 'refused',
      code: 'GIFT_CARD_HOLD_NOT_CURRENT',
    });
    const fresh = claim(orderId);
    expect(fresh).not.toBe(owner);
    expect(releaseOrdinaryOwnerBeforeSend(owner)).toBe(false);
    expect(admission(orderId).reservation?.status).toBe('busy');
    expect(releaseOrdinaryOwnerBeforeSend(fresh)).toBe(true);

    expect(send).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('probeOrdinaryOwner', () => {
  it('joins concurrent probes into one snapshot read and never writes', async () => {
    const orderId = nextOrderId('probe-join');
    const owner = await unknownOwner(orderId, { transactionRef: 'ref-join', idempotencyKey: 'ref-join' });
    const snapshot = deferred<{ completedPayments: unknown[]; value: string }>();
    const read = vi.fn(() => snapshot.promise);

    const first = probeOrdinaryOwner(owner, read);
    const second = probeOrdinaryOwner(owner, read);
    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);

    snapshot.resolve({ completedPayments: [], value: 'unpaid' });
    await expect(first).resolves.toEqual({ status: 'unknown', value: 'unpaid' });
    await expect(second).resolves.toEqual({ status: 'unknown', value: 'unpaid' });
    await tick();

    // Once answered, a later probe reads afresh.
    const third = probeOrdinaryOwner(owner, async () => ({ completedPayments: [], value: 'again' }));
    expect(third).not.toBe(first);
    await expect(third).resolves.toEqual({ status: 'unknown', value: 'again' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(retainedOrdinaryOwner(SCOPE, orderId)).toBe(owner);
    expectNoWrites();
  });

  it('completes on the original payment ID; later facts never replace the original ones', async () => {
    const orderId = nextOrderId('probe-id');
    const owner = claim(orderId);
    await runOrdinaryCollection(owner, original(), async () => {
      // Approved without booking: unknown, but the reply named its payment.
      const facts = readOrdinaryWriteReply({ success: true, paymentId: 'pay-orig', paymentPersisted: false });
      noteOrdinaryWriteFacts(owner, facts);
      return { verdict: classifyOrdinaryWrite(facts), value: null };
    });
    expect(ordinaryCollectionView(owner)).toMatchObject({
      phase: 'unknown',
      facts: { paymentId: 'pay-orig', success: true, paymentPersisted: false, replyLost: false },
    });
    noteOrdinaryWriteFacts(owner, readOrdinaryWriteReply({ success: true, paymentId: 'pay-other' }));
    expect(ordinaryCollectionView(owner)?.facts?.paymentId).toBe('pay-orig');

    await expect(
      probeOrdinaryOwner(owner, async () => ({ completedPayments: [row('pay-orig', null)], value: 'snap' })),
    ).resolves.toEqual({ status: 'completed', value: 'snap' });
    expect(admission(orderId).reservation).toBeNull();
    expect(retainedOrdinaryOwner(SCOPE, orderId)).toBeNull();
    expect(ordinaryCollectionView(owner)).toBeNull();
    expectNoWrites();
  });

  it('completes on the original transaction reference after a lost reply', async () => {
    const orderId = nextOrderId('probe-ref');
    const owner = await unknownOwner(orderId, { transactionRef: 'ref-lost' });

    await expect(
      probeOrdinaryOwner(owner, async () => ({ completedPayments: [row('pay-x', 'ref-lost')], value: 1 })),
    ).resolves.toEqual({ status: 'completed', value: 1 });
    expect(admission(orderId).reservation).toBeNull();
  });

  it('completes on the exact EFT transaction ID noted during the send', async () => {
    const orderId = nextOrderId('probe-eft');
    const owner = await unknownOwner(orderId, { method: 'card' }, (holder) => {
      const terminal = classifyOrdinaryTerminalReply({
        success: true,
        transaction: { id: 'txn-eft-9', status: 'approved' },
      });
      noteOrdinaryTerminalTransaction(holder, terminal.transactionId);
      noteOrdinaryTerminalTransaction(holder, 'txn-other');
    });
    expect(ordinaryCollectionView(owner)?.original?.terminalTransactionId).toBe('txn-eft-9');

    await expect(
      probeOrdinaryOwner(owner, async () => ({ completedPayments: [row('pay-y', 'txn-other')], value: 1 })),
    ).resolves.toEqual({ status: 'unknown', value: 1 });
    await expect(
      probeOrdinaryOwner(owner, async () => ({ completedPayments: [row('pay-y', 'txn-eft-9')], value: 2 })),
    ).resolves.toEqual({ status: 'completed', value: 2 });
    expect(admission(orderId).reservation).toBeNull();
  });

  it('stays unknown when another payment settled the order or the snapshot is unreadable', async () => {
    const orderId = nextOrderId('probe-other');
    const owner = await unknownOwner(orderId, { transactionRef: 'ref-mine' });

    await expect(
      probeOrdinaryOwner(owner, async () => ({
        completedPayments: [row('pay-someone', 'ref-someone')],
        value: 'settled-by-another',
      })),
    ).resolves.toEqual({ status: 'unknown', value: 'settled-by-another' });
    await expect(
      probeOrdinaryOwner(owner, async () => ({ completedPayments: [row('pay-void', 'ref-mine', 'voided')], value: 0 })),
    ).resolves.toEqual({ status: 'unknown', value: 0 });
    await expect(
      probeOrdinaryOwner(owner, async () => {
        throw new Error('snapshot unavailable');
      }),
    ).resolves.toEqual({ status: 'unknown', value: null });
    await expect(probeOrdinaryOwner(owner, async () => null)).resolves.toEqual({ status: 'unknown', value: null });

    expect(admission(orderId).reservation).toMatchObject({ kind: 'ordinary', status: 'unknown' });
    expect(retainedOrdinaryOwner(SCOPE, orderId)).toBe(owner);
    expectNoWrites();
  });

  it('reads nothing unless the collection is unknown', async () => {
    const orderId = nextOrderId('probe-held');
    const owner = claim(orderId);
    const read = vi.fn(async () => ({ completedPayments: [row('pay-1', null)], value: 1 }));

    await expect(probeOrdinaryOwner(owner, read)).resolves.toEqual({ status: 'unknown', value: null });
    expect(read).not.toHaveBeenCalled();
    // No original operation yet, so no ledger row can be it.
    expect(ledgerHasOriginalOrdinaryPayment(owner, [row('pay-1', null)])).toBe(false);
    expect(releaseOrdinaryOwnerBeforeSend(owner)).toBe(true);
  });
});

describe('classifyOrdinaryWrite (native payment_record envelopes)', () => {
  const settlement = {
    orderTotal: 12.5,
    netPaid: 0,
    outstandingAmount: 12.5,
    completedPayments: [],
    generation: 'a'.repeat(64),
  };
  const cases: Array<[string, unknown, boolean, OrdinaryCollectionVerdict, string | null]> = [
    [
      'success (payments.rs record_payment_with_expected_balance)',
      {
        success: true,
        orderId: 'o-1',
        paymentId: 'pay-1',
        method: 'cash',
        amount: 12.5,
        settlement,
        paymentOrigin: 'manual',
        syncStatus: 'pending',
        syncState: 'pending',
        message: 'Payment of 12.50 recorded',
      },
      false,
      'completed',
      null,
    ],
    [
      // payments.rs wraps an unapproved fiscal checkout this way after the
      // device may already have been called: nothing proves it was not sent.
      'FISCAL_CHECKOUT_NOT_APPROVED without reconciliation',
      {
        success: false,
        errorCode: 'FISCAL_CHECKOUT_NOT_APPROVED',
        paymentApproved: false,
        paymentPersisted: false,
        requiresReconciliation: false,
        error: 'Fiscal checkout was not approved',
        fiscalCheckout: { success: false, approved: false },
      },
      false,
      'unknown',
      'FISCAL_CHECKOUT_NOT_APPROVED',
    ],
    [
      'FISCAL_CHECKOUT_NOT_APPROVED requiring reconciliation',
      {
        success: false,
        errorCode: 'FISCAL_CHECKOUT_NOT_APPROVED',
        paymentApproved: false,
        paymentPersisted: false,
        requiresReconciliation: true,
        error: 'Fiscal checkout was not approved',
        fiscalCheckout: { success: false, approved: false, requiresReconciliation: true },
      },
      false,
      'unknown',
      'FISCAL_CHECKOUT_NOT_APPROVED',
    ],
    [
      'PAYMENT_PERSISTENCE_RECONCILIATION_REQUIRED',
      {
        success: false,
        errorCode: 'PAYMENT_PERSISTENCE_RECONCILIATION_REQUIRED',
        paymentApproved: true,
        paymentPersisted: false,
        requiresReconciliation: true,
        error: 'The fiscal payment was approved, but local persistence could not be completed.',
        fiscalCheckout: { success: true, approved: true },
      },
      false,
      'unknown',
      'PAYMENT_PERSISTENCE_RECONCILIATION_REQUIRED',
    ],
    ...(['IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_KEY_INVALID'].map((code) => [
      code,
      {
        success: false,
        errorCode: code,
        paymentApproved: false,
        paymentPersisted: false,
        requiresReconciliation: false,
        error: 'A valid payment attempt identifier is required before collecting the outstanding balance.',
      },
      false,
      'not_sent',
      code,
    ]) as Array<[string, unknown, boolean, OrdinaryCollectionVerdict, string | null]>),
    ...(['BALANCE_CHANGED', 'EXPECTED_SETTLEMENT_REQUIRED'].map((code) => [
      `${code} (settlement mismatch)`,
      {
        success: false,
        errorCode: code,
        paymentApproved: false,
        paymentPersisted: false,
        error: 'The order balance changed. Refresh the payment details before collecting it.',
        settlement,
      },
      false,
      'not_sent',
      code,
    ]) as Array<[string, unknown, boolean, OrdinaryCollectionVerdict, string | null]>),
    [
      // The wrapper's Err branch: false/false flags without any dispatch stage.
      'fiscal checkout error',
      {
        success: false,
        errorCode: 'FISCAL_CHECKOUT_NOT_APPROVED',
        paymentApproved: false,
        paymentPersisted: false,
        error: 'ECR device offline',
      },
      false,
      'unknown',
      'FISCAL_CHECKOUT_NOT_APPROVED',
    ],
    ['command Err (invoke rejected)', new Error('Order not found'), true, 'unknown', null],
    ['lost reply', undefined, true, 'unknown', null],
    ['null reply', null, false, 'unknown', null],
    ['non-object reply', 'ok', false, 'unknown', null],
    ['generic false', { success: false, error: 'Payment processing failed' }, false, 'unknown', null],
    ['success without a payment ID', { success: true, orderId: 'o-1' }, false, 'unknown', null],
    ['success not persisted', { success: true, paymentId: 'pay-1', paymentPersisted: false }, false, 'unknown', null],
    [
      'approved but not persisted, no reconciliation flag',
      { success: false, paymentApproved: true, paymentPersisted: false },
      false,
      'unknown',
      null,
    ],
    ['refused without the persisted flag', { success: false, paymentApproved: false }, false, 'unknown', null],
    // The release's answers (unsaved_payments / payment_review, 30/09/2026).
    [
      // The card was charged and its row is not saved: the native record holds
      // the Z and "Save payment again" replays it. Never not_sent.
      'PAYMENT_NOT_SAVED (unsaved_payments::not_saved_response)',
      {
        success: false,
        errorCode: 'PAYMENT_NOT_SAVED',
        paymentNotSaved: true,
        paymentApproved: true,
        paymentPersisted: false,
        requiresReconciliation: true,
        orderId: 'o-1',
        method: 'card',
        amount: 12.5,
        amountCents: 1250,
        error: 'The card was charged 12.50, but the payment could not be saved on this till yet.',
      },
      false,
      'unknown',
      'PAYMENT_NOT_SAVED',
    ],
    [
      // Refused first thing in payment_record, before any fiscal dispatch or
      // write, while another charged payment of the order is not saved.
      'PAYMENT_NOT_SAVED_PENDING (unsaved_payments::pending_refusal_response)',
      {
        success: false,
        errorCode: 'PAYMENT_NOT_SAVED_PENDING',
        paymentNotSaved: true,
        paymentApproved: false,
        paymentPersisted: false,
        orderId: 'o-1',
        amount: 12.5,
        amountCents: 1250,
        error: 'A card payment of 12.50 on this order is charged but not saved on this till yet.',
      },
      false,
      'not_sent',
      'PAYMENT_NOT_SAVED_PENDING',
    ],
    [
      // Money that moved found the order covered: persisted set aside. The
      // original operation is booked (its hold ends); the caller shows the
      // set-aside notice, never a collection.
      'PAYMENT_SET_ASIDE_FOR_REVIEW (payments::set_aside answer)',
      {
        success: false,
        errorCode: 'PAYMENT_SET_ASIDE_FOR_REVIEW',
        paymentSetAside: true,
        paymentApproved: true,
        paymentPersisted: true,
        requiresReconciliation: false,
        orderId: 'o-1',
        paymentId: 'pay-set-aside',
        method: 'card',
        amount: 12.5,
        amountDue: 0,
        reason: 'order_already_covered',
        error: 'This order was already paid.',
      },
      false,
      'completed',
      'PAYMENT_SET_ASIDE_FOR_REVIEW',
    ],
    [
      'a set-aside code without the persisted flag stays unknown',
      { success: false, errorCode: 'PAYMENT_SET_ASIDE_FOR_REVIEW', paymentApproved: true },
      false,
      'unknown',
      'PAYMENT_SET_ASIDE_FOR_REVIEW',
    ],
  ];

  it.each(cases)('%s', (_name, raw, threw, verdict, code) => {
    const facts = readOrdinaryWriteReply(raw, threw);
    expect(classifyOrdinaryWrite(facts)).toBe(verdict);
    expect(facts.code).toBe(code);
  });

  /** One original write through the real controller, replying with a native envelope. */
  async function runNativeWrite(orderId: string, reply: unknown) {
    const owner = claim(orderId);
    bridge.payments.recordPayment.mockResolvedValueOnce(reply);
    const run = await runOrdinaryCollection(owner, original(), async () => {
      const raw = await bridge.payments.recordPayment({ orderId, method: 'cash', amount: 12.5 });
      const facts = readOrdinaryWriteReply(raw, false);
      noteOrdinaryWriteFacts(owner, facts);
      return { verdict: classifyOrdinaryWrite(facts), value: raw, code: facts.code };
    });
    return { owner, run };
  }

  it('keeps the original held after a fiscal failure envelope that may follow dispatch', async () => {
    const orderId = nextOrderId('fiscal-post-dispatch');
    const { owner, run } = await runNativeWrite(orderId, {
      success: false,
      errorCode: 'FISCAL_CHECKOUT_NOT_APPROVED',
      paymentApproved: false,
      paymentPersisted: false,
      requiresReconciliation: false,
      error: 'ECR device offline',
      fiscalCheckout: { success: false, approved: false },
    });

    expect(run.status).toBe('unknown');
    expect(retainedOrdinaryOwner(SCOPE, orderId)).toBe(owner);
    expect(ordinaryCollectionView(owner)?.phase).toBe('unknown');
    expect(claimOrdinaryCollectionOwner(SCOPE, orderId).claimed).toBe(false);
    // An empty ledger proves nothing either way.
    expect((await probeOrdinaryOwner(owner, async () => ({ completedPayments: [], value: 0 }))).status).toBe('unknown');
    expect(retainedOrdinaryOwner(SCOPE, orderId)).toBe(owner);
    expect(bridge.payments.recordPayment).toHaveBeenCalledTimes(1);
  });

  it.each(['BALANCE_CHANGED', 'EXPECTED_SETTLEMENT_REQUIRED', 'IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_KEY_INVALID'])(
    'releases the original after the pre-dispatch refusal %s',
    async (code) => {
      const orderId = nextOrderId(`pre-dispatch-${code}`);
      const { run } = await runNativeWrite(orderId, {
        success: false,
        errorCode: code,
        paymentApproved: false,
        paymentPersisted: false,
        requiresReconciliation: false,
        error: 'The order balance changed. Refresh the payment details before collecting it.',
      });

      expect(run.status).toBe('not_sent');
      expect(retainedOrdinaryOwner(SCOPE, orderId)).toBeNull();
      const next = claimOrdinaryCollectionOwner(SCOPE, orderId);
      expect(next.claimed).toBe(true);
      if (next.claimed) releaseOrdinaryOwnerBeforeSend(next.owner);
    },
  );

  /** A Split batch: every draft is sent under one original and its own reference. */
  async function runBatch(orderId: string, writes: Array<[unknown, boolean, string | null]>) {
    const owner = claim(orderId);
    const run = await runOrdinaryCollection(owner, original({ amount: 20 }), async () => {
      for (const [raw, threw, ref] of writes) noteOrdinaryBatchWrite(owner, readOrdinaryWriteReply(raw, threw), ref);
      return { verdict: 'unknown' as const, value: undefined };
    });
    expect(run.status).toBe('unknown');
    return owner;
  }

  const bookedA = { success: true, paymentId: 'pay-A', paymentPersisted: true };
  const probeLedger = (owner: OrdinaryCollectionOwner, rows: unknown[]) =>
    probeOrdinaryOwner(owner, async () => ({ completedPayments: rows, value: rows.length }));

  it('a first booked portion never discharges a later lost write that has no reference', async () => {
    const orderId = nextOrderId('batch-lost');
    const owner = await runBatch(orderId, [[bookedA, false, null], [undefined, true, null]]);

    // Each probe stands for one close and reopen of a collection surface.
    for (const rows of [[], [row('pay-A', null)], [row('pay-A', null), row('pay-B', null)]]) {
      expect((await probeLedger(owner, rows)).status).toBe('unknown');
      expect(retainedOrdinaryOwner(SCOPE, orderId)).toBe(owner);
      expect(claimOrdinaryCollectionOwner(SCOPE, orderId).claimed).toBe(false);
    }
    expectNoWrites();
  });

  it('releases a batch only on exact proof for every uncertain write', async () => {
    const orderId = nextOrderId('batch-proof');
    const owner = await runBatch(orderId, [
      [bookedA, false, null],
      [{ success: true, paymentId: 'pay-B', paymentPersisted: false }, false, null],
      [undefined, true, 'split-ref-3'],
    ]);

    // The booked row proves nothing for a later write, even carrying its reference.
    for (const rows of [[], [row('pay-A', null)], [row('pay-A', 'split-ref-3'), row('pay-B', null)]]) {
      expect((await probeLedger(owner, rows)).status).toBe('unknown');
      expect(retainedOrdinaryOwner(SCOPE, orderId)).toBe(owner);
    }
    const proof = [row('pay-A', null), row('pay-B', null), row('pay-C', 'split-ref-3')];
    expect((await probeLedger(owner, proof)).status).toBe('completed');
    expect(retainedOrdinaryOwner(SCOPE, orderId)).toBeNull();
    expectNoWrites();
  });

  it('reads the raw facts without reducing them to one flag', () => {
    expect(readOrdinaryWriteReply(undefined, true)).toEqual({
      replyLost: true,
      success: null,
      paymentApproved: null,
      paymentPersisted: null,
      requiresReconciliation: null,
      paymentId: null,
      code: null,
    });
    expect(
      readOrdinaryWriteReply({
        success: false,
        errorCode: 'PAYMENT_PERSISTENCE_RECONCILIATION_REQUIRED',
        paymentApproved: true,
        paymentPersisted: false,
        requiresReconciliation: true,
      }),
    ).toEqual({
      replyLost: false,
      success: false,
      paymentApproved: true,
      paymentPersisted: false,
      requiresReconciliation: true,
      paymentId: null,
      code: 'PAYMENT_PERSISTENCE_RECONCILIATION_REQUIRED',
    });
    // A nested payment ID is read; a human error text never becomes a code.
    expect(readOrdinaryWriteReply({ success: true, data: { paymentId: ' pay-2 ' } }).paymentId).toBe('pay-2');
    expect(readOrdinaryWriteReply({ success: false, code: 'BALANCE_CHANGED' }).code).toBe('BALANCE_CHANGED');
    expect(readOrdinaryWriteReply({ success: false, errorCode: 'balance changed', error: 'NOPE' }).code).toBeNull();
    // A reply that is present but thrown still counts as lost.
    expect(readOrdinaryWriteReply({ success: true, paymentId: 'pay-1' }, true).replyLost).toBe(true);
  });
});

describe('classifyOrdinaryTerminalReply (native ecr_process_payment envelopes)', () => {
  const ecrReply = (status: string, extra: Record<string, unknown> = {}, success = status === 'approved') => ({
    success,
    transaction: {
      id: 'txn-7',
      amount: 12.5,
      status,
      authorizationCode: null,
      terminalReference: null,
      cardType: null,
      cardLastFour: null,
      entryMethod: null,
      errorMessage: null,
      startedAt: '2026-09-29T12:00:00Z',
      completedAt: '2026-09-29T12:00:05Z',
      ...extra,
    },
    options: { orderId: 'o-1' },
  });

  it.each([
    ['approved', ecrReply('approved'), false, { verdict: 'approved', transactionId: 'txn-7', message: null }],
    [
      'declined',
      ecrReply('declined', { errorMessage: 'Insufficient funds' }),
      false,
      { verdict: 'not_sent', transactionId: 'txn-7', message: 'Insufficient funds' },
    ],
    ['cancelled', ecrReply('cancelled'), false, { verdict: 'not_sent', transactionId: 'txn-7', message: null }],
    ['canceled spelling', ecrReply('canceled'), false, { verdict: 'not_sent', transactionId: 'txn-7', message: null }],
    ['uppercase APPROVED', ecrReply('APPROVED', {}, true), false, { verdict: 'approved', transactionId: 'txn-7', message: null }],
    ['timeout', ecrReply('timeout'), false, { verdict: 'unknown', transactionId: 'txn-7', message: null }],
    [
      'error status',
      ecrReply('error', { errorMessage: 'Comms fault' }),
      false,
      { verdict: 'unknown', transactionId: 'txn-7', message: 'Comms fault' },
    ],
    ['pending', ecrReply('pending'), false, { verdict: 'unknown', transactionId: 'txn-7', message: null }],
    ['processing', ecrReply('processing'), false, { verdict: 'unknown', transactionId: 'txn-7', message: null }],
    [
      'approved status on a false envelope',
      ecrReply('approved', {}, false),
      false,
      { verdict: 'unknown', transactionId: 'txn-7', message: null },
    ],
    [
      'approved without a transaction ID',
      ecrReply('approved', { id: null }),
      false,
      { verdict: 'unknown', transactionId: null, message: null },
    ],
    [
      'declined without a transaction ID',
      ecrReply('declined', { id: '' }),
      false,
      { verdict: 'unknown', transactionId: null, message: null },
    ],
    [
      'device exchange failed (no transaction)',
      { success: false, error: 'Serial port closed', options: {} },
      false,
      { verdict: 'unknown', transactionId: null, message: 'Serial port closed' },
    ],
    [
      'no device connected',
      { success: false, error: 'No ECR device connected', options: {} },
      false,
      { verdict: 'unknown', transactionId: null, message: 'No ECR device connected' },
    ],
    ['thrown call', ecrReply('approved'), true, { verdict: 'unknown', transactionId: null, message: null }],
    ['lost reply', undefined, false, { verdict: 'unknown', transactionId: null, message: null }],
  ])('%s', (_name, raw, threw, expected) => {
    expect(classifyOrdinaryTerminalReply(raw, threw)).toEqual(expected);
  });
});

describe('adoptGiftCardPaymentIds', () => {
  it('returns only unseen canonical gift payment IDs, idempotently across calls', () => {
    const orderId = nextOrderId('adopt');

    expect(adoptGiftCardPaymentIds(SCOPE, orderId, ['gift-1', ' gift-2 ', 'gift-1', ''])).toEqual([
      'gift-1',
      'gift-2',
    ]);
    expect(adoptGiftCardPaymentIds(SCOPE, orderId, ['gift-2', 'gift-3'])).toEqual(['gift-3']);
    expect(adoptGiftCardPaymentIds(SCOPE, ` ${orderId} `, ['gift-1', 'gift-3'])).toEqual([]);
    expect(adoptGiftCardPaymentIds(SCOPE, orderId, [])).toEqual([]);
    // Scoped per organization, terminal and order.
    expect(
      adoptGiftCardPaymentIds({ organizationId: 'org-ordinary', terminalId: 'term-other' }, orderId, ['gift-1']),
    ).toEqual(['gift-1']);
    expect(adoptGiftCardPaymentIds(SCOPE, nextOrderId('adopt-other'), ['gift-1'])).toEqual(['gift-1']);
    expect(adoptGiftCardPaymentIds(SCOPE, '   ', ['gift-9'])).toEqual([]);
    expectNoWrites();
  });
});

describe('useOrderStore.processPayment gift refusal', () => {
  beforeEach(() => {
    useOrderStore.setState({ silentRefresh: vi.fn(async () => undefined) } as never);
  });

  it.each(['gift_card', 'GIFT_CARD', 'Gift Card', 'gift-card', 'giftcard', 'GiftCard', 'gift', ' Gift ', 'gift  card'])(
    'refuses %j before normalization and before any IPC call',
    async (method) => {
      const result = await useOrderStore
        .getState()
        .processPayment(nextOrderId('gift'), { method: method as never, amount: 5 });

      expect(result).toEqual({ success: false, error: 'GIFT_CARD_GENERIC_PAYMENT_REFUSED' });
      expect(bridge.invoke).not.toHaveBeenCalled();
      expectNoWrites();
    },
  );

  it('still records cash through payment:record', async () => {
    const orderId = nextOrderId('cash');

    const result = await useOrderStore
      .getState()
      .processPayment(orderId, { method: 'cash', amount: 5, transactionRef: 'cash-ref-1' });

    expect(result).toEqual({ success: true, transactionId: 'cash-ref-1' });
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
    expect(bridge.invoke).toHaveBeenCalledWith(
      'payment:record',
      expect.objectContaining({ orderId, method: 'cash', amount: 5, transactionRef: 'cash-ref-1' }),
    );
  });

  it('still maps other non-gift methods to other', async () => {
    const orderId = nextOrderId('voucher');

    const result = await useOrderStore
      .getState()
      .processPayment(orderId, { method: 'voucher' as never, amount: 3, transactionRef: 'voucher-ref-1' });

    expect(result).toEqual({ success: true, transactionId: 'voucher-ref-1' });
    expect(bridge.invoke).toHaveBeenCalledWith('payment:record', expect.objectContaining({ orderId, method: 'other' }));
  });
});
