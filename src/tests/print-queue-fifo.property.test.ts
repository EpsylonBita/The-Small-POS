/**
 * Property-Based Tests for Print Queue FIFO Ordering
 *
 * **Feature: pos-printer-drivers, Property 2: Print Queue FIFO Ordering**
 * **Validates: Requirements 6.1, 6.2, 6.5**
 *
 * This test verifies that for any sequence of print jobs submitted to the queue,
 * they should be processed in the exact order they were submitted (First-In-First-Out),
 * and this ordering should be preserved across application restarts.
 */

import * as fc from 'fast-check';
import './propertyTestConfig';
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

// Configure fast-check
// Configuration is handled by propertyTestConfig.ts import

// ============================================================================
// Test Database Setup
// ============================================================================

let testDbPath: string;
let db: Database.Database;
let queueService: PrintQueueService;

beforeAll(() => {
  // Create a temporary database for testing
  const tempDir = os.tmpdir();
  testDbPath = path.join(tempDir, `print-queue-test-${Date.now()}.db`);
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

// Store for test printer IDs
let testPrinterId: string;

beforeEach(() => {
  // Clear the queue before each test
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
 * Arbitrary for generating valid dates (avoiding NaN dates) - for receipt data
 */
const receiptDateArb: fc.Arbitrary<Date> = fc
  .integer({ min: new Date('2020-01-01').getTime(), max: new Date('2030-12-31').getTime() })
  .map((timestamp) => new Date(timestamp));

/**
 * Arbitrary for generating simple receipt data
 * Note: Using Math.fround() for 32-bit float constraints as required by fast-check
 */
const receiptDataArb: fc.Arbitrary<ReceiptData> = fc.record({
  orderNumber: fc.stringMatching(/^[A-Z0-9]{4,10}$/),
  orderType: fc.constantFrom('dine-in' as const, 'takeout' as const, 'delivery' as const),
  timestamp: receiptDateArb,
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
 * Arbitrary for generating valid dates (avoiding NaN dates)
 */
const validDateArb: fc.Arbitrary<Date> = fc
  .integer({ min: new Date('2020-01-01').getTime(), max: new Date('2030-12-31').getTime() })
  .map((timestamp) => new Date(timestamp));

/**
 * Arbitrary for generating print jobs with same priority (to test pure FIFO)
 */
const printJobArb: fc.Arbitrary<PrintJob> = fc.record({
  id: fc.uuid(),
  type: printJobTypeArb,
  data: receiptDataArb as fc.Arbitrary<PrintJobData>,
  priority: fc.constant(0), // Same priority for FIFO testing
  createdAt: validDateArb,
  metadata: fc.option(
    fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ maxLength: 100 })),
    { nil: undefined }
  ),
});

/**
 * Arbitrary for generating a sequence of print jobs with incrementing timestamps
 */
const printJobSequenceArb: fc.Arbitrary<PrintJob[]> = fc
  .array(printJobArb, { minLength: 2, maxLength: 10 })
  .map((jobs) => {
    // Ensure jobs have incrementing timestamps for deterministic ordering
    const baseTime = Date.now();
    return jobs.map((job, index) => ({
      ...job,
      createdAt: new Date(baseTime + index * 1000), // 1 second apart
    }));
  });

// Note: We use a fixed testPrinterId created in beforeEach instead of generating random IDs
// because the print_queue table has a foreign key constraint to the printers table

// ============================================================================
// Property Tests
// ============================================================================

describe('Print Queue FIFO Ordering Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 2: Print Queue FIFO Ordering**
   * **Validates: Requirements 6.1, 6.2, 6.5**
   *
   * Property: For any sequence of print jobs submitted to the queue,
   * they should be processed in the exact order they were submitted (FIFO).
   */
  describe('Property 2: Print Queue FIFO Ordering', () => {
    it('jobs with same priority are dequeued in FIFO order', async () => {
      await fc.assert(
        fc.asyncProperty(printJobSequenceArb, async (jobs) => {
          // Clear queue
          queueService.clearQueue();

          // Enqueue all jobs in order
          const enqueuedIds: string[] = [];
          for (const job of jobs) {
            const jobId = queueService.enqueue(job, testPrinterId);
            enqueuedIds.push(jobId);
          }

          // Dequeue all jobs and verify order
          const dequeuedIds: string[] = [];
          let dequeuedJob: QueuedJob | null;
          while ((dequeuedJob = queueService.dequeue(testPrinterId)) !== null) {
            dequeuedIds.push(dequeuedJob.id);
            // Mark complete to remove from queue
            queueService.markComplete(dequeuedJob.id);
          }

          // Verify FIFO order
          expect(dequeuedIds).toEqual(enqueuedIds);
        }),
        { verbose: true }
      );
    });

    it('peek returns the same job that dequeue would return', async () => {
      await fc.assert(
        fc.asyncProperty(printJobSequenceArb, async (jobs) => {
          // Clear queue
          queueService.clearQueue();

          // Enqueue all jobs
          for (const job of jobs) {
            queueService.enqueue(job, testPrinterId);
          }

          // Peek should return the first job
          const peekedJob = queueService.peek(testPrinterId);
          expect(peekedJob).not.toBeNull();

          // Dequeue should return the same job
          const dequeuedJob = queueService.dequeue(testPrinterId);
          expect(dequeuedJob).not.toBeNull();
          expect(dequeuedJob!.id).toBe(peekedJob!.id);
        }),
        { verbose: true }
      );
    });

    it('queue length decreases by 1 after each dequeue', async () => {
      await fc.assert(
        fc.asyncProperty(printJobSequenceArb, async (jobs) => {
          // Clear queue
          queueService.clearQueue();

          // Enqueue all jobs
          for (const job of jobs) {
            queueService.enqueue(job, testPrinterId);
          }

          const initialLength = queueService.getQueueLength(testPrinterId);
          expect(initialLength).toBe(jobs.length);

          // Dequeue one job
          const dequeuedJob = queueService.dequeue(testPrinterId);
          expect(dequeuedJob).not.toBeNull();

          // Queue length should decrease (job is now 'printing', not 'pending')
          const pendingLength = queueService.getQueueLength(testPrinterId, QueuedJobStatus.PENDING);
          expect(pendingLength).toBe(jobs.length - 1);
        }),
        { verbose: true }
      );
    });

    it('FIFO order is preserved across database reconnection (restart recovery)', async () => {
      await fc.assert(
        fc.asyncProperty(printJobSequenceArb, async (jobs) => {
          // Clear queue
          queueService.clearQueue();

          // Enqueue all jobs
          const enqueuedIds: string[] = [];
          for (const job of jobs) {
            const jobId = queueService.enqueue(job, testPrinterId);
            enqueuedIds.push(jobId);
          }

          // Simulate restart by creating a new service instance with same database
          const newQueueService = new PrintQueueService(db);

          // Get pending jobs from new service
          const pendingJobs = newQueueService.getPendingJobs();

          // Filter to our printer and verify order
          const ourPendingJobs = pendingJobs.filter((j) => j.printerId === testPrinterId);
          const pendingIds = ourPendingJobs.map((j) => j.id);

          // Order should be preserved
          expect(pendingIds).toEqual(enqueuedIds);
        }),
        { verbose: true }
      );
    });

    it('enqueue returns unique job IDs', async () => {
      await fc.assert(
        fc.asyncProperty(printJobSequenceArb, async (jobs) => {
          // Clear queue
          queueService.clearQueue();

          // Enqueue all jobs
          const enqueuedIds: string[] = [];
          for (const job of jobs) {
            const jobId = queueService.enqueue(job, testPrinterId);
            enqueuedIds.push(jobId);
          }

          // All IDs should be unique
          const uniqueIds = new Set(enqueuedIds);
          expect(uniqueIds.size).toBe(enqueuedIds.length);
        }),
        { verbose: true }
      );
    });

    it('getQueuedJobs returns jobs in FIFO order', async () => {
      await fc.assert(
        fc.asyncProperty(printJobSequenceArb, async (jobs) => {
          // Clear queue
          queueService.clearQueue();

          // Enqueue all jobs
          const enqueuedIds: string[] = [];
          for (const job of jobs) {
            const jobId = queueService.enqueue(job, testPrinterId);
            enqueuedIds.push(jobId);
          }

          // Get all queued jobs
          const queuedJobs = queueService.getQueuedJobs(testPrinterId);
          const queuedIds = queuedJobs.map((j) => j.id);

          // Order should match enqueue order
          expect(queuedIds).toEqual(enqueuedIds);
        }),
        { verbose: true }
      );
    });

    it('markComplete removes job from queue', async () => {
      await fc.assert(
        fc.asyncProperty(printJobArb, async (job) => {
          // Clear queue and history to avoid UNIQUE constraint violations
          queueService.clearQueue();
          queueService.clearHistory();

          // Enqueue job
          const jobId = queueService.enqueue(job, testPrinterId);

          // Dequeue and mark complete
          const dequeuedJob = queueService.dequeue(testPrinterId);
          expect(dequeuedJob).not.toBeNull();
          queueService.markComplete(jobId);

          // Job should no longer be in queue
          const remainingJob = queueService.getJob(jobId);
          expect(remainingJob).toBeNull();
        }),
        { verbose: true }
      );
    });

    it('markFailed removes job from queue', async () => {
      await fc.assert(
        fc.asyncProperty(printJobArb, async (job) => {
          // Clear queue and history to avoid UNIQUE constraint violations
          queueService.clearQueue();
          queueService.clearHistory();

          // Enqueue job
          const jobId = queueService.enqueue(job, testPrinterId);

          // Dequeue and mark failed
          const dequeuedJob = queueService.dequeue(testPrinterId);
          expect(dequeuedJob).not.toBeNull();
          queueService.markFailed(jobId, 'Test error');

          // Job should no longer be in queue
          const remainingJob = queueService.getJob(jobId);
          expect(remainingJob).toBeNull();
        }),
        { verbose: true }
      );
    });
  });
});
