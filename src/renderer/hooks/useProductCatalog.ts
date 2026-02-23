/**
 * useProductCatalog Hook
 * 
 * React hook for managing product catalog in the POS system (Retail Vertical).
 * Provides data fetching, barcode scanning, and real-time updates.
 * 
 * Task 17.5: Create POS product catalog interface
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import toast from 'react-hot-toast';
import { offEvent, onEvent } from '../../lib';
import {
  productCatalogService,
  Product,
  ProductCategory,
  ProductFilters,
  ProductStats,
} from '../services/ProductCatalogService';

const EVENT_REFRESH_THROTTLE_MS = 5000;

interface UseProductCatalogProps {
  branchId: string;
  organizationId: string;
  filters?: ProductFilters;
  enableRealtime?: boolean;
}

interface UseProductCatalogReturn {
  // Data
  products: Product[];
  categories: ProductCategory[];
  stats: ProductStats;
  isLoading: boolean;
  error: string | null;

  // Actions
  refetch: () => Promise<void>;
  searchByBarcode: (barcode: string) => Promise<Product | null>;
  updateQuantity: (productId: string, quantity: number) => Promise<boolean>;

  // Filters
  setFilters: (filters: ProductFilters) => void;
}

export function useProductCatalog({
  branchId,
  organizationId,
  filters: initialFilters,
  enableRealtime = true,
}: UseProductCatalogProps): UseProductCatalogReturn {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ProductFilters>(initialFilters || {});

  // Sync internal filters state when initialFilters prop changes
  useEffect(() => {
    if (initialFilters) {
      setFilters(initialFilters);
    }
  }, [initialFilters?.categoryFilter, initialFilters?.searchTerm, initialFilters?.lowStockOnly]);

  // Set context when branch/org changes
  useEffect(() => {
    if (branchId && organizationId) {
      productCatalogService.setContext(branchId, organizationId);
    }
  }, [branchId, organizationId]);

  // Fetch products and categories
  const fetchData = useCallback(async (options: { silent?: boolean } = {}) => {
    const { silent = false } = options;
    // Only organizationId is required (products can be org-wide without branch)
    if (!organizationId) return;

    if (!silent) {
      setIsLoading(true);
      setError(null);
    }

    try {
      const [productsData, categoriesData] = await Promise.all([
        productCatalogService.fetchProducts(filters),
        productCatalogService.fetchCategories(),
      ]);
      setProducts(productsData);
      setCategories(categoriesData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch products';
      if (!silent) {
        setError(message);
      }
      console.error('Error fetching products:', err);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  }, [organizationId, filters]);

  // Initial fetch and refetch on filter changes
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Refresh from native sync/order events with throttling.
  useEffect(() => {
    if (!enableRealtime || !branchId) return;

    let disposed = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = 0;

    const scheduleRefresh = () => {
      if (disposed) return;

      const now = Date.now();
      const elapsed = now - lastRefreshAt;
      if (elapsed >= EVENT_REFRESH_THROTTLE_MS) {
        lastRefreshAt = now;
        void fetchData({ silent: true });
        return;
      }

      if (pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (disposed) return;
        lastRefreshAt = Date.now();
        void fetchData({ silent: true });
      }, EVENT_REFRESH_THROTTLE_MS - elapsed);
    };

    const handleSyncStatus = (status?: { inProgress?: boolean }) => {
      if (status?.inProgress) return;
      scheduleRefresh();
    };
    const handleSyncComplete = () => scheduleRefresh();
    const handleOrderMutation = () => scheduleRefresh();

    onEvent('sync:status', handleSyncStatus);
    onEvent('sync:complete', handleSyncComplete);
    onEvent('order-created', handleOrderMutation);
    onEvent('order-status-updated', handleOrderMutation);
    onEvent('order-deleted', handleOrderMutation);

    return () => {
      disposed = true;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
      }
      offEvent('sync:status', handleSyncStatus);
      offEvent('sync:complete', handleSyncComplete);
      offEvent('order-created', handleOrderMutation);
      offEvent('order-status-updated', handleOrderMutation);
      offEvent('order-deleted', handleOrderMutation);
    };
  }, [branchId, enableRealtime, fetchData]);

  // Calculate stats
  const stats = useMemo(() => {
    return productCatalogService.calculateStats(products);
  }, [products]);

  // Search by barcode
  const searchByBarcode = useCallback(async (barcode: string): Promise<Product | null> => {
    try {
      const product = await productCatalogService.fetchProductByBarcode(barcode);
      if (!product) {
        toast.error('Product not found');
      }
      return product;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to search product';
      toast.error(message);
      return null;
    }
  }, []);

  // Update quantity
  const updateQuantity = useCallback(async (productId: string, quantity: number): Promise<boolean> => {
    try {
      const updated = await productCatalogService.updateQuantity(productId, quantity);
      
      setProducts((prev) =>
        prev.map((p) => (p.id === productId ? updated : p))
      );
      
      toast.success('Quantity updated');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update quantity';
      toast.error(message);
      return false;
    }
  }, []);

  return {
    products,
    categories,
    stats,
    isLoading,
    error,
    refetch: fetchData,
    searchByBarcode,
    updateQuantity,
    setFilters,
  };
}

export default useProductCatalog;
