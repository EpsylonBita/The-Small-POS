export type MissingPaymentMethod = 'cash' | 'card';

export interface MissingPaymentRepairRequest {
  orderId: string;
  method: MissingPaymentMethod;
  amount: number;
  cashReceived?: number;
  changeGiven?: number;
  transactionRef?: string;
  idempotencyKey?: string;
  expectedSettlementGeneration: string;
}

interface MissingPaymentRepairBridge {
  recordPayment(request: {
    orderId: string;
    method: MissingPaymentMethod;
    amount: number;
    cashReceived?: number;
    changeGiven?: number;
    transactionRef?: string;
    idempotencyKey?: string;
    expectedSettlementGeneration: string;
    collectOutstandingBalance: true;
  }): Promise<unknown>;
}

export interface MissingPaymentSettlement {
  orderTotal: number;
  netPaid: number;
  outstandingAmount: number;
  completedPayments: unknown[];
}

export interface MissingPaymentRepairResult {
  orderId: string;
  paymentId: string;
  method: MissingPaymentMethod;
  amount: number;
  settlement: MissingPaymentSettlement;
}

export class MissingPaymentRepairError extends Error {
  constructor() {
    super('PAYMENT_REPAIR_FAILED');
    this.name = 'MissingPaymentRepairError';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseRepairResult(value: unknown): MissingPaymentRepairResult | null {
  if (!isObject(value) || value.success !== true) return null;

  const orderId = typeof value.orderId === 'string' ? value.orderId.trim() : '';
  const paymentId =
    typeof value.paymentId === 'string' ? value.paymentId.trim() : '';
  const method = value.method;
  const amount = Number(value.amount);
  const settlement = isObject(value.settlement) ? value.settlement : null;
  const orderTotal = Number(settlement?.orderTotal);
  const netPaid = Number(settlement?.netPaid);
  const outstandingAmount = Number(settlement?.outstandingAmount);
  const completedPayments = settlement?.completedPayments;
  if (
    !orderId ||
    !paymentId ||
    (method !== 'cash' && method !== 'card') ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !settlement ||
    !Number.isFinite(orderTotal) ||
    orderTotal < 0 ||
    !Number.isFinite(netPaid) ||
    netPaid < 0 ||
    !Number.isFinite(outstandingAmount) ||
    outstandingAmount < 0 ||
    !Array.isArray(completedPayments) ||
    completedPayments.length === 0 ||
    Math.abs(Math.round((orderTotal - netPaid) * 100) - Math.round(outstandingAmount * 100)) > 1
  ) {
    return null;
  }

  return {
    orderId,
    paymentId,
    method,
    amount,
    settlement: { orderTotal, netPaid, outstandingAmount, completedPayments },
  };
}

export async function repairMissingPayment(
  bridge: MissingPaymentRepairBridge,
  request: MissingPaymentRepairRequest,
): Promise<MissingPaymentRepairResult> {
  try {
    const orderId = request.orderId.trim();
    if (
      !orderId ||
      !/^[0-9a-f]{64}$/.test(request.expectedSettlementGeneration) ||
      !Number.isFinite(request.amount) ||
      request.amount <= 0 ||
      (request.method === 'cash' &&
        (!Number.isFinite(request.cashReceived) ||
          Number(request.cashReceived) + 0.005 < request.amount))
    ) {
      throw new MissingPaymentRepairError();
    }
    const parsed = parseRepairResult(
      await bridge.recordPayment({
        orderId,
        method: request.method,
        amount: request.amount,
        cashReceived: request.cashReceived,
        changeGiven: request.changeGiven,
        transactionRef: request.transactionRef,
        idempotencyKey: request.idempotencyKey,
        expectedSettlementGeneration: request.expectedSettlementGeneration,
        collectOutstandingBalance: true,
      }),
    );
    if (
      !parsed ||
      parsed.orderId !== orderId ||
      parsed.method !== request.method ||
      parsed.settlement.outstandingAmount >= 0.005 ||
      !parsed.settlement.completedPayments.some((payment) =>
        isObject(payment) &&
        payment.id === parsed.paymentId &&
        payment.status === 'completed',
      )
    ) {
      throw new MissingPaymentRepairError();
    }
    return parsed;
  } catch (error) {
    if (error instanceof MissingPaymentRepairError) throw error;
    throw new MissingPaymentRepairError();
  }
}
