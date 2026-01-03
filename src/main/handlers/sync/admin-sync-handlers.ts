import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';
import {
  fetchTablesFromAdmin,
  fetchReservationsFromAdmin,
  fetchSuppliersFromAdmin,
  fetchAnalyticsFromAdmin,
  fetchOrdersFromAdmin,
  type FetchTablesOptions,
  type FetchReservationsOptions,
  type FetchSuppliersOptions,
  type FetchAnalyticsOptions,
  type FetchOrdersOptions,
} from '../../api-sync';

/**
 * Registers core sync-related IPC handlers.
 */
export function registerCoreSyncHandlers(): void {
  const syncService = serviceRegistry.syncService;
  const authService = serviceRegistry.authService;
  const dbManager = serviceRegistry.dbManager;

  if (!syncService || !authService || !dbManager) {
    console.error('[SyncHandlers] Required services not initialized');
    return;
  }

  const db = dbManager.getDatabaseService();

  ipcMain.handle('sync:get-status', async () => {
    try {
      const status = await syncService.getSyncStatus();
      return status;
    } catch (error) {
      console.error('Get sync status error:', error);
      return {
        isOnline: false,
        lastSync: null,
        pendingItems: 0,
        syncInProgress: false,
        error: (error as Error).message,
      };
    }
  });

  ipcMain.handle('sync:force', async () => {
    try {
      // Check permission
      const hasPermission = await authService.hasPermission('force_sync');
      if (!hasPermission) {
        return { success: false, error: 'Insufficient permissions' };
      }

      await syncService.forceSync();

      // Update activity for session management
      authService.updateActivity();

      return { success: true };
    } catch (error) {
      console.error('Force sync error:', error);
      return { success: false, error: 'Failed to force sync' };
    }
  });

  ipcMain.handle('sync:get-network-status', async () => {
    try {
      const isOnline = syncService.getNetworkStatus();
      return { isOnline };
    } catch (error) {
      console.error('Get network status error:', error);
      return { isOnline: false };
    }
  });

  ipcMain.handle('sync:get-inter-terminal-status', async () => {
    try {
      const result = syncService.getInterTerminalStatus();
      return result;
    } catch (e) {
      console.error('Get inter-terminal status error:', e);
      return { parentInfo: null, isParentReachable: false, routingMode: 'unknown' };
    }
  });

  ipcMain.handle('sync:test-parent-connection', async () => {
    try {
      const result = await syncService.testParentConnection();
      return { success: true, reachable: result };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  });

  ipcMain.handle('sync:rediscover-parent', async () => {
    try {
      syncService.rediscoverParent();
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  });

  // Financial Sync Handlers
  ipcMain.handle('sync:get-financial-stats', async () => {
    try {
      return db.sync.getFinancialSyncStats();
    } catch (err) {
      console.error('sync:get-financial-stats error', err);
      // Return safer default matching the return type
      return {
        driver_earnings: { pending: 0, failed: 0 },
        staff_payments: { pending: 0, failed: 0 },
        shift_expenses: { pending: 0, failed: 0 }
      };
    }
  });

  ipcMain.handle('sync:get-failed-financial-items', async (_e, limit) => {
    try {
      // Validate limit
      const safeLimit = typeof limit === 'number' && limit > 0 ? limit : 100;
      return db.sync.getFailedFinancialSyncItems(safeLimit);
    } catch (err) {
      console.error('sync:get-failed-financial-items error', err);
      return [];
    }
  });

  ipcMain.handle('sync:retry-financial-item', async (_e, syncId) => {
    try {
      if (!syncId || typeof syncId !== 'string') {
        return { success: false, error: 'Invalid syncId provided' };
      }
      db.sync.retryFinancialSyncItem(syncId);
      syncService.startSync();
      return { success: true };
    } catch (err) {
      console.error('sync:retry-financial-item error', err);
      return { success: false, error: (err as any).message };
    }
  });

  ipcMain.handle('sync:retry-all-failed-financial', async () => {
    try {
      db.sync.retryAllFailedFinancialSyncs();
      syncService.startSync();
      return { success: true };
    } catch (err) {
      console.error('sync:retry-all-failed-financial error', err);
      return { success: false, error: (err as any).message };
    }
  });

  // Re-queue orphaned financial records (those with no supabase_id and no sync queue entry)
  ipcMain.handle('sync:requeue-orphaned-financial', async () => {
    try {
      const requeued = db.sync.requeueOrphanedFinancialRecords();
      if (requeued > 0) {
        syncService.startSync();
      }
      return { success: true, requeued };
    } catch (err) {
      console.error('sync:requeue-orphaned-financial error', err);
      return { success: false, error: (err as any).message };
    }
  });

  ipcMain.handle('sync:get-unsynced-financial-summary', async (_e, date) => {
    try {
      // Validate date if present
      const safeDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date) ? date : undefined;
      return db.reports.getUnsyncedFinancialSummary(safeDate);
    } catch (err) {
      console.error('sync:get-unsynced-financial-summary error', err);
      return { driverEarnings: 0, staffPayments: 0, shiftExpenses: 0, total: 0 };
    }
  });

  ipcMain.handle('sync:validate-financial-integrity', async (_e, date) => {
    try {
      const safeDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date) ? date : undefined;
      return await db.reports.validateFinancialDataIntegrity(safeDate);
    } catch (err) {
      console.error('sync:validate-financial-integrity error', err);
      return { valid: false, discrepancies: [], errors: [(err as any).message] };
    }
  });

  // Clear all sync queue items (useful for stuck sync items)
  ipcMain.handle('sync:clear-all', async () => {
    try {
      const cleared = db.sync.clearAllSyncQueue();
      return { success: true, cleared };
    } catch (err) {
      console.error('sync:clear-all error', err);
      return { success: false, error: (err as any).message };
    }
  });

  // Clear old/orphaned orders (orders from previous days that are stuck in non-final status)
  ipcMain.handle('sync:clear-old-orders', async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      // Use the orders service to delete old orders
      // Get all orders and filter locally, then delete
      const allOrders = db.orders.getAllOrders();
      const oldOrders = allOrders.filter(o => {
        const orderDate = o.created_at?.slice(0, 10);
        return orderDate && orderDate < today && 
          !['delivered', 'completed', 'cancelled'].includes(o.status);
      });
      
      let cleared = 0;
      for (const order of oldOrders) {
        try {
          db.orders.deleteOrder(order.id);
          cleared++;
        } catch (e) {
          console.warn(`[sync:clear-old-orders] Failed to delete order ${order.id}:`, e);
        }
      }
      
      console.log(`[sync:clear-old-orders] Cleared ${cleared} old/orphaned orders`);
      return { success: true, cleared };
    } catch (err) {
      console.error('sync:clear-old-orders error', err);
      return { success: false, error: (err as any).message };
    }
  });

  // Clear ALL local orders (useful for testing or when orders are out of sync with admin)
  ipcMain.handle('sync:clear-all-orders', async () => {
    try {
      const allOrders = db.orders.getAllOrders();
      let cleared = 0;
      for (const order of allOrders) {
        try {
          db.orders.deleteOrder(order.id);
          cleared++;
        } catch (e) {
          console.warn(`[sync:clear-all-orders] Failed to delete order ${order.id}:`, e);
        }
      }
      console.log(`[sync:clear-all-orders] Cleared ${cleared} orders`);
      return { success: true, cleared };
    } catch (err) {
      console.error('sync:clear-all-orders error', err);
      return { success: false, error: (err as any).message };
    }
  });

  // Sync deleted orders - check which local orders no longer exist on the server and delete them
  ipcMain.handle('sync:cleanup-deleted-orders', async () => {
    try {
      const { getSupabaseClient } = require('../../../shared/supabase-config');
      const supabase = getSupabaseClient();
      
      if (!supabase) {
        return { success: false, error: 'Supabase client not available' };
      }

      // Get all local orders with supabase_id
      const allOrders = db.orders.getAllOrders();
      const localOrders = allOrders.filter(o => o.supabase_id);

      if (localOrders.length === 0) {
        return { success: true, deleted: 0, message: 'No synced orders to check' };
      }

      // Check which orders still exist on the server (batch query)
      const supabaseIds = localOrders.map(o => o.supabase_id);
      const { data: serverOrders, error } = await supabase
        .from('orders')
        .select('id')
        .in('id', supabaseIds);

      if (error) {
        console.error('[sync:cleanup-deleted-orders] Error fetching server orders:', error);
        return { success: false, error: error.message };
      }

      const serverOrderIds = new Set((serverOrders || []).map((o: any) => o.id));
      
      // Find orders that exist locally but not on server
      const deletedOrders = localOrders.filter(o => !serverOrderIds.has(o.supabase_id));
      
      // Delete them locally
      let deletedCount = 0;
      for (const order of deletedOrders) {
        try {
          db.orders.deleteOrder(order.id);
          deletedCount++;
          console.log(`[sync:cleanup-deleted-orders] Deleted orphaned order ${order.id} (supabase_id: ${order.supabase_id})`);
        } catch (e) {
          console.warn(`[sync:cleanup-deleted-orders] Failed to delete order ${order.id}:`, e);
        }
      }

      console.log(`[sync:cleanup-deleted-orders] Cleaned up ${deletedCount} orphaned orders`);
      return { success: true, deleted: deletedCount, checked: localOrders.length };
    } catch (err) {
      console.error('sync:cleanup-deleted-orders error', err);
      return { success: false, error: (err as any).message };
    }
  });

  // Clear failed sync items for specific tables
  ipcMain.handle('sync:clear-failed', async (_e, tableNames?: string[]) => {
    try {
      const cleared = db.sync.clearFailedSyncItems(tableNames);
      return { success: true, cleared };
    } catch (err) {
      console.error('sync:clear-failed error', err);
      return { success: false, error: (err as any).message };
    }
  });
}

/**
 * Registers admin dashboard sync IPC handlers.
 *
 * These handlers allow the renderer process to fetch data from the admin dashboard.
 */
export function setupAdminSyncHandlers(): void {
  const dbManager = serviceRegistry.dbManager;
  if (!dbManager) {
    console.error('[SyncHandlers] DatabaseManager not initialized');
    return;
  }
  
  // dbManager is used as the `db` argument for fetch functions
  // fetchTablesFromAdmin takes (db: DatabaseManager, options)
  
  // Fetch tables from admin dashboard
  ipcMain.handle('sync:fetch-tables', async (_event, options?: FetchTablesOptions) => {
    try {
      console.log('[Sync Handlers] sync:fetch-tables called', { options });
      const tables = await fetchTablesFromAdmin(dbManager, options);
      return { success: true, tables };
    } catch (error) {
      console.error('[Sync Handlers] sync:fetch-tables error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch tables',
      };
    }
  });

  // Fetch reservations from admin dashboard
  ipcMain.handle('sync:fetch-reservations', async (_event, options?: FetchReservationsOptions) => {
    try {
      console.log('[Sync Handlers] sync:fetch-reservations called', { options });
      const result = await fetchReservationsFromAdmin(dbManager, options);
      return {
        success: true,
        reservations: result.reservations,
        stats: result.stats,
      };
    } catch (error) {
      console.error('[Sync Handlers] sync:fetch-reservations error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch reservations',
      };
    }
  });

  // Fetch suppliers from admin dashboard
  ipcMain.handle('sync:fetch-suppliers', async (_event, options?: FetchSuppliersOptions) => {
    try {
      console.log('[Sync Handlers] sync:fetch-suppliers called', { options });
      const suppliers = await fetchSuppliersFromAdmin(dbManager, options);
      return { success: true, suppliers };
    } catch (error) {
      console.error('[Sync Handlers] sync:fetch-suppliers error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch suppliers',
      };
    }
  });

  // Fetch analytics from admin dashboard
  ipcMain.handle('sync:fetch-analytics', async (_event, options?: FetchAnalyticsOptions) => {
    try {
      console.log('[Sync Handlers] sync:fetch-analytics called', { options });
      const analytics = await fetchAnalyticsFromAdmin(dbManager, options);
      return { success: true, analytics };
    } catch (error) {
      console.error('[Sync Handlers] sync:fetch-analytics error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch analytics',
      };
    }
  });

  // Fetch orders from admin dashboard
  ipcMain.handle('sync:fetch-orders', async (_event, options?: FetchOrdersOptions) => {
    try {
      console.log('[Sync Handlers] sync:fetch-orders called', { options });
      const result = await fetchOrdersFromAdmin(dbManager, options);
      return {
        success: true,
        orders: result.orders,
        total: result.total
      };
    } catch (error) {
      console.error('[Sync Handlers] sync:fetch-orders error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch orders',
      };
    }
  });
}
