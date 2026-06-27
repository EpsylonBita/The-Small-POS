/**
 * DeliveryPage - Delivery order management for Desktop POS
 *
 * Features:
 * - Active deliveries list with status tracking
 * - Driver assignment interface
 * - Status updates (pending → assigned → picked_up → in_transit → delivered)
 * - Filter by status
 * - Real-time updates via Supabase
 *
 * @since 2.3.0
 */

import React, { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { toast } from 'react-hot-toast';
import { useTheme } from '../contexts/theme-context';
import { useTerminalSettings } from '../hooks/useTerminalSettings';
import {
  buildGoogleMapsDirectionsUrl,
  buildSingleDeliveryRouteStop,
  resolveStoreMapOrigin,
  type StoreMapOrigin,
} from '../utils/delivery-routing';
import { getVisibleOrderNumber } from '../utils/orderNumberUtils';
import { openExternalUrl } from '../utils/external-url';
import { getBridge, offEvent, onEvent } from '../../lib';
import { pageMotionContainer, pageMotionItem } from '../components/ui/page-motion';
import { renderModalPortal } from '../utils/render-modal-portal';
import {
  Truck,
  MapPin,
  Clock,
  Phone,
  User,
  Package,
  CheckCircle,
  XCircle,
  RefreshCw,
  ChevronRight,
  AlertTriangle,
  Navigation,
  Users,
  Search,
  X,
} from 'lucide-react';

// ============================================================
// TYPES
// ============================================================

type DeliveryStatus = 'pending' | 'assigned' | 'picked_up' | 'in_transit' | 'delivered' | 'failed' | 'cancelled';

interface DeliveryAddress {
  street: string;
  city?: string;
  postalCode?: string;
  floor?: string;
  notes?: string;
}

interface Delivery {
  id: string;
  orderId: string;
  orderNumber: string;
  status: DeliveryStatus;
  customerName: string;
  customerPhone?: string;
  address: DeliveryAddress;
  driverId?: string;
  driverName?: string;
  orderTotal?: number;
  orderItems?: Array<{ name: string; quantity: number }>;
  paymentStatus?: 'paid' | 'unpaid' | 'cod';
  estimatedDeliveryTime?: string;
  actualDeliveryTime?: string;
  createdAt: string;
  updatedAt: string;
}

interface Driver {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  phone?: string;
  avatarUrl?: string;
  status: {
    isClockedIn: boolean;
    isAvailable: boolean;
    activeAssignments: number;
  };
}

type FilterTab = 'all' | 'active' | 'pending' | 'in_transit' | 'delivered';

// ============================================================
// CONSTANTS
// ============================================================

const STATUS_CONFIG: Record<DeliveryStatus, { label: string; color: string; bgColor: string; icon: typeof Package }> = {
  pending: { label: 'Pending', color: '#E4E4E7', bgColor: '#3F3F46', icon: Clock },
  assigned: { label: 'Assigned', color: '#E4E4E7', bgColor: '#52525B', icon: User },
  picked_up: { label: 'Picked Up', color: '#E4E4E7', bgColor: '#52525B', icon: Package },
  in_transit: { label: 'In Transit', color: '#F4F4F5', bgColor: '#71717A', icon: Truck },
  delivered: { label: 'Delivered', color: '#18181B', bgColor: '#E4E4E7', icon: CheckCircle },
  failed: { label: 'Failed', color: '#E4E4E7', bgColor: '#52525B', icon: XCircle },
  cancelled: { label: 'Cancelled', color: '#D4D4D8', bgColor: '#3F3F46', icon: XCircle },
};

const FILTER_TABS: { id: FilterTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'pending', label: 'Pending' },
  { id: 'in_transit', label: 'In Transit' },
  { id: 'delivered', label: 'Completed' },
];
const DELIVERY_REFRESH_MIN_MS = 30000;

// ============================================================
// HELPER FUNCTIONS
// ============================================================

const getElapsedTime = (createdAt: string): string => {
  const start = new Date(createdAt).getTime();
  const now = Date.now();
  const minutes = Math.floor((now - start) / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const getNextStatus = (currentStatus: DeliveryStatus): { label: string; status: DeliveryStatus; color: string } | null => {
  switch (currentStatus) {
    case 'pending':
      return { label: 'Assign Driver', status: 'assigned', color: '#E4E4E7' };
    case 'assigned':
      return { label: 'Pick Up', status: 'picked_up', color: '#E4E4E7' };
    case 'picked_up':
      return { label: 'Start Delivery', status: 'in_transit', color: '#E4E4E7' };
    case 'in_transit':
      return { label: 'Mark Delivered', status: 'delivered', color: '#E4E4E7' };
    default:
      return null;
  }
};

const normalizeDeliveryStatus = (value: unknown): DeliveryStatus => {
  const normalized = String(value || 'pending').trim().toLowerCase();
  switch (normalized) {
    case 'assigned':
      return 'assigned';
    case 'picked_up':
    case 'picked-up':
      return 'picked_up';
    case 'in_transit':
    case 'out_for_delivery':
    case 'out-for-delivery':
      return 'in_transit';
    case 'delivered':
    case 'completed':
      return 'delivered';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'pending';
  }
};

const extractDeliveryAddress = (order: Record<string, any>): DeliveryAddress => ({
  street: order.delivery_address || order.deliveryAddress || order.address || '',
  city: order.delivery_city || order.deliveryCity,
  postalCode: order.delivery_postal_code || order.deliveryPostalCode,
  floor: order.delivery_floor || order.deliveryFloor,
  notes: order.delivery_notes || order.deliveryNotes,
});

const mapOrderToDelivery = (order: Record<string, any>): Delivery | null => {
  const orderType = String(order.order_type || order.orderType || '').toLowerCase();
  if (orderType !== 'delivery') {
    return null;
  }

  const id = String(order.id || order.orderId || '').trim();
  if (!id) {
    return null;
  }

  const address = extractDeliveryAddress(order);
  const createdAt = order.created_at || order.createdAt || new Date().toISOString();
  const updatedAt = order.updated_at || order.updatedAt || createdAt;

  return {
    id,
    orderId: id,
    orderNumber: String(getVisibleOrderNumber(order) || order.order_id || id),
    status: normalizeDeliveryStatus(order.status),
    customerName: order.customer_name || order.customerName || 'Customer',
    customerPhone: order.customer_phone || order.customerPhone,
    address,
    driverId: order.driver_id || order.driverId,
    driverName: order.driver_name || order.driverName,
    orderTotal: Number(order.total_amount ?? order.totalAmount ?? 0) || 0,
    orderItems: Array.isArray(order.items)
      ? order.items.map((item: any) => ({
          name: item.name || item.item_name || 'Item',
          quantity: Number(item.quantity ?? 1) || 1,
        }))
      : Array.isArray(order.orderItems)
        ? order.orderItems
        : [],
    paymentStatus: order.payment_status || order.paymentStatus,
    estimatedDeliveryTime:
      order.estimated_delivery_time || order.estimatedDeliveryTime || order.estimated_time,
    actualDeliveryTime: order.actual_delivery_time || order.actualDeliveryTime,
    createdAt,
    updatedAt,
  };
};

const mapDriverToCardShape = (driver: Record<string, any>): Driver => {
  const name = String(driver.name || driver.staffName || '').trim();
  const activeAssignments = Number(driver.current_orders ?? driver.currentOrders ?? 0) || 0;
  const statusValue = String(driver.status || '').trim().toLowerCase();
  return {
    id: String(driver.id || driver.staffId || '').trim(),
    name,
    firstName: name.split(' ')[0] || name,
    lastName: name.split(' ').slice(1).join(' '),
    phone: driver.phone || undefined,
    avatarUrl: driver.avatar_url || driver.avatarUrl,
    status: {
      isClockedIn: true,
      isAvailable: statusValue !== 'busy',
      activeAssignments,
    },
  };
};

// ============================================================
// DELIVERY CARD COMPONENT
// ============================================================

interface DeliveryCardProps {
  delivery: Delivery;
  onStatusUpdate: (deliveryId: string, status: DeliveryStatus) => void;
  onAssignDriver: (delivery: Delivery) => void;
  onOpenMap: (delivery: Delivery) => void;
  canOpenMap: boolean;
  isDark: boolean;
}

const DeliveryCard = memo<DeliveryCardProps>(({
  delivery,
  onStatusUpdate,
  onAssignDriver,
  onOpenMap,
  canOpenMap,
  isDark,
}) => {
  const { t } = useTranslation();
  const statusConfig = STATUS_CONFIG[delivery.status];
  const StatusIcon = statusConfig.icon;
  const nextAction = getNextStatus(delivery.status);

  const handleAction = () => {
    if (delivery.status === 'pending') {
      onAssignDriver(delivery);
    } else if (nextAction) {
      onStatusUpdate(delivery.id, nextAction.status);
    }
  };

  return (
    <motion.div
      variants={pageMotionItem}
      className={`rounded-2xl border overflow-hidden ${
        isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'
      }`}
    >
      {/* Status Bar */}
      <div className="h-1" style={{ backgroundColor: statusConfig.color }} />

      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <span className={`font-bold text-lg ${isDark ? 'text-white' : 'text-gray-900'}`}>
              #{delivery.orderNumber}
            </span>
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-2xl text-xs font-medium"
              style={{ backgroundColor: statusConfig.bgColor, color: statusConfig.color }}
            >
              <StatusIcon className="w-3 h-3" />
              <span>{t(`delivery.status.${delivery.status}`, statusConfig.label)}</span>
            </div>
          </div>
          <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {getElapsedTime(delivery.createdAt)}
          </span>
        </div>

        {/* Customer Info */}
        <div className="space-y-2 mb-3">
          <div className={`flex items-center gap-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            <User className="w-4 h-4 text-gray-400" />
            <span className="font-medium">{delivery.customerName || 'Customer'}</span>
          </div>
          {delivery.customerPhone && (
            <div className={`flex items-center gap-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              <Phone className="w-4 h-4" />
              <span className="text-sm">{delivery.customerPhone}</span>
            </div>
          )}
        </div>

        {/* Address */}
        <button
          type="button"
          onClick={() => onOpenMap(delivery)}
          disabled={!canOpenMap}
          className={`w-full flex items-start gap-2 mb-3 text-left ${isDark ? 'text-white' : 'text-gray-900'} ${canOpenMap ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
        >
          <MapPin className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isDark ? 'text-zinc-400' : 'text-gray-500'}`} />
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate">{delivery.address.street}</p>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {[delivery.address.city, delivery.address.postalCode].filter(Boolean).join(', ')}
            </p>
          </div>
          <Navigation className={`w-4 h-4 mt-0.5 ${canOpenMap ? (isDark ? 'text-zinc-300' : 'text-gray-600') : (isDark ? 'text-zinc-600' : 'text-gray-300')}`} />
          <ChevronRight className={`w-5 h-5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
        </button>

        {/* Order Info */}
        {delivery.orderTotal && (
          <div className={`flex items-center gap-3 mb-3 text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            <div className="flex items-center gap-1.5">
              <Package className="w-4 h-4" />
              <span>{delivery.orderItems?.length || 0} items</span>
            </div>
            <span>•</span>
            <span className="font-medium">€{delivery.orderTotal.toFixed(2)}</span>
            {delivery.paymentStatus === 'paid' && (
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${isDark ? 'bg-zinc-900 border border-zinc-700 text-zinc-200' : 'bg-gray-100 text-gray-700 border border-gray-300'}`}>
                PAID
              </span>
            )}
            {delivery.paymentStatus === 'cod' && (
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${isDark ? 'bg-zinc-900 border border-zinc-700 text-zinc-300' : 'bg-gray-100 text-gray-700 border border-gray-300'}`}>
                COD
              </span>
            )}
          </div>
        )}

        {/* Driver Info (if assigned) */}
        {delivery.driverName && (
          <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-2xl ${isDark ? 'bg-zinc-900 border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
            <Truck className={`w-4 h-4 ${isDark ? 'text-zinc-300' : 'text-gray-700'}`} />
            <span className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-gray-800'}`}>{delivery.driverName}</span>
          </div>
        )}

        {/* Quick Action Button */}
        {nextAction && (
          <button
            onClick={handleAction}
            className={`w-full py-2.5 rounded-xl font-medium transition-all duration-200 active:scale-[0.98] ${
              isDark
                ? 'bg-zinc-100 text-black active:bg-white'
                : 'bg-black text-white active:bg-zinc-800'
            }`}
          >
            {nextAction.label}
          </button>
        )}
      </div>
    </motion.div>
  );
});

DeliveryCard.displayName = 'DeliveryCard';

// ============================================================
// DRIVER ASSIGNMENT MODAL
// ============================================================

interface DriverAssignmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  delivery: Delivery | null;
  drivers: Driver[];
  onAssign: (deliveryId: string, driverId: string) => void;
  isDark: boolean;
}

const DriverAssignmentModal = memo<DriverAssignmentModalProps>(({
  isOpen,
  onClose,
  delivery,
  drivers,
  onAssign,
  isDark,
}) => {
  const { t } = useTranslation();
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);

  if (!isOpen || !delivery) return null;

  const availableDrivers = drivers.filter(d => d.status.isAvailable);

  const handleAssign = () => {
    if (selectedDriverId) {
      onAssign(delivery.id, selectedDriverId);
      setSelectedDriverId(null);
      onClose();
    }
  };

  return renderModalPortal(
    <div className="fixed inset-0 z-[1200] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        className={`relative w-full max-w-lg mx-4 rounded-2xl shadow-2xl shadow-black/40 max-h-[80vh] flex flex-col backdrop-blur-2xl ring-1 ${
          isDark ? 'bg-black/60 border border-white/10 ring-white/15' : 'bg-white/60 border border-white/70 ring-white/60'
        }`}
      >
        {/* Header */}
        <div className={`flex items-center justify-between p-4 border-b ${isDark ? 'border-zinc-800' : 'border-gray-200'}`}>
          <div>
            <h2 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('delivery.assignDriver', 'Assign Driver')}
            </h2>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              Order #{delivery.orderNumber}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className={`p-2 rounded-2xl inline-flex items-center justify-center transition-transform duration-150 active:scale-95 ${isDark ? 'active:bg-zinc-800 text-zinc-400' : 'active:bg-gray-100 text-gray-500'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Driver List */}
        <div className="flex-1 overflow-y-auto scrollbar-hide p-4">
          {availableDrivers.length === 0 ? (
            <div className={`text-center py-8 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">{t('delivery.noDriversAvailable', 'No drivers available')}</p>
              <p className="text-sm mt-1">{t('delivery.noDriversHint', 'All drivers are either busy or not clocked in')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {availableDrivers.map(driver => (
                <button
                  key={driver.id}
                  onClick={() => setSelectedDriverId(driver.id)}
                  className={`w-full p-3 rounded-2xl border-2 transition-all duration-150 active:scale-[0.99] text-left ${
                    selectedDriverId === driver.id
                      ? isDark ? 'border-zinc-500 bg-zinc-900' : 'border-gray-400 bg-gray-100'
                      : isDark
                      ? 'border-zinc-800 active:border-zinc-700 bg-black'
                      : 'border-gray-200 active:border-gray-300 bg-gray-50'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`}>
                      <User className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
                    </div>
                    <div className="flex-1">
                      <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        {driver.name}
                      </p>
                      <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        {driver.status.activeAssignments} active deliveries
                      </p>
                    </div>
                    {selectedDriverId === driver.id && (
                      <CheckCircle className={`w-5 h-5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`p-4 border-t ${isDark ? 'border-zinc-800' : 'border-gray-200'}`}>
          <button
            onClick={handleAssign}
            disabled={!selectedDriverId}
            className={`w-full py-3 rounded-xl font-medium transition-all duration-200 ${
              selectedDriverId
                ? isDark ? 'bg-zinc-100 text-black active:bg-white active:scale-[0.98]' : 'bg-black text-white active:bg-zinc-800 active:scale-[0.98]'
                : isDark
                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {t('delivery.assignSelected', 'Assign Selected Driver')}
          </button>
        </div>
      </motion.div>
    </div>
  );
});

DriverAssignmentModal.displayName = 'DriverAssignmentModal';

// ============================================================
// MAIN COMPONENT
// ============================================================

const DeliveryPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { getSetting } = useTerminalSettings();
  const bridge = useMemo(() => getBridge(), []);
  const isDark = resolvedTheme === 'dark';
  const storeMapOrigin = useMemo<StoreMapOrigin | null>(
    () => resolveStoreMapOrigin(getSetting),
    [getSetting]
  );

  // State
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FilterTab>('active');
  const [searchTerm, setSearchTerm] = useState('');
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [selectedDelivery, setSelectedDelivery] = useState<Delivery | null>(null);

  // Fetch deliveries
  const fetchDeliveries = useCallback(async () => {
    try {
      const response: any = await bridge.orders.getAll();
      const rows = Array.isArray(response)
        ? response
        : Array.isArray(response?.data)
          ? response.data
          : Array.isArray(response?.orders)
            ? response.orders
            : [];

      const transformed = rows
        .map((row: Record<string, any>) => mapOrderToDelivery(row))
        .filter((delivery: Delivery | null): delivery is Delivery => Boolean(delivery))
        .sort((left: Delivery, right: Delivery) => {
          const leftTs = new Date(left.updatedAt || left.createdAt).getTime();
          const rightTs = new Date(right.updatedAt || right.createdAt).getTime();
          return rightTs - leftTs;
        });

      setDeliveries(transformed);
      setError(null);
    } catch (err) {
      console.error('[DeliveryPage] Error fetching deliveries:', err);
      setError('Failed to load deliveries');
    }
  }, [bridge.orders]);

  // Fetch drivers
  const fetchDrivers = useCallback(async () => {
    try {
      const branchId = await bridge.terminalConfig.getBranchId().catch(() => null);
      const response: any = await bridge.drivers.getActive(branchId || '');
      const rows = Array.isArray(response)
        ? response
        : Array.isArray(response?.data)
          ? response.data
          : [];

      setDrivers(
        rows
          .map((driver: Record<string, any>) => mapDriverToCardShape(driver))
          .filter((driver: Driver) => Boolean(driver.id)),
      );
    } catch (err) {
      console.error('[DeliveryPage] Error fetching drivers:', err);
    }
  }, [bridge.drivers, bridge.terminalConfig]);

  // Initial load
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      await Promise.all([fetchDeliveries(), fetchDrivers()]);
      setIsLoading(false);
    };
    loadData();
  }, [fetchDeliveries, fetchDrivers]);

  // Auto-refresh from Rust-driven events.
  useEffect(() => {
    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSyncRefreshAt = Date.now();

    const scheduleRefresh = (delayMs = 250) => {
      if (disposed || pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void fetchDeliveries();
      }, delayMs);
    };

    const handleSyncStatus = () => {
      const now = Date.now();
      if (now - lastSyncRefreshAt < DELIVERY_REFRESH_MIN_MS) {
        return;
      }
      lastSyncRefreshAt = now;
      scheduleRefresh(300);
    };

    const handleOrderMutation = () => {
      scheduleRefresh(150);
    };

    onEvent('sync:status', handleSyncStatus);
    onEvent('sync:complete', handleOrderMutation);
    onEvent('order-created', handleOrderMutation);
    onEvent('order-status-updated', handleOrderMutation);
    onEvent('order-deleted', handleOrderMutation);

    return () => {
      disposed = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      offEvent('sync:status', handleSyncStatus);
      offEvent('sync:complete', handleOrderMutation);
      offEvent('order-created', handleOrderMutation);
      offEvent('order-status-updated', handleOrderMutation);
      offEvent('order-deleted', handleOrderMutation);
    };
  }, [fetchDeliveries]);

  // Manual refresh
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await Promise.all([fetchDeliveries(), fetchDrivers()]);
    setIsRefreshing(false);
    toast.success(t('delivery.refreshed', 'Deliveries refreshed'));
  }, [fetchDeliveries, fetchDrivers, t]);

  // Update delivery status
  const handleStatusUpdate = useCallback(async (deliveryId: string, newStatus: DeliveryStatus) => {
    try {
      const response: any = await bridge.orders.updateStatus(deliveryId, newStatus);

      if (response?.success !== false) {
        setDeliveries(prev =>
          prev.map(d => (d.id === deliveryId ? { ...d, status: newStatus, updatedAt: new Date().toISOString() } : d))
        );
        toast.success(
          typeof navigator !== 'undefined' && !navigator.onLine
            ? t('delivery.savedLocallyQueued', 'Saved locally and queued for sync')
            : t('delivery.statusUpdated', 'Status updated'),
        );
      } else {
        toast.error(response?.error || t('delivery.statusUpdateFailed', 'Failed to update status'));
      }
    } catch (err) {
      console.error('[DeliveryPage] Error updating status:', err);
      toast.error(t('delivery.statusUpdateFailed', 'Failed to update status'));
    }
  }, [bridge.orders, t]);

  // Assign driver
  const handleAssignDriver = useCallback(async (deliveryId: string, driverId: string) => {
    try {
      const response: any = await bridge.orders.assignDriver(deliveryId, driverId);

      if (response?.success !== false) {
        const driver = drivers.find(d => d.id === driverId);
        setDeliveries(prev =>
          prev.map(d =>
            d.id === deliveryId
              ? { ...d, status: 'assigned' as DeliveryStatus, driverId, driverName: driver?.name, updatedAt: new Date().toISOString() }
              : d
          )
        );
        toast.success(
          typeof navigator !== 'undefined' && !navigator.onLine
            ? t('delivery.savedLocallyQueued', 'Saved locally and queued for sync')
            : t('delivery.driverAssigned', 'Driver assigned'),
        );
      } else {
        toast.error(response?.error || t('delivery.assignFailed', 'Failed to assign driver'));
      }
    } catch (err) {
      console.error('[DeliveryPage] Error assigning driver:', err);
      toast.error(t('delivery.assignFailed', 'Failed to assign driver'));
    }
  }, [bridge.orders, drivers, t]);

  // Open assignment modal
  const openAssignModal = useCallback((delivery: Delivery) => {
    setSelectedDelivery(delivery);
    setShowAssignModal(true);
  }, []);

  const handleOpenMap = useCallback(async (delivery: Delivery) => {
    if (!storeMapOrigin) {
      toast.error(t('delivery.storeLocationMissing', 'Store location is not configured'));
      return;
    }

    const routeStop = buildSingleDeliveryRouteStop({
      id: delivery.id,
      orderNumber: delivery.orderNumber,
      customerName: delivery.customerName,
      deliveryAddress: delivery.address,
    });

    if (!routeStop) {
      toast.error(t('delivery.missingAddress', 'Delivery address not available'));
      return;
    }

    const mapsUrl = buildGoogleMapsDirectionsUrl(storeMapOrigin, routeStop);
    if (!mapsUrl) {
      toast.error(t('delivery.mapOpenFailed', 'Failed to build Google Maps route'));
      return;
    }

    const opened = await openExternalUrl(mapsUrl);
    if (!opened) {
      toast.error(t('delivery.mapOpenFailed', 'Failed to open Google Maps'));
    }
  }, [storeMapOrigin, t]);

  // Filtered deliveries
  const filteredDeliveries = useMemo(() => {
    let result = deliveries;

    // Filter by tab
    if (activeTab === 'active') {
      result = result.filter(d => ['pending', 'assigned', 'picked_up', 'in_transit'].includes(d.status));
    } else if (activeTab !== 'all') {
      result = result.filter(d => d.status === activeTab);
    }

    // Filter by search
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        d =>
          d.orderNumber.toLowerCase().includes(term) ||
          d.customerName?.toLowerCase().includes(term) ||
          d.customerPhone?.includes(term) ||
          d.address.street.toLowerCase().includes(term)
      );
    }

    return result;
  }, [deliveries, activeTab, searchTerm]);

  // Stats
  const stats = useMemo(() => ({
    total: deliveries.length,
    pending: deliveries.filter(d => d.status === 'pending').length,
    inTransit: deliveries.filter(d => d.status === 'in_transit').length,
    delivered: deliveries.filter(d => d.status === 'delivered').length,
    availableDrivers: drivers.filter(d => d.status.isAvailable).length,
  }), [deliveries, drivers]);

  // Loading state
  if (isLoading) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex items-center justify-center ${isDark ? 'bg-black' : 'bg-[#fdfaf5]'}`}>
        <motion.div variants={pageMotionItem} className="text-center">
          <div className={`animate-spin w-12 h-12 border-4 border-t-transparent rounded-full mx-auto mb-4 ${isDark ? 'border-zinc-300' : 'border-gray-700'}`} />
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('delivery.loading', 'Loading deliveries...')}
          </p>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex flex-col ${isDark ? 'bg-black' : 'bg-[#fdfaf5]'}`}>
      {/* Header */}
      <motion.div variants={pageMotionItem} className={`mx-6 mt-4 mb-4 px-4 py-4 rounded-2xl border flex items-center justify-between ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
        <div className="min-w-0">
          <h1 className={`truncate text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('delivery.title', 'Deliveries')}
          </h1>
          <p className={`mt-1 truncate text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {stats.pending} {t('delivery.pending', 'pending')} • {stats.inTransit} {t('delivery.inTransit', 'in transit')}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className={`relative ${isDark ? 'bg-zinc-900' : 'bg-white'} rounded-xl border ${isDark ? 'border-zinc-700' : 'border-gray-200'}`}>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder={t('delivery.search', 'Search deliveries...')}
              className={`w-48 pl-9 pr-4 py-2 rounded-xl text-sm bg-transparent outline-none ${
                isDark ? 'text-zinc-100 placeholder:text-zinc-500' : 'text-gray-900 placeholder:text-gray-400'
              }`}
            />
          </div>

          {/* Refresh */}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            aria-label={t('common.refresh', 'Refresh')}
            className={`h-12 w-12 rounded-xl inline-flex items-center justify-center transition-all ${
              isDark
                ? 'border border-amber-400/30 bg-amber-500/15 text-amber-300 active:bg-amber-500/25'
                : 'border border-amber-400/40 bg-amber-50 text-amber-600 active:bg-amber-100'
            } ${isRefreshing ? 'opacity-60 cursor-not-allowed' : 'active:scale-95'}`}
          >
            <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </motion.div>

      {/* Stats Row */}
      <motion.div variants={pageMotionItem} className="px-6 pb-4">
        <motion.div variants={pageMotionContainer} className="flex gap-3 overflow-x-auto scrollbar-hide">
          <motion.div variants={pageMotionItem} className={`px-4 py-2.5 rounded-2xl ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} border`}>
            <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('delivery.stats.total', 'Total')}</div>
            <div className={`text-xl font-bold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{stats.total}</div>
          </motion.div>
          <motion.div variants={pageMotionItem} className={`px-4 py-2.5 rounded-2xl ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} border`}>
            <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('delivery.stats.pending', 'Pending')}</div>
            <div className={`text-xl font-bold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{stats.pending}</div>
          </motion.div>
          <motion.div variants={pageMotionItem} className={`px-4 py-2.5 rounded-2xl ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} border`}>
            <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('delivery.stats.inTransit', 'In Transit')}</div>
            <div className={`text-xl font-bold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{stats.inTransit}</div>
          </motion.div>
          <motion.div variants={pageMotionItem} className={`px-4 py-2.5 rounded-2xl ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} border`}>
            <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('delivery.stats.availableDrivers', 'Available Drivers')}</div>
            <div className={`text-xl font-bold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{stats.availableDrivers}</div>
          </motion.div>
        </motion.div>
      </motion.div>

      {/* Filter Tabs */}
      <motion.div variants={pageMotionItem} className="px-6 pb-4">
        <motion.div variants={pageMotionContainer} className={`flex gap-1 p-1 rounded-2xl ${isDark ? 'bg-zinc-900 border border-zinc-800' : 'bg-gray-100'}`}>
          {FILTER_TABS.map(tab => (
            <motion.button
              variants={pageMotionItem}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-3 py-2 rounded-2xl text-sm font-medium transition-transform active:scale-[0.98] ${
                activeTab === tab.id
                  ? isDark ? 'bg-zinc-100 text-black shadow' : 'bg-black text-white shadow'
                  : isDark
                  ? 'text-zinc-400 active:text-zinc-100 active:bg-zinc-800'
                  : 'text-gray-600 active:text-gray-900 active:bg-white'
              }`}
            >
              {t(`delivery.filter.${tab.id}`, tab.label)}
            </motion.button>
          ))}
        </motion.div>
      </motion.div>

      {/* Error Banner */}
      {error && (
        <motion.div variants={pageMotionItem} className="mx-6 mb-4 px-4 py-3 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          <p className="text-red-500 text-sm">{error}</p>
        </motion.div>
      )}

      {/* Content */}
      <motion.div variants={pageMotionItem} className="flex-1 overflow-auto px-6 pb-6">
        {filteredDeliveries.length === 0 ? (
          <motion.div variants={pageMotionItem} className="flex flex-col items-center justify-center py-16">
            <Truck className={`w-16 h-16 mb-4 ${isDark ? 'text-zinc-600' : 'text-gray-300'}`} />
            <p className={`text-lg font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('delivery.noDeliveries', 'No deliveries found')}
            </p>
            <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
              {t('delivery.noDeliveriesHint', 'Deliveries will appear here when orders are placed')}
            </p>
          </motion.div>
        ) : (
          <motion.div variants={pageMotionContainer} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredDeliveries.map(delivery => (
              <DeliveryCard
                key={delivery.id}
                delivery={delivery}
                onStatusUpdate={handleStatusUpdate}
                onAssignDriver={openAssignModal}
                onOpenMap={handleOpenMap}
                canOpenMap={Boolean(storeMapOrigin && delivery.address.street)}
                isDark={isDark}
              />
            ))}
          </motion.div>
        )}
      </motion.div>

      {/* Driver Assignment Modal */}
      <DriverAssignmentModal
        isOpen={showAssignModal}
        onClose={() => {
          setShowAssignModal(false);
          setSelectedDelivery(null);
        }}
        delivery={selectedDelivery}
        drivers={drivers}
        onAssign={handleAssignDriver}
        isDark={isDark}
      />
    </motion.div>
  );
};

export default DeliveryPage;
