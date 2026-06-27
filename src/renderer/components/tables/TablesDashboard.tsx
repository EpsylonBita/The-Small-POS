import React, { memo, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import { useOrderStore } from '../../hooks/useOrderStore';
import { useTables } from '../../hooks/useTables';
import { useSystemClock } from '../../hooks/useSystemClock';
import { ReservationInfoPanel } from './ReservationInfoPanel';
import { TableFloorPlanView } from './TableFloorPlanView';
import { FloatingActionButton } from '../ui/FloatingActionButton';
import type { Order } from '../../types/orders';
import type { RestaurantTable, TablesDashboardTab, TabConfig, TableStatus } from '../../types/tables';
import {
  AlertTriangle,
  ArrowRightLeft,
  Banknote,
  CheckCircle,
  ClipboardList,
  Clock3,
  LayoutGrid,
  Map as MapIcon,
  Plus,
  ReceiptText,
  RefreshCw,
  Truck,
  UserCheck,
  Users,
  WalletCards,
  XCircle,
} from 'lucide-react';
import { formatCurrency, formatTime as formatTimeValue } from '../../utils/format';
import { toLocalDateString } from '../../utils/date';
import { resolveTableDisplayStatus, tableHasOpenCheckReference } from '../../utils/tableOrderFlow';

interface TablesDashboardProps {
  branchId: string;
  organizationId: string;
  tables?: RestaurantTable[]; // Optional override for tables data
  onTableSelect?: (table: RestaurantTable) => void;
  onAddOrder?: () => void;
}

/**
 * TablesDashboard Component
 * 
 * A dashboard-style interface for the Tables page with four tabs:
 * - Orders: Active table orders (pending, preparing, ready)
 * - Delivered: Today's completed/delivered orders
 * - Canceled: Today's canceled orders
 * - Tables: Table grid with status indicators
 * 
 * Requirements: 1.1 - Display tab bar with Orders/Delivered/Canceled/Tables tabs
 */
export const TablesDashboard: React.FC<TablesDashboardProps> = memo(({
  branchId,
  organizationId,
  tables: tablesProp,
  onTableSelect,
  onAddOrder
}) => {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const { orders, loadOrders, isLoading: ordersLoading } = useOrderStore();
  const now = useSystemClock();
  const isDark = resolvedTheme === 'dark';

  // Use the useTables hook for real-time table data
  // Requirements: 1.6 - Update counts and lists on data changes within 2 seconds
  const { 
    tables: tablesFromHook, 
    isLoading: tablesLoading, 
    refetch: refetchTables 
  } = useTables({ 
    branchId, 
    organizationId, 
    enabled: !tablesProp // Only fetch if no tables prop provided
  });

  // Use provided tables or fetched tables
  const tables = tablesProp || tablesFromHook;

  // Active tab state
  const [activeTab, setActiveTab] = useState<TablesDashboardTab>('orders');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Manual refresh handler
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        loadOrders(),
        refetchTables()
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, [loadOrders, refetchTables]);

  // Get today's date for filtering
  const today = toLocalDateString(now);

  // Filter orders for table-related orders (dine-in orders with table assignment)
  const tableOrders = useMemo(() => {
    return orders.filter(order => 
      order.orderType === 'dine-in' || 
      order.tableNumber || 
      order.table_number
    );
  }, [orders]);

  // Calculate order counts for each tab
  const orderCounts = useMemo(() => {
    const activeOrders = tableOrders.filter(order =>
      ['pending', 'preparing', 'ready'].includes(order.status)
    );

    const deliveredOrders = tableOrders.filter(order => {
      const orderDate = toLocalDateString(order.createdAt || order.created_at || '');
      return (order.status === 'delivered' || order.status === 'completed') && 
             orderDate === today;
    });

    const canceledOrders = tableOrders.filter(order => {
      const orderDate = toLocalDateString(order.createdAt || order.created_at || '');
      return order.status === 'cancelled' && orderDate === today;
    });

    return {
      orders: activeOrders.length,
      delivered: deliveredOrders.length,
      canceled: canceledOrders.length,
      tables: tables.length
    };
  }, [tableOrders, tables, today]);

  // Tab configuration
  const tabs: TabConfig[] = useMemo(() => [
    { 
      id: 'orders', 
      label: t('tablesDashboard.tabs.orders', { defaultValue: 'Orders' }), 
      count: orderCounts.orders, 
      color: 'green' 
    },
    { 
      id: 'delivered', 
      label: t('tablesDashboard.tabs.delivered', { defaultValue: 'Delivered' }), 
      count: orderCounts.delivered, 
      color: 'orange' 
    },
    { 
      id: 'canceled', 
      label: t('tablesDashboard.tabs.canceled', { defaultValue: 'Canceled' }), 
      count: orderCounts.canceled, 
      color: 'red' 
    },
    { 
      id: 'tables', 
      label: t('tablesDashboard.tabs.tables', { defaultValue: 'Tables' }), 
      count: orderCounts.tables, 
      color: 'blue' 
    }
  ], [t, orderCounts]);

  // Handle tab change
  const handleTabChange = useCallback((tabId: TablesDashboardTab) => {
    setActiveTab(tabId);
  }, []);

  // Get icon for tab
  const getTabIcon = (tabId: TablesDashboardTab) => {
    switch (tabId) {
      case 'orders':
        return <ClipboardList className="w-4 h-4" />;
      case 'delivered':
        return <CheckCircle className="w-4 h-4" />;
      case 'canceled':
        return <XCircle className="w-4 h-4" />;
      case 'tables':
        return <LayoutGrid className="w-4 h-4" />;
    }
  };

  // Get color classes for tab
  const getTabColorClasses = (tab: TabConfig, isActive: boolean) => {
    if (!isActive) {
      return isDark ? 'text-white/70' : 'text-gray-600';
    }

    switch (tab.color) {
      case 'green':
        return 'text-green-500';
      case 'orange':
        return 'text-amber-500';
      case 'red':
        return 'text-red-500';
      case 'blue':
        return 'text-yellow-500';
      default:
        return isDark ? 'text-white' : 'text-gray-900';
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Tab Bar with Refresh Button */}
      <div 
        className={`flex items-center backdrop-blur-sm rounded-xl p-1.5 sm:p-2 border overflow-x-auto scrollbar-hide touch-pan-x mb-4 ${
          isDark
            ? 'bg-white/10 border-white/20'
            : 'bg-gray-100/80 border-gray-200/50 shadow-sm'
        }`} 
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {/* Refresh Button */}
        <button
          onClick={handleRefresh}
          disabled={isRefreshing || ordersLoading || tablesLoading}
          className={`mr-2 p-2 rounded-xl transition-all duration-200 ${
            isDark
              ? 'active:bg-white/10 text-white/70 disabled:text-white/30'
              : 'active:bg-gray-200 text-gray-600 disabled:text-gray-300'
          }`}
          aria-label={t('tablesDashboard.refresh', { defaultValue: 'Refresh' })}
        >
          <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
        </button>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`flex-1 min-w-[90px] px-3 sm:px-4 py-2.5 sm:py-3 rounded-xl font-medium transition-all duration-200 relative touch-feedback active:scale-95 ${
              activeTab === tab.id
                ? isDark
                  ? 'bg-white/20 shadow-lg'
                  : 'bg-white backdrop-blur-sm shadow-sm border border-gray-200/30'
                : isDark
                  ? 'active:bg-white/20'
                  : 'active:bg-white/80'
            }`}
          >
            <div className="flex items-center justify-center gap-1.5 sm:gap-2">
              <span className={`transition-all duration-200 ${getTabColorClasses(tab, activeTab === tab.id)}`}>
                {getTabIcon(tab.id)}
              </span>
              <span className={`text-sm sm:text-lg font-bold transition-all duration-200 ${getTabColorClasses(tab, activeTab === tab.id)}`}>
                {tab.label}
              </span>
              
              {/* Tab counter badge */}
              <span className={`text-[10px] sm:text-xs font-bold px-1.5 py-0.5 rounded-full transition-all duration-200 ${
                activeTab === tab.id
                  ? tab.color === 'green'
                    ? 'bg-green-500/20 text-green-500'
                    : tab.color === 'orange'
                      ? 'bg-amber-500/20 text-amber-500'
                      : tab.color === 'red'
                        ? 'bg-red-500/20 text-red-500'
                        : 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-300'
                  : isDark
                    ? 'bg-white/10 text-white/70'
                    : 'bg-gray-200 text-gray-600'
              }`}>
                {tab.count}
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'orders' && (
          <OrdersTabContent 
            orders={tableOrders} 
            today={today}
            isDark={isDark}
          />
        )}
        {activeTab === 'delivered' && (
          <DeliveredTabContent 
            orders={tableOrders} 
            today={today}
            isDark={isDark}
          />
        )}
        {activeTab === 'canceled' && (
          <CanceledTabContent 
            orders={tableOrders} 
            today={today}
            isDark={isDark}
          />
        )}
        {activeTab === 'tables' && (
          <TablesTabContent 
            tables={tables}
            isDark={isDark}
            branchId={branchId}
            organizationId={organizationId}
            onTableSelect={onTableSelect}
          />
        )}
      </div>

      {/* Floating Action Button for Add Order */}
      <FloatingActionButton
        onClick={onAddOrder}
        className="!bottom-6 !right-6"
        aria-label={t('tablesDashboard.addOrder', { defaultValue: 'Add Order' })}
      />
    </div>
  );
});

TablesDashboard.displayName = 'TablesDashboard';

// Orders Tab Content - Displays active table orders
// Requirements: 1.2 - Display active orders with order number, table, status, amount
interface OrdersTabContentProps {
  orders: Order[];
  today: string;
  isDark: boolean;
}

const OrdersTabContent: React.FC<OrdersTabContentProps> = memo(({ orders, today, isDark }) => {
  const { t } = useI18n();
  
  // Filter to show only active orders (pending, preparing, ready)
  const activeOrders = useMemo(() => {
    return orders.filter(order =>
      ['pending', 'preparing', 'ready'].includes(order.status)
    ).sort((a, b) => {
      // Sort by creation time, newest first
      const timeA = new Date(a.createdAt || a.created_at || 0).getTime();
      const timeB = new Date(b.createdAt || b.created_at || 0).getTime();
      return timeB - timeA;
    });
  }, [orders]);

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'pending':
        return isDark 
          ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
          : 'bg-yellow-100 text-yellow-700 border-yellow-300';
      case 'preparing':
        return isDark
          ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
          : 'bg-amber-100 text-amber-800 border-amber-300';
      case 'ready':
      case 'completed':
      case 'delivered':
        return isDark
          ? 'bg-green-500/20 text-green-400 border-green-500/30'
          : 'bg-green-100 text-green-700 border-green-300';
      default:
        return isDark
          ? 'bg-gray-500/20 text-gray-400 border-gray-500/30'
          : 'bg-gray-100 text-gray-600 border-gray-300';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'pending':
        return t('tablesDashboard.status.pending', { defaultValue: 'Pending' });
      case 'preparing':
        return t('tablesDashboard.status.preparing', { defaultValue: 'Preparing' });
      case 'ready':
        return t('tablesDashboard.status.ready', { defaultValue: 'Ready' });
      case 'completed':
        return t('orders.status.completed', { defaultValue: 'Completed' });
      case 'delivered':
        return t('orders.status.delivered', { defaultValue: 'Delivered' });
      default:
        return status;
    }
  };

  const formatTime = (dateString: string) => {
    return formatTimeValue(dateString, { hour: '2-digit', minute: '2-digit' });
  };

  if (activeOrders.length === 0) {
    return (
      <div className={`h-full flex items-center justify-center ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
        <div className="text-center">
          <ClipboardList className="w-16 h-16 mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium">
            {t('tablesDashboard.noActiveOrders', { defaultValue: 'No active orders' })}
          </p>
          <p className="text-sm mt-1 opacity-75">
            {t('tablesDashboard.ordersWillAppear', { defaultValue: 'Table orders will appear here' })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pr-2 space-y-3 scrollbar-hide">
      {activeOrders.map((order, index) => {
        const orderNumber = order.orderNumber || order.order_number || `#${index + 1}`;
        const tableNumber = order.tableNumber || order.table_number || '-';
        const totalAmount = order.totalAmount || order.total_amount || 0;
        const createdAt = order.createdAt || order.created_at || '';
        const customerName = order.customerName || order.customer_name || '';
        const orderStatusNormalized = (order.status || '').toLowerCase();
        const showReadyBadgeIcon =
          orderStatusNormalized === 'ready' ||
          orderStatusNormalized === 'completed' ||
          orderStatusNormalized === 'delivered';

        return (
          <div
            key={order.id}
            className={`rounded-xl p-4 border transition-all duration-200 active:scale-[0.99] cursor-pointer ${
              isDark
                ? 'bg-white/5 border-white/10 active:bg-white/10'
                : 'bg-white border-gray-200 active:bg-gray-50 shadow-sm'
            }`}
          >
            <div className="flex items-center justify-between">
              {/* Left: Order number and table */}
              <div className="flex items-center gap-4">
                <div className="flex flex-col">
                  <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {orderNumber}
                  </span>
                  <span className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                    {t('tablesDashboard.table', { defaultValue: 'Table' })} {tableNumber}
                  </span>
                </div>
                
                {/* Customer name if available */}
                {customerName && (
                  <div className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    {customerName}
                  </div>
                )}
              </div>

              {/* Center: Status badge */}
              <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${getStatusBadgeColor(order.status)}`}>
                {showReadyBadgeIcon && <CheckCircle className="w-3 h-3" />}
                {getStatusLabel(order.status)}
              </div>

              {/* Right: Amount and time */}
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {formatCurrency(totalAmount)}
                  </div>
                  <div className={`text-xs ${isDark ? 'text-white/50' : 'text-gray-400'}`}>
                    {formatTime(createdAt)}
                  </div>
                </div>
              </div>
            </div>

            {/* Items preview */}
            {order.items && order.items.length > 0 && (
              <div className={`mt-3 pt-3 border-t ${isDark ? 'border-white/10' : 'border-gray-100'}`}>
                <div className={`text-xs ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                  {order.items.slice(0, 3).map((item, idx) => (
                    <span key={idx}>
                      {item.quantity}x {item.name}
                      {idx < Math.min(order.items.length - 1, 2) && ', '}
                    </span>
                  ))}
                  {order.items.length > 3 && (
                    <span> +{order.items.length - 3} {t('tablesDashboard.moreItems', { defaultValue: 'more' })}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

OrdersTabContent.displayName = 'OrdersTabContent';

// Delivered Tab Content - Displays today's completed/delivered orders
// Requirements: 1.3 - Display all completed/delivered orders from the current day with timestamps
interface DeliveredTabContentProps {
  orders: Order[];
  today: string;
  isDark: boolean;
}

const DeliveredTabContent: React.FC<DeliveredTabContentProps> = memo(({ orders, today, isDark }) => {
  const { t } = useI18n();
  
  // Filter to show only today's delivered/completed orders
  const deliveredOrders = useMemo(() => {
    return orders.filter(order => {
      const orderDate = toLocalDateString(order.createdAt || order.created_at || '');
      return (order.status === 'delivered' || order.status === 'completed') && 
             orderDate === today;
    }).sort((a, b) => {
      // Sort by updated time (most recently delivered first)
      const timeA = new Date(a.updatedAt || a.updated_at || 0).getTime();
      const timeB = new Date(b.updatedAt || b.updated_at || 0).getTime();
      return timeB - timeA;
    });
  }, [orders, today]);

  const formatTime = (dateString: string) => {
    return formatTimeValue(dateString, { hour: '2-digit', minute: '2-digit' });
  };

  const getTimeDiff = (createdAt: string, updatedAt: string) => {
    const created = new Date(createdAt).getTime();
    const updated = new Date(updatedAt).getTime();
    const diffMinutes = Math.round((updated - created) / (1000 * 60));
    
    if (diffMinutes < 60) {
      return `${diffMinutes}m`;
    }
    const hours = Math.floor(diffMinutes / 60);
    const mins = diffMinutes % 60;
    return `${hours}h ${mins}m`;
  };

  if (deliveredOrders.length === 0) {
    return (
      <div className={`h-full flex items-center justify-center ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
        <div className="text-center">
          <CheckCircle className="w-16 h-16 mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium">
            {t('tablesDashboard.noDeliveredOrders', { defaultValue: 'No delivered orders today' })}
          </p>
          <p className="text-sm mt-1 opacity-75">
            {t('tablesDashboard.deliveredWillAppear', { defaultValue: 'Completed orders will appear here' })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pr-2 space-y-3 scrollbar-hide">
      {deliveredOrders.map((order, index) => {
        const orderNumber = order.orderNumber || order.order_number || `#${index + 1}`;
        const tableNumber = order.tableNumber || order.table_number || '-';
        const totalAmount = order.totalAmount || order.total_amount || 0;
        const createdAt = order.createdAt || order.created_at || '';
        const updatedAt = order.updatedAt || order.updated_at || '';
        const customerName = order.customerName || order.customer_name || '';
        const driverName = order.driverName || order.driver_name || '';
        const orderType = String(order.orderType || order.order_type || '').toLowerCase();
        const showDeliveredDriver = orderType === 'delivery' && !!driverName;

        return (
          <div
            key={order.id}
            className={`rounded-xl p-4 border transition-all duration-200 ${
              isDark
                ? 'bg-green-500/5 border-green-500/20 active:bg-green-500/10'
                : 'bg-green-50 border-green-200 active:bg-green-100 shadow-sm'
            }`}
          >
            <div className="flex items-center justify-between">
              {/* Left: Order number and table */}
              <div className="flex items-center gap-4">
                <div className="flex flex-col">
                  <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {orderNumber}
                  </span>
                  <span className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                    {t('tablesDashboard.table', { defaultValue: 'Table' })} {tableNumber}
                  </span>
                </div>
                
                {(customerName || showDeliveredDriver) && (
                  <div className="flex flex-col gap-1">
                    {customerName && (
                      <div className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                        {customerName}
                      </div>
                    )}
                    {showDeliveredDriver && (
                      <div className={`inline-flex items-center gap-1.5 text-xs font-medium ${isDark ? 'text-green-300' : 'text-green-700'}`}>
                        <Truck className="w-3 h-3" />
                        {t('tablesDashboard.deliveredBy', { defaultValue: 'Delivered by {{name}}', name: driverName })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Center: Completed badge */}
              <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${
                isDark
                  ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                  : 'bg-green-100 text-green-700 border border-green-300'
              }`}>
                <CheckCircle className="w-3 h-3" />
                {t('tablesDashboard.status.delivered', { defaultValue: 'Delivered' })}
              </div>

              {/* Right: Amount and timestamps */}
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {formatCurrency(totalAmount)}
                  </div>
                  <div className={`text-xs ${isDark ? 'text-white/50' : 'text-gray-400'}`}>
                    {formatTime(createdAt)} - {formatTime(updatedAt)}
                  </div>
                </div>
                
                {/* Duration badge */}
                <div className={`px-2 py-1 rounded text-xs font-medium ${
                  isDark ? 'bg-white/10 text-white/70' : 'bg-gray-100 text-gray-600'
                }`}>
                  {getTimeDiff(createdAt, updatedAt)}
                </div>
              </div>
            </div>

            {/* Items summary */}
            {order.items && order.items.length > 0 && (
              <div className={`mt-3 pt-3 border-t ${isDark ? 'border-white/10' : 'border-green-100'}`}>
                <div className={`text-xs ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                  {order.items.length} {t('tablesDashboard.items', { defaultValue: 'items' })} -{' '}
                  {order.items.slice(0, 2).map((item, idx) => (
                    <span key={idx}>
                      {item.quantity}x {item.name}
                      {idx < Math.min(order.items.length - 1, 1) && ', '}
                    </span>
                  ))}
                  {order.items.length > 2 && (
                    <span> +{order.items.length - 2} {t('tablesDashboard.moreItems', { defaultValue: 'more' })}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

DeliveredTabContent.displayName = 'DeliveredTabContent';

// Canceled Tab Content - Displays today's canceled orders
// Requirements: 1.4 - Display all canceled orders from the current day with cancellation reason
interface CanceledTabContentProps {
  orders: Order[];
  today: string;
  isDark: boolean;
}

const CanceledTabContent: React.FC<CanceledTabContentProps> = memo(({ orders, today, isDark }) => {
  const { t } = useI18n();
  
  // Filter to show only today's canceled orders
  const canceledOrders = useMemo(() => {
    return orders.filter(order => {
      const orderDate = toLocalDateString(order.createdAt || order.created_at || '');
      return order.status === 'cancelled' && orderDate === today;
    }).sort((a, b) => {
      // Sort by updated time (most recently canceled first)
      const timeA = new Date(a.updatedAt || a.updated_at || 0).getTime();
      const timeB = new Date(b.updatedAt || b.updated_at || 0).getTime();
      return timeB - timeA;
    });
  }, [orders, today]);

  const formatTime = (dateString: string) => {
    return formatTimeValue(dateString, { hour: '2-digit', minute: '2-digit' });
  };

  if (canceledOrders.length === 0) {
    return (
      <div className={`h-full flex items-center justify-center ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
        <div className="text-center">
          <XCircle className="w-16 h-16 mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium">
            {t('tablesDashboard.noCanceledOrders', { defaultValue: 'No canceled orders today' })}
          </p>
          <p className="text-sm mt-1 opacity-75">
            {t('tablesDashboard.canceledWillAppear', { defaultValue: 'Canceled orders will appear here' })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pr-2 space-y-3 scrollbar-hide">
      {canceledOrders.map((order, index) => {
        const orderNumber = order.orderNumber || order.order_number || `#${index + 1}`;
        const tableNumber = order.tableNumber || order.table_number || '-';
        const totalAmount = order.totalAmount || order.total_amount || 0;
        const createdAt = order.createdAt || order.created_at || '';
        const updatedAt = order.updatedAt || order.updated_at || '';
        const customerName = order.customerName || order.customer_name || '';
        const cancellationReason = order.cancellationReason || t('tablesDashboard.noReasonProvided', { defaultValue: 'No reason provided' });

        return (
          <div
            key={order.id}
            className={`rounded-xl p-4 border transition-all duration-200 ${
              isDark
                ? 'bg-red-500/5 border-red-500/20 active:bg-red-500/10'
                : 'bg-red-50 border-red-200 active:bg-red-100 shadow-sm'
            }`}
          >
            <div className="flex items-center justify-between">
              {/* Left: Order number and table */}
              <div className="flex items-center gap-4">
                <div className="flex flex-col">
                  <span className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {orderNumber}
                  </span>
                  <span className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                    {t('tablesDashboard.table', { defaultValue: 'Table' })} {tableNumber}
                  </span>
                </div>
                
                {customerName && (
                  <div className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                    {customerName}
                  </div>
                )}
              </div>

              {/* Center: Canceled badge */}
              <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${
                isDark
                  ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                  : 'bg-red-100 text-red-700 border border-red-300'
              }`}>
                <XCircle className="w-3 h-3" />
                {t('tablesDashboard.status.canceled', { defaultValue: 'Canceled' })}
              </div>

              {/* Right: Amount and timestamps */}
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className={`text-lg font-bold line-through ${isDark ? 'text-white/50' : 'text-gray-400'}`}>
                    {formatCurrency(totalAmount)}
                  </div>
                  <div className={`text-xs ${isDark ? 'text-white/50' : 'text-gray-400'}`}>
                    {formatTime(updatedAt)}
                  </div>
                </div>
              </div>
            </div>

            {/* Cancellation reason */}
            <div className={`mt-3 pt-3 border-t ${isDark ? 'border-white/10' : 'border-red-100'}`}>
              <div className={`flex items-start gap-2 text-sm ${isDark ? 'text-red-400/80' : 'text-red-600'}`}>
                <span className="font-medium">{t('tablesDashboard.reason', { defaultValue: 'Reason' })}:</span>
                <span className={isDark ? 'text-white/60' : 'text-gray-600'}>{cancellationReason}</span>
              </div>
            </div>

            {/* Items summary */}
            {order.items && order.items.length > 0 && (
              <div className={`mt-2 text-xs ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                {order.items.length} {t('tablesDashboard.items', { defaultValue: 'items' })} -{' '}
                {order.items.slice(0, 2).map((item, idx) => (
                  <span key={idx}>
                    {item.quantity}x {item.name}
                    {idx < Math.min(order.items.length - 1, 1) && ', '}
                  </span>
                ))}
                {order.items.length > 2 && (
                  <span> +{order.items.length - 2} {t('tablesDashboard.moreItems', { defaultValue: 'more' })}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

CanceledTabContent.displayName = 'CanceledTabContent';

// Tables Tab Content - Displays table grid with status indicators
// Requirements: 1.5 - Display the table grid with status indicators (available, occupied, reserved, cleaning)
interface TablesTabContentProps {
  tables: RestaurantTable[];
  isDark: boolean;
  branchId: string;
  organizationId: string;
  onTableSelect?: (table: RestaurantTable) => void;
  onNavigateToMenu?: (tableId: string, tableNumber: number) => void;
}

const TablesTabContent: React.FC<TablesTabContentProps> = memo(({
  tables,
  isDark,
  branchId,
  organizationId,
  onTableSelect,
  onNavigateToMenu
}) => {
  const { t } = useI18n();
  const now = useSystemClock();
  const [filter, setFilter] = useState<TableStatus | 'all'>('all');
  const [floorFilter, setFloorFilter] = useState('all');
  const [tableViewMode, setTableViewMode] = useState<'list' | 'floorplan'>('list');
  const [selectedTable, setSelectedTable] = useState<RestaurantTable | null>(null);
  const [showReservationPanel, setShowReservationPanel] = useState(false);
  const tableGridScrollRef = useRef<HTMLDivElement>(null);

  const textStrong = isDark ? 'text-white' : 'text-slate-950';
  const textMuted = isDark ? 'text-slate-300/75' : 'text-slate-600';
  const shellClass = isDark
    ? 'border-white/10 bg-slate-950/55 shadow-[0_18px_45px_rgba(0,0,0,0.35)]'
    : 'border-slate-200/80 bg-white/85 shadow-[0_18px_45px_rgba(15,23,42,0.08)]';
  const subtleClass = isDark
    ? 'border-white/10 bg-white/[0.045]'
    : 'border-slate-200/90 bg-slate-50/90';

  const getFloorValue = useCallback((table: RestaurantTable) => {
    const raw = table.floorLevel ?? (table as any).floor_level ?? 1;
    return raw === null || raw === undefined || raw === '' ? '1' : String(raw);
  }, []);

  const floorLabel = useCallback((floor: string) => {
    if (floor === 'all') {
      return t('tablesDashboard.allFloors', { defaultValue: 'All floors' });
    }
    return t('tablesDashboard.floorNumber', { defaultValue: 'Floor {{floor}}', floor });
  }, [t]);

  const floorOptions = useMemo(() => {
    const values = Array.from(new Set(tables.map(table => getFloorValue(table))));
    return values.sort((left, right) => {
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        return leftNumber - rightNumber;
      }
      return left.localeCompare(right);
    });
  }, [getFloorValue, tables]);

  useEffect(() => {
    if (floorFilter !== 'all' && !floorOptions.includes(floorFilter)) {
      setFloorFilter('all');
    }
  }, [floorFilter, floorOptions]);

  const floorScopedTables = useMemo(
    () => floorFilter === 'all'
      ? tables
      : tables.filter(table => getFloorValue(table) === floorFilter),
    [floorFilter, getFloorValue, tables],
  );

  const stats = useMemo(() => {
    const total = floorScopedTables.length;
    const available = floorScopedTables.filter(table => resolveTableDisplayStatus(table) === 'available').length;
    const occupied = floorScopedTables.filter(table => resolveTableDisplayStatus(table) === 'occupied').length;
    const reserved = floorScopedTables.filter(table => resolveTableDisplayStatus(table) === 'reserved').length;
    const cleaning = floorScopedTables.filter(table => resolveTableDisplayStatus(table) === 'cleaning').length;
    const due = floorScopedTables.reduce((sum, table) => {
      const balance = table.balance || {};
      const outstanding = Number(table.unpaidBalance ?? balance.outstanding_balance ?? 0);
      return sum + (Number.isFinite(outstanding) ? outstanding : 0);
    }, 0);
    const occupancyRate = total > 0 ? Math.round((occupied / total) * 100) : 0;

    return { total, available, occupied, reserved, cleaning, due, occupancyRate };
  }, [floorScopedTables]);

  const filteredTables = useMemo(() => {
    if (filter === 'all') return floorScopedTables;
    return floorScopedTables.filter(table => resolveTableDisplayStatus(table) === filter);
  }, [filter, floorScopedTables]);

  const statusConfig: Record<TableStatus, {
    label: string;
    cardClass: string;
    badgeClass: string;
    iconClass: string;
    progressClass: string;
  }> = {
    available: {
      label: t('tablesDashboard.tableStatus.available', { defaultValue: 'Available' }),
      cardClass: isDark
        ? 'border-emerald-400/35 bg-emerald-500/10'
        : 'border-emerald-300 bg-emerald-50/90',
      badgeClass: isDark
        ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200'
        : 'border-emerald-200 bg-emerald-100 text-emerald-700',
      iconClass: 'text-emerald-500',
      progressClass: 'bg-emerald-500',
    },
    occupied: {
      label: t('tablesDashboard.tableStatus.occupied', { defaultValue: 'Occupied' }),
      cardClass: isDark
        ? 'border-yellow-400/45 bg-yellow-500/10'
        : 'border-yellow-300 bg-yellow-50/95',
      badgeClass: isDark
        ? 'border-yellow-400/30 bg-yellow-400/10 text-yellow-200'
        : 'border-yellow-200 bg-yellow-100 text-yellow-800',
      iconClass: 'text-yellow-500',
      progressClass: 'bg-yellow-500',
    },
    reserved: {
      label: t('tablesDashboard.tableStatus.reserved', { defaultValue: 'Reserved' }),
      cardClass: isDark
        ? 'border-amber-400/40 bg-amber-500/10'
        : 'border-amber-300 bg-amber-50',
      badgeClass: isDark
        ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
        : 'border-amber-200 bg-amber-100 text-amber-700',
      iconClass: 'text-amber-500',
      progressClass: 'bg-amber-500',
    },
    cleaning: {
      label: t('tablesDashboard.tableStatus.cleaning', { defaultValue: 'Cleaning' }),
      cardClass: isDark
        ? 'border-slate-400/25 bg-white/[0.045]'
        : 'border-slate-300 bg-slate-50',
      badgeClass: isDark
        ? 'border-slate-400/25 bg-slate-400/10 text-slate-200'
        : 'border-slate-200 bg-slate-100 text-slate-700',
      iconClass: 'text-slate-500',
      progressClass: 'bg-slate-500',
    },
    maintenance: {
      label: t('tablesDashboard.tableStatus.maintenance', { defaultValue: 'Maintenance' }),
      cardClass: isDark
        ? 'border-red-400/35 bg-red-500/10'
        : 'border-red-300 bg-red-50',
      badgeClass: isDark
        ? 'border-red-400/25 bg-red-400/10 text-red-200'
        : 'border-red-200 bg-red-100 text-red-700',
      iconClass: 'text-red-500',
      progressClass: 'bg-red-500',
    },
    unavailable: {
      label: t('tablesDashboard.tableStatus.unavailable', { defaultValue: 'Unavailable' }),
      cardClass: isDark
        ? 'border-slate-500/25 bg-slate-800/35'
        : 'border-slate-300 bg-slate-100',
      badgeClass: isDark
        ? 'border-slate-500/25 bg-slate-500/10 text-slate-300'
        : 'border-slate-300 bg-slate-200 text-slate-700',
      iconClass: 'text-slate-500',
      progressClass: 'bg-slate-500',
    },
  };

  const readBalance = useCallback((table: RestaurantTable) => {
    const balance = table.balance || {};
    const total = Math.max(0, Number(balance.order_total ?? 0) || 0);
    const due = Math.max(0, Number(table.unpaidBalance ?? balance.outstanding_balance ?? 0) || 0);
    const paid = Math.max(0, Number(balance.paid_total ?? (total > 0 ? total - due : 0)) || 0);
    const tips = Math.max(0, Number(balance.tip_total ?? 0) || 0);
    return { total, paid, due, tips };
  }, []);

  const formatOccupiedDuration = useCallback((value?: string | null) => {
    if (!value) {
      return null;
    }
    const startedAt = new Date(value).getTime();
    if (!Number.isFinite(startedAt)) {
      return null;
    }
    const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - startedAt) / 60000));
    const hours = Math.floor(elapsedMinutes / 60);
    const minutes = elapsedMinutes % 60;
    const duration = hours > 0
      ? t('tablesDashboard.time.hoursMinutes', { defaultValue: '{{hours}}h {{minutes}}m', hours, minutes })
      : t('tablesDashboard.time.minutes', { defaultValue: '{{minutes}}m', minutes });
    const since = new Date(startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { since, duration };
  }, [now, t]);

  const handleTableClick = (table: RestaurantTable) => {
    setSelectedTable(table);
    setShowReservationPanel(table.status === 'reserved');
    onTableSelect?.(table);
  };

  const handleTableKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, table: RestaurantTable) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleTableClick(table);
    }
  };

  const handleClosePanel = () => {
    setSelectedTable(null);
    setShowReservationPanel(false);
  };

  const handleTableGridWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const scrollTarget = tableGridScrollRef.current;
    if (!scrollTarget) {
      return;
    }

    const maxScrollTop = scrollTarget.scrollHeight - scrollTarget.clientHeight;
    if (maxScrollTop <= 0) {
      return;
    }

    const deltaY =
      event.deltaMode === 1
        ? event.deltaY * 40
        : event.deltaMode === 2
          ? event.deltaY * scrollTarget.clientHeight
          : event.deltaY;
    const nextScrollTop = Math.max(
      0,
      Math.min(scrollTarget.scrollTop + deltaY, maxScrollTop),
    );

    event.preventDefault();
    event.stopPropagation();
    scrollTarget.scrollTop = nextScrollTop;
  }, []);

  // Reset the table-card scroll region to the top whenever the active status
  // filter, floor filter, or view mode changes, so a narrow filtered result set
  // starts fully visible below the fixed controls instead of inheriting the
  // previous scrollTop. Keyed on the filter/view inputs, not the table data, so
  // live updates don't reset the scroll position while staff are scrolling.
  useEffect(() => {
    const scrollTarget = tableGridScrollRef.current;
    if (scrollTarget) {
      scrollTarget.scrollTop = 0;
    }
  }, [filter, floorFilter, tableViewMode]);

  if (tables.length === 0) {
    return (
      <div className={`h-full flex items-center justify-center ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
        <div className="text-center">
          <LayoutGrid className="w-16 h-16 mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium">
            {t('tablesDashboard.noTables', { defaultValue: 'No tables configured' })}
          </p>
          <p className="text-sm mt-1 opacity-75">
            {t('tablesDashboard.tablesWillAppear', { defaultValue: 'Add tables in the Admin Dashboard' })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" onWheel={handleTableGridWheel}>
        <div className="mb-4 shrink-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid min-w-[360px] grid-cols-3 gap-2">
              <div className={`rounded-2xl border px-4 py-3 backdrop-blur-xl ${subtleClass}`}>
                <div className={`text-[11px] font-semibold uppercase tracking-wide ${textMuted}`}>
                  {t('tablesDashboard.occupied', { defaultValue: 'Occupied' })}
                </div>
                <div className={`mt-1 text-xl font-bold ${textStrong}`}>{stats.occupied}/{stats.total}</div>
              </div>
              <div className={`rounded-2xl border px-4 py-3 backdrop-blur-xl ${subtleClass}`}>
                <div className={`text-[11px] font-semibold uppercase tracking-wide ${textMuted}`}>
                  {t('tablesDashboard.openDue', { defaultValue: 'Open due' })}
                </div>
                <div className="mt-1 text-xl font-bold text-amber-600 dark:text-amber-300">{formatCurrency(stats.due)}</div>
              </div>
              <div className={`rounded-2xl border px-4 py-3 backdrop-blur-xl ${subtleClass}`}>
                <div className={`text-[11px] font-semibold uppercase tracking-wide ${textMuted}`}>
                  {t('tablesDashboard.rate', { defaultValue: 'Rate' })}
                </div>
                <div className={`mt-1 text-xl font-bold ${
                  stats.occupancyRate > 80
                    ? 'text-red-500'
                    : stats.occupancyRate > 50
                      ? 'text-amber-500'
                      : 'text-emerald-500'
                }`}>
                  {stats.occupancyRate}%
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <div className={`inline-flex rounded-xl border p-1 ${subtleClass}`}>
                <button
                  type="button"
                  onClick={() => setTableViewMode('list')}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${
                    tableViewMode === 'list'
                      ? 'bg-yellow-400 text-black'
                      : isDark
                        ? 'text-slate-200 active:bg-white/[0.08]'
                        : 'text-slate-700 active:bg-white'
                  }`}
                >
                  <LayoutGrid className="h-4 w-4" />
                  {t('tablesDashboard.viewMode.list', { defaultValue: 'List' })}
                </button>
                <button
                  type="button"
                  onClick={() => setTableViewMode('floorplan')}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${
                    tableViewMode === 'floorplan'
                      ? 'bg-yellow-400 text-black'
                      : isDark
                        ? 'text-slate-200 active:bg-white/[0.08]'
                        : 'text-slate-700 active:bg-white'
                  }`}
                >
                  <MapIcon className="h-4 w-4" />
                  {t('tablesDashboard.viewMode.floorPlan', { defaultValue: '2D' })}
                </button>
              </div>
              {(['all', 'available', 'occupied', 'reserved', 'cleaning'] as const).map(status => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setFilter(status)}
                  className={`rounded-xl px-3 py-2 text-sm font-semibold transition-all ${
                    filter === status
                      ? 'bg-yellow-400 text-black shadow-lg shadow-yellow-500/20'
                      : isDark
                        ? 'bg-white/[0.06] text-slate-200 active:bg-white/[0.1]'
                        : 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 active:bg-slate-50'
                  }`}
                >
                  {status === 'all' ? t('tablesDashboard.all', { defaultValue: 'All' }) : statusConfig[status].label}
                  {status !== 'all' ? (
                    <span className="ml-1 opacity-70">
                      {status === 'available'
                        ? stats.available
                        : status === 'occupied'
                          ? stats.occupied
                          : status === 'reserved'
                            ? stats.reserved
                            : stats.cleaning}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>

          <div className={`flex items-center gap-2 overflow-x-auto rounded-xl border p-1 backdrop-blur-xl scrollbar-hide ${subtleClass}`}>
            <span className={`ml-2 mr-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide ${textMuted}`}>
              <LayoutGrid className="h-3.5 w-3.5" />
              {t('tablesDashboard.floor', { defaultValue: 'Floor' })}
            </span>
            <button
              type="button"
              onClick={() => setFloorFilter('all')}
              className={`rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${
                floorFilter === 'all'
                  ? 'bg-yellow-400 text-black'
                  : isDark
                    ? 'text-slate-200 active:bg-white/[0.08]'
                    : 'text-slate-700 active:bg-white'
              }`}
            >
              {floorLabel('all')}
            </button>
            {floorOptions.map(floor => (
              <button
                key={floor}
                type="button"
                onClick={() => setFloorFilter(floor)}
                className={`rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${
                  floorFilter === floor
                    ? 'bg-yellow-400 text-black'
                    : isDark
                      ? 'text-slate-200 active:bg-white/[0.08]'
                      : 'text-slate-700 active:bg-white'
                }`}
              >
                {floorLabel(floor)}
              </button>
            ))}
          </div>
        </div>

        <div
          data-testid="tables-dashboard-table-grid-container"
          className="min-h-0 flex-1 overflow-hidden"
        >
          <div
            ref={tableGridScrollRef}
            data-testid="tables-dashboard-table-scroll-region"
            className="h-full min-h-0 overflow-y-auto overflow-x-hidden pb-28 pr-24 scrollbar-hide touch-scroll"
          >
          {tableViewMode === 'floorplan' ? (
            <TableFloorPlanView
              tables={filteredTables}
              isDark={isDark}
              selectedTableId={selectedTable?.id ?? null}
              onTableSelect={handleTableClick}
              className="min-h-full"
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3 pb-3">
            {filteredTables.map(table => {
              const displayStatus = resolveTableDisplayStatus(table);
              const visual = statusConfig[displayStatus] || statusConfig.available;
              const balance = readBalance(table);
              const paidPercent = balance.total > 0 ? Math.min(100, Math.round((balance.paid / balance.total) * 100)) : 0;
              const waiterName = table.currentWaiterName || t('tablesDashboard.unassigned', { defaultValue: 'Unassigned' });
              const guestCount = table.guestCount || table.capacity || 0;
              const isSelected = selectedTable?.id === table.id;
              const hasOpenCheck = tableHasOpenCheckReference(table);
              const occupiedInfo = hasOpenCheck ? formatOccupiedDuration(table.occupiedSince) : null;
              // Cleaning/maintenance/unavailable tables are not ready for guests and must not
              // offer guest order actions, even when no open check remains after payment.
              const needsAttention =
                !hasOpenCheck &&
                (displayStatus === 'cleaning' ||
                  displayStatus === 'maintenance' ||
                  displayStatus === 'unavailable');
              const attentionActionLabel =
                displayStatus === 'cleaning'
                  ? t('tablesDashboard.markCleaned', { defaultValue: 'Mark cleaned' })
                  : t('tablesDashboard.backInService', { defaultValue: 'Back in service' });

              return (
                <div
                  key={table.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleTableClick(table)}
                  onKeyDown={(event) => handleTableKeyDown(event, table)}
                  className={`group min-h-[205px] cursor-pointer rounded-2xl border p-4 backdrop-blur-xl transition-all duration-200 active:scale-[0.99] focus:outline-none focus:ring-2 focus:ring-yellow-400/45 ${
                    visual.cardClass
                  } ${isSelected ? 'ring-2 ring-yellow-500/70' : ''}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className={`flex items-center gap-1.5 text-xs font-semibold tracking-wide ${textMuted}`}>
                        <LayoutGrid className="h-3.5 w-3.5" />
                        {floorLabel(getFloorValue(table))}
                      </div>
                      <div className={`mt-1 truncate text-3xl font-black ${textStrong}`}>#{table.tableNumber}</div>
                    </div>
                    <span className={`shrink-0 rounded-xl border px-2.5 py-1 text-xs font-bold ${visual.badgeClass}`}>
                      {visual.label}
                    </span>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                    <div className={`rounded-2xl border px-3 py-2 ${isDark ? 'border-white/10 bg-black/20' : 'border-white/70 bg-white/65'}`}>
                      <div className={`flex items-center gap-1 text-xs font-medium ${textMuted}`}>
                        <Users className="h-3.5 w-3.5" />
                        {t('tablesDashboard.covers', { defaultValue: 'Covers' })}
                      </div>
                      <div className={`mt-1 font-bold ${textStrong}`}>{guestCount}/{table.capacity}</div>
                    </div>
                    <div className={`rounded-2xl border px-3 py-2 ${isDark ? 'border-white/10 bg-black/20' : 'border-white/70 bg-white/65'}`}>
                      <div className={`flex items-center gap-1 text-xs font-medium ${textMuted}`}>
                        <UserCheck className="h-3.5 w-3.5" />
                        {t('tablesDashboard.waiter', { defaultValue: 'Waiter' })}
                      </div>
                      <div className={`mt-1 truncate font-bold ${textStrong}`}>{waiterName}</div>
                    </div>
                  </div>

                  {hasOpenCheck ? (
                    <div className="mt-4">
                      <div className="flex items-end justify-between gap-3">
                        <div>
                          <div className={`text-[11px] font-bold uppercase tracking-wide ${textMuted}`}>
                            {t('tablesDashboard.due', { defaultValue: 'Due' })}
                          </div>
                          <div className={`text-2xl font-black ${balance.due > 0 ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300'}`}>
                            {formatCurrency(balance.due)}
                          </div>
                        </div>
                        <div className={`text-right text-xs ${textMuted}`}>
                          <div>{t('tablesDashboard.total', { defaultValue: 'Total' })} {formatCurrency(balance.total)}</div>
                          <div className="font-semibold text-emerald-600 dark:text-emerald-300">
                            {t('tablesDashboard.paid', { defaultValue: 'Paid' })} {formatCurrency(balance.paid)}
                          </div>
                        </div>
                      </div>
                      <div className={`mt-3 h-2 overflow-hidden rounded-full ${isDark ? 'bg-black/25' : 'bg-white/75'}`}>
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${visual.progressClass}`}
                          style={{ width: `${paidPercent}%` }}
                        />
                      </div>
                    </div>
                  ) : needsAttention ? (
                    <div className={`mt-4 rounded-2xl border px-3 py-3 ${isDark ? 'border-amber-400/25 bg-amber-400/10' : 'border-amber-200 bg-amber-50/80'}`}>
                      <div className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-4 w-4" />
                        {displayStatus === 'cleaning'
                          ? t('tablesDashboard.needsCleaning', { defaultValue: 'Needs cleaning' })
                          : t('tablesDashboard.outOfService', { defaultValue: 'Out of service' })}
                      </div>
                    </div>
                  ) : (
                    <div className={`mt-4 rounded-2xl border px-3 py-3 ${isDark ? 'border-emerald-400/20 bg-emerald-400/10' : 'border-emerald-200 bg-white/70'}`}>
                      <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                        <CheckCircle className="h-4 w-4" />
                        {t('tablesDashboard.readyForGuests', { defaultValue: 'Ready for guests' })}
                      </div>
                    </div>
                  )}

                  <div className={`mt-4 flex flex-wrap items-center gap-2 text-xs ${textMuted}`}>
                    {occupiedInfo ? (
                      <span className="inline-flex items-center gap-1 rounded-xl border border-yellow-400/20 bg-yellow-500/10 px-2 py-1 font-semibold text-yellow-800 dark:text-yellow-200">
                        <Clock3 className="h-3.5 w-3.5" />
                        {occupiedInfo.since} · {occupiedInfo.duration}
                      </span>
                    ) : null}
                    {table.currentOrderId ? (
                      <span className="inline-flex max-w-full items-center gap-1 rounded-xl border border-slate-400/20 px-2 py-1">
                        <ReceiptText className="h-3.5 w-3.5" />
                        <span className="truncate">{String(table.currentOrderId).slice(0, 10)}</span>
                      </span>
                    ) : null}
                  </div>

                  {needsAttention ? (
                    <div className="mt-4">
                      <span className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-amber-600 px-3 py-2 text-sm font-bold text-white transition-colors group-active:bg-amber-500">
                        <AlertTriangle className="h-4 w-4" />
                        {attentionActionLabel}
                      </span>
                    </div>
                  ) : (
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <span className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-bold transition-colors ${
                      hasOpenCheck
                        ? 'bg-yellow-400 text-black group-active:bg-yellow-300'
                        : 'bg-emerald-600 text-white group-active:bg-emerald-500'
                    }`}>
                      {hasOpenCheck ? <WalletCards className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                      {hasOpenCheck
                        ? t('tablesDashboard.openCheck', { defaultValue: 'Open check' })
                        : t('tablesDashboard.newOrder', { defaultValue: 'New order' })}
                    </span>
                    <span className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-bold ${
                      isDark
                        ? 'border-white/10 bg-white/[0.06] text-slate-200'
                        : 'border-slate-200 bg-white/75 text-slate-700'
                    }`}>
                      {hasOpenCheck ? <Banknote className="h-4 w-4" /> : <ArrowRightLeft className="h-4 w-4" />}
                      {hasOpenCheck
                        ? t('tablesDashboard.pay', { defaultValue: 'Pay' })
                        : t('tablesDashboard.assign', { defaultValue: 'Assign' })}
                    </span>
                  </div>
                  )}
                </div>
              );
            })}
            </div>
          )}
        </div>
      </div>
      </div>

      {selectedTable && (
        showReservationPanel ? (
          <ReservationInfoPanel
            tableId={selectedTable.id}
            tableNumber={selectedTable.tableNumber}
            branchId={branchId}
            organizationId={organizationId}
            onClose={handleClosePanel}
            onNavigateToMenu={onNavigateToMenu}
          />
        ) : (
          <div className={`w-80 shrink-0 rounded-2xl border p-4 backdrop-blur-xl ${shellClass}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={`text-xs font-semibold tracking-wide ${textMuted}`}>
                  {floorLabel(getFloorValue(selectedTable))}
                </p>
                <h3 className={`truncate text-xl font-black ${textStrong}`}>
                  {t('tablesDashboard.tableDetails', { defaultValue: 'Table' })} #{selectedTable.tableNumber}
                </h3>
              </div>
              <button
                type="button"
                onClick={handleClosePanel}
                className={`rounded-xl p-2 transition-colors ${
                  isDark ? 'text-slate-300 active:bg-white/[0.08]' : 'text-slate-500 active:bg-slate-100'
                }`}
                aria-label={t('common.close', { defaultValue: 'Close' })}
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            {(() => {
              const displayStatus = resolveTableDisplayStatus(selectedTable);
              const visual = statusConfig[displayStatus] || statusConfig.available;
              const balance = readBalance(selectedTable);
              const hasOpenCheck = tableHasOpenCheckReference(selectedTable);
              const occupiedInfo = hasOpenCheck ? formatOccupiedDuration(selectedTable.occupiedSince) : null;
              return (
                <div className="mt-4 space-y-3">
                  <div className={`rounded-2xl border p-3 ${subtleClass}`}>
                    <div className={`text-xs font-semibold uppercase tracking-wide ${textMuted}`}>
                      {t('tablesDashboard.status', { defaultValue: 'Status' })}
                    </div>
                    <div className={`mt-1 inline-flex rounded-xl border px-2.5 py-1 text-sm font-bold ${visual.badgeClass}`}>
                      {visual.label}
                    </div>
                  </div>
                  <div className={`rounded-2xl border p-3 ${subtleClass}`}>
                    <div className={`text-xs font-semibold uppercase tracking-wide ${textMuted}`}>
                      {t('tablesDashboard.balance', { defaultValue: 'Balance' })}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div>
                        <p className={`text-xs ${textMuted}`}>{t('tablesDashboard.due', { defaultValue: 'Due' })}</p>
                        <p className="text-lg font-black text-amber-600 dark:text-amber-300">{formatCurrency(balance.due)}</p>
                      </div>
                      <div>
                        <p className={`text-xs ${textMuted}`}>{t('tablesDashboard.paid', { defaultValue: 'Paid' })}</p>
                        <p className="text-lg font-black text-emerald-600 dark:text-emerald-300">{formatCurrency(balance.paid)}</p>
                      </div>
                    </div>
                  </div>
                  <div className={`rounded-2xl border p-3 ${subtleClass}`}>
                    <div className={`flex items-center justify-between gap-3 text-sm ${textMuted}`}>
                      <span className="inline-flex items-center gap-1.5">
                        <Users className="h-4 w-4" />
                        {selectedTable.guestCount || selectedTable.capacity} / {selectedTable.capacity}
                      </span>
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <UserCheck className="h-4 w-4 shrink-0" />
                        <span className="truncate">{selectedTable.currentWaiterName || t('tablesDashboard.unassigned', { defaultValue: 'Unassigned' })}</span>
                      </span>
                    </div>
                    {occupiedInfo ? (
                      <div className="mt-2 inline-flex items-center gap-1.5 rounded-xl border border-yellow-400/20 bg-yellow-500/10 px-2 py-1 text-xs font-semibold text-yellow-800 dark:text-yellow-200">
                        <Clock3 className="h-3.5 w-3.5" />
                        {occupiedInfo.since} · {occupiedInfo.duration}
                      </div>
                    ) : null}
                  </div>
                  {selectedTable.notes ? (
                    <div className={`rounded-2xl border p-3 ${subtleClass}`}>
                      <div className={`text-xs font-semibold uppercase tracking-wide ${textMuted}`}>
                        {t('tablesDashboard.notes', { defaultValue: 'Notes' })}
                      </div>
                      <div className={`mt-1 text-sm font-medium ${textStrong}`}>
                        {selectedTable.notes}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })()}
          </div>
        )
      )}
    </div>
  );
});

TablesTabContent.displayName = 'TablesTabContent';

export default TablesDashboard;
