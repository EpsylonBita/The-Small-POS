import React, { memo, useCallback, useEffect } from 'react';
import { useOrderStore } from '../../hooks/useOrderStore';
import { OrderDashboard } from '../OrderDashboard';
import OrderFlow from '../OrderFlow';
import { OrderConflictBanner } from '../OrderConflictBanner';
import type { Order } from '../../types/orders';
import { getBridge } from '../../../lib';

/**
 * Food Business Category Dashboard
 * Optimized for: restaurant, fast_food, bar_cafe, food_truck businesses
 *
 * Key features:
 * - Order management with active orders prominently displayed
 * - Kitchen queue visibility
 * - Delivery tracking for food_truck/delivery scenarios
 */
interface FoodDashboardProps {
  className?: string;
}

export const FoodDashboard = memo<FoodDashboardProps>(({ className = '' }) => {
  const bridge = getBridge();
  const { initializeOrders, conflicts } = useOrderStore();

  const foodOrderFilter = useCallback((order: Order): boolean => {
    const items = Array.isArray(order.items) ? order.items : [];

    if (items.length === 0) {
      return true;
    }

    return !items.some((item) => {
      const candidate = item as any;
      return Boolean(
        candidate.product_id ||
        candidate.productId ||
        candidate.retail_product_id ||
        candidate.product_name ||
        candidate.productName
      );
    });
  }, []);

  // Initialize orders when dashboard loads
  useEffect(() => {
    console.log('🍽️ Food Dashboard loading - initializing orders...');
    initializeOrders();
  }, [initializeOrders]);

  // Handle conflict resolution
  const handleResolveConflict = async (conflictId: string, strategy: string) => {
    try {
      await bridge.orders.resolveConflict(conflictId, strategy);
    } catch (error) {
      console.error('Failed to resolve conflict:', error);
      throw error;
    }
  };

  return (
    <div
      className={`p-4 md:p-6 space-y-4 md:space-y-6 ${className}`}
      data-testid="food-dashboard"
      data-business-category="food"
    >
      {/* Conflict Banner */}
      {conflicts.length > 0 && (
        <OrderConflictBanner
          conflicts={conflicts}
          onResolve={handleResolveConflict}
        />
      )}

      {/* Main Order Dashboard */}
      <OrderDashboard className="flex-1" orderFilter={foodOrderFilter} />

      {/* Order Flow with floating Add Order button */}
      <OrderFlow />
    </div>
  );
});

FoodDashboard.displayName = 'FoodDashboard';

export default FoodDashboard;
