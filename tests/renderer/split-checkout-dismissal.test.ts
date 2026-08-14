import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  loadPersistedSplitDismissal,
  reconcileOutstandingPaymentAttempt,
  resolvePersistedSplitDismissal,
} from '../../src/renderer/utils/splitCheckoutRecovery.ts';

const rendererSource = (...segments: string[]): string =>
  readFileSync(path.join(process.cwd(), 'src', 'renderer', ...segments), 'utf8');

const sliceBetween = (source: string, startMarker: string, endMarker: string): string => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found after start: ${endMarker}`);
  return source.slice(start, end);
};

test('zero completed split payments returns the persisted order to tender selection', () => {
  assert.deepEqual(
    resolvePersistedSplitDismissal({
      fallbackOrderTotal: 24.5,
      order: { totalAmount: 24.5, paidTotal: 0 },
      paymentsResult: [],
    }),
    {
      kind: 'unpaid',
      orderTotal: 24.5,
      paidAmount: 0,
      outstandingAmount: 24.5,
      completedPayments: [],
    },
  );
});

test('partial split keeps completed payment rows and only exposes the outstanding balance', () => {
  const cashPayment = {
    id: 'pay-cash-1',
    status: 'completed',
    amount: 10,
    remainingRefundable: 10,
  };

  assert.deepEqual(
    resolvePersistedSplitDismissal({
      fallbackOrderTotal: 24.5,
      order: { totalAmount: 24.5, paidTotal: 10 },
      paymentsResult: [cashPayment, { id: 'voided', status: 'voided', amount: 5 }],
    }),
    {
      kind: 'partial',
      orderTotal: 24.5,
      paidAmount: 10,
      outstandingAmount: 14.5,
      completedPayments: [cashPayment],
    },
  );
});

test('explicit backend outstanding balance wins over renderer payment arithmetic', () => {
  const payment = {
    id: 'pay-stale-renderer-view',
    status: 'completed',
    amount: 10,
    remainingRefundable: 10,
  };

  const resolution = resolvePersistedSplitDismissal({
    fallbackOrderTotal: 30,
    order: {
      totalAmount: 30,
      balance: { outstanding_balance: 7.25 },
      paidTotal: 20,
    },
    paymentsResult: [payment],
  });

  assert.equal(resolution.kind, 'partial');
  assert.equal(resolution.outstandingAmount, 7.25);
  assert.equal(resolution.paidAmount, 22.75);
  assert.deepEqual(resolution.completedPayments, [payment]);
});

test('fully settled dismissal never reopens a payment surface', () => {
  assert.equal(
    resolvePersistedSplitDismissal({
      fallbackOrderTotal: 12,
      order: { totalAmount: 12 },
      paymentsResult: [{ status: 'paid', amount: 12 }],
    }).kind,
    'settled',
  );
});

test('an exact one-cent outstanding balance remains payable', () => {
  const resolution = resolvePersistedSplitDismissal({
    fallbackOrderTotal: 12,
    order: { totalAmount: 12, outstandingAmount: 0.01 },
    paymentsResult: {
      outstandingAmount: 0.01,
      payments: [{ status: 'completed', amount: 11.99 }],
    },
  });

  assert.equal(resolution.kind, 'partial');
  assert.equal(resolution.outstandingAmount, 0.01);
});

test('latest persisted reconciliation wins over a stale paid completion signal', () => {
  const latest = resolvePersistedSplitDismissal({
    fallbackOrderTotal: 20,
    order: { totalAmount: 20 },
    paymentsResult: [{ status: 'completed', amount: 8 }],
  });

  assert.equal(latest.kind, 'partial');
  assert.equal(latest.outstandingAmount, 12);
});

test('split dismissal loads one authoritative native settlement snapshot', async () => {
  const getSettlementSnapshot = async (orderId: string) => ({
    success: true as const,
    orderId,
    orderTotal: 30,
    netPaid: 12,
    outstandingAmount: 18,
    completedPayments: [{ id: 'payment-1', status: 'completed', amount: 12 }],
    generation: 'a'.repeat(64),
  });
  const result = await loadPersistedSplitDismissal({
    payments: {
      getSettlementSnapshot,
    },
  }, 'order-1', 99);

  assert.deepEqual(result, {
    kind: 'partial',
    orderTotal: 30,
    paidAmount: 12,
    outstandingAmount: 18,
    completedPayments: [{ id: 'payment-1', status: 'completed', amount: 12 }],
    settlementGeneration: 'a'.repeat(64),
  });
});

test('split dismissal rejects malformed or mismatched native snapshots', async () => {
  for (const snapshot of [
    {
      success: true as const,
      orderId: 'other-order',
      orderTotal: 30,
      netPaid: 12,
      outstandingAmount: 18,
      completedPayments: [],
      generation: 'a'.repeat(64),
    },
    {
      success: true as const,
      orderId: 'order-1',
      orderTotal: 30,
      netPaid: 12,
      outstandingAmount: 3,
      completedPayments: [],
      generation: 'a'.repeat(64),
    },
  ]) {
    await assert.rejects(
      loadPersistedSplitDismissal({
        payments: { getSettlementSnapshot: async () => snapshot },
      }, 'order-1', 30),
      /INVALID_PAYMENT_SETTLEMENT_SNAPSHOT/,
    );
  }
});

test('an ambiguous collection rejection finalizes from the authoritative settled snapshot without retrying', async () => {
  let recordAttempts = 0;
  const result = await reconcileOutstandingPaymentAttempt({
    recordPayment: async () => {
      recordAttempts += 1;
      throw new Error('HTTP 500 Bearer customer@example.com');
    },
    bridge: {
      payments: {
        getSettlementSnapshot: async (orderId: string) => ({
          success: true as const,
          orderId,
          orderTotal: 24.5,
          netPaid: 24.5,
          outstandingAmount: 0,
          completedPayments: [{ id: 'payment-committed', status: 'completed', amount: 24.5 }],
          generation: 'b'.repeat(64),
        }),
      },
    },
    orderId: 'order-1',
    fallbackOrderTotal: 24.5,
  });

  assert.equal(recordAttempts, 1, 'reconciliation must never issue a second payment attempt');
  assert.equal(result.kind, 'settled');
  assert.equal(result.recordPaymentFailed, true);
  assert.equal(result.settlement.outstandingAmount, 0);
  assert.doesNotMatch(JSON.stringify(result), /Bearer|customer@example\.com|HTTP 500/);
});

test('an ambiguous collection rejection resumes split from the latest partial ledger', async () => {
  const completedPayment = { id: 'payment-1', status: 'completed', amount: 10 };
  const result = await reconcileOutstandingPaymentAttempt({
    recordPayment: async () => Promise.reject(new Error('private backend detail')),
    bridge: {
      payments: {
        getSettlementSnapshot: async (orderId: string) => ({
          success: true as const,
          orderId,
          orderTotal: 24.5,
          netPaid: 10,
          outstandingAmount: 14.5,
          completedPayments: [completedPayment],
          generation: 'c'.repeat(64),
        }),
      },
    },
    orderId: 'order-1',
    fallbackOrderTotal: 24.5,
  });

  assert.equal(result.kind, 'partial');
  assert.equal(result.recordPaymentFailed, true);
  assert.deepEqual(result.settlement.completedPayments, [completedPayment]);
  assert.equal(result.settlement.outstandingAmount, 14.5);
  assert.equal(result.settlement.settlementGeneration, 'c'.repeat(64));
});

test('an unpaid or unavailable post-attempt snapshot keeps recovery safe and refreshable', async () => {
  const unpaid = await reconcileOutstandingPaymentAttempt({
    recordPayment: async () => ({ success: false, error: 'private backend detail' }),
    bridge: {
      payments: {
        getSettlementSnapshot: async (orderId: string) => ({
          success: true as const,
          orderId,
          orderTotal: 24.5,
          netPaid: 0,
          outstandingAmount: 24.5,
          completedPayments: [],
          generation: 'd'.repeat(64),
        }),
      },
    },
    orderId: 'order-1',
    fallbackOrderTotal: 99,
  });
  assert.equal(unpaid.kind, 'unpaid');
  assert.equal(unpaid.recordPaymentFailed, true);
  assert.equal(unpaid.settlement.outstandingAmount, 24.5);
  assert.equal(unpaid.settlement.settlementGeneration, 'd'.repeat(64));

  const unknown = await reconcileOutstandingPaymentAttempt({
    recordPayment: async () => Promise.reject(new Error('secret record error')),
    bridge: {
      payments: {
        getSettlementSnapshot: async () => Promise.reject(new Error('secret snapshot error')),
      },
    },
    orderId: 'order-1',
    fallbackOrderTotal: 24.5,
  });
  assert.deepEqual(unknown, { kind: 'unknown', recordPaymentFailed: true });
});

test('an unknown attempt retries the authoritative snapshot without issuing another payment write', async () => {
  let recordAttempts = 0;
  let snapshotAttempts = 0;
  const bridge = {
    payments: {
      getSettlementSnapshot: async (orderId: string) => {
        snapshotAttempts += 1;
        if (snapshotAttempts === 1) {
          throw new Error('temporary snapshot failure');
        }
        return {
          success: true as const,
          orderId,
          orderTotal: 24.5,
          netPaid: 0,
          outstandingAmount: 24.5,
          completedPayments: [],
          generation: 'e'.repeat(64),
        };
      },
    },
  };
  const recordPayment = async () => {
    recordAttempts += 1;
    return { success: true };
  };

  const unknown = await reconcileOutstandingPaymentAttempt({
    recordPayment,
    bridge,
    orderId: 'order-1',
    fallbackOrderTotal: 24.5,
  });
  const reconciled = await reconcileOutstandingPaymentAttempt({
    recordPayment,
    snapshotOnly: true,
    bridge,
    orderId: 'order-1',
    fallbackOrderTotal: 24.5,
  });

  assert.equal(unknown.kind, 'unknown');
  assert.equal(reconciled.kind, 'unpaid');
  assert.equal(recordAttempts, 1, 'snapshot-only retry must retain the original write attempt');
  assert.equal(snapshotAttempts, 2);
});

test('every recovered full-balance payment asks native to collect the authoritative outstanding amount', () => {
  for (const [label, segments] of [
    ['OrderDashboard', ['components', 'OrderDashboard.tsx']],
    ['OrderFlow', ['components', 'OrderFlow.tsx']],
    ['NewOrderPage', ['pages', 'NewOrderPage.tsx']],
  ] as const) {
    const source = rendererSource(...segments);
    const handler = sliceBetween(
      source,
      'const handleOutstandingPaymentSelect = useCallback(',
      label === 'OrderDashboard'
        ? 'const buildStatusBlockerSplitPaymentData'
        : 'const handleSplitComplete = useCallback(',
    );
    assert.match(handler, /collectOutstandingBalance:\s*true/, `${label} must use the native balance`);
    assert.match(handler, /expectedSettlementGeneration:\s*pendingPayment\.settlementGeneration/, `${label} must bind collection to the displayed ledger generation`);
    assert.match(
      handler,
      /idempotencyKey:\s*selection\.transactionId/,
      `${label} must bind the native attempt to the tender transaction`,
    );
    assert.doesNotMatch(
      handler,
      /idempotencyKey:\s*pendingPayment\.orderId/,
      `${label} must never reuse the order id as a payment-attempt key`,
    );
    assert.match(
      handler,
      /snapshotOnly:\s*selection\.reconciliationOnly/,
      `${label} must retry an unknown attempt without another payment write`,
    );
    assert.match(
      handler,
      /paymentAttempt\.kind === ['"]unknown['"][\s\S]*?return ['"]reconciliation-pending['"]/,
      `${label} must keep the original tender locked until reconciliation is authoritative`,
    );
    assert.match(
      handler,
      /paymentAttempt\.kind === ['"]unknown['"][\s\S]*?if \(!selection\.reconciliationOnly\) \{[\s\S]*?toast\.error/,
      `${label} must notify once without spamming every snapshot-only retry`,
    );
  }
});

test('OutstandingPaymentMethodModal is presentational and disables new tips', () => {
  const source = rendererSource('components', 'modals', 'OutstandingPaymentMethodModal.tsx');

  assert.match(source, /export type OutstandingPaymentMethod = 'cash' \| 'card' \| 'split';/);
  assert.match(source, /<PaymentModal/);
  assert.match(source, /allowTips=\{false\}/);
  assert.match(source, /method: paymentData\.method/);
  assert.match(source, /const result = await onSelect\(selection\)/);
  assert.match(source, /method: 'split'/);
  assert.doesNotMatch(source, /recordPayment|createOrder|getBridge/);
});

for (const [label, segments] of [
  ['OrderDashboard', ['components', 'OrderDashboard.tsx']],
  ['OrderFlow', ['components', 'OrderFlow.tsx']],
  ['NewOrderPage', ['pages', 'NewOrderPage.tsx']],
] as const) {
  test(`${label} resolves split dismissal against the persisted order`, () => {
    const source = rendererSource(...segments);
    const closeHandler = sliceBetween(
      source,
      label === 'OrderDashboard'
        ? 'const handleSplitPaymentClose = useCallback('
        : 'const handleSplitClose = useCallback(',
      label === 'OrderDashboard'
        ? 'const buildStatusBlockerSplitPaymentData'
        : 'const handleSplitComplete = useCallback(',
    );

    assert.match(closeHandler, /loadPersistedSplitDismissal\(/);
    assert.match(closeHandler, /resolution\.kind === ['"]partial['"]/);
    assert.match(closeHandler, /existingPayments: resolution\.completedPayments/);
    assert.match(closeHandler, /setOutstandingPaymentData\(/);
    assert.match(closeHandler, /splitCloseRecoveryRef\.current/);
    assert.match(closeHandler, /setIsReconcilingSplitClose\(true\)/);
    assert.doesNotMatch(
      closeHandler,
      /resolution\.kind === ['"]settled['"]\s*\|\|\s*completionResult\?\.paymentStatus === ['"]paid['"]/,
      'latest persisted reconciliation must win over the modal completion snapshot',
    );

    const recoveryStart = closeHandler.indexOf('if (splitCloseRecoveryRef.current)');
    assert.notEqual(recoveryStart, -1, 'new-order recovery guard must be present');
    const guardedRecovery = closeHandler.slice(recoveryStart);
    const loadIndex = guardedRecovery.indexOf('await loadPersistedSplitDismissal(');
    const clearIndex = guardedRecovery.indexOf('setSplitPaymentData(null)');
    assert.ok(loadIndex !== -1, 'dismissal must load the persisted payment state');
    assert.ok(
      clearIndex === -1 || clearIndex > loadIndex,
      'the split surface must stay mounted until reconciliation finishes',
    );
  });

  test(`${label} records cash/card on the existing order and never creates a second order`, () => {
    const source = rendererSource(...segments);
    const handler = sliceBetween(
      source,
      'const handleOutstandingPaymentSelect = useCallback(',
      label === 'OrderDashboard'
        ? 'const buildStatusBlockerSplitPaymentData'
        : 'const handleSplitComplete = useCallback(',
    );

    assert.match(handler, /bridge\.payments\.recordPayment\(\{/);
    assert.match(handler, /orderId: pendingPayment\.orderId/);
    assert.match(handler, /amount: pendingPayment\.outstandingAmount/);
    assert.match(
      handler,
      /const paymentAttempt = await reconcileOutstandingPaymentAttempt\(\{/,
      'cash/card outcomes must be verified against the persisted ledger',
    );
    assert.match(handler, /latestResolution\.kind === ['"]partial['"]/);
    assert.match(handler, /latestResolution\.kind !== ['"]settled['"]/);
    const reconcileIndex = handler.indexOf(
      'const paymentAttempt = await reconcileOutstandingPaymentAttempt({',
    );
    const finalizeIndex = handler.indexOf('finalizeCreatedOrderPayment(');
    assert.ok(
      reconcileIndex !== -1 && finalizeIndex > reconcileIndex,
      'checkout finalization must happen only after persisted post-payment reconciliation',
    );
    assert.doesNotMatch(handler, /createOrder\(/);
    assert.match(
      handler,
      /reconcileOutstandingPaymentAttempt\(\{/,
      'the record attempt and atomic post-attempt reconciliation must share one guarded path',
    );
    assert.doesNotMatch(
      handler,
      /paymentResult\?\.error|paymentResult\.error|new Error\(paymentResult/,
      'raw backend payment errors must never cross into renderer error handling',
    );
  });
}

test('SplitPaymentModal blocks close and settlement while parent reconciliation is pending', () => {
  const source = rendererSource('components', 'modals', 'SplitPaymentModal.tsx');

  assert.match(source, /isReconciliationPending\?: boolean/);
  assert.match(source, /isReconciliationPending = false/);
  assert.match(
    source,
    /const isCloseLocked = isReconciliationPending \|\| Boolean\(processingPortionId\) \|\| isProcessing \|\| isTerminalChargeInFlight/,
  );
  assert.match(source, /closeMode=["']request["']/);
  assert.match(source, /closeDisabled=\{isCloseLocked\}/);
  assert.match(source, /closeOnEscape=\{!isCloseLocked\}/);
});

test('SplitPaymentModal blocks every terminal-card entry point during reconciliation', () => {
  const source = rendererSource('components', 'modals', 'SplitPaymentModal.tsx');

  assert.match(
    source,
    /const handleTerminalCardPayment = useCallback\(async \(portionId: string\) => \{\s*if \(isReconciliationPending\) return;/,
  );
  assert.match(
    source,
    /const locked = portion\.status !== 'draft' \|\| isProcessing \|\| isTerminalChargeInFlight \|\| isReconciliationPending;/,
  );
  assert.match(source, /inert=\{isReconciliationPending \? true : undefined\}/);
});
