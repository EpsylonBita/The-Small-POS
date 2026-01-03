/**
 * Window Handlers Module
 *
 * Handles window control IPC (minimize, maximize, close).
 */

import { ipcMain, app } from 'electron';
import { serviceRegistry } from '../service-registry';

/**
 * Register window control IPC handlers
 */
export function registerWindowHandlers(): void {
  // App version handler
  ipcMain.removeHandler('app:get-version');
  ipcMain.handle('app:get-version', () => {
    try {
      return app.getVersion();
    } catch (e) {
      return null;
    }
  });

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

  // Get window state (maximized, fullscreen)
  ipcMain.removeHandler('window-get-state');
  ipcMain.handle('window-get-state', () => {
    try {
      const mainWindow = serviceRegistry.mainWindow;
      if (!mainWindow) return { isMaximized: false, isFullScreen: false };
      return {
        isMaximized: mainWindow.isMaximized(),
        isFullScreen: mainWindow.isFullScreen(),
      };
    } catch (e) {
      return { isMaximized: false, isFullScreen: false };
    }
  });

  // Reload window
  ipcMain.removeHandler('window-reload');
  ipcMain.handle('window-reload', () => {
    try {
      serviceRegistry.mainWindow?.reload();
      return true;
    } catch (e) {
      return false;
    }
  });

  // Force reload window
  ipcMain.removeHandler('window-force-reload');
  ipcMain.handle('window-force-reload', () => {
    try {
      serviceRegistry.mainWindow?.webContents.reloadIgnoringCache();
      return true;
    } catch (e) {
      return false;
    }
  });

  // Toggle DevTools
  ipcMain.removeHandler('window-toggle-devtools');
  ipcMain.handle('window-toggle-devtools', () => {
    try {
      const mainWindow = serviceRegistry.mainWindow;
      if (!mainWindow) return false;
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools();
      }
      return true;
    } catch (e) {
      return false;
    }
  });

  // Zoom controls
  ipcMain.removeHandler('window-zoom-in');
  ipcMain.handle('window-zoom-in', () => {
    try {
      const mainWindow = serviceRegistry.mainWindow;
      if (!mainWindow) return false;
      const currentZoom = mainWindow.webContents.getZoomLevel();
      mainWindow.webContents.setZoomLevel(currentZoom + 1);
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.removeHandler('window-zoom-out');
  ipcMain.handle('window-zoom-out', () => {
    try {
      const mainWindow = serviceRegistry.mainWindow;
      if (!mainWindow) return false;
      const currentZoom = mainWindow.webContents.getZoomLevel();
      mainWindow.webContents.setZoomLevel(currentZoom - 1);
      return true;
    } catch (e) {
      return false;
    }
  });

  ipcMain.removeHandler('window-zoom-reset');
  ipcMain.handle('window-zoom-reset', () => {
    try {
      serviceRegistry.mainWindow?.webContents.setZoomLevel(0);
      return true;
    } catch (e) {
      return false;
    }
  });
}
