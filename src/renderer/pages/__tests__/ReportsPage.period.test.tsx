import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../locales/en.json';
import el from '../../../locales/el.json';
import de from '../../../locales/de.json';
import fr from '../../../locales/fr.json';
import itLocale from '../../../locales/it.json';
import sq from '../../../locales/sq.json';
import ReportsPage from '../ReportsPage';

const mocks = vi.hoisted(() => ({
  reports: {
    getTodayStatistics: vi.fn(), getSalesTrend: vi.fn(), getTopItems: vi.fn(),
    getHourlySales: vi.fn(), getPaymentMethodBreakdown: vi.fn(), getOrderTypeBreakdown: vi.fn(),
  },
  exportCSV: vi.fn(),
}));
vi.mock('../../../lib', () => ({ getBridge: () => mocks }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));
function translate(key: string) {
  return key.split('.').reduce<any>((node, part) => node?.[part], en) ?? key;
}
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('../../contexts/shift-context', () => ({ useShift: () => ({ staff: { branchId: 'branch-1' } }) }));
vi.mock('../../hooks/useEndOfDayStatus', () => ({
  useEndOfDayStatus: () => ({ endOfDayStatus: {}, isPendingLocalSubmit: false }),
}));
vi.mock('../../components/modals/ZReportModal', () => ({ default: () => null }));
vi.mock('../../utils/reportExport', () => ({ exportArrayToCSV: (...args: unknown[]) => mocks.exportCSV(...args) }));
vi.mock('../../utils/format', () => ({
  formatCurrency: (value: number) => `EUR ${value.toFixed(2)}`,
  formatDate: (value: string) => value,
}));
vi.mock('../../components/reports/ReportCharts', () => ({
  SalesTrendChart: () => <div data-testid="multi-day-trend" />,
  HourlySalesChart: ({ data }: { data: { hour: number; revenue: number }[] }) => (
    <div data-testid="hourly-sales">{data[0].hour}:00 EUR {data[0].revenue}</div>
  ),
  TopItemsChart: () => null, PaymentMethodChart: () => null, OrderTypeChart: () => null,
}));

beforeEach(() => {
  mocks.reports.getTodayStatistics.mockResolvedValue({ data: {
    totalOrders: 2, totalSales: 40, avgOrderValue: 20, completionRate: 100,
  } });
  mocks.reports.getSalesTrend.mockResolvedValue({ data: [
    { date: '2026-11-09', orders: 99, revenue: 999, avgOrderValue: 999 / 99 },
  ] });
  mocks.reports.getTopItems.mockResolvedValue({ data: [] });
  mocks.reports.getHourlySales.mockResolvedValue({ data: [{ hour: 9, orders: 2, revenue: 40 }] });
  mocks.reports.getPaymentMethodBreakdown.mockResolvedValue(null);
  mocks.reports.getOrderTypeBreakdown.mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Reports open business day', () => {
  it('shows one since-last-Z period without calendar period choices', async () => {
    render(<ReportsPage />);
    await screen.findByText('EUR 40.00');
    expect(screen.getByText('Since the last Z')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    for (const label of ['Today', 'This Week', 'This Month', 'This Quarter']) {
      expect(screen.queryByRole('option', { name: label })).not.toBeInTheDocument();
    }
  });

  it('keeps figures on the undated today path, which native code resolves from the last Z', async () => {
    render(<ReportsPage />);
    await screen.findByText('EUR 40.00');
    expect(mocks.reports.getTodayStatistics).toHaveBeenCalledWith({ branchId: 'branch-1' });
    expect(mocks.reports.getTopItems).toHaveBeenCalledWith({ branchId: 'branch-1', limit: 5 });
    for (const method of ['getHourlySales', 'getPaymentMethodBreakdown', 'getOrderTypeBreakdown'] as const) {
      expect(mocks.reports[method]).toHaveBeenCalledWith({ branchId: 'branch-1' });
    }
  });

  it('shows the open day by hour without fetching a multi-day trend', async () => {
    render(<ReportsPage />);
    await screen.findByText('EUR 40.00');
    await waitFor(() => expect(screen.getByTestId('hourly-sales')).toHaveTextContent('9:00 EUR 40'));
    expect(screen.queryByTestId('multi-day-trend')).not.toBeInTheDocument();
    expect(mocks.reports.getSalesTrend).not.toHaveBeenCalled();
  });

  it('exports the same open-day figures as the page', async () => {
    render(<ReportsPage />);
    await screen.findByText('EUR 40.00');
    fireEvent.click(screen.getByRole('button', { name: en.reports.actions.exportCSV }));
    expect(mocks.exportCSV).toHaveBeenCalledWith([{
      [en.reports.table.date]: 'Since the last Z',
      [en.reports.table.orders]: 2,
      [en.reports.table.revenue]: 40,
      [en.reports.table.avgOrder]: 20,
    }], 'sales-report.csv');
  });

  it.each([
    ['en', en, 'Since the last Z'], ['el', el, 'Από το τελευταίο Z'],
    ['de', de, 'Seit dem letzten Z'], ['fr', fr, 'Depuis le dernier Z'],
    ['it', itLocale, "Dall'ultimo Z"], ['sq', sq, 'Që nga Z-ja e fundit'],
  ])('has the intact %s label', (_language, locale, label) => {
    expect((locale as typeof en).reports.period).toHaveProperty('sinceLastZ', label);
  });
});
