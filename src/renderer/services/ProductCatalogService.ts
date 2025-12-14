/**
 * ProductCatalogService - POS Product Catalog Service
 * 
 * Provides product catalog functionality for the POS system (Retail Vertical).
 * Uses direct Supabase connection for real-time data.
 * 
 * Task 17.5: Create POS product catalog interface
 */

import { supabase, subscribeToTable, unsubscribeFromChannel } from '../../shared/supabase';

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
  createdAt: string;
  updatedAt: string;
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
    || data.categories?.name
    || data.retail_product_categories?.name
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
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

class ProductCatalogService {
  private branchId: string = '';
  private organizationId: string = '';
  private realtimeChannel: any = null;

  /**
   * Set the current branch and organization context
   */
  setContext(branchId: string, organizationId: string): void {
    this.branchId = branchId;
    this.organizationId = organizationId;
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
}

// Export singleton instance
export const productCatalogService = new ProductCatalogService();
