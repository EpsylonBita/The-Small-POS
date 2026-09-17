import test from 'node:test';
import assert from 'node:assert/strict';

import type { DiagnosticsSystemHealth } from '../../src/lib';
import { buildSyncRecoveryIssues } from '../../src/renderer/components/recovery/sync-recovery-issues';
import type { SyncQueueItem } from '../../../shared/pos/sync-queue-types';

const baseSystemHealth = (overrides: Partial<DiagnosticsSystemHealth> = {}) =>
  ({
    schemaVersion: 1,
    syncBacklog: {},
    paymentAdjustmentBacklog: {
      genericDeferred: 0,
      waitingForParentPayment: 0,
      waitingForCanonicalRemotePaymentId: 0,
    },
    lastSyncTimes: {},
    printerStatus: {
      configured: true,
      profileCount: 1,
      defaultProfile: 'printer-1',
      recentJobs: [],
    },
    lastZReport: null,
    pendingOrders: 0,
    dbSizeBytes: 0,
    isOnline: true,
    lastSyncTime: null,
    ...overrides,
  }) as DiagnosticsSystemHealth;

const addressRow = (overrides: Partial<SyncQueueItem> = {}): SyncQueueItem => ({
  id: 'address-queue', tableName: 'customer_addresses', recordId: 'address-1', operation: 'UPDATE',
  data: '{"is_default":true}', organizationId: 'org-1', createdAt: '2026-09-13T00:00:00Z',
  attempts: 1, lastAttempt: null, errorMessage: 'CUSTOMER_ADDRESS_DEFAULT_CONFLICT', nextRetryAt: null,
  retryDelayMs: 0, priority: 0, moduleType: 'customers', conflictStrategy: 'manual', version: 1, status: 'failed', ...overrides,
});
const addressResult = (rows: SyncQueueItem[], total = rows.length) => buildSyncRecoveryIssues({
  systemHealth: baseSystemHealth({parityQueueStatus: {total, failed:total, pending:0, conflicts:0}}),
  lastParitySync: {status:'failed', error:'updates blocked'} as any,
  parityItems: rows,
});

test('default address remedy only matches known scoped address write failures', () => {
  for (const signal of ['CUSTOMER_ADDRESS_DEFAULT_CONFLICT','CUSTOMER_ADDRESS_DEFAULT_RETRY','idx_customer_addresses_default_unique']) {
    const result = addressResult([addressRow({errorMessage:signal})]);
    const issue = result.issues.find(item => item.code === 'customer_address_default_conflict');
    assert.ok(issue, signal);
    assert.equal(issue.actions[0].recipeVersion,1);
    assert.equal(issue.actions[0].requiresSnapshot,true);
    assert.equal(issue.actions[0].requiresOnline,true);
    assert.equal(result.issues.some(item=>item.code === 'parity_processor_stalled_zero_progress'),false);
  }
  for (const change of [
    {errorMessage:'HTTP 500'}, {errorMessage:'CUSTOMER_ADDRESS_DEFAULT_CONFLICT forbidden'},
    {errorMessage:'NOT_CUSTOMER_ADDRESS_DEFAULT_CONFLICT_OTHER'}, {errorMessage:'idx_customer_addresses_default_unique_unrelated'},
    {tableName:'payments'}, {operation:'DELETE' as const}, {moduleType:'financial'}, {status:'pending' as const},
  ]) {
    assert.equal(addressResult([addressRow(change)]).issues.some(item=>item.code === 'customer_address_default_conflict'),false);
  }
});

test('specific address recipe cannot hide unrelated or unsampled processor failures', () => {
  const row=addressRow();
  for (const result of [addressResult([row],2), addressResult([row,addressRow({id:'unknown',recordId:'other',errorMessage:'HTTP 500'})]),addressResult([row,addressRow({id:'unknown',errorMessage:'HTTP 500'})])]) {
    assert.ok(result.issues.some(item=>item.code === 'customer_address_default_conflict'));
    assert.ok(result.issues.some(item=>item.code === 'parity_processor_stalled_zero_progress'));
  }
});

test('checkout payment blockers route to the order payment screen with a versioned known solution', () => {
  const result = buildSyncRecoveryIssues({
    systemHealth: baseSystemHealth({
      checkoutPaymentBlockers: {
        count: 1,
        sourceWindow: 'active_shift',
        details: [
          {
            orderId: 'order-1057',
            orderNumber: '1057',
            totalAmount: 28.4,
            settledAmount: 0,
            paymentStatus: 'pending',
            paymentMethod: 'card',
            reasonCode: 'missing_card_payment',
            reasonText: 'Order has no card payment row.',
            suggestedFix: 'Open the order and record the missing payment.',
          },
        ],
      },
    }),
  });

  const issue = result.issues.find((candidate) => candidate.code === 'missing_card_payment');
  assert.ok(issue, 'expected a checkout payment blocker issue');

  const [primaryAction] = issue.actions;
  assert.equal(primaryAction.id, 'openOrderPaymentFix');
  assert.equal(primaryAction.recommended, true);
  assert.equal(primaryAction.routeTarget?.screen, 'orderPayment');
  assert.equal(primaryAction.routeTarget?.orderId, 'order-1057');
  assert.equal(primaryAction.routeTarget?.orderNumber, '1057');
  assert.equal(primaryAction.routeTarget?.params?.openPayment, true);
  assert.equal(primaryAction.routeTarget?.params?.reasonCode, 'missing_card_payment');
  assert.equal(issue.actions.some((action) => action.id === 'resolveCheckoutPaymentBlocker'), false);
  assert.equal(issue.actions[issue.actions.length - 1]?.id, 'contactDev');
  assert.equal((issue as any).knownSolution?.recipeId, 'checkout-payment-blocker.open-payment');
  assert.equal((issue as any).knownSolution?.version, 1);
  assert.equal((issue as any).knownSolution?.requiresSnapshot, false);
});

test('known automated repair recipes are attached to matching parity payment conflicts', () => {
  const parityItems: SyncQueueItem[] = [
    {
      id: 'queue-payment-1',
      tableName: 'payments',
      recordId: 'payment-1',
      operation: 'INSERT',
      data: JSON.stringify({
        paymentId: 'payment-1',
        orderId: 'order-1',
        amount: 34,
        orderTotal: 30,
      }),
      organizationId: 'org-1',
      createdAt: '2026-05-16T08:00:00.000Z',
      attempts: 3,
      lastAttempt: '2026-05-16T08:05:00.000Z',
      errorMessage: 'HTTP 422 payment exceeds order total: order total: 30, existing completed: 0, payment: 34',
      nextRetryAt: null,
      retryDelayMs: 0,
      priority: 1,
      moduleType: 'financial',
      conflictStrategy: 'manual',
      version: 1,
      status: 'failed',
    },
  ];

  const result = buildSyncRecoveryIssues({
    systemHealth: baseSystemHealth({
      parityQueueStatus: {
        total: 1,
        pending: 0,
        failed: 1,
        conflicts: 0,
      },
    }),
    parityItems,
  });

  const issue = result.issues.find((candidate) => candidate.code === 'payment_total_conflict');
  assert.ok(issue, 'expected a payment total conflict issue');
  assert.equal(issue.actions[0]?.id, 'repairPaymentTotalConflict');
  assert.equal(issue.actions[0]?.recipeId, 'payment-total-conflict.repair');
  assert.equal(issue.actions[0]?.recipeVersion, 1);
  assert.equal(issue.actions[0]?.requiresSnapshot, true);
  assert.equal((issue as any).knownSolution?.recipeId, 'payment-total-conflict.repair');
  assert.equal((issue as any).knownSolution?.version, 1);
});

// ---------------------------------------------------------------------------
// 17/09/2026: the duplicate-customer conflict that retry cannot move.
//
// A shop on 1.4.114 had one such row, twenty hours old, `attempts: 0`,
// `nextRetryAt: null` — and the assistant offered only «retry this change» /
// «retry related changes», which answered «Η ενέργεια απέτυχε» every time
// because the office's reply is the same rejection on every attempt.
// ---------------------------------------------------------------------------

const DUPLICATE_ERROR =
  'SERVER_CONFLICT_DUPLICATE: A customer with this phone or email already exists; select it explicitly';

const customerRow = (overrides: Partial<SyncQueueItem> = {}): SyncQueueItem => ({
  id: '1abbfa54-bc0b-413a-b798-f2b0ccea457b', tableName: 'customers',
  recordId: 'cust-b2572ac9-63c2-4f7e-a11a-76c463fa0603', operation: 'INSERT',
  data: '{"name":"Πελάτης","phone":"6948128474"}', organizationId: 'org-1',
  createdAt: '2026-09-16T19:16:24Z', attempts: 0, lastAttempt: '2026-09-17T15:15:38Z',
  errorMessage: DUPLICATE_ERROR, nextRetryAt: null, retryDelayMs: 1000, priority: 0,
  moduleType: 'customers', conflictStrategy: 'manual', version: 1, status: 'conflict', ...overrides,
});

const customerResult = (rows: SyncQueueItem[], total = rows.length) => buildSyncRecoveryIssues({
  systemHealth: baseSystemHealth({parityQueueStatus: {total, failed:0, pending:0, conflicts:total}}),
  lastParitySync: {status:'failed', error:'PARITY_SYNC_PARTIAL', processed:0, remaining:total} as any,
  parityItems: rows,
});

test('a customer the office already holds gets the action that can actually resolve it', () => {
  const result = customerResult([customerRow()]);
  const issue = result.issues.find(item => item.code === 'duplicate_customer_conflict');
  assert.ok(issue, 'the duplicate conflict must have its own issue');
  assert.equal(issue.status, 'blocking');
  assert.equal(issue.entityId, 'cust-b2572ac9-63c2-4f7e-a11a-76c463fa0603');

  const resolve = issue.actions.find(action => action.id === 'resolveDuplicateCustomerConflict');
  assert.ok(resolve, 'the resolution must be offered');
  assert.equal(resolve.recommended, true);
  assert.equal(resolve.requiresOnline, true);
  assert.equal(resolve.confirmationRequired, true);
  assert.equal(resolve.safetyLevel, 'destructive_local');
  assert.equal(resolve.recipeId, 'duplicate-customer-conflict.adopt-server-record');
  assert.equal(issue.knownSolution?.recipeId, 'duplicate-customer-conflict.adopt-server-record');
  assert.equal(issue.params?.sampleItemId, '1abbfa54-bc0b-413a-b798-f2b0ccea457b');

  // The whole point: retry is not what the operator is pointed at. The office
  // replies with the same rejection however many times the same INSERT is sent.
  assert.equal(issue.actions.some(action => action.id === 'retryParityItem'), false);
  assert.equal(issue.actions.some(action => action.id === 'retryParityModule'), false);
});

test('the duplicate resolution covers the queue instead of the retry-only cards', () => {
  const result = customerResult([customerRow()]);
  // These two are what the shop was actually shown: a blocked PARITY item and a
  // blocked PARITY_MODULE item, both offering only retry.
  assert.equal(result.issues.some(item => item.code === 'parity_module_conflict_items'), false);
  assert.equal(result.issues.some(item => item.code === 'parity_processor_stalled_zero_progress'), false);
});

test('only the office duplicate answer earns the adoption action', () => {
  for (const change of [
    {errorMessage: 'CUSTOMER_PHONE_COUNTRY_UNRESOLVED'},
    {errorMessage: 'HTTP 500'},
    {errorMessage: null},
    {operation: 'UPDATE' as const},
    {status: 'failed' as const},
    {status: 'pending' as const},
    {tableName: 'customer_addresses'},
  ]) {
    assert.equal(
      customerResult([customerRow(change)]).issues.some(item => item.code === 'duplicate_customer_conflict'),
      false,
      JSON.stringify(change),
    );
  }
});

test('a second unrelated blocked row keeps the general parity card visible', () => {
  const result = customerResult([customerRow(), addressRow({id: 'other', errorMessage: 'HTTP 500'})], 2);
  assert.ok(result.issues.some(item => item.code === 'duplicate_customer_conflict'));
  assert.ok(
    result.issues.some(item => item.code.startsWith('parity_')),
    'a specific recipe must not hide a row it does not cover',
  );
});

// The checkout-blocker card renders `{{reasonText}}` / `{{suggestedFix}}` — the
// desktop classifier's English — so localising the blockers panel alone left
// this card still speaking English at the Greek shift checkout (17/09/2026).

const blockerHealth = () => baseSystemHealth({
  checkoutPaymentBlockers: {
    count: 1,
    sourceWindow: 'active_shift',
    details: [{
      orderId: 'e7da8932-14d5-4d88-a355-2e8b5be279c5',
      orderNumber: 'EFOOD-1789587601473-97727248',
      totalAmount: 6.5, settledAmount: 6.5,
      paymentStatus: 'paid', paymentMethod: 'card',
      reasonCode: 'platform_settlement_mismatch',
      reasonText: 'The platform settles this order, but EUR 6.50 is recorded as cash/card in the till.',
      suggestedFix: 'Void the cash/card row: prepaid and platform-rider COD money never enters the drawer.',
      severity: 'blocking' as const, differenceCents: 0,
      reasonAmounts: { drawerAmount: 650 }, reasonVariant: 'platform_holds',
    }],
  },
} as any);

test('the checkout-blocker card carries whatever language the caller localises into', () => {
  const localized = buildSyncRecoveryIssues({
    systemHealth: blockerHealth(),
    localizePaymentBlocker: () => ({
      reason: 'Την παραγγελία την εξοφλεί η πλατφόρμα.',
      fix: 'Ακύρωσε την εγγραφή κάρτας.',
    }),
  }).issues.find(issue => issue.code === 'platform_settlement_mismatch');

  assert.ok(localized, 'the blocker must raise an issue');
  assert.equal(localized.params?.reasonText, 'Την παραγγελία την εξοφλεί η πλατφόρμα.');
  assert.equal(localized.params?.suggestedFix, 'Ακύρωσε την εγγραφή κάρτας.');
});

test('a caller with no localiser still gets the classifier sentence, never a blank', () => {
  const raw = buildSyncRecoveryIssues({ systemHealth: blockerHealth() })
    .issues.find(issue => issue.code === 'platform_settlement_mismatch');

  assert.ok(raw);
  assert.match(String(raw.params?.reasonText), /^The platform settles this order/);
  assert.match(String(raw.params?.suggestedFix), /^Void the cash\/card row/);
});

// A `platform_settlement_missing` blocker used to route to the payment screen,
// which refuses cash and card on a platform-held order by design — so the
// recommended action led nowhere. It is also where voiding the wrongly
// recorded card row on the 17/09/2026 order lands next.

const settlementMissingHealth = () => baseSystemHealth({
  checkoutPaymentBlockers: {
    count: 1,
    sourceWindow: 'active_shift',
    details: [{
      orderId: 'ord-platform', orderNumber: 'EFOOD-2',
      totalAmount: 6.5, settledAmount: 0,
      paymentStatus: 'pending', paymentMethod: 'pending',
      reasonCode: 'platform_settlement_missing',
      reasonText: 'The platform settles this order, but no platform settlement of EUR 6.50 is recorded.',
      suggestedFix: 'Re-run platform settlement for this order so the money is recorded as platform revenue.',
      severity: 'blocking' as const, differenceCents: 650,
    }],
  },
} as any);

test('a missing platform settlement is offered the settlement, not the payment screen', () => {
  const issue = buildSyncRecoveryIssues({ systemHealth: settlementMissingHealth() })
    .issues.find(item => item.code === 'platform_settlement_missing');

  assert.ok(issue);
  const settle = issue.actions.find(action => action.id === 'settlePlatformOrder');
  assert.ok(settle, 'the settlement must be offered');
  assert.equal(settle.recommended, true);
  assert.equal(settle.confirmationRequired, true);
  assert.equal(settle.requiresSnapshot, true);
  assert.equal(settle.recipeId, 'platform-settlement-missing.settle-from-disposition');
  assert.equal(issue.knownSolution?.recipeId, 'platform-settlement-missing.settle-from-disposition');
  // The payment screen refuses this money; it must not be the recommendation.
  assert.equal(issue.actions.some(action => action.id === 'openOrderPaymentFix'), false);
});

test('the till row on platform money is corrected in one action, not two', () => {
  const issue = buildSyncRecoveryIssues({ systemHealth: blockerHealth() })
    .issues.find(item => item.code === 'platform_settlement_mismatch');

  assert.ok(issue);
  const repair = issue.actions.find(action => action.id === 'repairPlatformSettlementMismatch');
  assert.ok(repair, 'the one-action correction must be offered');
  assert.equal(repair.recommended, true);
  assert.equal(repair.confirmationRequired, true);
  assert.equal(repair.requiresSnapshot, true);
  assert.equal(repair.safetyLevel, 'destructive_local');
  assert.equal(issue.knownSolution?.recipeId, 'platform-settlement-mismatch.void-drawer-and-settle');
  // Voiding via the payment screen alone lands on platform_settlement_missing.
  assert.equal(issue.actions.some(action => action.id === 'openOrderPaymentFix'), false);
  assert.equal(issue.actions.some(action => action.id === 'settlePlatformOrder'), false);
});

test('the opposite arm of the same code is not offered the void-and-settle repair', () => {
  // Store money booked as platform revenue: voiding the settlement and
  // recording what the store took is the operator's call, not this recipe's.
  const health = blockerHealth();
  (health as any).checkoutPaymentBlockers.details[0].reasonVariant = 'store_collects_platform_order';
  const issue = buildSyncRecoveryIssues({ systemHealth: health })
    .issues.find(item => item.code === 'platform_settlement_mismatch');

  assert.ok(issue);
  assert.equal(issue.actions.some(action => action.id === 'repairPlatformSettlementMismatch'), false);
  assert.ok(issue.actions.some(action => action.id === 'openOrderPaymentFix'));
  assert.equal(issue.knownSolution?.recipeId, 'checkout-payment-blocker.open-payment');
});

test('a blocker from an older build, with no variant, keeps the payment screen', () => {
  const health = blockerHealth();
  delete (health as any).checkoutPaymentBlockers.details[0].reasonVariant;
  const issue = buildSyncRecoveryIssues({ systemHealth: health })
    .issues.find(item => item.code === 'platform_settlement_mismatch');

  assert.ok(issue);
  assert.equal(issue.actions.some(action => action.id === 'repairPlatformSettlementMismatch'), false);
  assert.ok(issue.actions.some(action => action.id === 'openOrderPaymentFix'));
});
