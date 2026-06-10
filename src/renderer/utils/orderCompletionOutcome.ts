export interface OrderCompletionInput {
  /** Did the completion flow run to the end without a failure? */
  succeeded: boolean;
  /**
   * Did createOrder persist the order (locally or queued offline) before the
   * failure? Stays false for pre-create validation errors, createOrder
   * returning success:false (timeout, offline saveForRetry also failing), and
   * exceptions thrown before the create resolved.
   */
  orderPersisted: boolean;
}

export interface OrderCompletionOutcome {
  /**
   * Handed back to MenuModal/PaymentModal as the onOrderComplete result.
   * `false` aborts their success path: the cart is kept and no success toast
   * fires, so staff can retry or change payment method without re-keying.
   */
  completionResult: boolean;
  /**
   * Whether the order-taking UI may be torn down (close MenuModal, clear
   * customer/table/order-type state). Must stay false while the order was
   * never persisted, so the keyed-in order survives for a retry.
   */
  resetOrderUiState: boolean;
}

/**
 * Decides what happens to the order-taking UI after a checkout attempt.
 *
 * Duplicate protection outranks retry convenience: once createOrder has
 * persisted the order, the UI finalizes even when a follow-up step failed —
 * retrying from a stale cart would create the order twice. Only a genuinely
 * unpersisted order keeps the modal open with the cart intact.
 */
export function resolveOrderCompletionOutcome(
  input: OrderCompletionInput,
): OrderCompletionOutcome {
  const finalize = input.succeeded || input.orderPersisted;
  return { completionResult: finalize, resetOrderUiState: finalize };
}
