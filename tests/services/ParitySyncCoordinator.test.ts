import test from 'node:test';
import assert from 'node:assert/strict';
import {
  offEvent,
  onEvent,
  resetBridge,
  setBridge,
} from '../../src/lib';
import {
  PARITY_QUEUE_STATUS_EVENT,
  runParitySyncCycle,
} from '../../src/renderer/services/ParitySyncCoordinator';
import {
  POS_MODULE_CACHE_ENTRIES,
  getPosModuleCachePrefixes,
  getPosModuleWarmPaths,
} from '../../src/renderer/services/pos-module-cache-registry';
import { getOptionalWarmupModules } from '../../src/renderer/services/pos-module-warmup-access';
import { setSyncQueueBridgeInstanceForTests } from '../../src/renderer/services/SyncQueueBridge';
import {
  clearTerminalCredentialCache,
  updateTerminalCredentialCache,
} from '../../src/renderer/services/terminal-credentials';

function moduleCache(ids: string[]) {
  return { success: true, isValid: true, identityMatch: true, modules: {
    success: true, organization_id: 'org-1', terminal_id: 'terminal-1',
    modules: ids.map(module_id => ({ module_id, is_purchased: true, pos_enabled: true })),
  } };
}

function createMockBridge(overrides?: {
  syncFromAdmin?: () => Promise<unknown>;
  getCachedModules?: () => Promise<unknown>;
  getFullConfig?: () => Promise<Record<string, unknown>>;
  getSetting?: (category: string, key: string) => Promise<unknown>;
  getSyncStatus?: () => Promise<Record<string, unknown>>;
  fetchFromAdmin?: (path: string) => Promise<unknown>;
  invoke?: (channel: string, payload?: unknown) => Promise<unknown>;
  listStaffSchedule?: (range: { start_date: string; end_date: string }) => Promise<unknown>;
  syncLoyaltySettings?: () => Promise<unknown>;
  syncLoyaltyCustomers?: () => Promise<unknown>;
  posApiKey?: string;
  terminalSettings?: Record<string, unknown> | null;
}) {
  const calls = {
    syncFromAdmin: 0,
    getFullConfig: 0,
    getSetting: [] as string[],
    forceSync: 0,
    adminFetches: [] as string[],
    invoke: [] as Array<{ channel: string; payload?: unknown }>,
    staffSchedule: [] as Array<{ start_date: string; end_date: string }>,
    loyaltySyncSettings: 0,
    loyaltySyncCustomers: 0,
    // W8 follow-up: the parity coordinator now resolves credentials via
    // `terminal-credentials.ts` (which calls `terminalConfig.{getTerminalId,
    // getBranchId, getOrganizationId}` and `settings.getPosApiKey`) AND
    // persists snapshots via `settings.updateLocal`. Track each.
    getTerminalId: 0,
    getBranchId: 0,
    getOrganizationId: 0,
    getSettings: 0,
    getPosApiKey: 0,
    getCredentialStatus: 0,
    settingsUpdateLocal: [] as Array<{ request: unknown; value?: unknown }>,
  };

  const bridge = {
    modules: { getCached: async () => overrides?.getCachedModules ? overrides.getCachedModules() : moduleCache([...POS_MODULE_CACHE_ENTRIES.map(entry => entry.moduleId), 'loyalty']) },
    terminalConfig: {
      syncFromAdmin: async () => {
        calls.syncFromAdmin += 1;
        return overrides?.syncFromAdmin ? overrides.syncFromAdmin() : null;
      },
      getFullConfig: async () => {
        calls.getFullConfig += 1;
        return overrides?.getFullConfig
          ? overrides.getFullConfig()
          : {
              terminal_id: 'terminal-1',
              admin_url: 'https://admin.example',
            };
      },
      getSetting: async (category: string, key: string) => {
        calls.getSetting.push(`${category}.${key}`);
        if (overrides?.getSetting) {
          return overrides.getSetting(category, key);
        }
        return key === 'pos_api_key' ? 'pos-key' : '';
      },
      getSettings: async () => {
        calls.getSettings += 1;
        return overrides?.terminalSettings ?? null;
      },
      getTerminalId: async () => {
        calls.getTerminalId += 1;
        return 'terminal-1';
      },
      getBranchId: async () => {
        calls.getBranchId += 1;
        return 'branch-1';
      },
      getOrganizationId: async () => {
        calls.getOrganizationId += 1;
        return 'org-1';
      },
    },
    sync: {
      getStatus: async () => {
        if (overrides?.getSyncStatus) {
          return overrides.getSyncStatus();
        }
        return {
          pendingItems: 0,
          pendingPaymentItems: 0,
          queuedRemote: 0,
          backpressureDeferred: 0,
        };
      },
      force: async () => {
        calls.forceSync += 1;
        return { success: true };
      },
    },
    settings: {
      getPosApiKey: async () => {
        calls.getPosApiKey += 1;
        return overrides?.posApiKey ?? 'pos-key';
      },
      getCredentialStatus: async () => {
        calls.getCredentialStatus += 1;
        return {
          hasAdminUrl: true,
          hasApiKey: true,
          hasTerminalId: true,
        };
      },
      updateLocal: async (request: unknown, value?: unknown) => {
        calls.settingsUpdateLocal.push({ request, value });
        return { success: true };
      },
    },
    adminApi: {
      fetchFromAdmin: async (path: string) => {
        calls.adminFetches.push(path);
        return overrides?.fetchFromAdmin
          ? overrides.fetchFromAdmin(path)
          : { success: true, data: { success: true } };
      },
    },
    invoke: async (channel: string, payload?: unknown) => {
      calls.invoke.push({ channel, payload });
      return overrides?.invoke
        ? overrides.invoke(channel, payload)
        : { success: true, paths: [] };
    },
    staffSchedule: {
      list: async (range: { start_date: string; end_date: string }) => {
        calls.staffSchedule.push(range);
        return overrides?.listStaffSchedule
          ? overrides.listStaffSchedule(range)
          : { success: true, data: { success: true, staff: [], shifts: [] } };
      },
    },
    loyalty: {
      syncSettings: async () => {
        calls.loyaltySyncSettings += 1;
        return overrides?.syncLoyaltySettings ? overrides.syncLoyaltySettings() : { success: true };
      },
      syncCustomers: async () => {
        calls.loyaltySyncCustomers += 1;
        return overrides?.syncLoyaltyCustomers ? overrides.syncLoyaltyCustomers() : { success: true };
      },
    },
  };

  return {
    bridge: bridge as any,
    calls,
  };
}

test('runParitySyncCycle drives config sync, parity queue sync, and renderer events', async () => {
  const queueStatus = {
    total: 2,
    pending: 1,
    failed: 1,
    conflicts: 0,
    oldestItemAge: null,
  };
  const parityResult = {
    success: true,
    processed: 1,
    failed: 0,
    conflicts: 0,
    errors: [],
  };
  let queueProcessCount = 0;
  const mockQueue = {
    getStatus: async () => queueStatus,
    processQueue: async () => {
      queueProcessCount += 1;
      return parityResult;
    },
  } as any;
  const { bridge, calls } = createMockBridge({
    getSyncStatus: async () => ({
      pendingItems: 1,
      pendingPaymentItems: 0,
      queuedRemote: 0,
      backpressureDeferred: 0,
    }),
  });
  const queueEvents: unknown[] = [];
  const configEvents: unknown[] = [];
  const handleQueueEvent = (payload: unknown) => queueEvents.push(payload);
  const handleConfigEvent = (payload: unknown) => configEvents.push(payload);

  setBridge(bridge);
  setSyncQueueBridgeInstanceForTests(mockQueue);
  // Pre-populate the credential cache. `terminal-credentials.ts` is
  // window-guarded and a no-op in node tests, so without this seed the
  // coordinator's `resolveParitySyncCredentials` would fall back to
  // `readString(config, 'pos_api_key', 'api_key')` and only populate the
  // key if it appears in `getFullConfig`. Pre-populating mirrors the
  // realistic state where credentials were resolved during a prior boot.
  updateTerminalCredentialCache({
    terminalId: 'terminal-1',
    branchId: 'branch-1',
    organizationId: 'org-1',
    apiKey: 'pos-key',
  });
  onEvent(PARITY_QUEUE_STATUS_EVENT, handleQueueEvent);
  onEvent('terminal-config-updated', handleConfigEvent);

  try {
    const result = await runParitySyncCycle();

    assert.equal(calls.syncFromAdmin, 1);
    assert.equal(calls.forceSync, 1);
    // Credential resolution refactored away from `getSetting('terminal',
    // 'pos_api_key' | 'api_key')`. The new path goes through
    // `terminal-credentials.ts`, but every accessor there is window-guarded
    // (`if (typeof window === 'undefined') return ''`) and therefore a no-op
    // in node-test runs. The coordinator's fallback `readString(config,
    // 'pos_api_key', 'api_key')` is what actually resolves the key in this
    // test — see the `pos_api_key: 'pos-key'` field on the mock's
    // getFullConfig return. So `getSetting` is never called from the
    // credential path here.
    assert.deepEqual(calls.getSetting, []);
    // The coordinator persists a snapshot via settings.updateLocal both at
    // sync-start (initial) and sync-end (completed). Assert at least one
    // update was made and that it carried the diagnostics setting type.
    // This call IS reachable in tests — `persistParitySyncSnapshot` has no
    // window guard.
    assert.ok(
      calls.settingsUpdateLocal.length >= 1,
      'settings.updateLocal must be called for snapshot persistence',
    );
    const firstSettingsUpdate = calls.settingsUpdateLocal[0]?.request as {
      settingType?: string;
    } | undefined;
    assert.equal(firstSettingsUpdate?.settingType, 'diagnostics');
    assert.deepEqual(calls.adminFetches, [
      '/api/pos/settings/terminal-1',
      '/api/pos/settings/terminal-1?category=menu',
      ...getPosModuleWarmPaths(new Set(POS_MODULE_CACHE_ENTRIES.map(e => e.moduleId).filter(id => id !== 'inventory' && id !== 'product_catalog'))),
      '/api/pos/purchase-orders',
    ]);
    assert.equal(calls.adminFetches.filter(path => path === '/api/pos/purchase-orders').length, 1);
    assert.ok(!calls.adminFetches.some(path => path.startsWith('/api/pos/map-analytics')));
    assert.deepEqual(calls.invoke, [{ channel: 'api:list-cached-paths', payload: { prefixes: getPosModuleCachePrefixes(new Set(POS_MODULE_CACHE_ENTRIES.map(e => e.moduleId).filter(id => id !== 'inventory' && id !== 'product_catalog'))) } }]);
    assert.equal(calls.staffSchedule.length, 1);
    assert.equal(calls.loyaltySyncSettings, 1);
    assert.equal(calls.loyaltySyncCustomers, 1);
    assert.equal(queueProcessCount, 1);
    assert.deepEqual(queueEvents, [queueStatus]);
    // `terminal-config-updated` was previously emitted by the coordinator
    // after `terminalConfig.syncFromAdmin`. It is now emitted by the Rust
    // side (see `event-bridge.ts:103` — `terminal_config_updated` →
    // `terminal-config-updated`). In a node-only test there is no Rust
    // process to emit it, so `configEvents` is empty. The renderer-side
    // listener wiring is unchanged and remains exercised by the consumer
    // hooks (`useFeatures`, `useResolvedPosIdentity`, etc.).
    assert.deepEqual(configEvents, []);
    // The result shape grew over time — it now also carries
    // `credentialState` and `paritySyncStatus` (with a dynamic
    // `finishedAt` timestamp). Assert per-field on the parts this test
    // actually cares about, rather than `deepEqual` on the whole object.
    assert.deepEqual(result.config, {
      terminal_id: 'terminal-1',
      admin_url: 'https://admin.example',
    });
    assert.deepEqual(result.queueStatus, queueStatus);
    assert.deepEqual(result.paritySyncResult, parityResult);
    assert.equal(result.legacySyncTriggered, true);
  } finally {
    offEvent(PARITY_QUEUE_STATUS_EVENT, handleQueueEvent);
    offEvent('terminal-config-updated', handleConfigEvent);
    setSyncQueueBridgeInstanceForTests(null);
    clearTerminalCredentialCache();
    resetBridge();
  }
});

test('scheduled queue retries never download unrelated advisory snapshots', async () => {
  const { bridge, calls } = createMockBridge();
  setBridge(bridge);
  let replayed = 0;
  setSyncQueueBridgeInstanceForTests({
    getStatus: async () => ({ total: 1, pending: 0, failed: 1, conflicts: 0, oldestItemAge: null }),
    processQueue: async () => { replayed++; return { success: false, processed: 0, failed: 1, conflicts: 0, errors: [] }; },
  } as any);
  try {
    await runParitySyncCycle({ trigger: 'scheduled_retry' });
    await runParitySyncCycle({ trigger: 'scheduled_retry' });
    assert.equal(replayed, 2);
    assert.deepEqual(calls.adminFetches, []);
    assert.equal(calls.syncFromAdmin, 0);
    assert.equal(calls.loyaltySyncCustomers, 0);
  } finally { setSyncQueueBridgeInstanceForTests(null); resetBridge(); }
});

test('POS module cache registry covers every scoped parity vertical', () => {
  const modules = new Set(POS_MODULE_CACHE_ENTRIES.map((entry) => entry.moduleId));

  for (const expected of [
    'appointments',
    'services',
    'rooms',
    'housekeeping',
    'guest_billing',
    'product_catalog',
  ]) {
    assert.ok(modules.has(expected), `missing cache entry for ${expected}`);
  }

  const warmPaths = getPosModuleWarmPaths();
  assert.ok(warmPaths.includes('/api/pos/services?is_active=true'));
  assert.ok(warmPaths.includes('/api/pos/sync/retail_product_categories?limit=2000'));
  assert.equal(warmPaths.length, new Set(warmPaths).size, 'warm paths must be unique');

  const prefixes = getPosModuleCachePrefixes();
  assert.ok(prefixes.includes('/api/pos/sync/guest_folios'));
  assert.equal(prefixes.length, new Set(prefixes).size, 'cache prefixes must be unique');
});

test('runParitySyncCycle deduplicates concurrent sync requests', async () => {
  let releaseSyncFromAdmin: () => void = () => {};
  const syncFromAdminGate = new Promise<void>((resolve) => {
    releaseSyncFromAdmin = resolve;
  });
  let queueProcessCount = 0;
  const mockQueue = {
    getStatus: async () => ({
      total: 0,
      pending: 0,
      failed: 0,
      conflicts: 0,
      oldestItemAge: null,
    }),
    processQueue: async () => {
      queueProcessCount += 1;
      return {
        success: true,
        processed: 0,
        failed: 0,
        conflicts: 0,
        errors: [],
      };
    },
  } as any;
  const { bridge, calls } = createMockBridge({
    syncFromAdmin: async () => {
      await syncFromAdminGate;
      return null;
    },
    getSyncStatus: async () => ({
      pendingItems: 1,
      pendingPaymentItems: 0,
      queuedRemote: 0,
      backpressureDeferred: 0,
    }),
  });

  setBridge(bridge);
  setSyncQueueBridgeInstanceForTests(mockQueue);
  // Same rationale as the first test — pre-populate the credential cache
  // because `terminal-credentials.ts` is window-guarded in node tests.
  updateTerminalCredentialCache({
    terminalId: 'terminal-1',
    branchId: 'branch-1',
    organizationId: 'org-1',
    apiKey: 'pos-key',
  });

  try {
    const first = runParitySyncCycle({ trigger: 'startup' });
    const second = runParitySyncCycle({ trigger: 'scheduled_retry' });

    releaseSyncFromAdmin();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepEqual(firstResult, secondResult);
    assert.equal(calls.syncFromAdmin, 1);
    assert.equal(calls.forceSync, 1);
    assert.equal(calls.adminFetches.length, new Set(calls.adminFetches).size);
    assert.equal(calls.staffSchedule.length, 1);
    assert.equal(queueProcessCount, 1);
  } finally {
    setSyncQueueBridgeInstanceForTests(null);
    clearTerminalCredentialCache();
    resetBridge();
  }
});


test('warmup excludes unacquired/disabled optional paths and stale cached paths while keeping free staff', async () => {
  const cache = moduleCache(['rooms', 'loyalty', 'analytics', 'inventory']);
  cache.modules.modules[2].pos_enabled = false;
  cache.modules.modules[3].is_purchased = false;
  const { bridge, calls } = createMockBridge({
    getCachedModules: async () => cache,
    invoke: async () => ({ success: true, paths: [
      '/api/pos/rooms?floor=2', '/api/pos/rooms?floor=2',
      '/api/pos/appointments?date=2026-09-28', '/api/pos/sync/inventory_items?limit=3000',
      '/api/pos/analytics?time_range=today', '/api/pos/rooms-admin',
      '/api/pos/map-analytics?time_range=30d', '/api/pos/purchase-orders',
      'https://elsewhere.example/api/pos/rooms',
    ] }),
  });
  setBridge(bridge);
  setSyncQueueBridgeInstanceForTests({
    getStatus: async () => ({ total: 0 }),
    processQueue: async () => ({ processed: 0, failed: 0, conflicts: 0 }),
  } as any);
  try {
    await runParitySyncCycle({ trigger: 'startup' });
    assert.deepEqual(calls.adminFetches, [
      '/api/pos/settings/terminal-1', '/api/pos/settings/terminal-1?category=menu',
      '/api/pos/rooms', '/api/pos/sync/rooms?limit=2000', '/api/pos/rooms?floor=2',
    ]);
    assert.equal(calls.staffSchedule.length, 1);
    assert.equal(calls.loyaltySyncSettings, 1);
    assert.equal(calls.loyaltySyncCustomers, 1);
  } finally { setSyncQueueBridgeInstanceForTests(null); resetBridge(); }
});

test('unknown, stale or wrong-identity module inventory cannot authorize optional network warmup', async () => {
  const valid = moduleCache(['rooms', 'loyalty', 'suppliers']);
  const cases = [
    null, { ...valid, isValid: false }, { ...valid, identityMatch: false }, { ...valid, stale: true },
    { ...valid, modules: { ...valid.modules, terminal_id: 'other-terminal' } },
    { ...valid, modules: { ...valid.modules, organization_id: 'other-org' } },
  ];
  for (const cached of cases) {
    const { bridge, calls } = createMockBridge({
      getCachedModules: async () => cached,
      getFullConfig: async () => ({ terminal_id: 'terminal-1', organization_id: 'org-1', admin_url: 'https://admin.example' }),
      invoke: async () => ({ success: true, paths: ['/api/pos/rooms?stale=true'] }),
    });
    setBridge(bridge);
    setSyncQueueBridgeInstanceForTests({
      getStatus: async () => ({ total: 0 }),
      processQueue: async () => ({ processed: 0, failed: 0, conflicts: 0 }),
    } as any);
    try {
      await runParitySyncCycle({ trigger: 'startup' });
      assert.deepEqual(calls.adminFetches, ['/api/pos/settings/terminal-1', '/api/pos/settings/terminal-1?category=menu']);
      assert.equal(calls.staffSchedule.length, 1);
      assert.equal(calls.loyaltySyncSettings, 0);
      assert.equal(calls.loyaltySyncCustomers, 0);
    } finally { setSyncQueueBridgeInstanceForTests(null); resetBridge(); }
  }
});

test('optional access follows the filtered native module contract, not a page-cache or core flag', async () => {
  const { bridge } = createMockBridge({ getCachedModules: async () => ({
    ...moduleCache([]), modules: { ...moduleCache([]).modules, modules: [
      { module_id: 'rooms', is_purchased: true, pos_enabled: true },
      { module_id: 'inventory', is_core: true, pos_enabled: true },
      { module_id: 'coupons', is_purchased: true, pos_enabled: true, is_locked: true },
      { module_id: 'analytics', is_purchased: true, pos_enabled: true, is_enabled: false },
    ] },
  }) });
  setBridge(bridge);
  try { assert.deepEqual([...await getOptionalWarmupModules({ terminal_id: 'terminal-1' })], ['rooms']); }
  finally { resetBridge(); }
});
