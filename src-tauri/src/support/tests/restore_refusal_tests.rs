use crate::support::critical_op::{CriticalKind, CriticalOpGate};
#[test]
fn exclusive_restore_fails_fast_for_sales_and_releases_refusals() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _global_gate = crate::support::critical_op::install_test_gate();
    let gate = CriticalOpGate::new();
    let sale = gate.begin_critical(CriticalKind::Checkout);
    assert!(gate.begin_exclusive_restore().is_err());
    drop(sale);
    let lease = gate.begin_exclusive_restore().unwrap();
    assert!(gate.restoring());
    assert!(gate.try_begin_critical(CriticalKind::Card).is_err());
    assert!(gate.try_begin_support(false, None).is_err());
    drop(lease);
    assert!(!gate.restoring());
    let _sale = gate.try_begin_critical(CriticalKind::Checkout).unwrap();
}

#[test]
fn existing_native_entry_waits_only_during_the_exclusive_lease() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _global_gate = crate::support::critical_op::install_test_gate();
    let gate = CriticalOpGate::new();
    let lease = gate.begin_exclusive_restore().unwrap();
    let (send, recv) = std::sync::mpsc::channel();
    let worker = gate.clone();
    let handle = std::thread::spawn(move || {
        let token = worker.begin_critical(CriticalKind::Checkout);
        send.send(()).unwrap();
        drop(token);
    });
    assert!(recv
        .recv_timeout(std::time::Duration::from_millis(30))
        .is_err());
    drop(lease);
    recv.recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    handle.join().unwrap();
}

#[test]
fn restore_watermark_versions_newest_and_swap_rollback() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _global_gate = crate::support::critical_op::install_test_gate();
    use crate::support::{db::SupportDb, restore, snapshot};
    let root = std::env::temp_dir().join(format!("support-restore-{}", uuid::Uuid::new_v4()));
    let store = SupportDb::open(&root).unwrap();
    let live = root.join("pos.db");
    let c = rusqlite::Connection::open(&live).unwrap();
    c.execute_batch("CREATE TABLE schema_version(version INTEGER);INSERT INTO schema_version VALUES(106);CREATE TABLE orders(id TEXT PRIMARY KEY,status TEXT);INSERT INTO orders VALUES('your_order','pending');").unwrap();
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let snap = snapshot::take(
        &store.conn,
        &live,
        "your_session",
        None,
        "pre_breakglass_sql",
        &permit,
    )
    .unwrap();
    snapshot::post_change(&store.conn, &c, &snap.id).unwrap();
    assert!(restore::validate(&store.conn, &c, &snap).is_ok());
    c.execute("UPDATE orders SET status='void'", []).unwrap();
    assert_eq!(
        restore::validate(&store.conn, &c, &snap).unwrap_err(),
        "RESTORE_WOULD_LOSE_SALES"
    );
    c.execute("UPDATE orders SET status='pending'", []).unwrap();
    let mut wrong = snap.clone();
    wrong.version = "0".into();
    assert_eq!(
        restore::validate(&store.conn, &c, &wrong).unwrap_err(),
        "POLICY_REFUSED"
    );
    let mut wrong_schema = snap.clone();
    wrong_schema.versions = serde_json::json!({"main":0});
    assert_eq!(
        restore::validate(&store.conn, &c, &wrong_schema).unwrap_err(),
        "POLICY_REFUSED"
    );
    let pre = snapshot::take(
        &store.conn,
        &live,
        "your_session",
        None,
        "pre_restore",
        &permit,
    )
    .unwrap();
    assert_eq!(
        restore::validate(&store.conn, &c, &snap).unwrap_err(),
        "POLICY_REFUSED"
    );
    struct Fail {
        calls: Vec<String>,
        rollback_fails: bool,
    }
    impl restore::Backend for Fail {
        fn close_all(&mut self) -> Result<(), String> {
            self.calls.push("close".into());
            Ok(())
        }
        fn replace(&mut self, path: &std::path::Path) -> Result<(), String> {
            self.calls.push(path.to_string_lossy().into_owned());
            if self.calls.len() == 2 || self.rollback_fails {
                Err("SNAPSHOT_FAILED".into())
            } else {
                Ok(())
            }
        }
        fn restart(&mut self) -> Result<(), String> {
            panic!("failed swap cannot report restart")
        }
    }
    let mut backend = Fail {
        calls: vec![],
        rollback_fails: false,
    };
    assert_eq!(
        restore::swap(&mut backend, &snap, &pre).unwrap_err(),
        "SNAPSHOT_FAILED"
    );
    assert_eq!(
        backend.calls[2],
        pre.folder.join("pos.db").to_string_lossy()
    );
    backend = Fail {
        calls: vec![],
        rollback_fails: true,
    };
    assert_eq!(
        restore::swap(&mut backend, &snap, &pre).unwrap_err(),
        "OUTCOME_UNKNOWN"
    );
    drop(c);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn support_connect_does_not_authorize_the_apps_manual_restore() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let c = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::run_migrations_for_test(&c);
    let pin = "your_restore_test_only";
    let hash = bcrypt::hash(pin, 4).unwrap();
    crate::db::set_setting(&c, "staff", "staff_pin_hash", &hash).unwrap();
    let db = crate::db::DbState {
        conn: std::sync::Mutex::new(c),
        db_path: ":memory:".into(),
    };
    let auth = crate::auth::AuthState::new();
    crate::auth::login(Some(serde_json::json!({"pin":pin})), &db, &auth).unwrap();
    assert!(crate::auth::has_permission(
        &auth,
        Some("pos.support.connect")
    ));
    assert!(crate::support::restore::authorize_state(&db, &auth).is_err());
}

#[test]
fn quarantine_retention_keeps_every_active_session_and_redacts_expired_groups() {
    use crate::support::{db::SupportDb, quarantine};
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let root = std::env::temp_dir().join(format!("support-retention-{}", uuid::Uuid::new_v4()));
    let store = SupportDb::open(&root).unwrap();
    let c = super::write_guard_tests::fixture();
    for (session, status) in [("your_active", "active"), ("your_ended", "ended")] {
        store.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,updated_at) VALUES(?1,?2,3,'2030-01-01','2030-01-01','2000-01-01')", rusqlite::params![session,status]).unwrap();
        store.conn.execute("INSERT INTO support_quarantine(id,group_id,session_id,source_db,source_table,source_pk_json,row_json,row_sha256,reason,state,created_at) VALUES(?1,?1,?1,'main','parity_sync_queue','{}','{}','your_hash','your_reason','quarantined','2000-01-01T00:00:00Z')", [session]).unwrap();
    }
    quarantine::prune(
        &store.conn,
        "your_other_session",
        chrono::Utc::now().timestamp_millis(),
    )
    .unwrap();
    assert_eq!(
        store
            .conn
            .query_row(
                "SELECT state FROM support_quarantine WHERE session_id='your_active'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "quarantined"
    );
    assert_eq!(
        store
            .conn
            .query_row(
                "SELECT state FROM support_quarantine WHERE session_id='your_ended'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "expired"
    );
    let listing = quarantine::list(&store.conn, &c).unwrap();
    assert!(listing
        .as_array()
        .unwrap()
        .iter()
        .all(|group| group["contents"] == "redacted" && group["reason"]["value"] == "[REDACTED]"));
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn quarantine_restore_refuses_the_whole_group_for_taken_keys_or_schema_drift() {
    use crate::support::{authorizer, db::SupportDb, dry_run_groups, guards, quarantine};
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    for schema_drift in [true, false] {
        let root =
            std::env::temp_dir().join(format!("support-group-refusal-{}", uuid::Uuid::new_v4()));
        let store = SupportDb::open(&root).unwrap();
        let c = super::write_guard_tests::fixture();
        c.execute("INSERT INTO parity_sync_queue SELECT 'your_second',table_name,record_id,module_type,attempts,data,updated_at FROM parity_sync_queue", []).unwrap();
        let scope = super::write_guard_tests::scope();
        let members = dry_run_groups::expand(&c, &serde_json::json!({"kind":"queue_items","database":"main","table":"parity_sync_queue","ids":["q"]}), &scope).unwrap();
        assert_eq!(members.len(), 2);
        quarantine::stage(
            &store.conn,
            &c,
            "your_group",
            "your_session",
            None,
            "your_reason",
            &members,
            "2030-01-01",
        )
        .unwrap();
        let copies = quarantine::load(&store.conn, "your_group", "staged").unwrap();
        c.execute("DELETE FROM parity_sync_queue", []).unwrap();
        if schema_drift {
            c.execute(
                "ALTER TABLE parity_sync_queue ADD COLUMN your_new_column TEXT",
                [],
            )
            .unwrap();
        } else {
            c.execute(
                "INSERT INTO parity_sync_queue(id) VALUES('your_second')",
                [],
            )
            .unwrap();
        }
        let policy = guards::install(&c, &scope).unwrap();
        let _native = authorizer::native_scope(&policy);
        c.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(quarantine::restore_verified(&c, &policy, &scope, &copies).is_err());
        c.execute_batch("ROLLBACK").unwrap();
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM parity_sync_queue WHERE id='q'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
