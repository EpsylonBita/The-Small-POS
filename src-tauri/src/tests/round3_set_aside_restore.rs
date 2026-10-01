//! Round 3 of the 01/10/2026 fix review, item DR5: the set-aside ledger
//! restore never lets one failing order block the ones after it.

use rusqlite::params;

use crate::tests::harness::TestDb;

const NOW: &str = "2026-10-01T12:00:00Z";

// ---------------------------------------------------------------------------
// DR5
// ---------------------------------------------------------------------------

/// DR5: the set-aside ledger restore read its orders in a fixed order and
/// stopped at the first failure, so one order the server could not answer
/// for held every later one forever. A failure now sends that order to the
/// back of the line (as the placeholder restore's D3 fix does).
#[test]
fn dr5_an_order_whose_set_aside_restore_failed_goes_to_the_back_of_the_line() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    for (order_id, payment_id) in [("ord-dr5-a", "pay-dr5-a"), ("ord-dr5-b", "pay-dr5-b")] {
        conn.execute(
            "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                 status, order_type, payment_status, sync_status, created_at, updated_at)
             VALUES (?1, ?1, '[]', 5.0, 500, 'completed', 'pickup', 'paid', 'synced',
                     '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')",
            params![order_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                 sync_status, sync_state, created_at, updated_at)
             VALUES (?1, ?2, 'cash', 5.0, 500, 'completed', 'pending', 'pending',
                     '2026-10-01T10:05:00Z', '2026-10-01T10:05:00Z')",
            params![payment_id, order_id],
        )
        .unwrap();
        crate::payment_review::set_aside_already_paid_payment(&conn, payment_id, None, NOW)
            .unwrap();
    }
    assert_eq!(
        crate::payment_review::orders_awaiting_ledger_restore(&conn, 25).unwrap(),
        vec!["ord-dr5-a".to_string(), "ord-dr5-b".to_string()]
    );
    crate::payment_review::mark_ledger_restore_failed(&conn, "ord-dr5-a", NOW).unwrap();
    assert_eq!(
        crate::payment_review::orders_awaiting_ledger_restore(&conn, 25).unwrap(),
        vec!["ord-dr5-b".to_string(), "ord-dr5-a".to_string()],
        "the order that failed waits behind the one never tried"
    );
    crate::payment_review::mark_ledger_restore_failed(&conn, "ord-dr5-b", "2026-10-01T12:05:00Z")
        .unwrap();
    assert_eq!(
        crate::payment_review::orders_awaiting_ledger_restore(&conn, 25).unwrap(),
        vec!["ord-dr5-a".to_string(), "ord-dr5-b".to_string()],
        "then the longest-waiting failure first"
    );
}
