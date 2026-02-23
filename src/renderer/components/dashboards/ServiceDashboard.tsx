import React, { memo, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../contexts/theme-context';
import { useOrderStore } from '../../hooks/useOrderStore';
import { useModules } from '../../contexts/module-context';
import { useNavigationSafe } from '../../contexts/navigation-context';
import { OrderDashboard } from '../OrderDashboard';
import OrderFlow from '../OrderFlow';
import { OrderConflictBanner } from '../OrderConflictBanner';
import { DashboardCard } from '../DashboardCard';
import { formatTime } from '../../utils/format';
import { getBridge, offEvent, onEvent } from '../../../lib';
import {
  Calendar,
  Bed,
  Scissors,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react';
import type { ModuleId } from '../../../shared/types/modules';

/**
 * Service Business Category Dashboard
 * Optimized for: salon, hotel businesses
 *
 * Key features:
 * - Appointments/bookings overview with metrics cards
 * - Staff availability
 * - Room/service status (hotel)
 * - Today's schedule highlights
 * - Module-based card visibility
 */
interface ServiceDashboardProps {
  className?: string;
}

interface ServiceMetrics {
  appointmentsToday: number;
  availableRooms: number;
  totalRooms: number;
  completedToday: number;
  canceledToday: number;
  isLoading: boolean;
}

export const ServiceDashboard = memo<ServiceDashboardProps>(({ className = '' }) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { initializeOrders, conflicts, orders } = useOrderStore();
  const { businessType, isModuleEnabled } = useModules();
  const navigation = useNavigationSafe();
  const isDark = resolvedTheme === 'dark';

  const isHotel = businessType === 'hotel';

  // Service metrics state
  const [metrics, setMetrics] = useState<ServiceMetrics>({
    appointmentsToday: 0,
    availableRooms: 0,
    totalRooms: 0,
    completedToday: 0,
    canceledToday: 0,
    isLoading: true,
  });

  /**
   * Load service metrics from the backend
   * Falls back to deriving from orders when APIs return notImplemented
   */
  const loadMetrics = useCallback(async () => {
    try {
      // For hotel businesses, fetch room availability
      if (isHotel) {
        try {
          const roomsResult = await bridge.invoke('rooms:get-availability');
          if (roomsResult?.success) {
            setMetrics((prev) => ({
              ...prev,
              availableRooms: roomsResult.available || 0,
              totalRooms: roomsResult.total || 0,
            }));
          }
          // Note: notImplemented responses are expected - no error logging needed
        } catch (err) {
          // Only log unexpected errors, not expected "not implemented" cases
          if (!(err as Error)?.message?.includes('not implemented')) {
            console.warn('[ServiceDashboard] Failed to fetch rooms:', err);
          }
        }
      }

      // Fetch appointments metrics
      try {
        const appointmentsResult = await bridge.invoke(
          'appointments:get-today-metrics'
        );
        if (appointmentsResult?.success) {
          setMetrics((prev) => ({
            ...prev,
            appointmentsToday: appointmentsResult.scheduled || 0,
            completedToday: appointmentsResult.completed || 0,
            canceledToday: appointmentsResult.canceled || 0,
            isLoading: false,
          }));
        } else {
          // API returned notImplemented or failed - derive from orders (expected behavior)
          deriveMetricsFromOrders();
        }
      } catch (err) {
        // Fallback to orders - this is expected when IPC is unavailable
        deriveMetricsFromOrders();
      }
    } catch (error) {
      console.error('[ServiceDashboard] Failed to load metrics:', error);
      setMetrics((prev) => ({ ...prev, isLoading: false }));
    }
  }, [bridge, isHotel]);

  /**
   * Derive metrics from orders when appointment API is not available
   * This provides a fallback for businesses using orders as appointments
   */
  const deriveMetricsFromOrders = useCallback(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayOrders = orders.filter((order) => {
      const orderDate = new Date(order.createdAt || '');
      orderDate.setHours(0, 0, 0, 0);
      return orderDate.getTime() === today.getTime();
    });

    const scheduled = todayOrders.filter((o) =>
      ['pending', 'confirmed', 'preparing'].includes(o.status)
    ).length;

    const completed = todayOrders.filter((o) =>
      ['completed', 'delivered'].includes(o.status)
    ).length;

    const canceled = todayOrders.filter((o) => o.status === 'cancelled').length;

    setMetrics((prev) => ({
      ...prev,
      appointmentsToday: scheduled,
      completedToday: completed,
      canceledToday: canceled,
      isLoading: false,
    }));
  }, [orders]);

  // Initialize orders when dashboard loads
  useEffect(() => {
    console.log('🎯 Service Dashboard loading - initializing orders...');
    initializeOrders();
  }, [initializeOrders]);

  // Load metrics on mount and refresh from Rust-driven events.
  useEffect(() => {
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (disposed || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void loadMetrics();
      }, 250);
    };

    void loadMetrics();

    onEvent('sync:status', scheduleRefresh);
    onEvent('sync:complete', scheduleRefresh);
    onEvent('order-created', scheduleRefresh);
    onEvent('order-status-updated', scheduleRefresh);
    onEvent('order-deleted', scheduleRefresh);

    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      offEvent('sync:status', scheduleRefresh);
      offEvent('sync:complete', scheduleRefresh);
      offEvent('order-created', scheduleRefresh);
      offEvent('order-status-updated', scheduleRefresh);
      offEvent('order-deleted', scheduleRefresh);
    };
  }, [loadMetrics]);

  // Re-derive metrics when orders change
  useEffect(() => {
    if (!metrics.isLoading) {
      deriveMetricsFromOrders();
    }
  }, [orders, deriveMetricsFromOrders, metrics.isLoading]);

  // Handle conflict resolution
  const handleResolveConflict = async (conflictId: string, strategy: string) => {
    try {
      await bridge.orders.resolveConflict(conflictId, strategy);
    } catch (error) {
      console.error('Failed to resolve conflict:', error);
      throw error;
    }
  };

  // Handle card navigation using context (not hash-based)
  const handleNavigateToAppointments = () => {
    navigation?.navigateTo('appointments');
  };

  const handleNavigateToRooms = () => {
    navigation?.navigateTo('rooms');
  };

  // Module visibility checks
  const showAppointments = isModuleEnabled('appointments' as ModuleId);
  const showRooms = isHotel && isModuleEnabled('rooms' as ModuleId);
  // Completed and canceled are always shown for service businesses
  const showCompleted = true;
  const showCanceled = true;

  // Determine if we should show the metrics grid
  const hasMetricsToShow = showAppointments || showRooms || showCompleted || showCanceled;

  return (
    <div
      className={`p-4 md:p-6 space-y-4 md:space-y-6 ${className}`}
      data-testid="service-dashboard"
      data-business-category="service"
      data-business-type={isHotel ? 'hotel' : 'salon'}
    >
      {/* Conflict Banner */}
      {conflicts.length > 0 && (
        <OrderConflictBanner
          conflicts={conflicts}
          onResolve={handleResolveConflict}
        />
      )}

      {/* Business Type Header */}
      <div className="flex items-center gap-3" role="banner">
        {isHotel ? (
          <Bed className={`w-6 h-6 ${isDark ? 'text-purple-400' : 'text-purple-600'}`} />
        ) : (
          <Scissors className={`w-6 h-6 ${isDark ? 'text-pink-400' : 'text-pink-600'}`} />
        )}
        <h1 className={`text-xl md:text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {isHotel
            ? t('dashboard.hotelDashboard', { defaultValue: 'Hotel Dashboard' })
            : t('dashboard.salonDashboard', { defaultValue: 'Salon Dashboard' })
          }
        </h1>
        <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <Clock className="w-4 h-4 inline mr-1" />
          {formatTime(new Date(), { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* Metrics Cards Grid */}
      {hasMetricsToShow && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Appointments Card */}
          {showAppointments && (
            <DashboardCard
              icon="Calendar"
              title={t('dashboard.appointmentsToday', { defaultValue: 'Appointments Today' })}
              value={metrics.appointmentsToday}
              color="blue"
              onClick={handleNavigateToAppointments}
              isLoading={metrics.isLoading}
              subtitle={t('dashboard.scheduled', { defaultValue: 'Scheduled' })}
            />
          )}

          {/* Rooms Card (Hotel only) */}
          {showRooms && (
            <DashboardCard
              icon="Bed"
              title={t('dashboard.availableRooms', { defaultValue: 'Available Rooms' })}
              value={`${metrics.availableRooms}/${metrics.totalRooms}`}
              color="brown"
              onClick={handleNavigateToRooms}
              isLoading={metrics.isLoading}
              subtitle={t('dashboard.roomStatus', { defaultValue: 'Room Status' })}
            />
          )}

          {/* Completed Card */}
          {showCompleted && (
            <DashboardCard
              icon="CheckCircle2"
              title={t('dashboard.completedToday', { defaultValue: 'Completed Today' })}
              value={metrics.completedToday}
              color="green"
              isLoading={metrics.isLoading}
              subtitle={t('dashboard.servicesCompleted', { defaultValue: 'Services Completed' })}
            />
          )}

          {/* Canceled Card */}
          {showCanceled && (
            <DashboardCard
              icon="XCircle"
              title={t('dashboard.canceledToday', { defaultValue: 'Canceled Today' })}
              value={metrics.canceledToday}
              color="red"
              isLoading={metrics.isLoading}
              subtitle={t('dashboard.appointmentsCanceled', { defaultValue: 'Appointments Canceled' })}
            />
          )}
        </div>
      )}

      {/* Empty State - No modules purchased */}
      {!hasMetricsToShow && (
        <div className={`
          rounded-xl border p-8 text-center
          ${isDark ? 'bg-gray-800/30 border-gray-700/50' : 'bg-gray-50 border-gray-200'}
        `}>
          <Calendar className={`w-12 h-12 mx-auto mb-4 ${isDark ? 'text-gray-600' : 'text-gray-400'}`} />
          <h3 className={`text-lg font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('dashboard.noModulesEnabled', { defaultValue: 'No Modules Enabled' })}
          </h3>
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t('dashboard.enableModulesPrompt', {
              defaultValue: 'Enable appointments or rooms modules to see metrics here.'
            })}
          </p>
        </div>
      )}

      {/* Orders Section (for add-on purchases/retail) */}
      {orders.length > 0 && (
        <div className="space-y-2">
          <h2 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('dashboard.recentOrders', { defaultValue: 'Recent Orders' })}
          </h2>
          <OrderDashboard className="flex-1" />
        </div>
      )}

      {/* Order Flow with floating Add Order button */}
      <OrderFlow />
    </div>
  );
});

ServiceDashboard.displayName = 'ServiceDashboard';

export default ServiceDashboard;
