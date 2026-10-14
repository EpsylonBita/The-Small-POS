import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarDays, Download, RefreshCw } from 'lucide-react';
import { getBridge } from '../../../lib';
import type { StoredZReportRow } from '../../../lib/ipc-contracts';
import { useTheme } from '../../contexts/theme-context';
import type { ZReportData } from '../../types/reports';
import { parseLocalDateString, toLocalDateString } from '../../utils/date';
import { formatCurrency, formatDate, formatTime } from '../../utils/format';
import {
  exportProvisionalZReportCsv,
  exportProvisionalZReportOrdersCsv,
  exportStoredZReportCsv,
  exportStoredZReportOrdersCsv,
  readProvisionalZReport,
  readStoredZReport,
  type StoredZReportExportOptions,
  type StoredZReportView,
} from '../../utils/reportExport';
import { resolvePersistedZReportId } from '../../utils/zReport';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { zReportRowCents, zReportTableRows } from '../../../../../shared/reports/z-report-export';
import { zReportLabel } from '../../../../../shared/reports/z-report-labels';

export type ZReportExportKind = 'report' | 'orders';

interface ZReportExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** What the Z window shows: a stored Z (it has a persisted id) or the live preview of the open day. */
  shownReport: ZReportData | null;
  /** The export the operator came for; that action leads. */
  intent?: ZReportExportKind;
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; detail: string }
  | { status: 'ready'; rows: StoredZReportRow[] };

type Notice = { tone: 'success' | 'error'; text: string; detail?: string };

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { error?: unknown; message?: unknown }).error ?? (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

const isStoredRow = (row: unknown): row is StoredZReportRow =>
  Boolean(row) && typeof (row as StoredZReportRow).id === 'string' && (row as StoredZReportRow).id.trim() !== '';

const timeOf = (value: string | null | undefined): number => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

/** Newest first, by the moment the Z was made; the native order breaks ties. */
function newestFirst(rows: StoredZReportRow[]): StoredZReportRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => timeOf(b.row.generatedAt) - timeOf(a.row.generatedAt) || a.index - b.index)
    .map((entry) => entry.row);
}

function formatBusinessDate(value: string | null): string {
  if (!value) return '—';
  const date = parseLocalDateString(value);
  return Number.isNaN(date.getTime())
    ? value
    : formatDate(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function formatPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return '—';
  const time = (iso: string) => formatTime(iso, { hour: '2-digit', minute: '2-digit' });
  const moment = (iso: string) => `${formatDate(iso, { day: '2-digit', month: '2-digit' })} ${time(iso)}`;
  const sameDay = Boolean(start && end) && toLocalDateString(start as string) === toLocalDateString(end as string);
  return `${start ? moment(start) : '…'} – ${end ? (sameDay ? time(end) : moment(end)) : '…'}`;
}

/**
 * The Z export picker (founder, 14/10/2026: "the Z export must be based on the Z's real data"). It lists the Zs
 * this till stored and exports the one the operator picks, read again by its id. The live preview of the open day
 * is offered apart, as a provisional file that is not a Z.
 */
const ZReportExportDialog: React.FC<ZReportExportDialogProps> = ({ isOpen, onClose, shownReport, intent = 'report' }) => {
  const bridge = getBridge();
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const { resolvedTheme } = useTheme();
  const isDarkTheme = resolvedTheme === 'dark';
  const shellClassName = isDarkTheme
    ? 'z-report-glass-shell border-yellow-400/25 text-white shadow-2xl shadow-black/40'
    : 'z-report-glass-shell border-yellow-500/30 text-slate-950 shadow-2xl shadow-slate-950/20';
  const contentClassName = isDarkTheme ? 'z-report-glass-content !p-4 text-white' : 'z-report-glass-content !p-4 text-slate-950';
  const insetClass = isDarkTheme
    ? 'border-yellow-400/15 bg-black/30 shadow-sm shadow-black/20 backdrop-blur-xl'
    : 'border-yellow-500/25 bg-white/70 shadow-sm shadow-slate-950/10 backdrop-blur-xl';
  const tileClass = isDarkTheme
    ? 'border-white/[0.12] bg-white/[0.08] text-white'
    : 'border-slate-900/[0.12] bg-white/80 text-slate-950';
  const strongText = isDarkTheme ? 'text-white' : 'text-slate-950';
  const mutedText = isDarkTheme ? 'text-white/85' : 'text-slate-700';
  const softText = isDarkTheme ? 'text-white/60' : 'text-slate-500';
  const secondaryButton = isDarkTheme
    ? 'border-yellow-400/20 bg-black/30 text-white active:bg-white/[0.12]'
    : 'border-yellow-500/25 bg-white/80 text-slate-900 active:bg-white';
  const primaryButton = 'border-yellow-500/40 bg-yellow-400 text-black shadow-lg shadow-yellow-500/20 active:bg-yellow-300';
  const buttonBase = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border px-4 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50';

  const listTitleId = useId();
  const previewTitleId = useId();
  const provisionalTitleId = useId();

  const shownZReportId = resolvePersistedZReportId(shownReport);
  // Only a preview without a stored id is provisional; a stored Z is exported from its row.
  const liveReport = shownReport && !shownZReportId ? shownReport : null;
  const shownTerminalId = typeof shownReport?.terminalId === 'string' ? shownReport.terminalId : '';
  const shownTerminalName = typeof shownReport?.terminalName === 'string' ? shownReport.terminalName.trim() : '';

  // A stored row carries the terminal id only; this till's own Zs show its display name, as the print does.
  const exportOptionsFor = useCallback(
    (row: StoredZReportRow): StoredZReportExportOptions | undefined =>
      shownTerminalName && shownTerminalId && row.terminalId === shownTerminalId
        ? { terminalName: shownTerminalName }
        : undefined,
    [shownTerminalId, shownTerminalName],
  );

  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Results belong to the open that started them; a late one after a close is dropped.
  const scopeRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const listFocusedRef = useRef(false);

  useEffect(() => {
    scopeRef.current += 1;
    setBusy(null);
    setNotice(null);
    listFocusedRef.current = false;
    // A stored Z read after the dialog closed is never downloaded.
    return () => {
      scopeRef.current += 1;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    let active = true;
    setList({ status: 'loading' });
    void (async () => {
      try {
        const result = await bridge.reports.listZReports();
        if (!result || result.success === false || !Array.isArray(result.reports)) {
          throw new Error(result?.error || '');
        }
        let rows = result.reports.filter(isStoredRow);
        // The Z the window shows can be older than the listed 30 days: read it by its id.
        if (shownZReportId && !rows.some((row) => row.id === shownZReportId)) {
          try {
            const shown = await bridge.reports.getZReport({ zReportId: shownZReportId });
            if (shown?.success !== false && isStoredRow(shown?.report)) rows = [...rows, shown.report];
          } catch {
            // The listed Zs stay exportable; only the shown one cannot be preselected.
          }
        }
        if (!active) return;
        const sorted = newestFirst(rows);
        setList({ status: 'ready', rows: sorted });
        setSelectedId((current) => {
          if (current && sorted.some((row) => row.id === current)) return current;
          return shownZReportId && sorted.some((row) => row.id === shownZReportId) ? shownZReportId : null;
        });
      } catch (error) {
        // A list that could not load is an error, never "no Z yet".
        if (active) setList({ status: 'error', detail: errorDetail(error) });
      }
    })();
    return () => {
      active = false;
    };
  }, [bridge, isOpen, reloadKey, shownZReportId]);

  const rows = list.status === 'ready' ? list.rows : null;
  const views = useMemo(
    () => (rows ?? []).map((row) => readStoredZReport(row, exportOptionsFor(row))),
    [exportOptionsFor, rows],
  );
  const selected = useMemo(() => views.find((view) => view.id === selectedId) ?? null, [selectedId, views]);
  const liveView = useMemo(() => (liveReport ? readProvisionalZReport(liveReport) : null), [liveReport]);
  const previewSections = useMemo(
    () =>
      selected
        ? selected.document.sections.map((section, index) => ({
          key: `${section.key}-${index}`,
          rows: zReportTableRows({ ...selected.document, sections: [section] }, { language }),
        }))
        : [],
    [language, selected],
  );

  // Keyboard users land on the picked (or newest) Z once the list is there, unless they moved on already.
  useEffect(() => {
    if (!isOpen || list.status !== 'ready' || listFocusedRef.current) return;
    listFocusedRef.current = true;
    const firstId = selectedId ?? list.rows[0]?.id ?? '';
    const target = rowRefs.current.get(firstId);
    const dialog = rootRef.current?.closest('[role="dialog"]');
    const active = document.activeElement;
    const untouched = !active
      || active === document.body
      || !dialog?.contains(active)
      || active === dialog
      || active.classList.contains('liquid-glass-modal-close');
    if (target && untouched) target.focus();
  }, [isOpen, list, selectedId]);

  const selectRow = useCallback((id: string) => {
    setSelectedId(id);
    setNotice(null);
  }, []);

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!rows || rows.length === 0) return;
      const current = rows.findIndex((row) => row.id === (event.target as HTMLElement).dataset.zReportId);
      const last = rows.length - 1;
      const next = event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? Math.min(last, current + 1)
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? Math.max(0, current - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
      if (next === null) return;
      event.preventDefault();
      const id = rows[next].id;
      selectRow(id);
      rowRefs.current.get(id)?.focus();
    },
    [rows, selectRow],
  );

  const exportStored = useCallback(
    async (kind: ZReportExportKind) => {
      if (!selectedId || busy) return;
      const scope = scopeRef.current;
      setBusy(kind);
      setNotice(null);
      try {
        // The file is made from the stored row read again by its id, never from the screen.
        const result = await bridge.reports.getZReport({ zReportId: selectedId });
        if (scopeRef.current !== scope) return;
        if (!result || result.success === false || !isStoredRow(result.report)) {
          throw new Error(result?.error || '');
        }
        const fileName = kind === 'orders'
          ? exportStoredZReportOrdersCsv(result.report, language, exportOptionsFor(result.report))
          : exportStoredZReportCsv(result.report, language, exportOptionsFor(result.report));
        setNotice({ tone: 'success', text: t('modals.zReport.exportDialog.exported', { fileName }) });
      } catch (error) {
        if (scopeRef.current !== scope) return;
        setNotice({ tone: 'error', text: t('modals.zReport.exportDialog.exportFailed'), detail: errorDetail(error) });
      } finally {
        if (scopeRef.current === scope) setBusy(null);
      }
    },
    [bridge, busy, exportOptionsFor, language, selectedId, t],
  );

  const exportProvisional = useCallback(
    (kind: ZReportExportKind) => {
      if (!liveReport || busy) return;
      try {
        const fileName = kind === 'orders'
          ? exportProvisionalZReportOrdersCsv(liveReport, language)
          : exportProvisionalZReportCsv(liveReport, language);
        setNotice({ tone: 'success', text: t('modals.zReport.exportDialog.exported', { fileName }) });
      } catch (error) {
        setNotice({ tone: 'error', text: t('modals.zReport.exportDialog.exportFailed'), detail: errorDetail(error) });
      }
    },
    [busy, language, liveReport, t],
  );

  const money = (cents: number | null, currency: string | null, signed = false) => {
    if (cents === null) return '—';
    const text = formatCurrency(cents / 100, currency);
    return signed && cents > 0 ? `+${text}` : text;
  };

  const renderRow = (view: StoredZReportView, index: number) => {
    const { identity, currency } = view.document;
    const isSelected = view.id === selectedId;
    const varianceCents = zReportRowCents(view.document, 'drawer.variance', 'cashDrawer');
    const varianceTone = varianceCents === null
      ? softText
      : varianceCents === 0
        ? 'text-emerald-600 dark:text-emerald-300'
        : 'text-amber-600 dark:text-amber-300';
    return (
      <button
        key={view.id}
        ref={(element) => {
          if (element) rowRefs.current.set(view.id, element);
          else rowRefs.current.delete(view.id);
        }}
        type="button"
        role="radio"
        aria-checked={isSelected}
        tabIndex={isSelected || (!selected && index === 0) ? 0 : -1}
        data-z-report-id={view.id}
        data-z-report-export-row
        onClick={() => selectRow(view.id)}
        className={`w-full rounded-2xl border p-3 text-left transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 ${
          isSelected ? 'border-yellow-400 bg-yellow-400/[0.16] ring-2 ring-yellow-400/60' : tileClass
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <span className={`min-w-0 truncate text-sm font-black ${strongText}`}>
            {identity.terminalName || identity.terminalId || '—'}
          </span>
          {view.id === shownZReportId && (
            <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-black text-emerald-700 dark:text-emerald-200">
              {t('modals.zReport.exportDialog.shownNow')}
            </span>
          )}
        </div>
        <div className={`mt-1 flex items-center gap-1.5 text-xs font-bold ${mutedText}`}>
          <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="break-words">{formatBusinessDate(identity.reportDate)}</span>
        </div>
        <div className={`mt-0.5 break-words text-[11px] font-semibold ${softText}`}>
          {formatPeriod(identity.periodStart, identity.periodEnd)}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="min-w-0">
            <div className={`truncate text-[11px] font-bold ${softText}`}>{t('modals.zReport.exportDialog.gross')}</div>
            <div className={`truncate text-sm font-black tabular-nums ${strongText}`}>
              {money(zReportRowCents(view.document, 'sales.gross', 'sales'), currency)}
            </div>
          </div>
          <div className="min-w-0">
            <div className={`truncate text-[11px] font-bold ${softText}`}>{t('modals.zReport.exportDialog.variance')}</div>
            <div className={`truncate text-sm font-black tabular-nums ${varianceTone}`}>{money(varianceCents, currency, true)}</div>
          </div>
        </div>
      </button>
    );
  };

  const busyLabel = (kind: string, label: string) => (busy === kind ? t('modals.zReport.exportDialog.exporting') : label);

  return (
    <LiquidGlassModal
      // Opened from the Z window, which stays usable while the cashier day is locked: so does this.
      recoveryAccess
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.zReport.exportDialog.title')}
      size="xl"
      className={shellClassName}
      contentClassName={contentClassName}
    >
      <div ref={rootRef} data-z-report-export-dialog className="flex flex-col gap-4">
        <p className={`text-sm font-semibold leading-5 ${mutedText}`}>{t('modals.zReport.exportDialog.subtitle')}</p>

        <div className="flex min-h-0 flex-col gap-4 lg:flex-row">
          <section aria-labelledby={listTitleId} className={`flex min-w-0 flex-col rounded-2xl border p-3 lg:w-[22rem] lg:shrink-0 ${insetClass}`}>
            <h3 id={listTitleId} className={`text-base font-black ${strongText}`}>{t('modals.zReport.exportDialog.listTitle')}</h3>
            <p className={`mt-0.5 text-[11px] font-semibold ${softText}`}>{t('modals.zReport.exportDialog.listHint')}</p>
            <div className="mt-3 min-h-0">
              {list.status === 'loading' && (
                <div role="status" className={`flex items-center gap-2 rounded-xl border px-3 py-3 text-sm font-bold ${tileClass}`}>
                  <RefreshCw className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                  {t('modals.zReport.exportDialog.loading')}
                </div>
              )}
              {list.status === 'error' && (
                <div role="alert" data-z-report-export-list-error className="rounded-xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm font-bold text-rose-700 dark:text-rose-200">
                  <div>{t('modals.zReport.exportDialog.loadFailed')}</div>
                  {list.detail && <div className={`mt-1 break-words text-[11px] font-semibold ${softText}`}>{list.detail}</div>}
                  <button
                    type="button"
                    onClick={() => setReloadKey((current) => current + 1)}
                    className={`${buttonBase} mt-2 ${secondaryButton}`}
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    {t('modals.zReport.exportDialog.retry')}
                  </button>
                </div>
              )}
              {list.status === 'ready' && list.rows.length === 0 && (
                <div data-z-report-export-empty className={`rounded-xl border border-dashed p-4 text-center text-sm font-semibold ${tileClass}`}>
                  {t('modals.zReport.exportDialog.empty')}
                </div>
              )}
              {views.length > 0 && (
                <div
                  role="radiogroup"
                  aria-labelledby={listTitleId}
                  onKeyDown={handleListKeyDown}
                  className="flex max-h-[52vh] flex-col gap-2 overflow-y-auto scrollbar-hide p-0.5"
                >
                  {views.map(renderRow)}
                </div>
              )}
            </div>
          </section>

          <section aria-labelledby={previewTitleId} className={`flex min-w-0 flex-1 flex-col rounded-2xl border p-3 ${insetClass}`}>
            <h3 id={previewTitleId} className={`text-base font-black ${strongText}`}>{t('modals.zReport.exportDialog.previewTitle')}</h3>
            {selected ? (
              <>
                <div className={`mt-3 max-h-[42vh] min-h-0 overflow-y-auto scrollbar-hide rounded-xl border ${tileClass}`}>
                  <table data-z-report-export-preview aria-labelledby={previewTitleId} className="w-full border-collapse text-sm">
                    <thead>
                      <tr className={`text-left text-[11px] font-black uppercase tracking-[0.08em] ${softText}`}>
                        <th scope="col" className="px-3 py-2">{zReportLabel(language, 'csv.line')}</th>
                        <th scope="col" className="px-3 py-2 text-right">{zReportLabel(language, 'csv.value')}</th>
                      </tr>
                    </thead>
                    {previewSections.map((section) => (
                      <tbody key={section.key}>
                        <tr>
                          <th
                            colSpan={2}
                            scope="colgroup"
                            className="border-t border-slate-900/10 bg-yellow-400/[0.1] px-3 py-1.5 text-left text-xs font-black dark:border-white/10"
                          >
                            {section.rows[0]?.section}
                          </th>
                        </tr>
                        {section.rows.map((row, index) => (
                          <tr key={`${row.rowKey}-${index}`} className="border-t border-slate-900/[0.06] dark:border-white/[0.06]">
                            <td className={`break-words px-3 py-1.5 font-semibold ${mutedText}`}>{row.line}</td>
                            <td className={`whitespace-nowrap px-3 py-1.5 text-right font-black tabular-nums ${strongText}`}>{row.text || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    ))}
                  </table>
                </div>
                {selected.document.hasMissingValues && (
                  <p className={`mt-2 text-[11px] font-semibold ${softText}`}>{zReportLabel(language, 'report.notRecorded')}</p>
                )}
              </>
            ) : (
              <div className={`mt-3 rounded-xl border border-dashed p-6 text-center text-sm font-semibold ${tileClass}`}>
                {t('modals.zReport.exportDialog.previewEmpty')}
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                data-z-report-export-action="report"
                onClick={() => void exportStored('report')}
                disabled={!selected || busy !== null}
                aria-busy={busy === 'report'}
                className={`${buttonBase} ${intent === 'report' ? primaryButton : secondaryButton}`}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                {busyLabel('report', t('modals.zReport.exportDialog.exportReport'))}
              </button>
              <button
                type="button"
                data-z-report-export-action="orders"
                onClick={() => void exportStored('orders')}
                disabled={!selected || busy !== null || selected.orders.length === 0}
                aria-busy={busy === 'orders'}
                className={`${buttonBase} ${intent === 'orders' ? primaryButton : secondaryButton}`}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                {busyLabel('orders', t('modals.zReport.exportDialog.exportOrders'))}
              </button>
            </div>
            {selected && selected.orders.length === 0 && (
              <p className={`mt-2 text-[11px] font-semibold ${softText}`}>{t('modals.zReport.exportDialog.noOrders')}</p>
            )}
            {selected && selected.ordersTruncated && (
              <p className={`mt-2 text-[11px] font-semibold ${softText}`}>{t('modals.zReport.exportDialog.ordersTruncated')}</p>
            )}
          </section>
        </div>

        {liveView && (
          <section
            aria-labelledby={provisionalTitleId}
            data-z-report-export-provisional
            className="rounded-2xl border border-dashed border-amber-500/50 bg-amber-400/[0.08] p-4"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
              <div className="min-w-0">
                <h3 id={provisionalTitleId} className={`text-base font-black ${strongText}`}>
                  {t('modals.zReport.exportDialog.provisionalTitle')}
                </h3>
                <p className={`mt-1 break-words text-xs font-semibold leading-5 ${mutedText}`}>
                  {t('modals.zReport.exportDialog.provisionalHelp')}
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                data-z-report-export-action="provisional-report"
                onClick={() => exportProvisional('report')}
                disabled={busy !== null}
                className={`${buttonBase} ${secondaryButton}`}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                {t('modals.zReport.exportDialog.exportProvisional')}
              </button>
              <button
                type="button"
                data-z-report-export-action="provisional-orders"
                onClick={() => exportProvisional('orders')}
                disabled={busy !== null || liveView.orders.length === 0}
                className={`${buttonBase} ${secondaryButton}`}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                {t('modals.zReport.exportDialog.exportProvisionalOrders')}
              </button>
            </div>
            {liveView.orders.length === 0 && (
              <p className={`mt-2 text-[11px] font-semibold ${softText}`}>{t('modals.zReport.exportDialog.provisionalNoOrders')}</p>
            )}
          </section>
        )}

        {notice && (
          <div
            role={notice.tone === 'error' ? 'alert' : 'status'}
            data-z-report-export-notice={notice.tone}
            className={`rounded-2xl border p-3 text-sm font-bold ${
              notice.tone === 'error'
                ? 'border-rose-400/40 bg-rose-500/10 text-rose-700 dark:text-rose-200'
                : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
            }`}
          >
            <div className="break-words">{notice.text}</div>
            {notice.detail && <div className={`mt-1 break-words text-[11px] font-semibold ${softText}`}>{notice.detail}</div>}
          </div>
        )}
      </div>
    </LiquidGlassModal>
  );
};

export default ZReportExportDialog;
