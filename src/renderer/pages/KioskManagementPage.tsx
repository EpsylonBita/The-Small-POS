/**
 * @fileoverview Kiosk Management Page for POS System
 *
 * Allows staff to manage and monitor kiosk self-service ordering:
 * - View kiosk orders that came in
 * - Enable/disable kiosk for the branch
 * - View QR codes
 * - Monitor kiosk status
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Monitor,
  QrCode,
  RefreshCw,
  ExternalLink,
  ToggleLeft,
  ToggleRight,
  AlertCircle,
  ShoppingBag,
  Clock,
  CheckCircle,
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { useShift } from '../contexts/shift-context';
import { formatCurrency, formatTime } from '../utils/format';

interface KioskOrder {
  id: string;
  order_number: string;
  status: string;
  total: number;
  items_count: number;
  created_at: string;
}

interface KioskStats {
  todayOrders: number;
  pendingOrders: number;
  completedOrders: number;
  totalRevenue: number;
}

const KioskManagementPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { staff } = useShift();
  const isDark = resolvedTheme === 'dark';

  const [isKioskEnabled, setIsKioskEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isToggling, setIsToggling] = useState(false);
  const [recentOrders, setRecentOrders] = useState<KioskOrder[]>([]);
  const [stats, setStats] = useState<KioskStats>({
    todayOrders: 0,
    pendingOrders: 0,
    completedOrders: 0,
    totalRevenue: 0,
  });
  const [error, setError] = useState<string | null>(null);

  const branchId = staff?.branchId;

  // Fetch kiosk status and orders using POS endpoints
  const fetchKioskData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const electron = (window as any).electronAPI;

      // Fetch kiosk status using POS endpoint
      // Note: fetchFromApi wraps responses in { success, data, status }
      const statusResult = await electron?.fetchFromApi?.('/api/pos/kiosk/status');

      if (statusResult?.success && statusResult?.data?.success) {
        setIsKioskEnabled(statusResult.data.kiosk_enabled || false);
      } else if (statusResult?.data?.error || statusResult?.error) {
        throw new Error(statusResult?.data?.error || statusResult?.error);
      }

      // Fetch recent kiosk orders using POS endpoint
      const ordersResult = await electron?.fetchFromApi?.('/api/pos/kiosk/orders?limit=10');

      if (ordersResult?.success && ordersResult?.data?.success) {
        setRecentOrders(ordersResult.data.data || []);

        // Use pre-calculated stats from API
        if (ordersResult.data.stats) {
          setStats({
            todayOrders: ordersResult.data.stats.today_count || 0,
            pendingOrders: ordersResult.data.stats.pending_count || 0,
            completedOrders: ordersResult.data.stats.completed_count || 0,
            totalRevenue: ordersResult.data.stats.total_revenue || 0,
          });
        }
      } else if (ordersResult?.data?.error || ordersResult?.error) {
        throw new Error(ordersResult?.data?.error || ordersResult?.error);
      }
    } catch (err) {
      console.error('Error fetching kiosk data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load kiosk data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKioskData();
  }, [fetchKioskData]);

  // Toggle kiosk enabled status using POS endpoint
  const handleToggleKiosk = async () => {
    setIsToggling(true);
    try {
      const electron = (window as any).electronAPI;
      const result = await electron?.fetchFromApi?.(
        '/api/pos/kiosk/toggle',
        {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !isKioskEnabled }),
        }
      );

      if (result?.success && result?.data?.success) {
        setIsKioskEnabled(result.data.kiosk_enabled);
      } else {
        throw new Error(result?.data?.error || result?.error || 'Failed to update kiosk status');
      }
    } catch (err) {
      console.error('Error toggling kiosk:', err);
      setError(err instanceof Error ? err.message : 'Failed to update kiosk status');
    } finally {
      setIsToggling(false);
    }
  };

  // Open kiosk in browser
  const handleOpenKiosk = () => {
    if (!branchId) return;
    // Use admin dashboard URL for kiosk page
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://admin.thesmall.app';
    const kioskUrl = `${baseUrl}/kiosk/${branchId}`;
    window.open(kioskUrl, '_blank');
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className={`p-6 h-full overflow-auto ${isDark ? 'text-white' : 'text-gray-900'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${isDark ? 'bg-green-900/30' : 'bg-green-100'}`}>
            <Monitor className={`w-6 h-6 ${isDark ? 'text-green-400' : 'text-green-600'}`} />
          </div>
          <div>
            <h1 className="text-2xl font-bold">
              {t('modules.kiosk.title', { defaultValue: 'Kiosk Management' })}
            </h1>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('modules.kiosk.description', { defaultValue: 'Manage self-service kiosk ordering' })}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchKioskData}
            className={`p-2 rounded-lg transition-colors ${
              isDark
                ? 'hover:bg-gray-800 text-gray-400'
                : 'hover:bg-gray-100 text-gray-600'
            }`}
            title={t('common.refresh', { defaultValue: 'Refresh' })}
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>
      </div>

      {error && (
        <div className={`mb-6 p-4 rounded-lg flex items-center gap-3 ${
          isDark ? 'bg-red-900/20 border border-red-800' : 'bg-red-50 border border-red-200'
        }`}>
          <AlertCircle className="w-5 h-5 text-red-500" />
          <p className={isDark ? 'text-red-400' : 'text-red-700'}>{error}</p>
        </div>
      )}

      {/* Kiosk Status Card */}
      <div className={`mb-6 p-6 rounded-xl ${
        isDark ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-200 shadow-sm'
      }`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`p-3 rounded-lg ${
              isKioskEnabled
                ? isDark ? 'bg-green-900/30' : 'bg-green-100'
                : isDark ? 'bg-gray-700' : 'bg-gray-100'
            }`}>
              <Monitor className={`w-8 h-8 ${
                isKioskEnabled
                  ? isDark ? 'text-green-400' : 'text-green-600'
                  : isDark ? 'text-gray-400' : 'text-gray-500'
              }`} />
            </div>
            <div>
              <h2 className="text-lg font-semibold">
                {t('modules.kiosk.status', { defaultValue: 'Kiosk Status' })}
              </h2>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {isKioskEnabled
                  ? t('modules.kiosk.enabled', { defaultValue: 'Kiosk ordering is enabled' })
                  : t('modules.kiosk.disabled', { defaultValue: 'Kiosk ordering is disabled' })
                }
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {isKioskEnabled && (
              <button
                onClick={handleOpenKiosk}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                  isDark
                    ? 'bg-blue-900/30 text-blue-400 hover:bg-blue-900/50'
                    : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                }`}
              >
                <ExternalLink className="w-4 h-4" />
                {t('modules.kiosk.openKiosk', { defaultValue: 'Open Kiosk' })}
              </button>
            )}

            <button
              onClick={handleToggleKiosk}
              disabled={isToggling}
              className={`p-2 rounded-lg transition-colors ${
                isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'
              } disabled:opacity-50`}
              title={isKioskEnabled ? 'Disable kiosk' : 'Enable kiosk'}
            >
              {isToggling ? (
                <RefreshCw className="w-8 h-8 animate-spin text-gray-400" />
              ) : isKioskEnabled ? (
                <ToggleRight className="w-8 h-8 text-green-500" />
              ) : (
                <ToggleLeft className="w-8 h-8 text-gray-400" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard
          icon={<ShoppingBag className="w-5 h-5" />}
          label={t('modules.kiosk.todayOrders', { defaultValue: "Today's Orders" })}
          value={stats.todayOrders}
          color="blue"
          isDark={isDark}
        />
        <StatCard
          icon={<Clock className="w-5 h-5" />}
          label={t('modules.kiosk.pending', { defaultValue: 'Pending' })}
          value={stats.pendingOrders}
          color="amber"
          isDark={isDark}
        />
        <StatCard
          icon={<CheckCircle className="w-5 h-5" />}
          label={t('modules.kiosk.completed', { defaultValue: 'Completed' })}
          value={stats.completedOrders}
          color="green"
          isDark={isDark}
        />
        <StatCard
          icon={<span className="text-lg font-bold">€</span>}
          label={t('modules.kiosk.revenue', { defaultValue: 'Revenue' })}
          value={formatCurrency(stats.totalRevenue)}
          color="purple"
          isDark={isDark}
        />
      </div>

      {/* QR Code Info */}
      <div className={`mb-6 p-6 rounded-xl ${
        isDark ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-200 shadow-sm'
      }`}>
        <div className="flex items-center gap-4 mb-4">
          <div className={`p-2 rounded-lg ${isDark ? 'bg-purple-900/30' : 'bg-purple-100'}`}>
            <QrCode className={`w-6 h-6 ${isDark ? 'text-purple-400' : 'text-purple-600'}`} />
          </div>
          <div>
            <h2 className="text-lg font-semibold">
              {t('modules.kiosk.qrCodes', { defaultValue: 'QR Codes' })}
            </h2>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('modules.kiosk.qrCodesDescription', { defaultValue: 'Manage QR codes in the admin dashboard' })}
            </p>
          </div>
        </div>
        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
          {t('modules.kiosk.qrCodesInfo', {
            defaultValue: 'Create and manage QR codes for kiosk ordering in the admin dashboard. Customers scan QR codes to place orders directly from their phones.'
          })}
        </p>
      </div>

      {/* Recent Kiosk Orders */}
      <div className={`rounded-xl ${
        isDark ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-200 shadow-sm'
      }`}>
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold">
            {t('modules.kiosk.recentOrders', { defaultValue: 'Recent Kiosk Orders' })}
          </h2>
        </div>

        {recentOrders.length === 0 ? (
          <div className="p-8 text-center">
            <ShoppingBag className={`w-12 h-12 mx-auto mb-3 ${isDark ? 'text-gray-600' : 'text-gray-300'}`} />
            <p className={isDark ? 'text-gray-400' : 'text-gray-500'}>
              {t('modules.kiosk.noOrders', { defaultValue: 'No kiosk orders yet' })}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {recentOrders.map((order) => (
              <div
                key={order.id}
                className={`px-6 py-4 flex items-center justify-between ${
                  isDark ? 'hover:bg-gray-700/50' : 'hover:bg-gray-50'
                } transition-colors`}
              >
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                    isDark ? 'bg-gray-700' : 'bg-gray-100'
                  }`}>
                    <span className="font-mono text-sm font-bold">
                      #{order.order_number?.slice(-3) || '---'}
                    </span>
                  </div>
                  <div>
                    <p className="font-medium">
                      {t('modules.kiosk.orderNumber', { defaultValue: 'Order' })} #{order.order_number}
                    </p>
                    <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      {order.items_count} {t('common.items', { defaultValue: 'items' })} • {formatTime(order.created_at)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                    order.status === 'completed' || order.status === 'delivered'
                      ? isDark ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-700'
                      : order.status === 'pending'
                      ? isDark ? 'bg-amber-900/30 text-amber-400' : 'bg-amber-100 text-amber-700'
                      : isDark ? 'bg-blue-900/30 text-blue-400' : 'bg-blue-100 text-blue-700'
                  }`}>
                    {order.status}
                  </span>
                  <span className="font-semibold">{formatCurrency(order.total)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// Stat Card Component
interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: 'blue' | 'green' | 'amber' | 'purple';
  isDark: boolean;
}

function StatCard({ icon, label, value, color, isDark }: StatCardProps) {
  const colorClasses = {
    blue: isDark ? 'bg-blue-900/30 text-blue-400' : 'bg-blue-100 text-blue-600',
    green: isDark ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-600',
    amber: isDark ? 'bg-amber-900/30 text-amber-400' : 'bg-amber-100 text-amber-600',
    purple: isDark ? 'bg-purple-900/30 text-purple-400' : 'bg-purple-100 text-purple-600',
  };

  return (
    <div className={`p-4 rounded-xl ${
      isDark ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-200 shadow-sm'
    }`}>
      <div className={`inline-flex p-2 rounded-lg ${colorClasses[color]} mb-3`}>
        {icon}
      </div>
      <div className="text-2xl font-bold">{value}</div>
      <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{label}</div>
    </div>
  );
}

export default KioskManagementPage;
