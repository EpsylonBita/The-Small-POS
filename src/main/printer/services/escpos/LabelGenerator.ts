/**
 * Label Generator for ESC/POS Thermal Printers
 *
 * Generates label print commands for:
 * - Barcode-only labels
 * - Shelf labels with product info
 * - Price tags
 * - Batch label printing
 *
 * @module printer/services/escpos/LabelGenerator
 */

import { EscPosBuilder, TextAlignment, PAPER_WIDTH_CHARS } from './EscPosBuilder';
import { PaperSize } from '../../types';
import type { BarcodeType } from '@shared/types/product';

// =============================================================================
// Types
// =============================================================================

export interface LabelProduct {
  name: string;
  sku?: string;
  barcode?: string;
  barcodeType?: BarcodeType;
  price: number;
  description?: string;
  unit?: string; // e.g., 'per kg', 'each'
}

export interface BarcodeLabelOptions {
  /** Show product name above barcode */
  showName?: boolean;
  /** Show price below barcode */
  showPrice?: boolean;
  /** Barcode height in dots (default: 80) */
  barcodeHeight?: number;
  /** Barcode width module (2-6, default: 3) */
  barcodeWidth?: number;
  /** Number of labels to print */
  quantity?: number;
  /** Feed lines after each label */
  feedAfter?: number;
}

export interface ShelfLabelOptions {
  /** Show SKU on label */
  showSku?: boolean;
  /** Show description on label */
  showDescription?: boolean;
  /** Show barcode on label */
  showBarcode?: boolean;
  /** Large price display */
  largePriceFont?: boolean;
  /** Number of labels to print */
  quantity?: number;
  /** Feed lines after each label */
  feedAfter?: number;
}

export interface PriceTagOptions {
  /** Show old/original price (strikethrough style) */
  showOldPrice?: boolean;
  /** Old/original price value */
  oldPrice?: number;
  /** Show "SALE" indicator */
  showSaleIndicator?: boolean;
  /** Number of labels to print */
  quantity?: number;
}

export interface BatchLabelItem {
  product: LabelProduct;
  quantity: number;
}

// =============================================================================
// LabelGenerator Class
// =============================================================================

/**
 * Generates ESC/POS commands for thermal label printing.
 *
 * Usage:
 * ```typescript
 * const generator = new LabelGenerator(PaperSize.MM_58);
 * const buffer = generator.generateBarcodeLabel(product, { showName: true });
 * await printer.print(buffer);
 * ```
 */
export class LabelGenerator {
  private paperSize: PaperSize;
  private lineWidth: number;

  constructor(paperSize: PaperSize = PaperSize.MM_58) {
    this.paperSize = paperSize;
    this.lineWidth = PAPER_WIDTH_CHARS[paperSize];
  }

  /**
   * Generate a barcode-only label
   */
  generateBarcodeLabel(product: LabelProduct, options: BarcodeLabelOptions = {}): Buffer {
    const {
      showName = true,
      showPrice = false,
      barcodeHeight = 80,
      barcodeWidth = 3,
      quantity = 1,
      feedAfter = 3,
    } = options;

    const builder = new EscPosBuilder(this.paperSize);
    builder.initialize();

    for (let i = 0; i < quantity; i++) {
      builder.alignCenter();

      // Product name
      if (showName) {
        builder
          .bold(true)
          .textLine(this.truncate(product.name, this.lineWidth))
          .bold(false)
          .emptyLine();
      }

      // Barcode
      if (product.barcode) {
        this.printBarcodeByType(builder, product.barcode, product.barcodeType, {
          height: barcodeHeight,
          width: barcodeWidth,
        });
        builder.lineFeed(2);
      }

      // Price
      if (showPrice) {
        builder
          .bold(true)
          .textLine(this.formatPrice(product.price))
          .bold(false);
      }

      // Feed for label separation
      builder.lineFeed(feedAfter);

      // Add separator between multiple labels
      if (i < quantity - 1) {
        builder.dashedLine();
      }
    }

    return builder.build();
  }

  /**
   * Generate a shelf label with product info, price, and optional barcode
   */
  generateShelfLabel(product: LabelProduct, options: ShelfLabelOptions = {}): Buffer {
    const {
      showSku = false,
      showDescription = false,
      showBarcode = true,
      largePriceFont = true,
      quantity = 1,
      feedAfter = 3,
    } = options;

    const builder = new EscPosBuilder(this.paperSize);
    builder.initialize();

    for (let i = 0; i < quantity; i++) {
      // Separator at top
      builder.doubleLine();

      // Product name
      builder
        .alignCenter()
        .bold(true)
        .textLine(this.truncate(product.name, this.lineWidth))
        .bold(false);

      // SKU
      if (showSku && product.sku) {
        builder.textLine(`SKU: ${product.sku}`);
      }

      // Description
      if (showDescription && product.description) {
        builder
          .normalSize()
          .textLine(this.truncate(product.description, this.lineWidth));
      }

      builder.emptyLine();

      // Price (prominent display)
      builder.alignCenter();
      if (largePriceFont) {
        builder
          .doubleSize()
          .bold(true)
          .textLine(this.formatPrice(product.price))
          .bold(false)
          .normalSize();
      } else {
        builder
          .bold(true)
          .textLine(this.formatPrice(product.price))
          .bold(false);
      }

      // Unit (if applicable)
      if (product.unit) {
        builder.textLine(product.unit);
      }

      builder.emptyLine();

      // Barcode
      if (showBarcode && product.barcode) {
        this.printBarcodeByType(builder, product.barcode, product.barcodeType, {
          height: 60,
          width: 2,
        });
        builder.lineFeed();
      }

      // Separator at bottom
      builder.doubleLine();

      // Feed for label separation
      builder.lineFeed(feedAfter);
    }

    return builder.build();
  }

  /**
   * Generate a price tag (optimized for price display)
   */
  generatePriceTag(product: LabelProduct, options: PriceTagOptions = {}): Buffer {
    const {
      showOldPrice = false,
      oldPrice,
      showSaleIndicator = false,
      quantity = 1,
    } = options;

    const builder = new EscPosBuilder(this.paperSize);
    builder.initialize();

    for (let i = 0; i < quantity; i++) {
      builder.alignCenter();

      // Product name
      builder
        .bold(true)
        .textLine(this.truncate(product.name, this.lineWidth))
        .bold(false)
        .emptyLine();

      // Sale indicator
      if (showSaleIndicator) {
        builder
          .bold(true)
          .textLine('*** SALE ***')
          .bold(false);
      }

      // Old price (crossed out style)
      if (showOldPrice && oldPrice !== undefined) {
        builder.textLine(`Was: ${this.formatPrice(oldPrice)}`);
      }

      // Current price (large and bold)
      builder
        .doubleSize()
        .bold(true)
        .textLine(this.formatPrice(product.price))
        .bold(false)
        .normalSize();

      // Unit
      if (product.unit) {
        builder.textLine(product.unit);
      }

      // Barcode (small)
      if (product.barcode) {
        builder.emptyLine();
        this.printBarcodeByType(builder, product.barcode, product.barcodeType, {
          height: 50,
          width: 2,
        });
      }

      builder.lineFeed(4);

      // Separator
      if (i < quantity - 1) {
        builder.dashedLine();
      }
    }

    return builder.build();
  }

  /**
   * Generate batch labels for multiple products
   */
  generateBatchLabels(
    items: BatchLabelItem[],
    labelType: 'barcode' | 'shelf' | 'price' = 'barcode',
    options?: BarcodeLabelOptions | ShelfLabelOptions | PriceTagOptions
  ): Buffer {
    const builder = new EscPosBuilder(this.paperSize);
    builder.initialize();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Generate appropriate label type
      let labelBuffer: Buffer;
      switch (labelType) {
        case 'shelf':
          labelBuffer = this.generateShelfLabel(item.product, {
            ...(options as ShelfLabelOptions),
            quantity: item.quantity,
          });
          break;
        case 'price':
          labelBuffer = this.generatePriceTag(item.product, {
            ...(options as PriceTagOptions),
            quantity: item.quantity,
          });
          break;
        case 'barcode':
        default:
          labelBuffer = this.generateBarcodeLabel(item.product, {
            ...(options as BarcodeLabelOptions),
            quantity: item.quantity,
          });
          break;
      }

      // Append to main buffer
      builder.raw(labelBuffer);

      // Add separator between different products
      if (i < items.length - 1) {
        builder.thickLine().lineFeed();
      }
    }

    return builder.build();
  }

  // =============================================================================
  // Private Helper Methods
  // =============================================================================

  /**
   * Print barcode using appropriate type
   */
  private printBarcodeByType(
    builder: EscPosBuilder,
    barcode: string,
    barcodeType?: BarcodeType,
    options?: { height?: number; width?: number }
  ): void {
    const type = barcodeType || this.detectBarcodeType(barcode);

    switch (type) {
      case 'EAN13':
        builder.printEAN13(barcode, {
          height: options?.height ?? 80,
          width: options?.width ?? 3,
          hriPosition: EscPosBuilder.HRI_POSITION.BELOW,
        });
        break;

      case 'UPCA':
        builder.printUPCA(barcode, {
          height: options?.height ?? 80,
          width: options?.width ?? 3,
          hriPosition: EscPosBuilder.HRI_POSITION.BELOW,
        });
        break;

      case 'CODE128':
      case 'INTERNAL':
      default:
        builder.printCode128(barcode, {
          height: options?.height ?? 80,
          width: options?.width ?? 2,
          hriPosition: EscPosBuilder.HRI_POSITION.BELOW,
        });
        break;
    }
  }

  /**
   * Auto-detect barcode type from content
   */
  private detectBarcodeType(barcode: string): BarcodeType {
    if (barcode.length === 13 && /^\d+$/.test(barcode)) {
      return 'EAN13';
    }
    if (barcode.length === 12 && /^\d+$/.test(barcode)) {
      return 'UPCA';
    }
    if (/^[A-Z]/i.test(barcode)) {
      return 'INTERNAL';
    }
    return 'CODE128';
  }

  /**
   * Truncate text to fit line width
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Format price for display
   */
  private formatPrice(price: number): string {
    return `$${price.toFixed(2)}`;
  }
}

// =============================================================================
// Export convenience functions
// =============================================================================

/**
 * Quick function to generate a single barcode label
 */
export function generateBarcodeLabel(
  product: LabelProduct,
  options?: BarcodeLabelOptions,
  paperSize?: PaperSize
): Buffer {
  const generator = new LabelGenerator(paperSize);
  return generator.generateBarcodeLabel(product, options);
}

/**
 * Quick function to generate a single shelf label
 */
export function generateShelfLabel(
  product: LabelProduct,
  options?: ShelfLabelOptions,
  paperSize?: PaperSize
): Buffer {
  const generator = new LabelGenerator(paperSize);
  return generator.generateShelfLabel(product, options);
}

/**
 * Quick function to generate a single price tag
 */
export function generatePriceTag(
  product: LabelProduct,
  options?: PriceTagOptions,
  paperSize?: PaperSize
): Buffer {
  const generator = new LabelGenerator(paperSize);
  return generator.generatePriceTag(product, options);
}

/**
 * Quick function to generate batch labels
 */
export function generateBatchLabels(
  items: BatchLabelItem[],
  labelType: 'barcode' | 'shelf' | 'price' = 'barcode',
  options?: BarcodeLabelOptions | ShelfLabelOptions | PriceTagOptions,
  paperSize?: PaperSize
): Buffer {
  const generator = new LabelGenerator(paperSize);
  return generator.generateBatchLabels(items, labelType, options);
}

export default LabelGenerator;
