/**
 * Property-Based Tests for Promotions
 * Feature: vertical-modules-ui
 * Requirements: 10.5, 10.7
 */

import {
  isPromotionScheduleValid,
  doesPromotionApplyToItem,
  applyPromotion,
  findBestPromotion,
  calculateCartPromotions,
  getPromotionBadge,
  formatPromotionDiscount,
  type POSPromotion,
  type CartItem,
} from '../renderer/utils/promotions';

describe('Promotions Utilities', () => {
  // Sample promotions for testing
  const percentagePromotion: POSPromotion = {
    id: 'promo-1',
    organizationId: 'org-1',
    name: '20% Off Everything',
    promotionType: 'percentage',
    discountPercentage: 20,
    appliesTo: 'all_products',
    startDate: '2024-01-01',
    endDate: '2030-12-31',
    isActive: true,
  };

  const fixedAmountPromotion: POSPromotion = {
    id: 'promo-2',
    organizationId: 'org-1',
    name: '$10 Off',
    promotionType: 'fixed_amount',
    discountValue: 10,
    appliesTo: 'all_products',
    startDate: '2024-01-01',
    endDate: '2030-12-31',
    isActive: true,
  };

  const bogoPromotion: POSPromotion = {
    id: 'promo-3',
    organizationId: 'org-1',
    name: 'Buy 2 Get 1 Free',
    promotionType: 'bogo',
    buyQuantity: 2,
    getQuantity: 1,
    getPercentage: 100,
    appliesTo: 'specific_products',
    productIds: ['product-1', 'product-2'],
    startDate: '2024-01-01',
    endDate: '2030-12-31',
    isActive: true,
  };

  const tieredPromotion: POSPromotion = {
    id: 'promo-4',
    organizationId: 'org-1',
    name: 'Bulk Discount',
    promotionType: 'tiered',
    tieredDiscounts: [
      { minQuantity: 5, discountPercentage: 5 },
      { minQuantity: 10, discountPercentage: 10 },
      { minQuantity: 20, discountPercentage: 15 },
    ],
    appliesTo: 'all_products',
    startDate: '2024-01-01',
    endDate: '2030-12-31',
    isActive: true,
  };

  const categoryPromotion: POSPromotion = {
    id: 'promo-5',
    organizationId: 'org-1',
    name: 'Electronics Sale',
    promotionType: 'percentage',
    discountPercentage: 15,
    appliesTo: 'category',
    categoryIds: ['cat-electronics'],
    startDate: '2024-01-01',
    endDate: '2030-12-31',
    isActive: true,
  };

  // Sample cart items
  const sampleCartItems: CartItem[] = [
    { productId: 'product-1', quantity: 3, unitPrice: 50, name: 'Product A' },
    { productId: 'product-2', quantity: 2, unitPrice: 30, name: 'Product B' },
    { productId: 'product-3', categoryId: 'cat-electronics', quantity: 1, unitPrice: 100, name: 'Product C' },
  ];

  describe('isPromotionScheduleValid', () => {
    it('should return true for active promotion within date range', () => {
      expect(isPromotionScheduleValid(percentagePromotion)).toBe(true);
    });

    it('should return false for promotion not yet started', () => {
      const futurePromo: POSPromotion = {
        ...percentagePromotion,
        startDate: '2099-01-01',
      };
      expect(isPromotionScheduleValid(futurePromo)).toBe(false);
    });

    it('should return false for expired promotion', () => {
      const expiredPromo: POSPromotion = {
        ...percentagePromotion,
        endDate: '2020-01-01',
      };
      expect(isPromotionScheduleValid(expiredPromo)).toBe(false);
    });

    it('should check day of week when specified', () => {
      const now = new Date();
      const currentDayOfWeek = now.getDay();
      const otherDay = (currentDayOfWeek + 1) % 7;

      const wrongDayPromo: POSPromotion = {
        ...percentagePromotion,
        dayOfWeek: [otherDay], // Only valid on a different day
      };
      expect(isPromotionScheduleValid(wrongDayPromo)).toBe(false);

      const rightDayPromo: POSPromotion = {
        ...percentagePromotion,
        dayOfWeek: [currentDayOfWeek],
      };
      expect(isPromotionScheduleValid(rightDayPromo)).toBe(true);
    });
  });

  describe('doesPromotionApplyToItem', () => {
    it('should return true for all_products promotion', () => {
      const item: CartItem = { productId: 'any-product', quantity: 1, unitPrice: 50, name: 'Any' };
      expect(doesPromotionApplyToItem(percentagePromotion, item)).toBe(true);
    });

    it('should check productIds for specific_products promotion', () => {
      const matchingItem: CartItem = { productId: 'product-1', quantity: 1, unitPrice: 50, name: 'P1' };
      const nonMatchingItem: CartItem = { productId: 'product-99', quantity: 1, unitPrice: 50, name: 'P99' };

      expect(doesPromotionApplyToItem(bogoPromotion, matchingItem)).toBe(true);
      expect(doesPromotionApplyToItem(bogoPromotion, nonMatchingItem)).toBe(false);
    });

    it('should check categoryId for category promotion', () => {
      const matchingItem: CartItem = {
        productId: 'p1',
        categoryId: 'cat-electronics',
        quantity: 1,
        unitPrice: 50,
        name: 'E1',
      };
      const nonMatchingItem: CartItem = {
        productId: 'p2',
        categoryId: 'cat-food',
        quantity: 1,
        unitPrice: 50,
        name: 'F1',
      };

      expect(doesPromotionApplyToItem(categoryPromotion, matchingItem)).toBe(true);
      expect(doesPromotionApplyToItem(categoryPromotion, nonMatchingItem)).toBe(false);
    });
  });

  describe('applyPromotion - Percentage', () => {
    it('should calculate percentage discount correctly', () => {
      const result = applyPromotion(percentagePromotion, sampleCartItems);
      // Total cart: (3*50) + (2*30) + (1*100) = 150 + 60 + 100 = 310
      // 20% of 310 = 62
      expect(result.isValid).toBe(true);
      expect(result.discountAmount).toBe(62);
    });

    it('should respect max discount amount', () => {
      const cappedPromo: POSPromotion = {
        ...percentagePromotion,
        maxDiscountAmount: 50,
      };
      const result = applyPromotion(cappedPromo, sampleCartItems);
      expect(result.discountAmount).toBe(50);
    });
  });

  describe('applyPromotion - Fixed Amount', () => {
    it('should apply fixed discount', () => {
      const result = applyPromotion(fixedAmountPromotion, sampleCartItems);
      expect(result.isValid).toBe(true);
      expect(result.discountAmount).toBe(10);
    });

    it('should not exceed cart subtotal', () => {
      const bigDiscount: POSPromotion = {
        ...fixedAmountPromotion,
        discountValue: 1000, // More than cart total
      };
      const result = applyPromotion(bigDiscount, sampleCartItems);
      expect(result.discountAmount).toBe(310); // Cart total
    });
  });

  describe('applyPromotion - BOGO', () => {
    it('should calculate BOGO discount correctly', () => {
      // product-1 (3 units) and product-2 (2 units) = 5 applicable items
      // Buy 2 get 1: 5 items = 1 complete set (3 items) + 2 leftover
      // Free items: 1 (cheapest = $30 from product-2)
      const result = applyPromotion(bogoPromotion, sampleCartItems);
      expect(result.isValid).toBe(true);
      expect(result.discountAmount).toBe(30);
    });

    it('should return 0 if not enough items for BOGO', () => {
      const smallCart: CartItem[] = [
        { productId: 'product-1', quantity: 2, unitPrice: 50, name: 'P1' },
      ];
      const result = applyPromotion(bogoPromotion, smallCart);
      // 2 items, need 3 for one complete set
      expect(result.discountAmount).toBe(0);
    });
  });

  describe('applyPromotion - Tiered', () => {
    it('should apply correct tier for quantity', () => {
      // 6 total items in cart = 5% tier
      const result = applyPromotion(tieredPromotion, sampleCartItems);
      // Cart total: 310, 5% = 15.5
      expect(result.discountAmount).toBe(15.5);
    });

    it('should apply higher tier for larger quantity', () => {
      const largeCart: CartItem[] = [
        { productId: 'product-1', quantity: 20, unitPrice: 10, name: 'P1' },
      ];
      // 20 items = 15% tier, $200 total, 15% = $30
      const result = applyPromotion(tieredPromotion, largeCart);
      expect(result.discountAmount).toBe(30);
    });
  });

  describe('applyPromotion - Validation', () => {
    it('should reject inactive promotion', () => {
      const inactivePromo: POSPromotion = {
        ...percentagePromotion,
        isActive: false,
      };
      const result = applyPromotion(inactivePromo, sampleCartItems);
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('not active');
    });

    it('should check minimum purchase amount', () => {
      const minPurchasePromo: POSPromotion = {
        ...percentagePromotion,
        minPurchaseAmount: 500,
      };
      const result = applyPromotion(minPurchasePromo, sampleCartItems);
      // Cart total is 310, below 500
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('Minimum purchase');
    });

    it('should check redemption limits', () => {
      const maxedOutPromo: POSPromotion = {
        ...percentagePromotion,
        maxTotalRedemptions: 100,
        currentRedemptionsCount: 100,
      };
      const result = applyPromotion(maxedOutPromo, sampleCartItems);
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('maximum redemptions');
    });
  });

  describe('findBestPromotion', () => {
    it('should find the promotion with highest discount', () => {
      const promotions = [
        percentagePromotion, // 20% = 62
        fixedAmountPromotion, // $10
      ];
      const best = findBestPromotion(promotions, sampleCartItems);
      expect(best?.promotionId).toBe('promo-1'); // percentage gives higher discount
    });

    it('should return null for empty promotions', () => {
      const best = findBestPromotion([], sampleCartItems);
      expect(best).toBeNull();
    });

    it('should return null for empty cart', () => {
      const best = findBestPromotion([percentagePromotion], []);
      expect(best).toBeNull();
    });
  });

  describe('calculateCartPromotions', () => {
    it('should calculate final total correctly', () => {
      const result = calculateCartPromotions([percentagePromotion], sampleCartItems);
      expect(result.cartSubtotal).toBe(310);
      expect(result.totalDiscount).toBe(62);
      expect(result.finalTotal).toBe(248);
    });

    it('should handle stackable promotions', () => {
      const stackable1: POSPromotion = {
        ...percentagePromotion,
        id: 'stack-1',
        discountPercentage: 10,
        isStackable: true,
      };
      const stackable2: POSPromotion = {
        ...fixedAmountPromotion,
        id: 'stack-2',
        discountValue: 5,
        isStackable: true,
      };

      const result = calculateCartPromotions([stackable1, stackable2], sampleCartItems);
      // Should apply both: 10% of 310 = 31, plus $5 = 36
      expect(result.totalDiscount).toBe(36);
      expect(result.promotionsApplied).toHaveLength(2);
    });

    it('should choose between stackable and non-stackable', () => {
      const stackable: POSPromotion = {
        ...fixedAmountPromotion,
        id: 'stack-1',
        discountValue: 5,
        isStackable: true,
      };
      const nonStackable: POSPromotion = {
        ...percentagePromotion, // 20% = $62
        isStackable: false,
      };

      const result = calculateCartPromotions([stackable, nonStackable], sampleCartItems);
      // Non-stackable ($62) > stackable ($5), should use non-stackable
      expect(result.totalDiscount).toBe(62);
    });
  });

  describe('getPromotionBadge', () => {
    it('should return correct badge for percentage', () => {
      const badge = getPromotionBadge('percentage');
      expect(badge.text).toBe('% Off');
      expect(badge.color).toBe('red');
    });

    it('should return correct badge for BOGO', () => {
      const badge = getPromotionBadge('bogo');
      expect(badge.text).toBe('BOGO');
      expect(badge.color).toBe('blue');
    });

    it('should return correct badge for bundle', () => {
      const badge = getPromotionBadge('bundle');
      expect(badge.text).toBe('Bundle');
      expect(badge.color).toBe('orange');
    });
  });

  describe('formatPromotionDiscount', () => {
    it('should format percentage discount', () => {
      const text = formatPromotionDiscount(percentagePromotion);
      expect(text).toBe('20% off');
    });

    it('should format fixed amount discount', () => {
      const text = formatPromotionDiscount(fixedAmountPromotion);
      expect(text).toBe('€10.00 off');
    });

    it('should format BOGO promotion', () => {
      const text = formatPromotionDiscount(bogoPromotion);
      expect(text).toContain('Buy 2');
      expect(text).toContain('get 1 free');
    });
  });

  describe('Property: Discount bounds', () => {
    // Property: discount should never exceed cart total
    it('discount should never exceed cart subtotal', () => {
      const promotions: POSPromotion[] = [
        percentagePromotion,
        fixedAmountPromotion,
        bogoPromotion,
        tieredPromotion,
      ];

      for (const promo of promotions) {
        const result = applyPromotion(promo, sampleCartItems);
        if (result.isValid) {
          expect(result.discountAmount).toBeLessThanOrEqual(310);
        }
      }
    });

    // Property: discount should be non-negative
    it('discount should always be non-negative', () => {
      const promotions: POSPromotion[] = [
        percentagePromotion,
        fixedAmountPromotion,
        bogoPromotion,
        tieredPromotion,
      ];

      for (const promo of promotions) {
        const result = applyPromotion(promo, sampleCartItems);
        expect(result.discountAmount).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Property: Final total consistency', () => {
    // Property: finalTotal = cartSubtotal - totalDiscount
    it('final total should equal subtotal minus discount', () => {
      const result = calculateCartPromotions([percentagePromotion], sampleCartItems);
      expect(result.finalTotal).toBe(result.cartSubtotal - result.totalDiscount);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty cart', () => {
      const result = calculateCartPromotions([percentagePromotion], []);
      expect(result.cartSubtotal).toBe(0);
      expect(result.totalDiscount).toBe(0);
      expect(result.finalTotal).toBe(0);
    });

    it('should handle zero quantity items', () => {
      const zeroCart: CartItem[] = [
        { productId: 'p1', quantity: 0, unitPrice: 50, name: 'P1' },
      ];
      const result = calculateCartPromotions([percentagePromotion], zeroCart);
      expect(result.cartSubtotal).toBe(0);
    });

    it('should handle zero price items', () => {
      const freeCart: CartItem[] = [
        { productId: 'p1', quantity: 5, unitPrice: 0, name: 'Free Item' },
      ];
      const result = applyPromotion(percentagePromotion, freeCart);
      expect(result.discountAmount).toBe(0);
    });
  });
});
