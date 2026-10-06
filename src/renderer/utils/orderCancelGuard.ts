import { getBridge } from '../../lib';

/** The till's refusal to cancel an order money was taken on. */
export const ORDER_HAS_PAYMENTS = 'ORDER_HAS_PAYMENTS';

/**
 * The till's refusal to cancel an order labelled paid whose payment is not
 * recorded on this till (founder rule 30/09 and 01/10/2026: an order is never
 * paid without its payment record). The record comes first: restored from the
 * server (Sync Now) or recorded from the Z report; never charged again.
 */
export const ORDER_PAYMENT_NOT_RECORDED = 'ORDER_PAYMENT_NOT_RECORDED';

export type OrderCancelRefusalCode = typeof ORDER_HAS_PAYMENTS | typeof ORDER_PAYMENT_NOT_RECORDED;

export interface OrderCancelRefusals {
  /** Money was taken on them: void or refund it first, or collect the rest. */
  hasPayments: string[];
  /** Labelled paid with no payment record here: restore or record it first. */
  notRecorded: string[];
}

/** The refusal code a till error carries, if any. */
export function cancelRefusalCodeFromError(errorText: string): OrderCancelRefusalCode | null {
  if (errorText.includes(ORDER_PAYMENT_NOT_RECORDED)) return ORDER_PAYMENT_NOT_RECORDED;
  if (errorText.includes('STAFF_CASH_RETURN_REQUIRED')) return ORDER_HAS_PAYMENTS;
  if (errorText.includes(ORDER_HAS_PAYMENTS)) return ORDER_HAS_PAYMENTS;
  return null;
}

/**
 * The refusal a settlement snapshot names. The till names it in
 * `cancelRefusal` (null: it may be cancelled, a platform order whose
 * settlement row `netPaid` still counts included); a snapshot without the
 * field (an older till, or a ledger the till could not read) falls back to
 * the money taken on the order.
 */
export function cancelRefusalFromSnapshot(snapshot: unknown): OrderCancelRefusalCode | null {
  const record = (snapshot ?? {}) as { cancelRefusal?: unknown; netPaid?: unknown };
  if (Object.prototype.hasOwnProperty.call(record, 'cancelRefusal')) {
    if (record.cancelRefusal === ORDER_PAYMENT_NOT_RECORDED) return ORDER_PAYMENT_NOT_RECORDED;
    if (record.cancelRefusal === 'STAFF_CASH_RETURN_REQUIRED') return ORDER_HAS_PAYMENTS;
    if (record.cancelRefusal === ORDER_HAS_PAYMENTS) return ORDER_HAS_PAYMENTS;
    if (record.cancelRefusal === null) return null;
  }
  const netPaid = Number(record.netPaid);
  return Number.isFinite(netPaid) && netPaid > 0.009 ? ORDER_HAS_PAYMENTS : null;
}

/**
 * Which of `orderIds` the till refuses to cancel, and why (fix review
 * 30/09/2026 and 01/10/2026, founder rule). Asked before the cancel reason,
 * so the cashier is told at once; the till refuses the cancel itself too, so
 * an order whose ledger cannot be read here is left to it. The till names the
 * refusal in the settlement snapshot (`cancelRefusal`, see
 * [cancelRefusalFromSnapshot]).
 */
export async function findCancelRefusals(orderIds: readonly string[]): Promise<OrderCancelRefusals> {
  const bridge = getBridge();
  const refusals: OrderCancelRefusals = { hasPayments: [], notRecorded: [] };
  for (const orderId of orderIds) {
    try {
      const snapshot = await bridge.payments.getSettlementSnapshot(orderId);
      const refusal = cancelRefusalFromSnapshot(snapshot);
      if (refusal === ORDER_PAYMENT_NOT_RECORDED) {
        refusals.notRecorded.push(orderId);
      } else if (refusal === ORDER_HAS_PAYMENTS) {
        refusals.hasPayments.push(orderId);
      }
    } catch (error) {
      console.warn('[orderCancelGuard] Reading the order payments failed:', error);
    }
  }
  return refusals;
}

/**
 * The orders among `orderIds` that money was taken on (fix review 30/09/2026,
 * founder rule). Such an order is never cancelled: its payment is voided or
 * refunded from the order first, or the rest is collected.
 */
export async function findOrdersWithMoneyTaken(orderIds: readonly string[]): Promise<string[]> {
  return (await findCancelRefusals(orderIds)).hasPayments;
}
