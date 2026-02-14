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
import { toast } from 'react-hot-toast';
import { useTheme } from '../contexts/theme-context';
import { useTerminalSettings } from '../hooks/useTerminalSettings';
import { posApiGet, posApiPost, posApiPatch } from '../utils/api-helpers';
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
  Filter,
  ChevronRight,
  AlertTriangle,
  Play,
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

// ============================================================
// DELIVERY CARD COMPONENT
// ============================================================

interface DeliveryCardProps {
  delivery: Delivery;
  onStatusUpdate: (deliveryId: string, status: DeliveryStatus) => void;
  onAssignDriver: (delivery: Delivery) => void;
  isDark: boolean;
}

const DeliveryCard = memo<DeliveryCardProps>(({ delivery, onStatusUpdate, onAssignDriver, isDark }) => {
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
    <div
      className={`rounded-xl border overflow-hidden ${
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
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium"
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
        <div className={`flex items-start gap-2 mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          <MapPin className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isDark ? 'text-zinc-400' : 'text-gray-500'}`} />
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate">{delivery.address.street}</p>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {[delivery.address.city, delivery.address.postalCode].filter(Boolean).join(', ')}
            </p>
          </div>
          <ChevronRight className={`w-5 h-5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
        </div>

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
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${isDark ? 'bg-zinc-900 border border-zinc-700 text-zinc-200' : 'bg-gray-100 text-gray-700 border border-gray-300'}`}>
                PAID
              </span>
            )}
            {delivery.paymentStatus === 'cod' && (
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${isDark ? 'bg-zinc-900 border border-zinc-700 text-zinc-300' : 'bg-gray-100 text-gray-700 border border-gray-300'}`}>
                COD
              </span>
            )}
          </div>
        )}

        {/* Driver Info (if assigned) */}
        {delivery.driverName && (
          <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-lg ${isDark ? 'bg-zinc-900 border border-zinc-800' : 'bg-gray-50 border border-gray-200'}`}>
            <Truck className={`w-4 h-4 ${isDark ? 'text-zinc-300' : 'text-gray-700'}`} />
            <span className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-gray-800'}`}>{delivery.driverName}</span>
          </div>
        )}

        {/* Quick Action Button */}
        {nextAction && (
          <button
            onClick={handleAction}
            className={`w-full py-2.5 rounded-lg font-medium transition-all hover:opacity-90 active:scale-[0.98] ${
              isDark
                ? 'bg-zinc-100 text-black hover:bg-white'
                : 'bg-black text-white hover:bg-zinc-800'
            }`}
          >
            {nextAction.label}
          </button>
        )}
      </div>
    </div>
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div
        className={`relative w-full max-w-lg mx-4 rounded-2xl shadow-2xl max-h-[80vh] flex flex-col ${
          isDark ? 'bg-zinc-950 border border-zinc-800' : 'bg-white border border-gray-200'
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
            className={`p-2 rounded-lg ${isDark ? 'hover:bg-zinc-800 text-zinc-400' : 'hover:bg-gray-100 text-gray-500'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Driver List */}
        <div className="flex-1 overflow-y-auto p-4">
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
                  className={`w-full p-3 rounded-xl border-2 transition-all text-left ${
                    selectedDriverId === driver.id
                      ? isDark ? 'border-zinc-500 bg-zinc-900' : 'border-gray-400 bg-gray-100'
                      : isDark
                      ? 'border-zinc-800 hover:border-zinc-700 bg-black'
                      : 'border-gray-200 hover:border-gray-300 bg-gray-50'
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
            className={`w-full py-3 rounded-xl font-medium transition-all ${
              selectedDriverId
                ? isDark ? 'bg-zinc-100 text-black hover:bg-white' : 'bg-black text-white hover:bg-zinc-800'
                : isDark
                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {t('delivery.assignSelected', 'Assign Selected Driver')}
          </button>
        </div>
      </div>
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
  const isDark = resolvedTheme === 'dark';

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

  const branchId = getSetting<string>('terminal', 'branch_id', '');

  // Fetch deliveries
  const fetchDeliveries = useCallback(async () => {
    try {
      const response = await posApiGet<{
        success: boolean;
        deliveries: any[];
        error?: string;
      }>('/api/pos/delivery/orders');

      if (response.success && response.data?.deliveries) {
        // Transform API response to our Delivery type
        const transformed: Delivery[] = response.data.deliveries.map((d: any) => ({
          id: d.id,
          orderId: d.order_id,
          orderNumber: d.order_number || d.orderNumber,
          status: d.status,
          customerName: d.customer_name || d.customerName,
          customerPhone: d.customer_phone || d.customerPhone,
          address: {
            street: d.delivery_address?.street || d.address?.street || '',
            city: d.delivery_address?.city || d.address?.city,
            postalCode: d.delivery_address?.postal_code || d.address?.postalCode,
            floor: d.delivery_address?.floor || d.address?.floor,
            notes: d.delivery_address?.notes || d.address?.notes,
          },
          driverId: d.driver_id || d.driverId,
          driverName: d.driver_name || d.driverName,
          orderTotal: d.order_total || d.orderTotal,
          orderItems: d.order_items || d.orderItems,
          paymentStatus: d.payment_status || d.paymentStatus,
          estimatedDeliveryTime: d.estimated_delivery_time || d.estimatedDeliveryTime,
          actualDeliveryTime: d.actual_delivery_time || d.actualDeliveryTime,
          createdAt: d.created_at || d.createdAt,
          updatedAt: d.updated_at || d.updatedAt,
        }));
        setDeliveries(transformed);
      }
    } catch (err) {
      console.error('[DeliveryPage] Error fetching deliveries:', err);
      setError('Failed to load deliveries');
    }
  }, []);

  // Fetch drivers
  const fetchDrivers = useCallback(async () => {
    try {
      const response = await posApiGet<{
        success: boolean;
        drivers: any[];
        error?: string;
      }>('/api/pos/delivery/drivers');

      if (response.success && response.data?.drivers) {
        setDrivers(response.data.drivers);
      }
    } catch (err) {
      console.error('[DeliveryPage] Error fetching drivers:', err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      await Promise.all([fetchDeliveries(), fetchDrivers()]);
      setIsLoading(false);
    };
    loadData();
  }, [fetchDeliveries, fetchDrivers]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchDeliveries();
    }, 30000);
    return () => clearInterval(interval);
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
      const response = await posApiPatch(`/api/pos/delivery/${deliveryId}/status`, {
        status: newStatus,
      });

      if (response.success) {
        setDeliveries(prev =>
          prev.map(d => (d.id === deliveryId ? { ...d, status: newStatus, updatedAt: new Date().toISOString() } : d))
        );
        toast.success(t('delivery.statusUpdated', 'Status updated'));
      } else {
        toast.error(t('delivery.statusUpdateFailed', 'Failed to update status'));
      }
    } catch (err) {
      console.error('[DeliveryPage] Error updating status:', err);
      toast.error(t('delivery.statusUpdateFailed', 'Failed to update status'));
    }
  }, [t]);

  // Assign driver
  const handleAssignDriver = useCallback(async (deliveryId: string, driverId: string) => {
    try {
      const response = await posApiPost('/api/pos/delivery/assign', {
        delivery_id: deliveryId,
        driver_id: driverId,
      });

      if (response.success) {
        const driver = drivers.find(d => d.id === driverId);
        setDeliveries(prev =>
          prev.map(d =>
            d.id === deliveryId
              ? { ...d, status: 'assigned' as DeliveryStatus, driverId, driverName: driver?.name, updatedAt: new Date().toISOString() }
              : d
          )
        );
        toast.success(t('delivery.driverAssigned', 'Driver assigned'));
      } else {
        toast.error(t('delivery.assignFailed', 'Failed to assign driver'));
      }
    } catch (err) {
      console.error('[DeliveryPage] Error assigning driver:', err);
      toast.error(t('delivery.assignFailed', 'Failed to assign driver'));
    }
  }, [drivers, t]);

  // Open assignment modal
  const openAssignModal = useCallback((delivery: Delivery) => {
    setSelectedDelivery(delivery);
    setShowAssignModal(true);
  }, []);

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
      <div className={`h-full flex items-center justify-center ${isDark ? 'bg-black' : 'bg-gray-50'}`}>
        <div className="text-center">
          <div className={`animate-spin w-12 h-12 border-4 border-t-transparent rounded-full mx-auto mb-4 ${isDark ? 'border-zinc-300' : 'border-gray-700'}`} />
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('delivery.loading', 'Loading deliveries...')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col ${isDark ? 'bg-black' : 'bg-gray-50'}`}>
      {/* Header */}
      <div className={`mx-6 mt-4 mb-4 px-4 py-4 rounded-2xl border flex items-center justify-between ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
        <div className="flex items-center gap-4">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${isDark ? 'bg-zinc-900 border border-zinc-700' : 'bg-gray-100 border border-gray-200'}`}>
            <Truck className={`w-6 h-6 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`} />
          </div>
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('delivery.title', 'Deliveries')}
            </h1>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {stats.pending} {t('delivery.pending', 'pending')} • {stats.inTransit} {t('delivery.inTransit', 'in transit')}
            </p>
          </div>
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
            onClick={handleRefresh}
            disabled={isRefreshing}
            className={`p-2.5 rounded-xl ${isDark ? 'bg-zinc-900 hover:bg-zinc-800' : 'bg-white hover:bg-gray-50'} border ${
              isDark ? 'border-zinc-700' : 'border-gray-200'
            } transition-colors disabled:opacity-50`}
          >
            <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''} ${isDark ? 'text-gray-300' : 'text-gray-600'}`} />
          </button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="px-6 pb-4">
        <div className="flex gap-3 overflow-x-auto scrollbar-hide">
          <div className={`px-4 py-2.5 rounded-xl ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} border`}>
            <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('delivery.stats.total', 'Total')}</div>
            <div className={`text-xl font-bold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{stats.total}</div>
          </div>
          <div className={`px-4 py-2.5 rounded-xl ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} border`}>
            <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('delivery.stats.pending', 'Pending')}</div>
            <div className={`text-xl font-bold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{stats.pending}</div>
          </div>
          <div className={`px-4 py-2.5 rounded-xl ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} border`}>
            <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('delivery.stats.inTransit', 'In Transit')}</div>
            <div className={`text-xl font-bold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{stats.inTransit}</div>
          </div>
          <div className={`px-4 py-2.5 rounded-xl ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} border`}>
            <div className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{t('delivery.stats.availableDrivers', 'Available Drivers')}</div>
            <div className={`text-xl font-bold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{stats.availableDrivers}</div>
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="px-6 pb-4">
        <div className={`flex gap-1 p-1 rounded-xl ${isDark ? 'bg-zinc-900 border border-zinc-800' : 'bg-gray-100'}`}>
          {FILTER_TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.id
                  ? isDark ? 'bg-zinc-100 text-black shadow' : 'bg-black text-white shadow'
                  : isDark
                  ? 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-white'
              }`}
            >
              {t(`delivery.filter.${tab.id}`, tab.label)}
            </button>
          ))}
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mx-6 mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          <p className="text-red-500 text-sm">{error}</p>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        {filteredDeliveries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <Truck className={`w-16 h-16 mb-4 ${isDark ? 'text-zinc-600' : 'text-gray-300'}`} />
            <p className={`text-lg font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('delivery.noDeliveries', 'No deliveries found')}
            </p>
            <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
              {t('delivery.noDeliveriesHint', 'Deliveries will appear here when orders are placed')}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredDeliveries.map(delivery => (
              <DeliveryCard
                key={delivery.id}
                delivery={delivery}
                onStatusUpdate={handleStatusUpdate}
                onAssignDriver={openAssignModal}
                isDark={isDark}
              />
            ))}
          </div>
        )}
      </div>

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
    </div>
  );
};

export default DeliveryPage;
