//! Round 3 of the 01/10/2026 fix review, shared rule R4 (the same rule on
//! Android): a payment set aside on platform-held money never gets "Record
//! the payment" offered on its order.

use serde_json::json;

use crate::tests::harness::TestDb;

const NOW: &str = "2026-10-01T12:00:00Z";

// ---------------------------------------------------------------------------
// R4
// ---------------------------------------------------------------------------

/// R4: an order whose till payment the server refused as platform-held money
/// was set aside and its label lowered; while its settlement is not mirrored
/// the Z lists it with no payment, and offered "Record cash / card" for it:
/// the server refuses that again. The blocker now says the platform holds the
/// money (`platformHeld`), and the till never offers to record a tender.
#[test]
fn r4_a_platform_held_set_aside_marks_its_blocker_platform_held() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
             status, order_type, payment_status, sync_status, plugin, external_plugin_order_id,
             created_at, updated_at)
         VALUES ('ord-r4', 'A-0404', '[]', 13.0, 1300, 'completed', 'delivery', 'paid',
                 'synced', 'efood', 'efood-4004', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
             sync_status, sync_state, created_at, updated_at)
         VALUES ('pay-r4-card', 'ord-r4', 'card', 13.0, 1300, 'completed', 'pending',
                 'pending', '2026-10-01T10:05:00Z', '2026-10-01T10:05:00Z')",
        [],
    )
    .unwrap();
    crate::payment_review::set_aside_platform_held_payment(&conn, "pay-r4-card", NOW)
        .expect("set the refused payment aside");

    let label: String = conn
        .query_row(
            "SELECT payment_status FROM orders WHERE id = 'ord-r4'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        label, "pending",
        "the label follows what the counted rows prove"
    );

    let blockers = crate::payment_integrity::load_order_payment_blockers(&conn, "ord-r4").unwrap();
    assert_eq!(blockers.len(), 1, "{blockers:?}");
    assert!(blockers[0].platform_held, "{blockers:?}");
    let wire = serde_json::to_value(&blockers[0]).unwrap();
    assert_eq!(wire["platformHeld"], json!(true));

    // An ordinary store order's blocker never carries the flag.
    conn.execute(
        "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
             status, order_type, payment_status, sync_status, created_at, updated_at)
         VALUES ('ord-r4-store', 'A-0405', '[]', 13.0, 1300, 'completed', 'pickup', 'pending',
                 'synced', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')",
        [],
    )
    .unwrap();
    let store =
        crate::payment_integrity::load_order_payment_blockers(&conn, "ord-r4-store").unwrap();
    assert_eq!(store.len(), 1);
    assert!(!store[0].platform_held);
    assert!(serde_json::to_value(&store[0])
        .unwrap()
        .get("platformHeld")
        .is_none());
}
