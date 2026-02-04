/**
 * Bundle Inventory Handlers
 *
 * Handles bundle inventory deduction events when bundle items are sold.
 * This module emits inventory deduction events for component products
 * when bundles are sold through orders.
 *
 * Feature: bundle-inventory-deduction
 */

import { ipcMain } from 'electron';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from '../../../shared/supabase-config';
import { serviceRegistry } from '../../service-registry';

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

/**
 * Order item with potential bundle reference
 */
interface OrderItem {
  id?: string;
  product_id?: string;
  bundle_id?: string;
  quantity: number;
  name?: string;
}

/**
 * Create a Supabase client for inventory operations
 */
function createSupabaseClient(): SupabaseClient | null {
  try {
    const config = getSupabaseConfig('server');
    return createClient(config.url, config.serviceRoleKey || config.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } catch (error) {
    console.error('[BundleInventory] Failed to create Supabase client:', error);
    return null;
  }
}

/**
 * Get organization and branch context from settings
 */
function getContext(): { organizationId: string; branchId: string } {
  const settingsService = serviceRegistry.get('settingsService');
  const organizationId =
    (settingsService?.getSetting?.('terminal', 'organization_id', '') as string) ||
    process.env.ORGANIZATION_ID ||
    '';
  const branchId =
    (settingsService?.getSetting?.('terminal', 'branch_id', '') as string) ||
    process.env.BRANCH_ID ||
    '';
  return { organizationId, branchId };
}

/**
 * Generate bundle inventory deduction events for an order
 */
async function generateBundleInventoryDeductionEvents(
  supabase: SupabaseClient,
  orderId: string,
  orderItems: OrderItem[],
  organizationId: string,
  branchId: string
): Promise<BundleInventoryDeductionEvent[]> {
  const events: BundleInventoryDeductionEvent[] = [];

  // Filter for bundle items (items with bundle_id set)
  const bundleItems = orderItems.filter((item) => item.bundle_id);

  if (bundleItems.length === 0) {
    return events;
  }

  try {
    const bundleIds = [...new Set(bundleItems.map((item) => item.bundle_id).filter(Boolean))];

    const { data: bundles, error } = await supabase
      .from('product_bundles')
      .select(
        `
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
      `
      )
      .in('id', bundleIds as string[]);

    if (error) {
      console.error('[BundleInventory] Error fetching bundles:', error);
      return events;
    }

    if (!bundles || bundles.length === 0) {
      return events;
    }

    // Generate events for each bundle item in the order
    for (const orderItem of bundleItems) {
      const bundle = bundles.find((b) => b.id === orderItem.bundle_id);
      if (!bundle) continue;

      // Skip if bundle doesn't deduct from components
      if (bundle.inventory_deduction_type === 'track_bundle_only') {
        continue;
      }

      const components: BundleComponentDeduction[] = [];

      for (const component of bundle.product_bundle_items || []) {
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
          organization_id: organizationId,
          branch_id: branchId || null,
          quantity_sold: orderItem.quantity,
          deduction_type: bundle.inventory_deduction_type as BundleInventoryDeductionEvent['deduction_type'],
          components,
          timestamp: new Date().toISOString(),
        });
      }
    }
  } catch (error) {
    console.error('[BundleInventory] Failed to generate events:', error);
  }

  return events;
}

/**
 * Emit bundle inventory deduction events to the inventory_events table
 */
async function emitBundleInventoryDeductionEvents(
  supabase: SupabaseClient,
  events: BundleInventoryDeductionEvent[]
): Promise<boolean> {
  if (events.length === 0) {
    return true;
  }

  try {
    const insertData = events.map((event) => ({
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

    const { error } = await supabase.from('inventory_events').insert(insertData);

    if (error) {
      console.error('[BundleInventory] Error emitting events:', error);
      return false;
    }

    console.log(`[BundleInventory] Emitted ${events.length} bundle inventory deduction event(s)`);
    return true;
  } catch (error) {
    console.error('[BundleInventory] Failed to emit events:', error);
    return false;
  }
}

/**
 * Process bundle inventory deduction for a completed order
 * This is called when an order status is updated to 'completed'
 *
 * @param orderId - The order ID
 * @param orderItems - Array of items in the order (parsed from JSON if needed)
 */
export async function processBundleInventoryDeduction(
  orderId: string,
  orderItems: OrderItem[]
): Promise<{ success: boolean; eventsEmitted: number }> {
  const supabase = createSupabaseClient();
  if (!supabase) {
    return { success: false, eventsEmitted: 0 };
  }

  const { organizationId, branchId } = getContext();

  if (!organizationId) {
    console.warn('[BundleInventory] Missing organizationId, skipping bundle inventory deduction');
    return { success: true, eventsEmitted: 0 };
  }

  const events = await generateBundleInventoryDeductionEvents(
    supabase,
    orderId,
    orderItems,
    organizationId,
    branchId
  );

  if (events.length === 0) {
    return { success: true, eventsEmitted: 0 };
  }

  const emitSuccess = await emitBundleInventoryDeductionEvents(supabase, events);
  return { success: emitSuccess, eventsEmitted: events.length };
}

/**
 * Register bundle inventory IPC handlers
 */
export function registerBundleInventoryHandlers(): void {
  // Remove existing handler to prevent double registration
  ipcMain.removeHandler('inventory:process-bundle-deduction');

  // Handler for processing bundle inventory deduction
  ipcMain.handle(
    'inventory:process-bundle-deduction',
    async (_event, { orderId, orderItems }: { orderId: string; orderItems: OrderItem[] }) => {
      console.log('[BundleInventory] Processing bundle inventory deduction for order:', orderId);

      try {
        const result = await processBundleInventoryDeduction(orderId, orderItems);
        return {
          success: result.success,
          eventsEmitted: result.eventsEmitted,
        };
      } catch (error) {
        console.error('[BundleInventory] Handler error:', error);
        return {
          success: false,
          eventsEmitted: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  console.log('[BundleInventory] ✅ Bundle inventory handlers registered');
}
