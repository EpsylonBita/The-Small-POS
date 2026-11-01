import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadNavigationOrder, NAVIGATION_ORDER_STORAGE_KEY, saveNavigationOrder } from '../navigation-order-storage';

// Founder 31/10: «η μεταφορά και η στοίχιση των εικονιδίων μετά την επανεκκίνηση πάνε ξανά όλα στις
// θέσεις που ήταν». Symptom: the rail is rearranged, the app restarts, the default order is back.
// Cause: the order was keyed by organization + terminal + staff on shift, and a shift restored from
// storage after a restart has no organization, so the key changed. Fix: one order per till.

const memoryStorage = (entries: Record<string, string> = {}) => {
  const data = new Map(Object.entries(entries));
  return {
    get length() { return data.size; },
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    data,
  };
};

const ARRANGED = ['orders', 'menu', 'dashboard', 'reservations', 'users'];

describe('sidebar order storage (one order per till)', () => {
  it('keeps the arrangement across a restart whatever staff the shift comes back with', () => {
    const storage = memoryStorage();
    saveNavigationOrder(storage, ARRANGED);
    // The restart: a different (or organization-less) staff on the restored shift reads the same order.
    expect(loadNavigationOrder(storage, { terminalId: 'T-1', staffId: 'cashier-2' })).toEqual(ARRANGED);
    expect(loadNavigationOrder(storage, {})).toEqual(ARRANGED);
  });

  it('reproduces the old failure: the per-staff key without organization missed the saved order', () => {
    // Saved while the shift carried its organization...
    const before = 'pos-navigation-module-order:org-1:T-1:cashier-1';
    // ...looked up after the restart, when the restored shift had none.
    const after = 'pos-navigation-module-order:unknown-organization:T-1:cashier-1';
    const storage = memoryStorage({ [before]: JSON.stringify(ARRANGED) });
    expect(storage.getItem(after)).toBeNull();
    // The till-level read finds it.
    expect(loadNavigationOrder(storage, { terminalId: 'T-1', staffId: 'cashier-1' })).toEqual(ARRANGED);
  });

  it('adopts an order saved under the old keys once: this till and staff first, then this till, then any', () => {
    const other = ['users', 'orders'];
    const storage = memoryStorage({
      'pos-navigation-module-order:org-1:T-9:someone': JSON.stringify(['dashboard']),
      'pos-navigation-module-order:org-1:T-1:other-staff': JSON.stringify(other),
      'pos-navigation-module-order:org-1:T-1:cashier-1': JSON.stringify(ARRANGED),
    });
    expect(loadNavigationOrder(storage, { terminalId: 'T-1', staffId: 'cashier-1' })).toEqual(ARRANGED);
    expect(JSON.parse(storage.getItem(NAVIGATION_ORDER_STORAGE_KEY) ?? 'null')).toEqual(ARRANGED);

    const sameTill = memoryStorage({
      'pos-navigation-module-order:org-1:T-9:someone': JSON.stringify(['dashboard']),
      'pos-navigation-module-order:org-1:T-1:other-staff': JSON.stringify(other),
    });
    expect(loadNavigationOrder(sameTill, { terminalId: 'T-1', staffId: 'cashier-1' })).toEqual(other);

    const anyTill = memoryStorage({ 'pos-navigation-module-order:org-1:T-9:someone': JSON.stringify(['dashboard']) });
    expect(loadNavigationOrder(anyTill, { terminalId: 'T-1', staffId: 'cashier-1' })).toEqual(['dashboard']);
  });

  it('the saved till order wins over old keys, and nothing saved or garbage means the default', () => {
    const storage = memoryStorage({
      [NAVIGATION_ORDER_STORAGE_KEY]: JSON.stringify(ARRANGED),
      'pos-navigation-module-order:org-1:T-1:cashier-1': JSON.stringify(['users']),
    });
    expect(loadNavigationOrder(storage, { terminalId: 'T-1', staffId: 'cashier-1' })).toEqual(ARRANGED);
    expect(loadNavigationOrder(memoryStorage(), { terminalId: 'T-1' })).toEqual([]);
    expect(loadNavigationOrder(memoryStorage({ [NAVIGATION_ORDER_STORAGE_KEY]: '{oops' }), {})).toEqual([]);
  });

  it('NavigationSidebar reads and writes the till order, never a staff-keyed one', () => {
    const source = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'components', 'NavigationSidebar.tsx'), 'utf8');
    expect(source).toMatch(/loadNavigationOrder\(localStorage, \{ terminalId: legacyTerminalId, staffId: legacyStaffId \}\)/);
    expect(source).toMatch(/saveNavigationOrder\(localStorage, nextOrder\)/);
    expect(source).not.toMatch(/unknown-organization|unknown-staff|navigationOrderStorageKey/);
  });
});
