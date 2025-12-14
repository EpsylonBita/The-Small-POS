/**
 * App Control Handlers Module
 *
 * Handles application control IPC (shutdown, restart, status).
 */

import { ipcMain } from 'electron';
import { serviceRegistry } from '../service-registry';
import { gracefulShutdown, gracefulRestart } from '../lifecycle/shutdown';

/**
 * Register app control IPC handlers
 */
export function registerAppControlHandlers(): void {
  // Application control handlers
  ipcMain.handle('app:shutdown', async () => {
    try {
      const authService = serviceRegistry.authService;

      // Check permission before allowing shutdown
      const hasPermission = await authService?.hasPermission('app:control');
      if (!hasPermission) {
        console.warn('Shutdown requested without proper permissions');
        return {
          success: false,
          error: 'Unauthorized: Insufficient permissions to shutdown application',
        };
      }

      console.log('Shutdown requested via IPC');
      await gracefulShutdown();
      return { success: true };
    } catch (error) {
      console.error('Shutdown error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('app:restart', async () => {
    try {
      const authService = serviceRegistry.authService;

      // Check permission before allowing restart
      const currentSession = await authService?.getCurrentSession();

      if (currentSession) {
        const hasPermission = await authService?.hasPermission('app:control');
        if (!hasPermission) {
          console.warn('Restart requested without proper permissions');
          return {
            success: false,
            error: 'Unauthorized: Insufficient permissions to restart application',
          };
        }
      } else {
        console.log('Restart requested (no active session, allowing for onboarding/login)');
      }

      console.log('Restart requested via IPC');
      await gracefulRestart();
      return { success: true };
    } catch (error) {
      console.error('Restart error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('app:get-shutdown-status', async () => {
    try {
      const { heartbeatService, syncService, authService, dbManager } =
        serviceRegistry.getAllServices();

      // Return current services status for shutdown monitoring
      return {
        heartbeat: heartbeatService?.isActive() ?? false,
        sync: syncService?.getSyncStatus() ?? null,
        auth: authService ? true : false,
        database: dbManager ? true : false,
      };
    } catch (error) {
      console.error('Get shutdown status error:', error);
      return null;
    }
  });
}
