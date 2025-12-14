/**
 * Thermal Printer Service for POS System
 *
 * Handles receipt and kitchen ticket printing using thermal printers.
 * Supports ESC/POS commands for various thermal printer models.
 *
 * Installation:
 * npm install node-thermal-printer --legacy-peer-deps
 *
 * Usage:
 * import { printerService } from '@/services/printer-service';
 * await printerService.printReceipt(orderData);
 */

// Types for printer configuration
export interface PrinterConfig {
  type: 'epson' | 'star' | 'tanca';
  interface: string; // e.g., 'tcp://192.168.1.100' or '\\\\.\\COM1' or 'printer:Star TSP100'
  characterSet?: string;
  width?: number; // Characters per line (default: 48)
  removeSpecialCharacters?: boolean;
}

export interface OrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
  modifiers?: string[];
  specialInstructions?: string;
}

export interface ReceiptData {
  orderNumber: string;
  orderType: 'dine-in' | 'takeout' | 'delivery';
  timestamp: Date;
  items: OrderItem[];
  subtotal: number;
  tax: number;
  tip?: number;
  deliveryFee?: number;
  total: number;
  paymentMethod: string;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  tableName?: string;
}

export interface KitchenTicketData {
  orderNumber: string;
  orderType: 'dine-in' | 'takeout' | 'delivery';
  timestamp: Date;
  items: OrderItem[];
  customerName?: string;
  tableName?: string;
  specialInstructions?: string;
  station: string; // e.g., 'Grill', 'Fryer', 'Prep'
}

class PrinterService {
  private printerConfig: PrinterConfig | null = null;
  private isInitialized: boolean = false;
  private ThermalPrinter: any = null;

  /**
   * Initialize the printer service
   * @param config Printer configuration
   */
  async initialize(config: PrinterConfig): Promise<void> {
    try {
      // Dynamically import node-thermal-printer
      // This allows the service to work even if the package isn't installed yet
      const { ThermalPrinter, PrinterTypes } = await import('node-thermal-printer');

      this.ThermalPrinter = ThermalPrinter;
      this.printerConfig = {
        ...config,
        width: config.width || 48,
        characterSet: config.characterSet || 'PC437_USA',
        removeSpecialCharacters: config.removeSpecialCharacters ?? false,
      };

      this.isInitialized = true;
      console.log('Printer service initialized:', config);
    } catch (error) {
      console.error('Failed to initialize printer service:', error);
      throw new Error('Printer library not installed. Run: npm install node-thermal-printer --legacy-peer-deps');
    }
  }

  /**
   * Check if printer is initialized and ready
   */
  isReady(): boolean {
    return this.isInitialized && this.printerConfig !== null;
  }

  /**
   * Create a printer instance
   */
  private createPrinter() {
    if (!this.isReady() || !this.ThermalPrinter) {
      throw new Error('Printer service not initialized');
    }

    const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');

    let printerType;
    switch (this.printerConfig!.type) {
      case 'epson':
        printerType = PrinterTypes.EPSON;
        break;
      case 'star':
        printerType = PrinterTypes.STAR;
        break;
      case 'tanca':
        printerType = PrinterTypes.TANCA;
        break;
      default:
        printerType = PrinterTypes.EPSON;
    }

    return new ThermalPrinter({
      type: printerType,
      interface: this.printerConfig!.interface,
      characterSet: this.printerConfig!.characterSet,
      width: this.printerConfig!.width,
      removeSpecialCharacters: this.printerConfig!.removeSpecialCharacters,
    });
  }

  /**
   * Print a customer receipt
   */
  async printReceipt(data: ReceiptData): Promise<boolean> {
    try {
      const printer = this.createPrinter();

      // Header
      printer.alignCenter();
      printer.setTextSize(1, 1);
      printer.bold(true);
      printer.println('THE SMALL RESTAURANT');
      printer.bold(false);
      printer.println('123 Main Street');
      printer.println('Los Angeles, CA 90001');
      printer.println('(310) 555-1234');
      printer.drawLine();

      // Order info
      printer.alignLeft();
      printer.println(`Order #: ${data.orderNumber}`);
      printer.println(`Type: ${data.orderType.toUpperCase()}`);
      printer.println(`Date: ${data.timestamp.toLocaleString()}`);

      if (data.tableName) {
        printer.println(`Table: ${data.tableName}`);
      }

      if (data.customerName) {
        printer.println(`Customer: ${data.customerName}`);
      }

      if (data.deliveryAddress) {
        printer.println(`Delivery: ${data.deliveryAddress}`);
      }

      printer.drawLine();

      // Items
      printer.setTextSize(0, 0);
      for (const item of data.items) {
        const itemLine = `${item.quantity}x ${item.name}`;
        const price = `$${item.total.toFixed(2)}`;
        const padding = ' '.repeat(Math.max(0, this.printerConfig!.width! - itemLine.length - price.length));
        printer.println(itemLine + padding + price);

        // Modifiers
        if (item.modifiers && item.modifiers.length > 0) {
          for (const modifier of item.modifiers) {
            printer.println(`  + ${modifier}`);
          }
        }

        // Special instructions
        if (item.specialInstructions) {
          printer.println(`  Note: ${item.specialInstructions}`);
        }
      }

      printer.drawLine();

      // Totals
      this.printLine(printer, 'Subtotal:', `$${data.subtotal.toFixed(2)}`);
      this.printLine(printer, 'Tax:', `$${data.tax.toFixed(2)}`);

      if (data.deliveryFee && data.deliveryFee > 0) {
        this.printLine(printer, 'Delivery Fee:', `$${data.deliveryFee.toFixed(2)}`);
      }

      if (data.tip && data.tip > 0) {
        this.printLine(printer, 'Tip:', `$${data.tip.toFixed(2)}`);
      }

      printer.bold(true);
      this.printLine(printer, 'TOTAL:', `$${data.total.toFixed(2)}`);
      printer.bold(false);

      printer.drawLine();

      // Payment method
      printer.println(`Payment: ${data.paymentMethod}`);

      // Footer
      printer.newLine();
      printer.alignCenter();
      printer.println('Thank you for your order!');
      printer.println('Please come again!');
      printer.newLine();

      // QR code with order number (if supported)
      try {
        printer.printQR(data.orderNumber, {
          cellSize: 6,
          correction: 'M',
          model: 2,
        });
      } catch (err) {
        // QR code not supported, skip
      }

      // Cut paper
      printer.cut();

      // Execute print
      await printer.execute();
      console.log('Receipt printed successfully:', data.orderNumber);
      return true;
    } catch (error) {
      console.error('Failed to print receipt:', error);
      return false;
    }
  }

  /**
   * Print a kitchen ticket
   */
  async printKitchenTicket(data: KitchenTicketData): Promise<boolean> {
    try {
      const printer = this.createPrinter();

      // Header
      printer.alignCenter();
      printer.setTextSize(1, 1);
      printer.bold(true);
      printer.println(`KITCHEN - ${data.station.toUpperCase()}`);
      printer.bold(false);
      printer.drawLine();

      // Order info
      printer.alignLeft();
      printer.setTextSize(1, 1);
      printer.bold(true);
      printer.println(`Order #${data.orderNumber}`);
      printer.bold(false);

      printer.setTextSize(0, 0);
      printer.println(`Type: ${data.orderType.toUpperCase()}`);
      printer.println(`Time: ${data.timestamp.toLocaleTimeString()}`);

      if (data.tableName) {
        printer.println(`Table: ${data.tableName}`);
      }

      if (data.customerName) {
        printer.println(`Customer: ${data.customerName}`);
      }

      printer.drawLine();

      // Items
      printer.setTextSize(1, 1);
      for (const item of data.items) {
        printer.bold(true);
        printer.println(`${item.quantity}x ${item.name}`);
        printer.bold(false);

        // Modifiers
        if (item.modifiers && item.modifiers.length > 0) {
          for (const modifier of item.modifiers) {
            printer.println(`  + ${modifier}`);
          }
        }

        // Special instructions
        if (item.specialInstructions) {
          printer.setTextSize(0, 0);
          printer.println(`  **${item.specialInstructions}**`);
          printer.setTextSize(1, 1);
        }

        printer.newLine();
      }

      // Special instructions for entire order
      if (data.specialInstructions) {
        printer.drawLine();
        printer.setTextSize(0, 0);
        printer.bold(true);
        printer.println('ORDER NOTES:');
        printer.bold(false);
        printer.println(data.specialInstructions);
      }

      // Footer
      printer.drawLine();
      printer.alignCenter();
      printer.setTextSize(0, 0);
      printer.println(`Printed: ${new Date().toLocaleTimeString()}`);

      // Cut paper
      printer.cut();

      // Execute print
      await printer.execute();
      console.log('Kitchen ticket printed successfully:', data.orderNumber, data.station);
      return true;
    } catch (error) {
      console.error('Failed to print kitchen ticket:', error);
      return false;
    }
  }

  /**
   * Test print to verify printer connection
   */
  async testPrint(): Promise<boolean> {
    try {
      const printer = this.createPrinter();

      printer.alignCenter();
      printer.setTextSize(1, 1);
      printer.bold(true);
      printer.println('PRINTER TEST');
      printer.bold(false);
      printer.newLine();
      printer.setTextSize(0, 0);
      printer.println('If you can read this,');
      printer.println('the printer is working correctly!');
      printer.newLine();
      printer.println(`Time: ${new Date().toLocaleString()}`);
      printer.cut();

      await printer.execute();
      console.log('Test print successful');
      return true;
    } catch (error) {
      console.error('Test print failed:', error);
      return false;
    }
  }

  /**
   * Helper method to print a line with left and right alignment
   */
  private printLine(printer: any, left: string, right: string): void {
    const padding = ' '.repeat(Math.max(0, this.printerConfig!.width! - left.length - right.length));
    printer.println(left + padding + right);
  }
}

// Export singleton instance
export const printerService = new PrinterService();
