//! "Record cash" / "Record card" on a payment blocker, the Z's and the shift
//! checkout's record-only action (item F, fix review 30/09/2026; parity with
//! Android's "Record the payment").
//!
//! Symptom: one tap recorded money no one had to confirm: no approval, no
//! audit entry naming who recorded it, and nothing keying the record, so a
//! replayed request relied on the balance check alone.

use rusqlite::params;
use serde_json::{json, Value};

use crate::auth::GuardedCommandError;
use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const TERMINAL_ID: &str = "terminal-record";
const BRANCH_ID: &str = "branch-record";
const ORDER_ID: &str = "ord-record";

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
         VALUES ('shift-record', 'staff-cashier', 'Cashier', ?1, ?2, 'cashier',
                 '2026-09-30T08:00:00Z', 100.0, 10000, 'active', 'pending',
                 '2026-09-30T08:00:00Z', '2026-09-30T08:00:00Z')",
        params![BRANCH_ID, TERMINAL_ID],
    )
    .unwrap();
    // A completed 13.00 order with no payment row: `no_persisted_payment`,
    // money the customer paid that the till never recorded.
    conn.execute(
        "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
            status, order_type, payment_status, sync_status, branch_id, terminal_id,
            staff_shift_id, created_at, updated_at)
         VALUES (?1, 'A-0120', '[]', 13.0, 1300, 'completed', 'takeaway', 'pending', 'synced',
                 ?2, ?3, 'shift-record', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
        params![ORDER_ID, BRANCH_ID, TERMINAL_ID],
    )
    .unwrap();
}

fn record(
    td: &TestDb,
    auth: &crate::auth::AuthState,
    amount_cents: i64,
) -> Result<Value, GuardedCommandError> {
    crate::commands::analytics::record_payment_blocker_guarded(
        &td.state,
        auth,
        Some(json!({ "orderId": ORDER_ID, "method": "cash", "amountCents": amount_cents })),
    )
}

fn error_code(error: &GuardedCommandError) -> &str {
    match error {
        GuardedCommandError::Structured(error) => error.code,
        _ => "",
    }
}

#[test]
fn recording_a_blocker_payment_needs_the_money_approval_is_audited_and_keyed_once() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    seed(&td.state.conn.lock().unwrap());
    let auth = crate::auth::AuthState::new();
    let rows = |td: &TestDb| -> i64 {
        td.state
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM order_payments WHERE order_id = ?1",
                params![ORDER_ID],
                |row| row.get(0),
            )
            .unwrap()
    };

    let refused = record(&td, &auth, 1300).expect_err("no session, no record");
    assert_eq!(error_code(&refused), "UNAUTHORIZED");
    crate::auth::login(Some(json!({ "pin": "4321" })), &td.state, &auth).expect("staff login");
    let stale = record(&td, &auth, 1300).expect_err("a session alone is not the approval");
    assert_eq!(error_code(&stale), "REAUTH_REQUIRED");
    assert_eq!(rows(&td), 0, "nothing recorded without the approval");

    crate::auth::confirm_privileged_action(
        Some(json!({ "pin": "4321", "scope": "cash_drawer_control" })),
        &td.state,
        &auth,
    )
    .expect("PIN confirmation");
    let recorded = record(&td, &auth, 1300).expect("recorded");
    assert_eq!(recorded["success"], true, "{recorded}");
    assert_eq!(recorded["charged"], false);
    assert_eq!(recorded["idempotencyKey"], "z-record:ord-record:1300");

    let conn = td.state.conn.lock().unwrap();
    let (method, status, amount_cents): (String, String, i64) = conn
        .query_row(
            "SELECT method, status, amount_cents FROM order_payments
             WHERE idempotency_key = 'z-record:ord-record:1300'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("the payment, under its key");
    assert_eq!(
        (method.as_str(), status.as_str(), amount_cents),
        ("cash", "completed", 1300)
    );
    let (issue_code, actor, payload): (String, Option<String>, String) = conn
        .query_row(
            "SELECT issue_code, actor_staff_id, payload_json FROM recovery_action_log
             WHERE action_id = 'z_record_payment' AND order_id = ?1",
            params![ORDER_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("the audit entry");
    assert_eq!(issue_code, "no_persisted_payment", "which blocker");
    let session = crate::auth::get_session_json(&auth);
    let session_staff = ["databaseStaffId", "staffId"]
        .iter()
        .find_map(|key| session.get(*key).and_then(Value::as_str))
        .map(str::to_string);
    assert_eq!(actor, session_staff, "who recorded it, from the session");
    let payload: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["charged"], false);
    assert_eq!(payload["method"], "cash");
    assert_eq!(payload["amountCents"], 1300);
    assert!(payload["recordedAt"]
        .as_str()
        .is_some_and(|at| !at.is_empty()));
    drop(conn);

    // The same confirmed record again: found under its key, never twice.
    let again = record(&td, &auth, 1300).expect("a second tap");
    assert_eq!(again["alreadyRecorded"], true, "{again}");
    assert_eq!(rows(&td), 1);
}

#[test]
fn a_record_is_refused_when_the_balance_changed_since_it_was_confirmed() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    seed(&td.state.conn.lock().unwrap());
    let auth = crate::auth::AuthState::new();
    crate::auth::login(Some(json!({ "pin": "4321" })), &td.state, &auth).expect("staff login");
    crate::auth::confirm_privileged_action(
        Some(json!({ "pin": "4321", "scope": "cash_drawer_control" })),
        &td.state,
        &auth,
    )
    .expect("PIN confirmation");

    let refused = record(&td, &auth, 900).expect("an answer");
    assert_eq!(refused["success"], false, "{refused}");
    let count: i64 = td
        .state
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM order_payments", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
