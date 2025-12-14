/**
 * Printer Database Schema
 *
 * SQL schema definitions for printer-related tables.
 * This module provides the schema for:
 * - printers: Configuration storage for all printer types
 * - print_queue: Persistent job queue for reliable printing
 * - print_job_history: Historical record of completed/failed jobs
 *
 * @module printer/services/PrinterDatabaseSchema
 */

/**
 * SQL to create the printers table for configuration storage
 * Stores all printer configurations with JSON-serialized connection details
 *
 * Requirements: 6.1, 8.1
 */
export const CREATE_PRINTERS_TABLE = `
  CREATE TABLE IF NOT EXISTS printers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('network', 'bluetooth', 'usb', 'wifi')),
    connection_details TEXT NOT NULL,
    paper_size TEXT NOT NULL CHECK (paper_size IN ('58mm', '80mm', '112mm')),
    character_set TEXT NOT NULL DEFAULT 'PC437_USA',
    role TEXT NOT NULL CHECK (role IN ('receipt', 'kitchen', 'bar', 'label')),
    is_default INTEGER NOT NULL DEFAULT 0,
    fallback_printer_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (fallback_printer_id) REFERENCES printers(id) ON DELETE SET NULL
  )
`;

/**
 * SQL to create the print_queue table for job persistence
 * Stores pending print jobs with retry tracking
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5
 */
export const CREATE_PRINT_QUEUE_TABLE = `
  CREATE TABLE IF NOT EXISTS print_queue (
    id TEXT PRIMARY KEY,
    printer_id TEXT NOT NULL,
    job_type TEXT NOT NULL CHECK (job_type IN ('receipt', 'kitchen_ticket', 'label', 'report', 'test')),
    job_data TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'printing', 'completed', 'failed')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    metadata TEXT,
    FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE CASCADE
  )
`;

/**
 * SQL to create the print_job_history table for completed/failed jobs
 * Maintains historical record for diagnostics and reporting
 *
 * Requirements: 10.5
 */
export const CREATE_PRINT_JOB_HISTORY_TABLE = `
  CREATE TABLE IF NOT EXISTS print_job_history (
    id TEXT PRIMARY KEY,
    printer_id TEXT NOT NULL,
    job_type TEXT NOT NULL,
    job_data TEXT NOT NULL,
    priority INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
    retry_count INTEGER NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT NOT NULL,
    metadata TEXT,
    duration_ms INTEGER
  )
`;

/**
 * SQL to create indexes for efficient querying
 */
export const CREATE_PRINTER_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_printers_role ON printers(role);
  CREATE INDEX IF NOT EXISTS idx_printers_type ON printers(type);
  CREATE INDEX IF NOT EXISTS idx_printers_enabled ON printers(enabled);
  CREATE INDEX IF NOT EXISTS idx_printers_is_default ON printers(is_default);
  
  CREATE INDEX IF NOT EXISTS idx_print_queue_printer_id ON print_queue(printer_id);
  CREATE INDEX IF NOT EXISTS idx_print_queue_status ON print_queue(status);
  CREATE INDEX IF NOT EXISTS idx_print_queue_created_at ON print_queue(created_at);
  CREATE INDEX IF NOT EXISTS idx_print_queue_priority ON print_queue(priority DESC, created_at ASC);
  
  CREATE INDEX IF NOT EXISTS idx_print_job_history_printer_id ON print_job_history(printer_id);
  CREATE INDEX IF NOT EXISTS idx_print_job_history_status ON print_job_history(status);
  CREATE INDEX IF NOT EXISTS idx_print_job_history_completed_at ON print_job_history(completed_at);
`;

/**
 * All schema creation statements in order
 */
export const ALL_PRINTER_SCHEMA = [
  CREATE_PRINTERS_TABLE,
  CREATE_PRINT_QUEUE_TABLE,
  CREATE_PRINT_JOB_HISTORY_TABLE,
  CREATE_PRINTER_INDEXES,
];

/**
 * Initialize printer tables in the database
 * @param db - better-sqlite3 Database instance
 */
export function initializePrinterTables(db: import('better-sqlite3').Database): void {
  console.log('[PrinterDatabaseSchema] Initializing printer tables...');

  for (const sql of ALL_PRINTER_SCHEMA) {
    try {
      db.exec(sql);
    } catch (error) {
      console.error('[PrinterDatabaseSchema] Failed to execute schema:', error);
      throw error;
    }
  }

  console.log('[PrinterDatabaseSchema] ✅ Printer tables initialized successfully');
}

/**
 * Check if printer tables exist in the database
 * @param db - better-sqlite3 Database instance
 * @returns Object indicating which tables exist
 */
export function checkPrinterTablesExist(db: import('better-sqlite3').Database): {
  printers: boolean;
  printQueue: boolean;
  printJobHistory: boolean;
} {
  const checkTable = (tableName: string): boolean => {
    const result = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    ).get(tableName);
    return !!result;
  };

  return {
    printers: checkTable('printers'),
    printQueue: checkTable('print_queue'),
    printJobHistory: checkTable('print_job_history'),
  };
}
