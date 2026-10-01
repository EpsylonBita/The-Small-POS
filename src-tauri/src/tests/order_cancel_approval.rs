//! Cancelling an order that still owes money is explicit (item D1, fix
//! review 30/09/2026): a reason, the desktop's approval for money actions,
//! and an audit entry.
//!
//! Symptom: releasing a table relied on the server to cancel its order; the
//! server now frees the table and leaves an owing order open, so the order
//! lingered as an orphan: shown occupied, payable, not cancellable from the
//! check, exempt from the Z. The till now asks, and a cancellation needs a
//! reason and a cashier or manager PIN.

use rusqlite::params;
use serde_json::{json, Value};

use crate::auth::GuardedCommandError;
use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const TERMINAL_ID: &str = "terminal-cancel";
const BRANCH_ID: &str = "branch-cancel";
const ORDER_ID: &str = "ord-cancel-owing";

fn seed(conn: &rusqlite::Connection) {
    crate::db::set_setting(conn, "terminal", "__ignore_keyring", "1").unwrap();
    crate::db::set_setting(conn, "terminal", "terminal_id", TERMINAL_ID).unwrap();
    crate::db::set_setting(conn, "terminal", "branch_id", BRANCH_ID).unwrap();
    let hash = bcrypt::hash("4321", 4).unwrap();
    crate::db::set_setting(conn, "staff", "staff_pin_hash", &hash).unwrap();
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, staff_name, branch_id, terminal_id,
            role_type, check_in_time, opening_cash_amount, opening_cash_amount_cents,
            status, sync_status, created_at, updated_at)
         VALUES ('shift-cancel', 'staff-cashier', 'Cashier', ?1, ?2, 'cashier',
                 '2026-09-30T08:00:00Z', 100.0, 10000, 'active', 'pending',
                 '2026-09-30T08:00:00Z', '2026-09-30T08:00:00Z')",
        params![BRANCH_ID, TERMINAL_ID],
    )
    .unwrap();
    // A dine-in order that still owes 13.00.
    conn.execute(
        "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
            status, order_type, payment_status, sync_status, branch_id, terminal_id,
            created_at, updated_at)
         VALUES (?1, 'T-0005', '[]', 13.0, 1300, 'pending', 'dine-in', 'pending', 'synced',
                 ?2, ?3, '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
        params![ORDER_ID, BRANCH_ID, TERMINAL_ID],
    )
    .unwrap();
}

fn error_code(error: &GuardedCommandError) -> &str {
    match error {
        GuardedCommandError::Structured(error) => error.code,
        _ => "",
    }
}

fn authorize(
    td: &TestDb,
    auth: &crate::auth::AuthState,
    reason: &str,
) -> Result<(String, String, crate::auth::MoneyApprover), GuardedCommandError> {
    crate::commands::orders::authorize_owing_order_cancel(
        &td.state,
        auth,
        Some(json!({ "orderId": ORDER_ID, "reason": reason })),
    )
}

#[test]
fn cancelling_an_owing_order_needs_a_reason_and_the_money_approval() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    seed(&td.state.conn.lock().unwrap());
    let auth = crate::auth::AuthState::new();

    assert!(
        authorize(&td, &auth, "   ").is_err(),
        "no reason, no cancellation"
    );
    let refused = authorize(&td, &auth, "The customer left").expect_err("no session");
    assert_eq!(error_code(&refused), "UNAUTHORIZED");
    crate::auth::login(Some(json!({ "pin": "4321" })), &td.state, &auth).expect("staff login");
    let stale =
        authorize(&td, &auth, "The customer left").expect_err("a session is not the approval");
    assert_eq!(error_code(&stale), "REAUTH_REQUIRED");

    crate::auth::confirm_privileged_action(
        Some(json!({ "pin": "4321", "scope": "cash_drawer_control" })),
        &td.state,
        &auth,
    )
    .expect("PIN confirmation");
    let (order_id, reason, approver) =
        authorize(&td, &auth, "  The customer left  ").expect("approved");
    assert_eq!(approver.via, "shift_session");
    assert_eq!(order_id, ORDER_ID);
    assert_eq!(reason, "The customer left");
}

fn seed_payment(conn: &rusqlite::Connection, id: &str, status: &str) {
    conn.execute(
        "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
             sync_status, created_at, updated_at)
         VALUES (?1, ?2, 'cash', 5.0, 500, ?3, 'synced',
                 '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
        params![id, ORDER_ID, status],
    )
    .expect("seed a payment");
}

/// Android parity: money taken on the order is voided or refunded from the
/// order first (or the rest is collected). Cancelling it here would take
/// back what the drawer counted for it while the payment stays recorded.
#[test]
fn an_order_money_was_taken_on_is_not_cancelled_here() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed(&conn);
        seed_payment(&conn, "pay-voided", "voided");
    }
    let auth = crate::auth::AuthState::new();
    crate::auth::login(Some(json!({ "pin": "4321" })), &td.state, &auth).expect("staff login");
    crate::auth::confirm_privileged_action(
        Some(json!({ "pin": "4321", "scope": "cash_drawer_control" })),
        &td.state,
        &auth,
    )
    .expect("PIN confirmation");
    // A voided payment is not money taken.
    authorize(&td, &auth, "The customer left").expect("nothing was taken");

    seed_payment(&td.state.conn.lock().unwrap(), "pay-part", "completed");
    let refused = authorize(&td, &auth, "The customer left").expect_err("money was taken");
    assert!(
        refused
            .to_string()
            .starts_with(crate::commands::orders::ORDER_HAS_PAYMENTS),
        "{refused}"
    );
    // Refused before any PIN is asked.
    let fresh = crate::auth::AuthState::new();
    let refused = authorize(&td, &fresh, "The customer left").expect_err("money was taken");
    assert!(refused
        .to_string()
        .starts_with(crate::commands::orders::ORDER_HAS_PAYMENTS));
}

#[test]
fn the_cancellation_audit_names_who_why_and_what_was_owed() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    seed(&td.state.conn.lock().unwrap());
    let auth = crate::auth::AuthState::new();
    crate::auth::login(Some(json!({ "pin": "4321" })), &td.state, &auth).expect("staff login");

    // What it owes is read before the cancellation reverses what it counted.
    let owed = crate::commands::orders::owing_order_outstanding_cents(&td.state, ORDER_ID)
        .expect("what the order owes");
    assert_eq!(owed, 1300);
    crate::commands::orders::record_owing_order_cancel_audit(
        &td.state,
        &auth,
        ORDER_ID,
        "The customer left",
        Some(owed),
        &crate::auth::MoneyApprover {
            manager_staff_id: None,
            via: "shift_session",
        },
    )
    .expect("the audit entry");

    let conn = td.state.conn.lock().unwrap();
    let (issue_code, actor, payload): (String, Option<String>, String) = conn
        .query_row(
            "SELECT issue_code, actor_staff_id, payload_json FROM recovery_action_log
             WHERE action_id = 'order_cancel_owing' AND order_id = ?1",
            params![ORDER_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("the audit entry");
    assert_eq!(issue_code, "order_owes_money");
    let session = crate::auth::get_session_json(&auth);
    let session_staff = ["databaseStaffId", "staffId"]
        .iter()
        .find_map(|key| session.get(*key).and_then(Value::as_str))
        .map(str::to_string);
    assert_eq!(actor, session_staff, "who cancelled it");
    let payload: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["reason"], "The customer left");
    assert_eq!(payload["outstandingCents"], 1300, "what it still owed");
    assert!(payload["cancelledAt"]
        .as_str()
        .is_some_and(|at| !at.is_empty()));
}

#[test]
fn an_unreadable_amount_is_recorded_as_unknown_never_as_zero() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    seed(&td.state.conn.lock().unwrap());
    let auth = crate::auth::AuthState::new();
    crate::auth::login(Some(json!({ "pin": "4321" })), &td.state, &auth).expect("staff login");

    crate::commands::orders::record_owing_order_cancel_audit(
        &td.state,
        &auth,
        ORDER_ID,
        "The customer left",
        None,
        &crate::auth::MoneyApprover {
            manager_staff_id: None,
            via: "shift_session",
        },
    )
    .expect("the audit entry");

    let conn = td.state.conn.lock().unwrap();
    let payload: String = conn
        .query_row(
            "SELECT payload_json FROM recovery_action_log
             WHERE action_id = 'order_cancel_owing' AND order_id = ?1",
            params![ORDER_ID],
            |row| row.get(0),
        )
        .expect("the audit entry");
    let payload: Value = serde_json::from_str(&payload).unwrap();
    assert!(payload["outstandingCents"].is_null(), "unknown, not 0");
}
