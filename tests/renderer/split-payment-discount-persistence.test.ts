import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  applyAdditionalDiscount,
  settleDraftPortions,
  settleTerminalPortion,
  type SplitOrderFinancials,
} from '../../src/renderer/utils/splitPaymentSettlement';

const baseFinancials = (totalAmount: number): SplitOrderFinancials => ({
  totalAmount,
  subtotal: totalAmount,
  discountAmount: 0,
  discountPercentage: 0,
  taxAmount: 0,
  deliveryFee: 0,
  tipAmount: 0,
});

// Emulates the modal's persistFinancials effect: bridge.orders.updateFinancials
// followed by setOrderFinancials, so local state tracks the DB in lockstep —
// the exact lockstep that makes ensureLatestOutstanding blind to double-applies.
const makePersistedOrder = (initial: SplitOrderFinancials) => {
  const writes: SplitOrderFinancials[] = [];
  const state = { current: initial };
  return {
    writes,
    state,
    persistFinancials: async (next: SplitOrderFinancials) => {
      writes.push(next);
      state.current = next;
    },
  };
};

test('terminal card decline followed by retry persists the discount exactly once', async () => {
  // €100 order, one €50 portion carrying a €10 discount. First attempt declines,
  // retry approves. The persisted total must end at €90, not €80.
  const order = makePersistedOrder(baseFinancials(100));
  const portion = { id: 'portion-1', discountAmount: 10 };

  await assert.rejects(
    settleTerminalPortion(order.state.current, portion, {
      processPayment: async () => {
        throw new Error('Card payment was not approved');
      },
      recordPayment: async () => 'pay-should-not-exist',
      persistFinancials: order.persistFinancials,
    }),
    /not approved/,
  );

  assert.equal(order.writes.length, 0, 'a declined card payment must not write order financials');
  assert.equal(order.state.current.totalAmount, 100);

  const retry = await settleTerminalPortion(order.state.current, portion, {
    processPayment: async () => ({ transactionId: 'tx-1' }),
    recordPayment: async (transactionId) => {
      assert.equal(transactionId, 'tx-1');
      return 'pay-1';
    },
    persistFinancials: order.persistFinancials,
  });

  assert.equal(order.writes.length, 1, 'discount must be persisted exactly once across decline + retry');
  assert.equal(order.state.current.totalAmount, 90);
  assert.equal(order.state.current.discountAmount, 10);
  assert.equal(retry.financials.totalAmount, 90);
  assert.equal(retry.paymentId, 'pay-1');
  assert.equal(retry.discountPersistFailed, false);
});

test('terminal settlement orders effects charge → record → persist', async () => {
  const order = makePersistedOrder(baseFinancials(100));
  const calls: string[] = [];

  await settleTerminalPortion(order.state.current, { id: 'portion-1', discountAmount: 5 }, {
    processPayment: async () => {
      calls.push('charge');
      return { transactionId: 'tx-1' };
    },
    recordPayment: async () => {
      calls.push('record');
      return 'pay-1';
    },
    persistFinancials: async (next) => {
      calls.push('persist');
      await order.persistFinancials(next);
    },
  });

  assert.deepEqual(calls, ['charge', 'record', 'persist'], 'nothing may be persisted before the charge approves and the payment is recorded');
});

test('confirm mid-loop failure leaves remaining discounts unpersisted; the next confirm applies each exactly once', async () => {
  // Two €50 portions with €10 discounts each on a €100 order. The first confirm
  // records portion A and then fails on portion B. Re-confirming the remaining
  // draft must end at €80 (each discount applied once), not €70.
  const order = makePersistedOrder(baseFinancials(100));
  const portions = [
    { id: 'portion-a', discountAmount: 10 },
    { id: 'portion-b', discountAmount: 10 },
  ];

  await assert.rejects(
    settleDraftPortions(order.state.current, portions, {
      recordPayment: async (portion) => {
        if (portion.id === 'portion-b') throw new Error('record failed');
        return `pay-${portion.id}`;
      },
      persistFinancials: order.persistFinancials,
    }),
    /record failed/,
  );

  assert.deepEqual(
    order.writes.map((write) => write.totalAmount),
    [90],
    'only the successfully recorded portion may have its discount persisted',
  );

  const second = await settleDraftPortions(order.state.current, [portions[1]], {
    recordPayment: async () => 'pay-portion-b',
    persistFinancials: order.persistFinancials,
  });

  assert.deepEqual(
    order.writes.map((write) => write.totalAmount),
    [90, 80],
    'each portion discount must reduce the persisted total exactly once across both confirms',
  );
  assert.equal(second.financials.totalAmount, 80);
  assert.equal(second.financials.discountAmount, 20);
});

test('a single confirm with multiple discounted portions threads the running total through each persist', async () => {
  const order = makePersistedOrder(baseFinancials(100));

  const result = await settleDraftPortions(
    order.state.current,
    [
      { id: 'portion-a', discountAmount: 10 },
      { id: 'portion-b', discountAmount: 10 },
    ],
    {
      recordPayment: async (portion) => `pay-${portion.id}`,
      persistFinancials: order.persistFinancials,
    },
  );

  assert.deepEqual(order.writes.map((write) => write.totalAmount), [90, 80]);
  assert.deepEqual(order.writes.map((write) => write.discountAmount), [10, 20]);
  assert.deepEqual(result.paymentIds, ['pay-portion-a', 'pay-portion-b']);
  assert.deepEqual(result.settledPortionIds, ['portion-a', 'portion-b']);
  assert.deepEqual(result.discountPersistFailures, []);
});

test('terminal discount persist failure keeps the recorded payment and reports loudly', async () => {
  const result = await settleTerminalPortion(baseFinancials(100), { id: 'portion-1', discountAmount: 10 }, {
    processPayment: async () => ({ transactionId: 'tx-1' }),
    recordPayment: async () => 'pay-1',
    persistFinancials: async () => {
      throw new Error('local db write failed');
    },
  });

  assert.equal(result.discountPersistFailed, true);
  assert.equal(result.paymentId, 'pay-1');
  assert.equal(
    result.financials.totalAmount,
    100,
    'an unpersisted discount must leave the total high (loud leftover outstanding), never silently shrink it',
  );
});

test('confirm loop keeps recording portions when one discount persist fails', async () => {
  const order = makePersistedOrder(baseFinancials(100));
  let failNextPersist = true;

  const result = await settleDraftPortions(
    order.state.current,
    [
      { id: 'portion-a', discountAmount: 10 },
      { id: 'portion-b', discountAmount: 5 },
    ],
    {
      recordPayment: async (portion) => `pay-${portion.id}`,
      persistFinancials: async (next) => {
        if (failNextPersist) {
          failNextPersist = false;
          throw new Error('local db hiccup');
        }
        await order.persistFinancials(next);
      },
    },
  );

  assert.deepEqual(result.discountPersistFailures, ['portion-a']);
  assert.deepEqual(result.paymentIds, ['pay-portion-a', 'pay-portion-b']);
  // portion-a's write never landed, so portion-b applies against the unreduced total
  assert.deepEqual(order.writes.map((write) => write.totalAmount), [95]);
  assert.equal(result.financials.totalAmount, 95);
});

test('portions without discounts never touch order financials', async () => {
  const order = makePersistedOrder(baseFinancials(60));

  await settleDraftPortions(
    order.state.current,
    [
      { id: 'portion-a', discountAmount: 0 },
      { id: 'portion-b', discountAmount: 0 },
    ],
    {
      recordPayment: async (portion) => `pay-${portion.id}`,
      persistFinancials: order.persistFinancials,
    },
  );

  assert.equal(order.writes.length, 0);
});

test('applyAdditionalDiscount ignores sub-cent deltas, rounds to cents, clamps at zero, accumulates order discount', () => {
  const financials = { ...baseFinancials(10.05), discountAmount: 1 };

  assert.equal(applyAdditionalDiscount(financials, 0), null);
  assert.equal(applyAdditionalDiscount(financials, 0.004), null);
  assert.equal(applyAdditionalDiscount(financials, -5), null);

  const applied = applyAdditionalDiscount(financials, 2.5);
  assert.deepEqual(applied, { ...financials, totalAmount: 7.55, discountAmount: 3.5 });

  const clamped = applyAdditionalDiscount(baseFinancials(5), 9);
  assert.equal(clamped?.totalAmount, 0);
});

test('SplitPaymentModal routes discount persistence through the settlement helpers', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'SplitPaymentModal.tsx'),
    'utf8',
  );

  assert.match(source, /settleTerminalPortion\(/);
  assert.match(source, /settleDraftPortions\(/);
  assert.doesNotMatch(
    source,
    /persistAdditionalDiscount/,
    'the pre-payment absolute discount write must not come back to the modal',
  );
});
