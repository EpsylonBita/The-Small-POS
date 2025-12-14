/**
 * Property-Based Tests for Job Routing
 *
 * **Feature: pos-printer-drivers, Property 7: Job Routing by Type**
 * **Validates: Requirements 9.2, 9.4**
 *
 * This test verifies that for any print job with a specific type (receipt, kitchen, bar),
 * if a printer is configured for that role, the job should be routed to that printer.
 * If multiple printers handle the same role, routing should be deterministic.
 */

import * as fc from 'fast-check';
import {
  PrintJob,
  PrintJobType,
  PrinterState,
  PrinterConfig,
  PrinterRole,
  PrinterType,
  PaperSize,
  ReceiptData,
  PrintJobData,
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
  orderType: fc.constantFrom('dine-in' as const, 'takeout' as const, 'delivery' as const),
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
    { minLength: 1, maxLength: 10 }
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
  data: receiptDataArb as fc.Arbitrary<PrintJobData>,
  priority: fc.integer({ min: 0, max: 10 }),
  createdAt: validDateArb,
  metadata: fc.option(
    fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ maxLength: 100 })),
    { nil: undefined }
  ),
});

/**
 * Arbitrary for generating routing configurations (job type -> printer ID pairs)
 */
const routingConfigArb: fc.Arbitrary<Array<{ jobType: PrintJobType; printerId: string }>> = fc.array(
  fc.record({
    jobType: printJobTypeArb,
    printerId: uuidArb,
  }),
  { minLength: 1, maxLength: 5 }
).map((entries) => {
  // Ensure unique job types (last one wins)
  const map = new Map<PrintJobType, string>();
  for (const entry of entries) {
    map.set(entry.jobType, entry.printerId);
  }
  return Array.from(map.entries()).map(([jobType, printerId]) => ({ jobType, printerId }));
});

// ============================================================================
// Mock Status Provider
// ============================================================================

/**
 * Create a mock status provider where all printers are online
 */
function createMockStatusProvider(onlinePrinterIds: Set<string>): PrinterStatusProvider {
  return {
    getPrinterStatus(printerId: string) {
      if (onlinePrinterIds.has(printerId)) {
        return { state: PrinterState.ONLINE };
      }
      return { state: PrinterState.OFFLINE };
    },
    getPrinterConfig(printerId: string) {
      return null; // Not needed for routing tests
    },
    getPrintersByRole(role: PrinterRole) {
      return []; // Not needed for routing tests
    },
  };
}

// ============================================================================
// Property Tests
// ============================================================================

describe('Job Routing Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 7: Job Routing by Type**
   * **Validates: Requirements 9.2, 9.4**
   *
   * Property: For any print job with a specific type, if a printer is configured
   * for that type, the job should be routed to that printer.
   */
  describe('Property 7: Job Routing by Type', () => {
    it('routes jobs to the configured printer for their type', async () => {
      await fc.assert(
        fc.asyncProperty(
          routingConfigArb,
          printJobArb,
          async (routingConfig, job) => {
            const router = new JobRouter();

            // Configure routing
            for (const { jobType, printerId } of routingConfig) {
              router.setRouting(jobType, printerId);
            }

            // Find the expected printer for this job type
            const expectedPrinter = routingConfig.find((r) => r.jobType === job.type);

            if (expectedPrinter) {
              // Job type has routing configured
              const result = router.routeJob(job);
              expect(result.printerId).toBe(expectedPrinter.printerId);
              expect(result.usedFallback).toBe(false);
            } else {
              // Job type has no routing - should throw or use default
              // If no default is set, it should throw
              expect(() => router.routeJob(job)).toThrow();
            }
          }
        ),
        { verbose: true }
      );
    });

    it('routing is deterministic - same job type always routes to same printer', async () => {
      await fc.assert(
        fc.asyncProperty(
          routingConfigArb,
          printJobTypeArb,
          fc.integer({ min: 2, max: 10 }),
          async (routingConfig, jobType, iterations) => {
            const router = new JobRouter();

            // Configure routing
            for (const { jobType: jt, printerId } of routingConfig) {
              router.setRouting(jt, printerId);
            }

            // Check if this job type has routing
            const expectedPrinter = routingConfig.find((r) => r.jobType === jobType);
            if (!expectedPrinter) {
              return; // Skip if no routing for this type
            }

            // Create multiple jobs of the same type
            const results: string[] = [];
            for (let i = 0; i < iterations; i++) {
              const job: PrintJob = {
                id: `test-${i}`,
                type: jobType,
                data: {
                  orderNumber: `ORD${i}`,
                  orderType: 'dine-in',
                  timestamp: new Date(),
                  items: [],
                  subtotal: 0,
                  tax: 0,
                  total: 0,
                  paymentMethod: 'cash',
                } as ReceiptData,
                priority: i,
                createdAt: new Date(),
              };

              const result = router.routeJob(job);
              results.push(result.printerId);
            }

            // All results should be the same
            const uniqueResults = new Set(results);
            expect(uniqueResults.size).toBe(1);
            expect(results[0]).toBe(expectedPrinter.printerId);
          }
        ),
        { verbose: true }
      );
    });

    it('uses default printer when no specific routing is configured', async () => {
      await fc.assert(
        fc.asyncProperty(
          uuidArb,
          printJobArb,
          async (defaultPrinterId, job) => {
            const router = new JobRouter();

            // Only set default printer, no specific routing
            router.setDefaultPrinter(defaultPrinterId);

            const result = router.routeJob(job);
            expect(result.printerId).toBe(defaultPrinterId);
            expect(result.usedFallback).toBe(false);
          }
        ),
        { verbose: true }
      );
    });

    it('specific routing takes precedence over default printer', async () => {
      await fc.assert(
        fc.asyncProperty(
          uuidArb,
          uuidArb,
          printJobArb,
          async (defaultPrinterId, specificPrinterId, job) => {
            // Ensure different printer IDs
            fc.pre(defaultPrinterId !== specificPrinterId);

            const router = new JobRouter();

            // Set both default and specific routing
            router.setDefaultPrinter(defaultPrinterId);
            router.setRouting(job.type, specificPrinterId);

            const result = router.routeJob(job);
            expect(result.printerId).toBe(specificPrinterId);
          }
        ),
        { verbose: true }
      );
    });

    it('getRouting returns all configured routes', async () => {
      await fc.assert(
        fc.asyncProperty(routingConfigArb, async (routingConfig) => {
          const router = new JobRouter();

          // Configure routing
          for (const { jobType, printerId } of routingConfig) {
            router.setRouting(jobType, printerId);
          }

          // Get routing table
          const routingTable = router.getRouting();

          // Verify all routes are present
          for (const { jobType, printerId } of routingConfig) {
            expect(routingTable.get(jobType)).toBe(printerId);
          }

          expect(routingTable.size).toBe(routingConfig.length);
        }),
        { verbose: true }
      );
    });

    it('removeRouting removes the route for a job type', async () => {
      await fc.assert(
        fc.asyncProperty(
          routingConfigArb,
          async (routingConfig) => {
            fc.pre(routingConfig.length > 0);

            const router = new JobRouter();

            // Configure routing
            for (const { jobType, printerId } of routingConfig) {
              router.setRouting(jobType, printerId);
            }

            // Remove first route
            const removedType = routingConfig[0].jobType;
            router.removeRouting(removedType);

            // Verify route is removed
            expect(router.getRoutingForType(removedType)).toBeNull();

            // Other routes should still exist
            for (let i = 1; i < routingConfig.length; i++) {
              const { jobType, printerId } = routingConfig[i];
              if (jobType !== removedType) {
                expect(router.getRoutingForType(jobType)).toBe(printerId);
              }
            }
          }
        ),
        { verbose: true }
      );
    });

    it('export and import preserves routing configuration', async () => {
      await fc.assert(
        fc.asyncProperty(routingConfigArb, uuidArb, async (routingConfig, defaultPrinterId) => {
          const router1 = new JobRouter();

          // Configure routing
          router1.setDefaultPrinter(defaultPrinterId);
          for (const { jobType, printerId } of routingConfig) {
            router1.setRouting(jobType, printerId);
          }

          // Export configuration
          const exported = router1.exportConfig();

          // Import into new router
          const router2 = new JobRouter();
          router2.importConfig(exported);

          // Verify configuration matches
          expect(router2.getDefaultPrinter()).toBe(defaultPrinterId);
          for (const { jobType, printerId } of routingConfig) {
            expect(router2.getRoutingForType(jobType)).toBe(printerId);
          }
        }),
        { verbose: true }
      );
    });
  });
});
