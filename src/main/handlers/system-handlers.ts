/**
 * System Handlers Module
 *
 * Handles system info and activity tracking IPC.
 */

import { app, ipcMain } from 'electron';
import { serviceRegistry } from '../service-registry';

/**
 * Register system-related IPC handlers
 */
export function registerSystemHandlers(): void {
  // System information handlers
  ipcMain.handle('system:get-info', async () => {
    return {
      platform: process.platform,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      userDataPath: app.getPath('userData'),
    };
  });

  // Activity tracking for session management
  ipcMain.handle('activity:track', () => {
    const authService = serviceRegistry.authService;
    if (authService) {
      authService.updateActivity();
    }
    return true;
  });

  ipcMain.handle('activity:get-last', () => {
    const authService = serviceRegistry.authService;
    if (authService) {
      return authService.getLastActivity();
    }
    return null;
  });
}
