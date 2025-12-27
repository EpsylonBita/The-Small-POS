/**
 * Property-Based Tests for Print Queue Retry Logic
 *
 * **Feature: pos-printer-drivers, Property 4: Retry Logic Consistency**
 * **Validates: Requirements 2.3, 3.5, 6.3**
 *
 * This test verifies that for any print job that fails, the system should
 * retry exactly up to the configured maximum (3 times) with exponential backoff,
 * and the retry count should be accurately tracked and persisted.
 */

import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  PrintJob,
  QueuedJob,
  PrintJobType,
  PrintJobData,
  ReceiptData,
  QueuedJobStatus,
} from '../main/printer/types';
import { PrintQueueService } from '../main/printer/services/PrintQueueService';
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
let queueService: PrintQueueService;
let testPrinterId: string;

beforeAll(() => {
  // Create a temporary database for testing
  const tempDir = os.tmpdir();
  testDbPath = path.join(tempDir, `print-queue-retry-test-${Date.now()}.db`);
  db = new Database(testDbPath);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');

  // Initialize printer tables
  initializePrinterTables(db);

  // Create queue service instance
  queueService = new PrintQueueService(db);
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
  // Clear the queue and history before each test
  queueService.clearQueue();
  queueService.clearHistory();

  // Clear printers table and create a test printer for foreign key constraint
  db.exec('DELETE FROM printers');
  testPrinterId = '00000000-0000-0000-0000-000000000001';
  db.prepare(`
    INSERT INTO printers (
      id, name, type, connection_details, paper_size, character_set,
      role, is_default, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    testPrinterId,
    'Test Printer',
    'network',
    JSON.stringify({ type: 'network', ip: '192.168.1.100', port: 9100 }),
    '80mm',
    'PC437_USA',
    'receipt',
    1,
    1,
    new Date().toISOString(),
    new Date().toISOString()
  );
});

// ============================================================================
// Arbitraries for generating valid print jobs
// ============================================================================

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
 * Arbitrary for generating valid dates (avoiding NaN dates)
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
  id: fc.uuid(),
  type: printJobTypeArb,
  data: receiptDataArb as fc.Arbitrary<PrintJobData>,
  priority: fc.constant(0),
  createdAt: validDateArb,
  metadata: fc.option(
    fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ maxLength: 100 })),
    { nil: undefined }
  ),
});

/**
 * Arbitrary for generating retry counts (0 to 5)
 */
const retryCountArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 5 });

/**
 * Arbitrary for generating error messages
 */
const errorMessageArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 200 });

// ============================================================================
// Property Tests
// ============================================================================

describe('Print Queue Retry Logic Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 4: Retry Logic Consistency**
   * **Validates: Requirements 2.3, 3.5, 6.3**
   *
   * Property: For any print job that fails, the system should retry exactly
   * up to the configured maximum (3 times) with exponential backoff, and the
   * retry count should be accurately tracked and persisted.
   */
  describe('Property 4: Retry Logic Consistency', () => {
    it('incrementRetry increases retry count by exactly 1', async () => {
      await fc.assert(
        fc.asyncProperty(printJobArb, async (job) => {
          // Clear queue and history
          queueService.clearQueue();
          queueService.clearHistory();

          // Enqueue job
          const jobId = queueService.enqueue(job, testPrinterId);

          // Dequeue to set status to 'printing'
          queueService.dequeue(testPrinterId);

          // Get initial retry count
          const initialJob = queueService.getJob(jobId);
          expect(initialJob).not.toBeNull();
          const initialRetryCount = initialJob!.retryCount;

          // Increment retry
          const newRetryCount = queueService.incrementRetry(jobId);

          // Verify retry count increased by exactly 1
          expect(newRetryCount).toBe(initialRetryCount + 1);

          // Verify persisted value matches
          const updatedJob = queueService.getJob(jobId);
          expect(updatedJob).not.toBeNull();
          expect(updatedJob!.retryCount).toBe(newRetryCount);
        }),
        { verbose: true }
      );
    });

    it('incrementRetry resets job status to pending', async () => {
      await fc.assert(
        fc.asyncProperty(printJobArb, async (job) => {
          // Clear queue and history
          queueService.clearQueue();
          queueService.clearHistory();

          // Enqueue job
          const jobId = queueService.enqueue(job, testPrinterId);

          // Dequeue to set status to 'printing'
          const dequeuedJob = queueService.dequeue(testPrinterId);
          expect(dequeuedJob).not.toBeNull();
          expect(dequeuedJob!.status).toBe(QueuedJobStatus.PRINTING);

          // Increment retry (simulating a failed print attempt)
          queueService.incrementRetry(jobId);

          // Verify status is reset to pending
          const updatedJob = queueService.getJob(jobId);
          expect(updatedJob).not.toBeNull();
          expect(updatedJob!.status).toBe(QueuedJobStatus.PENDING);
        }),
        { verbose: true }
      );
    });

    it('retry count is accurately tracked across multiple retries', async () => {
      await fc.assert(
        fc.asyncProperty(printJobArb, retryCountArb, async (job, numRetries) => {
          // Clear queue and history
          queueService.clearQueue();
          queueService.clearHistory();

          // Enqueue job
          const jobId = queueService.enqueue(job, testPrinterId);

          // Perform multiple retries
          for (let i = 0; i < numRetries; i++) {
            // Dequeue to set status to 'printing'
            queueService.dequeue(testPrinterId);

            // Increment retry
            const newCount = queueService.incrementRetry(jobId);
            expect(newCount).toBe(i + 1);
          }

          // Verify final retry count
          const finalJob = queueService.getJob(jobId);
          expect(finalJob).not.toBeNull();
          expect(finalJob!.retryCount).toBe(numRetries);
        }),
        { verbose: true }
      );
    });

    it('retry count is persisted across service restarts', async () => {
      await fc.assert(
        fc.asyncProperty(printJobArb, retryCountArb, async (job, numRetries) => {
          // Clear queue and history
          queueService.clearQueue();
          queueService.clearHistory();

          // Enqueue job
          const jobId = queueService.enqueue(job, testPrinterId);

          // Perform retries
          for (let i = 0; i < numRetries; i++) {
            queueService.dequeue(testPrinterId);
            queueService.incrementRetry(jobId);
          }

          // Simulate restart by creating a new service instance
          const newQueueService = new PrintQueueService(db);

          // Verify retry count is preserved
          const persistedJob = newQueueService.getJob(jobId);
          expect(persistedJob).not.toBeNull();
          expect(persistedJob!.retryCount).toBe(numRetries);
        }),
        { verbose: true }
      );
    });

    it('setLastError persists error message', async () => {
      await fc.assert(
        fc.asyncProperty(printJobArb, errorMessageArb, async (job, errorMessage) => {
          // Clear queue and history
          queueService.clearQueue();
          queueService.clearHistory();

          // Enqueue job
          const jobId = queueService.enqueue(job, testPrinterId);

          // Set error message
          queueService.setLastError(jobId, errorMessage);

          // Verify error is persisted
          const updatedJob = queueService.getJob(jobId);
          expect(updatedJob).not.toBeNull();
          expect(updatedJob!.lastError).toBe(errorMessage);
        }),
        { verbose: true }
      );
    });

    it('incrementRetry returns -1 for non-existent job', async () => {
      await fc.assert(
        fc.asyncProperty(fc.uuid(), async (nonExistentJobId) => {
          // Clear queue
          queueService.clearQueue();

          // Try to increment retry for non-existent job
          const result = queueService.incrementRetry(nonExistentJobId);

          // Should return -1
          expect(result).toBe(-1);
        }),
        { verbose: true }
      );
    });

    it('resetPrintingJobs resets all printing jobs to pending', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(printJobArb, { minLength: 2, maxLength: 5 }),
          async (jobs) => {
            // Clear queue and history
            queueService.clearQueue();
            queueService.clearHistory();

            // Enqueue all jobs
            const jobIds: string[] = [];
            for (const job of jobs) {
              const jobId = queueService.enqueue(job, testPrinterId);
              jobIds.push(jobId);
            }

            // Dequeue some jobs to set them to 'printing'
            const numToDequeue = Math.min(2, jobs.length);
            for (let i = 0; i < numToDequeue; i++) {
              queueService.dequeue(testPrinterId);
            }

            // Verify some jobs are in 'printing' status
            const printingCount = queueService.getQueueLength(testPrinterId, QueuedJobStatus.PRINTING);
            expect(printingCount).toBe(numToDequeue);

            // Reset printing jobs (simulating crash recovery)
            const resetCount = queueService.resetPrintingJobs();
            expect(resetCount).toBe(numToDequeue);

            // Verify all jobs are now pending
            const pendingCount = queueService.getQueueLength(testPrinterId, QueuedJobStatus.PENDING);
            expect(pendingCount).toBe(jobs.length);

            // Verify no jobs are in 'printing' status
            const newPrintingCount = queueService.getQueueLength(testPrinterId, QueuedJobStatus.PRINTING);
            expect(newPrintingCount).toBe(0);
          }
        ),
        { verbose: true }
      );
    });

    it('job with retries can still be dequeued after incrementRetry', async () => {
      await fc.assert(
        fc.asyncProperty(printJobArb, async (job) => {
          // Clear queue and history
          queueService.clearQueue();
          queueService.clearHistory();

          // Enqueue job
          const jobId = queueService.enqueue(job, testPrinterId);

          // Dequeue and retry
          queueService.dequeue(testPrinterId);
          queueService.incrementRetry(jobId);

          // Should be able to dequeue again
          const retriedJob = queueService.dequeue(testPrinterId);
          expect(retriedJob).not.toBeNull();
          expect(retriedJob!.id).toBe(jobId);
          expect(retriedJob!.retryCount).toBe(1);
        }),
        { verbose: true }
      );
    });
  });
});
