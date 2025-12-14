/**
 * Property-Based Tests for Settings Export Completeness
 *
 * **Feature: pos-printer-drivers, Property 12: Settings Export Completeness**
 * **Validates: Requirements 8.5**
 *
 * This test verifies that for any settings export operation, the exported data
 * should include all configured printers with their complete configuration,
 * and importing the export should restore the exact same printer configurations.
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
  PrintJobType,
} from '../main/printer/types';
import { PrinterConfigStore } from '../main/printer/services/PrinterConfigStore';
import { JobRouter, RoutingEntry, CategoryRoutingEntry, FallbackEntry } from '../main/printer/services/JobRouter';
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
let configStore: PrinterConfigStore;

beforeAll(() => {
  // Create a temporary database for testing
  const tempDir = os.tmpdir();
  testDbPath = path.join(tempDir, `settings-export-test-${Date.now()}.db`);
  db = new Database(testDbPath);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');

  // Initialize printer tables
  initializePrinterTables(db);

  // Create store instance
  configStore = new PrinterConfigStore(db);
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
 * Arbitrary for generating valid printer configuration input
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
      fallbackPrinterId: fc.constant(undefined),
      enabled: fc.boolean(),
    })
  );

/**
 * Arbitrary for generating print job types
 */
const printJobTypeArb: fc.Arbitrary<PrintJobType> = fc.constantFrom(
  PrintJobType.RECEIPT,
  PrintJobType.KITCHEN_TICKET,
  PrintJobType.LABEL,
  PrintJobType.REPORT,
  PrintJobType.TEST
);

/**
 * Arbitrary for generating category names
 */
const categoryNameArb: fc.Arbitrary<string> = fc.constantFrom(
  'food',
  'drinks',
  'desserts',
  'appetizers',
  'main',
  'sides'
);

// ============================================================================
// Property Tests
// ============================================================================

describe('Settings Export Completeness Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 12: Settings Export Completeness**
   * **Validates: Requirements 8.5**
   *
   * Property: For any settings export operation, the exported data should include
   * all configured printers with their complete configuration, and importing the
   * export should restore the exact same printer configurations.
   */
  describe('Property 12: Settings Export Completeness', () => {
    it('exported settings include all configured printers', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(printerConfigInputArb, { minLength: 1, maxLength: 5 }),
          async (configInputs) => {
            // Clear database
            db.exec('DELETE FROM printers');

            // Save all configurations
            const savedConfigs = configInputs.map((input) => configStore.save(input));

            // Export all settings
            const exported = configStore.exportAll();

            // Verify exported count matches saved count
            expect(exported.length).toBe(savedConfigs.length);

            // Verify each saved config is in the export
            for (const saved of savedConfigs) {
              const found = exported.find((e) => e.id === saved.id);
              expect(found).toBeDefined();
            }
          }
        ),
        { verbose: true }
      );
    });

    it('exported settings preserve all printer fields', async () => {
      await fc.assert(
        fc.asyncProperty(printerConfigInputArb, async (configInput) => {
          // Clear database
          db.exec('DELETE FROM printers');

          // Save configuration
          const saved = configStore.save(configInput);

          // Export settings
          const exported = configStore.exportAll();

          // Find the exported config
          const exportedConfig = exported.find((e) => e.id === saved.id);
          expect(exportedConfig).toBeDefined();

          // Verify all fields are present and correct
          expect(exportedConfig!.id).toBe(saved.id);
          expect(exportedConfig!.name).toBe(saved.name);
          expect(exportedConfig!.type).toBe(saved.type);
          expect(exportedConfig!.paperSize).toBe(saved.paperSize);
          expect(exportedConfig!.characterSet).toBe(saved.characterSet);
          expect(exportedConfig!.role).toBe(saved.role);
          expect(exportedConfig!.enabled).toBe(saved.enabled ? 1 : 0);
          expect(exportedConfig!.createdAt).toBe(saved.createdAt.toISOString());
          expect(exportedConfig!.updatedAt).toBe(saved.updatedAt.toISOString());

          // Verify connection details are serialized correctly
          const parsedConnectionDetails = JSON.parse(exportedConfig!.connectionDetails);
          expect(parsedConnectionDetails).toEqual(saved.connectionDetails);
        }),
        { verbose: true }
      );
    });

    it('import with replace restores exact configuration', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(printerConfigInputArb, { minLength: 1, maxLength: 5 }),
          async (configInputs) => {
            // Clear database
            db.exec('DELETE FROM printers');

            // Save all configurations
            const savedConfigs = configInputs.map((input) => configStore.save(input));

            // Export settings
            const exported = configStore.exportAll();

            // Clear database completely
            db.exec('DELETE FROM printers');

            // Verify database is empty
            expect(configStore.getAll().length).toBe(0);

            // Import with replace
            const importedCount = configStore.importAll(exported, true);

            // Verify import count
            expect(importedCount).toBe(savedConfigs.length);

            // Verify all configurations are restored
            const restored = configStore.getAll();
            expect(restored.length).toBe(savedConfigs.length);

            // Verify each configuration matches the exported data
            for (const exp of exported) {
              const found = restored.find((r) => r.id === exp.id);
              expect(found).toBeDefined();
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

    it('export/import round-trip preserves routing configuration', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Use uniqueArray to avoid duplicate job types
          fc.uniqueArray(printJobTypeArb, { minLength: 1, maxLength: 5 }),
          // Use uniqueArray to avoid duplicate categories
          fc.uniqueArray(categoryNameArb, { minLength: 0, maxLength: 3 }),
          fc.option(fc.uuid(), { nil: null }),
          async (jobTypes, categories, defaultPrinterId) => {
            // Create a JobRouter
            const router = new JobRouter();

            // Set up routing for each unique job type with a unique printer ID
            const routingMap = new Map<PrintJobType, string>();
            for (const jobType of jobTypes) {
              const printerId = fc.sample(fc.uuid(), 1)[0];
              router.setRouting(jobType, printerId);
              routingMap.set(jobType, printerId);
            }

            // Set up category routing with unique printer IDs
            const categoryMap = new Map<string, string>();
            for (const category of categories) {
              const printerId = fc.sample(fc.uuid(), 1)[0];
              router.setCategoryRouting(category, printerId);
              categoryMap.set(category.toLowerCase(), printerId);
            }

            // Set default printer if provided
            if (defaultPrinterId) {
              router.setDefaultPrinter(defaultPrinterId);
            }

            // Export configuration
            const exported = router.exportConfig();

            // Create a new router and import
            const newRouter = new JobRouter();
            newRouter.importConfig(exported);

            // Verify routing is preserved
            const newRouting = newRouter.getRouting();
            for (const [jobType, printerId] of routingMap) {
              expect(newRouting.get(jobType)).toBe(printerId);
            }

            // Verify category routing is preserved
            const newCategoryRouting = newRouter.getCategoryRouting();
            for (const [category, printerId] of categoryMap) {
              expect(newCategoryRouting.get(category)).toBe(printerId);
            }

            // Verify default printer is preserved
            expect(newRouter.getDefaultPrinter()).toBe(defaultPrinterId);
          }
        ),
        { verbose: true }
      );
    });

    it('export/import round-trip preserves fallback configuration', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(fc.uuid(), fc.uuid()),
            { minLength: 1, maxLength: 5 }
          ),
          async (fallbackPairs) => {
            // Create a JobRouter
            const router = new JobRouter();

            // Set up fallback mappings
            for (const [primary, fallback] of fallbackPairs) {
              router.setFallback(primary, fallback);
            }

            // Export configuration
            const exported = router.exportConfig();

            // Create a new router and import
            const newRouter = new JobRouter();
            newRouter.importConfig(exported);

            // Verify fallback mappings are preserved
            const newFallbackTable = newRouter.getFallbackTable();
            for (const [primary, fallback] of fallbackPairs) {
              expect(newFallbackTable.get(primary)).toBe(fallback);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('multiple export/import cycles produce identical results', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(printerConfigInputArb, { minLength: 1, maxLength: 3 }),
          async (configInputs) => {
            // Clear database
            db.exec('DELETE FROM printers');

            // Save all configurations
            configInputs.forEach((input) => configStore.save(input));

            // First export
            const export1 = configStore.exportAll();

            // Clear and import
            db.exec('DELETE FROM printers');
            configStore.importAll(export1, true);

            // Second export
            const export2 = configStore.exportAll();

            // Clear and import again
            db.exec('DELETE FROM printers');
            configStore.importAll(export2, true);

            // Third export
            const export3 = configStore.exportAll();

            // All exports should have same count
            expect(export1.length).toBe(export2.length);
            expect(export2.length).toBe(export3.length);

            // All exports should have same IDs
            const ids1 = new Set(export1.map((e) => e.id));
            const ids2 = new Set(export2.map((e) => e.id));
            const ids3 = new Set(export3.map((e) => e.id));

            expect(ids1).toEqual(ids2);
            expect(ids2).toEqual(ids3);

            // All exports should have same data for each ID
            for (const exp1 of export1) {
              const exp2 = export2.find((e) => e.id === exp1.id);
              const exp3 = export3.find((e) => e.id === exp1.id);

              expect(exp2).toBeDefined();
              expect(exp3).toBeDefined();

              // Compare all fields except timestamps (which may differ slightly)
              expect(exp2!.name).toBe(exp1.name);
              expect(exp2!.type).toBe(exp1.type);
              expect(exp2!.connectionDetails).toBe(exp1.connectionDetails);
              expect(exp2!.paperSize).toBe(exp1.paperSize);
              expect(exp2!.characterSet).toBe(exp1.characterSet);
              expect(exp2!.role).toBe(exp1.role);
              expect(exp2!.isDefault).toBe(exp1.isDefault);
              expect(exp2!.enabled).toBe(exp1.enabled);

              expect(exp3!.name).toBe(exp1.name);
              expect(exp3!.type).toBe(exp1.type);
              expect(exp3!.connectionDetails).toBe(exp1.connectionDetails);
              expect(exp3!.paperSize).toBe(exp1.paperSize);
              expect(exp3!.characterSet).toBe(exp1.characterSet);
              expect(exp3!.role).toBe(exp1.role);
              expect(exp3!.isDefault).toBe(exp1.isDefault);
              expect(exp3!.enabled).toBe(exp1.enabled);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('import without replace merges configurations', async () => {
      await fc.assert(
        fc.asyncProperty(
          printerConfigInputArb,
          printerConfigInputArb,
          async (config1, config2) => {
            // Clear database
            db.exec('DELETE FROM printers');

            // Save first configuration
            const saved1 = configStore.save(config1);

            // Export first config
            const export1 = configStore.exportAll();

            // Clear and save second configuration
            db.exec('DELETE FROM printers');
            const saved2 = configStore.save(config2);

            // Import first config without replace (merge)
            const importedCount = configStore.importAll(export1, false);

            // Should import 1 config (the first one)
            expect(importedCount).toBe(1);

            // Should now have both configurations
            const allConfigs = configStore.getAll();
            expect(allConfigs.length).toBe(2);

            // Both configs should be present
            expect(allConfigs.find((c) => c.id === saved1.id)).toBeDefined();
            expect(allConfigs.find((c) => c.id === saved2.id)).toBeDefined();
          }
        ),
        { verbose: true }
      );
    });

    it('empty export produces empty array', async () => {
      // Clear database
      db.exec('DELETE FROM printers');

      // Export from empty database
      const exported = configStore.exportAll();

      // Should be empty array
      expect(exported).toEqual([]);
    });

    it('import empty array does not affect existing configurations', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(printerConfigInputArb, { minLength: 1, maxLength: 3 }),
          async (configInputs) => {
            // Clear database
            db.exec('DELETE FROM printers');

            // Save configurations
            const savedConfigs = configInputs.map((input) => configStore.save(input));

            // Import empty array
            const importedCount = configStore.importAll([], false);

            // Should import 0
            expect(importedCount).toBe(0);

            // All original configs should still exist
            const allConfigs = configStore.getAll();
            expect(allConfigs.length).toBe(savedConfigs.length);
          }
        ),
        { verbose: true }
      );
    });
  });
});
