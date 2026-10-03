import { readTwintManualQr } from '../../../../shared/payments/twint-qr';
import { getBridge } from '../../lib';
import { getCachedTerminalCredentials } from './terminal-credentials';

export type TwintManualConfiguration = { qrImageData: string; currency: 'CHF'; scope: string };
export function currentTwintScope(): string {
  const { organizationId, branchId, terminalId } = getCachedTerminalCredentials();
  return organizationId && branchId && terminalId ? `${organizationId}|${branchId}|${terminalId}` : '';
}
export function configuredStoreCurrency(settings: Record<string, unknown>): string | null {
  for (const category of ['organization', 'payment', 'restaurant', 'terminal']) {
    const nested = settings[category] as Record<string, unknown> | undefined;
    const raw = settings[`${category}.currency`] ?? nested?.currency;
    if (typeof raw !== 'string') continue;
    const code = raw.trim().replace(/^"|"$/g, '').trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(code)) return code;
  }
  return null;
}
/** A fresh scoped online read; nothing is cached for later payment admission. */
export async function loadTwintManualConfiguration(): Promise<TwintManualConfiguration | null> {
  const scope = currentTwintScope();
  if (!scope || navigator.onLine === false) return null;
  try {
    const [response, settings] = await Promise.all([
      getBridge().adminApi.fetchFromAdmin('/api/pos/integrations', { method: 'GET' }),
      getBridge().terminalConfig.getSettings(),
    ]);
    const envelope = response as { success?: boolean; data?: { integrations?: unknown[] }; meta?: { source?: string; offlineFallback?: boolean } };
    // The generic POS helper discards this native marker; a cached purchase/setup
    // cannot authorize a payment after an outage or revoked branch configuration.
    if (currentTwintScope() !== scope || !envelope.success || envelope.meta?.source !== 'remote'
      || envelope.meta.offlineFallback === true || configuredStoreCurrency(settings || {}) !== 'CHF') return null;
    const branchId = getCachedTerminalCredentials().branchId;
    for (const item of envelope.data?.integrations || []) {
      if (!item || typeof item !== 'object' || (item as Record<string, unknown>).branch_id !== branchId) continue;
      const configuration = readTwintManualQr(item);
      if (configuration) return { ...configuration, scope };
    }
  } catch { /* No fresh configuration means no manual payment choice. */ }
  return null;
}

export type TwintConfirmationAction = 'confirm' | 'skip';
export function twintManualMetadata(action: TwintConfirmationAction) {
  return { provider: 'twint', confirmation: 'cashier', confirmation_action: action, qr_mode: 'static_qr_manual' } as const;
}
