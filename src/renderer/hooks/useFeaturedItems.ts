import { useState, useEffect, useCallback, useRef } from 'react';
import { getBridge, offEvent, onEvent } from '../../lib';

interface TopSeller {
  menuItemId: string;
  name: string;
  totalQuantity: number;
  totalRevenue: number;
}

interface UseFeaturedItemsReturn {
  topSellerIds: Set<string>;
  topSellers: TopSeller[];
  isLoading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
  isTopSeller: (menuItemId: string) => boolean;
}

// Refresh every 6 hours
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Custom hook for fetching weekly top-selling items for the Featured/Selected category.
 *
 * Calculates the top 20 best-selling items from the last 7 days of sales data.
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
export function useFeaturedItems(branchId: string | null): UseFeaturedItemsReturn {
  const bridge = getBridge();
  const [topSellerIds, setTopSellerIds] = useState<Set<string>>(new Set());
  const [topSellers, setTopSellers] = useState<TopSeller[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoRefreshAtRef = useRef<number>(0);

  const loadTopSellers = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await bridge.reports.getWeeklyTopItems({
        branchId: branchId || '',
        limit: 20
      });

      // Normalize response: accept array or { success, data, error }
      let items: TopSeller[] = [];
      if (Array.isArray(result)) {
        items = result;
      } else if (result && typeof result === 'object') {
        const r = result as { success?: boolean; data?: TopSeller[]; error?: string };
        if (Array.isArray(r.data)) {
          items = r.data;
        }
        if (r.success === false && r.error) {
          setError(String(r.error));
        }
      }

      // Build a Set of menu item IDs for fast lookup
      const ids = new Set(
        items
          .map((item: TopSeller) => item.menuItemId)
          .filter(Boolean) // Filter out empty strings
      );

      setTopSellers(items);
      setTopSellerIds(ids);
      setLastUpdated(new Date());
      lastAutoRefreshAtRef.current = Date.now();

      console.log(`[useFeaturedItems] Loaded ${items.length} top sellers for Featured category`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch weekly top items';
      console.error('[useFeaturedItems] Error:', err);
      setError(errorMessage);
      // Keep existing data on error (don't clear)
    } finally {
      setIsLoading(false);
    }
  }, [branchId, bridge.reports]);

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

  return {
    topSellerIds,
    topSellers,
    isLoading,
    error,
    lastUpdated,
    refresh: loadTopSellers,
    isTopSeller
  };
}
