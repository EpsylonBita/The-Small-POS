export interface SplitOrderFinancials {
  totalAmount: number;
  subtotal: number;
  discountAmount: number;
  discountPercentage: number;
  taxAmount: number;
  deliveryFee: number;
  tipAmount: number;
}

export interface SettlementPortion {
  id: string;
  discountAmount: number;
}

export interface TerminalSettlementEffects {
  /** Charge the card on the terminal. Must throw when the payment is declined. */
  processPayment(): Promise<{ transactionId: string }>;
  /** Record the approved payment locally. Resolves with the paymentId. */
  recordPayment(transactionId: string): Promise<string>;
  /** Persist the absolute financial state (bridge.orders.updateFinancials + local state). */
  persistFinancials(next: SplitOrderFinancials): Promise<void>;
}

export interface TerminalSettlementResult {
  financials: SplitOrderFinancials;
  paymentId: string;
  transactionId: string;
  discountPersistFailed: boolean;
}

export interface DraftSettlementEffects<P extends SettlementPortion> {
  recordPayment(portion: P): Promise<string>;
  persistFinancials(next: SplitOrderFinancials): Promise<void>;
  onPortionSettled?(portion: P, paymentId: string): void | Promise<void>;
}

export interface DraftSettlementResult {
  financials: SplitOrderFinancials;
  paymentIds: string[];
  settledPortionIds: string[];
  discountPersistFailures: string[];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Compute the financial state after granting an additional split discount.
 * Returns null when the delta is below one cent — callers skip the DB write
 * entirely for undiscounted portions.
 */
export const applyAdditionalDiscount = (
  current: SplitOrderFinancials,
  discountDelta: number,
): SplitOrderFinancials | null => {
  const delta = round2(discountDelta);
  if (delta <= 0.009) return null;
  return {
    ...current,
    totalAmount: round2(Math.max(0, current.totalAmount - delta)),
    discountAmount: round2(current.discountAmount + delta),
  };
};

/**
 * Money-integrity contract: a portion's discount is persisted to the order
 * exactly once, and only after its payment succeeds. A declined charge or a
 * failed record leaves order financials untouched, so retrying the portion
 * can never re-apply the discount. The payment is recorded before the
 * discount write so the rare failure between the two leaves a visibly
 * underpaid order (loud) instead of a silently shrunken total.
 */
export async function settleTerminalPortion(
  financials: SplitOrderFinancials,
  portion: SettlementPortion,
  effects: TerminalSettlementEffects,
): Promise<TerminalSettlementResult> {
  const { transactionId } = await effects.processPayment();
  const paymentId = await effects.recordPayment(transactionId);
  const next = applyAdditionalDiscount(financials, portion.discountAmount);
  let current = financials;
  let discountPersistFailed = false;
  if (next) {
    try {
      await effects.persistFinancials(next);
      current = next;
    } catch {
      discountPersistFailed = true;
    }
  }
  return { financials: current, paymentId, transactionId, discountPersistFailed };
}

/**
 * Settles draft portions one at a time, persisting each portion's discount
 * only after that portion's payment is recorded. A mid-loop record failure
 * aborts the loop: already-settled portions keep their persisted discounts,
 * unsettled portions keep theirs unpersisted, so a follow-up confirm applies
 * each discount exactly once.
 */
export async function settleDraftPortions<P extends SettlementPortion>(
  financials: SplitOrderFinancials,
  portions: P[],
  effects: DraftSettlementEffects<P>,
): Promise<DraftSettlementResult> {
  let current = financials;
  const paymentIds: string[] = [];
  const settledPortionIds: string[] = [];
  const discountPersistFailures: string[] = [];
  for (const portion of portions) {
    const paymentId = await effects.recordPayment(portion);
    paymentIds.push(paymentId);
    settledPortionIds.push(portion.id);
    const next = applyAdditionalDiscount(current, portion.discountAmount);
    if (next) {
      try {
        await effects.persistFinancials(next);
        current = next;
      } catch {
        discountPersistFailures.push(portion.id);
      }
    }
    await effects.onPortionSettled?.(portion, paymentId);
  }
  return { financials: current, paymentIds, settledPortionIds, discountPersistFailures };
}
