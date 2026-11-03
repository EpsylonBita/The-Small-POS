use super::*;
use crate::admission_tests::{before_admission, writer};
use crate::tests::harness::TestDb;
use rusqlite::Connection;

#[test]
fn admission_pending_loyalty_refuses_without_writer_and_rechecks_before_delete() {
    let db = TestDb::open();
    let mut conn = db.state.conn.lock().unwrap();
    let pending = "INSERT INTO loyalty_transactions(id,organization_id,customer_id,transaction_type,points,sync_state) VALUES('your-tx','your-org','your-customer','earn',1,'pending')";
    conn.execute_batch(pending).unwrap();
    let before = conn.total_changes();
    let held = writer(db.db_path());
    let at = std::time::Instant::now();
    assert!(replace_loyalty_snapshot(&mut conn, "your-org", &[])
        .unwrap_err()
        .contains("pending"));
    assert!(at.elapsed() < crate::admission_tests::UNBLOCKED);
    assert_eq!(conn.total_changes(), before);
    drop(held);
    conn.execute("DELETE FROM loyalty_transactions", [])
        .unwrap();
    let path = db.db_path().to_owned();
    before_admission(move |_| {
        Connection::open(path)
            .unwrap()
            .execute_batch(pending)
            .unwrap();
    });
    let before = conn.total_changes();
    assert!(replace_loyalty_snapshot(&mut conn, "your-org", &[])
        .unwrap_err()
        .contains("pending"));
    assert_eq!(conn.total_changes(), before);
}
