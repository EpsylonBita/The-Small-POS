/**
 * SyncQueueBridge
 *
 * TypeScript bridge for the Rust-backed parity sync queue.
 * Wraps Tauri IPC invoke() calls and exposes typed methods matching
 * the SyncQueue interface from shared/pos/sync-queue-types.ts.
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  SyncQueueItem,
  SyncResult,
  QueueStatus,
  SyncQueue,
  ConflictStrategy,
  SyncOperation,
  ConflictAuditEntry,
} from '../../../../shared/pos/sync-queue-types';

// =============================================
// ENQUEUE INPUT (matches Rust EnqueueInput)
// =============================================

interface EnqueueParams {
  tableName: string;
  recordId: string;
  operation: SyncOperation;
  data: string;
  organizationId: string;
  priority?: number;
  moduleType?: string;
  conflictStrategy?: ConflictStrategy;
  version?: number;
}

interface QueueListQuery {
  limit?: number;
  moduleType?: string;
}

interface RetryItemsResult {
  retried: number;
}

// =============================================
// SYNC QUEUE BRIDGE
// =============================================

export class SyncQueueBridge implements SyncQueue {
  private readonly invokeFn: typeof invoke;
  private _pendingCount = 0;
  private _listeners: Set<(count: number) => void> = new Set();

  constructor(invokeFn: typeof invoke = invoke) {
    this.invokeFn = invokeFn;
  }

  /**
   * Add an item to the offline sync queue.
   * Returns the generated UUID for the item.
   */
  async enqueue(
    item: Omit<SyncQueueItem, 'id' | 'createdAt' | 'attempts' | 'lastAttempt' | 'errorMessage' | 'nextRetryAt' | 'retryDelayMs' | 'status'>,
  ): Promise<string> {
    const params: EnqueueParams = {
      tableName: item.tableName,
      recordId: item.recordId,
      operation: item.operation,
      data: item.data,
      organizationId: item.organizationId,
      priority: item.priority,
      moduleType: item.moduleType,
      conflictStrategy: item.conflictStrategy,
      version: item.version,
    };

    const id = await this.invokeFn<string>('sync_queue_enqueue', { item: params });
    await this.refreshPendingCount();
    return id;
  }

  /**
   * Dequeue the next item (highest priority, oldest first).
   * Marks the item as 'processing'.
   */
  async dequeue(): Promise<SyncQueueItem | null> {
    const item = await this.invokeFn<SyncQueueItem | null>('sync_queue_dequeue');
    await this.refreshPendingCount();
    return item;
  }

  /**
   * Peek at the next item without removing or changing its status.
   */
  async peek(): Promise<SyncQueueItem | null> {
    return this.invokeFn<SyncQueueItem | null>('sync_queue_peek');
  }

  /**
   * Remove all items from the queue.
   */
  async clear(): Promise<void> {
    await this.invokeFn<void>('sync_queue_clear');
    this.updatePendingCount(0);
  }

  /**
   * Get the current number of items in the queue.
   */
  async getQueueLength(): Promise<number> {
    const length = await this.invokeFn<number>('sync_queue_length');
    this.updatePendingCount(length);
    return length;
  }

  /**
   * Get detailed queue status.
   */
  async getStatus(): Promise<QueueStatus> {
    const status = await this.invokeFn<QueueStatus>('sync_queue_status');
    this.updatePendingCount(status.total);
    return status;
  }

  /**
   * Process all pending items by syncing to the admin API.
   */
  async processQueue(apiBaseUrl: string, apiKey: string): Promise<SyncResult> {
    const result = await this.invokeFn<SyncResult>('sync_queue_process', {
      apiBaseUrl,
      apiKey,
    });
    await this.refreshPendingCount();
    return result;
  }

  async listItems(query: QueueListQuery = {}): Promise<SyncQueueItem[]> {
    return this.invokeFn<SyncQueueItem[]>('sync_queue_list_items', { query });
  }

  async retryItem(itemId: string): Promise<void> {
    await this.invokeFn<void>('sync_queue_retry_item', { itemId });
    await this.refreshPendingCount();
  }

  async retryModule(moduleType: string): Promise<RetryItemsResult> {
    const result = await this.invokeFn<RetryItemsResult>('sync_queue_retry_module', {
      moduleType,
    });
    await this.refreshPendingCount();
    return result;
  }

  async listConflicts(limit = 100): Promise<ConflictAuditEntry[]> {
    return this.invokeFn<ConflictAuditEntry[]>('sync_queue_list_conflicts', { limit });
  }

  // =============================================
  // PENDING COUNT (for UI badge)
  // =============================================

  /** Current pending count for UI display */
  get pendingCount(): number {
    return this._pendingCount;
  }

  /** Subscribe to pending count changes */
  onPendingCountChange(listener: (count: number) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private updatePendingCount(count: number): void {
    if (this._pendingCount !== count) {
      this._pendingCount = count;
      for (const listener of this._listeners) {
        try {
          listener(count);
        } catch {
          // listener errors should not break the bridge
        }
      }
    }
  }

  private async refreshPendingCount(): Promise<void> {
    try {
      const length = await this.invokeFn<number>('sync_queue_length');
      this.updatePendingCount(length);
    } catch {
      // non-critical — UI badge will update on next call
    }
  }
}

/** Singleton instance for app-wide use */
let _instance: SyncQueueBridge | null = null;

export function getSyncQueueBridge(): SyncQueueBridge {
  if (!_instance) {
    _instance = new SyncQueueBridge();
  }
  return _instance;
}

export function setSyncQueueBridgeInstanceForTests(instance: SyncQueueBridge | null): void {
  _instance = instance;
}
