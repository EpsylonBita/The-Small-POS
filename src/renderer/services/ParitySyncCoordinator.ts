import { environment } from '../../config/environment';
import { emitCompatEvent, getBridge } from '../../lib';
import { getSyncQueueBridge } from './SyncQueueBridge';
import { getCachedTerminalCredentials } from './terminal-credentials';
import type { QueueStatus, SyncResult } from '../../../../shared/pos/sync-queue-types';

export const PARITY_QUEUE_STATUS_EVENT = 'parity-queue:status';
export const REALTIME_STATUS_EVENT = 'realtime:status';

type RuntimeConfigLike = Record<string, unknown> | null;

export interface ParitySyncCycleResult {
  config: RuntimeConfigLike;
  queueStatus: QueueStatus | null;
  paritySyncResult: SyncResult | null;
  legacySyncTriggered: boolean;
}

let inFlightSync: Promise<ParitySyncCycleResult> | null = null;

function getAdvisoryCachePaths(config: RuntimeConfigLike): string[] {
  const terminalId = readString(config, 'terminal_id', 'terminalId');
  const dynamicPaths = terminalId
    ? [
        `/api/pos/settings/${encodeURIComponent(terminalId)}`,
        `/api/pos/settings/${encodeURIComponent(terminalId)}?category=menu`,
      ]
    : [];

  return [
    ...dynamicPaths,
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
  ];
}

function getVerticalCachePrefixes(): string[] {
  return [
    '/api/pos/reservations',
    '/api/pos/appointments',
    '/api/pos/drive-through',
    '/api/pos/rooms',
    '/api/pos/housekeeping',
    '/api/pos/guest-billing',
    '/api/pos/products',
    '/api/pos/product-categories',
  ];
}

function currentWeekRange(): { start_date: string; end_date: string } {
  const start = new Date()
  const normalized = new Date(start)
  normalized.setHours(0, 0, 0, 0)
  const day = normalized.getDay()
  const diff = day === 0 ? -6 : 1 - day
  normalized.setDate(normalized.getDate() + diff)
  const end = new Date(normalized)
  end.setDate(end.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  return {
    start_date: normalized.toISOString(),
    end_date: end.toISOString(),
  }
}

async function warmAdvisoryPageCaches(config: RuntimeConfigLike): Promise<void> {
  const bridge = getBridge();
  const cachePaths = getAdvisoryCachePaths(config);

  await Promise.allSettled(
    cachePaths.map((path) => bridge.adminApi.fetchFromAdmin(path, { method: 'GET' })),
  );

  await Promise.allSettled([
    bridge.loyalty?.syncSettings?.(),
    bridge.loyalty?.syncCustomers?.(),
  ]);

  const cachedPathResult = await bridge
    .invoke('api:list-cached-paths', { prefixes: getVerticalCachePrefixes() })
    .catch(() => null) as { success?: boolean; paths?: string[] } | null
  const cachedVerticalPaths = Array.isArray(cachedPathResult?.paths) ? cachedPathResult?.paths : []
  if (cachedVerticalPaths.length > 0) {
    await Promise.allSettled(
      cachedVerticalPaths.map((path) => bridge.adminApi.fetchFromAdmin(path, { method: 'GET' })),
    )
  }

  await Promise.allSettled([
    bridge.staffSchedule.list(currentWeekRange()),
  ])
}

function readString(source: RuntimeConfigLike, ...keys: string[]): string {
  if (!source) {
    return '';
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

async function getRuntimeConfig(): Promise<RuntimeConfigLike> {
  try {
    const config = await getBridge().terminalConfig.getFullConfig();
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      return config as Record<string, unknown>;
    }
  } catch {
    // Ignore config fetch failures; callers will fall back to cached values.
  }

  return null;
}

async function resolveParitySyncCredentials(config: RuntimeConfigLike): Promise<{
  adminUrl: string;
  apiKey: string;
}> {
  const bridge = getBridge();
  const cachedCredentials = getCachedTerminalCredentials();

  const adminUrl =
    readString(config, 'admin_dashboard_url', 'admin_url') ||
    (typeof window !== 'undefined'
      ? (window.localStorage.getItem('admin_dashboard_url') || '').trim()
      : '') ||
    environment.ADMIN_DASHBOARD_URL;

  const apiKeyCandidates = await Promise.allSettled([
    bridge.terminalConfig.getSetting('terminal', 'pos_api_key'),
    bridge.terminalConfig.getSetting('terminal', 'api_key'),
  ]);

  const apiKey =
    apiKeyCandidates
      .map((candidate) =>
        candidate.status === 'fulfilled' && typeof candidate.value === 'string'
          ? candidate.value.trim()
          : '',
      )
      .find(Boolean) ||
    readString(config, 'pos_api_key', 'api_key') ||
    cachedCredentials.apiKey;

  return {
    adminUrl: adminUrl.trim(),
    apiKey: apiKey.trim(),
  };
}

export async function emitParityQueueStatus(queueStatus?: QueueStatus | null): Promise<QueueStatus | null> {
  const resolvedStatus = queueStatus ?? (await getSyncQueueBridge().getStatus().catch(() => null));
  emitCompatEvent(PARITY_QUEUE_STATUS_EVENT, resolvedStatus);
  return resolvedStatus;
}

export async function runParitySyncCycle(options?: {
  forceLegacySync?: boolean;
  syncTerminalConfig?: boolean;
}): Promise<ParitySyncCycleResult> {
  if (!inFlightSync) {
    inFlightSync = (async () => {
      const bridge = getBridge();
      const syncQueue = getSyncQueueBridge();
      const shouldSyncTerminalConfig = options?.syncTerminalConfig !== false;
      const requestedLegacySync = options?.forceLegacySync;

      if (shouldSyncTerminalConfig) {
        try {
          await bridge.terminalConfig.syncFromAdmin();
        } catch (error) {
          console.warn('[ParitySyncCoordinator] Terminal config sync failed:', error);
        }
      }

      const config = await getRuntimeConfig();
      const { adminUrl, apiKey } = await resolveParitySyncCredentials(config);

      let paritySyncResult: SyncResult | null = null;
      if (adminUrl && apiKey) {
        try {
          paritySyncResult = await syncQueue.processQueue(adminUrl, apiKey);
        } catch (error) {
          console.warn('[ParitySyncCoordinator] Parity queue sync failed:', error);
        }
      }

      try {
        await warmAdvisoryPageCaches(config);
      } catch (error) {
        console.warn('[ParitySyncCoordinator] Advisory cache warmup failed:', error);
      }

      let shouldForceLegacySync = requestedLegacySync === true;
      if (requestedLegacySync == null) {
        try {
          const legacyStatus = (await bridge.sync.getStatus()) as unknown as Record<
            string,
            unknown
          >;
          shouldForceLegacySync =
            Number(legacyStatus?.pendingItems ?? 0) > 0 ||
            Number(legacyStatus?.pendingPaymentItems ?? 0) > 0 ||
            Number(legacyStatus?.queuedRemote ?? 0) > 0 ||
            Number(legacyStatus?.backpressureDeferred ?? 0) > 0;
        } catch {
          shouldForceLegacySync = false;
        }
      }

      if (shouldForceLegacySync) {
        await bridge.sync.force();
      }

      const queueStatus = await emitParityQueueStatus();

      if (config) {
        emitCompatEvent('terminal-config-updated', config);
      }

      return {
        config,
        queueStatus,
        paritySyncResult,
        legacySyncTriggered: shouldForceLegacySync,
      };
    })().finally(() => {
      inFlightSync = null;
    });
  }

  return inFlightSync;
}
