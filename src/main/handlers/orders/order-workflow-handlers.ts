/**
 * Order Workflow Handlers
 *
 * Handles order workflow operations like driver assignment and platform notifications.
 * Uses serviceRegistry for dependency access.
 */

import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';
import { ErrorHandler, withTimeout } from '../../../shared/utils/error-handler';
import { TIMING } from '../../../shared/constants';
import { getPrintServiceInstance } from '../print/print-handlers';
import { AssignOrderData } from '../../templates/assign-order-template';

const errorHandler = ErrorHandler.getInstance();

/**
 * Get the admin API base URL for platform sync operations.
 */
function getAdminApiBaseUrl(): string {
  const settingsService = serviceRegistry.get('settingsService');
  const terminalAdminUrl = (settingsService?.getSetting?.('terminal', 'admin_url', '') as string) || '';
  if (terminalAdminUrl) return terminalAdminUrl;
  const envAdminUrl = (process.env['ADMIN_API_BASE_URL'] || '').trim();
  return envAdminUrl;
}

/**
 * Get terminal credentials for platform sync authentication.
 */
function getTerminalCredentials(): { terminalId: string; apiKey: string } {
  const settingsService = serviceRegistry.get('settingsService');
  const terminalId = (settingsService?.getSetting?.('terminal', 'terminal_id', '') as string) || '';
  const terminalApiKey = (settingsService?.getSetting?.('terminal', 'pos_api_key', '') as string) || '';
  const envApiKey = (process.env['POS_API_KEY'] || process.env['POS_API_SHARED_KEY'] || '').trim();
  return { terminalId, apiKey: terminalApiKey || envApiKey };
}

export function registerOrderWorkflowHandlers(): void {
  // Remove existing handlers to prevent double registration
  const handlers = [
    'order:assign-driver',
    'order:notify-platform-ready',
    'payment:update-payment-status',
  ];
  handlers.forEach(handler => ipcMain.removeHandler(handler));

  // Assign driver to order
  ipcMain.handle('order:assign-driver', async (_event, orderId: string, driverId: string, notes?: string) => {
    try {
      const dbManager = serviceRegistry.requireService('dbManager');
      const syncService = serviceRegistry.get('syncService');
      const authService = serviceRegistry.get('authService');
      const staffAuthService = serviceRegistry.get('staffAuthService');
      const settingsService = serviceRegistry.get('settingsService');
      const mainWindow = serviceRegistry.get('mainWindow');

      // Authorization
      const hasPerm =
        (staffAuthService && await staffAuthService.hasAnyPermission?.(['update_order_status', 'assign_driver', 'manage_delivery'])) ||
        (staffAuthService && await staffAuthService.hasPermission?.('update_order_status')) ||
        (authService && await authService.hasPermission('update_order_status'));

      const currentSession = staffAuthService?.getCurrentSession();
      const terminalApiKey = (settingsService?.getSetting?.('terminal', 'pos_api_key', '') as string) || '';
      const envApiKey = (process.env.POS_API_KEY || process.env.POS_API_SHARED_KEY || '').trim();
      const terminalTrusted = !!terminalApiKey || !!envApiKey;

      if (!hasPerm && !currentSession && !terminalTrusted) {
        return { success: false, error: 'Insufficient permissions' };
      }

      // Load order (accept either local ID or Supabase ID)
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

      // Update order with driver_id and driver_name
      const updated = await dbManager.updateOrder(order.id, {
        driver_id: driverId,
        driver_name: driverName,
        updated_at: new Date().toISOString(),
      });

      if (!updated) {
        return { success: false, error: 'Failed to assign driver' };
      }

      // Set status to completed
      try {
        await dbManager.updateOrderStatus(order.id, 'completed' as any);
      } catch (e) {
        console.warn('[order:assign-driver] Driver assigned but status update to completed failed', { orderId: order.id, driverId, error: e });
      }

      // Record driver earning
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

      // Fast sync
      if (syncService) {
        try {
          await syncService.forceSyncFastLocal(3000);
        } catch (e) {
          console.warn('[order:assign-driver] Fast sync failed:', e);
        }
      }

      // Add driver_id and driver_name to sync queue for Supabase update
      try {
        const dbSvc = dbManager.getDatabaseService();
        dbSvc.sync.addToSyncQueue('orders', order.id, 'update', {
          driver_id: driverId,
          driver_name: driverName,
          status: 'completed',
          updated_at: new Date().toISOString()
        });
        console.log('[order:assign-driver] Added driver_id to sync queue for order:', order.id);
      } catch (e) {
        console.warn('[order:assign-driver] Failed to queue driver_id sync:', e);
      }

      // Print driver assignment receipt
      try {
        console.log('[order:assign-driver] 🖨️ Attempting to print driver assignment receipt...');
        const printService = getPrintServiceInstance();
        console.log('[order:assign-driver] PrintService instance:', printService ? 'Available' : 'NOT AVAILABLE');

        if (printService) {
          // Get order items from the order object (items are embedded in local orders)
          const orderItems = Array.isArray((order as any).items) ? (order as any).items : [];
          console.log('[order:assign-driver] Order items count:', orderItems.length);

          // Normalize payment method to expected type
          const normalizePaymentMethod = (pm: string | null | undefined): 'cash' | 'card' | 'mixed' | 'online' => {
            const pmLower = (pm || 'cash').toLowerCase();
            if (pmLower.includes('card')) return 'card';
            if (pmLower.includes('mix')) return 'mixed';
            if (pmLower.includes('online')) return 'online';
            return 'cash';
          };

          // Build receipt data
          // Debugging receipt data to ensure fields are present
          console.log('[order:assign-driver] 🔍 Extracting Address Information:');
          const rawCity = (order as any).delivery_city;
          const rawPostal = (order as any).delivery_postal_code;
          const rawFloor = (order as any).delivery_floor;
          const rawBell = (order as any).delivery_bell || (order as any).bell_name || (order as any).name_on_ringer;
          const rawDeliveryNotes = (order as any).delivery_notes || '';

          console.log(`[order:assign-driver] Raw DB fields -> city: "${rawCity}", postal: "${rawPostal}", floor: "${rawFloor}", bell: "${rawBell}", deliveryNotes: "${rawDeliveryNotes}"`);

          const assignOrderData: AssignOrderData = {
            orderId: order.id,
            orderNumber: order.order_number || `#${order.id.slice(-6)}`,
            driverId,
            driverName,
            customerName: order.customer_name || '',
            customerPhone: order.customer_phone || '',
            deliveryAddress: order.delivery_address || '',
            deliveryCity: rawCity || (order as any).city || '',
            deliveryPostalCode: rawPostal || (order as any).postal_code || '',
            deliveryFloor: rawFloor || (order as any).floor_number || '',
            deliveryBell: rawBell || '',
            deliveryNotes: rawDeliveryNotes,
            orderTotal: Number(order.total_amount || 0),
            paymentMethod: normalizePaymentMethod(order.payment_method),
            items: orderItems.map((item: any) => ({
              name: item.name || item.menu_item_name || 'Item',
              quantity: item.quantity || 1,
              price: item.unit_price || item.price || 0,
              customizations: item.customizations
            })),
            notes: notes || order.special_instructions || '',
            assignedAt: new Date()
          };

          console.log('[order:assign-driver] 🖨️ Calling printDriverAssignmentReceipt...');
          const terminalName = (settingsService?.getSetting?.('terminal', 'terminal_name', '') as string) || '';
          const printResult = await printService.printDriverAssignmentReceipt(assignOrderData, terminalName);
          if (printResult.success) {
            console.log('[order:assign-driver] ✅ Driver assignment receipt printed');
          } else {
            console.warn('[order:assign-driver] Failed to print driver receipt:', printResult.error);
          }
        } else {
          console.log('[order:assign-driver] PrintService not available, skipping receipt print');
        }
      } catch (e) {
        console.warn('[order:assign-driver] Error printing driver receipt (ignored):', e);
      }

      // Emit event
      if (mainWindow && !mainWindow.isDestroyed()) {
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

  // Notify platform that order is ready
  ipcMain.handle('order:notify-platform-ready', async (_event, orderId: string) => {
    try {
      const dbManager = serviceRegistry.requireService('dbManager');
      const authService = serviceRegistry.get('authService');
      const staffAuthService = serviceRegistry.get('staffAuthService');

      // Permission check
      const hasPermission =
        (staffAuthService && await staffAuthService.hasPermission('update_order_status')) ||
        (authService && await authService.hasPermission('update_order_status'));
      const currentSession = staffAuthService?.getCurrentSession();

      if (!hasPermission && !currentSession) {
        return { success: false, error: 'Insufficient permissions - staff login required' };
      }

      // Load order
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
      const platformField = order.platform || null;
      const externalPlatformOrderIdField = order.external_platform_order_id || null;
      const orderNumber = order.order_number || `ORD-${order.id.slice(-6)}`;

      if (!platformField || !externalPlatformOrderIdField) {
        return { success: false, error: 'Not a platform order or missing external order ID' };
      }

      // Get admin API URL
      const adminApiBaseUrl = getAdminApiBaseUrl();
      if (!adminApiBaseUrl) {
        console.warn('[order:notify-platform-ready] Admin API URL not configured');
        return { success: false, error: 'Admin API URL not configured' };
      }

      const { terminalId, apiKey } = getTerminalCredentials();

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

  // Update payment status
  ipcMain.handle('payment:update-payment-status', async (_event, { orderId, paymentStatus, paymentMethod, transactionId }) => {
    try {
      const dbManager = serviceRegistry.requireService('dbManager');
      const authService = serviceRegistry.get('authService');
      const staffAuthService = serviceRegistry.get('staffAuthService');
      const mainWindow = serviceRegistry.get('mainWindow');

      // Check permission
      const hasPermission =
        (staffAuthService && await staffAuthService.hasPermission('update_order_status')) ||
        (authService && await authService.hasPermission('update_order_status'));

      if (!hasPermission) {
        return { success: false, error: 'Insufficient permissions' };
      }

      await dbManager.updateOrderPaymentStatus(orderId, paymentStatus, paymentMethod, transactionId);

      // Update activity
      authService?.updateActivity();

      // Notify renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('order-payment-updated', { orderId, paymentStatus, paymentMethod, transactionId });
      }

      return { success: true };
    } catch (error) {
      console.error('Update order payment status error:', error);
      return { success: false, error: 'Failed to update order payment status' };
    }
  });
}
