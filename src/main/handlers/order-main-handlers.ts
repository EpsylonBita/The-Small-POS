/**
 * Order Main Handlers Module
 *
 * Handles order-related IPC handlers that are in main.ts
 * (order:get-all, orders:clear-all, database:reset)
 *
 * Note: The bulk of order handlers are in order-handlers.ts
 */

import { app, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { serviceRegistry } from '../service-registry';
import { ErrorHandler, withTimeout } from '../../shared/utils/error-handler';
import { TIMING } from '../../shared/constants';

const errorHandler = ErrorHandler.getInstance();

/**
 * Register order-related IPC handlers
 */
export function registerOrderMainHandlers(): void {
  // Order management handlers
  // Order management handlers
  // 'order:get-all' handler is canonical in Handlers/orders/order-crud-handlers.ts


  // Clear all orders handler (for development/testing)
  ipcMain.handle('orders:clear-all', async () => {
    const dbManager = serviceRegistry.dbManager;
    const mainWindow = serviceRegistry.mainWindow;

    if (!dbManager) {
      return { success: false, error: 'Database not initialized' };
    }

    try {
      console.log('🗑️  Clearing all orders from local database...');

      const databaseService = dbManager.getDatabaseService();
      const db = (databaseService as any).db;

      if (!db) {
        throw new Error('Database not initialized');
      }

      // Count orders before deletion
      const beforeCount = db.prepare('SELECT COUNT(*) as count FROM orders').get();
      console.log(`📊 Orders before deletion: ${beforeCount.count}`);

      // Start transaction
      db.exec('BEGIN TRANSACTION');

      try {
        // Delete from sync_queue (orders)
        const syncQueueResult = db
          .prepare("DELETE FROM sync_queue WHERE table_name = 'orders'")
          .run();
        console.log(`🗑️  Deleted ${syncQueueResult.changes} items from sync_queue`);

        // Delete from order_retry_queue if it exists
        try {
          const retryQueueResult = db.prepare('DELETE FROM order_retry_queue').run();
          console.log(`🗑️  Deleted ${retryQueueResult.changes} items from order_retry_queue`);
        } catch (err) {
          console.log('ℹ️  order_retry_queue table does not exist (skipping)');
        }

        // Delete from conflicts table if it exists
        try {
          const conflictsResult = db
            .prepare("DELETE FROM conflicts WHERE entity_type = 'order'")
            .run();
          console.log(`🗑️  Deleted ${conflictsResult.changes} conflicts`);
        } catch (err) {
          console.log('ℹ️  conflicts table does not exist (skipping)');
        }

        // Delete all orders
        const ordersResult = db.prepare('DELETE FROM orders').run();
        console.log(`🗑️  Deleted ${ordersResult.changes} orders`);

        // Commit transaction
        db.exec('COMMIT');
        console.log('✅ Transaction committed');

        // Verify deletion
        const afterCount = db.prepare('SELECT COUNT(*) as count FROM orders').get();
        console.log(`📊 Orders after deletion: ${afterCount.count}`);

        // Notify renderer to refresh
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('orders-cleared');
        }

        return {
          success: true,
          deletedOrders: ordersResult.changes,
          deletedSyncQueue: syncQueueResult.changes,
        };
      } catch (error) {
        // Rollback on error
        db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      console.error('❌ Error clearing orders:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // Reset database handler (for development/testing)
  ipcMain.handle('database:reset', async () => {
    const dbManager = serviceRegistry.dbManager;

    try {
      console.log('🔄 Resetting database...');

      const userDataPath = app.getPath('userData');
      const dbPath = path.join(userDataPath, 'pos-database.db');

      console.log(`📍 Database path: ${dbPath}`);

      if (!fs.existsSync(dbPath)) {
        console.log('ℹ️  Database file does not exist');
        return { success: true, message: 'Database file does not exist' };
      }

      // Close the database connection first
      if (dbManager) {
        try {
          const databaseService = dbManager.getDatabaseService();
          const db = (databaseService as any).db;
          if (db) {
            db.close();
            console.log('✅ Database connection closed');
          }
        } catch (err) {
          console.warn('⚠️ Error closing database:', err);
        }
      }

      // Delete the database file
      fs.unlinkSync(dbPath);
      console.log('🗑️  Database file deleted');

      // Restart the app to reinitialize
      console.log('🔄 Restarting app...');
      app.relaunch();
      app.quit();

      return { success: true, message: 'Database reset, restarting...' };
    } catch (error) {
      console.error('❌ Error resetting database:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
