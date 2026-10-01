import { roundMoney } from '@shared/utils/money';

export type PersistedSplitDismissalKind = 'unpaid' | 'partial' | 'settled';

export interface PersistedSplitDismissalResolution {
  kind: PersistedSplitDismissalKind;
  orderTotal: number;
  paidAmount: number;
  outstandingAmount: number;
  completedPayments: any[];
  /** Opaque native ledger generation; never render or reconstruct it. */
  settlementGeneration?: string;
}

/**
 * Raw facts of the write reply. A readable ledger never replaces them: an
 * unpaid or partial snapshot cannot prove an approved or lost write unsent.
 */
export interface OutstandingPaymentAttemptFacts {
  /** False for a snapshot-only probe: nothing was written. */
  dispatched: boolean;
  /** The write threw or answered unreadably; it may still have committed. */
  replyLost: boolean;
  success: boolean | null;
  paymentApproved: boolean | null;
  paymentPersisted: boolean | null;
  requiresReconciliation: boolean | null;
  paymentId: string | null;
  code: string | null;
  /** Native fiscal checkout state, passed through untouched. */
  fiscalCheckout: unknown;
  /**
   * The native answer itself when it set the money aside for review
   * (`PAYMENT_SET_ASIDE_FOR_REVIEW`, 30/09/2026), passed through untouched so
   * the caller can say what was set aside. Absent otherwise.
   */
  setAsideAnswer?: unknown;
}

export type OutstandingPaymentAttemptReconciliation =
  | {
      kind: PersistedSplitDismissalKind;
      recordPaymentFailed: boolean;
      attempt: OutstandingPaymentAttemptFacts;
      settlement: PersistedSplitDismissalResolution;
    }
  | {
      kind: 'unknown';
      recordPaymentFailed: boolean;
      attempt: OutstandingPaymentAttemptFacts;
    }
  | {
      /**
       * The card was charged but its payment is not saved on this till yet
       * (`PAYMENT_NOT_SAVED`), or the tender was refused because a charged
       * payment of the order is not saved (`PAYMENT_NOT_SAVED_PENDING`).
       * Never retried with a new key: its record holds the Z and "Save
       * payment again" replays it (fix review 30/09/2026).
       */
      kind: 'not_saved';
      recordPaymentFailed: true;
      result: unknown;
      /** The reply's raw facts, as every other outcome keeps them. */
      attempt: OutstandingPaymentAttemptFacts;
    };

const NOT_SAVED_ERROR_CODES = new Set(['PAYMENT_NOT_SAVED', 'PAYMENT_NOT_SAVED_PENDING']);

const isNotSavedAnswer = (result: unknown): boolean =>
  Boolean(
    result &&
      typeof result === 'object' &&
      NOT_SAVED_ERROR_CODES.has(String((result as { errorCode?: unknown }).errorCode ?? '')),
  );

const ATTEMPT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

const attemptFlag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const attemptText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const notDispatchedAttempt = (): OutstandingPaymentAttemptFacts => ({
  dispatched: false,
  replyLost: false,
  success: null,
  paymentApproved: null,
  paymentPersisted: null,
  requiresReconciliation: null,
  paymentId: null,
  code: null,
  fiscalCheckout: undefined,
});

const readAttemptFacts = (result: unknown, threw: boolean): OutstandingPaymentAttemptFacts => {
  const reply = !threw && result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
  if (!reply) return { ...notDispatchedAttempt(), dispatched: true, replyLost: true };
  const data = reply.data && typeof reply.data === 'object' ? (reply.data as Record<string, unknown>) : null;
  const code = [reply.errorCode, reply.code].map(attemptText).find((value) => ATTEMPT_CODE_PATTERN.test(value));
  return {
    dispatched: true,
    replyLost: false,
    success: attemptFlag(reply.success),
    paymentApproved: attemptFlag(reply.paymentApproved),
    paymentPersisted: attemptFlag(reply.paymentPersisted),
    requiresReconciliation: attemptFlag(reply.requiresReconciliation),
    paymentId: attemptText(reply.paymentId) || attemptText(data?.paymentId) || null,
    code: code ?? null,
    fiscalCheckout: reply.fiscalCheckout,
    ...(code === 'PAYMENT_SET_ASIDE_FOR_REVIEW' ? { setAsideAnswer: reply } : {}),
  };
};

interface NativeSettlementSnapshot {
  success: true;
  orderId: string;
  orderTotal: number;
  netPaid: number;
  outstandingAmount: number;
  completedPayments: any[];
  generation: string;
}

interface PersistedSplitDismissalInput {
  fallbackOrderTotal: number;
  order?: any;
  paymentsResult?: any;
}

// Module audit closure (2026-09-16): one rounding rule for the renderer.

const readMoney = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const amount = Number(value);
    if (Number.isFinite(amount) && amount >= 0) {
      return roundMoney(amount);
    }
  }
  return null;
};

const unwrapPayments = (result: any): any[] => {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.payments)) return result.payments;
  if (Array.isArray(result?.data?.payments)) return result.data.payments;
  return [];
};

const isCompletedPayment = (payment: any): boolean =>
  ['completed', 'paid'].includes(String(payment?.status || '').toLowerCase());

const getNetPaymentAmount = (payment: any): number => {
  const explicitRemaining = readMoney(
    payment?.remainingRefundable,
    payment?.remaining_refundable,
  );
  if (explicitRemaining !== null) return explicitRemaining;

  const amount = readMoney(payment?.amount) ?? 0;
  const refunded = readMoney(payment?.refundedAmount, payment?.refunded_amount) ?? 0;
  return roundMoney(Math.max(0, amount - refunded));
};

const readExplicitOutstanding = (paymentsResult: any, order: any): number | null =>
  readMoney(
    paymentsResult?.outstandingAmount,
    paymentsResult?.outstanding_amount,
    paymentsResult?.outstandingBalance,
    paymentsResult?.outstanding_balance,
    paymentsResult?.balance?.outstandingAmount,
    paymentsResult?.balance?.outstanding_amount,
    paymentsResult?.balance?.outstandingBalance,
    paymentsResult?.balance?.outstanding_balance,
    paymentsResult?.data?.outstandingAmount,
    paymentsResult?.data?.outstanding_amount,
    paymentsResult?.data?.outstandingBalance,
    paymentsResult?.data?.outstanding_balance,
    paymentsResult?.data?.balance?.outstandingAmount,
    paymentsResult?.data?.balance?.outstanding_amount,
    paymentsResult?.data?.balance?.outstandingBalance,
    paymentsResult?.data?.balance?.outstanding_balance,
    order?.outstandingAmount,
    order?.outstanding_amount,
    order?.outstandingBalance,
    order?.outstanding_balance,
    order?.balance?.outstandingAmount,
    order?.balance?.outstanding_amount,
    order?.balance?.outstandingBalance,
    order?.balance?.outstanding_balance,
  );

/**
 * Reconciles the state seen after a new-order split modal is dismissed.
 * Explicit native balance fields win when supplied; otherwise the completed
 * payment ledger (including refunds) is the renderer's best local snapshot.
 * Native recordPayment validation remains the final overpayment guard.
 */
export const resolvePersistedSplitDismissal = ({
  fallbackOrderTotal,
  order,
  paymentsResult,
}: PersistedSplitDismissalInput): PersistedSplitDismissalResolution => {
  const orderTotal = readMoney(
    order?.totalAmount,
    order?.total_amount,
    order?.total,
    fallbackOrderTotal,
  ) ?? 0;
  const completedPayments = unwrapPayments(paymentsResult).filter(isCompletedPayment);
  const ledgerPaidAmount = roundMoney(
    completedPayments.reduce((total, payment) => total + getNetPaymentAmount(payment), 0),
  );
  const explicitOutstanding = readExplicitOutstanding(paymentsResult, order);
  const paidTotalFallback = readMoney(order?.paidTotal, order?.paid_total);

  const outstandingAmount = roundMoney(Math.max(
    0,
    explicitOutstanding ?? (
      completedPayments.length > 0
        ? orderTotal - ledgerPaidAmount
        : orderTotal - (paidTotalFallback ?? 0)
    ),
  ));
  const paidAmount = roundMoney(Math.max(0, orderTotal - outstandingAmount));
  const kind: PersistedSplitDismissalKind = outstandingAmount < 0.005
    ? 'settled'
    : paidAmount >= 0.005
      ? 'partial'
      : 'unpaid';

  return {
    kind,
    orderTotal,
    paidAmount,
    outstandingAmount,
    completedPayments,
    ...(typeof paymentsResult?.generation === 'string'
      ? { settlementGeneration: paymentsResult.generation }
      : {}),
  };
};

export const loadPersistedSplitDismissal = async (
  bridge: {
    payments: {
      getSettlementSnapshot: (orderId: string) => Promise<NativeSettlementSnapshot>;
    };
  },
  orderId: string,
  fallbackOrderTotal: number,
): Promise<PersistedSplitDismissalResolution> => {
  const snapshot = await bridge.payments.getSettlementSnapshot(orderId);
  const normalizedOrderId = String(snapshot?.orderId ?? '').trim();
  const orderTotal = readMoney(snapshot?.orderTotal);
  const netPaid = readMoney(snapshot?.netPaid);
  const outstandingAmount = readMoney(snapshot?.outstandingAmount);
  const generation =
    typeof snapshot?.generation === 'string' ? snapshot.generation.trim() : '';
  if (
    snapshot?.success !== true ||
    !normalizedOrderId ||
    normalizedOrderId !== orderId.trim() ||
    orderTotal === null ||
    netPaid === null ||
    outstandingAmount === null ||
    !Array.isArray(snapshot.completedPayments) ||
    !/^[0-9a-f]{64}$/.test(generation) ||
    Math.abs(roundMoney(orderTotal - netPaid) - outstandingAmount) > 0.01
  ) {
    throw new Error('INVALID_PAYMENT_SETTLEMENT_SNAPSHOT');
  }

  return resolvePersistedSplitDismissal({
    fallbackOrderTotal,
    order: {
      totalAmount: orderTotal,
      paidTotal: netPaid,
      outstandingAmount,
    },
    paymentsResult: {
      outstandingAmount,
      payments: snapshot.completedPayments,
      generation,
    },
  });
};

/**
 * Runs one payment write and then treats the atomic native settlement snapshot
 * as the source of truth. Transport errors are deliberately swallowed here:
 * the write may already have committed, so callers must never invite a second
 * attempt before reconciliation says that a balance still exists.
 */
export const reconcileOutstandingPaymentAttempt = async ({
  recordPayment,
  snapshotOnly = false,
  bridge,
  orderId,
  fallbackOrderTotal,
}: {
  recordPayment: () => Promise<unknown>;
  snapshotOnly?: boolean;
  bridge: {
    payments: {
      getSettlementSnapshot: (orderId: string) => Promise<NativeSettlementSnapshot>;
    };
  };
  orderId: string;
  fallbackOrderTotal: number;
}): Promise<OutstandingPaymentAttemptReconciliation> => {
  let recordPaymentFailed = false;
  let attempt = notDispatchedAttempt();
  if (!snapshotOnly) {
    try {
      const result = await recordPayment();
      if (isNotSavedAnswer(result)) {
        return {
          kind: 'not_saved',
          recordPaymentFailed: true,
          result,
          attempt: readAttemptFacts(result, false),
        };
      }
      recordPaymentFailed = Boolean(
        result && typeof result === 'object' && 'success' in result && result.success === false,
      );
      attempt = readAttemptFacts(result, false);
    } catch {
      recordPaymentFailed = true;
      attempt = readAttemptFacts(undefined, true);
    }
  }

  try {
    const settlement = await loadPersistedSplitDismissal(
      bridge,
      orderId,
      fallbackOrderTotal,
    );
    return {
      kind: settlement.kind,
      recordPaymentFailed,
      attempt,
      settlement,
    };
  } catch {
    return { kind: 'unknown', recordPaymentFailed, attempt };
  }
};
