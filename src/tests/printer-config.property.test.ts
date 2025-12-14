/**
 * Property-Based Tests for Printer Configuration
 *
 * **Feature: pos-printer-drivers, Property 1: Printer Configuration Round-Trip**
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
 *
 * This test verifies that for any valid printer configuration, saving it to
 * the database and then loading it should produce an equivalent configuration
 * object with all fields preserved.
 */

import * as fc from 'fast-check';
import {
  PrinterConfig,
  PrinterType,
  PrinterRole,
  PaperSize,
  ConnectionDetails,
  NetworkConnectionDetails,
  BluetoothConnectionDetails,
  USBConnectionDetails,
} from '../main/printer/types';
import {
  serializePrinterConfig,
  deserializePrinterConfig,
  arePrinterConfigsEqual,
} from '../main/printer/types/serialization';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

// ============================================================================
// Arbitraries for generating valid printer configurations
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
 * Arbitrary for generating valid port numbers
 */
const portArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 65535 });

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
 * Arbitrary for generating valid RFCOMM channels (1-30)
 */
const rfcommChannelArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 30 });

/**
 * Arbitrary for generating valid USB vendor/product IDs
 */
const usbIdArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 65535 });

/**
 * Arbitrary for generating network connection details
 */
const networkConnectionDetailsArb: fc.Arbitrary<NetworkConnectionDetails> = fc.record({
  type: fc.constant('network' as const),
  ip: ipv4Arb,
  port: portArb,
  hostname: fc.option(fc.string({ minLength: 1, maxLength: 63 }), { nil: undefined }),
});

/**
 * Arbitrary for generating WiFi connection details
 */
const wifiConnectionDetailsArb: fc.Arbitrary<NetworkConnectionDetails> = fc.record({
  type: fc.constant('wifi' as const),
  ip: ipv4Arb,
  port: portArb,
  hostname: fc.option(fc.string({ minLength: 1, maxLength: 63 }), { nil: undefined }),
});

/**
 * Arbitrary for generating Bluetooth connection details
 */
const bluetoothConnectionDetailsArb: fc.Arbitrary<BluetoothConnectionDetails> = fc.record({
  type: fc.constant('bluetooth' as const),
  address: macAddressArb,
  channel: rfcommChannelArb,
  deviceName: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
});

/**
 * Arbitrary for generating USB connection details
 */
const usbConnectionDetailsArb: fc.Arbitrary<USBConnectionDetails> = fc.record({
  type: fc.constant('usb' as const),
  vendorId: usbIdArb,
  productId: usbIdArb,
  systemName: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
  path: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
});

/**
 * Arbitrary for generating any connection details
 */
const connectionDetailsArb: fc.Arbitrary<ConnectionDetails> = fc.oneof(
  networkConnectionDetailsArb,
  wifiConnectionDetailsArb,
  bluetoothConnectionDetailsArb,
  usbConnectionDetailsArb
);

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
 * Arbitrary for generating printer roles
 */
const printerRoleArb: fc.Arbitrary<PrinterRole> = fc.constantFrom(
  PrinterRole.RECEIPT,
  PrinterRole.KITCHEN,
  PrinterRole.BAR,
  PrinterRole.LABEL
);

/**
 * Arbitrary for generating paper sizes
 */
const paperSizeArb: fc.Arbitrary<PaperSize> = fc.constantFrom(
  PaperSize.MM_58,
  PaperSize.MM_80,
  PaperSize.MM_112
);

/**
 * Arbitrary for generating character sets
 */
const characterSetArb: fc.Arbitrary<string> = fc.constantFrom(
  'PC437_USA',
  'PC850_MULTILINGUAL',
  'PC860_PORTUGUESE',
  'PC863_CANADIAN_FRENCH',
  'PC865_NORDIC',
  'GBK',
  'UTF8'
);

/**
 * Arbitrary for generating valid dates (within reasonable range)
 */
const dateArb: fc.Arbitrary<Date> = fc
  .integer({ min: 1609459200000, max: 1893456000000 }) // 2021-01-01 to 2030-01-01
  .map((ts) => new Date(ts));

/**
 * Arbitrary for generating valid UUIDs
 */
const uuidArb: fc.Arbitrary<string> = fc.uuid();

/**
 * Arbitrary for generating printer names
 */
const printerNameArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 100 });

/**
 * Generate connection details that match the printer type
 */
function connectionDetailsForType(type: PrinterType): fc.Arbitrary<ConnectionDetails> {
  switch (type) {
    case PrinterType.NETWORK:
      return networkConnectionDetailsArb;
    case PrinterType.WIFI:
      return wifiConnectionDetailsArb;
    case PrinterType.BLUETOOTH:
      return bluetoothConnectionDetailsArb;
    case PrinterType.USB:
      return usbConnectionDetailsArb;
    default:
      return connectionDetailsArb;
  }
}

/**
 * Arbitrary for generating valid printer configurations with matching type and connection details
 */
const printerConfigArb: fc.Arbitrary<PrinterConfig> = printerTypeArb.chain((type) =>
  fc.record({
    id: uuidArb,
    name: printerNameArb,
    type: fc.constant(type),
    connectionDetails: connectionDetailsForType(type),
    paperSize: paperSizeArb,
    characterSet: characterSetArb,
    role: printerRoleArb,
    isDefault: fc.boolean(),
    fallbackPrinterId: fc.option(uuidArb, { nil: undefined }),
    enabled: fc.boolean(),
    createdAt: dateArb,
    updatedAt: dateArb,
  })
);

// ============================================================================
// Property Tests
// ============================================================================

describe('Printer Configuration Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 1: Printer Configuration Round-Trip**
   * **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
   *
   * Property: For any valid printer configuration, serializing it and then
   * deserializing should produce an equivalent configuration object.
   */
  describe('Property 1: Printer Configuration Round-Trip', () => {
    it('serialization followed by deserialization preserves all fields', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigArb, async (config) => {
          // Serialize the configuration
          const serialized = serializePrinterConfig(config);

          // Deserialize back to PrinterConfig
          const deserialized = deserializePrinterConfig(serialized);

          // Verify all fields are preserved
          expect(arePrinterConfigsEqual(config, deserialized)).toBe(true);
        }),
        { verbose: true }
      );
    });

    it('serialization produces valid JSON for connectionDetails', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigArb, async (config) => {
          const serialized = serializePrinterConfig(config);

          // connectionDetails should be valid JSON
          expect(() => JSON.parse(serialized.connectionDetails)).not.toThrow();

          // Parsed JSON should match original
          const parsed = JSON.parse(serialized.connectionDetails);
          expect(parsed.type).toBe(config.connectionDetails.type);
        }),
        { verbose: true }
      );
    });

    it('serialization converts booleans to SQLite integers', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigArb, async (config) => {
          const serialized = serializePrinterConfig(config);

          // isDefault should be 0 or 1
          expect(serialized.isDefault).toBeGreaterThanOrEqual(0);
          expect(serialized.isDefault).toBeLessThanOrEqual(1);
          expect(serialized.isDefault).toBe(config.isDefault ? 1 : 0);

          // enabled should be 0 or 1
          expect(serialized.enabled).toBeGreaterThanOrEqual(0);
          expect(serialized.enabled).toBeLessThanOrEqual(1);
          expect(serialized.enabled).toBe(config.enabled ? 1 : 0);
        }),
        { verbose: true }
      );
    });

    it('serialization converts dates to ISO strings', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigArb, async (config) => {
          const serialized = serializePrinterConfig(config);

          // Dates should be valid ISO strings
          expect(new Date(serialized.createdAt).toISOString()).toBe(serialized.createdAt);
          expect(new Date(serialized.updatedAt).toISOString()).toBe(serialized.updatedAt);
        }),
        { verbose: true }
      );
    });

    it('deserialization restores correct enum values', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigArb, async (config) => {
          const serialized = serializePrinterConfig(config);
          const deserialized = deserializePrinterConfig(serialized);

          // Enum values should be restored correctly
          expect(Object.values(PrinterType)).toContain(deserialized.type);
          expect(Object.values(PrinterRole)).toContain(deserialized.role);
          expect(Object.values(PaperSize)).toContain(deserialized.paperSize);
        }),
        { verbose: true }
      );
    });

    it('optional fallbackPrinterId is preserved correctly', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigArb, async (config) => {
          const serialized = serializePrinterConfig(config);
          const deserialized = deserializePrinterConfig(serialized);

          // Optional field should be preserved
          expect(deserialized.fallbackPrinterId).toBe(config.fallbackPrinterId);
        }),
        { verbose: true }
      );
    });

    it('multiple round-trips produce identical results', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigArb, async (config) => {
          // First round-trip
          const serialized1 = serializePrinterConfig(config);
          const deserialized1 = deserializePrinterConfig(serialized1);

          // Second round-trip
          const serialized2 = serializePrinterConfig(deserialized1);
          const deserialized2 = deserializePrinterConfig(serialized2);

          // Both deserializations should be equal
          expect(arePrinterConfigsEqual(deserialized1, deserialized2)).toBe(true);
        }),
        { verbose: true }
      );
    });
  });

  /**
   * Connection Details specific tests
   */
  describe('Connection Details Round-Trip', () => {
    it('network connection details are preserved', async () => {
      await fc.assert(
        fc.asyncProperty(networkConnectionDetailsArb, async (details) => {
          const json = JSON.stringify(details);
          const parsed = JSON.parse(json) as NetworkConnectionDetails;

          expect(parsed.type).toBe(details.type);
          expect(parsed.ip).toBe(details.ip);
          expect(parsed.port).toBe(details.port);
          expect(parsed.hostname).toBe(details.hostname);
        }),
        { verbose: true }
      );
    });

    it('bluetooth connection details are preserved', async () => {
      await fc.assert(
        fc.asyncProperty(bluetoothConnectionDetailsArb, async (details) => {
          const json = JSON.stringify(details);
          const parsed = JSON.parse(json) as BluetoothConnectionDetails;

          expect(parsed.type).toBe(details.type);
          expect(parsed.address).toBe(details.address);
          expect(parsed.channel).toBe(details.channel);
          expect(parsed.deviceName).toBe(details.deviceName);
        }),
        { verbose: true }
      );
    });

    it('USB connection details are preserved', async () => {
      await fc.assert(
        fc.asyncProperty(usbConnectionDetailsArb, async (details) => {
          const json = JSON.stringify(details);
          const parsed = JSON.parse(json) as USBConnectionDetails;

          expect(parsed.type).toBe(details.type);
          expect(parsed.vendorId).toBe(details.vendorId);
          expect(parsed.productId).toBe(details.productId);
          expect(parsed.systemName).toBe(details.systemName);
          expect(parsed.path).toBe(details.path);
        }),
        { verbose: true }
      );
    });
  });
});
