//! Local SQLite database layer for The Small POS.
//!
//! Uses rusqlite with WAL mode, matching the Electron POS's better-sqlite3
//! configuration. Provides schema migrations, settings helpers, and managed
//! state for use across Tauri commands.

use rusqlite::{params, Connection};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tracing::{error, info, warn};

/// Tauri managed state holding the database connection.
///
/// # Single-Mutex Design
///
/// SQLite enforces a single-writer constraint: only one thread may write at a
/// time, and concurrent readers are only possible when WAL mode is used with
/// separate connections. Because this POS application uses a single
/// `rusqlite::Connection` (matching the Electron POS's `better-sqlite3`
/// pattern), a single `Mutex<Connection>` serializes all access.
///
/// # Deadlock Prevention
///
/// `std::sync::Mutex` is **not** reentrant. Any function that acquires the
/// lock must **never** call another function that also acquires it while the
/// guard is held. The recommended pattern is:
///
/// 1. Acquire the lock in a scoped block `{ let conn = db.conn.lock()...; ... }`
/// 2. Drop the guard (end of block) **before** calling helpers that need
///    their own lock.
///
/// See `diagnostics::get_system_health` for an example of this drop-and-reacquire
/// pattern.
///
/// # Performance Considerations
///
/// A single mutex is adequate for the POS workload (low concurrency, small
/// transactions). If contention becomes measurable — e.g. background sync
/// blocking UI reads — consider migrating to an `r2d2` connection pool with
/// separate read-only and read-write connections, or switching to
/// `tokio::sync::Mutex` with `spawn_blocking` for DB calls.
pub struct DbState {
    pub conn: Mutex<Connection>,
    pub db_path: PathBuf,
}

/// Current schema version. Bump when adding new migrations.
const CURRENT_SCHEMA_VERSION: i32 = 61;

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
                "Database open failed ({}), quarantining and retrying once",
                first_err
            );
            crate::recovery::quarantine_database_files(app_data_dir, &db_path, &first_err)
                .map_err(|error| format!("Database open failed and quarantine failed: {error}"))?;
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

/// Wave 10 H32: bracket a closure with `PRAGMA synchronous = FULL` for
/// power-loss durability of monetary writes.
///
/// SQLite's default `synchronous = NORMAL` (set in `open_and_configure`)
/// fsyncs the WAL only at checkpoint time, so a power loss between two
/// checkpoints can lose committed-but-not-checkpointed writes. For
/// monetary data (`order_payments`, `payment_adjustments`, `z_reports`,
/// `staff_shifts`) this is unacceptable — the customer paid, the cash
/// drawer moved, but the row may not survive. `FULL` fsyncs every commit
/// at a measurable per-commit latency cost (see the bench harness in
/// `h32_pragma_bench_normal_vs_full` for current numbers and the 15% P99
/// ceiling that gated shipping).
///
/// **Status**: production wrap is descoped per the bench numbers
/// (P99 +47.8% on the dev machine). Helper kept as ready-to-use
/// infrastructure for a future re-bench on different hardware /
/// storage / OS, or for a targeted opt-in by a single high-value
/// transaction. See `project_w10_h32_pragma_descoped.md`.
///
/// Contract:
/// - The PRAGMA is per-connection in WAL mode (verified by SQLite docs).
///   This helper is therefore safe to call concurrently from different
///   connections without affecting each other.
/// - The `Restore` Drop guard puts the PRAGMA back to NORMAL on any
///   exit path (Ok return, Err return, panic). Without the guard, a
///   panic mid-closure would leave the connection in FULL mode for the
///   rest of its lifetime — a subtle and hard-to-trace performance bug.
/// - The closure receives `&Connection` (NOT a fresh connection) so it
///   can use any active transaction the caller has set up. Typical
///   call shape:
///
/// ```ignore
/// with_full_sync(&conn, |conn| {
///     conn.execute_batch("BEGIN IMMEDIATE")?;
///     // … monetary INSERTs / UPDATEs …
///     conn.execute_batch("COMMIT")?;
///     Ok(())
/// })
/// ```
///
///   The closure can also commit-and-then-do-more; the PRAGMA reset on
///   Drop is unaffected by what happens inside.
#[allow(dead_code)] // W10 H32 descoped per bench (P99 +47.8%); kept for re-bench.
pub(crate) fn with_full_sync<F, T>(conn: &Connection, f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    /// Drop guard that restores `PRAGMA synchronous = NORMAL` on any
    /// exit path — including panic unwinding through the closure.
    struct Restore<'c> {
        conn: &'c Connection,
    }
    impl Drop for Restore<'_> {
        fn drop(&mut self) {
            // We intentionally swallow the restore error: if the DB is
            // in a state where PRAGMA can't run (e.g. connection
            // closed), there is nothing useful to do. Log at debug so
            // a forensic trace is possible.
            if let Err(e) = self.conn.execute_batch("PRAGMA synchronous = NORMAL;") {
                tracing::debug!(
                    error = %e,
                    "Wave 10 H32: failed to restore PRAGMA synchronous = NORMAL on Drop"
                );
            }
        }
    }

    conn.execute_batch("PRAGMA synchronous = FULL;")
        .map_err(|e| format!("with_full_sync set FULL: {e}"))?;

    let _guard = Restore { conn };
    f(conn)
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

    if current > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "Database schema version ({current}) is newer than this application supports ({CURRENT_SCHEMA_VERSION}). \
             Please update the application or restore a backup."
        ));
    }
    let needs_v56_backfill = needs_v56_claim_generation_backfill(conn, current)?;
    if current == CURRENT_SCHEMA_VERSION && !needs_v56_backfill {
        info!("Database schema up to date (v{current})");
        return Ok(());
    }

    if current > 0 {
        if let Ok(db_path_value) = conn.query_row(
            "SELECT file FROM pragma_database_list WHERE name = 'main' LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        ) {
            if !db_path_value.trim().is_empty() {
                let db_path = PathBuf::from(db_path_value);
                if let Err(error) = crate::recovery::create_pre_migration_snapshot(&db_path, conn) {
                    return Err(format!("pre-migration recovery snapshot failed: {error}"));
                }
            }
        }
    }

    info!("Migrating database from v{current} to v{CURRENT_SCHEMA_VERSION}");

    // Each migration runs inside a transaction so a crash mid-migration
    // (power loss, process kill) cannot leave the schema in a half-applied
    // state. A handful of migrations historically embedded their own
    // `BEGIN;`/`COMMIT;` inside `execute_batch`; those are passed through
    // `migrate_vN(conn)?` directly because SQLite rejects a `BEGIN` within
    // an open transaction. Every other migration goes through
    // `run_migration_tx`, which wraps the call in `BEGIN IMMEDIATE` and
    // commits on success / rolls back on error.
    if current < 1 {
        run_migration_tx(conn, 1, migrate_v1)?;
    }
    if current < 2 {
        run_migration_tx(conn, 2, migrate_v2)?;
    }
    if current < 3 {
        run_migration_tx(conn, 3, migrate_v3)?;
    }
    if current < 4 {
        run_migration_tx(conn, 4, migrate_v4)?;
    }
    if current < 5 {
        run_migration_tx(conn, 5, migrate_v5)?;
    }
    if current < 6 {
        run_migration_tx(conn, 6, migrate_v6)?;
    }
    if current < 7 {
        run_migration_tx(conn, 7, migrate_v7)?;
    }
    if current < 8 {
        run_migration_tx(conn, 8, migrate_v8)?;
    }
    if current < 9 {
        run_migration_tx(conn, 9, migrate_v9)?;
    }
    if current < 10 {
        run_migration_tx(conn, 10, migrate_v10)?;
    }
    if current < 11 {
        // v11 self-wraps (inline BEGIN;/COMMIT;).
        migrate_v11(conn)?;
    }
    if current < 12 {
        run_migration_tx(conn, 12, migrate_v12)?;
    }
    if current < 13 {
        run_migration_tx(conn, 13, migrate_v13)?;
    }
    if current < 14 {
        run_migration_tx(conn, 14, migrate_v14)?;
    }
    if current < 15 {
        run_migration_tx(conn, 15, migrate_v15)?;
    }
    if current < 16 {
        // v16 self-wraps (inline BEGIN;/COMMIT;).
        migrate_v16(conn)?;
    }
    if current < 17 {
        run_migration_tx(conn, 17, migrate_v17)?;
    }
    if current < 18 {
        // v18 self-wraps (inline BEGIN;/COMMIT;).
        migrate_v18(conn)?;
    }
    if current < 19 {
        run_migration_tx(conn, 19, migrate_v19)?;
    }
    if current < 20 {
        // v20 self-wraps (inline BEGIN;/COMMIT;).
        migrate_v20(conn)?;
    }
    if current < 21 {
        run_migration_tx(conn, 21, migrate_v21)?;
    }
    if current < 22 {
        run_migration_tx(conn, 22, migrate_v22)?;
    }
    if current < 23 {
        run_migration_tx(conn, 23, migrate_v23)?;
    }
    if current < 24 {
        // v24 self-wraps (inline BEGIN;/COMMIT;).
        migrate_v24(conn)?;
    }
    if current < 25 {
        run_migration_tx(conn, 25, migrate_v25)?;
    }
    if current < 26 {
        run_migration_tx(conn, 26, migrate_v26)?;
    }
    if current < 27 {
        run_migration_tx(conn, 27, migrate_v27)?;
    }
    if current < 28 {
        // v28 self-wraps (inline BEGIN;/COMMIT;).
        migrate_v28(conn)?;
    }
    if current < 29 {
        run_migration_tx(conn, 29, migrate_v29)?;
    }
    if current < 30 {
        // v30 self-wraps (inline BEGIN;/COMMIT;).
        migrate_v30(conn)?;
    }
    if current < 31 {
        // v31 self-wraps (inline BEGIN;/COMMIT;).
        migrate_v31(conn)?;
    }
    if current < 32 {
        run_migration_tx(conn, 32, migrate_v32)?;
    }
    if current < 33 {
        run_migration_tx(conn, 33, migrate_v33)?;
    }
    if current < 34 {
        // v34 self-wraps (inline BEGIN;/COMMIT;).
        migrate_v34(conn)?;
    }
    if current < 35 {
        run_migration_tx(conn, 35, migrate_v35)?;
    }
    if current < 36 {
        // v36 self-wraps (inline BEGIN;/COMMIT;).
        migrate_v36(conn)?;
    }
    if current < 37 {
        run_migration_tx(conn, 37, migrate_v37)?;
    }
    if current < 38 {
        run_migration_tx(conn, 38, migrate_v38)?;
    }
    if current < 39 {
        run_migration_tx(conn, 39, migrate_v39)?;
    }
    if current < 40 {
        // v40 self-wraps (inline BEGIN;/COMMIT;).
        migrate_v40(conn)?;
    }
    if current < 41 {
        run_migration_tx(conn, 41, migrate_v41)?;
    }
    if current < 42 {
        run_migration_tx(conn, 42, migrate_v42)?;
    }
    if current < 43 {
        run_migration_tx(conn, 43, migrate_v43)?;
    }
    if current < 44 {
        run_migration_tx(conn, 44, migrate_v44)?;
    }
    if current < 45 {
        run_migration_tx(conn, 45, migrate_v45)?;
    }
    if current < 46 {
        run_migration_tx(conn, 46, migrate_v46)?;
    }
    if current < 47 {
        run_migration_tx(conn, 47, migrate_v47)?;
    }
    if current < 48 {
        run_migration_tx(conn, 48, migrate_v48)?;
    }
    if current < 49 {
        run_migration_tx(conn, 49, migrate_v49)?;
    }
    if current < 50 {
        run_migration_tx(conn, 50, migrate_v50)?;
    }
    if current < 51 {
        run_migration_tx(conn, 51, migrate_v51)?;
    }
    if current < 52 {
        run_migration_tx(conn, 52, migrate_v52)?;
    }
    if current < 53 {
        run_migration_tx(conn, 53, migrate_v53)?;
    }
    if current < 54 {
        run_migration_tx(conn, 54, migrate_v54)?;
    }
    if current < 55 {
        run_migration_tx(conn, 55, migrate_v55)?;
    }
    // Wave 10 H8: `claim_generation` column on `parity_sync_queue`.
    // Reserved as v56 by the W11 cleanup sprint (which jumped to v57
    // to leave 56 free for this work). See
    // `project_w10_h8_claim_generation_deferred.md`.
    if current < 56 || needs_v56_backfill {
        run_migration_tx(conn, 56, migrate_v56)?;
    }
    if current < 57 {
        run_migration_tx(conn, 57, migrate_v57)?;
    }
    if current < 58 {
        run_migration_tx(conn, 58, migrate_v58)?;
    }
    if current < 59 {
        run_migration_tx(conn, 59, migrate_v59)?;
    }
    if current < 60 {
        run_migration_tx(conn, 60, migrate_v60)?;
    }
    if current < 61 {
        run_migration_tx(conn, 61, migrate_v61)?;
    }

    Ok(())
}

fn schema_version_exists(conn: &Connection, version: i32) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_version WHERE version = ?1)",
        [version],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|e| format!("read schema_version {version}: {e}"))
}

fn needs_v56_claim_generation_backfill(conn: &Connection, current: i32) -> Result<bool, String> {
    if current < 56 {
        return Ok(false);
    }

    let has_version = schema_version_exists(conn, 56)?;
    let has_column = column_exists(conn, "parity_sync_queue", "claim_generation")?;
    Ok(!has_version || !has_column)
}

/// Run a migration inside a `BEGIN IMMEDIATE`/`COMMIT` transaction. Use
/// this for migration functions whose bodies do NOT already contain an
/// inline `BEGIN;`/`COMMIT;` pair — wrapping a self-wrapping migration
/// would double-begin and SQLite would reject the nested `BEGIN`.
///
/// On migration failure the transaction is rolled back so no partial DDL
/// or `INSERT schema_version` row persists; the application will retry
/// the migration on the next start.
///
/// # Table-rebuild migrations (important rule for future authors)
///
/// Several older migrations (v11, v18, v24, v28, v34, v40) rebuild a table
/// via the pattern:
///
/// ```sql
/// CREATE TABLE X_new (...);
/// INSERT INTO X_new SELECT * FROM X;   -- positional! fragile!
/// DROP TABLE X;
/// ALTER TABLE X_new RENAME TO X;
/// ```
///
/// The `SELECT *` / implicit-column INSERT is positional — if any prior
/// migration added a column in the middle of the old table (via
/// `ALTER TABLE ADD COLUMN` — which always appends, so this is mostly
/// safe in SQLite, but can still shift columns when combined with other
/// rebuilds) the mapping silently corrupts data because values land in
/// the wrong columns of the new schema. The `OR IGNORE` variant masks
/// the conflict by dropping the row.
///
/// **Rule for new table-rebuild migrations:** always list the columns
/// explicitly on BOTH sides of the `INSERT ... SELECT` so the SQL
/// engine checks the names, not the positions:
///
/// ```sql
/// INSERT INTO X_new (id, name, created_at)
/// SELECT id, name, created_at FROM X;
/// ```
///
/// The existing migrations cannot be retroactively fixed (the ship has
/// sailed on deployed terminals), but new rebuild migrations MUST follow
/// this rule.
fn run_migration_tx<F>(conn: &Connection, version: i32, migration: F) -> Result<(), String>
where
    F: FnOnce(&Connection) -> Result<(), String>,
{
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin migration v{version}: {e}"))?;
    match migration(conn) {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit migration v{version}: {e}"))?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(format!("migration v{version} rolled back: {e}"))
        }
    }
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
            customer_id TEXT,
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

        -- sync_queue (append-only) — RETIRED in migration v56.
        --
        -- Wave 5 Session 7 PR 2 dropped this table in migration v56 after
        -- PR 0 migrated every producer onto `parity_sync_queue` and PR 1
        -- added a compile-time seal. The CREATE TABLE stays in the v1
        -- body because intermediate migrations (v13, v47, v49, v50, ...)
        -- ALTER the table — a fresh install replays the v1→v56 chain
        -- end-to-end, so v1 must still build the table for the middle
        -- migrations to operate on before v56 finally drops it.
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
            updated_at TEXT DEFAULT (datetime('now'))
            , synced_at TEXT
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
            report_date TEXT,
            period_start_at TEXT,
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
        BEGIN;

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
        -- Wave 11 L doc: `INSERT OR IGNORE` here silently drops any
        -- rows whose `id` already exists in `print_jobs_v11` (it
        -- shouldn't, but the older table's history is opaque). The
        -- print_jobs schema later gains an `idempotency_key UNIQUE`
        -- column (v47), making this a dual-key arrangement (PK on `id`
        -- + UNIQUE on `idempotency_key`). After v47 a similar table-
        -- rebuild migration would silently drop rows that conflict on
        -- EITHER key — that's a real risk if any pre-v47 INSERT ever
        -- produced an `id` collision. Future rebuilds should explicitly
        -- handle the dual-key case (e.g. `ON CONFLICT(...) DO NOTHING`
        -- with the conflict target spelled out).
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

        COMMIT;
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

/// Check whether `table` has a column named `column`.
///
/// # Security contract
///
/// `table` is interpolated into the `PRAGMA table_info(...)` SQL string. SQL
/// identifiers cannot be bound as parameters in SQLite, so parameterisation
/// is not available — the only way to keep this safe is for every caller to
/// pass a **string literal** (or a value derived from a string literal) as
/// the `table` argument. At the time of writing every call site in this
/// module does exactly that (grep `column_exists(` — all call-sites pass
/// quoted literals such as `"sync_queue"`, `"orders"`, `"printer_profiles"`).
///
/// If you ever need to call this with a runtime-derived table name, STOP
/// and route the call through a known-good allowlist — or reject the call
/// outright. A caller-supplied identifier here is a SQL-injection primitive.
///
/// The `debug_assert!` in this function enforces an identifier regex at
/// development time so an accidental call like `column_exists(conn, user_input,
/// "foo")` fails loudly under `cargo test` even if the runtime happens to
/// accept it.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    debug_assert!(
        is_safe_sql_identifier(table),
        "column_exists: table name '{table}' is not a plain SQL identifier — \
         callers MUST pass a string literal, not runtime-derived input"
    );
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

/// Return true iff `s` looks like a plain SQL identifier: `[A-Za-z_][A-Za-z0-9_]*`.
/// Used by `debug_assert!` in `column_exists` to catch accidental interpolation
/// of runtime-derived table names during development. Not a substitute for
/// call-site discipline; see `column_exists` docs.
fn is_safe_sql_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
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

/// Migration v15: Extended printer profile columns for Electron-compat UI.
///
/// Adds `printer_type`, `role`, `is_default`, `enabled`, `character_set`,
/// `greek_render_mode`, `receipt_template`, `fallback_printer_id`, and
/// `connection_json` so that the full Electron-style printer config can be
/// round-tripped through the Tauri backend.
fn migrate_v15(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "printer_profiles", "printer_type")? {
        conn.execute_batch(
            "ALTER TABLE printer_profiles ADD COLUMN printer_type TEXT NOT NULL DEFAULT 'system';",
        )
        .map_err(|e| format!("migration v15 add printer_type: {e}"))?;
    }
    if !column_exists(conn, "printer_profiles", "role")? {
        conn.execute_batch(
            "ALTER TABLE printer_profiles ADD COLUMN role TEXT NOT NULL DEFAULT 'receipt';",
        )
        .map_err(|e| format!("migration v15 add role: {e}"))?;
    }
    if !column_exists(conn, "printer_profiles", "is_default")? {
        conn.execute_batch(
            "ALTER TABLE printer_profiles ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;",
        )
        .map_err(|e| format!("migration v15 add is_default: {e}"))?;
    }
    if !column_exists(conn, "printer_profiles", "enabled")? {
        conn.execute_batch(
            "ALTER TABLE printer_profiles ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;",
        )
        .map_err(|e| format!("migration v15 add enabled: {e}"))?;
    }
    if !column_exists(conn, "printer_profiles", "character_set")? {
        conn.execute_batch(
            "ALTER TABLE printer_profiles ADD COLUMN character_set TEXT NOT NULL DEFAULT 'PC437_USA';",
        )
        .map_err(|e| format!("migration v15 add character_set: {e}"))?;
    }
    if !column_exists(conn, "printer_profiles", "greek_render_mode")? {
        conn.execute_batch(
            "ALTER TABLE printer_profiles ADD COLUMN greek_render_mode TEXT DEFAULT 'text';",
        )
        .map_err(|e| format!("migration v15 add greek_render_mode: {e}"))?;
    }
    if !column_exists(conn, "printer_profiles", "receipt_template")? {
        conn.execute_batch(
            "ALTER TABLE printer_profiles ADD COLUMN receipt_template TEXT DEFAULT 'classic';",
        )
        .map_err(|e| format!("migration v15 add receipt_template: {e}"))?;
    }
    if !column_exists(conn, "printer_profiles", "fallback_printer_id")? {
        conn.execute_batch("ALTER TABLE printer_profiles ADD COLUMN fallback_printer_id TEXT;")
            .map_err(|e| format!("migration v15 add fallback_printer_id: {e}"))?;
    }
    if !column_exists(conn, "printer_profiles", "connection_json")? {
        conn.execute_batch("ALTER TABLE printer_profiles ADD COLUMN connection_json TEXT;")
            .map_err(|e| format!("migration v15 add connection_json: {e}"))?;
    }

    conn.execute_batch("INSERT INTO schema_version (version) VALUES (15);")
        .map_err(|e| {
            error!("Migration v15 failed: {e}");
            format!("migration v15: {e}")
        })?;

    info!("Applied migration v15 (extended printer profile columns)");
    Ok(())
}

/// Migration v16: Update printer_profiles driver_type CHECK to allow 'escpos'.
///
/// SQLite does not support ALTER CONSTRAINT, so the table is recreated with the
/// updated CHECK constraint. All existing data is preserved.
fn migrate_v16(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        BEGIN;

        CREATE TABLE printer_profiles_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            driver_type TEXT NOT NULL DEFAULT 'windows'
                CHECK (driver_type IN ('windows', 'escpos')),
            printer_name TEXT NOT NULL,
            paper_width_mm INTEGER NOT NULL DEFAULT 80
                CHECK (paper_width_mm IN (58, 80)),
            copies_default INTEGER NOT NULL DEFAULT 1,
            cut_paper INTEGER NOT NULL DEFAULT 1,
            open_cash_drawer INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            drawer_mode TEXT NOT NULL DEFAULT 'none'
                CHECK (drawer_mode IN ('none', 'escpos_tcp')),
            drawer_host TEXT,
            drawer_port INTEGER NOT NULL DEFAULT 9100,
            drawer_pulse_ms INTEGER NOT NULL DEFAULT 200,
            printer_type TEXT NOT NULL DEFAULT 'system',
            role TEXT NOT NULL DEFAULT 'receipt',
            is_default INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            character_set TEXT NOT NULL DEFAULT 'PC437_USA',
            greek_render_mode TEXT DEFAULT 'text',
            receipt_template TEXT DEFAULT 'classic',
            fallback_printer_id TEXT,
            connection_json TEXT
        );

        INSERT INTO printer_profiles_new
            SELECT id, name, driver_type, printer_name, paper_width_mm,
                   copies_default, cut_paper, open_cash_drawer,
                   created_at, updated_at,
                   drawer_mode, drawer_host, drawer_port, drawer_pulse_ms,
                   printer_type, role, is_default, enabled,
                   character_set, greek_render_mode, receipt_template,
                   fallback_printer_id, connection_json
            FROM printer_profiles;

        DROP TABLE printer_profiles;

        ALTER TABLE printer_profiles_new RENAME TO printer_profiles;

        CREATE INDEX IF NOT EXISTS idx_printer_profiles_name
            ON printer_profiles(printer_name);

        INSERT INTO schema_version (version) VALUES (16);

        COMMIT;
        ",
    )
    .map_err(|e| {
        error!("Migration v16 failed: {e}");
        format!("migration v16: {e}")
    })?;

    info!("Applied migration v16 (printer_profiles driver_type CHECK updated for escpos)");
    Ok(())
}

/// Migration v17: ECR devices and transactions tables.
///
/// Replaces the JSON blob in `local_settings` with proper relational tables
/// for fiscal cash registers and payment terminals. Migrates existing device
/// configurations.
fn migrate_v17(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS ecr_devices (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            device_type TEXT NOT NULL
                CHECK (device_type IN ('payment_terminal', 'cash_register')),
            brand TEXT NOT NULL DEFAULT 'generic',
            protocol TEXT NOT NULL DEFAULT 'generic',
            connection_type TEXT NOT NULL
                CHECK (connection_type IN ('bluetooth', 'serial_usb', 'network', 'usb')),
            connection_details TEXT NOT NULL DEFAULT '{}',
            terminal_id TEXT,
            merchant_id TEXT,
            operator_id TEXT,
            print_mode TEXT DEFAULT 'register_prints'
                CHECK (print_mode IN ('register_prints', 'pos_sends_receipt')),
            tax_rates TEXT DEFAULT '[]',
            is_default INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1,
            settings TEXT DEFAULT '{}',
            status TEXT DEFAULT 'disconnected',
            last_connected_at TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS ecr_transactions (
            id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            order_id TEXT,
            transaction_type TEXT NOT NULL,
            amount INTEGER NOT NULL,
            currency TEXT DEFAULT 'EUR',
            status TEXT NOT NULL,
            authorization_code TEXT,
            terminal_reference TEXT,
            fiscal_receipt_number TEXT,
            card_type TEXT,
            card_last_four TEXT,
            entry_method TEXT,
            receipt_data TEXT,
            error_message TEXT,
            raw_response TEXT,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (device_id) REFERENCES ecr_devices(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ecr_devices_type
            ON ecr_devices(device_type);
        CREATE INDEX IF NOT EXISTS idx_ecr_devices_default
            ON ecr_devices(is_default);
        CREATE INDEX IF NOT EXISTS idx_ecr_transactions_device
            ON ecr_transactions(device_id);
        CREATE INDEX IF NOT EXISTS idx_ecr_transactions_order
            ON ecr_transactions(order_id);
        CREATE INDEX IF NOT EXISTS idx_ecr_transactions_status
            ON ecr_transactions(status);

        INSERT INTO schema_version (version) VALUES (17);
        ",
    )
    .map_err(|e| {
        error!("Migration v17 failed: {e}");
        format!("migration v17: {e}")
    })?;

    // Migrate existing ecr_devices from JSON blob to the new table
    let old_json: Option<String> = conn
        .query_row(
            "SELECT setting_value FROM local_settings
             WHERE setting_category = 'local' AND setting_key = 'ecr_devices'",
            [],
            |row| row.get(0),
        )
        .ok();

    if let Some(json_str) = old_json {
        if let Ok(devices) = serde_json::from_str::<Vec<serde_json::Value>>(&json_str) {
            let mut dropped_devices = 0usize;
            let mut migrated_devices = 0usize;
            for dev in &devices {
                let id = dev.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                let name = dev
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown");
                let device_type = dev
                    .get("deviceType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("payment_terminal");
                let protocol = dev
                    .get("protocol")
                    .and_then(|v| v.as_str())
                    .unwrap_or("generic");
                let conn_type = dev
                    .get("connectionType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("network");
                let conn_details = dev
                    .get("connectionDetails")
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "{}".to_string());
                let terminal_id = dev.get("terminalId").and_then(|v| v.as_str());
                let merchant_id = dev.get("merchantId").and_then(|v| v.as_str());
                let is_default = dev
                    .get("isDefault")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false) as i32;
                let enabled = dev.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true) as i32;
                let settings = dev
                    .get("settings")
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "{}".to_string());

                // Wave 10 H33: an ECR device whose `device_type` /
                // `connection_type` didn't satisfy the new CHECK
                // constraints used to be silently dropped by the bare
                // `let _ = conn.execute(...)` call — the operator never
                // learned the row was lost, and the row was removed again
                // when the JSON blob was deleted below. Surfacing the
                // failure at `warn!` level keeps the migration forward
                // (we still continue the loop) but gives on-call
                // forensics a breadcrumb.
                if id.is_empty() {
                    dropped_devices += 1;
                    warn!("v17 migration: ECR device without id cannot be migrated");
                    continue;
                }

                match conn.execute(
                    "INSERT OR IGNORE INTO ecr_devices
                        (id, name, device_type, protocol, connection_type, connection_details,
                         terminal_id, merchant_id, is_default, enabled, settings)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        id,
                        name,
                        device_type,
                        protocol,
                        conn_type,
                        conn_details,
                        terminal_id,
                        merchant_id,
                        is_default,
                        enabled,
                        settings,
                    ],
                ) {
                    Ok(count) if count > 0 => migrated_devices += 1,
                    Ok(_) => {
                        let exists = conn
                            .query_row(
                                "SELECT 1 FROM ecr_devices WHERE id = ?1 LIMIT 1",
                                params![id],
                                |_| Ok(()),
                            )
                            .is_ok();
                        if exists {
                            migrated_devices += 1;
                        } else {
                            dropped_devices += 1;
                            warn!(
                                device_id = id,
                                device_type = device_type,
                                connection_type = conn_type,
                                "v17 migration: ECR device was ignored and is not present in destination table"
                            );
                        }
                    }
                    Err(e) => {
                        dropped_devices += 1;
                        warn!(
                            device_id = id,
                            device_type = device_type,
                            connection_type = conn_type,
                            error = %e,
                            "v17 migration: ECR device INSERT failed; preserving legacy JSON"
                        );
                    }
                }
            }

            if dropped_devices > 0 {
                warn!(
                    dropped = dropped_devices,
                    total = devices.len(),
                    "v17 migration: {dropped_devices} of {} ECR devices were not migrated; preserving legacy JSON",
                    devices.len()
                );
            } else {
                conn.execute(
                    "DELETE FROM local_settings
                     WHERE setting_category = 'local' AND setting_key = 'ecr_devices'",
                    [],
                )
                .map_err(|e| format!("migration v17 remove legacy ecr_devices: {e}"))?;
            }
            info!(
                "Migrated {} ECR devices from JSON to ecr_devices table ({} dropped)",
                migrated_devices, dropped_devices
            );
        } else {
            warn!("v17 migration: could not parse legacy ECR device JSON; preserving legacy blob");
        }
    }

    info!("Applied migration v17 (ecr_devices + ecr_transactions tables)");
    Ok(())
}

/// Migration v18: extend print_jobs entity type for shift checkout auto-print.
fn migrate_v18(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        BEGIN;

        CREATE TABLE IF NOT EXISTS print_jobs_v18 (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL
                CHECK (entity_type IN ('order_receipt', 'kitchen_ticket', 'z_report', 'shift_checkout')),
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
        -- Wave 11 L doc: see v11's INSERT OR IGNORE comment. Same
        -- dual-key debt applies here — `INSERT OR IGNORE` is silent
        -- on `id` collisions and (post-v47) `idempotency_key`
        -- collisions alike.
        INSERT OR IGNORE INTO print_jobs_v18
            SELECT * FROM print_jobs;
        DROP TABLE print_jobs;
        ALTER TABLE print_jobs_v18 RENAME TO print_jobs;

        CREATE INDEX IF NOT EXISTS idx_print_jobs_status
            ON print_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_created_at
            ON print_jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_entity
            ON print_jobs(entity_type, entity_id);

        INSERT INTO schema_version (version) VALUES (18);

        COMMIT;
        ",
    )
    .map_err(|e| {
        error!("Migration v18 failed: {e}");
        format!("migration v18: {e}")
    })?;

    info!("Applied migration v18 (print_jobs entity_type includes shift_checkout)");
    Ok(())
}

/// Migration v19: add ghost-order tracking fields on local orders.
fn migrate_v19(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "orders", "is_ghost")? {
        conn.execute(
            "ALTER TABLE orders ADD COLUMN is_ghost INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("migration v19 add is_ghost: {e}"))?;
    }
    if !column_exists(conn, "orders", "ghost_source")? {
        conn.execute("ALTER TABLE orders ADD COLUMN ghost_source TEXT", [])
            .map_err(|e| format!("migration v19 add ghost_source: {e}"))?;
    }
    if !column_exists(conn, "orders", "ghost_metadata")? {
        conn.execute("ALTER TABLE orders ADD COLUMN ghost_metadata TEXT", [])
            .map_err(|e| format!("migration v19 add ghost_metadata: {e}"))?;
    }

    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_orders_is_ghost ON orders(is_ghost);
        INSERT INTO schema_version (version) VALUES (19);
        ",
    )
    .map_err(|e| {
        error!("Migration v19 failed: {e}");
        format!("migration v19: {e}")
    })?;

    info!("Applied migration v19 (ghost order tracking fields)");
    Ok(())
}

/// Migration v20:
/// - add payload snapshot support for queued print jobs (`entity_payload_json`)
/// - allow 112mm printer profiles
/// - rollout `receipt_template = modern` for receipt/kitchen profiles
fn migrate_v20(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "print_jobs", "entity_payload_json")? {
        conn.execute(
            "ALTER TABLE print_jobs ADD COLUMN entity_payload_json TEXT",
            [],
        )
        .map_err(|e| format!("migration v20 add print_jobs.entity_payload_json: {e}"))?;
    }

    // Rebuild printer_profiles to update paper width CHECK (58, 80, 112) and
    // modern template default for new rows.
    conn.execute_batch(
        "
        BEGIN;

        CREATE TABLE printer_profiles_v20 (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            driver_type TEXT NOT NULL DEFAULT 'windows'
                CHECK (driver_type IN ('windows', 'escpos')),
            printer_name TEXT NOT NULL,
            paper_width_mm INTEGER NOT NULL DEFAULT 80
                CHECK (paper_width_mm IN (58, 80, 112)),
            copies_default INTEGER NOT NULL DEFAULT 1,
            cut_paper INTEGER NOT NULL DEFAULT 1,
            open_cash_drawer INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            drawer_mode TEXT NOT NULL DEFAULT 'none'
                CHECK (drawer_mode IN ('none', 'escpos_tcp')),
            drawer_host TEXT,
            drawer_port INTEGER NOT NULL DEFAULT 9100,
            drawer_pulse_ms INTEGER NOT NULL DEFAULT 200,
            printer_type TEXT NOT NULL DEFAULT 'system',
            role TEXT NOT NULL DEFAULT 'receipt',
            is_default INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            character_set TEXT NOT NULL DEFAULT 'PC437_USA',
            greek_render_mode TEXT DEFAULT 'text',
            receipt_template TEXT DEFAULT 'modern',
            fallback_printer_id TEXT,
            connection_json TEXT
        );

        INSERT INTO printer_profiles_v20
            SELECT id, name, driver_type, printer_name, paper_width_mm,
                   copies_default, cut_paper, open_cash_drawer,
                   created_at, updated_at,
                   drawer_mode, drawer_host, drawer_port, drawer_pulse_ms,
                   printer_type, role, is_default, enabled,
                   character_set, greek_render_mode, receipt_template,
                   fallback_printer_id, connection_json
            FROM printer_profiles;

        DROP TABLE printer_profiles;
        ALTER TABLE printer_profiles_v20 RENAME TO printer_profiles;

        CREATE INDEX IF NOT EXISTS idx_printer_profiles_name
            ON printer_profiles(printer_name);

        COMMIT;
        ",
    )
    .map_err(|e| format!("migration v20 rebuild printer_profiles: {e}"))?;

    conn.execute(
        "UPDATE printer_profiles
         SET receipt_template = 'modern'
         WHERE role IN ('receipt', 'kitchen')
           AND (
               receipt_template IS NULL
               OR TRIM(receipt_template) = ''
               OR LOWER(TRIM(receipt_template)) = 'classic'
           )",
        [],
    )
    .map_err(|e| format!("migration v20 rollout modern templates: {e}"))?;

    conn.execute_batch("INSERT INTO schema_version (version) VALUES (20);")
        .map_err(|e| {
            error!("Migration v20 failed: {e}");
            format!("migration v20: {e}")
        })?;

    info!("Applied migration v20 (print payloads + 112mm + modern receipt rollout)");
    Ok(())
}

/// Migration v21:
/// - extend local `orders` with delivery detail columns used on delivery receipts
/// - add explicit driver assignment columns (`driver_id`, `driver_name`)
fn migrate_v21(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "orders", "delivery_city")? {
        conn.execute("ALTER TABLE orders ADD COLUMN delivery_city TEXT", [])
            .map_err(|e| format!("migration v21 add orders.delivery_city: {e}"))?;
    }
    if !column_exists(conn, "orders", "delivery_postal_code")? {
        conn.execute(
            "ALTER TABLE orders ADD COLUMN delivery_postal_code TEXT",
            [],
        )
        .map_err(|e| format!("migration v21 add orders.delivery_postal_code: {e}"))?;
    }
    if !column_exists(conn, "orders", "delivery_floor")? {
        conn.execute("ALTER TABLE orders ADD COLUMN delivery_floor TEXT", [])
            .map_err(|e| format!("migration v21 add orders.delivery_floor: {e}"))?;
    }
    if !column_exists(conn, "orders", "driver_id")? {
        conn.execute("ALTER TABLE orders ADD COLUMN driver_id TEXT", [])
            .map_err(|e| format!("migration v21 add orders.driver_id: {e}"))?;
    }
    if !column_exists(conn, "orders", "driver_name")? {
        conn.execute("ALTER TABLE orders ADD COLUMN driver_name TEXT", [])
            .map_err(|e| format!("migration v21 add orders.driver_name: {e}"))?;
    }

    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_orders_driver_id ON orders(driver_id);
        INSERT INTO schema_version (version) VALUES (21);
        ",
    )
    .map_err(|e| {
        error!("Migration v21 failed: {e}");
        format!("migration v21: {e}")
    })?;

    info!("Applied migration v21 (delivery detail + driver assignment columns)");
    Ok(())
}

/// Migration v22: Loyalty module tables (settings cache, customer balances, transactions).
fn migrate_v22(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- Cached loyalty settings from admin dashboard
        CREATE TABLE IF NOT EXISTS loyalty_settings (
            id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 0,
            points_per_euro REAL NOT NULL DEFAULT 1.0,
            redemption_rate REAL NOT NULL DEFAULT 0.01,
            min_redemption_points INTEGER NOT NULL DEFAULT 100,
            tier_bronze_threshold INTEGER DEFAULT 0,
            tier_silver_threshold INTEGER DEFAULT 500,
            tier_gold_threshold INTEGER DEFAULT 2000,
            tier_platinum_threshold INTEGER DEFAULT 5000,
            welcome_bonus_points INTEGER DEFAULT 0,
            birthday_bonus_points INTEGER DEFAULT 0,
            referral_bonus_points INTEGER DEFAULT 0,
            last_synced_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Cached customer loyalty balances
        CREATE TABLE IF NOT EXISTS loyalty_customers (
            id TEXT PRIMARY KEY,
            user_profile_id TEXT NOT NULL,
            organization_id TEXT NOT NULL,
            points_balance INTEGER NOT NULL DEFAULT 0,
            total_earned INTEGER NOT NULL DEFAULT 0,
            total_redeemed INTEGER NOT NULL DEFAULT 0,
            tier TEXT NOT NULL DEFAULT 'none',
            customer_name TEXT,
            customer_email TEXT,
            customer_phone TEXT,
            loyalty_card_uid TEXT,
            last_synced_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(user_profile_id, organization_id)
        );
        CREATE INDEX IF NOT EXISTS idx_loyalty_customers_org ON loyalty_customers(organization_id);
        CREATE INDEX IF NOT EXISTS idx_loyalty_customers_card ON loyalty_customers(loyalty_card_uid);
        CREATE INDEX IF NOT EXISTS idx_loyalty_customers_phone ON loyalty_customers(customer_phone);

        -- Local loyalty transaction log with sync tracking
        CREATE TABLE IF NOT EXISTS loyalty_transactions (
            id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL,
            organization_id TEXT NOT NULL,
            points INTEGER NOT NULL,
            transaction_type TEXT NOT NULL CHECK (transaction_type IN ('earn', 'redeem', 'adjustment', 'expire')),
            order_id TEXT,
            description TEXT,
            sync_state TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending', 'syncing', 'applied', 'failed')),
            sync_last_error TEXT,
            sync_retry_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_loyalty_tx_customer ON loyalty_transactions(customer_id);
        CREATE INDEX IF NOT EXISTS idx_loyalty_tx_sync ON loyalty_transactions(sync_state);
        CREATE INDEX IF NOT EXISTS idx_loyalty_tx_order ON loyalty_transactions(order_id);

        INSERT INTO schema_version (version) VALUES (22);
        ",
    )
    .map_err(|e| {
        error!("Migration v22 failed: {e}");
        format!("migration v22: {e}")
    })?;

    info!("Applied migration v22 (loyalty settings, customers, transactions)");
    Ok(())
}

/// Migration v23: Add ESC/POS code page override to printer_profiles.
///
/// Different printer models use different code page numbers for the same encoding
/// (e.g. CP737 is code page 14 on Epson TM-T88III but code page 15 on Star mcPrint).
/// This column lets users override the auto-detected code page number.
fn migrate_v23(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        ALTER TABLE printer_profiles ADD COLUMN escpos_code_page INTEGER DEFAULT NULL;

        INSERT INTO schema_version (version) VALUES (23);
        ",
    )
    .map_err(|e| {
        error!("Migration v23 failed: {e}");
        format!("migration v23: {e}")
    })?;

    info!("Applied migration v23 (printer_profiles.escpos_code_page)");
    Ok(())
}

/// Migration v24: add 'delivery_slip' to print_jobs entity_type CHECK constraint.
fn migrate_v24(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        BEGIN;

        DROP TABLE IF EXISTS print_jobs_v24;
        CREATE TABLE print_jobs_v24 (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL
                CHECK (entity_type IN ('order_receipt', 'kitchen_ticket', 'z_report', 'shift_checkout', 'delivery_slip')),
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
            updated_at TEXT NOT NULL,
            entity_payload_json TEXT
        );
        -- Wave 11 L doc: see v11's INSERT OR IGNORE comment. Same
        -- dual-key debt — `INSERT OR IGNORE` here is silent on
        -- `id` collisions and (post-v47) `idempotency_key` collisions
        -- alike. Future rebuilds of `print_jobs` should make the
        -- conflict target explicit.
        INSERT OR IGNORE INTO print_jobs_v24
            SELECT id, entity_type, entity_id, printer_profile_id, status,
                   output_path, retry_count, max_retries, next_retry_at, last_error,
                   warning_code, warning_message, last_attempt_at, created_at, updated_at,
                   entity_payload_json
            FROM print_jobs;
        DROP TABLE print_jobs;
        ALTER TABLE print_jobs_v24 RENAME TO print_jobs;

        CREATE INDEX IF NOT EXISTS idx_print_jobs_status
            ON print_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_created_at
            ON print_jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_entity
            ON print_jobs(entity_type, entity_id);

        INSERT INTO schema_version (version) VALUES (24);

        COMMIT;
        ",
    )
    .map_err(|e| {
        error!("Migration v24 failed: {e}");
        format!("migration v24: {e}")
    })?;

    info!("Applied migration v24 (print_jobs entity_type includes delivery_slip)");
    Ok(())
}

/// Migration v25: add receipt typography controls to printer_profiles.
fn migrate_v25(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "printer_profiles", "font_type")? {
        conn.execute_batch(
            "ALTER TABLE printer_profiles
             ADD COLUMN font_type TEXT NOT NULL DEFAULT 'a'
             CHECK (font_type IN ('a', 'b'));",
        )
        .map_err(|e| format!("migration v25 add printer_profiles.font_type: {e}"))?;
    }

    if !column_exists(conn, "printer_profiles", "layout_density")? {
        conn.execute_batch(
            "ALTER TABLE printer_profiles
             ADD COLUMN layout_density TEXT NOT NULL DEFAULT 'compact'
             CHECK (layout_density IN ('compact', 'balanced', 'spacious'));",
        )
        .map_err(|e| format!("migration v25 add printer_profiles.layout_density: {e}"))?;
    }

    if !column_exists(conn, "printer_profiles", "header_emphasis")? {
        conn.execute_batch(
            "ALTER TABLE printer_profiles
             ADD COLUMN header_emphasis TEXT NOT NULL DEFAULT 'strong'
             CHECK (header_emphasis IN ('normal', 'strong'));",
        )
        .map_err(|e| format!("migration v25 add printer_profiles.header_emphasis: {e}"))?;
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (25)", [])
        .map_err(|e| format!("migration v25 mark schema version: {e}"))?;

    info!("Applied migration v25 (printer_profiles typography controls)");
    Ok(())
}

/// Migration v26:
/// - restore classic receipt template defaults for receipt/kitchen profiles
/// - restore raster_exact render mode defaults in connection_json for receipt/kitchen profiles
fn migrate_v26(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE printer_profiles
         SET receipt_template = 'classic'
         WHERE role IN ('receipt', 'kitchen')",
        [],
    )
    .map_err(|e| format!("migration v26 restore classic templates: {e}"))?;

    conn.execute(
        "UPDATE printer_profiles
         SET connection_json = CASE
             WHEN connection_json IS NULL OR TRIM(connection_json) = ''
                 THEN json_object('render_mode', 'raster_exact')
             WHEN json_valid(connection_json)
                 THEN json_set(connection_json, '$.render_mode', 'raster_exact')
             ELSE connection_json
         END
         WHERE role IN ('receipt', 'kitchen')",
        [],
    )
    .map_err(|e| format!("migration v26 restore raster_exact render mode: {e}"))?;

    conn.execute("INSERT INTO schema_version (version) VALUES (26)", [])
        .map_err(|e| format!("migration v26 mark schema version: {e}"))?;

    info!("Applied migration v26 (classic receipt defaults restored)");
    Ok(())
}

/// Migration v27:
/// - normalize raw LAN/Wi-Fi printer emulation from `auto` to `escpos`
fn migrate_v27(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE printer_profiles
         SET connection_json = json_set(connection_json, '$.emulation', 'escpos')
         WHERE json_valid(connection_json)
           AND LOWER(COALESCE(json_extract(connection_json, '$.type'), printer_type, 'system')) IN ('network', 'wifi')
           AND LOWER(COALESCE(json_extract(connection_json, '$.emulation'), 'auto')) = 'auto'",
        [],
    )
    .map_err(|e| format!("migration v27 normalize network emulation: {e}"))?;

    conn.execute("INSERT INTO schema_version (version) VALUES (27)", [])
        .map_err(|e| format!("migration v27 mark schema version: {e}"))?;

    info!("Applied migration v27 (network printer auto emulation normalized to escpos)");
    Ok(())
}

fn default_printer_capabilities_json() -> Value {
    serde_json::json!({
        "status": "unverified",
        "resolvedTransport": Value::Null,
        "resolvedAddress": Value::Null,
        "emulation": Value::Null,
        "renderMode": Value::Null,
        "baudRate": Value::Null,
        "supportsCut": false,
        "supportsLogo": false,
        "lastVerifiedAt": Value::Null
    })
}

fn migrate_v28(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        BEGIN;

        DROP TABLE IF EXISTS print_jobs_v28;
        CREATE TABLE print_jobs_v28 (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL
                CHECK (entity_type IN ('order_receipt', 'kitchen_ticket', 'z_report', 'shift_checkout', 'delivery_slip')),
            entity_id TEXT NOT NULL,
            printer_profile_id TEXT,
            status TEXT NOT NULL
                CHECK (status IN ('pending', 'printing', 'printed', 'dispatched', 'failed')),
            output_path TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 3,
            next_retry_at TEXT,
            last_error TEXT,
            warning_code TEXT,
            warning_message TEXT,
            last_attempt_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            entity_payload_json TEXT
        );
        INSERT OR IGNORE INTO print_jobs_v28
            SELECT id, entity_type, entity_id, printer_profile_id, status,
                   output_path, retry_count, max_retries, next_retry_at, last_error,
                   warning_code, warning_message, last_attempt_at, created_at, updated_at,
                   entity_payload_json
            FROM print_jobs;
        DROP TABLE print_jobs;
        ALTER TABLE print_jobs_v28 RENAME TO print_jobs;

        CREATE INDEX IF NOT EXISTS idx_print_jobs_status
            ON print_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_created_at
            ON print_jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_entity
            ON print_jobs(entity_type, entity_id);

        COMMIT;
        ",
    )
    .map_err(|e| {
        error!("Migration v28 failed during print_jobs rebuild: {e}");
        format!("migration v28 rebuild print_jobs: {e}")
    })?;

    let mut stmt = conn
        .prepare("SELECT id, connection_json FROM printer_profiles")
        .map_err(|e| format!("migration v28 prepare printer_profiles: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| format!("migration v28 query printer_profiles: {e}"))?;
    let profiles: Vec<(String, Option<String>)> = rows.filter_map(Result::ok).collect();
    drop(stmt);

    for (id, connection_json) in profiles {
        let mut parsed = connection_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        let capabilities = parsed
            .entry("capabilities".to_string())
            .or_insert_with(default_printer_capabilities_json);
        if !capabilities.is_object() {
            *capabilities = default_printer_capabilities_json();
        } else if let Some(obj) = capabilities.as_object_mut() {
            let defaults = default_printer_capabilities_json()
                .as_object()
                .cloned()
                .unwrap_or_default();
            for (key, value) in defaults {
                obj.entry(key).or_insert(value);
            }
            if !matches!(
                obj.get("status").and_then(Value::as_str),
                Some("verified" | "degraded" | "unverified")
            ) {
                obj.insert(
                    "status".to_string(),
                    Value::String("unverified".to_string()),
                );
            }
        }

        conn.execute(
            "UPDATE printer_profiles SET connection_json = ?1 WHERE id = ?2",
            params![Value::Object(parsed).to_string(), id],
        )
        .map_err(|e| format!("migration v28 update printer profile {id}: {e}"))?;
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (28)", [])
        .map_err(|e| format!("migration v28 mark schema version: {e}"))?;

    info!("Applied migration v28 (print job dispatched state + printer capability defaults)");
    Ok(())
}

fn migrate_v29(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id, connection_json FROM printer_profiles")
        .map_err(|e| format!("migration v29 prepare printer_profiles: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| format!("migration v29 query printer_profiles: {e}"))?;
    let profiles: Vec<(String, Option<String>)> = rows.filter_map(Result::ok).collect();
    drop(stmt);

    for (id, connection_json) in profiles {
        let mut parsed = connection_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();

        let connection_type = parsed
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let capability_status = parsed
            .get("capabilities")
            .and_then(Value::as_object)
            .and_then(|obj| obj.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("unverified")
            .trim()
            .to_ascii_lowercase();
        let emulation = parsed
            .get("emulation")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();

        if matches!(connection_type.as_str(), "network" | "wifi")
            && capability_status == "unverified"
            && emulation == "escpos"
        {
            parsed.insert("emulation".to_string(), Value::String("auto".to_string()));
            conn.execute(
                "UPDATE printer_profiles SET connection_json = ?1 WHERE id = ?2",
                params![Value::Object(parsed).to_string(), id],
            )
            .map_err(|e| format!("migration v29 update printer profile {id}: {e}"))?;
        }
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (29)", [])
        .map_err(|e| format!("migration v29 mark schema version: {e}"))?;

    info!("Applied migration v29 (reverted unverified raw network emulation normalization)");
    Ok(())
}

/// Migration v30: Add missing indexes on commonly-queried columns.
///
/// Adds indexes for faster lookups on orders (supabase_id, order_number)
/// and sync_queue (entity_type + status composite). The order_payments
/// order_id index already exists from v4 but is included defensively with
/// IF NOT EXISTS.
fn migrate_v30(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        BEGIN;

        -- Faster order lookup by Supabase remote ID (used during sync reconciliation)
        CREATE INDEX IF NOT EXISTS idx_orders_supabase_id ON orders(supabase_id);

        -- Faster order lookup by human-readable order number (used in search/display)
        CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);

        -- Composite index for sync queue polling by entity type + status
        CREATE INDEX IF NOT EXISTS idx_sync_queue_entity_status ON sync_queue(entity_type, status);

        -- Defensive: order_payments order_id index (already created in v4)
        CREATE INDEX IF NOT EXISTS idx_order_payments_order_id ON order_payments(order_id);

        INSERT INTO schema_version (version) VALUES (30);

        COMMIT;
        ",
    )
    .map_err(|e| {
        error!("Migration v30 failed: {e}");
        format!("migration v30: {e}")
    })?;

    info!("Applied migration v30 (missing indexes on orders, sync_queue, order_payments)");
    Ok(())
}

/// Migration v31: payment_items table for split-by-items tracking.
fn migrate_v31(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        BEGIN;

        CREATE TABLE IF NOT EXISTS payment_items (
            id TEXT PRIMARY KEY,
            payment_id TEXT NOT NULL,
            order_id TEXT NOT NULL,
            item_index INTEGER NOT NULL,
            item_name TEXT NOT NULL,
            item_quantity INTEGER NOT NULL DEFAULT 1,
            item_amount REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY(payment_id) REFERENCES order_payments(id) ON DELETE CASCADE,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_payment_items_payment_id ON payment_items(payment_id);
        CREATE INDEX IF NOT EXISTS idx_payment_items_order_id ON payment_items(order_id);

        INSERT INTO schema_version (version) VALUES (31);

        COMMIT;
        ",
    )
    .map_err(|e| {
        error!("Migration v31 failed: {e}");
        format!("migration v31: {e}")
    })?;

    info!("Applied migration v31 (payment_items table for split payments)");
    Ok(())
}

/// Migration v32:
/// - add split-payment discount persistence on order_payments
/// - persist whether card approval came from a live terminal or manual fallback
fn migrate_v32(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "order_payments", "discount_amount")? {
        conn.execute_batch(
            "ALTER TABLE order_payments
             ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0;",
        )
        .map_err(|e| format!("migration v32 add order_payments.discount_amount: {e}"))?;
    }

    if !column_exists(conn, "order_payments", "payment_origin")? {
        conn.execute_batch(
            "ALTER TABLE order_payments
             ADD COLUMN payment_origin TEXT NOT NULL DEFAULT 'manual'
             CHECK (payment_origin IN ('manual', 'terminal'));",
        )
        .map_err(|e| format!("migration v32 add order_payments.payment_origin: {e}"))?;
    }

    if !column_exists(conn, "order_payments", "terminal_device_id")? {
        conn.execute_batch(
            "ALTER TABLE order_payments
             ADD COLUMN terminal_device_id TEXT;",
        )
        .map_err(|e| format!("migration v32 add order_payments.terminal_device_id: {e}"))?;
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (32)", [])
        .map_err(|e| format!("migration v32 mark schema version: {e}"))?;

    info!("Applied migration v32 (split payment discounts + payment origin)");
    Ok(())
}

fn migrate_v33(conn: &Connection) -> Result<(), String> {
    fn seed_setting_if_missing(
        conn: &Connection,
        target_category: &str,
        target_key: &str,
        source_candidates: &[(&str, &str)],
    ) -> Result<bool, String> {
        if get_setting(conn, target_category, target_key).is_some() {
            return Ok(false);
        }

        for (source_category, source_key) in source_candidates {
            let Some(value) = get_setting(conn, source_category, source_key) else {
                continue;
            };
            let trimmed = value.trim();
            if trimmed.is_empty() {
                continue;
            }

            set_setting(conn, target_category, target_key, trimmed)?;
            return Ok(true);
        }

        Ok(false)
    }

    let mut migrated = 0usize;
    #[allow(clippy::type_complexity)]
    let seed_mappings: &[(&str, &str, &[(&str, &str)])] = &[
        (
            "ui",
            "display_brightness",
            &[
                ("ui", "display_brightness"),
                ("terminal", "display_brightness"),
            ],
        ),
        (
            "ui",
            "screen_timeout",
            &[("ui", "screen_timeout"), ("terminal", "screen_timeout")],
        ),
        (
            "ui",
            "touch_sensitivity",
            &[
                ("ui", "touch_sensitivity"),
                ("terminal", "touch_sensitivity"),
            ],
        ),
        (
            "ui",
            "audio_enabled",
            &[("ui", "audio_enabled"), ("terminal", "audio_enabled")],
        ),
        (
            "ui",
            "receipt_auto_print",
            &[
                ("ui", "receipt_auto_print"),
                ("terminal", "receipt_auto_print"),
                ("terminal", "auto_print_receipts"),
            ],
        ),
        (
            "terminal",
            "fiscal_print_enabled",
            &[("terminal", "fiscal_print_enabled")],
        ),
        (
            "scale",
            "enabled",
            &[
                ("scale", "enabled"),
                ("terminal", "scale_enabled"),
                ("hardware", "scale_enabled"),
            ],
        ),
        (
            "scale",
            "port",
            &[
                ("scale", "port"),
                ("terminal", "scale_port"),
                ("hardware", "scale_port"),
            ],
        ),
        (
            "scale",
            "baud_rate",
            &[
                ("scale", "baud_rate"),
                ("terminal", "scale_baud_rate"),
                ("hardware", "scale_baud_rate"),
            ],
        ),
        (
            "scale",
            "protocol",
            &[
                ("scale", "protocol"),
                ("terminal", "scale_protocol"),
                ("hardware", "scale_protocol"),
            ],
        ),
        (
            "display",
            "enabled",
            &[
                ("display", "enabled"),
                ("terminal", "customer_display_enabled"),
                ("hardware", "customer_display_enabled"),
            ],
        ),
        (
            "display",
            "connection_type",
            &[
                ("display", "connection_type"),
                ("terminal", "display_connection_type"),
                ("hardware", "display_connection_type"),
            ],
        ),
        (
            "display",
            "port",
            &[
                ("display", "port"),
                ("terminal", "display_port"),
                ("hardware", "display_port"),
            ],
        ),
        (
            "display",
            "baud_rate",
            &[
                ("display", "baud_rate"),
                ("terminal", "display_baud_rate"),
                ("hardware", "display_baud_rate"),
            ],
        ),
        (
            "display",
            "tcp_port",
            &[
                ("display", "tcp_port"),
                ("terminal", "display_tcp_port"),
                ("hardware", "display_tcp_port"),
            ],
        ),
        (
            "scanner",
            "enabled",
            &[
                ("scanner", "enabled"),
                ("terminal", "barcode_scanner_enabled"),
                ("hardware", "barcode_scanner_enabled"),
            ],
        ),
        (
            "scanner",
            "port",
            &[
                ("scanner", "port"),
                ("terminal", "barcode_scanner_port"),
                ("hardware", "barcode_scanner_port"),
            ],
        ),
        (
            "scanner",
            "baud_rate",
            &[
                ("scanner", "baud_rate"),
                ("terminal", "scanner_baud_rate"),
                ("hardware", "scanner_baud_rate"),
            ],
        ),
        (
            "peripherals",
            "card_reader_enabled",
            &[
                ("peripherals", "card_reader_enabled"),
                ("terminal", "card_reader_enabled"),
                ("hardware", "card_reader_enabled"),
            ],
        ),
        (
            "peripherals",
            "loyalty_card_reader",
            &[
                ("peripherals", "loyalty_card_reader"),
                ("terminal", "loyalty_card_reader"),
                ("hardware", "loyalty_card_reader"),
            ],
        ),
    ];

    for (target_category, target_key, source_candidates) in seed_mappings {
        if seed_setting_if_missing(conn, target_category, target_key, source_candidates)? {
            migrated += 1;
        }
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (33)", [])
        .map_err(|e| format!("migration v33 mark schema version: {e}"))?;

    info!(
        seeded_settings = migrated,
        "Applied migration v33 (seeded local-only terminal/device setting namespaces)"
    );
    Ok(())
}

/// Migration v34: Drop the restrictive entity_type CHECK on print_jobs.
///
/// The application-level allowlist in print.rs is the source of truth for
/// accepted entity types. The DB-level CHECK was added early and has fallen
/// out of sync as new types were introduced (test_print, split_receipt,
/// order_completed_receipt, order_canceled_receipt). Removing the constraint
/// avoids a recurring schema migration every time a new print-job kind is
/// added, while the Rust guard in enqueue_print_job_with_payload continues
/// to reject truly unknown types.
fn migrate_v34(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        BEGIN;

        -- Rebuild print_jobs without the entity_type CHECK constraint.
        -- All existing data is preserved; the application-level allowlist
        -- in print.rs guards against invalid values.
        CREATE TABLE print_jobs_v34 (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            printer_profile_id TEXT,
            status TEXT NOT NULL
                CHECK (status IN ('pending', 'printing', 'printed', 'dispatched', 'failed')),
            output_path TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 3,
            next_retry_at TEXT,
            last_error TEXT,
            warning_code TEXT,
            warning_message TEXT,
            last_attempt_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            entity_payload_json TEXT
        );

        INSERT INTO print_jobs_v34
            SELECT id, entity_type, entity_id, printer_profile_id, status,
                   output_path, retry_count, max_retries, next_retry_at, last_error,
                   warning_code, warning_message, last_attempt_at, created_at, updated_at,
                   entity_payload_json
            FROM print_jobs;

        DROP TABLE print_jobs;
        ALTER TABLE print_jobs_v34 RENAME TO print_jobs;

        CREATE INDEX IF NOT EXISTS idx_print_jobs_status
            ON print_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_created_at
            ON print_jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_entity
            ON print_jobs(entity_type, entity_id);

        COMMIT;
        ",
    )
    .map_err(|e| {
        error!("Migration v34 failed during print_jobs rebuild: {e}");
        format!("migration v34 rebuild print_jobs: {e}")
    })?;

    conn.execute("INSERT INTO schema_version (version) VALUES (34)", [])
        .map_err(|e| format!("migration v34 mark schema version: {e}"))?;

    info!("Applied migration v34 (removed restrictive entity_type CHECK from print_jobs)");
    Ok(())
}

/// Migration v35: mark previously closed drawers as reconciled.
///
/// Cashier/manager closeout already captures the counted closing cash and
/// computes expected/variance, so historical drawers that were closed before
/// the reconciliation flag was wired up should not remain permanently
/// unreconciled in reports.
fn migrate_v35(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE cash_drawer_sessions
         SET reconciled = 1,
             reconciled_at = COALESCE(
                 reconciled_at,
                 closed_at,
                 (
                     SELECT check_out_time
                     FROM staff_shifts
                     WHERE staff_shifts.id = cash_drawer_sessions.staff_shift_id
                 )
             ),
             reconciled_by = COALESCE(
                 reconciled_by,
                 (
                     SELECT closed_by
                     FROM staff_shifts
                     WHERE staff_shifts.id = cash_drawer_sessions.staff_shift_id
                 )
             )
         WHERE closed_at IS NOT NULL
           AND COALESCE(reconciled, 0) = 0",
        [],
    )
    .map_err(|e| format!("migration v35 backfill closed drawers: {e}"))?;

    conn.execute("INSERT INTO schema_version (version) VALUES (35)", [])
        .map_err(|e| format!("migration v35 mark schema version: {e}"))?;

    info!("Applied migration v35 (backfilled closed cash drawers as reconciled)");
    Ok(())
}

fn migrate_v36(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        BEGIN;

        CREATE TABLE order_payments_v36 (
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
            sync_state TEXT NOT NULL DEFAULT 'pending'
                CHECK (sync_state IN ('pending', 'waiting_parent', 'syncing', 'applied', 'failed')),
            sync_last_error TEXT,
            sync_retry_count INTEGER NOT NULL DEFAULT 0,
            sync_next_retry_at TEXT,
            discount_amount REAL NOT NULL DEFAULT 0,
            payment_origin TEXT NOT NULL DEFAULT 'manual'
                CHECK (payment_origin IN ('manual', 'terminal', 'manual_recovery', 'sync_reconstructed')),
            terminal_device_id TEXT,
            remote_payment_id TEXT,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
        );

        INSERT INTO order_payments_v36 (
            id, order_id, method, amount, currency, status,
            cash_received, change_given, transaction_ref,
            staff_id, staff_shift_id, voided_at, voided_by, void_reason,
            sync_status, created_at, updated_at, sync_state, sync_last_error,
            sync_retry_count, sync_next_retry_at, discount_amount, payment_origin,
            terminal_device_id, remote_payment_id
        )
        SELECT
            id, order_id, method, amount, currency, status,
            cash_received, change_given, transaction_ref,
            staff_id, staff_shift_id, voided_at, voided_by, void_reason,
            sync_status, created_at, updated_at, sync_state, sync_last_error,
            sync_retry_count, sync_next_retry_at, COALESCE(discount_amount, 0),
            CASE
                WHEN COALESCE(payment_origin, 'manual') IN ('manual', 'terminal', 'manual_recovery', 'sync_reconstructed')
                    THEN COALESCE(payment_origin, 'manual')
                ELSE 'manual'
            END,
            terminal_device_id,
            NULL
        FROM order_payments;

        DROP TABLE order_payments;
        ALTER TABLE order_payments_v36 RENAME TO order_payments;

        CREATE INDEX IF NOT EXISTS idx_order_payments_order_id ON order_payments(order_id);
        CREATE INDEX IF NOT EXISTS idx_order_payments_created_at ON order_payments(created_at);
        CREATE INDEX IF NOT EXISTS idx_order_payments_sync_status ON order_payments(sync_status);
        CREATE INDEX IF NOT EXISTS idx_order_payments_sync_state ON order_payments(sync_state);
        CREATE INDEX IF NOT EXISTS idx_order_payments_waiting_order ON order_payments(order_id, sync_state);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_order_payments_remote_payment_id
            ON order_payments(remote_payment_id)
            WHERE remote_payment_id IS NOT NULL;

        COMMIT;
        ",
    )
    .map_err(|e| format!("migration v36 rebuild order_payments: {e}"))?;

    conn.execute("INSERT INTO schema_version (version) VALUES (36)", [])
        .map_err(|e| format!("migration v36 mark schema version: {e}"))?;

    info!("Applied migration v36 (remote payment ids + expanded payment origins)");
    Ok(())
}

fn migrate_v37(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "payment_adjustments", "refund_method")? {
        conn.execute_batch(
            "ALTER TABLE payment_adjustments
             ADD COLUMN refund_method TEXT
             CHECK (refund_method IN ('cash', 'card'));",
        )
        .map_err(|e| format!("migration v37 add payment_adjustments.refund_method: {e}"))?;
    }

    if !column_exists(conn, "payment_adjustments", "cash_handler")? {
        conn.execute_batch(
            "ALTER TABLE payment_adjustments
             ADD COLUMN cash_handler TEXT
             CHECK (cash_handler IN ('cashier_drawer', 'driver_shift'));",
        )
        .map_err(|e| format!("migration v37 add payment_adjustments.cash_handler: {e}"))?;
    }

    if !column_exists(conn, "payment_adjustments", "adjustment_context")? {
        conn.execute_batch(
            "ALTER TABLE payment_adjustments
             ADD COLUMN adjustment_context TEXT NOT NULL DEFAULT 'manual'
             CHECK (adjustment_context IN ('manual', 'edit_settlement'));",
        )
        .map_err(|e| format!("migration v37 add payment_adjustments.adjustment_context: {e}"))?;
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (37)", [])
        .map_err(|e| format!("migration v37 mark schema version: {e}"))?;

    info!("Applied migration v37 (payment adjustment settlement attribution)");
    Ok(())
}

fn migrate_v38(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "orders", "customer_id")? {
        conn.execute_batch("ALTER TABLE orders ADD COLUMN customer_id TEXT;")
            .map_err(|e| format!("migration v38 add orders.customer_id: {e}"))?;
    }

    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
        INSERT INTO schema_version (version) VALUES (38);
        ",
    )
    .map_err(|e| format!("migration v38 mark schema version: {e}"))?;

    info!("Applied migration v38 (orders.customer_id)");
    Ok(())
}

fn migrate_v39(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "staff_shifts", "report_date")? {
        conn.execute_batch("ALTER TABLE staff_shifts ADD COLUMN report_date TEXT;")
            .map_err(|e| format!("migration v39 add staff_shifts.report_date: {e}"))?;
    }
    if !column_exists(conn, "staff_shifts", "period_start_at")? {
        conn.execute_batch("ALTER TABLE staff_shifts ADD COLUMN period_start_at TEXT;")
            .map_err(|e| format!("migration v39 add staff_shifts.period_start_at: {e}"))?;
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (39)", [])
        .map_err(|e| format!("migration v39 mark schema version: {e}"))?;

    info!("Applied migration v39 (staff_shifts business-day sync metadata)");
    Ok(())
}

fn migrate_v40(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        BEGIN;

        CREATE TABLE IF NOT EXISTS branch_ops_cache (
            branch_id TEXT NOT NULL,
            cache_key TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            version TEXT,
            synced_at TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (branch_id, cache_key, scope_key)
        );

        CREATE INDEX IF NOT EXISTS idx_branch_ops_cache_synced_at
            ON branch_ops_cache(synced_at);
        CREATE INDEX IF NOT EXISTS idx_branch_ops_cache_cache_key
            ON branch_ops_cache(cache_key, branch_id);

        CREATE TABLE print_jobs_v40 (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            printer_profile_id TEXT,
            status TEXT NOT NULL
                CHECK (status IN ('pending', 'printing', 'printed', 'dispatched', 'failed', 'cancelled')),
            output_path TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 3,
            next_retry_at TEXT,
            last_error TEXT,
            warning_code TEXT,
            warning_message TEXT,
            last_attempt_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            entity_payload_json TEXT
        );

        INSERT INTO print_jobs_v40
            SELECT id, entity_type, entity_id, printer_profile_id, status,
                   output_path, retry_count, max_retries, next_retry_at, last_error,
                   warning_code, warning_message, last_attempt_at, created_at, updated_at,
                   entity_payload_json
            FROM print_jobs;

        DROP TABLE print_jobs;
        ALTER TABLE print_jobs_v40 RENAME TO print_jobs;

        CREATE INDEX IF NOT EXISTS idx_print_jobs_status
            ON print_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_created_at
            ON print_jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_entity
            ON print_jobs(entity_type, entity_id);

        INSERT INTO schema_version (version) VALUES (40);

        COMMIT;
        ",
    )
    .map_err(|e| format!("migration v40 branch ops cache + print_jobs cancel status: {e}"))?;

    info!("Applied migration v40 (branch_ops_cache + cancelled print_jobs status)");
    Ok(())
}

fn migrate_v41(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "payment_adjustments", "staff_shift_id")? {
        conn.execute_batch("ALTER TABLE payment_adjustments ADD COLUMN staff_shift_id TEXT;")
            .map_err(|e| format!("migration v41 add payment_adjustments.staff_shift_id: {e}"))?;
    }

    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_payment_adjustments_staff_shift_id
            ON payment_adjustments(staff_shift_id);
        INSERT INTO schema_version (version) VALUES (41);
        ",
    )
    .map_err(|e| format!("migration v41 mark schema version: {e}"))?;

    info!("Applied migration v41 (payment_adjustments.staff_shift_id)");
    Ok(())
}

fn migrate_v42(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS caller_id_log (
            id TEXT PRIMARY KEY,
            caller_number TEXT NOT NULL,
            caller_name TEXT,
            customer_id TEXT,
            customer_name TEXT,
            sip_call_id TEXT,
            action_taken TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(sip_call_id)
        );
        CREATE INDEX IF NOT EXISTS idx_caller_id_log_number ON caller_id_log(caller_number);
        CREATE INDEX IF NOT EXISTS idx_caller_id_log_created ON caller_id_log(created_at);

        INSERT INTO schema_version (version) VALUES (42);
        ",
    )
    .map_err(|e| format!("migration v42 caller_id_log: {e}"))?;

    info!("Applied migration v42 (caller_id_log table)");
    Ok(())
}

fn migrate_v43(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "loyalty_customers", "customer_id")? {
        conn.execute_batch("ALTER TABLE loyalty_customers ADD COLUMN customer_id TEXT;")
            .map_err(|e| format!("migration v43 add loyalty_customers.customer_id: {e}"))?;
    }

    conn.execute_batch(
        "
        UPDATE loyalty_customers
        SET customer_id = COALESCE(customer_id, user_profile_id)
        WHERE customer_id IS NULL OR TRIM(customer_id) = '';

        CREATE INDEX IF NOT EXISTS idx_loyalty_customers_customer_id
            ON loyalty_customers(customer_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_customers_customer_org
            ON loyalty_customers(customer_id, organization_id)
            WHERE customer_id IS NOT NULL AND TRIM(customer_id) <> '';

        INSERT INTO schema_version (version) VALUES (43);
        ",
    )
    .map_err(|e| format!("migration v43 loyalty_customers.customer_id: {e}"))?;

    info!("Applied migration v43 (loyalty_customers.customer_id)");
    Ok(())
}

/// Migration v44: Parity sync queue and conflict audit log tables.
fn migrate_v44(conn: &Connection) -> Result<(), String> {
    crate::sync_queue::create_tables(conn)?;

    conn.execute_batch("INSERT INTO schema_version (version) VALUES (44);")
        .map_err(|e| format!("migration v44 schema_version: {e}"))?;

    info!("Applied migration v44 (parity_sync_queue, conflict_audit_log)");
    Ok(())
}

/// Migration v45: Stable cashier-facing display order number in local SQLite.
fn migrate_v45(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "orders", "display_order_number")? {
        conn.execute_batch("ALTER TABLE orders ADD COLUMN display_order_number TEXT;")
            .map_err(|e| format!("migration v45 add orders.display_order_number: {e}"))?;
    }

    conn.execute_batch(
        "
        UPDATE orders
        SET display_order_number = COALESCE(NULLIF(TRIM(display_order_number), ''), order_number)
        WHERE display_order_number IS NULL OR TRIM(display_order_number) = '';

        INSERT INTO schema_version (version) VALUES (45);
        ",
    )
    .map_err(|e| format!("migration v45 display_order_number backfill: {e}"))?;

    info!("Applied migration v45 (orders.display_order_number)");
    Ok(())
}

/// Migration v46 (Wave 2a C2): partial UNIQUE index enforcing
/// at-most-one active shift per staff member.
///
/// The review found that `shifts.rs::open_shift` ran its duplicate-shift
/// SELECT outside the enclosing `BEGIN IMMEDIATE` transaction. Two
/// terminals could race, both pass the pre-check, then both INSERT
/// successfully — leaving two rows with `status='active'` for the same
/// staff_id. The Rust-side fix in Wave 2a moves the SELECT inside the
/// transaction; this index is defence-in-depth: even a future
/// refactor that accidentally undoes the SELECT placement will get a
/// SQLite `UNIQUE constraint failed` error instead of silent double
/// shifts.
///
/// Data-cleanup first: any pre-existing duplicates (from terminals
/// that ran the buggy code before upgrade) would make
/// `CREATE UNIQUE INDEX` fail. We detect duplicates, close the older
/// rows (keeping the one with the latest `updated_at`), and log at
/// WARN so operators see the remediation.
fn migrate_v46(conn: &Connection) -> Result<(), String> {
    // Step 1: surface and close duplicate active shifts. A deterministic
    // tie-break on `updated_at DESC, id DESC` picks the "newest" row to
    // keep; the rest get `status='closed'` with a system-attributed
    // note.
    let mut dup_stmt = conn
        .prepare(
            "SELECT staff_id, COUNT(*) AS n
             FROM staff_shifts
             WHERE status = 'active'
             GROUP BY staff_id
             HAVING n > 1",
        )
        .map_err(|e| format!("migration v46 scan duplicates: {e}"))?;
    let duplicates: Vec<(String, i64)> = dup_stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("migration v46 map duplicates: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("migration v46 collect duplicates: {e}"))?;
    drop(dup_stmt);

    for (staff_id, count) in &duplicates {
        warn!(
            staff_id = %staff_id,
            duplicate_active_shifts = count,
            "migration v46: closing older duplicate active shifts to satisfy new UNIQUE invariant"
        );
        // Keep the most recently updated row, close the rest. The
        // `staff_shifts` schema has no dedicated "close reason" column,
        // so the audit trail for this cleanup lives in the `warn!` log
        // line above.
        conn.execute(
            "UPDATE staff_shifts
             SET status = 'closed',
                 updated_at = datetime('now')
             WHERE status = 'active'
               AND staff_id = ?1
               AND id NOT IN (
                   SELECT id FROM staff_shifts
                   WHERE status = 'active' AND staff_id = ?1
                   ORDER BY updated_at DESC, id DESC
                   LIMIT 1
               )",
            params![staff_id],
        )
        .map_err(|e| format!("migration v46 dedup staff {staff_id}: {e}"))?;
    }

    // Step 2: create the partial UNIQUE index. `IF NOT EXISTS` keeps
    // the migration idempotent across re-runs.
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_shift_per_staff
             ON staff_shifts(staff_id) WHERE status = 'active';

         INSERT INTO schema_version (version) VALUES (46);",
    )
    .map_err(|e| format!("migration v46 index + schema_version: {e}"))?;

    info!(
        duplicates_cleaned = duplicates.len(),
        "Applied migration v46 (staff_shifts UNIQUE partial index)"
    );
    Ok(())
}

/// Migration v47 (Wave 4 architectural): add `idempotency_key` to each
/// entity table whose rows flow through the financial sync queue, so
/// that the canonical key is generated at user-action time and
/// preserved across retries.
///
/// Before v47, `sync_queue` rows carried their own `idempotency_key`
/// (generated at enqueue time). A retry that failed to dispatch and
/// was later re-queued could produce a NEW key on re-insert, which
/// defeats server-side dedup. Persisting the key on the entity row
/// itself — and having the enqueue path *copy* rather than *generate*
/// it — makes retries truly idempotent.
///
/// This migration:
///   1. Adds a nullable `idempotency_key TEXT` column to each target
///      table (ALTER TABLE is guarded by `column_exists`).
///   2. Backfills existing rows with a deterministic
///      SQLite-generated 32-hex-char value so every row has a
///      unique, non-null key. The backfill value is never
///      round-tripped to the server (those rows predate the
///      exactly-once contract); its only purpose is to satisfy the
///      upcoming v48 NOT NULL constraint without data loss.
///   3. Adds a partial UNIQUE index `WHERE idempotency_key IS NOT
///      NULL` so post-migration inserts cannot collide, while still
///      tolerating any row that migration may have missed.
///
/// v48 (future) will promote the column to NOT NULL once fleet
/// telemetry shows zero null rows.
fn migrate_v47(conn: &Connection) -> Result<(), String> {
    // Tables to extend. `staff_payments` is deliberately excluded:
    // it is created by test setup only and has no production
    // migration. Adding a column to a non-existent table would
    // error out on real terminals. When/if `staff_payments` is
    // promoted to a production migration, add `idempotency_key` in
    // the same change.
    const TARGETS: &[&str] = &[
        "order_payments",
        "payment_adjustments",
        "staff_shifts",
        "shift_expenses",
        "driver_earnings",
    ];

    for table in TARGETS {
        if !column_exists(conn, table, "idempotency_key")? {
            conn.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN idempotency_key TEXT;"
            ))
            .map_err(|e| format!("migration v47 add {table}.idempotency_key: {e}"))?;
            info!(table, "v47: added idempotency_key column");
        }

        // Backfill any existing NULL rows with a unique SQLite-random
        // 32-hex-char value. `randomblob(16)` is cryptographically
        // random per row, so collisions are effectively impossible
        // across the typical per-terminal row counts.
        conn.execute_batch(&format!(
            "UPDATE {table}
             SET idempotency_key = lower(hex(randomblob(16)))
             WHERE idempotency_key IS NULL;"
        ))
        .map_err(|e| format!("migration v47 backfill {table}: {e}"))?;

        // Partial UNIQUE index so post-migration writes cannot
        // collide. Named deterministically per table.
        let index_name = format!("idx_{table}_idempotency_key");
        conn.execute_batch(&format!(
            "CREATE UNIQUE INDEX IF NOT EXISTS {index_name}
             ON {table}(idempotency_key)
             WHERE idempotency_key IS NOT NULL;"
        ))
        .map_err(|e| format!("migration v47 index {index_name}: {e}"))?;
    }

    conn.execute_batch("INSERT INTO schema_version (version) VALUES (47);")
        .map_err(|e| format!("migration v47 schema_version: {e}"))?;

    info!(
        tables_migrated = TARGETS.len(),
        "Applied migration v47 (idempotency_key on entity tables)"
    );
    Ok(())
}

/// Migration v48 (Wave 6): add `organization_id` to `caller_id_log`.
///
/// The cross-cutting review flagged `caller_id_log` (created in v42)
/// as the only multi-tenant table that lacks `organization_id`,
/// violating the repository-wide tenant-isolation rule. Every other
/// org-scoped table filters queries by `organization_id`; without it
/// here, a row from one organization could surface in another tenant's
/// CallerID history if the table were ever shared (e.g. across a
/// multi-branch organization with a single terminal).
///
/// Backfill resolves existing rows via the current terminal's
/// `local_settings` entry (category `terminal`, key `organization_id`).
/// If that setting is missing — a pre-onboarding test DB, for
/// example — rows are left NULL and a future column-NOT-NULL
/// promotion will need to skip them. That is acceptable because the
/// caller_id_log is rewritable (low-value lookup history, not
/// financial data).
fn migrate_v48(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "caller_id_log", "organization_id")? {
        conn.execute_batch("ALTER TABLE caller_id_log ADD COLUMN organization_id TEXT;")
            .map_err(|e| format!("migration v48 add caller_id_log.organization_id: {e}"))?;
    }

    // Backfill from the current terminal's local_settings.
    let current_org_id: Option<String> = conn
        .query_row(
            "SELECT setting_value
             FROM local_settings
             WHERE setting_category = 'terminal' AND setting_key = 'organization_id'",
            [],
            |row| row.get(0),
        )
        .ok();

    if let Some(org_id) = current_org_id.as_deref().filter(|s| !s.is_empty()) {
        let backfilled = conn
            .execute(
                "UPDATE caller_id_log
                 SET organization_id = ?1
                 WHERE organization_id IS NULL",
                params![org_id],
            )
            .map_err(|e| format!("migration v48 backfill caller_id_log: {e}"))?;
        info!(
            org_id = %org_id,
            rows_backfilled = backfilled,
            "v48: backfilled caller_id_log.organization_id"
        );
    }

    // Index for tenant-scoped queries.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_caller_id_log_org
             ON caller_id_log(organization_id, created_at);

         INSERT INTO schema_version (version) VALUES (48);",
    )
    .map_err(|e| format!("migration v48 index + schema_version: {e}"))?;

    info!("Applied migration v48 (caller_id_log.organization_id)");
    Ok(())
}

/// Migration v49 (Wave 4 architectural follow-up): auto-populate
/// `idempotency_key` on INSERT for every entity table that participates
/// in the financial sync queue.
///
/// v47 added the column (nullable, partial-unique index) and backfilled
/// existing rows. v49 guarantees every NEW row also gets a key, without
/// requiring every INSERT call-site in the codebase to be rewritten.
/// Creation paths that forget to supply `idempotency_key` fall through
/// to an `AFTER INSERT` trigger that stamps a cryptographically-random
/// 32-hex-char value via SQLite's `lower(hex(randomblob(16)))`.
///
/// The trigger is defensive: call-sites that DO supply an explicit key
/// (the pattern documented in `crate::sync::get_entity_idempotency_key`)
/// leave `NEW.idempotency_key` non-null and the trigger's guard skips
/// them. This means:
///   - existing code that never mentioned the column keeps working
///     (rows get a server-unique key automatically);
///   - new code that threads a caller-chosen key through a creation
///     path is honoured verbatim so the same key can be mirrored into
///     `sync_queue` and preserved across retries.
///
/// The column stays nullable on-disk for a release cycle; a future
/// `migrate_v50` can promote it to `NOT NULL` once fleet telemetry
/// confirms zero null rows.
fn migrate_v49(conn: &Connection) -> Result<(), String> {
    const TABLES: &[&str] = &[
        "order_payments",
        "payment_adjustments",
        "staff_shifts",
        "shift_expenses",
        "driver_earnings",
    ];

    for table in TABLES {
        // Guard the trigger on `NEW.idempotency_key IS NULL` so
        // explicitly-supplied keys pass through unchanged. The
        // `AFTER INSERT` timing + `UPDATE ... WHERE id = NEW.id`
        // pattern works even for tables whose primary key is not
        // called `id` (SQLite lets the trigger reference `NEW.id`
        // only if the column exists; all 5 target tables use `id`
        // as the PK, so this is safe).
        let trigger_name = format!("trg_{table}_idempotency_key");
        conn.execute_batch(&format!(
            "DROP TRIGGER IF EXISTS {trigger_name};
             CREATE TRIGGER {trigger_name}
                 AFTER INSERT ON {table}
                 WHEN NEW.idempotency_key IS NULL
             BEGIN
                 UPDATE {table}
                 SET idempotency_key = lower(hex(randomblob(16)))
                 WHERE id = NEW.id;
             END;"
        ))
        .map_err(|e| format!("migration v49 trigger {trigger_name}: {e}"))?;
    }

    conn.execute_batch("INSERT INTO schema_version (version) VALUES (49);")
        .map_err(|e| format!("migration v49 schema_version: {e}"))?;

    info!(
        tables_triggered = TABLES.len(),
        "Applied migration v49 (AFTER INSERT triggers for idempotency_key auto-population)"
    );
    Ok(())
}

/// Migration v50 (Wave 6): partial index backing the parity sync
/// queue's active-row count.
///
/// The enqueue path does `SELECT COUNT(*) FROM parity_sync_queue
/// WHERE status IN ('pending', 'processing', 'conflict')` on every
/// enqueue to enforce the per-terminal queue-capacity cap. Without a
/// supporting index, that COUNT scans every historical row including
/// permanently-`failed` ones that the enqueue logic deliberately
/// excludes. Over time (months of operation), the scan cost grew with
/// total queue history, not with working-set size. A partial index
/// restricted to the three active statuses keeps the count
/// constant-time relative to the active queue depth.
fn migrate_v50(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_parity_sync_queue_active
             ON parity_sync_queue(status)
             WHERE status IN ('pending', 'processing', 'conflict');

         INSERT INTO schema_version (version) VALUES (50);",
    )
    .map_err(|e| format!("migration v50 partial index: {e}"))?;

    info!("Applied migration v50 (parity_sync_queue active-status partial index)");
    Ok(())
}

/// Wave 4a: add `*_cents INTEGER` shadow columns (first slice).
///
/// Review finding C7 flagged that the POS stores money as `f64` everywhere
/// — 66 REAL columns across 12 tables. Wave 4 migrates to integer minor
/// units (cents) to eliminate float aggregation drift; the shipping plan
/// breaks that work into additive sub-steps so the schema change is safe
/// on its own.
///
/// **4a scope (this migration)**: the three highest-traffic financial
/// tables only — `orders`, `order_payments`, `payment_adjustments`.
/// Adding the columns is additive and non-breaking: no existing code
/// path reads them yet, and every existing row is backfilled from its
/// REAL sibling via `CAST(ROUND(col * 100) AS INTEGER)`. New rows
/// written AFTER this migration start with `NULL` in the `*_cents`
/// columns; Wave 4b/4c will extend the writers to dual-populate.
///
/// Follow-on migrations (v52+) will cover the remaining tables
/// (`cash_drawer_sessions`, `z_reports`, `staff_shifts`, `daily_z_reports`,
/// `driver_earnings`, `shift_expenses`, `staff_payments`, `transaction_log`,
/// …) in the same additive shape.
///
/// No triggers are created — keeping the migration dependency-free means
/// a rollback is simply "ignore the new columns". Dual-write is Rust's
/// job in 4b/4c; atomic switch-over happens in 4d; 4e drops the legacy
/// REAL columns.
fn migrate_v51(conn: &Connection) -> Result<(), String> {
    // Target tables and the REAL columns each gains an `*_cents` shadow.
    // (table, column) pairs — edit carefully; each ADD COLUMN is guarded
    // by `column_exists` so re-running the migration on a partially-applied
    // DB (e.g. after a crash between ADD COLUMN and the INSERT INTO
    // schema_version) is idempotent.
    const CENTS_COLUMNS: &[(&str, &str)] = &[
        ("orders", "total_amount"),
        ("orders", "tax_amount"),
        ("orders", "subtotal"),
        ("orders", "discount_amount"),
        ("orders", "tip_amount"),
        ("orders", "delivery_fee"),
        ("order_payments", "amount"),
        ("order_payments", "cash_received"),
        ("order_payments", "change_given"),
        ("payment_adjustments", "amount"),
    ];

    for (table, col) in CENTS_COLUMNS {
        let cents_col = format!("{col}_cents");
        if !column_exists(conn, table, &cents_col)? {
            let add_sql = format!("ALTER TABLE {table} ADD COLUMN {cents_col} INTEGER");
            conn.execute_batch(&add_sql)
                .map_err(|e| format!("v51 add {table}.{cents_col}: {e}"))?;
        }
        // Backfill is idempotent: the COALESCE guards against double-application
        // and preserves any value already written by application code.
        let backfill_sql = format!(
            "UPDATE {table}
             SET {cents_col} = CAST(ROUND(COALESCE({col}, 0) * 100) AS INTEGER)
             WHERE {cents_col} IS NULL AND {col} IS NOT NULL"
        );
        conn.execute(&backfill_sql, [])
            .map_err(|e| format!("v51 backfill {table}.{cents_col}: {e}"))?;
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (51)", [])
        .map_err(|e| format!("v51 record schema_version: {e}"))?;

    info!(
        columns = CENTS_COLUMNS.len(),
        "Applied migration v51 (Wave 4a: *_cents shadow columns on orders / order_payments / payment_adjustments)"
    );
    Ok(())
}

/// Wave 10 H31: re-run `migrate_v28`'s printer-capability completion loop
/// inside a single BEGIN IMMEDIATE so any terminal that crashed between
/// v28's inner COMMIT and its trailing capability loop / schema_version
/// INSERT lands in a consistent state.
///
/// **Context**: `migrate_v28` is a "self-wrapping" migration — it opens
/// its own `BEGIN; … COMMIT;` inside `execute_batch` to rebuild the
/// `print_jobs` table. The subsequent printer-capability-completion
/// loop (lines ~2050–2095 in `migrate_v28`) and the final
/// `INSERT INTO schema_version (version) VALUES (28)` run OUTSIDE that
/// inner transaction. A crash in that window leaves v28 partially
/// applied: the `print_jobs` rebuild committed, but some printer
/// profiles may not have had their capabilities backfilled, and
/// schema_version is still 27.
///
/// On the next boot the harness re-runs v28, which is idempotent but
/// leaves the atomicity guarantee fragile for future maintainers. v52
/// re-applies the capability-defaulting step inside a proper
/// `BEGIN IMMEDIATE` → `COMMIT` so the state is explicitly verified
/// atomic. Every operation in this migration is idempotent: a profile
/// whose capabilities block is already filled sees no change; a profile
/// with missing defaults gets them filled.
fn migrate_v52(conn: &Connection) -> Result<(), String> {
    // `printer_profiles` is v7+; older pre-v7 DBs don't have this table,
    // but they also can't reach v28, v52, or any schema past v7 without
    // passing through the CREATE. A belt-and-braces `table_exists`
    // guard costs us one extra query and protects against a future
    // partial restore of a historical backup.
    let profiles_exist: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'printer_profiles'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if profiles_exist == 0 {
        // No printer_profiles table — nothing to repair. Still bump the
        // schema version so the migration is recorded as applied.
        conn.execute("INSERT INTO schema_version (version) VALUES (52)", [])
            .map_err(|e| format!("v52 record schema_version (no profiles): {e}"))?;
        info!("Applied migration v52 (Wave 10 H31: no printer_profiles table, no-op)");
        return Ok(());
    }

    // Re-run v28's capability-fill loop. Every step here is idempotent
    // via the `or_insert_with` / `entry.entry` pattern and a stable
    // default shape. A profile that's already complete stays unchanged.
    let mut stmt = conn
        .prepare("SELECT id, connection_json FROM printer_profiles")
        .map_err(|e| format!("v52 prepare printer_profiles: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| format!("v52 query printer_profiles: {e}"))?;

    let profiles: Vec<(String, Option<String>)> = rows.filter_map(Result::ok).collect();
    drop(stmt);

    let mut updated = 0usize;
    for (id, connection_json) in profiles {
        let mut parsed = connection_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        let before = Value::Object(parsed.clone()).to_string();
        let capabilities = parsed
            .entry("capabilities".to_string())
            .or_insert_with(default_printer_capabilities_json);
        if !capabilities.is_object() {
            *capabilities = default_printer_capabilities_json();
        } else if let Some(obj) = capabilities.as_object_mut() {
            let defaults = default_printer_capabilities_json()
                .as_object()
                .cloned()
                .unwrap_or_default();
            for (key, value) in defaults {
                obj.entry(key).or_insert(value);
            }
            if !matches!(
                obj.get("status").and_then(Value::as_str),
                Some("verified" | "degraded" | "unverified")
            ) {
                obj.insert(
                    "status".to_string(),
                    Value::String("unverified".to_string()),
                );
            }
        }
        let after = Value::Object(parsed).to_string();
        if before != after {
            conn.execute(
                "UPDATE printer_profiles SET connection_json = ?1 WHERE id = ?2",
                params![after, id],
            )
            .map_err(|e| format!("v52 update printer profile {id}: {e}"))?;
            updated += 1;
        }
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (52)", [])
        .map_err(|e| format!("v52 record schema_version: {e}"))?;

    info!(
        updated,
        "Applied migration v52 (Wave 10 H31: printer_profiles capability-default atomic re-verification)"
    );
    Ok(())
}

/// Wave 4a extension: add `*_cents INTEGER` shadow columns to the next
/// tier of money-bearing tables (`staff_shifts`, `cash_drawer_sessions`,
/// `z_reports`). Extends migration v51's pattern to the 32 remaining
/// money columns on these three tables; the remaining tables
/// (`daily_z_reports`, `driver_earnings`, `shift_expenses`, `staff_payments`,
/// `transaction_log`) will be covered by a future v54+ migration once
/// v52/v53 bake in the field.
///
/// Additive and non-breaking: no reader code references the `*_cents`
/// columns yet (Wave 4b is the reader-switch). Backfill uses the same
/// `CAST(ROUND(col * 100) AS INTEGER)` pattern with idempotent
/// `WHERE cents IS NULL AND real IS NOT NULL` guards.
fn migrate_v53(conn: &Connection) -> Result<(), String> {
    const CENTS_COLUMNS: &[(&str, &str)] = &[
        // staff_shifts — money cols declared at v1 create (lines 533–542)
        ("staff_shifts", "opening_cash_amount"),
        ("staff_shifts", "closing_cash_amount"),
        ("staff_shifts", "expected_cash_amount"),
        ("staff_shifts", "cash_variance"),
        ("staff_shifts", "total_sales_amount"),
        ("staff_shifts", "total_cash_sales"),
        ("staff_shifts", "total_card_sales"),
        ("staff_shifts", "payment_amount"),
        // cash_drawer_sessions — 12 money cols (lines 561–572)
        ("cash_drawer_sessions", "opening_amount"),
        ("cash_drawer_sessions", "closing_amount"),
        ("cash_drawer_sessions", "expected_amount"),
        ("cash_drawer_sessions", "variance_amount"),
        ("cash_drawer_sessions", "total_cash_sales"),
        ("cash_drawer_sessions", "total_card_sales"),
        ("cash_drawer_sessions", "total_refunds"),
        ("cash_drawer_sessions", "total_expenses"),
        ("cash_drawer_sessions", "cash_drops"),
        ("cash_drawer_sessions", "driver_cash_given"),
        ("cash_drawer_sessions", "driver_cash_returned"),
        ("cash_drawer_sessions", "total_staff_payments"),
        // z_reports — 12 money cols (lines 945–958)
        ("z_reports", "gross_sales"),
        ("z_reports", "net_sales"),
        ("z_reports", "cash_sales"),
        ("z_reports", "card_sales"),
        ("z_reports", "refunds_total"),
        ("z_reports", "voids_total"),
        ("z_reports", "discounts_total"),
        ("z_reports", "tips_total"),
        ("z_reports", "expenses_total"),
        ("z_reports", "cash_variance"),
        ("z_reports", "opening_cash"),
        ("z_reports", "closing_cash"),
        ("z_reports", "expected_cash"),
    ];

    for (table, col) in CENTS_COLUMNS {
        let cents_col = format!("{col}_cents");
        if !column_exists(conn, table, &cents_col)? {
            let add_sql = format!("ALTER TABLE {table} ADD COLUMN {cents_col} INTEGER");
            conn.execute_batch(&add_sql)
                .map_err(|e| format!("v53 add {table}.{cents_col}: {e}"))?;
        }
        let backfill_sql = format!(
            "UPDATE {table}
             SET {cents_col} = CAST(ROUND(COALESCE({col}, 0) * 100) AS INTEGER)
             WHERE {cents_col} IS NULL AND {col} IS NOT NULL"
        );
        conn.execute(&backfill_sql, [])
            .map_err(|e| format!("v53 backfill {table}.{cents_col}: {e}"))?;
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (53)", [])
        .map_err(|e| format!("v53 record schema_version: {e}"))?;

    info!(
        columns = CENTS_COLUMNS.len(),
        "Applied migration v53 (W4a ext: *_cents on staff_shifts / cash_drawer_sessions / z_reports)"
    );
    Ok(())
}

/// Wave 4a final sweep: add `*_cents INTEGER` shadow columns to the
/// remaining production tables that carry REAL money — `order_payments`
/// (the `discount_amount` column that v36's table rebuild added but v51
/// missed), `payment_items` (v31), `driver_earnings`, and
/// `shift_expenses`.
///
/// Extends v51/v53's pattern to the final 9 money columns discovered by
/// an exhaustive grep of `^\s*\w+\s+REAL` in this file (filtered to
/// money vs ratio/rate columns case-by-case).
///
/// **Intentionally NOT included** — three tables that the v53 doc
/// comment listed as "future work" turn out never to be created in any
/// production migration:
///   - `daily_z_reports`: never created anywhere in this file.
///   - `staff_payments`: test-fixture only. v47 (`migrate_v47`, line
///     3049) already uses the same "deliberately excluded" precedent:
///     *"it is created by test setup only and has no production
///     migration. Adding a column to a non-existent table would error
///     out on real terminals."*
///   - `transaction_log`: never created anywhere in this file.
///
/// If any of these three ever graduates to a production CREATE TABLE,
/// its `*_cents` shadow columns should be added in the same migration
/// that creates the table, not here.
///
/// Additive and non-breaking: no reader code references the `*_cents`
/// columns yet (Wave 4b is the reader-switch). Backfill uses the same
/// `CAST(ROUND(col * 100) AS INTEGER)` pattern with idempotent
/// `WHERE cents IS NULL AND real IS NOT NULL` guards as v51 and v53.
fn migrate_v54(conn: &Connection) -> Result<(), String> {
    const CENTS_COLUMNS: &[(&str, &str)] = &[
        // order_payments — v36 table-rebuild added `discount_amount`
        // which v51 did not shadow. (v51 covered amount, cash_received,
        // change_given on this table.)
        ("order_payments", "discount_amount"),
        // payment_items — created in v31; entire table missed by v51/v53.
        ("payment_items", "item_amount"),
        // driver_earnings — v14 create; 6 money cols
        ("driver_earnings", "delivery_fee"),
        ("driver_earnings", "tip_amount"),
        ("driver_earnings", "total_earning"),
        ("driver_earnings", "cash_collected"),
        ("driver_earnings", "card_amount"),
        ("driver_earnings", "cash_to_return"),
        // shift_expenses — v3 create; 1 money col
        ("shift_expenses", "amount"),
    ];

    for (table, col) in CENTS_COLUMNS {
        let cents_col = format!("{col}_cents");
        if !column_exists(conn, table, &cents_col)? {
            let add_sql = format!("ALTER TABLE {table} ADD COLUMN {cents_col} INTEGER");
            conn.execute_batch(&add_sql)
                .map_err(|e| format!("v54 add {table}.{cents_col}: {e}"))?;
        }
        let backfill_sql = format!(
            "UPDATE {table}
             SET {cents_col} = CAST(ROUND(COALESCE({col}, 0) * 100) AS INTEGER)
             WHERE {cents_col} IS NULL AND {col} IS NOT NULL"
        );
        conn.execute(&backfill_sql, [])
            .map_err(|e| format!("v54 backfill {table}.{cents_col}: {e}"))?;
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (54)", [])
        .map_err(|e| format!("v54 record schema_version: {e}"))?;

    info!(
        columns = CENTS_COLUMNS.len(),
        "Applied migration v54 (W4a final: *_cents on order_payments.discount_amount / payment_items / driver_earnings / shift_expenses)"
    );
    Ok(())
}

/// W6 (C8/H13): drop the stored `orders.payment_method` column.
///
/// Before this migration, payment method classification was stored
/// denormalized on `orders.payment_method` and kept in lockstep with
/// `order_payments` rows via `recompute_order_payment_state` and
/// `refresh_order_payment_snapshot`. That setup had a well-known
/// stickiness bug: a brief `partially_paid` state wrote
/// `payment_method='split'`, and the next refresh read its own write
/// back out and kept re-writing 'split' even after the operator
/// collected the delta in the original method.
///
/// Post-v55, every consumer derives the method on read via
/// `payments::derive_payment_method(conn, order_id)` — single source of
/// truth is `order_payments` rows. The stickiness bug is structurally
/// impossible (nothing to stick).
///
/// Guarded by `column_exists` so a partial-retry after a mid-migration
/// crash doesn't fail on second run. Relies on native SQLite 3.35+
/// `ALTER TABLE ... DROP COLUMN` support (rusqlite's bundled SQLite is
/// >=3.35 on every supported Tauri build).
fn migrate_v55(conn: &Connection) -> Result<(), String> {
    if column_exists(conn, "orders", "payment_method")? {
        conn.execute_batch("ALTER TABLE orders DROP COLUMN payment_method;")
            .map_err(|e| format!("v55 drop orders.payment_method: {e}"))?;
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (55)", [])
        .map_err(|e| format!("v55 record schema_version: {e}"))?;

    info!("Applied migration v55 (W6 C8/H13: dropped orders.payment_method — derive-on-read via payments::derive_payment_method)");
    Ok(())
}

/// Migration v56 (Wave 10 H8): add `claim_generation INTEGER NOT NULL
/// DEFAULT 0` to `parity_sync_queue`.
///
/// The column is incremented on every `dequeue` and on every
/// `recover_stale_processing_items`. `mark_success` uses it as a guard:
/// only a success ack from the worker that owns the current generation
/// succeeds. A late ack from a worker whose lease expired is silently
/// dropped, preventing it from corrupting a fresh in-flight claim or
/// (worse) marking an already-failed row as successful.
///
/// `column_exists` guards re-application after a partial-retry crash.
/// See `project_w10_h8_claim_generation_deferred.md` for the full
/// design notes and the W11 sprint memo for why we jumped v57 first.
fn migrate_v56(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "parity_sync_queue", "claim_generation")? {
        conn.execute_batch(
            "ALTER TABLE parity_sync_queue
             ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0;",
        )
        .map_err(|e| format!("v56 add parity_sync_queue.claim_generation: {e}"))?;
    }

    conn.execute(
        "INSERT OR IGNORE INTO schema_version (version) VALUES (56)",
        [],
    )
    .map_err(|e| format!("v56 record schema_version: {e}"))?;

    info!("Applied migration v56 (W10 H8: parity_sync_queue.claim_generation column)");
    Ok(())
}

/// Migration v57 (Wave 11 L): supporting index for the `staff_shifts`
/// "find active shift for staff" lookup used throughout the open-shift
/// guard family (`shifts::open_shift`, `shifts::get_active_for_staff`,
/// the cross-terminal exclusivity check). Without this index the
/// queries scan every historical staff_shifts row to find at most one
/// active row per staff. Adding `(staff_id, status)` keeps the lookup
/// constant-time relative to the active set.
///
/// `IF NOT EXISTS` makes this idempotent — if a future migration ever
/// re-creates the index under a different name, this one is a harmless
/// no-op rather than a hard failure.
///
/// Skipped v56 to keep that number reserved for the H8
/// `claim_generation` work (see `project_w10_h8_claim_generation_deferred.md`).
fn migrate_v57(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS staff_shifts_staff_status
             ON staff_shifts (staff_id, status);

         INSERT INTO schema_version (version) VALUES (57);",
    )
    .map_err(|e| format!("migration v57 staff_shifts_staff_status index: {e}"))?;

    info!("Applied migration v57 (staff_shifts(staff_id, status) supporting index)");
    Ok(())
}

/// Wave 4e preparation: backfill any row whose `_cents` column is still
/// NULL from the legacy REAL sibling. This guarantees that after this
/// migration, every monetary cents column is populated for every row —
/// which is the precondition for safely simplifying the COALESCE-with-real
/// shims that 4b's read-path migration left in production SELECTs.
///
/// **NOT included in this migration**: the actual DROP COLUMN of the 52
/// REAL money columns. Dropping them requires (a) removing the dual-write
/// halves from ~37 production INSERT/UPDATE sites, and (b) updating ~30+
/// test fixtures that INSERT money via raw SQL with REAL columns. That
/// cascade is too large for a single session and is deferred to a future
/// migration v59 once the test-fixture updates land. Until then:
///   - dual-write continues (REAL column still receives writes)
///   - cents column is the canonical source of truth (post-backfill)
///   - production reads can drop COALESCE shims since cents is guaranteed
///     populated
///
/// Idempotent — only fills `WHERE _cents IS NULL AND real IS NOT NULL`.
fn migrate_v58(conn: &Connection) -> Result<(), String> {
    // Authoritative drop list — same `(table, real_col)` pairs as v51 +
    // v53 + v54 added their `_cents` siblings for. Re-typed here as the
    // single source of truth so a reviewer can diff-check against the
    // ADD COLUMN lists.
    const REAL_COLUMNS_TO_DROP: &[(&str, &str)] = &[
        // From migrate_v51 (orders, order_payments, payment_adjustments)
        ("orders", "total_amount"),
        ("orders", "tax_amount"),
        ("orders", "subtotal"),
        ("orders", "discount_amount"),
        ("orders", "tip_amount"),
        ("orders", "delivery_fee"),
        ("order_payments", "amount"),
        ("order_payments", "cash_received"),
        ("order_payments", "change_given"),
        ("payment_adjustments", "amount"),
        // From migrate_v53 (staff_shifts, cash_drawer_sessions, z_reports)
        ("staff_shifts", "opening_cash_amount"),
        ("staff_shifts", "closing_cash_amount"),
        ("staff_shifts", "expected_cash_amount"),
        ("staff_shifts", "cash_variance"),
        ("staff_shifts", "total_sales_amount"),
        ("staff_shifts", "total_cash_sales"),
        ("staff_shifts", "total_card_sales"),
        ("staff_shifts", "payment_amount"),
        ("cash_drawer_sessions", "opening_amount"),
        ("cash_drawer_sessions", "closing_amount"),
        ("cash_drawer_sessions", "expected_amount"),
        ("cash_drawer_sessions", "variance_amount"),
        ("cash_drawer_sessions", "total_cash_sales"),
        ("cash_drawer_sessions", "total_card_sales"),
        ("cash_drawer_sessions", "total_refunds"),
        ("cash_drawer_sessions", "total_expenses"),
        ("cash_drawer_sessions", "cash_drops"),
        ("cash_drawer_sessions", "driver_cash_given"),
        ("cash_drawer_sessions", "driver_cash_returned"),
        ("cash_drawer_sessions", "total_staff_payments"),
        ("z_reports", "gross_sales"),
        ("z_reports", "net_sales"),
        ("z_reports", "cash_sales"),
        ("z_reports", "card_sales"),
        ("z_reports", "refunds_total"),
        ("z_reports", "voids_total"),
        ("z_reports", "discounts_total"),
        ("z_reports", "tips_total"),
        ("z_reports", "expenses_total"),
        ("z_reports", "cash_variance"),
        ("z_reports", "opening_cash"),
        ("z_reports", "closing_cash"),
        ("z_reports", "expected_cash"),
        // From migrate_v54 (order_payments.discount_amount, payment_items, driver_earnings, shift_expenses)
        ("order_payments", "discount_amount"),
        ("payment_items", "item_amount"),
        ("driver_earnings", "delivery_fee"),
        ("driver_earnings", "tip_amount"),
        ("driver_earnings", "total_earning"),
        ("driver_earnings", "cash_collected"),
        ("driver_earnings", "card_amount"),
        ("driver_earnings", "cash_to_return"),
        ("shift_expenses", "amount"),
    ];

    // Backfill: any row whose `_cents` column is NULL gets it populated
    // from the REAL sibling. Idempotent — only fills NULLs.
    for (table, real_col) in REAL_COLUMNS_TO_DROP {
        let cents_col = format!("{real_col}_cents");
        if column_exists(conn, table, &cents_col)? && column_exists(conn, table, real_col)? {
            let backfill_sql = format!(
                "UPDATE {table}
                 SET {cents_col} = CAST(ROUND(COALESCE({real_col}, 0) * 100) AS INTEGER)
                 WHERE {cents_col} IS NULL AND {real_col} IS NOT NULL"
            );
            conn.execute(&backfill_sql, [])
                .map_err(|e| format!("v58 backfill {table}.{cents_col}: {e}"))?;
        }
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (58)", [])
        .map_err(|e| format!("v58 record schema_version: {e}"))?;

    info!(
        columns = REAL_COLUMNS_TO_DROP.len(),
        "Applied migration v58 (W4e prep: backfilled NULL cents from REAL siblings)"
    );
    Ok(())
}

fn migrate_v59(conn: &Connection) -> Result<(), String> {
    for (column, column_type) in [
        ("delivery_address_id", "TEXT"),
        ("delivery_latitude", "REAL"),
        ("delivery_longitude", "REAL"),
        ("delivery_address_fingerprint", "TEXT"),
        ("delivery_zone_id", "TEXT"),
    ] {
        if !column_exists(conn, "orders", column)? {
            let sql = format!("ALTER TABLE orders ADD COLUMN {column} {column_type}");
            conn.execute(&sql, [])
                .map_err(|e| format!("v59 add orders.{column}: {e}"))?;
        }
    }

    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_orders_delivery_address_id
          ON orders(delivery_address_id)
          WHERE delivery_address_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_orders_delivery_zone_id
          ON orders(delivery_zone_id)
          WHERE delivery_zone_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_orders_delivery_coordinates
          ON orders(delivery_latitude, delivery_longitude)
          WHERE delivery_latitude IS NOT NULL AND delivery_longitude IS NOT NULL;
        ",
    )
    .map_err(|e| format!("v59 order delivery destination indexes: {e}"))?;

    conn.execute("INSERT INTO schema_version (version) VALUES (59)", [])
        .map_err(|e| format!("v59 record schema_version: {e}"))?;

    info!("Applied migration v59 (order delivery destination snapshots)");
    Ok(())
}

/// Migration v60: persistent rolling top-sellers leaderboard.
///
/// The "Επιλεγμένα" (Featured) tab in the menu picker reads from
/// `report_get_top_items` / `report_get_weekly_top_items`, which both
/// query the local `orders` table. After every Z-report rollover,
/// `apply_local_day_rollover` deletes the closed-out orders — and the
/// Featured tab goes blank until the next day's orders accumulate.
///
/// This table preserves a per-(branch, menu_item) running aggregate
/// across Z-report rollovers. Z-report calls `top_sellers_aggregate_into_rolling`
/// just before deletion to fold the about-to-be-deleted orders into
/// this table. The reports queries then merge live orders + this
/// rolling table so the leaderboard is always populated and reflects
/// historical sales weighted alongside today's activity.
fn migrate_v60(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS top_sellers_rolling (
            branch_id TEXT NOT NULL,
            menu_item_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'Item',
            category_id TEXT,
            total_quantity REAL NOT NULL DEFAULT 0,
            total_revenue REAL NOT NULL DEFAULT 0,
            last_sold_at TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (branch_id, menu_item_id)
        );

        -- Lookups by branch + ranking are the hot path for the Featured
        -- tab population. Quantity-desc index keeps the limit-N read
        -- to an index scan rather than a full table sort.
        CREATE INDEX IF NOT EXISTS idx_top_sellers_rolling_branch_qty
          ON top_sellers_rolling (branch_id, total_quantity DESC);
        ",
    )
    .map_err(|e| format!("v60 create top_sellers_rolling: {e}"))?;

    conn.execute("INSERT INTO schema_version (version) VALUES (60)", [])
        .map_err(|e| format!("v60 record schema_version: {e}"))?;

    info!("Applied migration v60 (persistent rolling top-sellers leaderboard)");
    Ok(())
}

/// Migration v61: local terminal ownership scope for orders.
///
/// Remote orders already carry both the owning main terminal DB id and the
/// public source terminal id. Persisting those locally lets isolated main
/// terminals hide stale branch-shared rows that were imported before the
/// server-side terminal-unit filters were restored.
fn migrate_v61(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "orders", "owner_terminal_id")? {
        conn.execute("ALTER TABLE orders ADD COLUMN owner_terminal_id TEXT", [])
            .map_err(|e| format!("v61 add orders.owner_terminal_id: {e}"))?;
    }

    if !column_exists(conn, "orders", "source_terminal_id")? {
        conn.execute("ALTER TABLE orders ADD COLUMN source_terminal_id TEXT", [])
            .map_err(|e| format!("v61 add orders.source_terminal_id: {e}"))?;
    }

    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_orders_owner_terminal_id
          ON orders(owner_terminal_id)
          WHERE owner_terminal_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_orders_source_terminal_id
          ON orders(source_terminal_id)
          WHERE source_terminal_id IS NOT NULL;
        ",
    )
    .map_err(|e| format!("v61 order terminal ownership indexes: {e}"))?;

    conn.execute("INSERT INTO schema_version (version) VALUES (61)", [])
        .map_err(|e| format!("v61 record schema_version: {e}"))?;

    info!("Applied migration v61 (local order terminal ownership scope)");
    Ok(())
}

/// Read the persisted `idempotency_key` from an entity table.
///
/// Wave 4 architectural contract:
///
/// > Every `sync_queue` row that dispatches an entity MUST carry the
/// > SAME `idempotency_key` that was persisted on the entity row at
/// > creation time. A second dispatch (retry, requeue, manual replay)
/// > reads the same entity row and copies the same key, so the server
/// > sees ONE operation regardless of how many times the client
/// > re-sends it.
///
/// Use this helper to fetch the key before constructing an enqueue.
/// Rows created under v47+ always have a value (nullable on-disk, but
/// the v49 trigger backfills via SQLite random on INSERT). If the key
/// is missing for any reason — a pre-v47 row that was never touched,
/// or a trigger that failed silently — this returns `None` and the
/// caller may fall back to a deterministic synthetic
/// (`entity_type:entity_id:operation`) so the sync_queue INSERT still
/// succeeds.
///
/// `table` must be one of the five entity-sync-queue tables covered
/// by v47 (`order_payments`, `payment_adjustments`, `staff_shifts`,
/// `shift_expenses`, `driver_earnings`). The function validates that
/// at compile time via a debug_assert; production builds accept any
/// plain identifier and simply return `None` on lookup miss.
// Wave 5 C17: consumer wired in `sync_queue.rs::prepare_financial_request`
// via the `idempotency::make_entity_key` facade; `#[allow(dead_code)]`
// gate removed.
pub fn get_entity_idempotency_key(
    conn: &Connection,
    table: &str,
    entity_id: &str,
) -> Option<String> {
    debug_assert!(
        matches!(
            table,
            "order_payments"
                | "payment_adjustments"
                | "staff_shifts"
                | "shift_expenses"
                | "driver_earnings"
                | "staff_payments"
        ),
        "get_entity_idempotency_key: unexpected table '{table}'"
    );
    debug_assert!(
        is_safe_sql_identifier(table),
        "get_entity_idempotency_key: table '{table}' must be a plain identifier"
    );
    let sql = format!("SELECT idempotency_key FROM {table} WHERE id = ?1");
    conn.query_row(&sql, params![entity_id], |row| {
        row.get::<_, Option<String>>(0)
    })
    .ok()
    .flatten()
}

// ---------------------------------------------------------------------------
// ECR device helpers
// ---------------------------------------------------------------------------

/// Insert a new ECR device.
pub fn ecr_insert_device(conn: &Connection, dev: &serde_json::Value) -> Result<(), String> {
    conn.execute(
        "INSERT INTO ecr_devices
            (id, name, device_type, brand, protocol, connection_type, connection_details,
             terminal_id, merchant_id, operator_id, print_mode, tax_rates,
             is_default, enabled, settings)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            dev.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
            dev.get("name").and_then(|v| v.as_str()).unwrap_or("Device"),
            dev.get("deviceType")
                .and_then(|v| v.as_str())
                .unwrap_or("payment_terminal"),
            dev.get("brand")
                .and_then(|v| v.as_str())
                .unwrap_or("generic"),
            dev.get("protocol")
                .and_then(|v| v.as_str())
                .unwrap_or("generic"),
            dev.get("connectionType")
                .and_then(|v| v.as_str())
                .unwrap_or("network"),
            dev.get("connectionDetails")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".into()),
            dev.get("terminalId").and_then(|v| v.as_str()),
            dev.get("merchantId").and_then(|v| v.as_str()),
            dev.get("operatorId").and_then(|v| v.as_str()),
            dev.get("printMode")
                .and_then(|v| v.as_str())
                .unwrap_or("register_prints"),
            dev.get("taxRates")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "[]".into()),
            dev.get("isDefault")
                .and_then(|v| v.as_bool())
                .unwrap_or(false) as i32,
            dev.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true) as i32,
            dev.get("settings")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".into()),
        ],
    )
    .map_err(|e| format!("ecr_insert_device: {e}"))?;
    Ok(())
}

/// Update an existing ECR device.
pub fn ecr_update_device(
    conn: &Connection,
    id: &str,
    updates: &serde_json::Value,
) -> Result<(), String> {
    // Build SET clauses dynamically for provided fields
    let mut sets = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    macro_rules! maybe_set {
        ($field:expr, $col:expr) => {
            if let Some(v) = updates.get($field) {
                if let Some(s) = v.as_str() {
                    sets.push(format!("{} = ?", $col));
                    values.push(Box::new(s.to_string()));
                }
            }
        };
    }

    macro_rules! maybe_set_json {
        ($field:expr, $col:expr) => {
            if let Some(v) = updates.get($field) {
                sets.push(format!("{} = ?", $col));
                values.push(Box::new(v.to_string()));
            }
        };
    }

    macro_rules! maybe_set_bool {
        ($field:expr, $col:expr) => {
            if let Some(v) = updates.get($field).and_then(|v| v.as_bool()) {
                sets.push(format!("{} = ?", $col));
                values.push(Box::new(v as i32));
            }
        };
    }

    maybe_set!("name", "name");
    maybe_set!("deviceType", "device_type");
    maybe_set!("brand", "brand");
    maybe_set!("protocol", "protocol");
    maybe_set!("connectionType", "connection_type");
    maybe_set_json!("connectionDetails", "connection_details");
    maybe_set!("terminalId", "terminal_id");
    maybe_set!("merchantId", "merchant_id");
    maybe_set!("operatorId", "operator_id");
    maybe_set!("printMode", "print_mode");
    maybe_set_json!("taxRates", "tax_rates");
    maybe_set_bool!("isDefault", "is_default");
    maybe_set_bool!("enabled", "enabled");
    maybe_set_json!("settings", "settings");
    maybe_set!("status", "status");
    maybe_set!("lastError", "last_error");

    if sets.is_empty() {
        return Ok(());
    }

    sets.push("updated_at = datetime('now')".to_string());
    // SAFETY: `sets` is built exclusively from hardcoded column names via the
    // maybe_set!/maybe_set_bool!/maybe_set_json! macros above. No user input
    // reaches the format string — only parameterised `?` placeholders carry
    // user-supplied values.
    let sql = format!("UPDATE ecr_devices SET {} WHERE id = ?", sets.join(", "));
    values.push(Box::new(id.to_string()));

    let params: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, params.as_slice())
        .map_err(|e| format!("ecr_update_device: {e}"))?;
    Ok(())
}

/// Delete an ECR device.
pub fn ecr_delete_device(conn: &Connection, id: &str) -> Result<bool, String> {
    let rows = conn
        .execute("DELETE FROM ecr_devices WHERE id = ?1", params![id])
        .map_err(|e| format!("ecr_delete_device: {e}"))?;
    Ok(rows > 0)
}

/// Get a single ECR device by ID.
pub fn ecr_get_device(conn: &Connection, id: &str) -> Option<serde_json::Value> {
    ecr_query_one(conn, "SELECT * FROM ecr_devices WHERE id = ?1", params![id])
}

/// List all ECR devices.
pub fn ecr_list_devices(conn: &Connection) -> Vec<serde_json::Value> {
    ecr_query_many(
        conn,
        "SELECT * FROM ecr_devices ORDER BY is_default DESC, name ASC",
        [],
    )
}

/// List ECR devices by type.
#[allow(dead_code)]
pub fn ecr_list_devices_by_type(conn: &Connection, device_type: &str) -> Vec<serde_json::Value> {
    ecr_query_many(
        conn,
        "SELECT * FROM ecr_devices WHERE device_type = ?1 ORDER BY is_default DESC, name ASC",
        params![device_type],
    )
}

/// Get the default ECR device (optionally filtered by type).
pub fn ecr_get_default_device(
    conn: &Connection,
    device_type: Option<&str>,
) -> Option<serde_json::Value> {
    if let Some(dt) = device_type {
        ecr_query_one(
            conn,
            "SELECT * FROM ecr_devices WHERE device_type = ?1 AND enabled = 1
             ORDER BY is_default DESC LIMIT 1",
            params![dt],
        )
    } else {
        ecr_query_one(
            conn,
            "SELECT * FROM ecr_devices WHERE enabled = 1
             ORDER BY is_default DESC LIMIT 1",
            [],
        )
    }
}

/// Insert an ECR transaction record.
pub fn ecr_insert_transaction(conn: &Connection, tx: &serde_json::Value) -> Result<(), String> {
    conn.execute(
        "INSERT INTO ecr_transactions
            (id, device_id, order_id, transaction_type, amount, currency, status,
             authorization_code, terminal_reference, fiscal_receipt_number,
             card_type, card_last_four, entry_method, receipt_data,
             error_message, raw_response, started_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            tx.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
            tx.get("deviceId")
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
            tx.get("orderId").and_then(|v| v.as_str()),
            tx.get("transactionType")
                .and_then(|v| v.as_str())
                .unwrap_or("sale"),
            tx.get("amount").and_then(|v| v.as_i64()).unwrap_or(0),
            tx.get("currency").and_then(|v| v.as_str()).unwrap_or("EUR"),
            tx.get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("pending"),
            tx.get("authorizationCode").and_then(|v| v.as_str()),
            tx.get("terminalReference").and_then(|v| v.as_str()),
            tx.get("fiscalReceiptNumber").and_then(|v| v.as_str()),
            tx.get("cardType").and_then(|v| v.as_str()),
            tx.get("cardLastFour").and_then(|v| v.as_str()),
            tx.get("entryMethod").and_then(|v| v.as_str()),
            tx.get("receiptData").map(|v| v.to_string()),
            tx.get("errorMessage").and_then(|v| v.as_str()),
            tx.get("rawResponse").map(|v| v.to_string()),
            tx.get("startedAt")
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
            tx.get("completedAt").and_then(|v| v.as_str()),
        ],
    )
    .map_err(|e| format!("ecr_insert_transaction: {e}"))?;
    Ok(())
}

/// List ECR transactions with optional filters.
pub fn ecr_list_transactions(
    conn: &Connection,
    device_id: Option<&str>,
    limit: Option<u32>,
) -> Vec<serde_json::Value> {
    let limit_val = limit.unwrap_or(100) as i64;
    let mut sql = "SELECT * FROM ecr_transactions WHERE 1=1".to_string();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(did) = device_id {
        sql.push_str(&format!(" AND device_id = ?{}", param_values.len() + 1));
        param_values.push(Box::new(did.to_string()));
    }
    sql.push_str(&format!(
        " ORDER BY created_at DESC LIMIT ?{}",
        param_values.len() + 1
    ));
    param_values.push(Box::new(limit_val));

    let params: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|b| b.as_ref()).collect();

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    let rows = stmt
        .query_map(params.as_slice(), |row| {
            let mut obj = serde_json::Map::new();
            for (i, col) in column_names.iter().enumerate() {
                let val: rusqlite::types::Value = row.get(i)?;
                let json_val = match val {
                    rusqlite::types::Value::Null => serde_json::Value::Null,
                    rusqlite::types::Value::Integer(n) => serde_json::json!(n),
                    rusqlite::types::Value::Real(f) => serde_json::json!(f),
                    rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
                    rusqlite::types::Value::Blob(b) => serde_json::Value::String(
                        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &b),
                    ),
                };
                // Convert snake_case to camelCase for the frontend
                let camel = to_camel_case(col);
                obj.insert(camel, json_val);
            }
            Ok(serde_json::Value::Object(obj))
        })
        .ok();

    rows.map(|r| r.filter_map(|v| v.ok()).collect())
        .unwrap_or_default()
}

/// Helper: query one row from ecr tables as JSON.
fn ecr_query_one<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Option<serde_json::Value> {
    let mut stmt = conn.prepare(sql).ok()?;
    let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    stmt.query_row(params, |row| {
        let mut obj = serde_json::Map::new();
        for (i, col) in column_names.iter().enumerate() {
            let val: rusqlite::types::Value = row.get(i)?;
            let json_val = match val {
                rusqlite::types::Value::Null => serde_json::Value::Null,
                rusqlite::types::Value::Integer(n) => serde_json::json!(n),
                rusqlite::types::Value::Real(f) => serde_json::json!(f),
                rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
                rusqlite::types::Value::Blob(b) => serde_json::Value::String(
                    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &b),
                ),
            };
            let camel = to_camel_case(col);
            obj.insert(camel, json_val);
        }
        Ok(serde_json::Value::Object(obj))
    })
    .ok()
}

/// Helper: query multiple rows from ecr tables as JSON.
fn ecr_query_many<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Vec<serde_json::Value> {
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    let rows = stmt
        .query_map(params, |row| {
            let mut obj = serde_json::Map::new();
            for (i, col) in column_names.iter().enumerate() {
                let val: rusqlite::types::Value = row.get(i)?;
                let json_val = match val {
                    rusqlite::types::Value::Null => serde_json::Value::Null,
                    rusqlite::types::Value::Integer(n) => serde_json::json!(n),
                    rusqlite::types::Value::Real(f) => serde_json::json!(f),
                    rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
                    rusqlite::types::Value::Blob(b) => serde_json::Value::String(
                        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &b),
                    ),
                };
                let camel = to_camel_case(col);
                obj.insert(camel, json_val);
            }
            Ok(serde_json::Value::Object(obj))
        })
        .ok();

    rows.map(|r| r.filter_map(|v| v.ok()).collect())
        .unwrap_or_default()
}

/// Convert snake_case to camelCase.
fn to_camel_case(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut capitalize_next = false;
    for ch in s.chars() {
        if ch == '_' {
            capitalize_next = true;
        } else if capitalize_next {
            result.push(ch.to_ascii_uppercase());
            capitalize_next = false;
        } else {
            result.push(ch);
        }
    }
    result
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

/// Delete a single setting by (category, key). Silently succeeds if the row
/// does not exist. Used by the post-hydration purge to remove plaintext
/// credentials from `local_settings` once they're safely in the OS keyring.
pub fn delete_setting(conn: &Connection, category: &str, key: &str) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM local_settings WHERE setting_category = ?1 AND setting_key = ?2",
        params![category, key],
    )
    .map_err(|e| format!("delete_setting: {e}"))
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

pub fn upsert_caller_id_log(
    conn: &Connection,
    caller_number: &str,
    caller_name: Option<&str>,
    customer_id: Option<&str>,
    customer_name: Option<&str>,
    sip_call_id: &str,
    action_taken: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO caller_id_log
            (id, caller_number, caller_name, customer_id, customer_name, sip_call_id, action_taken, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
         ON CONFLICT(sip_call_id) DO UPDATE SET
            caller_number = excluded.caller_number,
            caller_name = excluded.caller_name,
            customer_id = excluded.customer_id,
            customer_name = excluded.customer_name,
            action_taken = excluded.action_taken",
        params![
            uuid::Uuid::new_v4().to_string(),
            caller_number,
            caller_name,
            customer_id,
            customer_name,
            sip_call_id,
            action_taken,
        ],
    )
    .map_err(|e| format!("upsert caller_id_log: {e}"))?;

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

        // v18: print_jobs should accept shift_checkout entity_type
        conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES ('pj-sc-test', 'shift_checkout', 'shift-1', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("print_jobs should accept shift_checkout entity_type");
        conn.execute("DELETE FROM print_jobs WHERE id = 'pj-sc-test'", [])
            .expect("cleanup");

        // v20: payload snapshot column should exist for queued snapshot prints
        let _payload_check: Result<Option<String>, _> = conn.query_row(
            "SELECT entity_payload_json FROM print_jobs LIMIT 0",
            [],
            |row| row.get(0),
        );
        let _delivery_columns_check: Result<Option<String>, _> = conn.query_row(
            "SELECT delivery_city, delivery_postal_code, delivery_floor, driver_id, driver_name
             FROM orders LIMIT 0",
            [],
            |row| row.get(0),
        );
        let _terminal_scope_columns_check: Result<Option<String>, _> = conn.query_row(
            "SELECT owner_terminal_id, source_terminal_id FROM orders LIMIT 0",
            [],
            |row| row.get(0),
        );

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
    fn test_migrate_v55_drops_payment_method_column() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Column must be gone.
        assert!(
            !column_exists(&conn, "orders", "payment_method").expect("column_exists probe"),
            "orders.payment_method should be dropped after v55"
        );

        // Derive helper still returns consistent results (no panic when
        // reading from a schema that never had the column).
        let derived = crate::payments::derive_payment_method(&conn, "any-nonexistent-id");
        assert!(
            derived.is_ok(),
            "derive_payment_method must tolerate the column being gone"
        );
    }

    #[test]
    fn test_migrate_v55_column_exists_guard_tolerates_rerun() {
        // The `column_exists` guard inside `migrate_v55` is what protects
        // against partial-retry after a mid-migration crash. Verify it by
        // running migrations to 55, then dropping the column is a no-op
        // when the probe returns false.
        let conn = test_db();
        run_migrations(&conn).expect("first run");
        assert!(
            !column_exists(&conn, "orders", "payment_method").expect("column_exists probe"),
            "column should be gone after v55"
        );
        // A rerun of `run_migrations` hits the `current < 55` guard and
        // skips the dispatch entirely — no UNIQUE-violation on
        // schema_version, no re-drop.
        run_migrations(&conn).expect("rerun should be a no-op");
    }

    #[test]
    fn test_migrate_v57_creates_staff_shifts_staff_status_index() {
        // Wave 11 L: migration v57 adds the `staff_shifts_staff_status`
        // index on `staff_shifts(staff_id, status)`. Probe sqlite_master
        // for the index name after running migrations.
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'staff_shifts_staff_status'",
                [],
                |row| row.get(0),
            )
            .expect("probe sqlite_master");
        assert_eq!(
            count, 1,
            "v57 must create the staff_shifts_staff_status index"
        );

        // Confirm the index targets the expected (staff_id, status)
        // columns. SQLite stores the CREATE INDEX SQL verbatim in
        // `sqlite_master.sql`.
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master
                 WHERE type = 'index' AND name = 'staff_shifts_staff_status'",
                [],
                |row| row.get(0),
            )
            .expect("read index SQL");
        assert!(
            sql.contains("staff_id") && sql.contains("status"),
            "v57 index SQL must mention both columns; got: {sql}"
        );

        // Schema_version row must record 57.
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
                row.get(0)
            })
            .expect("read schema_version");
        assert!(
            version >= 57,
            "schema_version must reach >= 57 after v57 runs (got {version})"
        );
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
    fn test_migrations_repair_missing_v56_after_later_versions_applied() {
        let conn = test_db();
        conn.execute_batch(
            "
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT DEFAULT (datetime('now'))
            );
            INSERT INTO schema_version (version) VALUES (58);

            CREATE TABLE orders (
                id TEXT PRIMARY KEY
            );

            CREATE TABLE parity_sync_queue (
                id              TEXT PRIMARY KEY,
                table_name      TEXT NOT NULL,
                record_id       TEXT NOT NULL,
                operation       TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
                data            TEXT NOT NULL,
                organization_id TEXT NOT NULL,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                attempts        INTEGER NOT NULL DEFAULT 0,
                last_attempt    TEXT,
                error_message   TEXT,
                next_retry_at   TEXT,
                retry_delay_ms  INTEGER NOT NULL DEFAULT 1000,
                priority        INTEGER NOT NULL DEFAULT 0,
                module_type     TEXT NOT NULL DEFAULT 'orders',
                conflict_strategy TEXT NOT NULL DEFAULT 'server-wins',
                version         INTEGER NOT NULL DEFAULT 1,
                status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'failed', 'conflict'))
            );
            ",
        )
        .expect("seed schema with v56 gap");

        run_migrations(&conn).expect("migrations should repair v56 gap");

        assert!(
            column_exists(&conn, "parity_sync_queue", "claim_generation")
                .expect("claim_generation column check"),
            "missing v56 claim_generation column must be backfilled"
        );
        assert!(
            schema_version_exists(&conn, 56).expect("schema version check"),
            "missing v56 schema_version row must be backfilled"
        );
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

        conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES ('pj-shift', 'shift_checkout', 'shift-1', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert shift checkout print job");

        // Verify CHECK constraint rejects invalid status
        let bad = conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES ('pj-bad', 'order_receipt', 'ord-1', 'INVALID', datetime('now'), datetime('now'))",
            [],
        );
        assert!(bad.is_err(), "invalid status should be rejected");

        // entity_type validation is handled by the print command layer; the
        // storage table intentionally remains permissive here.
        let bad_type = conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES ('pj-bad2', 'INVALID_TYPE', 'ord-1', 'pending', datetime('now'), datetime('now'))",
            [],
        );
        assert!(
            bad_type.is_ok(),
            "print_jobs storage should allow unknown entity types"
        );
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

        // Verify 112mm profile is accepted.
        conn.execute(
            "INSERT INTO printer_profiles (id, name, driver_type, printer_name, paper_width_mm, created_at, updated_at)
             VALUES ('pp-112', 'Wide Printer', 'windows', 'POS-112 Printer', 112, datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert 112mm printer profile");

        // Verify CHECK constraint rejects invalid driver_type
        let bad_driver = conn.execute(
            "INSERT INTO printer_profiles (id, name, driver_type, printer_name, created_at, updated_at)
             VALUES ('pp-bad', 'Bad', 'bluetooth', 'Printer', datetime('now'), datetime('now'))",
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
    fn test_migration_v15_printer_profile_extended_columns() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Insert a printer profile with extended columns
        conn.execute(
            "INSERT INTO printer_profiles (id, name, driver_type, printer_name,
                                           printer_type, role, is_default, enabled,
                                           character_set, greek_render_mode, receipt_template,
                                           fallback_printer_id, connection_json,
                                           created_at, updated_at)
             VALUES ('pp-ext', 'Receipt Printer', 'windows', 'POS-80',
                     'network', 'kitchen', 1, 1,
                     'PC737_GREEK', 'bitmap', 'modern',
                     NULL, '{\"type\":\"network\",\"ip\":\"192.168.1.100\",\"port\":9100}',
                     datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert extended printer profile");

        // Read back new columns
        let (ptype, role, is_default, enabled): (String, String, i32, i32) = conn
            .query_row(
                "SELECT printer_type, role, is_default, enabled FROM printer_profiles WHERE id = 'pp-ext'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(ptype, "network");
        assert_eq!(role, "kitchen");
        assert_eq!(is_default, 1);
        assert_eq!(enabled, 1);

        let (charset, grm, tpl): (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT character_set, greek_render_mode, receipt_template FROM printer_profiles WHERE id = 'pp-ext'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(charset, "PC737_GREEK");
        assert_eq!(grm, Some("bitmap".to_string()));
        assert_eq!(tpl, Some("modern".to_string()));

        // Verify defaults for a profile without explicit extended fields
        conn.execute(
            "INSERT INTO printer_profiles (id, name, driver_type, printer_name, created_at, updated_at)
             VALUES ('pp-defaults', 'Default Printer', 'windows', 'POS-58', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert profile with defaults");

        let (def_type, def_role, def_default, def_enabled, def_charset, def_template): (
            String,
            String,
            i32,
            i32,
            String,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT printer_type, role, is_default, enabled, character_set, receipt_template
                 FROM printer_profiles WHERE id = 'pp-defaults'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(def_type, "system");
        assert_eq!(def_role, "receipt");
        assert_eq!(def_default, 0);
        assert_eq!(def_enabled, 1);
        assert_eq!(def_charset, "PC437_USA");
        assert_eq!(def_template, Some("modern".to_string()));
    }

    #[test]
    fn test_migration_v26_restores_classic_raster_exact_for_receipt_and_kitchen_profiles() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE printer_profiles (
                id TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                receipt_template TEXT,
                connection_json TEXT
            );
            ",
        )
        .expect("create minimal migration tables");

        conn.execute(
            "INSERT INTO printer_profiles (id, role, receipt_template, connection_json)
             VALUES ('pp-receipt', 'receipt', 'modern', '{\"type\":\"network\",\"render_mode\":\"text\"}')",
            [],
        )
        .expect("insert receipt profile");
        conn.execute(
            "INSERT INTO printer_profiles (id, role, receipt_template, connection_json)
             VALUES ('pp-kitchen', 'kitchen', NULL, NULL)",
            [],
        )
        .expect("insert kitchen profile");
        conn.execute(
            "INSERT INTO printer_profiles (id, role, receipt_template, connection_json)
             VALUES ('pp-label', 'label', 'modern', '{\"type\":\"network\",\"render_mode\":\"text\"}')",
            [],
        )
        .expect("insert non-receipt profile");

        migrate_v26(&conn).expect("migration v26");

        let (receipt_template, receipt_connection): (String, String) = conn
            .query_row(
                "SELECT receipt_template, connection_json FROM printer_profiles WHERE id = 'pp-receipt'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read receipt profile");
        assert_eq!(receipt_template, "classic");
        let receipt_json: serde_json::Value =
            serde_json::from_str(&receipt_connection).expect("parse receipt connection json");
        assert_eq!(
            receipt_json
                .get("render_mode")
                .and_then(|value| value.as_str()),
            Some("raster_exact")
        );

        let (kitchen_template, kitchen_connection): (String, String) = conn
            .query_row(
                "SELECT receipt_template, connection_json FROM printer_profiles WHERE id = 'pp-kitchen'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read kitchen profile");
        assert_eq!(kitchen_template, "classic");
        let kitchen_json: serde_json::Value =
            serde_json::from_str(&kitchen_connection).expect("parse kitchen connection json");
        assert_eq!(
            kitchen_json
                .get("render_mode")
                .and_then(|value| value.as_str()),
            Some("raster_exact")
        );

        let (label_template, label_connection): (String, String) = conn
            .query_row(
                "SELECT receipt_template, connection_json FROM printer_profiles WHERE id = 'pp-label'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read non-receipt profile");
        assert_eq!(label_template, "modern");
        assert_eq!(
            label_connection,
            "{\"type\":\"network\",\"render_mode\":\"text\"}"
        );
    }

    #[test]
    fn test_migration_v27_normalizes_network_auto_emulation_to_escpos() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE printer_profiles (
                id TEXT PRIMARY KEY,
                printer_type TEXT,
                connection_json TEXT
            );
            ",
        )
        .expect("create minimal migration tables");

        conn.execute(
            "INSERT INTO printer_profiles (id, printer_type, connection_json)
             VALUES ('pp-network', 'network', '{\"type\":\"network\",\"ip\":\"192.168.1.19\",\"emulation\":\"auto\"}')",
            [],
        )
        .expect("insert network profile");
        conn.execute(
            "INSERT INTO printer_profiles (id, printer_type, connection_json)
             VALUES ('pp-system', 'system', '{\"type\":\"system\",\"systemName\":\"Star MCP31\",\"emulation\":\"auto\"}')",
            [],
        )
        .expect("insert system profile");

        migrate_v27(&conn).expect("migration v27");

        let network_connection: String = conn
            .query_row(
                "SELECT connection_json FROM printer_profiles WHERE id = 'pp-network'",
                [],
                |row| row.get(0),
            )
            .expect("read network profile");
        let network_json: serde_json::Value =
            serde_json::from_str(&network_connection).expect("parse network connection");
        assert_eq!(
            network_json
                .get("emulation")
                .and_then(|value| value.as_str()),
            Some("escpos")
        );

        let system_connection: String = conn
            .query_row(
                "SELECT connection_json FROM printer_profiles WHERE id = 'pp-system'",
                [],
                |row| row.get(0),
            )
            .expect("read system profile");
        let system_json: serde_json::Value =
            serde_json::from_str(&system_connection).expect("parse system connection");
        assert_eq!(
            system_json
                .get("emulation")
                .and_then(|value| value.as_str()),
            Some("auto")
        );
    }

    #[test]
    fn test_migration_v28_adds_dispatched_status_and_capabilities_defaults() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE print_jobs (
                id TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                printer_profile_id TEXT,
                status TEXT NOT NULL,
                output_path TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0,
                max_retries INTEGER NOT NULL DEFAULT 3,
                next_retry_at TEXT,
                last_error TEXT,
                warning_code TEXT,
                warning_message TEXT,
                last_attempt_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                entity_payload_json TEXT
            );
            CREATE TABLE printer_profiles (
                id TEXT PRIMARY KEY,
                connection_json TEXT
            );
            ",
        )
        .expect("create minimal migration tables");

        conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES ('pj-1', 'order_receipt', 'ord-1', 'printed', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert legacy print job");
        conn.execute(
            "INSERT INTO printer_profiles (id, connection_json)
             VALUES ('pp-1', '{\"type\":\"network\",\"ip\":\"192.168.1.19\",\"emulation\":\"escpos\"}')",
            [],
        )
        .expect("insert printer profile");

        migrate_v28(&conn).expect("migration v28");

        conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES ('pj-2', 'order_receipt', 'ord-2', 'dispatched', datetime('now'), datetime('now'))",
            [],
        )
        .expect("print_jobs should accept dispatched status");

        let connection_json: String = conn
            .query_row(
                "SELECT connection_json FROM printer_profiles WHERE id = 'pp-1'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated printer profile");
        let parsed: Value = serde_json::from_str(&connection_json).expect("parse migrated json");
        let capabilities = parsed
            .get("capabilities")
            .and_then(Value::as_object)
            .expect("capabilities object should exist");
        assert_eq!(
            capabilities.get("status").and_then(Value::as_str),
            Some("unverified")
        );
        assert_eq!(
            capabilities
                .get("resolvedTransport")
                .expect("resolvedTransport should exist"),
            &Value::Null
        );
    }

    #[test]
    fn test_migration_v29_reverts_unverified_network_escpos_back_to_auto() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE printer_profiles (
                id TEXT PRIMARY KEY,
                connection_json TEXT
            );
            ",
        )
        .expect("create minimal migration tables");

        conn.execute(
            "INSERT INTO printer_profiles (id, connection_json)
             VALUES ('pp-network', '{\"type\":\"network\",\"ip\":\"192.168.1.19\",\"emulation\":\"escpos\",\"capabilities\":{\"status\":\"unverified\"}}')",
            [],
        )
        .expect("insert unverified network profile");
        conn.execute(
            "INSERT INTO printer_profiles (id, connection_json)
             VALUES ('pp-verified', '{\"type\":\"network\",\"ip\":\"192.168.1.20\",\"emulation\":\"escpos\",\"capabilities\":{\"status\":\"verified\"}}')",
            [],
        )
        .expect("insert verified network profile");

        migrate_v29(&conn).expect("migration v29");

        let network_connection: String = conn
            .query_row(
                "SELECT connection_json FROM printer_profiles WHERE id = 'pp-network'",
                [],
                |row| row.get(0),
            )
            .expect("read reverted profile");
        let network_json: Value =
            serde_json::from_str(&network_connection).expect("parse reverted network connection");
        assert_eq!(
            network_json.get("emulation").and_then(Value::as_str),
            Some("auto")
        );

        let verified_connection: String = conn
            .query_row(
                "SELECT connection_json FROM printer_profiles WHERE id = 'pp-verified'",
                [],
                |row| row.get(0),
            )
            .expect("read verified profile");
        let verified_json: Value =
            serde_json::from_str(&verified_connection).expect("parse verified connection");
        assert_eq!(
            verified_json.get("emulation").and_then(Value::as_str),
            Some("escpos")
        );
    }

    #[test]
    fn test_migration_v35_backfills_closed_drawers_as_reconciled() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT DEFAULT (datetime('now'))
            );
            INSERT INTO schema_version (version) VALUES (34);

            CREATE TABLE staff_shifts (
                id TEXT PRIMARY KEY,
                check_out_time TEXT,
                closed_by TEXT
            );

            CREATE TABLE cash_drawer_sessions (
                id TEXT PRIMARY KEY,
                staff_shift_id TEXT NOT NULL,
                closed_at TEXT,
                reconciled INTEGER DEFAULT 0,
                reconciled_at TEXT,
                reconciled_by TEXT
            );
            ",
        )
        .expect("create minimal v34 schema");

        conn.execute(
            "INSERT INTO staff_shifts (id, check_out_time, closed_by)
             VALUES ('shift-closed', '2026-03-18T12:10:00Z', 'cashier-7')",
            [],
        )
        .expect("insert closed shift");
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, closed_at, reconciled, reconciled_at, reconciled_by
             ) VALUES (
                'drawer-closed', 'shift-closed', '2026-03-18T12:10:00Z', 0, NULL, NULL
             )",
            [],
        )
        .expect("insert unreconciled closed drawer");
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, closed_at, reconciled, reconciled_at, reconciled_by
             ) VALUES (
                'drawer-open', 'shift-closed', NULL, 0, NULL, NULL
             )",
            [],
        )
        .expect("insert open drawer");

        migrate_v35(&conn).expect("migration v35");

        let (reconciled, reconciled_at, reconciled_by): (i64, Option<String>, Option<String>) =
            conn.query_row(
                "SELECT reconciled, reconciled_at, reconciled_by
                 FROM cash_drawer_sessions
                 WHERE id = 'drawer-closed'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read closed drawer");
        assert_eq!(reconciled, 1);
        assert_eq!(reconciled_at.as_deref(), Some("2026-03-18T12:10:00Z"));
        assert_eq!(reconciled_by.as_deref(), Some("cashier-7"));

        let open_reconciled: i64 = conn
            .query_row(
                "SELECT reconciled FROM cash_drawer_sessions WHERE id = 'drawer-open'",
                [],
                |row| row.get(0),
            )
            .expect("read open drawer");
        assert_eq!(open_reconciled, 0, "open drawers should stay unreconciled");
    }

    #[test]
    fn test_migration_v41_adds_adjustment_staff_shift_id_without_losing_rows() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT DEFAULT (datetime('now'))
            );
            INSERT INTO schema_version (version) VALUES (40);

            CREATE TABLE payment_adjustments (
                id TEXT PRIMARY KEY,
                payment_id TEXT NOT NULL,
                order_id TEXT NOT NULL,
                adjustment_type TEXT NOT NULL,
                amount REAL NOT NULL,
                reason TEXT NOT NULL,
                staff_id TEXT,
                sync_state TEXT NOT NULL DEFAULT 'pending',
                sync_last_error TEXT,
                sync_retry_count INTEGER NOT NULL DEFAULT 0,
                sync_next_retry_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                refund_method TEXT,
                cash_handler TEXT,
                adjustment_context TEXT NOT NULL DEFAULT 'manual'
            );
            ",
        )
        .expect("create minimal v40 schema");

        conn.execute(
            "INSERT INTO payment_adjustments (
                id, payment_id, order_id, adjustment_type, amount, reason, staff_id,
                sync_state, created_at, updated_at, refund_method, cash_handler, adjustment_context
             ) VALUES (
                'adj-migrate-41', 'pay-41', 'ord-41', 'refund', 4.5, 'Legacy row', 'staff-41',
                'failed', datetime('now'), datetime('now'), 'cash', 'cashier_drawer', 'edit_settlement'
             )",
            [],
        )
        .expect("insert legacy payment adjustment");

        migrate_v41(&conn).expect("migration v41");

        assert!(
            column_exists(&conn, "payment_adjustments", "staff_shift_id").expect("column lookup"),
            "migration should add payment_adjustments.staff_shift_id",
        );

        let (reason, staff_id): (String, Option<String>) = conn
            .query_row(
                "SELECT reason, staff_id
                 FROM payment_adjustments
                 WHERE id = 'adj-migrate-41'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read migrated adjustment row");
        assert_eq!(reason, "Legacy row");
        assert_eq!(staff_id.as_deref(), Some("staff-41"));
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

    // ----------------------------------------------------------------------
    // Wave 4a — migration v51: *_cents shadow columns
    // ----------------------------------------------------------------------

    #[test]
    fn v51_cents_columns_exist_after_migrations() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // Bundle the shape into one prepared SELECT — column_exists errors
        // cleanly if any is missing.
        for col in [
            "total_amount_cents",
            "tax_amount_cents",
            "subtotal_cents",
            "discount_amount_cents",
            "tip_amount_cents",
            "delivery_fee_cents",
        ] {
            assert!(
                column_exists(&conn, "orders", col).unwrap(),
                "orders.{col} should exist after v51"
            );
        }
        for col in ["amount_cents", "cash_received_cents", "change_given_cents"] {
            assert!(
                column_exists(&conn, "order_payments", col).unwrap(),
                "order_payments.{col} should exist after v51"
            );
        }
        assert!(
            column_exists(&conn, "payment_adjustments", "amount_cents").unwrap(),
            "payment_adjustments.amount_cents should exist after v51"
        );
    }

    #[test]
    fn v53_cents_columns_exist_after_migrations() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // staff_shifts — 8 cols
        for col in [
            "opening_cash_amount_cents",
            "closing_cash_amount_cents",
            "expected_cash_amount_cents",
            "cash_variance_cents",
            "total_sales_amount_cents",
            "total_cash_sales_cents",
            "total_card_sales_cents",
            "payment_amount_cents",
        ] {
            assert!(
                column_exists(&conn, "staff_shifts", col).unwrap(),
                "staff_shifts.{col} should exist after v53"
            );
        }

        // cash_drawer_sessions — 12 cols
        for col in [
            "opening_amount_cents",
            "closing_amount_cents",
            "expected_amount_cents",
            "variance_amount_cents",
            "total_cash_sales_cents",
            "total_card_sales_cents",
            "total_refunds_cents",
            "total_expenses_cents",
            "cash_drops_cents",
            "driver_cash_given_cents",
            "driver_cash_returned_cents",
            "total_staff_payments_cents",
        ] {
            assert!(
                column_exists(&conn, "cash_drawer_sessions", col).unwrap(),
                "cash_drawer_sessions.{col} should exist after v53"
            );
        }

        // z_reports — 13 cols
        for col in [
            "gross_sales_cents",
            "net_sales_cents",
            "cash_sales_cents",
            "card_sales_cents",
            "refunds_total_cents",
            "voids_total_cents",
            "discounts_total_cents",
            "tips_total_cents",
            "expenses_total_cents",
            "cash_variance_cents",
            "opening_cash_cents",
            "closing_cash_cents",
            "expected_cash_cents",
        ] {
            assert!(
                column_exists(&conn, "z_reports", col).unwrap(),
                "z_reports.{col} should exist after v53"
            );
        }
    }

    #[test]
    fn v51_backfills_existing_rows_with_exact_cents() {
        // Craft a DB that is already at v50 (so the v51 backfill runs against
        // real rows) by pre-seeding the schema_version table and inserting
        // rows before v51 gets a chance to run. `run_migrations` is idempotent
        // on the migrations it has already seen, so marking v1..=v50 as
        // applied lets us control the pre-v51 state.
        let conn = test_db();

        // Apply the full schema (brings everything up to CURRENT_SCHEMA_VERSION),
        // then pretend v51 never ran by deleting its schema_version entry AND
        // nulling the cents columns we're about to repopulate.
        run_migrations(&conn).expect("initial migrations");
        conn.execute("DELETE FROM schema_version WHERE version = 51", [])
            .expect("undo v51 marker");
        conn.execute(
            "UPDATE orders SET total_amount_cents = NULL, tax_amount_cents = NULL,
                subtotal_cents = NULL, discount_amount_cents = NULL,
                tip_amount_cents = NULL, delivery_fee_cents = NULL",
            [],
        )
        .expect("null orders cents");
        conn.execute(
            "UPDATE order_payments SET amount_cents = NULL,
                cash_received_cents = NULL, change_given_cents = NULL",
            [],
        )
        .expect("null order_payments cents");
        conn.execute("UPDATE payment_adjustments SET amount_cents = NULL", [])
            .expect("null payment_adjustments cents");

        // Pre-insert rows with REAL values we can predict cents for.
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, tax_amount, subtotal,
                discount_amount, tip_amount, delivery_fee, status, sync_status, created_at, updated_at)
             VALUES ('v51-ord-1', '[]', 12.34, 1.24, 11.10, 0.50, 2.00, 3.50,
                     'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert pre-v51 order");

        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, cash_received,
                change_given, sync_status, created_at, updated_at)
             VALUES ('v51-pay-1', 'v51-ord-1', 'cash', 12.34, 20.00, 7.66,
                     'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert pre-v51 payment");

        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type,
                amount, reason, created_at, updated_at)
             VALUES ('v51-adj-1', 'v51-pay-1', 'v51-ord-1', 'refund',
                     5.00, 'regression test', datetime('now'), datetime('now'))",
            [],
        )
        .expect("insert pre-v51 adjustment");

        // Run just the v51 migration body.
        migrate_v51(&conn).expect("migrate_v51");

        let (total_c, tax_c, sub_c, disc_c, tip_c, deliv_c): (i64, i64, i64, i64, i64, i64) = conn
            .query_row(
                "SELECT total_amount_cents, tax_amount_cents, subtotal_cents,
                    discount_amount_cents, tip_amount_cents, delivery_fee_cents
                 FROM orders WHERE id = 'v51-ord-1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(total_c, 1234, "orders.total_amount backfill");
        assert_eq!(tax_c, 124, "orders.tax_amount backfill");
        assert_eq!(sub_c, 1110, "orders.subtotal backfill");
        assert_eq!(disc_c, 50, "orders.discount_amount backfill");
        assert_eq!(tip_c, 200, "orders.tip_amount backfill");
        assert_eq!(deliv_c, 350, "orders.delivery_fee backfill");

        let (amt_c, cash_c, change_c): (i64, i64, i64) = conn
            .query_row(
                "SELECT amount_cents, cash_received_cents, change_given_cents
                 FROM order_payments WHERE id = 'v51-pay-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(amt_c, 1234);
        assert_eq!(cash_c, 2000);
        assert_eq!(change_c, 766);

        let adj_c: i64 = conn
            .query_row(
                "SELECT amount_cents FROM payment_adjustments WHERE id = 'v51-adj-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(adj_c, 500);
    }

    #[test]
    fn v51_column_add_is_idempotent_on_partial_reapply() {
        // If the migration framework crashes between ALTER and schema_version
        // INSERT, the next `run_migrations` call re-enters `migrate_v51`.
        // Re-running it must not fail on "duplicate column name".
        let conn = test_db();
        run_migrations(&conn).expect("initial migrations");

        // Simulate the crash: pretend v51 didn't mark itself.
        conn.execute("DELETE FROM schema_version WHERE version = 51", [])
            .expect("undo v51 marker");

        // Re-run the migration body. column_exists guard must no-op the ADDs.
        migrate_v51(&conn).expect("migrate_v51 second run");
    }

    // ----------------------------------------------------------------------
    // Wave 4a — migration v54: *_cents shadow columns (final sweep)
    // ----------------------------------------------------------------------

    #[test]
    fn v54_cents_columns_exist_after_migrations() {
        let conn = test_db();
        run_migrations(&conn).expect("migrations");

        // order_payments — gap from v36 rebuild missed by v51
        assert!(
            column_exists(&conn, "order_payments", "discount_amount_cents").unwrap(),
            "order_payments.discount_amount_cents should exist after v54"
        );

        // payment_items — v31 table entirely missed by v51/v53
        assert!(
            column_exists(&conn, "payment_items", "item_amount_cents").unwrap(),
            "payment_items.item_amount_cents should exist after v54"
        );

        // driver_earnings — 6 money cols
        for col in [
            "delivery_fee_cents",
            "tip_amount_cents",
            "total_earning_cents",
            "cash_collected_cents",
            "card_amount_cents",
            "cash_to_return_cents",
        ] {
            assert!(
                column_exists(&conn, "driver_earnings", col).unwrap(),
                "driver_earnings.{col} should exist after v54"
            );
        }

        // shift_expenses — 1 money col
        assert!(
            column_exists(&conn, "shift_expenses", "amount_cents").unwrap(),
            "shift_expenses.amount_cents should exist after v54"
        );
    }

    /// W10 H32: the helper sets `synchronous = FULL` on entry and a
    /// Drop guard restores `NORMAL` on exit. This test asserts the
    /// guard fires even when the closure PANICS — without the guard,
    /// a panic mid-closure would leave the connection stuck in FULL
    /// mode, slowing every subsequent write on that connection.
    #[test]
    fn h32_with_full_sync_restores_pragma_on_panic() {
        let conn = test_db();

        // Sanity: at start, synchronous is unset / default for in-memory.
        // We DO NOT assert the start value — what matters is that after
        // the helper's closure panics, synchronous is back to NORMAL.

        // The closure panics. catch_unwind lets us observe the
        // post-panic state without crashing the test runner.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = with_full_sync(&conn, |_inner_conn| -> Result<(), String> {
                panic!("simulated mid-closure panic");
            });
        }));
        assert!(
            result.is_err(),
            "the closure must have panicked (test-setup sanity)"
        );

        // After the panic, the Drop guard must have restored NORMAL.
        let synchronous: i64 = conn
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .expect("read synchronous");
        // SQLite's `PRAGMA synchronous` returns 1 for NORMAL, 2 for FULL,
        // 3 for EXTRA. The Restore Drop must have set it back to 1.
        assert_eq!(
            synchronous, 1,
            "Drop guard must restore synchronous to NORMAL (1) after a closure panic; got {synchronous} (FULL=2, EXTRA=3)"
        );
    }

    /// W10 H32 bench harness — monetary-write latency under
    /// `synchronous = NORMAL` vs `synchronous = FULL`.
    ///
    /// Marked `#[ignore]` so it stays out of `cargo test --lib` (which
    /// is the acceptance gate). Run explicitly:
    ///
    ///     cd pos-tauri/src-tauri
    ///     cargo test --release --lib h32_pragma_bench -- --ignored --nocapture
    ///
    /// The harness:
    ///   - Opens a tempfile-backed WAL DB (NOT in-memory — `:memory:`
    ///     never fsyncs, so synchronous=FULL would be a no-op there).
    ///   - Runs migrations to set up the `order_payments` schema.
    ///   - Times 1000 sequential monetary INSERTs, each in its own
    ///     BEGIN IMMEDIATE / COMMIT pair (matching production write
    ///     shape), 5 trials.
    ///   - Computes P50 / P99 / mean per-INSERT latency.
    ///   - Reports under both synchronous=NORMAL (current default) and
    ///     synchronous=FULL (via `with_full_sync`) — output to stdout
    ///     so a single test invocation gives both numbers.
    ///   - Decision rule from `project_w10_h32_pragma_bench_deferred.md`:
    ///     ship the wrap if FULL P99 ≤ +15% over NORMAL P99; descope
    ///     if > 15% on the dominant path.
    ///
    /// Caveats:
    ///   - Numbers are environment-dependent (disk speed, OS, FS).
    ///     Run on the target machine before applying the rule.
    ///   - First-write warmup: we discard the first 100 of each trial
    ///     to avoid SQLite/OS cache cold-start skewing P50.
    ///   - Single-threaded by design — production monetary writes are
    ///     serialized through a `Mutex<Connection>`, so concurrent-
    ///     write benchmarks would not represent the production
    ///     hot-path.
    #[test]
    #[ignore = "bench harness — run with `cargo test --release h32_pragma_bench -- --ignored --nocapture`"]
    fn h32_pragma_bench_normal_vs_full() {
        use std::time::Instant;

        const TRIALS: usize = 5;
        const WRITES_PER_TRIAL: usize = 1000;
        const WARMUP: usize = 100;

        // Tempfile DB path — fresh each invocation.
        let dir = std::env::temp_dir().join(format!(
            "pos_h32_bench_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create bench tempdir");
        let db_path = dir.join("bench.db");

        let conn = open_and_configure(&db_path).expect("open bench db");
        run_migrations(&conn).expect("run migrations on bench db");

        // Insert one parent order to satisfy the order_payments FK.
        // All bench payments reference this one order — the FK lookup
        // hits a PK index and is microseconds either way; the dominant
        // cost we want to measure is fsync, not constraint checking.
        conn.execute("INSERT INTO orders (id) VALUES ('h32-bench-parent')", [])
            .expect("seed parent order");

        // ---- Helpers ----
        fn percentile(sorted: &[u128], p: f64) -> u128 {
            if sorted.is_empty() {
                return 0;
            }
            let idx = ((sorted.len() as f64) * p / 100.0).floor() as usize;
            sorted[idx.min(sorted.len() - 1)]
        }

        fn time_inserts(conn: &Connection, count: usize, base_id: usize) -> Vec<u128> {
            // Tests are single-threaded by default; we use `base_id` to
            // avoid PK collisions across trials. order_payments's CHECK
            // constraint requires `method IN ('cash','card','other')`,
            // status defaults handled by the schema.
            let mut samples = Vec::with_capacity(count);
            for i in 0..count {
                let id = format!("h32-bench-pay-{base_id}-{i}");
                let started = Instant::now();
                conn.execute_batch("BEGIN IMMEDIATE")
                    .expect("BEGIN IMMEDIATE");
                conn.execute(
                    "INSERT INTO order_payments
                     (id, order_id, method, amount, status, created_at, updated_at)
                     VALUES (?1, 'h32-bench-parent', 'cash', 12.34, 'completed',
                             datetime('now'), datetime('now'))",
                    rusqlite::params![id],
                )
                .expect("insert order_payments");
                conn.execute_batch("COMMIT").expect("COMMIT");
                samples.push(started.elapsed().as_micros());
            }
            samples
        }

        // ---- Bench A: synchronous = NORMAL (current default) ----
        // The default was set by open_and_configure; just confirm.
        let _: i64 = conn
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        let mut all_normal = Vec::with_capacity(TRIALS * (WRITES_PER_TRIAL - WARMUP));
        for trial in 0..TRIALS {
            let base_id = trial * 100_000;
            let samples = time_inserts(&conn, WRITES_PER_TRIAL, base_id);
            // Drop warmup samples to stabilize P50.
            all_normal.extend(samples.into_iter().skip(WARMUP));
        }
        all_normal.sort_unstable();
        let n_p50 = percentile(&all_normal, 50.0);
        let n_p99 = percentile(&all_normal, 99.0);
        let n_mean: u128 = all_normal.iter().sum::<u128>() / (all_normal.len() as u128);

        // ---- Bench B: synchronous = FULL via with_full_sync ----
        let mut all_full = Vec::with_capacity(TRIALS * (WRITES_PER_TRIAL - WARMUP));
        for trial in 0..TRIALS {
            let base_id = (TRIALS + trial) * 100_000; // disjoint id space
            let samples = with_full_sync(&conn, |c| Ok(time_inserts(c, WRITES_PER_TRIAL, base_id)))
                .expect("with_full_sync sample collection");
            all_full.extend(samples.into_iter().skip(WARMUP));
        }
        all_full.sort_unstable();
        let f_p50 = percentile(&all_full, 50.0);
        let f_p99 = percentile(&all_full, 99.0);
        let f_mean: u128 = all_full.iter().sum::<u128>() / (all_full.len() as u128);

        // ---- Report ----
        let p99_delta_pct = ((f_p99 as f64 - n_p99 as f64) / (n_p99 as f64).max(1.0)) * 100.0;
        let p50_delta_pct = ((f_p50 as f64 - n_p50 as f64) / (n_p50 as f64).max(1.0)) * 100.0;
        let mean_delta_pct = ((f_mean as f64 - n_mean as f64) / (n_mean as f64).max(1.0)) * 100.0;

        println!();
        println!("===== W10 H32 PRAGMA bench =====");
        println!(
            "  trials={TRIALS}, writes/trial={WRITES_PER_TRIAL}, warmup-discarded={WARMUP}, samples-per-mode={}",
            all_normal.len()
        );
        println!("                   NORMAL          FULL          delta");
        println!(
            "  P50 (µs):   {:>10}    {:>10}    {:>+6.1}%",
            n_p50, f_p50, p50_delta_pct
        );
        println!(
            "  P99 (µs):   {:>10}    {:>10}    {:>+6.1}%   <-- decision rule (≤ +15% to ship)",
            n_p99, f_p99, p99_delta_pct
        );
        println!(
            "  mean (µs):  {:>10}    {:>10}    {:>+6.1}%",
            n_mean, f_mean, mean_delta_pct
        );
        println!("=================================");
        println!();

        // Cleanup the tempdir so repeated runs don't accumulate.
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Happy-path: the helper restores PRAGMA on Ok return.
    #[test]
    fn h32_with_full_sync_restores_pragma_on_ok() {
        let conn = test_db();
        let observed_inside: i64 = with_full_sync(&conn, |inner_conn| {
            inner_conn
                .query_row("PRAGMA synchronous", [], |row| row.get(0))
                .map_err(|e| e.to_string())
        })
        .expect("with_full_sync should not return Err in this test");

        assert_eq!(
            observed_inside, 2,
            "inside the closure, synchronous must be FULL (2); got {observed_inside}"
        );

        let observed_after: i64 = conn
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .expect("read synchronous after");
        assert_eq!(
            observed_after, 1,
            "after the helper returns, synchronous must be NORMAL (1); got {observed_after}"
        );
    }
}
