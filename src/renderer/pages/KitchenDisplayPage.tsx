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
import { supabase } from '../../shared/supabase';

interface KitchenOrder {
  id: string;
  order_number: string;
  order_type: 'dine_in' | 'takeaway' | 'delivery';
  status: 'pending' | 'preparing' | 'ready';
  items: KitchenOrderItem[];
  created_at: string;
  table_number?: string;
  priority: 'normal' | 'rush' | 'vip';
  notes?: string;
}

interface KitchenOrderItem {
  id: string;
  name: string;
  quantity: number;
  station: 'grill' | 'cold' | 'hot' | 'dessert' | 'drinks';
  status: 'pending' | 'preparing' | 'ready';
  modifiers?: string[];
  notes?: string;
}

type StationType = 'all' | 'grill' | 'cold' | 'hot' | 'dessert' | 'drinks';

const KitchenDisplayPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { staff } = useShift();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [stationFilter, setStationFilter] = useState<StationType>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const isDark = resolvedTheme === 'dark';

  const fetchOrders = useCallback(async () => {
    if (!staff?.organizationId || !staff?.branchId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('orders')
        .select(`
          id, order_number, order_type, status, created_at, notes,
          table_id,
          order_items(id, quantity, notes, menu_items(name_en, name_el))
        `)
        .eq('organization_id', staff.organizationId)
        .eq('branch_id', staff.branchId)
        .in('status', ['pending', 'preparing', 'ready'])
        .order('created_at', { ascending: true })
        .limit(50);

      if (error) throw error;

      const kitchenOrders: KitchenOrder[] = (data || []).map((order: Record<string, unknown>) => ({
        id: order['id'] as string,
        order_number: order['order_number'] as string,
        order_type: (order['order_type'] as KitchenOrder['order_type']) || 'takeaway',
        status: order['status'] as KitchenOrder['status'],
        created_at: order['created_at'] as string,
        notes: order['notes'] as string | undefined,
        table_number: order['table_id'] ? `Table ${order['table_id']}` : undefined,
        priority: 'normal' as const,
        items: ((order['order_items'] as Record<string, unknown>[]) || []).map((item: Record<string, unknown>) => ({
          id: item['id'] as string,
          name: ((item['menu_items'] as Record<string, unknown>)?.['name_en'] as string) || 'Unknown',
          quantity: item['quantity'] as number,
          station: 'hot' as const,
          status: 'pending' as const,
          notes: item['notes'] as string | undefined
        }))
      }));
      setOrders(kitchenOrders);
    } catch (error) {
      console.error('Failed to fetch kitchen orders:', error);
      // Mock data for demo
      setOrders([
        { id: '1', order_number: '001', order_type: 'dine_in', status: 'pending', created_at: new Date(Date.now() - 5 * 60000).toISOString(), table_number: 'Table 5', priority: 'normal', items: [{ id: '1', name: 'Crepe Nutella', quantity: 2, station: 'hot', status: 'pending' }, { id: '2', name: 'Crepe Banana', quantity: 1, station: 'hot', status: 'pending' }] },
        { id: '2', order_number: '002', order_type: 'takeaway', status: 'preparing', created_at: new Date(Date.now() - 12 * 60000).toISOString(), priority: 'rush', items: [{ id: '3', name: 'Waffle Classic', quantity: 1, station: 'hot', status: 'preparing' }] },
        { id: '3', order_number: '003', order_type: 'delivery', status: 'ready', created_at: new Date(Date.now() - 20 * 60000).toISOString(), priority: 'normal', items: [{ id: '4', name: 'Crepe Savory', quantity: 2, station: 'grill', status: 'ready' }] },
      ]);
    } finally {
      setLoading(false);
    }
  }, [staff?.organizationId, staff?.branchId]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchOrders, 30000);
    return () => clearInterval(interval);
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
    const newStatus = order.status === 'pending' ? 'preparing' : order.status === 'preparing' ? 'ready' : 'completed';
    try {
      await supabase.from('orders').update({ status: newStatus }).eq('id', orderId);
      if (soundEnabled) new Audio('/sounds/bump.mp3').play().catch(() => {});
      toast.success(t('kitchen.orderBumped', 'Order updated'));
      fetchOrders();
    } catch (error) {
      toast.error(t('kitchen.bumpError', 'Failed to update order'));
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
    ready: orders.filter(o => o.status === 'ready').length,
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
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${order.order_type === 'dine_in' ? 'bg-blue-500/20 text-blue-500' : order.order_type === 'delivery' ? 'bg-purple-500/20 text-purple-500' : 'bg-green-500/20 text-green-500'}`}>
              {order.order_type === 'dine_in' ? t('kitchen.dineIn', 'Dine In') : order.order_type === 'delivery' ? t('kitchen.delivery', 'Delivery') : t('kitchen.takeaway', 'Takeaway')}
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
          className={`w-full py-3 rounded-xl font-medium transition-all ${order.status === 'pending' ? 'bg-blue-500 hover:bg-blue-600' : order.status === 'preparing' ? 'bg-green-500 hover:bg-green-600' : 'bg-cyan-500 hover:bg-cyan-600'} text-white`}
        >
          {order.status === 'pending' ? (
            <><Play className="w-4 h-4 inline mr-2" />{t('kitchen.startPreparing', 'Start Preparing')}</>
          ) : order.status === 'preparing' ? (
            <><CheckCircle className="w-4 h-4 inline mr-2" />{t('kitchen.markReady', 'Mark Ready')}</>
          ) : (
            <><CheckCircle className="w-4 h-4 inline mr-2" />{t('kitchen.complete', 'Complete')}</>
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
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('kitchen.ready', 'Ready')}</p>
              <p className="text-2xl font-bold">{stats.ready}</p>
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
        {(['all', 'grill', 'hot', 'cold', 'dessert', 'drinks'] as StationType[]).map((station) => (
          <button
            key={station}
            onClick={() => setStationFilter(station)}
            className={`px-4 py-2 rounded-lg font-medium whitespace-nowrap transition-all ${stationFilter === station ? 'bg-cyan-500 text-white' : isDark ? 'bg-gray-800 text-gray-400' : 'bg-white text-gray-600'} shadow-lg`}
          >
            {station === 'all' ? t('kitchen.allStations', 'All') : t(`kitchen.${station}`, station.charAt(0).toUpperCase() + station.slice(1))}
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

