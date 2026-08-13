/**
 * Purchase-order snapshot cache (procurement-loop Task 10.1).
 *
 * Offline-first source for the POS "Purchase orders" surface:
 * `ParitySyncCoordinator` calls `syncPurchaseOrderSnapshot()` every parity
 * cycle — the first pull is a full snapshot of `/api/pos/purchase-orders`
 * (the terminal branch's open POs plus the server's recently-closed
 * window), and every later pull passes the last stored `serverTime` as an
 * `updated_since` delta cursor so steady-state sync is a cheap diff.
 * [R10.1, R11.1, R13.3]
 *
 * The merged snapshot persists in `localStorage` with `fetchedAt`, so it
 * survives app restarts and renders offline with a staleness label; the
 * raw `/api/pos/purchase-orders` response is additionally cached by the
 * Rust admin-GET cache (see `pos-module-cache-registry.ts` `suppliers`
 * entry) as a second offline fallback. Delta-cursor responses are
 * deliberately never cached on the Rust side
 * (`api_bridge::is_delta_cursor_admin_get`).
 */

import { emitCompatEvent, getBridge } from '../../lib';
import type {
  PoItemFlavor,
  PurchaseOrderStatus,
} from '../../../../shared/types/procurement';

export const PURCHASE_ORDER_SNAPSHOT_EVENT = 'purchase-orders:snapshot';

const SNAPSHOT_STORAGE_KEY = 'pos_purchase_orders_snapshot_v1';
const PURCHASE_ORDERS_PATH = '/api/pos/purchase-orders';

/** Mirror of the server's recently-closed retention window (7 days). */
const CLOSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface PosPurchaseOrderItem {
  id: string;
  flavor: PoItemFlavor;
  inventoryItemId: string | null;
  retailProductId: string | null;
  productId: string | null;
  itemNameSnapshot: string;
  unit: string | null;
  quantityOrdered: number;
  expectedUnitCost: number | null;
  quantityReceived: number;
  remainingQuantity: number;
  isUnplanned: boolean;
}

export interface PosPurchaseOrder {
  id: string;
  organizationId: string;
  branchId: string;
  supplierId: string;
  supplierName: string | null;
  orderReference: string;
  status: PurchaseOrderStatus;
  expectedDeliveryDate: string | null;
  notes: string | null;
  items: PosPurchaseOrderItem[];
  orderedTotalCost: number;
  receivedProgress: { orderedQty: number; receivedQty: number };
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PurchaseOrderSnapshot {
  purchaseOrders: PosPurchaseOrder[];
  /** Server-issued `serverTime` from the last successful pull — the next `updated_since` cursor. */
  serverCursor: string | null;
  /** Local wall-clock time of the last successful pull, for staleness labels. */
  fetchedAt: string | null;
}

interface AdminFetchEnvelope {
  success?: boolean;
  data?: {
    success?: boolean;
    purchaseOrders?: unknown;
    serverTime?: unknown;
  };
  meta?: {
    source?: string;
    offlineFallback?: boolean;
    cachedAt?: string | null;
  };
  error?: string;
}

function emptySnapshot(): PurchaseOrderSnapshot {
  return { purchaseOrders: [], serverCursor: null, fetchedAt: null };
}

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isPurchaseOrderLike(value: unknown): value is PosPurchaseOrder {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { orderReference?: unknown }).orderReference === 'string' &&
    typeof (value as { status?: unknown }).status === 'string'
  );
}

function sanitizePurchaseOrders(rows: unknown): PosPurchaseOrder[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.filter(isPurchaseOrderLike).map((row) => ({
    ...row,
    items: Array.isArray(row.items) ? row.items : [],
  }));
}

/** Read the persisted snapshot; tolerant of missing/corrupt storage. */
export function loadPurchaseOrderSnapshot(): PurchaseOrderSnapshot {
  const storage = getStorage();
  if (!storage) {
    return emptySnapshot();
  }
  try {
    const raw = storage.getItem(SNAPSHOT_STORAGE_KEY);
    if (!raw) {
      return emptySnapshot();
    }
    const parsed = JSON.parse(raw) as Partial<PurchaseOrderSnapshot>;
    return {
      purchaseOrders: sanitizePurchaseOrders(parsed.purchaseOrders),
      serverCursor:
        typeof parsed.serverCursor === 'string' && parsed.serverCursor.trim()
          ? parsed.serverCursor
          : null,
      fetchedAt:
        typeof parsed.fetchedAt === 'string' && parsed.fetchedAt.trim()
          ? parsed.fetchedAt
          : null,
    };
  } catch {
    return emptySnapshot();
  }
}

function persistSnapshot(snapshot: PurchaseOrderSnapshot): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn('[purchase-order-snapshot] Failed to persist snapshot:', error);
  }
}

function sortByCreatedAtDesc(rows: PosPurchaseOrder[]): PosPurchaseOrder[] {
  return rows
    .slice()
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/**
 * Drop closed/cancelled POs that fell out of the server's recently-closed
 * window, mirroring the full-snapshot retention so delta merges do not
 * grow the local list forever.
 */
function pruneExpiredClosed(rows: PosPurchaseOrder[]): PosPurchaseOrder[] {
  const cutoff = Date.now() - CLOSED_RETENTION_MS;
  return rows.filter((po) => {
    if (po.status !== 'received_closed' && po.status !== 'cancelled') {
      return true;
    }
    const updatedAt = Date.parse(po.updatedAt ?? '');
    return Number.isFinite(updatedAt) && updatedAt >= cutoff;
  });
}

/** Delta merge: upsert changed POs by id into the stored list. [R11.1] */
export function mergeDeltaIntoSnapshot(
  existing: PosPurchaseOrder[],
  changed: PosPurchaseOrder[],
): PosPurchaseOrder[] {
  const byId = new Map(existing.map((po) => [po.id, po]));
  for (const po of changed) {
    byId.set(po.id, po);
  }
  return sortByCreatedAtDesc(pruneExpiredClosed(Array.from(byId.values())));
}

function publishSnapshot(snapshot: PurchaseOrderSnapshot): PurchaseOrderSnapshot {
  persistSnapshot(snapshot);
  emitCompatEvent(PURCHASE_ORDER_SNAPSHOT_EVENT, snapshot);
  return snapshot;
}

/**
 * Pull the terminal branch's purchase orders — full snapshot when no
 * cursor is stored, `updated_since` delta afterwards — and persist the
 * merged result with a fresh `fetchedAt`. Offline (or on any transport
 * failure) the stored snapshot is returned unchanged: the cursor never
 * advances without fresh server data, so the next online pull cannot
 * skip changes. [R10.1, R11.1]
 */
export async function syncPurchaseOrderSnapshot(): Promise<PurchaseOrderSnapshot> {
  const existing = loadPurchaseOrderSnapshot();
  const cursor = existing.serverCursor;
  const path = cursor
    ? `${PURCHASE_ORDERS_PATH}?updated_since=${encodeURIComponent(cursor)}`
    : PURCHASE_ORDERS_PATH;

  let result: AdminFetchEnvelope | null = null;
  try {
    result = (await getBridge().adminApi.fetchFromAdmin(path, {
      method: 'GET',
    })) as AdminFetchEnvelope;
  } catch (error) {
    console.warn('[purchase-order-snapshot] Snapshot fetch failed:', error);
    return existing;
  }

  if (!result?.success || result.data?.success === false) {
    return existing;
  }

  const isCacheFallback = Boolean(result.meta?.offlineFallback);
  const purchaseOrders = sanitizePurchaseOrders(result.data?.purchaseOrders);
  const serverTime =
    typeof result.data?.serverTime === 'string' && result.data.serverTime.trim()
      ? result.data.serverTime
      : null;

  if (isCacheFallback) {
    // Served from the Rust admin-GET cache while offline: never advance
    // the cursor from stale data. Seed the local snapshot only when we
    // have nothing at all (e.g. localStorage cleared, cache retained).
    if (existing.purchaseOrders.length > 0 || existing.fetchedAt) {
      return existing;
    }
    return publishSnapshot({
      purchaseOrders: sortByCreatedAtDesc(purchaseOrders),
      serverCursor: null,
      fetchedAt: result.meta?.cachedAt ?? null,
    });
  }

  const merged = cursor
    ? mergeDeltaIntoSnapshot(existing.purchaseOrders, purchaseOrders)
    : sortByCreatedAtDesc(pruneExpiredClosed(purchaseOrders));

  return publishSnapshot({
    purchaseOrders: merged,
    // serverTime is captured server-side BEFORE the query, so advancing
    // to it can never skip a row updated mid-response (gte re-delivery
    // is harmless — merges upsert by id).
    serverCursor: serverTime ?? cursor,
    fetchedAt: new Date().toISOString(),
  });
}

/** Test-only helper: wipe the persisted snapshot. */
export function clearPurchaseOrderSnapshotForTests(): void {
  getStorage()?.removeItem(SNAPSHOT_STORAGE_KEY);
}
