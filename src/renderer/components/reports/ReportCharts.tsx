import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { motion } from 'framer-motion';
import { formatDate as formatDateValue } from '../../utils/format';
import type { SalesTrendData, TopItemData, HourlySalesData } from '../../types/reports';

interface ChartContainerProps {
  title: string;
  children: React.ReactNode;
  isDark: boolean;
  delay?: number;
}

const ChartContainer = memo<ChartContainerProps>(({ title, children, isDark, delay = 0 }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.5, delay }}
    className={`p-6 rounded-xl ${
      isDark ? 'bg-gray-800/50 backdrop-blur-md' : 'bg-white/80 backdrop-blur-md'
    } shadow-lg border ${isDark ? 'border-gray-700/50' : 'border-gray-200/50'}`}
  >
    <h3 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
      {title}
    </h3>
    {children}
  </motion.div>
));

ChartContainer.displayName = 'ChartContainer';

interface SalesTrendChartProps {
  data: SalesTrendData[];
  isDark: boolean;
  currency: Intl.NumberFormat;
}

export const SalesTrendChart = memo<SalesTrendChartProps>(({ data, isDark, currency }) => {
  const { t } = useTranslation();
  const formatChartDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return formatDateValue(date, { month: 'short', day: 'numeric' });
  };

  return (
    <ChartContainer title={t('reports.sales.salesTrend')} isDark={isDark} delay={0.1}>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#eab308" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#eab308" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#374151' : '#e5e7eb'} />
            <XAxis
              dataKey="date"
              tickFormatter={formatChartDate}
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              style={{ fontSize: '12px' }}
            />
            <YAxis
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              style={{ fontSize: '12px' }}
              tickFormatter={(value: number) => currency.format(value)}
            />
            <Area
              type="monotone"
              dataKey="revenue"
              stroke="#eab308"
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorRevenue)"
              animationDuration={1000}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: '8px',
                color: isDark ? '#ffffff' : '#000000',
              }}
              formatter={(value) => typeof value === 'number' || typeof value === 'string'
                ? [currency.format(Number(value)), 'Revenue']
                : undefined}
              labelFormatter={(value) => typeof value === 'string' || typeof value === 'number'
                ? formatChartDate(String(value))
                : ''}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartContainer>
  );
});

SalesTrendChart.displayName = 'SalesTrendChart';

interface TopItemsChartProps {
  data: TopItemData[];
  isDark: boolean;
  currency: Intl.NumberFormat;
}

export const TopItemsChart = memo<TopItemsChartProps>(({ data, isDark, currency }) => {
  const { t } = useTranslation();
  const COLORS = ['#eab308', '#10b981', '#f59e0b', '#ef4444', '#71717a'];

  return (
    <ChartContainer title={t('reports.sales.topItems')} isDark={isDark} delay={0.2}>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#374151' : '#e5e7eb'} />
            <XAxis
              type="number"
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              style={{ fontSize: '12px' }}
              tickFormatter={(value: number) => currency.format(value)}
            />
            <YAxis
              type="category"
              dataKey="name"
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              style={{ fontSize: '12px' }}
              width={120}
            />
            <Bar dataKey="revenue" fill="#eab308" radius={[0, 8, 8, 0]} animationDuration={1000}>
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Bar>
            <Tooltip
              contentStyle={{
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: '8px',
                color: isDark ? '#ffffff' : '#000000',
              }}
              formatter={(value) => typeof value === 'number' || typeof value === 'string'
                ? [currency.format(Number(value)), 'Revenue']
                : undefined}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartContainer>
  );
});

TopItemsChart.displayName = 'TopItemsChart';

interface HourlySalesChartProps {
  data: HourlySalesData[];
  isDark: boolean;
  currency: Intl.NumberFormat;
}

export const HourlySalesChart = memo<HourlySalesChartProps>(({ data, isDark, currency }) => {
  const { t } = useTranslation();
  // Filter to show only hours with activity
  const activeHours = data.filter(d => d.orders > 0 || d.revenue > 0);

  return (
    <ChartContainer title={t('reports.sales.salesByHour')} isDark={isDark} delay={0.3}>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={activeHours}>
            <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#374151' : '#e5e7eb'} />
            <XAxis
              dataKey="hour"
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              style={{ fontSize: '12px' }}
              tickFormatter={(value: number) => `${value}:00`}
            />
            <YAxis
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              style={{ fontSize: '12px' }}
              tickFormatter={(value: number) => currency.format(value)}
            />
            <Bar dataKey="revenue" fill="#eab308" radius={[8, 8, 0, 0]} animationDuration={1000} />
            <Tooltip
              contentStyle={{
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: '8px',
                color: isDark ? '#ffffff' : '#000000',
              }}
              formatter={(value, name) => typeof value === 'number' || typeof value === 'string' ? [
                name === 'revenue' ? currency.format(Number(value)) : value,
                name === 'revenue' ? 'Revenue' : 'Orders'
              ] : undefined}
              labelFormatter={(value) => `${value}:00`}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartContainer>
  );
});

HourlySalesChart.displayName = 'HourlySalesChart';

interface PaymentMethodChartProps {
  twintTotal?: number;
  otherTotal?: number;
  cashTotal: number;
  cardTotal: number;
  isDark: boolean;
  currency: Intl.NumberFormat;
}

export const PaymentMethodChart = memo<PaymentMethodChartProps>(({ cashTotal, cardTotal, twintTotal = 0, otherTotal = 0, isDark, currency }) => {
  const { t } = useTranslation();
  const data = [
    { name: 'Cash', value: cashTotal },
    { name: 'Card', value: cardTotal },
    ...(twintTotal !== 0 ? [{ name: 'TWINT', value: twintTotal }] : []),
    ...(otherTotal !== 0 ? [{ name: 'Other', value: otherTotal }] : []),
  ];

  const COLORS = ['#10b981', '#eab308', '#111827', '#94a3b8'];

  const total = cashTotal + cardTotal + twintTotal + otherTotal;

  return (
    <ChartContainer title={t('reports.payments.paymentMethods')} isDark={isDark} delay={0.4}>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={({ payload, percent }) => `${payload.name}: ${((percent ?? 0) * 100).toFixed(0)}%`}
              outerRadius={100}
              fill="#8884d8"
              dataKey="value"
              animationDuration={1000}
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: '8px',
                color: isDark ? '#ffffff' : '#000000',
              }}
              formatter={(value) => typeof value === 'number' || typeof value === 'string'
                ? currency.format(Number(value))
                : undefined}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className={`mt-4 text-center text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
          Total: {currency.format(total)}
        </div>
      </div>
    </ChartContainer>
  );
});

PaymentMethodChart.displayName = 'PaymentMethodChart';

interface OrderTypeChartProps {
  deliveryTotal: number;
  instoreTotal: number;
  isDark: boolean;
  currency: Intl.NumberFormat;
}

export const OrderTypeChart = memo<OrderTypeChartProps>(({ deliveryTotal, instoreTotal, isDark, currency }) => {
  const { t } = useTranslation();
  const data = [
    { name: 'Delivery', value: deliveryTotal },
    { name: 'In-Store', value: instoreTotal },
  ];

  const COLORS = ['#f59e0b', '#71717a'];

  const total = deliveryTotal + instoreTotal;

  return (
    <ChartContainer title={t('reports.orders.ordersByType')} isDark={isDark} delay={0.5}>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={({ payload, percent }) => `${payload.name}: ${((percent ?? 0) * 100).toFixed(0)}%`}
              outerRadius={100}
              fill="#8884d8"
              dataKey="value"
              animationDuration={1000}
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: '8px',
                color: isDark ? '#ffffff' : '#000000',
              }}
              formatter={(value) => typeof value === 'number' || typeof value === 'string'
                ? currency.format(Number(value))
                : undefined}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className={`mt-4 text-center text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
          Total: {currency.format(total)}
        </div>
      </div>
    </ChartContainer>
  );
});

OrderTypeChart.displayName = 'OrderTypeChart';

