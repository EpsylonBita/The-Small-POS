/**
 * Queued goods-receipt inspection for the POS procurement surface
 * (procurement-loop Task 10.4).
 *
 * The offline `po_receipts` parity queue rows ARE the pending-sync
 * overlay's source of truth: a receipt captured offline renders
 * immediately on the PO detail as an optimistic "pending sync" entry
 * whose quantities adjust the remaining totals locally, and replay
 * outcomes surface through the row's state:
 *
 * - `pending`/`processing`            → optimistic overlay entry
 * - `pending` + MODULE_REQUIRED park  → retained, labeled parked [R11.6]
 * - `conflict` (409 PO_STATE_CONFLICT)→ needs-attention card preserving
 *                                       the recorded quantities [R11.7]
 * - `failed`                          → needs-attention card (dead-letter)
 *
 * Successful replay removes the row; the parity cycle then refreshes the
 * PO snapshot, clearing the overlay into fresh server state. [R11.1]
 */

import { getSyncQueueBridge } from './SyncQueueBridge';
import type { SyncQueueItem } from '../../../../shared/pos/sync-queue-types';
import type { PosPurchaseOrder } from './purchase-order-snapshot';

export type QueuedPoReceiptState = 'pending' | 'parked' | 'conflict' | 'failed';

export interface QueuedPoReceiptLine {
  purchaseOrderItemId: string | null;
  quantityReceived: number;
  unitCost: number | null;
  isUnplanned: boolean;
}

export interface QueuedPoReceipt {
  queueId: string;
  idempotencyKey: string;
  purchaseOrderId: string;
  recordedAt: string | null;
  notes: string | null;
  state: QueuedPoReceiptState;
  errorMessage: string | null;
  lines: QueuedPoReceiptLine[];
}

/**
 * Classify a queue row into its overlay state. MODULE_REQUIRED parks
 * leave the row `pending` on the slow probe cadence with the reason in
 * `error_message` (see sync_queue `mark_module_required`), so parking is
 * detected from the message, not the status.
 */
export function classifyQueuedReceiptState(
  status: string | null | undefined,
  errorMessage: string | null | undefined,
): QueuedPoReceiptState {
  if (status === 'conflict') {
    return 'conflict';
  }
  if (status === 'failed') {
    return 'failed';
  }
  if (typeof errorMessage === 'string' && errorMessage.includes('MODULE_REQUIRED')) {
    return 'parked';
  }
  return 'pending';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/** Parse one parity queue row into a typed queued receipt (null when not a po_receipts row). */
export function parseQueuedPoReceipt(item: SyncQueueItem): QueuedPoReceipt | null {
  if (item.tableName !== 'po_receipts') {
    return null;
  }

  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(item.data);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt payloads still surface (as needs-attention) rather than vanish.
  }

  const purchaseOrderId = readString(payload, 'purchase_order_id', 'purchaseOrderId');
  if (!purchaseOrderId) {
    return null;
  }

  const rawLines = Array.isArray(payload.lines) ? payload.lines : [];
  const lines: QueuedPoReceiptLine[] = rawLines
    .filter((line): line is Record<string, unknown> => !!line && typeof line === 'object')
    .map((line) => ({
      purchaseOrderItemId:
        readString(line, 'purchaseOrderItemId', 'purchase_order_item_id') ?? null,
      quantityReceived: toNumber(line.quantityReceived ?? line.quantity_received),
      unitCost:
        line.unitCost === undefined && line.unit_cost === undefined
          ? null
          : toNumber(line.unitCost ?? line.unit_cost),
      isUnplanned: Boolean(line.unplanned) || Boolean(line.isUnplanned),
    }));

  return {
    queueId: item.id,
    idempotencyKey:
      readString(payload, 'idempotency_key', 'idempotencyKey') ?? item.recordId,
    purchaseOrderId,
    recordedAt: readString(payload, 'recorded_at', 'recordedAt'),
    notes: readString(payload, 'notes'),
    state: classifyQueuedReceiptState(item.status, item.errorMessage ?? null),
    errorMessage: item.errorMessage ?? null,
    lines,
  };
}

/** List every actionable queued receipt (pending, parked, conflicted, failed). */
export async function listQueuedPoReceipts(): Promise<QueuedPoReceipt[]> {
  const items = await getSyncQueueBridge().listItems({ moduleType: 'suppliers' });
  return items
    .map((item) => parseQueuedPoReceipt(item))
    .filter((receipt): receipt is QueuedPoReceipt => receipt !== null);
}

/**
 * Optimistic overlay math: per PO item, the quantity still awaiting sync.
 * Only `pending` and `parked` receipts adjust remaining totals — a
 * conflicted or failed receipt was NOT applied server-side, so blending
 * it into the remaining quantity would misstate stock; its quantities
 * render on the needs-attention card instead. [R11.1, R11.7]
 */
export function pendingQuantitiesByItem(
  purchaseOrder: PosPurchaseOrder,
  receipts: QueuedPoReceipt[],
): Map<string, number> {
  const pending = new Map<string, number>();
  for (const receipt of receipts) {
    if (receipt.purchaseOrderId !== purchaseOrder.id) {
      continue;
    }
    if (receipt.state !== 'pending' && receipt.state !== 'parked') {
      continue;
    }
    for (const line of receipt.lines) {
      if (!line.purchaseOrderItemId) {
        continue;
      }
      pending.set(
        line.purchaseOrderItemId,
        (pending.get(line.purchaseOrderItemId) ?? 0) + line.quantityReceived,
      );
    }
  }
  return pending;
}

/** Re-run a queued receipt now (also the conflict card's retry action). */
export async function retryQueuedPoReceipt(queueId: string): Promise<void> {
  await getSyncQueueBridge().retryItem(queueId);
}
