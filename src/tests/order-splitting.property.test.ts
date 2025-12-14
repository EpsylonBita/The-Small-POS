/**
 * Property-Based Tests for Order Splitting by Category
 *
 * **Feature: pos-printer-drivers, Property 8: Order Splitting by Category**
 * **Validates: Requirements 9.5**
 *
 * This test verifies that for any order containing items from multiple categories
 * (e.g., food and drinks), when category-based routing is configured, the order
 * should be split into separate print jobs, each containing only items for that
 * category's printer.
 */

import * as fc from 'fast-check';
import {
  PrintJob,
  PrintJobType,
  KitchenTicketData,
  PrintOrderItem,
} from '../main/printer/types';
import { JobRouter } from '../main/printer/services/JobRouter';

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
 * Arbitrary for generating valid dates
 */
const validDateArb: fc.Arbitrary<Date> = fc
  .integer({ min: new Date('2020-01-01').getTime(), max: new Date('2030-12-31').getTime() })
  .map((timestamp) => new Date(timestamp));

/**
 * Arbitrary for generating category names
 */
const categoryArb: fc.Arbitrary<string> = fc.constantFrom(
  'food',
  'drinks',
  'desserts',
  'appetizers',
  'mains',
  'sides'
);

/**
 * Arbitrary for generating order items with categories
 */
const orderItemWithCategoryArb: fc.Arbitrary<PrintOrderItem> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }),
  quantity: fc.integer({ min: 1, max: 10 }),
  unitPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(100), noNaN: true }),
  total: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
  modifiers: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 3 }), { nil: undefined }),
  specialInstructions: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
  category: fc.option(categoryArb, { nil: undefined }),
});

/**
 * Arbitrary for generating order items without categories
 */
const orderItemWithoutCategoryArb: fc.Arbitrary<PrintOrderItem> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }),
  quantity: fc.integer({ min: 1, max: 10 }),
  unitPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(100), noNaN: true }),
  total: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
  modifiers: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 3 }), { nil: undefined }),
  specialInstructions: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
  category: fc.constant(undefined),
});

/**
 * Arbitrary for generating kitchen ticket data
 */
const kitchenTicketDataArb: fc.Arbitrary<KitchenTicketData> = fc.record({
  orderNumber: fc.stringMatching(/^[A-Z0-9]{4,10}$/),
  orderType: fc.constantFrom('dine-in' as const, 'takeout' as const, 'delivery' as const),
  timestamp: validDateArb,
  items: fc.array(orderItemWithCategoryArb, { minLength: 1, maxLength: 10 }),
  customerName: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
  tableName: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
  specialInstructions: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
  station: fc.string({ minLength: 1, maxLength: 30 }),
});

/**
 * Arbitrary for generating kitchen ticket print jobs
 */
const kitchenTicketJobArb: fc.Arbitrary<PrintJob> = fc.record({
  id: uuidArb,
  type: fc.constant(PrintJobType.KITCHEN_TICKET),
  data: kitchenTicketDataArb,
  priority: fc.integer({ min: 0, max: 10 }),
  createdAt: validDateArb,
  metadata: fc.option(
    fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ maxLength: 100 })),
    { nil: undefined }
  ),
});

/**
 * Arbitrary for generating category routing configurations
 */
const categoryRoutingConfigArb: fc.Arbitrary<Array<{ category: string; printerId: string }>> = fc.array(
  fc.record({
    category: categoryArb,
    printerId: uuidArb,
  }),
  { minLength: 1, maxLength: 4 }
).map((entries) => {
  // Ensure unique categories (last one wins)
  const map = new Map<string, string>();
  for (const entry of entries) {
    map.set(entry.category.toLowerCase(), entry.printerId);
  }
  return Array.from(map.entries()).map(([category, printerId]) => ({ category, printerId }));
});

/**
 * Arbitrary for generating orders with items from multiple specific categories
 */
const multiCategoryOrderArb = (categories: string[]): fc.Arbitrary<PrintJob> => {
  // Generate items for each category
  const itemsArb = fc.tuple(
    ...categories.map((category) =>
      fc.array(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 50 }),
          quantity: fc.integer({ min: 1, max: 10 }),
          unitPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(100), noNaN: true }),
          total: fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
          modifiers: fc.constant(undefined),
          specialInstructions: fc.constant(undefined),
          category: fc.constant(category),
        }),
        { minLength: 1, maxLength: 3 }
      )
    )
  ).map((itemArrays) => itemArrays.flat());

  return fc.record({
    id: uuidArb,
    type: fc.constant(PrintJobType.KITCHEN_TICKET),
    data: fc.record({
      orderNumber: fc.stringMatching(/^[A-Z0-9]{4,10}$/),
      orderType: fc.constantFrom('dine-in' as const, 'takeout' as const, 'delivery' as const),
      timestamp: validDateArb,
      items: itemsArb,
      customerName: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
      tableName: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
      specialInstructions: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
      station: fc.string({ minLength: 1, maxLength: 30 }),
    }),
    priority: fc.integer({ min: 0, max: 10 }),
    createdAt: validDateArb,
    metadata: fc.constant(undefined),
  });
};

// ============================================================================
// Property Tests
// ============================================================================

describe('Order Splitting Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 8: Order Splitting by Category**
   * **Validates: Requirements 9.5**
   *
   * Property: For any order containing items from multiple categories,
   * when category-based routing is configured, the order should be split
   * into separate print jobs, each containing only items for that category's printer.
   */
  describe('Property 8: Order Splitting by Category', () => {
    it('splits orders by category when category routing is configured', async () => {
      await fc.assert(
        fc.asyncProperty(
          categoryRoutingConfigArb,
          kitchenTicketJobArb,
          async (categoryRouting, job) => {
            const router = new JobRouter();

            // Configure category routing
            for (const { category, printerId } of categoryRouting) {
              router.setCategoryRouting(category, printerId);
            }

            // Split the order
            const result = router.splitOrderByCategory(job);

            // Get the categories that have routing configured
            const routedCategories = new Set(categoryRouting.map((r) => r.category.toLowerCase()));

            // Get items from the original job
            const kitchenData = job.data as KitchenTicketData;
            const itemsWithRoutedCategory = kitchenData.items.filter(
              (item) => item.category && routedCategories.has(item.category.toLowerCase())
            );

            if (itemsWithRoutedCategory.length === 0) {
              // No items have routed categories - should return original job
              expect(result.jobs.length).toBe(1);
              expect(result.jobs[0].id).toBe(job.id);
            } else {
              // Items should be split by category
              // Count items in split jobs
              let totalItemsInSplitJobs = 0;
              for (const splitJob of result.jobs) {
                const splitData = splitJob.data as KitchenTicketData;
                totalItemsInSplitJobs += splitData.items.length;
              }

              // Total items should equal original items
              expect(totalItemsInSplitJobs + result.unroutedItems.length).toBe(kitchenData.items.length);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('each split job contains only items from one category', async () => {
      // Use fixed categories for this test
      const categories = ['food', 'drinks'];

      await fc.assert(
        fc.asyncProperty(
          multiCategoryOrderArb(categories),
          async (job) => {
            const router = new JobRouter();

            // Configure category routing for both categories
            router.setCategoryRouting('food', 'printer-food');
            router.setCategoryRouting('drinks', 'printer-drinks');

            // Split the order
            const result = router.splitOrderByCategory(job);

            // Each split job should have items from only one category
            for (const splitJob of result.jobs) {
              const splitData = splitJob.data as KitchenTicketData;
              const categories = new Set(
                splitData.items
                  .map((item) => item.category?.toLowerCase())
                  .filter((c) => c !== undefined)
              );

              // Should have at most one category (or none for unrouted items)
              expect(categories.size).toBeLessThanOrEqual(1);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('split jobs have correct target printer in metadata', async () => {
      const categories = ['food', 'drinks'];

      await fc.assert(
        fc.asyncProperty(
          multiCategoryOrderArb(categories),
          async (job) => {
            const router = new JobRouter();

            // Configure category routing
            const foodPrinterId = 'printer-food-123';
            const drinksPrinterId = 'printer-drinks-456';
            router.setCategoryRouting('food', foodPrinterId);
            router.setCategoryRouting('drinks', drinksPrinterId);

            // Split the order
            const result = router.splitOrderByCategory(job);

            // Each split job should have the correct target printer in metadata
            for (const splitJob of result.jobs) {
              const splitData = splitJob.data as KitchenTicketData;
              const category = splitData.items[0]?.category?.toLowerCase();

              if (category === 'food') {
                expect(splitJob.metadata?.targetPrinterId).toBe(foodPrinterId);
              } else if (category === 'drinks') {
                expect(splitJob.metadata?.targetPrinterId).toBe(drinksPrinterId);
              }
            }
          }
        ),
        { verbose: true }
      );
    });

    it('preserves all items when splitting - no items lost', async () => {
      // Use fixed categories for deterministic testing
      const fixedCategories = ['food', 'drinks', 'desserts'];

      await fc.assert(
        fc.asyncProperty(
          kitchenTicketJobArb,
          async (job) => {
            const router = new JobRouter();

            // Configure category routing for all fixed categories
            for (const category of fixedCategories) {
              router.setCategoryRouting(category, `printer-${category}`);
            }

            // Also set a default printer for unrouted items
            const defaultPrinterId = 'default-printer';
            router.setDefaultPrinter(defaultPrinterId);
            router.setRouting(PrintJobType.KITCHEN_TICKET, defaultPrinterId);

            // Split the order
            const result = router.splitOrderByCategory(job);

            // Original items
            const kitchenData = job.data as KitchenTicketData;

            // Collect all items from split jobs
            const allSplitItems: PrintOrderItem[] = [];
            for (const splitJob of result.jobs) {
              const splitData = splitJob.data as KitchenTicketData;
              allSplitItems.push(...splitData.items);
            }

            // Add unrouted items (should be empty since we have default printer)
            allSplitItems.push(...result.unroutedItems);

            // Total count should match - all items should be preserved
            expect(allSplitItems.length).toBe(kitchenData.items.length);
          }
        ),
        { verbose: true }
      );
    });

    it('items without category go to unrouted or default printer', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(orderItemWithoutCategoryArb, { minLength: 1, maxLength: 5 }),
          async (itemsWithoutCategory) => {
            const router = new JobRouter();

            // Configure category routing (but items have no category)
            router.setCategoryRouting('food', 'printer-food');
            router.setCategoryRouting('drinks', 'printer-drinks');

            // Create a job with items that have no category
            const job: PrintJob = {
              id: 'test-job',
              type: PrintJobType.KITCHEN_TICKET,
              data: {
                orderNumber: 'ORD123',
                orderType: 'dine-in',
                timestamp: new Date(),
                items: itemsWithoutCategory,
                station: 'kitchen',
              } as KitchenTicketData,
              priority: 0,
              createdAt: new Date(),
            };

            // Split the order
            const result = router.splitOrderByCategory(job);

            // Since no items have categories, should return original job
            expect(result.jobs.length).toBe(1);
            expect(result.jobs[0].id).toBe(job.id);
          }
        ),
        { verbose: true }
      );
    });

    it('non-kitchen-ticket jobs are not split', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            PrintJobType.RECEIPT,
            PrintJobType.LABEL,
            PrintJobType.REPORT,
            PrintJobType.TEST
          ),
          uuidArb,
          async (jobType, jobId) => {
            const router = new JobRouter();

            // Configure category routing
            router.setCategoryRouting('food', 'printer-food');
            router.setCategoryRouting('drinks', 'printer-drinks');

            // Create a non-kitchen-ticket job
            const job: PrintJob = {
              id: jobId,
              type: jobType,
              data: {
                orderNumber: 'ORD123',
                orderType: 'dine-in',
                timestamp: new Date(),
                items: [],
                subtotal: 0,
                tax: 0,
                total: 0,
                paymentMethod: 'cash',
              },
              priority: 0,
              createdAt: new Date(),
            };

            // Split the order
            const result = router.splitOrderByCategory(job);

            // Should return original job unchanged
            expect(result.jobs.length).toBe(1);
            expect(result.jobs[0].id).toBe(jobId);
            expect(result.unroutedItems.length).toBe(0);
          }
        ),
        { verbose: true }
      );
    });

    it('split jobs reference original job ID in metadata', async () => {
      const categories = ['food', 'drinks'];

      await fc.assert(
        fc.asyncProperty(
          multiCategoryOrderArb(categories),
          async (job) => {
            const router = new JobRouter();

            // Configure category routing
            router.setCategoryRouting('food', 'printer-food');
            router.setCategoryRouting('drinks', 'printer-drinks');

            // Split the order
            const result = router.splitOrderByCategory(job);

            // If order was split (more than one job), each should reference original
            if (result.jobs.length > 1) {
              for (const splitJob of result.jobs) {
                expect(splitJob.metadata?.originalJobId).toBe(job.id);
              }
            }
          }
        ),
        { verbose: true }
      );
    });

    it('getCategoryRouting returns all configured category routes', async () => {
      await fc.assert(
        fc.asyncProperty(categoryRoutingConfigArb, async (categoryRouting) => {
          const router = new JobRouter();

          // Configure category routing
          for (const { category, printerId } of categoryRouting) {
            router.setCategoryRouting(category, printerId);
          }

          // Get category routing table
          const routingTable = router.getCategoryRouting();

          // Verify all routes are present
          for (const { category, printerId } of categoryRouting) {
            expect(routingTable.get(category.toLowerCase())).toBe(printerId);
          }

          expect(routingTable.size).toBe(categoryRouting.length);
        }),
        { verbose: true }
      );
    });
  });
});
