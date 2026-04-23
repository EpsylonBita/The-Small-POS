/**
 * Shared order-type pricing tier resolution.
 *
 * The Small POS stores up to three per-item prices: `pickup_price`,
 * `delivery_price`, `dine_in_price`, plus a base `price` fallback.
 * The selected order type determines which tier applies; missing tiers
 * fall back through a well-defined chain so a menu item without (say) a
 * dine-in price never renders as free.
 *
 * This helper is the single source of truth for that resolution. Consumers:
 *  - `MenuItemGrid` for the tile price shown on the grid
 *  - `MenuModal` for repricing existing cart items when the operator
 *    switches order type during an edit session
 *  - Anywhere else a new callsite needs to display or compute tier price
 *
 * Keeping one helper means every caller agrees on the fallback chain
 * (especially that `dine-in` falls back to `pickup_price` before `price`,
 * which matches the historical expectation that dine-in pricing mirrors
 * pickup unless explicitly set).
 */

export type OrderTypeTier = 'pickup' | 'delivery' | 'dine-in';

/**
 * Minimal per-item price shape. Kept as a structural type so callers don't
 * need to import a specific `MenuItem` class — any object with these numeric
 * fields works (including Supabase rows, locally-cached snapshots, or test
 * fixtures).
 */
export interface TierPriceFields {
  price?: number | null;
  pickup_price?: number | null;
  delivery_price?: number | null;
  dine_in_price?: number | null;
  /** camelCase aliases used by some renderer-facing types. */
  pickupPrice?: number | null;
  deliveryPrice?: number | null;
  dineInPrice?: number | null;
}

const asFiniteNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const pick = (...candidates: Array<unknown>): number | null => {
  for (const candidate of candidates) {
    const n = asFiniteNumber(candidate);
    if (n !== null && n > 0) return n;
  }
  // If nothing positive, accept the first finite value (including 0) to
  // avoid returning null for genuinely-free items.
  for (const candidate of candidates) {
    const n = asFiniteNumber(candidate);
    if (n !== null) return n;
  }
  return null;
};

/**
 * Resolve the price for a menu item under a given order type tier.
 * Returns `0` when the item has no usable price at all — callers should
 * never see NaN or undefined.
 */
export function resolveMenuItemPrice(
  item: TierPriceFields | null | undefined,
  orderType: OrderTypeTier | string | null | undefined,
): number {
  if (!item) return 0;

  const base = pick(item.price);

  const pickupTier = pick(item.pickup_price, item.pickupPrice);
  const deliveryTier = pick(item.delivery_price, item.deliveryPrice);
  const dineInTier = pick(item.dine_in_price, item.dineInPrice);

  switch (orderType) {
    case 'delivery':
      return deliveryTier ?? base ?? 0;
    case 'dine-in':
      // Dine-in falls back through pickup before base — intentional: many
      // restaurants set pickup + delivery but leave dine-in unset, and the
      // expected behaviour is "same as pickup", not "same as base".
      return dineInTier ?? pickupTier ?? base ?? 0;
    case 'pickup':
    default:
      return pickupTier ?? base ?? 0;
  }
}
