use super::*;
use crate::admission_tests::{before_admission, no_write, order, terminal, writer};
use crate::tests::{fake_keyring, harness::TestDb};

#[test]
fn admission_empty_read_probe_keeps_nonempty_headers_on_the_validation_path() {
    assert!(!lan_canonical_has_domain_rows(
        &json!({"data":{"orders":[],"sessions":[],"tables":[],"payments":[]}})
    ));
    assert!(lan_canonical_has_domain_rows(
        &json!({"data":{"id":"your-order","version":1}})
    ));
    assert!(lan_canonical_has_domain_rows(
        &json!({"data":{"order_items":[]}})
    ));
}

#[test]
fn admission_empty_page_and_payment_import_refusals_are_read_only() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = db.state.conn.lock().unwrap();
    terminal(&conn);
    order(&conn);
    let _writer = writer(db.db_path());
    no_write(&conn, || {
        assert_eq!(
            apply_remote_payment_page(
                &conn,
                &json!({"payments":[],"next_cursor":"must-not-advance"})
            )
            .unwrap(),
            0
        )
    });
    for row in [
        json!({}),
        json!({"id":"your-payment"}),
        json!({"id":"your-payment","order_id":"missing"}),
        json!({"id":"your-payment","order_id":"44444444-4444-4444-8444-444444444444","method":"unproven","amount":10}),
        json!({"id":"your-payment","order_id":"44444444-4444-4444-8444-444444444444","method":"cash","amount":0}),
        json!({"id":"your-payment","order_id":"44444444-4444-4444-8444-444444444444","method":"cash","amount":10,"status":"voided"}),
    ] {
        no_write(&conn, || {
            assert!(sync_remote_payment_into_local_with_context(&conn, &row)
                .unwrap()
                .is_none())
        });
    }
    no_write(&conn, || {
        assert_eq!(
            apply_order_payment_ledger_before_payment_decision(
                &conn,
                "your-order",
                "44444444-4444-4444-8444-444444444444",
                &[],
                "later"
            )
            .unwrap(),
            0
        )
    });
    no_write(&conn, || {
        assert_eq!(
            apply_order_payment_ledger_before_payment_decision(
                &conn,
                "your-order",
                "44444444-4444-4444-8444-444444444444",
                &[json!({"order_id":"other"})],
                "later"
            )
            .unwrap(),
            0
        )
    });
    no_write(&conn, || apply_refund_payment_ledger(&conn, &[]).unwrap());
    assert!(db::get_setting(&conn, "sync", "payments_cursor").is_none());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM order_payments", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn admission_payment_probe_rechecks_after_eligibility_changes() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = db.state.conn.lock().unwrap();
    terminal(&conn);
    order(&conn);
    let path = db.db_path().to_owned();
    // Initially eligible input becomes a nonpositive amount only through DB
    // identity loss. No stale payment is inserted after admission.
    before_admission(move |conn| {
        assert!(conn.is_autocommit());
        let other = Connection::open(path).unwrap();
        other
            .execute("DELETE FROM orders WHERE id='your-order'", [])
            .unwrap();
    });
    let row = json!({"id":"your-payment","order_id":"44444444-4444-4444-8444-444444444444","method":"cash","amount":10,"status":"completed","currency":"EUR"});
    assert!(sync_remote_payment_into_local_with_context(&conn, &row)
        .unwrap()
        .is_none());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM order_payments", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn admission_gone_financial_retry_skips_writer_and_rechecks() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let item: SyncItem = (
        1,
        "payment".into(),
        "your-payment".into(),
        "INSERT".into(),
        "{}".into(),
        "your-key".into(),
        0,
        5,
        None,
        1000,
        None,
    );
    let held = writer(db.db_path());
    let before = db.state.conn.lock().unwrap().total_changes();
    let at = std::time::Instant::now();
    defer_financial_server_retry(&db.state, &item, "your-error", None, None).unwrap();
    assert!(at.elapsed() < crate::admission_tests::UNBLOCKED);
    assert_eq!(db.state.conn.try_lock().unwrap().total_changes(), before);
    drop(held);
    db.state.conn.lock().unwrap().execute_batch("INSERT INTO sync_queue(id,entity_type,entity_id,operation,payload,idempotency_key) VALUES(1,'payment','your-payment','INSERT','{}','your-key')").unwrap();
    let path = db.db_path().to_owned();
    before_admission(move |_| {
        Connection::open(path)
            .unwrap()
            .execute("DELETE FROM sync_queue", [])
            .unwrap();
    });
    let before = db.state.conn.lock().unwrap().total_changes();
    defer_financial_server_retry(&db.state, &item, "your-error", None, None).unwrap();
    assert_eq!(db.state.conn.try_lock().unwrap().total_changes(), before);
}

#[test]
fn admission_canonical_application_never_reads_credentials_under_writer() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = std::rc::Rc::new(Connection::open(db.db_path()).unwrap());
    conn.busy_timeout(Duration::from_millis(5000)).unwrap();
    terminal(&conn);
    let checkout = crate::admission_tests::pause_credentials_for_checkout(
        conn.clone(),
        db.db_path().to_owned(),
    );
    let response = super::lan_canonical_response_tests::response();
    let captured =
        crate::terminal_helpers::TerminalScopeSnapshot::capture_for_canonical(&conn, &response)
            .unwrap();
    let tx = crate::db::immediate_transaction(&conn).unwrap();
    apply_lan_canonical_response_scoped(&tx, "/api/pos/table-sessions", &response, &captured)
        .unwrap();
    tx.commit().unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM table_session_snapshots_v1", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    checkout.join().unwrap();
}
