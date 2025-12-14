/**
 * Shutdown Module
 *
 * Handles graceful shutdown and restart of the POS application.
 */

import { app, BrowserWindow } from 'electron';
import { serviceRegistry } from '../service-registry';
import { logErrorToFile } from './error-logging';
import { shutdownPrinterManager } from '../handlers/printer-manager-handlers';

/**
 * Graceful shutdown handler
 * Cleans up all services and exits the application
 */
export async function gracefulShutdown(commandId?: string): Promise<void> {
  console.log('Performing graceful shutdown...');

  const {
    mainWindow,
    syncService,
    heartbeatService,
    authService,
    dbManager,
  } = serviceRegistry.getAllServices();
  const realtimeCleanup = serviceRegistry.getRealtimeCleanup();

  try {
    // Notify renderer of shutdown initiation
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-shutdown-initiated', {
        message: 'Application is shutting down...',
        timestamp: new Date().toISOString(),
      });
    }

    // 1. Prepare sync service for shutdown
    if (syncService) {
      console.log('Preparing sync service for shutdown...');

      // Clean up realtime handlers
      if (realtimeCleanup) {
        try {
          await Promise.resolve(realtimeCleanup());
        } catch (e) {
          console.warn('Realtime cleanup error', e);
        }
      }

      await syncService.prepareForShutdown();
    }

    // 2. Stop heartbeat service
    if (heartbeatService) {
      console.log('Stopping heartbeat service...');
      heartbeatService.stop();
    }

    // 3. Stop sync service
    if (syncService) {
      console.log('Stopping sync service...');
      syncService.stopAutoSync();
    }

    // 4. Logout current user
    if (authService) {
      console.log('Logging out current user...');
      await authService.logout();
    }

    // 5. Shutdown PrinterManager
    console.log('Shutting down PrinterManager...');
    try {
      await shutdownPrinterManager();
    } catch (error) {
      console.error('Error shutting down PrinterManager:', error);
      // Don't block shutdown on this error
    }

    // 6. Close database connection with WAL checkpoint
    if (dbManager) {
      console.log('Closing database connection...');
      await dbManager.close();
    }

    // 7. Mark command as completed if commandId provided
    if (commandId && heartbeatService) {
      try {
        await heartbeatService.markCommandCompleted(commandId);
      } catch (error) {
        console.error('Failed to mark command as completed:', error);
        // Don't block shutdown on this error
      }
    }

    // 8. Close all windows
    console.log('Closing all windows...');
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.close();
      }
    });

    console.log('Graceful shutdown complete');
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
    logErrorToFile(error);
  } finally {
    // Set quitting flag and exit
    serviceRegistry.setIsQuitting(true);

    // Force quit after 5 seconds if not already closed
    setTimeout(() => {
      console.log('Force quitting after timeout...');
      app.exit(0);
    }, 5000);

    app.exit(0);
  }
}

/**
 * Graceful restart handler
 * Cleans up all services and restarts the application
 */
export async function gracefulRestart(commandId?: string): Promise<void> {
  console.log('Performing graceful restart...');

  const {
    mainWindow,
    syncService,
    heartbeatService,
    authService,
    dbManager,
  } = serviceRegistry.getAllServices();

  try {
    // Notify renderer of restart initiation
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-restart-initiated', {
        message: 'Application is restarting...',
        timestamp: new Date().toISOString(),
      });
    }

    // 1. Prepare sync service for shutdown
    if (syncService) {
      console.log('Preparing sync service for restart...');
      await syncService.prepareForShutdown();
    }

    // 2. Stop heartbeat service
    if (heartbeatService) {
      console.log('Stopping heartbeat service...');
      heartbeatService.stop();
    }

    // 3. Stop sync service
    if (syncService) {
      console.log('Stopping sync service...');
      syncService.stopAutoSync();
    }

    // 4. Logout current user
    if (authService) {
      console.log('Logging out current user...');
      await authService.logout();
    }

    // 5. Shutdown PrinterManager
    console.log('Shutting down PrinterManager...');
    try {
      await shutdownPrinterManager();
    } catch (error) {
      console.error('Error shutting down PrinterManager:', error);
      // Don't block restart on this error
    }

    // 6. Close database connection with WAL checkpoint
    if (dbManager) {
      console.log('Closing database connection...');
      await dbManager.close();
    }

    // 7. Mark command as completed if commandId provided
    if (commandId && heartbeatService) {
      try {
        await heartbeatService.markCommandCompleted(commandId);
      } catch (error) {
        console.error('Failed to mark command as completed:', error);
        // Don't block restart on this error
      }
    }

    // 8. Close all windows
    console.log('Closing all windows...');
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.close();
      }
    });

    console.log('Graceful restart cleanup complete');
  } catch (error) {
    console.error('Error during graceful restart:', error);
    logErrorToFile(error);
  } finally {
    // Set quitting flag
    serviceRegistry.setIsQuitting(true);
    app.relaunch();
    app.exit(0);
  }
}

/**
 * Handle POS control commands from HeartbeatService
 */
export function handlePosControlCommand({
  type,
  commandId,
}: {
  type: 'shutdown' | 'restart' | 'enable' | 'disable';
  commandId?: string;
}): void {
  console.log('Received POS control command:', type);

  const mainWindow = serviceRegistry.mainWindow;

  switch (type) {
    case 'shutdown':
      gracefulShutdown(commandId);
      break;
    case 'restart':
      gracefulRestart(commandId);
      break;
    case 'disable':
      // Notify renderer to disable terminal
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-disabled', {
          message: 'Terminal has been disabled by admin',
          timestamp: new Date().toISOString(),
        });
      }
      break;
    case 'enable':
      // Notify renderer to enable terminal
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-enabled', {
          message: 'Terminal has been enabled',
          timestamp: new Date().toISOString(),
        });
      }
      break;
    default:
      console.warn('Unknown control command type:', type);
  }
}

/**
 * Before quit event handler
 * Cleans up services before the app quits
 */
export async function handleBeforeQuit(event: Electron.Event): Promise<void> {
  console.log('Application before-quit event triggered');

  // Guard to prevent re-entrant quit loop
  if (serviceRegistry.getIsQuitting()) {
    console.log('Already quitting, allowing quit to proceed');
    return; // Allow quit to proceed
  }

  const {
    syncService,
    heartbeatService,
    authService,
    dbManager,
  } = serviceRegistry.getAllServices();

  try {
    // Prevent immediate quit to allow cleanup
    event.preventDefault();

    // 1. Prepare sync service for shutdown
    if (syncService) {
      console.log('Preparing sync service for shutdown...');
      try {
        await syncService.prepareForShutdown();
      } catch (error) {
        console.error('Error preparing sync service for shutdown:', error);
        logErrorToFile(error);
      }
    }

    // 2. Stop heartbeat service
    if (heartbeatService) {
      console.log('Stopping heartbeat service...');
      try {
        heartbeatService.stop();
      } catch (error) {
        console.error('Error stopping heartbeat service:', error);
        logErrorToFile(error);
      }
    }

    // 3. Stop sync service
    if (syncService) {
      console.log('Stopping sync service...');
      try {
        syncService.stopAutoSync();
      } catch (error) {
        console.error('Error stopping sync service:', error);
        logErrorToFile(error);
      }
    }

    // 4. Logout current user
    if (authService) {
      console.log('Logging out current user...');
      try {
        await authService.logout();
      } catch (error) {
        console.error('Error logging out user:', error);
        logErrorToFile(error);
      }
    }

    // 5. Shutdown PrinterManager
    console.log('Shutting down PrinterManager...');
    try {
      await shutdownPrinterManager();
    } catch (error) {
      console.error('Error shutting down PrinterManager:', error);
      logErrorToFile(error);
    }

    // 6. Close database connection with WAL checkpoint
    if (dbManager) {
      console.log('Closing database connection...');
      try {
        await dbManager.close();
      } catch (error) {
        console.error('Error closing database:', error);
        logErrorToFile(error);
      }
    }

    console.log('App cleanup complete, exiting...');

    // Set quitting flag and exit
    serviceRegistry.setIsQuitting(true);
    app.exit(0);
  } catch (error) {
    console.error('Error during app cleanup:', error);
    logErrorToFile(error);
    serviceRegistry.setIsQuitting(true);
    app.exit(0);
  }
}
