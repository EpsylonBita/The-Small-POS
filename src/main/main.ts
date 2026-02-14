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

// Load environment variables at runtime (MUST be first)
// This ensures .env file is available before any modules try to access process.env
import * as dotenv from 'dotenv';
dotenv.config();

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
// ASAR integrity now handled by Electron 39's built-in fuses (enableEmbeddedAsarIntegrityValidation)

const DEV_SERVER_WATCHDOG_URL = process.env.POS_DEV_SERVER_URL || 'http://localhost:3002';
const DEV_SERVER_WATCHDOG_INTERVAL_MS = 2000;
const DEV_SERVER_WATCHDOG_FAILURE_THRESHOLD = 3;
const DEV_SERVER_WATCHDOG_REQUEST_TIMEOUT_MS = 1200;

function startDevServerShutdownWatchdog(): void {
  if (app.isPackaged) {
    return;
  }

  let consecutiveFailures = 0;
  let stopped = false;

  const stop = () => {
    stopped = true;
  };

  const checkDevServer = async () => {
    if (stopped) {
      return;
    }

    try {
      const response = await fetch(DEV_SERVER_WATCHDOG_URL, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(DEV_SERVER_WATCHDOG_REQUEST_TIMEOUT_MS),
      });

      if (response.ok || response.status >= 400) {
        consecutiveFailures = 0;
        return;
      }

      consecutiveFailures += 1;
    } catch {
      consecutiveFailures += 1;
    }

    if (consecutiveFailures >= DEV_SERVER_WATCHDOG_FAILURE_THRESHOLD) {
      console.warn(
        `[DevWatchdog] Dev server is unreachable (${DEV_SERVER_WATCHDOG_URL}). Exiting Electron.`,
      );
      serviceRegistry.setIsQuitting(true);
      app.exit(0);
    }
  };

  // Start immediately so orphaned dev Electron processes exit quickly after Ctrl+C.
  void checkDevServer();

  const timer = setInterval(() => {
    void checkDevServer();
  }, DEV_SERVER_WATCHDOG_INTERVAL_MS);
  timer.unref();

  app.on('before-quit', stop);
  app.on('will-quit', stop);
}

function registerProcessSignalHandlers(): void {
  const shutdownFromSignal = (signal: string) => {
    console.log(`[Main] Received ${signal}, shutting down...`);
    serviceRegistry.setIsQuitting(true);
    app.quit();

    // Fallback in case quit hooks are blocked.
    setTimeout(() => {
      app.exit(0);
    }, 2000).unref();
  };

  process.on('SIGINT', () => shutdownFromSignal('SIGINT'));
  process.on('SIGTERM', () => shutdownFromSignal('SIGTERM'));
  process.on('SIGHUP', () => shutdownFromSignal('SIGHUP'));
}

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

// Ensure Windows uses the branded app icon for taskbar/shortcuts
if (process.platform === 'win32') {
  app.setAppUserModelId('com.thesmall.pos');
}

// App ready handler
app.whenReady().then(async () => {
  try {
    registerProcessSignalHandlers();
    startDevServerShutdownWatchdog();

    // SECURITY: ASAR integrity verification is now handled automatically by Electron 39's
    // built-in fuses (enableEmbeddedAsarIntegrityValidation + onlyLoadAppFromAsar).
    // If integrity check fails, the app will refuse to load before reaching this point.

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
  contents.setWindowOpenHandler(({ url }: { url: string }) => {
    // Prevent opening new windows
    return { action: 'deny' };
  });
});
