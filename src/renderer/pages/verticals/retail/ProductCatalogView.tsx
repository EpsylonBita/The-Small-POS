/**
 * ProductCatalogView - POS Retail Dashboard with Order Management
 *
 * Mirrors the main Dashboard layout with Orders/Delivered/Canceled tabs
 * and the + button for creating orders, but uses ProductCatalogModal
 * instead of MenuModal for selecting products.
 *
 * Task 17.5: Create POS product catalog interface
 */

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useOrderStore } from '../../../hooks/useOrderStore';
import { OrderDashboard } from '../../../components/OrderDashboard';
import OrderFlow from '../../../components/OrderFlow';
import { OrderConflictBanner } from '../../../components/OrderConflictBanner';
import { useModules } from '../../../contexts/module-context';
import { useProductCatalog } from '../../../hooks/useProductCatalog';
import type { Order } from '../../../types/orders';
import { offEvent, onEvent } from '../../../../lib';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../../services/terminal-credentials';

export const ProductCatalogView: React.FC = memo(() => {
  const { conflicts, resolveConflict } = useOrderStore();
  const { organizationId: moduleOrgId } = useModules();
  const [branchId, setBranchId] = useState<string | null>(null);
  const [localOrgId, setLocalOrgId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    const hydrateTerminalIdentity = async () => {
      const cached = getCachedTerminalCredentials();
      if (!disposed) {
        setBranchId(cached.branchId || null);
        setLocalOrgId(cached.organizationId || null);
      }

      const refreshed = await refreshTerminalCredentialCache();
      if (!disposed) {
        setBranchId(refreshed.branchId || null);
        setLocalOrgId(refreshed.organizationId || null);
      }
    };

    const handleConfigUpdate = (data: { branch_id?: string; organization_id?: string }) => {
      if (disposed) return;
      if (typeof data?.branch_id === 'string' && data.branch_id.trim()) {
        setBranchId(data.branch_id.trim());
      }
      if (typeof data?.organization_id === 'string' && data.organization_id.trim()) {
        setLocalOrgId(data.organization_id.trim());
      }
    };

    hydrateTerminalIdentity();
    onEvent('terminal-config-updated', handleConfigUpdate);

    return () => {
      disposed = true;
      offEvent('terminal-config-updated', handleConfigUpdate);
    };
  }, []);

  const organizationId = moduleOrgId || localOrgId || '';

  const { products } = useProductCatalog({
    branchId: branchId || '',
    organizationId,
    filters: { activeOnly: false },
    enableRealtime: false,
  });

  const productIdSet = useMemo(() => new Set(products.map((product) => product.id)), [products]);

  const orderFilter = useCallback((order: Order): boolean => {
    const items = Array.isArray(order.items) ? order.items : [];
    return items.some((item) => {
      const candidate = (item as any);
      const productId =
        candidate.product_id ||
        candidate.productId ||
        candidate.retail_product_id ||
        candidate.menu_item_id ||
        candidate.menuItemId ||
        candidate.id;

      if (productId && productIdSet.has(productId)) {
        return true;
      }

      return Boolean(candidate.product_name || candidate.productName);
    });
  }, [productIdSet]);

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
      <OrderDashboard className="mb-6" orderFilter={orderFilter} />

      {/* Order Flow with forceRetailMode to show ProductCatalogModal instead of MenuModal */}
      <OrderFlow forceRetailMode={true} />
    </div>
  );
});

ProductCatalogView.displayName = 'ProductCatalogView';
export default ProductCatalogView;
