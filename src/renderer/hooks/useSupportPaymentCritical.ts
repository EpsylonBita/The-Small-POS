import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { v4 as uuid } from 'uuid';
import { supportIpc } from '../../lib/ipc-adapter';
import { useSupportSession } from './useSupportSession';

/** Informational only: support IPC must never delay or fail a sale. */
export function useSupportPaymentCritical(isOpen: boolean) {
  const session = useSupportSession();
  const sessionId = session?.snapshot?.session_id ?? null;
  const ended = session?.snapshot?.state === 'ended';
  const previousSession = useRef({ sessionId, ended });
  const token = useRef<string | null>(null);
  const open = useRef(false);
  const enabled = useRef(false);
  const lifetime = useRef(0);
  const attempts = useRef({ count: 0 });

  const release = useCallback(() => {
    const closing = token.current;
    token.current = null;
    if (closing) {
      try { void supportIpc('support_payment_closed', { token: closing }).catch(() => {}); }
      catch { /* The payment owns its result, including synchronous bridge failures. */ }
    }
  }, []);
  const close = useCallback(() => { enabled.current = false; release(); }, [release]);
  const ensureOpen = useCallback(() => {
    if (!open.current || !enabled.current || token.current) { return; }
    try {
      const next = uuid();
      token.current = next;
      void supportIpc('support_payment_open', { token: next }).catch(() => {});
    } catch { /* Cleanup still closes a token whose open failed. */ }
  }, []);

  // Layout effects run before the user can take payment input.
  useLayoutEffect(() => {
    open.current = isOpen;
    enabled.current = isOpen;
    lifetime.current++;
    attempts.current = { count: 0 };
    if (isOpen) { ensureOpen(); }
    return () => { open.current = false; lifetime.current++; close(); };
  }, [isOpen, close, ensureOpen]);
  useLayoutEffect(() => {
    // End clears native signals. Reassert only an outstanding modal/attempt.
    const previous = previousSession.current;
    previousSession.current = { sessionId, ended };
    if ((previous.sessionId !== sessionId || previous.ended !== ended) && token.current) { release(); ensureOpen(); }
  }, [sessionId, ended, release, ensureOpen]);

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const startedLifetime = lifetime.current;
    const group = attempts.current;
    group.count++;
    enabled.current = open.current;
    ensureOpen();
    try { return await operation(); }
    finally {
      group.count--;
      if (lifetime.current === startedLifetime && group.count === 0) {
        release();
        // A still-open modal can accept another portion/retry immediately.
        // Protect that input with a fresh token, never a closed token.
        ensureOpen();
      }
    }
  }, [release, ensureOpen]);
  return useMemo(() => ({ run, close }), [run, close]);
}
