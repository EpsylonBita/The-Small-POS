import { useCallback, useEffect, useRef, useState } from 'react';
import { offEvent, onEvent } from '../../lib';
import { getResolvedTerminalIdentity } from '../services/terminal-credentials';
import {
  acknowledgeNotice,
  loadPendingNotices,
  mergeIncomingNotices,
  type CancellationNoticeIdentity,
  type PlatformCancellationNotice,
} from '../services/platformCancellationNoticeStore';
import { fetchAllCancellationNotices } from '../services/platformCancellationNoticesApi';

const POLL_INTERVAL_MS = 30_000;

const RECOGNIZED_NON_CANCEL_STATUSES = new Set([
  'pending',
  'confirmed',
  'accepted',
  'preparing',
  'ready',
  'ready_for_pickup',
  'out_for_delivery',
  'completed',
  'delivered',
  'paid',
  'refunded',
]);

/**
 * Native `order_realtime_update` / `order_status_updated` payloads are only a
 * read hint — sync.rs can emit them with an orderId-only fallback shape and
 * cancellation reason fields are not guaranteed to be present. So this never
 * trusts the payload's content as proof of a provider cancellation; it only
 * decides whether the payload is ambiguous/cancelled enough to justify
 * re-checking the authoritative endpoint. A recognized non-cancel status
 * skips the extra read; anything else (including an unrecognized or missing
 * status, or a payload we cannot read at all) triggers one.
 */
function isCancellationReadHint(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true;
  const status = (payload as Record<string, unknown>).status;
  if (typeof status !== 'string' || !status.trim()) return true;
  const normalized = status.trim().toLowerCase();
  if (normalized === 'cancelled' || normalized === 'canceled') return true;
  return !RECOGNIZED_NON_CANCEL_STATUSES.has(normalized);
}

function identitiesEqual(
  a: CancellationNoticeIdentity | null,
  b: CancellationNoticeIdentity | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.organizationId === b.organizationId &&
    a.branchId === b.branchId &&
    a.terminalId === b.terminalId
  );
}

function hasStableIdentity(identity: CancellationNoticeIdentity | null): identity is CancellationNoticeIdentity {
  return !!identity && !!identity.organizationId && !!identity.branchId && !!identity.terminalId;
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function dedupeById(notices: readonly PlatformCancellationNotice[]): PlatformCancellationNotice[] {
  const seen = new Set<string>();
  const out: PlatformCancellationNotice[] = [];
  for (const notice of notices) {
    if (seen.has(notice.id)) continue;
    seen.add(notice.id);
    out.push(notice);
  }
  return out;
}

export interface UseCancellationNoticesResult {
  /** The oldest unacknowledged notice, or null when the queue is empty. */
  current: PlatformCancellationNotice | null;
  /** Total unacknowledged notices, including `current`. */
  queueLength: number;
  /** True while an acknowledgement write is in flight for `current`. */
  acknowledging: boolean;
  /** True when the last acknowledgement attempt for `current` failed to persist and should be retried. */
  acknowledgeFailed: boolean;
  /**
   * True when `current` was discovered but could not yet be durably saved
   * (e.g. storage quota/error). It still must be shown — a discovered
   * cancellation must never be silently invisible — but acknowledging it is
   * blocked until a retry durably persists it, so an ack can never be lost.
   */
  persistPending: boolean;
  acknowledge: () => void;
  /** Retries persisting/refreshing when `persistPending` is true. */
  retry: () => void;
}

/**
 * Orchestrates the provider-cancellation notice queue for this terminal:
 * identity resolution, durable offline restore, the authoritative poll
 * (startup / online / visible / 30s cadence, coalesced against realtime
 * hints), and acknowledgement. Enabled only while `enabled` is true (staff
 * authenticated with a resolvable terminal identity); disabling hides the
 * queue immediately without touching acknowledgement state on disk.
 */
export function useCancellationNotices(enabled: boolean): UseCancellationNoticesResult {
  const [durablePending, setDurablePending] = useState<PlatformCancellationNotice[]>([]);
  const [undurable, setUndurable] = useState<PlatformCancellationNotice[]>([]);
  const [acknowledging, setAcknowledging] = useState(false);
  const [acknowledgeFailed, setAcknowledgeFailed] = useState(false);

  const identityRef = useRef<CancellationNoticeIdentity | null>(null);
  const scopeRef = useRef<string | null>(null);
  const resumeCursorRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const pollInFlightRef = useRef(false);
  const trailingPollRequestedRef = useRef(false);
  const trailingTimeoutRef = useRef<number | null>(null);
  const ackInFlightRef = useRef(false);
  const durablePendingRef = useRef<PlatformCancellationNotice[]>([]);
  durablePendingRef.current = durablePending;

  const clearTrailingTimeout = useCallback(() => {
    if (trailingTimeoutRef.current !== null) {
      window.clearTimeout(trailingTimeoutRef.current);
      trailingTimeoutRef.current = null;
    }
    trailingPollRequestedRef.current = false;
  }, []);

  const resetForNewIdentity = useCallback(() => {
    generationRef.current += 1;
    scopeRef.current = null;
    resumeCursorRef.current = null;
    ackInFlightRef.current = false;
    clearTrailingTimeout();
    setDurablePending([]);
    setUndurable([]);
    setAcknowledging(false);
    setAcknowledgeFailed(false);
  }, [clearTrailingTimeout]);

  const poll = useCallback(() => {
    // Re-validated here (not only by the timer/callers that schedule this),
    // since `poll` can also run from a deferred trailing timeout or an
    // event handler well after the conditions that originally triggered it.
    if (!enabled || !mountedRef.current) return;
    if (!hasStableIdentity(identityRef.current)) return;
    if (!isOnline()) return;

    if (pollInFlightRef.current) {
      trailingPollRequestedRef.current = true;
      return;
    }
    pollInFlightRef.current = true;
    const generation = generationRef.current;
    const identity = identityRef.current;
    const startCursor = resumeCursorRef.current;

    void (async () => {
      // Only auto-continue immediately for a scan that hit the page cap
      // while otherwise healthy (`ok: true`); a hard failure (offline,
      // malformed response, scope churn) instead waits for the next
      // natural trigger (online/visible/30s) so a persistent failure can
      // never hot-loop requests against the backend.
      let continueNow = false;
      try {
        const result = await fetchAllCancellationNotices(startCursor);
        if (generation !== generationRef.current || !mountedRef.current) return;
        continueNow = result.ok && result.incomplete;

        if (!result.scope) {
          resumeCursorRef.current = result.resumeCursor;
          return;
        }

        const scopeChanged = scopeRef.current !== null && scopeRef.current !== result.scope;
        if (scopeChanged) {
          // Hide the old scope's queue immediately and invalidate any older
          // in-flight ack/read tied to the previous generation *before*
          // attempting the merge — the old notices are no longer valid for
          // this terminal and must never linger on screen while we merge.
          generationRef.current += 1;
          setDurablePending([]);
          setUndurable([]);
        }
        const mergeGeneration = generationRef.current;
        const merged = await mergeIncomingNotices(identity, result.scope, result.notices);
        if (mergeGeneration !== generationRef.current || !mountedRef.current) return;

        if (merged.ok) {
          // Only commit the new scope once its data is durably persisted —
          // never point `scopeRef` at a scope whose queue failed to save,
          // which would otherwise desync `scopeRef` from what's displayed.
          scopeRef.current = result.scope;
          setDurablePending(merged.pending);
          setUndurable([]);
          resumeCursorRef.current = scopeChanged ? null : result.resumeCursor;
        } else {
          // Persistence failed: the freshly-read notices must still surface
          // to staff — a cancellation must never be silently invisible —
          // but they are not safely stored, so acknowledging is blocked
          // until a retry durably saves them. Re-read the last known-good
          // durable state (read-only, does not write) rather than trusting
          // this failed attempt, and never erase already-known pending.
          resumeCursorRef.current = null;
          let known = new Set<string>();
          try {
            const restored = await loadPendingNotices(identity);
            if (mergeGeneration !== generationRef.current || !mountedRef.current) return;
            if (restored.ok) {
              setDurablePending(restored.pending);
              known = new Set([...restored.pending.map((n) => n.id), ...restored.ackedIds]);
            } else {
              known = new Set(durablePendingRef.current.map((n) => n.id));
            }
          } catch {
            known = new Set(durablePendingRef.current.map((n) => n.id));
          }
          setUndurable(dedupeById(result.notices.filter((n) => !known.has(n.id))));
        }
      } catch {
        // Never let an unexpected rejection crash the poll loop or the
        // caller; treat it like any other failed cycle and retry later.
      } finally {
        pollInFlightRef.current = false;
        const shouldContinue = mountedRef.current && enabled && (trailingPollRequestedRef.current || continueNow);
        trailingPollRequestedRef.current = false;
        if (shouldContinue) {
          // Coalesce anything that arrived while this cycle was in flight —
          // or finish a scan that hit the page cap / a transient bad
          // response — into exactly one follow-up cycle, not a burst.
          trailingTimeoutRef.current = window.setTimeout(() => {
            trailingTimeoutRef.current = null;
            poll();
          }, 0);
        }
      }
    })();
  }, [enabled]);

  // Mount/unmount bookkeeping: invalidate any in-flight async work and
  // cancel a scheduled trailing poll the moment this hook goes away, so an
  // older poll's `finally` can never launch a stale follow-up after logout.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      clearTrailingTimeout();
    };
  }, [clearTrailingTimeout]);

  // Identity resolution + offline restore + credential-change handling.
  useEffect(() => {
    if (!enabled) {
      identityRef.current = null;
      resetForNewIdentity();
      return;
    }

    let cancelled = false;

    const resolveIdentity = async () => {
      let resolved: CancellationNoticeIdentity | null = null;
      try {
        resolved = await getResolvedTerminalIdentity();
      } catch {
        resolved = null;
      }
      if (cancelled) return;
      const nextIdentity: CancellationNoticeIdentity | null = hasStableIdentity(resolved)
        ? resolved
        : null;
      if (identitiesEqual(identityRef.current, nextIdentity)) return;

      identityRef.current = nextIdentity;
      resetForNewIdentity();
      if (!nextIdentity) return;

      const generation = generationRef.current;
      try {
        const restored = await loadPendingNotices(nextIdentity);
        if (cancelled || generation !== generationRef.current || !mountedRef.current) return;
        if (restored.ok) {
          scopeRef.current = restored.scope;
          setDurablePending(restored.pending);
        }
      } catch {
        // Fail-safe: a restore failure must not erase whatever state is
        // already displayed (there is none yet for a freshly-resolved
        // identity), and must not block the poll below from trying fresh.
      }
      // A fully offline restart must show whatever was durably saved above
      // without ever attempting a network fetch; only poll while online.
      if (!cancelled && mountedRef.current && isOnline()) poll();
    };

    // Real identity changes (terminal reconfigured without a full logout)
    // must hide the previous identity's queue synchronously, before the
    // async re-resolution below even starts — otherwise the old identity's
    // notices could remain visible for the duration of that await.
    const handleCredentialsChanged = () => {
      identityRef.current = null;
      resetForNewIdentity();
      void resolveIdentity();
    };

    void resolveIdentity();
    onEvent('terminal-credentials-updated', handleCredentialsChanged);

    return () => {
      cancelled = true;
      offEvent('terminal-credentials-updated', handleCredentialsChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Lifecycle triggers: startup poll happens above once identity resolves;
  // this covers reconnect/visibility/cadence and never overlaps a poll.
  useEffect(() => {
    if (!enabled) return;

    const handleOnline = () => poll();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) poll();
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) poll();
    }, POLL_INTERVAL_MS);

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(interval);
    };
  }, [enabled, poll]);

  // Realtime read hints. `order-status-updated` is a real mapped channel too
  // (see `lib/event-bridge.ts`); both are treated identically here. Payloads
  // are only ever a hint to re-check the authoritative endpoint (see
  // `isCancellationReadHint`), never trusted as proof of a cancellation.
  useEffect(() => {
    if (!enabled) return;

    const handleHint = (payload: unknown) => {
      if (isCancellationReadHint(payload)) poll();
    };

    onEvent('order-realtime-update', handleHint);
    onEvent('order-status-updated', handleHint);

    return () => {
      offEvent('order-realtime-update', handleHint);
      offEvent('order-status-updated', handleHint);
    };
  }, [enabled, poll]);

  const acknowledge = useCallback(() => {
    // Synchronous guard against a double click/invocation racing ahead of
    // the `acknowledging` state flushing to a re-render.
    if (ackInFlightRef.current) return;
    const identity = identityRef.current;
    const scope = scopeRef.current;
    const notice = durablePendingRef.current[0];
    // Never acknowledge a notice that isn't confirmed durably stored yet
    // (see `undurable`/`persistPending`) — acknowledging must always start
    // from a queue that was already safely persisted.
    if (!identity || !scope || !notice) return;

    ackInFlightRef.current = true;
    const generation = generationRef.current;
    setAcknowledging(true);
    setAcknowledgeFailed(false);

    void (async () => {
      try {
        const result = await acknowledgeNotice(identity, scope, notice.id);
        if (generation !== generationRef.current || !mountedRef.current) return;
        setAcknowledging(false);
        if (!result.ok) {
          setAcknowledgeFailed(true);
          return;
        }
        setDurablePending(result.pending);
      } catch {
        if (generation === generationRef.current && mountedRef.current) {
          setAcknowledging(false);
          setAcknowledgeFailed(true);
        }
      } finally {
        ackInFlightRef.current = false;
      }
    })();
  }, []);

  const retry = useCallback(() => {
    poll();
  }, [poll]);

  const current = durablePending[0] ?? undurable[0] ?? null;
  const persistPending = durablePending.length === 0 && undurable.length > 0;

  return {
    current,
    queueLength: durablePending.length + undurable.length,
    acknowledging,
    acknowledgeFailed,
    persistPending,
    acknowledge,
    retry,
  };
}
