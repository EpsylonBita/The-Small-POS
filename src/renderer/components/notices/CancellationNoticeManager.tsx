/**
 * Globally visible, blocking notice for a provider ("platform") cancelling an
 * order. A provider cancellation must never silently disappear into the
 * cancelled-orders list while the kitchen keeps preparing it — so this
 * mounts once near the app root (like `SyncNotificationManager` /
 * `CaptureNotificationManager`), stays mounted across navigation, and shows
 * an unread notice above every other dialog.
 *
 * Reuses `LiquidGlassModal` — the app's one canonical modal shell/portal
 * (`document.body` portal, `z-index: 20000`, focus trap, background a11y
 * isolation, `useBlockerRegistration`) — instead of a bespoke portal, so this
 * notice is guaranteed to stack above every other dialog in the app
 * (`SyncRecoveryModal` etc. top out at `z-[10050]`) and participates in the
 * same blocker bookkeeping other surfaces already rely on.
 *
 * This never touches order status, refunds or the provider: it only shows
 * what `GET /pos/platforms/cancellations` already recorded and lets staff
 * acknowledge having seen it. Acknowledgement is purely local to this
 * terminal (`platformCancellationNoticeStore`).
 */

import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { useCancellationNotices } from '../../hooks/useCancellationNotices';
import { playSelectedPlatformSound } from '../../services/platformNotificationSound';
import { playAppAudioTones } from '../../services/appAudio';

export interface CancellationNoticeManagerProps {
  /** Staff authenticated with a stable, resolvable org/branch/terminal identity. */
  enabled: boolean;
}

// LiquidGlassModal's onClose is only reachable via backdrop/Escape/header
// close button, all disabled below — this exists just to satisfy the prop.
const NOOP = () => {};

export const CancellationNoticeManager: React.FC<CancellationNoticeManagerProps> = ({
  enabled,
}) => {
  const { t } = useTranslation();
  const { current, queueLength, acknowledging, acknowledgeFailed, persistPending, acknowledge, retry } =
    useCancellationNotices(enabled);

  const ackButtonRef = useRef<HTMLButtonElement | null>(null);
  const headerMarkerRef = useRef<HTMLDivElement | null>(null);
  const stopSoundRef = useRef<(() => void) | null>(null);
  const soundedIdsRef = useRef<Set<string>>(new Set());

  // Best-effort attention sound: plays once per notice becoming visible at
  // the front of the queue. A failed/blocked sound never prevents or delays
  // the dialog itself, which is already rendered from `current`.
  useEffect(() => {
    if (!enabled || !current) {
      stopSoundRef.current?.();
      stopSoundRef.current = null;
      return;
    }
    if (soundedIdsRef.current.has(current.id)) return;
    soundedIdsRef.current.add(current.id);

    stopSoundRef.current?.();
    try {
      stopSoundRef.current = playSelectedPlatformSound({
        volume: 0.9,
        onFallbackToTones: () =>
          playAppAudioTones(
            [
              { frequency: 880, start: 0, duration: 0.35 },
              { frequency: 880, start: 0.45, duration: 0.35 },
            ],
            0.2,
          ),
      });
    } catch {
      stopSoundRef.current = null;
    }
  }, [current, enabled]);

  // Belt-and-suspenders: stop any in-flight sound if this component itself
  // unmounts (e.g. logout tears down the authenticated tree), regardless of
  // what triggered it.
  useEffect(
    () => () => {
      stopSoundRef.current?.();
      stopSoundRef.current = null;
    },
    [],
  );

  if (!enabled || !current) {
    return null;
  }

  return (
    <LiquidGlassModal
      isOpen
      onClose={NOOP}
      closeOnBackdrop={false}
      closeOnEscape={false}
      closeMode="request"
      size="sm"
      ariaLabel={t('cancellationNotice.stopPreparing', {
        defaultValue: 'Stop preparing this order',
      })}
      initialFocusRef={ackButtonRef}
    >
      <div ref={headerMarkerRef} role="alert" className="flex items-start gap-3 pb-3" data-testid="cancellation-notice-dialog">
        <AlertTriangle className="mt-0.5 h-7 w-7 shrink-0 text-red-600 dark:text-red-400" />
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-red-600 dark:text-red-400">
            {t('cancellationNotice.eyebrow', { defaultValue: 'Order cancelled by platform' })}
          </div>
          <h2 className="mt-1 text-xl font-black leading-tight text-red-700 dark:text-red-300">
            {t('cancellationNotice.stopPreparing', {
              defaultValue: 'Stop preparing this order',
            })}
          </h2>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-sm text-slate-700 dark:text-slate-200">
          {t('cancellationNotice.explain', {
            defaultValue:
              'The delivery platform cancelled this order. Do not continue preparing or dispatching it.',
          })}
        </p>

        <dl className="space-y-2 rounded-2xl bg-slate-100 px-4 py-3 text-sm dark:bg-white/5">
          <div className="flex justify-between gap-3">
            <dt className="font-semibold text-slate-500 dark:text-slate-400">
              {t('cancellationNotice.orderNumber', { defaultValue: 'Order' })}
            </dt>
            <dd className="text-right font-bold text-slate-900 dark:text-white">
              {current.order_number}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="font-semibold text-slate-500 dark:text-slate-400">
              {t('cancellationNotice.platform', { defaultValue: 'Platform' })}
            </dt>
            <dd className="text-right font-bold text-slate-900 dark:text-white">
              {current.platform}
            </dd>
          </div>
          {current.external_order_id ? (
            <div className="flex justify-between gap-3">
              <dt className="font-semibold text-slate-500 dark:text-slate-400">
                {t('cancellationNotice.externalOrderId', { defaultValue: 'Platform order ID' })}
              </dt>
              <dd className="text-right font-bold text-slate-900 dark:text-white">
                {current.external_order_id}
              </dd>
            </div>
          ) : null}
        </dl>

        {queueLength > 1 ? (
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
            {t('cancellationNotice.queueCount', {
              defaultValue: '{{count}} more cancelled orders are waiting to be acknowledged.',
              count: queueLength - 1,
            })}
          </p>
        ) : null}

        {acknowledgeFailed ? (
          <p role="alert" className="text-sm font-semibold text-red-600 dark:text-red-400">
            {t('cancellationNotice.ackFailed', {
              defaultValue: 'Could not save that you read this. Try again.',
            })}
          </p>
        ) : null}

        {persistPending ? (
          <p role="alert" className="text-sm font-semibold text-red-600 dark:text-red-400">
            {t('cancellationNotice.persistPending', {
              defaultValue: 'Could not save this notice yet. Try again before acknowledging.',
            })}
          </p>
        ) : null}

        <button
          ref={ackButtonRef}
          type="button"
          data-testid={persistPending ? 'cancellation-notice-retry' : 'cancellation-notice-ack'}
          disabled={acknowledging}
          aria-busy={acknowledging}
          onClick={persistPending ? retry : acknowledge}
          className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-red-600 px-4 text-base font-black text-white transition-transform active:scale-[0.98] disabled:opacity-60"
        >
          {acknowledging ? <RefreshCw className="h-5 w-5 animate-spin" /> : null}
          {persistPending
            ? t('cancellationNotice.retry', { defaultValue: 'Try again' })
            : t('cancellationNotice.acknowledge', { defaultValue: 'I have read this' })}
        </button>
      </div>
    </LiquidGlassModal>
  );
};

export default CancellationNoticeManager;
