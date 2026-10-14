import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  toCents,
  zReportDocumentFromSnapshot,
  zReportOrdersFromSnapshot,
} from '../../../../../shared/reports/z-report-document';
import {
  formatZReportAmount,
  serializeZReportCsv,
  serializeZReportOrdersCsv,
  zReportFileName,
  Z_REPORT_CSV_BOM,
} from '../../../../../shared/reports/z-report-export';
import { zReportLabel } from '../../../../../shared/reports/z-report-labels';
import type { ZReportData } from '../../types/reports';
import {
  exportArrayToCSV,
  exportProvisionalZReportCsv,
  exportProvisionalZReportOrdersCsv,
  exportStoredZReportCsv,
  exportStoredZReportOrdersCsv,
  readStoredZReport,
} from '../reportExport';
import {
  captureDownloads,
  goldenCase,
  goldenCases,
  parseCsv,
  storedRowFromGolden,
  type CapturedDownload,
  type GoldenZCase,
} from './zReportExportKit';

// Founder, 14/10/2026: "the Z export must be based on the Z's real data". The desktop export
// reads the stored z_reports row and writes it with the shared serializer, as Android and the
// admin do; the live preview exports only as "Provisional – not a Z".

let downloads: CapturedDownload[] = [];

beforeEach(() => {
  downloads = captureDownloads();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const desktopCases = goldenCases.filter((entry) => entry.shape === 'desktop');
/** The fixture's terminal name is this till's display name; the stored row itself has none. */
const optionsOf = (entry: GoldenZCase) =>
  typeof entry.columns?.terminalName === 'string' ? { terminalName: entry.columns.terminalName } : undefined;
const sharedDocument = (entry: GoldenZCase) =>
  zReportDocumentFromSnapshot({ data: entry.data, shape: 'desktop', columns: entry.columns });
const lastDownload = () => downloads[downloads.length - 1];

describe('stored Z export (desktop)', () => {
  it('has golden desktop cases to compare with', () => {
    expect(desktopCases.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['desktop-takeaway-chf', 'desktop-delivery-eur', 'desktop-server-copy-legacy']),
    );
  });

  for (const entry of desktopCases) {
    it(`${entry.name}: the file is the shared serializer's CSV of the stored row, in el, de and en`, () => {
      for (const language of ['el', 'de', 'en']) {
        const fileName = exportStoredZReportCsv(storedRowFromGolden(entry), language, optionsOf(entry));
        const download = lastDownload();
        expect(download.csv).toBe(serializeZReportCsv(sharedDocument(entry), { language }));
        expect(fileName).toBe(zReportFileName(sharedDocument(entry), { extension: 'csv' }));
        expect(download.fileName).toBe(fileName);
        expect(download.type).toBe('text/csv;charset=utf-8');
      }
    });

    it(`${entry.name}: the orders file is the Z's recorded order list`, () => {
      const document = sharedDocument(entry);
      const orders = zReportOrdersFromSnapshot({ data: entry.data, shape: 'desktop', columns: entry.columns });
      const fileName = exportStoredZReportOrdersCsv(storedRowFromGolden(entry), 'it', optionsOf(entry));
      expect(lastDownload().csv).toBe(serializeZReportOrdersCsv(orders, document, { language: 'it' }));
      expect(fileName).toBe(zReportFileName(document, { extension: 'csv', kind: 'orders' }));
      expect(fileName).toMatch(/^z-report-orders_/);
    });
  }

  it('starts with exactly one UTF-8 BOM and writes CRLF lines', () => {
    exportStoredZReportCsv(storedRowFromGolden(goldenCase('desktop-takeaway-chf')), 'el');
    const { csv } = lastDownload();
    expect(csv.startsWith(Z_REPORT_CSV_BOM)).toBe(true);
    expect(csv.split(Z_REPORT_CSV_BOM)).toHaveLength(2);
    const header = (['csv.section', 'csv.line', 'csv.value'] as const).map((key) => zReportLabel('el', key)).join(';');
    expect(csv.startsWith(`${Z_REPORT_CSV_BOM}${header}\r\n`)).toBe(true);
    expect(/[^\r]\n/.test(csv)).toBe(false);
  });

  it('names the file after the terminal and the closing time, Greek names kept readable', () => {
    const entry = goldenCase('desktop-delivery-eur');
    const fileName = exportStoredZReportCsv(storedRowFromGolden(entry), 'el', { terminalName: 'Ταμείο 1' });
    expect(fileName).toMatch(/^z-report_Ταμείο-1_\d{4}-\d{2}-\d{2}_\d{4}\.csv$/);
    // Without the till's display name the row's terminal id names the file; nothing is invented.
    expect(exportStoredZReportCsv(storedRowFromGolden(entry), 'el')).toMatch(/^z-report_terminal-ath-main_/);
  });

  it('exports the stored row\'s own figures in cents, never a recomputation', () => {
    const entry = goldenCase('desktop-takeaway-chf');
    const row = storedRowFromGolden(entry);
    exportStoredZReportCsv(row, 'el');
    const rows = parseCsv(lastDownload().csv, ';');
    type Key = Parameters<typeof zReportLabel>[1];
    const value = (section: Key, line: Key, count?: number) => {
      const lineText = count === undefined ? zReportLabel('el', line) : `${zReportLabel('el', line)} (${count})`;
      return rows.find((cells) => cells[0] === zReportLabel('el', section) && cells[1] === lineText)?.[2];
    };
    const plain = (amount: number) => formatZReportAmount(toCents(amount), 'plain', ',');
    expect(value('section.sales', 'sales.gross')).toBe(plain(row.grossSales));
    expect(value('section.sales', 'sales.net')).toBe(plain(row.netSales));
    // Gross - discounts - refunds = Net (one Net on both apps, 14/10/2026): the deductions show
    // as outflows, each the row's own figure.
    const outflow = (amount: number) => formatZReportAmount(toCents(amount), 'out', ',');
    expect(value('section.sales', 'sales.discounts')).toBe(outflow(row.discountsTotal));
    expect(value('section.sales', 'sales.refunds')).toBe(outflow(row.refundsTotal));
    expect(value('section.sales', 'sales.orders')).toBe(String(row.totalOrders));
    const counts = entry.data.paymentsBreakdown;
    expect(value('section.payments', 'payments.cash', counts.cash.count)).toBe(plain(row.cashSales));
    expect(value('section.payments', 'payments.card', counts.card.count)).toBe(plain(row.cardSales));
    const drawer = entry.data.cashDrawer;
    expect(value('section.cashDrawer', 'drawer.opening')).toBe(formatZReportAmount(drawer.openingTotal_cents, 'plain', ','));
    expect(value('section.cashDrawer', 'drawer.expected')).toBe(formatZReportAmount(drawer.expected_cents, 'plain', ','));
    expect(value('section.cashDrawer', 'drawer.counted')).toBe(formatZReportAmount(drawer.moneyInDrawer_cents, 'plain', ','));
    expect(value('section.cashDrawer', 'drawer.variance')).toBe(formatZReportAmount(drawer.totalVariance_cents, 'signed', ','));

    // The row's column is what the file says, as on the printed Z.
    exportStoredZReportCsv({ ...row, grossSales: 999.99 }, 'el');
    const changed = parseCsv(lastDownload().csv, ';');
    expect(changed.find((cells) => cells[1] === zReportLabel('el', 'sales.gross'))?.[2]).toBe('999,99');
  });

  it('keeps a value the Z did not record empty, and says so once', () => {
    exportStoredZReportCsv(storedRowFromGolden(goldenCase('desktop-server-copy-legacy')), 'en');
    const rows = parseCsv(lastDownload().csv, ',');
    expect(rows.find((cells) => cells[1] === 'Gross sales')).toEqual(['Sales', 'Gross sales', '']);
    expect(rows[rows.length - 1]).toEqual(['', zReportLabel('en', 'report.notRecorded'), '']);
  });

  it('reads an unreadable snapshot without throwing and keeps the row\'s own figures', () => {
    const row = storedRowFromGolden(goldenCase('desktop-takeaway-chf'), { reportJson: '{not json' });
    const view = readStoredZReport(row);
    expect(view.id).toBe('zr-desk-0001');
    expect(view.orders).toEqual([]);
    exportStoredZReportCsv(row, 'en');
    const rows = parseCsv(lastDownload().csv, ',');
    expect(rows.find((cells) => cells[1] === 'Gross sales')?.[2]).toBe('316.90');
  });

  it('flags an order list the Z cut short', () => {
    const entry = goldenCase('desktop-takeaway-chf');
    expect(readStoredZReport(storedRowFromGolden(entry)).ordersTruncated).toBe(false);
    const cut = { ...entry, data: { ...entry.data, dayOrdersTruncated: true } };
    expect(readStoredZReport(storedRowFromGolden(cut)).ordersTruncated).toBe(true);
  });
});

describe('provisional export of the live preview', () => {
  const liveOf = (entry: GoldenZCase): ZReportData => ({
    ...entry.data,
    terminalId: entry.columns?.terminalId,
    terminalName: entry.columns?.terminalName,
  }) as unknown as ZReportData;

  it('is marked "Provisional – not a Z" on its first line and in its file name, in every language', () => {
    const entry = goldenCase('desktop-delivery-eur');
    for (const language of ['el', 'en', 'de', 'fr', 'it', 'sq']) {
      const fileName = exportProvisionalZReportCsv(liveOf(entry), language);
      expect(fileName).toMatch(/^z-provisional_Ταμείο-1_\d{4}-\d{2}-\d{2}_\d{4}\.csv$/);
      const rows = parseCsv(lastDownload().csv, language === 'en' ? ',' : ';');
      expect(rows[1]).toEqual([
        zReportLabel(language, 'section.report'),
        zReportLabel(language, 'report.status'),
        zReportLabel(language, 'status.provisional'),
      ]);
      // A preview never carries a report id.
      expect(rows.some((cells) => cells[1] === zReportLabel(language, 'report.reportId'))).toBe(false);
    }
  });

  it('writes the preview\'s orders under a provisional file name', () => {
    const entry = goldenCase('desktop-delivery-eur');
    const fileName = exportProvisionalZReportOrdersCsv(liveOf(entry), 'el');
    expect(fileName).toMatch(/^z-provisional-orders_/);
    const orders = zReportOrdersFromSnapshot({ data: entry.data, shape: 'desktop' });
    expect(lastDownload().csv).toBe(serializeZReportOrdersCsv(orders, { currency: entry.data.currency }, { language: 'el' }));
    const rows = parseCsv(lastDownload().csv, ';');
    expect(rows[0][0]).toBe(zReportLabel('el', 'orders.source'));
    expect(rows).toHaveLength(1 + entry.data.dayOrders.length);
  });
});

describe('plain table export (Reports page)', () => {
  it('uses the same spreadsheet rules: BOM, separators of the language, quoting, formulas neutralized', () => {
    const fileName = exportArrayToCSV(
      [{ Ημερομηνία: '13/10/2026', Παραγγελίες: 3, Έσοδα: 16.860000000000003, Σημείωση: '=HYPERLINK("x")' }],
      'sales-report.csv',
      { language: 'el' },
    );
    expect(fileName).toBe('sales-report.csv');
    expect(lastDownload().csv).toBe(
      `${Z_REPORT_CSV_BOM}Ημερομηνία;Παραγγελίες;Έσοδα;Σημείωση\r\n13/10/2026;3;16,86;"'=HYPERLINK(""x"")"\r\n`,
    );
    expect(exportArrayToCSV([{ Date: '2026-10-13', Revenue: -2.5, Note: 'a, b' }], 'sales', { language: 'en' })).toBe('sales.csv');
    expect(lastDownload().csv).toBe(`${Z_REPORT_CSV_BOM}Date,Revenue,Note\r\n2026-10-13,-2.5,"a, b"\r\n`);
  });
});
