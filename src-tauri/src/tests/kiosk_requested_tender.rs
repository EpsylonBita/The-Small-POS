//! A kiosk order paid at the counter completes as paid with the tender the
//! customer chose on the kiosk (founder, Le Petit Paris, 09/11/2026: «όταν το
//! κατάστημα την στέλνει στις ολοκληρωμένες σημαίνει πως έχει πληρωθεί χωρίς
//! να χρειάζεται έξτρα κουμπιά»).
//!
//! Symptom before: completing a kiosk order with no payment row was refused
//! with `no_persisted_payment` and the cashier had to collect it again on the
//! payment screen, choosing the tender the customer had already chosen.
//! Android (the same rule in `shared/pos/orders/kiosk-requested-tender.ts`)
//! let it complete unpaid, and those orders then held the Z.

use rusqlite::params;

use crate::commands::orders::{apply_order_status_in_connection, LocalStatusChange};
use crate::payments::{auto_record_kiosk_requested_payment, kiosk_requested_tender};
use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const TERMINAL_ID: &str = "terminal-kiosk-main";
const BRANCH_ID: &str = "22222222-2222-4222-8222-222222222222";
const NOW: &str = "2026-11-09T11:00:00Z";

fn seed_till(conn: &rusqlite::Connection) {
    crate::db::set_setting(conn, "terminal", "__ignore_keyring", "1").unwrap();
    crate::db::set_setting(conn, "terminal", "terminal_id", TERMINAL_ID).unwrap();
    crate::db::set_setting(conn, "terminal", "branch_id", BRANCH_ID).unwrap();
    crate::db::set_setting(
        conn,
        "terminal",
        "organization_id",
        "11111111-1111-4111-8111-111111111111",
    )
    .unwrap();
    for (key, value) in [
        ("store_currency_branch_id", BRANCH_ID),
        ("store_currency_available", "true"),
        ("store_currency_source", "branch_country"),
        ("currency", "CHF"),
    ] {
        crate::db::set_setting(conn, "restaurant", key, value).unwrap();
    }
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, staff_name, branch_id, terminal_id,
            role_type, check_in_time, opening_cash_amount, opening_cash_amount_cents,
            status, sync_status, created_at, updated_at, currency)
         VALUES ('shift-kiosk', 'staff-cashier', 'Cashier', ?1, ?2, 'cashier',
                 '2026-11-09T07:00:00Z', 100.0, 10000, 'active', 'pending',
                 '2026-11-09T07:00:00Z', '2026-11-09T07:00:00Z', 'CHF')",
        params![BRANCH_ID, TERMINAL_ID],
    )
    .unwrap();
}

/// A kiosk order as the server writes it (`/api/kiosk/[branchId]/orders`):
/// platform `web`, source `webapp-customer`, the K number, unpaid, and the
/// customer's tender only in `ghost_metadata.kiosk`.
fn seed_kiosk_order(conn: &rusqlite::Connection, id: &str, metadata: &str, order_type: &str) {
    conn.execute(
        "INSERT INTO orders (id, order_number, supabase_id, items, total_amount, total_amount_cents,
            status, order_type, payment_status, sync_status, branch_id, terminal_id,
            plugin, ghost_metadata, created_at, updated_at, currency)
         VALUES (?1, 'K-ed4158cf-20261109-093916-0002', ?2, '[]', 13.0, 1300, 'confirmed', ?3,
                 'pending', 'synced', ?4, ?5, 'web', ?6,
                 '2026-11-09T10:54:02Z', '2026-11-09T10:54:02Z', 'CHF')",
        params![
            id,
            format!("remote-{id}"),
            order_type,
            BRANCH_ID,
            TERMINAL_ID,
            metadata
        ],
    )
    .unwrap();
}

fn kiosk(method: &str) -> String {
    format!(
        r#"{{"kiosk":{{"entryMode":"pickup","paymentMethod":"{method}","payment_method":"{method}"}}}}"#
    )
}

fn payments(conn: &rusqlite::Connection, id: &str) -> Vec<(String, i64, String, String)> {
    let mut statement = conn
        .prepare(
            "SELECT method, amount_cents, status, COALESCE(idempotency_key, '')
             FROM order_payments WHERE order_id = ?1",
        )
        .unwrap();
    let rows = statement
        .query_map(params![id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap();
    rows.collect::<Result<Vec<_>, _>>().unwrap()
}

fn status_and_payment_status(conn: &rusqlite::Connection, id: &str) -> (String, String) {
    conn.query_row(
        "SELECT status, payment_status FROM orders WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

#[test]
#[serial_test::serial]
fn completing_a_kiosk_order_records_the_customers_tender_and_completes_it_paid() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_till(&conn);
    for (id, method) in [("kiosk-cash", "cash"), ("kiosk-card", "card")] {
        seed_kiosk_order(&conn, id, &kiosk(method), "pickup");
        let change = apply_order_status_in_connection(&conn, id, "completed", None, None, NOW)
            .expect("the status write");
        assert!(
            matches!(change, LocalStatusChange::Applied { .. }),
            "{method}: completed with no extra step"
        );
        assert_eq!(
            payments(&conn, id),
            vec![(
                method.to_string(),
                1300,
                "completed".to_string(),
                format!("kiosk-requested-{id}")
            )],
            "{method}: one payment row, the customer's tender, the order total"
        );
        assert_eq!(
            status_and_payment_status(&conn, id),
            ("completed".to_string(), "paid".to_string())
        );
        // Once paid, nothing is recorded again.
        assert!(!auto_record_kiosk_requested_payment(&conn, id).unwrap());
        assert_eq!(payments(&conn, id).len(), 1);
    }
}

#[test]
#[serial_test::serial]
fn a_card_terminal_plugin_or_a_non_kiosk_order_keeps_the_normal_collection() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_till(&conn);

    // A connected card plugin: the terminal must charge the card.
    crate::device_admission::admit_for_test(&conn, &[crate::device_admission::CARD_TERMINAL]);
    seed_kiosk_order(&conn, "kiosk-card-terminal", &kiosk("card"), "pickup");
    // An ordinary unpaid counter order.
    seed_kiosk_order(&conn, "counter-order", "{}", "pickup");
    for id in ["kiosk-card-terminal", "counter-order"] {
        let change = apply_order_status_in_connection(&conn, id, "completed", None, None, NOW)
            .expect("the status write");
        assert!(
            matches!(change, LocalStatusChange::Blocked(_)),
            "{id}: refused until collected"
        );
        assert!(payments(&conn, id).is_empty(), "{id}: nothing recorded");
        assert_eq!(status_and_payment_status(&conn, id).0, "confirmed");
    }

    // Cash still records: the plugin decides only for card.
    seed_kiosk_order(&conn, "kiosk-cash-with-terminal", &kiosk("cash"), "pickup");
    assert!(matches!(
        apply_order_status_in_connection(
            &conn,
            "kiosk-cash-with-terminal",
            "completed",
            None,
            None,
            NOW
        )
        .unwrap(),
        LocalStatusChange::Applied { .. }
    ));
    assert_eq!(payments(&conn, "kiosk-cash-with-terminal").len(), 1);
}

/// PR #432 review: a kiosk order already labelled paid (or partly paid)
/// whose local payment rows are missing is a missing-payment case. Completing
/// it must not record the total again as new money in today's drawer; it
/// keeps its blocker for the restore or the manager's record.
#[test]
#[serial_test::serial]
fn a_paid_or_partly_paid_kiosk_order_without_local_rows_is_never_collected_again() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_till(&conn);
    for (id, label) in [
        ("kiosk-paid-label", "paid"),
        ("kiosk-partly-paid-label", "partially_paid"),
    ] {
        seed_kiosk_order(&conn, id, &kiosk("cash"), "pickup");
        conn.execute(
            "UPDATE orders SET payment_status = ?1 WHERE id = ?2",
            params![label, id],
        )
        .unwrap();
        assert!(
            !auto_record_kiosk_requested_payment(&conn, id).unwrap(),
            "{label}: nothing recorded"
        );
        let change = apply_order_status_in_connection(&conn, id, "completed", None, None, NOW)
            .expect("the status write");
        assert!(
            matches!(change, LocalStatusChange::Blocked(_)),
            "{label}: the missing payment still blocks the completion"
        );
        assert!(
            payments(&conn, id).is_empty(),
            "{label}: no new payment row"
        );
        assert_eq!(status_and_payment_status(&conn, id).0, "confirmed");
    }
}

#[test]
fn only_a_counter_kiosk_order_with_cash_or_card_names_a_tender() {
    let pickup = |method: &str| kiosk(method);
    assert_eq!(
        kiosk_requested_tender(Some(&pickup("cash")), "pickup", None),
        Some("cash")
    );
    assert_eq!(
        kiosk_requested_tender(Some(&pickup("CARD")), "takeaway", None),
        Some("card")
    );
    assert_eq!(
        kiosk_requested_tender(
            Some(r#"{"kiosk":{"entryMode":"device","payment_method":"card"}}"#),
            "pickup",
            None
        ),
        Some("card")
    );
    // Not the store's counter money, or not a tender the till records itself.
    for method in ["room_charge", "twint", "online", ""] {
        assert_eq!(
            kiosk_requested_tender(Some(&pickup(method)), "pickup", None),
            None
        );
    }
    for entry in ["table", "room", "delivery"] {
        let metadata = format!(r#"{{"kiosk":{{"entryMode":"{entry}","paymentMethod":"cash"}}}}"#);
        assert_eq!(
            kiosk_requested_tender(Some(&metadata), "pickup", None),
            None,
            "{entry}"
        );
    }
    assert_eq!(
        kiosk_requested_tender(Some(&pickup("cash")), "delivery", None),
        None
    );
    assert_eq!(
        kiosk_requested_tender(Some(&pickup("cash")), "dine-in", Some("session-1")),
        None,
        "a table check is settled through its table"
    );
    assert_eq!(kiosk_requested_tender(None, "pickup", None), None);
    assert_eq!(kiosk_requested_tender(Some("{}"), "pickup", None), None);
    assert_eq!(
        kiosk_requested_tender(Some("not json"), "pickup", None),
        None
    );
}
