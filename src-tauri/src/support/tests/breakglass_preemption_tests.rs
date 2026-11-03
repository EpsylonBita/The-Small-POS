use crate::support::{
    authorizer, breakglass,
    critical_op::{CriticalKind, CriticalOpGate},
    guards,
};
#[test]
fn interrupted_write_rolls_back_and_marker_is_authoritative() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _global_gate = crate::support::critical_op::install_test_gate();
    let c = super::write_guard_tests::fixture();
    let policy = guards::install(&c, &super::write_guard_tests::scope()).unwrap();
    let _native = authorizer::native_scope(&policy);
    let gate = CriticalOpGate::new();
    let permit = gate
        .try_begin_support_write(std::sync::Arc::new(c.get_interrupt_handle()))
        .unwrap();
    let tx = permit.begin_write(&c).unwrap();
    authorizer::payload(&c, &policy, "UPDATE parity_sync_queue SET attempts=0").unwrap();
    let sale = gate.begin_critical(CriticalKind::Checkout);
    assert!(permit.is_cancelled());
    assert!(breakglass::commit(
        &tx,
        &policy,
        &permit,
        "your_command",
        "2030-01-01T00:00:00Z",
        std::time::Instant::now()
    )
    .is_err());
    c.progress_handler(0, None::<fn() -> bool>);
    drop(tx);
    assert_eq!(
        breakglass::recover_outcome(&c, "your_command"),
        "rolled_back"
    );
    assert_eq!(
        c.query_row("SELECT attempts FROM parity_sync_queue", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert!(gate.try_begin_support(false, None).is_err());
    drop(sale);
}
#[test]
fn elapsed_write_cannot_commit_and_sql_tail_is_engine_refused() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _global_gate = crate::support::critical_op::install_test_gate();
    let c = super::write_guard_tests::fixture();
    let policy = guards::install(&c, &super::write_guard_tests::scope()).unwrap();
    let _native = authorizer::native_scope(&policy);
    assert!(authorizer::payload(
        &c,
        &policy,
        "UPDATE parity_sync_queue SET attempts=0; DELETE FROM orders"
    )
    .is_err());
    let gate = CriticalOpGate::new();
    let permit = gate
        .try_begin_support_write(std::sync::Arc::new(c.get_interrupt_handle()))
        .unwrap();
    let tx = permit.begin_write(&c).unwrap();
    assert_eq!(
        breakglass::commit(
            &tx,
            &policy,
            &permit,
            "your_command",
            "2030-01-01T00:00:00Z",
            std::time::Instant::now() - std::time::Duration::from_millis(251)
        ),
        Err("QUERY_TIMEOUT".into())
    );
    c.progress_handler(0, None::<fn() -> bool>);
    drop(tx);
}

#[test]
fn actual_sql_write_checks_snapshot_drift_cap_and_records_post_change_before_later_sales() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _global_gate = crate::support::critical_op::install_test_gate();
    use crate::support::{dry_run, snapshot};
    let c = super::write_guard_tests::fixture();
    let scope = super::write_guard_tests::scope();
    let policy = guards::install(&c, &scope).unwrap();
    let native = authorizer::native_scope(&policy);
    let sql = "UPDATE parity_sync_queue SET attempts=0 WHERE id='q'";
    let before = dry_run::capture(&c, std::iter::once("parity_sync_queue".into())).unwrap();
    c.execute_batch("BEGIN IMMEDIATE").unwrap();
    authorizer::payload(&c, &policy, sql).unwrap();
    let targets = dry_run::changed(&c, &before).unwrap();
    c.execute_batch("ROLLBACK").unwrap();
    let stored = dry_run::result(
        &serde_json::json!({"step":"execute"}),
        targets,
        "your_session",
        0,
        1,
        1,
        None,
    )
    .unwrap();
    let cheap = snapshot::cheap_watermark(&c).unwrap();
    let gate = CriticalOpGate::new();
    let permit = gate
        .try_begin_support_write(std::sync::Arc::new(c.get_interrupt_handle()))
        .unwrap();
    let proof = || breakglass::WriteProof {
        stored: &stored,
        cheap: &cheap,
        expiry: std::time::Instant::now() + std::time::Duration::from_secs(30),
        cap: 1,
    };
    for (cap, expiry, expected) in [
        (
            0,
            std::time::Instant::now() + std::time::Duration::from_secs(30),
            "PAYLOAD_DRIFT",
        ),
        (1, std::time::Instant::now(), "APPROVAL_EXPIRED"),
    ] {
        let result = breakglass::write_sql(
            &c,
            &policy,
            &permit,
            &scope,
            sql,
            breakglass::WriteProof {
                cap,
                expiry,
                ..proof()
            },
            "your_refused",
            "2030-01-01T00:00:00Z",
        );
        assert_eq!(result.unwrap_err(), expected);
        assert_eq!(
            breakglass::recover_outcome(&c, "your_refused"),
            "rolled_back"
        );
    }
    let post = breakglass::write_sql(
        &c,
        &policy,
        &permit,
        &scope,
        sql,
        proof(),
        "your_success",
        "2030-01-01T00:00:00Z",
    )
    .unwrap();
    assert_eq!(breakglass::recover_outcome(&c, "your_success"), "succeeded");
    c.execute_batch("UPDATE temp.support_guard_mode SET mode='sql'")
        .unwrap();
    // A later normal sale's watermark cannot overwrite this committed baseline.
    let later = super::write_guard_tests::fixture();
    later
        .execute("INSERT INTO orders(id) VALUES('your_sale')", [])
        .unwrap();
    assert_ne!(snapshot::watermarks(&later).unwrap().0, post);
    let mut drift = cheap.clone();
    drift["orders"]["count"] = serde_json::json!(99);
    let refused = breakglass::write_sql(
        &c,
        &policy,
        &permit,
        &scope,
        sql,
        breakglass::WriteProof {
            cheap: &drift,
            ..proof()
        },
        "your_drift",
        "2030-01-01T00:00:00Z",
    );
    assert_eq!(refused.unwrap_err(), "PAYLOAD_DRIFT");
    drop(native);
}

#[test]
fn long_native_statement_is_interrupted_and_rolls_back() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _global_gate = crate::support::critical_op::install_test_gate();
    let c = super::write_guard_tests::fixture();
    let policy = guards::install(&c, &super::write_guard_tests::scope()).unwrap();
    let _native = authorizer::native_scope(&policy);
    let gate = CriticalOpGate::new();
    let permit = gate
        .try_begin_support_write(std::sync::Arc::new(c.get_interrupt_handle()))
        .unwrap();
    let tx = permit.begin_write(&c).unwrap();
    let result=authorizer::payload(&c,&policy,"UPDATE parity_sync_queue SET attempts=(WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT sum(x) FROM n)");
    assert_eq!(result.unwrap_err(), "QUERY_TIMEOUT");
    c.progress_handler(0, None::<fn() -> bool>);
    drop(tx);
    assert_eq!(
        c.query_row("SELECT attempts FROM parity_sync_queue", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn checkout_payment_and_fiscal_preempt_without_releasing_the_consumed_approval() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _global_gate = crate::support::critical_op::install_test_gate();
    for kind in [
        CriticalKind::Checkout,
        CriticalKind::Card,
        CriticalKind::Fiscal,
    ] {
        let root = std::env::temp_dir().join(format!("support-consumed-{}", uuid::Uuid::new_v4()));
        let store = crate::support::db::SupportDb::open(&root).unwrap();
        store.conn.execute("INSERT INTO support_consumed_approvals(approval_id,command_id,kind,payload_sha256,credential_id,consumed_at) VALUES('your_approval','your_command','sql','your_hash','your_key','2030-01-01')", []).unwrap();
        let c = super::write_guard_tests::fixture();
        let policy = guards::install(&c, &super::write_guard_tests::scope()).unwrap();
        let _native = authorizer::native_scope(&policy);
        let gate = CriticalOpGate::new();
        let permit = gate
            .try_begin_support_write(std::sync::Arc::new(c.get_interrupt_handle()))
            .unwrap();
        let tx = permit.begin_write(&c).unwrap();
        authorizer::payload(&c, &policy, "UPDATE parity_sync_queue SET attempts=0").unwrap();
        let at = std::time::Instant::now();
        let critical = gate.begin_critical(kind);
        assert!(at.elapsed() < std::time::Duration::from_millis(250));
        assert_eq!(
            breakglass::commit(&tx, &policy, &permit, "your_command", "2030-01-01", at),
            Err("PREEMPTED_BY_CRITICAL_OPERATION".into())
        );
        c.progress_handler(0, None::<fn() -> bool>);
        drop(tx);
        assert_eq!(
            breakglass::recover_outcome(&c, "your_command"),
            "rolled_back"
        );
        assert!(gate
            .try_begin_support_write(std::sync::Arc::new(c.get_interrupt_handle()))
            .is_err());
        assert_eq!(
            store
                .conn
                .query_row("SELECT count(*) FROM support_consumed_approvals", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(store
            .conn
            .execute(
                "INSERT INTO support_consumed_approvals SELECT * FROM support_consumed_approvals",
                []
            )
            .is_err());
        drop(critical);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn startup_reports_the_business_marker_once_and_never_reexecutes_a_crashed_command() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    for committed in [true, false] {
        let root = std::env::temp_dir().join(format!("support-crash-{}", uuid::Uuid::new_v4()));
        let store = crate::support::db::SupportDb::open(&root).unwrap();
        let path = root.join("pos.db");
        let fixture = super::write_guard_tests::fixture();
        fixture
            .execute("VACUUM INTO ?1", [path.to_str().unwrap()])
            .unwrap();
        let mut command = super::delivery_tests::command();
        command.kind = "breakglass_propose_sql".into();
        command.tier = 3;
        command.payload =
            serde_json::json!({"step":"execute","sql":"UPDATE parity_sync_queue SET attempts=0"});
        command.payload_sha256 = crate::support::contracts::payload_hash(&command.payload);
        store.conn.execute("INSERT INTO support_accepted_commands(command_id,session_id,sequence,kind,payload_sha256,accepted_at,started_at,idempotency_key,state,envelope_json) VALUES(?1,?2,1,?3,?4,?5,?5,?6,'executing',?7)", rusqlite::params![command.command_id,command.session_id,command.kind,command.payload_sha256,command.server_time,command.idempotency_key,serde_json::to_string(&command).unwrap()]).unwrap();
        store.conn.execute("INSERT INTO support_consumed_approvals(approval_id,command_id,kind,payload_sha256,credential_id,consumed_at) VALUES('your_approval',?1,'sql',?2,'your_key',?3)", rusqlite::params![command.command_id,command.payload_sha256,command.server_time]).unwrap();
        {
            let mut live = rusqlite::Connection::open(&path).unwrap();
            let tx = live.transaction().unwrap();
            tx.execute("UPDATE parity_sync_queue SET attempts=0", [])
                .unwrap();
            tx.execute(
                "INSERT INTO support_txn_marker VALUES(?1,?2)",
                rusqlite::params![command.command_id, command.server_time],
            )
            .unwrap();
            if committed {
                tx.commit().unwrap();
            }
        }
        breakglass::recover(&store.conn, &path, None).unwrap();
        breakglass::recover(&store.conn, &path, None).unwrap();
        let outcome: String = store
            .conn
            .query_row("SELECT outcome FROM support_accepted_commands", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            outcome,
            if committed {
                "succeeded"
            } else {
                "rolled_back"
            }
        );
        assert_eq!(
            store
                .conn
                .query_row("SELECT count(*) FROM support_result_outbox", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let live = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            live.query_row("SELECT attempts FROM parity_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            if committed { 0 } else { 2 }
        );
        assert_eq!(
            store
                .conn
                .query_row("SELECT count(*) FROM support_consumed_approvals", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(live);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn ending_support_during_a_write_rolls_back_atomically_and_the_banner_says_so() {
    use crate::support::{db::SupportDb, session::Core};
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _test_gate = crate::support::critical_op::install_test_gate();
    let root = std::env::temp_dir().join(format!("support-end-write-{}", uuid::Uuid::new_v4()));
    let mut core = Core::new(SupportDb::open(&root).unwrap()).unwrap();
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/routes/pos-support-session.json"
    ))
    .unwrap();
    core.adopt(
        serde_json::from_value(fixture["response"]["session"].clone()).unwrap(),
        "2026-11-01T12:00:00.000Z",
    )
    .unwrap();
    let id = core.session.as_ref().unwrap().info.session_id.clone();
    core.executor
        .db
        .conn
        .execute("UPDATE support_session_state SET status='active'", [])
        .unwrap();
    let mut command = super::delivery_tests::command();
    command.session_id = id.clone();
    command.kind = "breakglass_propose_sql".into();
    command.tier = 3;
    core.executor.db.conn.execute("INSERT INTO support_accepted_commands(command_id,session_id,sequence,kind,payload_sha256,accepted_at,started_at,idempotency_key,state) VALUES(?1,?2,1,?3,?4,?5,?5,?6,'executing')", rusqlite::params![command.command_id,id,command.kind,command.payload_sha256,command.server_time,command.idempotency_key]).unwrap();
    core.executor.db.conn.execute("INSERT INTO support_consumed_approvals(approval_id,command_id,kind,payload_sha256,credential_id,consumed_at) VALUES('your_approval',?1,'sql','your_hash','your_key',?2)", rusqlite::params![command.command_id,command.server_time]).unwrap();
    let c = super::write_guard_tests::fixture();
    let policy = guards::install(&c, &super::write_guard_tests::scope()).unwrap();
    let _native = authorizer::native_scope(&policy);
    let permit = crate::support::critical_op::global()
        .try_begin_support_write(std::sync::Arc::new(c.get_interrupt_handle()))
        .unwrap();
    let tx = permit.begin_write(&c).unwrap();
    authorizer::payload(&c, &policy, "UPDATE parity_sync_queue SET attempts=0").unwrap();
    core.end("till_end", true).unwrap();
    assert!(permit.is_cancelled());
    assert_eq!(
        breakglass::commit(
            &tx,
            &policy,
            &permit,
            &command.command_id,
            &command.server_time,
            std::time::Instant::now()
        ),
        Err("PREEMPTED_BY_CRITICAL_OPERATION".into())
    );
    c.progress_handler(0, None::<fn() -> bool>);
    drop(tx);
    drop(permit);
    let outcome = breakglass::recover_outcome(&c, &command.command_id);
    core.executor
        .db
        .conn
        .execute(
            "UPDATE support_consumed_approvals SET outcome=?1",
            [outcome],
        )
        .unwrap();
    assert_eq!(core.banner(true).unwrap()["write_outcome"], "rolled_back");
    assert_eq!(
        c.query_row("SELECT attempts FROM parity_sync_queue", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    drop(core);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_sale_on_the_app_connection_after_the_snapshot_refuses_the_support_write() {
    use crate::support::{dry_run, snapshot};
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let root = std::env::temp_dir().join(format!("support-sale-drift-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("pos.db");
    let fixture = super::write_guard_tests::fixture();
    fixture
        .execute("VACUUM INTO ?1", [path.to_str().unwrap()])
        .unwrap();
    let c = rusqlite::Connection::open(&path).unwrap();
    let app = rusqlite::Connection::open(&path).unwrap();
    let scope = super::write_guard_tests::scope();
    let policy = guards::install(&c, &scope).unwrap();
    let _native = authorizer::native_scope(&policy);
    let sql = "UPDATE parity_sync_queue SET attempts=0 WHERE id='q'";
    let before = dry_run::capture(&c, std::iter::once("parity_sync_queue".into())).unwrap();
    c.execute_batch("BEGIN IMMEDIATE").unwrap();
    authorizer::payload(&c, &policy, sql).unwrap();
    let targets = dry_run::changed(&c, &before).unwrap();
    c.execute_batch("ROLLBACK").unwrap();
    let stored = dry_run::result(
        &serde_json::json!({"step":"execute"}),
        targets,
        "your_session",
        0,
        1,
        1,
        None,
    )
    .unwrap();
    let cheap = snapshot::cheap_watermark(&c).unwrap();
    app.execute(
        "INSERT INTO orders(id,status) VALUES('your_new_sale','paid')",
        [],
    )
    .unwrap();
    let gate = CriticalOpGate::new();
    let permit = gate
        .try_begin_support_write(std::sync::Arc::new(c.get_interrupt_handle()))
        .unwrap();
    let result = breakglass::write_sql(
        &c,
        &policy,
        &permit,
        &scope,
        sql,
        breakglass::WriteProof {
            stored: &stored,
            cheap: &cheap,
            expiry: std::time::Instant::now() + std::time::Duration::from_secs(30),
            cap: 1,
        },
        "your_refused",
        "2030-01-01T00:00:00Z",
    );
    assert_eq!(result.unwrap_err(), "PAYLOAD_DRIFT");
    assert_eq!(
        breakglass::recover_outcome(&c, "your_refused"),
        "rolled_back"
    );
    assert_eq!(
        app.query_row(
            "SELECT status FROM orders WHERE id='your_new_sale'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "paid"
    );
    assert_eq!(
        app.query_row("SELECT attempts FROM parity_sync_queue", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    drop(_native);
    drop(c);
    drop(app);
    std::fs::remove_dir_all(root).unwrap();
}
