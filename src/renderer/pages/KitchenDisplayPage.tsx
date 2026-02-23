import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChefHat,
  Clock,
  CheckCircle,
  AlertTriangle,
  Timer,
  Utensils,
  Coffee,
  Flame,
  Snowflake,
  RefreshCw,
  Volume2,
  VolumeX,
  Play,
  Pause,
  LayoutGrid,
  List
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { useShift } from '../contexts/shift-context';
import { toast } from 'react-hot-toast';
import { getBridge, offEvent, onEvent } from '../../lib';

interface KitchenOrder {
  id: string;
  order_number: string;
  order_type: 'dine-in' | 'pickup' | 'takeaway' | 'delivery' | 'drive-through' | 'dine_in';
  status: 'pending' | 'preparing';
  items: KitchenOrderItem[];
  created_at: string;
  table_number?: string;
  priority: 'normal' | 'rush' | 'vip';
  notes?: string;
  station_id?: string;
}

interface KitchenOrderItem {
  id: string;
  name: string;
  quantity: number;
  station: string;
  status: 'pending' | 'preparing' | 'ready';
  modifiers?: string[];
  notes?: string;
}

interface KdsStation {
  id: string;
  name: string;
  station_type: string;
}

const BACKGROUND_SYNC_REFRESH_MIN_MS = 30000;

const KitchenDisplayPage: React.FC = () => {
  const bridge = getBridge();
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { staff } = useShift();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [stations, setStations] = useState<KdsStation[]>([]);
  const [stationFilter, setStationFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isDark = resolvedTheme === 'dark';

  // Map API status values back to UI status values
  const mapApiStatusToUi = (apiStatus: string): KitchenOrder['status'] | null => {
    const statusMap: Record<string, KitchenOrder['status']> = {
      pending: 'pending',
      in_progress: 'preparing',
    };
    // Return null for completed tickets so they can be filtered out
    if (apiStatus === 'completed') return null;
    return statusMap[apiStatus] || 'pending';
  };

  // Format order type for display using i18n (handles both legacy and new formats)
  const formatOrderType = (type: string): string => {
    // Map to translation keys (use existing orderType namespace)
    const keyMap: Record<string, string> = {
      'dine-in': 'orderType.dineIn',
      'dine_in': 'orderType.dineIn',  // legacy
      'pickup': 'orderType.pickup',
      'takeaway': 'orderType.takeaway',
      'delivery': 'orderType.delivery',
      'drive-through': 'orderType.driveThrough',
    };
    const key = keyMap[type];
    return key ? t(key, type) : type;  // fallback to raw type if no translation
  };

  // Get badge color for order type
  const getOrderTypeBadgeColor = (type: string): string => {
    const colors: Record<string, string> = {
      'dine-in': 'bg-blue-500/20 text-blue-500',
      'dine_in': 'bg-blue-500/20 text-blue-500',
      'pickup': 'bg-amber-500/20 text-amber-500',
      'takeaway': 'bg-green-500/20 text-green-500',
      'delivery': 'bg-purple-500/20 text-purple-500',
      'drive-through': 'bg-cyan-500/20 text-cyan-500',
    };
    return colors[type] || 'bg-gray-500/20 text-gray-500';
  };

  const fetchOrders = useCallback(async () => {
    if (!staff?.organizationId || !staff?.branchId) return;
    setLoading(true);
    setError(null);
    try {
      // Only fetch pending and preparing tickets - completed tickets clear from KDS
      const statusParam = 'pending,preparing';
      // Don't send station_id as it expects UUID - filter client-side instead
      const result = await bridge.adminApi.fetchFromAdmin(
        `/api/pos/kds?status=${statusParam}`
      );

      // Note: fetchFromApi wraps responses in { success, data, status }
      if (result?.success && result?.data?.success && result?.data?.tickets) {
        // Extract dynamic stations from API config
        if (result.data.config?.stations) {
          setStations(result.data.config.stations.map((s: Record<string, unknown>) => ({
            id: s['id'] as string,
            name: s['name'] as string,
            station_type: s['station_type'] as string,
          })));
        }

        const kitchenOrders: KitchenOrder[] = result.data.tickets
          .map((ticket: Record<string, unknown>) => {
            const status = mapApiStatusToUi(ticket['status'] as string);
            // Skip completed tickets (should not happen with new filter, but defensive)
            if (status === null) return null;
            return {
              id: ticket['id'] as string,
              order_number: ticket['order_number'] as string || ticket['ticket_number'] as string,
              order_type: (ticket['order_type'] as KitchenOrder['order_type']) || 'takeaway',
              status,
              created_at: ticket['created_at'] as string,
              notes: ticket['notes'] as string | undefined,
              table_number: ticket['table_number'] as string | undefined,
              priority: (ticket['priority'] as 'normal' | 'rush' | 'vip') || 'normal',
              station_id: ticket['station_id'] as string | undefined,
              items: ((ticket['items'] as Record<string, unknown>[]) || []).map((item: Record<string, unknown>) => ({
                id: item['id'] as string,
                name: item['name'] as string || 'Unknown',
                quantity: item['quantity'] as number || 1,
                station: (item['station'] as string) || 'hot',
                status: (item['status'] as 'pending' | 'preparing' | 'ready') || 'pending',
                notes: item['notes'] as string | undefined,
                modifiers: item['modifiers'] as string[] | undefined
              }))
            };
          })
          .filter((order: KitchenOrder | null): order is KitchenOrder => order !== null);
        // Filter by station client-side if needed (match by station_id on ticket or item station field)
        const filteredOrders = stationFilter === 'all'
          ? kitchenOrders
          : kitchenOrders.filter(order =>
              order.station_id === stationFilter ||
              order.items.some(item => item.station === stationFilter)
            );
        setOrders(filteredOrders);
      } else {
        throw new Error(result?.data?.error || result?.error || 'Failed to fetch kitchen orders');
      }
    } catch (err) {
      console.error('Failed to fetch kitchen orders:', err);
      setError(err instanceof Error ? err.message : t('kitchen.loadError', 'Unable to load orders'));
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [bridge, staff?.organizationId, staff?.branchId, stationFilter, t]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // Auto-refresh from Rust-driven events when enabled.
  useEffect(() => {
    if (!autoRefresh) return;
    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSyncRefreshAt = Date.now();

    const scheduleRefresh = (delayMs = 250) => {
      if (disposed || pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void fetchOrders();
      }, delayMs);
    };

    const handleOrderMutation = () => {
      scheduleRefresh(150);
    };

    const handleSyncStatus = () => {
      const now = Date.now();
      if (now - lastSyncRefreshAt < BACKGROUND_SYNC_REFRESH_MIN_MS) {
        return;
      }
      lastSyncRefreshAt = now;
      scheduleRefresh(300);
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
  }, [autoRefresh, fetchOrders]);

  const getTimeSinceOrder = (createdAt: string): string => {
    const diff = Date.now() - new Date(createdAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('kitchen.justNow', 'Just now');
    if (mins < 60) return `${mins} ${t('kitchen.min', 'min')}`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  const getTimeColor = (createdAt: string): string => {
    const diff = Date.now() - new Date(createdAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins > 20) return 'text-red-500';
    if (mins > 10) return 'text-yellow-500';
    return 'text-green-500';
  };

  const handleBumpOrder = async (orderId: string) => {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;
    // UI uses: pending -> preparing -> ready (clears from KDS)
    // API maps: preparing -> in_progress, ready -> completed
    // When status becomes 'ready', ticket disappears and order.status becomes 'ready'
    const newStatus = order.status === 'pending' ? 'preparing' : 'ready';

    // Optimistic update: remove from list if marking ready
    if (newStatus === 'ready') {
      setOrders(prev => prev.filter(o => o.id !== orderId));
    } else {
      setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: newStatus as 'pending' | 'preparing' } : o));
    }

    try {
      const result = await bridge.adminApi.fetchFromAdmin(
        `/api/pos/kds/${orderId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus }),
        }
      );

      // Note: fetchFromApi wraps responses in { success, data, status }
      if (result?.success && result?.data?.success) {
        if (soundEnabled) new Audio('/sounds/bump.mp3').play().catch(() => {});
        toast.success(t('kitchen.orderBumped', 'Order updated'));
        // Only refetch if not already removed (ready case already handled optimistically)
        if (newStatus !== 'ready') {
          fetchOrders();
        }
      } else {
        throw new Error(result?.data?.error || result?.error || 'Failed to update order');
      }
    } catch (error) {
      console.error('Failed to bump order:', error);
      toast.error(t('kitchen.bumpError', 'Failed to update order'));
      // Revert optimistic update on error
      fetchOrders();
    }
  };

  const StationIcon = ({ station }: { station: string }) => {
    switch (station) {
      case 'grill': return <Flame className="w-4 h-4 text-orange-500" />;
      case 'cold': return <Snowflake className="w-4 h-4 text-blue-500" />;
      case 'hot': return <Utensils className="w-4 h-4 text-red-500" />;
      case 'dessert': return <Coffee className="w-4 h-4 text-pink-500" />;
      case 'drinks': return <Coffee className="w-4 h-4 text-cyan-500" />;
      default: return <ChefHat className="w-4 h-4" />;
    }
  };

  const stats = {
    pending: orders.filter(o => o.status === 'pending').length,
    preparing: orders.filter(o => o.status === 'preparing').length,
    total: orders.length,
    avgTime: orders.length > 0 ? Math.round(orders.reduce((sum, o) => sum + (Date.now() - new Date(o.created_at).getTime()) / 60000, 0) / orders.length) : 0
  };

  const OrderCard = ({ order }: { order: KitchenOrder }) => {
    const timeColor = getTimeColor(order.created_at);
    return (
      <motion.div
        layout
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg ${order.priority === 'rush' ? 'ring-2 ring-red-500' : ''}`}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold">#{order.order_number}</span>
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${getOrderTypeBadgeColor(order.order_type)}`}>
              {formatOrderType(order.order_type)}
            </span>
            {order.table_number && <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{order.table_number}</span>}
          </div>
          <div className={`flex items-center gap-1 ${timeColor}`}>
            <Clock className="w-4 h-4" />
            <span className="text-sm font-medium">{getTimeSinceOrder(order.created_at)}</span>
          </div>
        </div>
        <div className="space-y-2 mb-4">
          {order.items.map((item) => (
            <div key={item.id} className={`flex items-center justify-between p-2 rounded-lg ${isDark ? 'bg-gray-700' : 'bg-gray-100'}`}>
              <div className="flex items-center gap-2">
                <StationIcon station={item.station} />
                <span className="font-medium">{item.quantity}x</span>
                <span>{item.name}</span>
              </div>
              {item.notes && <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{item.notes}</span>}
            </div>
          ))}
        </div>
        {order.notes && (
          <div className={`mb-3 p-2 rounded-lg ${isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'}`}>
            <p className="text-sm text-yellow-600">{order.notes}</p>
          </div>
        )}
        <button
          onClick={() => handleBumpOrder(order.id)}
          className={`w-full py-3 rounded-xl font-medium transition-all ${order.status === 'pending' ? 'bg-blue-500 hover:bg-blue-600' : 'bg-green-500 hover:bg-green-600'} text-white`}
        >
          {order.status === 'pending' ? (
            <><Play className="w-4 h-4 inline mr-2" />{t('kitchen.startPreparing', 'Start Preparing')}</>
          ) : (
            <><CheckCircle className="w-4 h-4 inline mr-2" />{t('kitchen.markReady', 'Mark Ready')}</>
          )}
        </button>
      </motion.div>
    );
  };

  return (
    <div className={`min-h-screen p-4 ${isDark ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-900'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className={`p-3 rounded-xl ${isDark ? 'bg-orange-500/20' : 'bg-orange-100'}`}>
            <ChefHat className="w-8 h-8 text-orange-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t('kitchen.title', 'Kitchen Display')}</h1>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('kitchen.subtitle', 'Real-time order preparation')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')} className={`p-3 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
            {viewMode === 'grid' ? <List className="w-5 h-5" /> : <LayoutGrid className="w-5 h-5" />}
          </button>
          <button onClick={() => setSoundEnabled(!soundEnabled)} className={`p-3 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
            {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
          </button>
          <button onClick={() => setAutoRefresh(!autoRefresh)} className={`p-3 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg ${autoRefresh ? 'text-green-500' : ''}`}>
            {autoRefresh ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>
          <button onClick={fetchOrders} className={`p-3 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-yellow-500/20"><AlertTriangle className="w-5 h-5 text-yellow-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('kitchen.pending', 'Pending')}</p>
              <p className="text-2xl font-bold">{stats.pending}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/20"><ChefHat className="w-5 h-5 text-blue-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('kitchen.preparing', 'Preparing')}</p>
              <p className="text-2xl font-bold">{stats.preparing}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-500/20"><CheckCircle className="w-5 h-5 text-green-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('kitchen.total', 'Total')}</p>
              <p className="text-2xl font-bold">{stats.total}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/20"><Timer className="w-5 h-5 text-cyan-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('kitchen.avgTime', 'Avg Time')}</p>
              <p className="text-2xl font-bold">{stats.avgTime} {t('kitchen.min', 'min')}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Station Filter */}
      <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
        {[{ id: 'all', name: t('kitchen.allStations', 'All'), station_type: 'all' } as KdsStation, ...stations].map((station) => (
          <button
            key={station.id}
            onClick={() => setStationFilter(station.id === 'all' ? 'all' : station.id)}
            className={`px-4 py-2 rounded-lg font-medium whitespace-nowrap transition-all ${stationFilter === (station.id === 'all' ? 'all' : station.id) ? 'bg-cyan-500 text-white' : isDark ? 'bg-gray-800 text-gray-400' : 'bg-white text-gray-600'} shadow-lg`}
          >
            {station.id === 'all' ? t('kitchen.allStations', 'All') : station.name}
          </button>
        ))}
      </div>

      {/* Orders Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className={`p-6 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white'} animate-pulse`}>
              <div className="h-6 bg-gray-600 rounded w-1/2 mb-4" />
              <div className="space-y-2">
                <div className="h-10 bg-gray-600 rounded" />
                <div className="h-10 bg-gray-600 rounded" />
              </div>
              <div className="h-12 bg-gray-600 rounded mt-4" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className={`p-12 rounded-xl text-center ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <AlertTriangle className="w-16 h-16 mx-auto mb-4 text-red-500 opacity-75" />
          <h3 className="text-xl font-semibold mb-2 text-red-500">{t('kitchen.loadError', 'Unable to Load Orders')}</h3>
          <p className={`mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{error}</p>
          <button
            onClick={fetchOrders}
            className="px-6 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-600 text-white font-medium transition-colors"
          >
            <RefreshCw className="w-4 h-4 inline mr-2" />
            {t('common.retry', 'Retry')}
          </button>
        </div>
      ) : orders.length === 0 ? (
        <div className={`p-12 rounded-xl text-center ${isDark ? 'bg-gray-800' : 'bg-white'} shadow-lg`}>
          <ChefHat className="w-16 h-16 mx-auto mb-4 text-gray-400 opacity-50" />
          <h3 className="text-xl font-semibold mb-2">{t('kitchen.noOrders', 'No Active Orders')}</h3>
          <p className={isDark ? 'text-gray-400' : 'text-gray-600'}>{t('kitchen.noOrdersDesc', 'New orders will appear here automatically')}</p>
        </div>
      ) : (
        <AnimatePresence>
          <div className={viewMode === 'grid' ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4' : 'space-y-4'}>
            {orders.map((order) => (
              <OrderCard key={order.id} order={order} />
            ))}
          </div>
        </AnimatePresence>
      )}
    </div>
  );
};

export default KitchenDisplayPage;

