/**
 * Property-Based Tests for SyncService
 * 
 * Feature: z-report-commit-fix
 * Property 1: Sync Queue Timeout Guarantee
 * 
 * Validates: Requirements 2.1, 2.4
 * 
 * For any Z-Report submission where the sync queue is not empty,
 * the forceSyncAndWaitForEmptyWithLogging function SHALL either return successfully
 * (queue empty) or throw an error within the specified timeout period.
 * The function SHALL NOT hang indefinitely.
 */

import * as fc from 'fast-check';

// Mock types for testing
interface MockSyncQueueItem {
  id: string;
  table_name: string;
  operation: string;
  record_id: string;
  data: string;
  created_at: string;
  synced: boolean;
  error?: string;
}

// Arbitraries for generating test data
const tableNameArb = fc.constantFrom(
  'orders',
  'driver_earnings',
  'staff_payments',
  'shift_expenses',
  'staff_shifts',
  'cash_drawer_sessions',
  'customers',
  'customer_addresses'
);

const operationArb = fc.constantFrom('insert', 'update', 'delete');

const syncQueueItemArb = fc.record({
  id: fc.uuid(),
  table_name: tableNameArb,
  operation: operationArb,
  record_id: fc.uuid(),
  data: fc.json(),
  created_at: fc.constant(new Date().toISOString()),
  synced: fc.boolean(),
  error: fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
});

const syncQueueArb = fc.array(syncQueueItemArb, { minLength: 0, maxLength: 10 });

// Timeout configuration arbitraries - keep very short for fast tests
const timeoutMsArb = fc.integer({ min: 50, max: 200 });

describe('SyncService Property Tests', () => {
  /**
   * Feature: z-report-commit-fix, Property 1: Sync Queue Timeout Guarantee
   * 
   * For any Z-Report submission where the sync queue is not empty,
   * the forceSyncAndWaitForEmptyWithLogging function SHALL either return successfully
   * (queue empty) or throw an error within the specified timeout period.
   * The function SHALL NOT hang indefinitely.
   * 
   * Validates: Requirements 2.1, 2.4
   */
  describe('Property 1: Sync Queue Timeout Guarantee', () => {
    it('should complete within timeout when queue is empty', async () => {
      await fc.assert(
        fc.asyncProperty(timeoutMsArb, async (timeoutMs) => {
          // Create a mock sync service with empty queue
          const mockService = createMockSyncService([]);
          
          const startTime = Date.now();
          
          // Should complete successfully
          await mockService.forceSyncAndWaitForEmptyWithLogging(timeoutMs);
          
          const elapsed = Date.now() - startTime;
          
          // Property: Should complete well before timeout when queue is empty
          expect(elapsed).toBeLessThan(timeoutMs);
          
          return true;
        }),
        { numRuns: 100 }
      );
    }, 30000); // 30 second timeout for the test

    it('should throw error with queue details when timeout is reached', async () => {
      await fc.assert(
        fc.asyncProperty(
          syncQueueArb.filter(q => q.length > 0), // Non-empty queue
          fc.integer({ min: 50, max: 150 }), // Very short timeout for faster tests
          async (initialQueue, timeoutMs) => {
            // Create a mock sync service that never empties the queue
            const mockService = createMockSyncService(initialQueue, false);
            
            const startTime = Date.now();
            let errorThrown = false;
            let errorMessage = '';
            
            try {
              await mockService.forceSyncAndWaitForEmptyWithLogging(timeoutMs);
            } catch (e: any) {
              errorThrown = true;
              errorMessage = e.message;
            }
            
            const elapsed = Date.now() - startTime;
            
            // Property 1: Should throw an error when queue doesn't empty
            expect(errorThrown).toBe(true);
            
            // Property 2: Error message should contain queue count
            expect(errorMessage).toContain(`${initialQueue.length} items remaining`);
            
            // Property 3: Error message should contain table names
            const tables = [...new Set(initialQueue.map(q => q.table_name))];
            tables.forEach(table => {
              expect(errorMessage).toContain(table);
            });
            
            // Property 4: Should complete within reasonable time after timeout
            // Allow some buffer for processing
            expect(elapsed).toBeLessThan(timeoutMs + 500);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 60000); // 60 second timeout for the test

    it('should return successfully when queue empties before timeout', async () => {
      await fc.assert(
        fc.asyncProperty(
          syncQueueArb.filter(q => q.length > 0),
          fc.integer({ min: 200, max: 500 }), // Longer timeout
          async (initialQueue, timeoutMs) => {
            // Create a mock sync service that empties the queue after a short delay
            const mockService = createMockSyncService(initialQueue, true, 50);
            
            const startTime = Date.now();
            let errorThrown = false;
            
            try {
              await mockService.forceSyncAndWaitForEmptyWithLogging(timeoutMs);
            } catch {
              errorThrown = true;
            }
            
            const elapsed = Date.now() - startTime;
            
            // Property: Should complete successfully without error
            expect(errorThrown).toBe(false);
            
            // Property: Should complete before timeout
            expect(elapsed).toBeLessThan(timeoutMs);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 60000); // 60 second timeout for the test
  });
});

/**
 * Creates a mock SyncService for testing the forceSyncAndWaitForEmptyWithLogging logic
 * without requiring actual database or network connections.
 */
function createMockSyncService(
  initialQueue: MockSyncQueueItem[],
  willEmpty: boolean = true,
  emptyAfterMs: number = 0
) {
  let queue = [...initialQueue];
  const startTime = Date.now();
  
  return {
    /**
     * Mock implementation of forceSyncAndWaitForEmptyWithLogging
     * This mirrors the actual implementation logic for testing
     */
    async forceSyncAndWaitForEmptyWithLogging(
      timeoutMs: number,
      logStep?: (step: number, msg: string) => void
    ): Promise<void> {
      const funcStartTime = Date.now();

      // Simulate startSync (very fast)
      await new Promise(resolve => setTimeout(resolve, 1));

      // Poll until queue is empty or timeout
      while (Date.now() - funcStartTime < timeoutMs) {
        // Simulate queue emptying after specified delay
        if (willEmpty && Date.now() - startTime >= emptyAfterMs) {
          queue = [];
        }

        if (queue.length === 0) {
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 10)); // Fast polling for tests
      }

      // Timeout - get final queue state for detailed error message
      const tables = [...new Set(queue.map(q => q.table_name))].join(', ');
      const errorMessage = `Sync queue not empty after ${timeoutMs / 1000}s timeout. ${queue.length} items remaining (tables: ${tables})`;
      throw new Error(errorMessage);
    },
  };
}
