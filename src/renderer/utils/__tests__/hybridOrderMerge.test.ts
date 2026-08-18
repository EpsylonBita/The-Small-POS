import { describe, expect, it } from 'vitest';
import {
  isPendingOrQueuedLocal,
  mergeHybridOrders,
  sharesIdentity,
  toIdentitySet,
  type HybridMergeOrder,
} from '../hybridOrderMerge';
import { resolveMergedOrderNumber } from '../orderNumberUtils';

interface TestOrder extends HybridMergeOrder {
  status?: string;
  total_amount?: number;
}

const order = (overrides: Partial<TestOrder> & { id: string }): TestOrder => ({
  order_number: overrides.id,
  updated_at: '2026-08-17T10:00:00Z',
  source: 'local',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Verbatim copy of the ORIGINAL OrdersPage merge (O(local x remote), two Sets
// per pair comparison). The rewrite must be observationally identical to this
// on every input; every equivalence assertion below runs both.
// ---------------------------------------------------------------------------
const legacyMergeHybridOrders = <T extends HybridMergeOrder>(
  localOrders: T[],
  remoteOrders: T[],
): T[] => {
  const merged: T[] = [];
  const upsert = (incoming: T) => {
    const index = merged.findIndex((existing) => sharesIdentity(existing, incoming));
    if (index === -1) {
      merged.push(incoming);
      return;
    }

    const existing = merged[index];
    if (isPendingOrQueuedLocal(existing) && incoming.source === 'remote') {
      return;
    }

    const existingTs = new Date(existing.updated_at).getTime();
    const incomingTs = new Date(incoming.updated_at).getTime();
    if (Number.isNaN(existingTs) || incomingTs >= existingTs) {
      merged[index] = {
        ...existing,
        ...incoming,
        order_number: resolveMergedOrderNumber(existing.order_number, incoming.order_number),
      };
    }
  };

  localOrders.forEach(upsert);
  remoteOrders.forEach(upsert);
  return merged;
};

const expectEquivalent = (local: TestOrder[], remote: TestOrder[]): TestOrder[] => {
  const actual = mergeHybridOrders(local, remote);
  const expected = legacyMergeHybridOrders(local, remote);
  expect(actual).toEqual(expected);
  return actual;
};

describe('hybridOrderMerge: identity definition', () => {
  // One test per identity field, with the shared value living in DIFFERENT
  // fields on each side. Weakening toIdentitySet (dropping any field, or
  // dropping the trim/lowercase normalization) turns at least one red.
  it.each([
    ['supabase_id', order({ id: 'local-1' }), order({ id: 'remote-1', supabase_id: 'local-1', source: 'remote' })],
    ['client_order_id', order({ id: 'local-2' }), order({ id: 'remote-2', client_order_id: 'local-2', source: 'remote' })],
    ['client_request_id', order({ id: 'local-3' }), order({ id: 'remote-3', client_request_id: 'local-3', source: 'remote' })],
    ['order_number', order({ id: 'local-4', order_number: 'shared-num' }), order({ id: 'remote-4', order_number: 'shared-num', source: 'remote' })],
    ['id', order({ id: 'same-id' }), order({ id: 'same-id', source: 'remote' })],
  ])('merges into one order when identity is shared through %s', (_field, local, remote) => {
    const merged = expectEquivalent([local], [remote]);
    expect(merged).toHaveLength(1);
  });

  it('identity comparison trims and lowercases', () => {
    const local = order({ id: '  Order-A  ' });
    const remote = order({ id: 'ORDER-a', source: 'remote', status: 'ready' });
    const merged = expectEquivalent([local], [remote]);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('ready');
  });

  it('toIdentitySet drops empty values and keeps all five fields', () => {
    const keys = toIdentitySet(
      order({
        id: 'A',
        supabase_id: 'B',
        client_order_id: 'C',
        client_request_id: 'D',
        order_number: 'E',
      }),
    );
    expect([...keys].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(toIdentitySet(order({ id: 'A', order_number: 'A' })).size).toBe(1);
  });
});

describe('hybridOrderMerge: base cases', () => {
  it('local-only input passes through unchanged', () => {
    const local = [order({ id: 'a' }), order({ id: 'b' })];
    const merged = expectEquivalent(local, []);
    expect(merged).toEqual(local);
  });

  it('remote-only input passes through unchanged', () => {
    const remote = [order({ id: 'a', source: 'remote' }), order({ id: 'b', source: 'remote' })];
    const merged = expectEquivalent([], remote);
    expect(merged).toEqual(remote);
  });

  it('disjoint local and remote concatenate, local first', () => {
    const local = [order({ id: 'l1' }), order({ id: 'l2' })];
    const remote = [order({ id: 'r1', source: 'remote' })];
    const merged = expectEquivalent(local, remote);
    expect(merged.map((o) => o.id)).toEqual(['l1', 'l2', 'r1']);
  });

  it('duplicate ids inside the SAME side collapse (newer-or-equal wins)', () => {
    const local = [
      order({ id: 'dup', status: 'pending', updated_at: '2026-08-17T09:00:00Z' }),
      order({ id: 'dup', status: 'ready', updated_at: '2026-08-17T10:00:00Z' }),
    ];
    const merged = expectEquivalent(local, []);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('ready');
  });
});

describe('hybridOrderMerge: win rules', () => {
  it('a pending local order never loses to a remote row', () => {
    const local = order({ id: 'p1', sync_status: 'pending', status: 'preparing' });
    const remote = order({
      id: 'p1',
      source: 'remote',
      status: 'completed',
      updated_at: '2026-08-18T10:00:00Z',
    });
    const merged = expectEquivalent([local], [remote]);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('preparing');
  });

  it('a queued local order never loses to a remote row', () => {
    const local = order({ id: 'q1', sync_status: 'queued', status: 'preparing' });
    const remote = order({
      id: 'q1',
      source: 'remote',
      status: 'completed',
      updated_at: '2026-08-18T10:00:00Z',
    });
    const merged = expectEquivalent([local], [remote]);
    expect(merged[0].status).toBe('preparing');
  });

  it('an older remote row does not overwrite a newer synced local row', () => {
    const local = order({
      id: 's1',
      sync_status: 'synced',
      status: 'ready',
      updated_at: '2026-08-17T12:00:00Z',
    });
    const remote = order({
      id: 's1',
      source: 'remote',
      status: 'pending',
      updated_at: '2026-08-17T08:00:00Z',
    });
    const merged = expectEquivalent([local], [remote]);
    expect(merged[0].status).toBe('ready');
  });

  it('a newer (or equal-timestamp) remote row wins over a synced local row', () => {
    const local = order({
      id: 's2',
      sync_status: 'synced',
      status: 'preparing',
      updated_at: '2026-08-17T12:00:00Z',
    });
    const remote = order({
      id: 's2',
      source: 'remote',
      status: 'completed',
      updated_at: '2026-08-17T12:00:00Z',
    });
    const merged = expectEquivalent([local], [remote]);
    expect(merged[0].status).toBe('completed');
  });

  it('an unparseable existing timestamp always yields to the incoming row', () => {
    const local = order({ id: 'n1', sync_status: 'synced', status: 'pending', updated_at: 'not-a-date' });
    const remote = order({
      id: 'n1',
      source: 'remote',
      status: 'ready',
      updated_at: '2020-01-01T00:00:00Z',
    });
    const merged = expectEquivalent([local], [remote]);
    expect(merged[0].status).toBe('ready');
  });

  it('a business order number survives an internal-fallback incoming number', () => {
    const local = order({
      id: 'b1',
      order_number: 'ORD-20260817-0042',
      updated_at: '2026-08-17T09:00:00Z',
    });
    const remote = order({
      id: 'b1',
      order_number: 'b1abcdef',
      source: 'remote',
      updated_at: '2026-08-17T10:00:00Z',
    });
    const merged = expectEquivalent([local], [remote]);
    expect(merged[0].order_number).toBe('ORD-20260817-0042');
  });
});

describe('hybridOrderMerge: first-match and identity-migration semantics', () => {
  it('an incoming row matching several merged entries lands on the FIRST', () => {
    const local = [
      order({ id: 'first', updated_at: '2026-08-17T08:00:00Z' }),
      order({ id: 'second', updated_at: '2026-08-17T08:00:00Z' }),
    ];
    // Bridges both: supabase_id hits `first`, client_order_id hits `second`.
    const remote = [
      order({
        id: 'bridge',
        supabase_id: 'first',
        client_order_id: 'second',
        source: 'remote',
        status: 'completed',
        updated_at: '2026-08-17T09:00:00Z',
      }),
    ];
    const merged = expectEquivalent(local, remote);
    expect(merged).toHaveLength(2);
    expect(merged[0].status).toBe('completed');
    expect(merged[1].id).toBe('second');
    expect(merged[1].status).toBeUndefined();
  });

  it('same id, different surrounding identity: the spread result is what later rows match', () => {
    // The merge REPLACES the slot's id ('a' -> 'b'); a later row that only
    // knows the old id must NOT find the slot any more — exactly what the
    // original findIndex-over-current-contents did.
    const local = [order({ id: 'a', supabase_id: 's1', updated_at: '2026-08-17T08:00:00Z' })];
    const remote = [
      order({
        id: 'b',
        supabase_id: 's1',
        client_order_id: undefined,
        client_request_id: undefined,
        source: 'remote',
        updated_at: '2026-08-17T09:00:00Z',
      }),
      order({ id: 'a', source: 'remote', updated_at: '2026-08-17T09:30:00Z' }),
    ];
    const merged = expectEquivalent(local, remote);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe('b');
    expect(merged[1].id).toBe('a');
  });

  it('when a merge makes two entries share a key, later rows land on the earlier entry', () => {
    const local = [
      order({ id: 'x', updated_at: '2026-08-17T08:00:00Z' }),
      order({ id: 'y', updated_at: '2026-08-17T08:00:00Z' }),
    ];
    const remote = [
      // Merges into slot 0 and gives it supabase_id 'y' — slot 0 and slot 1
      // now both answer to 'y'.
      order({
        id: 'x',
        supabase_id: 'y',
        source: 'remote',
        updated_at: '2026-08-17T09:00:00Z',
      }),
      // Must land on slot 0 (the first match), not slot 1.
      order({
        id: 'y',
        source: 'remote',
        status: 'completed',
        updated_at: '2026-08-17T09:30:00Z',
      }),
    ];
    const merged = expectEquivalent(local, remote);
    expect(merged).toHaveLength(2);
    expect(merged[0].status).toBe('completed');
    expect(merged[1].status).toBeUndefined();
  });
});

describe('hybridOrderMerge: 500-cap boundary and randomized equivalence', () => {
  const iso = (minute: number): string =>
    `2026-08-17T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00Z`;

  it('handles a full 500-row remote page against an overlapping local ledger', () => {
    // OrdersPage fetches remote with limit: 500. Build exactly 500 remote
    // rows; every 5th one overlaps a local row through supabase_id,
    // including the first and the last (boundary) row.
    const local: TestOrder[] = [];
    for (let i = 0; i < 500; i += 5) {
      local.push(
        order({
          id: `local-${i}`,
          supabase_id: `remote-${i}`,
          sync_status: i % 10 === 0 ? 'pending' : 'synced',
          status: 'preparing',
          updated_at: iso(60 + (i % 240)),
        }),
      );
    }
    const remote: TestOrder[] = [];
    for (let i = 0; i < 500; i += 1) {
      remote.push(
        order({
          id: `remote-${i}`,
          source: 'remote',
          status: 'completed',
          updated_at: iso(120 + (i % 240)),
        }),
      );
    }

    const merged = expectEquivalent(local, remote);
    // 100 overlapping identities collapse: 100 local slots + 400 remote-only.
    expect(merged).toHaveLength(500);
    // Pending locals kept their state; synced locals took the remote row
    // when it was newer-or-equal.
    const pendingSlots = merged.filter((o) => o.sync_status === 'pending');
    expect(pendingSlots.length).toBe(50);
    expect(pendingSlots.every((o) => o.status === 'preparing')).toBe(true);
  });

  it('is equivalent to the legacy algorithm on seeded random overlapping ledgers', () => {
    // Deterministic LCG so failures reproduce.
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 0x80000000;
      return seed / 0x80000000;
    };
    const pick = <V>(values: V[]): V => values[Math.floor(rand() * values.length)];

    for (let round = 0; round < 20; round += 1) {
      const idPool = Array.from({ length: 30 }, (_, i) => `id-${i}`);
      const make = (source: 'local' | 'remote'): TestOrder =>
        order({
          id: pick(idPool),
          supabase_id: rand() < 0.5 ? pick(idPool) : undefined,
          client_order_id: rand() < 0.3 ? pick(idPool) : undefined,
          client_request_id: rand() < 0.3 ? pick(idPool) : undefined,
          order_number: rand() < 0.5 ? pick(idPool) : `ORD-20260817-${Math.floor(rand() * 100)}`,
          sync_status: pick(['pending', 'queued', 'synced', undefined as unknown as string]),
          source,
          status: pick(['pending', 'preparing', 'ready', 'completed']),
          updated_at: pick([iso(Math.floor(rand() * 600)), 'not-a-date']),
        });

      const local = Array.from({ length: 40 }, () => make('local'));
      const remote = Array.from({ length: 60 }, () => make('remote'));
      expectEquivalent(local, remote);
    }
  });
});
