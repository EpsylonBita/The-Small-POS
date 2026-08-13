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
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
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
import { formatDate } from '../../utils/format';
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

interface CaptureQueuePanelProps {
  /** Open review for a recognised document. */
  onReview: (document: CaptureDocumentRow) => void;
  /** Reopen the page strip of a document still being scanned. */
  onContinueCapture: (document: CaptureDocumentRow) => void;
  /** Staff member acting, recorded on discards (R13.4). */
  staffId?: string | null;
  /** Raised after any change so the caller can refresh its badge. */
  onChanged?: () => void;
}

/** Statuses whose next action is "wait" — the worker owns them. */
const AUTOMATIC_STATUSES = new Set(['waiting', 'uploading', 'reading', 'parked', 'committing']);

/** Human-friendly time; falls back to the raw value rather than showing nothing. */
function displayTime(value: string): string {
  const formatted = formatDate(value);
  return formatted || value;
}

export const CaptureQueuePanel: React.FC<CaptureQueuePanelProps> = ({
  onReview,
  onContinueCapture,
  staffId,
  onChanged,
}) => {
  const { t } = useTranslation();
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

  useEffect(() => {
    if (!showHistory) return;
    void refreshHistory();
  }, [showHistory, refreshHistory]);

  useEffect(() => {
    const handleChange = () => {
      void refresh();
      if (showHistory) void refreshHistory();
    };

    onEvent('capture:status-changed', handleChange);
    onEvent('capture:document-arrived', handleChange);
    return () => {
      offEvent('capture:status-changed', handleChange);
      offEvent('capture:document-arrived', handleChange);
    };
  }, [refresh, refreshHistory, showHistory]);

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

  return (
    <section className="space-y-3" data-testid="capture-queue">
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
              {events.map((entry) => (
                <li key={`event-${entry.id}`} className="flex flex-wrap gap-2">
                  <span className={`shrink-0 text-xs ${subtleClass}`}>
                    {displayTime(entry.createdAt)}
                  </span>
                  <span className="min-w-0 flex-1">
                    {t(eventKey(entry.eventType), entry.eventType)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

export default CaptureQueuePanel;
