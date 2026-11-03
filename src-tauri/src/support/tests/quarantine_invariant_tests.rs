use crate::support::{db::SupportDb, dry_run_groups, guards, quarantine};
use serde_json::json;
#[test]
fn verified_copy_precedes_delete_and_marker_reconciles_crash_windows() {
    let root = std::env::temp_dir().join(format!("support-quarantine-{}", uuid::Uuid::new_v4()));
    let store = SupportDb::open(&root).unwrap();
    let c = super::write_guard_tests::fixture();
    let scope = super::write_guard_tests::scope();
    let target =
        json!({"kind":"queue_items","database":"main","table":"parity_sync_queue","ids":["q"]});
    let members = dry_run_groups::expand(&c, &target, &scope).unwrap();
    quarantine::stage(
        &store.conn,
        &c,
        "your_group",
        "your_session",
        None,
        "your_reason",
        &members,
        "2030-01-01T00:00:00Z",
    )
    .unwrap();
    quarantine::reconcile(&store.conn, &c, "your_group", "your_command").unwrap();
    assert_eq!(
        store
            .conn
            .query_row("SELECT state FROM support_quarantine", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "discarded"
    );
    quarantine::stage(
        &store.conn,
        &c,
        "your_group2",
        "your_session",
        None,
        "your_reason",
        &members,
        "2030-01-01T00:00:00Z",
    )
    .unwrap();
    let copies = quarantine::load(&store.conn, "your_group2", "staged").unwrap();
    let policy = guards::install(&c, &scope).unwrap();
    let native = crate::support::authorizer::native_scope(&policy);
    c.execute_batch("BEGIN IMMEDIATE").unwrap();
    quarantine::delete_verified(&c, &policy, &scope, &copies).unwrap();
    guards::marker(&c, &policy, "your_command", "2030-01-01T00:00:00Z").unwrap();
    c.execute_batch("COMMIT").unwrap();
    quarantine::reconcile(&store.conn, &c, "your_group2", "your_command").unwrap();
    assert_eq!(
        store
            .conn
            .query_row(
                "SELECT state FROM support_quarantine WHERE group_id='your_group2'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "quarantined"
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let copies = quarantine::load(&store.conn, "your_group2", "quarantined").unwrap();
    c.execute_batch("BEGIN IMMEDIATE").unwrap();
    quarantine::restore_verified(&c, &policy, &scope, &copies).unwrap();
    c.execute_batch("COMMIT").unwrap();
    assert_eq!(
        c.query_row("SELECT hex(data) FROM parity_sync_queue", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "00FF"
    );
    drop(native);
    drop(c);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn changed_or_protected_source_refuses_the_whole_group_without_losing_a_row() {
    for (change, expected) in [
        ("UPDATE parity_sync_queue SET attempts=3", "PAYLOAD_DRIFT"),
        (
            "UPDATE parity_sync_queue SET table_name='payments'",
            "PROTECTED_RECORD",
        ),
    ] {
        let root =
            std::env::temp_dir().join(format!("support-copy-drift-{}", uuid::Uuid::new_v4()));
        let store = SupportDb::open(&root).unwrap();
        let c = super::write_guard_tests::fixture();
        let scope = super::write_guard_tests::scope();
        let members=dry_run_groups::expand(&c,&json!({"kind":"queue_items","database":"main","table":"parity_sync_queue","ids":["q"]}),&scope).unwrap();
        quarantine::stage(
            &store.conn,
            &c,
            "your_group",
            "your_session",
            None,
            "your_reason",
            &members,
            "2030-01-01T00:00:00Z",
        )
        .unwrap();
        let copies = quarantine::load(&store.conn, "your_group", "staged").unwrap();
        c.execute_batch(change).unwrap();
        let policy = guards::install(&c, &scope).unwrap();
        let native = crate::support::authorizer::native_scope(&policy);
        let tx = crate::db::immediate_transaction(&c).unwrap();
        assert_eq!(
            quarantine::delete_verified(&c, &policy, &scope, &copies).unwrap_err(),
            expected
        );
        drop(tx);
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(copies.len(), 1);
        assert!(
            quarantine::restore_verified(&c, &policy, &scope, &copies).is_err(),
            "occupied keys refuse whole restore"
        );
        drop(native);
        drop(c);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn protected_dependent_and_cascading_trigger_refuse_group_expansion() {
    let c = super::write_guard_tests::fixture();
    c.execute("INSERT INTO order_payments VALUES('your_payment','o')", [])
        .unwrap();
    assert_eq!(
        dry_run_groups::expand(
            &c,
            &json!({"kind":"orders","order_ids":["o"]}),
            &super::write_guard_tests::scope()
        )
        .unwrap_err(),
        "PROTECTED_RECORD"
    );
    let c = super::write_guard_tests::fixture();
    c.execute_batch("CREATE TABLE dependent(id TEXT PRIMARY KEY,order_id TEXT);INSERT INTO dependent VALUES('your_child','o');").unwrap();
    assert_eq!(
        dry_run_groups::expand(
            &c,
            &json!({"kind":"orders","order_ids":["o"]}),
            &super::write_guard_tests::scope()
        )
        .unwrap_err(),
        "PROTECTED_RECORD"
    );
}
