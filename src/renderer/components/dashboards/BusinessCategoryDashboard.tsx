import React, { memo, useMemo } from 'react';
import { useModules } from '../../contexts/module-context';
import { FoodDashboard } from './FoodDashboard';
import { ServiceDashboard } from './ServiceDashboard';
import { ProductDashboard } from './ProductDashboard';
import type { BusinessType } from '../../../shared/types/organization';

// Define BusinessCategory locally to avoid import issues
type BusinessCategory = 'food' | 'service' | 'product';

/**
 * Business Category Dashboard
 *
 * Automatically selects and renders the appropriate dashboard layout
 * based on the organization's business type mapped to business categories:
 *
 * - Food Category: restaurant, fast_food, bar_cafe, food_truck, chain, franchise, cafe, bar, bakery, catering, ghost_kitchen
 * - Service Category: salon, spa, barbershop, beauty_salon, wellness, fitness, clinic, dental, medical_clinic, veterinary, physiotherapy, hotel, hotel_restaurant
 * - Product Category: retail, shop, boutique, convenience, grocery
 *
 * This provides an optimized POS experience tailored to each business's needs.
 */

interface BusinessCategoryDashboardProps {
  className?: string;
  /** Override the auto-detected business type (for testing/preview) */
  overrideBusinessType?: BusinessType;
  /** Override the auto-detected category (for testing/preview) */
  overrideCategory?: BusinessCategory;
}

/**
 * Maps business types to their business categories.
 * This mapping determines which dashboard layout is used.
 */
const BUSINESS_TYPE_TO_CATEGORY: Record<BusinessType, BusinessCategory> = {
  // Food businesses - order-focused, kitchen operations
  restaurant: 'food',
  fast_food: 'food',
  bar_cafe: 'food',
  food_truck: 'food',
  chain: 'food',
  franchise: 'food',
  cafe: 'food',
  bar: 'food',
  bakery: 'food',
  catering: 'food',
  ghost_kitchen: 'food',

  // Service businesses - appointment/booking-focused
  salon: 'service',
  spa: 'service',
  barbershop: 'service',
  beauty_salon: 'service',
  wellness: 'service',
  fitness: 'service',
  clinic: 'service',
  dental: 'service',
  medical_clinic: 'service',
  veterinary: 'service',
  physiotherapy: 'service',
  hotel: 'service',
  hotel_restaurant: 'service',

  // Product businesses - inventory/retail-focused
  retail: 'product',
  shop: 'product',
  boutique: 'product',
  convenience: 'product',
  grocery: 'product',
};

/**
 * Get the business category for a given business type
 */
export function getBusinessCategory(businessType: BusinessType | null): BusinessCategory {
  if (!businessType) {
    return 'food'; // Default to food dashboard
  }
  return BUSINESS_TYPE_TO_CATEGORY[businessType] || 'food';
}

export const BusinessCategoryDashboard = memo<BusinessCategoryDashboardProps>(({
  className = '',
  overrideBusinessType,
  overrideCategory,
}) => {
  const { businessType: contextBusinessType } = useModules();

  // Determine which business type to use
  const effectiveBusinessType = overrideBusinessType || contextBusinessType;

  // Determine which category to use
  const category = useMemo(() => {
    if (overrideCategory) {
      return overrideCategory;
    }
    return getBusinessCategory(effectiveBusinessType);
  }, [overrideCategory, effectiveBusinessType]);

  // Render the appropriate dashboard based on category
  switch (category) {
    case 'food':
      return <FoodDashboard className={className} />;
    case 'service':
      return <ServiceDashboard className={className} />;
    case 'product':
      return <ProductDashboard className={className} />;
    default:
      // Fallback to food dashboard
      return <FoodDashboard className={className} />;
  }
});

BusinessCategoryDashboard.displayName = 'BusinessCategoryDashboard';

export default BusinessCategoryDashboard;
