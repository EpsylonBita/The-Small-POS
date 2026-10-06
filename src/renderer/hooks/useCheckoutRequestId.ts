import { useCallback, useRef } from 'react';

const newCheckoutRequestId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `order-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * The client request id of the checkout on screen (fix review 30/09/2026).
 *
 * Every press of Pay for the same cart reuses it until the checkout ends (the
 * order is created, or a charge is held as not saved) or the cart is left.
 * The till deduplicates orders and card approvals by it and refuses a second
 * press while the first still waits on the card terminal, so pressing Pay
 * again after a slow terminal checks the same payment and never charges
 * twice. A new id used to be drawn for every press: after the screen gave up
 * on a slow terminal, the next press started a second checkout and a second
 * charge.
 */
export function useCheckoutRequestId() {
  const idRef = useRef<string | null>(null);
  const protectedRef = useRef(false);
  const take = useCallback((persistedId?: string): string => {
    if (persistedId) {
      if (idRef.current && idRef.current !== persistedId) throw new Error('CHECKOUT_REQUEST_ID_CHANGED');
      idRef.current = persistedId;
    }
    if (!idRef.current) {
      idRef.current = newCheckoutRequestId();
    }
    protectedRef.current = true;
    return idRef.current;
  }, []);
  const reset = useCallback(() => {
    idRef.current = null;
    protectedRef.current = false;
  }, []);
  const restore = useCallback((persistedId: string, draft?: { phase?: string; editMode?: boolean; renewedFrom?: string }) => {
    if (!persistedId.trim()) throw new Error('CHECKOUT_REQUEST_ID_REQUIRED');
    // An existing-order edit has its own durable event and never owns the
    // next create request. Its pending money remains in the edit journal.
    if (draft?.editMode) return;
    // Only the successful native declined-attempt CAS may replace a protected
    // identity. This proof is supplied by its live callback, never draft JSON.
    const renewed = draft?.phase === 'editing' && !!draft.renewedFrom &&
      draft.renewedFrom === idRef.current && persistedId !== idRef.current;
    if (draft?.renewedFrom && !renewed) throw new Error('CHECKOUT_REQUEST_ID_CHANGED');
    if (idRef.current && idRef.current !== persistedId && !renewed) throw new Error('CHECKOUT_REQUEST_ID_CHANGED');
    idRef.current = persistedId;
    if (renewed) protectedRef.current = false;
    // Missing phase keeps the original conservative restore contract. A stale
    // editable render must never downgrade an already submitted identity.
    protectedRef.current ||= draft?.phase !== 'editing';
  }, []);
  const dismiss = useCallback(() => {
    if (!protectedRef.current) idRef.current = null;
  }, []);
  return { take, reset, restore, dismiss };
}

export default useCheckoutRequestId;
