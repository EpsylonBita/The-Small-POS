import type { PlatformReadyResult } from '../../lib/ipc-adapter';

/**
 * Ready on the selected platform orders (item D8, efood late Ready,
 * 01/10/2026). The till answers an order already past Ready with
 * `alreadyClosed`, and an order cancelled or refunded with `cancelled`;
 * neither wrote, queued or sent anything. A cancelled order is never
 * announced as ready: the cashier is told it was cancelled by the platform.
 */
export interface PlatformReadyOutcome {
  markedReady: number;
  alreadyClosed: number;
  /** Display numbers of the orders the platform had cancelled. */
  cancelledOrderNumbers: string[];
  /** The order whose Ready failed (the loop stops there), if any. */
  failedOrderNumber: string | null;
}

export interface PlatformReadyTarget {
  id: string;
  /** The number shown to the cashier. */
  displayNumber: string;
}

export async function markPlatformOrdersReady(
  orders: readonly PlatformReadyTarget[],
  notify: (orderId: string) => Promise<PlatformReadyResult | null | undefined>,
): Promise<PlatformReadyOutcome> {
  const outcome: PlatformReadyOutcome = {
    markedReady: 0,
    alreadyClosed: 0,
    cancelledOrderNumbers: [],
    failedOrderNumber: null,
  };
  for (const order of orders) {
    let result: PlatformReadyResult | null | undefined;
    try {
      result = await notify(order.id);
    } catch {
      outcome.failedOrderNumber = order.displayNumber;
      return outcome;
    }
    if (result?.cancelled) {
      outcome.cancelledOrderNumbers.push(order.displayNumber);
    } else if (result?.alreadyClosed) {
      outcome.alreadyClosed += 1;
    } else {
      outcome.markedReady += 1;
    }
  }
  return outcome;
}

type Translate = (key: string, options?: Record<string, unknown>) => unknown;

interface ToastApi {
  success: (message: string, options?: Record<string, unknown>) => unknown;
  error: (message: string, options?: Record<string, unknown>) => unknown;
}

/** The messages for an outcome: never a success toast for a cancelled order. */
export function announcePlatformReadyOutcome(
  outcome: PlatformReadyOutcome,
  t: Translate,
  toast: ToastApi,
): void {
  if (outcome.failedOrderNumber !== null) {
    toast.error(
      String(
        t('orderDashboard.platformReadyFailed', {
          defaultValue: 'Failed to notify the platform for {{orderNumber}}',
          orderNumber: outcome.failedOrderNumber,
        }),
      ),
    );
  }
  if (outcome.cancelledOrderNumbers.length > 0) {
    const eyebrow = String(
      t('cancellationNotice.eyebrow', { defaultValue: 'Order cancelled by platform' }),
    );
    const orderLabel = String(t('cancellationNotice.orderNumber', { defaultValue: 'Order' }));
    toast.error(`${eyebrow}: ${orderLabel} ${outcome.cancelledOrderNumbers.join(', ')}`, {
      id: 'platform-ready-cancelled',
      duration: 8000,
    });
  }
  if (outcome.markedReady > 0) {
    toast.success(
      String(
        t('orderDashboard.platformReadySent', {
          defaultValue: 'Marked ready',
          count: outcome.markedReady,
        }),
      ),
    );
  }
}
