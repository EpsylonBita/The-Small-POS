/**
 * Order CRUD Handlers
 *
 * Handles order get, create, and delete operations.
 * Uses serviceRegistry for dependency access.
 */

import { ipcMain } from 'electron';
import { createClient } from '@supabase/supabase-js';
import { serviceRegistry } from '../../service-registry';
import { handleIPCError, IPCError } from '../utils';
import { withTimeout } from '../../../shared/utils/error-handler';
import { TIMING } from '../../../shared/constants';
import { getSupabaseConfig } from '../../../shared/supabase-config';

/**
 * Resolve item name from multiple sources with fallback chain:
 * 1. Direct name fields (name, item_name, product_name)
 * 2. Embedded menu_item data
 * 3. Local subcategories cache
 * 4. Supabase subcategories table
 * 5. Supabase menu_items table (new fallback)
 * 6. Fallback to "Item {id}" or "Unknown Item"
 */
async function resolveItemName(
  item: any,
  dbManager: any,
  supabaseClient?: any
): Promise<string> {
  console.log('[resolveItemName] Resolving item:', {
    name: item.name,
    menu_item_id: item.menu_item_id,
    subcategory_id: item.subcategory_id,
    hasMenuItemObj: !!item.menu_item
  });

  // 1. Try direct name fields, BUT ignore generic "Item {hash}" names
  const isGenericName = item.name && typeof item.name === 'string' && /^Item [a-fA-F0-9]+/.test(item.name);

  if (item.name && typeof item.name === 'string' && item.name.trim() && !isGenericName) {
    console.log('[resolveItemName] Found existing valid name:', item.name);
    return item.name;
  }
  if (isGenericName) {
    console.log(`[resolveItemName] Ignoring generic name "${item.name}", attempting resolution...`);
  }

  if (item.item_name && typeof item.item_name === 'string' && item.item_name.trim()) {
    return item.item_name;
  }
  if (item.product_name && typeof item.product_name === 'string' && item.product_name.trim()) {
    return item.product_name;
  }

  // 2. Try embedded menu_item data
  if (item.menu_item) {
    if (item.menu_item.name && typeof item.menu_item.name === 'string' && item.menu_item.name.trim()) {
      return item.menu_item.name;
    }
    if (item.menu_item.item_name && typeof item.menu_item.item_name === 'string') {
      return item.menu_item.item_name;
    }
  }

  // Also try subcategory object if present
  if (item.subcategory) {
    const subName = item.subcategory.name || item.subcategory.name_en || item.subcategory.name_el;
    if (subName && typeof subName === 'string' && subName.trim()) {
      console.log('[resolveItemName] Found name in subcategory object:', subName);
      return subName;
    }
  }

  // The ID to use for lookups
  const itemId = item.menu_item_id || item.subcategory_id;

  // 3. Try local cache if we have an ID
  if (itemId && dbManager?.getSubcategoryFromCache) {
    try {
      const cached = dbManager.getSubcategoryFromCache(itemId);
      if (cached) {
        const cachedName = cached.name || cached.name_en || cached.name_el;
        if (cachedName) {
          console.log(`[resolveItemName] Found name in cache for ${itemId}: ${cachedName}`);
          return cachedName;
        }
      }
    } catch (cacheError) {
      console.warn('[resolveItemName] Cache lookup failed:', cacheError);
    }
  }

  // 4. Try Supabase subcategories as fallback
  if (itemId && supabaseClient) {
    try {
      console.log(`[resolveItemName] Querying Supabase subcategories for ID: ${itemId}`);
      const { data: subcategory, error } = await supabaseClient
        .from('subcategories')
        .select('id, name, name_en, name_el')
        .eq('id', itemId)
        .single();

      if (!error && subcategory) {
        const supabaseName = subcategory.name || subcategory.name_en || subcategory.name_el;
        if (supabaseName) {
          console.log(`[resolveItemName] Found name in Supabase subcategories: ${supabaseName}`);
          // Cache for future use
          if (dbManager?.cacheSubcategory) {
            try {
              dbManager.cacheSubcategory(
                subcategory.id,
                subcategory.name || '',
                subcategory.name_en,
                subcategory.name_el
              );
            } catch (cacheErr) {
              console.warn('[resolveItemName] Failed to cache subcategory:', cacheErr);
            }
          }
          return supabaseName;
        }
      } else {
        console.log(`[resolveItemName] Subcategory not found, trying menu_items`);
      }
    } catch (supabaseError) {
      console.warn('[resolveItemName] Supabase subcategories lookup failed:', supabaseError);
    }

    // 5. Try menu_items table as another fallback
    try {
      const { data: menuItem, error } = await supabaseClient
        .from('menu_items')
        .select('id, name, name_en, name_el')
        .eq('id', itemId)
        .single();

      if (!error && menuItem) {
        const menuItemName = menuItem.name || menuItem.name_en || menuItem.name_el;
        if (menuItemName) {
          console.log(`[resolveItemName] Found name in Supabase menu_items: ${menuItemName}`);
          return menuItemName;
        }
      }
    } catch (menuItemError) {
      console.warn('[resolveItemName] Supabase menu_items lookup failed:', menuItemError);
    }
  }

  // 6. Final fallback
  if (itemId) {
    console.warn(`[resolveItemName] Could not resolve name for ID: ${itemId}`);
    return `Item ${itemId.substring(0, 8)}`;
  }

  console.warn('[resolveItemName] Item has no name and no ID');
  return 'Unknown Item';
}

/**
 * Check if a name is a valid item name (not generic/truncated ID)
 * Returns true if the name is valid, false if it's a generic "Item {hash}" or UUID pattern
 */
function isValidItemName(name: string | undefined | null): boolean {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return false;
  }
  // Reject generic "Item {hash}" names
  if (/^Item [a-fA-F0-9]+/.test(name)) {
    return false;
  }
  // Reject UUID patterns
  if (/^[a-f0-9]{8}-[a-f0-9]{4}/.test(name)) {
    return false;
  }
  return true;
}

/**
 * Enrich order items with names from cache or Supabase
 * Used during order creation to ensure all items have names before storage
 * 
 * CRITICAL: This function MUST set menu_item_name field on every item
 * The menu_item_name field is used for sync to Supabase and must be:
 * - Non-null and non-empty
 * - NOT a generic "Item {hash}" pattern
 * - NOT a UUID or truncated ID
 */
async function enrichOrderItemsWithNames(
  items: any[],
  dbManager: any,
  supabaseClient?: any
): Promise<any[]> {
  if (!items || items.length === 0) return items;

  console.log(`[enrichOrderItemsWithNames] Enriching ${items.length} items`);

  const enrichedItems = await Promise.all(items.map(async (item) => {
    try {
      if (!item) return item; // Safety check

      // 1. Resolve Item Name
      let resolvedName = item.name;
      const originalName = item.name;

      // Use helper to resolve name if missing or generic
      const needsNameResolution = !isValidItemName(item.name);
      if (needsNameResolution) {
        resolvedName = await resolveItemName(item, dbManager, supabaseClient);
        if (resolvedName !== originalName) {
          console.log(`[enrichOrderItemsWithNames] Enriched item ${item.menu_item_id || 'unknown'} name: ${resolvedName}`);
        }
      }

      // 2. Resolve Subcategory Name
      // OrderDetailsModal expects item.subcategory.name
      let subcategoryObj = item.subcategory || {};
      let subcategoryName = subcategoryObj.name || subcategoryObj.name_en || subcategoryObj.name_el;

      if (!subcategoryName) {
        const subId = item.subcategory_id || item.menu_item?.subcategory_id;
        if (subId) {
          // Try local cache first
          if (dbManager?.getSubcategoryFromCache) {
            try {
              const cached = dbManager.getSubcategoryFromCache(subId);
              if (cached) {
                const cachedName = cached.name || cached.name_en || cached.name_el;
                if (cachedName) {
                  // console.log(`[enrichOrderItemsWithNames] Found subcategory in cache: ${cachedName}`);
                  subcategoryName = cachedName;
                }
              }
            } catch (e) { /* ignore */ }
          }

          // Try Supabase fallback if still missing
          if (!subcategoryName && supabaseClient) {
            try {
              const { data: sub, error } = await supabaseClient
                .from('subcategories')
                .select('id, name, name_en, name_el')
                .eq('id', subId)
                .single();

              if (!error && sub) {
                subcategoryName = sub.name || sub.name_en || sub.name_el;
                console.log(`[enrichOrderItemsWithNames] Found subcategory in Supabase: ${subcategoryName}`);
              }
            } catch (e) {
              console.warn('[enrichOrderItemsWithNames] Supabase subcategory lookup failed:', e);
            }
          }
        }
      }

      // 3. CRITICAL: Set menu_item_name field for sync
      // This field MUST be set on every item for proper sync to Supabase
      // Priority: resolved name > existing menu_item_name > subcategory name
      let menuItemName = resolvedName;
      
      // If resolved name is still invalid, try existing menu_item_name
      if (!isValidItemName(menuItemName)) {
        menuItemName = item.menu_item_name;
      }
      
      // If still invalid, try subcategory name
      if (!isValidItemName(menuItemName)) {
        menuItemName = subcategoryName;
      }
      
      // Final validation - log warning if name is still invalid
      if (!isValidItemName(menuItemName)) {
        console.warn(`[enrichOrderItemsWithNames] Item ${item.menu_item_id || 'unknown'} has invalid name after enrichment: "${menuItemName}"`);
      }

      // Construct enriched item with menu_item_name field
      return {
        ...item,
        name: resolvedName,
        menu_item_name: menuItemName, // CRITICAL: Always set this field for sync
        subcategory: {
          ...subcategoryObj,
          name: subcategoryName || subcategoryObj.name // Keep existing if valid, or use resolved
        }
      };
    } catch (err) {
      console.error('[enrichOrderItemsWithNames] Error enriching item:', err);
      return item; // Return original item on failure
    }
  }));

  return enrichedItems;
}

/**
 * Create a Supabase client for item name resolution
 */
function createSupabaseClientForNameResolution(): any {
  try {
    const config = getSupabaseConfig('server');
    return createClient(config.url, config.serviceRoleKey || config.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  } catch (error) {
    console.warn('[createSupabaseClientForNameResolution] Failed to create client:', error);
    return null;
  }
}

/**
 * Transform database order to frontend format
 * Ensures items are always parsed from JSON string if needed
 */
function transformOrder(order: any) {
  // Parse items if stored as JSON string (Requirements 2.1, 2.3)
  let items = order.items;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch (e) {
      console.error('[transformOrder] Failed to parse items JSON:', e);
      items = []; // Graceful fallback to empty array
    }
  }
  
  // Ensure items is always an array (never null/undefined)
  if (!Array.isArray(items)) {
    items = [];
  }

  return {
    id: order.id,
    supabase_id: order.supabase_id, // Include Supabase ID for edit operations
    order_number: order.order_number, // Include snake_case for compatibility
    orderNumber: order.order_number || `ORD-${order.id.slice(-6)}`,
    status: order.status,
    items: items,
    total_amount: order.total_amount, // snake_case for frontend compatibility
    totalAmount: order.total_amount,
    subtotal: order.subtotal,
    tax_amount: order.tax_amount,
    tax: order.tax_amount,
    customer_name: order.customer_name, // snake_case
    customerName: order.customer_name,
    customer_phone: order.customer_phone, // snake_case
    customerPhone: order.customer_phone,
    customer_email: order.customer_email,
    customerEmail: order.customer_email,
    order_type: order.order_type, // snake_case
    orderType: order.order_type || 'takeaway',
    tableNumber: order.table_number,
    table_number: order.table_number,
    // Delivery address fields - both snake_case and legacy name
    address: order.delivery_address,
    delivery_address: order.delivery_address, // Include original snake_case
    delivery_city: order.delivery_city,
    delivery_postal_code: order.delivery_postal_code,
    delivery_floor: order.delivery_floor,
    delivery_notes: order.delivery_notes,
    name_on_ringer: order.name_on_ringer,
    special_instructions: order.special_instructions,
    notes: order.special_instructions,
    created_at: order.created_at,
    createdAt: order.created_at,
    updated_at: order.updated_at,
    updatedAt: order.updated_at,
    estimatedTime: order.estimated_time,
    estimated_time: order.estimated_time,
    payment_status: order.payment_status,
    paymentStatus: order.payment_status,
    payment_method: order.payment_method,
    paymentMethod: order.payment_method,
    paymentTransactionId: order.payment_transaction_id,
    // Platform integration fields
    platform: order.platform,
    externalPlatformOrderId: order.external_platform_order_id,
    platformCommissionPct: order.platform_commission_pct,
    netEarnings: order.net_earnings,
    // Driver assignment fields
    driver_id: order.driver_id,
    driverId: order.driver_id, // camelCase alias for frontend compatibility
    driver_name: order.driver_name,
    driverName: order.driver_name, // May be populated from joins or enrichment
    // Discount fields
    discount_amount: order.discount_amount,
    discount_percentage: order.discount_percentage,
    delivery_fee: order.delivery_fee,
  };
}

export function registerOrderCrudHandlers(): void {
  // Remove existing handlers to prevent double registration
  const handlers = [
    'order:get-all',
    'order:get-by-id',
    'order:get-by-customer-phone',
    'order:create',
    'order:delete',
    'order:fetch-items-from-supabase',
    'order:update-items',
  ];
  handlers.forEach(handler => ipcMain.removeHandler(handler));

  // Get orders by customer phone (for customer order history)
  ipcMain.handle('order:get-by-customer-phone', async (_event, customerPhone: string) => {
    return handleIPCError(async () => {
      if (!customerPhone || typeof customerPhone !== 'string') {
        throw new IPCError('customerPhone is required', 'VALIDATION_ERROR');
      }

      const dbManager = serviceRegistry.requireService('dbManager');

      // Use getAllOrders to fetch orders - no limit param, we'll filter manually
      const allOrders = await dbManager.getAllOrders();

      // DEBUG: Checking data availability for first 3 orders to find why address is missing
      if (allOrders && allOrders.length > 0) {
        console.log('[order:get-by-customer-phone] DEBUG First 3 DB Results:',
          allOrders.slice(0, 3).map((o: any) => ({
            id: o.id,
            no: o.order_number,
            addr: o.delivery_address,
            city: o.delivery_city,
            fl: o.delivery_floor,
            items: typeof o.items === 'string' ? JSON.parse(o.items).length : o.items?.length
          }))
        );
      }

      if (!allOrders || allOrders.length === 0) {
        return { success: true, orders: [] };
      }

      // Normalize phone for matching (remove spaces, dashes, etc.)
      const normalizedPhone = customerPhone.replace(/[\s\-\(\)]/g, '');

      // Filter orders by customer phone
      const customerOrders = allOrders.filter((order: any) => {
        if (!order.customer_phone) return false;
        const orderPhone = order.customer_phone.replace(/[\s\-\(\)]/g, '');
        return orderPhone.includes(normalizedPhone) || normalizedPhone.includes(orderPhone);
      });

      // Transform and deduplicate
      const seenNumbers = new Set<string>();
      const uniqueOrders = customerOrders.filter((o: any) => {
        if (seenNumbers.has(o.order_number)) return false;
        seenNumbers.add(o.order_number);
        return true;
      });

      // Add items count and sort by date descending
      const transformedOrders = uniqueOrders
        .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 50)
        .map((order: any) => {
          let itemsCount = 0;
          try {
            const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
            itemsCount = Array.isArray(items) ? items.length : 0;
          } catch { }

          return {
            id: order.id,
            order_number: order.order_number,
            status: order.status,
            order_type: order.order_type,
            total_amount: order.total_amount,
            payment_method: order.payment_method,
            created_at: order.created_at,
            items_count: itemsCount,
          };
        });

      console.log(`[order:get-by-customer-phone] Found ${transformedOrders.length} orders for phone: ${customerPhone}`);
      return { success: true, orders: transformedOrders };
    }, 'order:get-by-customer-phone');
  });

  // Get all orders - filtered to only show orders from current business shift
  // Orders from before the last Z-Report are excluded to ensure fresh start
  // Uses timestamp (not date) because business days don't align with calendar days
  // e.g., a store closing at 5am - orders from 00:00-05:00 belong to previous business day
  ipcMain.handle('order:get-all', async () => {
    return handleIPCError(async () => {
      const dbManager = serviceRegistry.requireService('dbManager');
      const settingsService = dbManager.getDatabaseService().settings;

      // Get the last Z-Report timestamp to filter out old orders
      const lastZReportTimestamp = settingsService?.getSetting<string>('system', 'last_z_report_timestamp') || null;

      console.log(`[order:get-all] Z-Report timestamp from settings: ${lastZReportTimestamp || 'NOT SET'}`);

      // Filter orders created AFTER the last Z-Report timestamp
      const orders = await withTimeout(
        dbManager.getOrders({ afterTimestamp: lastZReportTimestamp || undefined }),
        TIMING.DATABASE_QUERY_TIMEOUT,
        'Get all orders',
      );

      // DEBUG: Log metadata for the first few orders to debug missing address issues
      if (orders.length > 0) {
        console.log(`[order:get-all] Fetched ${orders.length} orders. Inspecting first 3 for delivery data:`);
        orders.slice(0, 3).forEach((o: any, i: number) => {
          console.log(`[order:get-all] [${i}] ID: ${o.id}, Addr: "${o.delivery_address || ''}", City: "${o.delivery_city || ''}", Floor: "${o.delivery_floor || ''}"`);
        });
      } else {
        console.log('[order:get-all] No orders found.');
      }

      // Enrich items for ALL fetched orders to ensure names are correct
      // This is critical because some orders might have generic "Item {hash}" names stored in the DB
      // Also handles JSON string parsing (Requirements 2.1, 2.2, 2.5)
      if (orders.length > 0) {
        const supabaseClient = createSupabaseClientForNameResolution();
        await Promise.all(orders.map(async (order: any) => {
          // Parse items if stored as JSON string (Requirements 2.1, 2.3)
          let items = order.items;
          if (typeof items === 'string') {
            try {
              items = JSON.parse(items);
            } catch (e) {
              console.error(`[order:get-all] Failed to parse items JSON for order ${order.id}:`, e);
              items = []; // Graceful fallback to empty array
            }
          }
          
          // Ensure items is always an array (never null/undefined)
          if (!Array.isArray(items)) {
            items = [];
          }
          
          // Enrich items with names if there are any items
          if (items.length > 0) {
            order.items = await enrichOrderItemsWithNames(items, dbManager, supabaseClient);
          } else {
            order.items = items; // Ensure empty array is set
          }
        }));
      }

      const transformedOrders = orders.map(transformOrder);
      return transformedOrders;
    }, 'order:get-all');
  });

  // Get order by ID
  ipcMain.handle('order:get-by-id', async (_event, orderIdOrObject: string | { orderId: string }) => {
    return handleIPCError(async () => {
      const dbManager = serviceRegistry.requireService('dbManager');

      console.log('📥 order:get-by-id called with:', orderIdOrObject, 'type:', typeof orderIdOrObject);

      const orderId =
        typeof orderIdOrObject === 'string'
          ? orderIdOrObject
          : orderIdOrObject && typeof orderIdOrObject === 'object'
            ? orderIdOrObject.orderId
            : undefined;

      if (!orderId) {
        throw new IPCError('orderId is required', 'VALIDATION_ERROR');
      }

      const order = await withTimeout(
        dbManager.getOrderById(orderId),
        TIMING.DATABASE_QUERY_TIMEOUT,
        'Get order by ID',
      );

      if (!order) return null;

      // Enrich items with proper names before returning
      let items = order.items;
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch { items = []; }
      }

      if (Array.isArray(items) && items.length > 0) {
        const supabaseClient = createSupabaseClientForNameResolution();
        const enrichedItems = await enrichOrderItemsWithNames(items, dbManager, supabaseClient);
        order.items = enrichedItems;
      }

      return transformOrder(order);
    }, 'order:get-by-id');
  });

  // Create order
  ipcMain.handle('order:create', async (_event, { orderData }) => {
    return handleIPCError(async () => {
      const dbManager = serviceRegistry.requireService('dbManager');
      const syncService = serviceRegistry.get('syncService');
      const authService = serviceRegistry.get('authService');
      const staffAuthService = serviceRegistry.get('staffAuthService');
      const settingsService = serviceRegistry.get('settingsService');
      const mainWindow = serviceRegistry.get('mainWindow');

      // Validate order data
      if (!orderData.items || orderData.items.length === 0) {
        throw new IPCError('Order must contain at least one item', 'VALIDATION_ERROR');
      }

      if (!orderData.totalAmount || orderData.totalAmount <= 0) {
        throw new IPCError('Order total must be greater than 0', 'VALIDATION_ERROR');
      }

      // Validation for specific order types
      if (orderData.orderType === 'delivery') {
        // Check if deliveryAddress is missing, null, undefined, or empty string
        const hasValidAddress = orderData.deliveryAddress &&
          typeof orderData.deliveryAddress === 'string' &&
          orderData.deliveryAddress.trim().length > 0;

        if (!hasValidAddress) {
          console.warn('[IPC order:create] ❌ Delivery order missing address, attempting fallback...');
          console.warn('[IPC order:create] orderData.deliveryAddress:', orderData.deliveryAddress);
          console.warn('[IPC order:create] Full orderData:', JSON.stringify(orderData, null, 2));

          // Attempt fallback: try to get address from customer record
          // IMPORTANT: This fallback relies on orderData.customerId being populated by the frontend.
          // The frontend order creation flow (OrderDashboard -> OrderService) should ensure that:
          // 1. Delivery orders with persisted customers always include customerId
          // 2. Delivery orders without persisted customers always pass a non-empty deliveryAddress string
          // If neither condition is met, this validation will fail with a helpful error message.
          let fallbackAddress: string | null = null;
          // Track all address fields for complete auto-population (Requirements 3.4)
          let fallbackCity: string | null = null;
          let fallbackPostalCode: string | null = null;
          let fallbackFloor: string | null = null;
          let fallbackDeliveryNotes: string | null = null;
          let fallbackNameOnRinger: string | null = null;

          if (orderData.customerId) {
            try {
              console.log('[IPC order:create] Attempting customer address fallback for customerId:', orderData.customerId);
              const customer = await dbManager.getCustomerById?.(orderData.customerId);

              if (customer) {
                // Check customer.addresses array first (Requirements 3.4)
                if (Array.isArray(customer.addresses) && customer.addresses.length > 0) {
                  const addr = customer.addresses.find((a: any) => a.is_default) || customer.addresses[0];
                  const parts: string[] = [];
                  if (addr.street_address || addr.street) parts.push(addr.street_address || addr.street);
                  if (addr.city) parts.push(addr.city);
                  if (addr.postal_code) parts.push(addr.postal_code);
                  fallbackAddress = parts.filter(Boolean).join(', ');
                  
                  // Extract all address fields for complete auto-population
                  fallbackCity = addr.city || null;
                  fallbackPostalCode = addr.postal_code || addr.zipCode || null;
                  fallbackFloor = addr.floor || addr.floor_number || null;
                  fallbackDeliveryNotes = addr.delivery_notes || addr.notes || addr.comments || null;
                  fallbackNameOnRinger = addr.name_on_ringer || addr.bell_name || null;
                  
                  console.log('[IPC order:create] Fallback address from customer.addresses:', {
                    address: fallbackAddress,
                    city: fallbackCity,
                    postalCode: fallbackPostalCode,
                    floor: fallbackFloor,
                    deliveryNotes: fallbackDeliveryNotes,
                    nameOnRinger: fallbackNameOnRinger
                  });
                }
                // Check legacy customer.address field (Requirements 3.4)
                else if (customer.address) {
                  if (typeof customer.address === 'string') {
                    fallbackAddress = customer.address;
                  } else if (typeof customer.address === 'object') {
                    const parts: string[] = [];
                    if (customer.address.street_address || customer.address.street) {
                      parts.push(customer.address.street_address || customer.address.street);
                    }
                    if (customer.address.city) parts.push(customer.address.city);
                    if (customer.address.postal_code) parts.push(customer.address.postal_code);
                    fallbackAddress = parts.filter(Boolean).join(', ');
                    
                    // Extract all address fields from legacy address object
                    fallbackCity = customer.address.city || null;
                    fallbackPostalCode = customer.address.postal_code || customer.address.zipCode || null;
                    fallbackFloor = customer.address.floor || customer.address.floor_number || null;
                    fallbackDeliveryNotes = customer.address.delivery_notes || customer.address.notes || customer.address.comments || null;
                    fallbackNameOnRinger = customer.address.name_on_ringer || customer.address.bell_name || null;
                  }
                  console.log('[IPC order:create] Fallback address from customer.address:', {
                    address: fallbackAddress,
                    city: fallbackCity,
                    postalCode: fallbackPostalCode,
                    floor: fallbackFloor,
                    deliveryNotes: fallbackDeliveryNotes,
                    nameOnRinger: fallbackNameOnRinger
                  });
                }
              }
            } catch (err) {
              console.error('[IPC order:create] Failed to fetch customer for address fallback:', err);
            }
          }

          if (fallbackAddress) {
            // Populate all delivery address fields from customer's saved address (Requirements 3.4)
            orderData.deliveryAddress = fallbackAddress;
            // Only set fallback values if not already provided in orderData
            if (!orderData.deliveryCity && !orderData.delivery_city) {
              orderData.deliveryCity = fallbackCity;
            }
            if (!orderData.deliveryPostalCode && !orderData.delivery_postal_code) {
              orderData.deliveryPostalCode = fallbackPostalCode;
            }
            if (!orderData.deliveryFloor && !orderData.delivery_floor) {
              orderData.deliveryFloor = fallbackFloor;
            }
            if (!orderData.deliveryNotes && !orderData.delivery_notes) {
              orderData.deliveryNotes = fallbackDeliveryNotes;
            }
            if (!orderData.nameOnRinger && !orderData.name_on_ringer) {
              orderData.nameOnRinger = fallbackNameOnRinger;
            }
            console.log('[IPC order:create] ✓ Using fallback delivery address with all fields:', {
              address: orderData.deliveryAddress,
              city: orderData.deliveryCity,
              postalCode: orderData.deliveryPostalCode,
              floor: orderData.deliveryFloor,
              deliveryNotes: orderData.deliveryNotes,
              nameOnRinger: orderData.nameOnRinger
            });
          } else {
            // Build a helpful error message with customer context
            const customerName = orderData.customerName || 'Unknown customer';
            const hasCustomerId = !!orderData.customerId;
            const errorMsg = hasCustomerId
              ? `Delivery order requires an address. Customer "${customerName}" has no address on file. Please add an address before creating delivery orders.`
              : 'Delivery order requires an address. No customer ID provided and no address in order data. Please select a customer or provide an address.';
            console.error('[IPC order:create] ❌ Address resolution failed:', {
              customerId: orderData.customerId,
              customerName,
              deliveryAddress: orderData.deliveryAddress
            });
            throw new IPCError(errorMsg, 'VALIDATION_ERROR');
          }
        }
      }
      if (orderData.orderType === 'dine-in' && !orderData.tableNumber) {
        console.warn('[IPC order:create] ❌ Validation failed: Dine-in order missing table number');
        throw new IPCError('Dine-in orders must include a table number', 'VALIDATION_ERROR');
      }

      // Authorization check
      const hasPermission =
        (staffAuthService && await staffAuthService.hasPermission('create_order')) ||
        (authService && await authService.hasPermission('create_order'));
      const currentSession = staffAuthService?.getCurrentSession();
      const terminalApiKey = settingsService?.getSetting?.('terminal', 'pos_api_key', '') as string;
      const terminalTrusted = !!terminalApiKey && terminalApiKey.length > 0;

      if (!hasPermission && !currentSession && !terminalTrusted) {
        throw new IPCError('Insufficient permissions', 'PERMISSION_DENIED');
      }

      // Debug: log the items with customizations
      console.log('[order:create] Items received:', JSON.stringify(orderData.items, null, 2));
      // Debug: Log notes field specifically for each item
      if (orderData.items && orderData.items.length > 0) {
        orderData.items.forEach((item: any, idx: number) => {
          console.log(`[order:create] Item ${idx} notes check:`, {
            notes: item.notes,
            special_instructions: item.special_instructions,
            hasNotes: !!(item.notes || item.special_instructions)
          });
        });
      }
      console.log('[order:create] Delivery data received:', {
        delivery_notes: orderData.delivery_notes,
        name_on_ringer: orderData.name_on_ringer,
        deliveryNotes: orderData.deliveryNotes,
        nameOnRinger: orderData.nameOnRinger
      });
      if (orderData.items && orderData.items.length > 0) {
        orderData.items.forEach((item: any, idx: number) => {
          console.log(`[order:create] Item ${idx}: ${item.name}, customizations count:`, item.customizations?.length || 0);
        });
      }

      // Enrich items with names if missing (for orders from external sources)
      const supabaseClientForNames = createSupabaseClientForNameResolution();
      const enrichedItems = await enrichOrderItemsWithNames(orderData.items, dbManager, supabaseClientForNames);

      // Validate enriched items - log warning if any item still has invalid name
      const itemsWithInvalidNames = enrichedItems.filter((item: any) => !isValidItemName(item.menu_item_name));
      if (itemsWithInvalidNames.length > 0) {
        console.warn(`[order:create] ⚠️ ${itemsWithInvalidNames.length} item(s) have invalid names after enrichment:`,
          itemsWithInvalidNames.map((item: any) => ({
            menu_item_id: item.menu_item_id,
            name: item.name,
            menu_item_name: item.menu_item_name
          }))
        );
      }

      // Transform frontend data to database schema
      // Extract delivery address fields from orderData or nested address object
      const dbOrderData = {
        customer_name: orderData.customerName,
        items: enrichedItems,
        total_amount: orderData.totalAmount || 0,
        status: orderData.status,
        order_type: orderData.orderType,
        customer_phone: orderData.customerPhone,
        customer_email: orderData.customerEmail,
        table_number: orderData.tableNumber,
        // Full delivery address fields - extract from orderData (camelCase or snake_case) or nested address object
        // Robust extraction logic to handle various frontend payloads
        delivery_address: orderData.deliveryAddress || orderData.delivery_address || orderData.address?.street_address || orderData.address?.address || orderData.address?.street,
        delivery_city: orderData.deliveryCity || orderData.delivery_city || orderData.address?.city,
        delivery_postal_code: orderData.deliveryPostalCode || orderData.delivery_postal_code || orderData.address?.postal_code || orderData.address?.zipCode,
        delivery_floor: orderData.deliveryFloor || orderData.delivery_floor || orderData.address?.floor || orderData.address?.floor_number,
        delivery_notes: orderData.deliveryNotes || orderData.delivery_notes || orderData.address?.delivery_notes || orderData.address?.notes || orderData.address?.comments,
        name_on_ringer: orderData.nameOnRinger || orderData.name_on_ringer || orderData.address?.name_on_ringer || orderData.address?.bell_name,
        special_instructions: orderData.notes,
        estimated_time: orderData.estimatedTime,
        payment_status: orderData.paymentStatus,
        payment_method: orderData.paymentMethod,
        payment_transaction_id: orderData.paymentTransactionId,
      };

      const createdOrder = await withTimeout(
        dbManager.insertOrder(dbOrderData),
        TIMING.ORDER_CREATE_TIMEOUT,
        'Create order',
      );

      console.log('✅ Order created successfully:', createdOrder?.id);

      // Update activity for session management
      authService?.updateActivity();

      // Notify renderer about the new order
      if (mainWindow && !mainWindow.isDestroyed() && createdOrder) {
        console.log('📤 Sending order-created event to renderer:', createdOrder.id);
        mainWindow.webContents.send('order-created', transformOrder(createdOrder));
      }

      // Auto-print receipt for newly created order
      if (createdOrder && createdOrder.id) {
        console.log('🖨️ [Auto-Print] Starting auto-print for order:', createdOrder.id);
        setTimeout(async () => {
          try {
            // Import print handler dynamically to avoid circular dependencies
            const { getPrinterManagerInstance } = await import('../printer-manager-handlers');
            const printerManager = getPrinterManagerInstance();

            if (!printerManager) {
              console.warn('[Auto-Print] PrinterManager not available, skipping auto-print');
              return;
            }

            // Get the first enabled receipt printer
            const printers = await printerManager.getPrinters();
            const receiptPrinter = printers.find((p: any) => p.role === 'receipt' && p.enabled) || printers.find((p: any) => p.enabled);

            if (!receiptPrinter) {
              console.warn('[Auto-Print] No enabled printers configured, skipping auto-print');
              return;
            }

            console.log('[Auto-Print] Using printer:', receiptPrinter.id, receiptPrinter.name);

            // Fetch complete order with items from database
            const dbManager = serviceRegistry.dbManager;
            if (!dbManager) {
              console.error('[Auto-Print] DatabaseManager not available');
              return;
            }

            const order = await dbManager.getOrderById(createdOrder.id);
            if (!order) {
              console.error('[Auto-Print] Order not found:', createdOrder.id);
              return;
            }

            console.log('[Auto-Print] Order loaded:', {
              id: order.id,
              orderNumber: order.order_number,
              items: order.items?.length || 0,
              total: order.total_amount
            });

            // Debug: Log the full item structure to see what fields are available
            if (order.items && order.items.length > 0) {
              console.log('[Auto-Print] First item structure:', JSON.stringify(order.items[0], null, 2));
            }

            // Import print types and generator
            const { ReceiptGenerator } = await import('../../printer/services/escpos/ReceiptGenerator');
            const { PaperSize, PrintJobType } = await import('../../printer/types/index');

            // Create Supabase client for name resolution fallback
            const supabaseClientForPrint = createSupabaseClientForNameResolution();

            // Transform order items to PrintOrderItem format with enhanced name resolution
            const printItems: any[] = await Promise.all((order.items || []).map(async (item: any) => {
              const modifiers: any[] = [];

              // Handle customizations
              if (item.customizations) {
                const customizations = typeof item.customizations === 'string'
                  ? JSON.parse(item.customizations)
                  : item.customizations;

                // Process customizations object
                Object.values(customizations || {}).forEach((custom: any) => {
                  if (custom && typeof custom === 'object') {
                    const quantity = custom.quantity || 1;
                    const name = custom.name || custom.ingredient?.name || 'Unknown';
                    const isLittle = custom.isLittle || custom.is_little;
                    // Get price from ingredient (three-tier pricing)
                    const getIngredientPrice = () => {
                      if (order.order_type === 'delivery') return custom.ingredient?.delivery_price ?? custom.ingredient?.price;
                      if (order.order_type === 'dine-in') return custom.ingredient?.dine_in_price ?? custom.ingredient?.pickup_price ?? custom.ingredient?.price;
                      return custom.ingredient?.pickup_price ?? custom.ingredient?.price;
                    };
                    const price = getIngredientPrice();

                    let modName = name;
                    if (isLittle) modName += ' (λίγο)';

                    modifiers.push({
                      name: modName,
                      quantity: quantity > 1 ? quantity : undefined,
                      price: price || undefined
                    });
                  }
                });
              }

              // Use enhanced name resolution with cache and Supabase fallback
              const itemName = await resolveItemName(item, dbManager, supabaseClientForPrint);

              return {
                name: itemName,
                quantity: item.quantity || 1,
                unitPrice: item.unit_price || item.price || 0,
                total: item.total_price || (item.price * item.quantity) || 0,
                modifiers: modifiers.length > 0 ? modifiers : undefined,
                specialInstructions: item.notes || item.special_instructions || undefined
              };
            }));

            // Map order type to receipt format
            let orderType: 'dine-in' | 'pickup' | 'delivery' = 'pickup';
            if (order.order_type === 'dine-in' || order.order_type === 'delivery') {
              orderType = order.order_type;
            }

            // Build receipt data
            const receiptData: any = {
              orderNumber: order.order_number || order.id.substring(0, 8),
              orderType: orderType,
              timestamp: new Date(order.created_at || new Date()),
              items: printItems,
              subtotal: order.subtotal || 0,
              tax: (order as any).tax || 0,
              tip: (order as any).tip || 0,
              deliveryFee: order.delivery_fee || 0,
              total: order.total_amount || 0,
              paymentMethod: order.payment_method || 'cash',
              customerName: order.customer_name || undefined,
              customerPhone: order.customer_phone || undefined,
              deliveryAddress: order.delivery_address || undefined,
              deliveryNotes: (order as any).delivery_notes || undefined,
              ringerName: (order as any).name_on_ringer || undefined,
              tableName: order.table_number || undefined
            };

            console.log('[Auto-Print] Receipt data prepared:', {
              orderNumber: receiptData.orderNumber,
              itemCount: receiptData.items.length,
              total: receiptData.total,
              deliveryNotes: receiptData.deliveryNotes,
              ringerName: receiptData.ringerName,
              orderDeliveryNotes: (order as any).delivery_notes,
              orderNameOnRinger: (order as any).name_on_ringer
            });

            // Get language and currency settings
            const settingsService = serviceRegistry.settingsService;
            const language = settingsService ? settingsService.getLanguage() : 'en';
            const currency = settingsService
              ? (settingsService.getSetting('restaurant', 'currency', '€') || settingsService.getSetting('terminal', 'currency', '€') || '€')
              : '€';

            // Get Greek render mode from printer config
            const greekRenderMode = receiptPrinter.greekRenderMode || 'text';

            // Generate receipt buffer
            const generator = new ReceiptGenerator({
              paperSize: receiptPrinter.paperSize || PaperSize.MM_80,
              storeName: 'The Small',
              currency: currency as string,
              language: language,
              greekRenderMode: greekRenderMode
            });

            const receiptBuffer = generator.generateReceipt(receiptData);
            console.log('[Auto-Print] Receipt buffer generated:', receiptBuffer.length, 'bytes');

            // Submit print job
            const jobResult = await printerManager.submitPrintJob({
              id: `receipt-${createdOrder.id}-${Date.now()}`,
              type: PrintJobType.RECEIPT,
              data: receiptData,
              priority: 2,
              createdAt: new Date()
            });

            console.log('[Auto-Print] Print job submitted:', jobResult);

            if (jobResult.success) {
              console.log('✅ [Auto-Print] Receipt printed successfully for order:', createdOrder.id);
            } else {
              console.error('❌ [Auto-Print] Print job failed:', jobResult.error);
            }
          } catch (printError) {
            console.error('❌ [Auto-Print] Error printing receipt:', printError);
          }
        }, 500); // Small delay to ensure order is fully saved
      }

      // Fire-and-forget: trigger immediate sync
      if (syncService && createdOrder) {
        setTimeout(() => {
          try {
            syncService.pushSingleOrderNow?.(createdOrder.id, 4000)?.catch(() => { });
          } catch (e) {
            console.warn('Immediate force sync scheduling failed:', e);
          }
        }, 0);
      }

      if (!createdOrder || !createdOrder.id) {
        console.error('❌ Created order is missing ID:', createdOrder);
        throw new IPCError('Order creation failed: missing order ID', 'DATABASE_ERROR');
      }

      // Return just the orderId - handleIPCError wrapper will add success: true and wrap in data
      return { orderId: createdOrder.id };
    }, 'order:create');
  });

  // Delete order
  ipcMain.handle('order:delete', async (_event, { orderId }) => {
    return handleIPCError(async () => {
      const dbManager = serviceRegistry.requireService('dbManager');
      const authService = serviceRegistry.get('authService');
      const staffAuthService = serviceRegistry.get('staffAuthService');
      const mainWindow = serviceRegistry.get('mainWindow');

      // Check permission
      const hasPermission =
        (staffAuthService && await staffAuthService.hasPermission('delete_order')) ||
        (authService && await authService.hasPermission('delete_order'));

      if (!hasPermission) {
        throw new IPCError('Insufficient permissions', 'PERMISSION_DENIED');
      }

      await dbManager.deleteOrder(orderId);

      // Update activity for session management
      authService?.updateActivity();

      // Notify renderer about the deletion
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('order-deleted', { orderId });
      }

      return { success: true };
    }, 'order:delete');
  });

  // Fetch order items from Supabase (fallback when local DB doesn't have items)
  ipcMain.handle('order:fetch-items-from-supabase', async (_event, { orderId }) => {
    return handleIPCError(async () => {
      const config = getSupabaseConfig('server');
      const supabase = createClient(config.url, config.serviceRoleKey || config.anonKey, {
        auth: { autoRefreshToken: false, persistSession: false }
      });

      // Fetch order items
      const { data: items, error: itemsError } = await supabase
        .from('order_items')
        .select('id, menu_item_id, quantity, unit_price, total_price, notes, customizations')
        .eq('order_id', orderId);

      if (itemsError) {
        console.warn('[order:fetch-items-from-supabase] Failed to fetch items:', itemsError);
        return [];
      }

      if (!items || items.length === 0) {
        return [];
      }

      // Fetch menu item names from subcategories table (order_items.menu_item_id references subcategories.id)
      const menuItemIds = items.map((item: any) => item.menu_item_id).filter(Boolean);
      let menuItemNames: Record<string, string> = {};

      if (menuItemIds.length > 0) {
        const { data: subcategories } = await supabase
          .from('subcategories')
          .select('id, name, name_en, name_el')
          .in('id', menuItemIds);

        if (subcategories) {
          menuItemNames = subcategories.reduce((acc: Record<string, string>, sc: any) => {
            // Prefer name, then English name, fall back to Greek
            acc[sc.id] = sc.name || sc.name_en || sc.name_el || 'Item';
            return acc;
          }, {});

          // Cache fetched subcategories for future offline use
          const dbManager = serviceRegistry.dbManager;
          if (dbManager?.bulkCacheSubcategories) {
            try {
              const subcategoriesToCache = subcategories.map((sc: any) => ({
                id: sc.id,
                name: sc.name || '',
                name_en: sc.name_en,
                name_el: sc.name_el
              }));
              dbManager.bulkCacheSubcategories(subcategoriesToCache);
              console.log(`[order:fetch-items-from-supabase] Cached ${subcategoriesToCache.length} subcategories`);
            } catch (cacheError) {
              console.warn('[order:fetch-items-from-supabase] Failed to cache subcategories:', cacheError);
            }
          }
        }
      }

      // Helper function to extract name from customizations
      const extractNameFromCustomizations = (customizations: any): string | null => {
        if (!customizations || typeof customizations !== 'object') return null;

        // Try to find ingredient name in customizations
        for (const key of Object.keys(customizations)) {
          const cust = customizations[key];
          if (cust?.ingredient?.name) {
            return cust.ingredient.name;
          }
          if (cust?.name) {
            return cust.name;
          }
        }
        return null;
      };

      // Transform items to match local format
      const transformedItems = items.map((item: any, index: number) => {
        // Try multiple sources for the item name
        let itemName: string = menuItemNames[item.menu_item_id] || '';

        if (!itemName) {
          // Try to extract from customizations
          const custName = extractNameFromCustomizations(item.customizations);
          if (custName) itemName = custName;
        }

        if (!itemName) {
          // Generate a generic name with price info
          const price = parseFloat(item.unit_price) || 0;
          itemName = `Item ${index + 1} (€${price.toFixed(2)})`;
        }

        return {
          id: item.id,
          menu_item_id: item.menu_item_id,
          name: itemName,
          quantity: item.quantity || 1,
          price: parseFloat(item.unit_price) || 0,
          unit_price: parseFloat(item.unit_price) || 0,
          total_price: parseFloat(item.total_price) || (parseFloat(item.unit_price) * (item.quantity || 1)),
          notes: item.notes,
          customizations: item.customizations
        };
      });

      console.log(`[order:fetch-items-from-supabase] Fetched ${transformedItems.length} items for order ${orderId}:`, transformedItems);
      return transformedItems;
    }, 'order:fetch-items-from-supabase');
  });

  // Update order items
  ipcMain.handle('order:update-items', async (_event, { orderId, items, orderNotes }) => {
    return handleIPCError(async () => {
      const dbManager = serviceRegistry.requireService('dbManager');
      const syncService = serviceRegistry.get('syncService');
      const authService = serviceRegistry.get('authService');
      const staffAuthService = serviceRegistry.get('staffAuthService');
      const settingsService = serviceRegistry.get('settingsService');
      const mainWindow = serviceRegistry.get('mainWindow');

      if (!orderId) {
        throw new IPCError('orderId is required', 'VALIDATION_ERROR');
      }

      if (!items || !Array.isArray(items)) {
        throw new IPCError('items array is required', 'VALIDATION_ERROR');
      }

      // Authorization check
      const hasPermission =
        (staffAuthService && await staffAuthService.hasPermission('edit_order')) ||
        (authService && await authService.hasPermission('edit_order'));
      const currentSession = staffAuthService?.getCurrentSession();
      const terminalApiKey = settingsService?.getSetting?.('terminal', 'pos_api_key', '') as string;
      const terminalTrusted = !!terminalApiKey && terminalApiKey.length > 0;

      if (!hasPermission && !currentSession && !terminalTrusted) {
        throw new IPCError('Insufficient permissions', 'PERMISSION_DENIED');
      }

      // Calculate new total from items
      const newTotalAmount = items.reduce((sum: number, item: any) => {
        const itemTotal = item.total_price || ((item.unit_price || item.price || 0) * (item.quantity || 1));
        return sum + itemTotal;
      }, 0);

      // Prepare update data
      const updateData: any = {
        items: items,
        total_amount: newTotalAmount,
        updated_at: new Date().toISOString(),
      };

      if (orderNotes) {
        updateData.special_instructions = orderNotes;
      }

      console.log('[order:update-items] Updating order:', { orderId, itemCount: items.length, newTotal: newTotalAmount });

      // Try to find the order - first by local ID, then by supabase_id
      let actualOrderId = orderId;
      console.log('[order:update-items] Looking up order by local ID:', orderId);
      let existingOrder = await withTimeout(
        dbManager.getOrderById(orderId),
        TIMING.DATABASE_QUERY_TIMEOUT,
        'Get order by ID',
      );
      console.log('[order:update-items] getOrderById result:', existingOrder ? `found (id=${existingOrder.id})` : 'not found');

      // If not found by local ID, try by supabase_id
      if (!existingOrder) {
        console.log('[order:update-items] Order not found by local ID, trying supabase_id:', orderId);
        existingOrder = await withTimeout(
          dbManager.getOrderBySupabaseId(orderId),
          TIMING.DATABASE_QUERY_TIMEOUT,
          'Get order by Supabase ID',
        );
        console.log('[order:update-items] getOrderBySupabaseId result:', existingOrder ? `found (id=${existingOrder.id})` : 'not found');
        if (existingOrder) {
          actualOrderId = existingOrder.id;
          console.log('[order:update-items] Found order by supabase_id, local ID:', actualOrderId);
        }
      }

      if (!existingOrder) {
        throw new IPCError(`Order not found: ${orderId}`, 'NOT_FOUND');
      }

      console.log('[order:update-items] Found order, actualOrderId:', actualOrderId, 'existingOrder.id:', existingOrder.id);

      // Update order in local database using the actual local ID
      const updatedOrder = await withTimeout(
        dbManager.updateOrder(actualOrderId, updateData),
        TIMING.DATABASE_QUERY_TIMEOUT,
        'Update order items',
      );

      console.log('[order:update-items] updateOrder result:', updatedOrder ? 'success' : 'null/undefined');

      if (!updatedOrder) {
        throw new IPCError(`Failed to update order: ${actualOrderId}`, 'DATABASE_ERROR');
      }

      console.log('[order:update-items] Order updated successfully:', actualOrderId);

      // Update activity for session management
      authService?.updateActivity();

      // Notify renderer about the updated order
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('order-updated', transformOrder(updatedOrder));
      }

      // Fire-and-forget: trigger immediate sync using the local order ID
      if (syncService) {
        setTimeout(() => {
          try {
            syncService.pushSingleOrderNow?.(actualOrderId, 4000)?.catch(() => { });
          } catch (e) {
            console.warn('[order:update-items] Immediate sync scheduling failed:', e);
          }
        }, 0);
      }

      return { success: true, orderId: actualOrderId };
    }, 'order:update-items');
  });
}
