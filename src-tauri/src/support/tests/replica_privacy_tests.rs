use crate::support::{critical_op::CriticalOpGate, replica, sql_query};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
fn fixture() -> (PathBuf, Connection) {
    let dir = std::env::temp_dir().join(format!("support-replica-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let conn = Connection::open(dir.join("pos.db")).unwrap();
    conn.execute_batch("CREATE TABLE orders(id INTEGER,customer_name TEXT);CREATE TABLE staff_sessions(session_id TEXT);CREATE TABLE local_settings(setting_category TEXT,setting_key TEXT,setting_value TEXT);INSERT INTO staff_sessions VALUES('your-secret-session');INSERT INTO local_settings VALUES('staff','pin_hash','your-secret-pin');INSERT INTO local_settings VALUES('local','printer_last_known_brand:192.168.1.19','Star');").unwrap();
    (dir, conn)
}
#[test]
fn adversarial_queries_reveal_neither_original_value_nor_null_or_empty() {
    let (dir, conn) = fixture();
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/replica-adversarial-queries.json"
    ))
    .unwrap();
    for (i, value) in vectors["original_values"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        conn.execute(
            "INSERT INTO orders VALUES(?1,?2)",
            rusqlite::params![i, value.as_str()],
        )
        .unwrap();
    }
    drop(conn);
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let r = replica::build(&dir.join("pos.db"), &permit).unwrap();
    for q in vectors["queries"].as_array().unwrap() {
        let sql = q["sql"]
            .as_str()
            .unwrap()
            .replace("replica_rows", "orders")
            .replace("value", "customer_name");
        let actual = sql_query::query(&r, &json!({"sql":sql}), &permit).unwrap();
        let actual = actual["rows"].as_array().unwrap();
        let expected = q["expected_rows"].as_array().unwrap();
        assert_eq!(actual.len(), expected.len(), "{}", q["id"]);
        for (a, e) in actual.iter().zip(expected) {
            let a = &a[0];
            let value = if a.is_object() {
                a["value"].clone()
            } else {
                a.clone()
            };
            assert_eq!(value, e["result"], "{}", q["id"]);
        }
    }
    let ro =
        Connection::open_with_flags(&r.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        ro.query_row("SELECT count(*) FROM staff_sessions", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        ro.query_row(
            "SELECT setting_value FROM local_settings WHERE setting_key='pin_hash'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "[REDACTED]"
    );
    assert_eq!(
        ro.query_row(
            "SELECT setting_value FROM local_settings WHERE setting_category='local'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "Star"
    );
    // Queries remain usable with no live DB: no hidden live connection or lock.
    std::fs::remove_file(dir.join("pos.db")).unwrap();
    assert!(sql_query::query(&r, &json!({"sql":"SELECT count(*) FROM orders"}), &permit).is_ok());
    drop(ro);
    drop(r);
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn engine_refuses_functions_writes_pragmas_attaches_and_multiple_statements() {
    let (dir, conn) = fixture();
    drop(conn);
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let r = replica::build(&dir.join("pos.db"), &permit).unwrap();
    for sql in [
        "SELECT load_extension('your-extension')",
        "SELECT readfile('your-file')",
        "SELECT writefile('your-file','x')",
        "SELECT edit('x')",
        "SELECT sqlite_compileoption_get(0)",
        "PRAGMA user_version",
        "ATTACH ':memory:' AS other",
        "UPDATE orders SET id=3",
        "WITH rows AS (SELECT 1) DELETE FROM orders",
        "SELECT 1; SELECT 2",
        "SELECT * FROM staff_sessions",
        "SELECT setting_value FROM local_settings",
    ] {
        assert_eq!(
            sql_query::query(&r, &json!({"sql":sql}), &permit).unwrap_err(),
            "POLICY_REFUSED",
            "{sql}"
        );
    }
    drop(r);
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn live_source_is_engine_read_only_and_cancelled() {
    let (dir, conn) = fixture();
    drop(conn);
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let ro = replica::read_connection(
        &dir.join("pos.db"),
        &permit,
        Instant::now() + Duration::from_secs(1),
    )
    .unwrap();
    assert!(ro.execute("INSERT INTO orders(id) VALUES(1)", []).is_err());
    let _sale = gate.begin_critical(crate::support::critical_op::CriticalKind::Checkout);
    assert!(ro.query_row("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT sum(x) FROM n",[],|r|r.get::<_,i64>(0)).is_err());
    drop(ro);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn migrated_schema_columns_are_explicitly_classified() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = crate::tests::harness::TestDb::open();
    let conn = db.state.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .unwrap();
    let names = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let mut missing = Vec::new();
    for table in names {
        let mut cols = conn
            .prepare(&format!("PRAGMA table_xinfo({})", replica::quote(&table)))
            .unwrap();
        for col in cols.query_map([], |r| r.get::<_, String>(1)).unwrap() {
            let col = col.unwrap();
            if replica::desktop_map()["tables"][&table]["columns"]
                .get(&col)
                .is_none()
            {
                missing.push(format!("{table}.{col}"));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "Unclassified migrated columns: {}",
        missing.join(", ")
    );
}
#[test]
fn replica_query_deadline_and_row_cell_caps_are_native() {
    let (dir, conn) = fixture();
    conn.execute("INSERT INTO orders VALUES(1,?1)", ["x".repeat(4000)])
        .unwrap();
    drop(conn);
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let r = replica::build(&dir.join("pos.db"), &permit).unwrap();
    let result=sql_query::query(&r,&json!({"sql":"WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<500) SELECT x FROM n","max_rows":200}),&permit).unwrap();
    assert_eq!(result["row_count"], 200);
    assert_eq!(result["truncation"]["rows"], true);
    let conn =
        replica::query_connection(&r, &permit, Instant::now() - Duration::from_millis(1)).unwrap();
    assert!(conn.query_row("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<100000) SELECT sum(x) FROM n",[],|r|r.get::<_,i64>(0)).is_err());
    drop(conn);
    drop(r);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unclassified_cells_and_constraint_metadata_cannot_leak() {
    let (dir, conn) = fixture();
    conn.execute_batch("ALTER TABLE orders ADD COLUMN future_pii TEXT;INSERT INTO orders VALUES(1,NULL,'your-unclassified-canary');CREATE TABLE future_secret(value TEXT);INSERT INTO future_secret VALUES('your-secret-canary');CREATE TABLE safe_view_source(customer_name TEXT DEFAULT 'your-default-canary');CREATE VIEW unsafe_view AS SELECT 'your-view-canary' AS value;").unwrap();
    drop(conn);
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let r = replica::build(&dir.join("pos.db"), &permit).unwrap();
    let clean =
        Connection::open_with_flags(&r.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        clean
            .query_row("SELECT future_pii FROM orders", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "[REDACTED]"
    );
    assert_eq!(
        clean
            .query_row("SELECT count(*) FROM future_secret", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        clean
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE type='view'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let sql = clean
        .query_row("SELECT group_concat(sql) FROM sqlite_schema", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap();
    assert!(!sql.contains("your-default-canary"));
    drop(clean);
    drop(r);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn source_index_order_cannot_reveal_classified_value_order() {
    let (dir, conn) = fixture();
    conn.execute_batch("ALTER TABLE orders ADD COLUMN opaque_blob BLOB;CREATE INDEX private_order ON orders(customer_name,id);").unwrap();
    conn.execute(
        "INSERT INTO orders VALUES(1,'Zed',zeroblob(50000)),(2,'Ada',zeroblob(50000))",
        [],
    )
    .unwrap();
    drop(conn);
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let r = replica::build(&dir.join("pos.db"), &permit).unwrap();
    let result = sql_query::query(&r, &json!({"sql":"SELECT id FROM orders"}), &permit).unwrap();
    assert_eq!(result["rows"], json!([[1], [2]]));
    drop(r);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn admitted_safe_column_affinity_preserves_sql_comparison_semantics() {
    let (dir, conn) = fixture();
    conn.execute("INSERT INTO orders VALUES(1,'your-pii-canary')", [])
        .unwrap();
    drop(conn);
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let r = replica::build(&dir.join("pos.db"), &permit).unwrap();
    let result = sql_query::query(
        &r,
        &json!({"sql":"SELECT count(*) FROM orders WHERE id='1'"}),
        &permit,
    )
    .unwrap();
    assert_eq!(result["rows"], json!([[1]]));
    drop(r);
    std::fs::remove_dir_all(dir).unwrap();
}
