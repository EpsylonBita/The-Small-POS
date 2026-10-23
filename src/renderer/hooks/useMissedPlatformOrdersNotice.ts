/**
 * Platform (efood/Wolt) orders the server declined while this till was
 * offline. Desktop parity with Android's `MissedPlatformOrdersNotice.ts`
 * (offline week Ω6, 22/10/2026).
 *
 * When the till's heartbeat is more than 3 minutes old, the server declines
 * every incoming platform order as `terminal_offline`: cleanly for the
 * customer, but silently for the shop. This hook turns that lost revenue into
 * a visible notice: once at startup (the till was closed) and each time the
 * connection comes back.
 *
 * - The same rows as Android's read: orders of this terminal's organization
 *   and branch, `status = cancelled`, `cancellation_reason = terminal_offline`,
 *   with an external platform id, created after the look-back start (at most
 *   1000). Android reads Supabase directly; the desktop renderer has no
 *   terminal-authorized Supabase read, so it asks the terminal-authenticated
 *   `GET /api/pos/platforms/missed-orders?since=` (server counterpart, W3a
 *   request C2). The server scopes it to the terminal; the renderer never names
 *   an organization or a branch. Until that route exists the check fails
 *   silently and keeps its watermark.
 * - The watermark is the start of the last check the server answered, so it
 *   stays at the till's last online moment for the whole outage. The look-back
 *   is capped at 8 days; without a usable watermark it is 12 h (Android's rule
 *   after the offline week, W6).
 * - A failed check, or a saved copy of an older answer, is silent and leaves
 *   the watermark alone, so the next one asks again. Read-only: it never
 *   changes an order.
 */
import { useEffect, useRef } from 'react';
import { isBrowser } from '../../lib';
import { posApiGet } from '../utils/api-helpers';
import { isTillKnownOffline, subscribeConnectivityRestored } from '../services/server-reachability';

/** Terminal-authenticated read of the declines (server counterpart, not yet deployed). */
export const MISSED_PLATFORM_ORDERS_ENDPOINT = 'pos/platforms/missed-orders';
export const MISSED_PLATFORM_ORDERS_CHECKED_AT_KEY = 'pos.missedPlatformOrders.checkedAt.v1';
/** Never look further back than this (Android's cap). */
export const MISSED_PLATFORM_ORDERS_MAX_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;
/** The look-back without a usable watermark (Android's first-check window). */
export const MISSED_PLATFORM_ORDERS_DEFAULT_LOOKBACK_MS = 12 * 60 * 60 * 1000;
/** A check that succeeded this recently is not repeated (Android's rate limit). */
export const MISSED_PLATFORM_ORDERS_MIN_CHECK_INTERVAL_MS = 60 * 1000;

export interface MissedPlatformOrder {
  id: string;
  order_number: string | null;
  platform: string | null;
  total_amount: number | null;
}

export interface MissedPlatformOrdersResult {
  orders: MissedPlatformOrder[];
  count: number;
  total: number;
}

export interface MissedPlatformOrdersDeps {
  now: () => number;
  readCheckedAt: () => string | null;
  writeCheckedAt: (iso: string) => void;
  fetchDeclined: (sinceIso: string) => Promise<unknown>;
}

/**
 * The start of the look-back: the stored watermark, capped at 8 days. A
 * missing, unreadable or future watermark (the clock moved back) looks back
 * 12 h, as on Android.
 */
export function missedPlatformOrdersSince(storedCheckedAt: string | null, nowMs: number): string {
  const parsed = storedCheckedAt ? Date.parse(storedCheckedAt) : Number.NaN;
  const since = Number.isFinite(parsed) && parsed <= nowMs
    ? Math.max(parsed, nowMs - MISSED_PLATFORM_ORDERS_MAX_LOOKBACK_MS)
    : nowMs - MISSED_PLATFORM_ORDERS_DEFAULT_LOOKBACK_MS;
  return new Date(since).toISOString();
}

function readOrder(raw: unknown): MissedPlatformOrder | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id) {
    return null;
  }
  const total = typeof row.total_amount === 'number'
    ? row.total_amount
    : typeof row.total_amount === 'string' ? Number(row.total_amount) : Number.NaN;
  return {
    id: row.id,
    order_number: typeof row.order_number === 'string' ? row.order_number : null,
    platform: typeof row.platform === 'string' ? row.platform : null,
    total_amount: Number.isFinite(total) ? total : null,
  };
}

/**
 * One check. Null when it failed (the watermark is not moved); otherwise the
 * declines since the watermark, which then moves to this check's start.
 */
export async function checkMissedPlatformOrders(
  deps: MissedPlatformOrdersDeps,
): Promise<MissedPlatformOrdersResult | null> {
  const startedAt = deps.now();
  const sinceIso = missedPlatformOrdersSince(deps.readCheckedAt(), startedAt);

  let response: unknown;
  try {
    response = await deps.fetchDeclined(sinceIso);
  } catch {
    return null;
  }
  const body = response as { success?: unknown; orders?: unknown } | null;
  if (!body || body.success !== true || !Array.isArray(body.orders)) {
    return null;
  }

  // Moved whether or not anything was missed, so each decline is announced once.
  deps.writeCheckedAt(new Date(startedAt).toISOString());

  const orders = body.orders
    .map(readOrder)
    .filter((order): order is MissedPlatformOrder => order !== null);
  const total = orders.reduce((sum, order) => sum + (order.total_amount ?? 0), 0);
  return { orders, count: orders.length, total };
}

function readStoredCheckedAt(): string | null {
  try {
    return localStorage.getItem(MISSED_PLATFORM_ORDERS_CHECKED_AT_KEY);
  } catch {
    return null;
  }
}

function writeStoredCheckedAt(iso: string): void {
  try {
    localStorage.setItem(MISSED_PLATFORM_ORDERS_CHECKED_AT_KEY, iso);
  } catch {
    // Storage unavailable: the next check looks back to the cap again.
  }
}

/**
 * Asks the server. A refusal, a missing route, a transport failure or a saved
 * copy of an older answer (the native GET fallback while offline) is "no
 * answer": the watermark must only move on a fresh server read.
 */
async function fetchDeclinedFromServer(sinceIso: string): Promise<unknown> {
  const result = await posApiGet<unknown>(
    `${MISSED_PLATFORM_ORDERS_ENDPOINT}?since=${encodeURIComponent(sinceIso)}`,
  );
  if (!result.success || result.stale === true || result.source === 'cache') {
    return null;
  }
  return result.data ?? null;
}

export const defaultMissedPlatformOrdersDeps: MissedPlatformOrdersDeps = {
  now: () => Date.now(),
  readCheckedAt: readStoredCheckedAt,
  writeCheckedAt: writeStoredCheckedAt,
  fetchDeclined: fetchDeclinedFromServer,
};

/**
 * Runs the check at start and each time the connection comes back, and calls
 * `onMissed` when declines were found. Off in a plain browser (no native
 * side) and while `enabled` is false.
 */
export function useMissedPlatformOrdersNotice(
  enabled: boolean,
  onMissed: (result: MissedPlatformOrdersResult) => void,
  deps: MissedPlatformOrdersDeps = defaultMissedPlatformOrdersDeps,
): void {
  const notifyRef = useRef(onMissed);
  notifyRef.current = onMissed;
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    if (!enabled || isBrowser()) {
      return undefined;
    }
    let cancelled = false;
    let checking = false;
    let rerun = false;
    let lastSucceededAt = Number.NEGATIVE_INFINITY;

    const run = async (): Promise<void> => {
      if (cancelled) return;
      if (checking) {
        // A reconnect while a check is running: ask once more after it.
        rerun = true;
        return;
      }
      if (isTillKnownOffline()) {
        // Nothing to ask now; the reconnection runs the check.
        return;
      }
      const current = depsRef.current;
      if (current.now() - lastSucceededAt < MISSED_PLATFORM_ORDERS_MIN_CHECK_INTERVAL_MS) {
        return;
      }
      checking = true;
      try {
        const result = await checkMissedPlatformOrders(current);
        if (result) {
          lastSucceededAt = current.now();
        }
        if (!cancelled && result && result.count > 0) {
          notifyRef.current(result);
        }
      } finally {
        checking = false;
      }
      if (rerun && !cancelled) {
        rerun = false;
        await run();
      }
    };

    void run();
    const unsubscribe = subscribeConnectivityRestored(() => {
      void run();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);
}
