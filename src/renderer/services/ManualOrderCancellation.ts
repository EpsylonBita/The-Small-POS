import type { PlatformBridge } from '../../lib';

export interface ManualCancellationPlan {
  orderId: string;
  tableSessionId?: string;
  pending?: boolean;
  /**
   * The server refused this saved table cancellation and it is never sent
   * again: nothing was returned. A manager clears it before a new attempt.
   */
  refused?: boolean;
  refusalCode?: string | null;
  reason?: string;
  returnChannel?: "cash_drawer" | "bank";
  requiresReturn: boolean;
  requiresHandback?: boolean;
  generation: string;
  amountCents: number;
  currency: string;
  requestId: string;
}

export async function prepareManualOrderCancellation(bridge: Pick<PlatformBridge, 'invoke'>, orderId: string): Promise<ManualCancellationPlan> {
  const result = await bridge.invoke('order_prepare_manual_cancel', { orderId });
  const financial = result?.requiresReturn === true || result?.requiresHandback === true;
  const table = typeof result?.tableSessionId === 'string' && result.tableSessionId.length > 0;
  if (result?.success !== true || (!financial && !table) || result.orderId !== orderId
    || typeof result.generation !== 'string' || !Number.isSafeInteger(result.amountCents) || result.amountCents < 0 || (result.requiresReturn === true && result.amountCents === 0)
    || (financial && (typeof result.currency !== 'string' || !/^[A-Z]{3}$/.test(result.currency)))) {
    throw new Error('CANCELLATION_PAYMENT_CHANGED');
  }
  return { ...result, requestId: result.requestId || crypto.randomUUID() };
}

export async function commitManualOrderCancellation(bridge: Pick<PlatformBridge, 'invoke'>, plan: ManualCancellationPlan, reason: string, returnChannel: 'cash_drawer' | 'bank'): Promise<void> {
  if (plan.tableSessionId) throw new Error('TABLE_CANONICAL_CANCELLATION_REQUIRED');
  const result = await bridge.invoke('order_cancel_manual_refund', {
    orderId: plan.orderId, generation: plan.generation, requestId: plan.requestId, reason, returnChannel,
  });
  if (result?.success !== true) throw new Error(result?.error || 'ORDER_CANCELLATION_FAILED');
}

const errorCode = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
};

export function manualCancellationFailureKey(error: unknown): string {
  const code = errorCode(error);
  const key = code.includes('TABLE_CANCELLATION_REFUSED') ? 'refusedByServer'
    : code.includes('TABLE_CANCELLATION_RELEASE_WAIT') ? 'releaseWait'
    : code.includes('TABLE_CANCELLATION_COMMITTED') ? 'releaseCommitted'
    : code.includes('TABLE_CANCELLATION_PENDING') ? 'cancellationPending'
    : code.includes('PLATFORM_ORDER_RETURN_REQUIRED') ? 'platformOrderReturn'
    : code.includes('ORIGINAL_RECEIPT_CHECK_UNAVAILABLE') ? 'receiptCheckUnavailable'
    : code.includes('STAFF_CASH_CUSTODY_AMBIGUOUS') ? 'staffCashAmbiguous'
    : code.includes('STAFF_CASH_RETURN_UNAVAILABLE') || code.includes('TABLE_MANUAL_CANCELLATION_UNAVAILABLE') ? 'staffCashUnavailable'
    : code.includes('ORIGINAL_PROVIDER_RETURN_REQUIRED') ? 'originalReturnRequired'
    : code.includes('PAYMENT_CONNECTION_STATUS_UNAVAILABLE') ? 'connectionUnavailable'
    : code.includes('ORDER_CANCELLATION_PERMISSION_REQUIRED') || code.includes('AUTHENTICATION_REQUIRED') ? 'permissionRequired'
    : code.includes('PAYMENT_SYNC_REQUIRED') ? 'paymentSyncRequired'
    : code.includes('CANCELLATION_PAYMENT_CHANGED') || code.includes('CANCELLATION_REQUEST_CONFLICT') ? 'paymentChanged'
    : code.includes('CURRENCY') ? 'currencyMismatch'
    : code.includes('CASHIER_DRAWER_UNAVAILABLE') ? 'drawerUnavailable' : undefined;
  if (code.includes('ORDER_PAYMENT_NOT_RECORDED')) return 'orderDashboard.cancelRefusedNotRecorded';
  return key ? `modals.orderCancellation.${key}` : 'orderDashboard.cancelFailed';
}

/** Interpolation values a failure text needs (the minutes left to wait). */
export function manualCancellationFailureOptions(error: unknown): Record<string, string | number> {
  const wait = /TABLE_CANCELLATION_RELEASE_WAIT:(\d+)/.exec(errorCode(error));
  return wait ? { minutes: Number(wait[1]) } : {};
}
