import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';
import {
  fetchTablesFromAdmin,
  fetchReservationsFromAdmin,
  fetchSuppliersFromAdmin,
  fetchAnalyticsFromAdmin,
  type FetchTablesOptions,
  type FetchReservationsOptions,
  type FetchSuppliersOptions,
  type FetchAnalyticsOptions,
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
}
