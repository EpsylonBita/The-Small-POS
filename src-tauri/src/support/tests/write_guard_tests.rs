use crate::support::{
    authorizer,
    guards::{self, Scope},
};
use rusqlite::Connection;

pub(super) fn scope() -> Scope {
    Scope {
        organization_id: "your_org".into(),
        branch_id: "your_branch".into(),
        terminal_id: "your_terminal".into(),
    }
}
pub(super) fn fixture() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE local_settings(setting_category TEXT,setting_key TEXT,setting_value TEXT,updated_at TEXT,PRIMARY KEY(setting_category,setting_key));
      INSERT INTO local_settings VALUES('local','printer_last_known_brand:host','old','a');
      CREATE TABLE parity_sync_queue(id TEXT PRIMARY KEY,table_name TEXT,record_id TEXT,module_type TEXT,attempts INTEGER,data BLOB,updated_at TEXT);
      INSERT INTO parity_sync_queue VALUES('q','customers','c','core',2,X'00FF','a');
      CREATE TABLE order_payments(id TEXT PRIMARY KEY,order_id TEXT);
      CREATE TABLE orders(id TEXT PRIMARY KEY,sync_status TEXT,status TEXT,staff_shift_id TEXT,created_at TEXT,total_amount REAL,total_amount_cents INTEGER,updated_at TEXT);
      INSERT INTO orders VALUES('o','pending','pending',NULL,'2030-01-01',1,100,'a');
      CREATE TABLE ecr_transactions(order_id TEXT,fiscal_receipt_number TEXT);
      CREATE TABLE gift_card_fiscal_operations(order_id TEXT);
      CREATE TABLE staff_shifts(id TEXT,status TEXT);
      CREATE TABLE z_reports(period_start TEXT,period_end TEXT);
      CREATE TABLE surprise(id TEXT);
      CREATE TABLE support_txn_marker(command_id TEXT PRIMARY KEY,committed_at TEXT NOT NULL);").unwrap();
    c
}
#[test]
fn native_guards_default_deny_immutable_columns_old_new_rows_and_ddl() {
    let c = fixture();
    let policy = guards::install(&c, &scope()).unwrap();
    for sql in [
        "UPDATE parity_sync_queue SET table_name='payments'",
        "INSERT INTO orders(id) VALUES('x')",
        "DELETE FROM parity_sync_queue",
        "UPDATE local_settings SET setting_key='api_key'",
        "INSERT INTO surprise VALUES('x')",
        "DROP TABLE orders",
        "PRAGMA user_version=999",
        "UPDATE orders SET sync_status='synced'",
        "UPDATE orders SET total_amount=2",
        "UPDATE orders SET total_amount='not_a_number',total_amount_cents=0",
        "UPDATE parity_sync_queue SET attempts=length(data)",
        "UPDATE parity_sync_queue SET attempts=random()",
        "UPDATE parity_sync_queue SET attempts=load_extension('x')",
    ] {
        assert!(authorizer::payload(&c, &policy, sql).is_err(), "{sql}");
    }
    assert_eq!(
        authorizer::payload(&c, &policy, "UPDATE parity_sync_queue SET attempts=0").unwrap(),
        1
    );
    assert_eq!(
        authorizer::payload(
            &c,
            &policy,
            "UPDATE orders SET total_amount=2,total_amount_cents=200"
        )
        .unwrap(),
        1
    );
    assert!(c.execute_batch("DROP TABLE orders").is_err());
    let c = fixture();
    c.execute("INSERT INTO order_payments VALUES('p','o')", [])
        .unwrap();
    let policy = guards::install(&c, &scope()).unwrap();
    assert!(authorizer::payload(&c, &policy, "UPDATE orders SET status='cancelled'").is_err());
    assert!(c
        .db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE)
        .unwrap());
}
#[test]
fn normal_connections_have_no_temp_guards_and_keep_their_timeout() {
    let c = fixture();
    c.busy_timeout(std::time::Duration::from_millis(5000))
        .unwrap();
    c.execute("INSERT INTO orders(id) VALUES('normal_sale')", [])
        .unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM sqlite_temp_schema WHERE type='trigger'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("PRAGMA busy_timeout", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        5000
    );
}

#[test]
fn old_and_new_order_evidence_and_null_settings_fail_closed() {
    for evidence in [
        "UPDATE orders SET sync_status='synced'",
        "INSERT INTO ecr_transactions VALUES('o','your_receipt')",
        "INSERT INTO gift_card_fiscal_operations VALUES('o')",
        "UPDATE orders SET staff_shift_id='s'; INSERT INTO staff_shifts VALUES('s','closed')",
        "INSERT INTO z_reports VALUES('2029-01-01','2031-01-01')",
        "INSERT INTO parity_sync_queue VALUES('f','orders','o','fiscal',0,NULL,'a')",
    ] {
        let c = fixture();
        c.execute_batch(evidence).unwrap();
        let policy = guards::install(&c, &scope()).unwrap();
        assert!(
            authorizer::payload(&c, &policy, "UPDATE orders SET status='cancelled'").is_err(),
            "{evidence}"
        );
    }
    let c = fixture();
    let policy = guards::install(&c, &scope()).unwrap();
    for sql in [
        "UPDATE local_settings SET setting_value='x' WHERE setting_key LIKE '%'",
        "UPDATE local_settings SET setting_value=NULL",
    ] {
        // Value edits of the exact operational key remain permitted.
        assert!(authorizer::payload(&c, &policy, sql).is_ok());
    }
    assert!(c
        .execute("INSERT INTO local_settings VALUES(NULL,NULL,'x',NULL)", [])
        .is_err());
    assert!(c
        .execute("UPDATE temp.support_guard_mode SET mode='quarantine'", [])
        .is_err());
}

#[test]
fn fresh_scratch_dryrun_records_targets_without_changing_live_rows() {
    let _global_gate = crate::support::critical_op::install_test_gate();
    let root = std::env::temp_dir().join(format!("support-dry-{}", uuid::Uuid::new_v4()));
    let store = crate::support::db::SupportDb::open(&root).unwrap();
    let live = root.join("pos.db");
    let source = fixture();
    source
        .execute("VACUUM INTO ?1", [live.to_str().unwrap()])
        .unwrap();
    let input = serde_json::json!({"step":"dry_run","database":"main","sql":"UPDATE parity_sync_queue SET attempts=0 WHERE id='q'","expected_rows":[{"table":"parity_sync_queue","inserted":0,"updated":1,"deleted":0}]});
    let gate = crate::support::critical_op::CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let result = crate::support::dry_run::sql(
        &store.conn,
        &live,
        "your_session",
        "your_proposal",
        &input,
        &scope(),
        0,
        &permit,
    )
    .unwrap();
    assert_eq!(result["rows_affected"][0]["updated"], 1);
    assert!(!result.to_string().contains("00FF"));
    assert_eq!(
        rusqlite::Connection::open(&live)
            .unwrap()
            .query_row("SELECT attempts FROM parity_sync_queue", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        std::fs::read_dir(root.join("support-replicas"))
            .unwrap()
            .count(),
        0
    );
    drop(store);
    drop(source);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn guarded_connection_bounds_native_value_allocations_before_admission() {
    let c = fixture();
    let _policy = guards::install(&c, &scope()).unwrap();
    let limit =
        unsafe { rusqlite::ffi::sqlite3_limit(c.handle(), rusqlite::ffi::SQLITE_LIMIT_LENGTH, -1) };
    assert_eq!(
        limit, 262144,
        "a huge row must refuse before Rust hashes it under the writer reservation"
    );
    let app = fixture();
    let normal = unsafe {
        rusqlite::ffi::sqlite3_limit(app.handle(), rusqlite::ffi::SQLITE_LIMIT_LENGTH, -1)
    };
    assert!(normal > limit);
}
