/**
 * ProductCatalogService - POS Product Catalog Service
 * 
 * Provides product catalog functionality for the POS system (Retail Vertical).
 * Uses direct Supabase connection for real-time data.
 * 
 * Task 17.5: Create POS product catalog interface
 */

import { supabase, subscribeToTable, unsubscribeFromChannel } from '../../shared/supabase';
import { posApiGet, posApiPatch } from '../utils/api-helpers';

// Types
export interface Product {
  id: string;
  organizationId: string;
  branchId: string;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  price: number;
  cost: number | null;
  quantity: number;
  lowStockThreshold: number;
  isActive: boolean;
  imageUrl: string | null;
  // Tiered pricing fields
  wholesalePrice: number | null;
  memberPrice: number | null;
  minWholesaleQuantity: number | null;
  // Supplier fields
  preferredSupplierId: string | null;
  preferredSupplierName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductSupplier {
  id: string;
  productId: string;
  supplierId: string;
  supplierName: string;
  supplierSku: string | null;
  supplierCost: number | null;
  leadTimeDays: number;
  minOrderQuantity: number;
  isPreferredSupplier: boolean;
  autoReorderEnabled: boolean;
  reorderPoint: number | null;
  reorderQuantity: number | null;
  lastOrderDate: string | null;
  lastReceivedDate: string | null;
}

export interface LowStockProduct {
  productId: string;
  productName: string;
  sku: string;
  currentQuantity: number;
  lowStockThreshold: number;
  preferredSupplierId: string | null;
  supplierName: string | null;
  supplierCost: number | null;
  leadTimeDays: number | null;
  suggestedQuantity: number;
}

export interface ProductCategory {
  id: string;
  name: string;
  isActive: boolean;
}

export interface ProductFilters {
  categoryFilter?: string | 'all';
  searchTerm?: string;
  lowStockOnly?: boolean;
  activeOnly?: boolean;
}

export interface ProductStats {
  totalProducts: number;
  activeProducts: number;
  lowStockProducts: number;
  outOfStockProducts: number;
  totalValue: number;
}

// Transform product from API
function transformProductFromAPI(data: any): Product {
  // Handle category name from join - could be in categories object or retail_product_categories
  const categoryName = data.category_name
    || data.category?.name
    || data.categories?.name
    || data.retail_product_categories?.name
    || null;

  // Handle preferred supplier from join
  const preferredSupplierName = data.preferred_supplier?.name
    || data.suppliers?.name
    || null;

  return {
    id: data.id,
    organizationId: data.organization_id,
    branchId: data.branch_id,
    sku: data.sku || '',
    barcode: data.barcode,
    name: data.name,
    description: data.description,
    categoryId: data.category_id,
    categoryName,
    price: parseFloat(data.price) || 0,
    cost: data.cost ? parseFloat(data.cost) : null,
    quantity: data.quantity || 0,
    lowStockThreshold: data.low_stock_threshold || 10,
    isActive: data.is_active ?? true,
    imageUrl: data.image_url,
    // Tiered pricing
    wholesalePrice: data.wholesale_price ? parseFloat(data.wholesale_price) : null,
    memberPrice: data.member_price ? parseFloat(data.member_price) : null,
    minWholesaleQuantity: data.min_wholesale_quantity ?? null,
    // Supplier fields
    preferredSupplierId: data.preferred_supplier_id || null,
    preferredSupplierName,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

// Transform product supplier from API
// Note: POS uses retail_product_id, fall back to product_id for compatibility
function transformProductSupplierFromAPI(data: any): ProductSupplier {
  return {
    id: data.id,
    productId: data.retail_product_id || data.product_id,
    supplierId: data.supplier_id,
    supplierName: data.suppliers?.name || data.supplier_name || '',
    supplierSku: data.supplier_sku,
    supplierCost: data.supplier_cost ? parseFloat(data.supplier_cost) : null,
    leadTimeDays: data.lead_time_days || 7,
    minOrderQuantity: data.min_order_quantity || 1,
    isPreferredSupplier: data.is_preferred_supplier ?? false,
    autoReorderEnabled: data.auto_reorder_enabled ?? false,
    reorderPoint: data.reorder_point,
    reorderQuantity: data.reorder_quantity,
    lastOrderDate: data.last_order_date,
    lastReceivedDate: data.last_received_date,
  };
}

// Transform low stock product from API
function transformLowStockProductFromAPI(data: any): LowStockProduct {
  return {
    productId: data.product_id || data.id,
    productName: data.product_name || data.name,
    sku: data.sku || '',
    currentQuantity: data.current_quantity ?? data.quantity ?? 0,
    lowStockThreshold: data.low_stock_threshold || 10,
    preferredSupplierId: data.preferred_supplier_id,
    supplierName: data.supplier_name,
    supplierCost: data.supplier_cost ? parseFloat(data.supplier_cost) : null,
    leadTimeDays: data.lead_time_days,
    suggestedQuantity: data.suggested_quantity || (data.low_stock_threshold || 10) * 2,
  };
}

class ProductCatalogService {
  private branchId: string = '';
  private organizationId: string = '';
  private realtimeChannel: any = null;
  private supplierRealtimeChannel: any = null;
  private useApiPrimary: boolean = true;

  /**
   * Set the current branch and organization context
   */
  setContext(branchId: string, organizationId: string): void {
    this.branchId = branchId;
    this.organizationId = organizationId;
  }

  /**
   * Control whether the Admin API is used as primary source
   */
  setUseApi(useApi: boolean): void {
    this.useApiPrimary = useApi;
  }

  /**
   * Fetch products with optional filters
   * Uses retail_products table for retail vertical
   */
  async fetchProducts(filters?: ProductFilters): Promise<Product[]> {
    // Validate context before making query
    if (!this.organizationId) {
      console.warn('ProductCatalogService: Missing organizationId, returning empty products');
      return [];
    }

    try {
      if (this.useApiPrimary) {
        const apiProducts = await this.fetchProductsFromApi(filters);
        if (apiProducts !== null) {
          return apiProducts;
        }
        console.warn('ProductCatalogService: API fetch failed, falling back to Supabase');
      }

      return await this.fetchProductsFromSupabase(filters);
    } catch (error) {
      console.error('Failed to fetch products:', error);
      return [];
    }
  }

  /**
   * Fetch product by barcode (for barcode scanning)
   * Uses retail_products table
   */
  async fetchProductByBarcode(barcode: string): Promise<Product | null> {
    // Validate context before making query
    if (!this.organizationId) {
      console.warn('ProductCatalogService: Missing organizationId, cannot fetch by barcode');
      return null;
    }

    try {
      if (this.useApiPrimary) {
        const apiProduct = await this.fetchProductByBarcodeFromApi(barcode);
        if (apiProduct !== null) {
          return apiProduct;
        }
        console.warn('ProductCatalogService: API barcode lookup failed, falling back to Supabase');
      }

      return await this.fetchProductByBarcodeFromSupabase(barcode);
    } catch (error) {
      console.error('Failed to fetch product by barcode:', error);
      return null;
    }
  }

  /**
   * Fetch categories
   * Uses retail_product_categories table
   */
  async fetchCategories(): Promise<ProductCategory[]> {
    // Validate context before making query
    if (!this.organizationId) {
      console.warn('ProductCatalogService: Missing organizationId, returning empty categories');
      return [];
    }

    try {
      if (this.useApiPrimary) {
        const apiCategories = await this.fetchCategoriesFromApi();
        if (apiCategories !== null) {
          return apiCategories;
        }
        console.warn('ProductCatalogService: API categories fetch failed, falling back to Supabase');
      }

      return await this.fetchCategoriesFromSupabase();
    } catch (error) {
      console.error('Failed to fetch categories:', error);
      return [];
    }
  }

  /**
   * Update product quantity (for inventory lookup)
   * Uses retail_products table
   */
  async updateQuantity(productId: string, newQuantity: number): Promise<Product> {
    try {
      if (this.useApiPrimary) {
        const apiUpdated = await this.updateQuantityViaApi(productId, newQuantity);
        if (apiUpdated !== null) {
          return apiUpdated;
        }
        console.warn('ProductCatalogService: API updateQuantity failed, falling back to Supabase');
      }

      return await this.updateQuantityViaSupabase(productId, newQuantity);
    } catch (error) {
      console.error('Failed to update product quantity:', error);
      throw error;
    }
  }

  /**
   * Calculate statistics from products
   */
  calculateStats(products: Product[]): ProductStats {
    const stats: ProductStats = {
      totalProducts: products.length,
      activeProducts: 0,
      lowStockProducts: 0,
      outOfStockProducts: 0,
      totalValue: 0,
    };

    products.forEach((p) => {
      if (p.isActive) stats.activeProducts++;
      if (p.quantity <= p.lowStockThreshold && p.quantity > 0) stats.lowStockProducts++;
      if (p.quantity === 0) stats.outOfStockProducts++;
      stats.totalValue += p.price * p.quantity;
    });

    return stats;
  }

  /**
   * Subscribe to real-time product updates
   * Uses retail_products table
   */
  subscribeToUpdates(callback: (product: Product) => void): void {
    if (this.realtimeChannel) {
      this.unsubscribeFromUpdates();
    }

    this.realtimeChannel = subscribeToTable(
      'retail_products',
      (payload: any) => {
        if (payload.new) {
          callback(transformProductFromAPI(payload.new));
        }
      },
      `organization_id=eq.${this.organizationId}`
    );
  }

  /**
   * Unsubscribe from real-time updates
   */
  unsubscribeFromUpdates(): void {
    if (this.realtimeChannel) {
      unsubscribeFromChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
  }

  // ===========================================================================
  // PRODUCT-SUPPLIER METHODS
  // ===========================================================================

  /**
   * Fetch suppliers linked to a retail product
   * Note: Uses retail_product_id for POS retail vertical
   */
  async fetchProductSuppliers(productId: string): Promise<ProductSupplier[]> {
    try {
      if (!this.organizationId) {
        console.warn('ProductCatalogService: Missing organizationId');
        return [];
      }

      if (this.useApiPrimary) {
        const apiSuppliers = await this.fetchProductSuppliersFromApi(productId);
        if (apiSuppliers !== null) {
          return apiSuppliers;
        }
        console.warn('ProductCatalogService: API suppliers fetch failed, falling back to Supabase');
      }

      return await this.fetchProductSuppliersFromSupabase(productId);
    } catch (error) {
      console.error('Failed to fetch product suppliers:', error);
      return [];
    }
  }

  /**
   * Fetch low stock products with supplier information
   */
  async fetchLowStockProducts(): Promise<LowStockProduct[]> {
    try {
      if (!this.organizationId) {
        console.warn('ProductCatalogService: Missing organizationId');
        return [];
      }

      if (this.useApiPrimary) {
        const apiLowStock = await this.fetchLowStockProductsFromApi();
        if (apiLowStock !== null) {
          return apiLowStock;
        }
        console.warn('ProductCatalogService: API low-stock fetch failed, falling back to Supabase');
      }

      return await this.fetchLowStockProductsFromSupabase();
    } catch (error) {
      console.error('Failed to fetch low stock products:', error);
      return [];
    }
  }

  // ===========================================================================
  // API FETCH METHODS
  // ===========================================================================

  private async fetchProductsFromApi(filters?: ProductFilters): Promise<Product[] | null> {
    try {
      const params = new URLSearchParams();
      if (filters?.categoryFilter && filters.categoryFilter !== 'all') {
        params.set('category_id', filters.categoryFilter);
      }
      if (filters?.searchTerm) {
        params.set('search', filters.searchTerm);
      }
      if (filters?.activeOnly !== false) {
        params.set('is_active', 'true');
      }
      if (filters?.lowStockOnly) {
        params.set('low_stock_only', 'true');
      }

      const endpoint = `/api/pos/products${params.toString() ? `?${params.toString()}` : ''}`;
      const result = await posApiGet<{ success: boolean; products: any[] }>(endpoint);

      if (!result.success || !result.data?.success) {
        return null;
      }

      return (result.data.products || []).map(transformProductFromAPI);
    } catch (error) {
      console.error('ProductCatalogService: API fetchProducts error:', error);
      return null;
    }
  }

  private async fetchProductByBarcodeFromApi(barcode: string): Promise<Product | null> {
    try {
      const cleanedBarcode = barcode.replace(/[\s\-]/g, '').trim();
      const endpoint = `/api/pos/products/lookup?barcode=${encodeURIComponent(cleanedBarcode)}`;
      const result = await posApiGet<{ success: boolean; found: boolean; product?: any }>(endpoint);

      if (!result.success || !result.data?.success) {
        return null;
      }

      if (!result.data.found || !result.data.product) {
        return null;
      }

      return transformProductFromAPI(result.data.product);
    } catch (error) {
      console.error('ProductCatalogService: API barcode lookup error:', error);
      return null;
    }
  }

  private async fetchCategoriesFromApi(): Promise<ProductCategory[] | null> {
    try {
      const result = await posApiGet<{ success: boolean; categories: any[] }>('/api/pos/product-categories');
      if (!result.success || !result.data?.success) {
        return null;
      }

      return (result.data.categories || []).map((c: any) => ({
        id: c.id,
        name: c.name,
        isActive: c.is_active ?? true,
      }));
    } catch (error) {
      console.error('ProductCatalogService: API categories error:', error);
      return null;
    }
  }

  private async updateQuantityViaApi(productId: string, newQuantity: number): Promise<Product | null> {
    try {
      const result = await posApiPatch<{ success: boolean; product: any }>(
        `/api/pos/products/${productId}`,
        { quantity: newQuantity }
      );

      if (!result.success || !result.data?.success) {
        return null;
      }

      return transformProductFromAPI(result.data.product);
    } catch (error) {
      console.error('ProductCatalogService: API updateQuantity error:', error);
      return null;
    }
  }

  private async fetchProductSuppliersFromApi(productId: string): Promise<ProductSupplier[] | null> {
    try {
      const result = await posApiGet<{ success: boolean; suppliers: any[] }>(
        `/api/pos/products/${productId}/suppliers`
      );

      if (!result.success || !result.data?.success) {
        return null;
      }

      return (result.data.suppliers || []).map(transformProductSupplierFromAPI);
    } catch (error) {
      console.error('ProductCatalogService: API product suppliers error:', error);
      return null;
    }
  }

  private async fetchLowStockProductsFromApi(): Promise<LowStockProduct[] | null> {
    try {
      const result = await posApiGet<{ success: boolean; products: any[] }>(
        '/api/pos/products/low-stock'
      );

      if (!result.success || !result.data?.success) {
        return null;
      }

      return (result.data.products || []).map(transformLowStockProductFromAPI);
    } catch (error) {
      console.error('ProductCatalogService: API low-stock error:', error);
      return null;
    }
  }

  // ===========================================================================
  // SUPABASE FALLBACK METHODS
  // ===========================================================================

  private async fetchProductsFromSupabase(filters?: ProductFilters): Promise<Product[]> {
    let query = supabase
      .from('retail_products')
      .select(`
        *,
        categories:category_id(name)
      `)
      .eq('organization_id', this.organizationId)
      .order('name', { ascending: true });

    // Filter by branch if set (branch_id can be null for org-wide products)
    if (this.branchId) {
      query = query.or(`branch_id.eq.${this.branchId},branch_id.is.null`);
    }

    if (filters?.categoryFilter && filters.categoryFilter !== 'all') {
      query = query.eq('category_id', filters.categoryFilter);
    }
    if (filters?.activeOnly !== false) {
      query = query.eq('is_active', true);
    }
    if (filters?.searchTerm) {
      query = query.or(
        `name.ilike.%${filters.searchTerm}%,sku.ilike.%${filters.searchTerm}%,barcode.ilike.%${filters.searchTerm}%`
      );
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching products:', error);
      throw error;
    }

    let products = (data || []).map(transformProductFromAPI);

    // Client-side filter for low stock
    if (filters?.lowStockOnly) {
      products = products.filter(p => p.quantity <= p.lowStockThreshold);
    }

    return products;
  }

  private async fetchProductByBarcodeFromSupabase(barcode: string): Promise<Product | null> {
    let query = supabase
      .from('retail_products')
      .select(`
        *,
        categories:category_id(name)
      `)
      .eq('organization_id', this.organizationId)
      .eq('barcode', barcode)
      .eq('is_active', true);

    // Filter by branch if set
    if (this.branchId) {
      query = query.or(`branch_id.eq.${this.branchId},branch_id.is.null`);
    }

    const { data, error } = await query.limit(1).maybeSingle();

    if (error) {
      console.error('Error fetching product by barcode:', error);
      return null;
    }

    return data ? transformProductFromAPI(data) : null;
  }

  private async fetchCategoriesFromSupabase(): Promise<ProductCategory[]> {
    let query = supabase
      .from('retail_product_categories')
      .select('id, name, is_active')
      .eq('organization_id', this.organizationId)
      .eq('is_active', true)
      .order('name', { ascending: true });

    // Filter by branch if set
    if (this.branchId) {
      query = query.or(`branch_id.eq.${this.branchId},branch_id.is.null`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching categories:', error);
      return [];
    }

    return (data || []).map(c => ({
      id: c.id,
      name: c.name,
      isActive: c.is_active,
    }));
  }

  private async updateQuantityViaSupabase(productId: string, newQuantity: number): Promise<Product> {
    const { data: product, error } = await supabase
      .from('retail_products')
      .update({
        quantity: newQuantity,
        updated_at: new Date().toISOString(),
      })
      .eq('id', productId)
      .select()
      .single();

    if (error) {
      console.error('Error updating product quantity:', error);
      throw error;
    }

    return transformProductFromAPI(product);
  }

  private async fetchProductSuppliersFromSupabase(productId: string): Promise<ProductSupplier[]> {
    let query = supabase
      .from('product_suppliers')
      .select(`
        *,
        suppliers:supplier_id (id, name, supplier_code)
      `)
      .eq('organization_id', this.organizationId)
      .eq('retail_product_id', productId)
      .order('is_preferred_supplier', { ascending: false });

    if (this.branchId) {
      query = query.eq('branch_id', this.branchId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching product suppliers:', error);
      return [];
    }

    return (data || []).map(transformProductSupplierFromAPI);
  }

  private async fetchLowStockProductsFromSupabase(): Promise<LowStockProduct[]> {
    // First, fetch products that are below their low stock threshold
    let query = supabase
      .from('retail_products')
      .select(`
        id,
        name,
        sku,
        quantity,
        low_stock_threshold,
        preferred_supplier_id,
        suppliers:preferred_supplier_id (id, name)
      `)
      .eq('organization_id', this.organizationId)
      .eq('is_active', true);

    if (this.branchId) {
      query = query.or(`branch_id.eq.${this.branchId},branch_id.is.null`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching products for low stock check:', error);
      return [];
    }

    // Filter low stock products
    const lowStockProducts = (data || []).filter(
      (p: any) => p.quantity < (p.low_stock_threshold || 10)
    );

    // Enrich with supplier info from product_suppliers table
    const enrichedProducts = await Promise.all(
      lowStockProducts.map(async (product: any) => {
        // Get preferred supplier details from product_suppliers (using retail_product_id for POS)
        const { data: supplierLink } = await supabase
          .from('product_suppliers')
          .select(`
            supplier_cost,
            lead_time_days,
            reorder_quantity,
            suppliers:supplier_id (id, name)
          `)
          .eq('retail_product_id', product.id)
          .eq('is_preferred_supplier', true)
          .single();

        // Extract supplier name - handle both array and object shapes from Supabase joins
        const supplierLinkSuppliers = supplierLink?.suppliers as { id: string; name: string } | { id: string; name: string }[] | null;
        const productSuppliers = product.suppliers as { id: string; name: string } | { id: string; name: string }[] | null;
        const supplierName =
          (Array.isArray(supplierLinkSuppliers) ? supplierLinkSuppliers[0]?.name : supplierLinkSuppliers?.name) ||
          (Array.isArray(productSuppliers) ? productSuppliers[0]?.name : productSuppliers?.name) ||
          null;

        return transformLowStockProductFromAPI({
          product_id: product.id,
          product_name: product.name,
          sku: product.sku,
          current_quantity: product.quantity,
          low_stock_threshold: product.low_stock_threshold,
          preferred_supplier_id: product.preferred_supplier_id,
          supplier_name: supplierName,
          supplier_cost: supplierLink?.supplier_cost || null,
          lead_time_days: supplierLink?.lead_time_days || null,
          suggested_quantity: supplierLink?.reorder_quantity || (product.low_stock_threshold || 10) * 2,
        });
      })
    );

    return enrichedProducts;
  }

  /**
   * Subscribe to real-time product-supplier updates
   */
  subscribeToSupplierUpdates(callback: (data: { type: string; payload: any }) => void): void {
    if (this.supplierRealtimeChannel) {
      this.unsubscribeFromSupplierUpdates();
    }

    if (!this.branchId || !this.organizationId) {
      console.warn('ProductCatalogService: Cannot subscribe to supplier updates without context');
      return;
    }

    this.supplierRealtimeChannel = subscribeToTable(
      'product_suppliers',
      (payload: any) => {
        callback({
          type: payload.eventType || 'UPDATE',
          payload: payload.new ? transformProductSupplierFromAPI(payload.new) : payload.old,
        });
      },
      `branch_id=eq.${this.branchId}`
    );
  }

  /**
   * Unsubscribe from real-time supplier updates
   */
  unsubscribeFromSupplierUpdates(): void {
    if (this.supplierRealtimeChannel) {
      unsubscribeFromChannel(this.supplierRealtimeChannel);
      this.supplierRealtimeChannel = null;
    }
  }

  /**
   * Cleanup all realtime subscriptions
   */
  cleanup(): void {
    this.unsubscribeFromUpdates();
    this.unsubscribeFromSupplierUpdates();
  }
}

// Export singleton instance
export const productCatalogService = new ProductCatalogService();
