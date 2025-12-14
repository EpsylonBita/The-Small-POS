/**
 * Window Handlers Module
 *
 * Handles window control IPC (minimize, maximize, close).
 */

import { ipcMain } from 'electron';
import { serviceRegistry } from '../service-registry';

/**
 * Register window control IPC handlers
 */
export function registerWindowHandlers(): void {
  // Window control handlers (defensive against dev reloads)
  ipcMain.removeHandler('window-minimize');
  ipcMain.handle('window-minimize', () => {
    try {
      serviceRegistry.mainWindow?.minimize();
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.removeHandler('window-maximize');
  ipcMain.handle('window-maximize', () => {
    try {
      const mainWindow = serviceRegistry.mainWindow;
      if (!mainWindow) return false;
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
      return mainWindow.isMaximized();
    } catch (e) {
      return false;
    }
  });

  ipcMain.removeHandler('window-close');
  ipcMain.handle('window-close', () => {
    try {
      serviceRegistry.mainWindow?.close();
      return true;
    } catch (e) {
      return false;
    }
  });

  // Fullscreen toggle handler
  ipcMain.removeHandler('window-toggle-fullscreen');
  ipcMain.handle('window-toggle-fullscreen', () => {
    try {
      const mainWindow = serviceRegistry.mainWindow;
      if (!mainWindow) return false;
      const isFullScreen = mainWindow.isFullScreen();
      mainWindow.setFullScreen(!isFullScreen);
      return !isFullScreen;
    } catch (e) {
      return false;
    }
  });
}
