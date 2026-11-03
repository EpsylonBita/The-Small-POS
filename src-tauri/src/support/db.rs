use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub const VERSION: i64 = 3;
#[cfg(test)]
pub const TABLES: &[&str] = &[
    "support_session_state",
    "support_pending_notices",
    "support_accepted_commands",
    "support_consumed_approvals",
    "support_key_signcounts",
    "support_revoked_keys",
    "support_dry_runs",
    "support_validations",
    "support_device_applies",
    "support_audit_local",
    "support_snapshots",
    "support_quarantine",
    "support_network_evidence",
];

pub struct SupportDb {
    pub conn: Connection,
    // Used by task 17.6 (Phase 3 restore snapshots).
    #[allow(dead_code)]
    pub path: PathBuf,
}

/// Startup failure disables support while leaving selling available.
pub fn initialize(app_data: &Path) -> Result<(), String> {
    let result = initialize_runtime(app_data);
    // Other native services reopen DbState after the singleton has started.
    let available = result.is_ok()
        || result
            .as_ref()
            .is_err_and(|error| error == "support already initialized");
    startup_observations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(app_data.to_path_buf(), available);
    result
}

fn startup_observations() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, bool>> {
    static OBSERVATIONS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, bool>>,
    > = std::sync::OnceLock::new();
    OBSERVATIONS.get_or_init(Default::default)
}

/// Sanitized diagnostic evidence, independent of the failed support connection.
pub fn startup_health(app_data: &Path) -> serde_json::Value {
    match startup_observations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(app_data)
    {
        Some(true) => serde_json::json!({"status":"available"}),
        Some(false) => {
            serde_json::json!({"status":"unavailable","code":"SUPPORT_DATABASE_UNAVAILABLE",
            "guidance":"Remote support is unavailable. You can keep selling. Restart the till; if this continues, export diagnostics for support."})
        }
        None => serde_json::json!({"status":"not_observed"}),
    }
}

fn initialize_runtime(app_data: &Path) -> Result<(), String> {
    let db = SupportDb::open(app_data)?;
    #[cfg(not(test))]
    {
        super::tools::initialize(app_data)?;
        super::session::initialize(db)
    }
    #[cfg(test)]
    {
        drop(db);
        Ok(())
    }
}

impl SupportDb {
    pub fn open(app_data: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
        let path = app_data.join("support.db");
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        conn.busy_timeout(Duration::from_millis(100))
            .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| e.to_string())?;
        Self::migrate(&conn)?;
        let tx = transaction(&conn).map_err(|e| e.to_string())?;
        tx.execute_batch("UPDATE support_device_applies SET state='unknown' WHERE state='saving'; UPDATE support_device_applies SET state='undo_unknown' WHERE state='undoing';").map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Self { conn, path })
    }

    fn migrate(conn: &Connection) -> Result<(), String> {
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version > VERSION {
            return Err("support.db schema is newer than this build".into());
        }
        if version == VERSION {
            return Ok(());
        }
        let tx = transaction(conn).map_err(|e| e.to_string())?;
        let mut current = version;
        if current == 0 {
            tx.execute_batch(include_str!("schema.sql"))
                .map_err(|e| e.to_string())?;
            // Fresh installs already contain the v2 device columns.
            current = 2;
        }
        if current == 1 {
            tx.execute_batch("ALTER TABLE support_device_applies ADD COLUMN state TEXT NOT NULL DEFAULT 'unknown'; ALTER TABLE support_device_applies ADD COLUMN applied_config_json TEXT; ALTER TABLE support_device_applies ADD COLUMN admission_json TEXT;").map_err(|e|e.to_string())?;
            current = 2;
        }
        if current == 2 {
            migrate_notices(&tx).map_err(|e| e.to_string())?;
        }
        tx.execute_batch("UPDATE support_device_applies SET state='unknown' WHERE state='saving'; UPDATE support_device_applies SET state='undo_unknown' WHERE state='undoing';").map_err(|e|e.to_string())?;
        tx.pragma_update(None, "user_version", VERSION)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
thread_local! {
    static FAIL_AFTER_NOTICE_COPY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn migrate_notices(conn: &Connection) -> rusqlite::Result<()> {
    // Autoindexes have NULL SQL and are recreated by the PRIMARY KEY declaration.
    let objects = conn.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='support_pending_notices' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")?
        .query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let before: i64 = conn.query_row("SELECT count(*) FROM support_pending_notices", [], |r| {
        r.get(0)
    })?;
    conn.execute_batch("CREATE TABLE support_pending_notices_upgrade (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('end','cancel_code','consent_decline')),
        body_json TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT);
        INSERT INTO support_pending_notices_upgrade SELECT id,kind,body_json,created_at,sent_at FROM support_pending_notices;")?;
    #[cfg(test)]
    if FAIL_AFTER_NOTICE_COPY.with(|fail| fail.replace(false)) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let after: i64 = conn.query_row(
        "SELECT count(*) FROM support_pending_notices_upgrade",
        [],
        |r| r.get(0),
    )?;
    if before != after {
        return Err(rusqlite::Error::InvalidQuery);
    }
    conn.execute_batch("DROP TABLE support_pending_notices; ALTER TABLE support_pending_notices_upgrade RENAME TO support_pending_notices;")?;
    for sql in objects {
        conn.execute_batch(&sql)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy(conn: &Connection, version: i64) {
        let mut sql = include_str!("schema.sql").replace(
            "'end','cancel_code','consent_decline'",
            "'end','cancel_code'",
        );
        if version == 1 {
            sql = sql.replace(",\n  state TEXT NOT NULL DEFAULT 'unknown', applied_config_json TEXT, admission_json TEXT", "");
        }
        conn.execute_batch(&sql).unwrap();
        conn.pragma_update(None, "user_version", version).unwrap();
        conn.execute_batch(
            "INSERT INTO support_pending_notices VALUES
            ('your_pending','end',' { \"value\":\"retained\" } ','your_time',NULL),
            ('your_sent','cancel_code','{}','your_time','your_sent_time'),
            ('your_retired','end','{\"reason\":\"refused\"}','your_time','your_retired_time');",
        )
        .unwrap();
    }

    fn notice_bytes(conn: &Connection) -> Vec<Vec<rusqlite::types::Value>> {
        conn.prepare("SELECT * FROM support_pending_notices ORDER BY id")
            .unwrap()
            .query_map([], |r| (0..5).map(|i| r.get(i)).collect())
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn notice_upgrade_preserves_every_value_from_each_older_version() {
        for version in 0..VERSION {
            let conn = Connection::open_in_memory().unwrap();
            let before = if version == 0 {
                vec![]
            } else {
                legacy(&conn, version);
                notice_bytes(&conn)
            };
            SupportDb::migrate(&conn).unwrap();
            assert_eq!(notice_bytes(&conn), before);
            assert_eq!(
                conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                    .unwrap(),
                VERSION
            );
            // No user-created index or trigger may silently disappear on rebuild.
            assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_schema WHERE tbl_name='support_pending_notices' AND type IN ('index','trigger') AND sql IS NOT NULL", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
            let indexes: Vec<(String, i64, String)> = conn
                .prepare("PRAGMA index_list(support_pending_notices)")
                .unwrap()
                .query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(3)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            assert_eq!(indexes.len(), 1);
            assert_eq!((indexes[0].1, indexes[0].2.as_str()), (1, "pk"));
            assert_eq!(
                conn.query_row(
                    "SELECT name FROM pragma_index_info(?1)",
                    [&indexes[0].0],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                "id"
            );
            let db = SupportDb {
                conn,
                path: PathBuf::new(),
            };
            super::super::session::queue_notice(&db, "consent_decline", serde_json::json!({}), 0)
                .unwrap();
            assert!(
                super::super::session::queue_notice(&db, "unknown", serde_json::json!({}), 0)
                    .is_err()
            );
            assert!(db.conn.execute("INSERT INTO support_pending_notices VALUES('your_invalid','end',NULL,'your_time',NULL) ON CONFLICT(id) DO NOTHING", []).is_err());
            let retained = notice_bytes(&db.conn);
            let changes = db.conn.total_changes();
            SupportDb::migrate(&db.conn).unwrap();
            assert_eq!(db.conn.total_changes(), changes);
            assert_eq!(notice_bytes(&db.conn), retained);
        }
    }

    #[test]
    fn notice_upgrade_recreates_indexes_and_triggers() {
        let conn = Connection::open_in_memory().unwrap();
        legacy(&conn, 2);
        conn.execute_batch("CREATE INDEX your_notice_kind ON support_pending_notices(kind);
            CREATE TRIGGER your_notice_guard BEFORE DELETE ON support_pending_notices BEGIN SELECT RAISE(ABORT,'your_guard'); END;").unwrap();
        let before = notice_bytes(&conn);
        SupportDb::migrate(&conn).unwrap();
        assert_eq!(notice_bytes(&conn), before);
        assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_schema WHERE name IN ('your_notice_kind','your_notice_guard')", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        assert!(conn
            .execute("DELETE FROM support_pending_notices", [])
            .is_err());
    }

    #[test]
    fn support_open_failure_leaves_business_startup_available_with_health_evidence() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let root =
            std::env::temp_dir().join(format!("support-open-failure-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("support.db")).unwrap();
        let selling = crate::db::init(&root).unwrap();
        assert_eq!(
            crate::diagnostics::get_system_health(&selling).unwrap()["remoteSupport"]["code"],
            "SUPPORT_DATABASE_UNAVAILABLE"
        );
        drop(selling);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notice_copy_failure_rolls_back_and_startup_reports_unavailable_while_selling_starts() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        for version in 0..VERSION {
            let root = std::env::temp_dir()
                .join(format!("support-failed-upgrade-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let conn = Connection::open(root.join("support.db")).unwrap();
            let before = if version == 0 {
                vec![]
            } else {
                legacy(&conn, version);
                notice_bytes(&conn)
            };
            FAIL_AFTER_NOTICE_COPY.with(|fail| fail.set(true));
            // The actual business startup catches support initialization failure.
            let selling = crate::db::init(&root).unwrap();
            assert_eq!(startup_health(&root)["status"], "unavailable");
            assert_eq!(
                crate::diagnostics::get_system_health(&selling).unwrap()["remoteSupport"]["status"],
                "unavailable"
            );
            assert!(startup_health(&root)["guidance"]
                .as_str()
                .unwrap()
                .contains("keep selling"));
            assert_eq!(
                conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                    .unwrap(),
                version
            );
            assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_schema WHERE name='support_pending_notices_upgrade'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
            if version > 0 {
                assert_eq!(notice_bytes(&conn), before);
                assert!(conn.execute("INSERT INTO support_pending_notices VALUES('your_decline','consent_decline','{}','your_time',NULL)", []).is_err());
            }
            drop(selling);
            drop(conn);
            assert!(initialize(&root).is_ok());
            assert_eq!(startup_health(&root)["status"], "available");
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn phase_two_migration_preserves_v1_records_and_recovers_interrupted_saves() {
        let root = std::env::temp_dir().join(format!("support-upgrade-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let conn = Connection::open(root.join("support.db")).unwrap();
        let old=include_str!("schema.sql").replace("\r\n","\n").replace(",\n  state TEXT NOT NULL DEFAULT 'unknown', applied_config_json TEXT, admission_json TEXT","");
        conn.execute_batch(&old).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute(
            "INSERT INTO support_revoked_keys VALUES('your_revoked_key','your_time','your_time')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO support_device_applies VALUES('your_apply','your_validation','printer','your_printer',NULL,'your_time',NULL)",[]).unwrap();
        drop(conn);
        let db = SupportDb::open(&root).unwrap();
        assert_eq!(
            db.conn
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            VERSION
        );
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM support_revoked_keys", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        db.conn
            .execute("UPDATE support_device_applies SET state='saving'", [])
            .unwrap();
        drop(db);
        let reopened = SupportDb::open(&root).unwrap();
        assert_eq!(
            reopened
                .conn
                .query_row("SELECT state FROM support_device_applies", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "unknown"
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn separate_versioned_state_survives_business_replacement_and_vacuum() {
        let root = std::env::temp_dir().join(format!("support-db-{}", uuid::Uuid::new_v4()));
        let db = SupportDb::open(&root).unwrap();
        for name in TABLES {
            let n: i64 = db
                .conn
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name=?1",
                    [name],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{name}");
        }
        db.conn
            .execute(
                "INSERT INTO support_revoked_keys VALUES ('revoked','now','now')",
                [],
            )
            .unwrap();
        let business = Connection::open(root.join("pos.db")).unwrap();
        business
            .execute_batch("CREATE TABLE orders(id TEXT)")
            .unwrap();
        business
            .execute(
                "VACUUM INTO ?1",
                [root.join("snapshot.db").to_str().unwrap()],
            )
            .unwrap();
        let snapshot = Connection::open(root.join("snapshot.db")).unwrap();
        assert_eq!(
            snapshot
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE name LIKE 'support_%'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        drop(snapshot);
        drop(business);
        std::fs::copy(root.join("snapshot.db"), root.join("pos.db")).unwrap();
        drop(db);
        let reopened = SupportDb::open(&root).unwrap();
        assert_eq!(
            reopened
                .conn
                .query_row("SELECT count(*) FROM support_revoked_keys", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Removes the deadline before rollback/drop, so an expired state operation
/// cannot poison later support heartbeats or prevent transaction cleanup.
pub struct StateTransaction<'a> {
    conn: &'a Connection,
    transaction: Option<rusqlite::Transaction<'a>>,
}
impl std::ops::Deref for StateTransaction<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn
    }
}
impl StateTransaction<'_> {
    pub fn commit(mut self) -> rusqlite::Result<()> {
        self.transaction
            .take()
            .expect("live support transaction")
            .commit()
    }
}
impl Drop for StateTransaction<'_> {
    fn drop(&mut self) {
        self.conn.progress_handler(0, None::<fn() -> bool>);
    }
}
pub fn transaction(conn: &Connection) -> rusqlite::Result<StateTransaction<'_>> {
    conn.busy_timeout(Duration::from_millis(100))?;
    let transaction = crate::db::immediate_transaction(conn)?;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    conn.progress_handler(100, Some(move || std::time::Instant::now() >= deadline));
    Ok(StateTransaction {
        conn,
        transaction: Some(transaction),
    })
}
