/**
 * Order Status Handlers
 *
 * Handles order status updates, approvals, and declines.
 * Uses serviceRegistry for dependency access.
 */

import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';
import { ErrorHandler, withTimeout } from '../../../shared/utils/error-handler';
import { TIMING } from '../../../shared/constants';
import { processBundleInventoryDeduction } from '../inventory';

const errorHandler = ErrorHandler.getInstance();

/**
 * Get the admin API base URL for platform sync operations.
 */
function getAdminApiBaseUrl(): string {
  const settingsService = serviceRegistry.get('settingsService');
  const terminalAdminDashboardUrl = (settingsService?.getSetting?.('terminal', 'admin_dashboard_url', '') as string) || '';
  if (terminalAdminDashboardUrl) return terminalAdminDashboardUrl;
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
  return { terminalId, apiKey: terminalApiKey };
}

export function registerOrderStatusHandlers(): void {
  // Remove existing handlers to prevent double registration
  const handlers = [
    'order:update-status',
    'order:update-type',
    'order:approve',
    'order:decline',
  ];
  handlers.forEach(handler => ipcMain.removeHandler(handler));

  // Update order status
  ipcMain.handle('order:update-status', async (_event, { orderId, status, estimatedTime }) => {
    console.log('[IPC order:update-status] 📨 Received', { orderId, status, timestamp: new Date().toISOString() });

    try {
      const dbManager = serviceRegistry.requireService('dbManager');
      const syncService = serviceRegistry.get('syncService');
      const authService = serviceRegistry.get('authService');
      const staffAuthService = serviceRegistry.get('staffAuthService');
      const settingsService = serviceRegistry.get('settingsService');
      const mainWindow = serviceRegistry.get('mainWindow');

      // Check permission
      const hasPermission =
        (staffAuthService && await staffAuthService.hasPermission('update_order_status')) ||
        (authService && await authService.hasPermission('update_order_status'));

      const terminalApiKey = (settingsService?.getSetting?.('terminal', 'pos_api_key', '') as string) || '';
      const terminalTrusted = !!terminalApiKey;

      const desiredStatus = String(status || '').toLowerCase();
      // Map POS-local statuses to Supabase-compatible statuses
      let coercedStatus = desiredStatus;
      if (desiredStatus === 'out_for_delivery') coercedStatus = 'completed';
      if (desiredStatus === 'delivered') coercedStatus = 'completed';
      const normalizedEstimatedTime = Number.isFinite(Number(estimatedTime))
        ? Math.max(1, Math.round(Number(estimatedTime)))
        : undefined;
      const allowByStatus = coercedStatus === 'cancelled' || coercedStatus === 'canceled';

      console.log('[IPC order:update-status] 🔐 Permission check', {
        hasPermission,
        terminalTrusted,
        allowByStatus,
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
        // Persist estimated prep time when provided by renderer.
        if (normalizedEstimatedTime !== undefined) {
          try {
            let targetOrder = await dbManager.getOrderById(orderId as any);
            if (!targetOrder) {
              targetOrder = await dbManager.getOrderBySupabaseId(orderId as any);
            }
            if (targetOrder?.id) {
              await withTimeout(
                dbManager.executeQuery(
                  `UPDATE orders SET estimated_time = ?, updated_at = ? WHERE id = ?`,
                  [normalizedEstimatedTime, new Date().toISOString(), targetOrder.id]
                ),
                TIMING.DATABASE_QUERY_TIMEOUT,
                'Update order estimated time'
              );
            }
          } catch (etaError) {
            console.warn('[IPC order:update-status] Failed to persist estimated_time (continuing):', etaError);
          }
        }

        // Update activity for session management
        authService?.updateActivity();

        // Process bundle inventory deduction and record driver earning if order was completed
        try {
          if (coercedStatus === 'completed') {
            let odr = await dbManager.getOrderById(orderId as any);
            if (!odr) {
              try {
                odr = await dbManager.getOrderBySupabaseId(orderId as any);
              } catch { }
            }

            // Process bundle inventory deduction for completed orders
            if (odr) {
              try {
                let orderItems = odr.items;
                if (typeof orderItems === 'string') {
                  try {
                    orderItems = JSON.parse(orderItems);
                  } catch (e) {
                    orderItems = [];
                  }
                }
                if (Array.isArray(orderItems) && orderItems.length > 0) {
                  const deductionResult = await processBundleInventoryDeduction(odr.id, orderItems);
                  if (deductionResult.eventsEmitted > 0) {
                    console.log(`[order:update-status] ✅ Bundle inventory deduction processed: ${deductionResult.eventsEmitted} event(s)`);
                  }
                }
              } catch (bundleError) {
                console.warn('[order:update-status] Bundle inventory deduction error (ignored):', bundleError);
              }
            }

            // Record driver earning if order is a delivery
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

              const shiftRows = await dbManager.executeQuery(
                `SELECT id FROM staff_shifts WHERE staff_id = ? AND status = 'active' AND role_type = 'driver' ORDER BY check_in_time DESC LIMIT 1`,
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
              }
            }
          }
        } catch (e) {
          console.warn('[IPC order:update-status] Error while recording driver earning (ignored):', e);
        }

        console.log('[IPC order:update-status] ✅ Update successful, triggering immediate order sync', { orderId, status: coercedStatus });

        // Immediate sync of this specific order (bypasses queue for guaranteed status update)
        if (syncService) {
          try {
            await syncService.pushSingleOrderNow(orderId, 5000);
            console.log('[IPC order:update-status] ✅ Order sync completed', { orderId, status: coercedStatus });
          } catch (e) {
            console.warn('[IPC order:update-status] ⚠️ Order sync after status update failed:', e);
          }
        }

        // Notify renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('order-status-updated', {
            orderId,
            status: coercedStatus,
            estimatedTime: normalizedEstimatedTime,
          });
        }

        console.log('[IPC order:update-status] 📤 Returning success', { orderId, status: coercedStatus });
        return { success: true };
      }

      console.warn('[IPC order:update-status] ❌ Update failed, returning error', { orderId, status });
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

  // Update order type
  ipcMain.handle('order:update-type', async (_event, orderId: string, newType: string) => {
    console.log('[IPC order:update-type] Received', { orderId, newType, timestamp: new Date().toISOString() });

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
      const terminalTrusted = !!terminalApiKey;

      if (!hasPerm && !currentSession && !terminalTrusted) {
        console.warn('[IPC order:update-type] Permission denied');
        return { success: false, error: 'Insufficient permissions' };
      }

      // Resolve order
      let order = await withTimeout(dbManager.getOrderById(orderId), TIMING.DATABASE_QUERY_TIMEOUT, 'Get order by ID');
      if (!order) {
        try {
          const bySupa = await withTimeout(dbManager.getOrderBySupabaseId(orderId), TIMING.DATABASE_QUERY_TIMEOUT, 'Get order by supabase_id');
          if (bySupa) order = bySupa;
        } catch (e) {
          console.warn('[IPC order:update-type] Fallback by supabase_id failed:', e);
        }
      }
      if (!order) {
        return { success: false, error: 'ORDER_NOT_FOUND' };
      }

      // Normalize type
      const desired = String(newType || '').toLowerCase();
      const dbType: 'dine-in' | 'pickup' | 'delivery' = desired === 'delivery'
        ? 'delivery'
        : desired === 'dine-in' || desired === 'dinein' || desired === 'dine_in'
          ? 'dine-in'
          : 'pickup';
      const uiType = dbType;

      // Apply update
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
      authService?.updateActivity();
      if (syncService) {
        try {
          await syncService.forceSyncFastLocal(3000);
        } catch (e) {
          console.warn('[IPC order:update-type] Fast sync after type update failed:', e);
        }
      }

      // Send realtime update to renderer
      try {
        const fresh = await withTimeout(dbManager.getOrderById(order.id), TIMING.DATABASE_QUERY_TIMEOUT, 'Reload updated order');
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
            plugin: fresh.plugin || fresh.platform,
            externalPluginOrderId: fresh.external_plugin_order_id || fresh.external_platform_order_id,
            pluginCommissionPct: fresh.plugin_commission_pct ?? fresh.platform_commission_pct,
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

  // Approve order
  ipcMain.handle('order:approve', async (_event, orderId: string, estimatedTime?: number) => {
    try {
      const dbManager = serviceRegistry.requireService('dbManager');
      const authService = serviceRegistry.get('authService');
      const staffAuthService = serviceRegistry.get('staffAuthService');
      const settingsService = serviceRegistry.get('settingsService');
      const mainWindow = serviceRegistry.get('mainWindow');

      // Check permission
      const hasPermission =
        (staffAuthService && await staffAuthService.hasPermission('update_order_status')) ||
        (authService && await authService.hasPermission('update_order_status'));

      if (!hasPermission) {
        return { success: false, error: 'Insufficient permissions' };
      }

      // Load order
      const order = await dbManager.getOrderById(orderId);
      if (!order) {
        return { success: false, error: 'Order not found' };
      }

      // Validate status transition
      if (order.status !== 'pending') {
        return { success: false, error: `Cannot approve order with status: ${order.status}` };
      }

      // Update to confirmed
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

      // Emit event
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('order-status-updated', {
          orderId,
          status: 'confirmed',
          estimatedTime,
        });
      }

      // Platform sync for external orders
      const pluginField = (order.plugin || order.platform) as string | undefined;
      const externalPluginOrderIdField = (order.external_plugin_order_id || order.external_platform_order_id) as string | undefined;
      const orderNumber = order.order_number as string | undefined;

      if (externalPluginOrderIdField && pluginField) {
        setTimeout(() => {
          try {
            const adminApiBaseUrl = getAdminApiBaseUrl();
            if (!adminApiBaseUrl) {
              console.warn('[order:approve] Admin API URL not configured, skipping platform sync');
              return;
            }

            const { terminalId, apiKey } = getTerminalCredentials();

            console.log(`[order:approve] Triggering plugin sync for ${pluginField} order ${externalPluginOrderIdField}`);

            fetch(`${adminApiBaseUrl}/api/plugin-sync/notify`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-terminal-id': terminalId,
                'x-pos-api-key': apiKey,
              },
              body: JSON.stringify({
                action: 'approved',
                posOrderId: order.id,
                orderNumber: orderNumber || null,
                externalPluginOrderId: externalPluginOrderIdField,
                plugin: pluginField,
                estimatedTime,
              }),
            })
              .then((res) => {
                if (res.ok) {
                  console.log(`[order:approve] Plugin sync successful for ${pluginField} order ${externalPluginOrderIdField}`);
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

  // Decline order
  ipcMain.handle('order:decline', async (_event, orderId: string, reason: string) => {
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

      // Load order
      const order = await dbManager.getOrderById(orderId);
      if (!order) {
        return { success: false, error: 'Order not found' };
      }

      // Validate status transition
      if (order.status !== 'pending') {
        return { success: false, error: `Cannot decline order with status: ${order.status}` };
      }

      // Update to cancelled
      const success = await dbManager.executeQuery(
        `UPDATE orders SET status = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?`,
        ['cancelled', reason, new Date().toISOString(), orderId],
      );

      if (!success) {
        return { success: false, error: 'Failed to update order' };
      }

      // Emit event
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('order-status-updated', {
          orderId,
          status: 'cancelled',
          reason,
        });
      }

      // Platform sync for external orders
      const pluginField = (order.plugin || order.platform) as string | undefined;
      const externalPluginOrderIdField = (order.external_plugin_order_id || order.external_platform_order_id) as string | undefined;
      const orderNumber = order.order_number as string | undefined;

      if (externalPluginOrderIdField && pluginField) {
        setTimeout(() => {
          try {
            const adminApiBaseUrl = getAdminApiBaseUrl();
            if (!adminApiBaseUrl) {
              console.warn('[order:decline] Admin API URL not configured, skipping platform sync');
              return;
            }

            const { terminalId, apiKey } = getTerminalCredentials();

            console.log(`[order:decline] Triggering plugin sync for ${pluginField} order ${externalPluginOrderIdField}`);

            fetch(`${adminApiBaseUrl}/api/plugin-sync/notify`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-terminal-id': terminalId,
                'x-pos-api-key': apiKey,
              },
              body: JSON.stringify({
                action: 'declined',
                posOrderId: order.id,
                orderNumber: orderNumber || null,
                externalPluginOrderId: externalPluginOrderIdField,
                plugin: pluginField,
                reason,
              }),
            })
              .then((res) => {
                if (res.ok) {
                  console.log(`[order:decline] Plugin sync successful for ${pluginField} order ${externalPluginOrderIdField}`);
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
}
