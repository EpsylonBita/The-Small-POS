/**
 * The capture queue — everything scanned on this till that is not filed yet.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
 * **D-UI**. Requirements R3.4, R10.5, R11.4, R11.5, R11.6, R12.1, R13.4.
 *
 * One promise, stated three ways:
 *
 * - **Nothing disappears.** Every document that is not committed is a row
 *   here, with a plain-language status and the time it was scanned (R11.4).
 *   A failure moves a document sideways into "needs attention" with a stated
 *   reason and its edits intact — never off the list (R11.6).
 * - **Every row leads somewhere.** Ready ones open review, failed ones offer
 *   trying again or typing it in, half-scanned ones offer carrying on. A row
 *   the user can only stare at would be a dead end (R11.4).
 * - **Skips are visible.** A duplicate or unreadable file the watched folder
 *   declined is a history entry saying so, because silently ignoring a file
 *   the user just scanned is indistinguishable from losing it (R3.4, R3.5).
 *
 * Status arrives by event, and only a *real* change is written to state: the
 * worker re-announces statuses it has already reported, and re-rendering the
 * list on every announcement would make a queue the user is reading jump.
 *
 * ---------------------------------------------------------------------------
 * INVOICES THE OFFICE RECORDED BY ITSELF
 * ---------------------------------------------------------------------------
 *
 * Spec: `.claude/specs/supplier-invoice-automation/design.md` §4.13, decision
 * **A24**; requirements R16.1, R16.2, R16.3, R16.5, R16.6.
 *
 * For a supplier the owner opted in, the server records the invoice at reading
 * time and the capture is confirmed `committed` there and then — so it is not
 * a queue row any more, and asking the person to check and Save something that
 * already exists would be a lie. What they get instead is the *result*: the
 * automatic mark, the supplier, the number, the date and the amount as printed,
 * and one action to open and correct the header (R16.1).
 *
 * That mark is read off the capture's own stored commit result — the server's
 * words, verbatim, as the `committed` event in this till's history — which is
 * why nothing here reads a switch: the decision was the office's, and a stale
 * local copy of it must never be able to record anything (R16.4). For the same
 * reason this panel offers **no control that sets the switches**: they live in
 * the admin dashboard only, and a POS control pretending otherwise is exactly
 * what R16.5 forbids.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  History,
  Loader2,
  PenLine,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useTheme } from '../../contexts/theme-context';
import { offEvent, onEvent } from '../../../lib';
import { formatCurrency, formatDate } from '../../utils/format';
import {
  advanceCapture,
  getCaptureHistory,
  listCaptureDocuments,
  type CaptureDocumentRow,
  type CaptureEventRow,
  type CaptureIngestRow,
} from '../../services/capture-client';
import {
  eventKey,
  ingestKey,
  reasonKey,
  sourceKindKey,
  statusKey,
} from '../../utils/capture-review';

/**
 * The `automation` block the reading door adds when it recorded the invoice
 * (design §4.6, §4.13). Stored verbatim by the capture worker as the capture's
 * commit result, which is where this panel reads it from.
 *
 * Everything in it except `outcome` and `kind` is content read off the paper or
 * held by the office — a name, a number, a date, an amount — and is shown as
 * read, never translated or reformatted beyond the locale's own money and date
 * formatting (R17.5, R17.6).
 */
export interface CaptureAutomation {
  outcome: 'recorded' | 'recorded_stock_updated';
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  amount: number;
  supplierName: string;
  kind: 'goods' | 'bill';
  supplierInvoiceId: string;
  attachmentUrl: string | null;
  attachmentPending: boolean;
}

/**
 * The block itself, if this value is one; otherwise `null`.
 *
 * The discriminator is `outcome`: only the reading door writes `recorded` or
 * `recorded_stock_updated`, and a person's own Save result — `{ success,
 * supplierInvoiceId, attachmentUrl, attachmentPending, … }` — carries no such
 * field, so the human path can never be mistaken for a recording.
 */
function parseAutomationBlock(candidate: unknown): CaptureAutomation | null {
  if (!candidate || typeof candidate !== 'object') return null;

  const record = candidate as Record<string, unknown>;
  const outcome = record.outcome;
  if (outcome !== 'recorded' && outcome !== 'recorded_stock_updated') return null;
  const invoiceId = typeof record.invoiceId === 'string' ? record.invoiceId.trim() : '';
  if (!invoiceId) return null;

  return {
    outcome,
    invoiceId,
    invoiceNumber: typeof record.invoiceNumber === 'string' ? record.invoiceNumber : '',
    invoiceDate: typeof record.invoiceDate === 'string' && record.invoiceDate ? record.invoiceDate : null,
    amount: typeof record.amount === 'number' && Number.isFinite(record.amount) ? record.amount : 0,
    supplierName: typeof record.supplierName === 'string' ? record.supplierName : '',
    kind: record.kind === 'bill' ? 'bill' : 'goods',
    supplierInvoiceId:
      typeof record.supplierInvoiceId === 'string' ? record.supplierInvoiceId : invoiceId,
    attachmentUrl: typeof record.attachmentUrl === 'string' ? record.attachmentUrl : null,
    attachmentPending: record.attachmentPending === true,
  };
}

/**
 * Read the automatic mark off a stored commit result.
 *
 * **The stored result *is* the block.** `confirm_commit`
 * (`src-tauri/src/capture/worker.rs`) passes the server's `automation` block
 * straight to `record_event`, which writes it as the `committed` event's whole
 * `details_json`; `commit_is_confirmed_with_attachment` and `committed_result`
 * read `supplierInvoiceId` / `attachmentUrl` / `attachmentPending` at its top
 * level for the same reason. So the candidate this reader must try first is the
 * result itself, not a `details.automation` wrapper — reading only the wrapper
 * is how the mark stayed dead on the wire while both suites were green.
 *
 * A `{ automation: … }` envelope is still accepted, second: nothing this client
 * writes produces one, but a future server-shaped payload that nests the block
 * should light the same mark rather than silently render nothing.
 *
 * A result without a block is a person's own Save — today's path, and no mark.
 * Anything malformed is treated the same way: the queue would rather say
 * nothing than invent a recording that did not happen.
 */
export function readAutomationBlock(details: unknown): CaptureAutomation | null {
  const stored = parseAutomationBlock(details);
  if (stored) return stored;
  if (!details || typeof details !== 'object') return null;
  return parseAutomationBlock((details as Record<string, unknown>).automation);
}

/** One capture this till scanned and the office recorded by itself. */
interface RecordedCapture {
  captureId: string;
  automation: CaptureAutomation;
}

interface CaptureQueuePanelProps {
  /** Open review for a recognised document. */
  onReview: (document: CaptureDocumentRow) => void;
  /** Reopen the page strip of a document still being scanned. */
  onContinueCapture: (document: CaptureDocumentRow) => void;
  /**
   * Open an automatically recorded invoice for correction — the header only.
   * There is nothing to save for the invoice to exist (R16.1).
   */
  onCorrect?: (automation: CaptureAutomation) => void;
  /** Staff member acting, recorded on discards (R13.4). */
  staffId?: string | null;
  /** The organization's currency, for the recorded amount (R17.6). */
  currencyCode?: string;
  /** Raised after any change so the caller can refresh its badge. */
  onChanged?: () => void;
}

/** Statuses whose next action is "wait" — the worker owns them. */
const AUTOMATIC_STATUSES = new Set(['waiting', 'uploading', 'reading', 'parked', 'committing']);

/** The history event carrying the server's verbatim commit result. */
const COMMIT_CONFIRMED_EVENT = 'committed';

/** Human-friendly time; falls back to the raw value rather than showing nothing. */
function displayTime(value: string): string {
  const formatted = formatDate(value);
  return formatted || value;
}

export const CaptureQueuePanel: React.FC<CaptureQueuePanelProps> = ({
  onReview,
  onContinueCapture,
  onCorrect,
  staffId,
  currencyCode,
  onChanged,
}) => {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const [documents, setDocuments] = useState<CaptureDocumentRow[]>([]);
  const [events, setEvents] = useState<CaptureEventRow[]>([]);
  const [ingest, setIngest] = useState<CaptureIngestRow[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);

  const subtleClass = isDark ? 'text-zinc-400' : 'text-gray-500';
  const cardClass = isDark ? 'border-zinc-800 bg-zinc-900/70' : 'border-gray-200 bg-gray-50';
  const secondaryButtonClass = isDark
    ? 'border-zinc-800 bg-zinc-900 text-zinc-100 active:bg-zinc-800'
    : 'border-gray-200 bg-white text-gray-800 active:bg-gray-100';
  const primaryButtonClass = isDark
    ? 'border-yellow-400/70 text-white active:bg-yellow-400/10'
    : 'border-yellow-400 text-gray-950 active:bg-yellow-50';

  /**
   * Re-read the queue, writing state only when something actually differs.
   *
   * This is the UI convention the spec calls out by name: an effect guard must
   * never seed a fresh array unconditionally. Here the guard is the comparison
   * itself, so a status announcement that changes nothing is a no-op update.
   */
  const refresh = useCallback(async () => {
    const next = await listCaptureDocuments();
    setDocuments((current) =>
      JSON.stringify(current) === JSON.stringify(next) ? current : next,
    );
  }, []);

  const refreshHistory = useCallback(async () => {
    const history = await getCaptureHistory();
    setEvents((current) =>
      JSON.stringify(current) === JSON.stringify(history.events) ? current : history.events,
    );
    setIngest((current) =>
      JSON.stringify(current) === JSON.stringify(history.ingest) ? current : history.ingest,
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The history is read whether or not it is on screen: it carries the stored
  // commit results, and an invoice the office recorded by itself must be in
  // front of the person the moment they open the queue, not one press later.
  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    const handleChange = () => {
      void refresh();
      void refreshHistory();
    };

    onEvent('capture:status-changed', handleChange);
    onEvent('capture:document-arrived', handleChange);
    return () => {
      offEvent('capture:status-changed', handleChange);
      offEvent('capture:document-arrived', handleChange);
    };
  }, [refresh, refreshHistory]);

  const act = useCallback(
    async (
      document: CaptureDocumentRow,
      status: CaptureDocumentRow['status'],
      reason?: string,
    ) => {
      setBusyId(document.captureId);
      try {
        await advanceCapture({
          captureId: document.captureId,
          status,
          reason: reason ?? null,
          staffId: staffId ?? null,
        });
        await refresh();
        onChanged?.();
      } finally {
        setBusyId(null);
        setConfirmDiscardId(null);
      }
    },
    [onChanged, refresh, staffId],
  );

  const sorted = useMemo(
    () =>
      [...documents].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)),
    [documents],
  );

  /**
   * The captures the office recorded by itself, newest first, one row per
   * capture. The newest `committed` event decides: a capture is confirmed once,
   * and re-confirming it (the attachment sweep finishing) must not double the
   * row the person is reading.
   */
  const recorded = useMemo<RecordedCapture[]>(() => {
    const seen = new Set<string>();
    const rows: RecordedCapture[] = [];

    for (const entry of [...events].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )) {
      if (entry.eventType !== COMMIT_CONFIRMED_EVENT || !entry.captureId) continue;
      if (seen.has(entry.captureId)) continue;
      seen.add(entry.captureId);

      const automation = readAutomationBlock(entry.details);
      if (!automation) continue;
      rows.push({ captureId: entry.captureId, automation });
    }

    return rows;
  }, [events]);

  /** The mark, by outcome. A bill says so as well (R16.6). */
  const markLabel = useCallback(
    (automation: CaptureAutomation): string =>
      automation.outcome === 'recorded_stock_updated'
        ? t(
            'suppliers.capture.automation.recordedStockMark',
            'Saved on its own · stock updated',
          )
        : t('suppliers.capture.automation.recordedMark', 'Saved on its own'),
    [t],
  );

  const money = useCallback(
    (amount: number): string => formatCurrency(amount, currencyCode || 'EUR', i18n.language),
    [currencyCode, i18n.language],
  );

  return (
    <section className="space-y-3" data-testid="capture-queue">
      {recorded.length > 0 && (
        <ul className="space-y-2" data-testid="capture-recorded">
          {recorded.map(({ captureId, automation }) => (
            <li
              key={`recorded-${captureId}`}
              data-testid={`capture-recorded-row-${captureId}`}
              className={`rounded-2xl border p-3 ${cardClass}`}
            >
              <div className="flex flex-wrap items-center gap-3">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />

                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{markLabel(automation)}</p>
                  <p className={`truncate text-xs ${subtleClass}`}>
                    {automation.supplierName}
                    {automation.invoiceNumber ? ` · ${automation.invoiceNumber}` : ''}
                    {automation.invoiceDate ? ` · ${displayTime(automation.invoiceDate)}` : ''}
                    {` · ${money(automation.amount)}`}
                    {automation.kind === 'bill'
                      ? ` · ${t('suppliers.capture.automation.billMark', 'Bill')}`
                      : ''}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => onCorrect?.(automation)}
                  className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${secondaryButtonClass}`}
                >
                  {t('suppliers.capture.automation.openAndCorrect', 'Open and correct')}
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {sorted.length === 0 ? (
        <div className={`rounded-2xl border p-4 text-sm ${cardClass}`}>
          <p className="font-semibold">
            {t('suppliers.capture.queue.emptyTitle', 'Nothing waiting')}
          </p>
          <p className={`mt-1 ${subtleClass}`}>
            {t(
              'suppliers.capture.queue.emptyDescription',
              'Scanned invoices show up here until they are saved.',
            )}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {sorted.map((document) => {
            const automatic = AUTOMATIC_STATUSES.has(document.status);
            const busy = busyId === document.captureId;

            return (
              <li
                key={document.captureId}
                data-testid={`capture-queue-row-${document.captureId}`}
                className={`rounded-2xl border p-3 ${cardClass}`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  {automatic ? (
                    <Loader2 className="h-5 w-5 shrink-0 animate-spin text-amber-500" />
                  ) : document.status === 'needs_attention' ? (
                    <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
                  ) : (
                    <Clock className="h-5 w-5 shrink-0 text-amber-500" />
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">
                      {t(statusKey(document.status), document.status)}
                    </p>
                    <p className={`truncate text-xs ${subtleClass}`}>
                      {displayTime(document.capturedAt)}
                      {' · '}
                      {t(sourceKindKey(document.sourceKind), document.sourceKind)}
                      {document.sourceName ? ` · ${document.sourceName}` : ''}
                      {' · '}
                      {t('suppliers.capture.pages.count', {
                        count: document.pageCount,
                        defaultValue: '{{count}} page(s) so far',
                      })}
                    </p>
                    {document.reasonCode && (
                      <p className="mt-1 text-xs font-semibold">
                        {t(
                          reasonKey(document.reasonCode),
                          t(
                            'suppliers.capture.reason.unknown',
                            'Something went wrong with this scan. Nothing is lost.',
                          ),
                        )}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-2">
                    {document.status === 'ready_review' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onReview(document)}
                        className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${primaryButtonClass}`}
                      >
                        {t('suppliers.capture.queue.check', 'Check & Save')}
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    )}

                    {document.status === 'capturing' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onContinueCapture(document)}
                        className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${primaryButtonClass}`}
                      >
                        {t('suppliers.capture.queue.continue', 'Carry on scanning')}
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    )}

                    {document.status === 'needs_attention' && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act(document, 'waiting')}
                          className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${primaryButtonClass}`}
                        >
                          <RefreshCw className="h-4 w-4" />
                          {t('suppliers.capture.queue.retry', 'Try again')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act(document, 'ready_review')}
                          className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${primaryButtonClass}`}
                        >
                          <PenLine className="h-4 w-4" />
                          {t('suppliers.capture.queue.manual', 'Fill in by hand')}
                        </button>
                      </>
                    )}

                    {document.status !== 'committing' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDiscardId(document.captureId)}
                        aria-label={t('suppliers.capture.queue.discard', 'Throw this scan away')}
                        className={`inline-flex h-10 w-10 items-center justify-center rounded-2xl border ${secondaryButtonClass}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>

                {confirmDiscardId === document.captureId && (
                  <div className={`mt-3 rounded-2xl border p-3 text-sm ${cardClass}`}>
                    <p>
                      {t(
                        'suppliers.capture.queue.discardConfirm',
                        'Throw this scan away? The pages are deleted from this till and cannot be brought back.',
                      )}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void act(document, 'discarded')}
                        className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${primaryButtonClass}`}
                      >
                        {t('suppliers.capture.queue.discard', 'Throw this scan away')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDiscardId(null)}
                        className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${secondaryButtonClass}`}
                      >
                        {t('common.cancel', 'Cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        data-testid="capture-history-toggle"
        onClick={() => setShowHistory((current) => !current)}
        className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${secondaryButtonClass}`}
      >
        <History className="h-4 w-4" />
        {showHistory
          ? t('suppliers.capture.history.hide', 'Hide recent activity')
          : t('suppliers.capture.history.show', 'Recent activity')}
      </button>

      {showHistory && (
        <div data-testid="capture-history" className={`rounded-2xl border p-3 ${cardClass}`}>
          {ingest.length === 0 && events.length === 0 ? (
            <p className={`text-sm ${subtleClass}`}>
              {t('suppliers.capture.history.empty', 'Nothing has happened here yet.')}
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {ingest.map((entry) => (
                <li key={`ingest-${entry.contentHash}`} className="flex flex-wrap gap-2">
                  <span className={`shrink-0 text-xs ${subtleClass}`}>
                    {displayTime(entry.seenAt)}
                  </span>
                  <span className="min-w-0 flex-1">{t(ingestKey(entry.outcome), entry.outcome)}</span>
                </li>
              ))}
              {events.map((entry) => {
                // A capture the office recorded says so here too, so the
                // history and the row above never tell two different stories
                // about the same invoice (§12 parity item).
                const automation =
                  entry.eventType === COMMIT_CONFIRMED_EVENT
                    ? readAutomationBlock(entry.details)
                    : null;

                return (
                  <li key={`event-${entry.id}`} className="flex flex-wrap gap-2">
                    <span className={`shrink-0 text-xs ${subtleClass}`}>
                      {displayTime(entry.createdAt)}
                    </span>
                    <span className="min-w-0 flex-1">
                      {automation
                        ? markLabel(automation)
                        : t(eventKey(entry.eventType), entry.eventType)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

export default CaptureQueuePanel;
