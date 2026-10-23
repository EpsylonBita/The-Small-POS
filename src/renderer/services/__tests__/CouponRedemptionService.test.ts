import { beforeEach, describe, expect, it, vi } from 'vitest';
import { couponRedemptionService } from '../CouponRedemptionService';
const { post, getById } = vi.hoisted(() => ({ post: vi.fn(), getById: vi.fn() }));
vi.mock('../../utils/api-helpers', () => ({ posApiPost: post, isModuleRequiredApiError: (error: unknown) => error === 'MODULE_REQUIRED' }));
vi.mock('../../../lib', () => ({ getBridge: () => ({ orders: { getById } }) }));
const KEY = 'pos_coupon_redemption_queue_v1';
const payload = { couponId: 'coupon-1', orderId: 'client-request-1', discountAmount: 5 };

describe('coupon server order reference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    post.mockReset().mockResolvedValue({ success: true, data: { success: true } });
    getById.mockReset().mockResolvedValue(null);
  });

  it('sends the new checkout client request id when there is no local row under it', async () => {
    expect(await couponRedemptionService.redeemOrQueue(payload)).toEqual({ applied: true, queued: false });
    expect(post).toHaveBeenCalledWith('pos/coupons/apply', { coupon_id: 'coupon-1', order_id: 'client-request-1', discount_amount: 5 });
  });

  it.each([{ client_request_id: 'client-request-1' }, { data: { supabase_id: 'server-order-1' } }])('translates an old parked local id at send time (%o)', async (row) => {
    window.localStorage.setItem(KEY, JSON.stringify([{ ...payload, orderId: 'local-order-1', attempts: 10, createdAt: '2026-10-21T00:00:00Z', nextRetryAt: 0 }]));
    getById.mockResolvedValue(row);
    await couponRedemptionService.processQueue();
    expect(getById).toHaveBeenCalledWith('local-order-1');
    expect(post).toHaveBeenCalledWith('pos/coupons/apply', expect.objectContaining({ order_id: 'data' in row ? 'server-order-1' : 'client-request-1' }));
    expect(couponRedemptionService.getQueueLength()).toBe(0);
  });

  it('retains the local queue identity after failure and translates again when the parent syncs', async () => {
    getById.mockResolvedValue({ clientRequestId: 'client-request-1' });
    post.mockResolvedValue({ success: false, error: 'MODULE_REQUIRED' });
    await couponRedemptionService.redeemOrQueue({ ...payload, orderId: 'local-order-1' });
    const parked = JSON.parse(window.localStorage.getItem(KEY)!);
    expect(parked[0]).toMatchObject({ orderId: 'local-order-1', attempts: 0 });
    window.localStorage.setItem(KEY, JSON.stringify([{ ...parked[0], nextRetryAt: 0 }]));
    getById.mockResolvedValue({ supabase_id: 'server-order-1' });
    post.mockResolvedValue({ success: true, data: { success: true } });
    await couponRedemptionService.processQueue();
    expect(post).toHaveBeenLastCalledWith('pos/coupons/apply', expect.objectContaining({ order_id: 'server-order-1' }));
    expect(couponRedemptionService.getQueueLength()).toBe(0);
  });

  it('can still send a known reference when IPC is unavailable', async () => {
    getById.mockRejectedValue(new Error('IPC unavailable'));
    await couponRedemptionService.redeemOrQueue(payload);
    expect(post).toHaveBeenCalledWith('pos/coupons/apply', expect.objectContaining({ order_id: payload.orderId }));
  });
});
