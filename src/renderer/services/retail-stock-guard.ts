/**
 * Desktop wrapper of the shared overselling rule (`retail.block_overselling`,
 * `shared/retail-stock.ts`; vertical salon follow-ups 21/10/2026).
 *
 * Android runs the same rule against the same parity cases. This file only
 * adapts the desktop's two cart shapes, the till's unsynced own sales (a
 * native command) and the toast; the decision itself stays in the shared rule.
 */
import toast from 'react-hot-toast';
import { getBridge, isBrowser } from '../../lib';
import {
  retailStockKey,
  retailStockShortfall,
  type RetailStockLine,
  type RetailStockVerdict,
} from '../../../../shared/retail-stock';

export { retailStockKey };
export type { RetailStockLine, RetailStockVerdict };

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The terminal setting as the feed stores it: a boolean or its text form. Default false. */
export function readBlockOverselling(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/** The `retail.block_overselling` reader over the local settings map (nested or flat keys). */
export function blockOversellingFromSettings(settings: unknown): boolean {
  const map = (settings ?? {}) as Record<string, any>;
  return readBlockOverselling(map?.retail?.block_overselling ?? map?.['retail.block_overselling']);
}

const CACHE_TTL_MS = 5_000;

let settingCache: { at: number; value: boolean } | null = null;

/** Reads the setting for a cart that has no reader of its own (MenuCart); cached briefly. */
export async function loadBlockOverselling(now = Date.now()): Promise<boolean> {
  if (settingCache && now - settingCache.at < CACHE_TTL_MS) return settingCache.value;
  try {
    const value = blockOversellingFromSettings(await getBridge().settings.getLocal());
    settingCache = { at: now, value };
    return value;
  } catch {
    return false;
  }
}

export type UnsyncedRetailQuantities = ReadonlyMap<string, number>;

const EMPTY: UnsyncedRetailQuantities = new Map();
let unsyncedCache: { at: number; value: UnsyncedRetailQuantities } | null = null;
let unsyncedInFlight: Promise<UnsyncedRetailQuantities> | null = null;

/**
 * This till's retail sales that have not reached the server, keyed by
 * `retailStockKey`. Fetched when a catalog opens and again after each add,
 * cached for a few seconds. A failure counts nothing: unknown never blocks,
 * and the server caps the deduction.
 */
export async function loadUnsyncedRetailQuantities(
  options: { force?: boolean; now?: number } = {},
): Promise<UnsyncedRetailQuantities> {
  const now = options.now ?? Date.now();
  if (!options.force && unsyncedCache && now - unsyncedCache.at < CACHE_TTL_MS) return unsyncedCache.value;
  if (unsyncedInFlight && !options.force) return unsyncedInFlight;
  const request = (async () => {
    try {
      if (isBrowser()) return EMPTY;
      const result = await getBridge().orders.getUnsyncedRetailQuantities();
      const value = new Map<string, number>();
      for (const row of result?.success && Array.isArray(result.quantities) ? result.quantities : []) {
        const quantity = Number(row?.quantity);
        if (typeof row?.productId !== 'string' || !row.productId || !Number.isFinite(quantity) || quantity <= 0) continue;
        const key = retailStockKey(row.productId, row.variantId);
        value.set(key, (value.get(key) ?? 0) + quantity);
      }
      unsyncedCache = { at: now, value };
      return value as UnsyncedRetailQuantities;
    } catch {
      return EMPTY;
    } finally {
      unsyncedInFlight = null;
    }
  })();
  unsyncedInFlight = request;
  return request;
}

/** Drops the cached setting and unsynced quantities (tests, terminal change). */
export function resetRetailStockGuardCache(): void {
  settingCache = null;
  unsyncedCache = null;
  unsyncedInFlight = null;
}

/** A retail catalog line: `id` is the product, `lineId` the line, `cartQuantity` the amount (its `quantity` is stock). */
export interface CatalogCartLine {
  id: string;
  lineId: string;
  cartQuantity: number;
  retail_variant_id?: string | null;
  is_offer_reward?: boolean;
  reward_item_id?: string | null;
}

export function catalogCartStockLine(line: CatalogCartLine): RetailStockLine {
  return {
    id: line.lineId,
    // A reward line hands over the granted product; its id is synthetic.
    retailProductId: line.is_offer_reward ? line.reward_item_id ?? null : line.id,
    retailVariantId: line.is_offer_reward ? null : line.retail_variant_id ?? null,
    quantity: line.cartQuantity,
  };
}

/** An order line (MenuCart, salon picker): `id` is the line, `retail_product_id` the product. */
export interface OrderStockSourceLine {
  id?: string | number | null;
  quantity?: number | null;
  retail_product_id?: string | null;
  retailProductId?: string | null;
  retail_variant_id?: string | null;
  retailVariantId?: string | null;
  line_role?: string | null;
}

/** Null for a line that is not a retail product (menu, service, manual). */
export function orderLineStockLine(line: OrderStockSourceLine): RetailStockLine | null {
  const productId = line.retail_product_id ?? line.retailProductId ?? null;
  if (typeof productId !== 'string' || !productId) return null;
  return {
    id: line.id === null || line.id === undefined ? null : String(line.id),
    retailProductId: productId,
    retailVariantId: line.retail_variant_id ?? line.retailVariantId ?? null,
    quantity: Number(line.quantity) || 0,
    isDeposit: line.line_role === 'deposit',
  };
}

export function orderStockLines(lines: readonly OrderStockSourceLine[]): RetailStockLine[] {
  return lines.map(orderLineStockLine).filter((line): line is RetailStockLine => line !== null);
}

export interface DesktopRetailStockCheck {
  blockOverselling: boolean;
  productId: string;
  variantId?: string | null;
  stock: number | null | undefined;
  nextQuantity: number;
  editedLineId?: string | null;
  previousQuantity?: number | null;
  lines: readonly RetailStockLine[];
  unsynced?: UnsyncedRetailQuantities;
}

/** The shared rule with this till's unsynced sales of the same product or variant. */
export function desktopRetailStockVerdict(check: DesktopRetailStockCheck): RetailStockVerdict {
  const { unsynced, ...rest } = check;
  return retailStockShortfall({
    ...rest,
    unsyncedQuantity: unsynced?.get(retailStockKey(check.productId, check.variantId)) ?? 0,
  });
}

const PIECE_UNITS = new Set(['', 'piece', 'pieces', 'pc', 'pcs', 'unit', 'units', 'each', 'ea', 'item']);

export function retailStockBlockedMessage(t: Translate, available: number | null, unit?: string | null): string {
  const raw = (unit ?? '').trim();
  const unitLabel = PIECE_UNITS.has(raw.toLowerCase())
    ? t('retailStock.unitPiece', { defaultValue: 'pcs' })
    : raw;
  // The same plain quantity the catalog shows as stock (three decimals at most).
  const amount = String(Math.round(Math.max(0, available ?? 0) * 1000) / 1000);
  return t('retailStock.onlyAvailable', {
    available: amount,
    unit: unitLabel,
    defaultValue: 'Only {{available}} {{unit}} in stock',
  });
}

/** Shows the hard block and returns true when the verdict refuses the change. */
export function refuseOversell(t: Translate, verdict: RetailStockVerdict, unit?: string | null): boolean {
  if (!verdict.blocked) return false;
  toast.error(retailStockBlockedMessage(t, verdict.available, unit));
  return true;
}

const finiteOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * Stock of a product or variant from the cached product snapshot, for carts
 * whose lines carry no stock (MenuCart, salon tickets). Null when unknown.
 */
export async function snapshotRetailStock(productId: string, variantId?: string | null): Promise<number | null> {
  try {
    const { readModuleSnapshot } = await import('./module-snapshots');
    const snapshot = await readModuleSnapshot('product_catalog', false, true);
    const row = snapshot.rows.find(candidate => candidate?.id === productId);
    if (!row) return null;
    if (!variantId) return finiteOrNull(row.quantity);
    const variant = Array.isArray(row.variants) ? row.variants.find((value: any) => value?.id === variantId) : null;
    return finiteOrNull(variant?.quantity);
  } catch {
    return null;
  }
}
