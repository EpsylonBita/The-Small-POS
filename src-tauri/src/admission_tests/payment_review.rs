use super::*;
use crate::admission_tests::{before_admission, no_write, order, writer};
use crate::tests::{fake_keyring, harness::TestDb};

#[test]
fn admission_missing_and_resolved_review_outcomes_skip_writer() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = db.state.conn.lock().unwrap();
    order(&conn);
    conn.execute_batch("INSERT INTO order_payments(id,order_id,method,amount,amount_cents,currency,status,metadata,created_at,updated_at) VALUES('your-resolved','your-order','cash',10,1000,'EUR','voided','{\"duplicate_review\":{\"resolution\":{}}}','now','now')").unwrap();
    let held = writer(db.db_path());
    no_write(&conn, || {
        assert!(matches!(
            set_aside_payment_in_connection(
                &conn,
                "missing",
                SetAsideReason::AlreadyPaid,
                None,
                "now"
            )
            .unwrap(),
            SetAsideOutcome::NotEligible
        ))
    });
    no_write(&conn, || {
        assert!(matches!(
            resolve_set_aside_payment_in_connection(&conn, "your-resolved", None, "now").unwrap(),
            ResolveOutcome::AlreadyResolved { .. }
        ))
    });
    no_write(&conn, || {
        assert!(resolve_set_aside_payment_in_connection(&conn, "missing", None, "now").is_err())
    });
    drop(held);
    conn.execute("UPDATE order_payments SET status='duplicate_review'", [])
        .unwrap();
    let path = db.db_path().to_owned();
    before_admission(move |_| {
        Connection::open(path)
            .unwrap()
            .execute("UPDATE order_payments SET status='voided'", [])
            .unwrap();
    });
    let before = conn.total_changes();
    assert!(matches!(
        resolve_set_aside_payment_in_connection(&conn, "your-resolved", None, "now").unwrap(),
        ResolveOutcome::AlreadyResolved { .. }
    ));
    assert_eq!(conn.total_changes(), before);
}
