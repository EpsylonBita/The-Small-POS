use super::*;
use crate::support::{critical_op, db::SupportDb, snapshot};

fn fixture() -> (PathBuf, SupportDb, snapshot::Snapshot) {
    let root = std::env::temp_dir().join(format!("support-startup-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let store = SupportDb::open(&root).unwrap();
    let live = Connection::open(root.join("pos.db")).unwrap();
    live.execute_batch("CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(106);
        CREATE TABLE orders(id TEXT PRIMARY KEY,status TEXT); INSERT INTO orders VALUES('your_order','pending');
        CREATE TABLE payments(id TEXT); CREATE TABLE shifts(id TEXT); CREATE TABLE z_reports(id TEXT); CREATE TABLE sync_queue(id TEXT);").unwrap();
    let now = Utc::now().timestamp_millis();
    let cap = crate::support::clock::iso(now + 60_000);
    store.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,updated_at) VALUES('your_session','active',3,?1,?1,?1)", [&cap]).unwrap();
    let private = critical_op::CriticalOpGate::new();
    let permit = private.try_begin_support(false, None).unwrap();
    let snap = snapshot::take(
        &store.conn,
        &root.join("pos.db"),
        "your_session",
        None,
        "pre_breakglass_sql",
        &permit,
    )
    .unwrap();
    live.execute("UPDATE orders SET status='support_changed'", [])
        .unwrap();
    snapshot::post_change(&store.conn, &live, &snap.id).unwrap();
    (root, store, snap)
}

fn stage(root: &Path, store: &SupportDb, snap: &snapshot::Snapshot) {
    crate::support::restore::stage_restore(
        &store.conn,
        &root.join("pos.db"),
        &snap.id,
        "your_session",
        None,
    )
    .unwrap();
}

#[test]
fn support_startup_rechecks_full_watermark_for_every_business_write() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for sql in [
        "UPDATE orders SET status='void'",
        "INSERT INTO orders VALUES('your_sale','paid')",
        "INSERT INTO payments VALUES('your_payment')",
        "INSERT INTO shifts VALUES('your_shift')",
        "INSERT INTO z_reports VALUES('your_z')",
        "INSERT INTO sync_queue VALUES('your_sync')",
    ] {
        let (root, store, snap) = fixture();
        stage(&root, &store, &snap);
        Connection::open(root.join("pos.db"))
            .unwrap()
            .execute_batch(sql)
            .unwrap();
        let result = maybe_apply_pending_restore(&root).unwrap().unwrap();
        assert_eq!(result["status"], "refused");
        assert_eq!(result["error_code"], "RESTORE_WOULD_LOSE_SALES");
        let live = Connection::open(root.join("pos.db")).unwrap();
        assert_ne!(snapshot::watermarks(&live).unwrap().0, snap.full);
        assert!(crate::support::audit_local::pending(&store.conn)
            .unwrap()
            .iter()
            .any(|a| a.status.as_deref() == Some("RESTORE_WOULD_LOSE_SALES")));
        drop(live);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn support_startup_discards_at_either_session_expiry() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for field in ["max_expires_at", "absolute_cap_at"] {
        let (root, store, snap) = fixture();
        stage(&root, &store, &snap);
        store
            .conn
            .execute(
                &format!("UPDATE support_session_state SET {field}='2000-01-01T00:00:00Z'"),
                [],
            )
            .unwrap();
        let result = maybe_apply_pending_restore(&root).unwrap().unwrap();
        assert_eq!(result["status"], "expired");
        assert!(!pending_restore_dir(&recovery_root_for_app_data(&root)).exists());
        assert!(crate::support::audit_local::pending(&store.conn)
            .unwrap()
            .iter()
            .any(|a| a.status.as_deref() == Some("SESSION_ENDED")));
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn support_staging_releases_sales_and_startup_reports_applied_without_restarting() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let (root, store, snap) = fixture();
    store.conn.execute("INSERT INTO support_result_outbox VALUES('your_other_command','your_session','{}',0,0)", []).unwrap();
    stage(&root, &store, &snap);
    assert!(!critical_op::global().restoring());
    let sale = critical_op::global()
        .try_begin_critical(critical_op::CriticalKind::Checkout)
        .unwrap();
    assert_eq!(crate::support::restore::notice(&root)["status"], "staged");
    drop(sale);
    let result = maybe_apply_pending_restore(&root).unwrap().unwrap();
    assert_eq!(result["status"], "applied");
    assert_eq!(crate::support::restore::notice(&root)["status"], "applied");
    let live = Connection::open(root.join("pos.db")).unwrap();
    assert_eq!(snapshot::watermarks(&live).unwrap().0, snap.full);
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM support_result_outbox", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(live);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn support_mid_swap_failure_rolls_back_and_allows_normal_startup() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let (root, store, snap) = fixture();
    stage(&root, &store, &snap);
    struct Fail;
    impl PendingRestoreApplyHooks for Fail {
        fn before_marker_commit(&mut self, _: &Path) -> Result<(), String> {
            Err("your_injected_failure".into())
        }
    }
    let result = maybe_apply_pending_restore_with_hooks(&root, &mut Fail)
        .unwrap()
        .unwrap();
    assert_eq!(result["status"], "rolled_back");
    let live = Connection::open(root.join("pos.db")).unwrap();
    assert_eq!(
        live.query_row("SELECT status FROM orders", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "support_changed"
    );
    assert!(maybe_apply_pending_restore(&root).unwrap().is_none());
    drop(live);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn support_restart_recovers_a_process_killed_between_file_moves() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let (root, store, snap) = fixture();
    stage(&root, &store, &snap);
    let pending = pending_restore_dir(&recovery_root_for_app_data(&root));
    let rollback = pending.join("rollback");
    fs::create_dir(&rollback).unwrap();
    write_json_file(&pending.join(SUPPORT_SWAP_FILE), &vec!["pos.db"]).unwrap();
    fs::rename(root.join("pos.db"), rollback.join("pos.db")).unwrap();
    fs::write(root.join("pos.db"), b"your_partial_copy").unwrap();
    let result = maybe_apply_pending_restore(&root).unwrap().unwrap();
    assert_eq!(result["status"], "rolled_back");
    let live = Connection::open(root.join("pos.db")).unwrap();
    assert_eq!(
        live.query_row("SELECT status FROM orders", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "support_changed"
    );
    drop(live);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn support_startup_refuses_changed_settings_and_an_obsolete_snapshot() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for later_snapshot in [true, false] {
        let (root, store, snap) = fixture();
        stage(&root, &store, &snap);
        if later_snapshot {
            let private = critical_op::CriticalOpGate::new();
            let permit = private.try_begin_support(false, None).unwrap();
            snapshot::take(
                &store.conn,
                &root.join("pos.db"),
                "your_session",
                None,
                "pre_quarantine",
                &permit,
            )
            .unwrap();
        } else {
            fs::write(root.join("settings.json"), b"your_later_setting").unwrap();
        }
        assert_eq!(
            maybe_apply_pending_restore(&root).unwrap().unwrap()["status"],
            "refused"
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn support_remote_restore_keeps_the_result_pending_until_startup_and_preserves_quarantine() {
    use crate::support::{clock, contracts, restore};
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for changed in [true, false] {
        let (root, store, snap) = fixture();
        let at = clock::iso(Utc::now().timestamp_millis());
        let payload = json!({"step":"execute","target":{"kind":"snapshot","snapshot_id":snap.id}});
        let command = contracts::Command {
            command_id: "your_restore_command".into(),
            session_id: "your_session".into(),
            sequence: 1,
            kind: "breakglass_propose_restore".into(),
            tier: 3,
            payload: payload.clone(),
            payload_sha256: contracts::payload_hash(&payload),
            idempotency_key: "your_restore_command".into(),
            call_id: "your_restore_command".into(),
            created_at: at.clone(),
            expires_at: clock::iso(Utc::now().timestamp_millis() + 60_000),
            server_time: at.clone(),
            approval: None,
        };
        store.conn.execute("INSERT INTO support_accepted_commands(command_id,session_id,sequence,kind,payload_sha256,accepted_at,started_at,idempotency_key,state,envelope_json) VALUES(?1,?2,1,?3,?4,?5,?5,?1,'executing',?6)", rusqlite::params![command.command_id,command.session_id,command.kind,command.payload_sha256,at,serde_json::to_string(&command).unwrap()]).unwrap();
        store.conn.execute("INSERT INTO support_consumed_approvals(approval_id,command_id,kind,payload_sha256,credential_id,consumed_at) VALUES('your_approval',?1,'restore',?2,'your_key',?3)", rusqlite::params![command.command_id,command.payload_sha256,at]).unwrap();
        let saved_row = json!({"id":"your_order","status":"pending"});
        let saved_schema: String = Connection::open(snap.folder.join("pos.db"))
            .unwrap()
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name='orders'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        store.conn.execute("INSERT INTO support_quarantine(id,group_id,session_id,source_db,source_table,source_pk_json,row_json,row_sha256,reason,state,created_at) VALUES('your_copy','your_group','your_session','main','orders',?1,?2,?3,'your_reason','quarantined',?4)", rusqlite::params![json!({"id":"your_order"}).to_string(),json!({"schema":saved_schema,"row":saved_row}).to_string(),contracts::payload_hash(&saved_row),at]).unwrap();
        restore::stage_restore(
            &store.conn,
            &root.join("pos.db"),
            &snap.id,
            "your_session",
            Some(&command.command_id),
        )
        .unwrap();
        let pending: String = store
            .conn
            .query_row("SELECT result_json FROM support_result_outbox", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&pending).unwrap()["outcome"],
            "pending"
        );
        if changed {
            Connection::open(root.join("pos.db"))
                .unwrap()
                .execute("INSERT INTO orders VALUES('your_sale','paid')", [])
                .unwrap();
        }
        maybe_apply_pending_restore(&root).unwrap();
        restore::report_startup(&store.conn, &root, &command.command_id).unwrap();
        restore::report_startup(&store.conn, &root, &command.command_id).unwrap();
        let result: String = store
            .conn
            .query_row("SELECT result_json FROM support_result_outbox", [], |r| {
                r.get(0)
            })
            .unwrap();
        let result: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            result["outcome"],
            if changed { "rolled_back" } else { "succeeded" }
        );
        if changed {
            assert_eq!(result["error_code"], "RESTORE_WOULD_LOSE_SALES");
        }
        assert_eq!(
            store
                .conn
                .query_row("SELECT count(*) FROM support_quarantine", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .conn
                .query_row("SELECT state FROM support_quarantine", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            if changed { "quarantined" } else { "restored" }
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn support_staging_does_not_hold_a_sale_that_has_already_started() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let (root, store, snap) = fixture();
    let sale = critical_op::global().begin_critical(critical_op::CriticalKind::Checkout);
    assert_eq!(
        crate::support::restore::stage_restore(
            &store.conn,
            &root.join("pos.db"),
            &snap.id,
            "your_session",
            None
        )
        .unwrap_err(),
        "deferred_critical_operation"
    );
    assert_eq!(
        snapshot::newest(&store.conn).unwrap().as_deref(),
        Some(snap.id.as_str())
    );
    assert!(!critical_op::global().restoring());
    drop(sale);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn support_staging_pins_the_original_window_even_if_the_session_is_extended() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let (root, store, snap) = fixture();
    stage(&root, &store, &snap);
    let pending = pending_restore_dir(&recovery_root_for_app_data(&root));
    let mut intent: SupportPendingRestore =
        serde_json::from_slice(&fs::read(pending.join(SUPPORT_RESTORE_FILE)).unwrap()).unwrap();
    intent.max_expires_at = "2000-01-01T00:00:00Z".into();
    write_support_restore_json(&pending.join(SUPPORT_RESTORE_FILE), &intent).unwrap();
    store.conn.execute("UPDATE support_session_state SET max_expires_at='2099-01-01T00:00:00Z',absolute_cap_at='2099-01-01T00:00:00Z'", []).unwrap();
    assert_eq!(
        maybe_apply_pending_restore(&root).unwrap().unwrap()["status"],
        "expired"
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn support_expiry_uses_authenticated_monotonic_time_and_refuses_a_different_boot() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for reboot in [true, false] {
        let (root, store, snap) = fixture();
        stage(&root, &store, &snap);
        let pending = pending_restore_dir(&recovery_root_for_app_data(&root));
        let mut intent: SupportPendingRestore =
            serde_json::from_slice(&fs::read(pending.join(SUPPORT_RESTORE_FILE)).unwrap()).unwrap();
        if reboot {
            intent.clock.boot_id[0] ^= 1;
        } else {
            intent.clock.server_ms += 120_000;
        }
        write_support_restore_json(&pending.join(SUPPORT_RESTORE_FILE), &intent).unwrap();
        // Local UTC and the stored caps still suggest a valid session. Only the
        // boot-bound authenticated time can decide whether startup may apply it.
        assert_eq!(
            maybe_apply_pending_restore(&root).unwrap().unwrap()["status"],
            "expired"
        );
        let live = Connection::open(root.join("pos.db")).unwrap();
        assert_eq!(
            live.query_row("SELECT status FROM orders", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "support_changed"
        );
        drop(live);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
}
