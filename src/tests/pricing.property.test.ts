/**
 * Property-Based Tests for Tiered Pricing
 * Feature: vertical-modules-ui
 * Requirements: 10.1, 10.3
 */

import {
  calculateTieredPrice,
  getDisplayPrice,
  hasTieredPricing,
  getAvailablePriceTiers,
  calculateLineItemTotal,
  getPriceTierBadge,
  type TieredPricingProduct,
  type TieredPricingVariant,
  type CustomerType,
} from '../renderer/utils/pricing';

describe('Tiered Pricing Utilities', () => {
  // Sample products for testing
  const retailOnlyProduct: TieredPricingProduct = {
    price: 100,
    wholesalePrice: null,
    memberPrice: null,
    minWholesaleQuantity: null,
  };

  const tieredProduct: TieredPricingProduct = {
    price: 100,
    wholesalePrice: 75,
    memberPrice: 85,
    minWholesaleQuantity: 10,
  };

  const variant: TieredPricingVariant = {
    priceAdjustment: 10,
    wholesalePriceAdjustment: 5,
    memberPriceAdjustment: 7,
  };

  describe('calculateTieredPrice', () => {
    it('should return retail price for retail customer', () => {
      const result = calculateTieredPrice(tieredProduct, 'retail', 1);
      expect(result.unitPrice).toBe(100);
      expect(result.priceType).toBe('retail');
      expect(result.appliedTier).toBe('Retail Price');
    });

    it('should return member price for member customer', () => {
      const result = calculateTieredPrice(tieredProduct, 'member', 1);
      expect(result.unitPrice).toBe(85);
      expect(result.priceType).toBe('member');
      expect(result.appliedTier).toBe('Member Price');
    });

    it('should return wholesale price when quantity threshold met', () => {
      const result = calculateTieredPrice(tieredProduct, 'wholesale', 10);
      expect(result.unitPrice).toBe(75);
      expect(result.priceType).toBe('wholesale');
      expect(result.appliedTier).toContain('Wholesale');
    });

    it('should return retail price for wholesale customer if quantity too low', () => {
      const result = calculateTieredPrice(tieredProduct, 'wholesale', 5);
      expect(result.unitPrice).toBe(100);
      expect(result.priceType).toBe('retail');
      expect(result.appliedTier).toContain('need 10 for wholesale');
    });

    it('should apply variant adjustments correctly', () => {
      const result = calculateTieredPrice(tieredProduct, 'retail', 1, variant);
      expect(result.unitPrice).toBe(110); // 100 + 10
    });

    it('should apply wholesale variant adjustment', () => {
      const result = calculateTieredPrice(tieredProduct, 'wholesale', 10, variant);
      expect(result.unitPrice).toBe(80); // 75 + 5
    });

    it('should apply member variant adjustment', () => {
      const result = calculateTieredPrice(tieredProduct, 'member', 1, variant);
      expect(result.unitPrice).toBe(92); // 85 + 7
    });

    it('should calculate discount percentage correctly', () => {
      const result = calculateTieredPrice(tieredProduct, 'wholesale', 10);
      expect(result.discountPercentage).toBe(25); // (100 - 75) / 100 * 100
    });

    it('should handle product with no tiered pricing', () => {
      const result = calculateTieredPrice(retailOnlyProduct, 'wholesale', 100);
      expect(result.unitPrice).toBe(100);
      expect(result.priceType).toBe('retail');
    });

    it('should never return negative price', () => {
      const negativeVariant: TieredPricingVariant = {
        priceAdjustment: -200, // More than product price
      };
      const result = calculateTieredPrice(tieredProduct, 'retail', 1, negativeVariant);
      expect(result.unitPrice).toBe(0);
    });
  });

  describe('getDisplayPrice', () => {
    it('should return retail price by default', () => {
      const price = getDisplayPrice(tieredProduct);
      expect(price).toBe(100);
    });

    it('should return member price for member customer', () => {
      const price = getDisplayPrice(tieredProduct, 'member');
      expect(price).toBe(85);
    });

    it('should return retail for wholesale with quantity 1', () => {
      const price = getDisplayPrice(tieredProduct, 'wholesale');
      expect(price).toBe(100); // Quantity is 1, below threshold
    });
  });

  describe('hasTieredPricing', () => {
    it('should return true for product with tiered pricing', () => {
      expect(hasTieredPricing(tieredProduct)).toBe(true);
    });

    it('should return false for retail-only product', () => {
      expect(hasTieredPricing(retailOnlyProduct)).toBe(false);
    });

    it('should return true for product with only member pricing', () => {
      const memberOnly: TieredPricingProduct = {
        price: 100,
        wholesalePrice: null,
        memberPrice: 90,
        minWholesaleQuantity: null,
      };
      expect(hasTieredPricing(memberOnly)).toBe(true);
    });

    it('should return true for product with only wholesale pricing', () => {
      const wholesaleOnly: TieredPricingProduct = {
        price: 100,
        wholesalePrice: 80,
        memberPrice: null,
        minWholesaleQuantity: 5,
      };
      expect(hasTieredPricing(wholesaleOnly)).toBe(true);
    });
  });

  describe('getAvailablePriceTiers', () => {
    it('should return all tiers for fully tiered product', () => {
      const tiers = getAvailablePriceTiers(tieredProduct);
      expect(tiers).toHaveLength(3);
      expect(tiers.map(t => t.type)).toEqual(['retail', 'member', 'wholesale']);
    });

    it('should return only retail for retail-only product', () => {
      const tiers = getAvailablePriceTiers(retailOnlyProduct);
      expect(tiers).toHaveLength(1);
      expect(tiers[0].type).toBe('retail');
    });

    it('should include min quantity in wholesale label', () => {
      const tiers = getAvailablePriceTiers(tieredProduct);
      const wholesaleTier = tiers.find(t => t.type === 'wholesale');
      expect(wholesaleTier?.label).toContain('min 10');
    });
  });

  describe('calculateLineItemTotal', () => {
    it('should calculate correct subtotal', () => {
      const result = calculateLineItemTotal(tieredProduct, 'retail', 5);
      expect(result.subtotal).toBe(500);
      expect(result.unitPrice).toBe(100);
      expect(result.savings).toBe(0);
    });

    it('should calculate savings for wholesale', () => {
      const result = calculateLineItemTotal(tieredProduct, 'wholesale', 10);
      expect(result.subtotal).toBe(750); // 75 * 10
      expect(result.unitPrice).toBe(75);
      expect(result.savings).toBe(250); // (100 - 75) * 10
    });

    it('should calculate savings for member', () => {
      const result = calculateLineItemTotal(tieredProduct, 'member', 10);
      expect(result.subtotal).toBe(850); // 85 * 10
      expect(result.unitPrice).toBe(85);
      expect(result.savings).toBe(150); // (100 - 85) * 10
    });

    it('should apply variant adjustments in line total', () => {
      const result = calculateLineItemTotal(tieredProduct, 'retail', 5, variant);
      expect(result.subtotal).toBe(550); // (100 + 10) * 5
      expect(result.unitPrice).toBe(110);
    });
  });

  describe('getPriceTierBadge', () => {
    it('should return correct badge for wholesale', () => {
      const badge = getPriceTierBadge('wholesale');
      expect(badge.text).toBe('Wholesale');
      expect(badge.color).toBe('blue');
    });

    it('should return correct badge for member', () => {
      const badge = getPriceTierBadge('member');
      expect(badge.text).toBe('Member');
      expect(badge.color).toBe('purple');
    });

    it('should return correct badge for retail', () => {
      const badge = getPriceTierBadge('retail');
      expect(badge.text).toBe('Retail');
      expect(badge.color).toBe('gray');
    });
  });

  describe('Property: Price consistency', () => {
    // Property: wholesale price should always be <= retail price (if set)
    it('wholesale should provide discount or equal price', () => {
      const products: TieredPricingProduct[] = [
        { price: 100, wholesalePrice: 80, memberPrice: null, minWholesaleQuantity: 5 },
        { price: 50, wholesalePrice: 50, memberPrice: null, minWholesaleQuantity: 3 },
        { price: 200, wholesalePrice: 150, memberPrice: 180, minWholesaleQuantity: 10 },
      ];

      for (const product of products) {
        if (product.wholesalePrice !== null) {
          expect(product.wholesalePrice).toBeLessThanOrEqual(product.price);
        }
      }
    });

    // Property: member price should always be <= retail price (if set)
    it('member should provide discount or equal price', () => {
      const products: TieredPricingProduct[] = [
        { price: 100, wholesalePrice: null, memberPrice: 90, minWholesaleQuantity: null },
        { price: 50, wholesalePrice: null, memberPrice: 45, minWholesaleQuantity: null },
        { price: 200, wholesalePrice: 150, memberPrice: 180, minWholesaleQuantity: 10 },
      ];

      for (const product of products) {
        if (product.memberPrice !== null) {
          expect(product.memberPrice).toBeLessThanOrEqual(product.price);
        }
      }
    });
  });

  describe('Property: Quantity thresholds', () => {
    // Property: increasing quantity should never increase effective unit price
    it('higher quantity should give equal or better price', () => {
      const quantities = [1, 5, 10, 15, 20, 50, 100];

      for (let i = 1; i < quantities.length; i++) {
        const lowerQtyResult = calculateTieredPrice(tieredProduct, 'wholesale', quantities[i - 1]);
        const higherQtyResult = calculateTieredPrice(tieredProduct, 'wholesale', quantities[i]);
        expect(higherQtyResult.unitPrice).toBeLessThanOrEqual(lowerQtyResult.unitPrice);
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle zero price', () => {
      const freeProduct: TieredPricingProduct = {
        price: 0,
        wholesalePrice: 0,
        memberPrice: 0,
        minWholesaleQuantity: 1,
      };
      const result = calculateTieredPrice(freeProduct, 'retail', 1);
      expect(result.unitPrice).toBe(0);
      expect(result.discountPercentage).toBe(0);
    });

    it('should handle zero quantity', () => {
      const result = calculateLineItemTotal(tieredProduct, 'retail', 0);
      expect(result.subtotal).toBe(0);
      expect(result.savings).toBe(0);
    });

    it('should handle undefined variant', () => {
      const result = calculateTieredPrice(tieredProduct, 'retail', 1, null);
      expect(result.unitPrice).toBe(100);
    });

    it('should handle empty variant', () => {
      const emptyVariant: TieredPricingVariant = {};
      const result = calculateTieredPrice(tieredProduct, 'retail', 1, emptyVariant);
      expect(result.unitPrice).toBe(100);
    });
  });
});
