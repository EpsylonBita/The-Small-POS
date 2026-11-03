//! A split from the menu saves its order only with its first portion (founder 01/11/2026, «Τίποτα»).
//!
//! Symptom: choosing Split saved the order before any money (desktop: the order row, its sync and its fiscal
//! hand-off), so backing out of the split left a PAY PENDING order the cashier never meant to keep. The split now
//! opens on the cart, and its first portion is saved here together with its order, through the ordinary checkout
//! create (one press per checkout, idempotent by its client request id). The only difference from an ordinary
//! partial create is that the register's receipt is not run for one portion: the split prints the whole order's
//! receipt when it settles, as it always did. Anything but a pending split's positive cash or card portion of a
//! counter order paid now is refused before anything is claimed, charged or written.

use rusqlite::params;
use serde_json::{json, Value};

use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const TERMINAL_ID: &str = "terminal-split-first";
const BRANCH_ID: &str = "11111111-2222-4333-8444-777777777777";
const CHECKOUT: &str = "checkout-split-first-1";

fn seed_terminal(conn: &rusqlite::Connection, with_register: bool) {
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
    for (key, value) in [
        ("currency", "EUR"),
        ("store_currency_branch_id", BRANCH_ID),
        ("store_currency_available", "true"),
        ("store_currency_source", "branch_country"),
    ] {
        crate::db::set_setting(conn, "restaurant", key, value).unwrap();
    }
    if with_register {
        // A fiscal register is configured and never connected: a checkout that reached it would answer
        // "Cash register not connected".
        conn.execute(
            "INSERT INTO ecr_devices (id, name, device_type, connection_type, is_default, enabled)
             VALUES ('register-split', 'Register', 'cash_register', 'network', 1, 1)",
            [],
        )
        .expect("seed the fiscal register");
        crate::device_admission::admit_for_test(conn, &[crate::device_admission::CASH_REGISTER]);
    }
}

fn open_cashier_shift(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO staff_shifts (
             id, staff_id, staff_name, branch_id, terminal_id, role_type,
             check_in_time, opening_cash_amount, opening_cash_amount_cents,
             status, sync_status, created_at, updated_at, currency
         ) VALUES ('shift-split', 'staff-split', 'Cashier', ?1, ?2, 'cashier',
                   datetime('now'), 100.0, 10000, 'active', 'pending',
                   datetime('now'), datetime('now'), 'EUR')",
        params![BRANCH_ID, TERMINAL_ID],
    )
    .expect("open a cashier shift");
}

/// Two crepes (26.00): an order paid now with Split, the first person paying `payment`.
fn split_order(payment: Value, marked: bool) -> Value {
    let mut order = json!({
        "clientRequestId": CHECKOUT,
        "branchId": BRANCH_ID,
        "terminalId": TERMINAL_ID,
        "items": [{ "name": "Crepe", "quantity": 2, "price": 13.0 }],
        "totalAmount": 26.0,
        "subtotal": 26.0,
        "status": "pending",
        "orderType": "takeaway",
        "paymentMethod": "pending",
        "is_ghost": false,
        "room_id": null,
        "initialPayment": payment
    });
    if marked {
        order["checkoutKind"] = json!("split_first_portion");
    }
    order
}

fn cash_portion() -> Value {
    json!({ "method": "cash", "payment_method": "cash", "amount": 13.0, "cashReceived": 13.0, "changeGiven": 0,
            "currency": "EUR", "paymentOrigin": "manual", "terminalApproved": false })
}

fn card_portion() -> Value {
    json!({ "method": "card", "payment_method": "card", "amount": 13.0, "currency": "EUR",
            "transactionRef": "eft-split-first-1", "paymentOrigin": "terminal", "terminalApproved": true,
            "terminalDeviceId": "eft-1" })
}

async fn press(td: &TestDb, payload: Value) -> Value {
    crate::commands::orders::create_order_with_initial_payment(
        &td.state,
        &crate::ecr::DeviceManager::new(),
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

fn open(with_register: bool, shift: bool) -> (TestDb, impl Drop) {
    let keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_terminal(&conn, with_register);
        if shift {
            open_cashier_shift(&conn);
        }
    }
    (td, keyring)
}

/// What a create wrote, with what differs by nature between two creates (ids and clocks) taken out.
fn written(td: &TestDb, order_id: &str) -> Value {
    const VOLATILE: &[&str] = &[
        "id",
        "orderId",
        "order_id",
        "local_id",
        "localId",
        "paymentId",
        "payment_id",
        "created_at",
        "createdAt",
        "updated_at",
        "updatedAt",
        "order_number",
        "orderNumber",
        "display_order_number",
        "displayOrderNumber",
        "timestamp",
        "issuedAt",
        "client_event_id",
        "clientEventId",
        "generation",
        "ledger_generation",
        "version",
    ];
    fn strip(value: Value, order_id: &str) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .filter(|(key, _)| !VOLATILE.contains(&key.as_str()))
                    .map(|(key, inner)| (key, strip(inner, order_id)))
                    .collect(),
            ),
            Value::Array(items) => Value::Array(
                items
                    .into_iter()
                    .map(|item| strip(item, order_id))
                    .collect(),
            ),
            Value::String(text) if text == order_id => Value::String("<order>".into()),
            other => other,
        }
    }
    let conn = td.state.conn.lock().unwrap();
    let order: Value = conn
        .query_row(
            "SELECT json_object('total', total_amount, 'subtotal', subtotal, 'status', status,
                    'payment_status', payment_status, 'order_type', order_type, 'branch', branch_id,
                    'terminal', terminal_id, 'shift', staff_shift_id, 'currency', currency,
                    'is_ghost', is_ghost, 'sync_status', sync_status)
               FROM orders WHERE id = ?1",
            [order_id],
            |row| row.get::<_, String>(0),
        )
        .map(|text| serde_json::from_str(&text).unwrap())
        .unwrap();
    let payments: Vec<Value> = conn
        .prepare(
            "SELECT json_object('method', method, 'amount', amount, 'currency', currency, 'status', status,
                    'origin', payment_origin, 'shift', staff_shift_id, 'ref', transaction_ref)
               FROM order_payments WHERE order_id = ?1",
        )
        .unwrap()
        .query_map([order_id], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|text| serde_json::from_str(&text.unwrap()).unwrap())
        .collect();
    let queued: Vec<Value> = conn
        .prepare("SELECT table_name, operation, data FROM parity_sync_queue ORDER BY rowid")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .map(|row| {
            let (table, operation, data) = row.unwrap();
            json!({ "table": table, "operation": operation,
                    "data": strip(serde_json::from_str(&data).unwrap_or(Value::Null), order_id) })
        })
        .collect();
    let prints = count(&conn, "SELECT COUNT(*) FROM print_jobs");
    json!({ "order": order, "payments": payments, "queued": queued, "prints": prints })
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn the_first_cash_portion_saves_the_order_with_it_and_leaves_the_receipt_to_the_split() {
    let (td, _keyring) = open(true, true);
    let answer = press(&td, split_order(cash_portion(), true)).await;
    assert_eq!(answer["success"], true, "{answer}");
    let order_id = answer["orderId"]
        .as_str()
        .expect("the order id")
        .to_string();

    let conn = td.state.conn.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 1);
    let (status, total): (String, f64) = conn
        .query_row(
            "SELECT payment_status, total_amount FROM orders WHERE id = ?1",
            [&order_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "partially_paid");
    assert_eq!(total, 26.0, "the order keeps its whole total");
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM ecr_transactions"),
        0,
        "the register was not asked for one portion's receipt"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE table_name = 'fiscal_submission' AND record_id = ?1",
            [&order_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        1,
        "the whole order is handed to fiscal at its first payment"
    );
    let synced: String = conn
        .query_row(
            "SELECT data FROM parity_sync_queue WHERE table_name = 'orders' AND record_id = ?1",
            [&order_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        !synced.contains("checkoutKind"),
        "the marker never reaches the server: {synced}"
    );
    // Kitchen and auto-print parity: a split order printed nothing when it was saved before its payments, and
    // prints nothing now that it is saved with its first portion. Its receipts are the split's own.
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM print_jobs"), 0);
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn the_marker_changes_nothing_but_the_registers_receipt() {
    // The same first portion as an ordinary partial create on a till with no register (whose receipt step is
    // skipped anyway), and with the marker on a till whose register is configured: the same order, payment,
    // sync, fiscal hand-off and prints.
    let (plain_td, _plain_keyring) = open(false, true);
    let plain = press(&plain_td, split_order(cash_portion(), false)).await;
    assert_eq!(plain["success"], true, "{plain}");
    let plain_written = written(&plain_td, plain["orderId"].as_str().unwrap());
    drop(plain_td);

    let (marked_td, _marked_keyring) = open(true, true);
    let marked = press(&marked_td, split_order(cash_portion(), true)).await;
    assert_eq!(marked["success"], true, "{marked}");
    let marked_written = written(&marked_td, marked["orderId"].as_str().unwrap());

    assert_eq!(marked_written, plain_written);
    let fiscal = marked_written["queued"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["table"] == "fiscal_submission")
        .count();
    assert_eq!(fiscal, 1, "{marked_written}");
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn anything_but_a_pending_counter_splits_cash_or_card_portion_is_refused_before_anything_moves(
) {
    let (td, _keyring) = open(true, true);
    let refusals: Vec<(&str, Value)> = vec![
        ("not_a_pending_split", {
            let mut o = split_order(cash_portion(), true);
            o["paymentMethod"] = json!("cash");
            o
        }),
        ("table_order", {
            let mut o = split_order(cash_portion(), true);
            o["orderType"] = json!("dine-in");
            o
        }),
        ("table_order", {
            let mut o = split_order(cash_portion(), true);
            o["tableNumber"] = json!("4");
            o
        }),
        ("ghost_order", {
            let mut o = split_order(cash_portion(), true);
            o["is_ghost"] = json!(true);
            o
        }),
        ("room_order", {
            let mut o = split_order(cash_portion(), true);
            o["room_id"] = json!("room-12");
            o
        }),
        (
            "tender",
            split_order(json!({ "method": "gift_card", "amount": 13.0 }), true),
        ),
        (
            "tender",
            split_order(
                json!({ "method": "twint", "amount": 13.0, "currency": "EUR",
            "metadata": { "provider": "twint", "confirmation": "cashier", "confirmation_action": "confirm", "qr_mode": "static_qr_manual" } }),
                true,
            ),
        ),
        (
            "tender",
            split_order(json!({ "method": "room_charge", "amount": 13.0 }), true),
        ),
        (
            "amount",
            split_order(json!({ "method": "cash", "amount": 0 }), true),
        ),
        (
            "amount",
            split_order(json!({ "method": "cash", "amount": -5.0 }), true),
        ),
    ];
    for (reason, payload) in refusals {
        let answer = press(&td, payload).await;
        assert_eq!(
            answer["errorCode"], "SPLIT_FIRST_PORTION_REFUSED",
            "{reason}: {answer}"
        );
        assert_eq!(answer["reason"], reason, "{answer}");
        assert_eq!(answer["orderPersisted"], false);
    }
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_payments"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM ecr_transactions"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM parity_sync_queue"), 0);
    assert!(crate::unsaved_payments::list(&conn, None)
        .unwrap()
        .is_empty());
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn without_the_marker_the_same_cart_still_reaches_the_register() {
    let (td, _keyring) = open(true, true);
    let answer = press(&td, split_order(cash_portion(), false)).await;
    assert_eq!(
        answer["errorCode"], "FISCAL_CHECKOUT_NOT_APPROVED",
        "{answer}"
    );
    assert_eq!(answer["orderPersisted"], false);
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 0);
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn the_same_checkout_pressed_again_keeps_one_order_and_one_payment() {
    let (td, _keyring) = open(true, true);
    let first = press(&td, split_order(cash_portion(), true)).await;
    assert_eq!(first["success"], true, "{first}");
    let again = press(&td, split_order(cash_portion(), true)).await;
    assert_eq!(again["success"], true, "{again}");
    assert_eq!(again["orderId"], first["orderId"]);
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_payments"), 1);
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn a_split_left_after_its_first_portion_is_partially_paid_resumable_and_has_no_receipt_yet() {
    // Fiscal parity with the split as it was: the order holds its first portion, the rest stays to collect, and
    // the register's receipt waits for the split to settle (a split left partly paid gets none; that gap is old).
    let (td, _keyring) = open(true, true);
    let answer = press(&td, split_order(cash_portion(), true)).await;
    assert_eq!(answer["success"], true, "{answer}");
    let order_id = answer["orderId"].as_str().unwrap().to_string();
    let conn = td.state.conn.lock().unwrap();
    let snapshot = crate::payments::load_order_settlement_snapshot(&conn, &order_id).unwrap();
    assert_eq!(snapshot.order_total, 26.0);
    assert_eq!(snapshot.net_paid, 13.0);
    assert_eq!(snapshot.outstanding_amount, 13.0);
    assert_eq!(snapshot.completed_payments.len(), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM ecr_transactions"), 0);
}

// Founder 01/11/2026: without a connected card plugin (every store today) Card is a plain record, like cash. No
// terminal is asked or waited for; the first card portion creates the order together with that card payment.
#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn without_a_card_plugin_a_first_card_portion_is_a_plain_record_that_creates_the_order() {
    let (td, _keyring) = open(false, true);
    let manual_card = json!({ "method": "card", "payment_method": "card", "amount": 13.0, "currency": "EUR",
                              "paymentOrigin": "manual", "terminalApproved": false });
    let answer = press(&td, split_order(manual_card, true)).await;
    assert_eq!(answer["success"], true, "{answer}");
    let order_id = answer["orderId"]
        .as_str()
        .expect("the order id")
        .to_string();
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 1);
    let (method, amount, origin): (String, f64, String) = conn
        .query_row(
            "SELECT method, amount, payment_origin FROM order_payments WHERE order_id = ?1",
            [&order_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (method.as_str(), amount, origin.as_str()),
        ("card", 13.0, "manual")
    );
    // No terminal anywhere: no SALE row, nothing held for the checkout.
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM ecr_transactions"), 0);
    assert!(
        crate::commands::ecr::checkout_direct_sale_projection(&conn, CHECKOUT)
            .unwrap()
            .is_null()
    );
    assert!(crate::unsaved_payments::list(&conn, None)
        .unwrap()
        .is_empty());
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn a_first_card_portion_charged_on_the_terminal_is_saved_with_its_order() {
    let (td, _keyring) = open(true, true);
    let answer = press(&td, split_order(card_portion(), true)).await;
    assert_eq!(answer["success"], true, "{answer}");
    let order_id = answer["orderId"]
        .as_str()
        .expect("the order id")
        .to_string();
    let conn = td.state.conn.lock().unwrap();
    let (method, amount, reference): (String, f64, Option<String>) = conn
        .query_row(
            "SELECT method, amount, transaction_ref FROM order_payments WHERE order_id = ?1",
            [&order_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!((method.as_str(), amount), ("card", 13.0));
    assert_eq!(reference.as_deref(), Some("eft-split-first-1"));
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM ecr_transactions"), 0);
    assert!(crate::unsaved_payments::list(&conn, None)
        .unwrap()
        .is_empty());
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn a_charged_first_card_that_cannot_be_saved_is_held_and_saved_once_by_the_same_checkout() {
    // No cashier on shift: the order write fails after the card was charged. The charge is held under the
    // checkout (shown with Save payment again); the same checkout pressed again saves one order and one payment.
    let (td, _keyring) = open(true, false);
    let first = press(&td, split_order(card_portion(), true)).await;
    assert_eq!(first["errorCode"], "PAYMENT_NOT_SAVED", "{first}");
    {
        let conn = td.state.conn.lock().unwrap();
        let held = crate::unsaved_payments::list(&conn, Some(CHECKOUT)).unwrap();
        assert_eq!(held.len(), 1, "the charged card is held under the checkout");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 0);
        open_cashier_shift(&conn);
    }
    let again = press(&td, split_order(card_portion(), true)).await;
    assert_eq!(again["success"], true, "{again}");
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_payments"), 1);
    assert!(crate::unsaved_payments::list(&conn, None)
        .unwrap()
        .is_empty());
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM ecr_transactions"),
        0,
        "never sent to a terminal again"
    );
}

// Coordinator decision (A), 01/11/2026: the first portion's card SALE is bound to the checkout before its order
// exists. A SALE approved and not recorded (a crash between the approval and the create) is recorded through the
// same create with that SALE as the first payment; nothing else may save the checkout, and the checkout cannot be
// backed out to «nothing» while it stands. An outcome not known holds every payment of the checkout.

fn seed_checkout_sale(conn: &rusqlite::Connection, status: &str) {
    conn.execute(
        "INSERT OR IGNORE INTO ecr_devices (id, name, device_type, connection_type, is_default, enabled)
         VALUES ('eft-1', 'EFT', 'payment_terminal', 'network', 0, 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO ecr_transactions (id, device_id, order_id, transaction_type, amount, currency, status,
                                       receipt_data, started_at, completed_at)
         VALUES ('sale-first-card', 'eft-1', ?1, 'sale', 1300, 'EUR', ?2,
                 json_object('directSaleAdmissionVersion', 1, 'checkoutRequestId', ?1),
                 '2026-11-01T12:00:00Z', '2026-11-01T12:00:20Z')",
        params![CHECKOUT, status],
    )
    .unwrap();
}

fn card_from_the_sale() -> Value {
    json!({ "method": "card", "payment_method": "card", "amount": 13.0, "currency": "EUR",
            "transactionRef": "sale-first-card", "paymentOrigin": "terminal", "terminalApproved": true,
            "terminalDeviceId": "eft-1" })
}

fn inspect_checkout(td: &TestDb) -> Value {
    let conn = td.state.conn.lock().unwrap();
    crate::checkout_drafts::inspect(
        &conn,
        &json!({ "organizationId": "11111111-2222-4333-8444-999999999999", "branchId": BRANCH_ID,
                 "terminalId": TERMINAL_ID, "clientRequestId": CHECKOUT }),
    )
    .unwrap()
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn an_approved_checkout_sale_left_by_a_crash_is_recorded_by_the_same_create_with_no_new_charge(
) {
    let (td, _keyring) = open(true, true);
    seed_checkout_sale(&td.state.conn.lock().unwrap(), "approved");
    // Back-out to «nothing» is refused while the money is held: the checkout is not «not found».
    assert_ne!(inspect_checkout(&td)["outcome"], "not_found");

    let answer = press(&td, split_order(card_from_the_sale(), true)).await;
    assert_eq!(answer["success"], true, "{answer}");
    let order_id = answer["orderId"].as_str().unwrap().to_string();
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_payments"), 1);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM ecr_transactions"),
        1,
        "no new SALE"
    );
    assert!(
        crate::commands::ecr::unresolved_checkout_direct_sales(&conn, CHECKOUT)
            .unwrap()
            .is_empty()
    );
    assert!(
        crate::commands::ecr::unresolved_direct_sales(&conn, &order_id)
            .unwrap()
            .is_empty()
    );
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn while_a_checkout_sale_is_unrecorded_no_other_payment_saves_the_checkout() {
    let (td, _keyring) = open(true, true);
    seed_checkout_sale(&td.state.conn.lock().unwrap(), "approved");
    let other_tenders = [
        split_order(cash_portion(), true),
        // The whole cart paid in cash from the payment window instead.
        {
            let mut whole = split_order(
                json!({ "method": "cash", "amount": 26.0, "cashReceived": 26.0, "currency": "EUR" }),
                false,
            );
            whole["paymentMethod"] = json!("cash");
            whole
        },
        // A card of another amount or reference.
        split_order(
            json!({ "method": "card", "amount": 13.0, "currency": "EUR", "transactionRef": "another-sale",
            "paymentOrigin": "terminal", "terminalApproved": true, "terminalDeviceId": "eft-1" }),
            true,
        ),
    ];
    for payload in other_tenders {
        let answer = press(&td, payload).await;
        assert_eq!(
            answer["errorCode"], "CHECKOUT_CARD_SALE_UNRECORDED",
            "{answer}"
        );
        assert_eq!(answer["amountCents"], 1300);
        assert_eq!(answer["orderPersisted"], false);
    }
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_payments"), 0);
    assert!(crate::unsaved_payments::list(&conn, None)
        .unwrap()
        .is_empty());
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn an_unknown_checkout_sale_holds_every_payment_until_it_is_reconciled() {
    let (td, _keyring) = open(true, true);
    seed_checkout_sale(&td.state.conn.lock().unwrap(), "error");
    assert_ne!(inspect_checkout(&td)["outcome"], "not_found");
    for payload in [
        split_order(cash_portion(), true),
        split_order(card_from_the_sale(), true),
    ] {
        let answer = press(&td, payload).await;
        assert_eq!(
            answer["errorCode"], "CHECKOUT_CARD_SALE_UNRESOLVED",
            "{answer}"
        );
        assert_eq!(answer["orderPersisted"], false);
    }
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 0);
    let projection =
        crate::commands::ecr::checkout_direct_sale_projection(&conn, CHECKOUT).unwrap();
    assert_eq!(projection["requiresReconciliation"], true, "{projection}");
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn a_declined_checkout_sale_leaves_the_checkout_free() {
    let (td, _keyring) = open(true, true);
    seed_checkout_sale(&td.state.conn.lock().unwrap(), "declined");
    assert_eq!(inspect_checkout(&td)["outcome"], "not_found");
    let answer = press(&td, split_order(cash_portion(), true)).await;
    assert_eq!(answer["success"], true, "{answer}");
}
