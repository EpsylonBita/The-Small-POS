import React, { memo, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { useOrderStore } from '../../hooks/useOrderStore';
import { useModules } from '../../contexts/module-context';
import { useNavigationSafe } from '../../contexts/navigation-context';
import { OrderDashboard } from '../OrderDashboard';
import OrderFlow from '../OrderFlow';
import { OrderConflictBanner } from '../OrderConflictBanner';
import { DashboardCard } from '../DashboardCard';
import { formatTime } from '../../utils/format';
import { getBridge, offEvent, onEvent } from '../../../lib';
import {
  Package,
  Barcode,
  Boxes,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import type { ModuleId } from '../../../shared/types/modules';

/**
 * Product Business Category Dashboard
 * Optimized for: retail businesses
 *
 * Key features:
 * - Sales overview with metrics cards
 * - Inventory alerts and stock levels
 * - Quick product lookup
 * - Transaction summary
 * - Module-based card visibility
 */
interface ProductDashboardProps {
  className?: string;
}

interface ProductMetrics {
  activeOrders: number;
  productsInStock: number;
  deliveredToday: number;
  canceledToday: number;
  lowStockCount: number;
  isLoading: boolean;
}

export const ProductDashboard = memo<ProductDashboardProps>(({ className = '' }) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { initializeOrders, conflicts, orders } = useOrderStore();
  const { isModuleEnabled } = useModules();
  const navigation = useNavigationSafe();
  const isDark = resolvedTheme === 'dark';

  // Product metrics state
  const [metrics, setMetrics] = useState<ProductMetrics>({
    activeOrders: 0,
    productsInStock: 0,
    deliveredToday: 0,
    canceledToday: 0,
    lowStockCount: 0,
    isLoading: true,
  });

  /**
   * Load product metrics from the backend
   * Falls back to deriving from orders when APIs return notImplemented
   */
  const loadMetrics = useCallback(async () => {
    try {
      // Fetch inventory metrics if inventory module is enabled
      if (isModuleEnabled('inventory' as ModuleId)) {
        try {
          const inventoryResult = await bridge.invoke(
            'inventory:get-stock-metrics'
          );
          if (inventoryResult?.success) {
            setMetrics((prev) => ({
              ...prev,
              productsInStock: inventoryResult.inStock || 0,
              lowStockCount: inventoryResult.lowStock || 0,
            }));
          }
          // Note: notImplemented responses are expected - no error logging needed
        } catch (err) {
          // Only log unexpected errors
          if (!(err as Error)?.message?.includes('not implemented')) {
            console.warn('[ProductDashboard] Inventory API error:', err);
          }
        }
      }

      // Fetch product catalog count if product_catalog module is enabled
      if (isModuleEnabled('product_catalog' as ModuleId)) {
        try {
          const catalogResult = await bridge.invoke(
            'products:get-catalog-count'
          );
          if (catalogResult?.success) {
            setMetrics((prev) => ({
              ...prev,
              productsInStock: catalogResult.total || prev.productsInStock,
            }));
          }
          // Note: notImplemented responses are expected - no error logging needed
        } catch (err) {
          // Only log unexpected errors
          if (!(err as Error)?.message?.includes('not implemented')) {
            console.warn('[ProductDashboard] Product catalog API error:', err);
          }
        }
      }

      // Derive order-based metrics (always runs as fallback)
      deriveMetricsFromOrders();
    } catch (error) {
      console.error('[ProductDashboard] Failed to load metrics:', error);
      setMetrics((prev) => ({ ...prev, isLoading: false }));
    }
  }, [bridge, isModuleEnabled]);

  /**
   * Derive metrics from orders
   * This provides real-time order counts
   */
  const deriveMetricsFromOrders = useCallback(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Active orders (pending, preparing, ready)
    const activeOrders = orders.filter((o) =>
      ['pending', 'confirmed', 'preparing', 'ready'].includes(o.status)
    ).length;

    // Today's orders
    const todayOrders = orders.filter((order) => {
      const orderDate = new Date(order.createdAt || '');
      orderDate.setHours(0, 0, 0, 0);
      return orderDate.getTime() === today.getTime();
    });

    const deliveredToday = todayOrders.filter((o) =>
      ['completed', 'delivered'].includes(o.status)
    ).length;

    const canceledToday = todayOrders.filter((o) => o.status === 'cancelled').length;

    setMetrics((prev) => ({
      ...prev,
      activeOrders,
      deliveredToday,
      canceledToday,
      isLoading: false,
    }));
  }, [orders]);

  // Initialize orders when dashboard loads
  useEffect(() => {
    console.log('📦 Product Dashboard loading - initializing orders...');
    initializeOrders();
  }, [initializeOrders]);

  // Load metrics on mount and refresh from Rust-driven events.
  useEffect(() => {
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (disposed || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void loadMetrics();
      }, 250);
    };

    void loadMetrics();

    onEvent('sync:status', scheduleRefresh);
    onEvent('sync:complete', scheduleRefresh);
    onEvent('order-created', scheduleRefresh);
    onEvent('order-status-updated', scheduleRefresh);
    onEvent('order-deleted', scheduleRefresh);

    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      offEvent('sync:status', scheduleRefresh);
      offEvent('sync:complete', scheduleRefresh);
      offEvent('order-created', scheduleRefresh);
      offEvent('order-status-updated', scheduleRefresh);
      offEvent('order-deleted', scheduleRefresh);
    };
  }, [loadMetrics]);

  // Re-derive metrics when orders change
  useEffect(() => {
    if (!metrics.isLoading) {
      deriveMetricsFromOrders();
    }
  }, [orders, deriveMetricsFromOrders, metrics.isLoading]);

  // Handle conflict resolution
  const handleResolveConflict = async (conflictId: string, strategy: string) => {
    try {
      await bridge.orders.resolveConflict(conflictId, strategy);
    } catch (error) {
      console.error('Failed to resolve conflict:', error);
      throw error;
    }
  };

  // Handle card navigation using context (not hash-based)
  const handleNavigateToOrders = () => {
    navigation?.navigateTo('orders');
  };

  const handleNavigateToProducts = () => {
    navigation?.navigateTo('product_catalog');
  };

  const handleNavigateToInventory = () => {
    navigation?.navigateTo('inventory');
  };

  // Module visibility checks
  const showOrders = true; // Orders are always shown for product businesses
  const showProducts = isModuleEnabled('product_catalog' as ModuleId);
  const showInventory = isModuleEnabled('inventory' as ModuleId);
  const showDelivered = true;
  const showCanceled = true;

  // Determine if we should show low stock warning
  const hasLowStock = metrics.lowStockCount > 0 && showInventory;

  return (
    <div
      className={`p-4 md:p-6 space-y-4 md:space-y-6 ${className}`}
      data-testid="product-dashboard"
      data-business-category="product"
    >
      {/* Conflict Banner */}
      {conflicts.length > 0 && (
        <OrderConflictBanner
          conflicts={conflicts}
          onResolve={handleResolveConflict}
        />
      )}

      {/* Business Type Header */}
      <div className="flex items-center justify-between" role="banner">
        <div className="flex items-center gap-3">
          <Boxes className={`w-6 h-6 ${isDark ? 'text-blue-400' : 'text-blue-600'}`} />
          <h1 className={`text-xl md:text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('dashboard.retailDashboard', { defaultValue: 'Retail Dashboard' })}
          </h1>
          <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            <Clock className="w-4 h-4 inline mr-1" />
            {formatTime(new Date(), { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        {/* Quick Scan Button */}
        <button
          className={`
            flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all
            ${isDark
              ? 'bg-blue-600 hover:bg-blue-500 text-white'
              : 'bg-blue-600 hover:bg-blue-700 text-white'
            }
          `}
        >
          <Barcode className="w-5 h-5" />
          <span className="hidden sm:inline">
            {t('dashboard.scanProduct', { defaultValue: 'Scan Product' })}
          </span>
        </button>
      </div>

      {/* Low Stock Warning */}
      {hasLowStock && (
        <div className={`
          rounded-xl border p-4 flex items-center gap-4
          ${isDark ? 'bg-amber-900/20 border-amber-500/30' : 'bg-amber-50 border-amber-200'}
        `}>
          <div className={`
            w-10 h-10 rounded-full flex items-center justify-center
            ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}
          `}>
            <AlertTriangle className={`w-5 h-5 ${isDark ? 'text-amber-400' : 'text-amber-600'}`} />
          </div>
          <div>
            <div className={`font-semibold ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
              {t('dashboard.lowStockWarning', { defaultValue: 'Low Stock Warning' })}
            </div>
            <div className={`text-sm ${isDark ? 'text-amber-400/70' : 'text-amber-600'}`}>
              {t('dashboard.lowStockItems', {
                defaultValue: '{{count}} items are below minimum stock levels.',
                count: metrics.lowStockCount,
              })}
            </div>
          </div>
          <button
            onClick={handleNavigateToInventory}
            className={`ml-auto px-3 py-1 rounded text-sm font-medium ${
              isDark
                ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
            }`}
          >
            {t('common.view', { defaultValue: 'View' })}
          </button>
        </div>
      )}

      {/* Metrics Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Active Orders Card */}
        {showOrders && (
          <DashboardCard
            icon="Package"
            title={t('dashboard.activeOrders', { defaultValue: 'Active Orders' })}
            value={metrics.activeOrders}
            color="blue"
            onClick={handleNavigateToOrders}
            isLoading={metrics.isLoading}
            subtitle={t('dashboard.pendingOrders', { defaultValue: 'Pending & In Progress' })}
          />
        )}

        {/* Products Card */}
        {showProducts && (
          <DashboardCard
            icon="Boxes"
            title={t('dashboard.productsInStock', { defaultValue: 'Products In Stock' })}
            value={metrics.productsInStock}
            color="purple"
            onClick={handleNavigateToProducts}
            isLoading={metrics.isLoading}
            subtitle={t('dashboard.totalProducts', { defaultValue: 'Total Products' })}
          />
        )}

        {/* Delivered Card */}
        {showDelivered && (
          <DashboardCard
            icon="CheckCircle2"
            title={t('dashboard.deliveredToday', { defaultValue: 'Delivered Today' })}
            value={metrics.deliveredToday}
            color="green"
            isLoading={metrics.isLoading}
            subtitle={t('dashboard.ordersCompleted', { defaultValue: 'Orders Completed' })}
          />
        )}

        {/* Canceled Card */}
        {showCanceled && (
          <DashboardCard
            icon="XCircle"
            title={t('dashboard.canceledToday', { defaultValue: 'Canceled Today' })}
            value={metrics.canceledToday}
            color="red"
            isLoading={metrics.isLoading}
            subtitle={t('dashboard.ordersCanceled', { defaultValue: 'Orders Canceled' })}
          />
        )}
      </div>

      {/* Inventory Healthy State - show when no low stock and inventory module enabled */}
      {showInventory && !hasLowStock && !metrics.isLoading && (
        <div className={`
          rounded-xl border p-6 flex items-center gap-4
          ${isDark ? 'bg-green-900/20 border-green-500/30' : 'bg-green-50 border-green-200'}
        `}>
          <div className={`
            w-12 h-12 rounded-full flex items-center justify-center
            ${isDark ? 'bg-green-500/20' : 'bg-green-100'}
          `}>
            <Package className={`w-6 h-6 ${isDark ? 'text-green-400' : 'text-green-600'}`} />
          </div>
          <div>
            <div className={`font-semibold ${isDark ? 'text-green-400' : 'text-green-700'}`}>
              {t('dashboard.inventoryHealthy', { defaultValue: 'Inventory Healthy' })}
            </div>
            <div className={`text-sm ${isDark ? 'text-green-400/70' : 'text-green-600'}`}>
              {t('dashboard.allStockLevelsGood', { defaultValue: 'All stock levels are above minimum thresholds.' })}
            </div>
          </div>
        </div>
      )}

      {/* Main Order/Transaction Dashboard */}
      <div className="space-y-2">
        <h2 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {t('dashboard.recentTransactions', { defaultValue: 'Recent Transactions' })}
        </h2>
        <OrderDashboard className="flex-1" />
      </div>

      {/* Order Flow with floating Add Order button */}
      <OrderFlow />
    </div>
  );
});

ProductDashboard.displayName = 'ProductDashboard';

export default ProductDashboard;
