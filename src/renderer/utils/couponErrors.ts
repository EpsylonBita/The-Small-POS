// Coupon-validation failures arrive in two different shapes depending on the
// runtime path, and both were previously echoed to the user verbatim:
//   - Browser/admin API (`pos/coupons/validate`) returns machine codes, e.g.
//     "COUPON_NOT_FOUND", "COUPON_EXPIRED", "COUPON_MIN_ORDER_NOT_MET".
//   - Desktop bridge (Rust `validate_coupon`) returns English sentences, e.g.
//     "Coupon not found", "Coupon has expired", "Minimum order amount is 20.00".
// Showing either raw leaks English (or worse, a SCREAMING_CASE code) into the
// active non-English UI. This module maps both shapes onto a single localized
// i18n key so the message is translated at the source via t(...).

export type CouponErrorKey =
  | 'menu.cart.couponNotFound'
  | 'menu.cart.couponInactive'
  | 'menu.cart.couponExpired'
  | 'menu.cart.couponUsageLimit'
  | 'menu.cart.couponNotAvailable'
  | 'menu.cart.couponMinOrder'
  | 'menu.cart.couponInvalid';

// English fallbacks, kept in lock-step with the en.json values so the inline
// t(key, fallback) default and the English locale agree. Used only when a key is
// somehow absent at runtime; the locales remain the source of truth.
export const COUPON_ERROR_FALLBACKS: Record<CouponErrorKey, string> = {
  'menu.cart.couponNotFound': 'Coupon not found',
  'menu.cart.couponInactive': 'This coupon is inactive',
  'menu.cart.couponExpired': 'This coupon has expired',
  'menu.cart.couponUsageLimit': "This coupon's usage limit has been reached",
  'menu.cart.couponNotAvailable': 'This coupon is not available for this branch',
  'menu.cart.couponMinOrder': "Your order doesn't meet this coupon's minimum amount",
  'menu.cart.couponInvalid': 'Invalid coupon code',
};

// Maps a raw server failure signal (code OR English sentence) to a locale key.
// Underscores are flattened to spaces so machine codes and sentences match the
// same phrase checks. An empty/unrecognized signal falls back to the generic
// localized "invalid coupon" message rather than echoing raw text.
export function resolveCouponErrorKey(serverError?: string | null): CouponErrorKey {
  const normalized = String(serverError ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ');

  if (!normalized) return 'menu.cart.couponInvalid';

  // Order matters: "not found" before the broader "branch"/"not active" checks.
  if (normalized.includes('not found') || normalized.includes('does not exist')) {
    return 'menu.cart.couponNotFound';
  }
  if (normalized.includes('branch')) {
    return 'menu.cart.couponNotAvailable';
  }
  if (
    normalized.includes('inactive') ||
    normalized.includes('not active') ||
    normalized.includes('disabled')
  ) {
    return 'menu.cart.couponInactive';
  }
  if (normalized.includes('expired')) {
    return 'menu.cart.couponExpired';
  }
  if (
    normalized.includes('usage limit') ||
    normalized.includes('limit reached') ||
    normalized.includes('limit has been reached')
  ) {
    return 'menu.cart.couponUsageLimit';
  }
  if (normalized.includes('min order') || normalized.includes('minimum order')) {
    return 'menu.cart.couponMinOrder';
  }

  return 'menu.cart.couponInvalid';
}
