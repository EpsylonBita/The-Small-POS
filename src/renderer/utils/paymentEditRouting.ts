import { isStoreCollectableOrder } from '../../../../shared/platforms/payment-coverage';

export type EditablePaymentMethod = 'cash' | 'card';

export interface EditablePaymentRouteRow {
  id: string;
  method: EditablePaymentMethod;
  amount: number;
  currency?: string | null;
  transactionRef?: string | null;
}

export type PaymentEditRoute =
  | { kind: 'blocked'; reason?: 'adjusted' | 'platform_held' }
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
  plugin?: unknown;
  platform?: unknown;
  external_plugin_order_id?: unknown;
  externalPluginOrderId?: unknown;
  ghost_metadata?: unknown;
  ghostMetadata?: unknown;
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
  currency?: unknown;
  transactionRef?: unknown;
  refundedAmount?: unknown;
  refunded_amount?: unknown;
  /** The server refused this till payment as platform-held money (R4). */
  platformHeldSetAside?: unknown;
}

const normalized = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

const asEditableMethod = (value: unknown): EditablePaymentMethod | null => {
  const method = normalized(value);
  return method === 'cash' || method === 'card' ? method : null;
};

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

/**
 * Does the delivery platform hold this order's money (shared rule R4, round
 * 3 review 01/10/2026)? Its disposition says so (the shared
 * `isStoreCollectableOrder`, as the till's collection refusal reads it), or
 * the server refused a till payment on it as platform-held. Such an order's
 * money is never collected or recorded at the till: its record is the
 * platform's settlement, restored from the server.
 */
export function orderMoneyIsPlatformHeld(
  order: PaymentEditOrderLike,
  paymentRows: readonly PaymentEditRowLike[],
): boolean {
  if (paymentRows.some((row) => row.platformHeldSetAside === true)) return true;
  return !isStoreCollectableOrder({
    id: String(order.id ?? ''),
    platform: textOrNull(order.plugin ?? order.platform),
    externalPlatformOrderId: textOrNull(
      order.external_plugin_order_id ?? order.externalPluginOrderId,
    ),
    ghostMetadata: order.ghost_metadata ?? order.ghostMetadata ?? null,
  });
}

export function routePaymentEdit(
  order: PaymentEditOrderLike | null | undefined,
  paymentRows: readonly PaymentEditRowLike[],
): PaymentEditRoute {
  const route = routeLedgerPaymentEdit(order, paymentRows);
  // Shared rule R4: the platform's money is never collected or recorded at
  // the till. Symptom before (round 3 review, 01/10/2026): a platform-held
  // order with a pending or partly paid label and no till row was routed to
  // "collect the missing payment" in cash or card; only the till's write
  // refused it (when the disposition was known), or the server refused it
  // again and it was set aside again.
  if (route.kind === 'collect-missing' && order && orderMoneyIsPlatformHeld(order, paymentRows)) {
    return { kind: 'blocked', reason: 'platform_held' };
  }
  return route;
}

function routeLedgerPaymentEdit(
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
        currency: textOrNull(row.currency),
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

  // The native ledger forbids rewriting tender history after an adjustment.
  // Check all rows, including refunded rows filtered out of the editable list.
  // A payment set aside for review (`duplicate_review`) holds the order the
  // same way: its tender is decided on the Z, never by a method edit.
  if (paymentRows.some((row) =>
    ['refunded', 'voided', 'duplicate_review'].includes(normalized(row.status)) ||
    Number(row.refundedAmount ?? row.refunded_amount ?? 0) > 0,
  )) {
    return { kind: 'blocked', reason: 'adjusted' };
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
