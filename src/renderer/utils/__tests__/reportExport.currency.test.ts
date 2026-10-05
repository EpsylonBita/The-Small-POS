import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZReportData, ZReportDayOrder } from '../../types/reports';
import { exportDayOrdersToCSV, exportZReportToCSV } from '../reportExport';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function captureExport(action: () => void): string {
  let csv = '';
  vi.stubGlobal('Blob', class { constructor(parts: string[]) { csv = parts.join(''); } });
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:report'), configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  action();
  return csv;
}

function report(currency?: string | null): ZReportData {
  return {
    currency,
    date: '2026-10-04',
    shifts: { total: 1, cashier: 1, driver: 0 },
    sales: { totalOrders: 1, totalSales: 10, cashSales: 10, cardSales: 0 },
    cashDrawer: { totalVariance: 0, totalCashDrops: 0, unreconciledCount: 0 },
    expenses: { total: 0, pendingCount: 0, items: [] },
    driverEarnings: { totalDeliveries: 0, totalEarnings: 0, unsettledCount: 0 },
  } as ZReportData;
}

describe('original currency in financial CSV exports', () => {
  it.each([['CHF', 'CHF'], [null, 'Unknown'], [undefined, 'Unknown']])(
    'exports recorded report currency %s without inferring a present unit', (currency, expected) => {
      expect(captureExport(() => exportZReportToCSV(report(currency))))
        .toContain(`"Report","Currency","${expected}"`);
    },
  );

  it('keeps each order original unit and leaves legacy orders explicitly unknown', () => {
    const orders = [
      { id: 'a', orderNumber: 'A', orderType: 'pickup', amount: 10, currency: 'CHF', status: 'completed', createdAt: '2026-10-04' },
      { id: 'b', orderNumber: 'B', orderType: 'pickup', amount: 20, currency: null, status: 'completed', createdAt: '2026-10-04' },
    ] as ZReportDayOrder[];
    const csv = captureExport(() => exportDayOrdersToCSV(orders));
    expect(csv).toContain('Amount,Currency,Payment Method');
    expect(csv).toContain('10,"CHF"');
    expect(csv).toContain('20,"Unknown"');
  });
});
