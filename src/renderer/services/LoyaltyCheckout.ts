import type { IpcResult } from '../../lib/ipc-adapter';
import { isCheckoutOutcomeUnknown } from '../utils/checkoutOutcome';
import { resolvePersistedCustomerId } from '../utils/persisted-customer-id';

type LoyaltyCheckoutBridge = {
  redeemPoints(opts: { customerId: string; points: number; orderId?: string; checkoutReservation?: boolean }): Promise<IpcResult>;
  releaseRedemption(opts: { orderId: string }): Promise<IpcResult>;
};

export class LoyaltyCheckoutRefused extends Error {}

export async function secureLoyaltyCheckout(
  order: { clientRequestId: string; customer_id?: unknown; customerId?: unknown },
  redemption: { customer_id?: unknown; points_redeemed?: unknown } | null,
  loyalty: LoyaltyCheckoutBridge,
): Promise<void> {
  if (!redemption) return;
  const customerId = resolvePersistedCustomerId(redemption.customer_id, order.customer_id, order.customerId);
  const points = Math.max(0, Math.trunc(Number(redemption.points_redeemed || 0)));
  if (!customerId || points <= 0) throw new LoyaltyCheckoutRefused();
  try {
    const secured = await loyalty.redeemPoints({ customerId, points, orderId: order.clientRequestId, checkoutReservation: true });
    if (secured?.success !== true) throw new LoyaltyCheckoutRefused();
  } catch {
    const released = await loyalty.releaseRedemption({ orderId: order.clientRequestId });
    if (released?.success !== true) throw new Error('LOYALTY_RELEASE_NOT_CONFIRMED');
    throw new LoyaltyCheckoutRefused();
  }
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
