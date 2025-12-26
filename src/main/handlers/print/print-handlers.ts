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
import { EscPosBuilder } from '../../printer/services/escpos/EscPosBuilder';
import { ReceiptData, PrintOrderItem, PaperSize, PrintJobType, ReceiptTemplate } from '../../printer/types';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from '../../../shared/supabase-config';

// Import PrinterManager type for updatePrintServiceWithPrinterManager
import type { PrinterManager } from '../../printer/services/PrinterManager';
import type { DatabaseManager } from '../../database';

// Module-level PrintService instance
let printService: PrintService | null = null;

/**
 * Resolve item name from multiple sources with fallback chain:
 * 1. Direct name fields (name, item_name, product_name)
 * 2. Embedded menu_item data
 * 3. Local subcategories cache
 * 4. Supabase subcategories table (last resort)
 * 5. Fallback to "Item {id}" or "Unknown Item"
 */
async function resolveItemName(
  item: any,
  dbManager: DatabaseManager | null,
  supabaseClient?: any
): Promise<string> {
  // 1. Try direct name fields
  if (item.name && typeof item.name === 'string' && item.name.trim()) {
    return item.name;
  }
  if (item.item_name && typeof item.item_name === 'string' && item.item_name.trim()) {
    return item.item_name;
  }
  if (item.product_name && typeof item.product_name === 'string' && item.product_name.trim()) {
    return item.product_name;
  }

  // 2. Try embedded menu_item data
  if (item.menu_item) {
    if (item.menu_item.name && typeof item.menu_item.name === 'string' && item.menu_item.name.trim()) {
      return item.menu_item.name;
    }
    if (item.menu_item.item_name && typeof item.menu_item.item_name === 'string') {
      return item.menu_item.item_name;
    }
  }

  // 3. Try local cache if we have menu_item_id
  if (item.menu_item_id && dbManager) {
    try {
      const cached = dbManager.getSubcategoryFromCache(item.menu_item_id);
      if (cached) {
        const cachedName = cached.name || cached.name_en || cached.name_el;
        if (cachedName) {
          console.log(`[resolveItemName] Found name in cache for ${item.menu_item_id}: ${cachedName}`);
          return cachedName;
        }
      }
    } catch (cacheError) {
      console.warn('[resolveItemName] Cache lookup failed:', cacheError);
    }
  }

  // 4. Try Supabase as last resort
  if (item.menu_item_id && supabaseClient) {
    try {
      const { data: subcategory, error } = await supabaseClient
        .from('subcategories')
        .select('id, name, name_en, name_el')
        .eq('id', item.menu_item_id)
        .single();

      if (!error && subcategory) {
        const supabaseName = subcategory.name || subcategory.name_en || subcategory.name_el;
        if (supabaseName) {
          console.log(`[resolveItemName] Found name in Supabase for ${item.menu_item_id}: ${supabaseName}`);
          // Cache for future use
          if (dbManager) {
            try {
              dbManager.cacheSubcategory(
                subcategory.id,
                subcategory.name || '',
                subcategory.name_en,
                subcategory.name_el
              );
            } catch (cacheErr) {
              console.warn('[resolveItemName] Failed to cache subcategory:', cacheErr);
            }
          }
          return supabaseName;
        }
      }
    } catch (supabaseError) {
      console.warn('[resolveItemName] Supabase lookup failed:', supabaseError);
    }
  }

  // 5. Final fallback
  if (item.menu_item_id) {
    console.warn(`[resolveItemName] Could not resolve name for menu_item_id: ${item.menu_item_id}`);
    return `Item ${item.menu_item_id.substring(0, 8)}`;
  }

  console.warn('[resolveItemName] Item has no name and no menu_item_id');
  return 'Unknown Item';
}

/**
 * Create a Supabase client for item name resolution
 */
function createSupabaseClientForNameResolution(): any {
  try {
    const config = getSupabaseConfig('server');
    return createClient(config.url, config.serviceRoleKey || config.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  } catch (error) {
    console.warn('[createSupabaseClientForNameResolution] Failed to create client:', error);
    return null;
  }
}

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
   * Print Z-Report receipt
   *
   * Uses PrinterManager for job routing when available.
   * Requirements: 2.4, 9.2
   */
  ipcMain.handle('report:print-z-report', async (_event, { snapshot, terminalName }) => {
    try {
      console.log('[report:print-z-report] Printing Z-Report');

      // Ensure PrintService has latest PrinterManager reference
      const currentPrinterManager = getPrinterManagerInstance();
      if (printService && currentPrinterManager) {
        printService.setPrinterManager(currentPrinterManager);
      }

      if (!printService) {
        return { success: false, error: 'PrintService not initialized' };
      }

      const result = await printService.printZReport(snapshot, terminalName);
      console.log('[report:print-z-report] Print result:', result);
      return result;
    } catch (error) {
      console.error('[report:print-z-report] Error:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to print Z-Report' };
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
  console.log('[PrintHandlers] REGISTERING payment:print-receipt handler');
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
      const printers = printerManager.getPrinters();
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

      // Create Supabase client for name resolution fallback
      const supabaseClient = createSupabaseClientForNameResolution();

      // Transform order items to PrintOrderItem format with enhanced name resolution
      const printItems: PrintOrderItem[] = await Promise.all((order.items || []).map(async (item: any) => {
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
              if (isLittle) modName += ' (little)';

              modifiers.push({
                name: modName,
                quantity: quantity > 1 ? quantity : undefined,
                price: price || undefined
              });
            }
          });
        }

        // Use enhanced name resolution with cache and Supabase fallback
        const itemName = await resolveItemName(item, db, supabaseClient);

        return {
          name: itemName,
          quantity: item.quantity || 1,
          unitPrice: item.unit_price || item.price || 0,
          total: item.total_price || (item.price * item.quantity) || 0,
          modifiers: modifiers.length > 0 ? modifiers : undefined,
          specialInstructions: item.notes || item.special_instructions || undefined
        };
      }));

      // Map order type to receipt format
      let orderType: 'dine-in' | 'pickup' | 'delivery' = 'pickup';
      if (order.order_type === 'dine-in' || order.order_type === 'delivery') {
        orderType = order.order_type;
      }

      // Fetch ringer name and delivery notes from customer if this is a delivery order
      // First try to use the values stored in the order itself
      let ringerName: string | undefined = (order as any).name_on_ringer || undefined;
      let deliveryNotes: string | undefined = (order as any).delivery_notes || undefined;

      console.log(`[payment:print-receipt] Initial values from order:`, {
        ringerName,
        deliveryNotes,
        orderType,
        customerPhone: order.customer_phone,
        deliveryAddress: order.delivery_address
      });

      // If not available in order, try to fetch from customer/address (fallback for older orders)
      if (orderType === 'delivery' && order.customer_phone && supabaseClient && (!ringerName || !deliveryNotes)) {
        console.log(`[payment:print-receipt] Fetching from Supabase (ringerName: ${ringerName}, deliveryNotes: ${deliveryNotes})`);
        try {
          // First get the customer with ringer_name
          const { data: customer, error: customerError } = await supabaseClient
            .from('customers')
            .select('id, ringer_name, name_on_ringer')
            .eq('phone', order.customer_phone)
            .single();

          console.log(`[payment:print-receipt] Customer query result:`, { customer, customerError });

          if (!ringerName && (customer?.ringer_name || customer?.name_on_ringer)) {
            ringerName = customer.ringer_name || customer.name_on_ringer;
            console.log(`[payment:print-receipt] Found ringer name from customer: ${ringerName}`);
          }

          // Then try to find the matching address to get notes
          if (customer?.id && order.delivery_address && !deliveryNotes) {
            // Try to match by street address
            const deliveryStreet = order.delivery_address.split(',')[0]?.trim();
            console.log(`[payment:print-receipt] Looking for address with street: ${deliveryStreet}`);
            if (deliveryStreet) {
              const { data: addresses, error: addressError } = await supabaseClient
                .from('customer_addresses')
                .select('notes, name_on_ringer')
                .eq('customer_id', customer.id)
                .ilike('street_address', `%${deliveryStreet}%`)
                .limit(1);

              console.log(`[payment:print-receipt] Address query result:`, { addresses, addressError });

              if (addresses && addresses.length > 0) {
                const addr = addresses[0];
                if (!deliveryNotes && addr.notes) {
                  deliveryNotes = addr.notes;
                  console.log(`[payment:print-receipt] Found delivery notes from address: ${deliveryNotes}`);
                }
                // Address-level name_on_ringer takes precedence over customer-level
                if (!ringerName && addr.name_on_ringer) {
                  ringerName = addr.name_on_ringer;
                  console.log(`[payment:print-receipt] Found address ringer name: ${ringerName}`);
                }
              }
            }
          }
        } catch (err) {
          console.warn('[payment:print-receipt] Could not fetch customer/address details:', err);
        }
      }

      if (ringerName) {
        console.log(`[payment:print-receipt] Using ringer name: ${ringerName}`);
      }
      if (deliveryNotes) {
        console.log(`[payment:print-receipt] Using delivery notes: ${deliveryNotes}`);
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
        deliveryNotes: deliveryNotes,
        ringerName: ringerName,
        tableName: order.table_number || undefined
      };

      console.log(`[payment:print-receipt] Receipt data prepared:`, {
        orderNumber: receiptData.orderNumber,
        itemCount: receiptData.items.length,
        total: receiptData.total
      });

      // Get current language and currency from settings
      // Currency is stored in 'restaurant' settings category, with fallback to 'terminal' for backward compatibility
      const settingsService = serviceRegistry.settingsService;
      const language = settingsService ? settingsService.getLanguage() : 'en';
      const currency = settingsService
        ? (settingsService.getSetting('restaurant', 'currency', '€') || settingsService.getSetting('terminal', 'currency', '€'))
        : '€';

      // Get the printer's character set, default to Greek if language is Greek
      let characterSet = receiptPrinter.characterSet || 'PC437_USA';
      if (language === 'el' && characterSet === 'PC437_USA') {
        characterSet = 'PC737_GREEK';
      }

      // Get Greek render mode from printer config
      const greekRenderMode = receiptPrinter.greekRenderMode || 'text';
      console.log(`[payment:print-receipt] Greek render mode: ${greekRenderMode}`);

      // Get receipt template from printer config
      const receiptTemplate = receiptPrinter.receiptTemplate || 'classic';
      console.log(`[payment:print-receipt] Receipt template: ${receiptTemplate}`);
      console.log(`[payment:print-receipt] Printer config receiptTemplate raw value: ${receiptPrinter.receiptTemplate}`);
      console.log(`[payment:print-receipt] Full printer config:`, JSON.stringify({
        id: receiptPrinter.id,
        name: receiptPrinter.name,
        greekRenderMode: receiptPrinter.greekRenderMode,
        receiptTemplate: receiptPrinter.receiptTemplate
      }));

      // Generate receipt buffer
      const generator = new ReceiptGenerator({
        paperSize: receiptPrinter.paperSize || PaperSize.MM_80,
        storeName: 'The Small',
        currency: currency as string,
        language: language,
        characterSet: characterSet as any,
        greekRenderMode: greekRenderMode,
        receiptTemplate: receiptTemplate
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

  /**
   * Direct COM port Greek test print
   * Tests different encoding approaches to find what works
   * 
   * Usage from DevTools console:
   *   window.electronAPI.printerTestGreekDirect('ascii')           // ASCII only test
   *   window.electronAPI.printerTestGreekDirect('cp737')           // CP737 Greek encoding
   *   window.electronAPI.printerTestGreekDirect('cp1253')          // Windows-1253 Greek
   *   window.electronAPI.printerTestGreekDirect('utf8')            // UTF-8 (default)
   *   window.electronAPI.printerTestGreekDirect('ascii', 'POS-80') // Specify printer name
   */
  ipcMain.handle('printer:test-greek-direct', async (_event, testMode?: string, printerNameArg?: string) => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const { execSync } = await import('child_process');

    try {
      const mode = testMode || 'ascii';  // Default to ASCII for baseline test
      const printerName = printerNameArg || 'POS-80';  // Default to POS-80 (has Greek charset)
      console.log(`[printer:test-greek-direct] Testing mode: ${mode}, printer: ${printerName}`);

      // Write to temp file
      const tempDir = path.join(os.tmpdir(), 'pos-greek-test');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempFile = path.join(tempDir, `greek-test-${Date.now()}.prn`);

      let buffer: Buffer;

      if (mode === 'utf8') {
        // Test 1: Send UTF-8 encoded text directly
        // Some printers can handle UTF-8 if configured properly
        const text = `
================================================
           ΔΟΚΙΜΗ ΕΛΛΗΝΙΚΩΝ (UTF-8)
================================================

Ευχαριστούμε για την παραγγελία σας!
Καλή σας μέρα!

Αριθμός: #12345
Σύνολο: €25.50

Test ASCII: ABCDEFGHIJKLMNOP
Numbers: 1234567890

================================================


`;
        buffer = Buffer.from(text, 'utf8');

      } else if (mode === 'cp737') {
        // Test 2: Use our CP737 encoding with code page 14
        const builder = new EscPosBuilder(PaperSize.MM_80, 'PC737_GREEK');

        builder.initialize();
        builder.raw([0x1B, 0x74, 14]);  // ESC t 14 - CP737
        builder.enableGreekEncoding();
        builder.setCharacterSetType('PC737_GREEK');

        builder
          .alignCenter()
          .doubleLine()
          .bold(true)
          .textLine('ΔΟΚΙΜΗ ΕΛΛΗΝΙΚΩΝ (CP737)')
          .bold(false)
          .doubleLine()
          .alignLeft()
          .textLine('Ευχαριστούμε!')
          .textLine('Test: ABCDEFGHIJKLMNOP')
          .emptyLines(3)
          .cut();

        buffer = builder.build();

      } else if (mode === 'cp737-17') {
        // Test: CP737 with code page 17 (some printers use this)
        const builder = new EscPosBuilder(PaperSize.MM_80, 'PC737_GREEK');

        builder.initialize();
        builder.raw([0x1B, 0x74, 17]);  // ESC t 17 - Try code page 17
        builder.enableGreekEncoding();
        builder.setCharacterSetType('PC737_GREEK');

        builder
          .alignCenter()
          .doubleLine()
          .bold(true)
          .textLine('ΔΟΚΙΜΗ (CP737 page 17)')
          .bold(false)
          .doubleLine()
          .alignLeft()
          .textLine('Ευχαριστούμε!')
          .textLine('Test: ABCDEFGHIJKLMNOP')
          .emptyLines(3)
          .cut();

        buffer = builder.build();

      } else if (mode === 'cp737-66') {
        // Test: CP66 Greek encoding for Netum/Chinese printers
        const builder = new EscPosBuilder(PaperSize.MM_80, 'CP66_GREEK');

        builder.initialize();
        builder.raw([0x1B, 0x74, 66]);  // ESC t 66 - Select code page 66
        builder.enableGreekEncoding();
        builder.setCharacterSetType('CP66_GREEK');

        builder
          .alignCenter()
          .doubleLine()
          .bold(true)
          .textLine('ΔΟΚΙΜΗ ΕΛΛΗΝΙΚΩΝ')
          .bold(false)
          .doubleLine()
          .alignLeft()
          .textLine('Ευχαριστούμε για την')
          .textLine('παραγγελία σας!')
          .emptyLine()
          .textLine('Uppercase: ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ')
          .textLine('Lowercase: αβγδεζηθικλμνξοπρστυφχψω')
          .emptyLine()
          .textLine('Test: ABCDEFGHIJKLMNOP')
          .textLine('Numbers: 1234567890')
          .textLine('Euro: € Price: €25.50')
          .emptyLines(3)
          .cut();

        buffer = builder.build();

      } else if (mode === 'cp737-38') {
        // Test: CP869 Greek with code page 38
        const builder = new EscPosBuilder(PaperSize.MM_80, 'PC737_GREEK');

        builder.initialize();
        builder.raw([0x1B, 0x74, 38]);  // ESC t 38 - CP869 Greek
        builder.enableGreekEncoding();
        builder.setCharacterSetType('PC737_GREEK');

        builder
          .alignCenter()
          .doubleLine()
          .bold(true)
          .textLine('ΔΟΚΙΜΗ (CP869 page 38)')
          .bold(false)
          .doubleLine()
          .alignLeft()
          .textLine('Ευχαριστούμε!')
          .textLine('Test: ABCDEFGHIJKLMNOP')
          .emptyLines(3)
          .cut();

        buffer = builder.build();

      } else if (mode === 'codepage-scan') {
        // Scan through code pages 0-50 to find which one has Greek
        const bytes: number[] = [];

        // Initialize
        bytes.push(0x1B, 0x40);  // ESC @

        // Header
        bytes.push(0x1B, 0x61, 0x01);  // Center
        const header = 'CODE PAGE SCAN';
        for (const c of header) bytes.push(c.charCodeAt(0));
        bytes.push(0x0A, 0x0A);

        bytes.push(0x1B, 0x61, 0x00);  // Left align

        // Test specific code pages known for Greek
        const greekPages = [14, 15, 16, 17, 18, 38, 39, 40, 41, 42, 43, 44, 45];

        for (const page of greekPages) {
          // Select code page
          bytes.push(0x1B, 0x74, page);

          // Print page number
          const pageStr = `Page ${page}: `;
          for (const c of pageStr) bytes.push(c.charCodeAt(0));

          // Print high bytes 0x80-0x90 (where Greek uppercase usually is)
          for (let i = 0x80; i <= 0x97; i++) {
            bytes.push(i);
          }
          bytes.push(0x0A);
        }

        bytes.push(0x0A, 0x0A, 0x0A);
        bytes.push(0x1D, 0x56, 0x42, 0x03);  // Cut

        buffer = Buffer.from(bytes);

      } else if (mode === 'bitmap') {
        // Print Greek text as bitmap image using Windows GDI
        // This renders text to bitmap and sends as ESC/POS raster image
        const { execSync } = await import('child_process');

        // Use PowerShell to render text to bitmap
        // Greek text is specified using Unicode escape sequences to avoid encoding issues
        // Note: Script uses only ASCII characters - Greek is built from [char] codes
        const bitmapScript = `
Add-Type -AssemblyName System.Drawing

$width = 384
$height = 100
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

# White background
$graphics.Clear([System.Drawing.Color]::White)

# Configure text rendering
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# Greek text using Unicode code points (avoids encoding issues)
# Build strings character by character
$text1 = ""
$text1 += [char]0x0394  # Delta
$text1 += [char]0x039F  # Omicron
$text1 += [char]0x039A  # Kappa
$text1 += [char]0x0399  # Iota
$text1 += [char]0x039C  # Mu
$text1 += [char]0x0397  # Eta
$text1 += " "
$text1 += [char]0x0395  # Epsilon
$text1 += [char]0x039B  # Lambda
$text1 += [char]0x039B  # Lambda
$text1 += [char]0x0397  # Eta
$text1 += [char]0x039D  # Nu
$text1 += [char]0x0399  # Iota
$text1 += [char]0x039A  # Kappa
$text1 += [char]0x03A9  # Omega
$text1 += [char]0x039D  # Nu

$text2 = ""
$text2 += [char]0x0395  # Epsilon
$text2 += [char]0x03C5  # upsilon
$text2 += [char]0x03C7  # chi
$text2 += [char]0x03B1  # alpha
$text2 += [char]0x03C1  # rho
$text2 += [char]0x03B9  # iota
$text2 += [char]0x03C3  # sigma
$text2 += [char]0x03C4  # tau
$text2 += [char]0x03BF  # omicron
$text2 += [char]0x03CD  # upsilon with tonos
$text2 += [char]0x03BC  # mu
$text2 += [char]0x03B5  # epsilon
$text2 += "!"

# Draw Greek text
$font1 = New-Object System.Drawing.Font("Arial", 20, [System.Drawing.FontStyle]::Bold)
$font2 = New-Object System.Drawing.Font("Arial", 16)
$brush = [System.Drawing.Brushes]::Black
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center

$rect1 = New-Object System.Drawing.RectangleF(0, 10, $width, 40)
$rect2 = New-Object System.Drawing.RectangleF(0, 55, $width, 35)

$graphics.DrawString($text1, $font1, $brush, $rect1, $format)
$graphics.DrawString($text2, $font2, $brush, $rect2, $format)

# Convert to 1-bit per pixel for thermal printer
$output = @()
for ($y = 0; $y -lt $height; $y++) {
    $line = @()
    for ($x = 0; $x -lt $width; $x += 8) {
        $byte = 0
        for ($bit = 0; $bit -lt 8; $bit++) {
            $px = $x + $bit
            if ($px -lt $width) {
                $pixel = $bitmap.GetPixel($px, $y)
                $gray = ($pixel.R + $pixel.G + $pixel.B) / 3
                if ($gray -lt 128) {
                    $byte = $byte -bor (0x80 -shr $bit)
                }
            }
        }
        $line += $byte
    }
    $output += ,($line)
}

$graphics.Dispose()
$bitmap.Dispose()

# Output as hex string
$hexOutput = ""
foreach ($line in $output) {
    foreach ($b in $line) {
        $hexOutput += "{0:X2}" -f $b
    }
}
Write-Output $hexOutput
`;

        const psFile2 = path.join(tempDir, `bitmap-${Date.now()}.ps1`);
        // Write with ASCII encoding since script only contains ASCII characters
        fs.writeFileSync(psFile2, bitmapScript, 'ascii');

        let bitmapHex: string;
        try {
          bitmapHex = execSync(`powershell -ExecutionPolicy Bypass -File "${psFile2}"`, {
            encoding: 'utf8',
            timeout: 30000,
            windowsHide: true
          }).trim();
          fs.unlinkSync(psFile2);
        } catch (err: any) {
          console.error('[bitmap] PowerShell error:', err.message);
          return { success: false, error: 'Failed to render bitmap: ' + err.message, mode };
        }

        // Convert hex string to bytes
        const bitmapBytes: number[] = [];
        for (let i = 0; i < bitmapHex.length; i += 2) {
          bitmapBytes.push(parseInt(bitmapHex.substr(i, 2), 16));
        }

        const width = 384;
        const height = 100;
        const bytesPerLine = width / 8;  // 48 bytes per line

        const bytes: number[] = [];

        // Initialize
        bytes.push(0x1B, 0x40);  // ESC @
        bytes.push(0x1B, 0x61, 0x01);  // Center

        // Print header
        const headerText = '=== BITMAP GREEK TEST ===';
        for (const c of headerText) bytes.push(c.charCodeAt(0));
        bytes.push(0x0A, 0x0A);

        // GS v 0 - Print raster bit image
        bytes.push(0x1D, 0x76, 0x30, 0x00);
        bytes.push(bytesPerLine & 0xFF, (bytesPerLine >> 8) & 0xFF);  // xL xH
        bytes.push(height & 0xFF, (height >> 8) & 0xFF);  // yL yH

        // Add bitmap data
        bytes.push(...bitmapBytes);

        bytes.push(0x0A, 0x0A, 0x0A);
        bytes.push(0x1D, 0x56, 0x42, 0x03);  // Cut

        buffer = Buffer.from(bytes);

        console.log(`[bitmap] Generated ${buffer.length} bytes, bitmap data: ${bitmapBytes.length} bytes`);

      } else if (mode === 'cp1253') {
        // Test 3: Use Windows-1253 encoding
        const builder = new EscPosBuilder(PaperSize.MM_80, 'PC1253_GREEK');

        builder.initialize();
        builder.raw([0x1B, 0x74, 17]);  // ESC t 17 - Try CP1253
        builder.enableGreekEncoding();
        builder.setCharacterSetType('PC1253_GREEK');

        builder
          .alignCenter()
          .doubleLine()
          .bold(true)
          .textLine('ΔΟΚΙΜΗ ΕΛΛΗΝΙΚΩΝ (CP1253)')
          .bold(false)
          .doubleLine()
          .alignLeft()
          .textLine('Ευχαριστούμε!')
          .textLine('Test: ABCDEFGHIJKLMNOP')
          .emptyLines(3)
          .cut();

        buffer = builder.build();

      } else {
        // Test 4: ASCII only (no Greek) - baseline test
        const builder = new EscPosBuilder(PaperSize.MM_80);

        builder.initialize();
        builder
          .alignCenter()
          .doubleLine()
          .bold(true)
          .textLine('ASCII ONLY TEST')
          .bold(false)
          .doubleLine()
          .alignLeft()
          .textLine('Thank you!')
          .textLine('Test: ABCDEFGHIJKLMNOP')
          .textLine('Numbers: 1234567890')
          .emptyLines(3)
          .cut();

        buffer = builder.build();
      }

      console.log(`[printer:test-greek-direct] Generated ${buffer.length} bytes`);

      // Log first 100 bytes for debugging
      const hexDump = Array.from(buffer.subarray(0, 100))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ');
      console.log(`[printer:test-greek-direct] First 100 bytes: ${hexDump}`);

      fs.writeFileSync(tempFile, buffer);
      console.log(`[printer:test-greek-direct] Wrote to ${tempFile}`);

      // First, list available printers to help debug
      try {
        const printerList = execSync('powershell -Command "Get-Printer | Select-Object Name, DriverName, PortName | Format-Table -AutoSize"', {
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true
        });
        console.log(`[printer:test-greek-direct] Available printers:\n${printerList}`);
      } catch (listErr) {
        console.warn(`[printer:test-greek-direct] Could not list printers:`, listErr);
      }

      // Use the existing SystemTransport approach - it works, just with wrong encoding
      // Let's use the same Win32 API approach that SystemTransport uses
      console.log(`[printer:test-greek-direct] Sending to printer: ${printerName}`);

      const psScript = `
$ErrorActionPreference = "Stop"
$printerName = "${printerName}"
$filePath = "${tempFile.replace(/\\/g, '\\\\')}"

Write-Host "Reading file: $filePath"
$rawData = [System.IO.File]::ReadAllBytes($filePath)
Write-Host "Read $($rawData.Length) bytes"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class RawPrint {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static string Send(string printer, byte[] data) {
        IntPtr hPrinter;
        if (!OpenPrinter(printer, out hPrinter, IntPtr.Zero)) {
            int err = Marshal.GetLastWin32Error();
            return "OpenPrinter failed, error: " + err;
        }

        DOCINFOA di = new DOCINFOA();
        di.pDocName = "Greek Test";
        di.pDataType = "RAW";

        if (!StartDocPrinter(hPrinter, 1, di)) {
            int err = Marshal.GetLastWin32Error();
            ClosePrinter(hPrinter);
            return "StartDocPrinter failed, error: " + err;
        }

        if (!StartPagePrinter(hPrinter)) {
            int err = Marshal.GetLastWin32Error();
            EndDocPrinter(hPrinter);
            ClosePrinter(hPrinter);
            return "StartPagePrinter failed, error: " + err;
        }

        IntPtr pBytes = Marshal.AllocCoTaskMem(data.Length);
        Marshal.Copy(data, 0, pBytes, data.Length);
        int written;
        bool ok = WritePrinter(hPrinter, pBytes, data.Length, out written);
        int writeErr = Marshal.GetLastWin32Error();
        Marshal.FreeCoTaskMem(pBytes);

        EndPagePrinter(hPrinter);
        EndDocPrinter(hPrinter);
        ClosePrinter(hPrinter);

        if (ok) {
            return "SUCCESS:" + written;
        } else {
            return "WritePrinter failed, error: " + writeErr + ", written: " + written;
        }
    }
}
"@

Write-Host "Sending to printer: $printerName"
$result = [RawPrint]::Send($printerName, $rawData)
Write-Host "Result: $result"
Write-Output $result
`;

      const psFile = path.join(tempDir, `print-${Date.now()}.ps1`);
      fs.writeFileSync(psFile, psScript, 'utf8');

      try {
        console.log(`[printer:test-greek-direct] Executing PowerShell...`);
        const output = execSync(`powershell -ExecutionPolicy Bypass -File "${psFile}"`, {
          encoding: 'utf8',
          timeout: 30000,
          windowsHide: true
        });
        console.log(`[printer:test-greek-direct] Result: ${output}`);

        // Cleanup
        setTimeout(() => {
          try { fs.unlinkSync(tempFile); } catch (e) { }
          try { fs.unlinkSync(psFile); } catch (e) { }
        }, 2000);

        const success = output.includes('SUCCESS');
        return {
          success,
          output: output.trim(),
          mode,
          printerName,
          bytes: buffer.length,
          message: success ? 'Print job sent successfully' : 'Print job may have failed - check output'
        };
      } catch (err: any) {
        console.error(`[printer:test-greek-direct] PowerShell error:`, err.message);
        console.error(`[printer:test-greek-direct] stderr:`, err.stderr);
        console.error(`[printer:test-greek-direct] stdout:`, err.stdout);
        return {
          success: false,
          error: err.message,
          stderr: err.stderr,
          stdout: err.stdout,
          mode,
          printerName
        };
      }

    } catch (error: any) {
      console.error('[printer:test-greek-direct] Error:', error);
      return { success: false, error: error.message || 'Failed' };
    }
  });

  console.log('[PrintHandlers] Print IPC handlers registered');
}

/**
 * Get the PrintService instance
 * @returns The PrintService instance or null if not initialized
 */
export function getPrintServiceInstance(): PrintService | null {
  return printService;
}
