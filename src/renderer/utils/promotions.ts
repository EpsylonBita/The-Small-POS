/**
 * Promotions Utilities - POS Promotion Validation & Application
 *
 * Handles promotion validation, discount calculation, and application to orders.
 * Feature: vertical-modules-ui
 * Requirements: 10.5, 10.7
 */

import type { CustomerType } from '../types/orders';

// Promotion types matching the shared types
export type PromotionType = 'percentage' | 'fixed_amount' | 'bogo' | 'tiered' | 'bundle';

export interface TieredDiscount {
  minQuantity: number;
  discountPercentage: number;
}

export interface BundleItem {
  productId?: string;
  variantId?: string;
  quantity: number;
}

export interface PromotionBundle {
  bundleName: string;
  discountValue?: number;
  discountPercentage?: number;
  items: BundleItem[];
}

export interface POSPromotion {
  id: string;
  organizationId: string;
  branchId?: string | null;
  name: string;
  description?: string | null;
  promotionType: PromotionType;
  discountValue?: number | null;
  discountPercentage?: number | null;
  buyQuantity?: number | null;
  getQuantity?: number | null;
  getPercentage?: number | null;
  tieredDiscounts?: TieredDiscount[] | null;
  appliesTo: 'all_products' | 'category' | 'specific_products' | 'variant';
  // Applicable items
  productIds?: string[];
  variantIds?: string[];
  categoryIds?: string[];
  // Scheduling
  startDate: string;
  endDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  dayOfWeek?: number[] | null;
  // Limits
  maxDiscountAmount?: number | null;
  minPurchaseAmount?: number | null;
  maxRedemptionsPerCustomer?: number | null;
  maxTotalRedemptions?: number | null;
  currentRedemptionsCount?: number;
  // Settings
  isActive: boolean;
  isStackable?: boolean;
  priority?: number;
  // Bundles
  bundles?: PromotionBundle[];
}

export interface CartItem {
  productId: string;
  variantId?: string | null;
  categoryId?: string | null;
  quantity: number;
  unitPrice: number;
  name: string;
}

export interface PromotionApplicationResult {
  promotionId: string;
  promotionName: string;
  promotionType: PromotionType;
  discountAmount: number;
  isValid: boolean;
  message?: string;
  appliedToItems?: string[]; // Item IDs that received the discount
}

export interface CartPromotionSummary {
  cartSubtotal: number;
  promotionsApplied: PromotionApplicationResult[];
  totalDiscount: number;
  finalTotal: number;
  bestPromotion?: PromotionApplicationResult | null;
}

/**
 * Check if a promotion is currently valid based on schedule
 */
export function isPromotionScheduleValid(promotion: POSPromotion, now: Date = new Date()): boolean {
  const currentDate = now.toISOString().split('T')[0];
  const currentTime = now.toTimeString().slice(0, 5); // HH:MM
  const currentDayOfWeek = now.getDay();

  // Check date range
  if (promotion.startDate && currentDate < promotion.startDate) {
    return false;
  }
  if (promotion.endDate && currentDate > promotion.endDate) {
    return false;
  }

  // Check time range
  if (promotion.startTime && promotion.endTime) {
    if (currentTime < promotion.startTime || currentTime > promotion.endTime) {
      return false;
    }
  }

  // Check day of week
  if (promotion.dayOfWeek && promotion.dayOfWeek.length > 0) {
    if (!promotion.dayOfWeek.includes(currentDayOfWeek)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a promotion applies to a specific cart item
 */
export function doesPromotionApplyToItem(promotion: POSPromotion, item: CartItem): boolean {
  switch (promotion.appliesTo) {
    case 'all_products':
      return true;

    case 'category':
      return item.categoryId ? (promotion.categoryIds?.includes(item.categoryId) ?? false) : false;

    case 'specific_products':
      return promotion.productIds?.includes(item.productId) ?? false;

    case 'variant':
      return item.variantId ? (promotion.variantIds?.includes(item.variantId) ?? false) : false;

    default:
      return false;
  }
}

/**
 * Calculate discount for percentage promotion
 */
function calculatePercentageDiscount(
  promotion: POSPromotion,
  applicableItems: CartItem[]
): number {
  if (!promotion.discountPercentage) return 0;

  const subtotal = applicableItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  let discount = subtotal * (promotion.discountPercentage / 100);

  // Apply max discount cap if set
  if (promotion.maxDiscountAmount && discount > promotion.maxDiscountAmount) {
    discount = promotion.maxDiscountAmount;
  }

  return discount;
}

/**
 * Calculate discount for fixed amount promotion
 */
function calculateFixedAmountDiscount(
  promotion: POSPromotion,
  applicableItems: CartItem[]
): number {
  if (!promotion.discountValue) return 0;

  const subtotal = applicableItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

  // Don't allow discount to exceed subtotal
  return Math.min(promotion.discountValue, subtotal);
}

/**
 * Calculate discount for BOGO (Buy One Get One) promotion
 */
function calculateBOGODiscount(
  promotion: POSPromotion,
  applicableItems: CartItem[]
): number {
  if (!promotion.buyQuantity || !promotion.getQuantity) return 0;

  const totalQuantity = applicableItems.reduce((sum, item) => sum + item.quantity, 0);
  const setSize = promotion.buyQuantity + promotion.getQuantity;

  // How many complete sets
  const completeSets = Math.floor(totalQuantity / setSize);

  if (completeSets === 0) return 0;

  // Sort items by price ascending to give free/discounted items on cheapest
  const sortedItems = [...applicableItems].sort((a, b) => a.unitPrice - b.unitPrice);

  // Calculate the value of free items
  let freeItemsRemaining = completeSets * promotion.getQuantity;
  let discount = 0;
  const getPercentage = promotion.getPercentage ?? 100; // Default 100% = free

  for (const item of sortedItems) {
    if (freeItemsRemaining <= 0) break;

    const freeFromThisItem = Math.min(freeItemsRemaining, item.quantity);
    discount += freeFromThisItem * item.unitPrice * (getPercentage / 100);
    freeItemsRemaining -= freeFromThisItem;
  }

  // Apply max discount cap if set
  if (promotion.maxDiscountAmount && discount > promotion.maxDiscountAmount) {
    discount = promotion.maxDiscountAmount;
  }

  return discount;
}

/**
 * Calculate discount for tiered quantity promotion
 */
function calculateTieredDiscount(
  promotion: POSPromotion,
  applicableItems: CartItem[]
): number {
  if (!promotion.tieredDiscounts || promotion.tieredDiscounts.length === 0) return 0;

  const totalQuantity = applicableItems.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = applicableItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

  // Sort tiers by minQuantity descending to find the best applicable tier
  const sortedTiers = [...promotion.tieredDiscounts].sort((a, b) => b.minQuantity - a.minQuantity);

  // Find the applicable tier
  const applicableTier = sortedTiers.find(tier => totalQuantity >= tier.minQuantity);

  if (!applicableTier) return 0;

  let discount = subtotal * (applicableTier.discountPercentage / 100);

  // Apply max discount cap if set
  if (promotion.maxDiscountAmount && discount > promotion.maxDiscountAmount) {
    discount = promotion.maxDiscountAmount;
  }

  return discount;
}

/**
 * Calculate discount for bundle promotion
 */
function calculateBundleDiscount(
  promotion: POSPromotion,
  cartItems: CartItem[]
): number {
  if (!promotion.bundles || promotion.bundles.length === 0) return 0;

  let totalDiscount = 0;

  for (const bundle of promotion.bundles) {
    // Check if all bundle items are present in the cart
    const bundleItemsInCart = bundle.items.every(bundleItem => {
      const cartItem = cartItems.find(ci =>
        ci.productId === bundleItem.productId ||
        (bundleItem.variantId && ci.variantId === bundleItem.variantId)
      );
      return cartItem && cartItem.quantity >= bundleItem.quantity;
    });

    if (!bundleItemsInCart) continue;

    // Calculate bundle items value
    let bundleValue = 0;
    for (const bundleItem of bundle.items) {
      const cartItem = cartItems.find(ci =>
        ci.productId === bundleItem.productId ||
        (bundleItem.variantId && ci.variantId === bundleItem.variantId)
      );
      if (cartItem) {
        bundleValue += cartItem.unitPrice * bundleItem.quantity;
      }
    }

    // Apply bundle discount
    if (bundle.discountValue) {
      totalDiscount += Math.min(bundle.discountValue, bundleValue);
    } else if (bundle.discountPercentage) {
      totalDiscount += bundleValue * (bundle.discountPercentage / 100);
    }
  }

  // Apply max discount cap if set
  if (promotion.maxDiscountAmount && totalDiscount > promotion.maxDiscountAmount) {
    totalDiscount = promotion.maxDiscountAmount;
  }

  return totalDiscount;
}

/**
 * Apply a single promotion to cart items
 */
export function applyPromotion(
  promotion: POSPromotion,
  cartItems: CartItem[],
  customerId?: string | null
): PromotionApplicationResult {
  // Check if promotion is active
  if (!promotion.isActive) {
    return {
      promotionId: promotion.id,
      promotionName: promotion.name,
      promotionType: promotion.promotionType,
      discountAmount: 0,
      isValid: false,
      message: 'Promotion is not active',
    };
  }

  // Check schedule
  if (!isPromotionScheduleValid(promotion)) {
    return {
      promotionId: promotion.id,
      promotionName: promotion.name,
      promotionType: promotion.promotionType,
      discountAmount: 0,
      isValid: false,
      message: 'Promotion is not valid at this time',
    };
  }

  // Check redemption limits
  if (
    promotion.maxTotalRedemptions &&
    (promotion.currentRedemptionsCount ?? 0) >= promotion.maxTotalRedemptions
  ) {
    return {
      promotionId: promotion.id,
      promotionName: promotion.name,
      promotionType: promotion.promotionType,
      discountAmount: 0,
      isValid: false,
      message: 'Promotion has reached maximum redemptions',
    };
  }

  // Get applicable items
  const applicableItems = cartItems.filter(item => doesPromotionApplyToItem(promotion, item));

  if (applicableItems.length === 0 && promotion.promotionType !== 'bundle') {
    return {
      promotionId: promotion.id,
      promotionName: promotion.name,
      promotionType: promotion.promotionType,
      discountAmount: 0,
      isValid: false,
      message: 'No items in cart qualify for this promotion',
    };
  }

  // Check minimum purchase amount
  const cartSubtotal = cartItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  if (promotion.minPurchaseAmount && cartSubtotal < promotion.minPurchaseAmount) {
    return {
      promotionId: promotion.id,
      promotionName: promotion.name,
      promotionType: promotion.promotionType,
      discountAmount: 0,
      isValid: false,
      message: `Minimum purchase of ${promotion.minPurchaseAmount} required`,
    };
  }

  // Calculate discount based on type
  let discountAmount = 0;
  switch (promotion.promotionType) {
    case 'percentage':
      discountAmount = calculatePercentageDiscount(promotion, applicableItems);
      break;
    case 'fixed_amount':
      discountAmount = calculateFixedAmountDiscount(promotion, applicableItems);
      break;
    case 'bogo':
      discountAmount = calculateBOGODiscount(promotion, applicableItems);
      break;
    case 'tiered':
      discountAmount = calculateTieredDiscount(promotion, applicableItems);
      break;
    case 'bundle':
      discountAmount = calculateBundleDiscount(promotion, cartItems);
      break;
  }

  return {
    promotionId: promotion.id,
    promotionName: promotion.name,
    promotionType: promotion.promotionType,
    discountAmount: Math.round(discountAmount * 100) / 100, // Round to 2 decimals
    isValid: discountAmount > 0,
    appliedToItems: applicableItems.map(item => item.productId),
    message: discountAmount > 0 ? 'Promotion applied successfully' : 'No discount applicable',
  };
}

/**
 * Find the best promotion for a cart
 */
export function findBestPromotion(
  promotions: POSPromotion[],
  cartItems: CartItem[],
  customerId?: string | null
): PromotionApplicationResult | null {
  if (promotions.length === 0 || cartItems.length === 0) return null;

  // Get non-stackable promotions sorted by priority
  const nonStackablePromotions = promotions
    .filter(p => !p.isStackable)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  let bestResult: PromotionApplicationResult | null = null;

  for (const promotion of nonStackablePromotions) {
    const result = applyPromotion(promotion, cartItems, customerId);
    if (result.isValid && result.discountAmount > (bestResult?.discountAmount ?? 0)) {
      bestResult = result;
    }
  }

  return bestResult;
}

/**
 * Calculate all applicable promotions for a cart
 */
export function calculateCartPromotions(
  promotions: POSPromotion[],
  cartItems: CartItem[],
  customerId?: string | null
): CartPromotionSummary {
  const cartSubtotal = cartItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

  if (promotions.length === 0 || cartItems.length === 0) {
    return {
      cartSubtotal,
      promotionsApplied: [],
      totalDiscount: 0,
      finalTotal: cartSubtotal,
      bestPromotion: null,
    };
  }

  // Get stackable promotions
  const stackablePromotions = promotions.filter(p => p.isStackable);

  // Apply stackable promotions
  const stackableResults: PromotionApplicationResult[] = [];
  for (const promotion of stackablePromotions) {
    const result = applyPromotion(promotion, cartItems, customerId);
    if (result.isValid) {
      stackableResults.push(result);
    }
  }

  // Find best non-stackable promotion
  const bestNonStackable = findBestPromotion(promotions, cartItems, customerId);

  // Calculate totals
  const stackableDiscount = stackableResults.reduce((sum, r) => sum + r.discountAmount, 0);
  const nonStackableDiscount = bestNonStackable?.discountAmount ?? 0;

  // Use the better option: stackable total or best non-stackable
  let totalDiscount: number;
  let appliedPromotions: PromotionApplicationResult[];
  let bestPromotion: PromotionApplicationResult | null;

  if (stackableDiscount >= nonStackableDiscount) {
    totalDiscount = stackableDiscount;
    appliedPromotions = stackableResults;
    bestPromotion = stackableResults.length > 0 ? stackableResults[0] : null;
  } else {
    totalDiscount = nonStackableDiscount;
    appliedPromotions = bestNonStackable ? [bestNonStackable] : [];
    bestPromotion = bestNonStackable;
  }

  return {
    cartSubtotal,
    promotionsApplied: appliedPromotions,
    totalDiscount: Math.round(totalDiscount * 100) / 100,
    finalTotal: Math.round((cartSubtotal - totalDiscount) * 100) / 100,
    bestPromotion,
  };
}

/**
 * Format promotion badge for display
 */
export function getPromotionBadge(promotionType: PromotionType): {
  text: string;
  color: 'red' | 'green' | 'blue' | 'purple' | 'orange';
} {
  switch (promotionType) {
    case 'percentage':
      return { text: '% Off', color: 'red' };
    case 'fixed_amount':
      return { text: 'Fixed', color: 'green' };
    case 'bogo':
      return { text: 'BOGO', color: 'blue' };
    case 'tiered':
      return { text: 'Tiered', color: 'purple' };
    case 'bundle':
      return { text: 'Bundle', color: 'orange' };
    default:
      return { text: 'Promo', color: 'green' };
  }
}

/**
 * Format discount display string
 */
export function formatPromotionDiscount(promotion: POSPromotion): string {
  switch (promotion.promotionType) {
    case 'percentage':
      return `${promotion.discountPercentage}% off`;
    case 'fixed_amount':
      return `€${promotion.discountValue?.toFixed(2)} off`;
    case 'bogo':
      const getPercent = promotion.getPercentage ?? 100;
      if (getPercent === 100) {
        return `Buy ${promotion.buyQuantity}, get ${promotion.getQuantity} free`;
      }
      return `Buy ${promotion.buyQuantity}, get ${promotion.getQuantity} at ${100 - getPercent}% off`;
    case 'tiered':
      return 'Quantity discounts';
    case 'bundle':
      return 'Bundle deal';
    default:
      return 'Special offer';
  }
}
