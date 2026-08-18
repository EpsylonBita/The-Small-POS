import { resolveMergedOrderNumber } from './orderNumberUtils';

/**
 * Structural slice of an order that hybrid local/remote merging depends on.
 * OrdersPage's page-local `Order` interface satisfies this.
 */
export interface HybridMergeOrder {
  id: string;
  order_number: string;
  updated_at: string;
  supabase_id?: string;
  client_order_id?: string;
  client_request_id?: string;
  sync_status?: string;
  source?: 'local' | 'remote';
}

/**
 * The identity of an order is the SET of its non-empty identifier values —
 * id, supabase_id, client_order_id, client_request_id and order_number —
 * trimmed and lowercased. Two orders are the same order when their identity
 * sets intersect, across fields: a remote row whose `id` equals a local
 * row's `supabase_id` (the common case after sync) is the same order.
 *
 * This definition is shared by the merge below and by OrdersPage's
 * remote-recovery pass; weakening it (dropping a field) makes duplicates
 * reappear on the orders screen.
 */
export const toIdentitySet = (order: HybridMergeOrder): Set<string> => {
  const keys = [
    order.id,
    order.supabase_id,
    order.client_order_id,
    order.client_request_id,
    order.order_number,
  ]
    .filter((v): v is string => !!v)
    .map((v) => v.trim().toLowerCase());
  return new Set(keys);
};

export const sharesIdentity = (a: HybridMergeOrder, b: HybridMergeOrder): boolean => {
  const aKeys = toIdentitySet(a);
  const bKeys = toIdentitySet(b);
  for (const key of aKeys) {
    if (bKeys.has(key)) return true;
  }
  return false;
};

export const isPendingOrQueuedLocal = (order: HybridMergeOrder): boolean => {
  const syncStatus = (order.sync_status || '').toLowerCase();
  return order.source === 'local' && (syncStatus === 'pending' || syncStatus === 'queued');
};

/**
 * Merge the local ledger with a remote snapshot, local first.
 *
 * Semantics (unchanged from the original OrdersPage implementation — the
 * `hybridOrderMerge.equivalence` suite pins them against a verbatim copy of
 * the old O(local x remote) algorithm):
 * - an incoming order lands on the FIRST already-merged entry whose current
 *   identity set intersects its own (see `toIdentitySet`);
 * - a pending/queued LOCAL entry never loses to a remote row;
 * - otherwise the incoming row wins when its `updated_at` is newer-or-equal
 *   (or the existing timestamp is unparseable), via object spread with
 *   `resolveMergedOrderNumber` arbitrating the order number;
 * - a merge can CHANGE the entry's identity (the spread result's fields are
 *   what subsequent rows match against).
 *
 * Implementation: one identity-key map maintained in lockstep with the
 * merged array — O(local + remote) with one small Set per order, instead of
 * findIndex + two Sets per pair comparison.
 */
export const mergeHybridOrders = <T extends HybridMergeOrder>(
  localOrders: T[],
  remoteOrders: T[],
): T[] => {
  const merged: T[] = [];
  // Identity set of each merged slot, kept in lockstep with the slot's
  // CURRENT contents (a merge can change a slot's identity).
  const slotKeys: Array<Set<string>> = [];
  // identity key -> indexes of every slot whose current identity holds it.
  // A key can belong to several slots (two entries merged through different
  // keys can converge on a shared one); lookups take the LOWEST index, which
  // is exactly what the old `findIndex` scan returned.
  const keyToSlots = new Map<string, Set<number>>();

  const registerSlot = (index: number, keys: Set<string>) => {
    slotKeys[index] = keys;
    keys.forEach((key) => {
      let owners = keyToSlots.get(key);
      if (!owners) {
        owners = new Set<number>();
        keyToSlots.set(key, owners);
      }
      owners.add(index);
    });
  };

  const unregisterSlot = (index: number) => {
    slotKeys[index].forEach((key) => {
      const owners = keyToSlots.get(key);
      if (!owners) return;
      owners.delete(index);
      if (owners.size === 0) keyToSlots.delete(key);
    });
  };

  const findFirstMatch = (keys: Set<string>): number => {
    let first = -1;
    keys.forEach((key) => {
      const owners = keyToSlots.get(key);
      if (!owners) return;
      owners.forEach((index) => {
        if (first === -1 || index < first) first = index;
      });
    });
    return first;
  };

  const upsert = (incoming: T) => {
    const incomingKeys = toIdentitySet(incoming);
    const index = findFirstMatch(incomingKeys);
    if (index === -1) {
      merged.push(incoming);
      registerSlot(merged.length - 1, incomingKeys);
      return;
    }

    const existing = merged[index];
    if (isPendingOrQueuedLocal(existing) && incoming.source === 'remote') {
      return;
    }

    const existingTs = new Date(existing.updated_at).getTime();
    const incomingTs = new Date(incoming.updated_at).getTime();
    if (Number.isNaN(existingTs) || incomingTs >= existingTs) {
      const next = {
        ...existing,
        ...incoming,
        order_number: resolveMergedOrderNumber(existing.order_number, incoming.order_number),
      };
      merged[index] = next;
      unregisterSlot(index);
      registerSlot(index, toIdentitySet(next));
    }
  };

  localOrders.forEach(upsert);
  remoteOrders.forEach(upsert);
  return merged;
};
