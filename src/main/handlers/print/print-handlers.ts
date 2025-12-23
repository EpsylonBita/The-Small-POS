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
import { ReceiptGenerator } from '../../printer/services/escpos/ReceiptGenerator';
import { ReceiptData, PrintOrderItem, PaperSize, PrintJobType } from '../../printer/types';

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

  /**
   * Print order receipt by order ID
   * Fetches order from database, formats as receipt, and prints
   */
  console.log('[PrintHandlers] ⚡ REGISTERING payment:print-receipt handler');
  ipcMain.handle('payment:print-receipt', async (_event, orderIdOrData: string | any, type = 'customer') => {
    try {
      console.log(`[payment:print-receipt] Printing receipt for order:`, orderIdOrData, `type:`, type);

      const printerManager = getPrinterManagerInstance();
      const db = serviceRegistry.dbManager;

      if (!printerManager) {
        console.error('[payment:print-receipt] PrinterManager not initialized');
        return { success: false, error: 'PrinterManager not initialized' };
      }

      if (!db) {
        console.error('[payment:print-receipt] DatabaseManager not initialized');
        return { success: false, error: 'DatabaseManager not initialized' };
      }

      // Get the first configured receipt printer
      const printers = await printerManager.getPrinters();
      const receiptPrinter = printers.find(p => p.role === 'receipt' && p.enabled) || printers.find(p => p.enabled);

      if (!receiptPrinter) {
        console.error('[payment:print-receipt] No enabled printers configured');
        return { success: false, error: 'No enabled printers configured' };
      }

      console.log(`[payment:print-receipt] Using printer:`, receiptPrinter.id, receiptPrinter.name);

      // Get order ID (handle both string ID and object with id property)
      const orderId = typeof orderIdOrData === 'string' ? orderIdOrData : orderIdOrData?.id || orderIdOrData?.order_id;

      if (!orderId) {
        console.error('[payment:print-receipt] No order ID provided');
        return { success: false, error: 'No order ID provided' };
      }

      // Fetch order from database - try both local ID and Supabase ID
      let order = await db.getOrderById(orderId);
      if (!order) {
        console.log('[payment:print-receipt] Order not found by local ID, trying Supabase ID:', orderId);
        order = await db.getOrderBySupabaseId(orderId);
      }

      if (!order) {
        console.error('[payment:print-receipt] Order not found by either ID:', orderId);
        return { success: false, error: 'Order not found' };
      }

      console.log(`[payment:print-receipt] Order loaded:`, {
        id: order.id,
        orderNumber: order.order_number,
        items: order.items?.length || 0,
        total: order.total_amount
      });

      // Debug: Log the full item structure to see what fields are available
      if (order.items && order.items.length > 0) {
        console.log(`[payment:print-receipt] First item structure:`, JSON.stringify(order.items[0], null, 2));
      }

      // Transform order items to PrintOrderItem format
      const printItems: PrintOrderItem[] = (order.items || []).map((item: any) => {
        const modifiers: any[] = [];

        // Handle customizations
        if (item.customizations) {
          const customizations = typeof item.customizations === 'string'
            ? JSON.parse(item.customizations)
            : item.customizations;

          // Process customizations object
          Object.values(customizations || {}).forEach((custom: any) => {
            if (custom && typeof custom === 'object') {
              const quantity = custom.quantity || 1;
              const name = custom.name || custom.ingredient?.name || 'Unknown';
              const isLittle = custom.isLittle || custom.is_little;
              // Get price from ingredient
              const price = order.order_type === 'delivery'
                ? custom.ingredient?.delivery_price
                : custom.ingredient?.pickup_price || custom.ingredient?.price;

              let modName = name;
              if (isLittle) modName += ' (λίγο)';

              modifiers.push({
                name: modName,
                quantity: quantity > 1 ? quantity : undefined,
                price: price || undefined
              });
            }
          });
        }

        // Try multiple ways to get the item name
        let itemName = item.name || item.item_name || item.product_name;

        // If still no name, try to get from menu_item data if embedded
        if (!itemName && item.menu_item) {
          itemName = item.menu_item.name || item.menu_item.item_name;
        }

        // Last resort: use menu_item_id or 'Item'
        if (!itemName) {
          itemName = item.menu_item_id ? `Item ${item.menu_item_id.substring(0, 8)}` : 'Item';
        }

        return {
          name: itemName,
          quantity: item.quantity || 1,
          unitPrice: item.unit_price || item.price || 0,
          total: item.total_price || (item.price * item.quantity) || 0,
          modifiers: modifiers.length > 0 ? modifiers : undefined,
          specialInstructions: item.notes || item.special_instructions || undefined
        };
      });

      // Map order type to receipt format
      let orderType: 'dine-in' | 'takeout' | 'delivery' = 'takeout';
      if (order.order_type === 'dine-in' || order.order_type === 'delivery') {
        orderType = order.order_type;
      }

      // Build receipt data
      const receiptData: ReceiptData = {
        orderNumber: order.order_number || order.id.substring(0, 8),
        orderType: orderType,
        timestamp: new Date(order.created_at || new Date()),
        items: printItems,
        subtotal: order.subtotal || 0,
        tax: (order as any).tax || 0,
        tip: (order as any).tip || 0,
        deliveryFee: order.delivery_fee || 0,
        total: order.total_amount || 0,
        paymentMethod: order.payment_method || 'cash',
        customerName: order.customer_name || undefined,
        customerPhone: order.customer_phone || undefined,
        deliveryAddress: order.delivery_address || undefined,
        tableName: order.table_number || undefined
      };

      console.log(`[payment:print-receipt] Receipt data prepared:`, {
        orderNumber: receiptData.orderNumber,
        itemCount: receiptData.items.length,
        total: receiptData.total
      });

      // Generate receipt buffer
      const generator = new ReceiptGenerator({
        paperSize: receiptPrinter.paperSize || PaperSize.MM_80,
        storeName: 'The Small',
        currency: '€'
      });

      const receiptBuffer = generator.generateReceipt(receiptData);
      console.log(`[payment:print-receipt] Receipt buffer generated:`, receiptBuffer.length, 'bytes');

      // Submit print job
      const jobResult = await printerManager.submitPrintJob({
        id: `receipt-${orderId}-${Date.now()}`,
        type: PrintJobType.RECEIPT,
        data: receiptData,
        priority: 2,
        createdAt: new Date()
      });

      console.log(`[payment:print-receipt] Print job submitted:`, jobResult);

      return { success: jobResult.success, error: jobResult.error };
    } catch (error) {
      console.error('[payment:print-receipt] Error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to print receipt' };
    }
  });

  console.log('[PrintHandlers] Print IPC handlers registered');
}
