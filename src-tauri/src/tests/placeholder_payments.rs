//! 1.4.119 placeholder payment rows (round 2 of the 01/10/2026 fix review,
//! founder rule 30/09/2026: no order is registered paid without its payment
//! record).
//!
//! Symptom: desktop 1.4.119 gave a pulled paid order with no local payment
//! row a completed row guessed from the order's own label and total
//! (`payment_origin = 'sync_reconstructed'`, no `remote_payment_id`).
//! c8c6be004 stopped writing them, but the rows already written kept counting
//! as coverage, net paid and drawer money: the Z saw no missing record, the
//! cancel refusal saw money, and an order write could claim `paid` on them.
//!
//! Now they count nowhere, migration v92 asks the server's ledger for their
//! orders once (the server's real row adopts the placeholder), and nothing is
//! deleted.

use rusqlite::params;

use crate::payments::{
    ledger_backs_claimed_status, load_net_paid_for_order, load_order_payment_balance_snapshot,
    mark_placeholder_ledger_restored, orders_awaiting_placeholder_ledger_restore,
};
use crate::tests::harness::TestDb;

const ORDER_ID: &str = "ord-placeholder-paid";

fn seed(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
            status, order_type, payment_status, branch_id, sync_status, created_at, updated_at)
         VALUES (?1, 'ORD-PH-1', '[]', 10.0, 1000, 'completed', 'pickup', 'paid', 'branch-ph',
                 'synced', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
        params![ORDER_ID],
    )
    .expect("seed the paid order");
    conn.execute(
        "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
             payment_origin, sync_status, sync_state, created_at, updated_at)
         VALUES ('pay-placeholder-1', ?1, 'cash', 10.0, 1000, 'completed',
                 'sync_reconstructed', 'synced', 'applied',
                 '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
        params![ORDER_ID],
    )
    .expect("seed the 1.4.119 placeholder");
}

#[test]
fn a_placeholder_row_is_never_coverage_net_paid_or_a_record() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed(&conn);

    assert_eq!(load_net_paid_for_order(&conn, ORDER_ID).unwrap(), 0.0);
    let snapshot = load_order_payment_balance_snapshot(&conn, ORDER_ID).unwrap();
    assert_eq!(snapshot.completed_payment_count, 0);
    assert_eq!(snapshot.outstanding_amount, 10.0);
    assert!(!ledger_backs_claimed_status(&conn, ORDER_ID, "paid").unwrap());
    let blockers = crate::payment_integrity::load_order_payment_blockers(&conn, ORDER_ID).unwrap();
    assert_eq!(
        blockers
            .iter()
            .map(|blocker| blocker.reason_code.as_str())
            .collect::<Vec<_>>(),
        vec!["missing_local_payment_row"],
        "the Z names the missing record"
    );
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_payments WHERE order_id = ?1",
            params![ORDER_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1, "nothing is deleted");

    // Adopted by the server's real payment (it has the server's id now): a
    // payment like any other.
    conn.execute(
        "UPDATE order_payments SET remote_payment_id = 'remote-pay-1' WHERE id = 'pay-placeholder-1'",
        [],
    )
    .unwrap();
    assert_eq!(load_net_paid_for_order(&conn, ORDER_ID).unwrap(), 10.0);
    assert!(ledger_backs_claimed_status(&conn, ORDER_ID, "paid").unwrap());
    assert!(
        crate::payment_integrity::load_order_payment_blockers(&conn, ORDER_ID)
            .unwrap()
            .is_empty()
    );
}

/// The one-shot step: v92 marks each placeholder for the server's ledger;
/// the sync pass mirrors its order once and stamps it. Nothing else moves.
#[test]
fn v92_asks_the_server_ledger_once_for_each_placeholder_order() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed(&conn);
    // A real server payment mirrored here also says `sync_reconstructed`,
    // always with its id: it is no placeholder and needs nothing.
    conn.execute_batch(
        "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
            status, order_type, payment_status, sync_status, created_at, updated_at)
         VALUES ('ord-mirrored', 'ORD-PH-2', '[]', 5.0, 500, 'completed', 'pickup', 'paid',
                 'synced', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z');
         INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
             payment_origin, remote_payment_id, sync_status, sync_state, created_at, updated_at)
         VALUES ('pay-mirrored', 'ord-mirrored', 'card', 5.0, 500, 'completed',
                 'sync_reconstructed', 'remote-pay-mirrored', 'synced', 'applied',
                 '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z');",
    )
    .unwrap();
    // Re-run the step the upgrade runs (this database was born at v92 or
    // later; v93 is additive and re-runs idempotently).
    conn.execute("DELETE FROM schema_version WHERE version >= 92", [])
        .unwrap();
    crate::db::run_migrations_for_test(&conn);

    assert_eq!(
        orders_awaiting_placeholder_ledger_restore(&conn, 25).unwrap(),
        vec![ORDER_ID.to_string()]
    );
    let (amount_cents, method, status): (i64, String, String) = conn
        .query_row(
            "SELECT amount_cents, method, status FROM order_payments WHERE id = 'pay-placeholder-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (amount_cents, method.as_str(), status.as_str()),
        (1000, "cash", "completed")
    );

    assert_eq!(
        mark_placeholder_ledger_restored(&conn, ORDER_ID, "2026-10-01T09:00:00Z").unwrap(),
        1
    );
    assert!(orders_awaiting_placeholder_ledger_restore(&conn, 25)
        .unwrap()
        .is_empty());
}

/// Round 2 review (01/10/2026): the restore pass stops at its first failure
/// (usually offline) and its work list had a fixed order, so one order whose
/// restore always failed blocked every later one. A failed order now goes to
/// the back of the line.
#[test]
fn an_order_whose_restore_fails_goes_to_the_back_of_the_line() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    for (order_id, payment_id) in [("ord-ph-a", "pay-ph-a"), ("ord-ph-b", "pay-ph-b")] {
        conn.execute(
            "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                status, order_type, payment_status, sync_status, created_at, updated_at)
             VALUES (?1, ?1, '[]', 6.0, 600, 'completed', 'pickup', 'paid', 'synced',
                     '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
            params![order_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                 payment_origin, sync_status, sync_state, metadata, created_at, updated_at)
             VALUES (?1, ?2, 'cash', 6.0, 600, 'completed', 'sync_reconstructed', 'synced',
                     'applied', '{\"placeholder_ledger_restore\":{\"requested_at\":\"2026-10-01T08:00:00Z\"}}',
                     '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
            params![payment_id, order_id],
        )
        .unwrap();
    }
    assert_eq!(
        orders_awaiting_placeholder_ledger_restore(&conn, 25).unwrap(),
        vec!["ord-ph-a".to_string(), "ord-ph-b".to_string()]
    );

    crate::payments::mark_placeholder_ledger_restore_failed(
        &conn,
        "ord-ph-a",
        "2026-10-01T09:00:00Z",
    )
    .unwrap();
    assert_eq!(
        orders_awaiting_placeholder_ledger_restore(&conn, 25).unwrap(),
        vec!["ord-ph-b".to_string(), "ord-ph-a".to_string()],
        "the failing order no longer blocks the next one"
    );

    crate::payments::mark_placeholder_ledger_restore_failed(
        &conn,
        "ord-ph-b",
        "2026-10-01T09:05:00Z",
    )
    .unwrap();
    assert_eq!(
        orders_awaiting_placeholder_ledger_restore(&conn, 1).unwrap(),
        vec!["ord-ph-a".to_string()],
        "the oldest failure is tried first"
    );
}

/// Round 2 review (01/10/2026): a placeholder counts nowhere as money in, so
/// nothing is paid out against it: no refund, no void.
#[test]
fn a_placeholder_row_is_never_refunded_or_voided() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed(&conn);
    }

    let refund = crate::refunds::refund_payment(
        &td.state,
        &serde_json::json!({
            "paymentId": "pay-placeholder-1",
            "amount": 10.0,
            "reason": "Synthetic refund",
            "refundMethod": "cash",
            "cashHandler": "cashier_drawer",
        }),
    )
    .expect_err("no money to give back");
    assert!(
        refund.starts_with("PAYMENT_PLACEHOLDER_NOT_MONEY"),
        "{refund}"
    );

    let void = crate::refunds::void_payment_with_adjustment(
        &td.state,
        "pay-placeholder-1",
        "Synthetic void",
        None,
        None,
    )
    .expect_err("no money to take back");
    assert!(void.starts_with("PAYMENT_PLACEHOLDER_NOT_MONEY"), "{void}");

    let conn = td.state.conn.lock().unwrap();
    let (status, adjustments): (String, i64) = conn
        .query_row(
            "SELECT status, (SELECT COUNT(*) FROM payment_adjustments WHERE payment_id = 'pay-placeholder-1')
             FROM order_payments WHERE id = 'pay-placeholder-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((status.as_str(), adjustments), ("completed", 0));
}
