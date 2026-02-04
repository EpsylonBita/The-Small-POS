import React, { memo, useMemo } from 'react';
import { ClipboardList } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOrderStore } from '../hooks/useOrderStore';
import type { Order } from '../types/orders';
import OrderCard from './order/OrderCard';
import SkeletonLoader from './ui/SkeletonLoader';
import LoadingSpinner from './ui/LoadingSpinner';

interface OrderGridProps {
  orders?: Order[];
  selectedOrders: string[];
  onToggleOrderSelection: (orderId: string) => void;
  onOrderDoubleClick?: (orderId: string) => void;
  activeTab: 'orders' | 'delivered' | 'canceled';
  className?: string;
}

const OrderGrid = memo<OrderGridProps>(({
  orders: ordersProp,
  selectedOrders,
  onToggleOrderSelection,
  onOrderDoubleClick,
  activeTab,
  className = ''
}) => {
  const { t } = useTranslation();
  const { orders: storeOrders, filter, isLoading } = useOrderStore();
  const baseOrders = ordersProp ?? storeOrders ?? [];
  const shouldApplyFilters = !ordersProp;

  // Memoized filtered orders based on active tab - use direct orders instead of getFilteredOrders
  const filteredOrders = useMemo(() => {
    // Start with all orders
    let filtered = baseOrders;

    if (!shouldApplyFilters) {
      return filtered;
    }

    // Apply global filters first (status, orderType, searchTerm)
    if (filter.status !== 'all') {
      const statusFilter = filter.status.toLowerCase();
      filtered = filtered.filter(order => (order.status || '').toLowerCase() === statusFilter);
    }

    if (filter.orderType !== 'all') {
      const typeFilter = filter.orderType.toLowerCase();
      filtered = filtered.filter(order => ((order.orderType || (order as any).order_type || '') as string).toLowerCase() === typeFilter);
    }

    if (filter.searchTerm) {
      const searchTerm = filter.searchTerm.toLowerCase();
      filtered = filtered.filter(order => {
        const orderNumber = (order.orderNumber || (order as any).order_number || '').toString().toLowerCase();
        const customerName = (order.customerName || (order as any).customer_name || '').toString().toLowerCase();
        const customerPhone = (order.customerPhone || (order as any).customer_phone || '').toString();
        return (
          orderNumber.includes(searchTerm) ||
          customerName.includes(searchTerm) ||
          customerPhone.includes(searchTerm)
        );
      });
    }

    // Then apply tab-based filtering
    if (activeTab === 'orders') {
      // Show pending, confirmed, preparing, and ready orders
      filtered = filtered.filter(order => {
        const status = (order.status || '').toLowerCase();
        return ['pending', 'confirmed', 'preparing', 'ready'].includes(status);
      });
    } else if (activeTab === 'delivered') {
      // Show delivered orders (include completed)
      filtered = filtered.filter(order => {
        const status = (order.status || '').toLowerCase();
        return status === 'delivered' || status === 'completed';
      });
    } else if (activeTab === 'canceled') {
      // Show cancelled orders
      filtered = filtered.filter(order => (order.status || '').toLowerCase() === 'cancelled');
    }

    return filtered;
  }, [baseOrders, filter, activeTab, shouldApplyFilters]); // Use orders directly, not getFilteredOrders

  // Memoized order cards with sequential indexing
  const orderCards = useMemo(() => 
    filteredOrders.map((order, index) => (
      <OrderCard
        key={order.id}
        order={order}
        orderIndex={index}
        isSelected={selectedOrders.includes(order.id)}
        onSelect={onToggleOrderSelection}
        onDoubleClick={onOrderDoubleClick}
      />
    )), 
    [filteredOrders, selectedOrders, onToggleOrderSelection, onOrderDoubleClick]
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="animate-pulse">
            <SkeletonLoader 
              height="h-20" 
              className="rounded-full"
            />
          </div>
        ))}
      </div>
    );
  }

  if (filteredOrders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 space-y-4">
        <ClipboardList className="h-14 w-14 opacity-50" />
        <div className="text-white/50 text-lg font-medium">{t('dashboard.noOrders', 'No orders found')}</div>
        <div className="text-white/30 text-sm">{t('dashboard.ordersWillAppear', 'Orders will appear here when created')}</div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-2 sm:gap-3 overflow-y-auto max-h-[calc(100vh-280px)] max-h-[calc(100dvh-280px)] pr-1 sm:pr-2 touch-scroll scrollbar-hide ${className}`}>
      {orderCards}
    </div>
  );
});

OrderGrid.displayName = 'OrderGrid';
export default OrderGrid; 
