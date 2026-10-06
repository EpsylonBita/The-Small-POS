import type { EditSettlementOrderUpdates, OrderFinancialsUpdateParams, OrderEditSettlementAction, OrderEditSettlementPreview, PlatformBridge } from '../../lib/ipc-adapter';
import { getEditSettlementItemsSubtotal } from '../utils/editSettlementFinancials';
import { roundMoney } from '@shared/utils/money';

export interface MenuEditHeaders {
  orderUpdates?: Partial<EditSettlementOrderUpdates>;
  deliveryFee?: number;
}

/** Staging is pure: selecting another type/address must never mutate the order. */
export function deriveMenuEditChanges(original: Record<string, any>, items: any[], orderType: 'pickup' | 'delivery' | 'dine-in', staged?: MenuEditHeaders) {
  const originalType = original.order_type ?? original.orderType;
  const orderUpdates: Partial<EditSettlementOrderUpdates> = { ...staged?.orderUpdates };
  if (orderType !== originalType) orderUpdates.orderType = orderType;
  const originalFee = Number(original.delivery_fee ?? original.deliveryFee ?? 0);
  const deliveryFee = orderType === 'delivery' ? staged?.deliveryFee ?? originalFee : 0;
  if (orderType !== 'delivery' && originalType === 'delivery') Object.assign(orderUpdates, {
    deliveryAddress: null, deliveryAddressId: null, deliveryCity: null, deliveryPostalCode: null,
    deliveryFloor: null, deliveryNotes: null, nameOnRinger: null, deliveryLatitude: null,
    deliveryLongitude: null, deliveryAddressFingerprint: null, deliveryZoneId: null,
    driverId: null, driverName: null,
  });
  if (orderType !== originalType && orderType !== 'dine-in') Object.assign(orderUpdates, { tableNumber: null, waiterId: null });
  const originalItems = Array.isArray(original.items) ? original.items : [];
  const total = roundMoney(Math.max(0, getEditSettlementItemsSubtotal(items) +
    Number(original.total_amount ?? original.totalAmount ?? getEditSettlementItemsSubtotal(originalItems)) -
    getEditSettlementItemsSubtotal(originalItems) - originalFee + deliveryFee));
  return { orderUpdates, financials: { totalAmount: total, deliveryFee }, total };
}

export interface MenuOrderEditData {
  orderId: string;
  client_event_id?: string;
  /**
   * A re-quote after a confirmed edit was proven never applied (fix 4): the
   * new event replaces that attempt once it is applied, so the money it
   * declared is recorded exactly once.
   */
  supersedes_client_event_id?: string;
  expected_version?: number;
  expected_local_version?: number;
  renderer_local_version?: number;
  items: any[];
  total: number;
  orderType?: string;
  notes?: string;
  orderUpdates?: Partial<EditSettlementOrderUpdates>;
  financials?: Partial<OrderFinancialsUpdateParams>;
  action?: string;
  settlementAction?: OrderEditSettlementAction;
  settlementRequest?: MenuEditSettlementRequest;
}

export interface MenuOrderEditLifecycle {
  beforeCommit(submission: Record<string, unknown>): Promise<void>;
}

export type MenuEditSettlementRequest = Parameters<PlatformBridge['orders']['applyEditSettlement']>[0];
export type MenuEditSettlementMethod = 'cash' | 'card';
export type MenuEditPreflight = { financials?: Partial<OrderFinancialsUpdateParams>; kind: 'ordinary' | 'metadata' | 'settlement'; requiredAction?: 'none' | 'collect' | 'refund'; canonicalExpectedVersion?: number; localExpectedVersion?: number;
  /** Tenders this terminal may record for the difference (server method_policy). */
  allowedMethods?: MenuEditSettlementMethod[];
  /** The order PATCH line limit (server max_lines). */
  maxLines?: number };

/** The order PATCH accepts at most this many lines (the quote accepts 500). */
export const MENU_EDIT_MAX_LINES = 50;

function settlementPolicy(preview: unknown): Pick<MenuEditPreflight, 'allowedMethods' | 'maxLines'> {
  const source = (preview ?? {}) as { allowedMethods?: unknown; maxLines?: unknown };
  const allowedMethods = Array.isArray(source.allowedMethods)
    ? source.allowedMethods.filter((method): method is MenuEditSettlementMethod => method === 'cash' || method === 'card')
    : undefined;
  const maxLines = Number.isSafeInteger(source.maxLines) && Number(source.maxLines) > 0 ? Number(source.maxLines) : undefined;
  return { ...(allowedMethods ? { allowedMethods } : {}), ...(maxLines ? { maxLines } : {}) };
}

export function menuEditRefundAction(preview: OrderEditSettlementPreview, amount: number, method: 'cash' | 'card', reason: string,
  attribution: { staffId?: string; staffShiftId?: string } = {}): OrderEditSettlementAction {
  let remaining = Math.round(amount * 100);
  const refunds: Extract<OrderEditSettlementAction, { type: 'refund' }>['refunds'] = [];
  const originals = preview.completedPayments.filter(payment => !payment.platformSettlement && ['cash', 'card'].includes(payment.method))
    .slice().sort((left, right) => Number(right.method === method) - Number(left.method === method));
  for (const original of originals) {
    const cents = Math.min(remaining, Math.max(0, Math.round(original.remainingRefundable * 100)));
    if (cents > 0) refunds.push({ paymentId: original.id, amount: cents / 100, refundMethod: method, reason, ...attribution });
    remaining -= cents;
    if (remaining === 0) break;
  }
  if (remaining !== 0 || refunds.length === 0) throw new Error('REFUND_NO_ELIGIBLE_PAYMENT');
  return { type: 'refund', refunds };
}

export function menuEditRequest(data: MenuOrderEditData): Omit<MenuEditSettlementRequest, 'action'> {
  if (!data.client_event_id || !Number.isInteger(data.expected_version) || Number(data.expected_version) < 1) {
    throw new Error('CHECKOUT_DRAFT_EDIT_VERSION_REQUIRED');
  }
  return { orderId: data.orderId, items: data.items, orderNotes: data.notes,
    orderUpdates: data.orderUpdates, financials: data.financials,
    client_event_id: data.client_event_id, expected_version: data.expected_version,
    ...(data.expected_local_version === undefined ? {} : { expected_local_version: data.expected_local_version }),
    ...(data.supersedes_client_event_id ? { supersedes_client_event_id: data.supersedes_client_event_id } : {}) };
}

export async function previewMenuOrderEdit(
  orders: PlatformBridge['orders'], data: MenuOrderEditData,
  sync?: Pick<PlatformBridge['sync'], 'force'> & Partial<Pick<PlatformBridge['sync'], 'getStatus'>>,
): Promise<{ preflight: MenuEditPreflight; preview: OrderEditSettlementPreview }> {
  try {
    return await previewMenuOrderEditOnce(orders, data);
  } catch (error) {
    if (!sync || data.action === 'edit_settlement' || !isPendingEditSync(error)) throw error;
    let pendingError = error;
    const deadline = Date.now() + 12_000;
    const withinDeadline = async <T>(operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(pendingError), Math.max(0, deadline - Date.now()));
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    // A tender correction has already been recorded locally. Flush its owned
    // queue; only a fresh successful preview proves this order is ready.
    // Other queued work may fail even when this original receipt has synced.
    await withinDeadline(sync.force().catch(() => undefined));
    let syncPasses = 1;
    while (Date.now() < deadline) {
      try {
        return await withinDeadline(previewMenuOrderEditOnce(orders, data));
      } catch (nextError) {
        if (!isPendingEditSync(nextError)) throw nextError;
        pendingError = nextError;
      }
      if (Date.now() >= deadline) break;
      // Payment ACK happens after the incoming-order pull. One follow-up pass
      // brings that acknowledged order snapshot forward without waiting15s.
      if (syncPasses < 2) {
        // A background cycle may already own the payment row. Do not spend
        // the follow-up while it is still processing that receipt.
        while (sync.getStatus && Date.now() < deadline) {
          const status = await withinDeadline(sync.getStatus().catch(() => null));
          if (status?.syncInProgress !== true) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
        }
        if (Date.now() >= deadline) break;
        syncPasses += 1;
        await withinDeadline(sync.force().catch(() => undefined));
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    }
    throw pendingError;
  }
}

function isPendingEditSync(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bEDIT_(?:ORIGINAL_PAYMENT|PREVIOUS_SETTLEMENT)_SYNC_REQUIRED\b/.test(message);
}

async function previewMenuOrderEditOnce(
  orders: PlatformBridge['orders'], data: MenuOrderEditData,
): Promise<{ preflight: MenuEditPreflight; preview: OrderEditSettlementPreview }> {
  const request = menuEditRequest(data);
  // Read the canonical money picture first. Unpaid full-check edits keep the
  // existing versioned updateItems route, including its table ownership guard.
  const preview = await orders.previewEditSettlement({ orderId: request.orderId, items: request.items, orderNotes: request.orderNotes,
    orderUpdates: request.orderUpdates, financials: request.financials });
  if (preview.success !== true) throw new Error('EDIT_SETTLEMENT_PREVIEW_FAILED');
  if (preview.metadataOnly === true) {
    // Verify the original header revision before the menu freezes its cart.
    const scoped = await orders.previewEditSettlement({ ...request, expectedLocalVersion: data.renderer_local_version });
    if (scoped.success !== true || scoped.metadataOnly !== true) throw new Error('EDIT_CANONICAL_ORIGINAL_CHANGED');
    return { preflight: { kind: 'metadata' }, preview: scoped };
  }
  const paid = preview.paidTotal > 0 || preview.completedPayments.length > 0 ||
    ['paid', 'completed', 'partial', 'partially_paid'].includes(preview.paymentStatus);
  if (!paid) return { preflight: { kind: 'ordinary' }, preview };
  // Version/paid-line/shared-check validation happens before any confirmation.
  const scoped = await orders.previewEditSettlement(request);
  if (scoped.success !== true) throw new Error('EDIT_SETTLEMENT_PREVIEW_FAILED');
  if (!Number.isInteger(scoped.canonicalExpectedVersion) || Number(scoped.canonicalExpectedVersion) < 1 ||
      !Number.isInteger(scoped.localExpectedVersion) || Number(scoped.localExpectedVersion) < 1) {
    throw new Error('EDIT_CANONICAL_PREFLIGHT_REQUIRED');
  }
  if (!scoped.quotedFinancials?.quote || typeof scoped.quotedFinancials.totalAmount !== 'number') throw new Error('EDIT_CANONICAL_QUOTE_REQUIRED');
  if (data.financials?.quote && JSON.stringify(data.financials) !== JSON.stringify(scoped.quotedFinancials)) throw new Error('EDIT_CANONICAL_QUOTE_CHANGED');
  // A second preview may refresh the proof, but cannot silently change an
  // already approved cart revision. This still happens before its picker.
  if (data.expected_local_version !== undefined && (data.expected_local_version !== scoped.localExpectedVersion ||
      data.expected_version !== scoped.canonicalExpectedVersion)) throw new Error('EDIT_SETTLEMENT_VERSION_CHANGED');
  return { preflight: { kind: 'settlement', financials: scoped.quotedFinancials, requiredAction: scoped.requiredAction,
    canonicalExpectedVersion: scoped.canonicalExpectedVersion, localExpectedVersion: scoped.localExpectedVersion,
    ...settlementPolicy(scoped) }, preview: scoped };
}

export async function commitMenuOrderEdit(
  orders: PlatformBridge['orders'], data: MenuOrderEditData, action: OrderEditSettlementAction,
  lifecycle?: MenuOrderEditLifecycle,
): Promise<void> {
  const request = data.action === 'edit_settlement' ? data.settlementRequest : { ...menuEditRequest(data), action };
  if (!request || request.client_event_id !== data.client_event_id || request.orderId !== data.orderId ||
      request.expected_version !== data.expected_version || request.expected_local_version !== data.expected_local_version) throw new Error('RECOVERY_ORIGINAL_REQUEST_REQUIRED');
  if (data.action !== 'edit_settlement') {
    if (!Number.isInteger(data.expected_local_version) || Number(data.expected_local_version) < 1) throw new Error('EDIT_CANONICAL_PREFLIGHT_REQUIRED');
    if (!lifecycle) throw new Error('CHECKOUT_DRAFT_EDIT_FREEZE_REQUIRED');
    await lifecycle.beforeCommit({ ...data, ...request, action: 'edit_settlement', settlementAction: request.action, settlementRequest: request });
  }
  const response = await orders.applyEditSettlement(request);
  // A fulfilled IPC is not automatically a committed edit. Rollback also
  // retains the confirmed manual tender: it does not prove physical no-money.
  if (response?.success !== true) {
    const reply = response as { error?: string; code?: string };
    throw new Error(reply?.error || reply?.code || 'EDIT_SETTLEMENT_OUTCOME_UNKNOWN');
  }
}
