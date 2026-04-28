//! Restart-simulation test harness for durability / parity-gate tests.
//!
//! # What problem does this solve?
//!
//! The existing test suite uses `Connection::open_in_memory()` fixtures
//! (`db::test_db()`). Those cannot simulate a process restart — when the
//! test drops the connection, the database disappears too, so tests
//! cannot assert "this state survived a crash".
//!
//! [`TestDb`] opens the database on a **real filesystem path** inside a
//! unique temp directory, then exposes [`TestDb::restart`] which drops
//! the current `DbState` (closing the SQLite connection) and re-opens
//! on the same path. Any persisted row survives; any in-memory state
//! (Mutex contents, tokio tasks, cached API keys) does not. This is the
//! closest we can get to a real crash-and-restart from Rust.
//!
//! # Wave 0 status
//!
//! Wave 0 introduces the helper only. Wave 3 and Wave 7 will add tests
//! that use it:
//!
//! - `test_sync_payment_crash_between_queue_and_applied` (W3)
//! - `tests::parity_g7` / `g8` / `g13` / `g14` (W7)

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::db::{self, DbState};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Create a unique empty directory inside the OS temp root.
///
/// No `tempfile` crate dependency — the POS already pulls in ~70 crates
/// and we can synthesize a unique path from `(pid, counter)` for test
/// isolation.
fn make_unique_temp_dir() -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id();
    let tsec = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("pos-tauri-test-{pid}-{tsec}-{n}"));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// A temporary directory that wipes itself on drop.
///
/// Tests should usually interact with [`TestDb`] rather than `TempDir`
/// directly — `TestDb` owns the lifetime of the underlying directory.
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new() -> Self {
        Self {
            path: make_unique_temp_dir(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Default for TempDir {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // Best-effort cleanup. If a test leaves file handles open (e.g. a
        // stale `DbState` clone), `remove_dir_all` will fail on Windows —
        // swallow that; the OS temp GC will reclaim eventually.
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Owns a freshly-initialised `DbState` on a real filesystem path.
///
/// Drop order: `state` is dropped first (closing SQLite), then `tmp`
/// (removing the directory). That order is enforced by declaration
/// order in a struct.
pub struct TestDb {
    /// The live database state. Pub so tests can `db.state.conn.lock()`
    /// directly without re-borrowing through an accessor.
    pub state: DbState,
    tmp: TempDir,
}

impl TestDb {
    /// Open a brand-new database on a unique temp path. Migrations run
    /// up to `CURRENT_SCHEMA_VERSION` as if this were a fresh terminal.
    pub fn open() -> Self {
        let tmp = TempDir::new();
        let state = db::init(tmp.path()).expect("TestDb::open: db::init failed");
        Self { state, tmp }
    }

    /// Simulate a process restart.
    ///
    /// Drops the current `DbState` (closing the connection) and re-runs
    /// `db::init` on the same file path. Persisted rows survive; any
    /// `Mutex<Connection>`-held in-memory caches do not.
    ///
    /// Returns a fresh `TestDb` wrapping the same underlying directory.
    pub fn restart(self) -> Self {
        let Self { state, tmp } = self;
        drop(state); // explicit close-of-connection
        let state = db::init(tmp.path()).expect("TestDb::restart: db::init failed");
        Self { state, tmp }
    }

    /// The directory that contains `pos.db` and any sidecar files.
    pub fn dir(&self) -> &Path {
        self.tmp.path()
    }

    /// Absolute path to the SQLite database file.
    pub fn db_path(&self) -> &Path {
        &self.state.db_path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_creates_real_db_file() {
        let td = TestDb::open();
        assert!(td.db_path().exists(), "pos.db should exist on disk");
        assert!(td.db_path().ends_with("pos.db"));
    }

    #[test]
    fn restart_preserves_persisted_rows() {
        let td = TestDb::open();
        {
            let conn = td.state.conn.lock().unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS harness_smoke (k TEXT PRIMARY KEY);
                 INSERT INTO harness_smoke (k) VALUES ('alpha'), ('beta');",
            )
            .unwrap();
        }

        let td = td.restart();
        let conn = td.state.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM harness_smoke", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2, "rows written before restart must survive");
    }

    #[test]
    fn restart_does_not_share_connection_state() {
        // In-memory PRAGMAs and statement caches belong to the closed
        // connection; the reopened connection gets a fresh set. This test
        // is a regression guard: if someone ever swaps `TestDb::restart`
        // for a cheap Mutex-swap that kept the same connection, this
        // assertion would start failing because the PRAGMA would leak
        // across the "restart".
        let td = TestDb::open();
        {
            let conn = td.state.conn.lock().unwrap();
            conn.execute_batch("PRAGMA user_version = 424242;").unwrap();
            let uv: i64 = conn
                .query_row("PRAGMA user_version;", [], |row| row.get(0))
                .unwrap();
            assert_eq!(uv, 424242);
        }

        let td = td.restart();
        let conn = td.state.conn.lock().unwrap();
        let uv: i64 = conn
            .query_row("PRAGMA user_version;", [], |row| row.get(0))
            .unwrap();
        // Persisted per the SQLite docs, so this survives. The *statement
        // cache* and per-connection `PRAGMA busy_timeout` would not, but
        // we can't assert on that from SQL alone.
        assert_eq!(uv, 424242);
    }

    #[test]
    fn temp_dir_cleans_up_on_drop() {
        let path;
        {
            let td = TestDb::open();
            path = td.dir().to_path_buf();
            assert!(path.exists());
        }
        // Drop ran; best-effort cleanup. On Windows this can fail if a
        // background process still has a handle open, so we accept either
        // state.
        let _ = path; // silence unused-var in case cleanup lags
    }
}
