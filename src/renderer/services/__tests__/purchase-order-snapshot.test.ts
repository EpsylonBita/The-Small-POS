/**
 * procurement-loop Task 10.1: purchase-order snapshot pull set.
 *
 * Pins the delta-cursor contract against `/api/pos/purchase-orders`:
 * no stored cursor → full snapshot; afterwards `updated_since=<cursor>`
 * delta pulls that upsert by id and advance the cursor from the
 * server's `serverTime`; offline/cache-fallback responses never advance
 * the cursor; the merged snapshot persists across "restarts"
 * (fresh module instance reading the same storage). [R10.1, R11.1]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchFromAdmin: vi.fn(),
  emitCompatEvent: vi.fn(),
}));

vi.mock('../../../lib', () => ({
  getBridge: () => ({
    adminApi: {
      fetchFromAdmin: mocks.fetchFromAdmin,
    },
  }),
  emitCompatEvent: mocks.emitCompatEvent,
}));

import {
  PURCHASE_ORDER_SNAPSHOT_EVENT,
  clearPurchaseOrderSnapshotForTests,
  loadPurchaseOrderSnapshot,
  mergeDeltaIntoSnapshot,
  syncPurchaseOrderSnapshot,
  type PosPurchaseOrder,
} from '../purchase-order-snapshot';

function purchaseOrder(overrides: Partial<PosPurchaseOrder> = {}): PosPurchaseOrder {
  return {
    id: 'po-1',
    organizationId: 'org-1',
    branchId: 'branch-1',
    supplierId: 'supplier-1',
    supplierName: 'Athens Fresh Produce',
    orderReference: 'PO-2026-000001',
    status: 'ordered',
    expectedDeliveryDate: '2026-08-07',
    notes: null,
    items: [
      {
        id: 'item-1',
        flavor: 'inventory',
        inventoryItemId: 'inv-1',
        retailProductId: null,
        productId: null,
        itemNameSnapshot: 'Tomatoes',
        unit: 'kg',
        quantityOrdered: 10,
        expectedUnitCost: 2.5,
        quantityReceived: 4,
        remainingQuantity: 6,
        isUnplanned: false,
      },
    ],
    orderedTotalCost: 25,
    receivedProgress: { orderedQty: 10, receivedQty: 4 },
    createdAt: '2026-08-04T09:00:00.000Z',
    updatedAt: '2026-08-04T09:00:00.000Z',
    ...overrides,
  };
}

function remoteResponse(purchaseOrders: PosPurchaseOrder[], serverTime: string) {
  return {
    success: true,
    data: { success: true, purchaseOrders, serverTime },
    status: 200,
    meta: { source: 'remote' },
  };
}

describe('purchase-order snapshot sync', () => {
  beforeEach(() => {
    clearPurchaseOrderSnapshotForTests();
    mocks.fetchFromAdmin.mockReset();
    mocks.emitCompatEvent.mockReset();
  });

  it('pulls a full snapshot when no cursor is stored and persists serverTime as the next cursor', async () => {
    mocks.fetchFromAdmin.mockResolvedValueOnce(
      remoteResponse([purchaseOrder()], '2026-08-05T10:00:00.000Z'),
    );

    const snapshot = await syncPurchaseOrderSnapshot();

    expect(mocks.fetchFromAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.fetchFromAdmin).toHaveBeenCalledWith('/api/pos/purchase-orders', {
      method: 'GET',
    });
    expect(snapshot.purchaseOrders).toHaveLength(1);
    expect(snapshot.purchaseOrders[0].orderReference).toBe('PO-2026-000001');
    expect(snapshot.serverCursor).toBe('2026-08-05T10:00:00.000Z');
    expect(snapshot.fetchedAt).toBeTruthy();
    expect(mocks.emitCompatEvent).toHaveBeenCalledWith(
      PURCHASE_ORDER_SNAPSHOT_EVENT,
      expect.objectContaining({ serverCursor: '2026-08-05T10:00:00.000Z' }),
    );
  });

  it('passes the stored cursor as updated_since, merges the delta by id, and advances the cursor', async () => {
    mocks.fetchFromAdmin.mockResolvedValueOnce(
      remoteResponse(
        [purchaseOrder(), purchaseOrder({ id: 'po-2', orderReference: 'PO-2026-000002' })],
        '2026-08-05T10:00:00.000Z',
      ),
    );
    await syncPurchaseOrderSnapshot();

    // Delta: po-1 became partially_received; po-2 untouched (not re-sent).
    mocks.fetchFromAdmin.mockResolvedValueOnce(
      remoteResponse(
        [
          purchaseOrder({
            status: 'partially_received',
            updatedAt: '2026-08-05T10:05:00.000Z',
          }),
        ],
        '2026-08-05T10:10:00.000Z',
      ),
    );
    const snapshot = await syncPurchaseOrderSnapshot();

    expect(mocks.fetchFromAdmin).toHaveBeenLastCalledWith(
      `/api/pos/purchase-orders?updated_since=${encodeURIComponent('2026-08-05T10:00:00.000Z')}`,
      { method: 'GET' },
    );
    expect(snapshot.serverCursor).toBe('2026-08-05T10:10:00.000Z');
    expect(snapshot.purchaseOrders).toHaveLength(2);
    expect(snapshot.purchaseOrders.find((po) => po.id === 'po-1')?.status).toBe(
      'partially_received',
    );
    expect(snapshot.purchaseOrders.find((po) => po.id === 'po-2')?.orderReference).toBe(
      'PO-2026-000002',
    );
  });

  it('survives a restart: a fresh load reads the persisted snapshot from storage', async () => {
    mocks.fetchFromAdmin.mockResolvedValueOnce(
      remoteResponse([purchaseOrder()], '2026-08-05T10:00:00.000Z'),
    );
    await syncPurchaseOrderSnapshot();

    // Simulate an app restart: a brand-new module instance must find the
    // snapshot (and its cursor) in localStorage. [R11.1, R11.2]
    vi.resetModules();
    const fresh = await import('../purchase-order-snapshot');
    const restored = fresh.loadPurchaseOrderSnapshot();

    expect(restored.purchaseOrders).toHaveLength(1);
    expect(restored.purchaseOrders[0].id).toBe('po-1');
    expect(restored.serverCursor).toBe('2026-08-05T10:00:00.000Z');
    expect(restored.fetchedAt).toBeTruthy();
  });

  it('keeps the stored snapshot and cursor unchanged on transport failure', async () => {
    mocks.fetchFromAdmin.mockResolvedValueOnce(
      remoteResponse([purchaseOrder()], '2026-08-05T10:00:00.000Z'),
    );
    await syncPurchaseOrderSnapshot();

    mocks.fetchFromAdmin.mockResolvedValueOnce({
      success: false,
      error: 'Network error. No cached local copy is available yet for offline use.',
    });
    const snapshot = await syncPurchaseOrderSnapshot();

    expect(snapshot.purchaseOrders).toHaveLength(1);
    expect(snapshot.serverCursor).toBe('2026-08-05T10:00:00.000Z');
  });

  it('never advances the cursor from an offline cache fallback response', async () => {
    mocks.fetchFromAdmin.mockResolvedValueOnce(
      remoteResponse([purchaseOrder()], '2026-08-05T10:00:00.000Z'),
    );
    await syncPurchaseOrderSnapshot();

    mocks.fetchFromAdmin.mockResolvedValueOnce({
      success: true,
      data: {
        success: true,
        purchaseOrders: [purchaseOrder({ status: 'cancelled' })],
        serverTime: '2026-08-05T12:00:00.000Z',
      },
      status: 200,
      meta: { source: 'cache', offlineFallback: true, cachedAt: '2026-08-05T09:00:00.000Z' },
    });
    const snapshot = await syncPurchaseOrderSnapshot();

    // Stale cached data must not overwrite the merged snapshot nor move
    // the cursor — the next online pull re-delivers anything missed.
    expect(snapshot.serverCursor).toBe('2026-08-05T10:00:00.000Z');
    expect(snapshot.purchaseOrders[0].status).toBe('ordered');
  });

  it('seeds from the cache fallback only when no local snapshot exists, leaving the cursor unset', async () => {
    mocks.fetchFromAdmin.mockResolvedValueOnce({
      success: true,
      data: {
        success: true,
        purchaseOrders: [purchaseOrder()],
        serverTime: '2026-08-05T12:00:00.000Z',
      },
      status: 200,
      meta: { source: 'cache', offlineFallback: true, cachedAt: '2026-08-05T09:00:00.000Z' },
    });

    const snapshot = await syncPurchaseOrderSnapshot();

    expect(snapshot.purchaseOrders).toHaveLength(1);
    // Cursor stays null so the first ONLINE pull is a full snapshot.
    expect(snapshot.serverCursor).toBeNull();
    expect(loadPurchaseOrderSnapshot().purchaseOrders).toHaveLength(1);
  });

  it('prunes closed and cancelled purchase orders older than the retention window on merge', () => {
    const staleClosed = purchaseOrder({
      id: 'po-old',
      status: 'received_closed',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    const freshCancelled = purchaseOrder({
      id: 'po-new',
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    });
    const open = purchaseOrder({ id: 'po-open', status: 'ordered', updatedAt: '2026-07-01T00:00:00.000Z' });

    const merged = mergeDeltaIntoSnapshot([staleClosed, open], [freshCancelled]);

    const ids = merged.map((po) => po.id);
    expect(ids).toContain('po-open');
    expect(ids).toContain('po-new');
    expect(ids).not.toContain('po-old');
  });
});
