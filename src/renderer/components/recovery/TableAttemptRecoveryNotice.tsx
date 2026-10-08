import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBridge, offEvent, onEvent } from '../../../lib';

type Attempt = { kind: string; clientEventId: string; orderId?: string; sessionId?: string;
  state: 'pending' | 'processing' | 'approval_required' | 'auth_required' | 'conflict' | 'applied' };
const states = new Set(['pending', 'processing', 'approval_required', 'auth_required', 'conflict', 'applied']);

/** Read-only status: the native recovery owner alone replays original immutable requests. */
export function TableAttemptRecoveryNotice() {
  const { t } = useTranslation();
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const revision = useRef(0);
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
  useEffect(() => {
    const update = () => { void refresh(); };
    const reset = () => { ++revision.current; lastValid.current = null; setAttempts([]); update(); };
    update();
    const timer = window.setInterval(update, 15000);
    onEvent('table_attempt_recovery', update);
    onEvent('app:reset', reset);
    onEvent('terminal-config-updated', reset);
    return () => {
      ++revision.current;
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
    <ul className="my-2 space-y-1">
      {attempts.map(entry => <li key={`${entry.kind}:${entry.clientEventId}`}>
        {t(`checkoutRecovery.${entry.state}`)}{entry.orderId ? ` · ${entry.orderId}` : ''}
      </li>)}
    </ul>
    <button type="button" onClick={() => void refresh()} className="rounded-lg border px-3 py-2">{t('checkoutRecovery.refresh')}</button>
  </section>;
}
