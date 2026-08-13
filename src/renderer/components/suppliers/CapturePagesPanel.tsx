/**
 * The pages of the invoice being scanned right now.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
 * **D-UI**. Requirements R5.1, R5.2, R12.3, R15.6, R17.1.
 *
 * This is the only screen between pressing Scan and checking the result, and
 * its whole job is to stay out of the way:
 *
 * - **"Add another page" and "Done" are equals.** Same size, same weight, side
 *   by side, neither one a "next step" the other is subordinate to. A one-page
 *   invoice is Done straight away; a five-page one is Add, Add, Add, Add,
 *   Done. There is no wizard, and no page count is ever asked for up front
 *   (R4.3-adjacent, R5.1, R15.6).
 * - **Remove / re-scan / reorder are always there and never required.** Every
 *   one of them is skippable on the happy path; the primary Done button stays
 *   reachable without touching any of them (R5.2, R15.6).
 * - **The page cap is a sentence, not a wall.** Hitting ten pages offers to
 *   finish this invoice and start the next one, because a long delivery note
 *   is a real thing and refusing it outright would strand the user (R12.3).
 *
 * Re-scanning a page replaces it *in place*: the new page is acquired onto the
 * end, the old one is removed, and the order is rewritten so the replacement
 * sits exactly where the original was. The user sees a page get better; they
 * never see it move.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTheme } from '../../contexts/theme-context';
import { renderModalPortal } from '../../utils/render-modal-portal';
import {
  MAX_CAPTURE_PAGES,
  acquireFromScanner,
  getCaptureDocument,
  getCapturePagePreview,
  removeCapturePage,
  reorderCapturePages,
  type CapturePageRow,
} from '../../services/capture-client';
import { deviceKey } from '../../utils/capture-review';

interface CapturePagesPanelProps {
  isOpen: boolean;
  captureId: string | null;
  /** Present for a connected scanner; absent for watched-folder documents. */
  deviceId?: string | null;
  sourceName?: string | null;
  /** Close without finishing — the document stays in `capturing`, nothing lost. */
  onClose: () => void;
  /** Finish this document and hand it to the recognition queue. */
  onDone: (captureId: string) => Promise<unknown> | void;
  /** Finish this one and immediately begin the next — the page-cap escape. */
  onFinishAndStartAnother: (captureId: string) => Promise<unknown> | void;
}

/**
 * Build the `order` array that moves the page currently at `from` to `to`,
 * expressed as current page indexes in their desired sequence.
 *
 * Exported because it is pure and the interesting half of both reordering and
 * in-place re-scanning — worth pinning by test without driving the UI.
 */
export function movedOrder(pageCount: number, from: number, to: number): number[] {
  const order = Array.from({ length: pageCount }, (_unused, index) => index);
  if (from < 0 || from >= pageCount || to < 0 || to >= pageCount) return order;
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return order;
}

export const CapturePagesPanel: React.FC<CapturePagesPanelProps> = ({
  isOpen,
  captureId,
  deviceId,
  sourceName,
  onClose,
  onDone,
  onFinishAndStartAnother,
}) => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const [pages, setPages] = useState<CapturePageRow[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const panelClass = isDark
    ? 'bg-zinc-950 border-zinc-800 text-white'
    : 'bg-white border-gray-200 text-gray-950';
  const subtleClass = isDark ? 'text-zinc-400' : 'text-gray-500';
  const cardClass = isDark ? 'border-zinc-800 bg-zinc-900/70' : 'border-gray-200 bg-gray-50';
  const secondaryButtonClass = isDark
    ? 'border-zinc-800 bg-zinc-900 text-zinc-100 active:bg-zinc-800'
    : 'border-gray-200 bg-white text-gray-800 active:bg-gray-100';
  const primaryButtonClass = isDark
    ? 'border-yellow-400/70 text-white active:bg-yellow-400/10'
    : 'border-yellow-400 text-gray-950 active:bg-yellow-50';

  /**
   * Re-read the page list.
   *
   * The comparison is not an optimization — it is the rule. Writing a fresh
   * array on every refresh would restart every thumbnail load and make the
   * strip flicker on a cadence the user never asked for.
   */
  const refreshPages = useCallback(async (): Promise<CapturePageRow[]> => {
    if (!captureId) return [];
    const { document } = await getCaptureDocument(captureId);
    const next = document?.pages ?? [];
    setPages((current) =>
      JSON.stringify(current) === JSON.stringify(next) ? current : next,
    );
    return next;
  }, [captureId]);

  useEffect(() => {
    if (!isOpen || !captureId) return;
    void refreshPages();
  }, [isOpen, captureId, refreshPages]);

  // Thumbnails are keyed by content hash, so a page that did not change keeps
  // its already-loaded preview across reorders and refreshes.
  useEffect(() => {
    if (!isOpen || !captureId) return;
    let cancelled = false;

    const missing = pages.filter((page) => !previews[page.contentHash]);
    if (missing.length === 0) return;

    void (async () => {
      for (const page of missing) {
        const dataUrl = await getCapturePagePreview(captureId, page.pageIndex);
        if (cancelled || !dataUrl) continue;
        setPreviews((current) =>
          current[page.contentHash] ? current : { ...current, [page.contentHash]: dataUrl },
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, captureId, pages, previews]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== dialogRef.current) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const atPageCap = pages.length >= MAX_CAPTURE_PAGES;

  const acquire = useCallback(async (): Promise<CapturePageRow[] | null> => {
    if (!captureId || !deviceId) return null;
    const outcome = await acquireFromScanner({ captureId, deviceId });
    if (!outcome.ok) {
      const message = t(
        deviceKey(outcome.code),
        t('suppliers.capture.device.device_error', 'The scanner did not answer. Check it is on and connected.'),
      );
      setNotice(message);
      toast.error(message);
      return null;
    }
    if (outcome.reachedPageCap) {
      setNotice(
        t(
          'suppliers.capture.pages.capReached',
          'That is as many pages as one invoice can hold. Finish this one and start another for the rest.',
        ),
      );
    }
    return outcome.pages;
  }, [captureId, deviceId, t]);

  const handleAddPage = useCallback(async () => {
    if (!captureId) return;
    setNotice(null);
    setBusy('add');
    try {
      await acquire();
      await refreshPages();
    } finally {
      setBusy(null);
    }
  }, [acquire, captureId, refreshPages]);

  const handleRemove = useCallback(
    async (pageIndex: number) => {
      if (!captureId) return;
      setNotice(null);
      setBusy(`remove-${pageIndex}`);
      try {
        await removeCapturePage(captureId, pageIndex);
        await refreshPages();
      } finally {
        setBusy(null);
      }
    },
    [captureId, refreshPages],
  );

  const handleMove = useCallback(
    async (from: number, to: number) => {
      if (!captureId) return;
      setNotice(null);
      setBusy(`move-${from}`);
      try {
        await reorderCapturePages(captureId, movedOrder(pages.length, from, to));
        await refreshPages();
      } finally {
        setBusy(null);
      }
    },
    [captureId, pages.length, refreshPages],
  );

  /**
   * Re-acquire one page from the source, replacing it where it stands.
   *
   * Order of operations matters and is deliberate: acquire *first*, so a
   * scanner that fails leaves the original page untouched. Only once new bytes
   * exist is the old page dropped and the replacement moved into its slot.
   */
  const handleRescan = useCallback(
    async (pageIndex: number) => {
      if (!captureId || !deviceId) return;
      setNotice(null);
      setBusy(`rescan-${pageIndex}`);
      try {
        const acquired = await acquire();
        if (!acquired || acquired.length === 0) return;

        const afterAcquire = await refreshPages();
        // Drop any surplus an ADF fed beyond the one page being replaced,
        // newest first so the indexes below it stay put.
        const surplus = afterAcquire.length - (pages.length + 1);
        for (let extra = 0; extra < surplus; extra += 1) {
          await removeCapturePage(captureId, afterAcquire.length - 1 - extra);
        }

        await removeCapturePage(captureId, pageIndex);
        const compacted = await refreshPages();
        // The replacement is now the last page; put it where the old one was.
        await reorderCapturePages(
          captureId,
          movedOrder(compacted.length, compacted.length - 1, pageIndex),
        );
        await refreshPages();
        toast.success(t('suppliers.capture.pages.rescanned', 'Page replaced.'));
      } finally {
        setBusy(null);
      }
    },
    [acquire, captureId, deviceId, pages.length, refreshPages, t],
  );

  const handleDone = useCallback(async () => {
    if (!captureId) return;
    setBusy('done');
    try {
      await onDone(captureId);
    } finally {
      setBusy(null);
    }
  }, [captureId, onDone]);

  const handleFinishAndStartAnother = useCallback(async () => {
    if (!captureId) return;
    setBusy('another');
    try {
      await onFinishAndStartAnother(captureId);
    } finally {
      setBusy(null);
    }
  }, [captureId, onFinishAndStartAnother]);

  const canAddPage = useMemo(() => Boolean(deviceId) && !atPageCap, [atPageCap, deviceId]);

  if (!isOpen || !captureId) return null;

  return renderModalPortal(
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        className={`flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl border shadow-2xl ${panelClass}`}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-inherit p-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-2xl font-bold">
              {t('suppliers.capture.pages.title', 'Your invoice')}
            </h2>
            <p className={`mt-1 truncate text-sm ${subtleClass}`}>
              {t('suppliers.capture.pages.count', {
                count: pages.length,
                defaultValue: '{{count}} page(s) so far',
              })}
              {sourceName ? ` · ${sourceName}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${secondaryButtonClass}`}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide p-4">
          {notice && (
            <div
              data-testid="capture-pages-notice"
              className={`mb-4 rounded-2xl border px-3 py-2 text-sm ${cardClass}`}
            >
              <p>{notice}</p>
              {atPageCap && (
                <button
                  type="button"
                  onClick={() => void handleFinishAndStartAnother()}
                  className={`mt-3 inline-flex min-h-10 items-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${primaryButtonClass}`}
                >
                  <Plus className="h-4 w-4" />
                  {t(
                    'suppliers.capture.pages.finishAndStartAnother',
                    'Finish this one and start another',
                  )}
                </button>
              )}
            </div>
          )}

          {pages.length === 0 ? (
            <div className={`rounded-2xl border p-4 text-sm ${cardClass}`}>
              {t('suppliers.capture.pages.empty', 'No pages yet. Add the first one.')}
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {pages.map((page, position) => (
                <li
                  key={page.contentHash + page.pageIndex}
                  data-testid={`capture-page-${page.pageIndex}`}
                  className={`rounded-2xl border p-3 ${cardClass}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">
                      {t('suppliers.capture.pages.pageLabel', {
                        number: position + 1,
                        defaultValue: 'Page {{number}}',
                      })}
                    </span>
                    {busy === `rescan-${page.pageIndex}` && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                  </div>

                  {previews[page.contentHash] ? (
                    <img
                      src={previews[page.contentHash]}
                      alt={t('suppliers.capture.pages.pageLabel', {
                        number: position + 1,
                        defaultValue: 'Page {{number}}',
                      })}
                      className="mt-2 h-40 w-full rounded-2xl border border-inherit object-contain"
                    />
                  ) : (
                    <div className="mt-2 flex h-40 w-full items-center justify-center rounded-2xl border border-inherit">
                      <Loader2 className={`h-5 w-5 animate-spin ${subtleClass}`} />
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={position === 0 || busy !== null}
                      onClick={() => void handleMove(position, position - 1)}
                      aria-label={t('suppliers.capture.pages.moveEarlier', 'Move earlier')}
                      className={`inline-flex h-10 w-10 items-center justify-center rounded-2xl border ${secondaryButtonClass}`}
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      disabled={position === pages.length - 1 || busy !== null}
                      onClick={() => void handleMove(position, position + 1)}
                      aria-label={t('suppliers.capture.pages.moveLater', 'Move later')}
                      className={`inline-flex h-10 w-10 items-center justify-center rounded-2xl border ${secondaryButtonClass}`}
                    >
                      <ArrowRight className="h-4 w-4" />
                    </button>
                    {deviceId && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void handleRescan(page.pageIndex)}
                        aria-label={t('suppliers.capture.pages.rescan', 'Scan this page again')}
                        className={`inline-flex h-10 w-10 items-center justify-center rounded-2xl border ${secondaryButtonClass}`}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void handleRemove(page.pageIndex)}
                      aria-label={t('suppliers.capture.pages.remove', 'Remove this page')}
                      className={`inline-flex h-10 w-10 items-center justify-center rounded-2xl border ${secondaryButtonClass}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {atPageCap && !notice && (
            <p data-testid="capture-page-cap" className={`mt-4 text-sm ${subtleClass}`}>
              {t(
                'suppliers.capture.pages.capReached',
                'That is as many pages as one invoice can hold. Finish this one and start another for the rest.',
              )}
            </p>
          )}
        </div>

        {/*
          Two choices, deliberately identical in weight and size. Neither is
          "the next step"; the user picks whichever describes their invoice.
          [R5.1, R15.6]
        */}
        <div className="grid shrink-0 gap-2 border-t border-inherit p-4 sm:grid-cols-2">
          <button
            type="button"
            data-testid="capture-add-page"
            disabled={!canAddPage || busy !== null}
            onClick={() => void handleAddPage()}
            className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold ${primaryButtonClass}`}
          >
            {busy === 'add' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {t('suppliers.capture.pages.addAnother', 'Add another page')}
          </button>
          <button
            type="button"
            data-testid="capture-done"
            disabled={pages.length === 0 || busy !== null}
            onClick={() => void handleDone()}
            className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold ${primaryButtonClass}`}
          >
            {busy === 'done' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            {t('suppliers.capture.pages.done', 'Done')}
          </button>
        </div>
      </div>
    </div>,
  );
};

export default CapturePagesPanel;
