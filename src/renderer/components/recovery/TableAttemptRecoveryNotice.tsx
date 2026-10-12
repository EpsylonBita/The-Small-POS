import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBridge, offEvent, onEvent } from '../../../lib';
import { formatCompactOrderNumberForDisplay } from '../../utils/orderNumberUtils';

type Attempt = { kind: string; clientEventId: string; orderId?: string; sessionId?: string;
  errorCode?: string;
  state: 'pending' | 'processing' | 'approval_required' | 'auth_required' | 'conflict' | 'applied' };
const states = new Set(['pending', 'processing', 'approval_required', 'auth_required', 'conflict', 'applied']);
const canConfirmOriginal = (entry: Attempt) => entry.kind === 'whole_order_cancel' &&
  entry.state === 'conflict' && entry.errorCode === 'CANONICAL_SNAPSHOT_REVIEW_REQUIRED';

/** Status reads and selected original receipt verification share the native recovery owner. */
export function TableAttemptRecoveryNotice({ onReviewEdit }: { onReviewEdit?: (clientEventId: string) => Promise<boolean> } = {}) {
  const { t } = useTranslation();
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const revision = useRef(0);
  const bindingRevision = useRef(0);
  const confirmation = useRef<string | null>(null);
  // The last valid reading of this binding: null until one succeeds.
  const lastValid = useRef<Attempt[] | null>(null);
  const refresh = useCallback(async () => {
    const version = ++revision.current;
    try {
      const response = await getBridge().invoke('table_attempt_recovery_status');
      if (!response?.success || !Array.isArray(response.attempts) || response.attempts.some((entry: Attempt) =>
        !entry.clientEventId || !states.has(entry.state))) throw new Error('TABLE_RECOVERY_STATUS_UNAVAILABLE');
      if (revision.current !== version) return;
      const pending = response.attempts.filter((entry: Attempt) => entry.state !== 'applied');
      lastValid.current = pending;
      setAttempts(pending);
      // Native status is capped at 100. An incomplete list must not turn
      // absence into proof that the selected original was resolved.
      setUnconfirmed(selected => selected &&
        (pending.some((entry: Attempt) => entry.clientEventId === selected) || response.attempts.length >= 100)
        ? selected : null);
      setUnavailable(false);
    } catch {
      // A failed read retains the last valid reading. Pending work stays
      // listed with the read failure; a terminal whose last reading had
      // nothing pending stays quiet instead of announcing recovery work it
      // does not have (06/10/2026: the notice appeared at intervals on a store
      // without tables whenever one status read failed). Only a binding that
      // has never been read shows the status as unavailable.
      if (revision.current === version) setUnavailable(lastValid.current === null || lastValid.current.length > 0);
    }
  }, []);
  const confirmOriginal = useCallback(async (entry: Attempt) => {
    if (!canConfirmOriginal(entry) || confirmation.current !== null) return;
    const binding = bindingRevision.current;
    confirmation.current = entry.clientEventId;
    setConfirming(entry.clientEventId);
    setUnconfirmed(null);
    try {
      // The UI supplies only the original event identity. Native selects and
      // verifies the retained request and reads its receipt without a mutation.
      const response = await getBridge().tableAttemptRecovery.confirmOriginal({
        clientEventId: entry.clientEventId,
      });
      if (bindingRevision.current !== binding) return;
      if (response?.state !== 'applied') setUnconfirmed(entry.clientEventId);
      await refresh();
    } catch {
      if (bindingRevision.current === binding) setUnconfirmed(entry.clientEventId);
    } finally {
      if (bindingRevision.current === binding) {
        confirmation.current = null;
        setConfirming(null);
      }
    }
  }, [refresh]);
  const reviewEdit = useCallback(async (entry: Attempt) => {
    if (!onReviewEdit || entry.kind !== 'item_edit' || entry.state === 'processing' || confirmation.current !== null) return;
    const binding = bindingRevision.current;
    confirmation.current = entry.clientEventId;
    setConfirming(entry.clientEventId);
    setUnconfirmed(null);
    try {
      const opened = await onReviewEdit(entry.clientEventId);
      if (bindingRevision.current === binding && !opened) setUnconfirmed(entry.clientEventId);
    } catch {
      if (bindingRevision.current === binding) setUnconfirmed(entry.clientEventId);
    } finally {
      if (bindingRevision.current === binding) {
        confirmation.current = null;
        setConfirming(null);
      }
    }
  }, [onReviewEdit]);
  useEffect(() => {
    const update = () => { void refresh(); };
    const reset = () => {
      ++revision.current;
      ++bindingRevision.current;
      confirmation.current = null;
      setConfirming(null);
      setUnconfirmed(null);
      lastValid.current = null;
      setAttempts([]);
      update();
    };
    update();
    const timer = window.setInterval(update, 15000);
    onEvent('table_attempt_recovery', update);
    onEvent('app:reset', reset);
    onEvent('terminal-config-updated', reset);
    return () => {
      ++revision.current;
      ++bindingRevision.current;
      window.clearInterval(timer);
      offEvent('table_attempt_recovery', update);
      offEvent('app:reset', reset);
      offEvent('terminal-config-updated', reset);
    };
  }, [refresh]);
  if (!attempts.length && !unavailable) return null;
  return <section role="status" className="shrink-0 rounded-xl border border-amber-400/40 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-100">
    <h3 className="font-semibold">{t('checkoutRecovery.title')}</h3>
    <p>{t('checkoutRecovery.guidance')}</p>
    {unavailable && <p>{t('checkoutRecovery.unavailable')}</p>}
    {unconfirmed && attempts.some(entry => entry.clientEventId === unconfirmed) && <p>{t('checkoutRecovery.originalResultUnconfirmed')}</p>}
    <ul className="my-2 space-y-1">
      {attempts.map(entry => <li key={`${entry.kind}:${entry.clientEventId}`}>
        {t(`checkoutRecovery.${entry.state}`)}{entry.orderId ? ` · ${formatCompactOrderNumberForDisplay(entry.orderId)}` : ''}
        {onReviewEdit && entry.kind === 'item_edit' && entry.state !== 'processing' && <button type="button"
          disabled={confirming !== null || unavailable} onClick={() => void reviewEdit(entry)}
          className="ml-2 rounded-lg border px-3 py-2 disabled:opacity-50">
          {t('modals.menu.draftRecover')}
        </button>}
        {canConfirmOriginal(entry) && <button type="button" disabled={confirming !== null}
          onClick={() => void confirmOriginal(entry)} className="ml-2 rounded-lg border px-3 py-2 disabled:opacity-50">
          {t('checkoutRecovery.confirmOriginalResult')}
        </button>}
      </li>)}
    </ul>
    <button type="button" onClick={() => void refresh()} className="rounded-lg border px-3 py-2">{t('checkoutRecovery.refresh')}</button>
  </section>;
}
