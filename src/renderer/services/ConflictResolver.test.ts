/**
 * Unit tests for DesktopConflictResolver.
 *
 * Covers: conflict detection, server-wins strategy, monetary flagging,
 * client-wins strategy, manual strategy, and audit log completeness.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import type { SyncQueueItem } from '../../../../shared/pos/sync-queue-types';
import {
  DesktopConflictResolver,
  type OrderConflict,
  type ServerRecord,
} from './ConflictResolver';

// =============================================
// TEST HELPERS
// =============================================

/** Build a minimal SyncQueueItem for testing. */
function makeSyncItem(overrides: Partial<SyncQueueItem> = {}): SyncQueueItem {
  return {
    id: 'item-001',
    tableName: 'orders',
    recordId: 'order-123',
    operation: 'UPDATE',
    data: JSON.stringify({ status: 'completed' }),
    organizationId: 'org-1',
    createdAt: '2026-04-01T10:00:00.000Z',
    attempts: 0,
    lastAttempt: null,
    errorMessage: null,
    nextRetryAt: null,
    retryDelayMs: 1000,
    priority: 0,
    moduleType: 'orders',
    conflictStrategy: 'server-wins',
    version: 1,
    status: 'pending',
    ...overrides,
  };
}

/** Build a minimal ServerRecord for testing. */
function makeServerRecord(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    version: 2,
    updatedAt: '2026-04-01T11:00:00.000Z',
    ...overrides,
  };
}

/** Build a monetary SyncQueueItem (payload contains `total` field). */
function makeMonetaryItem(overrides: Partial<SyncQueueItem> = {}): SyncQueueItem {
  return makeSyncItem({
    data: JSON.stringify({ total: 42.50, status: 'completed' }),
    ...overrides,
  });
}

/** Build a monetary SyncQueueItem via table name (payments table). */
function makePaymentItem(overrides: Partial<SyncQueueItem> = {}): SyncQueueItem {
  return makeSyncItem({
    tableName: 'payments',
    recordId: 'pay-456',
    data: JSON.stringify({ method: 'cash' }),
    moduleType: 'payments',
    ...overrides,
  });
}

// =============================================
// TESTS
// =============================================

describe('DesktopConflictResolver', () => {
  // ------------------------------------------
  // Constructor / Strategy
  // ------------------------------------------

  describe('constructor', () => {
    it('should default to server-wins strategy', () => {
      const resolver = new DesktopConflictResolver();
      expect(resolver.getStrategy()).toBe('server-wins');
    });

    it('should accept a custom strategy', () => {
      const resolver = new DesktopConflictResolver('client-wins');
      expect(resolver.getStrategy()).toBe('client-wins');
    });

    it('should allow strategy to be changed after construction', () => {
      const resolver = new DesktopConflictResolver('server-wins');
      resolver.setStrategy('manual');
      expect(resolver.getStrategy()).toBe('manual');
    });
  });

  // ------------------------------------------
  // Conflict Detection
  // ------------------------------------------

  describe('detect()', () => {
    let resolver: DesktopConflictResolver;

    beforeEach(() => {
      resolver = new DesktopConflictResolver();
    });

    it('should detect conflict when local version < server version', () => {
      const local = makeSyncItem({ version: 1 });
      const server = makeServerRecord({ version: 2 });

      const result = resolver.detect(local, server);

      expect(result.hasConflict).toBe(true);
      expect(result.localVersion).toBe(1);
      expect(result.serverVersion).toBe(2);
    });

    it('should not detect conflict when local version equals server version', () => {
      const local = makeSyncItem({ version: 2 });
      const server = makeServerRecord({ version: 2 });

      const result = resolver.detect(local, server);

      expect(result.hasConflict).toBe(false);
    });

    it('should not detect conflict when local version > server version', () => {
      const local = makeSyncItem({ version: 3 });
      const server = makeServerRecord({ version: 2 });

      const result = resolver.detect(local, server);

      expect(result.hasConflict).toBe(false);
    });

    it('should flag monetary conflict when payload contains monetary fields', () => {
      const local = makeMonetaryItem({ version: 1 });
      const server = makeServerRecord({ version: 2 });

      const result = resolver.detect(local, server);

      expect(result.hasConflict).toBe(true);
      expect(result.isMonetary).toBe(true);
    });

    it('should flag monetary conflict when table is a monetary table', () => {
      const local = makePaymentItem({ version: 1 });
      const server = makeServerRecord({ version: 2 });

      const result = resolver.detect(local, server);

      expect(result.hasConflict).toBe(true);
      expect(result.isMonetary).toBe(true);
    });

    it('should not flag monetary when no conflict exists even if payload is monetary', () => {
      const local = makeMonetaryItem({ version: 2 });
      const server = makeServerRecord({ version: 2 });

      const result = resolver.detect(local, server);

      expect(result.hasConflict).toBe(false);
      expect(result.isMonetary).toBe(false);
    });

    it('should not flag monetary for non-monetary data', () => {
      const local = makeSyncItem({
        version: 1,
        data: JSON.stringify({ status: 'pending', notes: 'test' }),
      });
      const server = makeServerRecord({ version: 2 });

      const result = resolver.detect(local, server);

      expect(result.hasConflict).toBe(true);
      expect(result.isMonetary).toBe(false);
    });

    it('should handle unparseable data payload gracefully (non-monetary)', () => {
      const local = makeSyncItem({
        version: 1,
        data: 'not-valid-json{{{',
      });
      const server = makeServerRecord({ version: 2 });

      const result = resolver.detect(local, server);

      expect(result.hasConflict).toBe(true);
      expect(result.isMonetary).toBe(false);
    });
  });

  // ------------------------------------------
  // Server-Wins Resolution
  // ------------------------------------------

  describe('resolve() with server-wins strategy', () => {
    let resolver: DesktopConflictResolver;

    beforeEach(() => {
      resolver = new DesktopConflictResolver('server-wins');
    });

    it('should discard local change for non-monetary conflict', () => {
      const local = makeSyncItem({ version: 1 });
      const server = makeServerRecord({ version: 2 });
      const detection = resolver.detect(local, server);
      const conflict: OrderConflict = {
        localItem: local,
        serverRecord: server,
        detection,
      };

      const resolution = resolver.resolve(conflict);

      expect(resolution.localDiscarded).toBe(true);
      expect(resolution.strategy).toBe('auto-server-wins');
      expect(resolution.requiresOperatorReview).toBe(false);
    });

    it('should flag monetary conflict for operator review', () => {
      const local = makeMonetaryItem({ version: 1 });
      const server = makeServerRecord({ version: 2 });
      const detection = resolver.detect(local, server);
      const conflict: OrderConflict = {
        localItem: local,
        serverRecord: server,
        detection,
      };

      const resolution = resolver.resolve(conflict);

      expect(resolution.localDiscarded).toBe(true);
      expect(resolution.requiresOperatorReview).toBe(true);
      expect(resolution.strategy).toBe('server-wins');
    });

    it('should flag payments table conflict for operator review', () => {
      const local = makePaymentItem({ version: 1 });
      const server = makeServerRecord({ version: 3 });
      const detection = resolver.detect(local, server);
      const conflict: OrderConflict = {
        localItem: local,
        serverRecord: server,
        detection,
      };

      const resolution = resolver.resolve(conflict);

      expect(resolution.requiresOperatorReview).toBe(true);
      expect(resolution.auditEntry.isMonetary).toBe(true);
    });
  });

  // ------------------------------------------
  // Client-Wins Resolution
  // ------------------------------------------

  describe('resolve() with client-wins strategy', () => {
    let resolver: DesktopConflictResolver;

    beforeEach(() => {
      resolver = new DesktopConflictResolver('client-wins');
    });

    it('should preserve local change', () => {
      const local = makeSyncItem({ version: 1 });
      const server = makeServerRecord({ version: 2 });
      const detection = resolver.detect(local, server);
      const conflict: OrderConflict = {
        localItem: local,
        serverRecord: server,
        detection,
      };

      const resolution = resolver.resolve(conflict);

      expect(resolution.localDiscarded).toBe(false);
      expect(resolution.strategy).toBe('client-wins');
      expect(resolution.requiresOperatorReview).toBe(false);
    });

    it('should not require operator review even for monetary conflicts', () => {
      const local = makeMonetaryItem({ version: 1 });
      const server = makeServerRecord({ version: 2 });
      const detection = resolver.detect(local, server);
      const conflict: OrderConflict = {
        localItem: local,
        serverRecord: server,
        detection,
      };

      const resolution = resolver.resolve(conflict);

      expect(resolution.localDiscarded).toBe(false);
      expect(resolution.requiresOperatorReview).toBe(false);
    });
  });

  // ------------------------------------------
  // Manual Resolution
  // ------------------------------------------

  describe('resolve() with manual strategy', () => {
    let resolver: DesktopConflictResolver;

    beforeEach(() => {
      resolver = new DesktopConflictResolver('manual');
    });

    it('should flag for operator review without discarding', () => {
      const local = makeSyncItem({ version: 1 });
      const server = makeServerRecord({ version: 2 });
      const detection = resolver.detect(local, server);
      const conflict: OrderConflict = {
        localItem: local,
        serverRecord: server,
        detection,
      };

      const resolution = resolver.resolve(conflict);

      expect(resolution.localDiscarded).toBe(false);
      expect(resolution.strategy).toBe('manual');
      expect(resolution.requiresOperatorReview).toBe(true);
    });
  });

  // ------------------------------------------
  // Audit Log
  // ------------------------------------------

  describe('getConflictLog()', () => {
    let resolver: DesktopConflictResolver;

    beforeEach(() => {
      resolver = new DesktopConflictResolver('server-wins');
    });

    it('should start with an empty log', () => {
      expect(resolver.getConflictLog()).toEqual([]);
    });

    it('should record an entry after resolving a conflict', () => {
      const local = makeSyncItem({ version: 1 });
      const server = makeServerRecord({ version: 2 });
      const detection = resolver.detect(local, server);
      resolver.resolve({ localItem: local, serverRecord: server, detection });

      const log = resolver.getConflictLog();
      expect(log).toHaveLength(1);
    });

    it('should contain all required audit fields', () => {
      const local = makeSyncItem({
        version: 1,
        operation: 'UPDATE',
        recordId: 'order-789',
        tableName: 'orders',
      });
      const server = makeServerRecord({ version: 5 });
      const detection = resolver.detect(local, server);
      resolver.resolve({ localItem: local, serverRecord: server, detection });

      const [entry] = resolver.getConflictLog();

      // Required fields per Requirement 6.3
      expect(entry.id).toBeDefined();
      expect(typeof entry.id).toBe('string');
      expect(entry.operationType).toBe('UPDATE');
      expect(entry.entityId).toBe('order-789');
      expect(entry.entityType).toBe('orders');
      expect(entry.localVersion).toBe(1);
      expect(entry.serverVersion).toBe(5);
      expect(entry.timestamp).toBeDefined();
      expect(entry.discardedPayload).toBe(local.data);
      expect(entry.resolution).toBeDefined();
      expect(typeof entry.isMonetary).toBe('boolean');
      expect(entry.reviewedByOperator).toBe(false);
    });

    it('should accumulate entries across multiple resolutions', () => {
      for (let i = 0; i < 3; i++) {
        const local = makeSyncItem({ version: 1, recordId: `order-${i}` });
        const server = makeServerRecord({ version: 2 });
        const detection = resolver.detect(local, server);
        resolver.resolve({ localItem: local, serverRecord: server, detection });
      }

      expect(resolver.getConflictLog()).toHaveLength(3);
    });

    it('should return a copy of the log (not a mutable reference)', () => {
      const local = makeSyncItem({ version: 1 });
      const server = makeServerRecord({ version: 2 });
      const detection = resolver.detect(local, server);
      resolver.resolve({ localItem: local, serverRecord: server, detection });

      const log1 = resolver.getConflictLog();
      const log2 = resolver.getConflictLog();

      expect(log1).toEqual(log2);
      expect(log1).not.toBe(log2); // Different array reference
    });

    it('should clear log when clearConflictLog is called', () => {
      const local = makeSyncItem({ version: 1 });
      const server = makeServerRecord({ version: 2 });
      const detection = resolver.detect(local, server);
      resolver.resolve({ localItem: local, serverRecord: server, detection });

      expect(resolver.getConflictLog()).toHaveLength(1);

      resolver.clearConflictLog();
      expect(resolver.getConflictLog()).toHaveLength(0);
    });

    it('should set discardedPayload to empty string when local is not discarded', () => {
      const resolver = new DesktopConflictResolver('client-wins');
      const local = makeSyncItem({ version: 1 });
      const server = makeServerRecord({ version: 2 });
      const detection = resolver.detect(local, server);
      resolver.resolve({ localItem: local, serverRecord: server, detection });

      const [entry] = resolver.getConflictLog();
      expect(entry.discardedPayload).toBe('');
    });
  });

  // ------------------------------------------
  // Strategy switching at runtime
  // ------------------------------------------

  describe('strategy switching', () => {
    it('should apply new strategy to subsequent resolutions', () => {
      const resolver = new DesktopConflictResolver('server-wins');

      const local1 = makeSyncItem({ version: 1, recordId: 'a' });
      const server = makeServerRecord({ version: 2 });
      const d1 = resolver.detect(local1, server);
      const r1 = resolver.resolve({ localItem: local1, serverRecord: server, detection: d1 });

      expect(r1.localDiscarded).toBe(true);

      // Switch strategy
      resolver.setStrategy('client-wins');

      const local2 = makeSyncItem({ version: 1, recordId: 'b' });
      const d2 = resolver.detect(local2, server);
      const r2 = resolver.resolve({ localItem: local2, serverRecord: server, detection: d2 });

      expect(r2.localDiscarded).toBe(false);
      expect(r2.strategy).toBe('client-wins');
    });
  });
});
