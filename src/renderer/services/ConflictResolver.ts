/**
 * Desktop Conflict Resolver
 *
 * Detects and resolves data conflicts when syncing offline-queued operations
 * back to the server. Supports configurable strategies (server-wins, client-wins,
 * manual) and flags monetary conflicts for operator review.
 *
 * All conflicts are logged to an in-memory audit trail that mirrors the
 * conflict_audit_log SQLite table schema defined in design.md.
 *
 * @see shared/pos/sync-queue-types.ts for canonical type definitions.
 */

import type {
  ConflictAuditEntry,
  ConflictStrategy,
  SyncOperation,
  SyncQueueItem,
} from '../../../../shared/pos/sync-queue-types';

// =============================================
// PUBLIC INTERFACES
// =============================================

/** Record returned from the server to compare against a local queue item. */
export interface ServerRecord {
  /** Server-side version counter for optimistic locking */
  version: number;
  /** ISO 8601 timestamp of the last server-side modification */
  updatedAt: string;
  /** The full server-side payload (JSON string or parsed object) */
  data?: string | Record<string, unknown>;
}

/** Result of conflict detection between a local item and the server state. */
export interface ConflictDetectionResult {
  /** Whether a version conflict exists */
  hasConflict: boolean;
  /** Whether the conflict involves monetary fields (totals, payments, etc.) */
  isMonetary: boolean;
  /** Local version at time of detection */
  localVersion: number;
  /** Server version that caused the conflict */
  serverVersion: number;
}

/** Full conflict descriptor passed to resolve(). */
export interface OrderConflict {
  /** The local sync queue item that conflicts */
  localItem: SyncQueueItem;
  /** The conflicting server record */
  serverRecord: ServerRecord;
  /** Detection result metadata */
  detection: ConflictDetectionResult;
}

/** Outcome of conflict resolution. */
export interface ConflictResolution {
  /** The strategy that was applied */
  strategy: ConflictStrategy | 'auto-server-wins';
  /** Whether the local change was discarded */
  localDiscarded: boolean;
  /** Whether operator review is required (monetary conflicts in server-wins) */
  requiresOperatorReview: boolean;
  /** The audit entry created for this resolution */
  auditEntry: ConflictAuditEntry;
}

// =============================================
// MONETARY DETECTION HELPERS
// =============================================

/**
 * Table names whose records are always considered monetary.
 * Monetary conflicts are never silently resolved — they require operator review.
 */
const MONETARY_TABLES = new Set([
  'payments',
  'payment_transactions',
  'refund_transactions',
]);

/**
 * Field names that, when present in a payload, indicate the record
 * involves monetary amounts.
 */
const MONETARY_FIELDS = [
  'total',
  'subtotal',
  'tax',
  'discount_amount',
  'payment_amount',
  'refund_amount',
  'amount',
  'price',
  'unit_price',
  'order_total',
  'grand_total',
  'tip',
  'tip_amount',
];

/**
 * Determine whether a sync queue item involves monetary data.
 * Checks both the table name and the payload field names.
 */
function isMonetaryItem(item: SyncQueueItem): boolean {
  if (MONETARY_TABLES.has(item.tableName)) {
    return true;
  }

  try {
    const payload = JSON.parse(item.data);
    if (typeof payload === 'object' && payload !== null) {
      const keys = Object.keys(payload);
      return keys.some((key) => MONETARY_FIELDS.includes(key));
    }
  } catch {
    // Unparseable payload — treat as non-monetary to avoid false positives
  }

  return false;
}

// =============================================
// UUID HELPER
// =============================================

/** Generate a simple UUID v4 for audit entry IDs. */
function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// =============================================
// DESKTOP CONFLICT RESOLVER
// =============================================

/**
 * Detects and resolves sync conflicts for the desktop POS client.
 *
 * Usage:
 * ```ts
 * const resolver = new DesktopConflictResolver('server-wins');
 * const detection = resolver.detect(localItem, serverRecord);
 * if (detection.hasConflict) {
 *   const resolution = resolver.resolve({
 *     localItem,
 *     serverRecord,
 *     detection,
 *   });
 * }
 * const log = resolver.getConflictLog();
 * ```
 */
export class DesktopConflictResolver {
  private strategy: ConflictStrategy;
  private conflictLog: ConflictAuditEntry[] = [];

  /**
   * @param strategy - Default conflict resolution strategy.
   *   Defaults to 'server-wins' per requirements.
   */
  constructor(strategy: ConflictStrategy = 'server-wins') {
    this.strategy = strategy;
  }

  /**
   * Get the currently configured default strategy.
   */
  getStrategy(): ConflictStrategy {
    return this.strategy;
  }

  /**
   * Update the default conflict resolution strategy.
   */
  setStrategy(strategy: ConflictStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Detect whether a conflict exists between a local queue item
   * and the current server state.
   *
   * A conflict is detected when the local item's version is behind
   * (strictly less than) the server version, meaning the server record
   * was modified after the local change was queued.
   *
   * @param localItem  - The offline-queued sync item.
   * @param serverRecord - The current server-side record state.
   * @returns Detection result with conflict flag and metadata.
   */
  detect(
    localItem: SyncQueueItem,
    serverRecord: ServerRecord,
  ): ConflictDetectionResult {
    const localVersion = localItem.version;
    const serverVersion = serverRecord.version;
    const hasConflict = localVersion < serverVersion;
    const monetary = hasConflict ? isMonetaryItem(localItem) : false;

    return {
      hasConflict,
      isMonetary: monetary,
      localVersion,
      serverVersion,
    };
  }

  /**
   * Resolve a detected conflict by applying the configured strategy.
   *
   * - **server-wins** (default): Discards the local change. Monetary
   *   conflicts are flagged for operator review rather than silently resolved.
   * - **client-wins**: Preserves the local change, discarding the server state.
   * - **manual**: Flags the conflict for operator review without
   *   automatically discarding either side.
   *
   * Every resolution is recorded in the in-memory audit log.
   *
   * @param conflict - Full conflict descriptor from detect().
   * @returns Resolution outcome including the audit entry.
   */
  resolve(conflict: OrderConflict): ConflictResolution {
    const { localItem, detection } = conflict;
    const effectiveStrategy = this.strategy;

    let localDiscarded: boolean;
    let requiresOperatorReview: boolean;
    let resolution: ConflictStrategy | 'auto-server-wins';

    switch (effectiveStrategy) {
      case 'server-wins':
        localDiscarded = true;
        // Monetary conflicts always require operator review
        requiresOperatorReview = detection.isMonetary;
        resolution = detection.isMonetary ? 'server-wins' : 'auto-server-wins';
        break;

      case 'client-wins':
        localDiscarded = false;
        requiresOperatorReview = false;
        resolution = 'client-wins';
        break;

      case 'manual':
        // Manual strategy defers all resolution to the operator
        localDiscarded = false;
        requiresOperatorReview = true;
        resolution = 'manual';
        break;

      default:
        // Fallback to server-wins for unknown strategies
        localDiscarded = true;
        requiresOperatorReview = detection.isMonetary;
        resolution = 'auto-server-wins';
        break;
    }

    // Build the audit entry with all required fields
    const auditEntry: ConflictAuditEntry = {
      id: generateId(),
      operationType: localItem.operation,
      entityId: localItem.recordId,
      entityType: localItem.tableName,
      localVersion: detection.localVersion,
      serverVersion: detection.serverVersion,
      timestamp: new Date().toISOString(),
      discardedPayload: localDiscarded ? localItem.data : '',
      resolution,
      isMonetary: detection.isMonetary,
      reviewedByOperator: false,
    };

    // Append to in-memory audit log
    this.conflictLog.push(auditEntry);

    return {
      strategy: resolution,
      localDiscarded,
      requiresOperatorReview,
      auditEntry,
    };
  }

  /**
   * Return all conflict audit entries recorded during this session.
   * Entries are ordered chronologically (oldest first).
   */
  getConflictLog(): ConflictAuditEntry[] {
    return [...this.conflictLog];
  }

  /**
   * Clear all in-memory audit entries.
   * Useful after entries have been persisted to SQLite.
   */
  clearConflictLog(): void {
    this.conflictLog = [];
  }
}
