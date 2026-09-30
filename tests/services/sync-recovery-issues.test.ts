import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';

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

// Updated 29/09/2026: a failed customer_addresses row is no longer an
// "unrelated" failure (every customer-directory row now has its own
// non-blocking card), so the unrelated rows here are order rows.
const unrelatedOrderRow = (overrides: Partial<SyncQueueItem> = {}): SyncQueueItem => addressRow({
  id: 'unknown', tableName: 'orders', moduleType: 'orders', recordId: 'order-1', errorMessage: 'HTTP 500', ...overrides,
});

test('specific address recipe cannot hide unrelated or unsampled processor failures', () => {
  const row=addressRow();
  for (const result of [addressResult([row],2), addressResult([row,unrelatedOrderRow()]),addressResult([row,unrelatedOrderRow({recordId:'address-1'})])]) {
    assert.ok(result.issues.some(item=>item.code === 'customer_address_default_conflict'));
    assert.ok(result.issues.some(item=>item.code === 'parity_processor_stalled_zero_progress'));
  }
});

test('a second failure on the same address gets the non-blocking customer card, not a blocking one', () => {
  const result = addressResult([addressRow(), addressRow({id:'unknown',errorMessage:'HTTP_500_SERVER_ERROR'})]);
  assert.ok(result.issues.some(item=>item.code === 'customer_address_default_conflict'));
  assert.ok(result.issues.some(item=>item.code === 'customer_directory_not_synced'));
  assert.equal(result.issues.some(item=>item.status === 'blocking'), false);
  assert.equal(result.counts.blocking, 0);
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
  // Updated 29/09/2026: customer-directory rows no longer block the Z, so the
  // card is not in the blocking list; its adoption action stays recommended.
  assert.equal(issue.status, 'recovering');
  assert.equal(issue.params?.closeoutBlocking, false);
  assert.equal(result.counts.blocking, 0);
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
  const result = customerResult([customerRow(), unrelatedOrderRow()], 2);
  assert.ok(result.issues.some(item => item.code === 'duplicate_customer_conflict'));
  assert.ok(
    result.issues.some(item => item.code.startsWith('parity_')),
    'a specific recipe must not hide a row it does not cover',
  );
});

// ---------------------------------------------------------------------------
// 28/09/2026: the customer the office refused for its phone.
//
// Symptom (Tomikro, desktop 1.4.118): «Cannot close day: pre-Z-report sync
// failed: PARITY_SYNC_PARTIAL», and Sync health showed a red «some updates
// could not be sent» card offering only retry. Root cause: the office refused
// an 11-digit phone (400 INVALID_PHONE), the till queued the customer anyway
// and any failed parity row blocked the Z. Customer-directory rows no longer
// block the Z (native closeout exemption); this card must say so, name the
// reason, and never sit in the blocking list.
// ---------------------------------------------------------------------------

const refusedCustomerRow = (overrides: Partial<SyncQueueItem> = {}): SyncQueueItem => customerRow({
  id: '0a8d8b99-0000-4000-8000-000000000001', status: 'failed',
  errorMessage: 'HTTP_400_CLIENT_ERROR:INVALID_PHONE', ...overrides,
});

const refusedResult = (rows: SyncQueueItem[], total = rows.length) => buildSyncRecoveryIssues({
  systemHealth: baseSystemHealth({parityQueueStatus: {total, failed: total, pending: 0, conflicts: 0}}),
  lastParitySync: {status: 'failed', error: 'PARITY_SYNC_PARTIAL', processed: 0, remaining: total} as any,
  parityItems: rows,
});

test('a customer the office refused for its phone is a non-blocking card that says why', () => {
  const result = refusedResult([refusedCustomerRow()]);
  const issue = result.issues.find(item => item.code === 'customer_phone_rejected');
  assert.ok(issue, 'the refused phone must have its own card');
  assert.equal(issue.status, 'recovering');
  assert.equal(issue.severity, 'warning');
  assert.equal(issue.titleKey, 'recovery.issues.customerPhoneRejected.title');
  assert.equal(issue.params?.rejectionCode, 'INVALID_PHONE');
  assert.equal(issue.params?.rejectionStatus, 400);
  assert.equal(issue.params?.closeoutBlocking, false);
  assert.equal(issue.params?.sampleItemId, '0a8d8b99-0000-4000-8000-000000000001');
  assert.ok(issue.actions.some(action => action.id === 'retryParityItem'));
  // What the shop was shown instead: blocking, retry-only cards.
  assert.equal(result.issues.some(item => item.code === 'parity_module_failed_items'), false);
  assert.equal(result.issues.some(item => item.code === 'parity_processor_stalled_zero_progress'), false);
  assert.equal(result.counts.blocking, 0);
});

test('COUNTRY_CONTEXT_REQUIRED is a phone refusal too', () => {
  const result = refusedResult([refusedCustomerRow({errorMessage: 'HTTP_400_CLIENT_ERROR:COUNTRY_CONTEXT_REQUIRED'})]);
  assert.ok(result.issues.some(item => item.code === 'customer_phone_rejected'));
});

test('a row stored by 1.4.118 without the code, or refused for another reason, gets the general customer card', () => {
  const cases: Array<[string, number, string | null]> = [
    ['HTTP_400_CLIENT_ERROR', 400, null],
    ['HTTP_404_CLIENT_ERROR:NOT_FOUND', 404, 'NOT_FOUND'],
    ['HTTP_400_CLIENT_ERROR:INVALID_COORDINATES', 400, 'INVALID_COORDINATES'],
  ];
  for (const [errorMessage, status, code] of cases) {
    const result = refusedResult([refusedCustomerRow({errorMessage})]);
    const issue = result.issues.find(item => item.code === 'customer_directory_not_synced');
    assert.ok(issue, errorMessage);
    assert.equal(issue.status, 'recovering', errorMessage);
    assert.equal(issue.params?.rejectionStatus, status, errorMessage);
    assert.equal(issue.params?.rejectionCode, code, errorMessage);
    assert.equal(result.counts.blocking, 0, errorMessage);
  }
});

test('a customer address the office refused is a customer card as well', () => {
  const result = refusedResult([addressRow({errorMessage: 'HTTP_400_CLIENT_ERROR:INVALID_COORDINATES'})]);
  const issue = result.issues.find(item => item.code === 'customer_directory_not_synced');
  assert.ok(issue);
  assert.equal(issue.entityType, 'customer_address');
  assert.equal(result.counts.blocking, 0);
});

test('only the customer directory is exempt: other failures stay blocking next to it', () => {
  const result = refusedResult([refusedCustomerRow(), unrelatedOrderRow()]);
  assert.ok(result.issues.some(item => item.code === 'customer_phone_rejected'));
  assert.ok(result.issues.some(item => item.status === 'blocking' && item.code.startsWith('parity_')));

  // A customers row of another module is not the customer directory (the
  // native exemption checks both), so it keeps the blocking card.
  const mislabelled = refusedResult([refusedCustomerRow({moduleType: 'orders'})]);
  assert.equal(mislabelled.issues.some(item => item.code === 'customer_phone_rejected'), false);
  assert.ok(mislabelled.counts.blocking > 0);
});

test('a truncated sample never hides the processor card behind the customer card', () => {
  const result = refusedResult([refusedCustomerRow()], 2);
  assert.ok(result.issues.some(item => item.code === 'customer_phone_rejected'));
  assert.ok(result.issues.some(item => item.code === 'parity_processor_stalled_zero_progress'));
});

test('pending customer rows keep the pending card, not the refusal card', () => {
  const result = refusedResult([refusedCustomerRow({status: 'pending', errorMessage: null})]);
  assert.equal(result.issues.some(item => item.code === 'customer_phone_rejected'), false);
  assert.equal(result.issues.some(item => item.code === 'customer_directory_not_synced'), false);
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

// Review round: the Tomikro incident had exactly one stuck row, and the card
// read «1 customer changes ... were refused». Each POS locale now has a
// singular summary; i18next picks it from the card's `count`.
test('the customer cards read naturally for one change and for several, in every POS locale', async () => {
  const one = refusedResult([refusedCustomerRow()]).issues.find(item => item.code === 'customer_phone_rejected');
  assert.equal(one?.params?.count, 1);
  const several = refusedResult([
    refusedCustomerRow({errorMessage: 'HTTP_400_CLIENT_ERROR'}),
    refusedCustomerRow({id: 'second', recordId: 'customer-2', errorMessage: 'HTTP_400_CLIENT_ERROR'}),
    refusedCustomerRow({id: 'third', recordId: 'customer-3', errorMessage: 'HTTP_400_CLIENT_ERROR'}),
  ]).issues.find(item => item.code === 'customer_directory_not_synced');
  assert.equal(several?.params?.count, 3);

  for (const locale of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
    const messages = JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${locale}.json`), 'utf8'));
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: locale,
      resources: {[locale]: {translation: messages}},
      interpolation: {escapeValue: false},
    });
    for (const key of ['customerPhoneRejected', 'customerDirectoryNotSynced']) {
      const summaries = messages.recovery.issues[key];
      const singular = i18n.t(`recovery.issues.${key}.summary`, {count: 1});
      assert.equal(singular, summaries.summary_one, `${locale} ${key} one`);
      assert.doesNotMatch(singular, /\{\{|\b1\b/, `${locale} ${key} one`);
      const plural = i18n.t(`recovery.issues.${key}.summary`, {count: 3});
      assert.equal(plural, summaries.summary_other.replace('{{count}}', '3'), `${locale} ${key} other`);
      assert.match(plural, /\b3\b/, `${locale} ${key} other`);
    }
  }
});
