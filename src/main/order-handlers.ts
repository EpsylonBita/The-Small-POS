import { BrowserWindow, ipcMain } from 'electron';
import { DatabaseManager } from './database';
import { SyncService } from './sync-service';
import { AuthService } from './auth-service';
import StaffAuthService from './staff-auth-service';
import { SettingsService } from './services/SettingsService';
import { ErrorHandler, withTimeout } from '../shared/utils/error-handler';
import { TIMING } from '../shared/constants';

const errorHandler = ErrorHandler.getInstance();

export interface OrderHandlerDeps {
  dbManager: DatabaseManager;
  syncService: SyncService;
  authService: AuthService;
  staffAuthService: StaffAuthService;
  settingsService: SettingsService;
  mainWindow: BrowserWindow | null;
}

/**
 * Get the admin API base URL for platform sync operations.
 * Prefers terminal-stored admin_url, then falls back to ADMIN_API_BASE_URL env var.
 * This ensures consistent URL resolution across all platform sync handlers.
 */
function getAdminApiBaseUrl(settingsService: SettingsService | null): string {
  // First preference: terminal-stored admin URL (set during connection string setup)
  const terminalAdminUrl = (settingsService?.getSetting?.('terminal', 'admin_url', '') as string) || '';
  if (terminalAdminUrl) return terminalAdminUrl;

  // Fallback: environment variable
  const envAdminUrl = (process.env['ADMIN_API_BASE_URL'] || '').trim();
  return envAdminUrl;
}

/**
 * Get terminal credentials for platform sync authentication.
 */
function getTerminalCredentials(settingsService: SettingsService | null): { terminalId: string; apiKey: string } {
  const terminalId = (settingsService?.getSetting?.('terminal', 'terminal_id', '') as string) || '';
  const terminalApiKey = (settingsService?.getSetting?.('terminal', 'pos_api_key', '') as string) || '';
  const envApiKey = (process.env['POS_API_KEY'] || process.env['POS_API_SHARED_KEY'] || '').trim();
  return { terminalId, apiKey: terminalApiKey || envApiKey };
}

export function registerOrderHandlers({
  dbManager,
  syncService,
  authService,
  staffAuthService,
  settingsService,
  mainWindow,
}: OrderHandlerDeps): void {
  // Remove existing handlers before registering to prevent double registration errors
  const orderHandlers = [
    'order:get-all',
    'order:get-by-id',
    'order:update-status',
    'order:update-type',
    'order:create',
    'order:delete',
    'payment:update-payment-status',
    'order:save-for-retry',
    'order:get-retry-queue',
    'order:process-retry-queue',
    'order:approve',
    'order:decline',
    'order:assign-driver',
    'order:notify-platform-ready',
  ];

  orderHandlers.forEach(handler => {
    ipcMain.removeHandler(handler);
  });

  // Order list and basic CRUD
  ipcMain.handle('order:get-all', async () => {
    try {
      const orders = await withTimeout(
        dbManager.getOrders(),
        TIMING.DATABASE_QUERY_TIMEOUT,
        'Get all orders',
      );
      const transformedOrders = orders.map((order: any) => ({
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
        // Platform integration fields (optional - present for external platform orders)
        platform: order.platform,
        externalPlatformOrderId: order.external_platform_order_id,
        platformCommissionPct: order.platform_commission_pct,
        netEarnings: order.net_earnings,
      }));
      return transformedOrders;
    } catch (error) {
      console.error('Get orders error:', error);
      const posError = errorHandler.handle(error);
      return {
        success: false,
        error: {
          code: posError.code,
          message: posError.message,
          userMessage: errorHandler.getUserMessage(posError),
        },
      };
    }
  });

  ipcMain.handle('order:get-by-id', async (_event, orderIdOrObject: string | { orderId: string }) => {
    try {
      console.log('📥 order:get-by-id called with:', orderIdOrObject, 'type:', typeof orderIdOrObject);

      const orderId =
        typeof orderIdOrObject === 'string'
          ? orderIdOrObject
          : orderIdOrObject && typeof orderIdOrObject === 'object'
            ? orderIdOrObject.orderId
            : undefined;

      if (!orderId) {
        console.error('Get order by ID error: orderId is required. Received:', orderIdOrObject);
        return null;
      }

      const order = await withTimeout(
        dbManager.getOrderById(orderId),
        TIMING.DATABASE_QUERY_TIMEOUT,
        'Get order by ID',
      );
      if (!order) return null;

      const transformedOrder = {
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
        // Platform integration fields (optional - present for external platform orders)
        platform: order.platform,
        externalPlatformOrderId: order.external_platform_order_id,
        platformCommissionPct: order.platform_commission_pct,
        netEarnings: order.net_earnings,
      };
      return transformedOrder;
    } catch (error) {
      console.error('Get order by ID error:', error);
      const posError = errorHandler.handle(error);
      return {
        success: false,
        error: {
          code: posError.code,
          message: posError.message,
          userMessage: errorHandler.getUserMessage(posError),
        },
      };
    }
  });

  ipcMain.handle('order:update-status', async (_event, { orderId, status }) => {
    console.log('[IPC order:update-status] 📨 Received', { orderId, status, timestamp: new Date().toISOString() });
    try {
      // Check permission
      const hasPermission = (await staffAuthService.hasPermission('update_order_status')) || (await authService.hasPermission('update_order_status'));
      // Allow trusted terminals (configured API key) or env key to perform local status updates
      const terminalApiKey = (settingsService?.getSetting?.('terminal', 'pos_api_key', '') as string) || '';
      const envApiKey = (process.env.POS_API_KEY || process.env.POS_API_SHARED_KEY || '').trim();
      const terminalTrusted = !!terminalApiKey || !!envApiKey;
      const desiredStatus = String(status || '').toLowerCase();
      // Coerce deprecated out_for_delivery to completed for consistency
      const coercedStatus = desiredStatus === 'out_for_delivery' ? 'completed' : desiredStatus;
      const allowByStatus = coercedStatus === 'cancelled' || coercedStatus === 'canceled';

      console.log('[IPC order:update-status] 🔐 Permission check', {
        hasPermission,
        terminalTrusted,
        allowByStatus,
        hasTerminalKey: !!terminalApiKey,
        hasEnvKey: !!envApiKey,
      });

      if (!hasPermission && !terminalTrusted && !allowByStatus) {
        console.warn('[IPC order:update-status] ❌ Permission denied');
        return { success: false, error: 'Insufficient permissions' };
      }

      console.log('[IPC order:update-status] 📞 Calling dbManager.updateOrderStatus', { orderId, status: coercedStatus });
      let success = await withTimeout(
        dbManager.updateOrderStatus(orderId, coercedStatus as any),
        TIMING.DATABASE_QUERY_TIMEOUT,
        'Update order status',
      );
      console.log('[IPC order:update-status] 📋 dbManager.updateOrderStatus result', { success, orderId, status: coercedStatus });

      // Fallback: if the renderer sent a Supabase ID, map to local ID and retry
      if (!success) {
        try {
          const localOrder = await withTimeout(
            dbManager.getOrderBySupabaseId(orderId),
            TIMING.DATABASE_QUERY_TIMEOUT,
            'Get order by supabase_id',
          );
          if (localOrder?.id) {
            success = await withTimeout(
              dbManager.updateOrderStatus(localOrder.id, coercedStatus as any),
              TIMING.DATABASE_QUERY_TIMEOUT,
              'Update order status (by supabase_id fallback)',
            );
          }
        } catch (e) {
          console.warn('Fallback update by supabase_id failed:', e);
        }
      }

      if (success) {
        // Update activity for session management
        authService.updateActivity();

        // If order was completed and is a delivery with a driver, attempt to record driver earning (duplicate-safe)
        try {
          if (coercedStatus === 'completed') {
            // Load order by local ID first, then fallback to Supabase ID
            let odr = await dbManager.getOrderById(orderId as any);
            if (!odr) {
              try {
                odr = await dbManager.getOrderBySupabaseId(orderId as any);
              } catch { }
            }
            if (odr && String(odr.order_type || '').toLowerCase() === 'delivery' && odr.driver_id) {
              const pmLower = String(odr.payment_method || '').toLowerCase();
              let paymentMethod: 'cash' | 'card' | 'mixed' = 'mixed';
              let cashCollected = 0;
              let cardAmount = 0;
              if (pmLower.includes('card')) {
                paymentMethod = 'card';
                cardAmount = Number(odr.total_amount || 0);
              } else if (pmLower.includes('cash')) {
                paymentMethod = 'cash';
                cashCollected = Number(odr.total_amount || 0);
              }
              // Find active driver shift for this driver
              const shiftRows = await dbManager.executeQuery(
                `SELECT id FROM staff_shifts WHERE staff_id = ? AND status = 'active' AND role_type = 'driver' ORDER BY login_time DESC LIMIT 1`,
                [odr.driver_id],
              );
              const shiftId = (shiftRows && shiftRows[0] && shiftRows[0].id) ? shiftRows[0].id : null;
              if (shiftId) {
                const res2 = dbManager.staff.recordDriverEarning({
                  driverId: odr.driver_id,
                  shiftId,
                  orderId: odr.id,
                  deliveryFee: 0,
                  tipAmount: Number(odr.tip_amount || 0),
                  paymentMethod,
                  cashCollected,
                  cardAmount,
                });
                if (!res2.success && (res2.error || '').toLowerCase().includes('earning already')) {
                  console.warn('[order:update-status] Driver earning already exists for order', { orderId: odr.id });
                } else if (!res2.success) {
                  console.warn('[order:update-status] Failed to record driver earning', { orderId: odr.id, error: res2.error });
                } else {
                  console.log('[order:update-status] ✅ Recorded driver earning', { orderId: odr.id, earningId: res2.earningId });
                }
              } else {
                console.warn('[order:update-status] No active driver shift found; skipping earning record', { orderId: odr.id, driverId: odr.driver_id });
              }
            }
          }
        } catch (e) {
          console.warn('[IPC order:update-status] Error while recording driver earning (ignored):', e);
        }

        console.log('[IPC order:update-status] ✅ Update successful, triggering fast sync', { orderId, status: coercedStatus });
        // Kick a fast local->remote sync so Supabase and Admin get the new status immediately
        try {
          await syncService.forceSyncFastLocal(3000);
          console.log('[IPC order:update-status] ✅ Fast sync completed', { orderId, status: coercedStatus });
        } catch (e) {
          console.warn('[IPC order:update-status] ⚠️ Fast local sync after status update failed:', e);
        }

        // Notify renderer about the update
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('order-status-updated', { orderId, status: coercedStatus });
        }
        console.log('[IPC order:update-status] 📤 Returning success', { orderId, status: coercedStatus });
        return { success: true };
      }

      console.warn('[IPC order:update-status] ❌ Update failed, returning error', { orderId, status });
      // Return a more descriptive error to hint at validation failures
      return { success: false, error: 'ORDER_UPDATE_FAILED: Check incomplete fields (Address/Table)' };
    } catch (error) {
      console.error('[IPC order:update-status] ❌ Exception:', error);
      const posError = errorHandler.handle(error);
      return {
        success: false,
        error: {
          code: posError.code,
          message: posError.message,
          userMessage: errorHandler.getUserMessage(posError),
        },
      };
    }
  });


  // Update order type (e.g., delivery -> pickup)
  console.log('[BOOT] Registering IPC handler: order:update-type');

  ipcMain.handle('order:update-type', async (_event, orderId: string, newType: string) => {
    console.log('[IPC order:update-type] Received', { orderId, newType, timestamp: new Date().toISOString() });
    try {
      // Authorization: align with assign-driver (more permissive: any of required perms OR active session OR trusted terminal)
      const hasPerm = (await staffAuthService.hasAnyPermission?.(['update_order_status', 'assign_driver', 'manage_delivery']))
        || (await staffAuthService.hasPermission?.('update_order_status'))
        || (await authService.hasPermission('update_order_status'));
      const currentSession = await staffAuthService.getCurrentSession();
      const terminalApiKey = (settingsService?.getSetting?.('terminal', 'pos_api_key', '') as string) || '';
      const envApiKey = (process.env.POS_API_KEY || process.env.POS_API_SHARED_KEY || '').trim();
      const terminalTrusted = !!terminalApiKey || !!envApiKey;

      if (!hasPerm && !currentSession && !terminalTrusted) {
        console.warn('[IPC order:update-type] Permission denied');
        return { success: false, error: 'Insufficient permissions' };
      }

      // Resolve order (accept either local id or supabase_id)
      let order = await withTimeout(dbManager.getOrderById(orderId), TIMING.DATABASE_QUERY_TIMEOUT, 'Get order by ID');
      if (!order) {
        try {
          const bySupa = await withTimeout(
            dbManager.getOrderBySupabaseId(orderId),
            TIMING.DATABASE_QUERY_TIMEOUT,
            'Get order by supabase_id',
          );
          if (bySupa) order = bySupa;
        } catch (e) {
          console.warn('[IPC order:update-type] Fallback by supabase_id failed:', e);
        }
      }
      if (!order) {
        return { success: false, error: 'ORDER_NOT_FOUND' };
      }

      // Normalize incoming type  DB and UI use the same values
      const desired = String(newType || '').toLowerCase();
      const dbType: 'dine-in' | 'pickup' | 'delivery' = desired === 'delivery'
        ? 'delivery'
        : desired === 'dine-in' || desired === 'dinein' || desired === 'dine_in'
          ? 'dine-in'
          : 'pickup'; // default treat pickup/takeaway as pickup in DB
      const uiType = dbType;

      // Apply update (also clear driver for non-delivery)
      const updates: any = { order_type: dbType, updated_at: new Date().toISOString() };
      if (dbType !== 'delivery') updates.driver_id = null;

      const updated = await withTimeout(
        dbManager.updateOrder(order.id, updates),
        TIMING.DATABASE_QUERY_TIMEOUT,
        'Update order type',
      );

      if (!updated) {
        console.warn('[IPC order:update-type] Update failed');
        return { success: false, error: 'ORDER_UPDATE_FAILED' };
      }

      // Update activity, sync fast
      authService.updateActivity();
      try {
        await syncService.forceSyncFastLocal(3000);
      } catch (e) {
        console.warn('[IPC order:update-type] Fast sync after type update failed:', e);
      }

      // Send realtime update payload to renderer (map to UI shape, using pickup for takeaway)
      try {
        const fresh = await withTimeout(
          dbManager.getOrderById(order.id),
          TIMING.DATABASE_QUERY_TIMEOUT,
          'Reload updated order',
        );
        if (fresh && mainWindow && !mainWindow.isDestroyed()) {
          const payload = {
            id: fresh.id,
            orderNumber: fresh.order_number || `ORD-${fresh.id.slice(-6)}`,
            status: fresh.status,
            items: fresh.items,
            totalAmount: fresh.total_amount,
            customerName: fresh.customer_name,
            customerPhone: fresh.customer_phone,
            customerEmail: fresh.customer_email,
            orderType: fresh.order_type || 'pickup',
            tableNumber: fresh.table_number,
            address: fresh.delivery_address,
            notes: fresh.special_instructions,
            createdAt: fresh.created_at,
            updatedAt: fresh.updated_at,
            estimatedTime: fresh.estimated_time,
            paymentStatus: fresh.payment_status,
            paymentMethod: fresh.payment_method,
            paymentTransactionId: fresh.payment_transaction_id,
            // Platform integration fields (optional - present for external platform orders)
            platform: fresh.platform,
            externalPlatformOrderId: fresh.external_platform_order_id,
            platformCommissionPct: fresh.platform_commission_pct,
            netEarnings: fresh.net_earnings,
          };
          mainWindow.webContents.send('order-realtime-update', payload);
        }
      } catch (e) {
        console.warn('[IPC order:update-type] Failed to emit realtime update:', e);
      }

      console.log('[IPC order:update-type] Update successful', { orderId: order.id, dbType, uiType });
      return { success: true, orderId: order.id, orderType: uiType };
    } catch (error) {
      console.error('[IPC order:update-type] Exception:', error);
      const posError = errorHandler.handle(error);
      return {
        success: false,
        error: {
          code: posError.code,
          message: posError.message,
          userMessage: errorHandler.getUserMessage(posError),
        },
      };
    }
  });


  ipcMain.handle('order:create', async (_event, { orderData }) => {
    try {
      // Validate order data
      if (!orderData.items || orderData.items.length === 0) {
        return { success: false, error: 'Order must contain at least one item' };
      }

      if (!orderData.totalAmount || orderData.totalAmount <= 0) {
        return { success: false, error: 'Order total must be greater than 0' };
      }

      // Validation for specific order types
      if (orderData.orderType === 'delivery' && !orderData.deliveryAddress) {
        console.warn('[IPC order:create] ❌ Validation failed: Delivery order missing address');
        return { success: false, error: 'Delivery orders must include a delivery address' };
      }
      if (orderData.orderType === 'dine-in' && !orderData.tableNumber) {
        console.warn('[IPC order:create] ❌ Validation failed: Dine-in order missing table number');
        return { success: false, error: 'Dine-in orders must include a table number' };
      }

      // Authorization: allow if any of the following are true
      // - staff is checked in (session exists)
      // - staff has create_order permission OR admin session has it
      // - terminal has a configured POS API key (trusted terminal)
      const hasPermission = (await staffAuthService.hasPermission('create_order')) || (await authService.hasPermission('create_order'));
      const currentSession = await staffAuthService.getCurrentSession();
      const terminalApiKey = settingsService?.getSetting?.('terminal', 'pos_api_key', '') as string;
      const terminalTrusted = !!terminalApiKey && terminalApiKey.length > 0;
      if (!hasPermission && !currentSession && !terminalTrusted) {
        return { success: false, error: 'Insufficient permissions' };
      }

      // Transform frontend data to match database schema
      const dbOrderData = {
        customer_name: orderData.customerName,
        items: orderData.items,
        total_amount: orderData.totalAmount || 0, // Fallback to 0 if null/undefined
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
      authService.updateActivity();

      // Notify renderer about the new order with full order data
      if (mainWindow && !mainWindow.isDestroyed() && createdOrder) {
        console.log('📤 Sending order-created event to renderer:', createdOrder.id);

        // Transform to match frontend format
        const createdOrderData = {
          id: createdOrder.id,
          orderNumber: createdOrder.order_number || `ORD-${createdOrder.id.slice(-6)}`,
          status: createdOrder.status,
          items: createdOrder.items,
          totalAmount: createdOrder.total_amount,
          customerName: createdOrder.customer_name,
          customerPhone: createdOrder.customer_phone,
          customerEmail: createdOrder.customer_email,
          orderType: createdOrder.order_type || 'takeaway',
          tableNumber: createdOrder.table_number,
          address: createdOrder.delivery_address,
          notes: createdOrder.special_instructions,
          createdAt: createdOrder.created_at,
          updatedAt: createdOrder.updated_at,
          estimatedTime: createdOrder.estimated_time,
          paymentStatus: createdOrder.payment_status,
          paymentMethod: createdOrder.payment_method,
          // Platform integration fields (optional - present for external platform orders)
          platform: createdOrder.platform,
          externalPlatformOrderId: createdOrder.external_platform_order_id,
          platformCommissionPct: createdOrder.platform_commission_pct,
          netEarnings: createdOrder.net_earnings,
        };

        mainWindow.webContents.send('order-created', createdOrderData);
      }

      // Fire-and-forget: trigger an immediate background sync so the order appears in Admin instantly
      try {
        // Do not await to avoid blocking the UI; allow up to 4s before we give up silently
        setTimeout(() => {
          try {
            // Ultra-fast: push only this new order directly to Supabase
            syncService?.pushSingleOrderNow(createdOrder.id, 4000).catch(() => {
              // ignore
            });
          } catch (e) {
            console.warn('Immediate force sync scheduling failed:', e);
          }
        }, 0);
      } catch (e) {
        console.warn('Immediate force sync setup error:', e);
      }

      // Ensure createdOrder has an id before returning
      if (!createdOrder || !createdOrder.id) {
        console.error('❌ Created order is missing ID:', createdOrder);
        throw new Error('Order creation failed: missing order ID');
      }

      return { success: true, orderId: createdOrder.id };
    } catch (error) {
      console.error('Create order error:', error);
      const posError = errorHandler.handle(error);
      return {
        success: false,
        error: {
          code: posError.code,
          message: posError.message,
          userMessage: errorHandler.getUserMessage(posError),
        },
      };
    }
  });


  ipcMain.handle('order:delete', async (_event, { orderId }) => {
    try {
      // Check permission
      const hasPermission = (await staffAuthService.hasPermission('delete_order')) || (await authService.hasPermission('delete_order'));
      if (!hasPermission) {
        return { success: false, error: 'Insufficient permissions' };
      }

      const success = await dbManager.deleteOrder(orderId);

      // Update activity for session management
      authService.updateActivity();

      // Notify renderer about the update
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('order-deleted', { orderId });
      }

      return { success: true };
    } catch (error) {
      console.error('Delete order error:', error);
      return { success: false, error: 'Failed to delete order' };
    }
  });

  ipcMain.handle('payment:update-payment-status', async (_event, { orderId, paymentStatus, paymentMethod, transactionId }) => {
    try {
      // Check permission
      const hasPermission = (await staffAuthService.hasPermission('update_order_status')) || (await authService.hasPermission('update_order_status'));
      if (!hasPermission) {
        return { success: false, error: 'Insufficient permissions' };
      }

      await dbManager.updateOrderPaymentStatus(orderId, paymentStatus, paymentMethod, transactionId);

      // Update activity for session management
      authService.updateActivity();

      // Notify renderer about the update
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('order-payment-updated', { orderId, paymentStatus, paymentMethod, transactionId });
      }

      return { success: true };
    } catch (error) {
      console.error('Update order payment status error:', error);
      return { success: false, error: 'Failed to update order payment status' };
    }
  });

  // Order retry queue handlers
  let retryQueue: any[] = [];

  ipcMain.handle('order:save-for-retry', async (_event, orderData) => {
    try {
      // Add timestamp and retry count
      const retryItem = {
        ...orderData,
        savedAt: new Date().toISOString(),
        retryCount: 0,
        id: `retry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      };

      retryQueue.push(retryItem);

      return { success: true, queueLength: retryQueue.length };
    } catch (error) {
      console.error('Failed to save order for retry:', error);
      return { success: false, error: 'Failed to save order for retry' };
    }
  });

  ipcMain.handle('order:get-retry-queue', async () => {
    try {
      return { success: true, queue: retryQueue };
    } catch (error) {
      console.error('Failed to get retry queue:', error);
      return { success: false, error: 'Failed to get retry queue', queue: [] };
    }
  });

  ipcMain.handle('order:process-retry-queue', async () => {
    try {
      const results: any[] = [];
      const failedItems: any[] = [];

      for (const item of retryQueue) {
        try {
          // Transform frontend data to match database schema
          const dbOrderData = {
            customer_name: item.customerName,
            items: item.items,
            total_amount: item.totalAmount || 0,
            status: item.status || 'pending',
            order_type: item.orderType,
            customer_phone: item.customerPhone,
            customer_email: item.customerEmail,
            table_number: item.tableNumber,
            delivery_address: item.deliveryAddress,
            special_instructions: item.notes,
            estimated_time: item.estimatedTime,
            payment_status: item.paymentStatus,
            payment_method: item.paymentMethod,
            payment_transaction_id: item.paymentTransactionId,
          };

          const createdOrder = await withTimeout(
            dbManager.insertOrder(dbOrderData),
            TIMING.ORDER_CREATE_TIMEOUT,
            'Retry order creation',
          );

          results.push({ id: item.id, success: true, orderId: createdOrder?.id });
        } catch (error) {
          item.retryCount = (item.retryCount || 0) + 1;

          // Keep in queue if retry count < 3
          if (item.retryCount < 3) {
            failedItems.push(item);
          }

          results.push({ id: item.id, success: false, error: (error as Error).message });
        }
      }

      // Update retry queue with failed items
      retryQueue = failedItems;

      return { success: true, results, remainingInQueue: retryQueue.length };
    } catch (error) {
      console.error('Failed to process retry queue:', error);
      return { success: false, error: 'Failed to process retry queue' };
    }
  });

  // Order approval workflow handlers
  ipcMain.handle('order:approve', async (_event, orderId: string, estimatedTime?: number) => {
    try {
      // Check permission
      const hasPermission = (await staffAuthService.hasPermission('update_order_status')) || (await authService.hasPermission('update_order_status'));
      if (!hasPermission) {
        return { success: false, error: 'Insufficient permissions' };
      }

      // Load order from local DB - ensure platform fields are explicitly included
      const order = await dbManager.getOrderById(orderId);
      if (!order) {
        return { success: false, error: 'Order not found' };
      }

      // Validate status transition
      if (order.status !== 'pending') {
        return { success: false, error: `Cannot approve order with status: ${order.status}` };
      }

      // Update local SQLite to confirmed
      const updateData: any = {
        status: 'confirmed',
        updated_at: new Date().toISOString(),
      };

      if (estimatedTime) {
        updateData.estimated_time = estimatedTime;
      }

      const success = await dbManager.executeQuery(
        `UPDATE orders SET status = ?, estimated_time = ?, updated_at = ? WHERE id = ?`,
        [updateData.status, updateData.estimated_time || order.estimated_time, updateData.updated_at, orderId],
      );

      if (!success) {
        return { success: false, error: 'Failed to update order' };
      }

      // Emit order-status-updated event
      if (mainWindow) {
        mainWindow.webContents.send('order-status-updated', {
          orderId,
          status: 'confirmed',
          estimatedTime,
        });
      }

      // Extract platform fields explicitly for sync decision
      // These fields should be present from getOrderById, but we guard against undefined
      const platformField = order.platform as string | undefined;
      const externalPlatformOrderIdField = order.external_platform_order_id as string | undefined;
      const orderNumber = order.order_number as string | undefined;

      // Trigger platform sync for external platform orders (fire-and-forget)
      if (externalPlatformOrderIdField && platformField) {
        setTimeout(() => {
          try {
            const adminApiBaseUrl = getAdminApiBaseUrl(settingsService);
            if (!adminApiBaseUrl) {
              console.warn('[order:approve] Admin API URL not configured, skipping platform sync');
              return;
            }

            const { terminalId, apiKey } = getTerminalCredentials(settingsService);

            console.log(`[order:approve] Triggering platform sync for ${platformField} order ${externalPlatformOrderIdField}`);

            fetch(`${adminApiBaseUrl}/api/platform-sync/notify`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-terminal-id': terminalId,
                'x-pos-api-key': apiKey,
              },
              body: JSON.stringify({
                action: 'approved',
                // posOrderId: internal database primary key for the POS order
                posOrderId: order.id,
                // orderNumber: business-facing order number for display/reference
                orderNumber: orderNumber || null,
                // externalPlatformOrderId: original order ID from external platform (e.g., Wolt order ID)
                externalPlatformOrderId: externalPlatformOrderIdField,
                platform: platformField,
                estimatedTime,
              }),
            })
              .then((res) => {
                if (res.ok) {
                  console.log(`[order:approve] Platform sync successful for ${platformField} order ${externalPlatformOrderIdField}`);
                } else {
                  console.warn(`[order:approve] Platform sync failed with status ${res.status}`);
                }
              })
              .catch((err) => {
                console.error('[order:approve] Platform sync error:', err);
              });
          } catch (e) {
            console.error('[order:approve] Failed to trigger platform sync:', e);
          }
        }, 0);
      }

      return { success: true, data: { orderId, status: 'confirmed', estimatedTime } };
    } catch (error) {
      console.error('Failed to approve order:', error);
      return { success: false, error: 'Failed to approve order' };
    }
  });

  ipcMain.handle('order:decline', async (_event, orderId: string, reason: string) => {
    try {
      // Check permission
      const hasPermission = (await staffAuthService.hasPermission('update_order_status')) || (await authService.hasPermission('update_order_status'));
      if (!hasPermission) {
        return { success: false, error: 'Insufficient permissions' };
      }

      // Load order from local DB - ensure platform fields are explicitly included
      const order = await dbManager.getOrderById(orderId);
      if (!order) {
        return { success: false, error: 'Order not found' };
      }

      // Validate status transition
      if (order.status !== 'pending') {
        return { success: false, error: `Cannot decline order with status: ${order.status}` };
      }

      // Update local SQLite to cancelled
      const success = await dbManager.executeQuery(
        `UPDATE orders SET status = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?`,
        ['cancelled', reason, new Date().toISOString(), orderId],
      );

      if (!success) {
        return { success: false, error: 'Failed to update order' };
      }

      // Emit order-status-updated event
      if (mainWindow) {
        mainWindow.webContents.send('order-status-updated', {
          orderId,
          status: 'cancelled',
          reason,
        });
      }

      // Extract platform fields explicitly for sync decision
      // These fields should be present from getOrderById, but we guard against undefined
      const platformField = order.platform as string | undefined;
      const externalPlatformOrderIdField = order.external_platform_order_id as string | undefined;
      const orderNumber = order.order_number as string | undefined;

      // Trigger platform sync for external platform orders (fire-and-forget)
      if (externalPlatformOrderIdField && platformField) {
        setTimeout(() => {
          try {
            const adminApiBaseUrl = getAdminApiBaseUrl(settingsService);
            if (!adminApiBaseUrl) {
              console.warn('[order:decline] Admin API URL not configured, skipping platform sync');
              return;
            }

            const { terminalId, apiKey } = getTerminalCredentials(settingsService);

            console.log(`[order:decline] Triggering platform sync for ${platformField} order ${externalPlatformOrderIdField}`);

            fetch(`${adminApiBaseUrl}/api/platform-sync/notify`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-terminal-id': terminalId,
                'x-pos-api-key': apiKey,
              },
              body: JSON.stringify({
                action: 'declined',
                // posOrderId: internal database primary key for the POS order
                posOrderId: order.id,
                // orderNumber: business-facing order number for display/reference
                orderNumber: orderNumber || null,
                // externalPlatformOrderId: original order ID from external platform (e.g., Wolt order ID)
                externalPlatformOrderId: externalPlatformOrderIdField,
                platform: platformField,
                reason,
              }),
            })
              .then((res) => {
                if (res.ok) {
                  console.log(`[order:decline] Platform sync successful for ${platformField} order ${externalPlatformOrderIdField}`);
                } else {
                  console.warn(`[order:decline] Platform sync failed with status ${res.status}`);
                }
              })
              .catch((err) => {
                console.error('[order:decline] Platform sync error:', err);
              });
          } catch (e) {
            console.error('[order:decline] Failed to trigger platform sync:', e);
          }
        }, 0);
      }

      return { success: true, data: { orderId, status: 'cancelled', reason } };
    } catch (error) {
      console.error('Failed to decline order:', error);
      return { success: false, error: 'Failed to decline order' };
    }
  });

  // Notify platform that order is ready for pickup
  ipcMain.handle('order:notify-platform-ready', async (_event, orderId: string) => {
    try {
      // Permission check: aligned with order:approve and order:decline handlers
      // Require hasPermission OR an active staff session. Unlike approve/decline,
      // we do not accept terminalTrusted alone since ready notifications are
      // typically triggered manually by staff, not automatically.
      const hasPermission = (await staffAuthService.hasPermission('update_order_status')) || (await authService.hasPermission('update_order_status'));
      const currentSession = await staffAuthService.getCurrentSession();

      if (!hasPermission && !currentSession) {
        return { success: false, error: 'Insufficient permissions - staff login required' };
      }

      // Load order from local DB
      let order = await dbManager.getOrderById(orderId);
      if (!order) {
        try {
          const bySupa = await dbManager.getOrderBySupabaseId(orderId);
          if (bySupa) order = bySupa;
        } catch { }
      }
      if (!order) {
        return { success: false, error: 'Order not found' };
      }

      // Extract platform fields
      // Note: order.platform is the canonical field
      const platformField = order.platform || null;
      const externalPlatformOrderIdField = order.external_platform_order_id || null;
      const orderNumber = order.order_number || `ORD-${order.id.slice(-6)}`;

      if (!platformField || !externalPlatformOrderIdField) {
        return { success: false, error: 'Not a platform order or missing external order ID' };
      }

      // Get admin API URL using standardized helper (consistent with approve/decline)
      const adminApiBaseUrl = getAdminApiBaseUrl(settingsService);
      if (!adminApiBaseUrl) {
        console.warn('[order:notify-platform-ready] Admin API URL not configured');
        return { success: false, error: 'Admin API URL not configured' };
      }

      const { terminalId, apiKey } = getTerminalCredentials(settingsService);

      console.log(`[order:notify-platform-ready] Notifying ${platformField} that order ${externalPlatformOrderIdField} is ready`);

      // Fire-and-forget call to platform sync API
      fetch(`${adminApiBaseUrl}/api/platform-sync/notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-terminal-id': terminalId,
          'x-pos-api-key': apiKey,
        },
        body: JSON.stringify({
          action: 'ready',
          platform: platformField,
          posOrderId: order.id,
          orderNumber,
          externalPlatformOrderId: externalPlatformOrderIdField,
        }),
      })
        .then((res) => {
          if (res.ok) {
            console.log(`[order:notify-platform-ready] Platform sync successful for ${platformField} order ${externalPlatformOrderIdField}`);
          } else {
            console.warn(`[order:notify-platform-ready] Platform sync failed with status ${res.status}`);
          }
        })
        .catch((err) => {
          console.error('[order:notify-platform-ready] Platform sync error:', err);
        });

      return { success: true, data: { orderId, platform: platformField, externalOrderId: externalPlatformOrderIdField } };
    } catch (error) {
      console.error('Failed to notify platform ready:', error);
      return { success: false, error: 'Failed to notify platform' };
    }
  });

  // Assign driver to order
  ipcMain.handle('order:assign-driver', async (_event, orderId: string, driverId: string, notes?: string) => {
    try {
      // Authorization: allow if any of the following are true
      // - staff has one of the required permissions
      // - a staff session exists (checked-in)
      // - trusted terminal (POS API key configured)
      const hasPerm = (await staffAuthService.hasAnyPermission?.(['update_order_status', 'assign_driver', 'manage_delivery']))
        || (await staffAuthService.hasPermission?.('update_order_status'))
        || (await authService.hasPermission('update_order_status'));
      const currentSession = await staffAuthService.getCurrentSession();
      const terminalApiKey = (settingsService?.getSetting?.('terminal', 'pos_api_key', '') as string) || '';
      const envApiKey = (process.env.POS_API_KEY || process.env.POS_API_SHARED_KEY || '').trim();
      const terminalTrusted = !!terminalApiKey || !!envApiKey;
      if (!hasPerm && !currentSession && !terminalTrusted) {
        return { success: false, error: 'Insufficient permissions' };
      }

      // Load order from local DB (accept either local ID or Supabase ID)
      let order = await dbManager.getOrderById(orderId);
      if (!order) {
        // Fallback: treat provided ID as Supabase ID and map to local order
        try {
          const bySupa = await dbManager.getOrderBySupabaseId(orderId);
          if (bySupa) {
            order = bySupa;
          }
        } catch { }
      }
      if (!order) {
        return { success: false, error: 'Order not found' };
      }

      // Validate driver exists and is active
      const driverRows = await dbManager.executeQuery(
        `SELECT * FROM staff_shifts WHERE staff_id = ? AND status = 'active' AND role_type = 'driver'`,
        [driverId],
      );

      if (!driverRows || driverRows.length === 0) {
        return { success: false, error: 'Driver not found or not active' };
      }

      const driverRow = driverRows[0] || {};
      const driverName = (driverRow as any).staff_name || `Driver ${String(driverId).slice(-6)}`;

      // Update order with driver_id
      const updated = await dbManager.updateOrder(order.id, {
        driver_id: driverId,
        updated_at: new Date().toISOString(),
      });

      if (!updated) {
        return { success: false, error: 'Failed to assign driver' };
      }

      // Set status to completed (final) per business rule: assigned to driver => completed
      try {
        await dbManager.updateOrderStatus(order.id, 'completed' as any);
      } catch (e) {
        console.warn('[order:assign-driver] Driver assigned but status update to completed failed', { orderId: order.id, driverId, error: e });
      }

      // Attempt to record driver earning for this delivery order (duplicate-safe)
      try {
        const pmLower = String(order.payment_method || '').toLowerCase();
        let paymentMethod: 'cash' | 'card' | 'mixed' = 'mixed';
        let cashCollected = 0;
        let cardAmount = 0;
        if (pmLower.includes('card')) {
          paymentMethod = 'card';
          cardAmount = Number(order.total_amount || 0);
        } else if (pmLower.includes('cash')) {
          paymentMethod = 'cash';
          cashCollected = Number(order.total_amount || 0);
        }

        const isDelivery = String(order.order_type || '').toLowerCase() === 'delivery';
        const shiftId = (driverRow as any).id;
        if (isDelivery && shiftId) {
          const res = dbManager.staff.recordDriverEarning({
            driverId,
            shiftId,
            orderId: order.id,
            deliveryFee: 0,
            tipAmount: Number(order.tip_amount || 0),
            paymentMethod,
            cashCollected,
            cardAmount,
          });
          if (!res.success && (res.error || '').toLowerCase().includes('earning already')) {
            console.warn('[order:assign-driver] Driver earning already exists for order', { orderId: order.id });
          } else if (!res.success) {
            console.warn('[order:assign-driver] Failed to record driver earning', { orderId: order.id, error: res.error });
          } else {
            console.log('[order:assign-driver] ✅ Recorded driver earning', { orderId: order.id, earningId: res.earningId });
          }
        }
      } catch (e) {
        console.warn('[order:assign-driver] Error while recording driver earning (ignored)', { orderId: order.id, error: e });
      }

      // Fast local sync to propagate changes
      try {
        await syncService.forceSyncFastLocal(3000);
      } catch (e) {
        console.warn('[order:assign-driver] Fast sync failed:', e);
      }

      // Emit order-status-updated event
      if (mainWindow) {
        mainWindow.webContents.send('order-status-updated', {
          orderId: order.id,
          driverId,
          driverName,
          status: 'completed',
          notes,
        });
      }

      return { success: true, driverName, data: { orderId: order.id, driverId, driverName } };
    } catch (error) {
      console.error('Failed to assign driver:', error);
      return { success: false, error: 'Failed to assign driver' };
    }
  });

}

