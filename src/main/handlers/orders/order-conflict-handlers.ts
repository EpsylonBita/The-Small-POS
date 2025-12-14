import { ipcMain } from 'electron';
import { serviceRegistry } from '../../service-registry';

export async function resolveOrderConflict(
  conflictId: string,
  strategy: string,
  data?: any,
): Promise<{ success: boolean; error?: string }> {
  try {
    const dbManager = serviceRegistry.dbManager;
    const mainWindow = serviceRegistry.mainWindow;

    if (!dbManager) {
      return { success: false, error: 'Database not initialized' };
    }

    const conflict = await dbManager.executeQuery(
      `SELECT * FROM order_sync_conflicts WHERE id = ?`,
      [conflictId],
    );

    if (!conflict || conflict.length === 0) {
      return { success: false, error: 'Conflict not found' };
    }

    const conflictData = conflict[0];

    let resolvedData: any;
    if (strategy === 'local_wins') {
      resolvedData = JSON.parse(conflictData.local_data);
    } else if (strategy === 'remote_wins') {
      resolvedData = JSON.parse(conflictData.remote_data);
    } else if (strategy === 'manual_merge' && data) {
      resolvedData = data;
    } else {
      return { success: false, error: 'Invalid resolution strategy' };
    }

    await dbManager.executeQuery(
      `UPDATE orders SET
        status = ?,
        total_amount = ?,
        updated_at = ?,
        version = version + 1,
        sync_status = 'pending'
      WHERE id = ?`,
      [
        resolvedData.status,
        resolvedData.totalAmount || resolvedData.total_amount,
        new Date().toISOString(),
        conflictData.order_id,
      ],
    );

    await dbManager.executeQuery(
      `UPDATE order_sync_conflicts SET
        resolved = 1,
        resolved_at = ?,
        resolution_strategy = ?
      WHERE id = ?`,
      [new Date().toISOString(), strategy, conflictId],
    );

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('order-conflict-resolved', {
        conflictId,
        orderId: conflictData.order_id,
        strategy,
      });
    }

    return { success: true };
  } catch (error) {
    console.error('Resolve order conflict error:', error);
    return { success: false, error: 'Failed to resolve conflict' };
  }
}

export async function forceOrderSyncRetry(
  orderId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const dbManager = serviceRegistry.dbManager;
    if (!dbManager) {
      return { success: false, error: 'Database not initialized' };
    }

    await dbManager.executeQuery(
      `UPDATE sync_queue SET
        retry_delay_ms = 0,
        next_retry_at = datetime('now'),
        attempts = 0,
        error_message = NULL
      WHERE table_name = 'orders' AND record_id = ? AND (has_conflict = 0 OR has_conflict IS NULL)`,
      [orderId],
    );

    return { success: true };
  } catch (error) {
    console.error('Force order sync retry error:', error);
    return { success: false, error: 'Failed to force sync retry' };
  }
}

export function registerOrderConflictHandlers(): void {
  const dbManager = serviceRegistry.dbManager;

  ipcMain.handle('orders:get-conflicts', async () => {
    try {
      if (!dbManager) {
        return { success: false, error: 'Database not initialized', conflicts: [] };
      }
      const conflicts = await dbManager.executeQuery(
        `SELECT * FROM order_sync_conflicts WHERE resolved = 0 ORDER BY created_at DESC`,
        [],
      );
      return { success: true, conflicts: conflicts || [] };
    } catch (error) {
      console.error('Failed to get conflicts:', error);
      return { success: false, error: 'Failed to get conflicts', conflicts: [] };
    }
  });

  ipcMain.handle('orders:resolve-conflict', async (_event, conflictId: string, strategy: string, data?: any) => {
    return resolveOrderConflict(conflictId, strategy, data);
  });

  ipcMain.handle('orders:force-sync-retry', async (_event, orderId: string) => {
    return forceOrderSyncRetry(orderId);
  });

  ipcMain.handle('orders:get-retry-info', async (_event, orderId: string) => {
    try {
      if (!dbManager) {
        return { success: false, error: 'Database not initialized', retryInfo: null };
      }

      const retryInfo = await dbManager.executeQuery(
        `SELECT record_id, attempts, next_retry_at, retry_delay_ms, error_message
         FROM sync_queue
         WHERE table_name = 'orders' AND record_id = ? AND (has_conflict = 0 OR has_conflict IS NULL)
         ORDER BY created_at DESC
         LIMIT 1`,
        [orderId],
      );

      if (!retryInfo || retryInfo.length === 0) {
        return { success: true, retryInfo: null };
      }

      const info = retryInfo[0];
      return {
        success: true,
        retryInfo: {
          orderId: info.record_id,
          attempts: info.attempts || 0,
          maxAttempts: 5,
          nextRetryAt: info.next_retry_at,
          retryDelayMs: info.retry_delay_ms || 0,
          lastError: info.error_message,
        },
      };
    } catch (error) {
      console.error('Failed to get retry info:', error);
      return { success: false, error: 'Failed to get retry info', retryInfo: null };
    }
  });

  // Alias handlers for renderer compatibility (previously in ipc-router.ts)
  ipcMain.handle('resolve-order-conflict', async (_event, conflictId: string, strategy: string, data?: any) => {
    return resolveOrderConflict(conflictId, strategy, data);
  });

  ipcMain.handle('force-order-sync-retry', async (_event, orderId: string) => {
    return forceOrderSyncRetry(orderId);
  });
}
