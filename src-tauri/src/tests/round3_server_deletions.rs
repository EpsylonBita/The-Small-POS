//! Round 3 of the 01/10/2026 fix review, shared rule R7 (the same rule on
//! Android): a deletion the server announces keeps (hidden as deleted) an
//! order with payment rows or inside a closed Z, and deletes only the rest.

use rusqlite::{params, Connection};

use crate::commands::orders::{apply_server_order_deletion, ServerDeletionOutcome};
use crate::tests::harness::TestDb;

const NOW: &str = "2026-10-01T12:00:00Z";

// ---------------------------------------------------------------------------
// R7
// ---------------------------------------------------------------------------

fn seed_plain_order(conn: &Connection, id: &str, created_at: &str) {
    conn.execute(
        "INSERT INTO orders (id, order_number, supabase_id, items, total_amount, total_amount_cents,
             status, order_type, payment_status, sync_status, created_at, updated_at)
         VALUES (?1, ?1, ?2, '[]', 9.0, 900, 'completed', 'pickup', 'paid', 'synced', ?3, ?3)",
        params![id, format!("remote-{id}"), created_at],
    )
    .unwrap();
}

fn listed_order_ids(td: &TestDb) -> Vec<String> {
    crate::sync::get_all_orders_since_utc(&td.state, None)
        .expect("list the orders")
        .iter()
        .filter_map(|order| {
            order
                .get("id")
                .and_then(|id| id.as_str())
                .map(str::to_string)
        })
        .collect()
}

/// R7: an order with payment rows, or one inside a closed Z, is never deleted
/// by a server deletion: it is kept hidden as deleted (no longer in the order
/// list) and its payment rows keep counting. Before, an order inside a closed
/// Z (its rows already swept by the rollover) was deleted, and an order with
/// payment rows stayed on the order list as if nothing had happened.
#[test]
fn r7_a_server_deletion_keeps_paid_and_closed_z_orders_hidden_and_deletes_the_rest() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        crate::db::set_setting(
            &conn,
            "system",
            "last_z_report_timestamp",
            "2026-10-01T06:00:00+00:00",
        )
        .unwrap();
        // Inside the closed Z, no payment rows left (the rollover swept them).
        seed_plain_order(&conn, "ord-closed-z", "2026-09-30T20:00:00Z");
        // Open period, with a payment row.
        seed_plain_order(&conn, "ord-with-payment", "2026-10-01T09:00:00Z");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                 sync_status, created_at, updated_at)
             VALUES ('pay-kept', 'ord-with-payment', 'cash', 9.0, 900, 'completed', 'synced',
                     '2026-10-01T09:01:00Z', '2026-10-01T09:01:00Z')",
            [],
        )
        .unwrap();
        // Open period, no payment rows.
        seed_plain_order(&conn, "ord-junk", "2026-10-01T09:30:00Z");
    }
    let listed = listed_order_ids(&td);
    for order_id in ["ord-closed-z", "ord-with-payment", "ord-junk"] {
        assert!(
            listed.contains(&order_id.to_string()),
            "{order_id} listed before"
        );
    }

    {
        let conn = td.state.conn.lock().unwrap();
        for (order_id, expected) in [
            ("ord-closed-z", ServerDeletionOutcome::KeptHidden),
            ("ord-with-payment", ServerDeletionOutcome::KeptHidden),
            ("ord-junk", ServerDeletionOutcome::Deleted),
        ] {
            assert_eq!(
                apply_server_order_deletion(&conn, order_id, NOW).unwrap(),
                expected,
                "{order_id}"
            );
        }
        let kept: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM orders
                 WHERE id IN ('ord-closed-z', 'ord-with-payment')
                   AND server_deleted_at = ?1",
                params![NOW],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kept, 2, "kept, marked deleted by the server");
        let junk: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM orders WHERE id = 'ord-junk'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            junk, 0,
            "an open-period order with no payment rows is deleted"
        );
        let payment: String = conn
            .query_row(
                "SELECT status FROM order_payments WHERE id = 'pay-kept'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payment, "completed", "the payment record is never touched");
        // A second tombstone keeps the first deletion time.
        assert_eq!(
            apply_server_order_deletion(&conn, "ord-with-payment", "2026-10-02T00:00:00Z").unwrap(),
            ServerDeletionOutcome::KeptHidden
        );
        let first: String = conn
            .query_row(
                "SELECT server_deleted_at FROM orders WHERE id = 'ord-with-payment'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first, NOW);
    }

    let listed = listed_order_ids(&td);
    assert!(
        listed.is_empty(),
        "hidden as deleted, never shown to staff again: {listed:?}"
    );
    let conn = td.state.conn.lock().unwrap();
    assert_eq!(
        crate::payments::load_net_paid_for_order(&conn, "ord-with-payment").unwrap(),
        9.0,
        "its money keeps counting"
    );
}
