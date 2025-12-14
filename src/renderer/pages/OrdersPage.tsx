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
  ChevronRight,
  User,
  MapPin,
  CreditCard,
  Banknote,
  Truck,
  Store,
  Eye
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { useShift } from '../contexts/shift-context';
import { toast } from 'react-hot-toast';
import { getApiUrl } from '../../config/environment';
import { OrderService } from '../../services/OrderService';

interface Order {
  id: string;
  order_number: string;
  status: 'pending' | 'preparing' | 'ready' | 'completed' | 'cancelled';
  order_type: 'dine_in' | 'takeaway' | 'delivery';
  payment_method: 'cash' | 'card' | 'online';
  total_amount: number;
  customer_name?: string;
  customer_phone?: string;
  delivery_address?: string;
  items_count: number;
  created_at: string;
  updated_at: string;
}

const OrdersPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { staff } = useShift();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');

  const isDark = resolvedTheme === 'dark';
  const currency = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'EUR' });

  const fetchOrders = useCallback(async () => {
    // Only fetch if we have a branch ID
    if (!staff?.branchId) return;

    setLoading(true);
    try {
      const ordersData = await OrderService.getInstance().fetchOrders();
      // Map shared Order type to local Order interface
      const mappedOrders: Order[] = (ordersData || []).map((o: any) => ({
        id: o.id,
        order_number: o.order_number || o.orderNumber || o.id.slice(0, 8),
        status: o.status,
        order_type: o.order_type || o.orderType || 'takeaway',
        payment_method: o.payment_method || o.paymentMethod || 'cash',
        total_amount: o.total_amount || o.totalAmount || 0,
        customer_name: o.customer_name || o.customerName,
        customer_phone: o.customer_phone || o.customerPhone,
        delivery_address: o.delivery_address || o.deliveryAddress,
        items_count: o.items?.length || o.itemsCount || 0,
        created_at: o.created_at || o.createdAt || new Date().toISOString(),
        updated_at: o.updated_at || o.updatedAt || new Date().toISOString()
      }));
      setOrders(mappedOrders);
    } catch (error) {
      console.error('Failed to fetch orders:', error);
      const msg = (error as any)?.message || 'Failed to load orders';
      toast.error(t('orders.errors.loadFailed', 'Failed to load orders'));
    } finally {
      setLoading(false);
    }
  }, [staff?.branchId, t]);

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [fetchOrders]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'bg-yellow-500/20 text-yellow-500 border-yellow-500/30';
      case 'preparing': return 'bg-blue-500/20 text-blue-500 border-blue-500/30';
      case 'ready': return 'bg-green-500/20 text-green-500 border-green-500/30';
      case 'completed': return 'bg-gray-500/20 text-gray-500 border-gray-500/30';
      case 'cancelled': return 'bg-red-500/20 text-red-500 border-red-500/30';
      default: return 'bg-gray-500/20 text-gray-500 border-gray-500/30';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending': return <Clock className="w-4 h-4" />;
      case 'preparing': return <RefreshCw className="w-4 h-4 animate-spin" />;
      case 'ready': return <CheckCircle className="w-4 h-4" />;
      case 'completed': return <CheckCircle className="w-4 h-4" />;
      case 'cancelled': return <XCircle className="w-4 h-4" />;
      default: return <Clock className="w-4 h-4" />;
    }
  };

  const getOrderTypeIcon = (type: string) => {
    switch (type) {
      case 'delivery': return <Truck className="w-4 h-4" />;
      case 'takeaway': return <ShoppingBag className="w-4 h-4" />;
      default: return <Store className="w-4 h-4" />;
    }
  };

  const filteredOrders = orders.filter(order => {
    const matchesStatus = statusFilter === 'all' || order.status === statusFilter;
    const matchesSearch = !searchTerm ||
      order.order_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.customer_name?.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  const statusCounts = {
    all: orders.length,
    pending: orders.filter(o => o.status === 'pending').length,
    preparing: orders.filter(o => o.status === 'preparing').length,
    ready: orders.filter(o => o.status === 'ready').length,
    completed: orders.filter(o => o.status === 'completed').length,
  };

  if (loading && orders.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-8 h-8 animate-spin text-cyan-500" />
      </div>
    );
  }

  return (
    <div className={`h-full flex ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      {/* Orders List */}
      <div className="flex-1 flex flex-col overflow-hidden p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-cyan-500/20">
              <ShoppingBag className="w-6 h-6 text-cyan-500" />
            </div>
            <div>
              <h1 className="text-xl font-bold">{t('orders.title', 'Orders')}</h1>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {t('orders.subtitle', 'Manage and track orders')}
              </p>
            </div>
          </div>
          <button
            onClick={fetchOrders}
            className={`p-2 rounded-lg ${isDark ? 'bg-gray-800 hover:bg-gray-700' : 'bg-white hover:bg-gray-100'}`}
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Search & Filters */}
        <div className="flex gap-3 mb-4">
          <div className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg ${isDark ? 'bg-gray-800' : 'bg-white'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
            <Search className="w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t('orders.search', 'Search orders...')}
              className="flex-1 bg-transparent outline-none text-sm"
            />
          </div>
        </div>

        {/* Status Tabs */}
        <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
          {(['all', 'pending', 'preparing', 'ready', 'completed'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-2 ${statusFilter === status
                ? 'bg-cyan-500 text-white'
                : isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-700 hover:bg-gray-100'
                }`}
            >
              {t(`orders.status.${status}`, status.charAt(0).toUpperCase() + status.slice(1))}
              <span className={`px-1.5 py-0.5 rounded text-xs ${statusFilter === status ? 'bg-white/20' : isDark ? 'bg-gray-700' : 'bg-gray-200'}`}>
                {statusCounts[status]}
              </span>
            </button>
          ))}
        </div>

        {/* Orders Grid */}
        <div className="flex-1 overflow-y-auto">
          {filteredOrders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <ShoppingBag className="w-12 h-12 text-gray-400 mb-4" />
              <h3 className="text-lg font-semibold mb-2">{t('orders.noOrders', 'No Orders')}</h3>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {t('orders.noOrdersDesc', 'Orders will appear here when placed.')}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              <AnimatePresence>
                {filteredOrders.map((order) => (
                  <motion.div
                    key={order.id}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    onClick={() => setSelectedOrder(order)}
                    className={`p-4 rounded-xl cursor-pointer transition-all ${isDark ? 'bg-gray-800/50 hover:bg-gray-800' : 'bg-white hover:bg-gray-50'} border ${isDark ? 'border-gray-700' : 'border-gray-200'} ${selectedOrder?.id === order.id ? 'ring-2 ring-cyan-500' : ''}`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <p className="font-bold text-lg">{order.order_number}</p>
                        <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                          {new Date(order.created_at).toLocaleTimeString()}
                        </p>
                      </div>
                      <span className={`px-2 py-1 rounded-lg text-xs font-medium flex items-center gap-1 border ${getStatusColor(order.status)}`}>
                        {getStatusIcon(order.status)}
                        {t(`orders.status.${order.status}`, order.status)}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 mb-3">
                      <div className="flex items-center gap-1 text-sm">
                        {getOrderTypeIcon(order.order_type)}
                        <span className="capitalize">{order.order_type.replace('_', ' ')}</span>
                      </div>
                      <div className="flex items-center gap-1 text-sm">
                        {order.payment_method === 'cash' ? <Banknote className="w-4 h-4" /> : <CreditCard className="w-4 h-4" />}
                        <span className="capitalize">{order.payment_method}</span>
                      </div>
                    </div>
                    {order.customer_name && (
                      <div className="flex items-center gap-2 mb-2 text-sm">
                        <User className="w-4 h-4 text-gray-400" />
                        <span>{order.customer_name}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between pt-3 border-t border-gray-700/50">
                      <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        {order.items_count} {t('orders.items', 'items')}
                      </span>
                      <span className="font-bold text-lg text-cyan-500">
                        {currency.format(order.total_amount)}
                      </span>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      {/* Order Details Panel */}
      <AnimatePresence>
        {selectedOrder && (
          <motion.div
            initial={{ x: 300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 300, opacity: 0 }}
            className={`w-80 border-l ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} p-4 overflow-y-auto`}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">{selectedOrder.order_number}</h2>
              <button
                onClick={() => setSelectedOrder(null)}
                className={`p-1 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <div className={`p-3 rounded-lg mb-4 ${getStatusColor(selectedOrder.status)} border`}>
              <div className="flex items-center gap-2">
                {getStatusIcon(selectedOrder.status)}
                <span className="font-medium capitalize">{selectedOrder.status}</span>
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'} mb-1`}>{t('orders.orderType', 'Order Type')}</p>
                <div className="flex items-center gap-2">
                  {getOrderTypeIcon(selectedOrder.order_type)}
                  <span className="capitalize">{selectedOrder.order_type.replace('_', ' ')}</span>
                </div>
              </div>
              <div>
                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'} mb-1`}>{t('orders.payment', 'Payment')}</p>
                <div className="flex items-center gap-2">
                  {selectedOrder.payment_method === 'cash' ? <Banknote className="w-4 h-4" /> : <CreditCard className="w-4 h-4" />}
                  <span className="capitalize">{selectedOrder.payment_method}</span>
                </div>
              </div>
              {selectedOrder.customer_name && (
                <div>
                  <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'} mb-1`}>{t('orders.customer', 'Customer')}</p>
                  <div className="flex items-center gap-2">
                    <User className="w-4 h-4" />
                    <span>{selectedOrder.customer_name}</span>
                  </div>
                </div>
              )}
              {selectedOrder.delivery_address && (
                <div>
                  <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'} mb-1`}>{t('orders.address', 'Address')}</p>
                  <div className="flex items-center gap-2">
                    <MapPin className="w-4 h-4" />
                    <span className="text-sm">{selectedOrder.delivery_address}</span>
                  </div>
                </div>
              )}
              <div className="pt-4 border-t border-gray-700/50">
                <div className="flex justify-between items-center">
                  <span className="font-medium">{t('orders.total', 'Total')}</span>
                  <span className="text-xl font-bold text-cyan-500">{currency.format(selectedOrder.total_amount)}</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default OrdersPage;

