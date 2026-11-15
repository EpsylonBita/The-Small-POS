#[test]
fn replica_build_uses_its_thirty_second_cap_and_queries_keep_five_seconds() {
    use crate::support::{contracts, replica};
    assert_eq!(replica::build_budget().as_millis(), 30_000);
    assert_eq!(
        replica::build_budget().as_millis(),
        u128::from(contracts::cap("performance", "replicaBuildMs"))
    );
    assert_eq!(contracts::cap("tools", "sqlMs"), 5_000);
}

#[test]
fn constant_query_avoids_replica_build_and_still_enforces_the_sql_boundary() {
    use crate::support::{critical_op::CriticalOpGate, sql_query};
    use serde_json::json;
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let r = sql_query::tableless(&json!({"sql":"SELECT 1 AS one"}), &permit)
        .unwrap()
        .unwrap();
    assert_eq!(r["rows"], json!([[1]]));
    assert_eq!(r["columns"], json!(["one"]));
    assert!(
        sql_query::tableless(&json!({"sql":"SELECT id FROM orders"}), &permit)
            .unwrap()
            .is_none()
    );
    for sql in [
        "SELECT 1; SELECT 2",
        "SELECT load_extension('x')",
        "SELECT readfile('x')",
        "DELETE FROM orders",
    ] {
        assert!(
            sql_query::tableless(&json!({"sql":sql}), &permit).is_err(),
            "{sql}"
        );
    }
}

#[test]
fn schema_does_not_build_or_refresh_a_replica_and_never_returns_schema_literals() {
    use crate::support::{critical_op::CriticalOpGate, replica};
    let tmp = crate::tests::harness::TempDir::new();
    let path = tmp.path().join("pos.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    crate::db::run_migrations_for_test(&conn);
    conn.execute_batch("CREATE TABLE secret_metadata(id TEXT DEFAULT 'your-secret'); CREATE INDEX secret_expression ON secret_metadata((id || 'your-secret')); ").unwrap();
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let schema = replica::schema(&path, &permit).unwrap();
    assert!(!schema.to_string().contains("your-secret"));
    assert!(!tmp.path().join("support-replicas").exists());
    assert!(schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["name"] == "orders"));
    assert!(replica::schema(&tmp.path().join("missing.db"), &permit)
        .unwrap_err()
        .contains("BUSINESS_DATABASE_MISSING"));
}
