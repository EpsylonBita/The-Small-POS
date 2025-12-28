import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';

// Import domain services
import { OrderService } from './OrderService';
import { StaffService } from './StaffService';
import { SyncQueueService } from './SyncQueueService';
import { SettingsService } from './SettingsService';
import { PaymentService } from './PaymentService';
import { ReportService } from './ReportService';
import { CustomerCacheService } from './CustomerCacheService';
import { CustomerDataService } from './CustomerDataService';

// Import error handling utilities
import { ErrorFactory, withTimeout, withRetry, POSError } from '../../shared/utils/error-handler';
import { TIMING, RETRY } from '../../shared/constants';

export class DatabaseService {
  private db: Database.Database | null = null;
  private dbPath: string;
  private healthCheckCache: { healthy: boolean; responseTime: number; lastCheck: string; error?: string } | null = null;
  private healthCheckCacheTime: number = 0;
  private lastError: POSError | null = null;

  // Domain services
  public orders: OrderService;
  public staff: StaffService;
  public sync: SyncQueueService;
  public settings: SettingsService;
  public payments: PaymentService;
  public reports: ReportService;
  public customerCache: CustomerCacheService;
  public customers: CustomerDataService;

  constructor() {
    // Store database in user data directory
    const userDataPath = app.getPath('userData');
    this.dbPath = path.join(userDataPath, 'pos-database.db');

    // Initialize services after database connection
    this.orders = null as unknown as OrderService;
    this.staff = null as unknown as StaffService;
    this.sync = null as unknown as SyncQueueService;
    this.settings = null as unknown as SettingsService;
    this.payments = null as unknown as PaymentService;
    this.reports = null as unknown as ReportService;
    this.customerCache = null as unknown as CustomerCacheService;
    this.customers = null as unknown as CustomerDataService;
  }

  async initialize(): Promise<void> {
    try {
      // Wrap initialization with timeout
      await withTimeout(
        this.initializeInternal(),
        TIMING.DATABASE_INIT_TIMEOUT,
        'Database initialization'
      );
    } catch (error) {
      const posError = ErrorFactory.databaseInit(
        'Failed to initialize database',
        {
          dbPath: this.dbPath,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        }
      );
      this.lastError = posError;
      console.error('Failed to initialize database:', posError);
      throw posError;
    }
  }

  private async initializeInternal(): Promise<void> {
    // Use retry logic for transient failures
    await withRetry(async () => {
      this.db = new Database(this.dbPath);

      // Disable foreign keys - staff data is managed in Supabase, not locally
      // This prevents foreign key constraint failures when staff_id doesn't exist in local staff table
      this.db.pragma('foreign_keys = OFF');

      // Enable WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = 1000');
      this.db.pragma('temp_store = memory');

      await this.createTables();

      // Initialize domain services
      this.orders = new OrderService(this.db);
      this.staff = new StaffService(this.db);
      this.sync = new SyncQueueService(this.db);
      this.settings = new SettingsService(this.db);
      this.payments = new PaymentService(this.db);
      this.reports = new ReportService(this.db);
      this.customerCache = new CustomerCacheService(this.db);
      this.customers = new CustomerDataService(this.db);
    }, RETRY.MAX_RETRY_ATTEMPTS, RETRY.RETRY_DELAY_MS);
  }

  async initializeWithFallback(): Promise<{ success: boolean; usedFallback: boolean; error?: POSError }> {
    try {
      // Try normal initialization first
      await this.initialize();
      return { success: true, usedFallback: false };
    } catch (error) {
      console.warn('Normal initialization failed, attempting fallback...');

      try {
        // Create backup of potentially corrupted database
        const fs = require('fs');
        const backupPath = `${this.dbPath}.backup.${Date.now()}`;

        if (fs.existsSync(this.dbPath)) {
          fs.copyFileSync(this.dbPath, backupPath);
          console.log(`Created backup at: ${backupPath}`);

          // Remove corrupted database
          fs.unlinkSync(this.dbPath);
        }

        // Try initialization with fresh database
        await this.initialize();
        return { success: true, usedFallback: true };
      } catch (fallbackError) {
        const posError = ErrorFactory.databaseInit(
          'Failed to initialize database even with fallback',
          {
            originalError: error instanceof Error ? error.message : String(error),
            fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          }
        );
        return { success: false, usedFallback: true, error: posError };
      }
    }
  }

  private applyMigrations(): void {
    if (!this.db) throw new Error('Database not initialized');

    console.log('Applying database migrations...');

    // Check if orders table exists
    const tableExists = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='orders'
    `).get();

    if (tableExists) {
      // Check if version column exists
      const columns = this.db.prepare(`PRAGMA table_info(orders)`).all() as any[];
      const hasVersion = columns.some((col: any) => col.name === 'version');
      const hasUpdatedBy = columns.some((col: any) => col.name === 'updated_by');
      const hasLastSyncedAt = columns.some((col: any) => col.name === 'last_synced_at');
      const hasRemoteVersion = columns.some((col: any) => col.name === 'remote_version');

      // Add missing columns
      if (!hasVersion) {
        console.log('Adding version column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN version INTEGER DEFAULT 1 NOT NULL`);
      }
      if (!hasUpdatedBy) {
        console.log('Adding updated_by column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN updated_by TEXT`);
      }
      if (!hasLastSyncedAt) {
        console.log('Adding last_synced_at column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN last_synced_at TEXT`);
      }
      if (!hasRemoteVersion) {
        console.log('Adding remote_version column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN remote_version INTEGER`);
      }

      const hasRoutingPath = columns.some((col: any) => col.name === 'routing_path');
      const hasSourceTerminalId = columns.some((col: any) => col.name === 'source_terminal_id');
      const hasForwardedAt = columns.some((col: any) => col.name === 'forwarded_at');
      const hasDeliveryNotes = columns.some((col: any) => col.name === 'delivery_notes');
      const hasNameOnRinger = columns.some((col: any) => col.name === 'name_on_ringer');

      if (!hasRoutingPath) {
        console.log('Adding routing_path column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN routing_path TEXT`);
      }
      if (!hasSourceTerminalId) {
        console.log('Adding source_terminal_id column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN source_terminal_id TEXT`);
      }
      if (!hasForwardedAt) {
        console.log('Adding forwarded_at column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN forwarded_at TEXT`);
      }
      if (!hasDeliveryNotes) {
        console.log('Adding delivery_notes column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN delivery_notes TEXT`);
      }
      if (!hasNameOnRinger) {
        console.log('Adding name_on_ringer column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN name_on_ringer TEXT`);
      }

      const hasDeliveryFloor = columns.some((col: any) => col.name === 'delivery_floor');
      const hasDeliveryCity = columns.some((col: any) => col.name === 'delivery_city');
      const hasDeliveryPostalCode = columns.some((col: any) => col.name === 'delivery_postal_code');

      if (!hasDeliveryFloor) {
        console.log('Adding delivery_floor column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN delivery_floor TEXT`);
      }
      if (!hasDeliveryCity) {
        console.log('Adding delivery_city column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN delivery_city TEXT`);
      }
      if (!hasDeliveryPostalCode) {
        console.log('Adding delivery_postal_code column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN delivery_postal_code TEXT`);
      }

      // Add driver and staff related columns
      const hasDriverId = columns.some((col: any) => col.name === 'driver_id');
      const hasStaffShiftId = columns.some((col: any) => col.name === 'staff_shift_id');
      const hasStaffId = columns.some((col: any) => col.name === 'staff_id');
      const hasDiscountPercentage = columns.some((col: any) => col.name === 'discount_percentage');
      const hasDiscountAmount = columns.some((col: any) => col.name === 'discount_amount');
      const hasTipAmount = columns.some((col: any) => col.name === 'tip_amount');

      if (!hasDriverId) {
        console.log('Adding driver_id column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN driver_id TEXT`);
      }

      // Add driver_name for display without joins
      const hasDriverName = columns.some((col: any) => col.name === 'driver_name');
      if (!hasDriverName) {
        console.log('Adding driver_name column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN driver_name TEXT`);
      }
      if (!hasStaffShiftId) {
        console.log('Adding staff_shift_id column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN staff_shift_id TEXT`);
      }
      if (!hasStaffId) {
        console.log('Adding staff_id column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN staff_id TEXT`);
      }
      if (!hasDiscountPercentage) {
        console.log('Adding discount_percentage column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN discount_percentage REAL`);
      }
      if (!hasDiscountAmount) {
        console.log('Adding discount_amount column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN discount_amount REAL`);
      }
      if (!hasTipAmount) {
        console.log('Adding tip_amount column to orders table...');
        this.db.exec(`ALTER TABLE orders ADD COLUMN tip_amount REAL`);
      }
    }

    console.log('✅ Orders table migrations complete');

    // Check if sync_queue table exists and add new columns
    const syncQueueExists = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='sync_queue'
    `).get();

    if (syncQueueExists) {
      const syncColumns = this.db.prepare(`PRAGMA table_info(sync_queue)`).all() as any[];
      const hasNextRetryAt = syncColumns.some((col: any) => col.name === 'next_retry_at');
      const hasRetryDelayMs = syncColumns.some((col: any) => col.name === 'retry_delay_ms');
      const hasConflict = syncColumns.some((col: any) => col.name === 'has_conflict');
      const hasConflictId = syncColumns.some((col: any) => col.name === 'conflict_id');

      if (!hasNextRetryAt) {
        console.log('Adding next_retry_at column to sync_queue table...');
        this.db.exec(`ALTER TABLE sync_queue ADD COLUMN next_retry_at TEXT`);
      }
      if (!hasRetryDelayMs) {
        console.log('Adding retry_delay_ms column to sync_queue table...');
        this.db.exec(`ALTER TABLE sync_queue ADD COLUMN retry_delay_ms INTEGER DEFAULT 5000`);
      }
      if (!hasConflict) {
        console.log('Adding has_conflict column to sync_queue table...');
        this.db.exec(`ALTER TABLE sync_queue ADD COLUMN has_conflict INTEGER DEFAULT 0`);
      }
      if (!hasConflictId) {
        console.log('Adding conflict_id column to sync_queue table...');
        this.db.exec(`ALTER TABLE sync_queue ADD COLUMN conflict_id TEXT`);
      }

      const hasRoutingAttempt = syncColumns.some((col: any) => col.name === 'routing_attempt');
      const hasRoutingPath = syncColumns.some((col: any) => col.name === 'routing_path');

      if (!hasRoutingAttempt) {
        console.log('Adding routing_attempt column to sync_queue table...');
        this.db.exec(`ALTER TABLE sync_queue ADD COLUMN routing_attempt INTEGER DEFAULT 0`);
      }
      if (!hasRoutingPath) {
        console.log('Adding routing_path column to sync_queue table...');
        this.db.exec(`ALTER TABLE sync_queue ADD COLUMN routing_path TEXT`);
      }

      console.log('✅ Sync queue migrations complete');
    }

    // Check if terminal_settings table exists and add business_type column
    const terminalSettingsExists = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='terminal_settings'
    `).get();

    if (terminalSettingsExists) {
      const terminalColumns = this.db.prepare(`PRAGMA table_info(terminal_settings)`).all() as any[];
      const hasBusinessType = terminalColumns.some((col: any) => col.name === 'business_type');

      if (!hasBusinessType) {
        console.log('Adding business_type column to terminal_settings table...');
        this.db.exec(`ALTER TABLE terminal_settings ADD COLUMN business_type TEXT`);
      }

      console.log('✅ Terminal settings migrations complete');
    }

    // Check for supabase_id in financial tables
    const financialTables = ['driver_earnings', 'staff_payments', 'shift_expenses'];
    for (const table of financialTables) {
      const tableExists = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      if (tableExists) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        const hasSupabaseId = columns.some((col: any) => col.name === 'supabase_id');
        if (!hasSupabaseId) {
          console.log(`Adding supabase_id column to ${table} table...`);
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN supabase_id TEXT`);
        }
      }
    }

    console.log('✅ All migrations applied successfully');
  }

  private async createTables(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Apply migrations first for existing tables
    this.applyMigrations();

    const errors: Array<{ table: string; error: string }> = [];

    // Helper function to create table with error handling
    const createTableSafe = (tableName: string, sql: string) => {
      try {
        this.db!.exec(sql);
        // Validation query after table creation
        this.db!.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({ table: tableName, error: errorMsg });
        console.error(`Failed to create table ${tableName}:`, error);
      }
    };

    // Orders table
    createTableSafe('orders', `
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        order_number TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL,
        items TEXT NOT NULL,
        total_amount REAL NOT NULL,
        customer_name TEXT,
        customer_phone TEXT,
        customer_email TEXT,
        order_type TEXT NOT NULL,
        table_number TEXT,
        delivery_address TEXT,
        delivery_city TEXT,
        delivery_postal_code TEXT,
        delivery_floor TEXT,
        delivery_notes TEXT,
        name_on_ringer TEXT,
        special_instructions TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        estimated_time INTEGER,
        supabase_id TEXT,
        sync_status TEXT DEFAULT 'pending',
        payment_status TEXT DEFAULT 'pending',
        payment_method TEXT,
        payment_transaction_id TEXT,
        version INTEGER DEFAULT 1 NOT NULL,
        updated_by TEXT,
        last_synced_at TEXT,
        remote_version INTEGER,
        driver_id TEXT,
        driver_name TEXT,
        staff_shift_id TEXT,
        staff_id TEXT,
        discount_percentage REAL,
        discount_amount REAL,
        tip_amount REAL
      )
    `);

    // Add indexes for orders table
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orders_sync_status ON orders(sync_status);
      CREATE INDEX IF NOT EXISTS idx_orders_version ON orders(id, version);
      CREATE INDEX IF NOT EXISTS idx_orders_supabase_id ON orders(supabase_id);
    `);

    // Payment transactions table
    createTableSafe('payment_transactions', `
      CREATE TABLE IF NOT EXISTS payment_transactions (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        amount REAL NOT NULL,
        payment_method TEXT NOT NULL,
        status TEXT NOT NULL,
        gateway_transaction_id TEXT,
        gateway_response TEXT,
        processed_at TEXT NOT NULL,
        refunded_amount REAL DEFAULT 0,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders (id)
      )
    `);

    // Payment receipts table
    createTableSafe('payment_receipts', `
      CREATE TABLE IF NOT EXISTS payment_receipts (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        receipt_number TEXT UNIQUE NOT NULL,
        order_details TEXT NOT NULL,
        subtotal REAL NOT NULL,
        tax REAL NOT NULL,
        delivery_fee REAL DEFAULT 0,
        total_amount REAL NOT NULL,
        payment_method TEXT NOT NULL,
        cash_received REAL,
        change_given REAL,
        printed BOOLEAN DEFAULT FALSE,
        emailed BOOLEAN DEFAULT FALSE,
        email_address TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (transaction_id) REFERENCES payment_transactions (id)
      )
    `);

    // Payment refunds table
    createTableSafe('payment_refunds', `
      CREATE TABLE IF NOT EXISTS payment_refunds (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        amount REAL NOT NULL,
        reason TEXT,
        status TEXT NOT NULL,
        gateway_refund_id TEXT,
        processed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (transaction_id) REFERENCES payment_transactions (id)
      )
    `);

    // Terminal settings table (local cache for offline support)
    createTableSafe('terminal_settings', `
      CREATE TABLE IF NOT EXISTS terminal_settings (
        terminal_id TEXT PRIMARY KEY,
        branch_id TEXT,
        organization_id TEXT,
        business_type TEXT,
        settings TEXT DEFAULT '{}',
        version INTEGER DEFAULT 1,
        updated_at TEXT,
        synced_at TEXT
      )
    `);

    // Staff sessions table
    createTableSafe('staff_sessions', `
      CREATE TABLE IF NOT EXISTS staff_sessions (
        id TEXT PRIMARY KEY,
        staff_id TEXT NOT NULL,
        pin_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
        login_time TEXT NOT NULL,
        logout_time TEXT,
        is_active BOOLEAN NOT NULL DEFAULT 1
      )
    `);

    // Staff table (local cache of staff members for offline support)
    createTableSafe('staff', `
      CREATE TABLE IF NOT EXISTS staff (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        staff_code TEXT UNIQUE,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT UNIQUE,
        phone TEXT,
        role_id TEXT,
        branch_id TEXT,
        department TEXT,
        employment_type TEXT DEFAULT 'full-time',
        hire_date TEXT,
        hourly_rate REAL,
        pin_hash TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        can_login_pos INTEGER NOT NULL DEFAULT 1,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Staff shifts table
    // Note: No foreign key on staff_id because staff data is managed in Supabase, not locally
    createTableSafe('staff_shifts', `
      CREATE TABLE IF NOT EXISTS staff_shifts (
        id TEXT PRIMARY KEY,
        staff_id TEXT NOT NULL,
        staff_name TEXT,
        branch_id TEXT,
        terminal_id TEXT,
        role_type TEXT NOT NULL CHECK (role_type IN ('cashier', 'manager', 'driver', 'kitchen', 'server')),
        check_in_time TEXT NOT NULL,
        check_out_time TEXT,
        scheduled_start TEXT,
        scheduled_end TEXT,
        opening_cash_amount REAL DEFAULT 0,
        closing_cash_amount REAL,
        expected_cash_amount REAL,
        cash_variance REAL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'abandoned')),
        total_orders_count INTEGER DEFAULT 0,
        total_sales_amount REAL DEFAULT 0,
        total_cash_sales REAL DEFAULT 0,
        total_card_sales REAL DEFAULT 0,
        payment_amount REAL,
        is_day_start INTEGER DEFAULT 0,
        is_transfer_pending INTEGER DEFAULT 0,
        notes TEXT,
        closed_by TEXT,
        transferred_to_cashier_shift_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Sync queue table
    createTableSafe('sync_queue', `
      CREATE TABLE IF NOT EXISTS sync_queue (
        id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt TEXT,
        error_message TEXT,
        next_retry_at TEXT,
        retry_delay_ms INTEGER DEFAULT 5000,
        has_conflict INTEGER DEFAULT 0,
        conflict_id TEXT
      )
    `);

    // Add indexes for sync_queue
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sync_queue_next_retry ON sync_queue(next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_sync_queue_conflict ON sync_queue(has_conflict);
    `);

    // Order retry queue table for error handling
    createTableSafe('order_retry_queue', `
      CREATE TABLE IF NOT EXISTS order_retry_queue (
        id TEXT PRIMARY KEY,
        order_data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt TEXT,
        error_message TEXT
      )
    `);

    // Order sync conflicts table
    createTableSafe('order_sync_conflicts', `
      CREATE TABLE IF NOT EXISTS order_sync_conflicts (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        local_version INTEGER NOT NULL,
        remote_version INTEGER NOT NULL,
        local_data TEXT NOT NULL,
        remote_data TEXT NOT NULL,
        conflict_type TEXT NOT NULL CHECK (conflict_type IN ('version_mismatch', 'simultaneous_update', 'pending_local_changes')),
        resolution_strategy TEXT CHECK (resolution_strategy IN ('local_wins', 'remote_wins', 'manual_merge', 'force_update')),
        resolved INTEGER DEFAULT 0,
        resolved_at TEXT,
        resolved_by TEXT,
        terminal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Add indexes for order_sync_conflicts
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conflicts_unresolved ON order_sync_conflicts(resolved, created_at);
      CREATE INDEX IF NOT EXISTS idx_conflicts_order ON order_sync_conflicts(order_id);
      CREATE INDEX IF NOT EXISTS idx_conflicts_terminal ON order_sync_conflicts(terminal_id);
    `);

    // Local settings cache table
    createTableSafe('local_settings', `
      CREATE TABLE IF NOT EXISTS local_settings (
        id TEXT PRIMARY KEY,
        setting_category TEXT NOT NULL,
        setting_key TEXT NOT NULL,
        setting_value TEXT NOT NULL,
        last_sync TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(setting_category, setting_key)
      )
    `);

    // POS configurations local cache
    createTableSafe('pos_local_config', `
      CREATE TABLE IF NOT EXISTS pos_local_config (
        id TEXT PRIMARY KEY,
        terminal_id TEXT NOT NULL,
        config_key TEXT NOT NULL,
        config_value TEXT NOT NULL,
        last_sync TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(terminal_id, config_key)
      )
    `);

    // Cash drawer sessions table
    createTableSafe('cash_drawer_sessions', `
      CREATE TABLE IF NOT EXISTS cash_drawer_sessions (
        id TEXT PRIMARY KEY,
        staff_shift_id TEXT NOT NULL UNIQUE,
        cashier_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        opening_amount REAL NOT NULL DEFAULT 0,
        closing_amount REAL,
        expected_amount REAL,
        variance_amount REAL,
        total_cash_sales REAL DEFAULT 0,
        total_card_sales REAL DEFAULT 0,
        total_refunds REAL DEFAULT 0,
        total_expenses REAL DEFAULT 0,
        cash_drops REAL DEFAULT 0,
        driver_cash_given REAL DEFAULT 0,
        driver_cash_returned REAL DEFAULT 0,
        total_staff_payments REAL DEFAULT 0,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        reconciled INTEGER DEFAULT 0,
        reconciled_at TEXT,
        reconciled_by TEXT,
        reconciliation_notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(staff_shift_id) REFERENCES staff_shifts(id),
        CHECK(closed_at IS NULL OR closed_at >= opened_at),
        CHECK(reconciled = 0 OR(reconciled_at IS NOT NULL AND reconciled_by IS NOT NULL))
      )
    `);

    // Shift expenses table
    createTableSafe('shift_expenses', `
      CREATE TABLE IF NOT EXISTS shift_expenses(
        id TEXT PRIMARY KEY,
        staff_shift_id TEXT NOT NULL,
        staff_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        expense_type TEXT NOT NULL CHECK(expense_type IN('supplies', 'maintenance', 'petty_cash', 'refund', 'other')),
        amount REAL NOT NULL,
        description TEXT NOT NULL,
        receipt_number TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending', 'approved', 'rejected')),
        approved_by TEXT,
        approved_at TEXT,
        rejection_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(staff_shift_id) REFERENCES staff_shifts(id),
        CHECK(status != 'approved' OR(approved_by IS NOT NULL AND approved_at IS NOT NULL)),
        CHECK(status != 'rejected' OR rejection_reason IS NOT NULL)
      )
      `);

    // Driver earnings table
    createTableSafe('driver_earnings', `
      CREATE TABLE IF NOT EXISTS driver_earnings(
        id TEXT PRIMARY KEY,
        driver_id TEXT NOT NULL,
        staff_shift_id TEXT,
        order_id TEXT UNIQUE NOT NULL,
        branch_id TEXT NOT NULL,
        delivery_fee REAL DEFAULT 0,
        tip_amount REAL DEFAULT 0,
        total_earning REAL NOT NULL,
        payment_method TEXT NOT NULL CHECK(payment_method IN('cash', 'card', 'mixed')),
        cash_collected REAL DEFAULT 0,
        card_amount REAL DEFAULT 0,
        cash_to_return REAL DEFAULT 0,
        order_details TEXT,
        settled INTEGER DEFAULT 0,
        settled_at TEXT,
        settlement_batch_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(staff_shift_id) REFERENCES staff_shifts(id),
        FOREIGN KEY(order_id) REFERENCES orders(id),
        CHECK(total_earning = delivery_fee + tip_amount),
        CHECK(settled = 0 OR settled_at IS NOT NULL)
      )
      `);

    // Add order_details column if it doesn't exist (migration for existing databases)
    try {
      const columns = this.db.prepare("PRAGMA table_info(driver_earnings)").all() as any[];
      const hasOrderDetails = columns.some((col: any) => col.name === 'order_details');
      if (!hasOrderDetails) {
        console.log('[DatabaseService] Adding order_details column to driver_earnings table');
        this.db.exec('ALTER TABLE driver_earnings ADD COLUMN order_details TEXT');
      }
    } catch (err) {
      console.warn('[DatabaseService] Could not check/add order_details column:', err);
    }

    // Add is_transferred column to driver_earnings if it doesn't exist
    try {
      const columns = this.db.prepare("PRAGMA table_info(driver_earnings)").all() as any[];
      const hasIsTransferred = columns.some((col: any) => col.name === 'is_transferred');
      if (!hasIsTransferred) {
        console.log('[DatabaseService] Adding is_transferred column to driver_earnings table');
        this.db.exec('ALTER TABLE driver_earnings ADD COLUMN is_transferred INTEGER DEFAULT 0');
      }
    } catch (err) {
      console.warn('[DatabaseService] Could not check/add is_transferred column:', err);
    }

    // Add transferred_to_cashier_shift_id column to staff_shifts if it doesn't exist
    try {
      const columns = this.db.prepare("PRAGMA table_info(staff_shifts)").all() as any[];
      const hasTransferred = columns.some((col: any) => col.name === 'transferred_to_cashier_shift_id');
      if (!hasTransferred) {
        console.log('[DatabaseService] Adding transferred_to_cashier_shift_id column to staff_shifts table');
        this.db.exec('ALTER TABLE staff_shifts ADD COLUMN transferred_to_cashier_shift_id TEXT');
      }
    } catch (err) {
      console.warn('[DatabaseService] Could not check/add transferred_to_cashier_shift_id column:', err);
    }

    // Add is_transfer_pending column to staff_shifts if it doesn't exist
    try {
      const columns = this.db.prepare("PRAGMA table_info(staff_shifts)").all() as any[];
      const hasTransferPending = columns.some((col: any) => col.name === 'is_transfer_pending');
      if (!hasTransferPending) {
        console.log('[DatabaseService] Adding is_transfer_pending column to staff_shifts table');
        this.db.exec('ALTER TABLE staff_shifts ADD COLUMN is_transfer_pending INTEGER DEFAULT 0');
      }
      // One-off cleanup: normalize any existing '__PENDING__' sentinel values
      const pendingRows = this.db.prepare(`
        SELECT id FROM staff_shifts WHERE transferred_to_cashier_shift_id = '__PENDING__'
      `).all() as any[];
      if (pendingRows.length > 0) {
        console.log(`[DatabaseService] Normalizing ${pendingRows.length} rows with __PENDING__ sentinel to is_transfer_pending=1`);
        this.db.exec(`
          UPDATE staff_shifts
          SET is_transfer_pending = 1, transferred_to_cashier_shift_id = NULL
          WHERE transferred_to_cashier_shift_id = '__PENDING__'
        `);
      }
    } catch (err) {
      console.warn('[DatabaseService] Could not check/add is_transfer_pending column:', err);
    }

    // Add staff_name column to staff_shifts if it doesn't exist
    try {
      const columns = this.db.prepare("PRAGMA table_info(staff_shifts)").all() as any[];
      const hasStaffName = columns.some((col: any) => col.name === 'staff_name');
      if (!hasStaffName) {
        console.log('[DatabaseService] Adding staff_name column to staff_shifts table');
        this.db.exec('ALTER TABLE staff_shifts ADD COLUMN staff_name TEXT');
      }
    } catch (err) {
      console.warn('[DatabaseService] Could not check/add staff_name column:', err);
    }

    // Add is_day_start column to staff_shifts if it doesn't exist
    try {
      const columns = this.db.prepare("PRAGMA table_info(staff_shifts)").all() as any[];
      const hasIsDayStart = columns.some((col: any) => col.name === 'is_day_start');
      if (!hasIsDayStart) {
        console.log('[DatabaseService] Adding is_day_start column to staff_shifts table');
        this.db.exec('ALTER TABLE staff_shifts ADD COLUMN is_day_start INTEGER DEFAULT 0');
      }
    } catch (err) {
      console.warn('[DatabaseService] Could not check/add is_day_start column:', err);
    }

    // Add payment_amount column to staff_shifts if it doesn't exist
    try {
      const columns = this.db.prepare("PRAGMA table_info(staff_shifts)").all() as any[];
      const hasPaymentAmount = columns.some((col: any) => col.name === 'payment_amount');
      if (!hasPaymentAmount) {
        console.log('[DatabaseService] Adding payment_amount column to staff_shifts table');
        this.db.exec('ALTER TABLE staff_shifts ADD COLUMN payment_amount REAL');
      }
    } catch (err) {
      console.warn('[DatabaseService] Could not check/add payment_amount column:', err);
    }

    // Migration: Remove foreign key constraint from staff_shifts table
    // SQLite doesn't support dropping foreign keys, so we need to recreate the table
    try {
      // Check if the table has a foreign key constraint by checking the SQL
      const tableInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='staff_shifts'").get() as any;
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes('FOREIGN KEY')) {
        console.log('[DatabaseService] Migrating staff_shifts table to remove foreign key constraint...');

        // Get existing columns from old table
        const oldColumns = this.db.prepare("PRAGMA table_info(staff_shifts)").all() as any[];
        const oldColumnNames = oldColumns.map((col: any) => col.name);

        // Disable foreign keys temporarily
        this.db.exec('PRAGMA foreign_keys = OFF');

        // Drop new table if it exists from a failed migration
        this.db.exec('DROP TABLE IF EXISTS staff_shifts_new');

        // Create new table without foreign key
        this.db.exec(`
          CREATE TABLE staff_shifts_new (
            id TEXT PRIMARY KEY,
            staff_id TEXT NOT NULL,
            staff_name TEXT,
            branch_id TEXT,
            terminal_id TEXT,
            role_type TEXT NOT NULL CHECK (role_type IN ('cashier', 'manager', 'driver', 'kitchen', 'server')),
            check_in_time TEXT NOT NULL,
            check_out_time TEXT,
            scheduled_start TEXT,
            scheduled_end TEXT,
            opening_cash_amount REAL DEFAULT 0,
            closing_cash_amount REAL,
            expected_cash_amount REAL,
            cash_variance REAL,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'abandoned')),
            total_orders_count INTEGER DEFAULT 0,
            total_sales_amount REAL DEFAULT 0,
            total_cash_sales REAL DEFAULT 0,
            total_card_sales REAL DEFAULT 0,
            notes TEXT,
            closed_by TEXT,
            transferred_to_cashier_shift_id TEXT,
            is_transfer_pending INTEGER DEFAULT 0,
            is_day_start INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `);

        // Build dynamic column list based on what exists in old table
        const newColumns = [
          'id', 'staff_id', 'staff_name', 'branch_id', 'terminal_id', 'role_type',
          'check_in_time', 'check_out_time', 'scheduled_start', 'scheduled_end',
          'opening_cash_amount', 'closing_cash_amount', 'expected_cash_amount', 'cash_variance',
          'status', 'total_orders_count', 'total_sales_amount', 'total_cash_sales', 'total_card_sales',
          'notes', 'closed_by', 'transferred_to_cashier_shift_id', 'is_transfer_pending', 'is_day_start',
          'created_at', 'updated_at'
        ];

        // Build SELECT expressions - use column if exists, otherwise use default
        const selectExprs = newColumns.map(col => {
          if (oldColumnNames.includes(col)) {
            return col;
          } else if (col === 'is_transfer_pending' || col === 'is_day_start') {
            return '0';
          } else if (col === 'staff_name') {
            return 'NULL';
          } else {
            return col; // Will fail if truly required and missing
          }
        });

        // Copy data from old table to new table
        this.db.exec(`
          INSERT INTO staff_shifts_new (${newColumns.join(', ')})
          SELECT ${selectExprs.join(', ')}
          FROM staff_shifts
        `);

        // Drop old table and rename new one
        this.db.exec('DROP TABLE staff_shifts');
        this.db.exec('ALTER TABLE staff_shifts_new RENAME TO staff_shifts');

        console.log('[DatabaseService] Successfully migrated staff_shifts table');
      }
    } catch (err) {
      console.warn('[DatabaseService] Could not migrate staff_shifts table:', err);
      // Clean up failed migration
      try {
        this.db.exec('DROP TABLE IF EXISTS staff_shifts_new');
      } catch (e) {
        // Ignore
      }
    }

    // Staff payments table for tracking wage payments made during cashier shifts
    // Note: staff_shift_id is nullable - links to recipient's shift if available, NULL for off-shift payouts
    createTableSafe('staff_payments', `
      CREATE TABLE IF NOT EXISTS staff_payments (
        id TEXT PRIMARY KEY,
        staff_shift_id TEXT,
        paid_to_staff_id TEXT NOT NULL,
        paid_by_cashier_shift_id TEXT NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0),
        payment_type TEXT NOT NULL CHECK (payment_type IN ('wage', 'tip', 'bonus', 'advance', 'other')),
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (staff_shift_id) REFERENCES staff_shifts(id),
        FOREIGN KEY (paid_by_cashier_shift_id) REFERENCES staff_shifts(id)
      )
    `);

    // Subcategories cache table for offline item name resolution
    createTableSafe('subcategories_cache', `
      CREATE TABLE IF NOT EXISTS subcategories_cache (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_en TEXT,
        name_el TEXT,
        category_id TEXT,
        updated_at TEXT NOT NULL
      )
    `);

    // Add indexes for subcategories_cache
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_subcategories_cache_updated ON subcategories_cache(updated_at);
      CREATE INDEX IF NOT EXISTS idx_subcategories_cache_category ON subcategories_cache(category_id);
    `);

    // Alter orders table to add shift-related columns
    try {
      this.db!.exec('ALTER TABLE orders ADD COLUMN staff_shift_id TEXT');
    } catch (e) {
      // Column might already exist
    }
    try {
      this.db!.exec('ALTER TABLE orders ADD COLUMN staff_id TEXT');
    } catch (e) {
      // Column might already exist
    }
    try {
      this.db!.exec('ALTER TABLE orders ADD COLUMN driver_id TEXT');
    } catch (e) {
      // Column might already exist
    }
    try {
      this.db!.exec('ALTER TABLE orders ADD COLUMN discount_percentage REAL DEFAULT 0');
    } catch (e) {
      // Column might already exist
    }
    try {
      this.db!.exec('ALTER TABLE orders ADD COLUMN discount_amount REAL DEFAULT 0');
    } catch (e) {
      // Column might already exist
    }
    try {
      this.db!.exec('ALTER TABLE orders ADD COLUMN tip_amount REAL DEFAULT 0');
    } catch (e) {
      // Column might already exist
    }

    // Add is_banned column to customers table if it doesn't exist
    try {
      this.db!.exec('ALTER TABLE customers ADD COLUMN is_banned INTEGER DEFAULT 0');
      console.log('✅ Added is_banned column to customers table');
    } catch (e: any) {
      // Column might already exist
      if (!e.message?.includes('duplicate column')) {
        console.warn('Could not add is_banned column:', e.message);
      }
    }

    // Create indexes for performance
    this.createIndexes();

    // Report any table creation errors
    if (errors.length > 0) {
      console.error('Some tables failed to create:', errors);
      throw ErrorFactory.database(
        `Failed to create ${errors.length} table(s)`,
        { errors }
      );
    }
  }

  private createIndexes(): void {
    if (!this.db) return;

    try {
      // Orders indexes
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_orders_sync_status ON orders(sync_status)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_orders_supabase_id ON orders(supabase_id)');

      // Payment transactions indexes
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_id ON payment_transactions(order_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions(status)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_payment_transactions_created_at ON payment_transactions(created_at)');

      // Staff sessions indexes
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_sessions_staff_id ON staff_sessions(staff_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_sessions_active ON staff_sessions(is_active)');

      // Staff table indexes
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_branch ON staff(branch_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_role ON staff(role_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_active ON staff(is_active)');

      // Staff shifts indexes
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_shifts_staff ON staff_shifts(staff_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_shifts_branch ON staff_shifts(branch_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_shifts_status ON staff_shifts(status)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_shifts_check_in ON staff_shifts(check_in_time)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_shifts_role_type ON staff_shifts(role_type)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_shifts_terminal ON staff_shifts(terminal_id)');

      // Sync queue indexes
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_sync_queue_attempts ON sync_queue(attempts)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_sync_queue_created_at ON sync_queue(created_at)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_sync_queue_table_record ON sync_queue(table_name, record_id)');

      // Order retry queue indexes
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_order_retry_queue_attempts ON order_retry_queue(attempts)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_order_retry_queue_created_at ON order_retry_queue(created_at)');

      // Staff payments indexes
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_payments_staff_shift ON staff_payments(staff_shift_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_payments_paid_to ON staff_payments(paid_to_staff_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_payments_paid_by ON staff_payments(paid_by_cashier_shift_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_payments_created_at ON staff_payments(created_at)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_staff_payments_payment_type ON staff_payments(payment_type)');

    } catch (error) {
      console.error('Failed to create indexes:', error);
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; responseTime: number; lastCheck: string; error?: string }> {
    const now = Date.now();
    if (this.healthCheckCache && (now - this.healthCheckCacheTime < 30000)) {
      return this.healthCheckCache;
    }

    const startTime = Date.now();

    try {
      if (!this.db) {
        const result = {
          healthy: false,
          responseTime: 0,
          lastCheck: new Date().toISOString(),
          error: 'Database not initialized'
        };
        this.healthCheckCache = result;
        this.healthCheckCacheTime = now;
        return result;
      }

      // Test multiple operations with timeout
      await withTimeout(
        Promise.all([
          // Simple SELECT
          Promise.resolve(this.db.prepare('SELECT 1').get()),
          // Table existence check
          Promise.resolve(this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orders'`).get()),
          // Write test (to temp table)
          Promise.resolve(this.db.prepare(`CREATE TEMP TABLE IF NOT EXISTS health_check_test(id INTEGER)`).run()),
        ]),
        TIMING.DATABASE_QUERY_TIMEOUT,
        'Health check'
      );

      const responseTime = Date.now() - startTime;
      const result = {
        healthy: true,
        responseTime,
        lastCheck: new Date().toISOString()
      };

      this.healthCheckCache = result;
      this.healthCheckCacheTime = now;
      return result;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('Database health check failed:', error);

      const result = {
        healthy: false,
        responseTime,
        lastCheck: new Date().toISOString(),
        error: errorMsg
      };

      this.healthCheckCache = result;
      this.healthCheckCacheTime = now;
      return result;
    }
  }

  async analyze(): Promise<void> {
    if (!this.db) return;
    try {
      this.db.pragma('optimize');
    } catch (e) {
      console.warn('Database optimization failed:', e);
    }
  }

  async getStats(): Promise<{
    orders: number;
    transactions: number;
    sessions: number;
    sync_items: number;
    settings: number;
    database_size: string;
  }> {
    if (!this.db) throw new Error('Database not initialized');

    interface CountResult { count: number; }

    const ordersCount = (this.db.prepare('SELECT COUNT(*) as count FROM orders').get() as CountResult).count;
    const transactionsCount = (this.db.prepare('SELECT COUNT(*) as count FROM payment_transactions').get() as CountResult).count;
    const sessionsCount = (this.db.prepare('SELECT COUNT(*) as count FROM staff_sessions').get() as CountResult).count;
    const syncCount = (this.db.prepare('SELECT COUNT(*) as count FROM sync_queue').get() as CountResult).count;
    const settingsCount = (this.db.prepare('SELECT COUNT(*) as count FROM local_settings').get() as CountResult).count;

    const fs = require('fs');
    const stats = fs.statSync(this.dbPath);
    const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);

    return {
      orders: ordersCount,
      transactions: transactionsCount,
      sessions: sessionsCount,
      sync_items: syncCount,
      settings: settingsCount,
      database_size: `${sizeInMB} MB`
    };
  }

  async backup(backupPath: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const fs = require('fs');
    const sourceStream = fs.createReadStream(this.dbPath);
    const destStream = fs.createWriteStream(backupPath);

    return new Promise((resolve, reject) => {
      sourceStream.pipe(destStream);
      destStream.on('finish', resolve);
      destStream.on('error', reject);
    });
  }

  // Get detailed stats including health status
  async getDetailedStats(): Promise<{
    orders: number;
    transactions: number;
    sessions: number;
    sync_items: number;
    settings: number;
    database_size: string;
    health: { healthy: boolean; responseTime: number; lastCheck: string; error?: string };
    lastError: POSError | null;
    dbPath: string;
  }> {
    const basicStats = await this.getStats();
    const health = await this.healthCheck();

    return {
      ...basicStats,
      health,
      lastError: this.lastError,
      dbPath: this.dbPath
    };
  }

  // ============================================================================
  // SUBCATEGORIES CACHE METHODS (for offline item name resolution)
  // ============================================================================

  /**
   * Cache a single subcategory (menu item) for offline name resolution
   */
  cacheSubcategory(id: string, name: string, name_en?: string, name_el?: string, category_id?: string): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO subcategories_cache (id, name, name_en, name_el, category_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, name, name_en || null, name_el || null, category_id || null, new Date().toISOString());
  }

  /**
   * Get a subcategory from the local cache by ID
   */
  getSubcategoryFromCache(id: string): { id: string; name: string; name_en?: string; name_el?: string; category_id?: string } | null {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('SELECT * FROM subcategories_cache WHERE id = ?');
    const row = stmt.get(id) as any;
    return row || null;
  }

  /**
   * Bulk cache subcategories for efficient syncing
   */
  bulkCacheSubcategories(subcategories: Array<{ id: string; name: string; name_en?: string; name_el?: string; category_id?: string }>): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO subcategories_cache (id, name, name_en, name_el, category_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    const insertMany = this.db.transaction((items: typeof subcategories) => {
      for (const item of items) {
        stmt.run(item.id, item.name, item.name_en || null, item.name_el || null, item.category_id || null, now);
      }
    });

    insertMany(subcategories);
    console.log(`[DatabaseService] Cached ${subcategories.length} subcategories`);
  }

  /**
   * Clear old subcategories cache entries (older than specified days)
   */
  clearOldSubcategoriesCache(olderThanDays: number = 30): number {
    if (!this.db) throw new Error('Database not initialized');

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const stmt = this.db.prepare('DELETE FROM subcategories_cache WHERE updated_at < ?');
    const result = stmt.run(cutoffDate.toISOString());
    console.log(`[DatabaseService] Cleared ${result.changes} old subcategories cache entries`);
    return result.changes;
  }

  /**
   * Get all cached subcategories (for debugging/diagnostics)
   */
  getAllCachedSubcategories(): Array<{ id: string; name: string; name_en?: string; name_el?: string; category_id?: string; updated_at: string }> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('SELECT * FROM subcategories_cache ORDER BY updated_at DESC');
    return stmt.all() as any[];
  }

  /**
   * Clear operational data - clears orders, shifts, drawers, expenses, payments, driver_earnings
   * Keeps connection settings, menu data, and customer data intact
   * Use this when you need to clear stuck operational data without losing configuration
   */
  async clearOperationalData(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      console.log('[DatabaseService] Starting operational data clear...');

      // Helper function to safely delete from table
      const safeClearTable = (tableName: string) => {
        try {
          this.db?.prepare(`DELETE FROM ${tableName}`).run();
          console.log(`[DatabaseService] Cleared table: ${tableName}`);
        } catch (e) {
          console.warn(`[DatabaseService] Could not clear table ${tableName} (might not exist):`, (e as Error).message);
        }
      };

      // Clear all orders and related data
      safeClearTable('orders');
      safeClearTable('order_items');
      safeClearTable('order_status_history');
      safeClearTable('order_retry_queue');
      safeClearTable('order_sync_conflicts');

      // Clear all staff shifts and related data
      safeClearTable('staff_shifts');
      safeClearTable('staff_activity_log');
      safeClearTable('staff_sessions');
      safeClearTable('shift_expenses');
      safeClearTable('driver_earnings');
      safeClearTable('staff_payments');

      // Clear cash drawer sessions
      safeClearTable('cash_drawer_sessions');

      // Clear payments
      safeClearTable('payments');
      safeClearTable('payment_transactions');
      safeClearTable('payment_receipts');
      safeClearTable('payment_refunds');

      // Clear sync queue (operational items only)
      safeClearTable('sync_queue');

      // Vacuum database to reclaim space
      try {
        this.db.prepare('VACUUM').run();
        console.log('[DatabaseService] Database vacuumed successfully');
      } catch (e) {
        console.warn('[DatabaseService] Could not vacuum database:', (e as Error).message);
      }

      console.log('[DatabaseService] Operational data clear completed successfully');
    } catch (error) {
      console.error('[DatabaseService] Operational data clear failed:', error);
      throw error;
    }
  }

  /**
   * Factory reset - clears all local cached data when switching to a different terminal/branch
   * Keeps only terminal settings and sync history
   */
  async factoryReset(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      console.log('[DatabaseService] Starting factory reset...');

      // Helper function to safely delete from table
      const safeClearTable = (tableName: string) => {
        try {
          this.db?.prepare(`DELETE FROM ${tableName}`).run();
          console.log(`[DatabaseService] Cleared table: ${tableName}`);
        } catch (e) {
          console.warn(`[DatabaseService] Could not clear table ${tableName} (might not exist):`, (e as Error).message);
        }
      };

      // Clear all orders and related data
      safeClearTable('orders');
      safeClearTable('order_items');
      safeClearTable('order_status_history');
      safeClearTable('order_retry_queue');
      safeClearTable('order_sync_conflicts');

      // Clear all customers and related data
      safeClearTable('customers');
      safeClearTable('customer_addresses');

      // Clear all staff and shifts
      safeClearTable('staff_shifts');
      safeClearTable('staff_activity_log');
      safeClearTable('staff_sessions');
      safeClearTable('shift_expenses');
      safeClearTable('driver_earnings');

      // Clear all menu and inventory data
      safeClearTable('menu_items');
      safeClearTable('menu_categories');
      safeClearTable('ingredients');
      safeClearTable('subcategories_cache');

      // Clear sync queue
      safeClearTable('sync_queue');

      // Clear payments
      safeClearTable('payments');
      safeClearTable('payment_transactions');
      safeClearTable('payment_receipts');
      safeClearTable('payment_refunds');

      // Clear local config cache - CRITICAL for removing old terminal ID
      safeClearTable('pos_local_config');
      safeClearTable('local_settings');
      safeClearTable('terminal_settings');

      // Clear cash drawer sessions
      safeClearTable('cash_drawer_sessions');

      // Reset sync timestamps to force full refresh
      safeClearTable('pos_settings_sync_history');

      // Clear error logs
      safeClearTable('error_logs');

      // Vacuum database to reclaim space
      try {
        this.db.prepare('VACUUM').run();
        console.log('[DatabaseService] Database vacuumed successfully');
      } catch (e) {
        console.warn('[DatabaseService] Could not vacuum database:', (e as Error).message);
      }

      console.log('[DatabaseService] Factory reset completed successfully');
    } catch (error) {
      console.error('[DatabaseService] Factory reset failed:', error);
      throw error;
    }
  }

  close(): void {
    if (this.db) {
      console.log('[DatabaseService] Closing database connection');
      this.db.close();
      this.db = null;
    }
  }
}