/**
 * Durable local queue for provider ("platform") order cancellation notices.
 *
 * A provider (efood, Wolt, …) cancelling an order must stay visible to staff
 * until someone explicitly acknowledges it — it must never silently vanish
 * into the cancelled-orders list while the kitchen keeps preparing it. The
 * authoritative source of a *provider* cancellation is the admin endpoint
 * `GET /pos/platforms/cancellations` (see `platformCancellationNoticesApi.ts`);
 * this module only durably persists what that endpoint returned plus which
 * notice ids this terminal has acknowledged, so the pending queue survives an
 * app restart — including fully offline, since it never depends on a fresh
 * fetch to read what was already saved.
 *
 * Storage is namespaced per local terminal identity (org/branch/terminal) and
 * tagged with the server-derived `scope` of the last successful fetch. If the
 * server's scope changes (identity or visible-order-set shifted underneath
 * us), stored pending notices from the old scope are not carried forward —
 * they could describe orders this terminal can no longer see, so no leak
 * would be safe here; the terminal starts a clean scan under the new scope.
 *
 * All reads and writes go through a single serialized queue so a poll's
 * merge and a user's acknowledgement (or two overlapping polls) can never
 * interleave into a lost update.
 */

export interface PlatformCancellationNotice {
  id: string;
  order_number: string;
  platform: string;
  external_order_id: string | null;
  cancelled_at: string;
}

export interface CancellationNoticeIdentity {
  organizationId: string;
  branchId: string;
  terminalId: string;
}

interface StoredScopeState {
  scope: string;
  pending: PlatformCancellationNotice[];
  acks: Record<string, number>;
  updatedAt: number;
}

const STORAGE_PREFIX = 'pos:platform-cancellation-notices:v1';

/**
 * How long an acknowledged notice id is remembered so the same order
 * reappearing from the backend's 24h recovery window (or a repeated realtime
 * hint / poll) is never re-alerted. 30 days comfortably covers that 24h
 * window even if the notice's `updated_at` shifts; it is a documented bound,
 * not a claim that dedupe is exact beyond it.
 */
export const ACK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function hasLocalStorage(): boolean {
  // Reading `window.localStorage` itself (not just using it) can throw in
  // some restrictive/private-browsing contexts, so this getter access must
  // be inside its own try — a naive `!!window.localStorage` check can crash
  // before any caller's own try/catch is reached.
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

function storageKey(identity: CancellationNoticeIdentity): string | null {
  if (!identity.organizationId || !identity.branchId || !identity.terminalId) {
    return null;
  }
  return `${STORAGE_PREFIX}:${identity.organizationId}:${identity.branchId}:${identity.terminalId}`;
}

export function isValidPlatformCancellationNotice(value: unknown): value is PlatformCancellationNotice {
  if (!value || typeof value !== 'object') return false;
  const notice = value as Record<string, unknown>;
  return (
    typeof notice.id === 'string' &&
    notice.id.length > 0 &&
    typeof notice.order_number === 'string' &&
    typeof notice.platform === 'string' &&
    (notice.external_order_id === null || typeof notice.external_order_id === 'string') &&
    typeof notice.cancelled_at === 'string'
  );
}

function sortPending(pending: PlatformCancellationNotice[]): PlatformCancellationNotice[] {
  return [...pending].sort((a, b) => {
    const at = Date.parse(a.cancelled_at) || 0;
    const bt = Date.parse(b.cancelled_at) || 0;
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function pruneAcks(acks: Record<string, number>, now: number): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [id, ackedAt] of Object.entries(acks)) {
    if (typeof ackedAt === 'number' && now - ackedAt < ACK_RETENTION_MS) {
      next[id] = ackedAt;
    }
  }
  return next;
}

function readState(key: string): StoredScopeState | null {
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.scope !== 'string') {
    return null;
  }
  const pending = Array.isArray(parsed.pending)
    ? parsed.pending.filter(isValidPlatformCancellationNotice)
    : [];
  const acks =
    parsed.acks && typeof parsed.acks === 'object' && !Array.isArray(parsed.acks)
      ? (parsed.acks as Record<string, number>)
      : {};
  return {
    scope: parsed.scope,
    pending,
    acks,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
  };
}

function writeState(key: string, state: StoredScopeState): void {
  window.localStorage.setItem(key, JSON.stringify(state));
}

// Every exported operation runs through this chain, one at a time, so a
// merge from a poll response and an acknowledgement triggered by staff can
// never race each other into overwriting one another's write.
let writeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => T): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface LoadResult {
  /** The scope the restored pending queue belongs to, or null if nothing was stored. */
  scope: string | null;
  pending: PlatformCancellationNotice[];
  ackedIds: Set<string>;
  ok: boolean;
}

const EMPTY_LOAD_RESULT = (ok: boolean): LoadResult => ({
  scope: null,
  pending: [],
  ackedIds: new Set(),
  ok,
});

/** Restores whatever was last durably saved for this terminal identity — works fully offline. */
export function loadPendingNotices(identity: CancellationNoticeIdentity): Promise<LoadResult> {
  return serialized(() => {
    const key = storageKey(identity);
    if (!key) return EMPTY_LOAD_RESULT(true);
    if (!hasLocalStorage()) return EMPTY_LOAD_RESULT(false);
    try {
      const state = readState(key);
      if (!state) return EMPTY_LOAD_RESULT(true);
      return {
        scope: state.scope,
        pending: sortPending(state.pending),
        ackedIds: new Set(Object.keys(state.acks)),
        ok: true,
      };
    } catch {
      return EMPTY_LOAD_RESULT(false);
    }
  });
}

export interface WriteResult {
  pending: PlatformCancellationNotice[];
  ok: boolean;
}

/**
 * Merges a freshly-fetched page/batch of notices for `scope` into the
 * durable queue, deduping against notices already pending and against
 * acknowledged ids. If the stored scope differs from `scope`, the old
 * scope's pending notices are dropped first (see module doc). Always
 * persists before returning, satisfying "persist new pending before
 * acknowledging".
 */
export function mergeIncomingNotices(
  identity: CancellationNoticeIdentity,
  scope: string,
  incoming: readonly PlatformCancellationNotice[],
  now: number = Date.now(),
): Promise<WriteResult> {
  return serialized(() => {
    const key = storageKey(identity);
    if (!key || !hasLocalStorage()) return { pending: [], ok: false };
    try {
      const existing = readState(key);
      const scopeMatches = existing?.scope === scope;
      const basePending = scopeMatches ? existing!.pending : [];
      const acks = pruneAcks(scopeMatches ? existing!.acks : {}, now);

      const byId = new Map(basePending.map((notice) => [notice.id, notice]));
      for (const notice of incoming) {
        if (!isValidPlatformCancellationNotice(notice)) continue;
        if (acks[notice.id]) continue;
        byId.set(notice.id, notice);
      }
      const pending = sortPending(Array.from(byId.values()));

      writeState(key, { scope, pending, acks, updatedAt: now });
      return { pending, ok: true };
    } catch {
      return { pending: [], ok: false };
    }
  });
}

/**
 * Acknowledges one notice id under `scope`. The write removes the notice
 * from `pending` and records the ack id in the same atomic
 * `localStorage.setItem` call, so a crash can never observe the notice as
 * "acked" without also observing it removed (or vice versa) — there is no
 * window where a restart could re-show an already-acknowledged notice.
 *
 * Fails closed (no write) if the on-disk scope is missing or differs from
 * `scope`: that means something else (another poll, another tab) already
 * moved this terminal's storage to a different scope than the caller
 * believes it's looking at, and blindly writing here would either resurrect
 * an ack under the wrong scope or clobber newer on-disk pending/acks with
 * stale data. The caller must re-sync (re-poll/re-load) and retry.
 */
export function acknowledgeNotice(
  identity: CancellationNoticeIdentity,
  scope: string,
  noticeId: string,
  now: number = Date.now(),
): Promise<WriteResult> {
  return serialized(() => {
    const key = storageKey(identity);
    if (!key || !hasLocalStorage()) return { pending: [], ok: false };
    try {
      const existing = readState(key);
      if (!existing || existing.scope !== scope) {
        return { pending: existing?.pending ?? [], ok: false };
      }
      const acks = pruneAcks(existing.acks, now);
      acks[noticeId] = now;
      const pending = existing.pending.filter((notice) => notice.id !== noticeId);

      writeState(key, { scope, pending, acks, updatedAt: now });
      return { pending, ok: true };
    } catch {
      return { pending: [], ok: false };
    }
  });
}
