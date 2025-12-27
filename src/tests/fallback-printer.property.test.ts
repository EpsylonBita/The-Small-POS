/**
 * Property-Based Tests for Fallback Printer Logic
 *
 * **Feature: pos-printer-drivers, Property 9: Fallback Printer Logic**
 * **Validates: Requirements 9.3**
 *
 * This test verifies that for any print job where the primary printer is offline
 * and a fallback printer is configured, the job should be routed to the fallback
 * printer. If the fallback is also offline, the job should be queued for the
 * primary printer.
 */

import * as fc from 'fast-check';
import {
  PrintJob,
  PrintJobType,
  PrinterState,
  PrinterConfig,
  PrinterRole,
  ReceiptData,
} from '../main/printer/types';
import { JobRouter, PrinterStatusProvider } from '../main/printer/services/JobRouter';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

// ============================================================================
// Arbitraries for generating valid test data
// ============================================================================

/**
 * Arbitrary for generating valid UUIDs
 */
const uuidArb: fc.Arbitrary<string> = fc.uuid();

/**
 * Arbitrary for generating valid print job types
 */
const printJobTypeArb: fc.Arbitrary<PrintJobType> = fc.constantFrom(
  PrintJobType.RECEIPT,
  PrintJobType.KITCHEN_TICKET,
  PrintJobType.LABEL,
  PrintJobType.REPORT,
  PrintJobType.TEST
);

/**
 * Arbitrary for generating valid dates
 */
const validDateArb: fc.Arbitrary<Date> = fc
  .integer({ min: new Date('2020-01-01').getTime(), max: new Date('2030-12-31').getTime() })
  .map((timestamp) => new Date(timestamp));

/**
 * Arbitrary for generating simple receipt data
 */
const receiptDataArb: fc.Arbitrary<ReceiptData> = fc.record({
  orderNumber: fc.stringMatching(/^[A-Z0-9]{4,10}$/),
  orderType: fc.constantFrom('dine-in' as const, 'pickup' as const, 'delivery' as const),
  timestamp: validDateArb,
  items: fc.array(
    fc.record({
      name: fc.string({ minLength: 1, maxLength: 50 }),
      quantity: fc.integer({ min: 1, max: 100 }),
      unitPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
      total: fc.float({ min: Math.fround(0.01), max: Math.fround(10000), noNaN: true }),
      modifiers: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 5 }), { nil: undefined }),
      specialInstructions: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
      category: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
    }),
    { minLength: 1, maxLength: 5 }
  ),
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
 * Arbitrary for generating print jobs
 */
const printJobArb: fc.Arbitrary<PrintJob> = fc.record({
  id: uuidArb,
  type: printJobTypeArb,
  data: receiptDataArb,
  priority: fc.integer({ min: 0, max: 10 }),
  createdAt: validDateArb,
  metadata: fc.option(
    fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ maxLength: 100 })),
    { nil: undefined }
  ),
});

/**
 * Arbitrary for generating printer states
 */
const printerStateArb: fc.Arbitrary<PrinterState> = fc.constantFrom(
  PrinterState.ONLINE,
  PrinterState.OFFLINE,
  PrinterState.ERROR,
  PrinterState.BUSY
);

/**
 * Arbitrary for generating fallback configurations
 */
const fallbackConfigArb: fc.Arbitrary<{
  primaryId: string;
  fallbackId: string;
  primaryState: PrinterState;
  fallbackState: PrinterState;
}> = fc.record({
  primaryId: uuidArb,
  fallbackId: uuidArb,
  primaryState: printerStateArb,
  fallbackState: printerStateArb,
}).filter((config) => config.primaryId !== config.fallbackId);

// ============================================================================
// Mock Status Provider Factory
// ============================================================================

/**
 * Create a mock status provider with configurable printer states
 */
function createMockStatusProvider(
  printerStates: Map<string, PrinterState>
): PrinterStatusProvider {
  return {
    getPrinterStatus(printerId: string) {
      const state = printerStates.get(printerId);
      if (state === undefined) {
        return null;
      }
      return { state };
    },
    getPrinterConfig(printerId: string) {
      return null;
    },
    getPrintersByRole(role: PrinterRole) {
      return [];
    },
  };
}

// ============================================================================
// Property Tests
// ============================================================================

describe('Fallback Printer Logic Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 9: Fallback Printer Logic**
   * **Validates: Requirements 9.3**
   *
   * Property: For any print job where the primary printer is offline and a
   * fallback printer is configured, the job should be routed to the fallback
   * printer. If the fallback is also offline, the job should be queued for
   * the primary printer.
   */
  describe('Property 9: Fallback Printer Logic', () => {
    it('routes to primary printer when primary is online', async () => {
      await fc.assert(
        fc.asyncProperty(
          uuidArb,
          uuidArb,
          printJobArb,
          async (primaryId, fallbackId, job) => {
            // Ensure different IDs
            fc.pre(primaryId !== fallbackId);

            // Create status provider with primary online
            const printerStates = new Map<string, PrinterState>();
            printerStates.set(primaryId, PrinterState.ONLINE);
            printerStates.set(fallbackId, PrinterState.ONLINE);

            const statusProvider = createMockStatusProvider(printerStates);

            const router = new JobRouter(statusProvider);
            router.setRouting(job.type, primaryId);
            router.setFallback(primaryId, fallbackId);

            const result = router.routeJob(job);

            // Should route to primary
            expect(result.printerId).toBe(primaryId);
            expect(result.usedFallback).toBe(false);
          }
        ),
        { verbose: true }
      );
    });

    it('routes to fallback printer when primary is offline and fallback is online', async () => {
      await fc.assert(
        fc.asyncProperty(
          uuidArb,
          uuidArb,
          printJobArb,
          async (primaryId, fallbackId, job) => {
            // Ensure different IDs
            fc.pre(primaryId !== fallbackId);

            // Create status provider with primary offline, fallback online
            const printerStates = new Map<string, PrinterState>();
            printerStates.set(primaryId, PrinterState.OFFLINE);
            printerStates.set(fallbackId, PrinterState.ONLINE);

            const statusProvider = createMockStatusProvider(printerStates);

            const router = new JobRouter(statusProvider);
            router.setRouting(job.type, primaryId);
            router.setFallback(primaryId, fallbackId);

            const result = router.routeJob(job);

            // Should route to fallback
            expect(result.printerId).toBe(fallbackId);
            expect(result.usedFallback).toBe(true);
            expect(result.fallbackReason).toContain('offline');
          }
        ),
        { verbose: true }
      );
    });

    it('routes to primary (for queuing) when both primary and fallback are offline', async () => {
      await fc.assert(
        fc.asyncProperty(
          uuidArb,
          uuidArb,
          printJobArb,
          async (primaryId, fallbackId, job) => {
            // Ensure different IDs
            fc.pre(primaryId !== fallbackId);

            // Create status provider with both offline
            const printerStates = new Map<string, PrinterState>();
            printerStates.set(primaryId, PrinterState.OFFLINE);
            printerStates.set(fallbackId, PrinterState.OFFLINE);

            const statusProvider = createMockStatusProvider(printerStates);

            const router = new JobRouter(statusProvider);
            router.setRouting(job.type, primaryId);
            router.setFallback(primaryId, fallbackId);

            const result = router.routeJob(job);

            // Should route to primary (job will be queued)
            expect(result.printerId).toBe(primaryId);
            expect(result.usedFallback).toBe(false);
          }
        ),
        { verbose: true }
      );
    });

    it('routes to primary when no fallback is configured and primary is offline', async () => {
      await fc.assert(
        fc.asyncProperty(
          uuidArb,
          printJobArb,
          async (primaryId, job) => {
            // Create status provider with primary offline
            const printerStates = new Map<string, PrinterState>();
            printerStates.set(primaryId, PrinterState.OFFLINE);

            const statusProvider = createMockStatusProvider(printerStates);

            const router = new JobRouter(statusProvider);
            router.setRouting(job.type, primaryId);
            // No fallback configured

            const result = router.routeJob(job);

            // Should route to primary (job will be queued)
            expect(result.printerId).toBe(primaryId);
            expect(result.usedFallback).toBe(false);
          }
        ),
        { verbose: true }
      );
    });

    it('treats BUSY state as available (routes to primary)', async () => {
      await fc.assert(
        fc.asyncProperty(
          uuidArb,
          uuidArb,
          printJobArb,
          async (primaryId, fallbackId, job) => {
            // Ensure different IDs
            fc.pre(primaryId !== fallbackId);

            // Create status provider with primary busy
            const printerStates = new Map<string, PrinterState>();
            printerStates.set(primaryId, PrinterState.BUSY);
            printerStates.set(fallbackId, PrinterState.ONLINE);

            const statusProvider = createMockStatusProvider(printerStates);

            const router = new JobRouter(statusProvider);
            router.setRouting(job.type, primaryId);
            router.setFallback(primaryId, fallbackId);

            const result = router.routeJob(job);

            // Should route to primary (BUSY is still available)
            expect(result.printerId).toBe(primaryId);
            expect(result.usedFallback).toBe(false);
          }
        ),
        { verbose: true }
      );
    });

    it('treats ERROR state as unavailable (routes to fallback)', async () => {
      await fc.assert(
        fc.asyncProperty(
          uuidArb,
          uuidArb,
          printJobArb,
          async (primaryId, fallbackId, job) => {
            // Ensure different IDs
            fc.pre(primaryId !== fallbackId);

            // Create status provider with primary in error state
            const printerStates = new Map<string, PrinterState>();
            printerStates.set(primaryId, PrinterState.ERROR);
            printerStates.set(fallbackId, PrinterState.ONLINE);

            const statusProvider = createMockStatusProvider(printerStates);

            const router = new JobRouter(statusProvider);
            router.setRouting(job.type, primaryId);
            router.setFallback(primaryId, fallbackId);

            const result = router.routeJob(job);

            // Should route to fallback (ERROR is unavailable)
            expect(result.printerId).toBe(fallbackId);
            expect(result.usedFallback).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    it('setFallback and getFallbackForPrinter are consistent', async () => {
      await fc.assert(
        fc.asyncProperty(
          uuidArb,
          uuidArb,
          async (primaryId, fallbackId) => {
            // Ensure different IDs
            fc.pre(primaryId !== fallbackId);

            const router = new JobRouter();

            // Initially no fallback
            expect(router.getFallbackForPrinter(primaryId)).toBeNull();

            // Set fallback
            router.setFallback(primaryId, fallbackId);
            expect(router.getFallbackForPrinter(primaryId)).toBe(fallbackId);

            // Remove fallback
            router.removeFallback(primaryId);
            expect(router.getFallbackForPrinter(primaryId)).toBeNull();
          }
        ),
        { verbose: true }
      );
    });

    it('getFallbackTable returns all configured fallbacks', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(uuidArb, uuidArb).filter(([a, b]) => a !== b),
            { minLength: 1, maxLength: 5 }
          ),
          async (fallbackPairs) => {
            const router = new JobRouter();

            // Configure fallbacks (ensure unique primary IDs)
            const uniquePrimaries = new Map<string, string>();
            for (const [primaryId, fallbackId] of fallbackPairs) {
              uniquePrimaries.set(primaryId, fallbackId);
            }

            for (const [primaryId, fallbackId] of uniquePrimaries) {
              router.setFallback(primaryId, fallbackId);
            }

            // Get fallback table
            const fallbackTable = router.getFallbackTable();

            // Verify all fallbacks are present
            for (const [primaryId, fallbackId] of uniquePrimaries) {
              expect(fallbackTable.get(primaryId)).toBe(fallbackId);
            }

            expect(fallbackTable.size).toBe(uniquePrimaries.size);
          }
        ),
        { verbose: true }
      );
    });

    it('export and import preserves fallback configuration', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(uuidArb, uuidArb).filter(([a, b]) => a !== b),
            { minLength: 1, maxLength: 5 }
          ),
          async (fallbackPairs) => {
            const router1 = new JobRouter();

            // Configure fallbacks (ensure unique primary IDs)
            const uniquePrimaries = new Map<string, string>();
            for (const [primaryId, fallbackId] of fallbackPairs) {
              uniquePrimaries.set(primaryId, fallbackId);
            }

            for (const [primaryId, fallbackId] of uniquePrimaries) {
              router1.setFallback(primaryId, fallbackId);
            }

            // Export configuration
            const exported = router1.exportConfig();

            // Import into new router
            const router2 = new JobRouter();
            router2.importConfig(exported);

            // Verify fallback configuration matches
            for (const [primaryId, fallbackId] of uniquePrimaries) {
              expect(router2.getFallbackForPrinter(primaryId)).toBe(fallbackId);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('without status provider, assumes all printers are available', async () => {
      await fc.assert(
        fc.asyncProperty(
          uuidArb,
          uuidArb,
          printJobArb,
          async (primaryId, fallbackId, job) => {
            // Ensure different IDs
            fc.pre(primaryId !== fallbackId);

            // Create router without status provider
            const router = new JobRouter();
            router.setRouting(job.type, primaryId);
            router.setFallback(primaryId, fallbackId);

            const result = router.routeJob(job);

            // Should route to primary (assumed available)
            expect(result.printerId).toBe(primaryId);
            expect(result.usedFallback).toBe(false);
          }
        ),
        { verbose: true }
      );
    });

    it('clearAll removes all fallback configurations', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(uuidArb, uuidArb).filter(([a, b]) => a !== b),
            { minLength: 1, maxLength: 5 }
          ),
          async (fallbackPairs) => {
            const router = new JobRouter();

            // Configure fallbacks
            for (const [primaryId, fallbackId] of fallbackPairs) {
              router.setFallback(primaryId, fallbackId);
            }

            // Clear all
            router.clearAll();

            // Verify all fallbacks are removed
            const fallbackTable = router.getFallbackTable();
            expect(fallbackTable.size).toBe(0);
          }
        ),
        { verbose: true }
      );
    });
  });
});
