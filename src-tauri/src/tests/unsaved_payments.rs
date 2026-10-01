//! Card payments charged on this till but not saved: end-to-end regressions
//! (fix review 30/09/2026; Android 1.0.13 parity).
//!
//! Symptom: the terminal approved a card, then the payment write failed. The
//! desktop answered "Failed to collect payment", kept no record, did not hold
//! the Z, and the next attempt could charge the card again.

use rusqlite::params;
use serde_json::{json, Value};

use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;
use crate::unsaved_payments::{
    save_charged_payment, UnsavedChargedPayment, PAYMENTS_NOT_SAVED_REASON_CODE,
    PAYMENT_NOT_SAVED_ERROR_CODE, PAYMENT_NOT_SAVED_PENDING_ERROR_CODE,
};

const TERMINAL_ID: &str = "terminal-unsaved";
const BRANCH_ID: &str = "11111111-2222-4333-8444-666666666666";
const ORDER_ID: &str = "ord-unsaved";

fn seed(conn: &rusqlite::Connection) {
    crate::db::set_setting(conn, "terminal", "__ignore_keyring", "1").unwrap();
    crate::db::set_setting(conn, "terminal", "terminal_id", TERMINAL_ID).unwrap();
    crate::db::set_setting(conn, "terminal", "branch_id", BRANCH_ID).unwrap();
    conn.execute(
        "INSERT INTO orders (
             id, order_number, items, total_amount, total_amount_cents, status, order_type,
             payment_status, sync_status, branch_id, terminal_id, created_at, updated_at
         ) VALUES (?1, 'A-0077', '[]', 13.0, 1300, 'completed', 'takeaway', 'pending', 'synced',
                   ?2, ?3, '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
        params![ORDER_ID, BRANCH_ID, TERMINAL_ID],
    )
    .expect("seed order");
}

fn approved_card(reference: &str, amount: f64) -> Value {
    json!({
        "orderId": ORDER_ID,
        "method": "card",
        "amount": amount,
        "transactionRef": reference,
        "paymentOrigin": "terminal",
        "terminalApproved": true,
        "terminalDeviceId": "eft-1",
    })
}

fn completed_cents(conn: &rusqlite::Connection) -> i64 {
    conn.query_row(
        "SELECT COALESCE(SUM(amount_cents), 0) FROM order_payments
         WHERE order_id = ?1 AND status = 'completed'",
        params![ORDER_ID],
        |row| row.get(0),
    )
    .unwrap()
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
        .filter(|blocker| blocker["reasonCode"] == PAYMENTS_NOT_SAVED_REASON_CODE)
        .cloned()
        .collect()
}

/// The write keeps failing: the answer says the card was charged and not
/// saved, the record survives a restart and holds the Z, and "Save payment
/// again" replays it with the same key once the till can write, which
/// releases the Z.
#[tokio::test(flavor = "current_thread")]
// One order id and the process-wide payment reservation: run one at a time.
#[serial_test::serial]
async fn a_charged_payment_not_saved_survives_a_restart_holds_the_z_and_a_replay_saves_it() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    seed(&td.state.conn.lock().unwrap());

    let entry = UnsavedChargedPayment::for_payment(
        ORDER_ID,
        &approved_card("txn-restart", 13.0),
        None,
        "2026-09-30T10:05:00Z",
    )
    .expect("a keyed card payment");
    let mut writes = 0;
    let answer = save_charged_payment(&td.state, entry, &[0, 0, 0], None, |_, _| {
        writes += 1;
        Err("database is locked".to_string())
    })
    .await;
    assert_eq!(writes, 4, "the write and three retries, the same key");
    assert_eq!(answer["errorCode"], PAYMENT_NOT_SAVED_ERROR_CODE);
    assert_eq!(answer["paymentApproved"], true);
    assert_eq!(answer["paymentPersisted"], false);
    assert!(
        answer["error"]
            .as_str()
            .unwrap()
            .contains("The card was charged 13.00"),
        "never a generic failure: {answer}"
    );

    let td = td.restart();
    let blockers = not_saved_blockers(&td);
    assert_eq!(blockers.len(), 1, "the record survived and holds the Z");
    assert_eq!(blockers[0]["orderNumber"], "A-0077");
    assert_eq!(blockers[0]["severity"], "blocking");
    assert_eq!(blockers[0]["differenceCents"], 0);
    assert_eq!(
        blockers[0]["unsavedPayment"]["idempotencyKey"],
        "terminal-card:txn-restart"
    );
    assert_eq!(blockers[0]["unsavedPayment"]["amountCents"], 1300);
    assert_eq!(blockers[0]["unsavedPayment"]["canSaveAgain"], true);
    let refused = crate::zreport::submit_z_report(&td.state, &json!({ "branchId": BRANCH_ID }))
        .expect_err("the day does not close over a charged payment not saved");
    assert!(refused.starts_with("Cannot generate Z-report"), "{refused}");

    let replay = crate::commands::payments::save_unsaved_payments_with_delays(
        &td.state,
        Some(json!({ "orderId": ORDER_ID })),
        &[0, 0, 0],
        &crate::print::NoopPrintQueueInvalidator,
    )
    .await
    .expect("Save payment again");
    assert_eq!(replay["success"], true, "{replay}");
    assert_eq!(replay["saved"], 1);
    assert!(
        not_saved_blockers(&td).is_empty(),
        "saved: the Z is released"
    );
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(completed_cents(&conn), 1300, "one payment, never two");
    let key: String = conn
        .query_row(
            "SELECT idempotency_key FROM order_payments WHERE order_id = ?1",
            params![ORDER_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(key, "terminal-card:txn-restart", "saved under its own key");
}

/// While a charged payment of the order is not saved, every new tender is
/// refused before anything is charged; a card the terminal already approved
/// is never refused (its money moved), it is saved like any other.
#[tokio::test(flavor = "current_thread")]
// One order id and the process-wide payment reservation: run one at a time.
#[serial_test::serial]
async fn a_new_tender_is_refused_while_a_charged_payment_is_not_saved() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL_ID)]);
    let td = TestDb::open();
    seed(&td.state.conn.lock().unwrap());
    let entry = UnsavedChargedPayment::for_payment(
        ORDER_ID,
        &approved_card("txn-pending", 13.0),
        None,
        "2026-09-30T10:05:00Z",
    )
    .unwrap();
    save_charged_payment(&td.state, entry, &[0, 0, 0], None, |_, _| {
        Err("disk I/O error".to_string())
    })
    .await;

    let conn = td.state.conn.lock().unwrap();
    let refusal =
        crate::commands::payments::refuse_new_tender_while_unsaved(&conn, ORDER_ID, false)
            .unwrap()
            .expect("cash, a manual card or a fiscal checkout is refused");
    assert_eq!(refusal["errorCode"], PAYMENT_NOT_SAVED_PENDING_ERROR_CODE);
    assert_eq!(refusal["paymentApproved"], false, "nothing was charged");
    assert_eq!(refusal["unsavedPayments"][0]["amountCents"], 1300);
    assert!(
        crate::commands::payments::refuse_new_tender_while_unsaved(&conn, ORDER_ID, true)
            .unwrap()
            .is_none(),
        "an approved card is money that moved: never refused"
    );
    assert!(
        crate::commands::payments::refuse_new_tender_while_unsaved(&conn, "other-order", false)
            .unwrap()
            .is_none(),
        "other orders are not held"
    );
}

/// A split terminal portion whose save fails keeps its record as a portion
/// (with its items) and replays as that portion: never back to a chargeable
/// draft, never charged twice.
#[tokio::test(flavor = "current_thread")]
// One order id and the process-wide payment reservation: run one at a time.
#[serial_test::serial]
async fn a_split_portion_not_saved_replays_as_that_portion() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL_ID)]);
    let td = TestDb::open();
    seed(&td.state.conn.lock().unwrap());
    let mut portion = approved_card("txn-portion", 5.0);
    portion["items"] = json!([{
        "itemIndex": 0,
        "itemName": "Espresso",
        "itemQuantity": 1,
        "itemAmount": 5.0,
    }]);
    let entry =
        UnsavedChargedPayment::for_payment(ORDER_ID, &portion, None, "2026-09-30T10:05:00Z")
            .unwrap();
    assert_eq!(entry.kind, "split_portion");
    let answer = save_charged_payment(&td.state, entry, &[0, 0, 0], None, |_, _| {
        Err("database is locked".to_string())
    })
    .await;
    assert_eq!(answer["unsavedPayment"]["kind"], "split_portion");

    let replay = crate::commands::payments::save_unsaved_payments_with_delays(
        &td.state,
        Some(json!({ "idempotencyKey": "terminal-card:txn-portion" })),
        &[0, 0, 0],
        &crate::print::NoopPrintQueueInvalidator,
    )
    .await
    .unwrap();
    assert_eq!(replay["saved"], 1, "{replay}");
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(completed_cents(&conn), 500, "the portion, not the order");
    let items: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM payment_items WHERE order_id = ?1",
            params![ORDER_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(items, 1, "with its items");
}
