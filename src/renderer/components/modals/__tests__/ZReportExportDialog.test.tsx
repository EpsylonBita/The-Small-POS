import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toCents, zReportDocumentFromSnapshot } from '../../../../../../shared/reports/z-report-document';
import { formatZReportAmount, serializeZReportCsv, zReportFileName } from '../../../../../../shared/reports/z-report-export';
import { zReportLabel } from '../../../../../../shared/reports/z-report-labels';
import type { StoredZReportRow } from '../../../../lib/ipc-contracts';
import type { ZReportData } from '../../../types/reports';
import { formatCurrency, formatTime } from '../../../utils/format';
import {
  captureDownloads,
  goldenCase,
  parseCsv,
  storedRowFromGolden,
  type CapturedDownload,
} from '../../../utils/__tests__/zReportExportKit';

const mocks = vi.hoisted(() => {
  // Keys stay readable in assertions; interpolated values follow the key.
  const translate = (key: string, options?: unknown): string => {
    const params = options && typeof options === 'object'
      ? Object.entries(options as Record<string, unknown>)
        .filter(([name]) => name !== 'defaultValue')
        .map(([name, value]) => `${name}=${String(value)}`)
      : [];
    return params.length ? `${key} ${params.join(' ')}` : key;
  };
  return {
    translate,
    bridge: {
      reports: {
        listZReports: vi.fn(),
        getZReport: vi.fn(),
      },
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate, i18n: { language: 'el', changeLanguage: vi.fn() } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
  Trans: ({ children }: { children?: unknown }) => children,
}));

vi.mock('../../../../lib', () => ({
  getBridge: () => mocks.bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}));

vi.mock('../../../contexts/i18n-context', () => ({
  useI18n: () => ({ language: 'el', setLanguage: vi.fn(), t: mocks.translate }),
}));

vi.mock('../../../hooks/useBlockerRegistration', () => ({ useBlockerRegistration: () => undefined }));

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light', theme: 'light' }),
}));

import ZReportExportDialog from '../ZReportExportDialog';

// Golden Zs: zr-desk-0001 (terminal-zh-01, made 13/10 18:31Z) is newer than zr-desk-0002
// (terminal-ath-main, made 13/10 00:42Z).
const takeaway = goldenCase('desktop-takeaway-chf');
const delivery = goldenCase('desktop-delivery-eur');
const rowTakeaway = storedRowFromGolden(takeaway);
const rowDelivery = storedRowFromGolden(delivery);
/** The open day's live preview on the Athens till: no stored id. */
const livePreview = { ...delivery.data, terminalId: 'terminal-ath-main', terminalName: 'Ταμείο 1' } as unknown as ZReportData;
/** The window showing the stored Z zr-desk-0002. */
const shownStored = { ...livePreview, zReportId: 'zr-desk-0002' } as ZReportData;

let downloads: CapturedDownload[] = [];

function serveList(rows: StoredZReportRow[]) {
  mocks.bridge.reports.listZReports.mockResolvedValue({ success: true, reports: rows, count: rows.length });
}

function serveRowsById(rows: StoredZReportRow[]) {
  mocks.bridge.reports.getZReport.mockImplementation(async ({ zReportId }: { zReportId: string }) => {
    const row = rows.find((candidate) => candidate.id === zReportId);
    if (!row) throw `Z-report not found: ${zReportId}`;
    return { success: true, report: row };
  });
}

const renderDialog = (props: Partial<React.ComponentProps<typeof ZReportExportDialog>> = {}) =>
  render(<ZReportExportDialog isOpen onClose={vi.fn()} shownReport={null} {...props} />);
const exportButton = (name: string) => screen.getByRole('button', { name: `modals.zReport.exportDialog.${name}` });
const checkedRow = () => screen.getByRole('radio', { checked: true });
const provisionalSection = () => document.querySelector<HTMLElement>('[data-z-report-export-provisional]');

beforeEach(() => {
  mocks.bridge.reports.listZReports.mockReset();
  mocks.bridge.reports.getZReport.mockReset();
  downloads = captureDownloads();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ZReportExportDialog', () => {
  it('lists the stored Zs newest first with terminal, period, and the Z\'s own gross and variance', async () => {
    serveList([rowDelivery, rowTakeaway]);
    renderDialog({ shownReport: livePreview });

    const rows = await screen.findAllByRole('radio');
    expect(rows.map((row) => row.getAttribute('data-z-report-id'))).toEqual(['zr-desk-0001', 'zr-desk-0002']);
    // This till's own Z shows its display name; another terminal's Z keeps its id.
    expect(within(rows[1]).getByText('Ταμείο 1')).toBeInTheDocument();
    expect(within(rows[0]).getByText('terminal-zh-01')).toBeInTheDocument();
    // The Z's own gross (row column) and drawer variance (frozen snapshot). The DOM text is
    // whitespace-normalized; a currency code is followed by a no-break space.
    const money = (cents: number, currency: string) => formatCurrency(cents / 100, currency).replace(/\s+/g, ' ');
    const variance = (cents: number, currency: string) => (cents > 0 ? `+${money(cents, currency)}` : money(cents, currency));
    expect(within(rows[1]).getByText(money(toCents(rowDelivery.grossSales), 'EUR'))).toBeInTheDocument();
    expect(within(rows[1]).getByText(variance(delivery.data.cashDrawer.totalVariance_cents, 'EUR'))).toBeInTheDocument();
    expect(within(rows[0]).getByText(money(toCents(rowTakeaway.grossSales), 'CHF'))).toBeInTheDocument();
    expect(within(rows[0]).getByText(variance(takeaway.data.cashDrawer.totalVariance_cents, 'CHF'))).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent(formatTime(takeaway.data.periodEnd, { hour: '2-digit', minute: '2-digit' }));
    // A live preview preselects nothing: the operator picks the stored Z.
    expect(rows.every((row) => row.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(screen.getByText('modals.zReport.exportDialog.previewEmpty')).toBeInTheDocument();
    expect(exportButton('exportReport')).toBeDisabled();
    expect(exportButton('exportOrders')).toBeDisabled();
  });

  it('preselects the stored Z the window shows, previews it and exports it read again by its id', async () => {
    serveList([rowTakeaway, rowDelivery]);
    serveRowsById([rowTakeaway, rowDelivery]);
    renderDialog({ shownReport: shownStored });

    await waitFor(() => expect(checkedRow()).toHaveAttribute('data-z-report-id', 'zr-desk-0002'));
    expect(within(checkedRow()).getByText('modals.zReport.exportDialog.shownNow')).toBeInTheDocument();
    // The preview shows what the file will hold, in the app language.
    const preview = document.querySelector<HTMLElement>('[data-z-report-export-preview]') as HTMLElement;
    expect(within(preview).getByText(zReportLabel('el', 'sales.gross')).closest('tr'))
      .toHaveTextContent(formatZReportAmount(toCents(rowDelivery.grossSales), 'plain', ','));
    expect(within(preview).getAllByText(zReportLabel('el', 'drawer.variance'))[0].closest('tr'))
      .toHaveTextContent(formatZReportAmount(delivery.data.cashDrawer.totalVariance_cents, 'signed', ','));
    // A stored Z is never offered as a provisional preview.
    expect(provisionalSection()).toBeNull();

    fireEvent.click(exportButton('exportReport'));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(mocks.bridge.reports.getZReport).toHaveBeenLastCalledWith({ zReportId: 'zr-desk-0002' });
    const document_ = zReportDocumentFromSnapshot({ data: delivery.data, shape: 'desktop', columns: delivery.columns });
    expect(downloads[0].csv).toBe(serializeZReportCsv(document_, { language: 'el' }));
    expect(downloads[0].fileName).toBe(zReportFileName(document_, { extension: 'csv' }));
    expect(downloads[0].fileName).toMatch(/^z-report_Ταμείο-1_/);
    expect(document.querySelector('[data-z-report-export-notice="success"]')).toHaveTextContent(downloads[0].fileName);
  });

  it('exports the order list the picked Z recorded', async () => {
    serveList([rowTakeaway, rowDelivery]);
    serveRowsById([rowTakeaway, rowDelivery]);
    renderDialog({ intent: 'orders' });

    const rows = await screen.findAllByRole('radio');
    fireEvent.click(rows[0]);
    expect(rows[0]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(exportButton('exportOrders'));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(mocks.bridge.reports.getZReport).toHaveBeenLastCalledWith({ zReportId: 'zr-desk-0001' });
    expect(downloads[0].fileName).toMatch(/^z-report-orders_terminal-zh-01_/);
    expect(parseCsv(downloads[0].csv, ';')).toHaveLength(1 + takeaway.data.dayOrders.length);
  });

  it('offers the live preview apart, as a provisional file that says it is not a Z', async () => {
    serveList([rowTakeaway]);
    const view = renderDialog({ shownReport: livePreview });
    await screen.findAllByRole('radio');

    const provisional = provisionalSection() as HTMLElement;
    expect(within(provisional).getByText('modals.zReport.exportDialog.provisionalTitle')).toBeInTheDocument();
    expect(within(provisional).getByText('modals.zReport.exportDialog.provisionalHelp')).toBeInTheDocument();
    fireEvent.click(within(provisional).getByRole('button', { name: 'modals.zReport.exportDialog.exportProvisional' }));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].fileName).toMatch(/^z-provisional_Ταμείο-1_/);
    expect(parseCsv(downloads[0].csv, ';')[1]).toEqual([
      zReportLabel('el', 'section.report'),
      zReportLabel('el', 'report.status'),
      zReportLabel('el', 'status.provisional'),
    ]);
    fireEvent.click(within(provisional).getByRole('button', { name: 'modals.zReport.exportDialog.exportProvisionalOrders' }));
    expect(downloads[1].fileName).toMatch(/^z-provisional-orders_/);
    // Nothing stored was read for it.
    expect(mocks.bridge.reports.getZReport).not.toHaveBeenCalled();
    view.unmount();

    // Without a live preview (nothing shown, or a stored Z) there is no provisional action.
    renderDialog({ shownReport: null });
    await screen.findAllByRole('radio');
    expect(provisionalSection()).toBeNull();
  });

  it('reads the shown Z by its id when it is older than the listed days', async () => {
    serveList([rowTakeaway]);
    serveRowsById([rowTakeaway, rowDelivery]);
    renderDialog({ shownReport: shownStored });

    await waitFor(() => expect(checkedRow()).toHaveAttribute('data-z-report-id', 'zr-desk-0002'));
    expect(mocks.bridge.reports.getZReport).toHaveBeenCalledWith({ zReportId: 'zr-desk-0002' });
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('shows a list that cannot load as an error, never as "no Z yet", and retries into the empty state', async () => {
    mocks.bridge.reports.listZReports
      .mockRejectedValueOnce('database is locked')
      .mockResolvedValueOnce({ success: false, error: 'z_reports unreadable' })
      .mockResolvedValueOnce({ success: true, reports: [], count: 0 });
    renderDialog({ shownReport: livePreview });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('modals.zReport.exportDialog.loadFailed');
    expect(alert).toHaveTextContent('database is locked');
    expect(screen.queryByText('modals.zReport.exportDialog.empty')).toBeNull();
    // The open day's preview stays exportable while the list is down.
    expect(provisionalSection()).not.toBeNull();

    fireEvent.click(within(alert).getByRole('button', { name: 'modals.zReport.exportDialog.retry' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('z_reports unreadable'));
    expect(screen.queryByText('modals.zReport.exportDialog.empty')).toBeNull();

    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'modals.zReport.exportDialog.retry' }));
    expect(await screen.findByText('modals.zReport.exportDialog.empty')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(mocks.bridge.reports.listZReports).toHaveBeenCalledTimes(3);
  });

  it('says so when the stored Z cannot be read for the export, and exports nothing', async () => {
    serveList([rowTakeaway]);
    mocks.bridge.reports.getZReport.mockRejectedValue('Z-report not found: zr-desk-0001');
    renderDialog();

    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    fireEvent.click(exportButton('exportReport'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('modals.zReport.exportDialog.exportFailed');
    expect(alert).toHaveTextContent('Z-report not found: zr-desk-0001');
    expect(downloads).toHaveLength(0);
  });

  it('drops a stored Z that arrives after the dialog closed: nothing is downloaded', async () => {
    serveList([rowTakeaway]);
    let answer: (value: unknown) => void = () => undefined;
    mocks.bridge.reports.getZReport.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const view = renderDialog();

    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    fireEvent.click(exportButton('exportReport'));
    await waitFor(() => expect(mocks.bridge.reports.getZReport).toHaveBeenCalledTimes(1));
    const busyButton = screen.getByRole('button', { name: 'modals.zReport.exportDialog.exporting' });
    expect(busyButton).toHaveAttribute('aria-busy', 'true');
    expect(busyButton).toBeDisabled();
    view.unmount();
    answer({ success: true, report: rowTakeaway });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(downloads).toHaveLength(0);
  });

  it('moves the pick with the arrow keys', async () => {
    serveList([rowTakeaway, rowDelivery]);
    renderDialog();

    const rows = await screen.findAllByRole('radio');
    expect(rows[0]).toHaveAttribute('tabindex', '0');
    expect(rows[1]).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(rows[1]).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: 'Home' });
    expect(rows[0]).toHaveAttribute('aria-checked', 'true');
    expect(rows[0]).toHaveAttribute('tabindex', '0');
  });
});
