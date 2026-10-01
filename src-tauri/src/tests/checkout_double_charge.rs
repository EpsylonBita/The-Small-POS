//! A slow card terminal is never paid twice (fix review 30/09/2026).
//!
//! Symptom: the checkout screen gave up after 15 s ("Failed to create
//! order") while the fiscal device still waited for the card (up to 120 s).
//! The command went on: the card was approved and the order saved. The next
//! press of Pay drew a new client request id, so it was a new checkout: a
//! second device transaction (queued behind the first) and a second charge.
//!
//! Now every press of the same cart carries the same client request id, and
//! the till answers a press while the same checkout is still in progress
//! without reaching the terminal; a press after the charge was held as not
//! saved replays the held order and payment, never this press's payload.

use rusqlite::params;
use serde_json::{json, Value};

use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const TERMINAL_ID: &str = "terminal-slow-card";
const BRANCH_ID: &str = "11111111-2222-4333-8444-888888888888";
const CLIENT_REQUEST_ID: &str = "checkout-request-slow-1";
const FISCAL_TXN: &str = "fiscal-txn-slow-1";
const PAYMENT_KEY: &str = "terminal-card:fiscal-txn-slow-1";

fn seed_terminal(conn: &rusqlite::Connection) {
    crate::db::set_setting(conn, "terminal", "__ignore_keyring", "1").unwrap();
    crate::db::set_setting(conn, "terminal", "terminal_id", TERMINAL_ID).unwrap();
    crate::db::set_setting(conn, "terminal", "branch_id", BRANCH_ID).unwrap();
    // A fiscal device is configured; no test ever connects it, so a checkout
    // that reached it would answer "Cash register not connected".
    conn.execute(
        "INSERT INTO ecr_devices (id, name, device_type, connection_type, is_default, enabled)
         VALUES ('register-slow', 'Register', 'cash_register', 'network', 1, 1)",
        [],
    )
    .expect("seed the fiscal device");
}

/// The terminal approved this checkout's card (13.00) on the first press.
fn seed_approved_card(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO ecr_transactions (
             id, device_id, order_id, transaction_type, amount, currency, status,
             fiscal_receipt_number, started_at, completed_at
         ) VALUES (?1, 'register-slow', ?2, 'fiscal_receipt', 1300, 'EUR', 'approved',
                   'R-0077', '2026-09-30T12:00:00Z', '2026-09-30T12:00:40Z')",
        params![FISCAL_TXN, CLIENT_REQUEST_ID],
    )
    .expect("seed the approved card");
}

fn open_cashier_shift(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO staff_shifts (
             id, staff_id, staff_name, branch_id, terminal_id, role_type,
             check_in_time, opening_cash_amount, opening_cash_amount_cents,
             status, sync_status, created_at, updated_at
         ) VALUES ('shift-slow', 'staff-slow', 'Cashier', ?1, ?2, 'cashier',
                   datetime('now'), 100.0, 10000, 'active', 'pending',
                   datetime('now'), datetime('now'))",
        params![BRANCH_ID, TERMINAL_ID],
    )
    .expect("open a cashier shift");
}

fn checkout(crepes: i64) -> Value {
    let total = 13.0 * crepes as f64;
    json!({
        "clientRequestId": CLIENT_REQUEST_ID,
        "branchId": BRANCH_ID,
        "terminalId": TERMINAL_ID,
        "items": [{ "name": "Crepe", "quantity": crepes, "price": 13.0 }],
        "totalAmount": total,
        "subtotal": total,
        "status": "completed",
        "orderType": "takeaway",
        "initialPayment": { "method": "card", "amount": total, "currency": "EUR" }
    })
}

async fn press_pay(td: &TestDb, payload: Value) -> Value {
    let mgr = crate::ecr::DeviceManager::new();
    crate::commands::orders::create_order_with_initial_payment(
        &td.state,
        &mgr,
        &crate::print::NoopPrintQueueInvalidator,
        payload,
        &[0, 0, 0],
    )
    .await
    .expect("a typed answer")
}

fn count(conn: &rusqlite::Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn a_press_while_the_same_checkout_waits_never_reaches_the_terminal() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_terminal(&conn);
        open_cashier_shift(&conn);
    }

    // The first press is still waiting on the card terminal.
    let first_press = crate::commands::orders::claim_checkout(&td.state, CLIENT_REQUEST_ID)
        .expect("claim")
        .expect("the first press holds the checkout");

    let answer = press_pay(&td, checkout(1)).await;
    assert_eq!(answer["errorCode"], "CHECKOUT_IN_PROGRESS", "{answer}");
    assert_eq!(answer["checkoutInProgress"], true);
    assert_eq!(answer["orderPersisted"], false);
    {
        let conn = td.state.conn.lock().unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 0);
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM ecr_transactions"),
            0,
            "the terminal was not asked again"
        );
    }

    // The first press answered: the checkout is free again.
    drop(first_press);
    let answer = press_pay(&td, checkout(1)).await;
    assert_ne!(answer["errorCode"], "CHECKOUT_IN_PROGRESS", "{answer}");
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn a_press_after_a_charge_held_as_not_saved_replays_the_held_checkout() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_terminal(&conn);
        seed_approved_card(&conn);
    }

    // First press: the card (13.00) was charged, the order could not be
    // saved (no cashier shift open): held as not saved.
    let answer = press_pay(&td, checkout(1)).await;
    assert_eq!(answer["errorCode"], "PAYMENT_NOT_SAVED", "{answer}");

    // The cashier opens the shift, adds a second crepe and presses Pay
    // again: the same checkout, a changed cart.
    open_cashier_shift(&td.state.conn.lock().unwrap());
    let answer = press_pay(&td, checkout(2)).await;
    assert_eq!(answer["success"], true, "{answer}");

    let conn = td.state.conn.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 1, "one order");
    let (total_cents, payments_cents, payment_count): (i64, i64, i64) = conn
        .query_row(
            "SELECT COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER)),
                    (SELECT COALESCE(SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))), 0) FROM order_payments
                      WHERE order_id = o.id AND status = 'completed'),
                    (SELECT COUNT(*) FROM order_payments WHERE order_id = o.id)
             FROM orders o",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        total_cents, 1300,
        "the order the card was charged for, not the changed cart"
    );
    assert_eq!(payments_cents, 1300, "the charge, once");
    assert_eq!(payment_count, 1);
    let key: String = conn
        .query_row("SELECT idempotency_key FROM order_payments", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(key, PAYMENT_KEY);
    assert_eq!(
        crate::unsaved_payments::count(&conn).unwrap(),
        0,
        "the held record is saved"
    );
}

/// The ownership model of #308 (one record per moved charge, saved when a row
/// with its key or its card identity exists) holds for a new-order checkout
/// too: its record names the client request id until the order exists, and
/// the card row booked for that approval under another key, on the order
/// created for that id, saves it. Nothing is booked a second time.
#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn a_held_checkout_booked_under_another_key_is_saved_not_booked_again() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_terminal(&conn);
        seed_approved_card(&conn);
    }
    let answer = press_pay(&td, checkout(1)).await;
    assert_eq!(answer["errorCode"], "PAYMENT_NOT_SAVED", "{answer}");

    // The same approval is booked by another recovery, under its own key, on
    // the order created for this checkout.
    {
        let conn = td.state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                 status, order_type, payment_status, sync_status, client_request_id,
                 created_at, updated_at)
             VALUES ('order-booked-elsewhere', 'ORD-30092026-00009', '[]', 13.0, 1300,
                     'completed', 'takeaway', 'paid', 'pending', ?1,
                     '2026-09-30T12:01:00Z', '2026-09-30T12:01:00Z')",
            params![CLIENT_REQUEST_ID],
        )
        .expect("the order created for the checkout");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                 transaction_ref, idempotency_key, sync_status, created_at, updated_at)
             VALUES ('pay-booked-elsewhere', 'order-booked-elsewhere', 'card', 13.0, 1300,
                     'completed', ?1, 'sale-recovery:fiscal-txn-slow-1', 'pending',
                     '2026-09-30T12:01:00Z', '2026-09-30T12:01:00Z')",
            params![FISCAL_TXN],
        )
        .expect("the card row booked under another key");
        assert!(
            crate::unsaved_payments::list(&conn, None)
                .unwrap()
                .is_empty(),
            "the record is no longer listed: its money is recorded"
        );
    }

    // "Save payment again" finds it saved and books nothing.
    let saved = crate::unsaved_payments::save_unsaved_payments(
        &td.state,
        None,
        Some(PAYMENT_KEY),
        &[0],
        &crate::print::NoopPrintQueueInvalidator,
    )
    .await
    .expect("save again");
    assert_eq!(saved["success"], true, "{saved}");
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM order_payments"),
        1,
        "one row"
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 1, "one order");
}
