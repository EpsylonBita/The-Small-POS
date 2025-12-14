/**
 * Property-Based Tests for Discovered Printer Formatting
 *
 * **Feature: pos-printer-drivers, Property 10: Discovered Printer Formatting**
 * **Validates: Requirements 1.4**
 *
 * This test verifies that for any discovered printer (regardless of connection type),
 * the formatted display should include the printer name, connection type, and address.
 */

import * as fc from 'fast-check';
import { DiscoveredPrinter, PrinterType } from '../main/printer/types';
import { formatDiscoveredPrinter } from '../main/printer/discovery/PrinterDiscovery';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

// ============================================================================
// Arbitraries for generating discovered printers
// ============================================================================

/**
 * Arbitrary for generating valid IPv4 addresses
 */
const ipv4Arb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 1, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 1, max: 254 })
  )
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

/**
 * Arbitrary for generating valid MAC addresses
 */
const macAddressArb: fc.Arbitrary<string> = fc
  .array(
    fc.integer({ min: 0, max: 255 }).map((n) => n.toString(16).padStart(2, '0').toUpperCase()),
    { minLength: 6, maxLength: 6 }
  )
  .map((parts) => parts.join(':'));

/**
 * Arbitrary for generating USB device addresses (vendorId:productId)
 */
const usbAddressArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 0, max: 65535 }),
    fc.integer({ min: 0, max: 65535 })
  )
  .map(([vendor, product]) => `${vendor}:${product}`);

/**
 * Arbitrary for generating valid port numbers
 */
const portArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 65535 });

/**
 * Arbitrary for generating printer types
 */
const printerTypeArb: fc.Arbitrary<PrinterType> = fc.constantFrom(
  PrinterType.NETWORK,
  PrinterType.BLUETOOTH,
  PrinterType.USB,
  PrinterType.WIFI
);

/**
 * Arbitrary for generating non-empty printer names
 */
const printerNameArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 100 })
  .filter(s => s.trim().length > 0);

/**
 * Arbitrary for generating optional model names
 */
const modelArb: fc.Arbitrary<string | undefined> = fc.option(
  fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
  { nil: undefined }
);

/**
 * Arbitrary for generating optional manufacturer names
 */
const manufacturerArb: fc.Arbitrary<string | undefined> = fc.option(
  fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
  { nil: undefined }
);

/**
 * Generate address appropriate for the printer type
 */
function addressForType(type: PrinterType): fc.Arbitrary<string> {
  switch (type) {
    case PrinterType.NETWORK:
    case PrinterType.WIFI:
      return ipv4Arb;
    case PrinterType.BLUETOOTH:
      return macAddressArb;
    case PrinterType.USB:
      return usbAddressArb;
    default:
      return fc.string({ minLength: 1, maxLength: 50 });
  }
}

/**
 * Generate port appropriate for the printer type
 */
function portForType(type: PrinterType): fc.Arbitrary<number | undefined> {
  switch (type) {
    case PrinterType.NETWORK:
    case PrinterType.WIFI:
      return portArb.map(p => p as number | undefined);
    case PrinterType.BLUETOOTH:
      // Bluetooth uses channel (1-30)
      return fc.integer({ min: 1, max: 30 }).map(p => p as number | undefined);
    case PrinterType.USB:
      // USB doesn't typically have a port
      return fc.constant(undefined);
    default:
      return fc.option(portArb, { nil: undefined });
  }
}

/**
 * Arbitrary for generating discovered printers with type-appropriate addresses
 */
const discoveredPrinterArb: fc.Arbitrary<DiscoveredPrinter> = printerTypeArb.chain((type) =>
  fc.record({
    name: printerNameArb,
    type: fc.constant(type),
    address: addressForType(type),
    port: portForType(type),
    model: modelArb,
    manufacturer: manufacturerArb,
    isConfigured: fc.boolean(),
  })
);

/**
 * Arbitrary for network printers specifically
 */
const networkPrinterArb: fc.Arbitrary<DiscoveredPrinter> = fc.record({
  name: printerNameArb,
  type: fc.constant(PrinterType.NETWORK),
  address: ipv4Arb,
  port: portArb.map(p => p as number | undefined),
  model: modelArb,
  manufacturer: manufacturerArb,
  isConfigured: fc.boolean(),
});

/**
 * Arbitrary for Bluetooth printers specifically
 */
const bluetoothPrinterArb: fc.Arbitrary<DiscoveredPrinter> = fc.record({
  name: printerNameArb,
  type: fc.constant(PrinterType.BLUETOOTH),
  address: macAddressArb,
  port: fc.integer({ min: 1, max: 30 }).map(p => p as number | undefined),
  model: modelArb,
  manufacturer: manufacturerArb,
  isConfigured: fc.boolean(),
});

/**
 * Arbitrary for USB printers specifically
 */
const usbPrinterArb: fc.Arbitrary<DiscoveredPrinter> = fc.record({
  name: printerNameArb,
  type: fc.constant(PrinterType.USB),
  address: usbAddressArb,
  port: fc.constant(undefined),
  model: modelArb,
  manufacturer: manufacturerArb,
  isConfigured: fc.boolean(),
});

/**
 * Arbitrary for WiFi printers specifically
 */
const wifiPrinterArb: fc.Arbitrary<DiscoveredPrinter> = fc.record({
  name: printerNameArb,
  type: fc.constant(PrinterType.WIFI),
  address: ipv4Arb,
  port: portArb.map(p => p as number | undefined),
  model: modelArb,
  manufacturer: manufacturerArb,
  isConfigured: fc.boolean(),
});

// ============================================================================
// Property Tests
// ============================================================================

describe('Discovered Printer Formatting Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 10: Discovered Printer Formatting**
   * **Validates: Requirements 1.4**
   *
   * Property: For any discovered printer (regardless of connection type),
   * the formatted display should include the printer name, connection type, and address.
   */
  describe('Property 10: Discovered Printer Formatting', () => {
    it('formatted output always contains the printer name', async () => {
      await fc.assert(
        fc.asyncProperty(discoveredPrinterArb, async (printer) => {
          const formatted = formatDiscoveredPrinter(printer);
          
          // The formatted string must contain the printer name
          expect(formatted).toContain(printer.name);
        }),
        { verbose: true }
      );
    });

    it('formatted output always contains the connection type', async () => {
      await fc.assert(
        fc.asyncProperty(discoveredPrinterArb, async (printer) => {
          const formatted = formatDiscoveredPrinter(printer);
          
          // The formatted string must contain the connection type (uppercase)
          expect(formatted.toUpperCase()).toContain(printer.type.toUpperCase());
        }),
        { verbose: true }
      );
    });

    it('formatted output always contains the address', async () => {
      await fc.assert(
        fc.asyncProperty(discoveredPrinterArb, async (printer) => {
          const formatted = formatDiscoveredPrinter(printer);
          
          // The formatted string must contain the address
          expect(formatted).toContain(printer.address);
        }),
        { verbose: true }
      );
    });

    it('formatted output is non-empty for any valid printer', async () => {
      await fc.assert(
        fc.asyncProperty(discoveredPrinterArb, async (printer) => {
          const formatted = formatDiscoveredPrinter(printer);
          
          // The formatted string must be non-empty
          expect(formatted.length).toBeGreaterThan(0);
          expect(formatted.trim().length).toBeGreaterThan(0);
        }),
        { verbose: true }
      );
    });

    it('formatted output includes port when present (for network/wifi printers)', async () => {
      await fc.assert(
        fc.asyncProperty(networkPrinterArb, async (printer) => {
          const formatted = formatDiscoveredPrinter(printer);
          
          // For network printers with a port, the formatted string should include it
          if (printer.port !== undefined) {
            expect(formatted).toContain(`:${printer.port}`);
          }
        }),
        { verbose: true }
      );
    });

    it('formatted output includes model when present', async () => {
      await fc.assert(
        fc.asyncProperty(discoveredPrinterArb, async (printer) => {
          const formatted = formatDiscoveredPrinter(printer);
          
          // If model is present, it should be in the formatted output
          if (printer.model) {
            expect(formatted).toContain(printer.model);
          }
        }),
        { verbose: true }
      );
    });

    it('formatted output includes manufacturer when model is absent', async () => {
      await fc.assert(
        fc.asyncProperty(
          discoveredPrinterArb.filter(p => !p.model && p.manufacturer !== undefined),
          async (printer) => {
            const formatted = formatDiscoveredPrinter(printer);
            
            // If manufacturer is present and model is absent, manufacturer should be shown
            if (printer.manufacturer) {
              expect(formatted).toContain(printer.manufacturer);
            }
          }
        ),
        { verbose: true }
      );
    });
  });

  /**
   * Type-specific formatting tests
   */
  describe('Type-Specific Formatting', () => {
    it('network printers format correctly', async () => {
      await fc.assert(
        fc.asyncProperty(networkPrinterArb, async (printer) => {
          const formatted = formatDiscoveredPrinter(printer);
          
          expect(formatted).toContain(printer.name);
          expect(formatted.toUpperCase()).toContain('NETWORK');
          expect(formatted).toContain(printer.address);
        }),
        { verbose: true }
      );
    });

    it('bluetooth printers format correctly', async () => {
      await fc.assert(
        fc.asyncProperty(bluetoothPrinterArb, async (printer) => {
          const formatted = formatDiscoveredPrinter(printer);
          
          expect(formatted).toContain(printer.name);
          expect(formatted.toUpperCase()).toContain('BLUETOOTH');
          expect(formatted).toContain(printer.address);
        }),
        { verbose: true }
      );
    });

    it('USB printers format correctly', async () => {
      await fc.assert(
        fc.asyncProperty(usbPrinterArb, async (printer) => {
          const formatted = formatDiscoveredPrinter(printer);
          
          expect(formatted).toContain(printer.name);
          expect(formatted.toUpperCase()).toContain('USB');
          expect(formatted).toContain(printer.address);
        }),
        { verbose: true }
      );
    });

    it('WiFi printers format correctly', async () => {
      await fc.assert(
        fc.asyncProperty(wifiPrinterArb, async (printer) => {
          const formatted = formatDiscoveredPrinter(printer);
          
          expect(formatted).toContain(printer.name);
          expect(formatted.toUpperCase()).toContain('WIFI');
          expect(formatted).toContain(printer.address);
        }),
        { verbose: true }
      );
    });
  });

  /**
   * Consistency tests
   */
  describe('Formatting Consistency', () => {
    it('same printer always produces same formatted output', async () => {
      await fc.assert(
        fc.asyncProperty(discoveredPrinterArb, async (printer) => {
          const formatted1 = formatDiscoveredPrinter(printer);
          const formatted2 = formatDiscoveredPrinter(printer);
          
          // Same input should always produce same output
          expect(formatted1).toBe(formatted2);
        }),
        { verbose: true }
      );
    });

    it('formatting is deterministic across multiple calls', async () => {
      await fc.assert(
        fc.asyncProperty(discoveredPrinterArb, fc.integer({ min: 2, max: 10 }), async (printer, iterations) => {
          const results: string[] = [];
          
          for (let i = 0; i < iterations; i++) {
            results.push(formatDiscoveredPrinter(printer));
          }
          
          // All results should be identical
          const first = results[0];
          expect(results.every(r => r === first)).toBe(true);
        }),
        { verbose: true }
      );
    });
  });
});
