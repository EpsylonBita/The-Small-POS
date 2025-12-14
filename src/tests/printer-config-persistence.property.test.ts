/**
 * Property-Based Tests for Printer Configuration Persistence (Database Layer)
 *
 * **Feature: pos-printer-drivers, Property 1: Printer Configuration Round-Trip** (database layer)
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
 *
 * This test verifies that for any valid printer configuration, saving it to
 * the SQLite database and then loading it should produce an equivalent
 * configuration object with all fields preserved.
 */

import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
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
import { arePrinterConfigsEqual } from '../main/printer/types/serialization';
import { PrinterConfigStore } from '../main/printer/services/PrinterConfigStore';
import { initializePrinterTables } from '../main/printer/services/PrinterDatabaseSchema';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

// ============================================================================
// Test Database Setup
// ============================================================================

let testDbPath: string;
let db: Database.Database;
let store: PrinterConfigStore;

beforeAll(() => {
  // Create a temporary database for testing
  const tempDir = os.tmpdir();
  testDbPath = path.join(tempDir, `printer-test-${Date.now()}.db`);
  db = new Database(testDbPath);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');

  // Initialize printer tables
  initializePrinterTables(db);

  // Create store instance
  store = new PrinterConfigStore(db);
});

afterAll(() => {
  // Close database and cleanup
  if (db) {
    db.close();
  }
  if (testDbPath && fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
    // Also remove WAL and SHM files if they exist
    const walPath = `${testDbPath}-wal`;
    const shmPath = `${testDbPath}-shm`;
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  }
});

beforeEach(() => {
  // Clear the printers table before each test
  db.exec('DELETE FROM printers');
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
 * Arbitrary for generating printer names (unique per test)
 */
const printerNameArb: fc.Arbitrary<string> = fc
  .tuple(fc.string({ minLength: 1, maxLength: 50 }), fc.uuid())
  .map(([name, uuid]) => `${name}-${uuid.slice(0, 8)}`);

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
      return networkConnectionDetailsArb;
  }
}

/**
 * Arbitrary for generating valid printer configuration input (without id, createdAt, updatedAt)
 */
const printerConfigInputArb: fc.Arbitrary<Omit<PrinterConfig, 'id' | 'createdAt' | 'updatedAt'>> =
  printerTypeArb.chain((type) =>
    fc.record({
      name: printerNameArb,
      type: fc.constant(type),
      connectionDetails: connectionDetailsForType(type),
      paperSize: paperSizeArb,
      characterSet: characterSetArb,
      role: printerRoleArb,
      isDefault: fc.boolean(),
      fallbackPrinterId: fc.constant(undefined), // Simplified for this test
      enabled: fc.boolean(),
    })
  );

// ============================================================================
// Property Tests
// ============================================================================

describe('Printer Configuration Persistence Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 1: Printer Configuration Round-Trip** (database layer)
   * **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
   *
   * Property: For any valid printer configuration, saving it to the database
   * and then loading it should produce an equivalent configuration object.
   */
  describe('Property 1: Printer Configuration Round-Trip (Database Layer)', () => {
    it('save followed by load preserves all fields', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigInputArb, async (configInput) => {
          // Clear database before each iteration
          db.exec('DELETE FROM printers');

          // Save the configuration
          const saved = store.save(configInput);

          // Load the configuration back
          const loaded = store.load(saved.id);

          // Verify loaded is not null
          expect(loaded).not.toBeNull();

          // Verify all fields are preserved
          expect(arePrinterConfigsEqual(saved, loaded!)).toBe(true);
        }),
        { verbose: true }
      );
    });

    it('save generates valid UUID for id', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigInputArb, async (configInput) => {
          db.exec('DELETE FROM printers');

          const saved = store.save(configInput);

          // ID should be a valid UUID format
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          expect(saved.id).toMatch(uuidRegex);
        }),
        { verbose: true }
      );
    });

    it('save sets createdAt and updatedAt timestamps', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigInputArb, async (configInput) => {
          db.exec('DELETE FROM printers');

          const beforeSave = new Date();
          const saved = store.save(configInput);
          const afterSave = new Date();

          // Timestamps should be within the save window
          expect(saved.createdAt.getTime()).toBeGreaterThanOrEqual(beforeSave.getTime());
          expect(saved.createdAt.getTime()).toBeLessThanOrEqual(afterSave.getTime());
          expect(saved.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeSave.getTime());
          expect(saved.updatedAt.getTime()).toBeLessThanOrEqual(afterSave.getTime());
        }),
        { verbose: true }
      );
    });

    it('update preserves createdAt but updates updatedAt', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigInputArb, async (configInput) => {
          db.exec('DELETE FROM printers');

          // Save initial configuration
          const saved = store.save(configInput);

          // Wait a small amount to ensure timestamp difference
          await new Promise((resolve) => setTimeout(resolve, 10));

          // Update the configuration
          const updated = store.update(saved.id, { name: `${saved.name}-updated` });

          expect(updated).not.toBeNull();
          // createdAt should be preserved
          expect(updated!.createdAt.toISOString()).toBe(saved.createdAt.toISOString());
          // updatedAt should be newer
          expect(updated!.updatedAt.getTime()).toBeGreaterThan(saved.updatedAt.getTime());
        }),
        { verbose: true }
      );
    });

    it('delete removes configuration from database', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigInputArb, async (configInput) => {
          db.exec('DELETE FROM printers');

          // Save configuration
          const saved = store.save(configInput);

          // Verify it exists
          expect(store.load(saved.id)).not.toBeNull();

          // Delete it
          const deleted = store.delete(saved.id);
          expect(deleted).toBe(true);

          // Verify it's gone
          expect(store.load(saved.id)).toBeNull();
        }),
        { verbose: true }
      );
    });

    it('getAll returns all saved configurations', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(printerConfigInputArb, { minLength: 1, maxLength: 5 }),
          async (configInputs) => {
            db.exec('DELETE FROM printers');

            // Save all configurations
            const savedConfigs = configInputs.map((input) => store.save(input));

            // Get all configurations
            const allConfigs = store.getAll();

            // Should have same count
            expect(allConfigs.length).toBe(savedConfigs.length);

            // Each saved config should be in the result
            // Note: isDefault may change due to business rule (only one default per role)
            // so we compare all fields except isDefault
            for (const saved of savedConfigs) {
              const found = allConfigs.find((c) => c.id === saved.id);
              expect(found).toBeDefined();
              
              // Compare all fields except isDefault (which may be modified by business logic)
              expect(found!.id).toBe(saved.id);
              expect(found!.name).toBe(saved.name);
              expect(found!.type).toBe(saved.type);
              expect(found!.paperSize).toBe(saved.paperSize);
              expect(found!.characterSet).toBe(saved.characterSet);
              expect(found!.role).toBe(saved.role);
              expect(found!.enabled).toBe(saved.enabled);
              expect(found!.fallbackPrinterId).toBe(saved.fallbackPrinterId);
              expect(JSON.stringify(found!.connectionDetails)).toBe(JSON.stringify(saved.connectionDetails));
            }
          }
        ),
        { verbose: true }
      );
    });

    it('getByRole returns only configurations with matching role', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(printerConfigInputArb, { minLength: 2, maxLength: 5 }),
          printerRoleArb,
          async (configInputs, targetRole) => {
            db.exec('DELETE FROM printers');

            // Save all configurations
            const savedConfigs = configInputs.map((input) => store.save(input));

            // Get configurations by role
            const roleConfigs = store.getByRole(targetRole);

            // Filter expected results
            const expectedConfigs = savedConfigs.filter((c) => c.role === targetRole);

            // Should have same count
            expect(roleConfigs.length).toBe(expectedConfigs.length);

            // All returned configs should have the target role
            for (const config of roleConfigs) {
              expect(config.role).toBe(targetRole);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('multiple round-trips through database produce identical results', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigInputArb, async (configInput) => {
          db.exec('DELETE FROM printers');

          // First save and load
          const saved1 = store.save(configInput);
          const loaded1 = store.load(saved1.id);

          // Delete and save again with same data
          store.delete(saved1.id);
          const saved2 = store.save({
            ...configInput,
            id: saved1.id, // Use same ID
          });
          const loaded2 = store.load(saved2.id);

          // Both loads should produce equivalent results (except timestamps)
          expect(loaded1).not.toBeNull();
          expect(loaded2).not.toBeNull();
          expect(loaded1!.name).toBe(loaded2!.name);
          expect(loaded1!.type).toBe(loaded2!.type);
          expect(loaded1!.role).toBe(loaded2!.role);
          expect(loaded1!.paperSize).toBe(loaded2!.paperSize);
          expect(loaded1!.characterSet).toBe(loaded2!.characterSet);
          expect(loaded1!.isDefault).toBe(loaded2!.isDefault);
          expect(loaded1!.enabled).toBe(loaded2!.enabled);
        }),
        { verbose: true }
      );
    });
  });

  /**
   * Export/Import Round-Trip Tests
   * **Validates: Requirements 8.5**
   */
  describe('Export/Import Round-Trip', () => {
    it('exportAll followed by importAll preserves all configurations', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(printerConfigInputArb, { minLength: 1, maxLength: 5 }),
          async (configInputs) => {
            db.exec('DELETE FROM printers');

            // Save all configurations
            const savedConfigs = configInputs.map((input) => store.save(input));

            // Export all - this captures the state AFTER business rules applied
            const exported = store.exportAll();

            // Clear database
            db.exec('DELETE FROM printers');

            // Import all
            const importedCount = store.importAll(exported, true);

            // Should import same count
            expect(importedCount).toBe(savedConfigs.length);

            // Verify all configurations are restored
            const allConfigs = store.getAll();
            expect(allConfigs.length).toBe(savedConfigs.length);

            // Compare exported configs with imported configs (not original saved)
            // because isDefault may have been modified by business rules during save
            for (const exp of exported) {
              const found = allConfigs.find((c) => c.id === exp.id);
              expect(found).toBeDefined();
              
              // Compare all fields - export captures post-business-rule state
              expect(found!.id).toBe(exp.id);
              expect(found!.name).toBe(exp.name);
              expect(found!.type).toBe(exp.type);
              expect(found!.paperSize).toBe(exp.paperSize);
              expect(found!.characterSet).toBe(exp.characterSet);
              expect(found!.role).toBe(exp.role);
              expect(found!.enabled).toBe(exp.enabled === 1);
              expect(found!.isDefault).toBe(exp.isDefault === 1);
            }
          }
        ),
        { verbose: true }
      );
    });
  });
});
