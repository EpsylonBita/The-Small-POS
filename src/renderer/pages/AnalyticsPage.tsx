import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  TrendingUp,
  TrendingDown,
  Euro,
  ShoppingCart,
  Users,
  Clock,
  RefreshCw,
  Calendar,
  BarChart3,
  PieChart,
  Activity
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { useShift } from '../contexts/shift-context';
import { toast } from 'react-hot-toast';
import { formatCurrency } from '../utils/format';

interface AnalyticsData {
  totalRevenue: number;
  totalOrders: number;
  averageOrderValue: number;
  totalCustomers: number;
  revenueChange: number;
  ordersChange: number;
  peakHour: string;
  topCategory: string;
  dailyRevenue: { date: string; revenue: number }[];
  categoryBreakdown: { category: string; revenue: number; percentage: number }[];
  hourlyDistribution: { hour: number; orders: number }[];
}

const AnalyticsPage: React.FC = () => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { staff } = useShift();
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today');
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);

  const isDark = resolvedTheme === 'dark';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const fetchAnalytics = useCallback(async () => {
    if (!staff?.branchId) return;
    setLoading(true);
    try {
      const { posApiGet } = await import('../utils/api-helpers');
      const timeRange = period === 'today' ? 'today' : period === 'week' ? 'week' : 'month';
      const result = await posApiGet<{ analytics: AnalyticsData }>(
        `pos/analytics?branch_id=${staff.branchId}&time_range=${timeRange}`
      );

      if (!result.success || !result.data?.analytics) {
        throw new Error(result.error || 'Analytics API returned no data');
      }
      setAnalytics(result.data.analytics);
    } catch (error) {
      console.error('Failed to fetch analytics:', error);
      toast.error(t('analytics.errors.loadFailed', 'Failed to load analytics'));
    } finally {
      setLoading(false);
    }
  }, [staff?.branchId, period, t]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  const StatCard = ({ icon: Icon, label, value, change, color }: {
    icon: React.ElementType;
    label: string;
    value: string;
    change?: number;
    color: string;
  }) => (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} backdrop-blur-sm border ${isDark ? 'border-gray-700' : 'border-gray-200'} shadow-lg`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className={`p-2 rounded-lg ${color}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        {change !== undefined && (
          <div className={`flex items-center text-sm ${change >= 0 ? 'text-green-500' : 'text-red-500'}`}>
            {change >= 0 ? <TrendingUp className="w-4 h-4 mr-1" /> : <TrendingDown className="w-4 h-4 mr-1" />}
            {Math.abs(change).toFixed(1)}%
          </div>
        )}
      </div>
      <p className="text-2xl font-bold">{value}</p>
      <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{label}</p>
    </motion.div>
  );

  if (loading && !analytics) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-8 h-8 animate-spin text-cyan-500" />
      </div>
    );
  }

  return (
    <div className={`h-full overflow-auto p-4 ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-cyan-500/20">
            <BarChart3 className="w-6 h-6 text-cyan-500" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('analytics.title', 'Analytics')}</h1>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              {t('analytics.subtitle', 'Business performance insights')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(['today', 'week', 'month'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                period === p
                  ? 'bg-cyan-500 text-white'
                  : isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-700 hover:bg-gray-100'
              }`}
            >
              {t(`analytics.period.${p}`, p.charAt(0).toUpperCase() + p.slice(1))}
            </button>
          ))}
          <button
            onClick={fetchAnalytics}
            className={`p-2 rounded-lg ${isDark ? 'bg-gray-800 hover:bg-gray-700' : 'bg-white hover:bg-gray-100'}`}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          icon={Euro}
          label={t('analytics.totalRevenue', 'Total Revenue')}
          value={formatMoney(analytics?.totalRevenue || 0)}
          change={analytics?.revenueChange}
          color="bg-green-500"
        />
        <StatCard
          icon={ShoppingCart}
          label={t('analytics.totalOrders', 'Total Orders')}
          value={String(analytics?.totalOrders || 0)}
          change={analytics?.ordersChange}
          color="bg-blue-500"
        />
        <StatCard
          icon={Activity}
          label={t('analytics.avgOrder', 'Avg Order Value')}
          value={formatMoney(analytics?.averageOrderValue || 0)}
          color="bg-purple-500"
        />
        <StatCard
          icon={Users}
          label={t('analytics.customers', 'Customers')}
          value={String(analytics?.totalCustomers || 0)}
          color="bg-orange-500"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Category Breakdown */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} backdrop-blur-sm border ${isDark ? 'border-gray-700' : 'border-gray-200'} shadow-lg`}
        >
          <div className="flex items-center gap-2 mb-4">
            <PieChart className="w-5 h-5 text-cyan-500" />
            <h3 className="font-semibold">{t('analytics.categoryBreakdown', 'Sales by Category')}</h3>
          </div>
          <div className="space-y-3">
            {analytics?.categoryBreakdown?.map((cat, idx) => (
              <div key={idx}>
                <div className="flex justify-between text-sm mb-1">
                  <span>{cat.category}</span>
                  <span className="font-medium">{formatMoney(cat.revenue)} ({cat.percentage}%)</span>
                </div>
                <div className={`h-2 rounded-full ${isDark ? 'bg-gray-700' : 'bg-gray-200'}`}>
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-500"
                    style={{ width: `${cat.percentage}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Hourly Distribution */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} backdrop-blur-sm border ${isDark ? 'border-gray-700' : 'border-gray-200'} shadow-lg`}
        >
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-5 h-5 text-cyan-500" />
            <h3 className="font-semibold">{t('analytics.hourlyOrders', 'Orders by Hour')}</h3>
          </div>
          <div className="flex items-end justify-between h-32 gap-1">
            {analytics?.hourlyDistribution?.map((h, idx) => {
              const maxOrders = Math.max(...(analytics?.hourlyDistribution?.map(x => x.orders) || [1]));
              const height = (h.orders / maxOrders) * 100;
              return (
                <div key={idx} className="flex-1 flex flex-col items-center">
                  <div
                    className="w-full bg-gradient-to-t from-cyan-500 to-blue-500 rounded-t"
                    style={{ height: `${height}%`, minHeight: '4px' }}
                  />
                  <span className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    {h.hour}
                  </span>
                </div>
              );
            })}
          </div>
        </motion.div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} backdrop-blur-sm border ${isDark ? 'border-gray-700' : 'border-gray-200'} shadow-lg`}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-500/20">
              <Clock className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {t('analytics.peakHour', 'Peak Hour')}
              </p>
              <p className="text-lg font-bold">{analytics?.peakHour || '-'}</p>
            </div>
          </div>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className={`p-4 rounded-xl ${isDark ? 'bg-gray-800/50' : 'bg-white/80'} backdrop-blur-sm border ${isDark ? 'border-gray-700' : 'border-gray-200'} shadow-lg`}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-pink-500/20">
              <BarChart3 className="w-5 h-5 text-pink-500" />
            </div>
            <div>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {t('analytics.topCategory', 'Top Category')}
              </p>
              <p className="text-lg font-bold">{analytics?.topCategory || '-'}</p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
};

export default AnalyticsPage;

