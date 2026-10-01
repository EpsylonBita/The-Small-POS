import { getBridge } from '../../lib';

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

/**
 * Native ModuleSyncService cache contains the server's purchased AND terminal-
 * filtered modules. Its validity check includes age and org/branch/terminal/URL
 * identity. Stale/offline data stays available to pages, but cannot authorize
 * speculative optional warmup. Do not add a second module-network sync here.
 */
export async function getOptionalWarmupModules(config: Record<string, unknown> | null, allowStale = false): Promise<ReadonlySet<string>> {
  try {
    const cached = record(await getBridge().modules.getCached());
    if (cached?.success !== true || (!allowStale && (cached.isValid !== true || cached.stale === true)) || cached.identityMatch !== true) return new Set();
    const envelope = record(cached.modules);
    if (envelope?.success !== true || !Array.isArray(envelope.modules) ||
      typeof envelope.organization_id !== 'string' || !envelope.organization_id ||
      typeof envelope.terminal_id !== 'string' || !envelope.terminal_id) return new Set();
    const terminal = config?.terminal_id ?? config?.terminalId;
    const organization = config?.organization_id ?? config?.organizationId;
    if ((terminal && terminal !== envelope.terminal_id) || (organization && organization !== envelope.organization_id)) return new Set();
    return new Set(envelope.modules.flatMap(value => {
      const module = record(value);
      // Current endpoint omits is_enabled on already-filtered rows. Explicit
      // disabled/locked flags still deny, while purchase and POS flags must prove access.
      return module && typeof module.module_id === 'string' && module.is_purchased === true &&
        module.pos_enabled === true && module.is_enabled !== false && module.is_locked !== true
        ? [module.module_id === 'retail_products' ? 'product_catalog' : module.module_id] : [];
    }));
  } catch {
    return new Set();
  }
}
