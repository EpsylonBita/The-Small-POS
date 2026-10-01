import React, { memo, useEffect } from 'react';
import { useOrderStore } from '../../hooks/useOrderStore';
import { OrderDashboard } from '../OrderDashboard';
import OrderFlow from '../OrderFlow';
import { OrderConflictBanner } from '../OrderConflictBanner';
import { getBridge } from '../../../lib';
import { foodOrderFilter } from './dashboardOrderScope';

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
      className={`flex h-full min-h-0 flex-col gap-4 overflow-hidden p-4 md:gap-6 md:p-6 ${className}`}
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

      {/* Main Order Dashboard. The same food scope decides which pending
          platform orders the app-shell alert rings for (dashboardOrderScope). */}
      <OrderDashboard className="flex-1" orderFilter={foodOrderFilter} />

      {/* Reuse order-flow modals/state here, but let OrderDashboard own the visible FAB */}
      <OrderFlow showFab={false} />
    </div>
  );
});

FoodDashboard.displayName = 'FoodDashboard';

export default FoodDashboard;
