/**
 * Test helpers for the Z export: stored `z_reports` rows built from the shared golden snapshots, a
 * capture of the files the till hands to the download, and an RFC 4180 reader.
 */
import { vi } from 'vitest';
import golden from '../../../../../shared/reports/__fixtures__/z-report-golden.json';
import { Z_REPORT_CSV_BOM } from '../../../../../shared/reports/z-report-export';
import type { StoredZReportRow } from '../../../lib/ipc-contracts';

export interface GoldenZCase {
  name: string;
  shape: 'desktop' | 'android';
  columns: Record<string, unknown> | null;
  data: Record<string, any>;
}

export const goldenCases = (golden as unknown as { cases: GoldenZCase[] }).cases;

export function goldenCase(name: string): GoldenZCase {
  const entry = goldenCases.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`missing golden case ${name}`);
  return entry;
}

const MONEY_COLUMNS = [
  'grossSales', 'netSales', 'totalOrders', 'cashSales', 'cardSales', 'refundsTotal', 'voidsTotal',
  'discountsTotal', 'tipsTotal', 'expensesTotal', 'cashVariance', 'openingCash', 'closingCash', 'expectedCash',
] as const;

/**
 * The row native `map_z_report_row` returns for a golden desktop Z: its columns, its snapshot as JSON text.
 * A stored row never carries the terminal's display name; the fixture's one goes through the export options.
 */
export function storedRowFromGolden(entry: GoldenZCase, patch: Partial<StoredZReportRow> = {}): StoredZReportRow {
  const columns = entry.columns ?? {};
  const row: Record<string, unknown> = {
    id: columns.reportId,
    shiftId: `shift-of-${String(columns.reportId)}`,
    branchId: columns.branchId,
    terminalId: columns.terminalId,
    reportDate: columns.reportDate,
    generatedAt: columns.generatedAt,
    paymentsBreakdown: '{}',
    reportJson: JSON.stringify(entry.data),
    currency: typeof entry.data.currency === 'string' ? entry.data.currency : null,
    syncState: 'applied',
    createdAt: columns.generatedAt,
    updatedAt: columns.generatedAt,
  };
  for (const key of MONEY_COLUMNS) {
    if (typeof columns[key] === 'number') row[key] = columns[key];
  }
  return { ...(row as unknown as StoredZReportRow), ...patch };
}

export interface CapturedDownload {
  fileName: string;
  csv: string;
  type: string;
}

/** Captures every file the till hands to the download (Blob + object URL + anchor click). */
export function captureDownloads(): CapturedDownload[] {
  const downloads: CapturedDownload[] = [];
  const blobs = new Map<string, { csv: string; type: string }>();
  let counter = 0;
  vi.stubGlobal('Blob', class {
    readonly text: string;
    readonly type: string;
    constructor(parts: unknown[], options?: { type?: string }) {
      this.text = parts.map(String).join('');
      this.type = options?.type ?? '';
    }
  });
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn((blob: { text: string; type: string }) => {
      counter += 1;
      const url = `blob:z-export-${counter}`;
      blobs.set(url, { csv: blob.text, type: blob.type });
      return url;
    }),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.getAttribute('href') ?? '');
    downloads.push({ fileName: this.download, csv: blob?.csv ?? '', type: blob?.type ?? '' });
  });
  return downloads;
}

/** RFC 4180 rows of a CSV written by the shared serializer (BOM first, CRLF lines). */
export function parseCsv(csv: string, delimiter: string): string[][] {
  if (!csv.startsWith(Z_REPORT_CSV_BOM)) throw new Error('the CSV must start with its UTF-8 BOM');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = csv.slice(Z_REPORT_CSV_BOM.length);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && body[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else cell += char;
  }
  return rows;
}
