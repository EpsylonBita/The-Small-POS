//! One card approval, one payment: the direct-SALE admission of #308 (schema
//! 89/91, `commands::ecr`) against the payments set aside for review and the
//! charged payments not saved of the 1.0.13 / 1.4.120 release (merge review
//! 30/09/2026).
//!
//! Symptoms these pin, each reproduced against the schema 89 rule before the
//! fix:
//! - a card row the server later refused as already paid (set aside,
//!   `duplicate_review`) left its SALE unresolved: the order's next payment
//!   and gift debit were refused for good, and the payment screens offered to
//!   book the same approval again;
//! - a charged payment a manager recorded as given back left its SALE
//!   bookable;
//! - a SALE booked by its own recovery under another key left the release's
//!   record of the charge listed: the Z stayed held and "Save payment again"
//!   would have set the same money aside a second time.

use rusqlite::{params, Connection};
use serde_json::json;

use crate::commands::ecr::{direct_sale_projection, unresolved_direct_sales};
use crate::payment_review::{set_aside_payment_in_connection, SetAsideReason};
use crate::tests::harness::TestDb;
use crate::unsaved_payments::{self, ResolveOutcome, UnsavedChargedPayment};

const ORDER_ID: &str = "ord-direct-sale";
const DEVICE_ID: &str = "eft-direct";

fn seed(conn: &Connection) {
    conn.execute(
        "INSERT INTO orders (
             id, order_number, items, total_amount, total_amount_cents, status, order_type,
             payment_status, sync_status, created_at, updated_at
         ) VALUES (?1, 'A-0091', '[]', 13.0, 1300, 'completed', 'takeaway', 'pending',
                   'synced', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
        params![ORDER_ID],
    )
    .expect("seed order");
    conn.execute(
        "INSERT INTO ecr_devices (id, name, device_type, connection_type)
         VALUES (?1, 'Terminal', 'payment_terminal', 'network')",
        params![DEVICE_ID],
    )
    .expect("seed terminal");
}

/// An approved pre-dispatch (schema 89) direct SALE of the order.
fn approved_sale(conn: &Connection, sale_id: &str) {
    conn.execute(
        "INSERT INTO ecr_transactions (
             id, device_id, order_id, transaction_type, amount, currency, status,
             receipt_data, started_at
         ) VALUES (?1, ?2, ?3, 'sale', 1300, 'EUR', 'approved',
                   '{\"directSaleAdmissionVersion\":1}', '2026-09-30T10:01:00Z')",
        params![sale_id, DEVICE_ID, ORDER_ID],
    )
    .expect("seed approved SALE");
}

/// The SALE's exact card payment row, under `key`.
fn book_sale(
    conn: &Connection,
    payment_id: &str,
    sale_id: &str,
    key: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO order_payments (
             id, order_id, method, amount, amount_cents, currency, status, transaction_ref,
             payment_origin, terminal_device_id, idempotency_key, created_at, updated_at
         ) VALUES (?1, ?2, 'card', 13.0, 1300, 'EUR', 'completed', ?3, 'terminal', ?4, ?5,
                   '2026-09-30T10:02:00Z', '2026-09-30T10:02:00Z')",
        params![payment_id, ORDER_ID, sale_id, DEVICE_ID, key],
    )
}

fn cash(conn: &Connection, payment_id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO order_payments (
             id, order_id, method, amount, amount_cents, currency, status, payment_origin,
             created_at, updated_at
         ) VALUES (?1, ?2, 'cash', 13.0, 1300, 'EUR', 'completed', 'manual',
                   '2026-09-30T10:03:00Z', '2026-09-30T10:03:00Z')",
        params![payment_id, ORDER_ID],
    )
}

fn charged_record(sale_id: &str, key: &str) -> UnsavedChargedPayment {
    UnsavedChargedPayment::for_payment(
        ORDER_ID,
        &json!({
            "orderId": ORDER_ID,
            "method": "card",
            "amount": 13.0,
            "currency": "EUR",
            "idempotencyKey": key,
            "transactionRef": sale_id,
            "paymentOrigin": "terminal",
            "terminalApproved": true,
            "terminalDeviceId": DEVICE_ID,
        }),
        None,
        "2026-09-30T10:01:30Z",
    )
    .expect("a keyed card payment")
}

#[test]
fn a_card_row_set_aside_after_booking_still_represents_its_sale() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed(&conn);
    approved_sale(&conn, "sale-set-aside");
    book_sale(
        &conn,
        "pay-sale",
        "sale-set-aside",
        "terminal-card:sale-set-aside",
    )
    .expect("the exact original books");
    assert!(unresolved_direct_sales(&conn, ORDER_ID).unwrap().is_empty());

    // The server answered already_paid: the row is set aside for review.
    set_aside_payment_in_connection(
        &conn,
        "pay-sale",
        SetAsideReason::AlreadyPaid,
        None,
        "2026-09-30T10:04:00Z",
    )
    .expect("set the card aside");
    let status: String = conn
        .query_row(
            "SELECT status FROM order_payments WHERE id = 'pay-sale'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "duplicate_review");

    assert!(
        unresolved_direct_sales(&conn, ORDER_ID).unwrap().is_empty(),
        "the set-aside row records the SALE's money"
    );
    assert_eq!(
        direct_sale_projection(&conn, ORDER_ID).unwrap(),
        serde_json::Value::Null
    );
    assert!(
        book_sale(&conn, "pay-again", "sale-set-aside", "terminal-card:again").is_err(),
        "the same approval is never booked a second time"
    );
    cash(&conn, "pay-cash").expect("the order is not held by a represented SALE");
}

#[test]
fn a_voided_card_row_still_represents_its_sale() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed(&conn);
    approved_sale(&conn, "sale-voided");
    book_sale(
        &conn,
        "pay-voided",
        "sale-voided",
        "terminal-card:sale-voided",
    )
    .unwrap();
    conn.execute(
        "UPDATE order_payments SET status = 'voided' WHERE id = 'pay-voided'",
        [],
    )
    .unwrap();

    assert!(unresolved_direct_sales(&conn, ORDER_ID).unwrap().is_empty());
    assert!(book_sale(&conn, "pay-rebook", "sale-voided", "terminal-card:rebook").is_err());
    cash(&conn, "pay-cash-after-void").expect("the voided order can be collected again");
}

#[test]
fn money_given_back_for_a_charged_sale_settles_the_sale_for_good() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed(&conn);
    approved_sale(&conn, "sale-given-back");
    let record = charged_record("sale-given-back", "terminal-card:sale-given-back");
    unsaved_payments::record(&conn, &record).unwrap();
    assert_eq!(unresolved_direct_sales(&conn, ORDER_ID).unwrap().len(), 1);

    let outcome = unsaved_payments::resolve_in_connection(
        &conn,
        "terminal-card:sale-given-back",
        Some("manager-1"),
        "2026-09-30T11:00:00Z",
    )
    .expect("resolve");
    assert!(
        matches!(outcome, ResolveOutcome::Resolved { .. }),
        "{outcome:?}"
    );

    let marker: Option<String> = conn
        .query_row(
            "SELECT json_extract(receipt_data, '$.returnedToCustomer.idempotencyKey')
             FROM ecr_transactions WHERE id = 'sale-given-back'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marker.as_deref(), Some("terminal-card:sale-given-back"));
    assert!(unresolved_direct_sales(&conn, ORDER_ID).unwrap().is_empty());
    assert_eq!(
        direct_sale_projection(&conn, ORDER_ID).unwrap(),
        serde_json::Value::Null
    );
    assert!(
        book_sale(
            &conn,
            "pay-after-return",
            "sale-given-back",
            "terminal-card:late"
        )
        .is_err(),
        "money given back is never booked"
    );
    cash(&conn, "pay-cash-after-return").expect("the order takes its payment again");
}

#[test]
fn a_sale_booked_by_its_recovery_under_another_key_saves_the_charged_record() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed(&conn);
    approved_sale(&conn, "sale-recovered");
    let record = charged_record("sale-recovered", "checkout-key-1");
    unsaved_payments::record(&conn, &record).unwrap();
    assert_eq!(
        unsaved_payments::list(&conn, Some(ORDER_ID)).unwrap().len(),
        1
    );

    // The payment screens book the saved approval under the terminal key.
    book_sale(
        &conn,
        "pay-recovered",
        "sale-recovered",
        "terminal-card:sale-recovered",
    )
    .expect("the exact original books");

    assert!(
        unsaved_payments::list(&conn, Some(ORDER_ID))
            .unwrap()
            .is_empty(),
        "the charge is recorded: it no longer holds the Z"
    );
    let outcome = unsaved_payments::resolve_in_connection(
        &conn,
        "checkout-key-1",
        Some("manager-1"),
        "2026-09-30T11:00:00Z",
    )
    .expect("resolve");
    assert_eq!(
        outcome,
        ResolveOutcome::Saved,
        "nothing is given back for booked money"
    );
    assert!(unsaved_payments::load(&conn, "checkout-key-1")
        .unwrap()
        .is_none());
    let marker: Option<String> = conn
        .query_row(
            "SELECT json_extract(receipt_data, '$.returnedToCustomer') FROM ecr_transactions
             WHERE id = 'sale-recovered'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(marker.is_none());
}

/// An approved card the order's unresolved direct SALE does not admit (not
/// its exact original) is money that moved: `payment_record` holds it as a
/// charged payment not saved instead of refusing it (founder rule 2), so the
/// Z holds and a manager's decision settles it. The unrelated SALE is left
/// exactly as it was.
#[tokio::test(flavor = "current_thread")]
async fn an_approved_card_the_sale_admission_refuses_is_held_not_lost() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed(&conn);
        approved_sale(&conn, "sale-open");
    }
    let entry = charged_record("other-approval", "terminal-card:other-approval");
    // The write the record replays, reduced to its row: the schema's
    // direct-SALE admission is what refuses it.
    let answer =
        unsaved_payments::save_charged_payment(&td.state, entry, &[0, 0, 0], None, |db, held| {
            let conn = db.conn.lock().map_err(|error| error.to_string())?;
            conn.execute(
                "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, currency, status, transaction_ref,
                 payment_origin, terminal_device_id, idempotency_key, created_at, updated_at
             ) VALUES ('pay-other', ?1, 'card', 13.0, 1300, 'EUR', 'completed', ?2, 'terminal',
                       ?3, ?4, '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
                params![
                    held.order_id,
                    held.transaction_ref,
                    DEVICE_ID,
                    held.idempotency_key
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "paymentId": "pay-other" }))
        })
        .await;
    assert_eq!(
        answer["errorCode"],
        unsaved_payments::PAYMENT_NOT_SAVED_ERROR_CODE,
        "{answer}"
    );
    assert_eq!(answer["paymentApproved"], true);

    let conn = td.state.conn.lock().unwrap();
    let held = unsaved_payments::list(&conn, Some(ORDER_ID)).unwrap();
    assert_eq!(held.len(), 1, "the charge is held and holds the Z");
    assert!(
        held[0]
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("unresolved direct card SALE")),
        "{:?}",
        held[0].last_error
    );
    let completed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_payments WHERE order_id = ?1",
            params![ORDER_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(completed, 0, "nothing was booked past the SALE");

    let outcome = unsaved_payments::resolve_in_connection(
        &conn,
        "terminal-card:other-approval",
        Some("manager-1"),
        "2026-09-30T11:00:00Z",
    )
    .expect("resolve");
    assert!(matches!(outcome, ResolveOutcome::Resolved { .. }));
    assert_eq!(
        unresolved_direct_sales(&conn, ORDER_ID).unwrap().len(),
        1,
        "the other approval's return never settles the open SALE"
    );
}
