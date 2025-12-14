import React, { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrderStore } from '../hooks/useOrderStore';
import OrderCard from './order/OrderCard';
import SkeletonLoader from './ui/SkeletonLoader';
import LoadingSpinner from './ui/LoadingSpinner';

interface OrderGridProps {
  selectedOrders: string[];
  onToggleOrderSelection: (orderId: string) => void;
  onOrderDoubleClick?: (orderId: string) => void;
  activeTab: 'orders' | 'delivered' | 'canceled';
  className?: string;
}

const OrderGrid = memo<OrderGridProps>(({
  selectedOrders,
  onToggleOrderSelection,
  onOrderDoubleClick,
  activeTab,
  className = ''
}) => {
  const { t } = useTranslation();
  const { orders, filter, isLoading } = useOrderStore();

  // Memoized filtered orders based on active tab - use direct orders instead of getFilteredOrders
  const filteredOrders = useMemo(() => {
    // Start with all orders
    let filtered = orders;
    
    // Apply global filters first (status, orderType, searchTerm)
    if (filter.status !== 'all') {
      filtered = filtered.filter(order => order.status === filter.status);
    }
    
    if (filter.orderType !== 'all') {
      filtered = filtered.filter(order => order.orderType === filter.orderType);
    }
    
    if (filter.searchTerm) {
      const searchTerm = filter.searchTerm.toLowerCase();
      filtered = filtered.filter(order => 
        order.orderNumber.toLowerCase().includes(searchTerm) ||
        order.customerName?.toLowerCase().includes(searchTerm) ||
        order.customerPhone?.includes(searchTerm)
      );
    }
    
    // Then apply tab-based filtering
    if (activeTab === 'orders') {
      // Show pending, preparing, and ready orders
      filtered = filtered.filter(order => 
        ['pending', 'preparing', 'ready'].includes(order.status)
      );
    } else if (activeTab === 'delivered') {
      // Show delivered orders (include completed)
      filtered = filtered.filter(order =>
        order.status === 'delivered' || order.status === 'completed'
      );
    } else if (activeTab === 'canceled') {
      // Show cancelled orders
      filtered = filtered.filter(order => order.status === 'cancelled');
    }
    
    return filtered;
  }, [orders, filter, activeTab]); // Use orders directly, not getFilteredOrders

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
        <div className="text-6xl opacity-50">📋</div>
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