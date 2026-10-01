//! Round 3 review fixes (01/10/2026), the shared rules on the desktop side,
//! the same as Android:
//!
//! - R1: the till never voids or refunds a delivery platform's settlement row
//!   (`PLATFORM_SETTLEMENT_NOT_REVERSIBLE`), and one settlement classifier in
//!   both apps (a method other than cash or card, and one of the server's
//!   marks: external id, idempotency key or metadata).
//! - R4: a payment the server refused as platform-held (`platform_held`
//!   set-aside) makes the order's money the platform's: no cash, card or
//!   "Record the payment", and no "paid but not recorded" cancel refusal.
//!   A platform order of unknown disposition is store-collectable (the shared
//!   contract `isStoreCollectableOrder`): its unbacked paid label refuses the
//!   cancel until restored or recorded.
//! - R5: a refund of an `other` tender names `other` (v94), and the server is
//!   told cash or card only.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::commands::orders::{
    cancel_refusal_code, ORDER_HAS_PAYMENTS, ORDER_PAYMENT_NOT_RECORDED,
};
use crate::tests::harness::TestDb;

const NOW: &str = "2026-10-01T12:00:00Z";
const PREPAID_EFOOD: &str = r#"{"food_delivery":{"prepaid":true,"payment_method":"online"}}"#;

fn seed_order(conn: &Connection, id: &str, label: &str, platform: Option<(&str, &str, &str)>) {
    let (plugin, external_id, metadata) = platform.unwrap_or(("", "", ""));
    conn.execute(
        "INSERT INTO orders (id, order_number, supabase_id, items, total_amount, total_amount_cents,
             status, order_type, payment_status, sync_status, plugin, external_plugin_order_id,
             ghost_metadata, created_at, updated_at)
         VALUES (?1, ?1, ?2, '[]', 12.0, 1200, 'pending', 'delivery', ?3, 'synced',
                 NULLIF(?4, ''), NULLIF(?5, ''), NULLIF(?6, ''),
                 '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')",
        params![id, format!("remote-{id}"), label, plugin, external_id, metadata],
    )
    .expect("seed the order");
}

/// A completed, server-held row. `marks`: (transaction_ref, idempotency_key, metadata).
fn seed_row(
    conn: &Connection,
    id: &str,
    order_id: &str,
    method: &str,
    marks: (Option<&str>, Option<&str>, Option<&str>),
) {
    let (transaction_ref, idempotency_key, metadata) = marks;
    conn.execute(
        "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
             transaction_ref, idempotency_key, metadata, payment_origin, remote_payment_id,
             sync_status, sync_state, created_at, updated_at)
         VALUES (?1, ?2, ?3, 12.0, 1200, 'completed', ?4, ?5, ?6, 'sync_reconstructed', ?7,
                 'synced', 'applied', '2026-10-01T10:00:05Z', '2026-10-01T10:00:05Z')",
        params![
            id,
            order_id,
            method,
            transaction_ref,
            idempotency_key,
            metadata,
            format!("remote-{id}")
        ],
    )
    .expect("seed the payment row");
}

fn adjustments_of(conn: &Connection, order_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM payment_adjustments WHERE order_id = ?1",
        params![order_id],
        |row| row.get(0),
    )
    .unwrap()
}

// ---------------------------------------------------------------------------
// R1
// ---------------------------------------------------------------------------

/// R1: the refund screen offered Void and Refund on the platform's mirrored
/// settlement row, and both went through: two adjustments synced to the
/// server against its canonical settlement payment, so the till, not the
/// server, decided what became of the platform's money (review probe
/// `review_probe_till_reverses_platform_settlement_row`). Android refuses
/// both before any write (974dcd3a6). Now desktop does too.
#[test]
fn r1_the_till_never_refunds_or_voids_the_platform_settlement_row() {
    let _keyring = crate::tests::fake_keyring::install_seeded([
        ("terminal_id", "terminal-r1"),
        ("branch_id", "branch-r1"),
    ]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_order(
            &conn,
            "ord-r1-settled",
            "paid",
            Some(("efood", "efood-1", PREPAID_EFOOD)),
        );
        seed_row(
            &conn,
            "settle-r1",
            "ord-r1-settled",
            "other",
            (
                Some("platform_settlement:online:remote-ord-r1-settled"),
                None,
                None,
            ),
        );
    }
    let refund = crate::refunds::refund_payment(
        &td.state,
        &json!({ "paymentId": "settle-r1", "amount": 12.0, "reason": "Synthetic" }),
    )
    .expect_err("the settlement is never refunded at the till");
    assert!(
        refund.starts_with("PLATFORM_SETTLEMENT_NOT_REVERSIBLE"),
        "{refund}"
    );
    let void = crate::refunds::void_payment_with_adjustment(
        &td.state,
        "settle-r1",
        "Synthetic",
        None,
        None,
    )
    .expect_err("the settlement is never voided at the till");
    assert!(
        void.starts_with("PLATFORM_SETTLEMENT_NOT_REVERSIBLE"),
        "{void}"
    );

    let conn = td.state.conn.lock().unwrap();
    assert_eq!(
        adjustments_of(&conn, "ord-r1-settled"),
        0,
        "nothing written"
    );
    let status: String = conn
        .query_row(
            "SELECT status FROM order_payments WHERE id = 'settle-r1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "completed");
    drop(conn);

    // The refund screen offers neither: the till marks the row.
    let rows = crate::payments::get_order_payments(&td.state, "ord-r1-settled").unwrap();
    assert_eq!(rows[0]["platformSettlement"], json!(true), "{rows}");
    let balance = crate::refunds::get_payment_balance(&td.state, "settle-r1").unwrap();
    assert_eq!(balance["platformSettlement"], json!(true), "{balance}");
}

/// R1, one classifier in both apps (Android `platformSettlementRowSql`): a
/// cash or card row is always money a till took, whatever its reference says
/// (desktop read a `platform_settlement:*` reference on ANY method as the
/// platform's, so it let that cancel through where Android refused it); an
/// `other` row the server marked only by its key or its metadata is the
/// platform's settlement (desktop read it as store money and refused the
/// cancel where Android allowed it).
#[test]
fn r1_one_settlement_classifier_with_android() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "ord-r1-cash-ref", "paid", None);
    seed_row(
        &conn,
        "pay-r1-cash-ref",
        "ord-r1-cash-ref",
        "cash",
        (
            Some("platform_settlement:cod:remote-ord-r1-cash-ref"),
            None,
            None,
        ),
    );
    assert_eq!(
        cancel_refusal_code(&conn, "ord-r1-cash-ref").unwrap(),
        Some(ORDER_HAS_PAYMENTS),
        "cash a till took, whatever its reference"
    );

    for (order_id, payment_id, marks) in [
        (
            "ord-r1-key",
            "pay-r1-key",
            (None, Some("platform-settle-remote-ord-r1-key"), None),
        ),
        (
            "ord-r1-key-ref",
            "pay-r1-key-ref",
            (
                None,
                Some("platform_settlement:online:remote-ord-r1-key-ref"),
                None,
            ),
        ),
        (
            "ord-r1-meta",
            "pay-r1-meta",
            (
                None,
                None,
                Some(r#"{"platform_settlement":{"kind":"online"}}"#),
            ),
        ),
        (
            "ord-r1-origin",
            "pay-r1-origin",
            (
                None,
                None,
                Some(r#"{"payment_origin":"platform_settlement"}"#),
            ),
        ),
    ] {
        seed_order(
            &conn,
            order_id,
            "paid",
            Some(("efood", order_id, PREPAID_EFOOD)),
        );
        seed_row(&conn, payment_id, order_id, "other", marks);
        assert_eq!(
            cancel_refusal_code(&conn, order_id).unwrap(),
            None,
            "{order_id}: the platform's settlement never refuses a decline"
        );
    }

    // An ordinary `other` row without any mark is store money.
    seed_order(&conn, "ord-r1-voucher", "paid", None);
    seed_row(
        &conn,
        "pay-r1-voucher",
        "ord-r1-voucher",
        "other",
        (Some("VOUCHER-7"), None, None),
    );
    assert_eq!(
        cancel_refusal_code(&conn, "ord-r1-voucher").unwrap(),
        Some(ORDER_HAS_PAYMENTS)
    );
}

// ---------------------------------------------------------------------------
// R4
// ---------------------------------------------------------------------------

fn seed_platform_held_set_aside(conn: &Connection, order_id: &str) {
    // The till's disposition reads store-collectable (the store's own driver
    // carries it), but the server refused a till payment on it as money the
    // platform holds: the server's answer wins.
    seed_order(
        conn,
        order_id,
        "paid",
        Some((
            "efood",
            order_id,
            r#"{"food_delivery":{"payment_method":"cash","delivery_provider":"vendor_delivery"}}"#,
        )),
    );
    conn.execute(
        "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
             sync_status, sync_state, created_at, updated_at)
         VALUES (?1, ?2, 'card', 12.0, 1200, 'completed', 'pending', 'pending',
                 '2026-10-01T10:05:00Z', '2026-10-01T10:05:00Z')",
        params![format!("pay-{order_id}"), order_id],
    )
    .unwrap();
    crate::payment_review::set_aside_platform_held_payment(conn, &format!("pay-{order_id}"), NOW)
        .expect("set the refused payment aside");
    // A pull put the paid label back before the settlement was mirrored.
    conn.execute(
        "UPDATE orders SET payment_status = 'paid' WHERE id = ?1",
        params![order_id],
    )
    .unwrap();
}

/// R4: desktop read the `platform_held` set-aside only for the Z blocker's
/// flag. An order the server had called platform-held, whose label a pull
/// put back to paid before the settlement was mirrored, refused its cancel
/// as "record the payment from the Z report" (where no tender is offered)
/// and still accepted a cash or card collection at the till, which the
/// server refused again. Android exempts the cancel and refuses both.
#[test]
fn r4_a_platform_held_set_aside_makes_the_money_the_platforms() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_platform_held_set_aside(&conn, "ord-r4-held");
    assert_eq!(
        cancel_refusal_code(&conn, "ord-r4-held").unwrap(),
        None,
        "the platform holds it: the decline goes through, the server decides"
    );
    for method in ["cash", "card"] {
        let input = crate::payments::build_payment_record_input(&json!({
            "orderId": "ord-r4-held",
            "method": method,
            "amount": 12.0,
        }))
        .unwrap();
        let error = crate::payments::record_payment_in_connection(
            &conn,
            &input,
            &crate::payments::PaymentInsertOptions::local(),
        )
        .map(|_| ())
        .expect_err("never collected or recorded at the till");
        assert!(
            error.starts_with(crate::payments::PLATFORM_HELD_COLLECTION_ERROR),
            "{method}: {error}"
        );
    }
    // The server's own record still mirrors.
    let mirror = crate::payments::build_applied_canonical_payment_record_input(&json!({
        "orderId": "ord-r4-held",
        "method": "other",
        "amount": 12.0,
        "transactionRef": "platform_settlement:online:remote-ord-r4-held",
        "paymentOrigin": "sync_reconstructed",
    }))
    .unwrap();
    crate::payments::record_payment_in_connection(
        &conn,
        &mirror,
        &crate::payments::PaymentInsertOptions::applied(Some("remote-settle-r4".into())),
    )
    .expect("the server's settlement mirrors");
}

/// The shared contract (`isStoreCollectableOrder`: "unknown means ask the
/// operator, never assume"), as on Android: a platform order whose
/// disposition this till does not know, labelled paid with no payment
/// record, is refused its cancel until the record is restored or recorded.
/// Desktop exempted it, so it cancelled a paid label with no record.
#[test]
fn r4_a_platform_order_of_unknown_disposition_is_collectable_by_the_store() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "ord-unknown", "paid", Some(("wolt", "wolt-77", "")));
    assert!(crate::payments::order_money_is_store_collectable(
        &conn,
        "ord-unknown"
    ));
    assert_eq!(
        cancel_refusal_code(&conn, "ord-unknown").unwrap(),
        Some(ORDER_PAYMENT_NOT_RECORDED)
    );
    // A known platform-held disposition stays exempt.
    seed_order(
        &conn,
        "ord-known",
        "paid",
        Some(("efood", "efood-78", PREPAID_EFOOD)),
    );
    assert_eq!(cancel_refusal_code(&conn, "ord-known").unwrap(), None);
    // A store's hand-tagged Wolt order (platform `pos`, no metadata) is an
    // ordinary store order.
    seed_order(&conn, "ord-hand-wolt", "paid", Some(("pos", "", "")));
    assert_eq!(
        cancel_refusal_code(&conn, "ord-hand-wolt").unwrap(),
        Some(ORDER_PAYMENT_NOT_RECORDED)
    );
}

// ---------------------------------------------------------------------------
// R5
// ---------------------------------------------------------------------------

/// R5: "a refund always names its tender". Desktop stored no tender for the
/// refund of an `other` payment (v37's CHECK allowed cash or card only),
/// while Android stored `other`: the same refund, two records. v94 widens
/// the CHECK; the server is still told cash or card only, as Android sends.
#[test]
fn r5_an_other_refund_names_other_and_the_server_hears_no_tender() {
    let _keyring = crate::tests::fake_keyring::install_seeded([
        ("terminal_id", "terminal-r5"),
        ("branch_id", "branch-r5"),
    ]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_order(&conn, "ord-r5-voucher", "paid", None);
        seed_row(
            &conn,
            "pay-r5-voucher",
            "ord-r5-voucher",
            "other",
            (Some("VOUCHER-9"), None, None),
        );
    }
    let answer = crate::refunds::refund_payment(
        &td.state,
        &json!({ "paymentId": "pay-r5-voucher", "amount": 5.0, "reason": "Synthetic" }),
    )
    .expect("refund the voucher payment");
    assert_eq!(answer["refundMethod"], json!("other"));
    assert_eq!(answer["cashHandler"], Value::Null);

    let conn = td.state.conn.lock().unwrap();
    let (method, handler): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT refund_method, cash_handler FROM payment_adjustments WHERE payment_id = 'pay-r5-voucher'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (method.as_deref(), handler.as_deref()),
        (Some("other"), None)
    );
    let payload: String = conn
        .query_row(
            "SELECT data FROM parity_sync_queue WHERE table_name = 'payment_adjustments'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let payload: Value = serde_json::from_str(&payload).unwrap();
    assert!(payload.get("refundMethod").is_none(), "{payload}");
    let balance = {
        drop(conn);
        crate::refunds::get_payment_balance(&td.state, "pay-r5-voucher").unwrap()
    };
    assert_eq!(balance["defaultRefundMethod"], json!("other"));
}
