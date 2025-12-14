/**
 * Main Entry Point for POS System
 *
 * This file orchestrates the application lifecycle and service initialization.
 * All handler registration and service logic has been modularized into:
 * - service-registry.ts - Centralized service access
 * - lifecycle/ - App initialization, shutdown, error logging
 * - handlers/ - IPC handler modules (domain-organized)
 * - auto-updater.ts - Update management
 *
 * Architecture follows the Refactored Architecture pattern:
 * - Handlers access services via serviceRegistry singleton
 * - Domain handlers are organized under handlers/ directory
 * - See docs/architecture/REFACTORED_ARCHITECTURE.md for details
 */

import { app, BrowserWindow } from 'electron';
import { serviceRegistry } from './service-registry';
import {
  initializeDatabase,
  initializeServices,
  createMainWindow,
  setupServiceCallbacks,
  startSync,
  normalizeLegacyStatuses,
  startHealthChecks,
  performInitialHealthCheck,
  logErrorToFile,
  showErrorDialog,
  handleBeforeQuit,
  handlePosControlCommand,
} from './lifecycle';
import { registerAllMainHandlers, registerAllDomainHandlers } from './handlers';
import { initializeAutoUpdater } from './auto-updater';
import { createApplicationMenu } from './app-menu';

// Configure Google API key for geolocation BEFORE app is ready
try {
  const googleApiKey = (process.env.GOOGLE_MAPS_API_KEY || '').trim();
  if (googleApiKey) {
    app.commandLine.appendSwitch('google-api-key', googleApiKey);
    console.log('✅ Google API key configured for geolocation');
  }
} catch (e) {
  console.warn('Failed to configure Google API key:', e);
}

// App ready handler
app.whenReady().then(async () => {
  try {
    // Register all main IPC handlers (clipboard, window, geo, etc.)
    registerAllMainHandlers();

    // Initialize database with fallback
    const { dbManager, success, usedFallback } = await initializeDatabase();
    if (!success) {
      return; // App will quit/relaunch from initializeDatabase
    }
    serviceRegistry.register('dbManager', dbManager);

    if (usedFallback) {
      console.warn('Database initialized using fallback (fresh database)');
    }

    // Initialize all services
    const servicesInitialized = await initializeServices(dbManager);
    if (!servicesInitialized) {
      return; // App will quit/relaunch from initializeServices
    }

    // Register domain handlers that use serviceRegistry pattern
    // IMPORTANT: Must be registered BEFORE creating the window so that
    // the renderer's ConfigGuard can access the correct handlers immediately
    registerAllDomainHandlers();

    // Create main window
    const mainWindow = createMainWindow();
    if (!mainWindow) {
      throw new Error('Failed to create main window');
    }

    // Set up service callbacks for main window
    setupServiceCallbacks(mainWindow);

    // Perform initial health check
    await performInitialHealthCheck();

    // Start auto-sync and real-time subscriptions
    startSync();

    // Run legacy status normalization
    normalizeLegacyStatuses();

    // Start periodic health checks (every 5 minutes)
    startHealthChecks();

    // Initialize auto-updater for production
    initializeAutoUpdater();

    // Create application menu with Help menu
    createApplicationMenu();
  } catch (error) {
    console.error('Failed to initialize app:', error);
    logErrorToFile(error);

    await showErrorDialog(
      'Application Error',
      'Failed to start the application. Please check the logs and try again.',
      ['Exit']
    );

    app.quit();
  }
});

// App activate handler (macOS)
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// Window all closed handler
app.on('window-all-closed', () => {
  // On macOS, keep app running even when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Before quit handler
app.on('before-quit', async (event) => {
  await handleBeforeQuit(event);
});

// Listen for POS control commands from HeartbeatService
process.on('pos-control-command', (data: { type: 'shutdown' | 'restart' | 'enable' | 'disable'; commandId?: string }) => {
  handlePosControlCommand(data);
});

// Prevent new window creation
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // Prevent opening new windows
    return { action: 'deny' };
  });
});
