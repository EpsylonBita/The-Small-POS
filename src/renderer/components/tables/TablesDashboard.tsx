import React, { memo, useState, useEffect, useMemo, useCallback } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { useI18n } from '../../contexts/i18n-context';
import { useOrderStore } from '../../hooks/useOrderStore';
import { useTables } from '../../hooks/useTables';
import { ReservationInfoPanel } from './ReservationInfoPanel';
import type { Order } from '../../types/orders';
import type { RestaurantTable, TablesDashboardTab, TabConfig, TableStatus } from '../../types/tables';
import { ClipboardList, CheckCircle, XCircle, LayoutGrid, Users, RefreshCw, Plus } from 'lucide-react';

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
  const today = useMemo(() => {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }, []);

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
      const orderDate = (order.createdAt || order.created_at || '').split('T')[0];
      return (order.status === 'delivered' || order.status === 'completed') && 
             orderDate === today;
    });

    const canceledOrders = tableOrders.filter(order => {
      const orderDate = (order.createdAt || order.created_at || '').split('T')[0];
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
      return isDark ? 'text-white/70 hover:text-white' : 'text-gray-600 hover:text-gray-800';
    }

    switch (tab.color) {
      case 'green':
        return 'text-green-500 drop-shadow-[0_0_8px_rgba(34,197,94,0.8)]';
      case 'orange':
        return 'text-orange-500 drop-shadow-[0_0_8px_rgba(249,115,22,0.8)]';
      case 'red':
        return 'text-red-500 drop-shadow-[0_0_8px_rgba(239,68,68,0.8)]';
      case 'blue':
        return 'text-blue-500 drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]';
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
          className={`mr-2 p-2 rounded-lg transition-all duration-200 ${
            isDark
              ? 'hover:bg-white/10 text-white/70 hover:text-white disabled:text-white/30'
              : 'hover:bg-gray-200 text-gray-600 hover:text-gray-800 disabled:text-gray-300'
          }`}
          title={t('tablesDashboard.refresh', { defaultValue: 'Refresh' })}
        >
          <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
        </button>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`flex-1 min-w-[90px] px-3 sm:px-4 py-2.5 sm:py-3 rounded-lg font-medium transition-all duration-200 relative touch-feedback active:scale-95 ${
              activeTab === tab.id
                ? isDark
                  ? 'bg-white/20 shadow-lg'
                  : 'bg-white backdrop-blur-sm shadow-sm border border-gray-200/30'
                : isDark
                  ? 'hover:bg-white/10 active:bg-white/20'
                  : 'hover:bg-white/60 active:bg-white/80'
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
                      ? 'bg-orange-500/20 text-orange-500'
                      : tab.color === 'red'
                        ? 'bg-red-500/20 text-red-500'
                        : 'bg-blue-500/20 text-blue-500'
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
      <button
        onClick={onAddOrder}
        className={`fixed bottom-6 right-6 w-16 h-16 rounded-full shadow-lg transition-all duration-300 z-50 flex items-center justify-center ${
          isDark
            ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-500/30'
            : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg'
        } hover:scale-110 active:scale-95`}
        title={t('tablesDashboard.addOrder', { defaultValue: 'Add Order' })}
      >
        <Plus className="w-8 h-8" />
      </button>
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
          ? 'bg-purple-500/20 text-purple-400 border-purple-500/30'
          : 'bg-purple-100 text-purple-700 border-purple-300';
      case 'ready':
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
      default:
        return status;
    }
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatAmount = (amount: number) => {
    return `€${amount.toFixed(2)}`;
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
    <div className="h-full overflow-y-auto pr-2 space-y-3">
      {activeOrders.map((order, index) => {
        const orderNumber = order.orderNumber || order.order_number || `#${index + 1}`;
        const tableNumber = order.tableNumber || order.table_number || '-';
        const totalAmount = order.totalAmount || order.total_amount || 0;
        const createdAt = order.createdAt || order.created_at || '';
        const customerName = order.customerName || order.customer_name || '';

        return (
          <div
            key={order.id}
            className={`rounded-xl p-4 border transition-all duration-200 hover:scale-[1.01] cursor-pointer ${
              isDark
                ? 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20'
                : 'bg-white border-gray-200 hover:bg-gray-50 hover:border-gray-300 shadow-sm'
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
              <div className={`px-3 py-1 rounded-full text-xs font-medium border ${getStatusBadgeColor(order.status)}`}>
                {getStatusLabel(order.status)}
              </div>

              {/* Right: Amount and time */}
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {formatAmount(totalAmount)}
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
      const orderDate = (order.createdAt || order.created_at || '').split('T')[0];
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
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatAmount = (amount: number) => {
    return `€${amount.toFixed(2)}`;
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
    <div className="h-full overflow-y-auto pr-2 space-y-3">
      {deliveredOrders.map((order, index) => {
        const orderNumber = order.orderNumber || order.order_number || `#${index + 1}`;
        const tableNumber = order.tableNumber || order.table_number || '-';
        const totalAmount = order.totalAmount || order.total_amount || 0;
        const createdAt = order.createdAt || order.created_at || '';
        const updatedAt = order.updatedAt || order.updated_at || '';
        const customerName = order.customerName || order.customer_name || '';

        return (
          <div
            key={order.id}
            className={`rounded-xl p-4 border transition-all duration-200 ${
              isDark
                ? 'bg-green-500/5 border-green-500/20 hover:bg-green-500/10'
                : 'bg-green-50 border-green-200 hover:bg-green-100 shadow-sm'
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
                    {formatAmount(totalAmount)}
                  </div>
                  <div className={`text-xs ${isDark ? 'text-white/50' : 'text-gray-400'}`}>
                    {formatTime(createdAt)} → {formatTime(updatedAt)}
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
                  {order.items.length} {t('tablesDashboard.items', { defaultValue: 'items' })} • {' '}
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
      const orderDate = (order.createdAt || order.created_at || '').split('T')[0];
      return order.status === 'cancelled' && orderDate === today;
    }).sort((a, b) => {
      // Sort by updated time (most recently canceled first)
      const timeA = new Date(a.updatedAt || a.updated_at || 0).getTime();
      const timeB = new Date(b.updatedAt || b.updated_at || 0).getTime();
      return timeB - timeA;
    });
  }, [orders, today]);

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatAmount = (amount: number) => {
    return `€${amount.toFixed(2)}`;
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
    <div className="h-full overflow-y-auto pr-2 space-y-3">
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
                ? 'bg-red-500/5 border-red-500/20 hover:bg-red-500/10'
                : 'bg-red-50 border-red-200 hover:bg-red-100 shadow-sm'
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
                    {formatAmount(totalAmount)}
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
                {order.items.length} {t('tablesDashboard.items', { defaultValue: 'items' })} • {' '}
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
  const [filter, setFilter] = useState<TableStatus | 'all'>('all');
  const [selectedTable, setSelectedTable] = useState<RestaurantTable | null>(null);
  const [showReservationPanel, setShowReservationPanel] = useState(false);

  // Calculate occupancy stats
  const stats = useMemo(() => {
    const total = tables.length;
    const available = tables.filter(t => t.status === 'available').length;
    const occupied = tables.filter(t => t.status === 'occupied').length;
    const reserved = tables.filter(t => t.status === 'reserved').length;
    const cleaning = tables.filter(t => t.status === 'cleaning').length;
    const occupancyRate = total > 0 ? Math.round((occupied / total) * 100) : 0;

    return { total, available, occupied, reserved, cleaning, occupancyRate };
  }, [tables]);

  // Filter tables based on selected filter
  const filteredTables = useMemo(() => {
    if (filter === 'all') return tables;
    return tables.filter(t => t.status === filter);
  }, [tables, filter]);

  const statusConfig: Record<TableStatus, { color: string; label: string; bgClass: string }> = {
    available: { 
      color: 'green', 
      label: t('tablesDashboard.tableStatus.available', { defaultValue: 'Available' }),
      bgClass: 'border-green-500 bg-green-500/10'
    },
    occupied: { 
      color: 'blue', 
      label: t('tablesDashboard.tableStatus.occupied', { defaultValue: 'Occupied' }),
      bgClass: 'border-blue-500 bg-blue-500/10'
    },
    reserved: { 
      color: 'yellow', 
      label: t('tablesDashboard.tableStatus.reserved', { defaultValue: 'Reserved' }),
      bgClass: 'border-yellow-500 bg-yellow-500/10'
    },
    cleaning: { 
      color: 'gray', 
      label: t('tablesDashboard.tableStatus.cleaning', { defaultValue: 'Cleaning' }),
      bgClass: 'border-gray-500 bg-gray-500/10'
    },
  };

  const handleTableClick = (table: RestaurantTable) => {
    setSelectedTable(table);
    // Show reservation panel for reserved tables
    setShowReservationPanel(table.status === 'reserved');
    onTableSelect?.(table);
  };

  const handleClosePanel = () => {
    setSelectedTable(null);
    setShowReservationPanel(false);
  };

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
    <div className="h-full flex gap-4">
      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Stats & Filters */}
        <div className="flex items-center justify-between mb-4">
          {/* Occupancy Stats */}
          <div className="flex gap-3">
            <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
              <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {t('tablesDashboard.occupancy', { defaultValue: 'Occupancy' })}
              </div>
              <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {stats.occupied}/{stats.total}
              </div>
            </div>
            <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
              <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {t('tablesDashboard.rate', { defaultValue: 'Rate' })}
              </div>
              <div className={`text-xl font-bold ${
                stats.occupancyRate > 80 
                  ? 'text-red-500' 
                  : stats.occupancyRate > 50 
                    ? 'text-yellow-500' 
                    : 'text-green-500'
              }`}>
                {stats.occupancyRate}%
              </div>
            </div>
          </div>

          {/* Status Filters */}
          <div className="flex gap-2">
            {(['all', 'available', 'occupied', 'reserved', 'cleaning'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-sm transition-all ${
                  filter === f
                    ? 'bg-blue-600 text-white'
                    : isDark
                      ? 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {f === 'all' 
                  ? t('tablesDashboard.all', { defaultValue: 'All' }) 
                  : statusConfig[f].label}
                {f !== 'all' && (
                  <span className="ml-1 opacity-70">
                    ({f === 'available' ? stats.available 
                      : f === 'occupied' ? stats.occupied 
                      : f === 'reserved' ? stats.reserved 
                      : stats.cleaning})
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Tables Grid */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {filteredTables.map(table => (
              <button
                key={table.id}
                onClick={() => handleTableClick(table)}
                className={`aspect-square p-3 rounded-xl border-2 transition-all hover:scale-105 ${
                  statusConfig[table.status].bgClass
                } ${
                  selectedTable?.id === table.id ? 'ring-2 ring-blue-500' : ''
                }`}
              >
                <div className="h-full flex flex-col items-center justify-center">
                  <LayoutGrid className={`w-6 h-6 mb-1 text-${statusConfig[table.status].color}-500`} />
                  <div className={`font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    #{table.tableNumber}
                  </div>
                  <div className={`flex items-center gap-1 text-xs mt-1 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                    <Users className="w-3 h-3" />
                    <span>{table.capacity}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Sidebar - Table Details or Reservation Info */}
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
          <div className={`w-72 rounded-2xl p-4 ${isDark ? 'bg-gray-800' : 'bg-white shadow-lg'}`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('tablesDashboard.tableDetails', { defaultValue: 'Table' })} #{selectedTable.tableNumber}
              </h3>
              <button 
                onClick={handleClosePanel} 
                className={`${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-gray-700'}`}
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div className={`p-3 rounded-lg ${isDark ? 'bg-gray-700' : 'bg-gray-50'}`}>
                <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('tablesDashboard.status', { defaultValue: 'Status' })}
                </div>
                <div className={`font-medium text-${statusConfig[selectedTable.status].color}-500`}>
                  {statusConfig[selectedTable.status].label}
                </div>
              </div>

              <div className={`p-3 rounded-lg ${isDark ? 'bg-gray-700' : 'bg-gray-50'}`}>
                <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('tablesDashboard.capacity', { defaultValue: 'Capacity' })}
                </div>
                <div className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {selectedTable.capacity} {t('tablesDashboard.guests', { defaultValue: 'guests' })}
                </div>
              </div>

              {selectedTable.currentOrderId && (
                <div className={`p-3 rounded-lg ${isDark ? 'bg-gray-700' : 'bg-gray-50'}`}>
                  <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {t('tablesDashboard.currentOrder', { defaultValue: 'Current Order' })}
                  </div>
                  <div className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {selectedTable.currentOrderId}
                  </div>
                </div>
              )}

              {selectedTable.notes && (
                <div className={`p-3 rounded-lg ${isDark ? 'bg-gray-700' : 'bg-gray-50'}`}>
                  <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {t('tablesDashboard.notes', { defaultValue: 'Notes' })}
                  </div>
                  <div className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {selectedTable.notes}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-4 space-y-2">
              <button className="w-full py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors">
                {t('tablesDashboard.viewOrder', { defaultValue: 'View Order' })}
              </button>
              <button className={`w-full py-2 rounded-lg transition-colors ${
                isDark ? 'bg-gray-700 text-white hover:bg-gray-600' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}>
                {t('tablesDashboard.changeStatus', { defaultValue: 'Change Status' })}
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
});

TablesTabContent.displayName = 'TablesTabContent';

export default TablesDashboard;
