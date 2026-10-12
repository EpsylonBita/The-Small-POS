import type { CheckoutDraft } from '../services/CheckoutDraftStore';

/** A retained edit stays in recovery until the operator explicitly reviews it. */
export function shouldAutomaticallyRestoreCheckoutDraft(saved: CheckoutDraft | null): boolean {
  return Boolean(saved && (saved.cartItems.length || saved.phase === 'checkout_pending') &&
    !(saved.context.editMode === true && saved.phase === 'checkout_pending'));
}

export function selectRetainedCheckoutEdit(saved: CheckoutDraft | null, clientEventId: string): CheckoutDraft | null {
  if (!saved || !clientEventId || saved.checkoutRequestId !== clientEventId || saved.context.editMode !== true ||
      !['pickup', 'delivery', 'dine-in'].includes(saved.context.orderType)) return null;
  return saved;
}
