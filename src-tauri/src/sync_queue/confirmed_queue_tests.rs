use super::*;

fn seed(
    c: &Connection,
    id: &str,
    table: &str,
    operation: &str,
    status: &str,
    error: &str,
    org: &str,
) {
    c.execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,module_type,status,attempts,error_message,created_at) VALUES(?,?,'your-order',?,'{\"orderId\":\"your-order\"}',?,'payment',?,1,?,'2026-11-11T12:00:00Z')",params![id,table,operation,org,status,error]).unwrap();
}
#[test]
fn money_waiting_behind_a_set_aside_order_edit_is_set_aside_and_undo_preserves_original() {
    let db = crate::tests::harness::TestDb::open();
    let c = db.state.conn.lock().unwrap();
    seed(
        &c,
        "your-edit",
        "orders",
        "UPDATE",
        "failed",
        "HTTP_422_CLIENT_ERROR",
        "your-org",
    );
    seed(
        &c,
        "your-payment",
        "payments",
        "INSERT",
        "pending",
        "Waiting for parent order sync",
        "your-org",
    );
    let before = load_queue_row(&c, "your-payment").unwrap().unwrap();
    assert_eq!(
        rows_waiting_on_queue_row(&c, "your-edit").unwrap(),
        vec!["your-payment"]
    );
    assert!(set_aside_queue_row(
        &c,
        "your-payment",
        "support:your-session:your-command",
        "founder_confirmed"
    )
    .is_err());
    set_aside_queue_row(
        &c,
        "your-edit",
        "support:your-session:your-command",
        "founder_confirmed",
    )
    .unwrap();
    set_aside_queue_row(
        &c,
        "your-payment",
        "support:your-session:your-command",
        "founder_confirmed",
    )
    .unwrap();
    assert!(queue_row_is_set_aside(&c, "your-payment").unwrap());
    assert_eq!(
        retained_set_aside_group(&c, "your-edit").unwrap(),
        vec!["your-edit", "your-payment"]
    );
    undo_set_aside(&c, "your-payment", "support:your-session:your-command").unwrap();
    let after = load_queue_row(&c, "your-payment").unwrap().unwrap();
    assert_eq!(before.data, after.data);
    assert_eq!(before.status, after.status);
}
#[test]
fn dependency_must_name_the_same_order_and_organization_and_cannot_undo_a_z_claim() {
    let db = crate::tests::harness::TestDb::open();
    let c = db.state.conn.lock().unwrap();
    seed(
        &c,
        "your-edit",
        "orders",
        "UPDATE",
        "failed",
        "HTTP_422_CLIENT_ERROR",
        "your-org",
    );
    seed(
        &c,
        "your-payment",
        "payments",
        "INSERT",
        "pending",
        "Waiting for parent order sync",
        "other-org",
    );
    set_aside_queue_row(
        &c,
        "your-edit",
        "support:your-session:your-command",
        "founder_confirmed",
    )
    .unwrap();
    assert!(rows_waiting_on_queue_row(&c, "your-edit")
        .unwrap()
        .is_empty());
    assert!(set_aside_queue_row(
        &c,
        "your-payment",
        "support:your-session:your-command",
        "founder_confirmed"
    )
    .is_err());
    c.execute(
        "UPDATE parity_sync_set_aside SET z_report_id='your-z' WHERE queue_id='your-edit'",
        [],
    )
    .unwrap();
    // The store's own rule is unchanged: a manager may return a row a Z lists.
    // Support refuses that row itself (support confirmed tests).
    undo_set_aside(&c, "your-edit", "your-manager").unwrap();
    assert!(!queue_row_is_set_aside(&c, "your-edit").unwrap());
}
