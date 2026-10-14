import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zReportLabel } from '../../../../../shared/reports/z-report-labels';
import type { ZReportData, ZReportDayOrder } from '../../types/reports';
import { exportProvisionalZReportCsv, exportProvisionalZReportOrdersCsv } from '../reportExport';
import { captureDownloads, parseCsv, type CapturedDownload } from './zReportExportKit';

let downloads: CapturedDownload[] = [];

beforeEach(() => {
  downloads = captureDownloads();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const lastRows = () => parseCsv(downloads[downloads.length - 1].csv, ',');

function report(currency?: string | null, dayOrders?: ZReportDayOrder[]): ZReportData {
  return {
    currency,
    date: '2026-10-04',
    shifts: { total: 1, cashier: 1, driver: 0 },
    sales: { totalOrders: 1, totalSales: 10, cashSales: 10, cardSales: 0 },
    cashDrawer: { totalVariance: 0, totalCashDrops: 0, unreconciledCount: 0 },
    expenses: { total: 0, pendingCount: 0, items: [] },
    driverEarnings: { totalDeliveries: 0, totalEarnings: 0, unsettledCount: 0 },
    ...(dayOrders ? { dayOrders } : {}),
  } as ZReportData;
}

describe('original currency in financial CSV exports', () => {
  it.each([['CHF', 'CHF'], [null, ''], [undefined, '']])(
    'exports recorded report currency %s without inferring a present unit', (currency, expected) => {
      exportProvisionalZReportCsv(report(currency), 'en');
      const rows = lastRows();
      // An unrecorded unit stays an empty cell, explained once at the end of the file.
      expect(rows).toContainEqual(['Z report', 'Currency', expected]);
      expect(rows[rows.length - 1]).toEqual(['', zReportLabel('en', 'report.notRecorded'), '']);
      expect(rows.some((cells) => cells.includes('Unknown') || cells.includes('EUR'))).toBe(false);
    },
  );

  it('keeps each order original unit; an order without one shows the Z unit, never an invented one', () => {
    const orders = [
      { id: 'a', orderNumber: 'A', orderType: 'pickup', amount: 10, currency: 'CHF', status: 'completed', createdAt: '2026-10-04T08:00:00Z' },
      { id: 'b', orderNumber: 'B', orderType: 'pickup', amount: 20, currency: null, status: 'completed', createdAt: '2026-10-04T09:00:00Z' },
    ] as ZReportDayOrder[];
    exportProvisionalZReportOrdersCsv(report('EUR', orders), 'en');
    expect(lastRows().map((cells) => [cells[1], cells[4], cells[5]])).toEqual([
      ['Order number', 'Amount', 'Currency'],
      ['A', '10.00', 'CHF'],
      ['B', '20.00', 'EUR'],
    ]);
    exportProvisionalZReportOrdersCsv(report(null, orders), 'en');
    expect(lastRows().slice(1).map((cells) => cells[5])).toEqual(['CHF', '']);
  });
});
