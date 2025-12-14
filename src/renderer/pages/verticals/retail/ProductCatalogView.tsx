/**
 * ProductCatalogView - POS Retail Dashboard with Order Management
 *
 * Mirrors the main Dashboard layout with Orders/Delivered/Canceled tabs
 * and the + button for creating orders, but uses ProductCatalogModal
 * instead of MenuModal for selecting products.
 *
 * Task 17.5: Create POS product catalog interface
 */

import React, { memo, useCallback } from 'react';
import { useOrderStore } from '../../../hooks/useOrderStore';
import { OrderDashboard } from '../../../components/OrderDashboard';
import OrderFlow from '../../../components/OrderFlow';
import { OrderConflictBanner } from '../../../components/OrderConflictBanner';

export const ProductCatalogView: React.FC = memo(() => {
  const { conflicts, resolveConflict } = useOrderStore();

  const handleResolveConflict = useCallback(async (conflictId: string, strategy: string): Promise<void> => {
    await resolveConflict(conflictId, strategy);
  }, [resolveConflict]);

  return (
    <div className="p-6">
      {/* Conflict Banner */}
      {conflicts.length > 0 && (
        <div className="mb-4">
          <OrderConflictBanner
            conflicts={conflicts}
            onResolve={handleResolveConflict}
          />
        </div>
      )}

      {/* Orders Dashboard with tabs for Active/Delivered/Canceled */}
      <OrderDashboard className="mb-6" />

      {/* Order Flow with forceRetailMode to show ProductCatalogModal instead of MenuModal */}
      <OrderFlow forceRetailMode={true} />
    </div>
  );
});

ProductCatalogView.displayName = 'ProductCatalogView';
export default ProductCatalogView;
