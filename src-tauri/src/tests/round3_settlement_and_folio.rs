//! Round 3 of the 01/10/2026 fix review, shared rules R1 and R6 (the same
//! rules on Android):
//!
//! - R1: a platform settlement row (a method other than cash or card, marked
//!   by the server: external id `platform_settlement:*`, its key or its
//!   metadata; `payments::platform_settlement_row_sql`, the same classifier as
//!   Android's) is never money the STORE took for the cancel/decline refusal,
//!   on any order; it is still the order's payment record.
//! - R6: a hotel folio charge (the server's `room_charge`) is never refused a
//!   cancel as paid without a payment record, and never blocks the Z.

use rusqlite::{params, Connection};
use serde_json::json;

use crate::commands::orders::{
    cancel_refusal_code, decline_order_locally, ORDER_HAS_PAYMENTS, ORDER_PAYMENT_NOT_RECORDED,
};
use crate::tests::harness::TestDb;

const NOW: &str = "2026-10-01T12:00:00Z";

fn seed_order(conn: &Connection, id: &str, label: &str, extra: Option<(&str, &str, &str)>) {
    let (plugin, external_id, metadata) = extra.unwrap_or(("", "", ""));
    conn.execute(
        "INSERT INTO orders (id, order_number, supabase_id, items, total_amount, total_amount_cents,
             status, order_type, payment_status, sync_status, plugin, external_plugin_order_id,
             ghost_metadata, created_at, updated_at)
         VALUES (?1, ?1, ?2, '[]', 12.0, 1200, 'pending', 'delivery', ?3, 'synced',
                 NULLIF(?4, ''), NULLIF(?5, ''), NULLIF(?6, ''),
                 '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')",
        params![
            id,
            format!("remote-{id}"),
            label,
            plugin,
            external_id,
            metadata
        ],
    )
    .expect("seed the order");
}

fn seed_settlement_row(conn: &Connection, order_id: &str, method: &str) {
    conn.execute(
        "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
             transaction_ref, payment_origin, remote_payment_id, sync_status, sync_state,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, 12.0, 1200, 'completed', ?4, 'sync_reconstructed', ?5,
                 'synced', 'applied', '2026-10-01T10:00:05Z', '2026-10-01T10:00:05Z')",
        params![
            format!("settle-{order_id}"),
            order_id,
            method,
            format!("platform_settlement:online:{order_id}"),
            format!("remote-settle-{order_id}"),
        ],
    )
    .expect("seed the platform settlement row");
}

fn status_of(conn: &Connection, order_id: &str) -> String {
    conn.query_row(
        "SELECT status FROM orders WHERE id = ?1",
        params![order_id],
        |row| row.get(0),
    )
    .expect("the order exists")
}

// ---------------------------------------------------------------------------
// R1
// ---------------------------------------------------------------------------

/// R1: the platform's settlement row was money the store took whenever the
/// till did not classify the order as platform-held (a store order carrying
/// one, or a platform order of unknown disposition), and the decline of a
/// platform-held order carrying it was refused as ORDER_HAS_PAYMENTS. The
/// till cannot void the platform's money, so both were dead ends. It is never
/// money the store took; it is the order's record, so neither is refused as
/// "not recorded" either. (A CASH or CARD row is always money a till took,
/// whatever its reference says, as on Android: round 3 review; such a row on
/// a platform-held order is the platform-mismatch repair's to void.)
#[test]
fn r1_a_platform_settlement_row_never_refuses_a_cancel_or_decline() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        // The till sees no platform markers on this one: a store order.
        seed_order(&conn, "ord-store-with-settlement", "paid", None);
        seed_settlement_row(&conn, "ord-store-with-settlement", "other");
        // Platform-held, and its mirrored settlement row.
        seed_order(
            &conn,
            "ord-efood-settled-card",
            "paid",
            Some((
                "efood",
                "efood-3001",
                r#"{"food_delivery":{"prepaid":true,"payment_method":"online"}}"#,
            )),
        );
        seed_settlement_row(&conn, "ord-efood-settled-card", "other");
        for order_id in ["ord-store-with-settlement", "ord-efood-settled-card"] {
            assert_eq!(
                cancel_refusal_code(&conn, order_id).unwrap(),
                None,
                "{order_id}: the platform's settlement is no money the store took"
            );
        }
    }
    for order_id in ["ord-store-with-settlement", "ord-efood-settled-card"] {
        decline_order_locally(&td.state, order_id, "Store closed", NOW)
            .unwrap_or_else(|error| panic!("{order_id}: {error}"));
        let conn = td.state.conn.lock().unwrap();
        assert_eq!(status_of(&conn, order_id), "cancelled", "{order_id}");
    }
}

/// R1, the other half: the settlement row is still the order's payment
/// record (coverage, the label, the Z), and money the store's own till took
/// on the same order still refuses.
#[test]
fn r1_the_settlement_row_stays_the_record_and_till_money_still_refuses() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "ord-settled-plus-cash", "paid", None);
    seed_settlement_row(&conn, "ord-settled-plus-cash", "other");
    conn.execute(
        "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
             sync_status, created_at, updated_at)
         VALUES ('pay-till-cash', 'ord-settled-plus-cash', 'cash', 2.0, 200, 'completed',
                 'synced', '2026-10-01T10:01:00Z', '2026-10-01T10:01:00Z')",
        [],
    )
    .unwrap();
    assert_eq!(
        cancel_refusal_code(&conn, "ord-settled-plus-cash").unwrap(),
        Some(ORDER_HAS_PAYMENTS)
    );
    assert_eq!(
        crate::payments::load_net_paid_for_order(&conn, "ord-settled-plus-cash").unwrap(),
        14.0,
        "the settlement row counts as the order's money"
    );
}

// ---------------------------------------------------------------------------
// R6
// ---------------------------------------------------------------------------

/// R6: a folio-charged order pulled from the server (`payment_method =
/// 'room_charge'`, labelled paid, no payment row by design) was refused every
/// cancel with ORDER_PAYMENT_NOT_RECORDED, whose remedies (Sync Now, Record
/// the payment) do not apply to a folio, and it blocked the Z as
/// `missing_local_payment_row`. The pulled method is now kept
/// (`orders.folio_charged`) and the folio charge is its record.
#[test]
fn r6_a_folio_charged_order_is_never_refused_as_not_recorded() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO orders (id, order_number, supabase_id, items, total_amount, total_amount_cents,
             status, order_type, payment_status, sync_status, branch_id, created_at, updated_at)
         VALUES ('ord-folio', 'R-0101', '2f1e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b', '[]', 18.0, 1800,
                 'completed', 'room_service', 'pending', 'synced', 'branch-folio',
                 '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')",
        [],
    )
    .unwrap();
    let page_error = crate::sync::apply_remote_orders_page_for_test(
        &conn,
        vec![json!({
            "id": "2f1e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
            "status": "completed",
            "payment_status": "paid",
            "payment_method": "room_charge",
            "updated_at": "2026-10-01T10:05:00Z"
        })],
    );
    assert!(page_error.is_none(), "{page_error:?}");
    let label: String = conn
        .query_row(
            "SELECT payment_status FROM orders WHERE id = 'ord-folio'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(label, "paid", "the server's folio label is kept");

    assert_eq!(
        cancel_refusal_code(&conn, "ord-folio").unwrap(),
        None,
        "the folio charge is the order's record"
    );
    assert!(
        crate::payment_integrity::load_order_payment_blockers(&conn, "ord-folio")
            .unwrap()
            .is_empty(),
        "a folio charge never blocks the Z as a missing payment row"
    );
    assert!(
        crate::payments::server_ledger_backs_claimed_status(&conn, "ord-folio", "paid").unwrap(),
        "its paid label is never withheld from an order write"
    );

    // A later pull naming another method takes the marker away again.
    let page_error = crate::sync::apply_remote_orders_page_for_test(
        &conn,
        vec![json!({
            "id": "2f1e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
            "status": "completed",
            "payment_status": "paid",
            "payment_method": "cash",
            "updated_at": "2026-10-01T10:06:00Z"
        })],
    );
    assert!(page_error.is_none(), "{page_error:?}");
    assert_eq!(
        cancel_refusal_code(&conn, "ord-folio").unwrap(),
        Some(ORDER_PAYMENT_NOT_RECORDED)
    );
}
