import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type HTMLMotionProps } from 'framer-motion';
import { AlertTriangle, CalendarDays, Download, RefreshCw } from 'lucide-react';
import { getBridge } from '../../../lib';
import type { StoredZReportRow } from '../../../lib/ipc-contracts';
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

// Keep stale messages and controls out of the DOM while their empty glass panel collapses.
// This preserves the original removal timing, including blockers that have just been resolved.
function ZReportReveal({ as = 'div', children, ...props }: HTMLMotionProps<'div'> & { as?: 'div' | 'section' | 'p' | 'ul' }) {
  const isPresent = useIsPresent();
  const Surface = motion[as] as typeof motion.div;
  return <Surface {...props} aria-hidden={isPresent ? props['aria-hidden'] : true}>{isPresent ? children : null}</Surface>;
}

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
  const shellClassName = 'z-report-glass-shell [&_.liquid-glass-modal-header]:border-b-0! border-(--pos-s-border) liquid-glass-modal-text shadow-2xl shadow-slate-950/20 dark:shadow-black/40';
  const contentClassName = 'z-report-glass-content p-4! liquid-glass-modal-text';
  // founder 11/11/2026: frosted panels and deep tappable rows, solid export actions.
  const insetClass = 'pos-glass-form-card';
  const tileClass = 'pos-glass-form-card liquid-glass-modal-text';
  const strongText = 'liquid-glass-modal-text';
  const mutedText = 'liquid-glass-modal-text-muted';
  const softText = 'liquid-glass-modal-text-muted';
  const secondaryButton = 'border-(--pos-s-border) bg-(--pos-s-raised) text-(--pos-s-fg) shadow-(--pos-s-depth) active:bg-(--pos-s-raised-press) active:scale-[0.99]';
  const primaryButton = 'border-(--pos-s-border) bg-yellow-400 text-black shadow-lg active:bg-yellow-300';
  const buttonBase = 'inline-flex min-h-touch items-center justify-center gap-2 rounded-xl border px-4 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50';
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };


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
      ? 'text-amber-600 dark:text-amber-300'
      : varianceCents === 0
        ? 'text-emerald-600 dark:text-emerald-300'
        : 'text-rose-500';
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
        className={`pos-glass-tap-card min-h-touch w-full p-3 text-left transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-yellow-400 ${
          isSelected ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg)' : strongText
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <span className={`min-w-0 truncate text-sm font-black ${isSelected ? 'text-(--pos-s-sel-fg)' : strongText}`}>
            {identity.terminalName || identity.terminalId || '—'}
          </span>
          {view.id === shownZReportId && (
            <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-black text-emerald-700 dark:text-emerald-200">
              {t('modals.zReport.exportDialog.shownNow')}
            </span>
          )}
        </div>
        <div className={`mt-1 flex items-center gap-1.5 text-xs font-bold ${isSelected ? 'text-(--pos-s-sel-fg)' : mutedText}`}>
          <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="wrap-break-word">{formatBusinessDate(identity.reportDate)}</span>
        </div>
        <div className={`mt-0.5 wrap-break-word text-[11px] font-semibold ${isSelected ? 'text-(--pos-s-sel-fg)' : softText}`}>
          {formatPeriod(identity.periodStart, identity.periodEnd)}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="min-w-0">
            <div className={`truncate text-[11px] font-bold ${isSelected ? 'text-(--pos-s-sel-fg)' : softText}`}>{t('modals.zReport.exportDialog.gross')}</div>
            <div className={`truncate text-sm font-black tabular-nums ${isSelected ? 'text-(--pos-s-sel-fg)' : strongText}`}>
              {money(zReportRowCents(view.document, 'sales.gross', 'sales'), currency)}
            </div>
          </div>
          <div className="min-w-0">
            <div className={`truncate text-[11px] font-bold ${isSelected ? 'text-(--pos-s-sel-fg)' : softText}`}>{t('modals.zReport.exportDialog.variance')}</div>
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
      <div ref={rootRef} data-z-report-export-dialog className="flex flex-col gap-3">
        <p className={`text-sm font-semibold leading-5 ${mutedText}`}>{t('modals.zReport.exportDialog.subtitle')}</p>

        <div className="flex min-h-0 flex-col gap-3 lg:flex-row">
          <section aria-labelledby={listTitleId} className={`flex min-w-0 flex-col rounded-2xl border p-3! lg:w-88 lg:shrink-0 ${insetClass}`}>
            <h3 id={listTitleId} className={`text-base font-black ${strongText}`}>{t('modals.zReport.exportDialog.listTitle')}</h3>
            <p className={`mt-0.5 text-[11px] font-semibold ${softText}`}>{t('modals.zReport.exportDialog.listHint')}</p>
            <div className="mt-3 min-h-0">
              <AnimatePresence initial={false}>{list.status === 'loading' && (
                <ZReportReveal as="div" key="z-reveal-1" {...revealMotion} role="status" className={`flex items-center gap-2 rounded-xl border px-3! py-3! text-sm font-bold ${tileClass}`}>
                  <RefreshCw className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                  {t('modals.zReport.exportDialog.loading')}
                </ZReportReveal>
              )}</AnimatePresence>
              <AnimatePresence initial={false}>{list.status === 'error' && (
                <ZReportReveal as="div" key="z-reveal-2" {...revealMotion} role="alert" data-z-report-export-list-error className="rounded-xl border border-(--pos-s-bad) bg-(--pos-s-bad-bg) p-3 text-sm font-bold text-rose-700 dark:text-rose-200">
                  <div>{t('modals.zReport.exportDialog.loadFailed')}</div>
                  <AnimatePresence initial={false}>{list.detail && <ZReportReveal as="div" key="z-reveal-3" {...revealMotion} className={`mt-1 wrap-break-word text-[11px] font-semibold ${softText}`}>{list.detail}</ZReportReveal>}</AnimatePresence>
                  <button
                    type="button"
                    onClick={() => setReloadKey((current) => current + 1)}
                    className={`${buttonBase} mt-2 ${secondaryButton}`}
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    {t('modals.zReport.exportDialog.retry')}
                  </button>
                </ZReportReveal>
              )}</AnimatePresence>
              <AnimatePresence initial={false}>{list.status === 'ready' && list.rows.length === 0 && (
                <ZReportReveal as="div" key="z-reveal-4" {...revealMotion} data-z-report-export-empty className={`rounded-xl border border-dashed p-4! text-center text-sm font-semibold ${tileClass}`}>
                  {t('modals.zReport.exportDialog.empty')}
                </ZReportReveal>
              )}</AnimatePresence>
              <AnimatePresence initial={false}>{views.length > 0 && (
                <ZReportReveal as="div" key="z-reveal-5" {...revealMotion}
                  role="radiogroup"
                  aria-labelledby={listTitleId}
                  onKeyDown={handleListKeyDown}
                  className="flex max-h-[52vh] flex-col gap-2 overflow-y-auto scrollbar-hide p-0.5"
                >
                  {views.map(renderRow)}
                </ZReportReveal>
              )}</AnimatePresence>
            </div>
          </section>

          <section aria-labelledby={previewTitleId} className={`flex min-w-0 flex-1 flex-col rounded-2xl border p-3! ${insetClass}`}>
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
                            className="px-3 pt-4 pb-2 text-left text-xs font-black liquid-glass-modal-text"
                          >
                            {section.rows[0]?.section}
                          </th>
                        </tr>
                        {section.rows.map((row, index) => (
                          <tr key={`${row.rowKey}-${index}`} className="align-top">
                            <td className={`wrap-break-word px-3 py-1.5 font-semibold ${mutedText}`}>{row.line}</td>
                            <td className={`whitespace-nowrap px-3 py-1.5 text-right font-black tabular-nums ${strongText}`}>{row.text || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    ))}
                  </table>
                </div>
                <AnimatePresence initial={false}>{selected.document.hasMissingValues && (
                  <ZReportReveal as="p" key="z-reveal-6" {...revealMotion} className={`mt-2 text-[11px] font-semibold ${softText}`}>{zReportLabel(language, 'report.notRecorded')}</ZReportReveal>
                )}</AnimatePresence>
              </>
            ) : (
              <div className={`mt-3 rounded-xl border border-dashed p-6! text-center text-sm font-semibold ${tileClass}`}>
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
            <AnimatePresence initial={false}>{selected && selected.orders.length === 0 && (
              <ZReportReveal as="p" key="z-reveal-7" {...revealMotion} className={`mt-2 text-[11px] font-semibold ${softText}`}>{t('modals.zReport.exportDialog.noOrders')}</ZReportReveal>
            )}</AnimatePresence>
            <AnimatePresence initial={false}>{selected && selected.ordersTruncated && (
              <ZReportReveal as="p" key="z-reveal-8" {...revealMotion} className={`mt-2 text-[11px] font-semibold ${softText}`}>{t('modals.zReport.exportDialog.ordersTruncated')}</ZReportReveal>
            )}</AnimatePresence>
          </section>
        </div>

        <AnimatePresence initial={false}>{liveView && (
          <ZReportReveal as="section" key="z-reveal-9" {...revealMotion}
            aria-labelledby={provisionalTitleId}
            data-z-report-export-provisional
            className="pos-glass-form-card"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
              <div className="min-w-0">
                <h3 id={provisionalTitleId} className={`text-base font-black ${strongText}`}>
                  {t('modals.zReport.exportDialog.provisionalTitle')}
                </h3>
                <p className={`mt-1 wrap-break-word text-xs font-semibold leading-5 ${mutedText}`}>
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
            <AnimatePresence initial={false}>{liveView.orders.length === 0 && (
              <ZReportReveal as="p" key="z-reveal-10" {...revealMotion} className={`mt-2 text-[11px] font-semibold ${softText}`}>{t('modals.zReport.exportDialog.provisionalNoOrders')}</ZReportReveal>
            )}</AnimatePresence>
          </ZReportReveal>
        )}</AnimatePresence>

        <AnimatePresence initial={false}>{notice && (
          <ZReportReveal as="div" key="z-reveal-11" {...revealMotion}
            role={notice.tone === 'error' ? 'alert' : 'status'}
            data-z-report-export-notice={notice.tone}
            className={`rounded-2xl border p-3! text-sm font-bold ${
              notice.tone === 'error'
                ? 'border-(--pos-s-bad) bg-(--pos-s-bad-bg) text-rose-700 dark:text-rose-200'
                : 'pos-glass-form-card p-3! text-emerald-800 dark:text-emerald-200'
            }`}
          >
            <div className="wrap-break-word">{notice.text}</div>
            <AnimatePresence initial={false}>{notice.detail && <ZReportReveal as="div" key="z-reveal-12" {...revealMotion} className={`mt-1 wrap-break-word text-[11px] font-semibold ${softText}`}>{notice.detail}</ZReportReveal>}</AnimatePresence>
          </ZReportReveal>
        )}</AnimatePresence>
      </div>
    </LiquidGlassModal>
  );
};

export default ZReportExportDialog;
