/**
 * Printer Manager IPC Handlers
 *
 * Handles all printer-related IPC communication between renderer and main process.
 * Provides comprehensive printer management including discovery, configuration,
 * job submission, status monitoring, and diagnostics.
 *
 * @module handlers/printer-manager-handlers
 *
 * Requirements: All (1.1-10.5)
 */

import { ipcMain, BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import {
  PrinterManager,
  PrinterManagerEvent,
} from '../printer/services/PrinterManager';
import type {
  PrinterConfig,
  PrinterType,
  PrinterStatus,
  PrintJob,
} from '../printer/types';
import { serviceRegistry } from '../service-registry';

// Lazy-loaded print handlers module reference
let printHandlersModule: typeof import('./print/print-handlers') | null = null;

/**
 * Get the print handlers module (lazy loaded to avoid circular dependencies)
 */
async function getPrintHandlersModule(): Promise<typeof import('./print/print-handlers') | null> {
  if (printHandlersModule) return printHandlersModule;
  try {
    // Use require for CommonJS compatibility in Electron main process
    printHandlersModule = require('./print/print-handlers');
    return printHandlersModule;
  } catch (error) {
    console.warn('[PrinterManagerHandlers] Could not load print-handlers module:', error);
    return null;
  }
}

// Module-level PrinterManager instance
let printerManager: PrinterManager | null = null;

/**
 * IPC Channel names for printer operations
 */
export const PRINTER_IPC_CHANNELS = {
  // Discovery
  DISCOVER: 'printer:discover',

  // Configuration CRUD
  ADD: 'printer:add',
  UPDATE: 'printer:update',
  REMOVE: 'printer:remove',
  GET_ALL: 'printer:get-all',
  GET_ONE: 'printer:get',

  // Status
  GET_STATUS: 'printer:get-status',
  GET_ALL_STATUSES: 'printer:get-all-statuses',
  STATUS_CHANGED: 'printer:status-changed',

  // Job management
  SUBMIT_JOB: 'printer:submit-job',
  CANCEL_JOB: 'printer:cancel-job',
  RETRY_JOB: 'printer:retry-job',

  // Testing and diagnostics
  TEST: 'printer:test',
  DIAGNOSTICS: 'printer:diagnostics',
  
  // Bluetooth status
  BLUETOOTH_STATUS: 'printer:bluetooth-status',

  // Cash drawer
  OPEN_CASH_DRAWER: 'printer:open-cash-drawer',
} as const;

/**
 * Get the PrinterManager instance
 * @throws Error if PrinterManager is not initialized
 */
function getPrinterManager(): PrinterManager {
  if (!printerManager) {
    throw new Error('PrinterManager not initialized. Call initializePrinterManager first.');
  }
  return printerManager;
}

/**
 * Initialize the PrinterManager instance
 * Should be called during app initialization after database is ready
 *
 * @param db - The SQLite database instance
 * @param mainWindow - Optional main window for status event forwarding
 * @returns The initialized PrinterManager instance
 *
 * Requirements: 6.5, 7.4
 */
export async function initializePrinterManager(
  db: Database.Database,
  mainWindow?: BrowserWindow
): Promise<PrinterManager> {
  if (printerManager) {
    console.log('[PrinterManagerHandlers] PrinterManager already initialized');
    return printerManager;
  }

  console.log('[PrinterManagerHandlers] Initializing PrinterManager...');

  printerManager = new PrinterManager(db, {
    autoStartProcessing: true,
    autoConnect: true,
  });

  // Initialize the manager (loads configs, resumes pending jobs)
  await printerManager.initialize();

  // Wire up status change events to renderer if mainWindow provided
  if (mainWindow) {
    setupStatusEventForwarding(mainWindow);
  }

  // Wire up PrinterManager with SettingsService for export/import integration
  // Requirements: 8.5
  const settingsService = serviceRegistry.settingsService;
  if (settingsService) {
    settingsService.setPrinterManager(printerManager);
    console.log('[PrinterManagerHandlers] PrinterManager wired to SettingsService for export/import');
  }

  // Wire up PrinterManager with PrintService for print job routing
  // Requirements: 2.4, 9.2
  const printHandlers = await getPrintHandlersModule();
  if (printHandlers?.updatePrintServiceWithPrinterManager) {
    printHandlers.updatePrintServiceWithPrinterManager(printerManager);
    console.log('[PrinterManagerHandlers] PrinterManager wired to PrintService for job routing');
  }

  // Register PrinterManager in service registry
  serviceRegistry.register('printerManager', printerManager);

  console.log('[PrinterManagerHandlers] PrinterManager initialized successfully');
  return printerManager;
}

/**
 * Set up status event forwarding to renderer process
 *
 * @param mainWindow - The main BrowserWindow instance
 *
 * Requirements: 7.4
 */
export function setupStatusEventForwarding(mainWindow: BrowserWindow): void {
  if (!printerManager) {
    console.warn('[PrinterManagerHandlers] Cannot setup event forwarding - PrinterManager not initialized');
    return;
  }

  // Forward printer status changes to renderer
  printerManager.on(
    PrinterManagerEvent.PRINTER_STATUS_CHANGED,
    (printerId: string, status: PrinterStatus) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(PRINTER_IPC_CHANNELS.STATUS_CHANGED, {
          printerId,
          status,
        });
      }
    }
  );

  console.log('[PrinterManagerHandlers] Status event forwarding configured');
}

/**
 * Shutdown the PrinterManager
 * Should be called during app shutdown
 */
export async function shutdownPrinterManager(): Promise<void> {
  if (printerManager) {
    console.log('[PrinterManagerHandlers] Shutting down PrinterManager...');
    
    // Clear PrinterManager reference from SettingsService
    const settingsService = serviceRegistry.settingsService;
    if (settingsService) {
      settingsService.setPrinterManager(null);
    }
    
    // Clear PrinterManager reference from PrintService
    // Requirements: 2.4, 9.2
    const printHandlers = await getPrintHandlersModule();
    if (printHandlers?.updatePrintServiceWithPrinterManager) {
      printHandlers.updatePrintServiceWithPrinterManager(null);
    }
    
    // Clear from service registry
    serviceRegistry.register('printerManager', null);
    
    await printerManager.shutdown();
    printerManager = null;
    console.log('[PrinterManagerHandlers] PrinterManager shutdown complete');
  }
}

/**
 * Register all printer manager IPC handlers
 *
 * @param db - The SQLite database instance (used if PrinterManager not yet initialized)
 *
 * Requirements: All
 */
export function registerPrinterManagerHandlers(db?: Database.Database): void {
  console.log('[PrinterManagerHandlers] Registering IPC handlers...');

  // =========================================================================
  // Discovery Handler
  // =========================================================================

  /**
   * Discover available printers
   * @param types - Optional array of printer types to discover
   * @returns Array of discovered printers
   *
   * Requirements: 1.1, 1.2, 1.3, 1.4
   */
  ipcMain.handle(
    PRINTER_IPC_CHANNELS.DISCOVER,
    async (_event, types?: PrinterType[]) => {
      try {
        const manager = getPrinterManager();
        const printers = await manager.discoverPrinters(types);
        return { success: true, printers };
      } catch (error) {
        console.error('[printer:discover] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Discovery failed',
          printers: [],
        };
      }
    }
  );

  // =========================================================================
  // Configuration CRUD Handlers
  // =========================================================================

  /**
   * Add a new printer configuration
   * @param config - Printer configuration (without id, createdAt, updatedAt)
   * @returns The saved printer configuration
   *
   * Requirements: 8.1
   */
  ipcMain.handle(
    PRINTER_IPC_CHANNELS.ADD,
    async (_event, config: Omit<PrinterConfig, 'id' | 'createdAt' | 'updatedAt'>) => {
      try {
        const manager = getPrinterManager();
        const savedConfig = await manager.addPrinter(config);
        return { success: true, printer: savedConfig };
      } catch (error) {
        console.error('[printer:add] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to add printer',
        };
      }
    }
  );

  /**
   * Update an existing printer configuration
   * @param printerId - The printer ID to update
   * @param updates - Partial configuration updates
   * @returns The updated printer configuration
   *
   * Requirements: 8.3
   */
  ipcMain.handle(
    PRINTER_IPC_CHANNELS.UPDATE,
    async (
      _event,
      printerId: string,
      updates: Partial<Omit<PrinterConfig, 'id' | 'createdAt'>>
    ) => {
      try {
        console.log('[printer:update] Updating printer:', printerId);
        console.log('[printer:update] Updates received:', JSON.stringify(updates, null, 2));
        console.log('[printer:update] receiptTemplate in updates:', updates.receiptTemplate);
        
        const manager = getPrinterManager();
        const updatedConfig = await manager.updatePrinter(printerId, updates);
        
        console.log('[printer:update] Updated config receiptTemplate:', updatedConfig.receiptTemplate);
        return { success: true, printer: updatedConfig };
      } catch (error) {
        console.error('[printer:update] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update printer',
        };
      }
    }
  );

  /**
   * Remove a printer configuration
   * @param printerId - The printer ID to remove
   * @returns Success status
   *
   * Requirements: 8.4
   */
  ipcMain.handle(
    PRINTER_IPC_CHANNELS.REMOVE,
    async (_event, printerId: string) => {
      try {
        const manager = getPrinterManager();
        const removed = await manager.removePrinter(printerId);
        return { success: removed };
      } catch (error) {
        console.error('[printer:remove] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to remove printer',
        };
      }
    }
  );

  /**
   * Get all printer configurations
   * @returns Array of all printer configurations
   *
   * Requirements: 8.2
   */
  ipcMain.handle(PRINTER_IPC_CHANNELS.GET_ALL, async () => {
    try {
      const manager = getPrinterManager();
      const printers = manager.getPrinters();
      return { success: true, printers };
    } catch (error) {
      console.error('[printer:get-all] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get printers',
        printers: [],
      };
    }
  });

  // =========================================================================
  // Status Handlers
  // =========================================================================

  /**
   * Get the status of a specific printer
   * @param printerId - The printer ID
   * @returns The printer status
   *
   * Requirements: 7.1, 7.2
   */
  ipcMain.handle(
    PRINTER_IPC_CHANNELS.GET_STATUS,
    async (_event, printerId: string) => {
      try {
        const manager = getPrinterManager();
        const status = manager.getPrinterStatus(printerId);
        if (!status) {
          return { success: false, error: 'Printer not found' };
        }
        return { success: true, status };
      } catch (error) {
        console.error('[printer:get-status] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get printer status',
        };
      }
    }
  );

  /**
   * Get all printer statuses
   * @returns Map of printer IDs to their statuses (as object)
   *
   * Requirements: 7.5
   */
  ipcMain.handle(PRINTER_IPC_CHANNELS.GET_ALL_STATUSES, async () => {
    try {
      const manager = getPrinterManager();
      const statusMap = manager.getAllPrinterStatuses();
      // Convert Map to plain object for IPC serialization
      const statuses: Record<string, PrinterStatus> = {};
      statusMap.forEach((status, printerId) => {
        statuses[printerId] = status;
      });
      return { success: true, statuses };
    } catch (error) {
      console.error('[printer:get-all-statuses] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get printer statuses',
        statuses: {},
      };
    }
  });

  // =========================================================================
  // Job Management Handlers
  // =========================================================================

  /**
   * Submit a print job
   * @param job - The print job to submit
   * @returns The result of job submission
   *
   * Requirements: 6.1, 6.2, 9.2
   */
  ipcMain.handle(
    PRINTER_IPC_CHANNELS.SUBMIT_JOB,
    async (_event, job: PrintJob) => {
      try {
        const manager = getPrinterManager();
        const result = await manager.submitPrintJob(job);
        return result;
      } catch (error) {
        console.error('[printer:submit-job] Error:', error);
        return {
          success: false,
          jobId: job.id || '',
          error: error instanceof Error ? error.message : 'Failed to submit print job',
        };
      }
    }
  );

  /**
   * Cancel a print job
   * @param jobId - The job ID to cancel
   * @returns Success status
   *
   * Requirements: 6.4
   */
  ipcMain.handle(
    PRINTER_IPC_CHANNELS.CANCEL_JOB,
    async (_event, jobId: string) => {
      try {
        const manager = getPrinterManager();
        const cancelled = await manager.cancelPrintJob(jobId);
        return { success: cancelled };
      } catch (error) {
        console.error('[printer:cancel-job] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to cancel print job',
        };
      }
    }
  );

  /**
   * Retry a failed print job
   * @param jobId - The job ID to retry
   * @returns The result of the retry
   *
   * Requirements: 6.3
   */
  ipcMain.handle(
    PRINTER_IPC_CHANNELS.RETRY_JOB,
    async (_event, jobId: string) => {
      try {
        const manager = getPrinterManager();
        const result = await manager.retryPrintJob(jobId);
        return result;
      } catch (error) {
        console.error('[printer:retry-job] Error:', error);
        return {
          success: false,
          jobId,
          error: error instanceof Error ? error.message : 'Failed to retry print job',
        };
      }
    }
  );

  // =========================================================================
  // Testing and Diagnostics Handlers
  // =========================================================================

  /**
   * Send a test print to a printer
   * @param printerId - The printer ID
   * @returns The test print result
   *
   * Requirements: 10.1, 10.2
   */
  ipcMain.handle(
    PRINTER_IPC_CHANNELS.TEST,
    async (_event, printerId: string) => {
      try {
        const manager = getPrinterManager();
        const result = await manager.testPrint(printerId);
        return result;
      } catch (error) {
        console.error('[printer:test] Error:', error);
        return {
          success: false,
          printerId,
          error: error instanceof Error ? error.message : 'Test print failed',
        };
      }
    }
  );

  /**
   * Get diagnostics for a printer
   * @param printerId - The printer ID
   * @returns Printer diagnostics
   *
   * Requirements: 10.2, 10.4, 10.5
   */
  ipcMain.handle(
    PRINTER_IPC_CHANNELS.DIAGNOSTICS,
    async (_event, printerId: string) => {
      try {
        const manager = getPrinterManager();
        const diagnostics = await manager.getDiagnostics(printerId);
        return { success: true, diagnostics };
      } catch (error) {
        console.error('[printer:diagnostics] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get diagnostics',
        };
      }
    }
  );

  /**
   * Get Bluetooth availability status
   * @returns Bluetooth availability and any error message
   *
   * Requirements: 1.2
   */
  ipcMain.handle(
    PRINTER_IPC_CHANNELS.BLUETOOTH_STATUS,
    async () => {
      try {
        const manager = getPrinterManager();
        const status = await manager.getBluetoothStatus();
        return { success: true, ...status };
      } catch (error) {
        console.error('[printer:bluetooth-status] Error:', error);
        return {
          success: false,
          available: false,
          error: error instanceof Error ? error.message : 'Failed to get Bluetooth status',
        };
      }
    }
  );

  // =========================================================================
  // Cash Drawer Handler
  // =========================================================================

  /**
   * Open cash drawer connected to a receipt printer
   * @param printerId - Optional printer ID (uses default if not specified)
   * @param drawerNumber - Optional drawer number (1 or 2, default 1)
   * @returns Success status
   */
  ipcMain.handle(
    PRINTER_IPC_CHANNELS.OPEN_CASH_DRAWER,
    async (_event, printerId?: string, drawerNumber?: 1 | 2) => {
      try {
        const manager = getPrinterManager();
        await manager.openCashDrawer(printerId, drawerNumber);
        return { success: true };
      } catch (error) {
        console.error('[printer:open-cash-drawer] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to open cash drawer',
        };
      }
    }
  );

  console.log('[PrinterManagerHandlers] IPC handlers registered successfully');
}

/**
 * Get the current PrinterManager instance (for use by other services)
 * @returns The PrinterManager instance or null if not initialized
 */
export function getPrinterManagerInstance(): PrinterManager | null {
  return printerManager;
}
