import type { RecoveryRouteTarget } from '../../lib';

export const RECOVERY_ORDER_PAYMENT_TARGET_KEY = 'pos-recovery-order-payment-target';
export const OPEN_RECOVERY_ORDER_PAYMENT_EVENT = 'pos:open-order-payment';

export function openRecoveryOrderPayment(target: Pick<RecoveryRouteTarget, 'orderId' | 'orderNumber' | 'params'>): void {
  window.sessionStorage.setItem(RECOVERY_ORDER_PAYMENT_TARGET_KEY, JSON.stringify({
    orderId: target.orderId ?? null,
    orderNumber: target.orderNumber ?? null,
    params: target.params ?? {},
    createdAt: Date.now(),
  }));
  window.dispatchEvent(new CustomEvent('pos:navigate-view', { detail: { view: 'orders' } }));
  window.dispatchEvent(new Event(OPEN_RECOVERY_ORDER_PAYMENT_EVENT));
}
