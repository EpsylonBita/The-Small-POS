import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  TrendingUp,
  Euro,
  ShoppingCart,
  CheckCircle,
  Download,
  FileText,
  Clock,
  CreditCard,
  Package
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { useShift } from '../contexts/shift-context';
import ZReportModal from '../components/modals/ZReportModal';
import { toast } from 'react-hot-toast';
import type {
  SalesTrendData,
  TopItemData,
  TodayStatistics,
  HourlySalesData,
  PaymentMethodBreakdown,
  OrderTypeBreakdown
} from '../types/reports';
import { exportArrayToCSV } from '../utils/reportExport';
import {
  SalesTrendChart,
  TopItemsChart,
  HourlySalesChart,
  PaymentMethodChart,
  OrderTypeChart
} from '../components/reports/ReportCharts';


const ReportsPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [selectedPeriod, setSelectedPeriod] = useState('today');
  const { staff } = useShift();
  const [todayStats, setTodayStats] = useState<TodayStatistics | null>(null);
  const [salesData, setSalesData] = useState<SalesTrendData[]>([]);
  const [topItems, setTopItems] = useState<TopItemData[]>([]);
  const [hourlySales, setHourlySales] = useState<HourlySalesData[]>([]);
  const [paymentBreakdown, setPaymentBreakdown] = useState<PaymentMethodBreakdown | null>(null);
  const [orderTypeBreakdown, setOrderTypeBreakdown] = useState<OrderTypeBreakdown | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [showZReport, setShowZReport] = useState<boolean>(false);

  // Locale-aware currency formatter
  const currency = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'EUR' });
  const isDark = resolvedTheme === 'dark';

  useEffect(() => {
    if (!staff?.branchId) return;
    const fetchReportData = async () => {
      setLoading(true);
      try {
        // Temporary fallback if preload is not exposing report APIs yet
        if (!window.electronAPI?.getTodayStatistics) {
          setTodayStats({ totalOrders: 0, totalSales: 0, avgOrderValue: 0, completionRate: 0, cashSales: 0, cardSales: 0 } as any);
          setSalesData([]);
          setTopItems([]);
          setHourlySales([]);
          setPaymentBreakdown({ cash: { count: 0, total: 0 }, card: { count: 0, total: 0 } });
          setOrderTypeBreakdown({ delivery: { count: 0, total: 0 }, instore: { count: 0, total: 0 } });
          return;
        }

        // IPC handlers wrap response in { success: true, data: ... }
        const statsResult = await window.electronAPI?.getTodayStatistics?.(staff.branchId);
        setTodayStats(statsResult?.data || statsResult || null);

        const days = selectedPeriod === 'today' ? 5 : selectedPeriod === 'week' ? 7 : selectedPeriod === 'month' ? 30 : 90;
        const trendResult = await window.electronAPI?.getSalesTrend?.({ branchId: staff.branchId, days });
        setSalesData(trendResult?.data || trendResult || []);

        const itemsResult = await window.electronAPI?.getTopItems?.({ branchId: staff.branchId, limit: 5 });
        setTopItems(itemsResult?.data || itemsResult || []);

        // Fetch new analytics data
        if (window.electronAPI?.getHourlySales) {
          const hourlyResult = await window.electronAPI.getHourlySales({ branchId: staff.branchId });
          setHourlySales(hourlyResult?.data || hourlyResult || []);
        }

        if (window.electronAPI?.getPaymentMethodBreakdown) {
          const paymentResult = await window.electronAPI.getPaymentMethodBreakdown({ branchId: staff.branchId });
          setPaymentBreakdown(paymentResult?.data || paymentResult || null);
        }

        if (window.electronAPI?.getOrderTypeBreakdown) {
          const orderTypeResult = await window.electronAPI.getOrderTypeBreakdown({ branchId: staff.branchId });
          setOrderTypeBreakdown(orderTypeResult?.data || orderTypeResult || null);
        }
      } catch (error) {
        console.error('Failed to fetch report data:', error);
        toast.error(t('reports.errors.loadFailed'));
      } finally {
        setLoading(false);
      }
    };
    fetchReportData();
  }, [staff?.branchId, selectedPeriod, t]);

  // Metric card component
  const MetricCard = ({
    icon: Icon,
    title,
    value,
    subtitle,
    color,
    delay
  }: {
    icon: any;
    title: string;
    value: string | number;
    subtitle: string;
    color: string;
    delay: number;
  }) => (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, delay }}
      className={`p-6 rounded-xl ${
        isDark ? 'bg-gray-800/50 backdrop-blur-md' : 'bg-white/80 backdrop-blur-md'
      } shadow-lg border ${isDark ? 'border-gray-700/50' : 'border-gray-200/50'} hover:shadow-xl transition-shadow`}
    >
      <div className="flex items-center justify-between mb-4">
        <div className={`p-3 rounded-lg ${color}`}>
          <Icon className="w-6 h-6 text-white" />
        </div>
      </div>
      <h3 className={`text-sm font-medium mb-2 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
        {title}
      </h3>
      <p className={`text-3xl font-bold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
        {value}
      </p>
      <p className={`text-sm ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
        {subtitle}
      </p>
    </motion.div>
  );

  if (loading) {
    return (
      <div className={`min-h-screen p-6 ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-center h-96">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className={isDark ? 'text-gray-400' : 'text-gray-600'}>
                {t('common.messages.loadingData')}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-screen overflow-y-auto p-6 ${isDark ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-900'}`}>
      <div className="max-w-7xl mx-auto pb-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-8"
        >
          <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            {t('reports.title')}
          </h1>
          <p className={`text-lg ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t('reports.subtitle')}
          </p>
        </motion.div>

        {/* Period Selector & Actions */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mb-8 flex flex-wrap items-center justify-between gap-4"
        >
          <select
            value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(e.target.value)}
            className={`px-6 py-3 rounded-xl border ${
              isDark
                ? 'bg-gray-800/50 border-gray-700 text-white backdrop-blur-md'
                : 'bg-white/80 border-gray-300 text-gray-900 backdrop-blur-md'
            } focus:ring-2 focus:ring-blue-500 focus:border-transparent shadow-lg transition-all`}
          >
            <option value="today">{t('reports.period.today')}</option>
            <option value="week">{t('reports.period.thisWeek')}</option>
            <option value="month">{t('reports.period.thisMonth')}</option>
            <option value="quarter">{t('reports.period.thisQuarter')}</option>
          </select>

          <div className="flex gap-3">
            <button
              onClick={() => {
                const data = salesData.map(d => ({
                  [t('reports.table.date')]: new Date(d.date).toLocaleDateString(),
                  [t('reports.table.orders')]: d.orders,
                  [t('reports.table.revenue')]: d.revenue,
                  [t('reports.table.avgOrder')]: d.avgOrderValue
                }));
                exportArrayToCSV(data, 'sales-report.csv');
              }}
              className={`px-6 py-3 rounded-xl border ${
                isDark
                  ? 'border-gray-700 text-gray-300 hover:bg-gray-800/50 backdrop-blur-md'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50/80 backdrop-blur-md'
              } transition-all shadow-lg flex items-center gap-2`}
            >
              <Download className="w-5 h-5" />
              {t('reports.actions.exportCSV')}
            </button>
            <button
              onClick={() => setShowZReport(true)}
              className="px-6 py-3 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white rounded-xl transition-all shadow-lg flex items-center gap-2"
            >
              <FileText className="w-5 h-5" />
              {t('reports.actions.generateZReport')}
            </button>
          </div>
        </motion.div>

        {/* Key Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <MetricCard
            icon={ShoppingCart}
            title={t('reports.metrics.totalOrders')}
            value={todayStats?.totalOrders ?? 0}
            subtitle={t('reports.trends.ordersChange')}
            color="bg-gradient-to-br from-blue-500 to-blue-600"
            delay={0.1}
          />
          <MetricCard
            icon={Euro}
            title={t('reports.sales.totalSales')}
            value={currency.format(todayStats?.totalSales ?? 0)}
            subtitle={t('reports.trends.revenueChange')}
            color="bg-gradient-to-br from-green-500 to-green-600"
            delay={0.15}
          />
          <MetricCard
            icon={TrendingUp}
            title={t('reports.orders.avgOrderValue')}
            value={currency.format(todayStats?.avgOrderValue ?? 0)}
            subtitle={t('reports.trends.avgOrderChange')}
            color="bg-gradient-to-br from-purple-500 to-purple-600"
            delay={0.2}
          />
          <MetricCard
            icon={CheckCircle}
            title={`${t('common.status.completed')} Rate`}
            value={`${todayStats?.completionRate ?? 0}%`}
            subtitle={t('reports.trends.completionRateChange')}
            color="bg-gradient-to-br from-orange-500 to-orange-600"
            delay={0.25}
          />
        </div>

        {/* Charts Section */}
        <div className="space-y-8">
          {/* Sales Trend Chart */}
          {salesData.length > 0 && (
            <SalesTrendChart data={salesData} isDark={isDark} currency={currency} />
          )}

          {/* Two Column Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Top Items Chart */}
            {topItems.length > 0 && (
              <TopItemsChart data={topItems} isDark={isDark} currency={currency} />
            )}

            {/* Hourly Sales Chart */}
            {hourlySales.length > 0 && (
              <HourlySalesChart data={hourlySales} isDark={isDark} currency={currency} />
            )}
          </div>

          {/* Payment & Order Type Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Payment Method Breakdown */}
            {paymentBreakdown && (
              <PaymentMethodChart
                cashTotal={paymentBreakdown.cash.total}
                cardTotal={paymentBreakdown.card.total}
                isDark={isDark}
                currency={currency}
              />
            )}

            {/* Order Type Breakdown */}
            {orderTypeBreakdown && (
              <OrderTypeChart
                deliveryTotal={orderTypeBreakdown.delivery.total}
                instoreTotal={orderTypeBreakdown.instore.total}
                isDark={isDark}
                currency={currency}
              />
            )}
          </div>

          {/* Additional Metrics Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.6 }}
              className={`p-6 rounded-xl ${
                isDark ? 'bg-gray-800/50 backdrop-blur-md' : 'bg-white/80 backdrop-blur-md'
              } shadow-lg border ${isDark ? 'border-gray-700/50' : 'border-gray-200/50'}`}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="p-3 rounded-lg bg-gradient-to-br from-green-500 to-green-600">
                  <CreditCard className="w-6 h-6 text-white" />
                </div>
                <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('reports.payments.cashPayments')}
                </h3>
              </div>
              <p className={`text-3xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {currency.format(paymentBreakdown?.cash.total ?? 0)}
              </p>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {paymentBreakdown?.cash.count ?? 0} {t('reports.payments.transactions')}
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.65 }}
              className={`p-6 rounded-xl ${
                isDark ? 'bg-gray-800/50 backdrop-blur-md' : 'bg-white/80 backdrop-blur-md'
              } shadow-lg border ${isDark ? 'border-gray-700/50' : 'border-gray-200/50'}`}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="p-3 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600">
                  <CreditCard className="w-6 h-6 text-white" />
                </div>
                <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('reports.payments.cardPayments')}
                </h3>
              </div>
              <p className={`text-3xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {currency.format(paymentBreakdown?.card.total ?? 0)}
              </p>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {paymentBreakdown?.card.count ?? 0} {t('reports.payments.transactions')}
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.7 }}
              className={`p-6 rounded-xl ${
                isDark ? 'bg-gray-800/50 backdrop-blur-md' : 'bg-white/80 backdrop-blur-md'
              } shadow-lg border ${isDark ? 'border-gray-700/50' : 'border-gray-200/50'}`}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="p-3 rounded-lg bg-gradient-to-br from-purple-500 to-purple-600">
                  <Package className="w-6 h-6 text-white" />
                </div>
                <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('reports.deliveryOrders')}
                </h3>
              </div>
              <p className={`text-3xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {currency.format(orderTypeBreakdown?.delivery.total ?? 0)}
              </p>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {orderTypeBreakdown?.delivery.count ?? 0} {t('reports.payments.orders')}
              </p>
            </motion.div>
          </div>
        </div>

        {/* Z Report Modal */}
        {showZReport && (
          <ZReportModal
            isOpen={showZReport}
            onClose={() => setShowZReport(false)}
            branchId={staff?.branchId || ''}
          />
        )}

      </div>
    </div>
  );
};

export default ReportsPage;