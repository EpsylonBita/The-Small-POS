import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import en from '../../../locales/en.json';
import { ORDER_HAS_OPEN_NOTICE, ORDER_NOTICE_CHECK_UNAVAILABLE, isOrderOpenNoticeRefusal, orderNoticeRefusalCode } from '../../../lib/order-open-notice';
import { announceOrderNoticeMoveRefusal, moveOrdersWithNoticeGate } from '../OrderNoticeStatusGuard';
import toast from 'react-hot-toast';

vi.mock('react-hot-toast', () => ({ default: { error: vi.fn() } }));
vi.mock('../OrderSyncNoticeStore', () => ({ openOrderNotice: (orderId: string) => window.dispatchEvent(new CustomEvent('pos:open-order-notice', { detail: { orderId } })) }));

beforeEach(async () => {
  vi.clearAllMocks();
  await i18next.init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
});

describe('staff completion refused by an open notice', () => {
  it.each([1, 2])('explains %i unreadable orders once without opening an order or showing a raw failure', count => {
    const opened = vi.fn();
    window.addEventListener('pos:open-order-notice', opened);
    const orders = Array.from({ length: count }, (_, index) => ({ id: String(index), number: String(125 + index), errorCode: ORDER_NOTICE_CHECK_UNAVAILABLE }));
    announceOrderNoticeMoveRefusal(orders, i18next.t.bind(i18next), count > 1);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(count === 1
      ? en.orderSyncNotice.checkUnavailable.replace('{{number}}', '125')
      : en.orderSyncNotice.checkUnavailableMany.replace('{{numbers}}', '125, 126'), expect.any(Object));
    expect(vi.mocked(toast.error).mock.calls[0][0]).not.toMatch(/ORDER_|failed|server|database|sync|recovery/i);
    expect(opened).not.toHaveBeenCalled();
    window.removeEventListener('pos:open-order-notice', opened);
  });
  it('keeps the unavailable code through wrappers and continues a bulk move', async () => {
    expect(orderNoticeRefusalCode({ data: { completionRefusal: ORDER_NOTICE_CHECK_UNAVAILABLE } })).toBe(ORDER_NOTICE_CHECK_UNAVAILABLE);
    const orders = ['one', 'two', 'three'].map(id => ({ id, number: id }));
    const move = vi.fn().mockResolvedValueOnce({ success: false, errorCode: ORDER_NOTICE_CHECK_UNAVAILABLE }).mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false, errorCode: ORDER_HAS_OPEN_NOTICE });
    const failure = vi.fn();
    const outcome = await moveOrdersWithNoticeGate(orders, move, failure);
    expect(outcome.moved).toEqual([orders[1]]);
    expect(outcome.blocked).toEqual([{ ...orders[0], errorCode: ORDER_NOTICE_CHECK_UNAVAILABLE }, orders[2]]);
    expect(outcome.stopped).toBe(false);
    expect(failure).not.toHaveBeenCalled();
    expect(move).toHaveBeenCalledTimes(3);
  });
  it.each([ORDER_HAS_OPEN_NOTICE, new Error(ORDER_HAS_OPEN_NOTICE), { success: false, code: ORDER_HAS_OPEN_NOTICE }, { details: { error: ORDER_HAS_OPEN_NOTICE } }])('recognizes wrapped native refusals', error => {
    expect(isOrderOpenNoticeRefusal(error)).toBe(true);
    expect(isOrderOpenNoticeRefusal(new Error('unrelated'))).toBe(false);
  });
  it('explains a single refusal and opens that order once', () => {
    const opened = vi.fn();
    window.addEventListener('pos:open-order-notice', opened);
    announceOrderNoticeMoveRefusal([{ id: 'one', number: '125' }], i18next.t.bind(i18next));
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(en.orderSyncNotice.moveBlocked.replace('{{number}}', '125'), expect.any(Object));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0].detail.orderId).toBe('one');
    window.removeEventListener('pos:open-order-notice', opened);
  });
  it('moves healthy orders on both sides of refusals and announces all blocked orders once', async () => {
    const orders = ['one', 'two', 'three', 'four'].map((id, i) => ({ id, number: String(125 + i) }));
    const move = vi.fn(async (order: typeof orders[number]) => ['one', 'three'].includes(order.id)
      ? { success: false, errorCode: ORDER_HAS_OPEN_NOTICE }
      : { success: true });
    const failure = vi.fn();
    const outcome = await moveOrdersWithNoticeGate(orders, move, failure);
    expect(outcome.moved.map(order => order.id)).toEqual(['two', 'four']);
    expect(outcome.blocked.map(order => order.id)).toEqual(['one', 'three']);
    expect(move).toHaveBeenCalledTimes(4);
    expect(failure).not.toHaveBeenCalled();
    announceOrderNoticeMoveRefusal(outcome.blocked, i18next.t.bind(i18next), true);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Not moved: 125, 127. They have an issue that must be solved first.', expect.any(Object));
  });
  it('lets a later attempt move once the native read has no notice', async () => {
    const order = { id: 'one', number: '125' };
    const move = vi.fn().mockResolvedValueOnce({ success: false, errorCode: ORDER_HAS_OPEN_NOTICE }).mockResolvedValueOnce({ success: true });
    expect((await moveOrdersWithNoticeGate([order], move, vi.fn())).blocked).toEqual([order]);
    expect((await moveOrdersWithNoticeGate([order], move, vi.fn())).moved).toEqual([order]);
  });
});
