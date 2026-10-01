//! Ready on a platform order the till is behind on (item D8 of the
//! 01/10/2026 fix review; efood late Ready).
//!
//! Symptom: a stale card pressed Ready on an order that was already
//! delivered (or cancelled by efood) and the till answered «Invalid status
//! transition: delivered -> ready»: the cashier saw "Failed to notify the
//! platform", a false failure. On an order efood had cancelled, Ready could
//! run the platform auto-settlement and record a settlement row on a
//! cancelled order, against the founder's payment rule.
//!
//! Now Ready checks first: an order already past Ready answers "already
//! closed" and writes, queues and sends nothing; a cancelled or refunded one
//! answers "cancelled" (the renderer shows the cancellation notice) and also
//! writes, queues, settles and sends nothing.

use rusqlite::params;

use crate::commands::orders::{notify_platform_ready_locally, PlatformReadyLocal};
use crate::tests::harness::TestDb;

const NOW: &str = "2026-10-01T09:00:00Z";
const PREPAID_FLEET: &str = r#"{"food_delivery":{"prepaid":true,"payment_method":"online","delivery_provider":"platform_delivery"}}"#;

fn seed_platform_order(conn: &rusqlite::Connection, id: &str, status: &str) {
    conn.execute(
        "INSERT INTO orders (id, order_number, supabase_id, items, total_amount, total_amount_cents,
            status, order_type, payment_status, sync_status, plugin, external_plugin_order_id,
            ghost_metadata, created_at, updated_at)
         VALUES (?1, ?1, ?2, '[]', 12.0, 1200, ?3, 'delivery', 'pending', 'synced', 'efood',
                 ?4, ?5, '2026-10-01T08:00:00Z', '2026-10-01T08:00:00Z')",
        params![
            id,
            format!("remote-{id}"),
            status,
            format!("efood-{id}"),
            PREPAID_FLEET
        ],
    )
    .expect("seed a platform order");
}

fn counts(td: &TestDb, id: &str) -> (String, i64, i64) {
    let conn = td.state.conn.lock().unwrap();
    let status: String = conn
        .query_row(
            "SELECT status FROM orders WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap();
    let payments: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_payments WHERE order_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap();
    let queued: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE record_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    (status, payments, queued)
}

#[test]
fn ready_on_an_order_already_past_ready_writes_nothing() {
    let td = TestDb::open();
    for status in ["delivered", "completed", "out_for_delivery"] {
        let id = format!("ord-closed-{status}");
        seed_platform_order(&td.state.conn.lock().unwrap(), &id, status);
        let before = counts(&td, &id);
        assert_eq!(
            notify_platform_ready_locally(&td.state, &id, NOW).expect("never an error"),
            PlatformReadyLocal::AlreadyClosed {
                status: status.to_string()
            }
        );
        assert_eq!(counts(&td, &id), before, "{status}: no write, no queue row");
    }
}

#[test]
fn ready_on_a_cancelled_order_writes_settles_and_queues_nothing() {
    let td = TestDb::open();
    for status in ["cancelled", "refunded"] {
        let id = format!("ord-gone-{status}");
        seed_platform_order(&td.state.conn.lock().unwrap(), &id, status);
        assert_eq!(
            notify_platform_ready_locally(&td.state, &id, NOW).expect("never an error"),
            PlatformReadyLocal::Cancelled {
                status: status.to_string()
            }
        );
        assert_eq!(
            counts(&td, &id),
            (status.to_string(), 0, 0),
            "{status}: no settlement row on a cancelled order, nothing queued"
        );
    }
}

#[test]
fn the_platform_auto_settlement_never_runs_on_a_cancelled_order() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_platform_order(&conn, "ord-settle-cancelled", "cancelled");
    assert!(!crate::payments::auto_settle_platform_order(&conn, "ord-settle-cancelled").unwrap());
    seed_platform_order(&conn, "ord-settle-open", "ready");
    assert!(
        crate::payments::auto_settle_platform_order(&conn, "ord-settle-open").unwrap(),
        "an open prepaid order still settles from its disposition"
    );
}

#[test]
fn ready_on_an_open_platform_fleet_order_still_completes_it() {
    let td = TestDb::open();
    seed_platform_order(
        &td.state.conn.lock().unwrap(),
        "ord-open-fleet",
        "preparing",
    );
    match notify_platform_ready_locally(&td.state, "ord-open-fleet", NOW).unwrap() {
        PlatformReadyLocal::Applied {
            remote_order_id,
            local_status,
        } => {
            assert_eq!(remote_order_id.as_deref(), Some("remote-ord-open-fleet"));
            assert_eq!(local_status, "delivered");
        }
        other => panic!("expected the order to be marked ready: {other:?}"),
    }
    let (status, payments, queued) = counts(&td, "ord-open-fleet");
    assert_eq!(status, "delivered");
    assert_eq!(payments, 1, "the platform settlement row");
    assert!(queued >= 1, "ready then delivered queued for the server");
}
