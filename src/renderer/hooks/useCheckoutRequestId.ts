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
  const take = useCallback((persistedId?: string): string => {
    if (persistedId) {
      if (idRef.current && idRef.current !== persistedId) throw new Error('CHECKOUT_REQUEST_ID_CHANGED');
      idRef.current = persistedId;
    }
    if (!idRef.current) {
      idRef.current = newCheckoutRequestId();
    }
    return idRef.current;
  }, []);
  const reset = useCallback(() => {
    idRef.current = null;
  }, []);
  const restore = useCallback((persistedId: string) => {
    if (!persistedId.trim()) throw new Error('CHECKOUT_REQUEST_ID_REQUIRED');
    idRef.current = persistedId;
  }, []);
  return { take, reset, restore };
}

export default useCheckoutRequestId;
