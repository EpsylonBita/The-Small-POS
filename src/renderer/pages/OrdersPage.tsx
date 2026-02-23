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
import { getBridge, isBrowser, offEvent, onEvent } from '../../lib';

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
  status: string;
  order_type: string;
  payment_method: string;
  payment_status?: string;
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
  sync_status?: string;
  supabase_id?: string;
  client_order_id?: string;
  source?: 'local' | 'remote';
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

const asString = (value: any): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const asNumber = (value: any, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const normalizeOrderType = (value: string | undefined): string => {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) return 'pickup';
  if (normalized === 'dine_in') return 'dine-in';
  if (normalized === 'takeaway' || normalized === 'takeout') return 'pickup';
  return normalized;
};

const normalizeOrder = (raw: any, source: 'local' | 'remote'): Order | null => {
  if (!raw || typeof raw !== 'object') return null;

  const id = asString(raw.id) || asString(raw.client_order_id) || asString(raw.order_number);
  if (!id) return null;

  const createdAt = asString(raw.created_at) || asString(raw.createdAt) || new Date().toISOString();
  const updatedAt = asString(raw.updated_at) || asString(raw.updatedAt) || createdAt;
  const orderItems = Array.isArray(raw.order_items)
    ? raw.order_items
    : Array.isArray(raw.items)
      ? raw.items
      : [];

  return {
    id,
    order_number: asString(raw.order_number) || asString(raw.orderNumber) || id.slice(0, 8),
    status: asString(raw.status) || 'pending',
    order_type: normalizeOrderType(asString(raw.order_type) || asString(raw.orderType)),
    payment_method: asString(raw.payment_method) || asString(raw.paymentMethod) || 'cash',
    payment_status: asString(raw.payment_status) || asString(raw.paymentStatus),
    total_amount: asNumber(raw.total_amount ?? raw.totalAmount, 0),
    subtotal: asNumber(raw.subtotal, 0),
    tax_amount: asNumber(raw.tax_amount ?? raw.taxAmount, 0),
    delivery_fee: asNumber(raw.delivery_fee ?? raw.deliveryFee, 0),
    discount_amount: asNumber(raw.discount_amount ?? raw.discountAmount, 0),
    customer_name: asString(raw.customer_name) || asString(raw.customerName),
    customer_phone: asString(raw.customer_phone) || asString(raw.customerPhone),
    customer_email: asString(raw.customer_email) || asString(raw.customerEmail),
    delivery_address: asString(raw.delivery_address) || asString(raw.deliveryAddress),
    delivery_city: asString(raw.delivery_city) || asString(raw.deliveryCity),
    delivery_postal_code: asString(raw.delivery_postal_code) || asString(raw.deliveryPostalCode),
    delivery_floor: asString(raw.delivery_floor) || asString(raw.deliveryFloor),
    delivery_notes: asString(raw.delivery_notes) || asString(raw.deliveryNotes),
    table_number: asString(raw.table_number) || asString(raw.tableNumber),
    special_instructions: asString(raw.special_instructions) || asString(raw.specialInstructions),
    name_on_ringer: asString(raw.name_on_ringer) || asString(raw.nameOnRinger),
    order_items: orderItems as OrderItem[],
    created_at: createdAt,
    updated_at: updatedAt,
    estimated_ready_time: raw.estimated_ready_time ?? raw.estimatedTime,
    sync_status: asString(raw.sync_status) || asString(raw.syncStatus),
    supabase_id: asString(raw.supabase_id) || asString(raw.supabaseId),
    client_order_id: asString(raw.client_order_id),
    source,
  };
};

const toIdentitySet = (order: Order): Set<string> => {
  const keys = [
    order.id,
    order.supabase_id,
    order.client_order_id,
    order.order_number,
  ]
    .filter((v): v is string => !!v)
    .map((v) => v.trim().toLowerCase());
  return new Set(keys);
};

const sharesIdentity = (a: Order, b: Order): boolean => {
  const aKeys = toIdentitySet(a);
  const bKeys = toIdentitySet(b);
  for (const key of aKeys) {
    if (bKeys.has(key)) return true;
  }
  return false;
};

const isPendingOrQueuedLocal = (order: Order): boolean => {
  const syncStatus = (order.sync_status || '').toLowerCase();
  return order.source === 'local' && (syncStatus === 'pending' || syncStatus === 'queued');
};

const mergeHybridOrders = (localOrders: Order[], remoteOrders: Order[]): Order[] => {
  const merged: Order[] = [];
  const upsert = (incoming: Order) => {
    const index = merged.findIndex((existing) => sharesIdentity(existing, incoming));
    if (index === -1) {
      merged.push(incoming);
      return;
    }

    const existing = merged[index];
    if (isPendingOrQueuedLocal(existing) && incoming.source === 'remote') {
      return;
    }

    const existingTs = new Date(existing.updated_at).getTime();
    const incomingTs = new Date(incoming.updated_at).getTime();
    if (Number.isNaN(existingTs) || incomingTs >= existingTs) {
      merged[index] = { ...existing, ...incoming };
    }
  };

  localOrders.forEach(upsert);
  remoteOrders.forEach(upsert);
  return merged;
};

const BACKGROUND_SYNC_REFRESH_MIN_MS = 30000;

const OrdersPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const bridge = getBridge();

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

  const applyFilters = useCallback((input: Order[]): Order[] => {
    const search = searchTerm.trim().toLowerCase();
    return input.filter((order) => {
      if (statusFilter !== 'all' && order.status !== statusFilter) return false;
      if (orderTypeFilter !== 'all' && order.order_type !== orderTypeFilter) return false;
      if (dateFrom && order.created_at.slice(0, 10) < dateFrom) return false;
      if (dateTo && order.created_at.slice(0, 10) > dateTo) return false;

      if (!search) return true;
      const haystack = [
        order.order_number,
        order.customer_name,
        order.customer_phone,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(search);
    });
  }, [statusFilter, orderTypeFilter, dateFrom, dateTo, searchTerm]);

  const paginateOrders = useCallback((input: Order[]) => {
    const start = (currentPage - 1) * pageSize;
    return input.slice(start, start + pageSize);
  }, [currentPage, pageSize]);

  const fetchOrders = useCallback(async () => {
    if (isBrowser()) {
      console.error('[OrdersPage] Electron API not available');
      toast.error('Electron API not available');
      setLoading(false);
      return;
    }

    setSyncing(true);
    try {
      const remoteOptions: FetchOrdersOptions = { limit: 500, offset: 0 };
      if (statusFilter !== 'all') remoteOptions.status = statusFilter;
      if (orderTypeFilter !== 'all') remoteOptions.order_type = orderTypeFilter;
      if (searchTerm) remoteOptions.search = searchTerm;
      if (dateFrom) remoteOptions.date_from = dateFrom;
      if (dateTo) remoteOptions.date_to = dateTo;

      const localRaw = await bridge.orders.getAll();
      const localOrders = (Array.isArray(localRaw) ? localRaw : [])
        .map((entry: any) => normalizeOrder(entry, 'local'))
        .filter((entry: Order | null): entry is Order => !!entry);

      let mergedOrders = localOrders;
      let filtered = applyFilters(mergedOrders).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      setTotal(filtered.length);
      setOrders(paginateOrders(filtered));

      try {
        const remoteResult = await bridge.sync.fetchOrders(remoteOptions);
        if (remoteResult?.success) {
          const remoteOrders = (Array.isArray(remoteResult.orders) ? remoteResult.orders : [])
            .map((entry: any) => normalizeOrder(entry, 'remote'))
            .filter((entry: Order | null): entry is Order => !!entry);
          mergedOrders = mergeHybridOrders(localOrders, remoteOrders);
          filtered = applyFilters(mergedOrders).sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          );
          setTotal(filtered.length);
          setOrders(paginateOrders(filtered));
        } else if (localOrders.length === 0) {
          toast.error(remoteResult?.error || 'Failed to load remote orders');
        }
      } catch (remoteError) {
        console.warn('[OrdersPage] Remote fetch failed, using local orders only', remoteError);
        if (localOrders.length === 0) {
          toast.error('Failed to load orders');
        }
      }
    } catch (error) {
      console.error('[OrdersPage] Exception while fetching orders:', error);
      toast.error('Failed to load orders');
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, [
    statusFilter,
    orderTypeFilter,
    searchTerm,
    dateFrom,
    dateTo,
    applyFilters,
    paginateOrders,
    bridge.orders,
    bridge.sync,
  ]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // Refresh from Rust-driven events instead of renderer polling.
  useEffect(() => {
    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSyncRefreshAt = Date.now();

    const scheduleFetch = (delayMs = 250) => {
      if (disposed || pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void fetchOrders();
      }, delayMs);
    };

    const handleOrderMutation = () => {
      scheduleFetch(150);
    };

    const handleSyncStatus = () => {
      const now = Date.now();
      if (now - lastSyncRefreshAt < BACKGROUND_SYNC_REFRESH_MIN_MS) {
        return;
      }
      lastSyncRefreshAt = now;
      scheduleFetch(300);
    };

    onEvent('order-created', handleOrderMutation);
    onEvent('order-status-updated', handleOrderMutation);
    onEvent('order-deleted', handleOrderMutation);
    onEvent('sync:status', handleSyncStatus);
    onEvent('sync:complete', handleOrderMutation);

    return () => {
      disposed = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      offEvent('order-created', handleOrderMutation);
      offEvent('order-status-updated', handleOrderMutation);
      offEvent('order-deleted', handleOrderMutation);
      offEvent('sync:status', handleSyncStatus);
      offEvent('sync:complete', handleOrderMutation);
    };
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
