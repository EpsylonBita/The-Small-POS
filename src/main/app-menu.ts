/**
 * Application Menu Manager
 *
 * Creates and manages the application menu with Help menu items
 * and cross-platform support for Windows, macOS, and Linux.
 */

import { app, Menu, shell, BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { serviceRegistry } from './service-registry';

// Menu configuration URLs
export interface MenuConfig {
  learnMoreUrl: string;
  documentationUrl: string;
  communityUrl: string;
  issuesUrl: string;
}

// Default configuration
const defaultConfig: MenuConfig = {
  learnMoreUrl: 'https://www.electronjs.org/',
  documentationUrl: 'https://github.com/The-Small-POS/The-Small-002#readme',
  communityUrl: 'https://github.com/The-Small-POS/The-Small-002/discussions',
  issuesUrl: 'https://github.com/The-Small-POS/The-Small-002/issues',
};

/**
 * Creates the application menu with Help menu and standard menus
 */
export function createApplicationMenu(config: MenuConfig = defaultConfig): void {
  const isMac = process.platform === 'darwin';
  
  const template: MenuItemConstructorOptions[] = [
    // macOS App menu
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    
    // File menu
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' as const },
          { role: 'delete' as const },
          { role: 'selectAll' as const },
          { type: 'separator' as const },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' as const },
              { role: 'stopSpeaking' as const },
            ],
          },
        ] : [
          { role: 'delete' as const },
          { type: 'separator' as const },
          { role: 'selectAll' as const },
        ]),
      ],
    },
    
    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
          { type: 'separator' as const },
          { role: 'window' as const },
        ] : [
          { role: 'close' as const },
        ]),
      ],
    },
    
    // Help menu
    {
      role: 'help' as const,
      submenu: [
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal(config.learnMoreUrl);
          },
        },
        {
          label: 'Documentation',
          click: async () => {
            await shell.openExternal(config.documentationUrl);
          },
        },
        {
          label: 'Community Discussions',
          click: async () => {
            await shell.openExternal(config.communityUrl);
          },
        },
        {
          label: 'Search Issues',
          click: async () => {
            await shell.openExternal(config.issuesUrl);
          },
        },
        { type: 'separator' as const },
        {
          label: 'Check for Updates...',
          click: () => {
            handleCheckForUpdates();
          },
        },
      ],
    },
  ];
  
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * Handle Check for Updates menu click
 * Triggers update check and notifies renderer to show dialog
 */
function handleCheckForUpdates(): void {
  const mainWindow = serviceRegistry.mainWindow;
  const autoUpdaterService = serviceRegistry.autoUpdaterService;
  
  // Notify renderer to open update dialog
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:check-for-updates');
  }
  
  // Trigger update check if service is available
  if (autoUpdaterService) {
    autoUpdaterService.checkForUpdates().catch((error) => {
      console.error('[AppMenu] Failed to check for updates:', error);
    });
  } else {
    console.log('[AppMenu] AutoUpdater service not available (dev mode?)');
  }
}

/**
 * Get the menu template for testing purposes
 */
export function getMenuTemplate(config: MenuConfig = defaultConfig): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';
  
  return [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
      ],
    },
    {
      role: 'help' as const,
      submenu: [
        { label: 'Learn More' },
        { label: 'Documentation' },
        { label: 'Community Discussions' },
        { label: 'Search Issues' },
        { type: 'separator' as const },
        { label: 'Check for Updates...' },
      ],
    },
  ];
}

export { defaultConfig };
