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
  Legend,
} from 'recharts';
import { motion } from 'framer-motion';
import { formatDate as formatDateValue } from '../../utils/format';
import type { SalesTrendData, TopItemData, HourlySalesData } from '../../types/reports';

// Type workarounds for Recharts + React 19
const ResponsiveContainerC: any = ResponsiveContainer as any;
const AreaChartC: any = AreaChart as any;
const BarChartC: any = BarChart as any;
const PieChartC: any = PieChart as any;
const CartesianGridC: any = CartesianGrid as any;
const XAxisC: any = XAxis as any;
const YAxisC: any = YAxis as any;
const TooltipC: any = Tooltip as any;
const AreaC: any = Area as any;
const BarC: any = Bar as any;
const PieC: any = Pie as any;
const CellC: any = Cell as any;
const LegendC: any = Legend as any;

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
        <ResponsiveContainerC width="100%" height="100%">
          <AreaChartC data={data}>
            <defs>
              <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGridC strokeDasharray="3 3" stroke={isDark ? '#374151' : '#e5e7eb'} />
            <XAxisC
              dataKey="date"
              tickFormatter={formatChartDate}
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              style={{ fontSize: '12px' }}
            />
            <YAxisC
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              style={{ fontSize: '12px' }}
              tickFormatter={(value: number) => currency.format(value)}
            />
            <TooltipC
              contentStyle={{
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: '8px',
                color: isDark ? '#ffffff' : '#000000',
              }}
              formatter={(value: number) => [currency.format(value), 'Revenue']}
              labelFormatter={formatChartDate}
            />
            <AreaC
              type="monotone"
              dataKey="revenue"
              stroke="#3b82f6"
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorRevenue)"
              animationDuration={1000}
            />
          </AreaChartC>
        </ResponsiveContainerC>
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
  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

  return (
    <ChartContainer title={t('reports.sales.topItems')} isDark={isDark} delay={0.2}>
      <div className="h-80">
        <ResponsiveContainerC width="100%" height="100%">
          <BarChartC data={data} layout="vertical">
            <CartesianGridC strokeDasharray="3 3" stroke={isDark ? '#374151' : '#e5e7eb'} />
            <XAxisC
              type="number"
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              style={{ fontSize: '12px' }}
              tickFormatter={(value: number) => currency.format(value)}
            />
            <YAxisC
              type="category"
              dataKey="name"
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              style={{ fontSize: '12px' }}
              width={120}
            />
            <TooltipC
              contentStyle={{
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: '8px',
                color: isDark ? '#ffffff' : '#000000',
              }}
              formatter={(value: number) => [currency.format(value), 'Revenue']}
            />
            <BarC dataKey="revenue" fill="#3b82f6" radius={[0, 8, 8, 0]} animationDuration={1000}>
              {data.map((entry, index) => (
                <CellC key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </BarC>
          </BarChartC>
        </ResponsiveContainerC>
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
        <ResponsiveContainerC width="100%" height="100%">
          <BarChartC data={activeHours}>
            <CartesianGridC strokeDasharray="3 3" stroke={isDark ? '#374151' : '#e5e7eb'} />
            <XAxisC
              dataKey="hour"
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              style={{ fontSize: '12px' }}
              tickFormatter={(value: number) => `${value}:00`}
            />
            <YAxisC
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              style={{ fontSize: '12px' }}
              tickFormatter={(value: number) => currency.format(value)}
            />
            <TooltipC
              contentStyle={{
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: '8px',
                color: isDark ? '#ffffff' : '#000000',
              }}
              formatter={(value: number, name: string) => [
                name === 'revenue' ? currency.format(value) : value,
                name === 'revenue' ? 'Revenue' : 'Orders'
              ]}
              labelFormatter={(value: number) => `${value}:00`}
            />
            <BarC dataKey="revenue" fill="#3b82f6" radius={[8, 8, 0, 0]} animationDuration={1000} />
          </BarChartC>
        </ResponsiveContainerC>
      </div>
    </ChartContainer>
  );
});

HourlySalesChart.displayName = 'HourlySalesChart';

interface PaymentMethodChartProps {
  cashTotal: number;
  cardTotal: number;
  isDark: boolean;
  currency: Intl.NumberFormat;
}

export const PaymentMethodChart = memo<PaymentMethodChartProps>(({ cashTotal, cardTotal, isDark, currency }) => {
  const { t } = useTranslation();
  const data = [
    { name: 'Cash', value: cashTotal },
    { name: 'Card', value: cardTotal },
  ];

  const COLORS = ['#10b981', '#3b82f6'];

  const total = cashTotal + cardTotal;

  return (
    <ChartContainer title={t('reports.payments.paymentMethods')} isDark={isDark} delay={0.4}>
      <div className="h-80">
        <ResponsiveContainerC width="100%" height="100%">
          <PieChartC>
            <PieC
              data={data}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={({ name, percent }: { name: string; percent: number }) => `${name}: ${(percent * 100).toFixed(0)}%`}
              outerRadius={100}
              fill="#8884d8"
              dataKey="value"
              animationDuration={1000}
            >
              {data.map((entry, index) => (
                <CellC key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </PieC>
            <TooltipC
              contentStyle={{
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: '8px',
                color: isDark ? '#ffffff' : '#000000',
              }}
              formatter={(value: number) => currency.format(value)}
            />
          </PieChartC>
        </ResponsiveContainerC>
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

  const COLORS = ['#f59e0b', '#8b5cf6'];

  const total = deliveryTotal + instoreTotal;

  return (
    <ChartContainer title={t('reports.orders.ordersByType')} isDark={isDark} delay={0.5}>
      <div className="h-80">
        <ResponsiveContainerC width="100%" height="100%">
          <PieChartC>
            <PieC
              data={data}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={({ name, percent }: { name: string; percent: number }) => `${name}: ${(percent * 100).toFixed(0)}%`}
              outerRadius={100}
              fill="#8884d8"
              dataKey="value"
              animationDuration={1000}
            >
              {data.map((entry, index) => (
                <CellC key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </PieC>
            <TooltipC
              contentStyle={{
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: '8px',
                color: isDark ? '#ffffff' : '#000000',
              }}
              formatter={(value: number) => currency.format(value)}
            />
          </PieChartC>
        </ResponsiveContainerC>
        <div className={`mt-4 text-center text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
          Total: {currency.format(total)}
        </div>
      </div>
    </ChartContainer>
  );
});

OrderTypeChart.displayName = 'OrderTypeChart';

