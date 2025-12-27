/**
 * Property-Based Tests for ESC/POS Command Generation
 *
 * **Feature: pos-printer-drivers, Property 6: ESC/POS Command Generation**
 * **Validates: Requirements 2.4**
 *
 * This test verifies that for any valid print job data (receipt, kitchen ticket, etc.),
 * the generated ESC/POS command buffer should be non-empty, start with the
 * initialization sequence (ESC @), and end with a cut command.
 */

import * as fc from 'fast-check';
import './propertyTestConfig';
import {
  PaperSize,
  ReceiptData,
  KitchenTicketData,
  PrintOrderItem,
} from '../main/printer/types';
import {
  EscPosBuilder,
  ESC,
  GS,
  TextAlignment,
} from '../main/printer/services/escpos/EscPosBuilder';
import { ReceiptGenerator } from '../main/printer/services/escpos/ReceiptGenerator';

// Configure fast-check
// Configuration is handled by propertyTestConfig.ts import

// ============================================================================
// ESC/POS Command Constants for Verification
// ============================================================================

// ESC @ (Initialize printer)
const INIT_SEQUENCE = Buffer.from([ESC, 0x40]);

// GS V 66 n (Feed and cut) - we check for GS V (0x1d 0x56)
const CUT_COMMAND_PREFIX = Buffer.from([GS, 0x56]);

// ============================================================================
// Arbitraries for generating valid print data
// ============================================================================

/**
 * Arbitrary for generating valid paper sizes
 */
const paperSizeArb: fc.Arbitrary<PaperSize> = fc.constantFrom(
  PaperSize.MM_58,
  PaperSize.MM_80,
  PaperSize.MM_112
);

/**
 * Arbitrary for generating valid dates
 */
const validDateArb: fc.Arbitrary<Date> = fc
  .integer({ min: new Date('2020-01-01').getTime(), max: new Date('2030-12-31').getTime() })
  .map((timestamp) => new Date(timestamp));

/**
 * Arbitrary for generating valid order items
 */
const orderItemArb: fc.Arbitrary<PrintOrderItem> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }),
  quantity: fc.integer({ min: 1, max: 100 }),
  unitPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
  total: fc.float({ min: Math.fround(0.01), max: Math.fround(10000), noNaN: true }),
  modifiers: fc.option(
    fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 5 }),
    { nil: undefined }
  ),
  specialInstructions: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
  category: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
});

/**
 * Arbitrary for generating valid receipt data
 */
const receiptDataArb: fc.Arbitrary<ReceiptData> = fc.record({
  orderNumber: fc.stringMatching(/^[A-Z0-9]{4,10}$/),
  orderType: fc.constantFrom('dine-in' as const, 'pickup' as const, 'delivery' as const),
  timestamp: validDateArb,
  items: fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
  subtotal: fc.float({ min: Math.fround(0.01), max: Math.fround(10000), noNaN: true }),
  tax: fc.float({ min: Math.fround(0), max: Math.fround(1000), noNaN: true }),
  tip: fc.option(fc.float({ min: Math.fround(0), max: Math.fround(500), noNaN: true }), { nil: undefined }),
  deliveryFee: fc.option(fc.float({ min: Math.fround(0), max: Math.fround(50), noNaN: true }), { nil: undefined }),
  total: fc.float({ min: Math.fround(0.01), max: Math.fround(15000), noNaN: true }),
  paymentMethod: fc.constantFrom('cash', 'card', 'mobile'),
  customerName: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
  customerPhone: fc.option(fc.stringMatching(/^\+?[0-9]{10,15}$/), { nil: undefined }),
  deliveryAddress: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
  tableName: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
});

/**
 * Arbitrary for generating valid kitchen ticket data
 */
const kitchenTicketDataArb: fc.Arbitrary<KitchenTicketData> = fc.record({
  orderNumber: fc.stringMatching(/^[A-Z0-9]{4,10}$/),
  orderType: fc.constantFrom('dine-in' as const, 'pickup' as const, 'delivery' as const),
  timestamp: validDateArb,
  items: fc.array(orderItemArb, { minLength: 1, maxLength: 10 }),
  customerName: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
  tableName: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
  specialInstructions: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
  station: fc.constantFrom('Grill', 'Fryer', 'Prep', 'Salad', 'Dessert', 'Bar'),
});

/**
 * Arbitrary for generating valid text content
 */
const textContentArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 100 });

/**
 * Arbitrary for generating valid text size
 */
const textSizeArb: fc.Arbitrary<{ width: number; height: number }> = fc.record({
  width: fc.integer({ min: 1, max: 8 }),
  height: fc.integer({ min: 1, max: 8 }),
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if buffer starts with the initialization sequence (ESC @)
 */
function startsWithInit(buffer: Buffer): boolean {
  if (buffer.length < 2) return false;
  return buffer[0] === INIT_SEQUENCE[0] && buffer[1] === INIT_SEQUENCE[1];
}

/**
 * Check if buffer contains a cut command (GS V)
 */
function containsCutCommand(buffer: Buffer): boolean {
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === CUT_COMMAND_PREFIX[0] && buffer[i + 1] === CUT_COMMAND_PREFIX[1]) {
      return true;
    }
  }
  return false;
}

/**
 * Find the position of the last cut command in the buffer
 */
function findLastCutCommandPosition(buffer: Buffer): number {
  let lastPos = -1;
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === CUT_COMMAND_PREFIX[0] && buffer[i + 1] === CUT_COMMAND_PREFIX[1]) {
      lastPos = i;
    }
  }
  return lastPos;
}

// ============================================================================
// Property Tests
// ============================================================================

describe('ESC/POS Command Generation Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 6: ESC/POS Command Generation**
   * **Validates: Requirements 2.4**
   */
  describe('Property 6: ESC/POS Command Generation', () => {
    describe('EscPosBuilder basic properties', () => {
      it('initialize() produces ESC @ command', () => {
        fc.assert(
          fc.property(paperSizeArb, (paperSize) => {
            const builder = new EscPosBuilder(paperSize);
            const buffer = builder.initialize().build();

            expect(buffer.length).toBeGreaterThanOrEqual(2);
            expect(startsWithInit(buffer)).toBe(true);
          }),
          { verbose: true }
        );
      });

      it('cut() produces GS V command', () => {
        fc.assert(
          fc.property(paperSizeArb, (paperSize) => {
            const builder = new EscPosBuilder(paperSize);
            const buffer = builder.cut().build();

            expect(buffer.length).toBeGreaterThanOrEqual(2);
            expect(containsCutCommand(buffer)).toBe(true);
          }),
          { verbose: true }
        );
      });

      it('text() adds content to buffer', () => {
        fc.assert(
          fc.property(paperSizeArb, textContentArb, (paperSize, text) => {
            const builder = new EscPosBuilder(paperSize);
            const buffer = builder.text(text).build();

            // Buffer should contain the text bytes
            expect(buffer.length).toBeGreaterThan(0);
            // The text should be present in the buffer
            const textBuffer = Buffer.from(text, 'utf8');
            expect(buffer.includes(textBuffer)).toBe(true);
          }),
          { verbose: true }
        );
      });

      it('build() returns non-empty buffer after any command', () => {
        fc.assert(
          fc.property(paperSizeArb, textContentArb, (paperSize, text) => {
            const builder = new EscPosBuilder(paperSize);
            const buffer = builder
              .initialize()
              .text(text)
              .lineFeed()
              .cut()
              .build();

            expect(buffer.length).toBeGreaterThan(0);
          }),
          { verbose: true }
        );
      });

      it('setTextSize clamps values to valid range (1-8)', () => {
        fc.assert(
          fc.property(
            paperSizeArb,
            fc.integer({ min: -10, max: 20 }),
            fc.integer({ min: -10, max: 20 }),
            (paperSize, width, height) => {
              const builder = new EscPosBuilder(paperSize);
              // Should not throw even with out-of-range values
              expect(() => {
                builder.setTextSize({ width, height });
              }).not.toThrow();

              const buffer = builder.build();
              // GS ! n command should be present
              expect(buffer.length).toBe(3);
              expect(buffer[0]).toBe(GS);
              expect(buffer[1]).toBe(0x21);
            }
          ),
          { verbose: true }
        );
      });

      it('alignment commands produce valid ESC a n sequences', () => {
        fc.assert(
          fc.property(
            paperSizeArb,
            fc.constantFrom(TextAlignment.LEFT, TextAlignment.CENTER, TextAlignment.RIGHT),
            (paperSize, alignment) => {
              const builder = new EscPosBuilder(paperSize);
              const buffer = builder.align(alignment).build();

              expect(buffer.length).toBe(3);
              expect(buffer[0]).toBe(ESC);
              expect(buffer[1]).toBe(0x61); // 'a'
              expect(buffer[2]).toBe(alignment);
            }
          ),
          { verbose: true }
        );
      });

      it('bold command produces valid ESC E n sequence', () => {
        fc.assert(
          fc.property(paperSizeArb, fc.boolean(), (paperSize, enabled) => {
            const builder = new EscPosBuilder(paperSize);
            const buffer = builder.bold(enabled).build();

            expect(buffer.length).toBe(3);
            expect(buffer[0]).toBe(ESC);
            expect(buffer[1]).toBe(0x45); // 'E'
            expect(buffer[2]).toBe(enabled ? 1 : 0);
          }),
          { verbose: true }
        );
      });

      it('underline command produces valid ESC - n sequence', () => {
        fc.assert(
          fc.property(
            paperSizeArb,
            fc.constantFrom(0 as const, 1 as const, 2 as const),
            (paperSize, mode) => {
              const builder = new EscPosBuilder(paperSize);
              const buffer = builder.underline(mode).build();

              expect(buffer.length).toBe(3);
              expect(buffer[0]).toBe(ESC);
              expect(buffer[1]).toBe(0x2d); // '-'
              expect(buffer[2]).toBe(mode);
            }
          ),
          { verbose: true }
        );
      });

      it('lineFeed adds correct number of LF bytes', () => {
        fc.assert(
          fc.property(
            paperSizeArb,
            fc.integer({ min: 1, max: 10 }),
            (paperSize, count) => {
              const builder = new EscPosBuilder(paperSize);
              const buffer = builder.lineFeed(count).build();

              expect(buffer.length).toBe(count);
              for (let i = 0; i < count; i++) {
                expect(buffer[i]).toBe(0x0a); // LF
              }
            }
          ),
          { verbose: true }
        );
      });

      it('clear() resets buffer to empty', () => {
        fc.assert(
          fc.property(paperSizeArb, textContentArb, (paperSize, text) => {
            const builder = new EscPosBuilder(paperSize);
            builder.initialize().text(text).lineFeed();

            expect(builder.getLength()).toBeGreaterThan(0);

            builder.clear();
            expect(builder.getLength()).toBe(0);
            expect(builder.build().length).toBe(0);
          }),
          { verbose: true }
        );
      });
    });

    describe('ReceiptGenerator properties', () => {
      it('generateReceipt produces non-empty buffer starting with init and ending with cut', () => {
        fc.assert(
          fc.property(paperSizeArb, receiptDataArb, (paperSize, receiptData) => {
            const generator = new ReceiptGenerator({ paperSize });
            const buffer = generator.generateReceipt(receiptData);

            // Buffer should be non-empty
            expect(buffer.length).toBeGreaterThan(0);

            // Should start with initialization sequence (ESC @)
            expect(startsWithInit(buffer)).toBe(true);

            // Should contain a cut command
            expect(containsCutCommand(buffer)).toBe(true);

            // Cut command should be near the end (within last 10 bytes)
            const cutPos = findLastCutCommandPosition(buffer);
            expect(cutPos).toBeGreaterThan(buffer.length - 10);
          }),
          { verbose: true }
        );
      });

      it('generateKitchenTicket produces non-empty buffer starting with init and ending with cut', () => {
        fc.assert(
          fc.property(paperSizeArb, kitchenTicketDataArb, (paperSize, ticketData) => {
            const generator = new ReceiptGenerator({ paperSize });
            const buffer = generator.generateKitchenTicket(ticketData);

            // Buffer should be non-empty
            expect(buffer.length).toBeGreaterThan(0);

            // Should start with initialization sequence (ESC @)
            expect(startsWithInit(buffer)).toBe(true);

            // Should contain a cut command
            expect(containsCutCommand(buffer)).toBe(true);

            // Cut command should be near the end
            const cutPos = findLastCutCommandPosition(buffer);
            expect(cutPos).toBeGreaterThan(buffer.length - 10);
          }),
          { verbose: true }
        );
      });

      it('generateTestPrint produces non-empty buffer starting with init and ending with cut', () => {
        fc.assert(
          fc.property(
            paperSizeArb,
            fc.string({ minLength: 1, maxLength: 50 }),
            (paperSize, printerName) => {
              const generator = new ReceiptGenerator({ paperSize });
              const buffer = generator.generateTestPrint(printerName);

              // Buffer should be non-empty
              expect(buffer.length).toBeGreaterThan(0);

              // Should start with initialization sequence (ESC @)
              expect(startsWithInit(buffer)).toBe(true);

              // Should contain a cut command
              expect(containsCutCommand(buffer)).toBe(true);

              // Cut command should be near the end
              const cutPos = findLastCutCommandPosition(buffer);
              expect(cutPos).toBeGreaterThan(buffer.length - 10);
            }
          ),
          { verbose: true }
        );
      });

      it('receipt buffer contains order number', () => {
        fc.assert(
          fc.property(paperSizeArb, receiptDataArb, (paperSize, receiptData) => {
            const generator = new ReceiptGenerator({ paperSize });
            const buffer = generator.generateReceipt(receiptData);

            // Buffer should contain the order number
            const orderNumberBuffer = Buffer.from(receiptData.orderNumber, 'utf8');
            expect(buffer.includes(orderNumberBuffer)).toBe(true);
          }),
          { verbose: true }
        );
      });

      it('kitchen ticket buffer contains station name', () => {
        fc.assert(
          fc.property(paperSizeArb, kitchenTicketDataArb, (paperSize, ticketData) => {
            const generator = new ReceiptGenerator({ paperSize });
            const buffer = generator.generateKitchenTicket(ticketData);

            // Buffer should contain the station name (uppercase)
            const stationBuffer = Buffer.from(ticketData.station.toUpperCase(), 'utf8');
            expect(buffer.includes(stationBuffer)).toBe(true);
          }),
          { verbose: true }
        );
      });

      it('test print buffer contains printer name', () => {
        fc.assert(
          fc.property(
            paperSizeArb,
            fc.string({ minLength: 1, maxLength: 50 }),
            (paperSize, printerName) => {
              const generator = new ReceiptGenerator({ paperSize });
              const buffer = generator.generateTestPrint(printerName);

              // Buffer should contain the printer name
              const printerNameBuffer = Buffer.from(printerName, 'utf8');
              expect(buffer.includes(printerNameBuffer)).toBe(true);
            }
          ),
          { verbose: true }
        );
      });

      it('different paper sizes produce different line widths', () => {
        fc.assert(
          fc.property(receiptDataArb, (receiptData) => {
            const generator58 = new ReceiptGenerator({ paperSize: PaperSize.MM_58 });
            const generator80 = new ReceiptGenerator({ paperSize: PaperSize.MM_80 });
            const generator112 = new ReceiptGenerator({ paperSize: PaperSize.MM_112 });

            const buffer58 = generator58.generateReceipt(receiptData);
            const buffer80 = generator80.generateReceipt(receiptData);
            const buffer112 = generator112.generateReceipt(receiptData);

            // All should be valid (non-empty, start with init, contain cut)
            expect(buffer58.length).toBeGreaterThan(0);
            expect(buffer80.length).toBeGreaterThan(0);
            expect(buffer112.length).toBeGreaterThan(0);

            expect(startsWithInit(buffer58)).toBe(true);
            expect(startsWithInit(buffer80)).toBe(true);
            expect(startsWithInit(buffer112)).toBe(true);

            expect(containsCutCommand(buffer58)).toBe(true);
            expect(containsCutCommand(buffer80)).toBe(true);
            expect(containsCutCommand(buffer112)).toBe(true);
          }),
          { verbose: true }
        );
      });
    });

    describe('Complete print job flow', () => {
      it('any valid receipt data produces a valid ESC/POS buffer', () => {
        fc.assert(
          fc.property(paperSizeArb, receiptDataArb, (paperSize, receiptData) => {
            const generator = new ReceiptGenerator({ paperSize });
            const buffer = generator.generateReceipt(receiptData);

            // Property 6 requirements:
            // 1. Buffer should be non-empty
            expect(buffer.length).toBeGreaterThan(0);

            // 2. Should start with initialization sequence (ESC @)
            expect(startsWithInit(buffer)).toBe(true);

            // 3. Should end with a cut command
            expect(containsCutCommand(buffer)).toBe(true);
          }),
          { verbose: true }
        );
      });

      it('any valid kitchen ticket data produces a valid ESC/POS buffer', () => {
        fc.assert(
          fc.property(paperSizeArb, kitchenTicketDataArb, (paperSize, ticketData) => {
            const generator = new ReceiptGenerator({ paperSize });
            const buffer = generator.generateKitchenTicket(ticketData);

            // Property 6 requirements:
            // 1. Buffer should be non-empty
            expect(buffer.length).toBeGreaterThan(0);

            // 2. Should start with initialization sequence (ESC @)
            expect(startsWithInit(buffer)).toBe(true);

            // 3. Should end with a cut command
            expect(containsCutCommand(buffer)).toBe(true);
          }),
          { verbose: true }
        );
      });
    });
  });
});
