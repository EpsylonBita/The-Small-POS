import React, { type ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HourlySalesChart, OrderTypeChart, PaymentMethodChart, SalesTrendChart, TopItemsChart,
} from '../ReportCharts';

// Supply layout dimensions; keep the installed Recharts rendering and label contracts.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <actual.ResponsiveContainer width={640} height={320}>{children}</actual.ResponsiveContainer>
    ),
  };
});
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
// Render the final chart state without waiting for browser animation frames.
beforeEach(() => vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
  matches: query === '(prefers-reduced-motion: reduce)', media: query, onchange: null,
  addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
}))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

describe('Recharts 3 report charts', () => {
  it('renders payment names and rounded shares, including optional tenders', async () => {
    const { container } = render(
      <PaymentMethodChart cashTotal={40} cardTotal={30} twintTotal={20} otherTotal={10} isDark={false} currency={currency} />,
    );
    await waitFor(() => {
      expect(screen.getByText('Cash: 40%')).toBeInTheDocument();
      expect(screen.getByText('Card: 30%')).toBeInTheDocument();
      expect(screen.getByText('TWINT: 20%')).toBeInTheDocument();
      expect(screen.getByText('Other: 10%')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText('Total: $100.00')).toBeInTheDocument();
    expect(container.querySelector('svg[role="application"][tabindex="0"]')).not.toBeNull();
  });

  it('renders order type labels from the original entries', async () => {
    render(<OrderTypeChart deliveryTotal={25} instoreTotal={75} isDark currency={currency} />);
    await waitFor(() => {
      expect(screen.getByText('Delivery: 25%')).toBeInTheDocument();
      expect(screen.getByText('In-Store: 75%')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('renders the trend, top items and active hourly sales with real chart types', () => {
    const { container } = render(<>
      <SalesTrendChart data={[{ date: '2026-10-27', revenue: 100, orders: 4, avgOrderValue: 25 }]} isDark={false} currency={currency} />
      <TopItemsChart data={[{ name: 'Coffee', quantity: 4, revenue: 100 }]} isDark={false} currency={currency} />
      <HourlySalesChart data={[{ hour: 0, orders: 0, revenue: 0 }, { hour: 12, orders: 4, revenue: 100 }]} isDark currency={currency} />
    </>);
    expect(screen.getByText('Coffee')).toBeInTheDocument();
    expect(screen.getAllByText('12:00').length).toBeGreaterThan(0);
    expect(screen.queryByText('0:00')).not.toBeInTheDocument();
    expect(container.querySelectorAll('svg[role="application"][tabindex="0"]')).toHaveLength(3);
    expect(container.querySelectorAll('.recharts-cartesian-grid-horizontal line').length).toBeGreaterThan(0);
  });
});
