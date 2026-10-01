import { getBridge, isBrowser } from '../../lib';
import { posApiGet } from '../utils/api-helpers';
import { getOptionalWarmupModules } from './pos-module-warmup-access';
import { fetchAllPages, SnapshotAccessError, VersionedSnapshot, type Snapshot } from './versioned-snapshot';

type Row = Record<string, any>;
type Module = 'inventory' | 'product_catalog';
type Data = { rows: Row[]; categories: Row[] };
type Overlay = { table: string; id: string; data: Row };
const engines = new Map<Module, VersionedSnapshot<Data>>();
const storageKey = (module: Module) => `pos-complete-snapshot-v1:${module}`;
async function request(path: string): Promise<Row> {
  const result: any = isBrowser() ? await posApiGet(path) : await getBridge().adminApi.fetchFromAdmin(path, { method: 'GET' });
  if ([401, 403].includes(result?.status)) throw new SnapshotAccessError('Module access denied');
  if (!result?.success || result.data?.success === false || result.meta?.source === 'cache') throw new Error(result?.error || 'Fresh snapshot unavailable');
  return result.data;
}
function engine(module: Module): VersionedSnapshot<Data> {
  if (!engines.has(module)) engines.set(module, new VersionedSnapshot<Data>({
    version: async () => {
      try {
        const data = await request(`/api/pos/sync-version?module=${module}`);
        return typeof data?.version === 'string' ? data.version : null;
      } catch (error) { if (error instanceof SnapshotAccessError) throw error; return null; }
    },
    fetch: async () => {
      const endpoint = module === 'inventory' ? 'inventory' : 'products';
      const rows = await fetchAllPages<Row>(async offset => {
        const data = await request(`/api/pos/${endpoint}?limit=200&offset=${offset}`);
        if (!Array.isArray(data[endpoint]) || typeof data.pagination?.hasMore !== 'boolean') throw new Error('Incomplete snapshot response');
        return { rows: data[endpoint], pagination: data.pagination };
      });
      const categories = module === 'product_catalog' ? await fetchAllPages<Row>(async offset => {
        const data = await request(`/api/pos/product-categories?limit=200&offset=${offset}`);
        if (!Array.isArray(data.categories) || typeof data.pagination?.hasMore !== 'boolean') throw new Error('Incomplete categories response');
        return { rows: data.categories, pagination: data.pagination };
      }) : [];
      return { rows, categories };
    },
    load: scope => {
      try { const value = JSON.parse(localStorage.getItem(storageKey(module)) || 'null') as Snapshot<Data> | null; return value?.scope === scope ? value : null; } catch { return null; }
    },
    save: value => { if (value) localStorage.setItem(storageKey(module), JSON.stringify(value)); else localStorage.removeItem(storageKey(module)); },
  }));
  return engines.get(module)!;
}

export function overlayPendingRows(rows: Row[], overlays: Overlay[], module: Module): Row[] {
  return rows.map(original => {
    const row = { ...original };
    for (const item of overlays) {
      if (module === 'product_catalog' && item.table === 'products' && item.id === row.id) row.quantity = Number(item.data.quantity);
      if (module === 'inventory' && item.table === 'inventory_adjustments' && item.data.product_id === (row.product_id || row.id)) {
        row.stock_quantity = Number(row.stock_quantity ?? row.quantity ?? 0) + Number(item.data.adjustment || 0);
      }
    }
    return row;
  });
}

export async function readModuleSnapshot(module: Module, force = false): Promise<Data> {
  const bridge = getBridge();
  const config = await bridge.terminalConfig.getFullConfig() as Record<string, unknown>;
  const scope = JSON.stringify([config?.organization_id, config?.branch_id, config?.terminal_id]);
  const access = await getOptionalWarmupModules(config, true);
  if (!config?.organization_id || !config?.terminal_id || !access.has(module === 'inventory' ? 'inventory' : 'product_catalog')) {
    engine(module).revoke();
    throw new SnapshotAccessError('Module unavailable for current terminal');
  }
  const pending = isBrowser() ? [] : await bridge.invoke('inventory_snapshot_overlays') as Overlay[];
  const relevantPending = pending.some(item => item.table === (module === 'inventory' ? 'inventory_adjustments' : 'products'));
  // Freeze the raw baseline while unresolved deltas exist. A retry may already
  // have reached the server; replacing that baseline could apply it twice.
  const cached = relevantPending ? engine(module).cached(scope) : null;
  const data = cached ?? await engine(module).read(scope, force);
  // Read all unresolved mutations locally, including failed/conflicted entries.
  // Keep the stored snapshot raw so repeated reads never apply a delta twice.
  const overlays = isBrowser() ? [] : await bridge.invoke('inventory_snapshot_overlays') as Overlay[];
  const current = await bridge.terminalConfig.getFullConfig() as Record<string, unknown>;
  if (scope !== JSON.stringify([current?.organization_id, current?.branch_id, current?.terminal_id])) {
    engine(module).revoke();
    throw new SnapshotAccessError('Terminal changed during snapshot');
  }
  return { ...data, rows: overlayPendingRows(data.rows, overlays, module) };
}
