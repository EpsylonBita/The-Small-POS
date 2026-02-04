/**
 * Pricing Utilities - POS Tiered Pricing Support
 *
 * Handles tiered pricing calculations for retail, wholesale, and member customers.
 * Feature: vertical-modules-ui
 * Requirements: 10.1, 10.3
 */

export type CustomerType = 'retail' | 'wholesale' | 'member';

export interface TieredPricingProduct {
  price: number;
  wholesalePrice?: number | null;
  memberPrice?: number | null;
  minWholesaleQuantity?: number | null;
}

export interface TieredPricingVariant {
  priceAdjustment?: number | null;
  wholesalePriceAdjustment?: number | null;
  memberPriceAdjustment?: number | null;
}

export interface PriceCalculationResult {
  unitPrice: number;
  originalPrice: number;
  priceType: CustomerType;
  discountPercentage: number;
  appliedTier: string;
}

/**
 * Calculate the effective price for a product based on customer type and quantity
 */
export function calculateTieredPrice(
  product: TieredPricingProduct,
  customerType: CustomerType,
  quantity: number = 1,
  variant?: TieredPricingVariant | null
): PriceCalculationResult {
  const basePrice = product.price;
  let unitPrice = basePrice;
  let priceType: CustomerType = 'retail';
  let appliedTier = 'Retail Price';

  // Determine base price based on customer type
  switch (customerType) {
    case 'wholesale':
      // Wholesale pricing requires minimum quantity
      if (
        product.wholesalePrice !== null &&
        product.wholesalePrice !== undefined &&
        product.wholesalePrice > 0
      ) {
        const minQty = product.minWholesaleQuantity || 1;
        if (quantity >= minQty) {
          unitPrice = product.wholesalePrice;
          priceType = 'wholesale';
          appliedTier = `Wholesale (min ${minQty} units)`;
        } else {
          // Fall back to retail if quantity not met
          appliedTier = `Retail (need ${minQty} for wholesale)`;
        }
      }
      break;

    case 'member':
      // Member pricing has no quantity requirement
      if (
        product.memberPrice !== null &&
        product.memberPrice !== undefined &&
        product.memberPrice > 0
      ) {
        unitPrice = product.memberPrice;
        priceType = 'member';
        appliedTier = 'Member Price';
      }
      break;

    case 'retail':
    default:
      // Retail is the base price, no changes needed
      break;
  }

  // Apply variant price adjustments if present
  if (variant) {
    let adjustment = 0;

    switch (priceType) {
      case 'wholesale':
        adjustment = variant.wholesalePriceAdjustment ?? variant.priceAdjustment ?? 0;
        break;
      case 'member':
        adjustment = variant.memberPriceAdjustment ?? variant.priceAdjustment ?? 0;
        break;
      default:
        adjustment = variant.priceAdjustment ?? 0;
    }

    unitPrice += adjustment;
  }

  // Calculate discount percentage
  const discountPercentage =
    basePrice > 0 ? Math.round(((basePrice - unitPrice) / basePrice) * 100) : 0;

  return {
    unitPrice: Math.max(0, unitPrice), // Ensure non-negative
    originalPrice: basePrice,
    priceType,
    discountPercentage: Math.max(0, discountPercentage),
    appliedTier,
  };
}

/**
 * Get the display price for a product (for showing in UI)
 */
export function getDisplayPrice(
  product: TieredPricingProduct,
  customerType: CustomerType = 'retail'
): number {
  const result = calculateTieredPrice(product, customerType, 1);
  return result.unitPrice;
}

/**
 * Check if a product has tiered pricing available
 */
export function hasTieredPricing(product: TieredPricingProduct): boolean {
  return (
    (product.wholesalePrice !== null && product.wholesalePrice !== undefined && product.wholesalePrice > 0) ||
    (product.memberPrice !== null && product.memberPrice !== undefined && product.memberPrice > 0)
  );
}

/**
 * Get all available price tiers for a product
 */
export function getAvailablePriceTiers(
  product: TieredPricingProduct
): Array<{ type: CustomerType; price: number; label: string }> {
  const tiers: Array<{ type: CustomerType; price: number; label: string }> = [
    { type: 'retail', price: product.price, label: 'Retail' },
  ];

  if (product.memberPrice !== null && product.memberPrice !== undefined && product.memberPrice > 0) {
    tiers.push({ type: 'member', price: product.memberPrice, label: 'Member' });
  }

  if (product.wholesalePrice !== null && product.wholesalePrice !== undefined && product.wholesalePrice > 0) {
    const label = product.minWholesaleQuantity
      ? `Wholesale (min ${product.minWholesaleQuantity})`
      : 'Wholesale';
    tiers.push({ type: 'wholesale', price: product.wholesalePrice, label });
  }

  return tiers;
}

/**
 * Calculate line item total with tiered pricing
 */
export function calculateLineItemTotal(
  product: TieredPricingProduct,
  customerType: CustomerType,
  quantity: number,
  variant?: TieredPricingVariant | null
): {
  subtotal: number;
  unitPrice: number;
  savings: number;
  appliedTier: string;
} {
  const priceResult = calculateTieredPrice(product, customerType, quantity, variant);

  const subtotal = priceResult.unitPrice * quantity;
  const retailSubtotal = priceResult.originalPrice * quantity;
  const savings = Math.max(0, retailSubtotal - subtotal);

  return {
    subtotal,
    unitPrice: priceResult.unitPrice,
    savings,
    appliedTier: priceResult.appliedTier,
  };
}

/**
 * Format price tier badge text
 */
export function getPriceTierBadge(customerType: CustomerType): {
  text: string;
  color: 'green' | 'blue' | 'purple' | 'gray';
} {
  switch (customerType) {
    case 'wholesale':
      return { text: 'Wholesale', color: 'blue' };
    case 'member':
      return { text: 'Member', color: 'purple' };
    case 'retail':
    default:
      return { text: 'Retail', color: 'gray' };
  }
}
