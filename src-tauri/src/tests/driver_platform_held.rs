//! Assign Driver applies the payment record path's guard (item D3, fix review
//! 30/09/2026): no cash is expected from the courier for money that is not
//! there.
//!
//! Symptom: on an order whose money a delivery platform holds (prepaid online,
//! or cash the platform's own rider collected) the till refuses a cash or card
//! collection, but a completed cash row that got there anyway (before that
//! refusal, or by mistake) became cash the courier had to return when a
//! driver was assigned, and again whenever the earning was refreshed.
//!
//! Rule: the courier's cash is the order's completed cash rows and its card
//! amount the completed card rows (founder's rule: rows only, never the
//! order's total or tender); on a platform-held order both are 0. A platform
//! order the store's own driver carries as cash on delivery is the store's
//! money and counts as usual.

use rusqlite::{params, Connection};

use crate::tests::harness::TestDb;

const BRANCH: &str = "branch-platform";
const TERMINAL: &str = "terminal-platform";
const DRIVER: &str = "driver-platform";
const DRIVER_SHIFT: &str = "shift-driver-platform";
const NOW: &str = "2026-09-30T12:00:00Z";

const PREPAID: &str = r#"{"food_delivery":{"payment_method":"online","prepaid":true}}"#;
const PLATFORM_RIDER_COD: &str = r#"{"food_delivery":{"payment_method":"cash","prepaid":false,"delivery_provider":"platform_delivery"}}"#;
const OWN_DRIVER_COD: &str = r#"{"food_delivery":{"payment_method":"cash","prepaid":false,"delivery_provider":"vendor_delivery"}}"#;

fn seed_driver_shift(conn: &Connection) {
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
            check_in_time, opening_cash_amount, opening_cash_amount_cents,
            status, calculation_version, sync_status, created_at, updated_at)
         VALUES (?1, ?2, 'driver', ?3, ?4, '2026-09-30T08:30:00Z', 20.0, 2000,
                 'active', 2, 'pending', '2026-09-30T08:30:00Z', '2026-09-30T08:30:00Z')",
        params![DRIVER_SHIFT, DRIVER, BRANCH, TERMINAL],
    )
    .expect("driver shift");
}

/// A 13.00 efood delivery with the given platform disposition.
fn seed_platform_delivery(conn: &Connection, order_id: &str, disposition: &str) {
    conn.execute(
        "INSERT INTO orders (
             id, order_number, items, order_type, total_amount, total_amount_cents,
             delivery_fee, delivery_fee_cents, status, payment_status, sync_status,
             branch_id, terminal_id, plugin, external_plugin_order_id, ghost_metadata,
             created_at, updated_at
         ) VALUES (?1, ?1, '[]', 'delivery', 13.0, 1300, 2.0, 200, 'pending', 'pending',
                   'synced', ?2, ?3, 'efood', ?4, ?5,
                   '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
        params![
            order_id,
            BRANCH,
            TERMINAL,
            format!("ext-{order_id}"),
            disposition
        ],
    )
    .expect("seed platform delivery");
}

/// A completed row written straight to the ledger: the till refuses such a
/// tender on platform money today, so this is the row from before that
/// refusal, or a mistake.
fn seed_completed_row(conn: &Connection, payment_id: &str, order_id: &str, method: &str) {
    conn.execute(
        "INSERT INTO order_payments (
             id, order_id, method, amount, amount_cents, currency, status,
             sync_status, sync_state, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 13.0, 1300, 'EUR', 'completed', 'synced', 'applied',
                   '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
        params![payment_id, order_id, method],
    )
    .expect("seed completed row");
}

fn assign(conn: &Connection, order_id: &str) -> String {
    let assignment = crate::order_ownership::assign_order_to_driver_shift(
        conn,
        order_id,
        DRIVER,
        Some("Driver"),
        DRIVER_SHIFT,
        NOW,
    )
    .expect("assign the driver");
    crate::order_ownership::upsert_driver_earning(conn, order_id, DRIVER, &assignment, NOW)
        .expect("the courier earning")
}

/// (cash_collected_cents, card_amount_cents, cash_to_return_cents)
fn earning(conn: &Connection, order_id: &str) -> (i64, i64, i64) {
    conn.query_row(
        "SELECT COALESCE(cash_collected_cents, 0), COALESCE(card_amount_cents, 0),
                COALESCE(cash_to_return_cents, 0)
         FROM driver_earnings WHERE order_id = ?1",
        params![order_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .expect("the earning")
}

#[test]
fn a_courier_never_carries_money_a_platform_holds() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_driver_shift(&conn);
    seed_platform_delivery(&conn, "ord-prepaid", PREPAID);
    seed_completed_row(&conn, "pay-prepaid-cash", "ord-prepaid", "cash");
    seed_platform_delivery(&conn, "ord-rider-cod", PLATFORM_RIDER_COD);
    seed_completed_row(&conn, "pay-rider-card", "ord-rider-cod", "card");

    assign(&conn, "ord-prepaid");
    assign(&conn, "ord-rider-cod");

    assert_eq!(
        earning(&conn, "ord-prepaid"),
        (0, 0, 0),
        "prepaid online: nothing to return"
    );
    assert_eq!(
        earning(&conn, "ord-rider-cod"),
        (0, 0, 0),
        "the platform's rider collected it"
    );
}

#[test]
fn a_platform_order_the_stores_own_driver_carries_is_the_stores_money() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_driver_shift(&conn);
    seed_platform_delivery(&conn, "ord-own-driver", OWN_DRIVER_COD);
    seed_completed_row(&conn, "pay-own-driver", "ord-own-driver", "cash");

    assign(&conn, "ord-own-driver");

    assert_eq!(earning(&conn, "ord-own-driver"), (1300, 0, 1300));
}

#[test]
fn a_refreshed_earning_never_takes_on_money_a_platform_holds() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_driver_shift(&conn);
    seed_platform_delivery(&conn, "ord-prepaid-late", PREPAID);
    assign(&conn, "ord-prepaid-late");
    assert_eq!(earning(&conn, "ord-prepaid-late"), (0, 0, 0));

    // A cash row lands on the prepaid order after the assignment.
    seed_completed_row(&conn, "pay-prepaid-late", "ord-prepaid-late", "cash");
    crate::order_ownership::refresh_existing_driver_earning_payment_snapshot(
        &conn,
        "ord-prepaid-late",
        NOW,
    )
    .expect("refresh the earning");

    assert_eq!(earning(&conn, "ord-prepaid-late"), (0, 0, 0));
}
