import { useState, useEffect, useCallback } from 'react';

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
  const [topSellerIds, setTopSellerIds] = useState<Set<string>>(new Set());
  const [topSellers, setTopSellers] = useState<TopSeller[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadTopSellers = useCallback(async () => {
    // Check if electronAPI is available
    if (!window.electronAPI?.getWeeklyTopItems) {
      console.warn('[useFeaturedItems] electronAPI.getWeeklyTopItems not available');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await window.electronAPI.getWeeklyTopItems({
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

      console.log(`[useFeaturedItems] Loaded ${items.length} top sellers for Featured category`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch weekly top items';
      console.error('[useFeaturedItems] Error:', err);
      setError(errorMessage);
      // Keep existing data on error (don't clear)
    } finally {
      setIsLoading(false);
    }
  }, [branchId]);

  // Load on mount and when branchId changes
  useEffect(() => {
    loadTopSellers();
  }, [loadTopSellers]);

  // Auto-refresh every 6 hours
  useEffect(() => {
    const timer = setInterval(() => {
      loadTopSellers();
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(timer);
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
