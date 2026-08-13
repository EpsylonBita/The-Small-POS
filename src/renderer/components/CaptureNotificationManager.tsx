/**
 * In-app notifications for invoice capture.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
 * **D-UI**. Requirements R3.6, R11.9, R12.4, R14.1.
 *
 * Pattern: `SyncNotificationManager` — mounted once near the app root, listens
 * to backend events for its whole life, owns no page state. Two jobs:
 *
 * 1. **Tell the user.** A scan arriving from the watched folder, or a queued
 *    document finishing recognition after the connection came back, raises a
 *    toast carrying a "Check invoice" action that navigates straight to review
 *    (R3.6, R11.9). This is the requirement-bearing path; OS-level
 *    notifications are explicitly a nice-to-have and are not used.
 * 2. **Rasterize PDFs.** `capture:needs-render` is the watcher asking the
 *    webview to do what Rust deliberately cannot (D1). Handling it here rather
 *    than on the suppliers page matters: a PDF that lands while the user is on
 *    the order screen must still become a readable capture, and this component
 *    is always mounted.
 *
 * Toasts are raised through `react-hot-toast`, which the app renders via
 * `PortaledToaster` — portaled to `document.body` precisely so a notification
 * cannot be trapped behind a modal's stacking context.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { offEvent, onEvent } from '../../lib';
import { useModules } from '../contexts/module-context';
import { renderCaptureDocument } from '../services/capture-pdf-render';
import { reasonKey } from '../utils/capture-review';

/**
 * Window event the suppliers page listens for. Carries the capture the user
 * asked to look at, so "Check invoice" lands on that document rather than just
 * on the suppliers page.
 */
export const CAPTURE_REVIEW_REQUEST_EVENT = 'capture:review-request';

/** Ask the app to open review for one captured document. */
export function requestCaptureReview(captureId: string): void {
  window.dispatchEvent(
    new CustomEvent('pos:navigate-view', { detail: { view: 'suppliers' } }),
  );
  window.dispatchEvent(
    new CustomEvent(CAPTURE_REVIEW_REQUEST_EVENT, { detail: { captureId } }),
  );
}

interface DocumentArrivedPayload {
  captureId?: string;
  sourceName?: string | null;
  needsRender?: boolean;
}

interface StatusChangedPayload {
  captureId?: string;
  status?: string;
  reason?: string | null;
}

interface NeedsRenderPayload {
  captureId?: string;
}

export const CaptureNotificationManager: React.FC = () => {
  const { t } = useTranslation();
  const { isModuleEnabled } = useModules();
  const capturesEnabled = isModuleEnabled('suppliers');

  /**
   * Render requests already picked up this session. A ref, not state: the poll
   * sweep can re-announce the same document across a restart of the watcher,
   * and re-rasterizing a PDF is expensive and pointless. Nothing renders from
   * this, so it must not cause one.
   */
  const renderedRef = useRef<Set<string>>(new Set());

  const notify = useCallback(
    (message: string, captureId: string | undefined) => {
      toast.custom(
        (instance) => (
          <div className="flex max-w-md items-center gap-3 rounded-2xl border border-amber-400/40 bg-black/85 px-4 py-3 text-sm text-white shadow-2xl">
            <FileText className="h-5 w-5 shrink-0 text-amber-300" />
            <span className="min-w-0 flex-1">{message}</span>
            {captureId ? (
              <button
                type="button"
                onClick={() => {
                  toast.dismiss(instance.id);
                  requestCaptureReview(captureId);
                }}
                className="inline-flex min-h-10 shrink-0 items-center rounded-2xl border border-amber-400 px-3 text-sm font-semibold text-amber-200 active:bg-amber-400/20"
              >
                {t('suppliers.capture.notifications.check', 'Check invoice')}
              </button>
            ) : null}
          </div>
        ),
        { duration: 8000 },
      );
    },
    [t],
  );

  useEffect(() => {
    if (!capturesEnabled) {
      return;
    }

    const handleArrived = (payload: DocumentArrivedPayload) => {
      notify(
        t('suppliers.capture.notifications.arrived', 'A new invoice arrived.'),
        payload?.captureId,
      );
    };

    const handleStatus = (payload: StatusChangedPayload) => {
      const status = payload?.status;
      if (status === 'ready_review') {
        notify(
          t('suppliers.capture.notifications.ready', 'An invoice is ready to check.'),
          payload?.captureId,
        );
        return;
      }
      if (status === 'needs_attention') {
        notify(
          t(reasonKey(payload?.reason), t('suppliers.capture.reason.unknown', 'Something went wrong with a scanned invoice. Nothing is lost.')),
          payload?.captureId,
        );
        return;
      }
      if (status === 'parked') {
        notify(
          t(
            'suppliers.capture.status.parked',
            'On hold — the suppliers feature is not active. Nothing is lost.',
          ),
          payload?.captureId,
        );
      }
    };

    const handleNeedsRender = (payload: NeedsRenderPayload) => {
      const captureId = payload?.captureId;
      if (!captureId || renderedRef.current.has(captureId)) {
        return;
      }
      renderedRef.current.add(captureId);
      void renderCaptureDocument(captureId).catch((error) => {
        // The command itself already parks the document with a stated reason
        // on every failure path it can see; this catches the transport
        // failing outright, which must not take the manager down with it.
        console.error('[capture] rasterization handler failed:', error);
        renderedRef.current.delete(captureId);
      });
    };

    onEvent('capture:document-arrived', handleArrived);
    onEvent('capture:status-changed', handleStatus);
    onEvent('capture:needs-render', handleNeedsRender);

    return () => {
      offEvent('capture:document-arrived', handleArrived);
      offEvent('capture:status-changed', handleStatus);
      offEvent('capture:needs-render', handleNeedsRender);
    };
  }, [capturesEnabled, notify, t]);

  return null;
};

export default CaptureNotificationManager;
