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
import { setSyncQueueBridgeInstanceForTests } from '../../src/renderer/services/SyncQueueBridge';
import { clearTerminalCredentialCache } from '../../src/renderer/services/terminal-credentials';

function createMockBridge(overrides?: {
  syncFromAdmin?: () => Promise<unknown>;
  getFullConfig?: () => Promise<Record<string, unknown>>;
  getSetting?: (category: string, key: string) => Promise<unknown>;
  getSyncStatus?: () => Promise<Record<string, unknown>>;
  fetchFromAdmin?: (path: string) => Promise<unknown>;
  invoke?: (channel: string, payload?: unknown) => Promise<unknown>;
  listStaffSchedule?: (range: { start_date: string; end_date: string }) => Promise<unknown>;
  syncLoyaltySettings?: () => Promise<unknown>;
  syncLoyaltyCustomers?: () => Promise<unknown>;
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
  };

  const bridge = {
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
  const queueCalls: Array<{ adminUrl: string; apiKey: string }> = [];
  const mockQueue = {
    getStatus: async () => queueStatus,
    processQueue: async (adminUrl: string, apiKey: string) => {
      queueCalls.push({ adminUrl, apiKey });
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
  onEvent(PARITY_QUEUE_STATUS_EVENT, handleQueueEvent);
  onEvent('terminal-config-updated', handleConfigEvent);

  try {
    const result = await runParitySyncCycle();

    assert.equal(calls.syncFromAdmin, 1);
    assert.equal(calls.forceSync, 1);
    assert.deepEqual(calls.getSetting, ['terminal.pos_api_key', 'terminal.api_key']);
    assert.deepEqual(calls.adminFetches, [
      '/api/pos/settings/terminal-1',
      '/api/pos/settings/terminal-1?category=menu',
      '/api/pos/integrations',
      '/api/pos/mydata/config',
      '/api/pos/customer-display?limit=200',
      '/api/pos/kiosk/status',
      '/api/pos/kiosk/orders?limit=10',
      '/api/pos/analytics?time_range=today',
      '/api/pos/analytics?time_range=week',
      '/api/pos/analytics?time_range=month',
      '/api/pos/delivery-zones',
      '/api/pos/map-analytics?time_range=30d',
      '/api/pos/sync/inventory_items?limit=2000',
      '/api/pos/suppliers',
      '/api/pos/coupons',
    ]);
    assert.deepEqual(calls.invoke, [
      {
        channel: 'api:list-cached-paths',
        payload: {
          prefixes: [
            '/api/pos/reservations',
            '/api/pos/appointments',
            '/api/pos/drive-through',
            '/api/pos/rooms',
            '/api/pos/housekeeping',
            '/api/pos/guest-billing',
            '/api/pos/products',
            '/api/pos/product-categories',
          ],
        },
      },
    ]);
    assert.equal(calls.staffSchedule.length, 1);
    assert.equal(calls.loyaltySyncSettings, 1);
    assert.equal(calls.loyaltySyncCustomers, 1);
    assert.deepEqual(queueCalls, [
      {
        adminUrl: 'https://admin.example',
        apiKey: 'pos-key',
      },
    ]);
    assert.deepEqual(queueEvents, [queueStatus]);
    assert.deepEqual(configEvents, [
      {
        terminal_id: 'terminal-1',
        admin_url: 'https://admin.example',
      },
    ]);
    assert.deepEqual(result, {
      config: {
        terminal_id: 'terminal-1',
        admin_url: 'https://admin.example',
      },
      queueStatus,
      paritySyncResult: parityResult,
      legacySyncTriggered: true,
    });
  } finally {
    offEvent(PARITY_QUEUE_STATUS_EVENT, handleQueueEvent);
    offEvent('terminal-config-updated', handleConfigEvent);
    setSyncQueueBridgeInstanceForTests(null);
    clearTerminalCredentialCache();
    resetBridge();
  }
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

  try {
    const first = runParitySyncCycle();
    const second = runParitySyncCycle();

    releaseSyncFromAdmin();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepEqual(firstResult, secondResult);
    assert.equal(calls.syncFromAdmin, 1);
    assert.equal(calls.forceSync, 1);
    assert.equal(queueProcessCount, 1);
  } finally {
    setSyncQueueBridgeInstanceForTests(null);
    clearTerminalCredentialCache();
    resetBridge();
  }
});
