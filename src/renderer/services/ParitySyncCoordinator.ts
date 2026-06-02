import { environment } from '../../config/environment';
import { emitCompatEvent, getBridge } from '../../lib';
import { getSyncQueueBridge } from './SyncQueueBridge';
import {
  getPosModuleCachePrefixes,
  getPosModuleWarmPaths,
} from './pos-module-cache-registry';
import type {
  QueueStatus,
  SyncResult,
  SyncTelemetrySnapshot,
} from '../../../../shared/pos/sync-queue-types';

export const PARITY_QUEUE_STATUS_EVENT = 'parity-queue:status';
export const PARITY_SYNC_STATUS_EVENT = 'parity-sync:status';
export const REALTIME_STATUS_EVENT = 'realtime:status';

type RuntimeConfigLike = Record<string, unknown> | null;
export type ParitySyncTrigger =
  | 'startup'
  | 'scheduled_retry'
  | 'online'
  | 'manual'
  | 'realtime'
  | 'unknown';

export interface ParitySyncCredentialState {
  hasAdminUrl: boolean;
  hasApiKey: boolean;
}

export type ParitySyncStatus =
  | 'idle'
  | 'started'
  | 'completed'
  | 'skipped_missing_credentials'
  | 'failed';

export interface ParitySyncSnapshot {
  status: ParitySyncStatus;
  trigger: ParitySyncTrigger;
  startedAt: string;
  finishedAt: string | null;
  processed: number;
  failed: number;
  conflicts: number;
  remaining: number;
  error: string | null;
  reason: string | null;
  legacySyncTriggered: boolean;
  credentialState: ParitySyncCredentialState;
  queueStatus: QueueStatus | null;
  telemetry: SyncTelemetrySnapshot | null;
}

export interface ParitySyncCycleResult {
  config: RuntimeConfigLike;
  queueStatus: QueueStatus | null;
  paritySyncResult: SyncResult | null;
  legacySyncTriggered: boolean;
  credentialState: ParitySyncCredentialState;
  paritySyncStatus: ParitySyncSnapshot;
}

let inFlightSync: Promise<ParitySyncCycleResult> | null = null;
let lastParitySyncSnapshot: ParitySyncSnapshot = {
  status: 'idle',
  trigger: 'unknown',
  startedAt: new Date(0).toISOString(),
  finishedAt: null,
  processed: 0,
  failed: 0,
  conflicts: 0,
  remaining: 0,
  error: null,
  reason: null,
  legacySyncTriggered: false,
  credentialState: {
    hasAdminUrl: false,
    hasApiKey: false,
  },
  queueStatus: null,
  telemetry: null,
};

function describeCaughtError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return maybeMessage;
    }
  }
  return fallback;
}

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
    ...getPosModuleWarmPaths(),
  ];
}

function getVerticalCachePrefixes(): string[] {
  return getPosModuleCachePrefixes();
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
  hasApiKey: boolean;
  hasTerminalId: boolean;
}> {
  const adminUrl =
    readString(config, 'admin_dashboard_url', 'admin_url') ||
    (typeof window !== 'undefined'
      ? (window.localStorage.getItem('admin_dashboard_url') || '').trim()
      : '') ||
    environment.ADMIN_DASHBOARD_URL;

  const credentialStatus = await getBridge().settings.getCredentialStatus().catch(() => ({
    hasAdminUrl: Boolean(adminUrl.trim()),
    hasApiKey: false,
    hasTerminalId: false,
  }));

  return {
    adminUrl: adminUrl.trim(),
    hasApiKey: Boolean(credentialStatus.hasApiKey),
    hasTerminalId: Boolean(credentialStatus.hasTerminalId),
  };
}

function describeMissingCredentials(credentialState: ParitySyncCredentialState): string | null {
  const missing: string[] = [];
  if (!credentialState.hasAdminUrl) {
    missing.push('Admin URL');
  }
  if (!credentialState.hasApiKey) {
    missing.push('POS API key');
  }
  return missing.length > 0
    ? `${missing.join(' and ')} missing for parity sync.`
    : null;
}

async function persistParitySyncSnapshot(snapshot: ParitySyncSnapshot): Promise<void> {
  try {
    await getBridge().settings.updateLocal({
      settingType: 'diagnostics',
      settings: {
        last_parity_sync: JSON.stringify(snapshot),
      },
    });
  } catch (error) {
    console.warn('[ParitySyncCoordinator] Failed to persist parity sync snapshot:', error);
  }
}

async function publishParitySyncSnapshot(snapshot: ParitySyncSnapshot): Promise<void> {
  lastParitySyncSnapshot = snapshot;
  emitCompatEvent(PARITY_SYNC_STATUS_EVENT, snapshot);
  await persistParitySyncSnapshot(snapshot);
}

export function getLastParitySyncSnapshot(): ParitySyncSnapshot {
  return lastParitySyncSnapshot;
}

export async function emitParityQueueStatus(queueStatus?: QueueStatus | null): Promise<QueueStatus | null> {
  const resolvedStatus = queueStatus ?? (await getSyncQueueBridge().getStatus().catch(() => null));
  emitCompatEvent(PARITY_QUEUE_STATUS_EVENT, resolvedStatus);
  return resolvedStatus;
}

export async function runParitySyncCycle(options?: {
  forceLegacySync?: boolean;
  syncTerminalConfig?: boolean;
  trigger?: ParitySyncTrigger;
}): Promise<ParitySyncCycleResult> {
  if (!inFlightSync) {
    inFlightSync = (async () => {
      const bridge = getBridge();
      const syncQueue = getSyncQueueBridge();
      const shouldSyncTerminalConfig = options?.syncTerminalConfig !== false;
      const requestedLegacySync = options?.forceLegacySync;
      const trigger = options?.trigger ?? 'unknown';
      const startedAt = new Date().toISOString();

      if (shouldSyncTerminalConfig) {
        try {
          await bridge.terminalConfig.syncFromAdmin();
        } catch (error) {
          console.warn('[ParitySyncCoordinator] Terminal config sync failed:', error);
        }
      }

      const config = await getRuntimeConfig();
      const { adminUrl, hasApiKey, hasTerminalId } = await resolveParitySyncCredentials(config);
      const credentialState = {
        hasAdminUrl: Boolean(adminUrl.trim()),
        hasApiKey: hasApiKey && hasTerminalId,
      };
      const initialSnapshot: ParitySyncSnapshot = {
        status: 'started',
        trigger,
        startedAt,
        finishedAt: null,
        processed: 0,
        failed: 0,
        conflicts: 0,
        remaining: lastParitySyncSnapshot.queueStatus?.total ?? 0,
        error: null,
        reason: null,
        legacySyncTriggered: false,
        credentialState,
        queueStatus: lastParitySyncSnapshot.queueStatus,
        telemetry: null,
      };
      await publishParitySyncSnapshot(initialSnapshot);

      let paritySyncResult: SyncResult | null = null;
      let paritySyncError: string | null = null;
      let paritySyncReason: string | null = null;
      let paritySyncStatus: ParitySyncStatus = 'completed';

      if (credentialState.hasAdminUrl && credentialState.hasApiKey) {
        try {
          paritySyncResult = await syncQueue.processQueue();
        } catch (error) {
          paritySyncStatus = 'failed';
          paritySyncError = describeCaughtError(error, 'Unknown parity sync failure');
          console.warn('[ParitySyncCoordinator] Parity queue sync failed:', error);
        }
      } else {
        paritySyncStatus = 'skipped_missing_credentials';
        paritySyncReason = describeMissingCredentials(credentialState);
        console.warn('[ParitySyncCoordinator] Parity queue sync skipped:', paritySyncReason);
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
        try {
          await bridge.sync.force();
        } catch (error) {
          paritySyncStatus = 'failed';
          paritySyncError =
            paritySyncError ?? describeCaughtError(error, 'Legacy sync force failed');
          console.warn('[ParitySyncCoordinator] Legacy sync force failed:', error);
        }
      }

      const queueStatus = await emitParityQueueStatus();
      const completedSnapshot: ParitySyncSnapshot = {
        status: paritySyncStatus,
        trigger,
        startedAt,
        finishedAt: new Date().toISOString(),
        processed: paritySyncResult?.processed ?? 0,
        failed: paritySyncResult?.failed ?? 0,
        conflicts: paritySyncResult?.conflicts ?? 0,
        remaining: queueStatus?.total ?? 0,
        error: paritySyncError,
        reason: paritySyncReason,
        legacySyncTriggered: shouldForceLegacySync,
        credentialState,
        queueStatus,
        telemetry: paritySyncResult?.telemetry ?? null,
      };
      await publishParitySyncSnapshot(completedSnapshot);

      return {
        config,
        queueStatus,
        paritySyncResult,
        legacySyncTriggered: shouldForceLegacySync,
        credentialState,
        paritySyncStatus: completedSnapshot,
      };
    })().finally(() => {
      inFlightSync = null;
    });
  }

  return inFlightSync;
}
