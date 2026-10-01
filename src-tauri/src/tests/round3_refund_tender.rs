//! Round 3 of the 01/10/2026 fix review, shared rule R5 (the same rule on
//! Android): a refund names its tender; an `other` tender is never guessed
//! as cash (no drawer refund, no courier money).

use rusqlite::params;
use serde_json::json;

use crate::tests::harness::TestDb;

// ---------------------------------------------------------------------------
// R5
// ---------------------------------------------------------------------------

/// R5: a refund that named no tender was written as a CASH refund from the
/// drawer whatever the payment's tender (`_ => Cash`): refunding an `other`
/// tender lowered the drawer's expected cash for money that never left it.
/// It now names the payment's own tender, `other` included (round 3 review:
/// a refund always names its tender, as Android stores it): no drawer
/// refund, no courier money.
#[test]
fn r5_a_refund_of_an_other_tender_is_never_guessed_as_cash() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, check_in_time,
                opening_cash_amount, opening_cash_amount_cents, status, calculation_version,
                sync_status, created_at, updated_at)
             VALUES ('shift-r5', 'cashier-r5', 'cashier', 'branch-r5', '2026-10-01T08:00:00Z',
                     50.0, 5000, 'active', 2, 'pending', '2026-10-01T08:00:00Z',
                     '2026-10-01T08:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id,
                terminal_id, opening_amount, opening_amount_cents, opened_at, created_at,
                updated_at)
             VALUES ('drawer-r5', 'shift-r5', 'cashier-r5', 'branch-r5', 'terminal-r5', 50.0,
                     5000, '2026-10-01T08:00:00Z', '2026-10-01T08:00:00Z',
                     '2026-10-01T08:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                 status, order_type, payment_status, sync_status, staff_shift_id, created_at,
                 updated_at)
             VALUES ('ord-r5', 'ord-r5', '[]', 20.0, 2000, 'completed', 'pickup', 'paid',
                     'synced', 'shift-r5', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z')",
            [],
        )
        .unwrap();
        for (id, method) in [("pay-r5-other", "other"), ("pay-r5-cash", "cash")] {
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                     staff_shift_id, sync_status, sync_state, created_at, updated_at)
                 VALUES (?1, 'ord-r5', ?2, 10.0, 1000, 'completed', 'shift-r5', 'synced',
                         'applied', '2026-10-01T09:01:00Z', '2026-10-01T09:01:00Z')",
                params![id, method],
            )
            .unwrap();
        }
    }

    for payment_id in ["pay-r5-other", "pay-r5-cash"] {
        crate::refunds::refund_payment(
            &td.state,
            &json!({
                "paymentId": payment_id,
                "amount": 4.0,
                "reason": "Synthetic refund",
                "staffShiftId": "shift-r5",
            }),
        )
        .unwrap_or_else(|error| panic!("{payment_id}: {error}"));
    }
    let conn = td.state.conn.lock().unwrap();
    let route = |payment_id: &str| -> (Option<String>, Option<String>) {
        conn.query_row(
            "SELECT refund_method, cash_handler FROM payment_adjustments WHERE payment_id = ?1",
            params![payment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    };
    assert_eq!(
        route("pay-r5-other"),
        (Some("other".to_string()), None),
        "named as its own tender, never guessed as cash"
    );
    assert_eq!(
        route("pay-r5-cash"),
        (Some("cash".to_string()), Some("cashier_drawer".to_string())),
        "a cash payment's refund names cash, paid by the drawer (no courier holds it)"
    );
    let drawer_refunds: i64 = conn
        .query_row(
            "SELECT COALESCE(total_refunds_cents, 0) FROM cash_drawer_sessions WHERE id = 'drawer-r5'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(drawer_refunds, 400, "only the cash refund left the drawer");
}
