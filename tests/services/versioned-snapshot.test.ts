import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPages, SnapshotAccessError, VersionedSnapshot, type Snapshot } from '../../src/renderer/services/versioned-snapshot';
import { overlayPendingRows, readModuleSnapshot } from '../../src/renderer/services/module-snapshots';
import { resetBridge, setBridge } from '../../src/lib';
import { resetPlatformCache } from '../../src/lib/platform-detect';

test('unchanged skips payload, changed/deleted replaces it and manual forces refresh', async () => {
  let version: string | null = '1'; let fetches = 0; let rows = ['a', 'b'];
  const engine = new VersionedSnapshot({ version: async () => version, fetch: async () => { fetches++; return rows; }, load: () => null, save: () => {} });
  assert.deepEqual(await engine.read('org/branch/terminal'), ['a', 'b']);
  await engine.read('org/branch/terminal'); assert.equal(fetches, 1);
  version = '2'; rows = ['b']; assert.deepEqual(await engine.read('org/branch/terminal'), ['b']);
  await engine.read('org/branch/terminal', true); assert.equal(fetches, 3);
  version = null; await engine.read('org/branch/terminal'); await engine.read('org/branch/terminal'); assert.equal(fetches, 5);
});

test('complete page traversal stops at exact boundary, failed page retains snapshot and version', async () => {
  let version = '1'; let fail = false; let saved: Snapshot<number[]> | null = null; const offsets: number[] = [];
  const engine = new VersionedSnapshot({ version: async () => version, load: () => null, save: value => { saved = value; }, fetch: () => fetchAllPages(async offset => {
    offsets.push(offset); if (fail && offset === 200) throw new Error('offline');
    return { rows: Array.from({length: 200}, (_, i) => offset + i), pagination: { hasMore: offset === 0, nextOffset: offset === 0 ? 200 : null } };
  }) });
  assert.equal((await engine.read('a')).length, 400); assert.deepEqual(offsets, [0, 200]);
  version = '2'; fail = true; assert.equal((await engine.read('a')).length, 400); assert.equal(saved!.version, '1');
});

test('identity changes discard in-flight result; access revocation cannot return old cache', async () => {
  let resolve!: (value: string[]) => void; let deny = false;
  const engine = new VersionedSnapshot({ version: async () => { if (deny) throw new SnapshotAccessError('denied'); return '1'; }, fetch: () => new Promise<string[]>(r => { resolve = r; }), load: () => null, save: () => {} });
  const first = engine.read('org-a'); await Promise.resolve(); engine.reset('org-b'); resolve(['private-a']);
  await assert.rejects(first, /identity/);
  deny = true; await assert.rejects(engine.read('org-b'), /denied/);
});

test('revision change during download never replaces or marks mixed pages current', async () => {
  let version = '1'; let calls = 0;
  const engine = new VersionedSnapshot({ version: async () => version, fetch: async () => { calls++; if (calls > 1) version = '3'; return [calls]; }, load: () => null, save: () => {} });
  await engine.read('a'); version = '2'; assert.deepEqual(await engine.read('a'), [1]);
  assert.deepEqual(await engine.read('a'), [3]);
});

test('known pre-fetch revision requires a matching post-fetch revision, including outage', async () => {
  let version: string | null = '1'; let outage = false; let saved: Snapshot<string[]> | null = null;
  const engine = new VersionedSnapshot({ version: async () => version, load: () => null, save: snapshot => { saved = snapshot; },
    fetch: async () => { if (outage) version = null; return outage ? ['unconfirmed'] : ['complete']; } });
  await engine.read('scope'); version = '2'; outage = true;
  assert.deepEqual(await engine.read('scope'), ['complete']); assert.equal(saved!.version, '1');
  assert.deepEqual(saved!.value, ['complete']);
});

test('pending overlays are repeatable without mutating raw snapshot; latest quantity wins', () => {
  const inventory = [{ id: 'a', stock_quantity: 2.5 }];
  const pending = [{ table: 'inventory_adjustments', id: 'a', data: { product_id: 'a', adjustment: 1.25 } }];
  assert.equal(overlayPendingRows(inventory, pending, 'inventory')[0].stock_quantity, 3.75);
  assert.equal(overlayPendingRows(inventory, pending, 'inventory')[0].stock_quantity, 3.75);
  assert.equal(inventory[0].stock_quantity, 2.5);
  assert.equal(overlayPendingRows([{ id: 'a', quantity: 1 }], [
    { table: 'products', id: 'a', data: { quantity: 3 } }, { table: 'products', id: 'a', data: { quantity: 8 } },
  ], 'product_catalog')[0].quantity, 8);
});

test('actual catalog consumer shares complete pages/categories and checks only revision when unchanged', async () => {
  Object.assign(globalThis, { window: { __TAURI_INTERNALS__: {} } });
  resetPlatformCache();
  const stored = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) } });
  const calls: string[] = [];
  let pending: any[] = [];
  const config = { organization_id: 'integration-org', branch_id: 'branch', terminal_id: 'terminal' };
  setBridge({
    terminalConfig: { getFullConfig: async () => config },
    modules: { getCached: async () => ({ success: true, identityMatch: true, isValid: true, modules: { success: true, organization_id: config.organization_id, terminal_id: config.terminal_id, modules: [{ module_id: 'product_catalog', is_purchased: true, pos_enabled: true }] } }) },
    invoke: async () => pending,
    adminApi: { fetchFromAdmin: async (path: string) => {
      calls.push(path);
      return { success: true, meta: { source: 'remote' }, data: path.includes('sync-version') ? { version: '1' } : path.includes('product-categories') ? { categories: [{ id: path.includes('offset=0') ? 'category1' : 'category2' }], pagination: { hasMore: path.includes('offset=0'), nextOffset: path.includes('offset=0') ? 200 : null } } : {
        products: [{ id: path.includes('offset=0') ? 'first' : 'second' }], pagination: { hasMore: path.includes('offset=0'), nextOffset: path.includes('offset=0') ? 200 : null },
      } };
    } },
  } as any);
  try {
    const result = await readModuleSnapshot('product_catalog');
    assert.deepEqual(result.rows.map(row => row.id), ['first', 'second']);
    assert.deepEqual(result.categories.map(row => row.id), ['category1', 'category2']);
    const before = calls.length; await readModuleSnapshot('product_catalog');
    assert.deepEqual(calls.slice(before), ['/api/pos/sync-version?module=product_catalog']);
    pending = [{ table: 'products', id: 'first', data: { quantity: 17 } }];
    const beforePending = calls.length;
    assert.equal((await readModuleSnapshot('product_catalog', true)).rows[0].quantity, 17);
    assert.equal(calls.length, beforePending, 'manual refresh cannot replace an unresolved local baseline');
  } finally { resetBridge(); delete (globalThis as any).window; resetPlatformCache(); }
});
