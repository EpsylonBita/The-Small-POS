/**
 * procurement-loop Task 10.4: queued goods-receipt inspection.
 *
 * Pins the pending-sync overlay's source-of-truth semantics: queue rows
 * classify into pending / parked (MODULE_REQUIRED) / conflict / failed,
 * only pending+parked adjust the optimistic remaining quantities, and a
 * conflicted receipt's recorded quantities stay parseable for the
 * needs-attention card — never silently dropped. [R11.1, R11.6, R11.7]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listItems: vi.fn(),
  retryItem: vi.fn(),
}));

vi.mock('../SyncQueueBridge', () => ({
  getSyncQueueBridge: () => ({
    listItems: mocks.listItems,
    retryItem: mocks.retryItem,
  }),
}));

import type { SyncQueueItem } from '../../../../shared/pos/sync-queue-types';
import type { PosPurchaseOrder } from '../purchase-order-snapshot';
import {
  classifyQueuedReceiptState,
  listQueuedPoReceipts,
  parseQueuedPoReceipt,
  pendingQuantitiesByItem,
  retryQueuedPoReceipt,
} from '../po-receipt-queue';

function queueItem(overrides: Partial<SyncQueueItem> = {}): SyncQueueItem {
  return {
    id: 'queue-1',
    tableName: 'po_receipts',
    recordId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    operation: 'INSERT',
    data: JSON.stringify({
      purchase_order_id: 'po-1',
      idempotency_key: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      recorded_at: '2026-08-05T10:15:00.000Z',
      staff_id: 'staff-1',
      source: 'pos_desktop',
      kind: 'delivery',
      notes: null,
      lines: [
        { purchaseOrderItemId: 'item-1', quantityReceived: 4, unitCost: 2.5 },
        { purchaseOrderItemId: 'item-2', quantityReceived: 2 },
      ],
    }),
    organizationId: 'org-1',
    createdAt: '2026-08-05T10:15:01.000Z',
    attempts: 0,
    lastAttempt: null,
    errorMessage: null,
    nextRetryAt: null,
    retryDelayMs: 1000,
    priority: 0,
    moduleType: 'suppliers',
    conflictStrategy: 'manual',
    version: 1,
    status: 'pending',
    ...overrides,
  } as SyncQueueItem;
}

function purchaseOrder(): PosPurchaseOrder {
  return {
    id: 'po-1',
    organizationId: 'org-1',
    branchId: 'branch-1',
    supplierId: 'supplier-1',
    supplierName: 'Athens Fresh Produce',
    orderReference: 'PO-2026-000001',
    status: 'ordered',
    expectedDeliveryDate: null,
    notes: null,
    items: [],
    orderedTotalCost: 0,
    receivedProgress: { orderedQty: 10, receivedQty: 0 },
    createdAt: null,
    updatedAt: null,
  };
}

describe('classifyQueuedReceiptState', () => {
  it('maps queue rows to overlay states', () => {
    expect(classifyQueuedReceiptState('pending', null)).toBe('pending');
    expect(classifyQueuedReceiptState('processing', null)).toBe('pending');
    expect(classifyQueuedReceiptState('conflict', null)).toBe('conflict');
    expect(classifyQueuedReceiptState('failed', 'HTTP 400: nope')).toBe('failed');
    // MODULE_REQUIRED parks leave the row pending with the reason in the
    // error message — parking is detected from the message. [R11.6]
    expect(
      classifyQueuedReceiptState(
        'pending',
        'MODULE_REQUIRED: organization is missing module(s): suppliers',
      ),
    ).toBe('parked');
  });
});

describe('parseQueuedPoReceipt', () => {
  it('parses the capture payload including recorded quantities', () => {
    const receipt = parseQueuedPoReceipt(queueItem());
    expect(receipt).not.toBeNull();
    expect(receipt?.purchaseOrderId).toBe('po-1');
    expect(receipt?.idempotencyKey).toBe('7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
    expect(receipt?.recordedAt).toBe('2026-08-05T10:15:00.000Z');
    expect(receipt?.state).toBe('pending');
    expect(receipt?.lines).toEqual([
      { purchaseOrderItemId: 'item-1', quantityReceived: 4, unitCost: 2.5, isUnplanned: false },
      { purchaseOrderItemId: 'item-2', quantityReceived: 2, unitCost: null, isUnplanned: false },
    ]);
  });

  it('ignores rows of other entities and falls back to recordId for the key', () => {
    expect(parseQueuedPoReceipt(queueItem({ tableName: 'orders' }))).toBeNull();

    const withoutKey = queueItem({
      data: JSON.stringify({
        purchase_order_id: 'po-1',
        lines: [{ purchaseOrderItemId: 'item-1', quantityReceived: 1 }],
      }),
    });
    expect(parseQueuedPoReceipt(withoutKey)?.idempotencyKey).toBe(
      '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    );
  });

  it('preserves recorded quantities on conflicted rows for the needs-attention card', () => {
    const conflicted = parseQueuedPoReceipt(
      queueItem({ status: 'conflict', errorMessage: 'Conflict detected (HTTP 409)' }),
    );
    expect(conflicted?.state).toBe('conflict');
    expect(conflicted?.lines[0].quantityReceived).toBe(4);
    expect(conflicted?.errorMessage).toContain('409');
  });
});

describe('pendingQuantitiesByItem', () => {
  it('sums pending and parked quantities per item, excluding conflict and failed rows', () => {
    const receipts = [
      parseQueuedPoReceipt(queueItem())!,
      parseQueuedPoReceipt(
        queueItem({
          id: 'queue-2',
          recordId: 'key-2',
          errorMessage: 'MODULE_REQUIRED: organization is missing module(s): suppliers',
        }),
      )!,
      parseQueuedPoReceipt(queueItem({ id: 'queue-3', recordId: 'key-3', status: 'conflict' }))!,
      parseQueuedPoReceipt(queueItem({ id: 'queue-4', recordId: 'key-4', status: 'failed' }))!,
    ];

    const pending = pendingQuantitiesByItem(purchaseOrder(), receipts);

    // pending (4+2) + parked (4+2); conflict/failed contribute nothing —
    // they were NOT applied server-side. [R11.7]
    expect(pending.get('item-1')).toBe(8);
    expect(pending.get('item-2')).toBe(4);
  });

  it('only counts receipts targeting the given purchase order', () => {
    const other = parseQueuedPoReceipt(
      queueItem({
        id: 'queue-5',
        recordId: 'key-5',
        data: JSON.stringify({
          purchase_order_id: 'po-OTHER',
          idempotency_key: 'key-5',
          lines: [{ purchaseOrderItemId: 'item-1', quantityReceived: 9 }],
        }),
      }),
    )!;
    const pending = pendingQuantitiesByItem(purchaseOrder(), [other]);
    expect(pending.size).toBe(0);
  });
});

describe('queue bridge integration', () => {
  beforeEach(() => {
    mocks.listItems.mockReset();
    mocks.retryItem.mockReset();
  });

  it('lists queued receipts through the suppliers module filter', async () => {
    mocks.listItems.mockResolvedValueOnce([
      queueItem(),
      queueItem({ id: 'queue-x', tableName: 'orders' }),
    ]);

    const receipts = await listQueuedPoReceipts();

    expect(mocks.listItems).toHaveBeenCalledWith({ moduleType: 'suppliers' });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].queueId).toBe('queue-1');
  });

  it('retries a queued receipt by queue id', async () => {
    mocks.retryItem.mockResolvedValueOnce(undefined);
    await retryQueuedPoReceipt('queue-1');
    expect(mocks.retryItem).toHaveBeenCalledWith('queue-1');
  });
});
