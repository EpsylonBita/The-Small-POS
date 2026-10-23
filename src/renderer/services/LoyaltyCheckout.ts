import type { IpcResult } from '../../lib/ipc-adapter';
import { isCheckoutOutcomeUnknown } from '../utils/checkoutOutcome';
import { resolvePersistedCustomerId } from '../utils/persisted-customer-id';

type LoyaltyCheckoutBridge = {
  redeemPoints(opts: { customerId: string; points: number; orderId?: string; checkoutReservation?: boolean }): Promise<IpcResult>;
  releaseRedemption(opts: { orderId: string }): Promise<IpcResult>;
};

/**
 * Typed answers of native `loyalty_redeem_points` (Ω11, 22/10/2026): points
 * are redeemed only with a live server answer. Offline or refused, nothing was
 * debited and the sale continues without the discount. Unconfirmed, the
 * request was sent with no answer: the points stay on the sale until Retry
 * gets the server's answer or the cashier removes them.
 */
export const LOYALTY_REDEEM_OFFLINE = 'LOYALTY_REDEEM_OFFLINE';
export const LOYALTY_REDEEM_REFUSED = 'LOYALTY_REDEEM_REFUSED';
export const LOYALTY_REDEEM_UNCONFIRMED = 'LOYALTY_REDEEM_UNCONFIRMED';
/** Refusal reason: this checkout's points were released; a new sale can redeem. */
export const LOYALTY_REDEMPTION_RELEASED = 'LOYALTY_REDEMPTION_RELEASED';

/** The points were not secured and nothing is held for them. */
export class LoyaltyCheckoutRefused extends Error {
  constructor(readonly code?: string, readonly reason?: string) {
    super(code || 'LOYALTY_CHECKOUT_REFUSED');
  }
}

/** Sent without a definitive answer: the redemption stays, nothing is released. */
export class LoyaltyRedemptionUnconfirmed extends Error {
  constructor() {
    super(LOYALTY_REDEEM_UNCONFIRMED);
  }
}

/** The message key for a refused or unconfirmed redemption, else null. */
export function loyaltyCheckoutMessageKey(error: unknown): string | null {
  if (error instanceof LoyaltyRedemptionUnconfirmed) return 'loyalty.redeem.confirmationRequired';
  if (!(error instanceof LoyaltyCheckoutRefused)) return null;
  if (error.code === LOYALTY_REDEEM_OFFLINE) return 'loyalty.redeem.offlineRefused';
  if (error.reason === LOYALTY_REDEMPTION_RELEASED) return 'loyalty.redeem.releasedForCheckout';
  if (error.code === LOYALTY_REDEEM_REFUSED) return 'loyalty.redeem.refusedBody';
  return null;
}

export async function secureLoyaltyCheckout(
  order: { clientRequestId: string; customer_id?: unknown; customerId?: unknown },
  redemption: { customer_id?: unknown; points_redeemed?: unknown } | null,
  loyalty: LoyaltyCheckoutBridge,
): Promise<void> {
  if (!redemption) return;
  const customerId = resolvePersistedCustomerId(redemption.customer_id, order.customer_id, order.customerId);
  const points = Math.max(0, Math.trunc(Number(redemption.points_redeemed || 0)));
  if (!customerId || points <= 0) throw new LoyaltyCheckoutRefused();
  let secured: (IpcResult & { reason?: unknown }) | null = null;
  try {
    secured = await loyalty.redeemPoints({ customerId, points, orderId: order.clientRequestId, checkoutReservation: true });
  } catch {
    secured = null;
  }
  if (secured?.success === true) return;
  // The server may hold the debit: keep it under this checkout for Retry.
  if (secured?.errorCode === LOYALTY_REDEEM_UNCONFIRMED) throw new LoyaltyRedemptionUnconfirmed();
  const released = await loyalty.releaseRedemption({ orderId: order.clientRequestId });
  if (released?.success !== true) throw new Error('LOYALTY_RELEASE_NOT_CONFIRMED');
  throw new LoyaltyCheckoutRefused(
    typeof secured?.errorCode === 'string' ? secured.errorCode : undefined,
    typeof secured?.reason === 'string' ? secured.reason : undefined,
  );
}

// Keep the same identity through a lost save acknowledgement or payment recovery.
export async function saveOrderWithLoyalty<T extends { success: boolean; paymentNotSaved?: boolean }>(
  order: { clientRequestId: string; customer_id?: unknown; customerId?: unknown },
  redemption: { customer_id?: unknown; points_redeemed?: unknown } | null,
  loyalty: LoyaltyCheckoutBridge,
  save: () => Promise<T>,
  admission: { redemptionSecured?: boolean; receiptConfirmed?: boolean } = {},
): Promise<T> {
  if (!admission.redemptionSecured) await secureLoyaltyCheckout(order, redemption, loyalty);
  if (!redemption) return save();

  // A thrown save has no definitive outcome. Leave its debit with the original
  // checkout; retry secures that same transaction rather than spending twice.
  const result = await save();
  if (!admission.redemptionSecured && !admission.receiptConfirmed && !result.success && !result.paymentNotSaved && !isCheckoutOutcomeUnknown(result)) {
    const released = await loyalty.releaseRedemption({ orderId: order.clientRequestId });
    if (released?.success !== true) throw new Error('LOYALTY_RELEASE_NOT_CONFIRMED');
  }
  return result;
}
