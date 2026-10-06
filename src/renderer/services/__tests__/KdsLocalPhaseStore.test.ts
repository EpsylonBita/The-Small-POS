import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  settings: {
    getLocal: vi.fn(async (_key: string): Promise<string | null> => null),
    set: vi.fn(async (_update: any): Promise<any> => ({ success: true })),
  },
}));
vi.mock('../../../lib', () => ({ getBridge: () => bridge }));
import {
  LocalPreparationConflictError,
  LocalPreparationStateError,
  LocalPreparationStore,
  localPreparationStorageKey,
  parseLocalPreparationState,
  readLocalPreparationPhase,
} from '../KdsLocalPhaseStore';

const SCOPE = 'org|branch|terminal';
const SCOPE_2 = 'org|branch|terminal-2';
const KEY = 'local.kds_phase_org_branch_terminal';
const storage = new Map<string, string>();
const stored = (marks: Record<string, unknown>, scope = SCOPE, v = 2) => JSON.stringify({ v, scope, marks });
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
// A refresh of '' is a queued no-op: awaiting it drains every earlier read and write.
const idle = (store: LocalPreparationStore) => store.refresh('');

async function loadedStore(scope = SCOPE) {
  const store = new LocalPreparationStore();
  store.configure(scope);
  await idle(store);
  return store;
}

beforeEach(() => {
  storage.clear();
  bridge.settings.getLocal.mockReset().mockImplementation(async (key: string) => storage.get(key) ?? null);
  bridge.settings.set.mockReset().mockImplementation(async ({ category, key, value }: any) => {
    storage.set(`${category}.${key}`, value);
    return { success: true };
  });
});

describe('parseLocalPreparationState', () => {
  it('treats missing storage as empty and rejects anything present but malformed', () => {
    expect(parseLocalPreparationState(null, SCOPE)).toEqual({});
    expect(parseLocalPreparationState(undefined, SCOPE)).toEqual({});
    const at = new Date().toISOString();
    for (const raw of [
      '',
      '   ',
      '{broken',
      '42',
      '[]',
      JSON.stringify({ v: 3, scope: SCOPE, marks: {} }),
      JSON.stringify({ v: 2, scope: SCOPE }),
      JSON.stringify({ v: 2, scope: SCOPE, marks: [] }),
      stored({}, 'org|branch|other'),
      stored({ a: { phase: 'completed', at } }),
      stored({ a: { phase: 'ready' } }),
      stored({ a: { phase: 'ready', at: 'yesterday' } }),
      stored({ a: { phase: 'ready', at, refs: [''] } }),
      stored({ a: 'ready' }),
    ]) {
      expect(() => parseLocalPreparationState(raw, SCOPE), raw).toThrow(LocalPreparationStateError);
    }
  });

  it('reads version 1 marks and all three stages', () => {
    const at = '2026-01-01T00:00:00.000Z';
    expect(parseLocalPreparationState(stored({ a: { phase: 'ready', at } }, SCOPE, 1), SCOPE)).toEqual({ a: { phase: 'ready', at } });
    expect(parseLocalPreparationState(stored({ a: { phase: 'collected', at, refs: ['c'] }, b: { phase: 'preparing', at } }), SCOPE))
      .toEqual({ a: { phase: 'collected', at, refs: ['c'] }, b: { phase: 'preparing', at } });
  });
});

describe('LocalPreparationStore', () => {
  it('keeps every mark regardless of age or count (no eviction can resurrect a ready order)', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`order-${index}`, { phase: 'ready', at: old }]));
    storage.set(KEY, stored(many));
    const store = await loadedStore();
    expect(Object.keys(store.getSnapshot().state!)).toHaveLength(501);
    await store.mark(SCOPE, 'order-new', 'preparing', null);
    const persisted = JSON.parse(storage.get(KEY)!);
    expect(Object.keys(persisted.marks)).toHaveLength(502);
    expect(persisted.marks['order-0']).toEqual({ phase: 'ready', at: old });
    expect(persisted.marks['order-500']).toEqual({ phase: 'ready', at: old });
  });

  it('moves forward only from the stage the caller saw, rejecting stale and double actions', async () => {
    const store = await loadedStore();
    await store.mark(SCOPE, 'o1', 'preparing', null, ['cloud-1', 'o1', '']);
    await store.mark(SCOPE, 'o1', 'ready', 'preparing');
    await expect(store.mark(SCOPE, 'o1', 'ready', 'preparing')).rejects.toBeInstanceOf(LocalPreparationConflictError);
    await expect(store.mark(SCOPE, 'o1', 'preparing', 'ready')).rejects.toBeInstanceOf(LocalPreparationConflictError);
    await store.mark(SCOPE, 'o1', 'collected', 'ready');
    await expect(store.mark(SCOPE, 'o1', 'collected', 'collected')).rejects.toBeInstanceOf(LocalPreparationConflictError);
    expect(bridge.settings.set).toHaveBeenCalledTimes(3);
    // Order ids, stages, times and identity aliases only: no customer, payment or cart data.
    expect(JSON.parse(storage.get(KEY)!)).toEqual({
      v: 2,
      scope: SCOPE,
      marks: { o1: { phase: 'collected', at: expect.any(String), refs: ['cloud-1'] } },
    });
  });

  it('persists in the local settings namespace and restores ready and collected stages after a restart', async () => {
    const store = await loadedStore();
    await store.mark(SCOPE, 'o1', 'preparing', null);
    await store.mark(SCOPE, 'o1', 'ready', 'preparing');
    await store.mark(SCOPE, 'o2', 'ready', null);
    await store.mark(SCOPE, 'o2', 'collected', 'ready');
    expect(bridge.settings.set.mock.calls.every(([update]) => update.category === 'local' && update.key === 'kds_phase_org_branch_terminal')).toBe(true);
    const restarted = await loadedStore();
    expect(restarted.getSnapshot()).toEqual({
      scope: SCOPE,
      state: { o1: { phase: 'ready', at: expect.any(String) }, o2: { phase: 'collected', at: expect.any(String) } },
      error: null,
    });
  });

  it('publishes a mark only after it is persisted and never publishes a failed write', async () => {
    const store = await loadedStore();
    const seen: string[] = [];
    store.subscribe(() => seen.push(storage.has(KEY) ? 'persisted' : 'unsaved'));
    const before = store.getSnapshot();
    bridge.settings.set.mockResolvedValueOnce({ success: false, error: 'disk full' });
    await expect(store.mark(SCOPE, 'o1', 'preparing', null)).rejects.toBeInstanceOf(LocalPreparationStateError);
    bridge.settings.set.mockRejectedValueOnce(new Error('ipc down'));
    await expect(store.mark(SCOPE, 'o1', 'preparing', null)).rejects.toThrow('ipc down');
    expect(store.getSnapshot()).toBe(before);
    expect(seen).toEqual([]);
    await store.mark(SCOPE, 'o1', 'preparing', null);
    expect(seen).toEqual(['persisted']);
    expect(store.getSnapshot().state).toEqual({ o1: { phase: 'preparing', at: expect.any(String) } });
  });

  it('fails closed on a first read failure and keeps the last good state on later failures', async () => {
    bridge.settings.getLocal.mockRejectedValueOnce(new Error('database locked'));
    const store = await loadedStore();
    expect(store.getSnapshot()).toEqual({ scope: SCOPE, state: null, error: 'database locked' });
    await expect(store.mark(SCOPE, 'o1', 'preparing', null)).rejects.toBeInstanceOf(LocalPreparationStateError);
    expect(bridge.settings.set).not.toHaveBeenCalled();

    await store.refresh(SCOPE);
    expect(store.getSnapshot()).toEqual({ scope: SCOPE, state: {}, error: null });
    await store.mark(SCOPE, 'o1', 'preparing', null);
    const good = store.getSnapshot().state;

    storage.set(KEY, 'not json');
    await store.refresh(SCOPE);
    expect(store.getSnapshot()).toEqual({ scope: SCOPE, state: good, error: 'Stored kitchen state is unreadable' });
    // Unreadable storage is never overwritten by an action.
    await expect(store.mark(SCOPE, 'o1', 'ready', 'preparing')).rejects.toBeInstanceOf(LocalPreparationStateError);
    expect(storage.get(KEY)).toBe('not json');
    expect(store.getSnapshot().state).toBe(good);
  });

  it('retains collected state and refuses writes when persisted storage becomes blank', async () => {
    storage.set(KEY, stored({ o1: { phase: 'collected', at: new Date().toISOString() } }));
    const store = await loadedStore();
    const good = store.getSnapshot().state;
    storage.set(KEY, '');
    await store.refresh(SCOPE);
    expect(store.getSnapshot()).toEqual({ scope: SCOPE, state: good, error: 'Stored kitchen state is unreadable' });
    await expect(store.mark(SCOPE, 'o2', 'preparing', null)).rejects.toBeInstanceOf(LocalPreparationStateError);
    expect(bridge.settings.set).not.toHaveBeenCalled();
    expect(storage.get(KEY)).toBe('');
    expect(store.getSnapshot().state).toBe(good);
  });

  it('ignores a delayed read of a previous scope, rejects its actions and clears on sign-out', async () => {
    storage.set(KEY, stored({ o1: { phase: 'ready', at: new Date().toISOString() } }));
    let release!: () => void;
    bridge.settings.getLocal.mockImplementationOnce((key: string) => new Promise((resolve) => {
      release = () => resolve(storage.get(key) ?? null);
    }));
    const store = new LocalPreparationStore();
    store.configure(SCOPE);
    await settle();
    store.configure(SCOPE_2);
    release();
    await idle(store);
    expect(store.getSnapshot()).toEqual({ scope: SCOPE_2, state: {}, error: null });
    await expect(store.mark(SCOPE, 'o1', 'collected', 'ready')).rejects.toBeInstanceOf(LocalPreparationStateError);
    await store.mark(SCOPE_2, 'o9', 'preparing', null);
    expect(JSON.parse(storage.get('local.kds_phase_org_branch_terminal-2')!).marks).toEqual({ o9: expect.objectContaining({ phase: 'preparing' }) });
    expect(JSON.parse(storage.get(KEY)!).marks).toEqual({ o1: expect.objectContaining({ phase: 'ready' }) });
    store.configure('');
    expect(store.getSnapshot()).toEqual({ scope: '', state: null, error: null });
    await expect(store.mark(SCOPE_2, 'o9', 'ready', 'preparing')).rejects.toBeInstanceOf(LocalPreparationStateError);
  });

  it('resolves and folds an order marked under its local id and later under its cloud id', async () => {
    const store = await loadedStore();
    await store.mark(SCOPE, 'local-1', 'ready', null, ['client-1']);
    // The same order now reaches the kitchen under its cloud id: its stored stage is still found by alias.
    await expect(store.mark(SCOPE, 'cloud-1', 'collected', null, ['local-1', 'client-1'])).rejects.toBeInstanceOf(LocalPreparationConflictError);
    await store.mark(SCOPE, 'cloud-1', 'collected', 'ready', ['local-1', 'client-1']);
    const marks = JSON.parse(storage.get(KEY)!).marks;
    expect(Object.keys(marks)).toEqual(['cloud-1']);
    expect(marks['cloud-1']).toEqual({ phase: 'collected', at: expect.any(String), refs: expect.arrayContaining(['local-1', 'client-1']) });
    const restarted = await loadedStore();
    for (const id of ['local-1', 'cloud-1', 'client-1']) expect(readLocalPreparationPhase(restarted.getSnapshot(), { id })).toBe('collected');
    await expect(restarted.mark(SCOPE, 'local-1', 'ready', 'collected')).rejects.toBeInstanceOf(LocalPreparationConflictError);
  });

  it('reads the furthest stage when older marks name one order under two ids', async () => {
    const at = new Date().toISOString();
    storage.set(KEY, stored({ 'local-1': { phase: 'ready', at }, 'cloud-1': { phase: 'collected', at, refs: ['local-1'] } }));
    const store = await loadedStore();
    expect(readLocalPreparationPhase(store.getSnapshot(), { id: 'local-1' })).toBe('collected');
    expect(readLocalPreparationPhase(store.getSnapshot(), { id: 'local-1', supabase_id: 'cloud-1' })).toBe('collected');
    await expect(store.mark(SCOPE, 'local-1', 'collected', 'ready')).rejects.toBeInstanceOf(LocalPreparationConflictError);
    expect(bridge.settings.set).not.toHaveBeenCalled();
  });

  it('sanitizes storage keys', () => {
    expect(localPreparationStorageKey('o r/g|b.x|t')).toBe('kds_phase_o_r_g_b_x_t');
  });
});

describe('readLocalPreparationPhase', () => {
  it('matches local ids and aliases in scope and ignores other organizations, branches and scopes', async () => {
    const store = await loadedStore();
    await store.mark(SCOPE, 'local-1', 'ready', null, ['cloud-1']);
    const snapshot = store.getSnapshot();
    expect(readLocalPreparationPhase(snapshot, { id: 'local-1', status: 'pending' })).toBe('ready');
    expect(readLocalPreparationPhase(snapshot, { id: 'cloud-1', supabase_id: 'cloud-1' })).toBe('ready');
    expect(readLocalPreparationPhase(snapshot, { id: 'local-1', organization_id: 'org', branch_id: 'branch' })).toBe('ready');
    expect(readLocalPreparationPhase(snapshot, { id: 'local-1', organization_id: 'other-org' })).toBeUndefined();
    expect(readLocalPreparationPhase(snapshot, { id: 'local-1', branchId: 'other-branch' })).toBeUndefined();
    expect(readLocalPreparationPhase(snapshot, { id: 'local-1' }, SCOPE_2)).toBeUndefined();
    expect(readLocalPreparationPhase({ scope: SCOPE, state: null, error: 'x' }, { id: 'local-1' })).toBeUndefined();
  });
});
