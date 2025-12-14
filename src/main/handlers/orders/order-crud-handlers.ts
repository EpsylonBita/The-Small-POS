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
 * Transform database order to frontend format
 */
function transformOrder(order: any) {
  return {
    id: order.id,
    orderNumber: order.order_number || `ORD-${order.id.slice(-6)}`,
    status: order.status,
    items: order.items,
    totalAmount: order.total_amount,
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    customerEmail: order.customer_email,
    orderType: order.order_type || 'takeaway',
    tableNumber: order.table_number,
    address: order.delivery_address,
    notes: order.special_instructions,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    estimatedTime: order.estimated_time,
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method,
    paymentTransactionId: order.payment_transaction_id,
    // Platform integration fields
    platform: order.platform,
    externalPlatformOrderId: order.external_platform_order_id,
    platformCommissionPct: order.platform_commission_pct,
    netEarnings: order.net_earnings,
  };
}

export function registerOrderCrudHandlers(): void {
  // Remove existing handlers to prevent double registration
  const handlers = [
    'order:get-all',
    'order:get-by-id',
    'order:create',
    'order:delete',
    'order:fetch-items-from-supabase',
  ];
  handlers.forEach(handler => ipcMain.removeHandler(handler));

  // Get all orders - filtered to only show orders from current business shift
  // Orders from before the last Z-Report are excluded to ensure fresh start
  // Uses timestamp (not date) because business days don't align with calendar days
  // e.g., a store closing at 5am - orders from 00:00-05:00 belong to previous business day
  ipcMain.handle('order:get-all', async () => {
    return handleIPCError(async () => {
      const dbManager = serviceRegistry.requireService('dbManager');
      const settingsService = dbManager.getDatabaseService().settings;

      // Get the last Z-Report timestamp to filter out old orders
      // Orders created before this timestamp should not appear in the POS
      const lastZReportTimestamp = settingsService?.getSetting<string>('system', 'last_z_report_timestamp') || null;

      console.log(`[order:get-all] Z-Report timestamp from settings: ${lastZReportTimestamp || 'NOT SET'}`);

      // Filter orders created AFTER the last Z-Report timestamp
      // If no Z-Report recorded, show all orders (first run scenario)
      const orders = await withTimeout(
        dbManager.getOrders({ afterTimestamp: lastZReportTimestamp || undefined }),
        TIMING.DATABASE_QUERY_TIMEOUT,
        'Get all orders',
      );

      if (lastZReportTimestamp) {
        console.log(`[order:get-all] Returning ${orders.length} orders created after Z-Report at ${lastZReportTimestamp}`);
        // Debug: log order timestamps to verify filtering
        if (orders.length > 0) {
          orders.forEach((o: any) => {
            console.log(`[order:get-all] Order ${o.id?.slice(-6)} created_at: ${o.created_at}, status: ${o.status}`);
          });
        }
      } else {
        console.log(`[order:get-all] No Z-Report found, returning all ${orders.length} orders`);
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

          if (orderData.customerId) {
            try {
              console.log('[IPC order:create] Attempting customer address fallback for customerId:', orderData.customerId);
              const customer = await dbManager.getCustomerById?.(orderData.customerId);

              if (customer) {
                // Check customer.addresses array first
                if (Array.isArray(customer.addresses) && customer.addresses.length > 0) {
                  const addr = customer.addresses.find((a: any) => a.is_default) || customer.addresses[0];
                  const parts: string[] = [];
                  if (addr.street_address || addr.street) parts.push(addr.street_address || addr.street);
                  if (addr.city) parts.push(addr.city);
                  if (addr.postal_code) parts.push(addr.postal_code);
                  fallbackAddress = parts.filter(Boolean).join(', ');
                  console.log('[IPC order:create] Fallback address from customer.addresses:', fallbackAddress);
                }
                // Check legacy customer.address field
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
                  }
                  console.log('[IPC order:create] Fallback address from customer.address:', fallbackAddress);
                }
              }
            } catch (err) {
              console.error('[IPC order:create] Failed to fetch customer for address fallback:', err);
            }
          }

          if (fallbackAddress) {
            orderData.deliveryAddress = fallbackAddress;
            console.log('[IPC order:create] ✓ Using fallback delivery address:', fallbackAddress);
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
      if (orderData.items && orderData.items.length > 0) {
        orderData.items.forEach((item: any, idx: number) => {
          console.log(`[order:create] Item ${idx}: ${item.name}, customizations count:`, item.customizations?.length || 0);
        });
      }

      // Transform frontend data to database schema
      const dbOrderData = {
        customer_name: orderData.customerName,
        items: orderData.items,
        total_amount: orderData.totalAmount || 0,
        status: orderData.status,
        order_type: orderData.orderType,
        customer_phone: orderData.customerPhone,
        customer_email: orderData.customerEmail,
        table_number: orderData.tableNumber,
        delivery_address: orderData.deliveryAddress,
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
}
