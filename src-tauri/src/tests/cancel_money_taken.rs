//! Every cancel refuses an order money was taken on (fix review 30/09/2026,
//! founder rule: never an order without its payment record, never money
//! counted twice).
//!
//! Symptom: "Cancel order" (the dashboard's bulk action and the order's own
//! cancel) and the platform decline cancelled an order that had a completed
//! payment. The cancel took back what the drawer counted for the order while
//! the payment row stayed completed on a cancelled order: the drawer expected
//! less cash than it held and the payment was never voided or refunded.
//!
//! Now the money is voided or refunded from the order first, or the rest is
//! collected; the refusal comes before anything is written. Android refuses
//! the plain cancel of an order with settled money too.

use rusqlite::params;

use crate::commands::orders::{
    apply_order_status_locally, cancel_refusal_code, decline_order_locally, LocalStatusChange,
    ORDER_HAS_PAYMENTS, ORDER_PAYMENT_NOT_RECORDED,
};
use crate::tests::harness::TestDb;

const ORDER_ID: &str = "ord-cancel-paid";
const NOW: &str = "2026-09-30T12:00:00Z";

fn seed_order(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
            status, order_type, payment_status, sync_status, created_at, updated_at)
         VALUES (?1, 'ORD-30092026-00007', '[]', 13.0, 1300, 'pending', 'pickup',
                 'partially_paid', 'synced', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
        params![ORDER_ID],
    )
    .expect("seed the order");
}

fn seed_payment(conn: &rusqlite::Connection, id: &str, status: &str) {
    conn.execute(
        "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
             sync_status, created_at, updated_at)
         VALUES (?1, ?2, 'cash', 5.0, 500, ?3, 'synced',
                 '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
        params![id, ORDER_ID, status],
    )
    .expect("seed a payment");
}

fn order_status(td: &TestDb) -> String {
    td.state
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT status FROM orders WHERE id = ?1",
            params![ORDER_ID],
            |row| row.get(0),
        )
        .unwrap()
}

fn cancel(td: &TestDb) -> Result<LocalStatusChange, String> {
    apply_order_status_locally(
        &td.state,
        ORDER_ID,
        "cancelled",
        None,
        Some("The customer changed their mind"),
        NOW,
    )
}

#[test]
fn the_ordinary_cancel_refuses_an_order_money_was_taken_on() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_order(&conn);
        seed_payment(&conn, "pay-cash-part", "completed");
    }

    let refused = cancel(&td).err().expect("money was taken on it");
    assert!(refused.starts_with(ORDER_HAS_PAYMENTS), "{refused}");
    assert_eq!(order_status(&td), "pending", "nothing was written");
}

#[test]
fn an_order_whose_payments_were_voided_or_refunded_can_be_cancelled() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_order(&conn);
        seed_payment(&conn, "pay-voided", "voided");
        seed_payment(&conn, "pay-refunded", "completed");
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type,
                 amount, amount_cents, reason, created_at, updated_at)
             VALUES ('adj-refund', 'pay-refunded', ?1, 'refund', 5.0, 500, 'Given back',
                     '2026-09-30T10:10:00Z', '2026-09-30T10:10:00Z')",
            params![ORDER_ID],
        )
        .expect("seed the refund");
        // The till's void and refund settle the label to what the rows
        // prove, in the same write (`payments::recompute_order_payment_state`).
        conn.execute(
            "UPDATE orders SET payment_status = 'pending' WHERE id = ?1",
            params![ORDER_ID],
        )
        .expect("the label the void and refund leave");
    }

    match cancel(&td).expect("nothing is held on it") {
        LocalStatusChange::Applied { order_id, .. } => assert_eq!(order_id, ORDER_ID),
        LocalStatusChange::Blocked(answer) => panic!("blocked: {answer}"),
    }
    assert_eq!(order_status(&td), "cancelled");
}

#[test]
fn declining_an_order_money_was_taken_on_is_refused_too() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_order(&conn);
        seed_payment(&conn, "pay-cash-part", "completed");
    }

    let refused = decline_order_locally(&td.state, ORDER_ID, "Declined", NOW)
        .expect_err("money was taken on it");
    assert!(refused.starts_with(ORDER_HAS_PAYMENTS), "{refused}");
    assert_eq!(order_status(&td), "pending");

    td.state
        .conn
        .lock()
        .unwrap()
        .execute_batch(
            "UPDATE order_payments SET status = 'voided' WHERE id = 'pay-cash-part';
             UPDATE orders SET payment_status = 'pending' WHERE id = 'ord-cancel-paid';",
        )
        .unwrap();
    decline_order_locally(&td.state, ORDER_ID, "Declined", NOW).expect("nothing held");
    assert_eq!(order_status(&td), "cancelled");
}

// ---------------------------------------------------------------------------
// ORDER_PAYMENT_NOT_RECORDED (founder rule 30/09/2026 and 01/10/2026).
//
// Symptom: a cancel of an order labelled paid with NO payment record on the
// till went through (the refusal read the rows only and found no money), and
// the Z then skipped it because it skips cancelled orders: the claim and the
// missing record both vanished. Now the missing record comes first: restored
// from the server or recorded ("Record the payment"); then the void/refund
// rule applies. A platform order whose money the platform holds is exempt.

fn seed_labelled_order(conn: &rusqlite::Connection, id: &str, label: &str, total_cents: i64) {
    conn.execute(
        "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
            status, order_type, payment_status, sync_status, created_at, updated_at)
         VALUES (?1, ?1, '[]', ?2, ?3, 'pending', 'pickup', ?4, 'synced',
                 '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
        params![id, total_cents as f64 / 100.0, total_cents, label],
    )
    .expect("seed a labelled order");
}

fn status_of(td: &TestDb, id: &str) -> String {
    td.state
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT status FROM orders WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
}

fn cancel_order(td: &TestDb, id: &str) -> Result<LocalStatusChange, String> {
    apply_order_status_locally(&td.state, id, "cancelled", None, Some("Customer left"), NOW)
}

#[test]
fn a_paid_label_with_no_payment_record_is_never_cancelled() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_labelled_order(&conn, "ord-paid-no-row", "paid", 1000);
        seed_labelled_order(&conn, "ord-completed-no-row", "Completed", 1000);
        seed_labelled_order(&conn, "ord-partial-no-row", "PARTIALLY_PAID", 1000);
    }

    for order_id in [
        "ord-paid-no-row",
        "ord-completed-no-row",
        "ord-partial-no-row",
    ] {
        let refused = cancel_order(&td, order_id)
            .err()
            .unwrap_or_else(|| panic!("{order_id}: the label claims money no record backs"));
        assert!(
            refused.starts_with(ORDER_PAYMENT_NOT_RECORDED),
            "{order_id}: {refused}"
        );
        assert_eq!(
            status_of(&td, order_id),
            "pending",
            "{order_id}: nothing written"
        );
        let declined = decline_order_locally(&td.state, order_id, "Declined", NOW)
            .expect_err("the decline is a cancel too");
        assert!(
            declined.starts_with(ORDER_PAYMENT_NOT_RECORDED),
            "{declined}"
        );
    }
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(
        cancel_refusal_code(&conn, "ord-paid-no-row").unwrap(),
        Some(ORDER_PAYMENT_NOT_RECORDED),
        "the settlement snapshot tells the cashier before the reason"
    );
}

#[test]
fn a_pending_label_with_no_rows_still_cancels() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_labelled_order(&conn, "ord-pending-no-row", "pending", 1000);
        seed_labelled_order(&conn, "ord-comp-paid", "paid", 0);
    }
    for order_id in ["ord-pending-no-row", "ord-comp-paid"] {
        cancel_order(&td, order_id).unwrap_or_else(|error| panic!("{order_id}: {error}"));
        assert_eq!(status_of(&td, order_id), "cancelled", "{order_id}");
    }
}

#[test]
fn a_recorded_then_voided_payment_lets_the_cancel_through() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_labelled_order(&conn, "ord-record-void", "paid", 1000);
        // The record comes first ("Record the payment", or the server's row
        // restored): now money is on it.
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                 sync_status, created_at, updated_at)
             VALUES ('pay-recorded', 'ord-record-void', 'cash', 10.0, 1000, 'completed',
                     'pending', '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
            [],
        )
        .unwrap();
    }
    let refused = cancel_order(&td, "ord-record-void")
        .err()
        .expect("money is on it now");
    assert!(refused.starts_with(ORDER_HAS_PAYMENTS), "{refused}");

    crate::refunds::void_payment_with_adjustment(
        &td.state,
        "pay-recorded",
        "Given back",
        None,
        None,
    )
    .expect("void the recorded payment");
    cancel_order(&td, "ord-record-void").expect("the void settled the label: nothing is claimed");
    assert_eq!(status_of(&td, "ord-record-void"), "cancelled");
}

#[test]
fn a_platform_held_order_pulled_paid_before_its_settlement_mirror_can_be_declined() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        for (id, external_id, metadata) in [
            (
                "ord-efood-prepaid",
                "efood-1001",
                Some(
                    r#"{"food_delivery":{"prepaid":true,"payment_method":"online","delivery_provider":"platform_delivery"}}"#,
                ),
            ),
            // Disposition unknown on this till: the shared contract
            // (`isStoreCollectableOrder`, round 3 review 01/10/2026, as on
            // Android) never assumes it is the platform's. Its paid label
            // with no record refuses the decline until the server's record
            // (its settlement) is restored or a manager records it.
            ("ord-efood-unknown", "efood-1002", None),
            // The STORE's driver carries this one as cash: the store's money.
            (
                "ord-efood-store-cod",
                "efood-1003",
                Some(
                    r#"{"food_delivery":{"payment_method":"cash","delivery_provider":"vendor_delivery"}}"#,
                ),
            ),
        ] {
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, sync_status, plugin,
                    external_plugin_order_id, ghost_metadata, created_at, updated_at)
                 VALUES (?1, ?1, '[]', 12.0, 1200, 'pending', 'delivery', 'paid', 'synced',
                         'efood', ?2, ?3, '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
                params![id, external_id, metadata],
            )
            .unwrap();
        }
    }
    decline_order_locally(&td.state, "ord-efood-prepaid", "Store closed", NOW)
        .expect("the platform holds it");
    assert_eq!(status_of(&td, "ord-efood-prepaid"), "cancelled");
    for order_id in ["ord-efood-unknown", "ord-efood-store-cod"] {
        let refused = decline_order_locally(&td.state, order_id, "Store closed", NOW)
            .expect_err("a paid label with no record, money the store may hold");
        assert!(
            refused.starts_with(ORDER_PAYMENT_NOT_RECORDED),
            "{order_id}: {refused}"
        );
    }
}

/// Round 2 review (01/10/2026): the server writes a platform order's
/// settlement row at ingest (`platform_settlement:{kind}:{order}`, method
/// `other`), so it is often mirrored while the order still waits for the
/// store's answer. It counted as money taken: declining the order was refused
/// with ORDER_HAS_PAYMENTS, and the till cannot void the platform's money.
/// Platform orders settled by the server's settlement row are exempt; money
/// the store itself took on such an order still refuses.
#[test]
fn a_platform_order_whose_settlement_row_is_mirrored_can_still_be_declined() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        for (id, external_id) in [
            ("ord-efood-settled", "efood-2001"),
            ("ord-efood-cash-row", "efood-2002"),
        ] {
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, sync_status, plugin,
                    external_plugin_order_id, ghost_metadata, created_at, updated_at)
                 VALUES (?1, ?1, '[]', 12.0, 1200, 'pending', 'delivery', 'paid', 'synced',
                         'efood', ?2, ?3, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')",
                params![
                    id,
                    external_id,
                    r#"{"food_delivery":{"prepaid":true,"payment_method":"online","delivery_provider":"platform_delivery"}}"#
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                     transaction_ref, payment_origin, remote_payment_id, sync_status, sync_state,
                     created_at, updated_at)
                 VALUES (?1, ?2, 'other', 12.0, 1200, 'completed', ?3, 'sync_reconstructed',
                         ?4, 'synced', 'applied', '2026-10-01T10:00:05Z', '2026-10-01T10:00:05Z')",
                params![
                    format!("settle-{id}"),
                    id,
                    format!("platform_settlement:online:{id}"),
                    format!("remote-settle-{id}"),
                ],
            )
            .unwrap();
        }
        // Cash the store's own till took on the second one: the store's
        // money, which still refuses the decline.
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                 sync_status, created_at, updated_at)
             VALUES ('pay-cash-on-platform', 'ord-efood-cash-row', 'cash', 3.0, 300, 'completed',
                     'synced', '2026-10-01T10:01:00Z', '2026-10-01T10:01:00Z')",
            [],
        )
        .unwrap();
        assert_eq!(
            cancel_refusal_code(&conn, "ord-efood-settled").unwrap(),
            None,
            "the platform's settlement is no money the store took"
        );
    }

    decline_order_locally(&td.state, "ord-efood-settled", "Store closed", NOW)
        .expect("the platform's settlement row does not block the decline");
    assert_eq!(status_of(&td, "ord-efood-settled"), "cancelled");

    let refused = decline_order_locally(&td.state, "ord-efood-cash-row", "Store closed", NOW)
        .expect_err("cash the store took still refuses");
    assert!(refused.starts_with(ORDER_HAS_PAYMENTS), "{refused}");
}

#[test]
fn a_placeholder_row_is_no_record_for_the_cancel() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_labelled_order(&conn, "ord-placeholder", "paid", 1000);
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                 payment_origin, sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-placeholder', 'ord-placeholder', 'cash', 10.0, 1000, 'completed',
                     'sync_reconstructed', 'synced', 'applied',
                     '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
            [],
        )
        .unwrap();
    }
    let refused = cancel_order(&td, "ord-placeholder")
        .err()
        .expect("a 1.4.119 guess is no record of money");
    assert!(refused.starts_with(ORDER_PAYMENT_NOT_RECORDED), "{refused}");
}
