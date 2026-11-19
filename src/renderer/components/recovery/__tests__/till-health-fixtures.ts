import type { DiagnosticsSystemHealth } from '../../../../lib';
import type { SimpleServiceStatus } from '../../../../../../shared/pos/health/health-contract';
import type { SyncQueueItem } from '../../../../../../shared/pos/sync-queue-types';
import { buildSyncRecoveryIssues } from '../sync-recovery-issues';
import { buildTillHealthCards, tillHealthState, type TillHealthState } from '../till-health-model';
import type { TillHealthAttempt } from '../useTillHealthActions';

export const ORDER_ID = '60169ffa-38ee-4161-afdf-50374804efd3';
export const CORRECTION_ROW = '99d2a273-b330-4f1a-ad90-f8aa0f59aef3';
export const OTHER_ORDER = '2616c71a-1115-43f9-a3b3-adf9e16ae210';
export const OTHER_ROW = 'b9af2ef2-7735-4bc0-877d-2fadaa43cdf4';
export const CHECKED = '2026-11-18T10:02:00';
export const VERIFIED = '2026-11-18T10:42:00';
export const OFFICIAL_REFUSAL = 'UNKNOWN_CONFLICT_REVIEW';

export const healthy: DiagnosticsSystemHealth = {
  schemaVersion: 71, dbSizeBytes: 1, isOnline: true, pendingOrders: 0, lastSyncTime: null,
  syncBacklog: {}, lastSyncTimes: {}, lastZReport: null,
  paymentAdjustmentBacklog: { genericDeferred: 0, waitingForParentPayment: 0, waitingForCanonicalRemotePaymentId: 0 },
  printerStatus: { configured: true, profileCount: 1, defaultProfile: 'Receipt', recentJobs: [] },
};

export const correctionHealth: DiagnosticsSystemHealth = {
  ...healthy,
  orderNotices: [{
    orderId: ORDER_ID, orderNumber: '00093', queueId: CORRECTION_ROW, since: CHECKED,
    kind: 'customer_correction_refused', state: 'refused',
    actions: ['resendOrderCustomerCorrection', 'keepServerOrderCustomerDetails'],
  }],
};

export function refusedRow(id = OTHER_ROW, order = OTHER_ORDER): SyncQueueItem {
  return {
    id, tableName: 'orders', recordId: order, operation: 'UPDATE', data: '{}', organizationId: 'test',
    createdAt: CHECKED, attempts: 3, nextRetryAt: null, lastAttempt: CHECKED, errorMessage: OFFICIAL_REFUSAL,
    status: 'conflict', moduleType: 'orders', retryDelayMs: 1000, priority: 0, conflictStrategy: 'server-wins', version: 1,
  };
}

export function refusedHealth(rows = [refusedRow()]): DiagnosticsSystemHealth {
  return {
    ...healthy,
    parityQueueStatus: { pending: 0, failed: 0, conflicts: rows.length, total: rows.length },
    lastParitySync: { status: 'failed', trigger: 'manual', processed: 0, failed: rows.length, conflicts: rows.length, remaining: rows.length, startedAt: CHECKED, legacySyncTriggered: false },
    syncBlockerDetails: rows.map((row, index) => ({
      queue: 'parity_sync_queue', queueItemId: row.id, entityType: 'order', entityId: row.recordId,
      orderId: row.recordId, orderNumber: `000${92 - index}`, operation: 'UPDATE',
      queueStatus: 'conflict', blockerReason: OFFICIAL_REFUSAL,
    })),
  };
}

export const fixtures = ['ok', 'issue', 'working', 'pending', 'solved', 'support', 'offline', 'stale'] as const;
export const HEALTHY_TEST_SERVICES: SimpleServiceStatus = {
  orders: 'working', internet: 'connected', sync: 'healthy', printer: 'ready', closeout: 'open', support: 'not_needed',
};

export function tillHealthFixture(name: TillHealthState) {
  const online = name !== 'offline';
  const availability = name === 'stale' ? 'stale' as const : 'ready' as const;
  const order = name === 'support' ? refusedHealth() : ['ok', 'offline'].includes(name) ? healthy : correctionHealth;
  const issues = buildSyncRecoveryIssues({
    systemHealth: order,
    lastParitySync: order.lastParitySync,
    parityItems: name === 'support' ? [refusedRow()] : [],
  }).issues;
  const attempts: TillHealthAttempt[] = name === 'working' || name === 'pending' || name === 'solved'
    ? [{ issue: issues[0], actionId: issues[0].actions[0].id, state: name, startedAt: Date.parse(CHECKED),
      ...(name === 'solved' ? { verifiedAt: VERIFIED } : {}) }]
    : [];
  const cards = buildTillHealthCards({
    issues: name === 'solved' ? [] : issues, attempts, problem: 'ready', printerNeedsAttention: false, canSend: false,
  });
  const services: SimpleServiceStatus = {
    orders: 'working', internet: online ? 'connected' : 'offline',
    sync: name === 'support' ? 'failed' : ['ok', 'solved'].includes(name) ? 'healthy' : 'waiting',
    printer: 'ready', closeout: 'open', support: 'not_needed',
  };
  return {
    id: 'fixture-till-health', state: tillHealthState({ availability, online, cards, supportUnavailable: false }),
    availability, online, cards, services, isShiftActive: true, lastChecked: CHECKED,
    dayStart: '2026-11-18T08:19:00', busy: name === 'working',
    canAskSupport: online, supportUnavailable: false, supportFlowOpen: false,
  };
}
