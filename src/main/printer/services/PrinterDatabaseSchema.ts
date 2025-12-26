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
    type TEXT NOT NULL CHECK (type IN ('network', 'bluetooth', 'usb', 'wifi', 'system')),
    connection_details TEXT NOT NULL,
    paper_size TEXT NOT NULL CHECK (paper_size IN ('58mm', '80mm', '112mm')),
    character_set TEXT NOT NULL DEFAULT 'PC437_USA',
    greek_render_mode TEXT DEFAULT 'text' CHECK (greek_render_mode IN ('text', 'bitmap')),
    receipt_template TEXT DEFAULT 'classic' CHECK (receipt_template IN ('classic', 'modern')),
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

/**
 * Migrate the printers table to add 'system' type support
 * SQLite doesn't support ALTER TABLE to modify CHECK constraints,
 * so we need to recreate the table with the new constraint.
 * 
 * @param db - better-sqlite3 Database instance
 */
export function migratePrintersTableForSystemType(db: import('better-sqlite3').Database): void {
  // Check if migration is needed by trying to insert a test value
  // If the constraint already includes 'system', this will succeed
  try {
    // Check the current schema
    const tableInfo = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='printers'`
    ).get() as { sql: string } | undefined;
    
    if (!tableInfo) {
      // Table doesn't exist, no migration needed
      return;
    }
    
    // Check if 'system' is already in the CHECK constraint
    if (tableInfo.sql.includes("'system'")) {
      console.log('[PrinterDatabaseSchema] Printers table already supports system type');
      return;
    }
    
    console.log('[PrinterDatabaseSchema] Migrating printers table to add system type support...');
    
    // Begin transaction
    db.exec('BEGIN TRANSACTION');
    
    try {
      // 1. Create new table with updated constraint
      db.exec(`
        CREATE TABLE printers_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('network', 'bluetooth', 'usb', 'wifi', 'system')),
          connection_details TEXT NOT NULL,
          paper_size TEXT NOT NULL CHECK (paper_size IN ('58mm', '80mm', '112mm')),
          character_set TEXT NOT NULL DEFAULT 'PC437_USA',
          role TEXT NOT NULL CHECK (role IN ('receipt', 'kitchen', 'bar', 'label')),
          is_default INTEGER NOT NULL DEFAULT 0,
          fallback_printer_id TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (fallback_printer_id) REFERENCES printers_new(id) ON DELETE SET NULL
        )
      `);
      
      // 2. Copy data from old table
      db.exec(`
        INSERT INTO printers_new 
        SELECT * FROM printers
      `);
      
      // 3. Drop old table
      db.exec('DROP TABLE printers');
      
      // 4. Rename new table
      db.exec('ALTER TABLE printers_new RENAME TO printers');
      
      // 5. Recreate indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_printers_role ON printers(role);
        CREATE INDEX IF NOT EXISTS idx_printers_type ON printers(type);
        CREATE INDEX IF NOT EXISTS idx_printers_enabled ON printers(enabled);
        CREATE INDEX IF NOT EXISTS idx_printers_is_default ON printers(is_default);
      `);
      
      // Commit transaction
      db.exec('COMMIT');
      
      console.log('[PrinterDatabaseSchema] ✅ Migration completed successfully');
    } catch (error) {
      // Rollback on error
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('[PrinterDatabaseSchema] Migration failed:', error);
    throw error;
  }
}

/**
 * Migrate the printers table to add 'greek_render_mode' column
 * This column stores the rendering mode for Greek text ('text' or 'bitmap')
 * 
 * @param db - better-sqlite3 Database instance
 */
export function migratePrintersTableForGreekRenderMode(db: import('better-sqlite3').Database): void {
  try {
    // Check if the column already exists
    const tableInfo = db.prepare('PRAGMA table_info(printers)').all() as Array<{ name: string }>;
    const hasColumn = tableInfo.some(col => col.name === 'greek_render_mode');
    
    if (hasColumn) {
      console.log('[PrinterDatabaseSchema] greek_render_mode column already exists');
      return;
    }
    
    console.log('[PrinterDatabaseSchema] Adding greek_render_mode column to printers table...');
    
    // SQLite supports adding columns with ALTER TABLE
    db.exec(`
      ALTER TABLE printers 
      ADD COLUMN greek_render_mode TEXT DEFAULT 'text' 
      CHECK (greek_render_mode IN ('text', 'bitmap'))
    `);
    
    console.log('[PrinterDatabaseSchema] ✅ greek_render_mode column added successfully');
  } catch (error) {
    console.error('[PrinterDatabaseSchema] Failed to add greek_render_mode column:', error);
    // Don't throw - this is a non-critical migration
  }
}

/**
 * Migrate the printers table to add 'receipt_template' column
 * This column stores the receipt template style ('classic' or 'modern')
 * 
 * @param db - better-sqlite3 Database instance
 */
export function migratePrintersTableForReceiptTemplate(db: import('better-sqlite3').Database): void {
  try {
    // Check if the column already exists
    const tableInfo = db.prepare('PRAGMA table_info(printers)').all() as Array<{ name: string }>;
    const hasColumn = tableInfo.some(col => col.name === 'receipt_template');
    
    if (hasColumn) {
      console.log('[PrinterDatabaseSchema] receipt_template column already exists');
      return;
    }
    
    console.log('[PrinterDatabaseSchema] Adding receipt_template column to printers table...');
    
    // SQLite supports adding columns with ALTER TABLE
    // Note: SQLite doesn't support CHECK constraints in ALTER TABLE, so we add without constraint
    db.exec(`
      ALTER TABLE printers 
      ADD COLUMN receipt_template TEXT DEFAULT 'classic'
    `);
    
    console.log('[PrinterDatabaseSchema] ✅ receipt_template column added successfully');
  } catch (error) {
    console.error('[PrinterDatabaseSchema] Failed to add receipt_template column:', error);
    // Don't throw - this is a non-critical migration
  }
}
