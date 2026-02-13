import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShoppingBag,
  RefreshCw,
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
  User,
  Phone,
  Package,
  Truck,
  Store,
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
      <div className={`flex items-center justify-center h-full ${isDark ? 'bg-black text-zinc-200' : 'bg-gray-50 text-gray-800'}`}>
        <div className="text-center">
          <RefreshCw className={`w-12 h-12 animate-spin mx-auto mb-4 ${isDark ? 'text-cyan-500' : 'text-blue-500'}`} />
          <p className={isDark ? 'text-zinc-300' : 'text-gray-700'}>Loading orders...</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col ${isDark ? 'bg-black text-zinc-100' : 'bg-gray-50 text-gray-900'}`}>
      {/* Header */}
      <div className={`border-b ${isDark ? 'border-zinc-800 bg-gradient-to-br from-zinc-950 via-slate-950 to-zinc-900' : 'border-gray-200 bg-white'}`}>
        <div className="p-6 md:p-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className={`text-3xl font-bold tracking-tight mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>{t('orders.title', 'Orders')}</h1>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
                {total} {total === 1 ? 'order' : 'orders'} total
              </p>
            </div>
            <button
              onClick={fetchOrders}
              disabled={syncing}
              className={`px-4 py-2.5 rounded-xl flex items-center gap-2 transition-all text-white ${isDark ? 'border border-blue-500/50 bg-blue-600/90 hover:bg-blue-500' : 'bg-blue-500 hover:bg-blue-600'} ${syncing ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Refresh'}
            </button>
          </div>

          {/* Search and Filters */}
          <div className="space-y-3">
            <div className={`flex items-center gap-2 px-4 py-3 rounded-xl border ${isDark ? 'bg-zinc-900/90 border-zinc-800 focus-within:border-cyan-500/50' : 'bg-gray-100 border-gray-200 focus-within:border-blue-400'}`}>
              <Search className={`w-5 h-5 ${isDark ? 'text-zinc-500' : 'text-gray-400'}`} />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search by order number, customer name, or phone..."
                className={`flex-1 bg-transparent outline-none ${isDark ? 'text-zinc-100 placeholder:text-zinc-500' : 'text-gray-900 placeholder:text-gray-500'}`}
              />
              {searchTerm && (
                <button onClick={() => setSearchTerm('')} className={`${isDark ? 'text-zinc-500 hover:text-zinc-200' : 'text-gray-400 hover:text-gray-700'} transition-colors`}>
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Filter Toggle */}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm border transition-colors ${isDark ? 'bg-zinc-900 border-zinc-800 hover:border-zinc-600' : 'bg-gray-100 border-gray-200 hover:border-gray-300'}`}
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
                  <div className={`grid grid-cols-1 md:grid-cols-3 gap-3 p-4 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-gray-100 border-gray-200'}`}>
                    <div>
                      <label className="text-xs mb-1 block opacity-70">Status</label>
                      <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                        className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-white border-gray-300'}`}
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
                        className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-white border-gray-300'}`}
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
                        className={`w-full px-3 py-2 rounded-lg text-sm border ${isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-white border-gray-300'}`}
                      />
                    </div>
                  </div>
                  <button
                    onClick={handleClearFilters}
                    className={`mt-2 text-sm transition-colors ${isDark ? 'text-cyan-400 hover:text-cyan-300' : 'text-blue-600 hover:text-blue-700'}`}
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
      <div className={`flex-1 overflow-y-auto p-6 ${isDark ? 'bg-gradient-to-b from-black via-black to-zinc-950/80' : 'bg-gray-50'}`}>
        {orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <ShoppingBag className={`w-16 h-16 mb-4 ${isDark ? 'text-zinc-700' : 'text-gray-400'}`} />
            <h3 className="text-lg font-semibold mb-2">No Orders Found</h3>
            <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-gray-600'}`}>
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
                className={`p-5 rounded-xl border cursor-pointer transition-all ${isDark ? 'border-zinc-800 bg-zinc-950/80 hover:border-cyan-500/50 hover:bg-zinc-900' : 'border-gray-200 bg-white hover:border-blue-400 hover:shadow-md'}`}
                onClick={() => setSelectedOrder(order)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="font-mono font-bold text-lg">#{order.order_number}</span>
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusBadge(order.status)}`}>
                        {order.status}
                      </span>
                      <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs ${isDark ? 'bg-zinc-800 border border-zinc-700 text-zinc-200' : 'bg-gray-100 border border-gray-200 text-gray-700'}`}>
                        {getOrderTypeIcon(order.order_type)}
                        <span>{order.order_type}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                      {order.customer_name && (
                        <div className={`flex items-center gap-2 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>
                          <User className="w-4 h-4 opacity-50" />
                          <span>{order.customer_name}</span>
                        </div>
                      )}
                      {order.customer_phone && (
                        <div className={`flex items-center gap-2 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>
                          <Phone className="w-4 h-4 opacity-50" />
                          <span>{order.customer_phone}</span>
                        </div>
                      )}
                      <div className={`flex items-center gap-2 ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                        <Package className="w-4 h-4 opacity-50" />
                        <span>{order.order_items?.length || 0} items</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right">
                    <div className={`text-3xl font-bold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {formatMoney(order.total_amount)}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
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
        <div className={`border-t p-4 ${isDark ? 'border-zinc-800 bg-zinc-950/90' : 'border-gray-200 bg-white'}`}>
          <div className="flex items-center justify-between">
            <div className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
              Page {currentPage} of {totalPages}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
                className={`px-3 py-2 rounded-lg border ${currentPage === 1
                  ? isDark ? 'opacity-40 cursor-not-allowed bg-zinc-900 border-zinc-700' : 'opacity-40 cursor-not-allowed bg-gray-100 border-gray-300'
                  : isDark ? 'bg-zinc-800 hover:bg-zinc-700 border-zinc-700' : 'bg-gray-100 hover:bg-gray-200 border-gray-300'
                  }`}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={currentPage === totalPages}
                className={`px-3 py-2 rounded-lg border ${currentPage === totalPages
                  ? isDark ? 'opacity-40 cursor-not-allowed bg-zinc-900 border-zinc-700' : 'opacity-40 cursor-not-allowed bg-gray-100 border-gray-300'
                  : isDark ? 'bg-zinc-800 hover:bg-zinc-700 border-zinc-700' : 'bg-gray-100 hover:bg-gray-200 border-gray-300'
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

