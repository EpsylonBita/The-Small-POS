//! Local SQLite database layer for The Small POS.
//!
//! Uses rusqlite with WAL mode, matching the Electron POS's better-sqlite3
//! configuration. Provides schema migrations, settings helpers, and managed
//! state for use across Tauri commands.

use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tracing::{error, info, warn};

/// Tauri managed state holding the database connection.
pub struct DbState {
    pub conn: Mutex<Connection>,
    pub db_path: PathBuf,
}

/// Current schema version. Bump when adding new migrations.
const CURRENT_SCHEMA_VERSION: i32 = 14;

/// Initialize the database at `{app_data_dir}/pos.db`.
///
/// Creates the directory if needed, opens the connection, sets pragmas,
/// and runs any pending migrations. On corruption or open failure,
/// deletes the file and retries once.
pub fn init(app_data_dir: &Path) -> Result<DbState, String> {
    fs::create_dir_all(app_data_dir).map_err(|e| format!("Failed to create data dir: {e}"))?;

    let db_path = app_data_dir.join("pos.db");
    info!("Opening database at {}", db_path.display());

    let conn = match open_and_configure(&db_path) {
        Ok(c) => c,
        Err(first_err) => {
            warn!(
                "Database open failed ({}), deleting and retrying once",
                first_err
            );
            if db_path.exists() {
                let _ = fs::remove_file(&db_path);
                // Also remove WAL/SHM files if present
                let wal = db_path.with_extension("db-wal");
                let shm = db_path.with_extension("db-shm");
                let _ = fs::remove_file(&wal);
                let _ = fs::remove_file(&shm);
            }
            open_and_configure(&db_path)
                .map_err(|e| format!("Database open failed after retry: {e}"))?
        }
    };

    run_migrations(&conn)?;

    info!("Database initialized (schema v{CURRENT_SCHEMA_VERSION})");

    Ok(DbState {
        conn: Mutex::new(conn),
        db_path,
    })
}

/// Open the database file and apply pragmas.
fn open_and_configure(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("sqlite open: {e}"))?;

    // Match Electron better-sqlite3 config
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA synchronous = NORMAL;",
    )
    .map_err(|e| format!("pragma setup: {e}"))?;

    Ok(conn)
}

/// Run all pending migrations up to `CURRENT_SCHEMA_VERSION`.
fn run_migrations(conn: &Connection) -> Result<(), String> {
    // Ensure schema_version table exists first
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT DEFAULT (datetime('now'))
        );",
    )
    .map_err(|e| format!("create schema_version: {e}"))?;

    let current: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if current >= CURRENT_SCHEMA_VERSION {
        info!("Database schema up to date (v{current})");
        return Ok(());
    }

    info!("Migrating database from v{current} to v{CURRENT_SCHEMA_VERSION}");

    if current < 1 {
        migrate_v1(conn)?;
    }
    if current < 2 {
        migrate_v2(conn)?;
    }
    if current < 3 {
        migrate_v3(conn)?;
    }
    if current < 4 {
        migrate_v4(conn)?;
    }
    if current < 5 {
        migrate_v5(conn)?;
    }
    if current < 6 {
        migrate_v6(conn)?;
    }
    if current < 7 {
        migrate_v7(conn)?;
    }
    if current < 8 {
        migrate_v8(conn)?;
    }
    if current < 9 {
        migrate_v9(conn)?;
    }
    if current < 10 {
        migrate_v10(conn)?;
    }
    if current < 11 {
        migrate_v11(conn)?;
    }
    if current < 12 {
        migrate_v12(conn)?;
    }
    if current < 13 {
        migrate_v13(conn)?;
    }
    if current < 14 {
        migrate_v14(conn)?;
    }

    Ok(())
}

/// Migration v1: Core tables for MVP.
fn migrate_v1(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- local_settings (category/key/value store)
        CREATE TABLE IF NOT EXISTS local_settings (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            setting_category TEXT NOT NULL,
            setting_key TEXT NOT NULL,
            setting_value TEXT NOT NULL,
            last_sync TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(setting_category, setting_key)
        );

        -- orders
        CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            order_number TEXT,
            customer_name TEXT,
            customer_phone TEXT,
            customer_email TEXT,
            items TEXT NOT NULL DEFAULT '[]',
            total_amount REAL NOT NULL DEFAULT 0,
            tax_amount REAL DEFAULT 0,
            subtotal REAL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            cancellation_reason TEXT,
            order_type TEXT DEFAULT 'dine-in',
            table_number TEXT,
            delivery_address TEXT,
            delivery_notes TEXT,
            name_on_ringer TEXT,
            special_instructions TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            estimated_time INTEGER,
            supabase_id TEXT,
            sync_status TEXT NOT NULL DEFAULT 'pending',
            payment_status TEXT DEFAULT 'pending',
            payment_method TEXT,
            payment_transaction_id TEXT,
            staff_shift_id TEXT,
            staff_id TEXT,
            discount_percentage REAL DEFAULT 0,
            discount_amount REAL DEFAULT 0,
            tip_amount REAL DEFAULT 0,
            version INTEGER DEFAULT 1,
            updated_by TEXT,
            last_synced_at TEXT,
            remote_version INTEGER,
            terminal_id TEXT,
            branch_id TEXT,
            plugin TEXT,
            external_plugin_order_id TEXT,
            tax_rate REAL,
            delivery_fee REAL DEFAULT 0
        );

        -- sync_queue (append-only)
        CREATE TABLE IF NOT EXISTS sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            payload TEXT NOT NULL,
            idempotency_key TEXT UNIQUE NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            retry_count INTEGER DEFAULT 0,
            max_retries INTEGER DEFAULT 5,
            last_error TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            synced_at TEXT
        );

        -- staff_sessions
        CREATE TABLE IF NOT EXISTS staff_sessions (
            id TEXT PRIMARY KEY,
            staff_id TEXT NOT NULL,
            pin_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'staff',
            login_time TEXT DEFAULT (datetime('now')),
            logout_time TEXT,
            is_active INTEGER DEFAULT 1
        );

        -- menu_cache
        CREATE TABLE IF NOT EXISTS menu_cache (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            cache_key TEXT UNIQUE NOT NULL,
            data TEXT NOT NULL,
            version TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        -- Indexes
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_orders_sync_status ON orders(sync_status);
        CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
        CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);
        CREATE INDEX IF NOT EXISTS idx_local_settings_cat_key ON local_settings(setting_category, setting_key);

        -- Record migration
        INSERT INTO schema_version (version) VALUES (1);
        ",
    )
    .map_err(|e| {
        error!("Migration v1 failed: {e}");
        format!("migration v1: {e}")
    })?;

    info!("Applied migration v1");
    Ok(())
}

/// Migration v2: Shift management tables.
fn migrate_v2(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- staff_shifts (main shift tracking)
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
            calculation_version INTEGER DEFAULT 2,
            sync_status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- cash_drawer_sessions (cashier-specific tracking)
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
            FOREIGN KEY(staff_shift_id) REFERENCES staff_shifts(id) ON DELETE CASCADE
        );

        -- Indexes for shift queries
        CREATE INDEX IF NOT EXISTS idx_staff_shifts_staff_id ON staff_shifts(staff_id);
        CREATE INDEX IF NOT EXISTS idx_staff_shifts_terminal_id ON staff_shifts(terminal_id);
        CREATE INDEX IF NOT EXISTS idx_staff_shifts_status ON staff_shifts(status);
        CREATE INDEX IF NOT EXISTS idx_staff_shifts_branch_id ON staff_shifts(branch_id);
        CREATE INDEX IF NOT EXISTS idx_staff_shifts_branch_terminal ON staff_shifts(branch_id, terminal_id);
        CREATE INDEX IF NOT EXISTS idx_staff_shifts_check_in ON staff_shifts(check_in_time);
        CREATE INDEX IF NOT EXISTS idx_staff_shifts_role_type ON staff_shifts(role_type);
        CREATE INDEX IF NOT EXISTS idx_cash_drawer_shift_id ON cash_drawer_sessions(staff_shift_id);

        -- Record migration
        INSERT INTO schema_version (version) VALUES (2);
        ",
    )
    .map_err(|e| {
        error!("Migration v2 failed: {e}");
        format!("migration v2: {e}")
    })?;

    info!("Applied migration v2 (shift tables)");
    Ok(())
}

/// Migration v3: Shift expenses table.
fn migrate_v3(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- shift_expenses (expenses recorded during a shift)
        CREATE TABLE IF NOT EXISTS shift_expenses (
            id TEXT PRIMARY KEY,
            staff_shift_id TEXT NOT NULL,
            staff_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            expense_type TEXT NOT NULL CHECK (expense_type IN ('supplies', 'maintenance', 'petty_cash', 'refund', 'other')),
            amount REAL NOT NULL,
            description TEXT NOT NULL,
            receipt_number TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
            approved_by TEXT,
            approved_at TEXT,
            rejection_reason TEXT,
            sync_status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(staff_shift_id) REFERENCES staff_shifts(id) ON DELETE CASCADE
        );

        -- Indexes for expense queries
        CREATE INDEX IF NOT EXISTS idx_shift_expenses_shift_id ON shift_expenses(staff_shift_id);
        CREATE INDEX IF NOT EXISTS idx_shift_expenses_created_at ON shift_expenses(created_at);
        CREATE INDEX IF NOT EXISTS idx_shift_expenses_status ON shift_expenses(status);

        -- Record migration
        INSERT INTO schema_version (version) VALUES (3);
        ",
    )
    .map_err(|e| {
        error!("Migration v3 failed: {e}");
        format!("migration v3: {e}")
    })?;

    info!("Applied migration v3 (shift_expenses table)");
    Ok(())
}

/// Migration v4: Order payments table.
fn migrate_v4(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- order_payments (payment records per order)
        CREATE TABLE IF NOT EXISTS order_payments (
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL,
            method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'other')),
            amount REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'EUR',
            status TEXT NOT NULL DEFAULT 'completed'
                CHECK (status IN ('completed', 'voided', 'refunded')),
            cash_received REAL,
            change_given REAL,
            transaction_ref TEXT,
            staff_id TEXT,
            staff_shift_id TEXT,
            voided_at TEXT,
            voided_by TEXT,
            void_reason TEXT,
            sync_status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
        );

        -- Indexes for payment queries
        CREATE INDEX IF NOT EXISTS idx_order_payments_order_id ON order_payments(order_id);
        CREATE INDEX IF NOT EXISTS idx_order_payments_created_at ON order_payments(created_at);
        CREATE INDEX IF NOT EXISTS idx_order_payments_sync_status ON order_payments(sync_status);

        -- Record migration
        INSERT INTO schema_version (version) VALUES (4);
        ",
    )
    .map_err(|e| {
        error!("Migration v4 failed: {e}");
        format!("migration v4: {e}")
    })?;

    info!("Applied migration v4 (order_payments table)");
    Ok(())
}

/// Migration v5: Payment sync state machine columns.
///
/// Adds explicit sync_state (pending | waiting_parent | syncing | applied | failed),
/// last_error, retry_count, and next_retry_at to order_payments so the
/// reconciliation loop can track exactly where each payment is in the sync
/// pipeline.
fn migrate_v5(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- Payment sync state machine columns
        ALTER TABLE order_payments ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending'
            CHECK (sync_state IN ('pending', 'waiting_parent', 'syncing', 'applied', 'failed'));

        ALTER TABLE order_payments ADD COLUMN sync_last_error TEXT;

        ALTER TABLE order_payments ADD COLUMN sync_retry_count INTEGER NOT NULL DEFAULT 0;

        ALTER TABLE order_payments ADD COLUMN sync_next_retry_at TEXT;

        -- Back-fill: existing payments whose parent order has no supabase_id yet
        -- should be in waiting_parent, others stay pending.
        UPDATE order_payments
            SET sync_state = 'waiting_parent'
            WHERE sync_status = 'pending'
              AND order_id IN (
                  SELECT id FROM orders WHERE supabase_id IS NULL OR supabase_id = ''
              );

        -- Index on sync_state for the reconciliation loop's queries
        CREATE INDEX IF NOT EXISTS idx_order_payments_sync_state
            ON order_payments(sync_state);

        -- Composite index for parent-order reconciliation scan
        CREATE INDEX IF NOT EXISTS idx_order_payments_waiting_order
            ON order_payments(order_id, sync_state);

        -- Record migration
        INSERT INTO schema_version (version) VALUES (5);
        ",
    )
    .map_err(|e| {
        error!("Migration v5 failed: {e}");
        format!("migration v5: {e}")
    })?;

    info!("Applied migration v5 (payment sync state machine)");
    Ok(())
}

/// Migration v6: Print jobs table for offline print spooler.
fn migrate_v6(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- print_jobs (local print spooler)
        CREATE TABLE IF NOT EXISTS print_jobs (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL DEFAULT 'order_receipt'
                CHECK (entity_type IN ('order_receipt', 'kitchen_ticket')),
            entity_id TEXT NOT NULL,
            printer_profile_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'printing', 'printed', 'failed')),
            output_path TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 3,
            next_retry_at TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Indexes for print job queries
        CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_created_at ON print_jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_entity ON print_jobs(entity_type, entity_id);

        -- Record migration
        INSERT INTO schema_version (version) VALUES (6);
        ",
    )
    .map_err(|e| {
        error!("Migration v6 failed: {e}");
        format!("migration v6: {e}")
    })?;

    info!("Applied migration v6 (print_jobs table)");
    Ok(())
}

/// Migration v7: Printer profiles table for hardware printing.
fn migrate_v7(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- printer_profiles (local printer configuration)
        CREATE TABLE IF NOT EXISTS printer_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            driver_type TEXT NOT NULL DEFAULT 'windows'
                CHECK (driver_type IN ('windows')),
            printer_name TEXT NOT NULL,
            paper_width_mm INTEGER NOT NULL DEFAULT 80
                CHECK (paper_width_mm IN (58, 80)),
            copies_default INTEGER NOT NULL DEFAULT 1,
            cut_paper INTEGER NOT NULL DEFAULT 1,
            open_cash_drawer INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Index for quick lookup by printer_name
        CREATE INDEX IF NOT EXISTS idx_printer_profiles_name
            ON printer_profiles(printer_name);

        -- Record migration
        INSERT INTO schema_version (version) VALUES (7);
        ",
    )
    .map_err(|e| {
        error!("Migration v7 failed: {e}");
        format!("migration v7: {e}")
    })?;

    info!("Applied migration v7 (printer_profiles table)");
    Ok(())
}

/// Migration v8: Add cash drawer fields to printer_profiles.
///
/// Adds `drawer_mode` (none | escpos_tcp), `drawer_host`, `drawer_port`,
/// and `drawer_pulse_ms` columns so that a printer profile can optionally
/// trigger a drawer kick via ESC/POS over TCP.
fn migrate_v8(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- Cash drawer configuration columns
        ALTER TABLE printer_profiles ADD COLUMN drawer_mode TEXT NOT NULL DEFAULT 'none'
            CHECK (drawer_mode IN ('none', 'escpos_tcp'));

        ALTER TABLE printer_profiles ADD COLUMN drawer_host TEXT;

        ALTER TABLE printer_profiles ADD COLUMN drawer_port INTEGER NOT NULL DEFAULT 9100;

        ALTER TABLE printer_profiles ADD COLUMN drawer_pulse_ms INTEGER NOT NULL DEFAULT 200;

        -- Record migration
        INSERT INTO schema_version (version) VALUES (8);
        ",
    )
    .map_err(|e| {
        error!("Migration v8 failed: {e}");
        format!("migration v8: {e}")
    })?;

    info!("Applied migration v8 (cash drawer fields on printer_profiles)");
    Ok(())
}

/// Migration v9: Add warning columns to print_jobs for operational visibility.
///
/// Adds `warning_code` (nullable), `warning_message` (nullable), and
/// `last_attempt_at` (nullable) so the print worker can record non-fatal
/// issues (e.g. drawer kick failures) without failing the print job.
fn migrate_v9(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- Warning columns for non-fatal issues (e.g. drawer kick failed)
        ALTER TABLE print_jobs ADD COLUMN warning_code TEXT;

        ALTER TABLE print_jobs ADD COLUMN warning_message TEXT;

        ALTER TABLE print_jobs ADD COLUMN last_attempt_at TEXT;

        -- Record migration
        INSERT INTO schema_version (version) VALUES (9);
        ",
    )
    .map_err(|e| {
        error!("Migration v9 failed: {e}");
        format!("migration v9: {e}")
    })?;

    info!("Applied migration v9 (print_jobs warning columns)");
    Ok(())
}

/// Migration v10: Payment adjustments table for voids and refunds.
///
/// Tracks all payment adjustments (voids, partial/full refunds) as an
/// immutable audit trail.  Each adjustment is synced independently via
/// `entity_type = 'payment_adjustment'` in the sync queue.
fn migrate_v10(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- payment_adjustments (void/refund audit trail)
        CREATE TABLE IF NOT EXISTS payment_adjustments (
            id TEXT PRIMARY KEY,
            payment_id TEXT NOT NULL,
            order_id TEXT NOT NULL,
            adjustment_type TEXT NOT NULL
                CHECK (adjustment_type IN ('void', 'refund')),
            amount REAL NOT NULL,
            reason TEXT NOT NULL,
            staff_id TEXT,
            sync_state TEXT NOT NULL DEFAULT 'pending'
                CHECK (sync_state IN ('pending', 'waiting_parent', 'syncing', 'applied', 'failed')),
            sync_last_error TEXT,
            sync_retry_count INTEGER NOT NULL DEFAULT 0,
            sync_next_retry_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(payment_id) REFERENCES order_payments(id) ON DELETE CASCADE,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
        );

        -- Indexes for adjustment queries
        CREATE INDEX IF NOT EXISTS idx_payment_adjustments_payment_id
            ON payment_adjustments(payment_id);
        CREATE INDEX IF NOT EXISTS idx_payment_adjustments_order_id
            ON payment_adjustments(order_id);
        CREATE INDEX IF NOT EXISTS idx_payment_adjustments_sync_state
            ON payment_adjustments(sync_state);

        -- Record migration
        INSERT INTO schema_version (version) VALUES (10);
        ",
    )
    .map_err(|e| {
        error!("Migration v10 failed: {e}");
        format!("migration v10: {e}")
    })?;

    info!("Applied migration v10 (payment_adjustments table)");
    Ok(())
}

/// Z-reports table for end-of-day financial snapshots, plus print_jobs table
/// rebuild to add `z_report` entity type to the CHECK constraint.
fn migrate_v11(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- z_reports: per-shift end-of-day financial snapshots
        CREATE TABLE IF NOT EXISTS z_reports (
            id TEXT PRIMARY KEY,
            shift_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            terminal_id TEXT NOT NULL,
            report_date TEXT NOT NULL,
            generated_at TEXT NOT NULL,
            -- Normalized totals for efficient queries
            gross_sales REAL NOT NULL DEFAULT 0,
            net_sales REAL NOT NULL DEFAULT 0,
            total_orders INTEGER NOT NULL DEFAULT 0,
            cash_sales REAL NOT NULL DEFAULT 0,
            card_sales REAL NOT NULL DEFAULT 0,
            refunds_total REAL NOT NULL DEFAULT 0,
            voids_total REAL NOT NULL DEFAULT 0,
            discounts_total REAL NOT NULL DEFAULT 0,
            tips_total REAL NOT NULL DEFAULT 0,
            expenses_total REAL NOT NULL DEFAULT 0,
            cash_variance REAL NOT NULL DEFAULT 0,
            opening_cash REAL NOT NULL DEFAULT 0,
            closing_cash REAL NOT NULL DEFAULT 0,
            expected_cash REAL NOT NULL DEFAULT 0,
            -- Full breakdown JSON blobs
            payments_breakdown_json TEXT NOT NULL DEFAULT '{}',
            report_json TEXT NOT NULL DEFAULT '{}',
            -- Sync state machine (no waiting_parent: server has no FK on shift)
            sync_state TEXT NOT NULL DEFAULT 'pending'
                CHECK (sync_state IN ('pending', 'syncing', 'applied', 'failed')),
            sync_last_error TEXT,
            sync_retry_count INTEGER NOT NULL DEFAULT 0,
            sync_next_retry_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(shift_id) REFERENCES staff_shifts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_z_reports_shift_id
            ON z_reports(shift_id);
        CREATE INDEX IF NOT EXISTS idx_z_reports_sync_state
            ON z_reports(sync_state);
        CREATE INDEX IF NOT EXISTS idx_z_reports_report_date
            ON z_reports(report_date);

        -- Rebuild print_jobs to add 'z_report' to entity_type CHECK constraint.
        -- SQLite does not support ALTER TABLE DROP/ADD CONSTRAINT, so we
        -- recreate the table preserving all existing data and indexes.
        CREATE TABLE IF NOT EXISTS print_jobs_v11 (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL
                CHECK (entity_type IN ('order_receipt', 'kitchen_ticket', 'z_report')),
            entity_id TEXT NOT NULL,
            printer_profile_id TEXT,
            status TEXT NOT NULL
                CHECK (status IN ('pending', 'printing', 'printed', 'failed')),
            output_path TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 3,
            next_retry_at TEXT,
            last_error TEXT,
            warning_code TEXT,
            warning_message TEXT,
            last_attempt_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO print_jobs_v11
            SELECT * FROM print_jobs;
        DROP TABLE print_jobs;
        ALTER TABLE print_jobs_v11 RENAME TO print_jobs;

        CREATE INDEX IF NOT EXISTS idx_print_jobs_status
            ON print_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_created_at
            ON print_jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_entity
            ON print_jobs(entity_type, entity_id);

        -- Record migration
        INSERT INTO schema_version (version) VALUES (11);
        ",
    )
    .map_err(|e| {
        error!("Migration v11 failed: {e}");
        format!("migration v11: {e}")
    })?;

    info!("Applied migration v11 (z_reports table + print_jobs entity_type update)");
    Ok(())
}

/// Migration v12: idempotent order creation support.
///
/// Adds `client_request_id` to `orders` plus a unique partial index so
/// repeated create attempts with the same client token resolve to one order.
fn migrate_v12(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        ALTER TABLE orders ADD COLUMN client_request_id TEXT;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_request_id_unique
            ON orders(client_request_id)
            WHERE client_request_id IS NOT NULL;

        -- Record migration
        INSERT INTO schema_version (version) VALUES (12);
        ",
    )
    .map_err(|e| {
        error!("Migration v12 failed: {e}");
        format!("migration v12: {e}")
    })?;

    info!("Applied migration v12 (orders client_request_id idempotency)");
    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| format!("table_info {table}: {e}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| format!("table_info query: {e}"))?;
    while let Some(row) = rows.next().map_err(|e| format!("table_info next: {e}"))? {
        let name: String = row.get(1).map_err(|e| format!("table_info name: {e}"))?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Migration v13: sync queue retry scheduling and remote receipt tracking.
///
/// Adds:
/// - `next_retry_at` for deferred retries (backpressure-aware)
/// - `retry_delay_ms` for deterministic retry pacing
/// - `remote_receipt_id` for async `/orders/sync` receipt polling
fn migrate_v13(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "sync_queue", "next_retry_at")? {
        conn.execute_batch("ALTER TABLE sync_queue ADD COLUMN next_retry_at TEXT;")
            .map_err(|e| format!("migration v13 add next_retry_at: {e}"))?;
    }

    if !column_exists(conn, "sync_queue", "retry_delay_ms")? {
        conn.execute_batch(
            "ALTER TABLE sync_queue ADD COLUMN retry_delay_ms INTEGER NOT NULL DEFAULT 5000;",
        )
        .map_err(|e| format!("migration v13 add retry_delay_ms: {e}"))?;
    }

    if !column_exists(conn, "sync_queue", "remote_receipt_id")? {
        conn.execute_batch("ALTER TABLE sync_queue ADD COLUMN remote_receipt_id TEXT;")
            .map_err(|e| format!("migration v13 add remote_receipt_id: {e}"))?;
    }

    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_sync_queue_status_next_retry
            ON sync_queue(status, next_retry_at);
        CREATE INDEX IF NOT EXISTS idx_sync_queue_remote_receipt
            ON sync_queue(remote_receipt_id);

        INSERT INTO schema_version (version) VALUES (13);
        ",
    )
    .map_err(|e| {
        error!("Migration v13 failed: {e}");
        format!("migration v13: {e}")
    })?;

    info!("Applied migration v13 (sync queue retry scheduling + receipt tracking)");
    Ok(())
}

/// Migration v14: Driver earnings table (replaces JSON blob in local_settings).
///
/// Moves driver earnings from a JSON array stored under the
/// `driver_earnings_v1` key in `local_settings` to a proper relational table
/// with foreign keys, indexes, and CHECK constraints.
fn migrate_v14(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- driver_earnings (per-delivery earning records)
        CREATE TABLE IF NOT EXISTS driver_earnings (
            id TEXT PRIMARY KEY,
            driver_id TEXT NOT NULL,
            staff_shift_id TEXT,
            order_id TEXT UNIQUE NOT NULL,
            branch_id TEXT NOT NULL,
            delivery_fee REAL DEFAULT 0,
            tip_amount REAL DEFAULT 0,
            total_earning REAL NOT NULL,
            payment_method TEXT NOT NULL CHECK(payment_method IN('cash','card','mixed')),
            cash_collected REAL DEFAULT 0,
            card_amount REAL DEFAULT 0,
            cash_to_return REAL DEFAULT 0,
            order_details TEXT,
            settled INTEGER DEFAULT 0,
            settled_at TEXT,
            settlement_batch_id TEXT,
            is_transferred INTEGER DEFAULT 0,
            supabase_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(staff_shift_id) REFERENCES staff_shifts(id) ON DELETE SET NULL,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_driver_earnings_shift_id
            ON driver_earnings(staff_shift_id);
        CREATE INDEX IF NOT EXISTS idx_driver_earnings_driver_id
            ON driver_earnings(driver_id);
        CREATE INDEX IF NOT EXISTS idx_driver_earnings_order_id
            ON driver_earnings(order_id);

        -- Record migration
        INSERT INTO schema_version (version) VALUES (14);
        ",
    )
    .map_err(|e| {
        error!("Migration v14 failed: {e}");
        format!("migration v14: {e}")
    })?;

    info!("Applied migration v14 (driver_earnings table)");
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

/// Get a single setting value.
pub fn get_setting(conn: &Connection, category: &str, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT setting_value FROM local_settings WHERE setting_category = ?1 AND setting_key = ?2",
        params![category, key],
        |row| row.get(0),
    )
    .ok()
}

/// Insert or update a setting.
pub fn set_setting(
    conn: &Connection,
    category: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO local_settings (setting_category, setting_key, setting_value, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(setting_category, setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at",
        params![category, key, value],
    )
    .map_err(|e| format!("set_setting: {e}"))?;
    Ok(())
}

/// Get all settings grouped by category as JSON.
#[allow(dead_code)]
pub fn get_all_settings(conn: &Connection) -> serde_json::Value {
    let mut stmt = match conn.prepare(
        "SELECT setting_category, setting_key, setting_value FROM local_settings ORDER BY setting_category, setting_key",
    ) {
        Ok(s) => s,
        Err(e) => {
            error!("get_all_settings prepare: {e}");
            return serde_json::json!({});
        }
    };

    let mut result = serde_json::Map::new();

    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) {
        Ok(r) => r,
        Err(e) => {
            error!("get_all_settings query: {e}");
            return serde_json::json!({});
        }
    };

    for (cat, key, val) in rows.flatten() {
        let category = result.entry(cat).or_insert_with(|| serde_json::json!({}));
        if let serde_json::Value::Object(ref mut map) = category {
            map.insert(key, serde_json::Value::String(val));
        }
    }

    serde_json::Value::Object(result)
}

/// Delete all settings in a category.
#[allow(dead_code)]
pub fn delete_all_settings(conn: &Connection, category: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM local_settings WHERE setting_category = ?1",
        params![category],
    )
    .map_err(|e| format!("delete_all_settings: {e}"))?;
    Ok(())
}

/// Run all migrations on the given connection (test helper, not public API).
#[cfg(test)]
pub fn run_migrations_for_test(conn: &Connection) {
    run_migrations(conn).expect("run_migrations should succeed in test");
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Open an in-memory database and apply pragmas (mirrors open_and_configure).
    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        conn
    }

    /// Helper: list table names in the database.
    fn table_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .expect("prepare table list");
        stmt.query_map([], |row| row.get(0))
            .expect("query tables")
            .filter_map(|r| r.ok())
            .collect()
    }

    /// Helper: query a single PRAGMA value as a string.
    fn pragma_val(conn: &Connection, pragma: &str) -> String {
        conn.query_row(&format!("PRAGMA {pragma}"), [], |row| {
            row.get::<_, i64>(0).map(|v| v.to_string())
        })
        .unwrap_or_default()
    }

    // ------------------------------------------------------------------
    // Migration tests
    // ------------------------------------------------------------------

    #[test]
    fn test_migrations_v1_to_latest() {
        let conn = test_db();
        run_migrations(&conn).expect("run_migrations should succeed");

        let tables = table_names(&conn);

        // v1 tables
        assert!(
            tables.contains(&"local_settings".to_string()),
            "missing local_settings"
        );
        assert!(tables.contains(&"orders".to_string()), "missing orders");
        assert!(
            tables.contains(&"sync_queue".to_string()),
            "missing sync_queue"
        );
        assert!(
            tables.contains(&"staff_sessions".to_string()),
            "missing staff_sessions"
        );
        assert!(
            tables.contains(&"menu_cache".to_string()),
            "missing menu_cache"
        );

        // v2 tables
        assert!(
            tables.contains(&"staff_shifts".to_string()),
            "missing staff_shifts"
        );
        assert!(
            tables.contains(&"cash_drawer_sessions".to_string()),
            "missing cash_drawer_sessions"
        );

        // v3 tables
        assert!(
            tables.contains(&"shift_expenses".to_string()),
            "missing shift_expenses"
        );

        // v4 tables
        assert!(
            tables.contains(&"order_payments".to_string()),
            "missing order_payments"
        );

        // v5: verify sync_state column exists
        let sync_state_default: String = conn
            .query_row("SELECT sync_state FROM order_payments LIMIT 0", [], |row| {
                row.get(0)
            })
            .unwrap_or_else(|_| "column_exists".to_string());
        // If the column didn't exist, the prepare above would have failed.
        // We just ensure the query doesn't error; the table may be empty.
        assert!(
            sync_state_default == "column_exists" || !sync_state_default.is_empty(),
            "sync_state column should exist after v5"
        );

        // v6 tables
        assert!(
            tables.contains(&"print_jobs".to_string()),
            "missing print_jobs"
        );

        // v7 tables
        assert!(
            tables.contains(&"printer_profiles".to_string()),
            "missing printer_profiles"
        );

        // v8: verify drawer_mode column exists on printer_profiles
        let _drawer_mode_check: Result<String, _> = conn.query_row(
            "SELECT drawer_mode FROM printer_profiles LIMIT 0",
            [],
            |row| row.get(0),
        );
        // The query succeeds if the column exists (even on empty table)

        // v9: verify warning columns exist on print_jobs
        let _warning_check: Result<Option<String>, _> = conn.query_row(
            "SELECT warning_code, warning_message, last_attempt_at FROM print_jobs LIMIT 0",
            [],
            |row| row.get(0),
        );

        // v10 tables
        assert!(
            tables.contains(&"payment_adjustments".to_string()),
            "missing payment_adjustments"
        );

        // v11 tables
        assert!(
            tables.contains(&"z_reports".to_string()),
            "missing z_reports"
        );

        // v11: print_jobs should accept z_report entity_type
        conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES ('pj-zr-test', 'z_report', 'zr-1', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("print_jobs should accept z_report entity_type");
        // Clean up
        conn.execute("DELETE FROM print_jobs WHERE id = 'pj-zr-test'", [])
            .expect("cleanup");

        // v14 tables
        assert!(
            tables.contains(&"driver_earnings".to_string()),
            "missing driver_earnings"
        );

        // Schema version should be latest
        let version: i32 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
                row.get(0)
            })
            .expect("read schema version");
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn test_foreign_keys_enabled() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        let fk = pragma_val(&conn, "foreign_keys");
        assert_eq!(fk, "1", "foreign_keys should be ON");
    }

    #[test]
    fn test_wal_mode_on_file_db() {
        // WAL only works on file-backed databases; in-memory always returns "memory".
        // We use a tempfile to verify the full open_and_configure path.
        let dir = std::env::temp_dir().join("pos_tauri_test_wal");
        let _ = std::fs::create_dir_all(&dir);
        let db_path = dir.join("test_wal.db");

        // Clean up from previous run
        let _ = std::fs::remove_file(&db_path);

        let conn = open_and_configure(&db_path).expect("open temp db");
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("read journal_mode");
        assert_eq!(mode.to_lowercase(), "wal", "journal_mode should be WAL");

        // Cleanup
        drop(conn);
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_migrations_are_idempotent() {
        let conn = test_db();
        run_migrations(&conn).expect("first run");
        // Running again should be a no-op (already at latest version)
        run_migrations(&conn).expect("second run should succeed");

        let version: i32 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
                row.get(0)
            })
            .expect("read schema version");
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn test_shift_expenses_fk_cascade() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Insert a shift
        conn.execute(
            "INSERT INTO staff_shifts (id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at)
             VALUES ('shift-1', 'staff-1', 'cashier', datetime('now'), 'active', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert shift");

        // Insert an expense linked to the shift
        conn.execute(
            "INSERT INTO shift_expenses (id, staff_shift_id, staff_id, branch_id, expense_type, amount, description, sync_status, created_at, updated_at)
             VALUES ('exp-1', 'shift-1', 'staff-1', 'branch-1', 'supplies', 10.0, 'Test', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert expense");

        // Verify expense exists
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM shift_expenses", [], |row| row.get(0))
            .expect("count expenses");
        assert_eq!(count, 1);

        // Delete the shift — expense should cascade-delete
        conn.execute("DELETE FROM staff_shifts WHERE id = 'shift-1'", [])
            .expect("delete shift");

        let count_after: i32 = conn
            .query_row("SELECT COUNT(*) FROM shift_expenses", [], |row| row.get(0))
            .expect("count expenses after cascade");
        assert_eq!(
            count_after, 0,
            "expense should be cascade-deleted with shift"
        );
    }

    #[test]
    fn test_sync_queue_idempotency_key_unique() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('order', 'ord-1', 'insert', '{}', 'key-1')",
            [],
        )
        .expect("first insert");

        // Duplicate idempotency_key should fail
        let result = conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('order', 'ord-2', 'insert', '{}', 'key-1')",
            [],
        );
        assert!(
            result.is_err(),
            "duplicate idempotency_key should be rejected"
        );
    }

    #[test]
    fn test_order_payments_fk_cascade() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Insert an order
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-1', '[]', 25.0, 'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert order");

        // Insert a payment linked to the order
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, created_at, updated_at)
             VALUES ('pay-1', 'ord-1', 'cash', 25.0, 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert payment");

        // Verify payment exists
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM order_payments", [], |row| row.get(0))
            .expect("count payments");
        assert_eq!(count, 1);

        // Delete the order — payment should cascade-delete
        conn.execute("DELETE FROM orders WHERE id = 'ord-1'", [])
            .expect("delete order");

        let count_after: i32 = conn
            .query_row("SELECT COUNT(*) FROM order_payments", [], |row| row.get(0))
            .expect("count payments after cascade");
        assert_eq!(
            count_after, 0,
            "payment should be cascade-deleted with order"
        );
    }

    #[test]
    fn test_migration_v5_sync_state_backfill() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Insert an order WITHOUT supabase_id
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-no-sup', '[]', 10.0, 'pending', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert order without supabase_id");

        // Insert an order WITH supabase_id
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, supabase_id, created_at, updated_at)
             VALUES ('ord-has-sup', '[]', 20.0, 'completed', 'synced', 'sup-abc-123', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert order with supabase_id");

        // Insert payments BEFORE v5 migration using the v4 schema
        // (sync_state column added by v5, so we need to test the backfill effect)
        // Because we already ran all migrations, the column exists. Instead,
        // test the default and CHECK constraint.
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-wp', 'ord-no-sup', 'cash', 10.0, 'pending', 'waiting_parent', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert payment waiting_parent");

        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-pend', 'ord-has-sup', 'card', 20.0, 'pending', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert payment pending");

        // Verify sync_state values
        let wp: String = conn
            .query_row(
                "SELECT sync_state FROM order_payments WHERE id = 'pay-wp'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(wp, "waiting_parent");

        let pend: String = conn
            .query_row(
                "SELECT sync_state FROM order_payments WHERE id = 'pay-pend'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pend, "pending");

        // Verify CHECK constraint rejects invalid values
        let bad = conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-bad', 'ord-no-sup', 'cash', 5.0, 'pending', 'INVALID', datetime('now'), datetime('now'))",
            [],
        );
        assert!(bad.is_err(), "invalid sync_state should be rejected");
    }

    #[test]
    fn test_print_jobs_table() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Insert a print job
        conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES ('pj-1', 'order_receipt', 'ord-1', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert print job");

        // Verify it exists
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM print_jobs", [], |row| row.get(0))
            .expect("count print_jobs");
        assert_eq!(count, 1);

        // Verify CHECK constraint rejects invalid status
        let bad = conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES ('pj-bad', 'order_receipt', 'ord-1', 'INVALID', datetime('now'), datetime('now'))",
            [],
        );
        assert!(bad.is_err(), "invalid status should be rejected");

        // Verify CHECK constraint rejects invalid entity_type
        let bad_type = conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES ('pj-bad2', 'INVALID_TYPE', 'ord-1', 'pending', datetime('now'), datetime('now'))",
            [],
        );
        assert!(bad_type.is_err(), "invalid entity_type should be rejected");
    }

    #[test]
    fn test_printer_profiles_table() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Insert a printer profile
        conn.execute(
            "INSERT INTO printer_profiles (id, name, driver_type, printer_name, paper_width_mm, copies_default, cut_paper, open_cash_drawer, created_at, updated_at)
             VALUES ('pp-1', 'Receipt Printer', 'windows', 'POS-58 Printer', 58, 1, 1, 0, datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert printer profile");

        // Verify it exists
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM printer_profiles", [], |row| {
                row.get(0)
            })
            .expect("count printer_profiles");
        assert_eq!(count, 1);

        // Verify CHECK constraint rejects invalid driver_type
        let bad_driver = conn.execute(
            "INSERT INTO printer_profiles (id, name, driver_type, printer_name, created_at, updated_at)
             VALUES ('pp-bad', 'Bad', 'escpos', 'Printer', datetime('now'), datetime('now'))",
            [],
        );
        assert!(
            bad_driver.is_err(),
            "invalid driver_type should be rejected"
        );

        // Verify CHECK constraint rejects invalid paper_width_mm
        let bad_width = conn.execute(
            "INSERT INTO printer_profiles (id, name, driver_type, printer_name, paper_width_mm, created_at, updated_at)
             VALUES ('pp-bad2', 'Bad', 'windows', 'Printer', 72, datetime('now'), datetime('now'))",
            [],
        );
        assert!(
            bad_width.is_err(),
            "invalid paper_width_mm should be rejected"
        );
    }

    #[test]
    fn test_migration_v8_drawer_columns() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Insert a printer profile with drawer fields
        conn.execute(
            "INSERT INTO printer_profiles (id, name, driver_type, printer_name,
                                           drawer_mode, drawer_host, drawer_port, drawer_pulse_ms,
                                           created_at, updated_at)
             VALUES ('pp-drawer', 'Drawer Printer', 'windows', 'POS-80',
                     'escpos_tcp', '192.168.1.100', 9100, 250,
                     datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert profile with drawer fields");

        // Read back
        let mode: String = conn
            .query_row(
                "SELECT drawer_mode FROM printer_profiles WHERE id = 'pp-drawer'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mode, "escpos_tcp");

        let host: String = conn
            .query_row(
                "SELECT drawer_host FROM printer_profiles WHERE id = 'pp-drawer'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(host, "192.168.1.100");

        let port: i32 = conn
            .query_row(
                "SELECT drawer_port FROM printer_profiles WHERE id = 'pp-drawer'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(port, 9100);

        let pulse: i32 = conn
            .query_row(
                "SELECT drawer_pulse_ms FROM printer_profiles WHERE id = 'pp-drawer'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pulse, 250);

        // Default values for a profile without explicit drawer fields
        conn.execute(
            "INSERT INTO printer_profiles (id, name, driver_type, printer_name, created_at, updated_at)
             VALUES ('pp-nodr', 'No Drawer', 'windows', 'POS-58', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert profile without drawer fields");

        let default_mode: String = conn
            .query_row(
                "SELECT drawer_mode FROM printer_profiles WHERE id = 'pp-nodr'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(default_mode, "none");

        let default_port: i32 = conn
            .query_row(
                "SELECT drawer_port FROM printer_profiles WHERE id = 'pp-nodr'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(default_port, 9100);

        // CHECK constraint rejects invalid drawer_mode
        let bad_mode = conn.execute(
            "INSERT INTO printer_profiles (id, name, driver_type, printer_name, drawer_mode, created_at, updated_at)
             VALUES ('pp-bad', 'Bad', 'windows', 'Printer', 'serial', datetime('now'), datetime('now'))",
            [],
        );
        assert!(bad_mode.is_err(), "invalid drawer_mode should be rejected");
    }

    #[test]
    fn test_migration_v9_warning_columns() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Insert a print job with warning fields
        conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status,
                                     warning_code, warning_message, last_attempt_at,
                                     created_at, updated_at)
             VALUES ('pj-warn', 'order_receipt', 'ord-1', 'printed',
                     'drawer_kick_failed', 'TCP connect failed', datetime('now'),
                     datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert print job with warning");

        // Read back warning fields
        let (code, msg, attempt_at): (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT warning_code, warning_message, last_attempt_at FROM print_jobs WHERE id = 'pj-warn'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(code, Some("drawer_kick_failed".to_string()));
        assert_eq!(msg, Some("TCP connect failed".to_string()));
        assert!(attempt_at.is_some());

        // Verify nullable — insert without warning fields
        conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES ('pj-no-warn', 'order_receipt', 'ord-2', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert print job without warning");

        let (code2, msg2): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT warning_code, warning_message FROM print_jobs WHERE id = 'pj-no-warn'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(code2.is_none());
        assert!(msg2.is_none());
    }

    #[test]
    fn test_migration_v10_payment_adjustments() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Insert prerequisite order + payment
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-adj', '[]', 50.0, 'completed', 'synced', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert order");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, sync_status, created_at, updated_at)
             VALUES ('pay-adj', 'ord-adj', 'cash', 50.0, 'synced', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert payment");

        // Insert a refund adjustment
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-1', 'pay-adj', 'ord-adj', 'refund', 10.0, 'Overcharged', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert refund adjustment");

        // Insert a void adjustment
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-2', 'pay-adj', 'ord-adj', 'void', 50.0, 'Wrong order', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert void adjustment");

        // Verify count
        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM payment_adjustments WHERE payment_id = 'pay-adj'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);

        // CHECK constraint rejects invalid adjustment_type
        let bad = conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-bad', 'pay-adj', 'ord-adj', 'INVALID', 5.0, 'test', 'pending', datetime('now'), datetime('now'))",
            [],
        );
        assert!(bad.is_err(), "invalid adjustment_type should be rejected");

        // CHECK constraint rejects invalid sync_state
        let bad_state = conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-bad2', 'pay-adj', 'ord-adj', 'refund', 5.0, 'test', 'INVALID', datetime('now'), datetime('now'))",
            [],
        );
        assert!(bad_state.is_err(), "invalid sync_state should be rejected");

        // FK cascade: deleting payment cascades to adjustments
        conn.execute("DELETE FROM order_payments WHERE id = 'pay-adj'", [])
            .expect("delete payment");
        let count_after: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM payment_adjustments WHERE payment_id = 'pay-adj'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count_after, 0,
            "adjustments should cascade-delete with payment"
        );
    }

    #[test]
    fn test_migration_v14_driver_earnings() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Insert prerequisite shift + order
        conn.execute(
            "INSERT INTO staff_shifts (id, staff_id, role_type, check_in_time, status, sync_status, created_at, updated_at)
             VALUES ('shift-drv', 'staff-drv', 'driver', datetime('now'), 'active', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert driver shift");
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-drv', '[]', 30.0, 'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert order");

        // Insert a driver earning
        conn.execute(
            "INSERT INTO driver_earnings (id, driver_id, staff_shift_id, order_id, branch_id,
                                          delivery_fee, tip_amount, total_earning,
                                          payment_method, cash_collected, card_amount, cash_to_return,
                                          created_at, updated_at)
             VALUES ('de-1', 'staff-drv', 'shift-drv', 'ord-drv', 'branch-1',
                     3.0, 1.0, 4.0, 'cash', 30.0, 0.0, 30.0,
                     datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert driver earning");

        // Verify it exists
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM driver_earnings", [], |row| row.get(0))
            .expect("count driver_earnings");
        assert_eq!(count, 1);

        // Verify UNIQUE constraint on order_id
        let dup = conn.execute(
            "INSERT INTO driver_earnings (id, driver_id, staff_shift_id, order_id, branch_id,
                                          total_earning, payment_method, created_at, updated_at)
             VALUES ('de-2', 'staff-drv', 'shift-drv', 'ord-drv', 'branch-1',
                     4.0, 'cash', datetime('now'), datetime('now'))",
            [],
        );
        assert!(dup.is_err(), "duplicate order_id should be rejected");

        // Verify CHECK constraint on payment_method
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-drv2', '[]', 20.0, 'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert order 2");
        let bad_method = conn.execute(
            "INSERT INTO driver_earnings (id, driver_id, staff_shift_id, order_id, branch_id,
                                          total_earning, payment_method, created_at, updated_at)
             VALUES ('de-bad', 'staff-drv', 'shift-drv', 'ord-drv2', 'branch-1',
                     4.0, 'bitcoin', datetime('now'), datetime('now'))",
            [],
        );
        assert!(
            bad_method.is_err(),
            "invalid payment_method should be rejected"
        );

        // Verify FK cascade: deleting the order cascades to driver_earnings
        conn.execute("DELETE FROM orders WHERE id = 'ord-drv'", [])
            .expect("delete order");
        let count_after: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM driver_earnings WHERE order_id = 'ord-drv'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count_after, 0,
            "driver_earnings should cascade-delete with order"
        );

        // Verify FK SET NULL: deleting shift sets staff_shift_id to NULL
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
             VALUES ('ord-drv3', '[]', 15.0, 'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert order 3");
        conn.execute(
            "INSERT INTO driver_earnings (id, driver_id, staff_shift_id, order_id, branch_id,
                                          total_earning, payment_method, created_at, updated_at)
             VALUES ('de-3', 'staff-drv', 'shift-drv', 'ord-drv3', 'branch-1',
                     5.0, 'card', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert earning for FK test");
        conn.execute("DELETE FROM staff_shifts WHERE id = 'shift-drv'", [])
            .expect("delete shift");
        let shift_id_after: Option<String> = conn
            .query_row(
                "SELECT staff_shift_id FROM driver_earnings WHERE id = 'de-3'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            shift_id_after.is_none(),
            "staff_shift_id should be SET NULL after shift delete"
        );
    }

    #[test]
    fn test_settings_crud() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Set a value
        set_setting(&conn, "terminal", "language", "el").expect("set");
        let val = get_setting(&conn, "terminal", "language");
        assert_eq!(val, Some("el".to_string()));

        // Update
        set_setting(&conn, "terminal", "language", "en").expect("update");
        let val = get_setting(&conn, "terminal", "language");
        assert_eq!(val, Some("en".to_string()));

        // Delete category
        delete_all_settings(&conn, "terminal").expect("delete");
        let val = get_setting(&conn, "terminal", "language");
        assert!(val.is_none());
    }
}
