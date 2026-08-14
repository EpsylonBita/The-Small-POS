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

export type OutstandingPaymentAttemptReconciliation =
  | {
      kind: PersistedSplitDismissalKind;
      recordPaymentFailed: boolean;
      settlement: PersistedSplitDismissalResolution;
    }
  | {
      kind: 'unknown';
      recordPaymentFailed: boolean;
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

const roundMoney = (value: number): number =>
  Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;

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
  if (!snapshotOnly) {
    try {
      const result = await recordPayment();
      recordPaymentFailed = Boolean(
        result && typeof result === 'object' && 'success' in result && result.success === false,
      );
    } catch {
      recordPaymentFailed = true;
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
      settlement,
    };
  } catch {
    return { kind: 'unknown', recordPaymentFailed };
  }
};
