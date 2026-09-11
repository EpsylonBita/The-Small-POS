import { useCallback, useEffect, useRef } from 'react';

/** Refresh only while visible, sharing one request across manual/lifecycle/poll triggers. */
export function useIntegrationRefresh(
  scopeKey: string,
  load: (isCurrent: () => boolean) => Promise<boolean>,
  reset: () => void,
) {
  const latest = useRef({ scopeKey, load, reset });
  latest.current = { scopeKey, load, reset };
  const state = useRef({ mounted: false, generation: 0, pending: false });
  const inFlight = useRef<Promise<boolean> | null>(null);
  const refresh = useCallback((): Promise<boolean> => {
    // Read current document focus instead of retaining a blur flag across scope
    // changes. A focus event can be missed while lifecycle listeners are rebound.
    const active = () => state.current.mounted && document.hasFocus()
      && document.visibilityState !== 'hidden' && navigator.onLine;
    if (!active()) { return Promise.resolve(false); }
    if (inFlight.current) { return inFlight.current; }
    const scope = latest.current.scopeKey;
    const generation = state.current.generation;
    const isCurrent = () => active() && latest.current.scopeKey === scope && state.current.generation === generation;
    const request = Promise.resolve().then(() => latest.current.load(isCurrent)).catch(() => false).finally(() => {
      inFlight.current = null;
      if (state.current.pending) {
        state.current.pending = false;
        void refresh();
      }
    });
    inFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    state.current.mounted = true;
    state.current.generation += 1;
    latest.current.reset();
    if (inFlight.current) { state.current.pending = true; }
    else { void refresh(); }
    const resume = () => {
      if (inFlight.current) { state.current.pending = true; }
      void refresh();
    };
    const pause = () => { state.current.generation += 1; };
    const visibility = () => document.visibilityState === 'hidden' ? pause() : resume();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    window.addEventListener('focus', resume);
    window.addEventListener('blur', pause);
    window.addEventListener('online', resume);
    window.addEventListener('offline', pause);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      state.current.mounted = false;
      state.current.generation += 1;
      window.clearInterval(timer);
      window.removeEventListener('focus', resume);
      window.removeEventListener('blur', pause);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', pause);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [scopeKey, refresh]);

  return refresh;
}
