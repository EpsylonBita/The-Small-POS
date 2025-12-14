/**
 * Print Queue Service
 *
 * Manages persistent job queuing with FIFO ordering and retry logic.
 * Jobs are persisted to SQLite database for reliability across restarts.
 *
 * @module printer/services/PrintQueueService
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  PrintJob,
  QueuedJob,
  QueuedJobStatus,
  PrintJobType,
  PrintJobData,
  SerializedQueuedJob,
} from '../types';
import { initializePrinterTables, checkPrinterTablesExist } from './PrinterDatabaseSchema';

/**
 * Database row type for print_queue table
 */
interface PrintQueueRow {
  id: string;
  printer_id: string;
  job_type: string;
  job_data: string;
  priority: number;
  status: string;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata: string | null;
}

/**
 * Serialize a QueuedJob to database format
 */
function serializeQueuedJob(job: QueuedJob): SerializedQueuedJob {
  return {
    id: job.id,
    printerId: job.printerId,
    type: job.type,
    data: JSON.stringify(job.data),
    priority: job.priority,
    status: job.status,
    retryCount: job.retryCount,
    lastError: job.lastError ?? null,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    metadata: job.metadata ? JSON.stringify(job.metadata) : null,
  };
}

/**
 * Deserialize a database row to QueuedJob
 */
function deserializeQueuedJob(row: PrintQueueRow): QueuedJob {
  return {
    id: row.id,
    printerId: row.printer_id,
    type: row.job_type as PrintJobType,
    data: JSON.parse(row.job_data) as PrintJobData,
    priority: row.priority,
    status: row.status as QueuedJobStatus,
    retryCount: row.retry_count,
    lastError: row.last_error ?? undefined,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

/**
 * PrintQueueService - Manages persistent print job queuing
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5
 */
export class PrintQueueService {
  private db: Database.Database;
  private initialized: boolean = false;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Initialize the printer tables if they don't exist
   */
  initialize(): void {
    if (this.initialized) return;

    const tables = checkPrinterTablesExist(this.db);
    if (!tables.printers || !tables.printQueue || !tables.printJobHistory) {
      initializePrinterTables(this.db);
    }

    this.initialized = true;
  }

  /**
   * Add a print job to the queue with database persistence
   * @param job - The print job to enqueue
   * @param printerId - The target printer ID
   * @returns The job ID
   *
   * Requirements: 6.1
   */
  enqueue(job: PrintJob, printerId: string): string {
    this.initialize();

    const queuedJob: QueuedJob = {
      ...job,
      id: job.id || uuidv4(),
      printerId,
      status: QueuedJobStatus.PENDING,
      retryCount: 0,
      createdAt: job.createdAt || new Date(),
    };

    const serialized = serializeQueuedJob(queuedJob);

    const stmt = this.db.prepare(`
      INSERT INTO print_queue (
        id, printer_id, job_type, job_data, priority, status,
        retry_count, last_error, created_at, started_at, completed_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      serialized.id,
      serialized.printerId,
      serialized.type,
      serialized.data,
      serialized.priority,
      serialized.status,
      serialized.retryCount,
      serialized.lastError,
      serialized.createdAt,
      serialized.startedAt,
      serialized.completedAt,
      serialized.metadata
    );

    return queuedJob.id;
  }

  /**
   * Remove and return the next job from the queue (FIFO ordering)
   * Jobs are ordered by priority (descending) then by creation time (ascending)
   * @param printerId - Optional printer ID to filter by
   * @returns The next queued job or null if queue is empty
   *
   * Requirements: 6.2
   */
  dequeue(printerId?: string): QueuedJob | null {
    this.initialize();

    let stmt;
    let row: PrintQueueRow | undefined;

    if (printerId) {
      stmt = this.db.prepare(`
        SELECT * FROM print_queue
        WHERE printer_id = ? AND status = 'pending'
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      `);
      row = stmt.get(printerId) as PrintQueueRow | undefined;
    } else {
      stmt = this.db.prepare(`
        SELECT * FROM print_queue
        WHERE status = 'pending'
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      `);
      row = stmt.get() as PrintQueueRow | undefined;
    }

    if (!row) return null;

    // Update status to printing
    const updateStmt = this.db.prepare(`
      UPDATE print_queue
      SET status = 'printing', started_at = ?
      WHERE id = ?
    `);
    updateStmt.run(new Date().toISOString(), row.id);

    // Return the job with updated status
    const job = deserializeQueuedJob(row);
    job.status = QueuedJobStatus.PRINTING;
    job.startedAt = new Date();

    return job;
  }

  /**
   * View the next job in the queue without removing it
   * @param printerId - Optional printer ID to filter by
   * @returns The next queued job or null if queue is empty
   */
  peek(printerId?: string): QueuedJob | null {
    this.initialize();

    let stmt;
    let row: PrintQueueRow | undefined;

    if (printerId) {
      stmt = this.db.prepare(`
        SELECT * FROM print_queue
        WHERE printer_id = ? AND status = 'pending'
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      `);
      row = stmt.get(printerId) as PrintQueueRow | undefined;
    } else {
      stmt = this.db.prepare(`
        SELECT * FROM print_queue
        WHERE status = 'pending'
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      `);
      row = stmt.get() as PrintQueueRow | undefined;
    }

    if (!row) return null;

    return deserializeQueuedJob(row);
  }

  /**
   * Get all queued jobs, optionally filtered by printer
   * @param printerId - Optional printer ID to filter by
   * @returns Array of queued jobs
   */
  getQueuedJobs(printerId?: string): QueuedJob[] {
    this.initialize();

    let stmt;
    let rows: PrintQueueRow[];

    if (printerId) {
      stmt = this.db.prepare(`
        SELECT * FROM print_queue
        WHERE printer_id = ?
        ORDER BY priority DESC, created_at ASC
      `);
      rows = stmt.all(printerId) as PrintQueueRow[];
    } else {
      stmt = this.db.prepare(`
        SELECT * FROM print_queue
        ORDER BY priority DESC, created_at ASC
      `);
      rows = stmt.all() as PrintQueueRow[];
    }

    return rows.map(deserializeQueuedJob);
  }

  /**
   * Get all pending jobs (for restart recovery)
   * @returns Array of pending queued jobs
   *
   * Requirements: 6.5
   */
  getPendingJobs(): QueuedJob[] {
    this.initialize();

    const stmt = this.db.prepare(`
      SELECT * FROM print_queue
      WHERE status IN ('pending', 'printing')
      ORDER BY priority DESC, created_at ASC
    `);

    const rows = stmt.all() as PrintQueueRow[];
    return rows.map(deserializeQueuedJob);
  }

  /**
   * Mark a job as completed and move to history
   * @param jobId - The job ID to mark as complete
   *
   * Requirements: 6.2
   */
  markComplete(jobId: string): void {
    this.initialize();

    const now = new Date();
    const nowIso = now.toISOString();

    // Get the job first
    const selectStmt = this.db.prepare(`SELECT * FROM print_queue WHERE id = ?`);
    const row = selectStmt.get(jobId) as PrintQueueRow | undefined;

    if (!row) return;

    // Calculate duration
    const startedAt = row.started_at ? new Date(row.started_at) : now;
    const durationMs = now.getTime() - startedAt.getTime();

    // Move to history
    const insertHistoryStmt = this.db.prepare(`
      INSERT INTO print_job_history (
        id, printer_id, job_type, job_data, priority, status,
        retry_count, last_error, created_at, started_at, completed_at, metadata, duration_ms
      ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)
    `);

    insertHistoryStmt.run(
      row.id,
      row.printer_id,
      row.job_type,
      row.job_data,
      row.priority,
      row.retry_count,
      row.last_error,
      row.created_at,
      row.started_at,
      nowIso,
      row.metadata,
      durationMs
    );

    // Remove from queue
    const deleteStmt = this.db.prepare(`DELETE FROM print_queue WHERE id = ?`);
    deleteStmt.run(jobId);
  }

  /**
   * Mark a job as failed
   * @param jobId - The job ID to mark as failed
   * @param error - The error message
   *
   * Requirements: 6.3
   */
  markFailed(jobId: string, error: string): void {
    this.initialize();

    const now = new Date();
    const nowIso = now.toISOString();

    // Get the job first
    const selectStmt = this.db.prepare(`SELECT * FROM print_queue WHERE id = ?`);
    const row = selectStmt.get(jobId) as PrintQueueRow | undefined;

    if (!row) return;

    // Calculate duration
    const startedAt = row.started_at ? new Date(row.started_at) : now;
    const durationMs = now.getTime() - startedAt.getTime();

    // Move to history
    const insertHistoryStmt = this.db.prepare(`
      INSERT INTO print_job_history (
        id, printer_id, job_type, job_data, priority, status,
        retry_count, last_error, created_at, started_at, completed_at, metadata, duration_ms
      ) VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?)
    `);

    insertHistoryStmt.run(
      row.id,
      row.printer_id,
      row.job_type,
      row.job_data,
      row.priority,
      row.retry_count,
      error,
      row.created_at,
      row.started_at,
      nowIso,
      row.metadata,
      durationMs
    );

    // Remove from queue
    const deleteStmt = this.db.prepare(`DELETE FROM print_queue WHERE id = ?`);
    deleteStmt.run(jobId);
  }

  /**
   * Increment the retry count for a job and reset status to pending
   * @param jobId - The job ID to retry
   * @returns The new retry count, or -1 if job not found
   *
   * Requirements: 6.3
   */
  incrementRetry(jobId: string): number {
    this.initialize();

    // Get current retry count
    const selectStmt = this.db.prepare(`SELECT retry_count FROM print_queue WHERE id = ?`);
    const row = selectStmt.get(jobId) as { retry_count: number } | undefined;

    if (!row) return -1;

    const newRetryCount = row.retry_count + 1;

    // Update retry count and reset status to pending
    const updateStmt = this.db.prepare(`
      UPDATE print_queue
      SET retry_count = ?, status = 'pending', started_at = NULL
      WHERE id = ?
    `);
    updateStmt.run(newRetryCount, jobId);

    return newRetryCount;
  }

  /**
   * Update the last error for a job
   * @param jobId - The job ID
   * @param error - The error message
   */
  setLastError(jobId: string, error: string): void {
    this.initialize();

    const stmt = this.db.prepare(`
      UPDATE print_queue SET last_error = ? WHERE id = ?
    `);
    stmt.run(error, jobId);
  }

  /**
   * Remove a job from the queue
   * @param jobId - The job ID to remove
   * @returns true if removed, false if not found
   */
  removeJob(jobId: string): boolean {
    this.initialize();

    const stmt = this.db.prepare(`DELETE FROM print_queue WHERE id = ?`);
    const result = stmt.run(jobId);
    return result.changes > 0;
  }

  /**
   * Get a specific job by ID
   * @param jobId - The job ID
   * @returns The queued job or null if not found
   */
  getJob(jobId: string): QueuedJob | null {
    this.initialize();

    const stmt = this.db.prepare(`SELECT * FROM print_queue WHERE id = ?`);
    const row = stmt.get(jobId) as PrintQueueRow | undefined;

    if (!row) return null;

    return deserializeQueuedJob(row);
  }

  /**
   * Get the count of jobs in the queue
   * @param printerId - Optional printer ID to filter by
   * @param status - Optional status to filter by
   * @returns The count of jobs
   */
  getQueueLength(printerId?: string, status?: QueuedJobStatus): number {
    this.initialize();

    let sql = 'SELECT COUNT(*) as count FROM print_queue WHERE 1=1';
    const params: (string | undefined)[] = [];

    if (printerId) {
      sql += ' AND printer_id = ?';
      params.push(printerId);
    }

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params) as { count: number };
    return result.count;
  }

  /**
   * Reset all 'printing' jobs back to 'pending' (for crash recovery)
   * @returns The number of jobs reset
   *
   * Requirements: 6.5
   */
  resetPrintingJobs(): number {
    this.initialize();

    const stmt = this.db.prepare(`
      UPDATE print_queue
      SET status = 'pending', started_at = NULL
      WHERE status = 'printing'
    `);
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Clear all jobs from the queue (for testing)
   */
  clearQueue(): void {
    this.initialize();
    this.db.exec('DELETE FROM print_queue');
  }

  /**
   * Clear job history (for testing)
   */
  clearHistory(): void {
    this.initialize();
    this.db.exec('DELETE FROM print_job_history');
  }

  /**
   * Get recent job statistics for a printer
   * @param printerId - The printer ID
   * @param limit - Maximum number of recent jobs to consider (default 100)
   * @returns Statistics about recent jobs
   *
   * Requirements: 10.5
   */
  getRecentJobStats(printerId: string, limit: number = 100): {
    total: number;
    successful: number;
    failed: number;
  } {
    this.initialize();

    const stmt = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM (
        SELECT status FROM print_job_history
        WHERE printer_id = ?
        ORDER BY completed_at DESC
        LIMIT ?
      )
    `);

    const result = stmt.get(printerId, limit) as {
      total: number;
      successful: number;
      failed: number;
    } | undefined;

    return {
      total: result?.total ?? 0,
      successful: result?.successful ?? 0,
      failed: result?.failed ?? 0,
    };
  }
}
