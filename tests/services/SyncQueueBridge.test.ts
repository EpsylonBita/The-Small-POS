import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncQueueBridge } from '../../src/renderer/services/SyncQueueBridge';

type InvokeResponse =
  | unknown
  | ((payload: unknown) => unknown | Promise<unknown>);

function createInvokeStub(plan: Record<string, InvokeResponse[]>) {
  const calls: Array<{ command: string; payload: unknown }> = [];

  const invoke = async (command: string, payload?: unknown) => {
    calls.push({ command, payload });
    const bucket = plan[command];
    assert.ok(bucket && bucket.length > 0, `Missing planned response for ${command}`);
    const next = bucket.shift();
    return typeof next === 'function' ? (next as (value: unknown) => unknown)(payload) : next;
  };

  return {
    calls,
    invoke: invoke as any,
  };
}

const buildQueueItem = () => ({
  tableName: 'orders',
  recordId: 'order-123',
  operation: 'INSERT' as const,
  data: '{"id":"order-123"}',
  organizationId: 'org-123',
  priority: 4,
  moduleType: 'orders',
  conflictStrategy: 'server-wins' as const,
  version: 2,
});

test('SyncQueueBridge enqueue maps IPC payloads and refreshes pending count', async () => {
  const stub = createInvokeStub({
    sync_queue_enqueue: ['queue-item-1'],
    sync_queue_length: [1],
  });
  const bridge = new SyncQueueBridge(stub.invoke);
  const updates: number[] = [];
  bridge.onPendingCountChange((count) => updates.push(count));

  const id = await bridge.enqueue(buildQueueItem());

  assert.equal(id, 'queue-item-1');
  assert.equal(bridge.pendingCount, 1);
  assert.deepEqual(updates, [1]);
  assert.deepEqual(stub.calls, [
    {
      command: 'sync_queue_enqueue',
      payload: {
        item: {
          tableName: 'orders',
          recordId: 'order-123',
          operation: 'INSERT',
          data: '{"id":"order-123"}',
          organizationId: 'org-123',
          priority: 4,
          moduleType: 'orders',
          conflictStrategy: 'server-wins',
          version: 2,
        },
      },
    },
    {
      command: 'sync_queue_length',
      payload: undefined,
    },
  ]);
});

test('SyncQueueBridge processQueue and clear keep pending count synchronized', async () => {
  const stub = createInvokeStub({
    sync_queue_status: [
      {
        total: 3,
        pending: 2,
        failed: 1,
        conflicts: 0,
        oldestItemAge: null,
      },
    ],
    sync_queue_process: [
      {
        success: true,
        processed: 2,
        failed: 0,
        conflicts: 0,
        errors: [],
      },
    ],
    sync_queue_length: [1],
    sync_queue_clear: [undefined],
  });
  const bridge = new SyncQueueBridge(stub.invoke);
  const updates: number[] = [];
  bridge.onPendingCountChange((count) => updates.push(count));

  const status = await bridge.getStatus();
  const result = await bridge.processQueue('https://admin.example', 'pos-key');
  await bridge.clear();

  assert.deepEqual(status, {
    total: 3,
    pending: 2,
    failed: 1,
    conflicts: 0,
    oldestItemAge: null,
  });
  assert.deepEqual(result, {
    success: true,
    processed: 2,
    failed: 0,
    conflicts: 0,
    errors: [],
  });
  assert.equal(bridge.pendingCount, 0);
  assert.deepEqual(updates, [3, 1, 0]);
  assert.deepEqual(stub.calls, [
    {
      command: 'sync_queue_status',
      payload: undefined,
    },
    {
      command: 'sync_queue_process',
      payload: {
        apiBaseUrl: 'https://admin.example',
        apiKey: 'pos-key',
      },
    },
    {
      command: 'sync_queue_length',
      payload: undefined,
    },
    {
      command: 'sync_queue_clear',
      payload: undefined,
    },
  ]);
});

test('SyncQueueBridge list and retry helpers call parity IPC commands', async () => {
  const stub = createInvokeStub({
    sync_queue_list_items: [[
      {
        id: 'queue-1',
        tableName: 'payments',
        recordId: 'payment-1',
        operation: 'INSERT',
        data: '{"paymentId":"payment-1"}',
        organizationId: 'org-123',
        createdAt: '2026-04-10T10:00:00.000Z',
        attempts: 2,
        lastAttempt: null,
        errorMessage: 'Waiting for parent order sync',
        nextRetryAt: '2026-04-10T10:00:05.000Z',
        retryDelayMs: 1000,
        priority: 1,
        moduleType: 'financial',
        conflictStrategy: 'manual',
        version: 1,
        status: 'pending',
      },
    ]],
    sync_queue_retry_item: [undefined],
    sync_queue_retry_module: [{ retried: 3 }],
    sync_queue_length: [4, 2],
    sync_queue_list_conflicts: [[
      {
        id: 'conflict-1',
        operationType: 'INSERT',
        entityId: 'payment-1',
        entityType: 'payments',
        localVersion: 1,
        serverVersion: 2,
        timestamp: '2026-04-10T10:00:00.000Z',
        discardedPayload: '{"paymentId":"payment-1"}',
        resolution: 'manual',
        isMonetary: true,
        reviewedByOperator: false,
      },
    ]],
  });
  const bridge = new SyncQueueBridge(stub.invoke);

  const items = await bridge.listItems({ moduleType: 'financial', limit: 25 });
  await bridge.retryItem('queue-1');
  const retryResult = await bridge.retryModule('financial');
  const conflicts = await bridge.listConflicts(20);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.tableName, 'payments');
  assert.deepEqual(retryResult, { retried: 3 });
  assert.equal(conflicts[0]?.entityType, 'payments');
  assert.deepEqual(stub.calls, [
    {
      command: 'sync_queue_list_items',
      payload: {
        query: {
          moduleType: 'financial',
          limit: 25,
        },
      },
    },
    {
      command: 'sync_queue_retry_item',
      payload: {
        itemId: 'queue-1',
      },
    },
    {
      command: 'sync_queue_length',
      payload: undefined,
    },
    {
      command: 'sync_queue_retry_module',
      payload: {
        moduleType: 'financial',
      },
    },
    {
      command: 'sync_queue_length',
      payload: undefined,
    },
    {
      command: 'sync_queue_list_conflicts',
      payload: {
        limit: 20,
      },
    },
  ]);
});
