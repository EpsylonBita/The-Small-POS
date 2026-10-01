//! A courier's cash, earnings and settlement come only from payment rows
//! (founder's rule, 30/09/2026; item C of the Android 1.0.13 / desktop 1.4.120
//! fix review).
//!
//! Symptom: a delivery order with no payment row was charged to its courier
//! as the whole order total in cash, at assignment and in the shift summary's
//! backfill, and its tip was handed to the courier out of the drawer. A
//! charge later set aside as a duplicate, given back, or voided stayed cash
//! the courier owed at checkout, in the shift close and in the Z.
//!
//! Root cause: `order_ownership::get_order_payment_totals` and the summary
//! backfill fell back to `orders.total_amount` as cash when an order had no
//! payment row, the close counted a tip as cash from the earning's own label,
//! and nothing took money back out of the earning snapshot when it left the
//! order.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const BRANCH: &str = "branch-courier";
const TERMINAL: &str = "terminal-courier";
const DRIVER: &str = "driver-courier";
const DRIVER_SHIFT: &str = "shift-courier";
const CASHIER_SHIFT: &str = "shift-cashier";
const OPENING: f64 = 20.0;
const NOW: &str = "2026-09-30T12:00:00Z";

fn seed_shifts(conn: &Connection) {
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
            check_in_time, opening_cash_amount, opening_cash_amount_cents,
            status, calculation_version, sync_status, created_at, updated_at)
         VALUES (?1, 'cashier-courier', 'cashier', ?2, ?3, '2026-09-30T08:00:00Z',
            100.0, 10000, 'active', 2, 'pending', '2026-09-30T08:00:00Z', '2026-09-30T08:00:00Z')",
        params![CASHIER_SHIFT, BRANCH, TERMINAL],
    )
    .expect("cashier shift");
    conn.execute(
        "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id,
            terminal_id, opening_amount, opening_amount_cents,
            driver_cash_given, driver_cash_given_cents,
            opened_at, created_at, updated_at)
         VALUES ('drawer-courier', ?1, 'cashier-courier', ?2, ?3, 100.0, 10000,
            ?4, ?5, '2026-09-30T08:00:00Z', '2026-09-30T08:00:00Z', '2026-09-30T08:00:00Z')",
        params![
            CASHIER_SHIFT,
            BRANCH,
            TERMINAL,
            OPENING,
            (OPENING * 100.0) as i64
        ],
    )
    .expect("cashier drawer");
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
            check_in_time, opening_cash_amount, opening_cash_amount_cents,
            status, calculation_version, sync_status, created_at, updated_at)
         VALUES (?1, ?2, 'driver', ?3, ?4, '2026-09-30T08:30:00Z',
            ?5, ?6, 'active', 2, 'pending', '2026-09-30T08:30:00Z', '2026-09-30T08:30:00Z')",
        params![
            DRIVER_SHIFT,
            DRIVER,
            BRANCH,
            TERMINAL,
            OPENING,
            (OPENING * 100.0) as i64
        ],
    )
    .expect("driver shift");
}

/// A 13.00 delivery with a 1.00 tip, not paid yet.
fn seed_delivery(conn: &Connection, order_id: &str) {
    conn.execute(
        "INSERT INTO orders (
             id, order_number, items, order_type, total_amount, total_amount_cents,
             tip_amount, tip_amount_cents, delivery_fee, delivery_fee_cents,
             status, payment_status, sync_status, branch_id, terminal_id,
             created_at, updated_at
         ) VALUES (?1, ?1, '[]', 'delivery', 13.0, 1300, 1.0, 100, 2.0, 200,
                   'pending', 'pending', 'synced', ?2, ?3,
                   '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
        params![order_id, BRANCH, TERMINAL],
    )
    .expect("seed delivery");
}

fn add_payment(
    conn: &Connection,
    payment_id: &str,
    order_id: &str,
    method: &str,
    cents: i64,
    shift_id: &str,
) {
    conn.execute(
        "INSERT INTO order_payments (
             id, order_id, method, amount, amount_cents, currency, status,
             staff_shift_id, sync_status, sync_state, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'EUR', 'completed', ?6, 'pending', 'syncing',
                   '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
        params![
            payment_id,
            order_id,
            method,
            cents as f64 / 100.0,
            cents,
            shift_id
        ],
    )
    .expect("seed payment");
    conn.execute(
        "UPDATE orders SET payment_status = 'paid' WHERE id = ?1",
        params![order_id],
    )
    .unwrap();
}

fn assign(conn: &Connection, order_id: &str) {
    let assignment = crate::order_ownership::assign_order_to_driver_shift(
        conn,
        order_id,
        DRIVER,
        Some("Courier"),
        DRIVER_SHIFT,
        NOW,
    )
    .expect("assign the courier");
    crate::order_ownership::upsert_driver_earning(conn, order_id, DRIVER, &assignment, NOW)
        .expect("write the earning");
}

/// (cash collected, card, cash to return), in cents.
fn earning(conn: &Connection, order_id: &str) -> (i64, i64, i64) {
    conn.query_row(
        "SELECT COALESCE(cash_collected_cents, CAST(ROUND(cash_collected * 100) AS INTEGER), 0),
                COALESCE(card_amount_cents, CAST(ROUND(card_amount * 100) AS INTEGER), 0),
                COALESCE(cash_to_return_cents, CAST(ROUND(cash_to_return * 100) AS INTEGER), 0)
         FROM driver_earnings WHERE order_id = ?1",
        params![order_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .expect("the order has a courier earning")
}

fn amount_to_return(td: &TestDb) -> f64 {
    let summary = crate::shifts::get_shift_summary(&td.state, DRIVER_SHIFT).expect("summary");
    summary["amountToReturn"]
        .as_f64()
        .expect("a courier return")
}

fn close_expected(td: &TestDb) -> Value {
    let closed = crate::shifts::close_shift(
        &td.state,
        &json!({ "shiftId": DRIVER_SHIFT, "closingCash": OPENING }),
    )
    .expect("close the courier shift");
    closed["expected"].clone()
}

/// No payment row: the courier owes nothing for the order and keeps no tip
/// out of the drawer. It used to be the whole 13.00 in cash, less the tip.
#[test]
fn an_order_with_no_payment_row_charges_its_courier_nothing() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_shifts(&conn);
        seed_delivery(&conn, "ord-unpaid");
        assign(&conn, "ord-unpaid");
        assert_eq!(earning(&conn, "ord-unpaid"), (0, 0, 0));
    }
    assert_eq!(amount_to_return(&td), OPENING);
    assert_eq!(close_expected(&td), json!(OPENING));
}

/// The shift summary backfills an earning for a delivery the courier carries
/// that has none; it used to take the order total as cash.
#[test]
fn the_summary_backfill_charges_its_courier_nothing_without_a_payment_row() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_shifts(&conn);
        seed_delivery(&conn, "ord-backfill");
        conn.execute(
            "UPDATE orders SET driver_id = ?1, staff_shift_id = ?2, status = 'delivered'
             WHERE id = 'ord-backfill'",
            params![DRIVER, DRIVER_SHIFT],
        )
        .unwrap();
    }
    assert_eq!(amount_to_return(&td), OPENING);
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(earning(&conn, "ord-backfill"), (0, 0, 0));
}

/// The courier's cash payment is set aside as a possible duplicate after the
/// assignment (the server said the order was already paid by other money):
/// the courier is no longer charged for it, and the same holds once the
/// manager records it as given back to the customer.
#[test]
fn a_payment_set_aside_or_given_back_leaves_the_couriers_cash() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_shifts(&conn);
        seed_delivery(&conn, "ord-dup");
        add_payment(&conn, "pay-dup", "ord-dup", "cash", 1300, CASHIER_SHIFT);
        assign(&conn, "ord-dup");
        assert_eq!(earning(&conn, "ord-dup"), (1300, 0, 1300));

        let outcome = crate::payment_review::set_aside_already_paid_payment(
            &conn,
            "pay-dup",
            Some("srv-other-payment"),
            "2026-09-30T12:05:00Z",
        )
        .expect("set aside");
        assert!(matches!(
            outcome,
            crate::payment_review::SetAsideOutcome::SetAside { .. }
        ));
        assert_eq!(earning(&conn, "ord-dup"), (0, 0, 0), "set aside");
        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue
                 WHERE table_name = 'driver_earnings' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(queued >= 1, "the corrected earning is sent to the server");

        crate::payment_review::resolve_set_aside_payment_in_connection(
            &conn,
            "pay-dup",
            Some("manager-courier"),
            "2026-09-30T12:10:00Z",
        )
        .expect("given back to the customer");
        assert_eq!(earning(&conn, "ord-dup"), (0, 0, 0), "given back");
    }
    assert_eq!(amount_to_return(&td), OPENING);
    assert_eq!(close_expected(&td), json!(OPENING));
}

/// A card charged but not saved on this till, given back to the customer by
/// the manager: no payment row ever existed, so the courier carries nothing.
#[test]
fn a_charge_not_saved_and_given_back_is_never_the_couriers_cash() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_shifts(&conn);
    seed_delivery(&conn, "ord-unsaved");
    let entry = crate::unsaved_payments::UnsavedChargedPayment::for_payment(
        "ord-unsaved",
        &json!({
            "orderId": "ord-unsaved",
            "method": "card",
            "amount": 13.0,
            "transactionRef": "txn-courier-1",
            "terminalApproved": true,
        }),
        None,
        "2026-09-30T11:00:00Z",
    )
    .expect("a charged card");
    crate::unsaved_payments::record(&conn, &entry).unwrap();
    let outcome = crate::unsaved_payments::resolve_in_connection(
        &conn,
        &entry.idempotency_key,
        Some("manager-courier"),
        "2026-09-30T11:30:00Z",
    )
    .expect("given back");
    assert_eq!(outcome.as_str(), "resolved");

    assign(&conn, "ord-unsaved");
    assert_eq!(earning(&conn, "ord-unsaved"), (0, 0, 0));
}

/// A voided courier payment leaves the courier's cash; a payment booked to
/// another shift (the cashier's, after the assignment) was never the
/// courier's, so voiding it changes nothing there.
#[test]
fn a_voided_courier_payment_leaves_the_couriers_cash() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_shifts(&conn);
        seed_delivery(&conn, "ord-void");
        add_payment(&conn, "pay-courier", "ord-void", "cash", 800, CASHIER_SHIFT);
        assign(&conn, "ord-void");
        assert_eq!(earning(&conn, "ord-void"), (800, 0, 800));
        add_payment(&conn, "pay-counter", "ord-void", "cash", 500, CASHIER_SHIFT);
    }

    crate::refunds::void_payment_with_adjustment(
        &td.state,
        "pay-counter",
        "rang up twice",
        None,
        None,
    )
    .expect("void the counter payment");
    {
        let conn = td.state.conn.lock().unwrap();
        assert_eq!(
            earning(&conn, "ord-void"),
            (800, 0, 800),
            "not the courier's"
        );
    }

    crate::refunds::void_payment_with_adjustment(
        &td.state,
        "pay-courier",
        "customer refused the order",
        None,
        None,
    )
    .expect("void the courier payment");
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(earning(&conn, "ord-void"), (0, 0, 0));
}

/// The diagnostic that attaches driverless deliveries to a courier used to
/// write the order total under the derived tender: a 5.00 cash part-payment
/// charged the courier 13.00.
#[test]
fn the_driver_id_repair_takes_the_couriers_money_from_payment_rows() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_shifts(&conn);
    for order_id in ["ord-part", "ord-none"] {
        seed_delivery(&conn, order_id);
        conn.execute(
            "UPDATE orders SET status = 'delivered' WHERE id = ?1",
            params![order_id],
        )
        .unwrap();
    }
    add_payment(&conn, "pay-part", "ord-part", "cash", 500, CASHIER_SHIFT);

    let fixed = crate::commands::diagnostics::fix_missing_driver_ids_in_connection(&conn, DRIVER)
        .expect("repair");
    assert_eq!(fixed["earningsCreated"], 2, "{fixed}");
    assert_eq!(earning(&conn, "ord-part"), (500, 0, 500));
    assert_eq!(earning(&conn, "ord-none"), (0, 0, 0));
}

// ---------------------------------------------------------------------------
// Item D9 (round 2, 01/10/2026): only a refund the courier handed back lowers
// the courier's cash. Android's `readCourierOrderTenders` (c1ab6dfd8) lowers
// the courier for every refund except a drawer-paid cash one; desktop lowers
// it only for a cash refund with `cash_handler = 'driver_shift'`, because the
// drawer counts every other cash refund (`shifts`, NULL handler included).
//
// Symptom: a refund the CASHIER paid from the drawer is counted in the
// drawer (`cash_drawer_sessions.total_refunds`), and the courier still holds
// the cash collected. A full refund made the row `refunded`, and every
// recount of the courier's money (reassignment, a payment-method edit, the
// summary backfill) dropped the row: the courier owed nothing for cash still
// in the courier's pocket. A partial refund the courier handed back was
// counted back on the next recount.

fn refund(td: &TestDb, payment_id: &str, cents: i64, handler: &str, shift_id: &str) {
    crate::refunds::refund_payment(
        &td.state,
        &json!({
            "paymentId": payment_id,
            "amount": cents as f64 / 100.0,
            "reason": "Synthetic refund",
            "refundMethod": "cash",
            "cashHandler": handler,
            "staffShiftId": shift_id,
        }),
    )
    .expect("record the refund");
}

fn recount(conn: &Connection, order_id: &str) {
    crate::order_ownership::refresh_existing_driver_earning_payment_snapshot(conn, order_id, NOW)
        .expect("recount the courier's money")
        .expect("the order has an editable earning");
}

/// A refund the drawer paid while the courier still held the cash: no NEW
/// refund is written so any more (shared rule R2, round 3 review: the rule,
/// never a caller, names the handler), but a record an earlier build wrote
/// with the cashier's picker keeps its reading: the drawer's, never the
/// courier's too.
#[test]
fn a_refund_the_cashier_paid_from_the_drawer_leaves_the_couriers_cash() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_shifts(&conn);
    seed_delivery(&conn, "ord-cashier-refund");
    add_payment(
        &conn,
        "pay-courier-cash",
        "ord-cashier-refund",
        "cash",
        1300,
        DRIVER_SHIFT,
    );
    assign(&conn, "ord-cashier-refund");
    assert_eq!(earning(&conn, "ord-cashier-refund"), (1300, 0, 1300));
    conn.execute(
        "INSERT INTO payment_adjustments (
             id, payment_id, order_id, adjustment_type, amount, amount_cents, reason,
             staff_shift_id, refund_method, cash_handler, sync_state, created_at, updated_at
         ) VALUES ('refund-picked-drawer', 'pay-courier-cash', 'ord-cashier-refund', 'refund',
                   13.0, 1300, 'Synthetic refund', ?1, 'cash', 'cashier_drawer', 'pending',
                   '2026-09-30T11:00:00Z', '2026-09-30T11:00:00Z')",
        params![CASHIER_SHIFT],
    )
    .unwrap();
    conn.execute(
        "UPDATE order_payments SET status = 'refunded' WHERE id = 'pay-courier-cash'",
        [],
    )
    .unwrap();
    recount(&conn, "ord-cashier-refund");
    assert_eq!(
        earning(&conn, "ord-cashier-refund"),
        (1300, 0, 1300),
        "a recount never takes a drawer-paid refund off the courier"
    );
}

#[test]
fn a_refund_the_courier_handed_back_stays_off_the_couriers_cash() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_shifts(&conn);
        seed_delivery(&conn, "ord-courier-refund");
        add_payment(
            &conn,
            "pay-courier-cash-2",
            "ord-courier-refund",
            "cash",
            1300,
            DRIVER_SHIFT,
        );
        assign(&conn, "ord-courier-refund");
    }

    refund(&td, "pay-courier-cash-2", 300, "driver_shift", DRIVER_SHIFT);
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(earning(&conn, "ord-courier-refund"), (1000, 0, 1000));
    recount(&conn, "ord-courier-refund");
    assert_eq!(
        earning(&conn, "ord-courier-refund"),
        (1000, 0, 1000),
        "the 3.00 the courier handed back is never counted back"
    );
}

/// A refund row as an older till (or another app) left it: no handler, and
/// possibly no refund method. Never written by `refunds::refund_payment`.
fn legacy_refund(
    conn: &Connection,
    id: &str,
    payment_id: &str,
    order_id: &str,
    cents: i64,
    refund_method: Option<&str>,
) {
    conn.execute(
        "INSERT INTO payment_adjustments (
             id, payment_id, order_id, adjustment_type, amount, amount_cents, reason,
             staff_shift_id, refund_method, cash_handler, sync_state, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'refund', ?4, ?5, 'Synthetic legacy refund', ?6, ?7, NULL,
                   'pending', '2026-09-30T11:00:00Z', '2026-09-30T11:00:00Z')",
        params![
            id,
            payment_id,
            order_id,
            cents as f64 / 100.0,
            cents,
            CASHIER_SHIFT,
            refund_method
        ],
    )
    .expect("seed a legacy refund");
}

/// Shared rule R2 (round 3, 01/10/2026; it replaces the round 2 reading): a
/// cash refund that does not say who handed it back (recorded before the
/// field existed, or mirrored without one) is the courier's when the order
/// carries a courier earning, and the drawer's otherwise, once, never both.
/// Round 2 made it the drawer's always, so a courier still owed the full 13.00
/// for 3.00 they had handed back.
#[test]
fn a_refund_that_names_no_handler_on_a_couriers_order_is_the_couriers_only() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_shifts(&conn);
        for (order_id, payment_id, refund_id, refund_method) in [
            (
                "ord-legacy-cash",
                "pay-legacy-cash",
                "refund-legacy-cash",
                Some("cash"),
            ),
            (
                "ord-legacy-blank",
                "pay-legacy-blank",
                "refund-legacy-blank",
                None,
            ),
        ] {
            seed_delivery(&conn, order_id);
            add_payment(&conn, payment_id, order_id, "cash", 1300, DRIVER_SHIFT);
            assign(&conn, order_id);
            legacy_refund(&conn, refund_id, payment_id, order_id, 300, refund_method);
            recount(&conn, order_id);
            assert_eq!(
                earning(&conn, order_id),
                (1000, 0, 1000),
                "{order_id}: the courier handed the 3.00 back"
            );
            // The drawer never counts it too, even where the order and its
            // payment are attributed to the cashier's shift.
            conn.execute(
                "UPDATE order_payments SET staff_shift_id = ?1 WHERE order_id = ?2",
                params![CASHIER_SHIFT, order_id],
            )
            .unwrap();
            conn.execute(
                "UPDATE orders SET staff_shift_id = ?1 WHERE id = ?2",
                params![CASHIER_SHIFT, order_id],
            )
            .unwrap();
        }
    }
    let summary = crate::shifts::get_shift_summary(&td.state, CASHIER_SHIFT).expect("summary");
    assert_eq!(summary["cashRefunds"].as_f64(), Some(0.0), "{summary}");
}

/// Shared rule R2: on an order no courier carries, a legacy refund that names
/// no handler is the drawer's.
#[test]
fn a_refund_that_names_no_handler_on_a_counter_order_is_the_drawers() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_shifts(&conn);
        seed_delivery(&conn, "ord-counter-legacy");
        conn.execute(
            "UPDATE orders SET order_type = 'pickup' WHERE id = 'ord-counter-legacy'",
            [],
        )
        .unwrap();
        add_payment(
            &conn,
            "pay-counter-legacy",
            "ord-counter-legacy",
            "cash",
            1300,
            CASHIER_SHIFT,
        );
        legacy_refund(
            &conn,
            "refund-counter-legacy",
            "pay-counter-legacy",
            "ord-counter-legacy",
            300,
            None,
        );
    }
    let summary = crate::shifts::get_shift_summary(&td.state, CASHIER_SHIFT).expect("summary");
    assert_eq!(summary["cashRefunds"].as_f64(), Some(3.0), "{summary}");
}

/// Shared rule R2: every NEW cash refund records who handed the money back.
/// With nobody named, it is the courier while their earning on the order is
/// still unsettled (they still hold the cash), else the drawer. Desktop wrote
/// `cashier_drawer` always, so the courier kept owing money they had handed
/// back, and Android and desktop disagreed on the same refund.
#[test]
fn a_new_cash_refund_naming_nobody_follows_who_still_holds_the_cash() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_shifts(&conn);
        for (order_id, payment_id) in [
            ("ord-courier-holds", "pay-courier-holds"),
            ("ord-courier-settled", "pay-courier-settled"),
        ] {
            seed_delivery(&conn, order_id);
            add_payment(&conn, payment_id, order_id, "cash", 1300, DRIVER_SHIFT);
            assign(&conn, order_id);
        }
        conn.execute(
            "UPDATE driver_earnings SET settled = 1 WHERE order_id = 'ord-courier-settled'",
            [],
        )
        .unwrap();
    }
    for payment_id in ["pay-courier-holds", "pay-courier-settled"] {
        crate::refunds::refund_payment(
            &td.state,
            &json!({
                "paymentId": payment_id,
                "amount": 3.0,
                "reason": "Synthetic refund",
                "refundMethod": "cash",
                "staffShiftId": CASHIER_SHIFT,
            }),
        )
        .unwrap_or_else(|error| panic!("{payment_id}: {error}"));
    }
    let conn = td.state.conn.lock().unwrap();
    let handler = |payment_id: &str| -> Option<String> {
        conn.query_row(
            "SELECT cash_handler FROM payment_adjustments WHERE payment_id = ?1",
            params![payment_id],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(
        handler("pay-courier-holds").as_deref(),
        Some("driver_shift")
    );
    assert_eq!(
        earning(&conn, "ord-courier-holds"),
        (1000, 0, 1000),
        "the courier handed it back from the cash they hold"
    );
    assert_eq!(
        handler("pay-courier-settled").as_deref(),
        Some("cashier_drawer"),
        "the courier settled: the drawer paid it"
    );
    drop(conn);
    let rule =
        crate::refunds::get_payment_balance(&td.state, "pay-courier-holds").expect("balance");
    assert_eq!(rule["cashHandlerByRule"], json!("driver_shift"));
    assert_eq!(rule["defaultRefundMethod"], json!("cash"));
}

/// A card refund of a cash payment goes back on a card: the courier still
/// holds the cash collected and hands it over.
#[test]
fn a_card_refund_of_a_cash_payment_leaves_the_couriers_cash() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_shifts(&conn);
    seed_delivery(&conn, "ord-card-back");
    add_payment(
        &conn,
        "pay-card-back",
        "ord-card-back",
        "cash",
        1300,
        DRIVER_SHIFT,
    );
    assign(&conn, "ord-card-back");
    legacy_refund(
        &conn,
        "refund-card-back",
        "pay-card-back",
        "ord-card-back",
        500,
        Some("card"),
    );
    recount(&conn, "ord-card-back");
    assert_eq!(earning(&conn, "ord-card-back"), (1300, 0, 1300));
}

// ---------------------------------------------------------------------------
// Round 3 review (01/10/2026), shared rule R2, the same reading as Android's
// `readCourierOrderTenders`: courier cash = cash rows minus every cash refund
// the courier handed back, whatever tender the refund is booked against; the
// rule, never the caller, names who handed it back.
// ---------------------------------------------------------------------------

/// The reviewers' probe: 7.00 cash + 6.00 card, then 5.00 handed back in cash
/// for the CARD payment while the courier's earning is unsettled. The refund
/// is the courier's (`driver_shift`) and lowered the earning to 2.00 at the
/// write, but every recount put the 7.00 back (only refunds of CASH rows
/// lowered the courier), and the drawer skips a `driver_shift` refund: the
/// 5.00 the courier handed back was counted nowhere and the courier looked
/// 5.00 short (amount to return 26.00 instead of 21.00).
#[test]
fn cash_the_courier_hands_back_for_a_card_payment_comes_off_the_couriers_cash() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_shifts(&conn);
        seed_delivery(&conn, "ord-mixed-back");
        add_payment(
            &conn,
            "pay-mixed-cash",
            "ord-mixed-back",
            "cash",
            700,
            DRIVER_SHIFT,
        );
        add_payment(
            &conn,
            "pay-mixed-card",
            "ord-mixed-back",
            "card",
            600,
            DRIVER_SHIFT,
        );
        assign(&conn, "ord-mixed-back");
        assert_eq!(earning(&conn, "ord-mixed-back"), (700, 600, 700));
    }
    crate::refunds::refund_payment(
        &td.state,
        &json!({
            "paymentId": "pay-mixed-card",
            "amount": 5.0,
            "reason": "Synthetic refund",
            "refundMethod": "cash",
            "staffShiftId": CASHIER_SHIFT,
        }),
    )
    .expect("refund the card payment in cash");
    {
        let conn = td.state.conn.lock().unwrap();
        let handler: Option<String> = conn
            .query_row(
                "SELECT cash_handler FROM payment_adjustments WHERE payment_id = 'pay-mixed-card'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(handler.as_deref(), Some("driver_shift"));
        assert_eq!(
            earning(&conn, "ord-mixed-back"),
            (200, 600, 200),
            "at the write"
        );
        recount(&conn, "ord-mixed-back");
        assert_eq!(
            earning(&conn, "ord-mixed-back"),
            (200, 600, 200),
            "a recount never puts the handed-back cash back on the courier"
        );
    }
    let cashier = crate::shifts::get_shift_summary(&td.state, CASHIER_SHIFT).expect("summary");
    assert_eq!(
        cashier["cashRefunds"].as_f64(),
        Some(0.0),
        "never the drawer's too"
    );
    // 20.00 float + 2.00 cash still held - the 1.00 tip paid out of it.
    assert_eq!(amount_to_return(&td), 21.0);
}

/// A non-cash refund of a card row lowers the courier's card money, as on
/// Android (every non-cash refund of a non-cash row), at the write and in
/// every recount; a card refund of a cash row leaves both alone.
#[test]
fn a_card_refund_of_a_card_payment_lowers_the_couriers_card_money_once() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_shifts(&conn);
        seed_delivery(&conn, "ord-mixed-card");
        add_payment(
            &conn,
            "pay-mc-cash",
            "ord-mixed-card",
            "cash",
            700,
            DRIVER_SHIFT,
        );
        add_payment(
            &conn,
            "pay-mc-card",
            "ord-mixed-card",
            "card",
            600,
            DRIVER_SHIFT,
        );
        assign(&conn, "ord-mixed-card");
    }
    for (payment_id, cents) in [("pay-mc-card", 200), ("pay-mc-cash", 100)] {
        crate::refunds::refund_payment(
            &td.state,
            &json!({
                "paymentId": payment_id,
                "amount": cents as f64 / 100.0,
                "reason": "Synthetic refund",
                "refundMethod": "card",
                "staffShiftId": CASHIER_SHIFT,
            }),
        )
        .unwrap_or_else(|error| panic!("{payment_id}: {error}"));
    }
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(
        earning(&conn, "ord-mixed-card"),
        (700, 400, 700),
        "the card refund of the cash row moved no courier money (it used to lower the card)"
    );
    recount(&conn, "ord-mixed-card");
    assert_eq!(earning(&conn, "ord-mixed-card"), (700, 400, 700));
}

/// R2: the refund screen's picker let a cashier book a cash refund on the
/// drawer while the courier still held the order's cash, and the caller's
/// choice overrode the rule (Android, with no picker, records the rule's
/// answer). Booking a refund on a courier whose earning was settled failed
/// outright. The rule now decides, whatever the caller sends.
#[test]
fn the_rule_not_the_caller_names_who_handed_a_cash_refund_back() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL), ("branch_id", BRANCH)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_shifts(&conn);
        for (order_id, payment_id) in [
            ("ord-rule-holds", "pay-rule-holds"),
            ("ord-rule-settled", "pay-rule-settled"),
        ] {
            seed_delivery(&conn, order_id);
            add_payment(&conn, payment_id, order_id, "cash", 1300, DRIVER_SHIFT);
            assign(&conn, order_id);
        }
        conn.execute(
            "UPDATE driver_earnings SET settled = 1 WHERE order_id = 'ord-rule-settled'",
            [],
        )
        .unwrap();
    }
    refund(&td, "pay-rule-holds", 300, "cashier_drawer", CASHIER_SHIFT);
    refund(&td, "pay-rule-settled", 300, "driver_shift", CASHIER_SHIFT);
    let conn = td.state.conn.lock().unwrap();
    let handler = |payment_id: &str| -> Option<String> {
        conn.query_row(
            "SELECT cash_handler FROM payment_adjustments WHERE payment_id = ?1",
            params![payment_id],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(handler("pay-rule-holds").as_deref(), Some("driver_shift"));
    assert_eq!(earning(&conn, "ord-rule-holds"), (1000, 0, 1000));
    assert_eq!(
        handler("pay-rule-settled").as_deref(),
        Some("cashier_drawer")
    );
    let drawer_refunds: i64 = conn
        .query_row(
            "SELECT COALESCE(total_refunds_cents, 0) FROM cash_drawer_sessions WHERE id = 'drawer-courier'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        drawer_refunds, 300,
        "only the settled order's refund left the drawer"
    );
}
