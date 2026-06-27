import { posApiGet } from './api-helpers';

export interface PosIntegrationEntitlementPayload {
  id?: unknown;
  plugin_id?: unknown;
  provider?: unknown;
  is_purchased?: unknown;
  is_enabled?: unknown;
}

const LEGACY_FISCAL_PLUGIN_IDS = new Set(['mydata']);

export function normalizeFiscalPluginId(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : '';
}

export function isFiscalOrderReportingPlugin(value: PosIntegrationEntitlementPayload): boolean {
  const pluginId = normalizeFiscalPluginId(value.plugin_id ?? value.provider ?? value.id);
  return LEGACY_FISCAL_PLUGIN_IDS.has(pluginId) || pluginId.startsWith('fiscalization_');
}

export function hasAcquiredFiscalOrderReportingIntegration(value: unknown): boolean {
  const integrations = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { integrations?: unknown }).integrations)
      ? (value as { integrations: unknown[] }).integrations
      : [];

  return integrations.some((integration) => {
    if (!integration || typeof integration !== 'object') {
      return false;
    }

    const row = integration as PosIntegrationEntitlementPayload;
    return (
      isFiscalOrderReportingPlugin(row) &&
      row.is_purchased === true &&
      row.is_enabled !== false
    );
  });
}

export async function loadFiscalOrderReportingEntitlement(): Promise<boolean> {
  const response = await posApiGet<{ integrations?: PosIntegrationEntitlementPayload[] }>('/pos/integrations');
  if (!response.success) {
    return false;
  }

  return hasAcquiredFiscalOrderReportingIntegration(response.data);
}
