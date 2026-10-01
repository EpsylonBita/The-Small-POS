import { getBridge } from '../../lib';

/**
 * Local kitchen preparation stage (preparing / ready / collected) shared by the
 * Windows KDS, the central order views and the connected customer display.
 * Keyed by organization|branch|terminal scope and local order id, stored in the
 * `local` settings namespace, which Rust writes to SQLite without settings
 * events, terminal configuration sync, exports or the order outbox. Canonical
 * order status, payment state and closure are never changed from here:
 * "collected" means a waiter picked the order up from the kitchen.
 * Payload: order ids, phases and times only. Marks are never evicted by age or
 * count, so a ready order cannot resurrect while its canonical order is active.
 */
export type LocalPreparationPhase = 'preparing' | 'ready' | 'collected';

export interface LocalPreparationMark {
  phase: LocalPreparationPhase;
  at: string;
  /** Other identity keys of the same local order (cloud id, client order id). */
  refs?: readonly string[];
}

export type LocalPreparationState = Readonly<Record<string, LocalPreparationMark>>;

export interface LocalPreparationSnapshot {
  /** Active organization|branch|terminal scope; '' while signed out or unresolved. */
  readonly scope: string;
  /** Last good marks for `scope`; null until the first successful read. */
  readonly state: LocalPreparationState | null;
  /** Latest read failure. The last good state of the same scope is kept. */
  readonly error: string | null;
}

const STORAGE_CATEGORY = 'local';
const STORAGE_VERSION = 2;
const READABLE_VERSIONS = new Set<unknown>([1, 2]);
const PHASE_RANK: Record<LocalPreparationPhase, number> = { preparing: 1, ready: 2, collected: 3 };
const UNREADABLE = 'Stored kitchen state is unreadable';
const NOT_READY = 'Kitchen state is not loaded for this terminal';
const EMPTY_SNAPSHOT: LocalPreparationSnapshot = Object.freeze({ scope: '', state: null, error: null });
const ORDER_IDENTITY_KEYS = [
  'id',
  'supabase_id',
  'supabaseId',
  'client_order_id',
  'clientOrderId',
  'client_request_id',
  'clientRequestId',
] as const;

export class LocalPreparationStateError extends Error {}
/** The stored stage no longer matches what the caller saw: a stale, double or regressing action. */
export class LocalPreparationConflictError extends Error {}

export function localPreparationStorageKey(scope: string): string {
  return `kds_phase_${scope.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isPhase = (value: unknown): value is LocalPreparationPhase =>
  value === 'preparing' || value === 'ready' || value === 'collected';

const isRefs = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((ref) => typeof ref === 'string' && ref.length > 0);

/** Missing storage is an empty state; anything present but malformed is a failure, never an empty board. */
export function parseLocalPreparationState(raw: unknown, scope: string): LocalPreparationState {
  if (raw === null || raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new LocalPreparationStateError(UNREADABLE);
  }
  // A record written for another scope (sanitized key collision) is never read or overwritten.
  if (!isPlainObject(parsed) || !READABLE_VERSIONS.has(parsed['v']) || parsed['scope'] !== scope || !isPlainObject(parsed['marks'])) {
    throw new LocalPreparationStateError(UNREADABLE);
  }
  const marks: Record<string, LocalPreparationMark> = {};
  Object.entries(parsed['marks']).forEach(([orderId, value]) => {
    const mark = isPlainObject(value) ? value : null;
    const at = mark?.['at'];
    const refs = mark?.['refs'];
    if (
      !orderId ||
      !mark ||
      !isPhase(mark['phase']) ||
      typeof at !== 'string' ||
      !Number.isFinite(Date.parse(at)) ||
      (refs !== undefined && !isRefs(refs))
    ) {
      throw new LocalPreparationStateError(UNREADABLE);
    }
    marks[orderId] = refs && refs.length > 0 ? { phase: mark['phase'], at, refs: [...refs] } : { phase: mark['phase'], at };
  });
  return marks;
}

const markIndexes = new WeakMap<LocalPreparationState, Map<string, LocalPreparationMark>>();

// Stages only move forward, so when several marks name one order (it was marked
// under its local id and later under its cloud id) the furthest stage is its stage.
const isFurther = (mark: LocalPreparationMark, than: LocalPreparationMark | undefined): boolean =>
  !than || PHASE_RANK[mark.phase] > PHASE_RANK[than.phase];

function indexMarks(state: LocalPreparationState): Map<string, LocalPreparationMark> {
  let index = markIndexes.get(state);
  if (!index) {
    const built = new Map<string, LocalPreparationMark>();
    Object.entries(state).forEach(([orderId, mark]) =>
      [orderId, ...(mark.refs ?? [])].forEach((key) => {
        if (isFurther(mark, built.get(key))) built.set(key, mark);
      })
    );
    markIndexes.set(state, built);
    index = built;
  }
  return index;
}

/**
 * Finds the mark of an order by any of its identity keys (local id or alias).
 * Reads and `mark` resolve identity the same way: the furthest stage wins.
 */
export function findLocalPreparationMark(
  state: LocalPreparationState,
  keys: readonly string[]
): LocalPreparationMark | undefined {
  const index = indexMarks(state);
  let found: LocalPreparationMark | undefined;
  keys.forEach((key) => {
    const mark = key ? index.get(key) : undefined;
    if (mark && isFurther(mark, found)) found = mark;
  });
  return found;
}

const readText = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
};

export function getLocalPreparationIdentityKeys(order: unknown): string[] {
  if (!isPlainObject(order)) return [];
  return [...new Set(ORDER_IDENTITY_KEYS.map((key) => readText(order, key)).filter(Boolean))];
}

/**
 * Selector for central views: the local kitchen stage of an order row, or
 * undefined when the snapshot is unloaded, belongs to another scope, or the row
 * explicitly names another organization or branch.
 */
export function readLocalPreparationPhase(
  snapshot: LocalPreparationSnapshot,
  order: unknown,
  scope: string = snapshot.scope
): LocalPreparationPhase | undefined {
  if (!scope || snapshot.scope !== scope || !snapshot.state || !isPlainObject(order)) return undefined;
  const [organizationId, branchId] = scope.split('|');
  const rowOrganizationId = readText(order, 'organization_id') || readText(order, 'organizationId');
  const rowBranchId = readText(order, 'branch_id') || readText(order, 'branchId');
  if ((rowOrganizationId && rowOrganizationId !== organizationId) || (rowBranchId && rowBranchId !== branchId)) {
    return undefined;
  }
  return findLocalPreparationMark(snapshot.state, getLocalPreparationIdentityKeys(order))?.phase;
}

/**
 * One observable store for the whole renderer. Every read and write is
 * serialized and generation guarded, so a late read of a previous scope or
 * sign-in session can never publish or overwrite newer marks.
 */
export class LocalPreparationStore {
  private snapshot: LocalPreparationSnapshot = EMPTY_SNAPSHOT;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): LocalPreparationSnapshot => this.snapshot;

  private publish(snapshot: LocalPreparationSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(scope: string): Promise<LocalPreparationState> {
    const raw = await getBridge().settings.getLocal(`${STORAGE_CATEGORY}.${localPreparationStorageKey(scope)}`);
    return parseLocalPreparationState(raw, scope);
  }

  /** Selects the signed-in scope ('' signs out). A new scope starts unread, so nothing stale can show. */
  configure(scope: string): void {
    if (scope === this.snapshot.scope) return;
    this.generation += 1;
    this.publish(scope ? { scope, state: null, error: null } : EMPTY_SNAPSHOT);
    if (scope) void this.refresh(scope);
  }

  /** Re-reads the active scope. A failure keeps the last good state and records the error. */
  refresh(scope: string): Promise<void> {
    const generation = this.generation;
    return this.enqueue(async () => {
      if (!scope || scope !== this.snapshot.scope || generation !== this.generation) return;
      try {
        const state = await this.read(scope);
        if (generation === this.generation) this.publish({ scope, state, error: null });
      } catch (err) {
        if (generation !== this.generation) return;
        this.publish({ scope, state: this.snapshot.state, error: err instanceof Error ? err.message : UNREADABLE });
      }
    });
  }

  /**
   * Persists one forward stage change, then publishes it. `expected` is the stored
   * stage the caller saw (null for none); a mismatch or a non-forward step is
   * rejected. Storage is re-read first, so unreadable storage is never overwritten.
   */
  mark(
    scope: string,
    orderId: string,
    next: LocalPreparationPhase,
    expected: LocalPreparationPhase | null,
    refs: readonly string[] = []
  ): Promise<LocalPreparationState> {
    const generation = this.generation;
    return this.enqueue(async () => {
      if (!scope || !orderId || scope !== this.snapshot.scope || generation !== this.generation || !this.snapshot.state) {
        throw new LocalPreparationStateError(NOT_READY);
      }
      let base: LocalPreparationState;
      try {
        base = await this.read(scope);
      } catch (err) {
        if (generation === this.generation) {
          this.publish({ scope, state: this.snapshot.state, error: err instanceof Error ? err.message : UNREADABLE });
        }
        throw err;
      }
      if (generation !== this.generation) throw new LocalPreparationStateError(NOT_READY);
      // The stage is resolved by every identity of the order, exactly as views read it.
      const keys = [...new Set([orderId, ...refs].filter(Boolean))];
      const current = findLocalPreparationMark(base, keys)?.phase ?? null;
      if (current !== expected || (current !== null && PHASE_RANK[next] <= PHASE_RANK[current])) {
        throw new LocalPreparationConflictError('Kitchen stage changed before this action');
      }
      // Fold every mark of this order (by id or alias) into one forward mark under `orderId`.
      const state: Record<string, LocalPreparationMark> = { ...base };
      const aliases = new Set(refs);
      Object.entries(base).forEach(([key, mark]) => {
        if (!keys.includes(key) && !mark.refs?.some((ref) => keys.includes(ref))) return;
        delete state[key];
        aliases.add(key);
        mark.refs?.forEach((ref) => aliases.add(ref));
      });
      aliases.delete(orderId);
      aliases.delete('');
      const at = new Date().toISOString();
      state[orderId] = aliases.size > 0 ? { phase: next, at, refs: [...aliases] } : { phase: next, at };
      const result = await getBridge().settings.set({
        category: STORAGE_CATEGORY,
        key: localPreparationStorageKey(scope),
        value: JSON.stringify({ v: STORAGE_VERSION, scope, marks: state }),
      });
      if (result && typeof result === 'object' && (result as { success?: unknown }).success === false) {
        throw new LocalPreparationStateError('Kitchen state could not be saved');
      }
      if (generation === this.generation) this.publish({ scope, state, error: null });
      return state;
    });
  }

  /** Test helper: forgets scope, marks and pending work. */
  resetForTests(): void {
    this.generation += 1;
    this.queue = Promise.resolve();
    this.publish(EMPTY_SNAPSHOT);
  }
}

export const localPreparationStore = new LocalPreparationStore();
