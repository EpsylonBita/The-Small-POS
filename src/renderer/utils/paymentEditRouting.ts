export type EditablePaymentMethod = 'cash' | 'card';

export interface EditablePaymentRouteRow {
  id: string;
  method: EditablePaymentMethod;
  amount: number;
  transactionRef?: string | null;
}

export type PaymentEditRoute =
  | { kind: 'blocked' }
  | { kind: 'collect-missing' }
  | {
      kind: 'edit-existing';
      currentMethod: EditablePaymentMethod;
      payments: EditablePaymentRouteRow[];
    };

interface PaymentEditOrderLike {
  id?: unknown;
  status?: unknown;
  payment_status?: unknown;
  paymentStatus?: unknown;
  payment_method?: unknown;
  paymentMethod?: unknown;
}

interface PaymentEditBridgeLike {
  payments: {
    getOrderPayments(orderId: string): Promise<unknown>;
  };
}

interface PaymentEditRowLike {
  id?: unknown;
  method?: unknown;
  status?: unknown;
  amount?: unknown;
  transactionRef?: unknown;
}

const normalized = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

const asEditableMethod = (value: unknown): EditablePaymentMethod | null => {
  const method = normalized(value);
  return method === 'cash' || method === 'card' ? method : null;
};

export function routePaymentEdit(
  order: PaymentEditOrderLike | null | undefined,
  paymentRows: readonly PaymentEditRowLike[],
): PaymentEditRoute {
  if (!order) return { kind: 'blocked' };

  const orderStatus = normalized(order.status);
  if (
    orderStatus === 'cancelled' ||
    orderStatus === 'canceled' ||
    orderStatus === 'refunded'
  ) {
    return { kind: 'blocked' };
  }

  const completedPayments = paymentRows.flatMap((row) => {
    const id = String(row.id ?? '').trim();
    const method = asEditableMethod(row.method);
    if (normalized(row.status) !== 'completed' || !id || !method) return [];

    return [
      {
        id,
        method,
        amount: Number(row.amount ?? 0),
        transactionRef:
          typeof row.transactionRef === 'string' ? row.transactionRef : null,
      } satisfies EditablePaymentRouteRow,
    ];
  });

  const paymentStatus = normalized(
    order.payment_status ?? order.paymentStatus ?? 'pending',
  );

  if (
    paymentStatus === 'refunded' ||
    paymentStatus === 'voided' ||
    paymentStatus === 'cancelled' ||
    paymentStatus === 'canceled'
  ) {
    return { kind: 'blocked' };
  }

  if (paymentStatus === 'partially_paid') {
    return { kind: 'collect-missing' };
  }

  if (completedPayments.length > 0) {
    return {
      kind: 'edit-existing',
      currentMethod:
        completedPayments[0]?.method ??
        asEditableMethod(order.payment_method ?? order.paymentMethod) ??
        'cash',
      payments: completedPayments,
    };
  }

  if (paymentRows.length > 0) return { kind: 'blocked' };

  return paymentStatus === 'pending' || paymentStatus === 'partially_paid'
    ? { kind: 'collect-missing' }
    : { kind: 'blocked' };
}

export async function loadPaymentEditRoute(
  bridge: PaymentEditBridgeLike,
  order: PaymentEditOrderLike | null | undefined,
): Promise<PaymentEditRoute> {
  const orderId = String(order?.id ?? '').trim();
  if (!order || !orderId) return { kind: 'blocked' };

  const paymentRows = await bridge.payments.getOrderPayments(orderId);
  if (!Array.isArray(paymentRows)) return { kind: 'blocked' };
  return routePaymentEdit(order, paymentRows);
}
