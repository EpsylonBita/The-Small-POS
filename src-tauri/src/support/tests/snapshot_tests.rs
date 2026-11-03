use crate::support::{db::SupportDb, snapshot};
#[test]
fn snapshot_disk_limit_retention_and_real_integrity() {
    let _global_gate = crate::support::critical_op::install_test_gate();
    assert_eq!(
        snapshot::check_disk(500 * 1024 * 1024 + 199, 100),
        Err("INSUFFICIENT_DISK".into())
    );
    assert!(snapshot::check_disk(500 * 1024 * 1024 + 200, 100).is_ok());
    assert!(snapshot::check_disk(499 * 1024 * 1024, 0).is_err());
    assert_eq!(snapshot::check_limit(10), Err("SNAPSHOT_LIMIT".into()));
    let root = std::env::temp_dir().join(format!("support-snapshot-{}", uuid::Uuid::new_v4()));
    let support = SupportDb::open(&root).unwrap();
    let live = root.join("pos.db");
    let c = rusqlite::Connection::open(&live).unwrap();
    c.execute_batch("CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(106); CREATE TABLE orders(id TEXT PRIMARY KEY,status TEXT); INSERT INTO orders VALUES('your_order','pending');").unwrap();
    let gate = crate::support::critical_op::CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let snap = snapshot::take(
        &support.conn,
        &live,
        "your_session",
        None,
        "pre_breakglass_sql",
        &permit,
    )
    .unwrap();
    assert!(snap.metadata()["financial_watermark"]["main"]["orders"]["sha256"].is_string());
    assert_eq!(snap.cheap["orders"]["count"], 1);
    assert_eq!(snap.metadata().as_object().unwrap().len(), 7);
    assert_eq!(
        snapshot::metadata(&support.conn, &snap.id).unwrap(),
        snap.metadata()
    );
    let copy = rusqlite::Connection::open(snap.folder.join("pos.db")).unwrap();
    assert_eq!(
        copy.query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name='support_session_state'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(copy);
    assert!(snapshot::verify(&snap).is_ok());
    std::fs::write(snap.folder.join("pos.db"), b"corrupt").unwrap();
    assert_eq!(snapshot::verify(&snap), Err("SNAPSHOT_FAILED".into()));
    assert_eq!(
        snapshot::metadata(&support.conn, &snap.id).unwrap(),
        snap.metadata(),
        "durable result metadata survives a later file failure"
    );
    snapshot::prune(&support.conn, "your_session", i64::MAX).unwrap();
    assert!(snap.folder.exists(), "active session is never pruned");
    drop(c);
    drop(support);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn eleventh_snapshot_refuses_and_retention_preserves_all_active_session_copies() {
    let _global_gate = crate::support::critical_op::install_test_gate();
    let root = std::env::temp_dir().join(format!("support-snapshot-cap-{}", uuid::Uuid::new_v4()));
    let store = SupportDb::open(&root).unwrap();
    let live = root.join("pos.db");
    let c = rusqlite::Connection::open(&live).unwrap();
    c.execute_batch(
        "CREATE TABLE schema_version(version INTEGER);INSERT INTO schema_version VALUES(106);",
    )
    .unwrap();
    let gate = crate::support::critical_op::CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    for _ in 0..10 {
        snapshot::take(
            &store.conn,
            &live,
            "your_active_session",
            None,
            "pre_breakglass_sql",
            &permit,
        )
        .unwrap();
    }
    assert_eq!(
        snapshot::take(
            &store.conn,
            &live,
            "your_active_session",
            None,
            "pre_breakglass_sql",
            &permit
        )
        .unwrap_err(),
        "SNAPSHOT_LIMIT"
    );
    snapshot::prune(&store.conn, "your_active_session", i64::MAX).unwrap();
    assert_eq!(
        store
            .conn
            .query_row("SELECT COUNT(*) FROM support_snapshots", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        10
    );
    drop(c);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn full_watermark_detects_in_place_void_without_timestamp_change() {
    let c = super::write_guard_tests::fixture();
    let before = snapshot::watermarks(&c).unwrap();
    c.execute("UPDATE orders SET status='void'", []).unwrap();
    let after = snapshot::watermarks(&c).unwrap();
    assert_ne!(before.0, after.0);
    assert_eq!(before.1, after.1);
}
