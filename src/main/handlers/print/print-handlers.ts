/**
 * Print IPC Handlers
 * Handles print-related IPC communication between renderer and main process
 *
 * This module integrates with PrinterManager for advanced printer management
 * while maintaining backward compatibility with legacy PrintService.
 *
 * Requirements: All (1.1-10.5)
 */

import { ipcMain } from 'electron';
import { PrintService } from '../../services/PrintService';
import { getPrinterManagerInstance } from '../printer-manager-handlers';
import { serviceRegistry } from '../../service-registry';

// Import PrinterManager type for updatePrintServiceWithPrinterManager
import type { PrinterManager } from '../../printer/services/PrinterManager';

// Module-level PrintService instance
let printService: PrintService | null = null;

/**
 * Update the PrintService instance with a new PrinterManager reference
 * This is called by printer-manager-handlers when PrinterManager is initialized or shutdown
 *
 * @param printerManager - The PrinterManager instance or null to clear
 */
export function updatePrintServiceWithPrinterManager(printerManager: PrinterManager | null): void {
  if (printService) {
    printService.setPrinterManager(printerManager);
    console.log(`[PrintHandlers] PrinterManager reference ${printerManager ? 'updated' : 'cleared'}`);
  }
}

/**
 * Register print handlers with PrinterManager integration
 */
export function registerPrintHandlers() {
  const dbManager = serviceRegistry.dbManager;
  if (!dbManager) {
    console.error('[PrintHandlers] DatabaseManager not initialized');
    return;
  }

  printService = new PrintService(dbManager.db);

  // Wire up PrinterManager if available
  const printerManager = getPrinterManagerInstance();
  if (printerManager) {
    printService.setPrinterManager(printerManager);
    console.log('[PrintHandlers] PrinterManager integration enabled');
  }

  /**
   * Print checkout receipt for a shift
   *
   * Uses PrinterManager for job routing when available.
   * Requirements: 2.4, 9.2
   */
  ipcMain.handle('shift:print-checkout', async (_event, { shiftId, roleType, terminalName }) => {
    try {
      console.log(`[shift:print-checkout] Printing checkout for shift ${shiftId}, role: ${roleType}`);

      // Ensure PrintService has latest PrinterManager reference
      const currentPrinterManager = getPrinterManagerInstance();
      if (printService && currentPrinterManager) {
        printService.setPrinterManager(currentPrinterManager);
      }

      if (!printService) {
        return { success: false, error: 'PrintService not initialized' };
      }

      const result = await printService.printCheckout(shiftId, roleType, terminalName);
      return result;
    } catch (error) {
      console.error('[shift:print-checkout] Error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to print checkout' };
    }
  });

  /**
   * Test Print - simple sample to validate printer configuration
   *
   * Uses PrinterManager.testPrint() when a specific printer is configured,
   * otherwise falls back to legacy PrintService test print.
   *
   * Requirements: 10.1, 10.2
   */
  ipcMain.handle('printer:test-print', async (_event, printerId?: string) => {
    try {
      // If a specific printer ID is provided, use PrinterManager directly
      const printerManager = getPrinterManagerInstance();
      if (printerId && printerManager) {
        console.log(`[printer:test-print] Using PrinterManager for printer ${printerId}`);
        const result = await printerManager.testPrint(printerId);
        return result;
      }

      // Otherwise, use PrintService (which may route through PrinterManager)
      if (!printService) {
        return { success: false, error: 'PrintService not initialized' };
      }

      // Ensure PrintService has latest PrinterManager reference
      if (printerManager) {
        printService.setPrinterManager(printerManager);
      }

      const result = await printService.printTestReceipt();
      return result;
    } catch (error) {
      console.error('[printer:test-print] Error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to print test receipt' };
    }
  });

  console.log('[PrintHandlers] Print IPC handlers registered');
}
