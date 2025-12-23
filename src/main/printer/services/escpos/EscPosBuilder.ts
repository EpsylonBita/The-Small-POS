/**
 * ESC/POS Command Builder
 *
 * Generates ESC/POS commands for thermal receipt printers.
 * Supports text formatting, alignment, line drawing, and paper cutting.
 *
 * @module printer/services/escpos
 *
 * **Feature: pos-printer-drivers, Property 6: ESC/POS Command Generation**
 */

import { PaperSize } from '../../types';

// ============================================================================
// ESC/POS Command Constants
// ============================================================================

/**
 * ESC/POS command bytes
 */
export const ESC = 0x1b; // Escape
export const GS = 0x1d; // Group Separator
export const LF = 0x0a; // Line Feed
export const CR = 0x0d; // Carriage Return

/**
 * Text alignment values
 */
export enum TextAlignment {
  LEFT = 0,
  CENTER = 1,
  RIGHT = 2,
}

/**
 * Text size multipliers (1-8)
 */
export interface TextSize {
  width: number; // 1-8
  height: number; // 1-8
}

/**
 * Paper width configurations in characters
 */
export const PAPER_WIDTH_CHARS: Record<PaperSize, number> = {
  [PaperSize.MM_58]: 32,
  [PaperSize.MM_80]: 48,
  [PaperSize.MM_112]: 64,
};

// ============================================================================
// EscPosBuilder Class
// ============================================================================

/**
 * Builder class for generating ESC/POS command buffers.
 *
 * Usage:
 * ```typescript
 * const builder = new EscPosBuilder(PaperSize.MM_80);
 * const buffer = builder
 *   .initialize()
 *   .alignCenter()
 *   .bold(true)
 *   .text('RECEIPT')
 *   .bold(false)
 *   .lineFeed()
 *   .cut()
 *   .build();
 * ```
 */
export class EscPosBuilder {
  private buffer: number[] = [];
  private paperSize: PaperSize;
  private lineWidth: number;

  constructor(paperSize: PaperSize = PaperSize.MM_80) {
    this.paperSize = paperSize;
    this.lineWidth = PAPER_WIDTH_CHARS[paperSize];
  }

  // ==========================================================================
  // Initialization Commands
  // ==========================================================================

  /**
   * Initialize printer (ESC @)
   * Clears the print buffer and resets the printer to default settings.
   */
  initialize(): this {
    this.buffer.push(ESC, 0x40); // ESC @
    return this;
  }

  /**
   * Set character code page (ESC t n)
   * Selects the character code page for printing special characters.
   *
   * Common code pages:
   * - 0: CP437 (USA, Standard Europe)
   * - 16: CP737 (Greek)
   * - 17: CP851 (Greek)
   * - 18: CP869 (Greek)
   * - 19: CP866 (Cyrillic)
   * - 32: CP852 (Latin 2)
   * - 255: Custom (depends on printer)
   *
   * @param codePage - code page number (0-255)
   */
  setCodePage(codePage: number): this {
    this.buffer.push(ESC, 0x74, codePage); // ESC t n
    return this;
  }

  /**
   * Set international character set (ESC R n)
   * Selects one of the international character sets.
   *
   * Common character sets:
   * - 0: USA
   * - 1: France
   * - 2: Germany
   * - 3: UK
   * - 13: Greece
   *
   * @param charset - character set number (0-15)
   */
  setCharacterSet(charset: number): this {
    this.buffer.push(ESC, 0x52, charset); // ESC R n
    return this;
  }

  // ==========================================================================
  // Text Formatting Commands
  // ==========================================================================

  /**
   * Set bold mode (ESC E n)
   * @param enabled - true to enable bold, false to disable
   */
  bold(enabled: boolean): this {
    this.buffer.push(ESC, 0x45, enabled ? 1 : 0); // ESC E n
    return this;
  }

  /**
   * Set underline mode (ESC - n)
   * @param mode - 0: off, 1: 1-dot underline, 2: 2-dot underline
   */
  underline(mode: 0 | 1 | 2 = 1): this {
    this.buffer.push(ESC, 0x2d, mode); // ESC - n
    return this;
  }

  /**
   * Set text size (GS ! n)
   * @param size - width and height multipliers (1-8)
   */
  setTextSize(size: TextSize): this {
    // Clamp values to valid range
    const width = Math.max(1, Math.min(8, size.width)) - 1;
    const height = Math.max(1, Math.min(8, size.height)) - 1;
    // n = (width << 4) | height
    const n = (width << 4) | height;
    this.buffer.push(GS, 0x21, n); // GS ! n
    return this;
  }

  /**
   * Reset text size to normal (1x1)
   */
  normalSize(): this {
    return this.setTextSize({ width: 1, height: 1 });
  }

  /**
   * Set double width text
   */
  doubleWidth(): this {
    return this.setTextSize({ width: 2, height: 1 });
  }

  /**
   * Set double height text
   */
  doubleHeight(): this {
    return this.setTextSize({ width: 1, height: 2 });
  }

  /**
   * Set double width and height text
   */
  doubleSize(): this {
    return this.setTextSize({ width: 2, height: 2 });
  }

  // ==========================================================================
  // Alignment Commands
  // ==========================================================================

  /**
   * Set text alignment (ESC a n)
   * @param alignment - TextAlignment value
   */
  align(alignment: TextAlignment): this {
    this.buffer.push(ESC, 0x61, alignment); // ESC a n
    return this;
  }

  /**
   * Align text to the left
   */
  alignLeft(): this {
    return this.align(TextAlignment.LEFT);
  }

  /**
   * Align text to the center
   */
  alignCenter(): this {
    return this.align(TextAlignment.CENTER);
  }

  /**
   * Align text to the right
   */
  alignRight(): this {
    return this.align(TextAlignment.RIGHT);
  }

  // ==========================================================================
  // Text Output Commands
  // ==========================================================================

  /**
   * Add raw text to the buffer
   * @param content - text string to add
   */
  text(content: string): this {
    const bytes = Buffer.from(content, 'utf8');
    for (const byte of bytes) {
      this.buffer.push(byte);
    }
    return this;
  }

  /**
   * Add text followed by a line feed
   * @param content - text string to add
   */
  textLine(content: string): this {
    return this.text(content).lineFeed();
  }

  /**
   * Add a line feed (LF)
   * @param count - number of line feeds (default 1)
   */
  lineFeed(count: number = 1): this {
    for (let i = 0; i < count; i++) {
      this.buffer.push(LF);
    }
    return this;
  }

  /**
   * Add a carriage return and line feed
   */
  newLine(): this {
    this.buffer.push(CR, LF);
    return this;
  }

  // ==========================================================================
  // Line Drawing and Separators
  // ==========================================================================

  /**
   * Draw a horizontal line using a character
   * @param char - character to use for the line (default '-')
   */
  horizontalLine(char: string = '-'): this {
    const line = char.repeat(this.lineWidth);
    return this.textLine(line);
  }

  /**
   * Draw a double horizontal line
   */
  doubleLine(): this {
    return this.horizontalLine('=');
  }

  /**
   * Draw a dotted line
   */
  dottedLine(): this {
    return this.horizontalLine('.');
  }

  /**
   * Add empty lines as spacing
   * @param count - number of empty lines
   */
  emptyLines(count: number): this {
    return this.lineFeed(count);
  }

  /**
   * Print a two-column row (left and right aligned text)
   * @param left - left-aligned text
   * @param right - right-aligned text
   */
  twoColumnRow(left: string, right: string): this {
    const padding = this.lineWidth - left.length - right.length;
    if (padding < 1) {
      // If text is too long, truncate left side
      const maxLeft = this.lineWidth - right.length - 1;
      const truncatedLeft = left.substring(0, maxLeft);
      const spaces = ' '.repeat(this.lineWidth - truncatedLeft.length - right.length);
      return this.textLine(truncatedLeft + spaces + right);
    }
    const spaces = ' '.repeat(padding);
    return this.textLine(left + spaces + right);
  }

  /**
   * Print a three-column row
   * @param left - left-aligned text
   * @param center - center text
   * @param right - right-aligned text
   */
  threeColumnRow(left: string, center: string, right: string): this {
    const totalTextLength = left.length + center.length + right.length;
    const totalPadding = this.lineWidth - totalTextLength;

    if (totalPadding < 2) {
      // Fallback to two columns if not enough space
      return this.twoColumnRow(left, right);
    }

    const leftPadding = Math.floor(totalPadding / 2);
    const rightPadding = totalPadding - leftPadding;

    const line = left + ' '.repeat(leftPadding) + center + ' '.repeat(rightPadding) + right;
    return this.textLine(line);
  }

  // ==========================================================================
  // Paper Cut Commands
  // ==========================================================================

  /**
   * Full paper cut (GS V 0)
   */
  fullCut(): this {
    this.buffer.push(GS, 0x56, 0x00); // GS V 0
    return this;
  }

  /**
   * Partial paper cut (GS V 1)
   */
  partialCut(): this {
    this.buffer.push(GS, 0x56, 0x01); // GS V 1
    return this;
  }

  /**
   * Feed paper and cut (GS V 66 n)
   * @param feedLines - number of lines to feed before cutting (default 3)
   */
  feedAndCut(feedLines: number = 3): this {
    this.buffer.push(GS, 0x56, 0x42, feedLines); // GS V 66 n
    return this;
  }

  /**
   * Default cut command (feed and partial cut)
   */
  cut(): this {
    return this.feedAndCut(3);
  }

  // ==========================================================================
  // Cash Drawer Commands
  // ==========================================================================

  /**
   * Open cash drawer (ESC p m t1 t2)
   * @param pin - drawer pin (0 or 1)
   */
  openCashDrawer(pin: 0 | 1 = 0): this {
    // ESC p m t1 t2
    // m = pin connector (0 or 1)
    // t1 = on time (25ms units)
    // t2 = off time (25ms units)
    this.buffer.push(ESC, 0x70, pin, 25, 250);
    return this;
  }

  // ==========================================================================
  // Build Methods
  // ==========================================================================

  /**
   * Get the current buffer as a Buffer object
   */
  build(): Buffer {
    return Buffer.from(this.buffer);
  }

  /**
   * Get the current buffer length
   */
  getLength(): number {
    return this.buffer.length;
  }

  /**
   * Get the paper size
   */
  getPaperSize(): PaperSize {
    return this.paperSize;
  }

  /**
   * Get the line width in characters
   */
  getLineWidth(): number {
    return this.lineWidth;
  }

  /**
   * Clear the buffer
   */
  clear(): this {
    this.buffer = [];
    return this;
  }

  /**
   * Append raw bytes to the buffer
   * @param bytes - array of bytes or Buffer to append
   */
  raw(bytes: number[] | Buffer): this {
    if (Buffer.isBuffer(bytes)) {
      for (const byte of bytes) {
        this.buffer.push(byte);
      }
    } else {
      this.buffer.push(...bytes);
    }
    return this;
  }
}
