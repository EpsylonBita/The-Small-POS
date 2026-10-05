//! A card charged at new-order checkout that the till could not save: end to
//! end (item E, fix review 30/09/2026; Android 1.0.13 parity, "an offline
//! checkout keeps a payment it cannot save").
//!
//! Symptom: the fiscal device approved the card, then the order write failed
//! (here: no cashier shift was open). The error went back as a plain failure:
//! the order did not exist, nothing durable said the customer had paid, the Z
//! knew nothing, and the next try started a new checkout and a second charge.

use rusqlite::params;
use serde_json::{json, Value};

use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const TERMINAL_ID: &str = "terminal-checkout";
const BRANCH_ID: &str = "11111111-2222-4333-8444-777777777777";
const CLIENT_REQUEST_ID: &str = "checkout-request-0001";
const FISCAL_TXN: &str = "fiscal-txn-checkout-1";
const PAYMENT_KEY: &str = "terminal-card:fiscal-txn-checkout-1";

fn seed_terminal(conn: &rusqlite::Connection) {
    crate::db::set_setting(conn, "terminal", "__ignore_keyring", "1").unwrap();
    crate::db::set_setting(
        conn,
        "terminal",
        "organization_id",
        "11111111-2222-4333-8444-999999999999",
    )
    .unwrap();
    crate::db::set_setting(conn, "terminal", "terminal_id", TERMINAL_ID).unwrap();
    crate::db::set_setting(conn, "terminal", "branch_id", BRANCH_ID).unwrap();
}

/// The fiscal device already approved this checkout's card: a retry of the
/// same checkout reads the approval back and never charges again.
fn seed_approved_fiscal_card(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO ecr_devices (id, name, device_type, connection_type, is_default, enabled)
         VALUES ('register-checkout', 'Register', 'cash_register', 'network', 1, 1)",
        [],
    )
    .expect("seed the fiscal device");
    conn.execute(
        "INSERT INTO ecr_transactions (
             id, device_id, order_id, transaction_type, amount, currency, status,
             fiscal_receipt_number, started_at, completed_at
         ) VALUES (?1, 'register-checkout', ?2, 'fiscal_receipt', 1300, 'EUR', 'approved',
                   'R-0042', '2026-09-30T12:00:00Z', '2026-09-30T12:00:05Z')",
        params![FISCAL_TXN, CLIENT_REQUEST_ID],
    )
    .expect("seed the approved fiscal card");
}

fn open_cashier_shift(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO staff_shifts (
             id, staff_id, staff_name, branch_id, terminal_id, role_type,
             check_in_time, opening_cash_amount, opening_cash_amount_cents,
             status, sync_status, created_at, updated_at
         ) VALUES ('shift-checkout', 'staff-checkout', 'Cashier', ?1, ?2, 'cashier',
                   datetime('now'), 100.0, 10000, 'active', 'pending',
                   datetime('now'), datetime('now'))",
        params![BRANCH_ID, TERMINAL_ID],
    )
    .expect("open a cashier shift");
}

fn checkout() -> Value {
    json!({
        "clientRequestId": CLIENT_REQUEST_ID,
        "branchId": BRANCH_ID,
        "terminalId": TERMINAL_ID,
        "items": [{ "name": "Crepe", "quantity": 1, "price": 13.0 }],
        "totalAmount": 13.0,
        "subtotal": 13.0,
        "status": "completed",
        "orderType": "takeaway",
        "initialPayment": { "method": "card", "amount": 13.0, "currency": "EUR" }
    })
}

fn count(conn: &rusqlite::Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn not_saved_blockers(td: &TestDb) -> Vec<Value> {
    let blockers =
        crate::zreport::unsettled_payment_blockers(&td.state, &json!({ "branchId": BRANCH_ID }))
            .expect("load the Z blockers");
    serde_json::to_value(&blockers)
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .filter(|blocker| blocker["reasonCode"] == "payments_not_saved")
        .cloned()
        .collect()
}

/// The order write fails after the card moved: the answer says charged, not
/// saved; the order and its keys are held durably, across a restart, and
/// hold the Z. "Save payment again" then writes the order and its payment
/// with the same keys: one order, paid by its row, no second charge.
#[tokio::test(flavor = "current_thread")]
async fn a_charged_checkout_the_till_cannot_save_is_held_across_a_restart_and_saved_with_its_keys()
{
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_terminal(&conn);
        seed_approved_fiscal_card(&conn);
    }
    let mgr = crate::ecr::DeviceManager::new();

    let answer = crate::commands::orders::create_order_with_initial_payment(
        &td.state,
        &mgr,
        &crate::print::NoopPrintQueueInvalidator,
        checkout(),
        &[0, 0, 0],
    )
    .await
    .expect("a typed answer, never a plain failure");
    assert_eq!(answer["errorCode"], "PAYMENT_NOT_SAVED", "{answer}");
    assert_eq!(answer["paymentApproved"], true);
    assert_eq!(answer["orderPersisted"], false);
    assert_eq!(answer["amountCents"], 1300);
    assert!(answer["orderId"].is_null(), "no order exists yet: {answer}");
    assert_eq!(answer["unsavedPayment"]["idempotencyKey"], PAYMENT_KEY);
    assert!(
        answer["error"]
            .as_str()
            .unwrap()
            .contains("The card was charged 13.00"),
        "{answer}"
    );
    {
        let conn = td.state.conn.lock().unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_payments"), 0);
    }

    let td = td.restart();
    let blockers = not_saved_blockers(&td);
    assert_eq!(
        blockers.len(),
        1,
        "the record survived the restart and holds the Z"
    );
    assert_eq!(blockers[0]["reasonVariant"], "new_order");
    assert_eq!(blockers[0]["unsavedPayment"]["kind"], "new_order_checkout");
    assert_eq!(blockers[0]["unsavedPayment"]["canSaveAgain"], true);

    {
        let conn = td.state.conn.lock().unwrap();
        open_cashier_shift(&conn);
    }
    let replay = crate::commands::payments::save_unsaved_payments_with_delays(
        &td.state,
        Some(json!({ "idempotencyKey": PAYMENT_KEY })),
        &[0, 0, 0],
        &crate::print::NoopPrintQueueInvalidator,
    )
    .await
    .expect("Save payment again");
    assert_eq!(replay["saved"], 1, "{replay}");

    let conn = td.state.conn.lock().unwrap();
    let (order_id, payment_status): (String, String) = conn
        .query_row(
            "SELECT id, payment_status FROM orders WHERE client_request_id = ?1",
            params![CLIENT_REQUEST_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the order, written with its client request id");
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 1);
    assert_eq!(payment_status, "paid", "derived from its payment row");
    let (method, status, amount_cents, payment_order): (String, String, i64, String) = conn
        .query_row(
            "SELECT method, status, amount_cents, order_id FROM order_payments
             WHERE idempotency_key = ?1",
            params![PAYMENT_KEY],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("the payment, written with its key");
    assert_eq!(
        (method.as_str(), status.as_str(), amount_cents),
        ("card", "completed", 1300)
    );
    assert_eq!(payment_order, order_id);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_payments"), 1);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM ecr_transactions"),
        1,
        "no new charge: the approval was reused"
    );
    drop(conn);
    assert!(not_saved_blockers(&td).is_empty(), "the Z is released");
}

/// The manager's way out: the money given back to the customer. The audit
/// entry holds the decision, the Z is released, and no order is written.
#[tokio::test(flavor = "current_thread")]
async fn a_checkout_charge_given_back_releases_the_z_and_writes_no_order() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_terminal(&conn);
        seed_approved_fiscal_card(&conn);
    }
    let mgr = crate::ecr::DeviceManager::new();
    let answer = crate::commands::orders::create_order_with_initial_payment(
        &td.state,
        &mgr,
        &crate::print::NoopPrintQueueInvalidator,
        checkout(),
        &[0, 0, 0],
    )
    .await
    .expect("a typed answer");
    assert_eq!(answer["errorCode"], "PAYMENT_NOT_SAVED", "{answer}");

    let conn = td.state.conn.lock().unwrap();
    let outcome = crate::unsaved_payments::resolve_in_connection(
        &conn,
        PAYMENT_KEY,
        Some("manager-checkout"),
        "2026-09-30T12:30:00Z",
    )
    .expect("given back");
    assert_eq!(outcome.as_str(), "resolved");
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM recovery_action_log WHERE action_id = 'payment_not_saved_resolved'"
        ),
        1
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 0);
    drop(conn);
    assert!(not_saved_blockers(&td).is_empty());
}

/// Item A's criterion at checkout: a card the checkout carries as approved by
/// a payment terminal (no fiscal device here) is money that moved as well,
/// held and saved with its keys the same way.
#[tokio::test(flavor = "current_thread")]
async fn a_terminal_approved_checkout_card_the_till_cannot_save_is_held_and_saved_with_its_keys() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    seed_terminal(&td.state.conn.lock().unwrap());
    let mgr = crate::ecr::DeviceManager::new();
    let mut payload = checkout();
    payload["initialPayment"] = json!({
        "method": "card",
        "amount": 13.0,
        "currency": "EUR",
        "terminalApproved": true,
        "paymentOrigin": "terminal",
        "transactionRef": "term-ref-0001"
    });

    let answer = crate::commands::orders::create_order_with_initial_payment(
        &td.state,
        &mgr,
        &crate::print::NoopPrintQueueInvalidator,
        payload,
        &[0, 0, 0],
    )
    .await
    .expect("a typed answer, never a plain failure");
    assert_eq!(answer["errorCode"], "PAYMENT_NOT_SAVED", "{answer}");
    assert_eq!(
        answer["unsavedPayment"]["idempotencyKey"],
        "terminal-card:term-ref-0001"
    );
    assert_eq!(answer["unsavedPayment"]["kind"], "new_order_checkout");
    assert_eq!(
        count(
            &td.state.conn.lock().unwrap(),
            "SELECT COUNT(*) FROM orders"
        ),
        0
    );

    open_cashier_shift(&td.state.conn.lock().unwrap());
    let replay = crate::commands::payments::save_unsaved_payments_with_delays(
        &td.state,
        Some(json!({ "idempotencyKey": "terminal-card:term-ref-0001" })),
        &[0, 0, 0],
        &crate::print::NoopPrintQueueInvalidator,
    )
    .await
    .expect("Save payment again");
    assert_eq!(replay["saved"], 1, "{replay}");
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 1);
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM order_payments
             WHERE idempotency_key = 'terminal-card:term-ref-0001' AND status = 'completed'"
        ),
        1
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM orders WHERE payment_status = 'paid'"
        ),
        1
    );
}

/// The usual checkout: the write succeeds at once. The answer is the order's,
/// the payment carries its key, and no record is left to hold the Z.
#[tokio::test(flavor = "current_thread")]
async fn a_charged_checkout_that_saves_answers_with_the_order_and_leaves_no_record() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_terminal(&conn);
        seed_approved_fiscal_card(&conn);
        open_cashier_shift(&conn);
    }
    let mgr = crate::ecr::DeviceManager::new();

    let answer = crate::commands::orders::create_order_with_initial_payment(
        &td.state,
        &mgr,
        &crate::print::NoopPrintQueueInvalidator,
        checkout(),
        &[0, 0, 0],
    )
    .await
    .expect("the checkout");
    assert_eq!(answer["success"], true, "{answer}");
    let order_id = answer["orderId"]
        .as_str()
        .expect("the order id")
        .to_string();

    let conn = td.state.conn.lock().unwrap();
    let payment_order: String = conn
        .query_row(
            "SELECT order_id FROM order_payments WHERE idempotency_key = ?1",
            params![PAYMENT_KEY],
            |row| row.get(0),
        )
        .expect("the payment, under its key");
    assert_eq!(payment_order, order_id);
    assert_eq!(
        crate::unsaved_payments::count(&conn).unwrap(),
        0,
        "no record left behind"
    );
    drop(conn);
    assert!(not_saved_blockers(&td).is_empty());
}
