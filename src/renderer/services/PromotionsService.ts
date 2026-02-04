/**
 * PromotionsService - POS Promotions Service
 *
 * Provides promotion functionality for the POS system.
 * Fetches active promotions and validates them against cart items.
 *
 * Feature: vertical-modules-ui
 * Requirements: 10.5, 10.7
 */

import { supabase, subscribeToTable, unsubscribeFromChannel } from '../../shared/supabase';
import type {
  POSPromotion,
  CartItem,
  CartPromotionSummary,
  PromotionApplicationResult,
  TieredDiscount,
  PromotionBundle,
  BundleItem,
} from '../utils/promotions';
import {
  calculateCartPromotions,
  applyPromotion,
  findBestPromotion,
} from '../utils/promotions';

interface PromotionFromAPI {
  id: string;
  organization_id: string;
  branch_id?: string | null;
  name: string;
  description?: string | null;
  promotion_type: string;
  discount_value?: number | null;
  discount_percentage?: number | null;
  buy_quantity?: number | null;
  get_quantity?: number | null;
  get_percentage?: number | null;
  applies_to: string;
  start_date: string;
  end_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  day_of_week?: number[] | null;
  max_discount_amount?: number | null;
  min_purchase_amount?: number | null;
  max_redemptions_per_customer?: number | null;
  max_total_redemptions?: number | null;
  current_redemptions_count?: number;
  is_active: boolean;
  is_stackable?: boolean;
  priority?: number;
  // Metadata containing tiered pricing tiers (for tiered promotions)
  metadata?: {
    tiers?: Array<{ minQty: number; discountPercent: number }>;
  } | null;
  // Related data
  promotion_products?: Array<{
    product_id?: string | null;
    product_variant_id?: string | null;
    product_category_id?: string | null;
  }>;
  promotion_bundles?: Array<{
    id: string;
    bundle_name: string;
    bundle_discount_value?: number | null;
    bundle_discount_percentage?: number | null;
    bundle_items?: Array<{
      product_id?: string | null;
      product_variant_id?: string | null;
      quantity: number;
    }>;
  }>;
}

/**
 * Transform promotion from API response to POS format
 */
function transformPromotionFromAPI(data: PromotionFromAPI): POSPromotion {
  // Extract product IDs, variant IDs, and category IDs from promotion_products
  const productIds: string[] = [];
  const variantIds: string[] = [];
  const categoryIds: string[] = [];

  if (data.promotion_products) {
    for (const pp of data.promotion_products) {
      if (pp.product_id) productIds.push(pp.product_id);
      if (pp.product_variant_id) variantIds.push(pp.product_variant_id);
      if (pp.product_category_id) categoryIds.push(pp.product_category_id);
    }
  }

  // Transform bundles
  const bundles: PromotionBundle[] = [];
  if (data.promotion_bundles) {
    for (const bundle of data.promotion_bundles) {
      const items: BundleItem[] = [];
      if (bundle.bundle_items) {
        for (const item of bundle.bundle_items) {
          items.push({
            productId: item.product_id ?? undefined,
            variantId: item.product_variant_id ?? undefined,
            quantity: item.quantity,
          });
        }
      }
      bundles.push({
        bundleName: bundle.bundle_name,
        discountValue: bundle.bundle_discount_value ?? undefined,
        discountPercentage: bundle.bundle_discount_percentage ?? undefined,
        items,
      });
    }
  }

  // Transform tiered discounts from metadata.tiers format to TieredDiscount[] format
  let tieredDiscounts: TieredDiscount[] | undefined = undefined;
  if (data.promotion_type === 'tiered' && data.metadata?.tiers) {
    tieredDiscounts = data.metadata.tiers.map(tier => ({
      minQuantity: tier.minQty,
      discountPercentage: tier.discountPercent,
    }));
  }

  return {
    id: data.id,
    organizationId: data.organization_id,
    branchId: data.branch_id,
    name: data.name,
    description: data.description,
    promotionType: data.promotion_type as POSPromotion['promotionType'],
    discountValue: data.discount_value,
    discountPercentage: data.discount_percentage,
    buyQuantity: data.buy_quantity,
    getQuantity: data.get_quantity,
    getPercentage: data.get_percentage,
    tieredDiscounts,
    appliesTo: data.applies_to as POSPromotion['appliesTo'],
    productIds: productIds.length > 0 ? productIds : undefined,
    variantIds: variantIds.length > 0 ? variantIds : undefined,
    categoryIds: categoryIds.length > 0 ? categoryIds : undefined,
    startDate: data.start_date,
    endDate: data.end_date,
    startTime: data.start_time,
    endTime: data.end_time,
    dayOfWeek: data.day_of_week,
    maxDiscountAmount: data.max_discount_amount,
    minPurchaseAmount: data.min_purchase_amount,
    maxRedemptionsPerCustomer: data.max_redemptions_per_customer,
    maxTotalRedemptions: data.max_total_redemptions,
    currentRedemptionsCount: data.current_redemptions_count,
    isActive: data.is_active,
    isStackable: data.is_stackable,
    priority: data.priority,
    bundles: bundles.length > 0 ? bundles : undefined,
  };
}

class PromotionsService {
  private branchId: string = '';
  private organizationId: string = '';
  private realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
  private cachedPromotions: POSPromotion[] = [];
  private lastFetchTime: number = 0;
  private cacheTTL: number = 60000; // 1 minute cache

  /**
   * Set the current branch and organization context
   */
  setContext(branchId: string, organizationId: string): void {
    this.branchId = branchId;
    this.organizationId = organizationId;
    // Clear cache when context changes
    this.cachedPromotions = [];
    this.lastFetchTime = 0;
  }

  /**
   * Fetch active promotions for the current branch
   */
  async fetchActivePromotions(forceRefresh: boolean = false): Promise<POSPromotion[]> {
    // Check cache
    if (!forceRefresh && this.cachedPromotions.length > 0) {
      const now = Date.now();
      if (now - this.lastFetchTime < this.cacheTTL) {
        return this.cachedPromotions;
      }
    }

    if (!this.organizationId) {
      console.warn('PromotionsService: Missing organizationId');
      return [];
    }

    try {
      const now = new Date().toISOString().split('T')[0];

      let query = supabase
        .from('product_promotions')
        .select(`
          *,
          promotion_products (
            product_id,
            product_variant_id,
            product_category_id
          ),
          promotion_bundles (
            id,
            bundle_name,
            bundle_discount_value,
            bundle_discount_percentage,
            bundle_items (
              product_id,
              product_variant_id,
              quantity
            )
          )
        `)
        .eq('organization_id', this.organizationId)
        .eq('is_active', true)
        .lte('start_date', now)
        .order('priority', { ascending: true });

      // Filter by branch (branch-specific or org-wide)
      if (this.branchId) {
        query = query.or(`branch_id.eq.${this.branchId},branch_id.is.null`);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching promotions:', error);
        return this.cachedPromotions; // Return cached data on error
      }

      // Filter out expired promotions client-side (end_date check)
      const activePromotions = (data || []).filter((p: PromotionFromAPI) => {
        if (p.end_date && p.end_date < now) return false;
        return true;
      });

      this.cachedPromotions = activePromotions.map(transformPromotionFromAPI);
      this.lastFetchTime = Date.now();

      return this.cachedPromotions;
    } catch (error) {
      console.error('Failed to fetch promotions:', error);
      return this.cachedPromotions;
    }
  }

  /**
   * Validate promotions against cart items
   */
  async validateCartPromotions(
    cartItems: CartItem[],
    customerId?: string | null
  ): Promise<CartPromotionSummary> {
    const promotions = await this.fetchActivePromotions();
    return calculateCartPromotions(promotions, cartItems, customerId);
  }

  /**
   * Apply a specific promotion to cart
   */
  async applySpecificPromotion(
    promotionId: string,
    cartItems: CartItem[],
    customerId?: string | null
  ): Promise<PromotionApplicationResult | null> {
    const promotions = await this.fetchActivePromotions();
    const promotion = promotions.find(p => p.id === promotionId);

    if (!promotion) {
      return {
        promotionId,
        promotionName: 'Unknown',
        promotionType: 'percentage',
        discountAmount: 0,
        isValid: false,
        message: 'Promotion not found',
      };
    }

    return applyPromotion(promotion, cartItems, customerId);
  }

  /**
   * Find the best available promotion for cart
   */
  async findBestPromotionForCart(
    cartItems: CartItem[],
    customerId?: string | null
  ): Promise<PromotionApplicationResult | null> {
    const promotions = await this.fetchActivePromotions();
    return findBestPromotion(promotions, cartItems, customerId);
  }

  /**
   * Record a promotion redemption
   */
  async recordRedemption(
    promotionId: string,
    orderId: string,
    customerId: string | null,
    discountApplied: number
  ): Promise<boolean> {
    if (!this.organizationId) {
      console.warn('PromotionsService: Missing organizationId');
      return false;
    }

    try {
      const { error } = await supabase.from('promotion_redemptions').insert({
        organization_id: this.organizationId,
        promotion_id: promotionId,
        order_id: orderId,
        customer_id: customerId,
        discount_applied: discountApplied,
        redeemed_at: new Date().toISOString(),
      });

      if (error) {
        console.error('Error recording redemption:', error);
        return false;
      }

      // Invalidate cache to reflect updated redemption count
      this.lastFetchTime = 0;

      return true;
    } catch (error) {
      console.error('Failed to record redemption:', error);
      return false;
    }
  }

  /**
   * Subscribe to real-time promotion updates
   */
  subscribeToUpdates(callback: () => void): void {
    if (this.realtimeChannel) {
      this.unsubscribeFromUpdates();
    }

    this.realtimeChannel = subscribeToTable(
      'product_promotions',
      () => {
        // Clear cache on any change
        this.lastFetchTime = 0;
        callback();
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

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cachedPromotions = [];
    this.lastFetchTime = 0;
  }

  /**
   * Get cached promotions (for display without refetch)
   */
  getCachedPromotions(): POSPromotion[] {
    return this.cachedPromotions;
  }

  /**
   * Generate bundle inventory deduction events for an order
   * This should be called when an order is completed to properly deduct inventory
   * for bundle component products.
   *
   * @param orderId - The order ID
   * @param orderItems - Array of items in the order
   * @returns Array of bundle inventory deduction events
   */
  async generateBundleInventoryDeductionEvents(
    orderId: string,
    orderItems: Array<{
      id?: string;
      product_id?: string;
      bundle_id?: string;
      quantity: number;
      name?: string;
    }>
  ): Promise<BundleInventoryDeductionEvent[]> {
    const events: BundleInventoryDeductionEvent[] = [];

    // Filter for bundle items (items with bundle_id set)
    const bundleItems = orderItems.filter(item => item.bundle_id);

    if (bundleItems.length === 0) {
      return events;
    }

    // Fetch product bundles with their components
    try {
      const bundleIds = [...new Set(bundleItems.map(item => item.bundle_id).filter(Boolean))];

      const { data: bundles, error } = await supabase
        .from('product_bundles')
        .select(`
          id,
          sku,
          name,
          inventory_deduction_type,
          product_bundle_items (
            id,
            product_id,
            product_variant_id,
            quantity,
            products:product_id (name),
            product_variants:product_variant_id (name)
          )
        `)
        .in('id', bundleIds as string[]);

      if (error) {
        console.error('[PromotionsService] Error fetching bundles for inventory deduction:', error);
        return events;
      }

      if (!bundles || bundles.length === 0) {
        return events;
      }

      // Generate events for each bundle item in the order
      for (const orderItem of bundleItems) {
        const bundle = bundles.find(b => b.id === orderItem.bundle_id);
        if (!bundle) continue;

        // Skip if bundle doesn't deduct from components
        if (bundle.inventory_deduction_type === 'track_bundle_only') {
          continue;
        }

        const components: BundleComponentDeduction[] = [];

        for (const component of (bundle.product_bundle_items || [])) {
          const productName =
            (component.products as any)?.name ||
            (component.product_variants as any)?.name ||
            'Unknown Product';

          components.push({
            product_id: component.product_id || null,
            product_variant_id: component.product_variant_id || null,
            product_name: productName,
            quantity_to_deduct: component.quantity * orderItem.quantity,
          });
        }

        if (components.length > 0) {
          events.push({
            event_type: 'bundle_sale',
            bundle_id: bundle.id,
            bundle_sku: bundle.sku,
            bundle_name: bundle.name,
            order_id: orderId,
            organization_id: this.organizationId,
            branch_id: this.branchId || null,
            quantity_sold: orderItem.quantity,
            deduction_type: bundle.inventory_deduction_type as BundleInventoryDeductionEvent['deduction_type'],
            components,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      console.error('[PromotionsService] Failed to generate bundle inventory deduction events:', error);
    }

    return events;
  }

  /**
   * Emit bundle inventory deduction events to the inventory service
   * This inserts the events into the inventory_events table for processing
   *
   * @param events - Array of bundle inventory deduction events
   * @returns Success status
   */
  async emitBundleInventoryDeductionEvents(
    events: BundleInventoryDeductionEvent[]
  ): Promise<boolean> {
    if (events.length === 0) {
      return true;
    }

    try {
      // Insert events into inventory_events table for async processing
      const insertData = events.map(event => ({
        organization_id: event.organization_id,
        branch_id: event.branch_id,
        event_type: event.event_type,
        reference_id: event.order_id,
        reference_type: 'order',
        metadata: {
          bundle_id: event.bundle_id,
          bundle_sku: event.bundle_sku,
          bundle_name: event.bundle_name,
          quantity_sold: event.quantity_sold,
          deduction_type: event.deduction_type,
          components: event.components,
        },
        created_at: event.timestamp,
      }));

      const { error } = await supabase
        .from('inventory_events')
        .insert(insertData);

      if (error) {
        console.error('[PromotionsService] Error emitting bundle inventory events:', error);
        return false;
      }

      console.log(`[PromotionsService] Emitted ${events.length} bundle inventory deduction event(s)`);
      return true;
    } catch (error) {
      console.error('[PromotionsService] Failed to emit bundle inventory events:', error);
      return false;
    }
  }

  /**
   * Process bundle inventory deduction for a completed order
   * Convenience method that generates and emits events in one call
   *
   * @param orderId - The order ID
   * @param orderItems - Array of items in the order
   * @returns Success status and generated events
   */
  async processBundleInventoryDeduction(
    orderId: string,
    orderItems: Array<{
      id?: string;
      product_id?: string;
      bundle_id?: string;
      quantity: number;
      name?: string;
    }>
  ): Promise<{ success: boolean; events: BundleInventoryDeductionEvent[] }> {
    const events = await this.generateBundleInventoryDeductionEvents(orderId, orderItems);

    if (events.length === 0) {
      return { success: true, events: [] };
    }

    const emitSuccess = await this.emitBundleInventoryDeductionEvents(events);
    return { success: emitSuccess, events };
  }
}

/**
 * Bundle inventory deduction event type
 */
export interface BundleInventoryDeductionEvent {
  event_type: 'bundle_sale';
  bundle_id: string;
  bundle_sku: string;
  bundle_name: string;
  order_id: string;
  organization_id: string;
  branch_id: string | null;
  quantity_sold: number;
  deduction_type: 'deduct_components' | 'track_bundle_only' | 'both';
  components: BundleComponentDeduction[];
  timestamp: string;
}

/**
 * Individual component deduction within a bundle sale
 */
export interface BundleComponentDeduction {
  product_id: string | null;
  product_variant_id: string | null;
  product_name: string;
  quantity_to_deduct: number;
}

// Export singleton instance
export const promotionsService = new PromotionsService();
