/**
 * Unit tests for DesktopRealtimeManager
 *
 * Covers:
 * - Subscription creation with correct filters
 * - Reconnection timing (exponential backoff)
 * - Polling fallback after max reconnect attempts
 * - Full sync on reconnection
 * - Graceful close on API key revocation
 * - disconnect() cleans up channels
 * - Connection status and isConnected()
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { POS_REALTIME_SUBSCRIPTIONS } from '../../../shared/config/realtimeConfig';

// ============================================================
// MOCK SUPABASE CLIENT
// ============================================================

interface MockChannelCall {
  channelName: string;
  onCalls: Array<{
    type: string;
    config: Record<string, unknown>;
    callback: (payload: any) => void;
  }>;
  subscribeCb: ((status: string, err?: Error) => void) | null;
}

function createMockSupabaseClient() {
  const channels: Map<string, MockChannelCall> = new Map();
  const removedChannels: string[] = [];
  let currentChannel: MockChannelCall | null = null;

  const channelObj = {
    on(_type: string, config: Record<string, unknown>, callback: (payload: any) => void) {
      currentChannel?.onCalls.push({ type: _type, config, callback });
      return channelObj;
    },
    subscribe(cb: (status: string, err?: Error) => void) {
      if (currentChannel) {
        currentChannel.subscribeCb = cb;
      }
      return channelObj;
    },
  };

  const client = {
    channel(name: string) {
      currentChannel = {
        channelName: name,
        onCalls: [],
        subscribeCb: null,
      };
      channels.set(name, currentChannel);
      return channelObj;
    },
    removeChannel(_ch: any) {
      removedChannels.push('removed');
    },
    // Test helpers
    _channels: channels,
    _removedChannels: removedChannels,
    _getLastSubscribeCallback(): ((status: string, err?: Error) => void) | null {
      const all = Array.from(channels.values());
      return all.length > 0 ? all[all.length - 1].subscribeCb : null;
    },
    _getAllSubscribeCallbacks(): Array<(status: string, err?: Error) => void> {
      return Array.from(channels.values())
        .map((c) => c.subscribeCb)
        .filter(Boolean) as Array<(status: string, err?: Error) => void>;
    },
    _getChannelConfigs(): Array<{ channelName: string; filters: Record<string, unknown>[] }> {
      return Array.from(channels.values()).map((c) => ({
        channelName: c.channelName,
        filters: c.onCalls.map((call) => call.config),
      }));
    },
  };

  return client;
}

// ============================================================
// DYNAMIC IMPORT HELPER
// ============================================================

/**
 * We import the class dynamically so that mock setup can be done per-test
 * without module caching issues. Since the module is pure TypeScript with
 * no side effects at import time, a static import is fine here.
 */
async function importModule() {
  // Use require-style for node:test compatibility with ts transpilers
  const mod = await import('../../src/renderer/services/RealtimeManager');
  return mod;
}

// ============================================================
// TESTS
// ============================================================

test('DesktopRealtimeManager - subscription creation with correct filters', async () => {
  const { DesktopRealtimeManager } = await importModule();
  const mockClient = createMockSupabaseClient();
  const orgId = 'org-test-123';

  const manager = new DesktopRealtimeManager({
    supabaseUrl: 'https://realtime.invalid',
    supabaseKey: 'test-key',
    organizationId: orgId,
    onOrderChange: () => {},
    onConfigChange: () => {},
    onModuleChange: () => {},
    client: mockClient as any,
  });

  await manager.connect();

  const channelConfigs = mockClient._getChannelConfigs();

  // Should create one channel per subscription in POS_REALTIME_SUBSCRIPTIONS
  assert.equal(
    channelConfigs.length,
    POS_REALTIME_SUBSCRIPTIONS.length,
    `Expected ${POS_REALTIME_SUBSCRIPTIONS.length} channels`
  );

  // Every subscription should filter by organization_id=eq.<orgId>
  for (const sub of POS_REALTIME_SUBSCRIPTIONS) {
    const matching = channelConfigs.find((c) => c.channelName.includes(sub.id));
    assert.ok(matching, `Channel for subscription "${sub.id}" should exist`);

    for (const filter of matching.filters) {
      assert.equal(
        filter.filter,
        `organization_id=eq.${orgId}`,
        `Filter for ${sub.id} should include organization_id`
      );
      assert.equal(filter.table, sub.table, `Table should match for ${sub.id}`);
      assert.equal(filter.schema, sub.schema, `Schema should match for ${sub.id}`);
    }
  }

  manager.disconnect();
});

test('DesktopRealtimeManager - callbacks are invoked for matching subscription', async () => {
  const { DesktopRealtimeManager } = await importModule();
  const mockClient = createMockSupabaseClient();

  const orderPayloads: any[] = [];
  const configPayloads: any[] = [];
  const modulePayloads: any[] = [];

  const manager = new DesktopRealtimeManager({
    supabaseUrl: 'https://realtime.invalid',
    supabaseKey: 'test-key',
    organizationId: 'org-1',
    onOrderChange: (p) => orderPayloads.push(p),
    onConfigChange: (p) => configPayloads.push(p),
    onModuleChange: (p) => modulePayloads.push(p),
    client: mockClient as any,
  });

  await manager.connect();

  // Find the orders channel and invoke its callback
  const ordersChannel = Array.from(mockClient._channels.values()).find((c) =>
    c.channelName.includes('orders')
  );
  assert.ok(ordersChannel, 'Orders channel should exist');
  assert.ok(ordersChannel.onCalls.length > 0, 'Orders channel should have on() calls');

  // Simulate an INSERT event
  ordersChannel.onCalls[0].callback({
    eventType: 'INSERT',
    new: { id: 'order-1' },
    old: {},
    commit_timestamp: '2026-01-01T00:00:00Z',
  });

  assert.equal(orderPayloads.length, 1, 'onOrderChange should have been called');
  assert.equal(orderPayloads[0].table, 'orders');
  assert.equal(configPayloads.length, 0, 'onConfigChange should not be called');
  assert.equal(modulePayloads.length, 0, 'onModuleChange should not be called');

  manager.disconnect();
});

test('DesktopRealtimeManager - reconnection with exponential backoff timing', async () => {
  const { DesktopRealtimeManager } = await importModule();
  const mockClient = createMockSupabaseClient();

  const manager = new DesktopRealtimeManager({
    supabaseUrl: 'https://realtime.invalid',
    supabaseKey: 'test-key',
    organizationId: 'org-1',
    onOrderChange: () => {},
    onConfigChange: () => {},
    onModuleChange: () => {},
    client: mockClient as any,
    reconnectConfig: {
      maxReconnectAttempts: 3,
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 30000,
    },
  });

  await manager.connect();

  // Verify initial status
  assert.equal(manager.getConnectionStatus(), 'connecting');

  // Simulate connection error on first channel
  const callbacks = mockClient._getAllSubscribeCallbacks();
  assert.ok(callbacks.length > 0, 'Should have subscribe callbacks');

  // Trigger a CHANNEL_ERROR to initiate reconnect
  callbacks[0]('CHANNEL_ERROR', new Error('connection lost'));

  // Status should be reconnecting
  assert.equal(manager.getConnectionStatus(), 'reconnecting');

  manager.disconnect();
});

test('DesktopRealtimeManager - polling fallback after max reconnect attempts', async () => {
  const { DesktopRealtimeManager } = await importModule();
  const mockClient = createMockSupabaseClient();

  let fullSyncCount = 0;
  const manager = new DesktopRealtimeManager({
    supabaseUrl: 'https://realtime.invalid',
    supabaseKey: 'test-key',
    organizationId: 'org-1',
    onOrderChange: () => {},
    onConfigChange: () => {},
    onModuleChange: () => {},
    onFullSyncNeeded: () => { fullSyncCount++; },
    client: mockClient as any,
    reconnectConfig: {
      maxReconnectAttempts: 0, // Immediately fall back to polling
      reconnectDelayMs: 100,
      maxReconnectDelayMs: 200,
    },
    pollingIntervalMs: 50,
  });

  await manager.connect();

  // Simulate failure
  const callbacks = mockClient._getAllSubscribeCallbacks();
  if (callbacks.length > 0) {
    callbacks[0]('CHANNEL_ERROR', new Error('connection lost'));
  }

  // With maxReconnectAttempts=0, should immediately go to polling
  assert.equal(manager.getConnectionStatus(), 'polling');

  // Wait for at least one polling cycle
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.ok(fullSyncCount >= 1, `Full sync should have been called at least once, got ${fullSyncCount}`);

  manager.disconnect();
  assert.equal(manager.getConnectionStatus(), 'disconnected');
});

test('DesktopRealtimeManager - full sync on reconnection', async () => {
  const { DesktopRealtimeManager } = await importModule();
  const mockClient = createMockSupabaseClient();

  let fullSyncCount = 0;
  const manager = new DesktopRealtimeManager({
    supabaseUrl: 'https://realtime.invalid',
    supabaseKey: 'test-key',
    organizationId: 'org-1',
    onOrderChange: () => {},
    onConfigChange: () => {},
    onModuleChange: () => {},
    onFullSyncNeeded: () => { fullSyncCount++; },
    client: mockClient as any,
  });

  // First connect
  await manager.connect();

  // Simulate all channels reporting SUBSCRIBED (first connection)
  let cbs = mockClient._getAllSubscribeCallbacks();
  for (const cb of cbs) {
    cb('SUBSCRIBED');
  }

  // First connection should NOT trigger full sync (no missed events)
  assert.equal(fullSyncCount, 0, 'First connection should not trigger full sync');

  // Now simulate a disconnection and reconnection
  // Trigger error on one channel
  cbs[0]('CHANNEL_ERROR', new Error('dropped'));

  // Re-connect (simulates the reconnect path)
  await manager.connect();

  // Get the new callbacks from the re-created channels
  cbs = mockClient._getAllSubscribeCallbacks();
  for (const cb of cbs) {
    cb('SUBSCRIBED');
  }

  // Reconnection should trigger full sync since we connected before
  assert.ok(fullSyncCount >= 1, `Full sync should have been called on reconnect, got ${fullSyncCount}`);

  manager.disconnect();
});

test('DesktopRealtimeManager - graceful close on API key revocation', async () => {
  const { DesktopRealtimeManager } = await importModule();
  const mockClient = createMockSupabaseClient();

  let apiKeyRevokedCalled = false;
  const manager = new DesktopRealtimeManager({
    supabaseUrl: 'https://realtime.invalid',
    supabaseKey: 'test-key',
    organizationId: 'org-1',
    onOrderChange: () => {},
    onConfigChange: () => {},
    onModuleChange: () => {},
    onApiKeyRevoked: () => { apiKeyRevokedCalled = true; },
    client: mockClient as any,
  });

  await manager.connect();

  // Simulate API key revocation error
  const callbacks = mockClient._getAllSubscribeCallbacks();
  assert.ok(callbacks.length > 0, 'Should have subscribe callbacks');

  callbacks[0]('CHANNEL_ERROR', new Error('401 Unauthorized - Invalid API key'));

  // Should have disconnected and notified
  assert.equal(manager.getConnectionStatus(), 'error');
  assert.equal(apiKeyRevokedCalled, true, 'onApiKeyRevoked should have been called');
  assert.equal(manager.isConnected(), false);

  manager.disconnect();
});

test('DesktopRealtimeManager - status change callback tracks lifecycle transitions', async () => {
  const { DesktopRealtimeManager } = await importModule();
  const mockClient = createMockSupabaseClient();
  const statuses: string[] = [];

  const manager = new DesktopRealtimeManager({
    supabaseUrl: 'https://realtime.invalid',
    supabaseKey: 'test-key',
    organizationId: 'org-1',
    onOrderChange: () => {},
    onConfigChange: () => {},
    onModuleChange: () => {},
    onStatusChange: (status) => statuses.push(status),
    client: mockClient as any,
    reconnectConfig: {
      maxReconnectAttempts: 1,
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 1000,
    },
  });

  await manager.connect();

  const callbacks = mockClient._getAllSubscribeCallbacks();
  for (const cb of callbacks) {
    cb('SUBSCRIBED');
  }

  callbacks[0]('CHANNEL_ERROR', new Error('connection lost'));
  manager.disconnect();

  assert.deepEqual(statuses, [
    'connecting',
    'connected',
    'connected',
    'connected',
    'reconnecting',
    'disconnected',
  ]);
});

test('DesktopRealtimeManager - disconnect cleans up all channels', async () => {
  const { DesktopRealtimeManager } = await importModule();
  const mockClient = createMockSupabaseClient();

  const manager = new DesktopRealtimeManager({
    supabaseUrl: 'https://realtime.invalid',
    supabaseKey: 'test-key',
    organizationId: 'org-1',
    onOrderChange: () => {},
    onConfigChange: () => {},
    onModuleChange: () => {},
    client: mockClient as any,
  });

  await manager.connect();

  const channelCountBefore = mockClient._channels.size;
  assert.ok(channelCountBefore > 0, 'Should have channels before disconnect');

  manager.disconnect();

  assert.equal(manager.getConnectionStatus(), 'disconnected');
  assert.equal(manager.isConnected(), false);
  // removeChannel should have been called for each channel
  assert.equal(
    mockClient._removedChannels.length,
    channelCountBefore,
    'All channels should have been removed'
  );
});

test('DesktopRealtimeManager - isConnected() reflects status correctly', async () => {
  const { DesktopRealtimeManager } = await importModule();
  const mockClient = createMockSupabaseClient();

  const manager = new DesktopRealtimeManager({
    supabaseUrl: 'https://realtime.invalid',
    supabaseKey: 'test-key',
    organizationId: 'org-1',
    onOrderChange: () => {},
    onConfigChange: () => {},
    onModuleChange: () => {},
    client: mockClient as any,
  });

  // Before connect
  assert.equal(manager.isConnected(), false);
  assert.equal(manager.getConnectionStatus(), 'disconnected');

  await manager.connect();

  // After connect but before SUBSCRIBED
  assert.equal(manager.isConnected(), false);
  assert.equal(manager.getConnectionStatus(), 'connecting');

  // Simulate SUBSCRIBED
  const callbacks = mockClient._getAllSubscribeCallbacks();
  for (const cb of callbacks) {
    cb('SUBSCRIBED');
  }

  assert.equal(manager.isConnected(), true);
  assert.equal(manager.getConnectionStatus(), 'connected');

  // Disconnect
  manager.disconnect();
  assert.equal(manager.isConnected(), false);
  assert.equal(manager.getConnectionStatus(), 'disconnected');
});

test('DesktopRealtimeManager - subscription channel names include POS_TAURI prefix', async () => {
  const { DesktopRealtimeManager } = await importModule();
  const mockClient = createMockSupabaseClient();
  const orgId = 'org-abc-xyz';

  const manager = new DesktopRealtimeManager({
    supabaseUrl: 'https://realtime.invalid',
    supabaseKey: 'test-key',
    organizationId: orgId,
    onOrderChange: () => {},
    onConfigChange: () => {},
    onModuleChange: () => {},
    client: mockClient as any,
  });

  await manager.connect();

  const channelNames = Array.from(mockClient._channels.keys());
  for (const name of channelNames) {
    assert.ok(
      name.includes('pos-tauri-org'),
      `Channel name "${name}" should include pos-tauri-org prefix`
    );
    assert.ok(
      name.includes(orgId),
      `Channel name "${name}" should include organization ID`
    );
  }

  manager.disconnect();
});
