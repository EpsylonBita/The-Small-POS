/**
 * Edit-order line repricing helpers.
 *
 * A customized order line's unit price is `tier base + sum(ingredient tier
 * prices)`. The edit-order flow historically lost the ingredient component in
 * two places:
 *
 *  - MenuModal's edit-mode reprice effect replaced the hydrated (combined)
 *    unit price with the bare catalog tier from `resolveMenuItemPrice`,
 *    flattening every customized line to the subcategory base price.
 *  - `calculatePickupToDeliveryTotal` retiered items to delivery with the
 *    same bare-tier lookup.
 *
 * These helpers are the single source of truth for "reprice a cart line under
 * an order type without dropping its customizations". The ingredient tier
 * fallback chains deliberately mirror `MenuModal.handleAddToCart` (nullish
 * chains, so a genuine 0 tier price is respected), not the positive-preferring
 * `pick()` used for menu-item tiers in `order-type-pricing.ts`.
 */

import { resolveMenuItemPrice, type TierPriceFields } from './order-type-pricing';

const asFiniteNumber = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Tier price for a single ingredient/customization source object. Accepts
 * either a full ingredient row (snake_case tier fields) or a flat kiosk-style
 * entry ({ name, price }). Returns 0 when no usable price exists — never NaN.
 */
export function resolveIngredientTierPrice(
  source: Record<string, unknown> | null | undefined,
  orderType: string | null | undefined,
): number {
  if (!source) return 0;

  const base = asFiniteNumber(source.price);
  const pickup = asFiniteNumber(source.pickup_price);
  const delivery = asFiniteNumber(source.delivery_price);
  const dineIn = asFiniteNumber(source.dine_in_price);

  switch (orderType) {
    case 'delivery':
      return delivery ?? base ?? 0;
    case 'dine-in':
      return dineIn ?? pickup ?? base ?? 0;
    case 'pickup':
      return pickup ?? base ?? 0;
    default:
      return base ?? 0;
  }
}

interface FlattenedCustomization {
  source: Record<string, unknown>;
  quantity: number;
  isWithout: boolean;
}

const entryIsWithout = (entry: Record<string, unknown>): boolean =>
  entry.isWithout === true || entry.is_without === true || entry.without === true;

const entryQuantity = (entry: Record<string, unknown>): number => {
  const quantity =
    asFiniteNumber(entry.quantity) ?? asFiniteNumber(entry.qty) ?? asFiniteNumber(entry.count) ?? 1;
  return Math.max(1, Math.round(quantity));
};

const flattenEntry = (entry: unknown, isWithout: boolean): FlattenedCustomization[] => {
  if (!entry) return [];
  // Bare string entries (name-only / removed-id lists) carry no price data.
  if (typeof entry !== 'object') return [];
  if (Array.isArray(entry)) {
    return entry.flatMap((value) => flattenEntry(value, isWithout));
  }

  const record = entry as Record<string, unknown>;
  const nested = record.ingredient;
  const source =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : record;

  return [
    {
      source,
      quantity: entryQuantity(record),
      isWithout: isWithout || entryIsWithout(record),
    },
  ];
};

/**
 * Flatten any of the persisted customization shapes into priceable entries:
 * SelectedIngredient arrays (POS cart), object maps keyed by ingredient id
 * (synced orders), kiosk `{ added: [...], removed: [...] }`, or JSON strings
 * of any of those.
 */
export function flattenStoredCustomizations(customizations: unknown): FlattenedCustomization[] {
  let parsed = customizations;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) => flattenEntry(entry, false));
  }

  const record = parsed as Record<string, unknown>;
  const groupedEntries = [record.added, record.selected, record.ingredients, record.items]
    .filter(Array.isArray)
    .flatMap((entries) => flattenEntry(entries, false));
  const removedEntries = Array.isArray(record.removed)
    ? flattenEntry(record.removed, true)
    : [];

  if (groupedEntries.length > 0 || removedEntries.length > 0) {
    return [...groupedEntries, ...removedEntries];
  }

  // Object map keyed by ingredient id/name (synced-order shape).
  return Object.values(record).flatMap((entry) => flattenEntry(entry, false));
}

/**
 * Per-unit price contribution of a line's customizations under an order type.
 * "Without" entries are free removals and never contribute.
 */
export function sumCustomizationUnitPrice(
  customizations: unknown,
  orderType: string | null | undefined,
): number {
  return flattenStoredCustomizations(customizations).reduce((sum, entry) => {
    if (entry.isWithout) return sum;
    return sum + resolveIngredientTierPrice(entry.source, orderType) * entry.quantity;
  }, 0);
}

export interface CartLineUnitPrice {
  /** Bare menu-item tier price (no customizations). */
  basePrice: number;
  /** basePrice + customization contribution, rounded to cents. */
  unitPrice: number;
}

/**
 * Full per-unit price of a cart line under an order type: menu-item tier base
 * plus the line's customization contribution.
 */
export function resolveCartLineUnitPrice(
  menuItem: TierPriceFields | null | undefined,
  customizations: unknown,
  orderType: string | null | undefined,
): CartLineUnitPrice {
  const basePrice = resolveMenuItemPrice(menuItem, orderType);
  const unitPrice = Number(
    (basePrice + sumCustomizationUnitPrice(customizations, orderType)).toFixed(2),
  );
  return { basePrice, unitPrice };
}

/**
 * Reconcile a hydrated unit price against the stored line total. Kiosk-created
 * order_items store `unit_price` as the bare base while `total_price` includes
 * ingredients, so trusting `unit_price` under-prices the line the moment cart
 * math recomputes from it. Reconstruction is upward-only: discounted lines
 * (total below unit x quantity) are left alone.
 */
export function reconcileHydratedUnitPrice(
  unitPrice: number,
  totalPrice: unknown,
  quantity: unknown,
): number {
  const qty = Number(quantity);
  const total = Number(totalPrice);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(total) || total <= 0) {
    return unitPrice;
  }
  // Base-only stored unit prices (the kiosk shape) always carry integer
  // quantities. Fractional weighed quantities amplify the cent-rounding in
  // total_price by 1/qty (e.g. 0.1 kg at 7.97/kg stores total 0.80, and
  // 0.80/0.1 = 8.00) and must never trigger reconstruction.
  if (!Number.isInteger(qty)) {
    return unitPrice;
  }
  const perUnit = total / qty;
  if (perUnit > unitPrice + 0.005) {
    return Number(perUnit.toFixed(2));
  }
  return unitPrice;
}
