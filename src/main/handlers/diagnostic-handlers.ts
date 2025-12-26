/**
 * Diagnostic Handlers
 *
 * Provides diagnostic tools for troubleshooting driver checkout and order issues.
 */

import { ipcMain } from 'electron';
import { serviceRegistry } from '../service-registry';

export function registerDiagnosticHandlers(): void {
  const handlers = [
    'diagnostic:check-delivered-orders',
    'diagnostic:fix-missing-driver-ids',
    'diagnostic:force-sync-orders',
    'diagnostic:mark-earnings-synced',
    'diagnostic:mark-all-unsynced-earnings',
    'diagnostic:get-sync-queue-details',
    'diagnostic:retry-driver-earnings-sync',
  ];
  handlers.forEach(handler => ipcMain.removeHandler(handler));

  // Check delivered orders for missing driver_id
  ipcMain.handle('diagnostic:check-delivered-orders', async () => {
    try {
      const dbManager = serviceRegistry.requireService('dbManager');

      // Get all delivered/completed delivery orders
      const allDeliveredQuery = `
        SELECT id, order_number, status, order_type, driver_id, staff_shift_id, created_at, updated_at
        FROM orders
        WHERE LOWER(COALESCE(order_type, '')) = 'delivery'
          AND LOWER(COALESCE(status, '')) IN ('delivered', 'completed')
        ORDER BY created_at DESC
      `;
      const allDelivered = await dbManager.executeQuery(allDeliveredQuery);

      // Separate into with/without driver_id
      const withDriver = allDelivered.filter((o: any) => o.driver_id);
      const withoutDriver = allDelivered.filter((o: any) => !o.driver_id);

      // Check driver earnings
      const earningsQuery = `
        SELECT COUNT(*) as count FROM driver_earnings
      `;
      const earningsResult = await dbManager.executeQuery(earningsQuery);
      const earningsCount = earningsResult[0]?.count || 0;

      // Check active driver shifts
      const shiftsQuery = `
        SELECT id, staff_id, role_type, status, check_in_time, check_out_time
        FROM staff_shifts
        WHERE role_type = 'driver'
        ORDER BY check_in_time DESC
        LIMIT 5
      `;
      const driverShifts = await dbManager.executeQuery(shiftsQuery);

      return {
        success: true,
        data: {
          total: allDelivered.length,
          withDriver: withDriver.length,
          withoutDriver: withoutDriver.length,
          earningsCount,
          ordersWithoutDriver: withoutDriver.map((o: any) => ({
            id: o.id,
            orderNumber: o.order_number,
            status: o.status,
            createdAt: o.created_at,
          })),
          recentDriverShifts: driverShifts,
        }
      };
    } catch (error) {
      console.error('Failed to check delivered orders:', error);
      return { success: false, error: String(error) };
    }
  });

  // Force sync specific orders by their IDs
  ipcMain.handle('diagnostic:force-sync-orders', async (_event, orderIds: string[]) => {
    try {
      const dbManager = serviceRegistry.requireService('dbManager');
      const syncService = serviceRegistry.get('syncService');

      if (!Array.isArray(orderIds) || orderIds.length === 0) {
        return { success: false, error: 'No order IDs provided' };
      }

      let syncedCount = 0;
      let errorCount = 0;
      const errors: string[] = [];

      for (const orderId of orderIds) {
        try {
          // Get the order from local DB
          const order = await dbManager.getOrderById(orderId);

          if (!order) {
            errors.push(`Order ${orderId} not found in local DB`);
            errorCount++;
            continue;
          }

          // Add to sync queue
          const dbService = dbManager.getDatabaseService();
          dbService.sync.addToSyncQueue('orders', orderId, 'insert', order as any);
          syncedCount++;

          console.log(`[diagnostic:force-sync-orders] Added order ${orderId} to sync queue`);
        } catch (err) {
          errors.push(`Error syncing order ${orderId}: ${err}`);
          errorCount++;
        }
      }

      // Trigger sync
      if (syncService && syncedCount > 0) {
        syncService.startSync();
      }

      return {
        success: syncedCount > 0,
        syncedCount,
        errorCount,
        errors: errors.length > 0 ? errors : undefined,
        message: `Added ${syncedCount} orders to sync queue, ${errorCount} errors`
      };
    } catch (error) {
      console.error('Failed to force sync orders:', error);
      return { success: false, error: String(error) };
    }
  });

  // Mark driver earnings as synced (to bypass Z-Report blocking)
  ipcMain.handle('diagnostic:mark-earnings-synced', async (_event, earningIds: string[]) => {
    try {
      const dbManager = serviceRegistry.requireService('dbManager');

      if (!Array.isArray(earningIds) || earningIds.length === 0) {
        return { success: false, error: 'No earning IDs provided' };
      }

      let markedCount = 0;
      const errors: string[] = [];

      for (const earningId of earningIds) {
        try {
          // Mark as synced by setting supabase_id to the local id
          // This prevents it from being counted as unsynced
          const result = await dbManager.executeQuery(
            'UPDATE driver_earnings SET supabase_id = id WHERE id = ? AND (supabase_id IS NULL OR supabase_id = \'\')',
            [earningId]
          );

          if (result && result.length > 0) {
            markedCount++;
            console.log(`[diagnostic:mark-earnings-synced] Marked driver earning ${earningId} as synced`);
          }
        } catch (err) {
          errors.push(`Error marking earning ${earningId}: ${err}`);
        }
      }

      return {
        success: markedCount > 0,
        markedCount,
        errors: errors.length > 0 ? errors : undefined,
        message: `Marked ${markedCount} driver earnings as synced`
      };
    } catch (error) {
      console.error('Failed to mark earnings as synced:', error);
      return { success: false, error: String(error) };
    }
  });

  // Mark ALL unsynced driver earnings as synced (to bypass Z-Report blocking)
  ipcMain.handle('diagnostic:mark-all-unsynced-earnings', async () => {
    try {
      const dbManager = serviceRegistry.requireService('dbManager');

      // Find all unsynced driver earnings
      const unsyncedEarnings = await dbManager.executeQuery(
        'SELECT id FROM driver_earnings WHERE supabase_id IS NULL OR supabase_id = \'\'',
        []
      );

      if (!unsyncedEarnings || unsyncedEarnings.length === 0) {
        return { success: true, markedCount: 0, message: 'No unsynced earnings found' };
      }

      console.log(`[diagnostic:mark-all-unsynced-earnings] Found ${unsyncedEarnings.length} unsynced earnings`);

      // Mark all as synced
      const result = await dbManager.executeQuery(
        'UPDATE driver_earnings SET supabase_id = id WHERE supabase_id IS NULL OR supabase_id = \'\'',
        []
      );

      console.log(`[diagnostic:mark-all-unsynced-earnings] Update result:`, result);

      // Verify how many were updated
      const stillUnsynced = await dbManager.executeQuery(
        'SELECT id FROM driver_earnings WHERE supabase_id IS NULL OR supabase_id = \'\'',
        []
      );

      const markedCount = unsyncedEarnings.length - stillUnsynced.length;

      return {
        success: true,
        markedCount,
        totalFound: unsyncedEarnings.length,
        stillUnsynced: stillUnsynced.length,
        message: `Marked ${markedCount} of ${unsyncedEarnings.length} driver earnings as synced`,
        unsyncedIds: stillUnsynced.map((e: any) => e.id),
      };
    } catch (error) {
      console.error('Failed to mark all unsynced earnings:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get sync queue details for driver earnings
  ipcMain.handle('diagnostic:get-sync-queue-details', async () => {
    try {
      const dbManager = serviceRegistry.requireService('dbManager');
      const dbService = dbManager.getDatabaseService();

      // Get all unsynced driver earnings
      const unsyncedEarnings = await dbManager.executeQuery(
        `SELECT id, driver_id, staff_shift_id, order_id, supabase_id, created_at
         FROM driver_earnings
         WHERE supabase_id IS NULL OR supabase_id = ''
         ORDER BY created_at DESC`,
        []
      );

      // Get sync queue items for driver_earnings
      const syncQueueItems = await dbManager.executeQuery(
        `SELECT id, record_id, operation, attempts, error_message, next_retry_at, created_at
         FROM sync_queue
         WHERE table_name = 'driver_earnings'
         ORDER BY created_at DESC`,
        []
      );

      // Get orders for these driver earnings to check their sync status
      const orderIds = unsyncedEarnings.map((e: any) => e.order_id).filter(Boolean);
      let ordersStatus: any[] = [];
      if (orderIds.length > 0) {
        const placeholders = orderIds.map(() => '?').join(',');
        ordersStatus = await dbManager.executeQuery(
          `SELECT id, order_number, supabase_id, status FROM orders WHERE id IN (${placeholders})`,
          orderIds
        );
      }

      // Get staff shifts for these earnings
      const shiftIds = unsyncedEarnings.map((e: any) => e.staff_shift_id).filter(Boolean);
      let shiftsStatus: any[] = [];
      if (shiftIds.length > 0) {
        const placeholders = shiftIds.map(() => '?').join(',');
        shiftsStatus = await dbManager.executeQuery(
          `SELECT id, staff_id, role_type, supabase_id, status FROM staff_shifts WHERE id IN (${placeholders})`,
          shiftIds
        );
      }

      // Get financial sync stats
      const financialStats = dbService.sync.getFinancialSyncStats();

      return {
        success: true,
        data: {
          unsyncedEarnings,
          syncQueueItems,
          ordersStatus,
          shiftsStatus,
          financialStats,
          summary: {
            totalUnsyncedEarnings: unsyncedEarnings.length,
            totalSyncQueueItems: syncQueueItems.length,
            ordersWithSupabaseId: ordersStatus.filter((o: any) => o.supabase_id).length,
            ordersWithoutSupabaseId: ordersStatus.filter((o: any) => !o.supabase_id).length,
            shiftsWithSupabaseId: shiftsStatus.filter((s: any) => s.supabase_id).length,
            shiftsWithoutSupabaseId: shiftsStatus.filter((s: any) => !s.supabase_id).length,
          }
        }
      };
    } catch (error) {
      console.error('Failed to get sync queue details:', error);
      return { success: false, error: String(error) };
    }
  });

  // Retry all failed driver earnings sync
  ipcMain.handle('diagnostic:retry-driver-earnings-sync', async () => {
    try {
      const dbManager = serviceRegistry.requireService('dbManager');
      const dbService = dbManager.getDatabaseService();
      const syncService = serviceRegistry.get('syncService');

      // Retry all failed financial syncs
      dbService.sync.retryAllFailedFinancialSyncs();

      // Re-queue orphaned financial records
      const requeued = dbService.sync.requeueOrphanedFinancialRecords();

      // Trigger sync
      if (syncService) {
        await syncService.startSync();
      }

      return {
        success: true,
        requeued,
        message: `Re-queued ${requeued} orphaned financial records and triggered sync`
      };
    } catch (error) {
      console.error('Failed to retry driver earnings sync:', error);
      return { success: false, error: String(error) };
    }
  });

  // Fix missing driver_ids for delivered orders
  ipcMain.handle('diagnostic:fix-missing-driver-ids', async (_event, driverId: string) => {
    try {
      const dbManager = serviceRegistry.requireService('dbManager');

      // Verify driver exists and has an active shift
      const driverShiftQuery = `
        SELECT id, staff_id FROM staff_shifts
        WHERE staff_id = ? AND role_type = 'driver'
        ORDER BY check_in_time DESC
        LIMIT 1
      `;
      const driverShifts = await dbManager.executeQuery(driverShiftQuery, [driverId]);

      if (!driverShifts || driverShifts.length === 0) {
        return { success: false, error: 'Driver not found or has no shifts' };
      }

      const driverShiftId = driverShifts[0].id;

      // Get delivered orders without driver_id
      const ordersQuery = `
        SELECT id, payment_method, total_amount, tip_amount
        FROM orders
        WHERE LOWER(COALESCE(order_type, '')) = 'delivery'
          AND LOWER(COALESCE(status, '')) IN ('delivered', 'completed')
          AND driver_id IS NULL
      `;
      const orders = await dbManager.executeQuery(ordersQuery);

      if (!orders || orders.length === 0) {
        return { success: true, fixed: 0, message: 'No orders to fix' };
      }

      let fixed = 0;
      let earningsCreated = 0;

      for (const order of orders) {
        try {
          // Update order with driver_id
          await dbManager.updateOrder(order.id, {
            driver_id: driverId,
            updated_at: new Date().toISOString(),
          });
          fixed++;

          // Create driver earning if it doesn't exist
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

          try {
            const res = dbManager.staff.recordDriverEarning({
              driverId,
              shiftId: driverShiftId,
              orderId: order.id,
              deliveryFee: 0,
              tipAmount: Number(order.tip_amount || 0),
              paymentMethod,
              cashCollected,
              cardAmount,
            });

            if (res.success) {
              earningsCreated++;
            }
          } catch (earningErr) {
            console.warn(`Failed to create earning for order ${order.id}:`, earningErr);
          }
        } catch (orderErr) {
          console.error(`Failed to update order ${order.id}:`, orderErr);
        }
      }

      return {
        success: true,
        fixed,
        earningsCreated,
        message: `Updated ${fixed} orders and created ${earningsCreated} driver earnings`,
      };
    } catch (error) {
      console.error('Failed to fix missing driver_ids:', error);
      return { success: false, error: String(error) };
    }
  });
}
