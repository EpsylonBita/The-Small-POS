import { ipcMain } from 'electron';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, getSupabaseConfig } from '../../../shared/supabase-config';
import { serviceRegistry } from '../../service-registry';

// Create a service role client for write operations (bypasses RLS)
let serviceRoleClient: SupabaseClient | null = null;

function getServiceRoleClient(): SupabaseClient | null {
  if (!serviceRoleClient) {
    const config = getSupabaseConfig('server');
    if (config.serviceRoleKey) {
      serviceRoleClient = createClient(config.url, config.serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
      console.log('[menu-handlers] Service role client initialized for write operations');
    } else {
      console.warn('[menu-handlers] Service role key not available, falling back to anon key (may fail RLS)');
    }
  }
  return serviceRoleClient;
}

// Get the appropriate client for write operations (prefer service role, fallback to anon)
function getWriteClient(): SupabaseClient {
  return getServiceRoleClient() || getSupabaseClient();
}

const MENU_SYNC_CACHE_TTL_MS = 60_000;
const menuSyncCache = new Map<string, { fetchedAt: number; data: any }>();
const INGREDIENT_CATEGORY_SNAPSHOT_TTL_MS = 60_000;
const SUBCATEGORY_INGREDIENT_SNAPSHOT_TTL_MS = 60_000;
const DEFAULT_INGREDIENT_COLORS = new Set(['#6b7280', '#808080', '#9ca3af', '#a1a1aa', 'gray', 'grey']);
let lastIngredientQualityWarningCycle: number | null = null;
let lastSubcategoryLinkFallbackWarningCycle: number | null = null;
const SUBCATEGORY_INGREDIENT_COLUMN_CAPABILITY_TTL_MS = 5 * 60_000;

type IngredientCategorySnapshotRow = {
  id?: string | null;
  parent_id?: string | null;
  flavor_type?: string | null;
  name?: string | null;
  is_active?: boolean | null;
};

type SubcategoryIngredientSnapshotRow = {
  subcategory_id?: string | null;
  ingredient_id?: string | null;
  quantity?: number | string | null;
  is_active?: boolean | null;
  is_default?: boolean | null;
  is_optional?: boolean | null;
  updated_at?: string | null;
  created_at?: string | null;
};

let ingredientCategorySnapshotCache: {
  fetchedAt: number;
  terminalId: string;
  data: IngredientCategorySnapshotRow[];
} | null = null;

let subcategoryIngredientSnapshotCache: {
  fetchedAt: number;
  terminalId: string;
  data: Array<{
    subcategory_id: string | null;
    ingredient_id: string | null;
    quantity: number;
    is_default: boolean;
    is_optional: boolean;
    is_active: boolean;
    updated_at: string | null;
  }>;
} | null = null;

type SubcategoryIngredientColumnCapabilities = {
  hasIsDefault: boolean;
  hasIsOptional: boolean;
  hasUpdatedAt: boolean;
  checkedAt: number;
};

let subcategoryIngredientColumnCapabilitiesCache: SubcategoryIngredientColumnCapabilities | null = null;

function normalizeAdminDashboardUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';

  let normalized = trimmed;
  if (!/^https?:\/\//i.test(normalized)) {
    const isLocalhost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(normalized);
    normalized = `${isLocalhost ? 'http' : 'https'}://${normalized}`;
  }

  try {
    const parsed = new URL(normalized);
    parsed.search = '';
    parsed.hash = '';
    const cleanPath = parsed.pathname.replace(/\/+$/, '').replace(/\/api$/i, '');
    parsed.pathname = cleanPath || '/';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return normalized.replace(/\/+$/, '').replace(/\/api$/i, '');
  }
}

function extractAdminUrlFromConnectionString(posApiKey: string): string {
  const trimmed = (posApiKey || '').trim();
  if (!trimmed || trimmed.length < 20) return '';

  try {
    const base64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    return normalizeAdminDashboardUrl((parsed?.url || '').toString());
  } catch {
    return '';
  }
}

function isLocalhostAdminUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname);
  } catch {
    return /(?:^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i.test(url);
  }
}

type AdminTerminalSyncContext = {
  terminalId: string;
  apiKey: string;
  adminUrl: string;
};

function resolveTerminalSyncContext(): AdminTerminalSyncContext | null {
  const dbSvc = serviceRegistry.dbManager?.getDatabaseService?.();
  const terminalId = (dbSvc?.settings?.getSetting?.('terminal', 'terminal_id', '') || '').toString();
  const apiKey = (dbSvc?.settings?.getSetting?.('terminal', 'pos_api_key', '') || '').toString();
  const storedAdminUrl = (dbSvc?.settings?.getSetting?.('terminal', 'admin_dashboard_url', '') || '').toString();
  const legacyAdminUrl = (dbSvc?.settings?.getSetting?.('terminal', 'admin_url', '') || '').toString();
  const envAdminUrl = (process.env.ADMIN_DASHBOARD_URL || process.env.ADMIN_API_BASE_URL || '').toString();

  let adminUrl = normalizeAdminDashboardUrl(storedAdminUrl) || normalizeAdminDashboardUrl(legacyAdminUrl);
  if (!adminUrl) {
    const decodedUrl = extractAdminUrlFromConnectionString(apiKey);
    if (decodedUrl) {
      adminUrl = decodedUrl;
      try {
        dbSvc?.settings?.setSetting?.('terminal', 'admin_dashboard_url', decodedUrl);
      } catch (persistError) {
        console.warn('[menu-handlers] Failed to persist decoded admin dashboard URL:', persistError);
      }
    }
  }
  if (!adminUrl) {
    const normalizedEnvAdminUrl = normalizeAdminDashboardUrl(envAdminUrl);
    if (normalizedEnvAdminUrl) {
      const hasTerminalCredentials = terminalId !== 'terminal-001' && !!apiKey;
      if (hasTerminalCredentials && isLocalhostAdminUrl(normalizedEnvAdminUrl)) {
        console.warn(
          '[menu-handlers] Admin dashboard URL not configured for terminal; refusing localhost fallback'
        );
        return null;
      }
      adminUrl = normalizedEnvAdminUrl;
    }
  }

  if (!terminalId || !apiKey || !adminUrl) {
    return null;
  }

  return {
    terminalId,
    apiKey,
    adminUrl,
  };
}

function parseFlavorType(value: unknown): 'savory' | 'sweet' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'sweet' || normalized.includes('sweet') || normalized.includes('γλυκ')) return 'sweet';
  if (
    normalized === 'savory'
    || normalized === 'savoury'
    || normalized.includes('savory')
    || normalized.includes('savoury')
    || normalized.includes('αλμυρ')
    || normalized.includes('salty')
    || normalized.includes('salt')
  ) return 'savory';
  return null;
}

function hasResolvedFlavorSignal(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  const nestedCategory = Array.isArray(item.ingredient_categories)
    ? item.ingredient_categories[0]
    : item.ingredient_categories;

  return !!(
    parseFlavorType(item.flavor_type)
    || parseFlavorType(item.flavorType)
    || parseFlavorType(item.category_flavor_type)
    || parseFlavorType(item.categoryFlavorType)
    || parseFlavorType(item.ingredient_subcategory)
    || parseFlavorType(item.ingredientSubcategory)
    || parseFlavorType(item.category_name)
    || parseFlavorType(item.categoryName)
    || parseFlavorType(nestedCategory?.flavor_type)
  );
}

function normalizeColorSignal(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function hasNonDefaultColorSignal(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  const nestedCategory = Array.isArray(item.ingredient_categories)
    ? item.ingredient_categories[0]
    : item.ingredient_categories;

  const color =
    normalizeColorSignal(item.item_color)
    || normalizeColorSignal(item.itemColor)
    || normalizeColorSignal(item.category_color)
    || normalizeColorSignal(item.categoryColor)
    || normalizeColorSignal(nestedCategory?.color_code)
    || normalizeColorSignal(nestedCategory?.colorCode);

  if (!color) return false;
  return !DEFAULT_INGREDIENT_COLORS.has(color);
}

function computeIngredientPayloadQuality(items: any[]): {
  total: number;
  resolvableFlavorCount: number;
  nonDefaultColorCount: number;
} {
  let resolvableFlavorCount = 0;
  let nonDefaultColorCount = 0;

  for (const item of items) {
    if (hasResolvedFlavorSignal(item)) {
      resolvableFlavorCount += 1;
    }
    if (hasNonDefaultColorSignal(item)) {
      nonDefaultColorCount += 1;
    }
  }

  return {
    total: items.length,
    resolvableFlavorCount,
    nonDefaultColorCount,
  };
}

function maybeWarnIngredientPayloadQuality(items: any[], cycleToken: number | null): void {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }

  const quality = computeIngredientPayloadQuality(items);
  const lowQuality = quality.resolvableFlavorCount === 0 || quality.nonDefaultColorCount === 0;
  if (!lowQuality) {
    return;
  }

  if (cycleToken !== null && lastIngredientQualityWarningCycle === cycleToken) {
    return;
  }

  if (cycleToken !== null) {
    lastIngredientQualityWarningCycle = cycleToken;
  }

  console.warn('[menu:get-ingredients] Low-quality ingredient metadata in menu-sync payload', {
    cycleToken,
    total: quality.total,
    resolvableFlavorCount: quality.resolvableFlavorCount,
    nonDefaultColorCount: quality.nonDefaultColorCount,
  });
}

function buildIngredientCategoryFlavorResolver(
  rows: IngredientCategorySnapshotRow[]
): (categoryId: string | null | undefined) => 'savory' | 'sweet' | null {
  const byId = new Map<string, { parentId: string | null; flavorType: string | null; name: string | null }>();
  for (const row of rows) {
    const rowId = typeof row?.id === 'string' ? row.id : null;
    if (!rowId) continue;
    byId.set(rowId, {
      parentId: typeof row.parent_id === 'string' ? row.parent_id : null,
      flavorType: typeof row.flavor_type === 'string' ? row.flavor_type : null,
      name: typeof row.name === 'string' ? row.name : null,
    });
  }

  return (categoryId: string | null | undefined) => {
    if (!categoryId) return null;

    const visited = new Set<string>();
    let currentId: string | null = categoryId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const current = byId.get(currentId);
      if (!current) break;

      const directFlavor = parseFlavorType(current.flavorType) || parseFlavorType(current.name);
      if (directFlavor) {
        return directFlavor;
      }
      currentId = current.parentId;
    }

    return null;
  };
}

function enrichIngredientsWithResolvedCategoryFlavor(
  items: any[],
  categoryRows: IngredientCategorySnapshotRow[]
): any[] {
  if (!Array.isArray(items) || items.length === 0 || !Array.isArray(categoryRows) || categoryRows.length === 0) {
    return items;
  }

  const resolveFlavorByCategoryId = buildIngredientCategoryFlavorResolver(categoryRows);
  return items.map((item) => {
    if (!item || typeof item !== 'object') {
      return item;
    }

    const alreadyResolved =
      parseFlavorType(item.flavor_type)
      || parseFlavorType(item.flavorType)
      || parseFlavorType(item.category_flavor_type)
      || parseFlavorType(item.categoryFlavorType)
      || parseFlavorType(item.ingredient_subcategory)
      || parseFlavorType(item.ingredientSubcategory)
      || parseFlavorType(item.category_name)
      || parseFlavorType(item.categoryName);
    if (alreadyResolved) {
      return item;
    }

    const categoryId = typeof item.category_id === 'string' ? item.category_id : null;
    const resolvedFromHierarchy = resolveFlavorByCategoryId(categoryId);
    if (!resolvedFromHierarchy) {
      return item;
    }

    return {
      ...item,
      category_flavor_type: resolvedFromHierarchy,
    };
  });
}

function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeError = error as { code?: string; message?: string };
  const code = maybeError.code || '';
  const message = maybeError.message || '';
  return (
    code === '42703'
    || code === 'PGRST204'
    || /column .* does not exist/i.test(message)
    || /Could not find the '.*' column/i.test(message)
  );
}

async function probeSubcategoryIngredientColumn(
  supabase: SupabaseClient,
  columnName: 'is_default' | 'is_optional' | 'updated_at'
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('subcategory_ingredients')
      .select(`subcategory_id, ingredient_id, ${columnName}`)
      .limit(1);

    if (!error) {
      return true;
    }

    if (isMissingColumnError(error)) {
      return false;
    }

    console.warn('[menu:get-subcategory-ingredients] Unexpected column probe error', {
      columnName,
      code: (error as { code?: string }).code,
      error: (error as { message?: string }).message,
    });
    return false;
  } catch (error) {
    console.warn('[menu:get-subcategory-ingredients] Column probe failed', {
      columnName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function getSubcategoryIngredientColumnCapabilities(supabase: SupabaseClient): Promise<SubcategoryIngredientColumnCapabilities> {
  const now = Date.now();
  if (
    subcategoryIngredientColumnCapabilitiesCache
    && now - subcategoryIngredientColumnCapabilitiesCache.checkedAt < SUBCATEGORY_INGREDIENT_COLUMN_CAPABILITY_TTL_MS
  ) {
    return subcategoryIngredientColumnCapabilitiesCache;
  }

  const [hasIsDefault, hasIsOptional, hasUpdatedAt] = await Promise.all([
    probeSubcategoryIngredientColumn(supabase, 'is_default'),
    probeSubcategoryIngredientColumn(supabase, 'is_optional'),
    probeSubcategoryIngredientColumn(supabase, 'updated_at'),
  ]);

  subcategoryIngredientColumnCapabilitiesCache = {
    hasIsDefault,
    hasIsOptional,
    hasUpdatedAt,
    checkedAt: now,
  };

  return subcategoryIngredientColumnCapabilitiesCache;
}

async function fetchIngredientCategorySnapshotFromAdmin(): Promise<IngredientCategorySnapshotRow[] | null> {
  try {
    const context = resolveTerminalSyncContext();
    if (!context) {
      return null;
    }

    if (
      ingredientCategorySnapshotCache
      && ingredientCategorySnapshotCache.terminalId === context.terminalId
      && Date.now() - ingredientCategorySnapshotCache.fetchedAt < INGREDIENT_CATEGORY_SNAPSHOT_TTL_MS
    ) {
      return ingredientCategorySnapshotCache.data;
    }

    const base = context.adminUrl.replace(/\/$/, '');
    const url = new URL('/api/pos/sync/ingredient_categories', base);
    url.searchParams.set('terminal_id', context.terminalId);
    url.searchParams.set('last_sync', '1970-01-01T00:00:00.000Z');
    url.searchParams.set('limit', '5000');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-terminal-id': context.terminalId,
        'x-pos-api-key': context.apiKey,
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      throw new Error(`ingredient category sync failed: HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload?.success || !Array.isArray(payload.data)) {
      throw new Error(payload?.error || 'ingredient category sync failed');
    }

    const activeRows = (payload.data as IngredientCategorySnapshotRow[]).filter((row) => row?.is_active !== false);
    ingredientCategorySnapshotCache = {
      fetchedAt: Date.now(),
      terminalId: context.terminalId,
      data: activeRows,
    };
    return activeRows;
  } catch (error) {
    console.warn('[menu:get-ingredients] Failed to fetch ingredient category snapshot for flavor enrichment', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function fetchSubcategoryIngredientSnapshotFromAdmin(): Promise<Array<{
  subcategory_id: string | null;
  ingredient_id: string | null;
  quantity: number;
  is_default: boolean;
  is_optional: boolean;
  is_active: boolean;
  updated_at: string | null;
}> | null> {
  try {
    const context = resolveTerminalSyncContext();
    if (!context) {
      return null;
    }

    if (
      subcategoryIngredientSnapshotCache
      && subcategoryIngredientSnapshotCache.terminalId === context.terminalId
      && Date.now() - subcategoryIngredientSnapshotCache.fetchedAt < SUBCATEGORY_INGREDIENT_SNAPSHOT_TTL_MS
    ) {
      return subcategoryIngredientSnapshotCache.data;
    }

    const base = context.adminUrl.replace(/\/$/, '');
    const url = new URL('/api/pos/sync/subcategory_ingredients', base);
    url.searchParams.set('terminal_id', context.terminalId);
    url.searchParams.set('last_sync', '1970-01-01T00:00:00.000Z');
    url.searchParams.set('limit', '10000');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-terminal-id': context.terminalId,
        'x-pos-api-key': context.apiKey,
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      throw new Error(`subcategory ingredient sync failed: HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload?.success || !Array.isArray(payload.data)) {
      throw new Error(payload?.error || 'subcategory ingredient sync failed');
    }

    const normalized = (payload.data as SubcategoryIngredientSnapshotRow[])
      .filter((row) => row?.is_active !== false)
      .map((row) => ({
        subcategory_id: typeof row?.subcategory_id === 'string' ? row.subcategory_id : null,
        ingredient_id: typeof row?.ingredient_id === 'string' ? row.ingredient_id : null,
        quantity: Number.isFinite(Number(row?.quantity)) ? Number(row?.quantity) : 1,
        is_default: row?.is_default === true,
        is_optional: row?.is_optional === true,
        is_active: row?.is_active !== false,
        updated_at: row?.updated_at ?? row?.created_at ?? null,
      }));

    subcategoryIngredientSnapshotCache = {
      fetchedAt: Date.now(),
      terminalId: context.terminalId,
      data: normalized,
    };

    return normalized;
  } catch (error) {
    console.warn('[menu:get-subcategory-ingredients] Failed to fetch subcategory ingredient snapshot from admin sync endpoint', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

type MenuSyncFetchOptions = {
  includeInactive?: boolean;
};

async function fetchMenuSyncData(options: MenuSyncFetchOptions = {}): Promise<any | null> {
  try {
    const includeInactive = !!options.includeInactive;
    const cacheKey = includeInactive ? 'all' : 'active';
    const cached = menuSyncCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < MENU_SYNC_CACHE_TTL_MS) {
      return cached.data;
    }

    const context = resolveTerminalSyncContext();
    if (!context) {
      return null;
    }

    const base = context.adminUrl.replace(/\/$/, '');
    const url = new URL('/api/pos/menu-sync', base);
    url.searchParams.set('terminal_id', context.terminalId);
    // Use an old timestamp to force a full payload for management views
    url.searchParams.set('last_sync', '1970-01-01T00:00:00.000Z');
    url.searchParams.set('include_inactive', includeInactive ? 'true' : 'false');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-terminal-id': context.terminalId,
      'x-pos-api-key': context.apiKey,
    };

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`Menu sync failed: HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload?.success || !payload?.menu_data) {
      throw new Error(payload?.error || 'Menu sync failed');
    }

    const cacheEntry = { fetchedAt: Date.now(), data: payload.menu_data };
    menuSyncCache.set(cacheKey, cacheEntry);
    return cacheEntry.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ECONNREFUSED|fetch failed/i.test(message)) {
      console.warn('[menu-handlers] Menu sync fallback skipped: admin API is unreachable');
    } else {
      console.warn('[menu-handlers] Menu sync fallback failed:', message);
    }
    return null;
  }
}

export function registerMenuHandlers(): void {
  // Remove existing handlers to avoid conflicts
  ipcMain.removeHandler('menu:get-categories');
  ipcMain.removeHandler('menu:get-subcategories');
  ipcMain.removeHandler('menu:get-ingredients');
  ipcMain.removeHandler('menu:get-subcategory-ingredients');
  ipcMain.removeHandler('menu:get-combos');
  ipcMain.removeHandler('menu:update-category');
  ipcMain.removeHandler('menu:update-subcategory');
  ipcMain.removeHandler('menu:update-ingredient');
  ipcMain.removeHandler('menu:update-combo');

  const mainWindow = serviceRegistry.mainWindow;

  // Get menu categories
  ipcMain.handle('menu:get-categories', async () => {
    try {
      // Prefer admin dashboard menu sync (uses terminal auth, bypasses RLS)
      const menuData = await fetchMenuSyncData({ includeInactive: true });
      const categories = Array.isArray(menuData?.categories) ? menuData.categories : null;
      if (categories) {
        return categories.filter((item: any) => {
          const name = (item.name || item.name_en || '').toLowerCase();
          return !name.includes('rls') && !name.startsWith('test ') && item.is_active !== false;
        });
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('menu_categories')
        .select('*')
        .order('display_order', { ascending: true });

      if (error) throw error;

      // Filter out RLS test data (categories with "RLS" or "test" in the name)
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name || item.name_en || '').toLowerCase();
        return !name.includes('rls') && !name.startsWith('test ');
      });

      return filteredData;
    } catch (error) {
      console.error('Error loading categories:', error);
      return [];
    }
  });

  // Get subcategories (menu items) - returns ALL items including inactive for management
  ipcMain.handle('menu:get-subcategories', async () => {
    try {
      // Prefer admin dashboard menu sync (uses terminal auth, bypasses RLS)
      const menuData = await fetchMenuSyncData({ includeInactive: true });
      const subcategories = Array.isArray(menuData?.subcategories) ? menuData.subcategories : null;
      if (subcategories) {
        return subcategories.filter((item: any) => {
          const name = (item.name || '').toLowerCase();
          return !name.includes('rls') && !name.startsWith('test ');
        });
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('subcategories')
        .select('*')
        .order('display_order', { ascending: true });

      if (error) throw error;

      // Filter out RLS test data only, keep inactive items for management
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name || '').toLowerCase();
        // Filter out RLS test items only
        return !name.includes('rls') && !name.startsWith('test ');
      });

      return filteredData;
    } catch (error) {
      console.error('Error loading subcategories:', error);
      return [];
    }
  });

  // Get ingredients
  ipcMain.handle('menu:get-ingredients', async () => {
    let apiFallbackIngredients: any[] | null = null;

    try {
      // Prefer admin dashboard menu sync (uses terminal auth, bypasses RLS)
      const menuData = await fetchMenuSyncData({ includeInactive: true });
      const ingredients = Array.isArray(menuData?.ingredients) ? menuData.ingredients : null;
      if (ingredients) {
        const filteredFromApi = ingredients.filter((item: any) => {
          const name = (item.name || '').toLowerCase();
          return !name.includes('rls') && !name.startsWith('test ') && item.is_available !== false;
        });

        const baseQuality = computeIngredientPayloadQuality(filteredFromApi);
        let enrichedFromApi = filteredFromApi;
        if (filteredFromApi.length > 0 && baseQuality.resolvableFlavorCount === 0) {
          const categorySnapshot = await fetchIngredientCategorySnapshotFromAdmin();
          if (Array.isArray(categorySnapshot) && categorySnapshot.length > 0) {
            enrichedFromApi = enrichIngredientsWithResolvedCategoryFlavor(filteredFromApi, categorySnapshot);
            const enrichedQuality = computeIngredientPayloadQuality(enrichedFromApi);
            console.info('[menu:get-ingredients] Applied POS-side category flavor enrichment from admin sync snapshot', {
              ingredientCount: filteredFromApi.length,
              categoryCount: categorySnapshot.length,
              resolvableBefore: baseQuality.resolvableFlavorCount,
              resolvableAfter: enrichedQuality.resolvableFlavorCount,
            });
          }
        }
        apiFallbackIngredients = enrichedFromApi;

        // The terminal-auth payload is the primary source of flavor/color metadata.
        // Log poor metadata quality once per sync cycle but do not block usage.
        maybeWarnIngredientPayloadQuality(enrichedFromApi, menuSyncCache.get('all')?.fetchedAt ?? null);

        if (enrichedFromApi.length > 0) {
          return enrichedFromApi;
        }
        // Empty payload can happen during sync lag; fallback query is best-effort.
        console.warn('[menu:get-ingredients] API payload returned 0 active ingredients; attempting Supabase fallback');
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('ingredients')
        .select(`
          *,
          ingredient_categories (
            id,
            name,
            color_code,
            flavor_type
          )
        `)
        .eq('is_available', true)
        .order('name', { ascending: true });

      if (error) throw error;

      // Filter out RLS test data
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name || '').toLowerCase();
        return !name.includes('rls') && !name.startsWith('test ') && item.is_available !== false;
      });

      if (filteredData.length > 0 || !apiFallbackIngredients) {
        return filteredData;
      }

      console.warn('[menu:get-ingredients] Supabase fallback returned 0 ingredients; using API snapshot');
      return apiFallbackIngredients;
    } catch (error) {
      console.error('Error loading ingredients:', error);
      if (apiFallbackIngredients) {
        console.warn('[menu:get-ingredients] Returning API snapshot without flavor metadata due to fallback failure');
        return apiFallbackIngredients;
      }
      return [];
    }
  });

  // Get default ingredients for a specific menu item
  ipcMain.handle('menu:get-subcategory-ingredients', async (_event, subcategoryId: string) => {
    try {
      if (!subcategoryId || typeof subcategoryId !== 'string') {
        return [];
      }

      // Primary source: menu-sync payload (terminal-auth path, no anon RLS dependency).
      const menuData = await fetchMenuSyncData({ includeInactive: true });
      const payloadLinks = menuData?.subcategory_ingredients;
      if (Array.isArray(payloadLinks)) {
        const scopedPayloadLinks = payloadLinks
          .filter((row: any) => row?.subcategory_id === subcategoryId)
          .filter((row: any) => row?.is_active !== false)
          .map((row: any) => ({
            subcategory_id: row?.subcategory_id,
            ingredient_id: row?.ingredient_id,
            quantity: typeof row?.quantity === 'number' ? row.quantity : 1,
            is_default: row?.is_default === true,
            is_optional: row?.is_optional === true,
            is_active: row?.is_active !== false,
          }));

        if (scopedPayloadLinks.length > 0 || payloadLinks.length > 0) {
          return scopedPayloadLinks;
        }
      }

      // Secondary source: admin generic sync table endpoint (terminal-auth).
      // Handles cases where menu-sync payload is missing/degraded.
      const adminSyncSnapshot = await fetchSubcategoryIngredientSnapshotFromAdmin();
      if (Array.isArray(adminSyncSnapshot)) {
        const scopedAdminSyncLinks = adminSyncSnapshot
          .filter((row) => row.subcategory_id === subcategoryId)
          .filter((row) => row.is_active !== false)
          .map((row) => ({
            subcategory_id: row.subcategory_id,
            ingredient_id: row.ingredient_id,
            quantity: row.quantity,
            is_default: row.is_default === true,
            is_optional: row.is_optional === true,
            is_active: row.is_active !== false,
            updated_at: row.updated_at ?? null,
          }));

        if (scopedAdminSyncLinks.length > 0) {
          return scopedAdminSyncLinks;
        }
      }

      // Tertiary source: anon Supabase query (best-effort fallback only).
      const warningCycle = Math.floor(Date.now() / MENU_SYNC_CACHE_TTL_MS);
      if (lastSubcategoryLinkFallbackWarningCycle !== warningCycle) {
        lastSubcategoryLinkFallbackWarningCycle = warningCycle;
        console.warn('[menu:get-subcategory-ingredients] menu-sync/admin sync links unavailable; using Supabase fallback', {
          subcategoryId,
          hasMenuData: !!menuData,
          payloadType: Array.isArray(payloadLinks) ? 'array' : typeof payloadLinks,
          payloadLinkCount: Array.isArray(payloadLinks) ? payloadLinks.length : null,
        });
      }

      const config = getSupabaseConfig('server');
      if (!config.url || !config.anonKey) {
        return [];
      }

      const supabase = getSupabaseClient();
      const linkColumnCapabilities = await getSubcategoryIngredientColumnCapabilities(supabase);
      const fallbackSelectFields = [
        'subcategory_id',
        'ingredient_id',
        'quantity',
        'is_active',
        ...(linkColumnCapabilities.hasIsDefault ? ['is_default'] : []),
        ...(linkColumnCapabilities.hasIsOptional ? ['is_optional'] : []),
        ...(linkColumnCapabilities.hasUpdatedAt ? ['updated_at'] : []),
      ];
      const { data, error } = await supabase
        .from('subcategory_ingredients')
        .select(fallbackSelectFields.join(', '))
        .eq('subcategory_id', subcategoryId);

      if (error) throw error;
      return (data || [])
        .filter((row: any) => row?.is_active !== false)
        .map((row: any) => ({
          subcategory_id: row?.subcategory_id,
          ingredient_id: row?.ingredient_id,
          quantity: Number.isFinite(Number(row?.quantity)) ? Number(row.quantity) : 1,
          is_default: row?.is_default === true,
          is_optional: row?.is_optional === true,
          is_active: row?.is_active !== false,
          updated_at: row?.updated_at ?? null,
        }));
    } catch (error) {
      console.error('Error loading menu item ingredients:', error);
      return [];
    }
  });

  // Get combos/offers
  ipcMain.handle('menu:get-combos', async () => {
    try {
      // Prefer admin dashboard menu sync (uses terminal auth, bypasses RLS)
      const menuData = await fetchMenuSyncData({ includeInactive: true });
      const combos = Array.isArray(menuData?.combos) ? menuData.combos : null;
      if (combos) {
        return combos.filter((item: any) => {
          const name = (item.name_en || item.name_el || item.name || '').toLowerCase();
          return !name.includes('rls') && !name.startsWith('test ');
        });
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('menu_combos')
        .select('*')
        .order('display_order', { ascending: true });

      if (error) throw error;

      // Filter out RLS test data
      const filteredData = (data || []).filter((item: any) => {
        const name = (item.name_en || item.name_el || '').toLowerCase();
        return !name.includes('rls') && !name.startsWith('test ');
      });

      return filteredData;
    } catch (error) {
      console.error('Error loading combos:', error);
      return [];
    }
  });

  // Update category
  ipcMain.handle('menu:update-category', async (_event, params: { id: string; is_active: boolean }) => {
    try {
      // Use service role client to bypass RLS for write operations
      const supabase = getWriteClient();
      const { error } = await supabase
        .from('menu_categories')
        .update({
          is_active: params.is_active,
          updated_at: new Date().toISOString()
        })
        .eq('id', params.id);

      if (error) throw error;

      // Notify renderer of the change
      const currentMainWindow = serviceRegistry.mainWindow;
      if (currentMainWindow && !currentMainWindow.isDestroyed()) {
        currentMainWindow.webContents.send('menu:sync', {
          table: 'menu_categories',
          action: 'update',
          id: params.id
        });
      }

      return { success: true };
    } catch (error) {
      console.error('Error updating category:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update category' };
    }
  });

  // Update subcategory (menu item)
  ipcMain.handle('menu:update-subcategory', async (_event, params: { id: string; is_available: boolean }) => {
    try {
      // Use service role client to bypass RLS for write operations
      const supabase = getWriteClient();
      const { error } = await supabase
        .from('subcategories')
        .update({
          is_available: params.is_available,
          updated_at: new Date().toISOString()
        })
        .eq('id', params.id);

      if (error) throw error;

      // Notify renderer of the change
      const currentMainWindow = serviceRegistry.mainWindow;
      if (currentMainWindow && !currentMainWindow.isDestroyed()) {
        currentMainWindow.webContents.send('menu:sync', {
          table: 'subcategories',
          action: 'update',
          id: params.id
        });
      }

      return { success: true };
    } catch (error) {
      console.error('Error updating subcategory:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update subcategory' };
    }
  });

  // Update ingredient
  ipcMain.handle('menu:update-ingredient', async (_event, params: { id: string; is_available: boolean }) => {
    try {
      console.log('[menu:update-ingredient] Updating ingredient:', params);

      // Use service role client to bypass RLS for write operations
      const supabase = getWriteClient();
      const { data, error, count } = await supabase
        .from('ingredients')
        .update({
          is_available: params.is_available,
          updated_at: new Date().toISOString()
        })
        .eq('id', params.id)
        .select();

      if (error) {
        console.error('[menu:update-ingredient] Supabase error:', error);
        throw error;
      }

      // Check if any rows were actually updated
      if (!data || data.length === 0) {
        console.warn('[menu:update-ingredient] No rows updated - ingredient may not exist or ID mismatch');
        return { success: false, error: 'Ingredient not found or no changes made' };
      }

      console.log('[menu:update-ingredient] Successfully updated:', data);

      // Notify renderer of the change
      const currentMainWindow = serviceRegistry.mainWindow;
      if (currentMainWindow && !currentMainWindow.isDestroyed()) {
        currentMainWindow.webContents.send('menu:sync', {
          table: 'ingredients',
          action: 'update',
          id: params.id,
          data: data[0]
        });
      }

      return { success: true, data: data[0] };
    } catch (error) {
      console.error('[menu:update-ingredient] Error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update ingredient' };
    }
  });

  // Update combo/offer
  ipcMain.handle('menu:update-combo', async (_event, params: { id: string; is_active: boolean }) => {
    try {
      const supabase = getWriteClient();
      const { data, error } = await supabase
        .from('menu_combos')
        .update({
          is_active: params.is_active,
          updated_at: new Date().toISOString()
        })
        .eq('id', params.id)
        .select();

      if (error) throw error;

      if (!data || data.length === 0) {
        return { success: false, error: 'Combo not found or no changes made' };
      }

      // Notify renderer of the change
      const currentMainWindow = serviceRegistry.mainWindow;
      if (currentMainWindow && !currentMainWindow.isDestroyed()) {
        currentMainWindow.webContents.send('menu:sync', {
          table: 'menu_combos',
          action: 'update',
          id: params.id,
          data: data[0]
        });
      }

      return { success: true, data: data[0] };
    } catch (error) {
      console.error('Error updating combo:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update combo' };
    }
  });

  // Handle menu-triggered check for updates
  ipcMain.removeHandler('menu:trigger-check-for-updates');
  ipcMain.handle('menu:trigger-check-for-updates', () => {
    const currentMainWindow = serviceRegistry.mainWindow;
    if (currentMainWindow && !currentMainWindow.isDestroyed()) {
      // Send the event that useAutoUpdater listens for
      currentMainWindow.webContents.send('menu:check-for-updates');
      console.log('[menu-handlers] Sent menu:check-for-updates event');
    }
    return { success: true };
  });

  // Setup real-time subscriptions for menu changes from admin dashboard
  const setupMenuRealtimeSync = () => {
    try {
      const supabase = getSupabaseClient();
      
      const channel = supabase
        .channel('pos-menu-sync')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_categories' }, (payload) => {
          console.log('📡 Menu category changed:', payload);
          const currentMainWindow = serviceRegistry.mainWindow;
          if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('menu:sync', {
              table: 'menu_categories',
              action: payload.eventType,
              data: payload.new || payload.old
            });
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'subcategories' }, (payload) => {
          console.log('📡 Subcategory changed:', payload);
          const currentMainWindow = serviceRegistry.mainWindow;
          if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('menu:sync', {
              table: 'subcategories',
              action: payload.eventType,
              data: payload.new || payload.old
            });
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ingredients' }, (payload) => {
          console.log('📡 Ingredient changed:', payload);
          const currentMainWindow = serviceRegistry.mainWindow;
          if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('menu:sync', {
              table: 'ingredients',
              action: payload.eventType,
              data: payload.new || payload.old
            });
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_combos' }, (payload) => {
          console.log('📡 Combo changed:', payload);
          const currentMainWindow = serviceRegistry.mainWindow;
          if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('menu:sync', {
              table: 'menu_combos',
              action: payload.eventType,
              data: payload.new || payload.old
            });
          }
        })
        .subscribe((status) => {
          console.log('📡 POS menu sync subscription status:', status);
        });

      return () => {
        console.log('🧹 Cleaning up POS menu sync subscription');
        supabase.removeChannel(channel);
      };
    } catch (error) {
      console.error('Error setting up menu realtime sync:', error);
      return () => {};
    }
  };

  // Start real-time sync
  setupMenuRealtimeSync();
}
