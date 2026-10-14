/**
 * CSV exports of the till.
 *
 * A Z export is made from the STORED Z only (founder, 14/10/2026: "the Z export must be based on the Z's real
 * data"): the `z_reports` row (`zreport_list` / `zreport_get`) with its frozen `report_json`, read and written by
 * `shared/reports`, the same document Android and the admin export. Nothing here recomputes a figure. The live
 * preview of a day that is still open can be exported too, but only marked "Provisional – not a Z": on its first
 * line and in its file name (`z-provisional_...`).
 *
 * Every file is written for spreadsheets: UTF-8 with a BOM, CRLF, RFC 4180 quoting, formula-like text
 * neutralized, and `;` with decimal commas wherever the app language writes decimal commas.
 */
import i18next from 'i18next';
import type { StoredZReportRow } from '../../lib/ipc-contracts';
import type { ZReportData } from '../types/reports';
import {
  desktopZReportColumns,
  zReportDocumentFromSnapshot,
  zReportOrdersFromSnapshot,
  type ZReportColumns,
  type ZReportDocument,
  type ZReportOrderLine,
  type ZReportSnapshotInput,
} from '../../../../shared/reports/z-report-document';
import {
  serializeZReportCsv,
  serializeZReportOrdersCsv,
  zReportCsvCell,
  zReportCsvDelimiter,
  zReportDecimalSeparator,
  zReportFileName,
  Z_REPORT_CSV_BOM,
} from '../../../../shared/reports/z-report-export';

export interface StoredZReportExportOptions {
  /**
   * This till's display name, for its own Zs: a stored row carries only the terminal id, and the printed Z
   * shows the till's display name the same way. Never replaces a name the row recorded.
   */
  terminalName?: string | null;
}

/** One Z read once: its document, the order list it recorded and whether that list was cut short. */
export interface ZReportExportView {
  document: ZReportDocument;
  orders: ZReportOrderLine[];
  /** The Z recorded only its first orders (the builder keeps at most 1000). */
  ordersTruncated: boolean;
}

export interface StoredZReportView extends ZReportExportView {
  id: string;
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `report_json` is JSON text; parsed once here, the shared reader takes the object. */
function parseSnapshot(reportJson: unknown): unknown {
  if (typeof reportJson !== 'string') return reportJson;
  try {
    return JSON.parse(reportJson);
  } catch {
    // Unreadable text stays as received: the reader then keeps only the row's own columns.
    return reportJson;
  }
}

function ordersWereTruncated(snapshot: unknown): boolean {
  if (!isRecord(snapshot)) return false;
  if (Array.isArray(snapshot.dayOrders)) return snapshot.dayOrdersTruncated === true;
  // Reports persisted before 1.4.97 keep one order list per staff shift.
  return Array.isArray(snapshot.staffReports)
    && snapshot.staffReports.some((staff) => isRecord(staff) && staff.ordersTruncated === true);
}

function storedColumns(row: StoredZReportRow, options: StoredZReportExportOptions = {}): ZReportColumns {
  const columns = desktopZReportColumns(row);
  const terminalName = typeof options.terminalName === 'string' ? options.terminalName.trim() : '';
  return terminalName && !columns.terminalName ? { ...columns, terminalName } : columns;
}

function readView(input: ZReportSnapshotInput, provisional: boolean): ZReportExportView {
  return {
    document: zReportDocumentFromSnapshot(input, { provisional }),
    orders: zReportOrdersFromSnapshot(input),
    ordersTruncated: ordersWereTruncated(input.data),
  };
}

/** A stored Z: the row's columns and its frozen snapshot, exactly as the till saved them. */
export function readStoredZReport(row: StoredZReportRow, options?: StoredZReportExportOptions): StoredZReportView {
  const view = readView(
    { data: parseSnapshot(row.reportJson), shape: 'desktop', columns: storedColumns(row, options) },
    false,
  );
  return { id: row.id, ...view };
}

/** The live preview of the open day: provisional, never a Z. */
export function readProvisionalZReport(liveReport: ZReportData): ZReportExportView {
  return readView({ data: liveReport, shape: 'desktop', columns: desktopZReportColumns(liveReport) }, true);
}

/**
 * Hand the file to the webview's download. The shared serializer already wrote the BOM; nothing is added.
 * Returns the file name.
 */
function downloadCsvFile(csv: string, fileName: string): string {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  // Released after the click has handed the blob to the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return fileName;
}

function exportReportCsv(view: ZReportExportView, language: string | null | undefined): string {
  return downloadCsvFile(
    serializeZReportCsv(view.document, { language }),
    zReportFileName(view.document, { extension: 'csv' }),
  );
}

function exportOrdersCsv(view: ZReportExportView, language: string | null | undefined): string {
  return downloadCsvFile(
    serializeZReportOrdersCsv(view.orders, view.document, { language }),
    zReportFileName(view.document, { extension: 'csv', kind: 'orders' }),
  );
}

/** The stored Z as CSV, in the app language. Returns the file name (`z-report_<terminal>_<closing time>.csv`). */
export function exportStoredZReportCsv(
  row: StoredZReportRow,
  language: string | null | undefined,
  options?: StoredZReportExportOptions,
): string {
  return exportReportCsv(readStoredZReport(row, options), language);
}

/** The order list the stored Z recorded, as CSV. Returns the file name (`z-report-orders_...`). */
export function exportStoredZReportOrdersCsv(
  row: StoredZReportRow,
  language: string | null | undefined,
  options?: StoredZReportExportOptions,
): string {
  return exportOrdersCsv(readStoredZReport(row, options), language);
}

/** The live preview as CSV, marked provisional (`z-provisional_...`, "Provisional – not a Z" on its first line). */
export function exportProvisionalZReportCsv(liveReport: ZReportData, language: string | null | undefined): string {
  return exportReportCsv(readProvisionalZReport(liveReport), language);
}

/** The live preview's orders as CSV, marked provisional in the file name (`z-provisional-orders_...`). */
export function exportProvisionalZReportOrdersCsv(
  liveReport: ZReportData,
  language: string | null | undefined,
): string {
  return exportOrdersCsv(readProvisionalZReport(liveReport), language);
}

function plainCellText(value: unknown, decimal: ',' | '.'): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    // Float noise (16.860000000000003) is dropped; the language's decimal separator is used.
    const text = String(Number(value.toFixed(10)));
    return decimal === ',' ? text.replace('.', ',') : text;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  return JSON.stringify(value) ?? '';
}

/**
 * A plain table as CSV (the Reports page), with the same spreadsheet rules as the Z export. Without a language
 * the app's current language decides the separators. Returns the file name.
 */
export function exportArrayToCSV(
  data: Record<string, unknown>[],
  filename: string,
  options: { language?: string | null } = {},
): string {
  const decimal = zReportDecimalSeparator(options.language ?? i18next.language);
  const delimiter = zReportCsvDelimiter(decimal);
  const rows = Array.isArray(data) ? data.filter(isRecord) : [];
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const cell = (value: unknown) => zReportCsvCell(plainCellText(value, decimal), delimiter);
  const lines = headers.length > 0
    ? [headers.map(cell), ...rows.map((row) => headers.map((header) => cell(row[header])))]
    : [];
  const csv = Z_REPORT_CSV_BOM + lines.map((line) => line.join(delimiter)).map((line) => `${line}\r\n`).join('');
  return downloadCsvFile(csv, /\.csv$/i.test(filename) ? filename : `${filename}.csv`);
}
