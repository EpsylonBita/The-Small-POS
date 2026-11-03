use super::*;
use crate::admission_tests::{no_write, writer};
use crate::tests::{fake_keyring, harness::TestDb};

#[test]
fn admission_missing_and_resolved_retained_receipts_skip_writer() {
    let _keyring = fake_keyring::install_empty();
    let db = TestDb::open();
    let conn = db.state.conn.lock().unwrap();
    crate::db::set_setting(
        &conn,
        UNSAVED_CHARGED_PAYMENT_RESOLVED_CATEGORY,
        "your-resolved",
        "{}",
    )
    .unwrap();
    crate::admission_tests::order(&conn);
    conn.execute_batch("INSERT INTO order_payments(id,order_id,idempotency_key,method,amount,amount_cents,currency,status,created_at,updated_at) VALUES('your-saved-payment','your-order','your-saved','cash',10,1000,'EUR','completed','now','now')").unwrap();
    let _writer = writer(db.db_path());
    no_write(&conn, || {
        assert!(matches!(
            resolve_in_connection(&conn, "your-saved", None, "now").unwrap(),
            ResolveOutcome::Saved
        ))
    });
    for key in ["your-missing", "your-resolved"] {
        no_write(&conn, || {
            let outcome = resolve_in_connection(&conn, key, None, "now").unwrap();
            assert!(matches!(
                outcome,
                ResolveOutcome::NotFound | ResolveOutcome::AlreadyResolved
            ));
        });
        no_write(&conn, || {
            let outcome = resolve_twint_returned_in_connection(
                &conn,
                key,
                "your-return-reference",
                "your-staff",
                "your-approval",
                "now",
            )
            .unwrap();
            assert!(matches!(
                outcome,
                ResolveOutcome::NotFound | ResolveOutcome::AlreadyResolved
            ));
        });
    }
}
