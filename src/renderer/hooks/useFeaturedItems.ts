import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getBridge, offEvent, onEvent } from '../../lib';

interface TopSeller {
  menuItemId: string;
  name: string;
  quantity: number;
  revenue: number;
  categoryId: string | null;
}

interface RawTopSeller {
  menuItemId?: string;
  menu_item_id?: string;
  name?: string;
  quantity?: number;
  totalQuantity?: number;
  revenue?: number;
  totalRevenue?: number;
  categoryId?: string | null;
  category_id?: string | null;
}

interface TopSellerResponse {
  success?: boolean;
  data?: RawTopSeller[];
  error?: string;
}

interface UseFeaturedItemsOptions {
  strategy?: 'weekly' | 'daily_then_weekly';
  limit?: number;
}

interface UseFeaturedItemsReturn {
  topSellerIds: Set<string>;
  rankedTopSellerIds: string[];
  topSellers: TopSeller[];
  isLoading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
  isTopSeller: (menuItemId: string) => boolean;
}

const DEFAULT_LIMIT = 20;

// Refresh every 6 hours
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

function normalizeTopSellerResult(result: unknown): { items: TopSeller[]; error: string | null } {
  let rawItems: RawTopSeller[] = [];
  let error: string | null = null;

  if (Array.isArray(result)) {
    rawItems = result as RawTopSeller[];
  } else if (result && typeof result === 'object') {
    const response = result as TopSellerResponse;
    if (Array.isArray(response.data)) {
      rawItems = response.data;
    }
    if (response.success === false && response.error) {
      error = String(response.error);
    }
  }

  const items = rawItems
    .map((item) => {
      const menuItemId = String(item.menuItemId || item.menu_item_id || '').trim();
      if (!menuItemId) {
        return null;
      }

      return {
        menuItemId,
        name: String(item.name || 'Item').trim() || 'Item',
        quantity: Number(item.quantity ?? item.totalQuantity ?? 0) || 0,
        revenue: Number(item.revenue ?? item.totalRevenue ?? 0) || 0,
        categoryId: item.categoryId ?? item.category_id ?? null,
      } satisfies TopSeller;
    })
    .filter((item): item is TopSeller => Boolean(item));

  return { items, error };
}

function mergeRankedTopSellers(primary: TopSeller[], secondary: TopSeller[], limit: number): TopSeller[] {
  const merged: TopSeller[] = [];
  const seenIds = new Set<string>();

  for (const item of [...primary, ...secondary]) {
    const menuItemId = item.menuItemId.trim();
    if (!menuItemId || seenIds.has(menuItemId)) {
      continue;
    }

    seenIds.add(menuItemId);
    merged.push(item);

    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

/**
 * Custom hook for fetching top-selling items for the Featured/Selected category.
 *
 * Supports either:
 * - weekly top sellers (default)
 * - daily-first ranking with weekly top-up for quick menu population
 *
 * Used to dynamically populate the "Επιλεγμένα" (Selected) menu category.
 *
 * Features:
 * - Loads on mount and when branchId changes
 * - Auto-refreshes every 6 hours
 * - Falls back gracefully when no data available
 * - Works offline using local SQLite data
 *
 * @param {string | null} branchId - The ID of the branch (optional for future multi-branch support)
 * @returns {UseFeaturedItemsReturn} Object containing top sellers data and utility functions
 *
 * @example
 * ```tsx
 * const { topSellerIds, isLoading, isTopSeller } = useFeaturedItems(branchId);
 *
 * // Filter menu items by top sellers
 * const featuredItems = menuItems.filter(item => topSellerIds.has(item.id));
 *
 * // Or check individual items
 * if (isTopSeller(menuItem.id)) {
 *   // Show "Popular" badge
 * }
 * ```
 */
export function useFeaturedItems(
  branchId: string | null,
  options: UseFeaturedItemsOptions = {},
): UseFeaturedItemsReturn {
  const bridge = getBridge();
  const strategy = options.strategy ?? 'weekly';
  const limit = options.limit ?? DEFAULT_LIMIT;
  const [topSellerIds, setTopSellerIds] = useState<Set<string>>(new Set());
  const [topSellers, setTopSellers] = useState<TopSeller[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoRefreshAtRef = useRef<number>(0);

  const fetchTopSellers = useCallback(async (mode: 'daily' | 'weekly') => {
    try {
      const result = mode === 'daily'
        ? await bridge.reports.getTopItems({
            branchId: branchId || '',
            limit,
          })
        : await bridge.reports.getWeeklyTopItems({
            branchId: branchId || '',
            limit,
          });
      return normalizeTopSellerResult(result);
    } catch (err) {
      return {
        items: [] as TopSeller[],
        error: err instanceof Error
          ? err.message
          : `Failed to fetch ${mode === 'daily' ? 'daily' : 'weekly'} top items`,
      };
    }
  }, [branchId, bridge.reports, limit]);

  const loadTopSellers = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      let items: TopSeller[] = [];
      let nextError: string | null = null;

      if (strategy === 'daily_then_weekly') {
        const daily = await fetchTopSellers('daily');
        const weekly = daily.items.length < limit
          ? await fetchTopSellers('weekly')
          : { items: [] as TopSeller[], error: null as string | null };

        items = mergeRankedTopSellers(daily.items, weekly.items, limit);
        nextError = items.length > 0 ? null : daily.error || weekly.error;
      } else {
        const weekly = await fetchTopSellers('weekly');
        items = weekly.items.slice(0, limit);
        nextError = items.length > 0 ? null : weekly.error;
      }

      // Build a Set of menu item IDs for fast lookup
      const ids = new Set(
        items
          .map((item: TopSeller) => item.menuItemId.trim())
          .filter(Boolean) // Filter out empty strings
      );

      setTopSellers(items);
      setTopSellerIds(ids);
      setError(nextError);
      setLastUpdated(new Date());
      lastAutoRefreshAtRef.current = Date.now();

      console.log(`[useFeaturedItems] Loaded ${items.length} top sellers for Featured category (${strategy})`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch featured top items';
      console.error('[useFeaturedItems] Error:', err);
      setError(errorMessage);
      // Keep existing data on error (don't clear)
    } finally {
      setIsLoading(false);
    }
  }, [fetchTopSellers, limit, strategy]);

  // Load on mount and when branchId changes
  useEffect(() => {
    loadTopSellers();
  }, [loadTopSellers]);

  // Event-driven refresh with 6-hour throttling to avoid unnecessary recomputation.
  useEffect(() => {
    const scheduleRefresh = (delayMs = 250, force = false) => {
      if (pendingRefreshRef.current) return;
      pendingRefreshRef.current = setTimeout(() => {
        pendingRefreshRef.current = null;
        if (!force) {
          const now = Date.now();
          if (now - lastAutoRefreshAtRef.current < REFRESH_INTERVAL_MS) {
            return;
          }
        }
        void loadTopSellers();
      }, delayMs);
    };

    const handleSyncStatus = () => {
      scheduleRefresh(300, false);
    };

    const handleSyncComplete = () => {
      scheduleRefresh(200, false);
    };

    const handleMenuSync = () => {
      scheduleRefresh(200, false);
    };

    onEvent('sync:status', handleSyncStatus);
    onEvent('sync:complete', handleSyncComplete);
    onEvent('menu:sync', handleMenuSync);

    return () => {
      offEvent('sync:status', handleSyncStatus);
      offEvent('sync:complete', handleSyncComplete);
      offEvent('menu:sync', handleMenuSync);
      if (pendingRefreshRef.current) {
        clearTimeout(pendingRefreshRef.current);
        pendingRefreshRef.current = null;
      }
    };
  }, [loadTopSellers]);

  // Helper function to check if an item is a top seller
  const isTopSeller = useCallback((menuItemId: string) => {
    return topSellerIds.has(menuItemId);
  }, [topSellerIds]);

  const rankedTopSellerIds = useMemo(
    () => topSellers
      .map((item) => item.menuItemId.trim())
      .filter(Boolean),
    [topSellers],
  );

  return {
    topSellerIds,
    rankedTopSellerIds,
    topSellers,
    isLoading,
    error,
    lastUpdated,
    refresh: loadTopSellers,
    isTopSeller
  };
}
