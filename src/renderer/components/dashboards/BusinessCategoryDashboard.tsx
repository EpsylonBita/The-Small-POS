import React, { lazy, memo, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useModules } from '../../contexts/module-context';
import { FoodDashboard } from './FoodDashboard';
import type { BusinessType } from '../../../shared/types/organization';
import { getBusinessCategory, type BusinessCategory } from './dashboardOrderScope';

// The category mapping lives in dashboardOrderScope.ts so the app-shell
// incoming-order alert scopes orders exactly as the chosen dashboard does.
export { getBusinessCategory };

const ServiceDashboard = lazy(() => import('./ServiceDashboard').then(m => ({ default: m.ServiceDashboard })));
const ProductDashboard = lazy(() => import('./ProductDashboard').then(m => ({ default: m.ProductDashboard })));

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

export const BusinessCategoryDashboard = memo<BusinessCategoryDashboardProps>(({
  className = '',
  overrideBusinessType,
  overrideCategory,
}) => {
  const { businessType: contextBusinessType } = useModules();
  const { t } = useTranslation();

  // Determine which business type to use
  const effectiveBusinessType = overrideBusinessType || contextBusinessType;

  // Determine which category to use
  const category = useMemo(() => {
    if (overrideCategory) {
      return overrideCategory;
    }
    return getBusinessCategory(effectiveBusinessType);
  }, [overrideCategory, effectiveBusinessType]);

  const Dashboard = category === 'service'
    ? ServiceDashboard
    : category === 'product' ? ProductDashboard : FoodDashboard;

  return (
    <Suspense fallback={<div role="status" className="flex h-full items-center justify-center p-8">{t('common.loading')}</div>}>
      <Dashboard className={className} />
    </Suspense>
  );
});

BusinessCategoryDashboard.displayName = 'BusinessCategoryDashboard';

export default BusinessCategoryDashboard;
