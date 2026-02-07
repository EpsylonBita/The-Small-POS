import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';
import {
  fetchTablesFromAdmin,
  fetchReservationsFromAdmin,
  fetchSuppliersFromAdmin,
  fetchAnalyticsFromAdmin,
  fetchOrdersFromAdmin,
  fetchRoomsFromAdmin,
  updateRoomStatusFromAdmin,
  fetchDriveThruFromAdmin,
  updateDriveThruOrderStatusFromAdmin,
  type FetchTablesOptions,
  type FetchReservationsOptions,
  type FetchSuppliersOptions,
  type FetchAnalyticsOptions,
  type FetchOrdersOptions,
  type FetchRoomsOptions,
  type FetchDriveThruOptions,
  type RoomStatus,
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
  // IMPORTANT: Only cleans up orders from BEFORE the last Z-Report to preserve current session orders
  ipcMain.handle('sync:cleanup-deleted-orders', async () => {
    try {
      const { getSupabaseClient } = require('../../../shared/supabase-config');
      const supabase = getSupabaseClient();

      if (!supabase) {
        return { success: false, error: 'Supabase client not available' };
      }

      // Get the last Z-Report timestamp to preserve orders that haven't been Z-Reported yet
      const lastZReportTimestamp = db.settings.getSetting('system', 'last_z_report_timestamp', null) as string | null;
      if (!lastZReportTimestamp) {
        console.log('[sync:cleanup-deleted-orders] No Z-Report timestamp found, skipping cleanup to preserve all orders');
        return { success: true, deleted: 0, message: 'No Z-Report yet, preserving all orders' };
      }

      const zReportTime = new Date(lastZReportTimestamp).getTime();

      // Get all local orders with supabase_id
      const allOrders = db.orders.getAllOrders();

      // Only consider orders created BEFORE the last Z-Report for cleanup
      // Orders after the Z-Report are preserved until the next Z-Report is executed
      const ordersBeforeZReport = allOrders.filter(o => {
        const orderCreatedAt = o.created_at;
        if (!orderCreatedAt) return false;
        const orderTime = new Date(orderCreatedAt).getTime();
        return orderTime < zReportTime;
      });

      const localOrders = ordersBeforeZReport.filter(o => o.supabase_id);
      const preservedCount = allOrders.length - ordersBeforeZReport.length;
      if (preservedCount > 0) {
        console.log(`[sync:cleanup-deleted-orders] Preserving ${preservedCount} orders created after Z-Report`);
      }

      if (localOrders.length === 0) {
        return { success: true, deleted: 0, message: 'No synced orders to check (excluding current session)' };
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

      console.log(`[sync:cleanup-deleted-orders] Cleaned up ${deletedCount} orphaned orders (preserved ${preservedCount} current session orders)`);
      return { success: true, deleted: deletedCount, checked: localOrders.length, preserved: preservedCount };
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

  // Fetch rooms from admin dashboard (Hotel Vertical)
  ipcMain.handle('sync:fetch-rooms', async (_event, options?: FetchRoomsOptions) => {
    try {
      console.log('[Sync Handlers] sync:fetch-rooms called', { options });
      const rooms = await fetchRoomsFromAdmin(dbManager, options);
      return { success: true, rooms };
    } catch (error) {
      console.error('[Sync Handlers] sync:fetch-rooms error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch rooms',
      };
    }
  });

  // Update room status via admin dashboard (Hotel Vertical)
  ipcMain.handle('sync:update-room-status', async (_event, roomId: string, status: RoomStatus) => {
    try {
      console.log('[Sync Handlers] sync:update-room-status called', { roomId, status });
      const room = await updateRoomStatusFromAdmin(dbManager, roomId, status);
      return { success: true, room };
    } catch (error) {
      console.error('[Sync Handlers] sync:update-room-status error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update room status',
      };
    }
  });

  // Fetch drive-through data from admin dashboard (Fast-Food Vertical)
  ipcMain.handle('sync:fetch-drive-thru', async (_event, options?: FetchDriveThruOptions) => {
    try {
      console.log('[Sync Handlers] sync:fetch-drive-thru called', { options });
      const result = await fetchDriveThruFromAdmin(dbManager, options);
      return {
        success: true,
        lanes: result.lanes || [],
        orders: result.orders || [],
        queue_stats: result.queue_stats,
      };
    } catch (error) {
      console.error('[Sync Handlers] sync:fetch-drive-thru error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch drive-through data',
      };
    }
  });

  // Update drive-through order status via admin dashboard (Fast-Food Vertical)
  ipcMain.handle(
    'sync:update-drive-thru-order-status',
    async (_event, driveThruOrderId: string, status: string) => {
      try {
        console.log('[Sync Handlers] sync:update-drive-thru-order-status called', {
          driveThruOrderId,
          status,
        });
        const order = await updateDriveThruOrderStatusFromAdmin(dbManager, driveThruOrderId, status);
        return { success: true, order };
      } catch (error) {
        console.error('[Sync Handlers] sync:update-drive-thru-order-status error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update drive-through order status',
        };
      }
    }
  );

  // Generic authenticated fetch from admin dashboard API
  // This allows renderer to make arbitrary API calls to the admin dashboard
  // with proper terminal authentication headers
  ipcMain.handle('api:fetch-from-admin', async (_event, path: string, options?: {
    method?: string;
    body?: any;
    headers?: Record<string, string>;
  }) => {
    try {
      const adminSyncService = serviceRegistry.adminDashboardSyncService;
      if (!adminSyncService) {
        return { success: false, error: 'Admin sync service not initialized' };
      }

      // Get the admin dashboard URL and terminal credentials
      const db = dbManager.getDatabaseService();
      const terminalId = (db?.settings?.getSetting?.('terminal', 'terminal_id', '') || '').toString();
      const apiKey = (db?.settings?.getSetting?.('terminal', 'pos_api_key', '') || '').toString();
      const adminUrl = (db?.settings?.getSetting?.('terminal', 'admin_dashboard_url', '') || process.env.ADMIN_DASHBOARD_URL || 'http://localhost:3001').toString();

      if (!terminalId || !apiKey) {
        return { success: false, error: 'Terminal credentials not configured' };
      }

      if (!adminUrl) {
        return { success: false, error: 'Admin dashboard URL not configured' };
      }

      if (!path || typeof path !== 'string') {
        return { success: false, error: 'Invalid API path' };
      }

      let baseUrl: URL;
      try {
        baseUrl = new URL(adminUrl);
        if (!['http:', 'https:'].includes(baseUrl.protocol)) {
          return { success: false, error: 'Admin dashboard URL must be http or https' };
        }
      } catch (e) {
        return { success: false, error: 'Invalid admin dashboard URL' };
      }

      // Build the full URL and ensure it stays on the admin host
      let fullUrl: URL;
      try {
        fullUrl = (path.startsWith('http://') || path.startsWith('https://'))
          ? new URL(path)
          : new URL(path, baseUrl);
      } catch (e) {
        return { success: false, error: 'Invalid API path' };
      }

      if (fullUrl.origin !== baseUrl.origin) {
        return { success: false, error: 'Target host not allowed' };
      }

      // Build headers with terminal authentication
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...options?.headers,
        'x-terminal-id': terminalId,
        'x-pos-api-key': apiKey,
      };

      // Make the fetch request
      const fetchOptions: RequestInit = {
        method: options?.method || 'GET',
        headers,
        signal: AbortSignal.timeout(30000), // 30 second timeout
      };

      if (options?.body && options?.method !== 'GET') {
        fetchOptions.body = typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body);
      }

      console.log('[api:fetch-from-admin] Fetching:', fullUrl.toString(), { method: fetchOptions.method });

      const response = await fetch(fullUrl.toString(), fetchOptions);

      // Try to parse as JSON, fall back to text
      let data;
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      if (!response.ok) {
        console.error('[api:fetch-from-admin] Request failed:', response.status, data);
        return {
          success: false,
          error: typeof data === 'object' && data?.error ? data.error : `HTTP ${response.status}`,
          status: response.status,
          data,
        };
      }

      return {
        success: true,
        data,
        status: response.status,
      };
    } catch (error) {
      console.error('[api:fetch-from-admin] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch from admin API',
      };
    }
  });
}
