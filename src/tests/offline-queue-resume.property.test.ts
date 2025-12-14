/**
 * Property-Based Tests for Offline Queue and Resume
 *
 * **Feature: pos-printer-drivers, Property 3: Offline Queue and Resume**
 * **Validates: Requirements 2.5, 4.4, 4.5**
 *
 * This test verifies that for any print jobs submitted while the target printer
 * is offline, they should be added to the persistent queue, and when the printer
 * comes back online, all queued jobs should be processed in order without data loss.
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
import {
  BasePrinterTransport,
  TransportState,
  TransportOptions,
} from '../main/printer/transport';

// Configure fast-check
// Configuration is handled by propertyTestConfig.ts import

// ============================================================================
// Mock Transport for Testing
// ============================================================================

/**
 * Mock transport that can simulate online/offline states
 */
class MockTransport extends BasePrinterTransport {
  private _isOnline: boolean = false;
  private sentData: Buffer[] = [];

  constructor(options?: TransportOptions) {
    super(options);
  }

  setOnline(online: boolean): void {
    this._isOnline = online;
    if (online) {
      this['setState'](TransportState.CONNECTED);
    } else {
      this['setState'](TransportState.DISCONNECTED);
    }
  }

  getSentData(): Buffer[] {
    return this.sentData;
  }

  clearSentData(): void {
    this.sentData = [];
  }

  protected async doConnect(): Promise<void> {
    if (!this._isOnline) {
      throw new Error('Printer is offline');
    }
  }

  protected async doDisconnect(): Promise<void> {
    // No-op for mock
  }

  protected async doSend(data: Buffer): Promise<void> {
    if (!this._isOnline) {
      throw new Error('Printer is offline');
    }
    this.sentData.push(data);
  }
}

// ============================================================================
// Test Database Setup
// ============================================================================

let testDbPath: string;
let db: Database.Database;
let queueService: PrintQueueService;

beforeAll(() => {
  // Create a temporary database for testing
  const tempDir = os.tmpdir();
  testDbPath = path.join(tempDir, `offline-queue-test-${Date.now()}.db`);
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
  id: fc.uuid(),
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
 * Arbitrary for generating a sequence of print jobs with incrementing timestamps
 */
const printJobSequenceArb: fc.Arbitrary<PrintJob[]> = fc
  .array(printJobArb, { minLength: 1, maxLength: 10 })
  .map((jobs) => {
    // Ensure jobs have incrementing timestamps for deterministic ordering
    const baseTime = Date.now();
    return jobs.map((job, index) => ({
      ...job,
      priority: 0, // Same priority for FIFO testing
      createdAt: new Date(baseTime + index * 1000), // 1 second apart
    }));
  });

// ============================================================================
// Property Tests
// ============================================================================

describe('Offline Queue and Resume Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 3: Offline Queue and Resume**
   * **Validates: Requirements 2.5, 4.4, 4.5**
   *
   * Property: For any print jobs submitted while the target printer is offline,
   * they should be added to the persistent queue, and when the printer comes
   * back online, all queued jobs should be processed in order without data loss.
   */
  describe('Property 3: Offline Queue and Resume', () => {
    it('jobs submitted while offline are persisted to queue', async () => {
      await fc.assert(
        fc.asyncProperty(printJobSequenceArb, async (jobs) => {
          // Clear queue
          queueService.clearQueue();

          // Create mock transport in offline state
          const transport = new MockTransport();
          transport.setOnline(false);

          // Verify transport is offline
          expect(transport.isConnected()).toBe(false);

          // Enqueue all jobs while "offline"
          const enqueuedIds: string[] = [];
          for (const job of jobs) {
            const jobId = queueService.enqueue(job, testPrinterId);
            enqueuedIds.push(jobId);
          }

          // Verify all jobs are in the queue
          const queuedJobs = queueService.getQueuedJobs(testPrinterId);
          expect(queuedJobs.length).toBe(jobs.length);

          // Verify all job IDs match
          const queuedIds = queuedJobs.map((j) => j.id);
          expect(queuedIds).toEqual(enqueuedIds);

          // Verify all jobs have pending status
          for (const queuedJob of queuedJobs) {
            expect(queuedJob.status).toBe(QueuedJobStatus.PENDING);
          }
        }),
        { verbose: true }
      );
    });

    it('queued jobs are preserved across database reconnection (simulating restart)', async () => {
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

          // Filter to our printer
          const ourPendingJobs = pendingJobs.filter((j) => j.printerId === testPrinterId);

          // Verify all jobs are preserved
          expect(ourPendingJobs.length).toBe(jobs.length);

          // Verify order is preserved
          const pendingIds = ourPendingJobs.map((j) => j.id);
          expect(pendingIds).toEqual(enqueuedIds);
        }),
        { verbose: true }
      );
    });

    it('jobs can be processed in order when printer comes online', async () => {
      await fc.assert(
        fc.asyncProperty(printJobSequenceArb, async (jobs) => {
          // Clear queue
          queueService.clearQueue();
          queueService.clearHistory();

          // Create mock transport in offline state
          const transport = new MockTransport();
          transport.setOnline(false);

          // Enqueue all jobs while "offline"
          const enqueuedIds: string[] = [];
          for (const job of jobs) {
            const jobId = queueService.enqueue(job, testPrinterId);
            enqueuedIds.push(jobId);
          }

          // Simulate printer coming online
          transport.setOnline(true);

          // Process all jobs in order
          const processedIds: string[] = [];
          let dequeuedJob: QueuedJob | null;
          while ((dequeuedJob = queueService.dequeue(testPrinterId)) !== null) {
            processedIds.push(dequeuedJob.id);

            // Simulate successful print
            queueService.markComplete(dequeuedJob.id);
          }

          // Verify all jobs were processed in FIFO order
          expect(processedIds).toEqual(enqueuedIds);

          // Verify queue is now empty
          const remainingJobs = queueService.getQueuedJobs(testPrinterId);
          expect(remainingJobs.length).toBe(0);
        }),
        { verbose: true }
      );
    });

    it('job data is preserved without loss through queue cycle', async () => {
      await fc.assert(
        fc.asyncProperty(printJobArb, async (job) => {
          // Clear queue
          queueService.clearQueue();
          queueService.clearHistory();

          // Enqueue job
          const jobId = queueService.enqueue(job, testPrinterId);

          // Retrieve job from queue
          const retrievedJob = queueService.getJob(jobId);

          // Verify job exists
          expect(retrievedJob).not.toBeNull();

          // Verify core job data is preserved
          expect(retrievedJob!.id).toBe(jobId);
          expect(retrievedJob!.type).toBe(job.type);
          expect(retrievedJob!.priority).toBe(job.priority);

          // Verify job data is preserved (deep comparison)
          const originalData = job.data as ReceiptData;
          const retrievedData = retrievedJob!.data as ReceiptData;

          expect(retrievedData.orderNumber).toBe(originalData.orderNumber);
          expect(retrievedData.orderType).toBe(originalData.orderType);
          expect(retrievedData.items.length).toBe(originalData.items.length);
          expect(retrievedData.subtotal).toBeCloseTo(originalData.subtotal, 2);
          expect(retrievedData.tax).toBeCloseTo(originalData.tax, 2);
          expect(retrievedData.total).toBeCloseTo(originalData.total, 2);
          expect(retrievedData.paymentMethod).toBe(originalData.paymentMethod);
        }),
        { verbose: true }
      );
    });

    it('multiple offline/online cycles preserve queue integrity', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(printJobArb, { minLength: 3, maxLength: 6 }),
          fc.integer({ min: 1, max: 3 }),
          async (jobs, cycleCount) => {
            // Clear queue
            queueService.clearQueue();
            queueService.clearHistory();

            // Ensure jobs have incrementing timestamps
            const baseTime = Date.now();
            const orderedJobs = jobs.map((job, index) => ({
              ...job,
              priority: 0,
              createdAt: new Date(baseTime + index * 1000),
            }));

            // Create mock transport
            const transport = new MockTransport();

            // Simulate multiple offline/online cycles
            const allEnqueuedIds: string[] = [];
            let jobIndex = 0;

            for (let cycle = 0; cycle < cycleCount && jobIndex < orderedJobs.length; cycle++) {
              // Go offline
              transport.setOnline(false);

              // Enqueue some jobs while offline
              const jobsThisCycle = Math.min(2, orderedJobs.length - jobIndex);
              for (let i = 0; i < jobsThisCycle && jobIndex < orderedJobs.length; i++) {
                const jobId = queueService.enqueue(orderedJobs[jobIndex], testPrinterId);
                allEnqueuedIds.push(jobId);
                jobIndex++;
              }

              // Go online briefly (but don't process)
              transport.setOnline(true);
            }

            // Enqueue any remaining jobs
            while (jobIndex < orderedJobs.length) {
              const jobId = queueService.enqueue(orderedJobs[jobIndex], testPrinterId);
              allEnqueuedIds.push(jobId);
              jobIndex++;
            }

            // Verify all jobs are in queue
            const queuedJobs = queueService.getQueuedJobs(testPrinterId);
            expect(queuedJobs.length).toBe(orderedJobs.length);

            // Verify order is preserved
            const queuedIds = queuedJobs.map((j) => j.id);
            expect(queuedIds).toEqual(allEnqueuedIds);
          }
        ),
        { verbose: true }
      );
    });

    it('resetPrintingJobs recovers jobs stuck in printing state', async () => {
      await fc.assert(
        fc.asyncProperty(printJobSequenceArb, async (jobs) => {
          // Clear queue
          queueService.clearQueue();

          // Enqueue all jobs
          for (const job of jobs) {
            queueService.enqueue(job, testPrinterId);
          }

          // Dequeue some jobs (they become 'printing')
          const dequeueCount = Math.min(Math.ceil(jobs.length / 2), jobs.length);
          for (let i = 0; i < dequeueCount; i++) {
            queueService.dequeue(testPrinterId);
          }

          // Verify some jobs are in 'printing' state
          const printingJobs = queueService.getQueuedJobs(testPrinterId).filter(
            (j) => j.status === QueuedJobStatus.PRINTING
          );
          expect(printingJobs.length).toBe(dequeueCount);

          // Simulate crash recovery - reset printing jobs
          const resetCount = queueService.resetPrintingJobs();
          expect(resetCount).toBe(dequeueCount);

          // Verify all jobs are now pending
          const allJobs = queueService.getQueuedJobs(testPrinterId);
          for (const job of allJobs) {
            expect(job.status).toBe(QueuedJobStatus.PENDING);
          }

          // Verify total job count is preserved
          expect(allJobs.length).toBe(jobs.length);
        }),
        { verbose: true }
      );
    });

    it('queue length is accurate after offline enqueue operations', async () => {
      await fc.assert(
        fc.asyncProperty(printJobSequenceArb, async (jobs) => {
          // Clear queue
          queueService.clearQueue();

          // Enqueue jobs one by one and verify queue length
          for (let i = 0; i < jobs.length; i++) {
            queueService.enqueue(jobs[i], testPrinterId);
            const queueLength = queueService.getQueueLength(testPrinterId);
            expect(queueLength).toBe(i + 1);
          }

          // Final verification
          const finalLength = queueService.getQueueLength(testPrinterId);
          expect(finalLength).toBe(jobs.length);
        }),
        { verbose: true }
      );
    });
  });
});
