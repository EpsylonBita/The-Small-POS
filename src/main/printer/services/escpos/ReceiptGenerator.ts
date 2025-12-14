/**
 * Receipt Generator
 *
 * Generates formatted receipts, kitchen tickets, and test prints
 * using the EscPosBuilder class.
 *
 * @module printer/services/escpos
 */

import {
  PaperSize,
  ReceiptData,
  KitchenTicketData,
  PrintOrderItem,
} from '../../types';
import { EscPosBuilder, PAPER_WIDTH_CHARS } from './EscPosBuilder';

// ============================================================================
// Receipt Configuration
// ============================================================================

/**
 * Configuration options for receipt generation
 */
export interface ReceiptConfig {
  paperSize: PaperSize;
  storeName?: string;
  storeAddress?: string;
  storePhone?: string;
  footerMessage?: string;
  showLogo?: boolean;
  currency?: string;
}

/**
 * Default receipt configuration
 */
const DEFAULT_RECEIPT_CONFIG: ReceiptConfig = {
  paperSize: PaperSize.MM_80,
  storeName: 'Restaurant',
  currency: '$',
};

// ============================================================================
// ReceiptGenerator Class
// ============================================================================

/**
 * Generates formatted receipts and tickets for thermal printers.
 *
 * Usage:
 * ```typescript
 * const generator = new ReceiptGenerator({ paperSize: PaperSize.MM_80 });
 * const buffer = generator.generateReceipt(receiptData);
 * ```
 */
export class ReceiptGenerator {
  private config: ReceiptConfig;
  private lineWidth: number;

  constructor(config: Partial<ReceiptConfig> = {}) {
    this.config = { ...DEFAULT_RECEIPT_CONFIG, ...config };
    this.lineWidth = PAPER_WIDTH_CHARS[this.config.paperSize];
  }

  /**
   * Get the current configuration
   */
  getConfig(): ReceiptConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<ReceiptConfig>): void {
    this.config = { ...this.config, ...config };
    this.lineWidth = PAPER_WIDTH_CHARS[this.config.paperSize];
  }

  // ==========================================================================
  // Receipt Generation
  // ==========================================================================

  /**
   * Generate a customer receipt
   * @param data - Receipt data including items, totals, etc.
   */
  generateReceipt(data: ReceiptData): Buffer {
    const builder = new EscPosBuilder(this.config.paperSize);

    builder.initialize();

    // Header
    this.addReceiptHeader(builder, data);

    // Order info
    this.addOrderInfo(builder, data);

    // Items
    this.addItemsSection(builder, data.items);

    // Totals
    this.addTotalsSection(builder, data);

    // Payment info
    this.addPaymentInfo(builder, data);

    // Footer
    this.addReceiptFooter(builder);

    // Cut paper
    builder.cut();

    return builder.build();
  }

  /**
   * Add receipt header with store info
   */
  private addReceiptHeader(builder: EscPosBuilder, data: ReceiptData): void {
    builder.alignCenter();

    // Store name (large and bold)
    if (this.config.storeName) {
      builder
        .doubleSize()
        .bold(true)
        .textLine(this.config.storeName)
        .bold(false)
        .normalSize();
    }

    // Store address
    if (this.config.storeAddress) {
      builder.textLine(this.config.storeAddress);
    }

    // Store phone
    if (this.config.storePhone) {
      builder.textLine(`Tel: ${this.config.storePhone}`);
    }

    builder.emptyLines(1).doubleLine().emptyLines(1);
  }

  /**
   * Add order information section
   */
  private addOrderInfo(builder: EscPosBuilder, data: ReceiptData): void {
    builder.alignLeft();

    // Order number and type
    builder
      .bold(true)
      .textLine(`Order #${data.orderNumber}`)
      .bold(false);

    // Order type
    const orderTypeLabel = this.formatOrderType(data.orderType);
    builder.textLine(`Type: ${orderTypeLabel}`);

    // Table name for dine-in
    if (data.tableName && data.orderType === 'dine-in') {
      builder.textLine(`Table: ${data.tableName}`);
    }

    // Customer info for delivery/takeout
    if (data.customerName) {
      builder.textLine(`Customer: ${data.customerName}`);
    }

    if (data.customerPhone) {
      builder.textLine(`Phone: ${data.customerPhone}`);
    }

    if (data.deliveryAddress && data.orderType === 'delivery') {
      builder.textLine(`Address: ${data.deliveryAddress}`);
    }

    // Timestamp
    builder.textLine(`Date: ${this.formatDate(data.timestamp)}`);

    builder.emptyLines(1).horizontalLine().emptyLines(1);
  }

  /**
   * Add items section
   */
  private addItemsSection(builder: EscPosBuilder, items: PrintOrderItem[]): void {
    builder.alignLeft();

    // Column headers
    builder
      .bold(true)
      .threeColumnRow('Item', 'Qty', 'Price')
      .bold(false)
      .horizontalLine();

    // Items
    for (const item of items) {
      this.addItemLine(builder, item);
    }

    builder.horizontalLine().emptyLines(1);
  }

  /**
   * Add a single item line with modifiers
   */
  private addItemLine(builder: EscPosBuilder, item: PrintOrderItem): void {
    const priceStr = this.formatCurrency(item.total);
    const qtyStr = item.quantity.toString();

    // Main item line
    builder.threeColumnRow(
      this.truncateText(item.name, this.lineWidth - qtyStr.length - priceStr.length - 4),
      qtyStr,
      priceStr
    );

    // Modifiers (indented)
    if (item.modifiers && item.modifiers.length > 0) {
      for (const modifier of item.modifiers) {
        builder.textLine(`  + ${modifier}`);
      }
    }

    // Special instructions (indented)
    if (item.specialInstructions) {
      builder.textLine(`  * ${item.specialInstructions}`);
    }
  }

  /**
   * Add totals section
   */
  private addTotalsSection(builder: EscPosBuilder, data: ReceiptData): void {
    builder.alignLeft();

    // Subtotal
    builder.twoColumnRow('Subtotal:', this.formatCurrency(data.subtotal));

    // Tax
    builder.twoColumnRow('Tax:', this.formatCurrency(data.tax));

    // Delivery fee (if applicable)
    if (data.deliveryFee && data.deliveryFee > 0) {
      builder.twoColumnRow('Delivery Fee:', this.formatCurrency(data.deliveryFee));
    }

    // Tip (if applicable)
    if (data.tip && data.tip > 0) {
      builder.twoColumnRow('Tip:', this.formatCurrency(data.tip));
    }

    builder.horizontalLine();

    // Total (bold and larger)
    builder
      .bold(true)
      .doubleHeight()
      .twoColumnRow('TOTAL:', this.formatCurrency(data.total))
      .normalSize()
      .bold(false);

    builder.emptyLines(1);
  }

  /**
   * Add payment information
   */
  private addPaymentInfo(builder: EscPosBuilder, data: ReceiptData): void {
    builder.alignLeft();
    builder.twoColumnRow('Payment:', data.paymentMethod);
    builder.emptyLines(1);
  }

  /**
   * Add receipt footer
   */
  private addReceiptFooter(builder: EscPosBuilder): void {
    builder.doubleLine().alignCenter();

    if (this.config.footerMessage) {
      builder.textLine(this.config.footerMessage);
    } else {
      builder.textLine('Thank you for your order!');
    }

    builder.emptyLines(2);
  }

  // ==========================================================================
  // Kitchen Ticket Generation
  // ==========================================================================

  /**
   * Generate a kitchen ticket
   * @param data - Kitchen ticket data
   */
  generateKitchenTicket(data: KitchenTicketData): Buffer {
    const builder = new EscPosBuilder(this.config.paperSize);

    builder.initialize();

    // Header with station and order info
    this.addKitchenHeader(builder, data);

    // Items for this station
    this.addKitchenItems(builder, data.items);

    // Special instructions
    if (data.specialInstructions) {
      this.addSpecialInstructions(builder, data.specialInstructions);
    }

    // Footer with timestamp
    this.addKitchenFooter(builder, data);

    // Cut paper
    builder.cut();

    return builder.build();
  }

  /**
   * Add kitchen ticket header
   */
  private addKitchenHeader(builder: EscPosBuilder, data: KitchenTicketData): void {
    builder.alignCenter();

    // Station name (large and bold)
    builder
      .doubleSize()
      .bold(true)
      .textLine(data.station.toUpperCase())
      .bold(false)
      .normalSize();

    builder.doubleLine();

    // Order info
    builder
      .alignLeft()
      .doubleHeight()
      .bold(true)
      .textLine(`Order #${data.orderNumber}`)
      .normalSize()
      .bold(false);

    // Order type
    const orderTypeLabel = this.formatOrderType(data.orderType);
    builder.textLine(`Type: ${orderTypeLabel}`);

    // Table or customer
    if (data.tableName) {
      builder.bold(true).textLine(`Table: ${data.tableName}`).bold(false);
    } else if (data.customerName) {
      builder.textLine(`Customer: ${data.customerName}`);
    }

    builder.horizontalLine().emptyLines(1);
  }

  /**
   * Add kitchen items (simplified format)
   */
  private addKitchenItems(builder: EscPosBuilder, items: PrintOrderItem[]): void {
    builder.alignLeft();

    for (const item of items) {
      // Quantity and item name (larger text)
      builder
        .doubleHeight()
        .bold(true)
        .textLine(`${item.quantity}x ${item.name}`)
        .normalSize()
        .bold(false);

      // Modifiers
      if (item.modifiers && item.modifiers.length > 0) {
        for (const modifier of item.modifiers) {
          builder.textLine(`   + ${modifier}`);
        }
      }

      // Special instructions for this item
      if (item.specialInstructions) {
        builder
          .bold(true)
          .textLine(`   ** ${item.specialInstructions} **`)
          .bold(false);
      }

      builder.emptyLines(1);
    }

    builder.horizontalLine();
  }

  /**
   * Add special instructions section
   */
  private addSpecialInstructions(builder: EscPosBuilder, instructions: string): void {
    builder
      .emptyLines(1)
      .alignCenter()
      .bold(true)
      .textLine('*** SPECIAL INSTRUCTIONS ***')
      .bold(false)
      .alignLeft()
      .textLine(instructions)
      .emptyLines(1)
      .horizontalLine();
  }

  /**
   * Add kitchen ticket footer
   */
  private addKitchenFooter(builder: EscPosBuilder, data: KitchenTicketData): void {
    builder
      .alignCenter()
      .textLine(this.formatDate(data.timestamp))
      .emptyLines(2);
  }

  // ==========================================================================
  // Test Print Generation
  // ==========================================================================

  /**
   * Generate a test print receipt
   * @param printerName - Name of the printer being tested
   */
  generateTestPrint(printerName: string = 'Test Printer'): Buffer {
    const builder = new EscPosBuilder(this.config.paperSize);

    builder.initialize();

    // Header
    builder
      .alignCenter()
      .doubleLine()
      .doubleSize()
      .bold(true)
      .textLine('TEST PRINT')
      .normalSize()
      .bold(false)
      .doubleLine()
      .emptyLines(1);

    // Printer info
    builder
      .alignLeft()
      .textLine(`Printer: ${printerName}`)
      .textLine(`Paper Size: ${this.config.paperSize}`)
      .textLine(`Line Width: ${this.lineWidth} chars`)
      .textLine(`Date: ${this.formatDate(new Date())}`)
      .emptyLines(1)
      .horizontalLine()
      .emptyLines(1);

    // Text formatting tests
    builder
      .alignCenter()
      .textLine('Text Formatting Tests')
      .horizontalLine()
      .alignLeft();

    builder.textLine('Normal text');
    builder.bold(true).textLine('Bold text').bold(false);
    builder.underline(1).textLine('Underlined text').underline(0);
    builder.doubleWidth().textLine('Double width').normalSize();
    builder.doubleHeight().textLine('Double height').normalSize();
    builder.doubleSize().textLine('Double size').normalSize();

    builder.emptyLines(1).horizontalLine().emptyLines(1);

    // Alignment tests
    builder.alignCenter().textLine('Alignment Tests').horizontalLine();
    builder.alignLeft().textLine('Left aligned');
    builder.alignCenter().textLine('Center aligned');
    builder.alignRight().textLine('Right aligned');

    builder.emptyLines(1).horizontalLine().emptyLines(1);

    // Line drawing tests
    builder.alignCenter().textLine('Line Drawing Tests').horizontalLine();
    builder.alignLeft();
    builder.textLine('Dashed line:');
    builder.horizontalLine();
    builder.textLine('Double line:');
    builder.doubleLine();
    builder.textLine('Dotted line:');
    builder.dottedLine();

    builder.emptyLines(1);

    // Two-column test
    builder.textLine('Two-column layout:');
    builder.twoColumnRow('Left text', 'Right text');
    builder.twoColumnRow('Item name', '$9.99');
    builder.twoColumnRow('Longer item name here', '$12.50');

    builder.emptyLines(1).doubleLine();

    // Success message
    builder
      .alignCenter()
      .bold(true)
      .textLine('Test print successful!')
      .bold(false)
      .emptyLines(2);

    // Cut paper
    builder.cut();

    return builder.build();
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Format a number as currency
   */
  private formatCurrency(amount: number): string {
    const currency = this.config.currency || '$';
    return `${currency}${amount.toFixed(2)}`;
  }

  /**
   * Format a date for display
   */
  private formatDate(date: Date): string {
    const d = new Date(date);
    return d.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  }

  /**
   * Format order type for display
   */
  private formatOrderType(orderType: string): string {
    const labels: Record<string, string> = {
      'dine-in': 'Dine-In',
      'takeout': 'Takeout',
      'delivery': 'Delivery',
    };
    return labels[orderType] || orderType;
  }

  /**
   * Truncate text to fit within a maximum length
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - 3) + '...';
  }
}
