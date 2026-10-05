//! A manager approves the Z's money actions with their own PIN when nobody is
//! on shift at this terminal (fix review 30/09/2026).
//!
//! Symptom: the Z needs every staff member checked out, and the money actions
//! of the Z ("Record cash/card", "Money given back") and the owing-order
//! cancel needed an active cashier or manager shift on this terminal: they
//! answered "shift required" exactly when the Z needed them.
//!
//! Now, with nobody on shift here, the approval is a manager's own PIN,
//! checked on this till against the staff directory (the PIN hashes the
//! shift check-in trusts) among the staff whose store permissions allow the
//! action (THE-448 names, as on Android: `pos.refunds.process` for a payment,
//! `pos.orders.cancel` for an order). It is used once, audited, and wrong PINs
//! count toward the terminal's lockout. With a shift open, nothing changes.

use rusqlite::params;
use serde_json::{json, Value};

use crate::auth::{GuardedCommandError, MoneyApproval, PrivilegedActionError};
use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const TERMINAL_ID: &str = "terminal-manager-pin";
const BRANCH_ID: &str = "branch-manager-pin";
const ORDER_ID: &str = "ord-manager-pin";
const TERMINAL_STAFF_PIN: &str = "4321";
const MANAGER: (&str, &str) = ("staff-manager", "2468");
const CASHIER: (&str, &str) = ("staff-cashier", "1357");
const REFUNDS_ONLY: (&str, &str) = ("staff-refunds", "9753");

fn seed(conn: &rusqlite::Connection) {
    crate::db::set_setting(conn, "terminal", "__ignore_keyring", "1").unwrap();
    crate::db::set_setting(conn, "terminal", "terminal_id", TERMINAL_ID).unwrap();
    crate::db::set_setting(conn, "terminal", "branch_id", BRANCH_ID).unwrap();
    for (key, value) in [
        ("store_currency_branch_id", BRANCH_ID),
        ("store_currency_available", "true"),
        ("store_currency_source", "branch_country"),
        ("currency", "EUR"),
    ] {
        crate::db::set_setting(conn, "restaurant", key, value).unwrap();
    }
    let hash = bcrypt::hash(TERMINAL_STAFF_PIN, 4).unwrap();
    crate::db::set_setting(conn, "staff", "staff_pin_hash", &hash).unwrap();
    // The staff directory as the till stores it (synthetic staff).
    let entry = |(id, pin): (&str, &str), permissions: &[&str]| {
        json!({
            "id": id,
            "canLoginPos": true,
            "isActive": true,
            "hasPin": true,
            "pinHash": bcrypt::hash(pin, 4).unwrap(),
            "permissions": permissions,
        })
    };
    let directory = json!({
        "version": 1,
        "branch_id": BRANCH_ID,
        "synced_at": "2026-09-30T07:00:00Z",
        "staff": [
            entry(MANAGER, &["pos.refunds.process", "pos.orders.cancel"]),
            entry(CASHIER, &["pos.orders.create"]),
            entry(REFUNDS_ONLY, &["pos.refunds.process"]),
        ],
    });
    crate::db::set_setting(
        conn,
        "staff_auth_cache",
        &format!("branch_{BRANCH_ID}"),
        &directory.to_string(),
    )
    .unwrap();
    // The day's cashier checked out: nobody is on shift at this terminal.
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, staff_name, branch_id, terminal_id,
            role_type, check_in_time, check_out_time, opening_cash_amount,
            opening_cash_amount_cents, status, sync_status, created_at, updated_at, currency)
         VALUES ('shift-closed', 'staff-cashier', 'Cashier', ?1, ?2, 'cashier',
                 '2026-09-30T08:00:00Z', '2026-09-30T20:00:00Z', 100.0, 10000, 'closed',
                 'pending', '2026-09-30T08:00:00Z', '2026-09-30T20:00:00Z', 'EUR')",
        params![BRANCH_ID, TERMINAL_ID],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id,
            terminal_id, opening_amount, opening_amount_cents, total_cash_sales,
            total_cash_sales_cents, opened_at, closed_at, created_at, updated_at, currency)
         VALUES ('drawer-closed', 'shift-closed', 'staff-cashier', ?1, ?2, 100.0, 10000,
                 0.0, 0, '2026-09-30T08:00:00Z', '2026-09-30T20:00:00Z',
                 '2026-09-30T08:00:00Z', '2026-09-30T20:00:00Z', 'EUR')",
        params![BRANCH_ID, TERMINAL_ID],
    )
    .unwrap();
    // A completed 13.00 order without its payment row: a Z blocker.
    conn.execute(
        "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
            status, order_type, payment_status, sync_status, branch_id, terminal_id,
            staff_shift_id, created_at, updated_at, currency)
         VALUES (?1, 'A-0451', '[]', 13.0, 1300, 'completed', 'takeaway', 'pending', 'synced',
                 ?2, ?3, 'shift-closed', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z', 'EUR')",
        params![ORDER_ID, BRANCH_ID, TERMINAL_ID],
    )
    .unwrap();
}

fn open_cashier_shift(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, staff_name, branch_id, terminal_id,
            role_type, check_in_time, opening_cash_amount, opening_cash_amount_cents,
            status, sync_status, created_at, updated_at, currency)
         VALUES ('shift-open', 'staff-cashier', 'Cashier', ?1, ?2, 'cashier',
                 '2026-09-30T21:00:00Z', 100.0, 10000, 'active', 'pending',
                 '2026-09-30T21:00:00Z', '2026-09-30T21:00:00Z', 'EUR')",
        params![BRANCH_ID, TERMINAL_ID],
    )
    .unwrap();
}

fn setup() -> (fake_keyring::Guard, TestDb, crate::auth::AuthState) {
    let keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    seed(&td.state.conn.lock().unwrap());
    let auth = crate::auth::AuthState::new();
    crate::auth::login(Some(json!({ "pin": TERMINAL_STAFF_PIN })), &td.state, &auth)
        .expect("the terminal's staff login");
    (keyring, td, auth)
}

fn confirm(
    td: &TestDb,
    auth: &crate::auth::AuthState,
    pin: &str,
    approval: Option<&str>,
) -> Result<Value, PrivilegedActionError> {
    let mut payload = json!({ "pin": pin, "scope": "cash_drawer_control" });
    if let Some(approval) = approval {
        payload["approval"] = json!(approval);
    }
    crate::auth::confirm_privileged_action(Some(payload), &td.state, auth)
}

fn record(td: &TestDb, auth: &crate::auth::AuthState) -> Result<Value, GuardedCommandError> {
    crate::commands::analytics::record_payment_blocker_guarded(
        &td.state,
        auth,
        Some(json!({ "orderId": ORDER_ID, "method": "cash", "amountCents": 1300 })),
    )
}

fn structured(error: &GuardedCommandError) -> &PrivilegedActionError {
    match error {
        GuardedCommandError::Structured(error) => error,
        GuardedCommandError::Message(message) => panic!("not a structured refusal: {message}"),
    }
}

fn lockout_attempts(td: &TestDb) -> u32 {
    crate::db::get_setting(&td.state.conn.lock().unwrap(), "staff", "lockout_attempts")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

#[test]
fn with_nobody_on_shift_the_z_record_asks_a_managers_own_pin_and_names_the_manager() {
    let (_keyring, td, auth) = setup();

    // It used to answer "shift required": a dead button on the Z.
    let asked = record(&td, &auth).expect_err("the approval comes first");
    let asked = structured(&asked);
    assert_eq!(asked.code, "REAUTH_REQUIRED", "{asked:?}");
    assert_eq!(asked.approval, Some("void_payments"));

    let approved = confirm(&td, &auth, MANAGER.1, Some("void_payments")).expect("the manager");
    assert_eq!(approved["approvedBy"], MANAGER.0);
    assert_eq!(approved["via"], "manager_pin");

    let recorded = record(&td, &auth).expect("recorded");
    assert_eq!(recorded["success"], true, "{recorded}");
    assert_eq!(recorded["charged"], false);

    let conn = td.state.conn.lock().unwrap();
    let (actor, payload): (Option<String>, String) = conn
        .query_row(
            "SELECT actor_staff_id, payload_json FROM recovery_action_log
             WHERE action_id = 'z_record_payment' AND order_id = ?1",
            params![ORDER_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the record's audit entry");
    assert_eq!(
        actor.as_deref(),
        Some(MANAGER.0),
        "the manager is who recorded it"
    );
    let payload: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["approvalVia"], "manager_pin");
    let (issue, approval_actor): (String, Option<String>) = conn
        .query_row(
            "SELECT issue_code, actor_staff_id FROM recovery_action_log
             WHERE action_id = 'manager_approval'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the approval's own audit entry");
    assert_eq!(issue, "void_payments");
    assert_eq!(approval_actor.as_deref(), Some(MANAGER.0));
}

#[test]
fn a_managers_approval_is_used_once() {
    let (_keyring, td, auth) = setup();
    confirm(&td, &auth, MANAGER.1, Some("void_payments")).expect("the manager");

    let first = crate::auth::authorize_money_action(MoneyApproval::VoidPayments, &td.state, &auth)
        .expect("approved");
    assert_eq!(first.manager_staff_id.as_deref(), Some(MANAGER.0));
    assert_eq!(first.via, "manager_pin");
    let second = crate::auth::authorize_money_action(MoneyApproval::VoidPayments, &td.state, &auth)
        .expect_err("used once");
    assert_eq!(second.code, "REAUTH_REQUIRED");
    assert_eq!(second.approval, Some("void_payments"));
}

#[test]
fn only_a_pin_whose_store_rights_allow_the_action_approves_it() {
    let (_keyring, td, auth) = setup();

    // The terminal's shared staff PIN and a cashier without the right: as a
    // wrong PIN, counted toward the lockout.
    for pin in [TERMINAL_STAFF_PIN, CASHIER.1, "0000"] {
        let refused = confirm(&td, &auth, pin, Some("void_payments")).expect_err("not a manager");
        assert_eq!(refused.code, "UNAUTHORIZED");
        assert_eq!(refused.reason, "Invalid PIN");
    }
    assert_eq!(lockout_attempts(&td), 3, "wrong PINs count");

    // A refunds-only manager approves a payment action, not an order cancel.
    confirm(&td, &auth, REFUNDS_ONLY.1, Some("void_payments")).expect("refunds right");
    let refused =
        confirm(&td, &auth, REFUNDS_ONLY.1, Some("void_orders")).expect_err("no cancel right");
    assert_eq!(refused.reason, "Invalid PIN");
    confirm(&td, &auth, MANAGER.1, Some("void_orders")).expect("the manager cancels");

    // Without saying what it approves, nobody approves anything off shift.
    let refused = confirm(&td, &auth, MANAGER.1, None).expect_err("which approval?");
    assert_eq!(refused.code, "UNAUTHORIZED");
}

#[test]
fn with_a_shift_on_this_terminal_the_session_and_its_pin_decide_as_before() {
    let (_keyring, td, auth) = setup();
    open_cashier_shift(&td.state.conn.lock().unwrap());

    let asked = crate::auth::authorize_money_action(MoneyApproval::VoidPayments, &td.state, &auth)
        .expect_err("a fresh PIN first");
    assert_eq!(asked.code, "REAUTH_REQUIRED");
    assert_eq!(
        asked.approval, None,
        "the terminal's own PIN, not a manager's"
    );

    confirm(&td, &auth, TERMINAL_STAFF_PIN, None).expect("the session's PIN");
    let approved =
        crate::auth::authorize_money_action(MoneyApproval::VoidPayments, &td.state, &auth)
            .expect("approved");
    assert_eq!(approved.via, "shift_session");
    assert_eq!(approved.manager_staff_id, None);
}

#[test]
fn the_owing_order_cancel_asks_for_the_cancel_right() {
    let (_keyring, td, auth) = setup();
    td.state
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE orders SET status = 'pending' WHERE id = ?1",
            params![ORDER_ID],
        )
        .unwrap();
    let cancel = |auth: &crate::auth::AuthState| {
        crate::commands::orders::authorize_owing_order_cancel(
            &td.state,
            auth,
            Some(json!({ "orderId": ORDER_ID, "reason": "The customer left" })),
        )
    };

    let asked = cancel(&auth).expect_err("the approval comes first");
    assert_eq!(structured(&asked).approval, Some("void_orders"));
    // A payment right is not a cancel right.
    confirm(&td, &auth, REFUNDS_ONLY.1, Some("void_payments")).expect("refunds right");
    assert!(cancel(&auth).is_err(), "a payment approval does not cancel");

    confirm(&td, &auth, MANAGER.1, Some("void_orders")).expect("the manager");
    let (_, _, approver) = cancel(&auth).expect("approved");
    assert_eq!(approver.manager_staff_id.as_deref(), Some(MANAGER.0));
}
