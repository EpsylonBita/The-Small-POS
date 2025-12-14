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
import {
  productCatalogService,
  Product,
  ProductCategory,
  ProductFilters,
  ProductStats,
} from '../services/ProductCatalogService';

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
  const fetchData = useCallback(async () => {
    // Only organizationId is required (products can be org-wide without branch)
    if (!organizationId) return;

    setIsLoading(true);
    setError(null);

    try {
      const [productsData, categoriesData] = await Promise.all([
        productCatalogService.fetchProducts(filters),
        productCatalogService.fetchCategories(),
      ]);
      setProducts(productsData);
      setCategories(categoriesData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch products';
      setError(message);
      console.error('Error fetching products:', err);
    } finally {
      setIsLoading(false);
    }
  }, [organizationId, filters]);

  // Initial fetch and refetch on filter changes
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Real-time subscription
  useEffect(() => {
    if (!enableRealtime || !branchId) return;

    productCatalogService.subscribeToUpdates((updatedProduct) => {
      setProducts((prev) => {
        const index = prev.findIndex((p) => p.id === updatedProduct.id);
        if (index >= 0) {
          const updated = [...prev];
          updated[index] = updatedProduct;
          return updated;
        }
        return prev;
      });
    });

    return () => {
      productCatalogService.unsubscribeFromUpdates();
    };
  }, [branchId, enableRealtime]);

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
