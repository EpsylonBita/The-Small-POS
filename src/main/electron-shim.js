// Electron shim for webpack bundling
// This file provides the electron module when the npm package returns a path string

let electronModule;

// Try to get electron from the standard require
const electronFromRequire = require('electron');

if (typeof electronFromRequire === 'object' && electronFromRequire.app) {
  // Normal case - electron module loaded correctly
  electronModule = electronFromRequire;
} else {
  // Workaround: when running inside Electron but node_modules/electron returns a path,
  // we need to access electron's internal exports differently
  
  // Check if we're inside Electron
  if (process.versions.electron) {
    console.warn('[electron-shim] require("electron") returned:', typeof electronFromRequire);
    console.warn('[electron-shim] Attempting to use Electron internals...');
    
    // In some Electron setups, the module might be available through a different mechanism
    // Try to access it through the Module system
    const Module = require('module');
    
    // Create a mock electron module with empty implementations
    // This is a last resort - the app won't work without the real electron module
    electronModule = {
      app: {
        on: () => {},
        whenReady: () => Promise.resolve(),
        quit: () => process.exit(0),
        getPath: () => '',
        getAppPath: () => __dirname,
        getVersion: () => process.versions.electron || '0.0.0',
        getName: () => 'app',
        isReady: () => false,
        commandLine: {
          appendSwitch: () => {},
          appendArgument: () => {},
          hasSwitch: () => false,
          getSwitchValue: () => ''
        }
      },
      BrowserWindow: class BrowserWindow {
        constructor() {}
        loadURL() {}
        loadFile() {}
        show() {}
      },
      ipcMain: {
        on: () => {},
        handle: () => {},
        removeHandler: () => {}
      },
      dialog: {
        showMessageBox: () => Promise.resolve({ response: 0 }),
        showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
        showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
        showErrorBox: () => {}
      },
      shell: {
        openExternal: () => Promise.resolve(),
        openPath: () => Promise.resolve('')
      },
      clipboard: {
        writeText: () => {},
        readText: () => ''
      },
      nativeImage: {
        createFromPath: () => ({}),
        createEmpty: () => ({})
      },
      Menu: class Menu {},
      MenuItem: class MenuItem {},
      session: {
        defaultSession: {}
      }
    };
    
    console.error('[electron-shim] WARNING: Using mock electron module. App functionality will be limited.');
  } else {
    // Not inside Electron - just export the path (for spawn use cases)
    electronModule = electronFromRequire;
  }
}

module.exports = electronModule;
