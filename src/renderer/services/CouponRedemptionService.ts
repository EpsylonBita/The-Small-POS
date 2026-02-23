import { posApiPost } from '../utils/api-helpers';

const COUPON_REDEMPTION_QUEUE_KEY = 'pos_coupon_redemption_queue_v1';
const MAX_RETRY_ATTEMPTS = 10;
const BASE_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

export interface CouponRedemptionPayload {
  couponId: string;
  orderId: string;
  discountAmount: number;
  couponCode?: string | null;
}

interface CouponRedemptionQueueItem extends CouponRedemptionPayload {
  attempts: number;
  createdAt: string;
  lastAttemptAt?: string;
  nextRetryAt: number;
}

interface CouponApplyResponse {
  success?: boolean;
  already_applied?: boolean;
}

class CouponRedemptionService {
  private static instance: CouponRedemptionService;

  static getInstance(): CouponRedemptionService {
    if (!CouponRedemptionService.instance) {
      CouponRedemptionService.instance = new CouponRedemptionService();
    }
    return CouponRedemptionService.instance;
  }

  private readQueue(): CouponRedemptionQueueItem[] {
    if (typeof window === 'undefined') {
      return [];
    }

    try {
      const raw = window.localStorage.getItem(COUPON_REDEMPTION_QUEUE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((entry) => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }
        return typeof entry.couponId === 'string' && typeof entry.orderId === 'string';
      }) as CouponRedemptionQueueItem[];
    } catch (error) {
      console.warn('[CouponRedemptionService] Failed to read queue:', error);
      return [];
    }
  }

  private writeQueue(items: CouponRedemptionQueueItem[]): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(COUPON_REDEMPTION_QUEUE_KEY, JSON.stringify(items));
    } catch (error) {
      console.warn('[CouponRedemptionService] Failed to write queue:', error);
    }
  }

  private getBackoffDelayMs(attempts: number): number {
    const multiplier = Math.max(1, 2 ** Math.max(0, attempts - 1));
    return Math.min(BASE_RETRY_DELAY_MS * multiplier, MAX_RETRY_DELAY_MS);
  }

  private upsertQueueItem(item: CouponRedemptionQueueItem): void {
    const queue = this.readQueue();
    const existingIndex = queue.findIndex(
      (entry) => entry.orderId === item.orderId && entry.couponId === item.couponId
    );

    if (existingIndex >= 0) {
      queue[existingIndex] = item;
    } else {
      queue.push(item);
    }

    this.writeQueue(queue);
  }

  private removeQueueItem(target: CouponRedemptionQueueItem): void {
    const queue = this.readQueue().filter(
      (entry) => !(entry.orderId === target.orderId && entry.couponId === target.couponId)
    );
    this.writeQueue(queue);
  }

  private async applyCoupon(payload: CouponRedemptionPayload): Promise<boolean> {
    try {
      const response = await posApiPost<CouponApplyResponse>('pos/coupons/apply', {
        coupon_id: payload.couponId,
        order_id: payload.orderId,
        discount_amount: Math.max(0, Number(payload.discountAmount) || 0),
      });

      if (!response.success) {
        return false;
      }

      if (response.data && response.data.success === false) {
        return false;
      }

      return true;
    } catch (error) {
      console.warn('[CouponRedemptionService] Coupon apply request failed:', error);
      return false;
    }
  }

  async redeemOrQueue(payload: CouponRedemptionPayload): Promise<{ applied: boolean; queued: boolean }> {
    if (!payload.couponId || !payload.orderId) {
      return { applied: false, queued: false };
    }

    const applied = await this.applyCoupon(payload);
    if (applied) {
      return { applied: true, queued: false };
    }

    const now = Date.now();
    this.upsertQueueItem({
      ...payload,
      attempts: 0,
      createdAt: new Date(now).toISOString(),
      nextRetryAt: now + BASE_RETRY_DELAY_MS,
    });

    return { applied: false, queued: true };
  }

  async processQueue(): Promise<void> {
    const now = Date.now();
    const queue = this.readQueue();
    if (queue.length === 0) {
      return;
    }

    const updatedQueue: CouponRedemptionQueueItem[] = [];

    for (const item of queue) {
      if (item.nextRetryAt > now) {
        updatedQueue.push(item);
        continue;
      }

      const applied = await this.applyCoupon(item);
      if (applied) {
        continue;
      }

      const nextAttempts = item.attempts + 1;
      if (nextAttempts >= MAX_RETRY_ATTEMPTS) {
        console.warn('[CouponRedemptionService] Dropping coupon apply after max retries', {
          orderId: item.orderId,
          couponId: item.couponId,
          attempts: nextAttempts,
        });
        continue;
      }

      const delayMs = this.getBackoffDelayMs(nextAttempts);
      updatedQueue.push({
        ...item,
        attempts: nextAttempts,
        lastAttemptAt: new Date(now).toISOString(),
        nextRetryAt: now + delayMs,
      });
    }

    this.writeQueue(updatedQueue);
  }

  getQueueLength(): number {
    return this.readQueue().length;
  }
}

export const couponRedemptionService = CouponRedemptionService.getInstance();
