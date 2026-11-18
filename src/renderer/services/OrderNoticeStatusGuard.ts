import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { isOrderOpenNoticeRefusal, orderNoticeRefusalCode, ORDER_NOTICE_CHECK_UNAVAILABLE, type OrderNoticeRefusalCode } from '../../lib/order-open-notice';
import { openOrderNotice } from './OrderSyncNoticeStore';

export type NoticeMoveOrder = { id: string; number: string; errorCode?: OrderNoticeRefusalCode };

export function announceOrderNoticeMoveRefusal(orders: readonly NoticeMoveOrder[], t: TFunction, bulk = false): void {
  if (!orders.length) return;
  const unavailable = orders.filter(order => order.errorCode === ORDER_NOTICE_CHECK_UNAVAILABLE);
  const open = orders.filter(order => order.errorCode !== ORDER_NOTICE_CHECK_UNAVAILABLE);
  const messages: string[] = [];
  if (unavailable.length) messages.push(unavailable.length > 1
    ? t('orderSyncNotice.checkUnavailableMany', { numbers: unavailable.map(order => order.number).join(', '), defaultValue: 'The till cannot check right now whether orders {{numbers}} have an open issue, so they stay in the active orders. Try again in a moment. If it keeps happening, call support.' })
    : t('orderSyncNotice.checkUnavailable', { number: unavailable[0].number.replace(/^#/, ''), defaultValue: 'The till cannot check right now whether order #{{number}} has an open issue, so it stays in the active orders. Try again in a moment. If it keeps happening, call support.' }));
  if (open.length) messages.push(bulk
    ? t('orderSyncNotice.movesBlocked', { numbers: open.map(order => order.number).join(', '), defaultValue: 'Not moved: {{numbers}}. They have an issue that must be solved first.' })
    : t('orderSyncNotice.moveBlocked', { number: open[0].number, defaultValue: 'Order {{number}} has an issue that must be solved first. Open it to see what to do.' }));
  toast.error(messages.join('\n'), { id: 'order-open-notice-move', duration: 9000 });
  if (open.length) openOrderNotice(open[0].id);
}

/** Each native move is its own transaction. A refused order cannot stop healthy orders. */
export async function moveOrdersWithNoticeGate<
  T extends NoticeMoveOrder,
  R extends { success: boolean; errorCode?: string; errorMessage?: string },
>(
  orders: readonly T[],
  move: (order: T) => Promise<R>,
  onOtherFailure: (order: T, result: R) => void,
): Promise<{ moved: T[]; blocked: T[]; stopped: boolean }> {
  const moved: T[] = [];
  const blocked: T[] = [];
  for (const order of orders) {
    const result = await move(order);
    if (result.success) moved.push(order);
    else if (isOrderOpenNoticeRefusal(result)) blocked.push(orderNoticeRefusalCode(result) === ORDER_NOTICE_CHECK_UNAVAILABLE
      ? { ...order, errorCode: ORDER_NOTICE_CHECK_UNAVAILABLE } : order);
    else {
      onOtherFailure(order, result);
      return { moved, blocked, stopped: true };
    }
  }
  return { moved, blocked, stopped: false };
}
