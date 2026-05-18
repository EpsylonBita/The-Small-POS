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
