import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShoppingBag,
  Clock,
  CheckCircle,
  XCircle,
  RefreshCw,
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
  User,
  MapPin,
  Phone,
  Package,
  Truck,
  Store,
  Calendar,
  DollarSign,
  X
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { toast } from 'react-hot-toast';
import OrderDetailsModal from '../components/modals/OrderDetailsModal';
import { formatCurrency } from '../utils/format';
import CustomerOrderHistoryModal from '../components/modals/CustomerOrderHistoryModal';
import { getOrderStatusBadgeClasses } from '../utils/orderStatus';

interface OrderItem {
  id: string;
  menu_item_id: string;
  name: string;
  quantity: number;
  price: number;
  unit_price: number;
  total_price: number;
  customizations?: Record<string, any>;
  notes?: string;
}

interface Order {
  id: string;
  order_number: string;
  status: 'pending' | 'confirmed' | 'preparing' | 'ready' | 'completed' | 'cancelled';
  order_type: 'dine-in' | 'pickup' | 'delivery';
  payment_method: 'cash' | 'card' | 'digital_wallet' | 'other';
  payment_status?: 'pending' | 'paid' | 'partially_paid' | 'refunded' | 'failed';
  total_amount: number;
  subtotal?: number;
  tax_amount?: number;
  delivery_fee?: number;
  discount_amount?: number;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  delivery_address?: string;
  delivery_city?: string;
  delivery_postal_code?: string;
  delivery_floor?: string;
  delivery_notes?: string;
  table_number?: string;
  special_instructions?: string;
  name_on_ringer?: string;
  order_items: OrderItem[];
  created_at: string;
  updated_at: string;
  estimated_ready_time?: number;
}

interface FetchOrdersOptions {
  status?: string;
  order_type?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

const OrdersPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  // Customer history modal state
  const [showCustomerHistory, setShowCustomerHistory] = useState(false);
  const [customerHistoryPhone, setCustomerHistoryPhone] = useState('');

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [orderTypeFilter, setOrderTypeFilter] = useState<string>('all');

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 20;

  const isDark = resolvedTheme === 'dark';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const fetchOrders = useCallback(async () => {
    if (!window.electron?.ipcRenderer) {
      console.error('[OrdersPage] Electron API not available');
      toast.error('Electron API not available');
      setLoading(false);
      return;
    }

    setSyncing(true);
    try {
      const options: FetchOrdersOptions = {
        limit: pageSize,
        offset: (currentPage - 1) * pageSize,
      };

      if (statusFilter !== 'all') options.status = statusFilter;
      if (orderTypeFilter !== 'all') options.order_type = orderTypeFilter;
      if (searchTerm) options.search = searchTerm;
      if (dateFrom) options.date_from = dateFrom;
      if (dateTo) options.date_to = dateTo;

      console.log('[OrdersPage] Fetching orders with options:', options);
      const result = await window.electron.ipcRenderer.invoke('sync:fetch-orders', options);
      console.log('[OrdersPage] Fetch result:', {
        success: result.success,
        ordersCount: result.orders?.length,
        total: result.total,
        error: result.error
      });

      if (result.success) {
        setOrders(result.orders || []);
        setTotal(result.total || 0);
        console.log('[OrdersPage] Orders set:', result.orders?.length || 0);
      } else {
        console.error('[OrdersPage] Failed to fetch orders:', result.error);
        toast.error(result.error || 'Failed to load orders');
      }
    } catch (error) {
      console.error('[OrdersPage] Exception while fetching orders:', error);
      toast.error('Failed to load orders');
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, [statusFilter, orderTypeFilter, searchTerm, dateFrom, dateTo, currentPage, pageSize, t]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchOrders();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  const getStatusBadge = (status: string) => getOrderStatusBadgeClasses(status);

  const getOrderTypeIcon = (type: string) => {
    switch (type) {
      case 'delivery': return <Truck className="w-4 h-4" />;
      case 'pickup': return <ShoppingBag className="w-4 h-4" />;
      case 'dine-in': return <Store className="w-4 h-4" />;
      default: return <ShoppingBag className="w-4 h-4" />;
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  const handleClearFilters = () => {
    setStatusFilter('all');
    setOrderTypeFilter('all');
    setSearchTerm('');
    setDateFrom('');
    setDateTo('');
    setCurrentPage(1);
  };

  if (loading && orders.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <RefreshCw className="w-12 h-12 animate-spin text-blue-500 mx-auto mb-4" />
          <p className={isDark ? 'text-gray-300' : 'text-gray-700'}>Loading orders...</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col ${isDark ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-900'}`}>
      {/* Header */}
      <div className={`border-b ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold mb-1">{t('orders.title', 'Orders')}</h1>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {total} {total === 1 ? 'order' : 'orders'} total
              </p>
            </div>
            <button
              onClick={fetchOrders}
              disabled={syncing}
              className={`px-4 py-2 rounded-lg flex items-center gap-2 transition-colors ${isDark
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : 'bg-blue-500 hover:bg-blue-600 text-white'
                } ${syncing ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Refresh'}
            </button>
          </div>

          {/* Search and Filters */}
          <div className="space-y-3">
            <div className={`flex items-center gap-2 px-4 py-3 rounded-lg ${isDark ? 'bg-gray-700' : 'bg-gray-100'}`}>
              <Search className="w-5 h-5 text-gray-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search by order number, customer name, or phone..."
                className="flex-1 bg-transparent outline-none"
              />
              {searchTerm && (
                <button onClick={() => setSearchTerm('')} className="text-gray-400 hover:text-gray-600">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Filter Toggle */}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm ${isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-200 hover:bg-gray-300'
                }`}
            >
              <Filter className="w-4 h-4" />
              {showFilters ? 'Hide Filters' : 'Show Filters'}
            </button>

            {/* Filters Panel */}
            <AnimatePresence>
              {showFilters && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className={`grid grid-cols-3 gap-3 p-4 rounded-lg ${isDark ? 'bg-gray-700' : 'bg-gray-100'}`}>
                    <div>
                      <label className="text-xs mb-1 block opacity-70">Status</label>
                      <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                        className={`w-full px-3 py-2 rounded-lg text-sm ${isDark ? 'bg-gray-600' : 'bg-white'}`}
                      >
                        <option value="all">All Statuses</option>
                        <option value="pending">Pending</option>
                        <option value="confirmed">Confirmed</option>
                        <option value="preparing">Preparing</option>
                        <option value="ready">Ready</option>
                        <option value="completed">Completed</option>
                        <option value="cancelled">Cancelled</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs mb-1 block opacity-70">Order Type</label>
                      <select
                        value={orderTypeFilter}
                        onChange={(e) => setOrderTypeFilter(e.target.value)}
                        className={`w-full px-3 py-2 rounded-lg text-sm ${isDark ? 'bg-gray-600' : 'bg-white'}`}
                      >
                        <option value="all">All Types</option>
                        <option value="dine-in">Dine-In</option>
                        <option value="pickup">Pickup</option>
                        <option value="delivery">Delivery</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs mb-1 block opacity-70">Date From</label>
                      <input
                        type="date"
                        value={dateFrom}
                        onChange={(e) => setDateFrom(e.target.value)}
                        className={`w-full px-3 py-2 rounded-lg text-sm ${isDark ? 'bg-gray-600' : 'bg-white'}`}
                      />
                    </div>
                  </div>
                  <button
                    onClick={handleClearFilters}
                    className="mt-2 text-sm text-blue-500 hover:text-blue-600"
                  >
                    Clear all filters
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Orders List */}
      <div className="flex-1 overflow-y-auto p-6">
        {orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <ShoppingBag className={`w-16 h-16 mb-4 ${isDark ? 'text-gray-600' : 'text-gray-400'}`} />
            <h3 className="text-lg font-semibold mb-2">No Orders Found</h3>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              No orders match your current filters.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {orders.map((order) => (
              <motion.div
                key={order.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className={`p-4 rounded-lg border cursor-pointer transition-all ${isDark
                  ? 'bg-gray-800 border-gray-700 hover:border-blue-500'
                  : 'bg-white border-gray-200 hover:border-blue-400 hover:shadow-md'
                  }`}
                onClick={() => setSelectedOrder(order)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="font-mono font-bold text-lg">#{order.order_number}</span>
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusBadge(order.status)}`}>
                        {order.status}
                      </span>
                      <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs ${isDark ? 'bg-gray-700' : 'bg-gray-100'}`}>
                        {getOrderTypeIcon(order.order_type)}
                        <span>{order.order_type}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-4 text-sm">
                      {order.customer_name && (
                        <div className="flex items-center gap-2">
                          <User className="w-4 h-4 opacity-50" />
                          <span>{order.customer_name}</span>
                        </div>
                      )}
                      {order.customer_phone && (
                        <div className="flex items-center gap-2">
                          <Phone className="w-4 h-4 opacity-50" />
                          <span>{order.customer_phone}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <Package className="w-4 h-4 opacity-50" />
                        <span>{order.order_items?.length || 0} items</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-2xl font-bold mb-1">
                      {formatMoney(order.total_amount)}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                      {new Date(order.created_at).toLocaleString()}
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className={`border-t p-4 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
          <div className="flex items-center justify-between">
            <div className="text-sm opacity-70">
              Page {currentPage} of {totalPages}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
                className={`px-3 py-2 rounded-lg ${currentPage === 1
                  ? 'opacity-50 cursor-not-allowed'
                  : isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-200 hover:bg-gray-300'
                  }`}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={currentPage === totalPages}
                className={`px-3 py-2 rounded-lg ${currentPage === totalPages
                  ? 'opacity-50 cursor-not-allowed'
                  : isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-200 hover:bg-gray-300'
                  }`}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Order Detail Modal */}
      <OrderDetailsModal
        isOpen={!!selectedOrder}
        orderId={selectedOrder?.id || selectedOrder?.order_number || ''}
        order={selectedOrder}
        onClose={() => setSelectedOrder(null)}
        onShowCustomerHistory={(phone) => {
          setCustomerHistoryPhone(phone);
          setShowCustomerHistory(true);
        }}
      />

      {/* Customer Order History Modal */}
      <CustomerOrderHistoryModal
        isOpen={showCustomerHistory}
        customerPhone={customerHistoryPhone}
        customerName={selectedOrder?.customer_name}
        onClose={() => {
          setShowCustomerHistory(false);
          setCustomerHistoryPhone('');
        }}
        onViewOrder={(orderId) => {
          // Close history modal and load the selected order
          setShowCustomerHistory(false);
          // Optionally fetch and show the order
        }}
      />
    </div>
  );
};

export default OrdersPage;

