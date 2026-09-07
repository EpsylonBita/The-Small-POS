export type TerminalConfigHealthState = 'healthy' | 'stale' | 'offline' | 'unavailable' | 'error' | 'unknown';

export interface TerminalConfigHealth {
  state: TerminalConfigHealthState;
  isHealthy: boolean;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}

const HEALTHY_STATES = new Set(['polling', 'healthy', 'online', 'ok', 'synced', 'connected', 'good', 'live']);
const OFFLINE_STATES = new Set(['offline', 'disconnected', 'not_connected', 'not connected']);
const ERROR_STATES = new Set(['error', 'failed', 'degraded']);

/**
 * Admin-configuration freshness, not order-queue or network health.
 * Native `polling` means credentials are available and config sync succeeded
 * within its freshness window; periodic polling is the normal transport.
 */
export function resolveTerminalConfigHealth(value: unknown): TerminalConfigHealth {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (HEALTHY_STATES.has(normalized)) return { state: 'healthy', isHealthy: true, tone: 'success' };
  if (normalized === 'stale') return { state: 'stale', isHealthy: false, tone: 'warning' };
  if (OFFLINE_STATES.has(normalized)) return { state: 'offline', isHealthy: false, tone: 'danger' };
  if (normalized === 'unavailable') return { state: 'unavailable', isHealthy: false, tone: 'danger' };
  if (ERROR_STATES.has(normalized)) return { state: 'error', isHealthy: false, tone: 'danger' };
  return { state: 'unknown', isHealthy: false, tone: 'neutral' };
}
