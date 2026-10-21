import { describe, expect, it } from 'vitest';
import { couponEligibilityError } from '../couponErrors';

describe('applied coupon eligibility', () => {
  it('uses the raw qualifying basket in cents, with either minimum field', () => {
    expect(couponEligibilityError({ min_order_amount: 20 }, 19.99)).toBe('menu.cart.couponMinOrder');
    expect(couponEligibilityError({ minimum_order_amount: 20 }, 20)).toBeNull();
    expect(couponEligibilityError({ min_order_amount: 10.05 }, 10.049999999)).toBeNull();
    expect(couponEligibilityError({ min_order_amount: 10.05 }, 10.04)).toBe('menu.cart.couponMinOrder');
  });

  it('rechecks expiration, activity and locally known exhausted usage', () => {
    expect(couponEligibilityError({ expires_at: '2026-10-19T00:00:00Z' }, 30, Date.parse('2026-10-20'))).toBe('menu.cart.couponExpired');
    expect(couponEligibilityError({ is_active: false }, 30)).toBe('menu.cart.couponInactive');
    expect(couponEligibilityError({ usage_limit: 2, usage_count: 2 }, 30)).toBe('menu.cart.couponUsageLimit');
    expect(couponEligibilityError({ usage_limit: null, usage_count: 20 }, 30)).toBeNull();
  });
});
