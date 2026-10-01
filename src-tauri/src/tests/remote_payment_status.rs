//! The pull respects the server payment's status (item D2, fix review
//! 30/09/2026): a payment voided or refunded on the server never stays
//! completed local money.
//!
//! Symptom: another terminal (or the admin) voided a payment; every till that
//! had mirrored it while it was completed linked the server row by identity
//! and left the local row `completed`, so the order read paid there, an edit
//! asked only for the difference, and a courier was charged for it. The
//! pre-edit restore skipped voided server rows altogether.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::tests::harness::TestDb;

const BRANCH: &str = "branch-remote-status";
const LOCAL_ORDER: &str = "order-remote-status";
const REMOTE_ORDER: &str = "5b0f3c1e-2d4a-4b6c-8e9f-0a1b2c3d4e5f";
const REMOTE_PAYMENT: &str = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const SHIFT: &str = "shift-remote-status";

fn seed_order(conn: &Connection, order_type: &str) {
    conn.execute(
        "INSERT INTO orders (
             id, supabase_id, order_number, items, order_type, total_amount, total_amount_cents,
             status, payment_status, sync_status, branch_id, staff_shift_id,
             created_at, updated_at
         ) VALUES (?1, ?2, 'A-0301', '[]', ?3, 13.0, 1300, 'completed', 'pending', 'synced',
                   ?4, ?5, '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
        params![LOCAL_ORDER, REMOTE_ORDER, order_type, BRANCH, SHIFT],
    )
    .expect("seed the order");
}

fn seed_drawer(conn: &Connection, cash_cents: i64) {
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, check_in_time,
            opening_cash_amount, opening_cash_amount_cents, status, calculation_version,
            sync_status, created_at, updated_at)
         VALUES (?1, 'cashier-remote', 'cashier', ?2, '2026-09-30T08:00:00Z', 50.0, 5000,
                 'active', 2, 'pending', '2026-09-30T08:00:00Z', '2026-09-30T08:00:00Z')",
        params![SHIFT, BRANCH],
    )
    .expect("seed the cashier shift");
    conn.execute(
        "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id,
            terminal_id, opening_amount, opening_amount_cents, total_cash_sales,
            total_cash_sales_cents, opened_at, created_at, updated_at)
         VALUES ('drawer-remote-status', ?1, 'cashier-remote', ?2, 'terminal-remote-status',
                 50.0, 5000, ?3, ?4,
                 '2026-09-30T08:00:00Z', '2026-09-30T08:00:00Z', '2026-09-30T08:00:00Z')",
        params![SHIFT, BRANCH, cash_cents as f64 / 100.0, cash_cents],
    )
    .expect("seed the drawer");
}

fn server_payment(status: &str, updated_at: &str) -> Value {
    json!({
        "id": REMOTE_PAYMENT,
        "order_id": REMOTE_ORDER,
        "payment_method": "cash",
        "amount": 13.0,
        "currency": "EUR",
        "status": status,
        "created_at": "2026-09-30T10:05:00Z",
        "updated_at": updated_at,
        "metadata": {}
    })
}

fn mirror(conn: &Connection, payment: &Value) {
    crate::sync::sync_remote_payment_into_local_for_test(conn, payment).expect("mirror the row");
}

fn local_rows(conn: &Connection) -> Vec<(String, String)> {
    let mut statement = conn
        .prepare(
            "SELECT id, status FROM order_payments WHERE order_id = ?1 ORDER BY created_at, id",
        )
        .unwrap();
    statement
        .query_map(params![LOCAL_ORDER], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn payment_status(conn: &Connection) -> String {
    conn.query_row(
        "SELECT payment_status FROM orders WHERE id = ?1",
        params![LOCAL_ORDER],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn a_payment_voided_on_the_server_stops_counting_on_a_till_that_mirrored_it() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "takeaway");

    mirror(&conn, &server_payment("completed", "2026-09-30T10:05:00Z"));
    let rows = local_rows(&conn);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "completed");
    assert_eq!(payment_status(&conn), "paid");

    // Another terminal voids it; the next pull brings the voided row.
    mirror(&conn, &server_payment("voided", "2026-09-30T11:00:00Z"));
    let rows = local_rows(&conn);
    assert_eq!(rows.len(), 1, "no new row");
    assert_eq!(rows[0].1, "voided", "never completed money here");
    assert_ne!(payment_status(&conn), "paid");

    // The pulled order page (server label pending) keeps it that way.
    let page_error = crate::sync::apply_remote_orders_page_for_test(
        &conn,
        vec![json!({
            "id": REMOTE_ORDER,
            "status": "completed",
            "payment_status": "pending",
            "updated_at": "2026-09-30T11:00:05Z"
        })],
    );
    assert!(page_error.is_none(), "{page_error:?}");
    assert_ne!(payment_status(&conn), "paid");
}

#[test]
fn a_refund_on_the_server_marks_the_local_row_refunded() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "takeaway");
    mirror(&conn, &server_payment("completed", "2026-09-30T10:05:00Z"));

    mirror(&conn, &server_payment("refunded", "2026-09-30T11:00:00Z"));

    assert_eq!(local_rows(&conn)[0].1, "refunded");
    assert_ne!(payment_status(&conn), "paid");
}

#[test]
fn the_origin_tills_drawer_gives_back_a_payment_voided_on_the_server() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "takeaway");
    seed_drawer(&conn, 1300);
    // Recorded on this till, pushed, and linked to its server row.
    conn.execute(
        "INSERT INTO order_payments (
             id, order_id, method, amount, amount_cents, currency, status, payment_origin,
             staff_shift_id, remote_payment_id, sync_status, sync_state, created_at, updated_at
         ) VALUES ('pay-origin', ?1, 'cash', 13.0, 1300, 'EUR', 'completed', 'manual', ?2, ?3,
                   'synced', 'applied', '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
        params![LOCAL_ORDER, SHIFT, REMOTE_PAYMENT],
    )
    .unwrap();
    conn.execute(
        "UPDATE orders SET payment_status = 'paid' WHERE id = ?1",
        params![LOCAL_ORDER],
    )
    .unwrap();

    mirror(&conn, &server_payment("voided", "2026-09-30T11:00:00Z"));

    assert_eq!(
        local_rows(&conn),
        vec![("pay-origin".to_string(), "voided".to_string())]
    );
    let drawer_cash: i64 = conn
        .query_row(
            "SELECT total_cash_sales_cents FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
            params![SHIFT],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(drawer_cash, 0, "the drawer no longer expects it");
}

#[test]
fn a_courier_is_not_charged_for_a_payment_voided_on_the_server() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "delivery");
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, check_in_time,
            opening_cash_amount, opening_cash_amount_cents, status, calculation_version,
            sync_status, created_at, updated_at)
         VALUES ('shift-courier-remote', 'driver-remote', 'driver', ?1, '2026-09-30T08:30:00Z',
                 20.0, 2000, 'active', 2, 'pending', '2026-09-30T08:30:00Z',
                 '2026-09-30T08:30:00Z')",
        params![BRANCH],
    )
    .unwrap();
    mirror(&conn, &server_payment("completed", "2026-09-30T10:05:00Z"));
    let assignment = crate::order_ownership::assign_order_to_driver_shift(
        &conn,
        LOCAL_ORDER,
        "driver-remote",
        Some("Driver"),
        "shift-courier-remote",
        "2026-09-30T10:30:00Z",
    )
    .unwrap();
    crate::order_ownership::upsert_driver_earning(
        &conn,
        LOCAL_ORDER,
        "driver-remote",
        &assignment,
        "2026-09-30T10:30:00Z",
    )
    .unwrap();

    mirror(&conn, &server_payment("voided", "2026-09-30T11:00:00Z"));

    let cash_to_return: i64 = conn
        .query_row(
            "SELECT cash_to_return_cents FROM driver_earnings WHERE order_id = ?1",
            params![LOCAL_ORDER],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cash_to_return, 0);
}

#[test]
fn a_local_change_still_on_its_way_goes_first() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "takeaway");
    mirror(&conn, &server_payment("completed", "2026-09-30T10:05:00Z"));
    let payment_id = local_rows(&conn)[0].0.clone();
    // A refund recorded here, not applied on the server yet.
    conn.execute(
        "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount,
            amount_cents, reason, sync_state, created_at, updated_at)
         VALUES ('adj-in-flight', ?1, ?2, 'refund', 5.0, 500, 'wrong item', 'pending',
                 '2026-09-30T10:50:00Z', '2026-09-30T10:50:00Z')",
        params![payment_id, LOCAL_ORDER],
    )
    .unwrap();

    mirror(&conn, &server_payment("voided", "2026-09-30T11:00:00Z"));

    assert_eq!(local_rows(&conn)[0].1, "completed", "left for a later pull");
}

#[test]
fn the_pre_edit_restore_applies_a_void_and_never_raises_the_label_back() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "takeaway");
    mirror(&conn, &server_payment("completed", "2026-09-30T10:05:00Z"));
    assert_eq!(payment_status(&conn), "paid");

    crate::sync::apply_order_payment_ledger_before_payment_decision(
        &conn,
        LOCAL_ORDER,
        REMOTE_ORDER,
        &[server_payment("voided", "2026-09-30T11:00:00Z")],
        "2026-09-30T11:00:10Z",
    )
    .expect("restore the ledger before the edit");

    assert_eq!(local_rows(&conn)[0].1, "voided");
    assert_ne!(
        payment_status(&conn),
        "paid",
        "the edit must not treat voided money as paid"
    );
}

/// A gift card row's return belongs to #308's gift return import, which nets
/// it by its proven return floor: the pull never flips it (as on Android).
#[test]
fn a_gift_card_row_is_left_to_its_return_import() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "takeaway");
    // The server's atomic redemption result, with its proof.
    let gift = |status: &str, updated_at: &str| {
        let mut payment = server_payment(status, updated_at);
        payment["payment_method"] = json!("gift_card");
        payment["external_transaction_id"] = json!("gift_card:gift-txn-0301");
        payment["metadata"] = json!({ "gift_card_transaction_id": "gift-txn-0301" });
        payment
    };

    mirror(&conn, &gift("completed", "2026-09-30T10:05:00Z"));
    let rows = local_rows(&conn);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "completed");

    mirror(&conn, &gift("refunded", "2026-09-30T11:00:00Z"));
    let rows = local_rows(&conn);
    assert_eq!(rows.len(), 1, "no new row");
    assert_eq!(
        rows[0].1, "completed",
        "its return import decides, not the pull"
    );
}
