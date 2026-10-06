//! Explicit upgrade recovery for a still-open cashier created before v96.
//! Old orders/payments/outbox bodies keep their original unknown provenance.
use crate::{auth, db, gift_financial_opening, shifts};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};

const ACTION: &str = "confirm_legacy_shift_currency_v1";
const REQUIRED: &str = "LEGACY_SHIFT_CURRENCY_CONFIRMATION_REQUIRED";

struct Proposal {
    scope: gift_financial_opening::OpeningScope,
    shift_id: String,
    staff_id: String,
    drawer_id: String,
    currency: String,
    proof: Option<String>,
    already_applied: bool,
}

fn proposal(conn: &Connection, shift_id: &str) -> Result<Proposal, String> {
    let scope = gift_financial_opening::OpeningScope::resolve(conn)
        .ok_or("LEGACY_SHIFT_SCOPE_UNAVAILABLE")?;
    let row: Option<(String, String, String, String, Option<String>)> = conn
        .query_row(
            "SELECT staff_id,branch_id,terminal_id,role_type,currency FROM staff_shifts
         WHERE id=?1 AND status='active' AND check_out_time IS NULL",
            [shift_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (staff_id, branch, terminal, role, recorded) = row.ok_or("LEGACY_SHIFT_NOT_ACTIVE")?;
    if branch != scope.branch_id
        || terminal != scope.terminal_id
        || !matches!(role.as_str(), "cashier" | "manager")
    {
        return Err("LEGACY_SHIFT_SCOPE_MISMATCH".into());
    }
    let mut statement = conn.prepare(
        "SELECT id,cashier_id,branch_id,terminal_id,closed_at,currency FROM cash_drawer_sessions WHERE staff_shift_id=?1"
    ).map_err(|error| error.to_string())?;
    let drawers = statement
        .query_map([shift_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if drawers.len() != 1 {
        return Err("LEGACY_SHIFT_DRAWER_MISMATCH".into());
    }
    let (drawer_id, cashier, drawer_branch, drawer_terminal, closed, drawer_currency) = &drawers[0];
    if cashier != &staff_id
        || drawer_branch != &branch
        || drawer_terminal != &terminal
        || closed.is_some()
    {
        return Err("LEGACY_SHIFT_DRAWER_MISMATCH".into());
    }
    let governing =
        crate::order_ownership::resolve_active_cashier_assignment(conn, &branch, &terminal)?;
    if governing.as_ref().map(|(id, _)| id.as_str()) != Some(shift_id) {
        return Err("LEGACY_SHIFT_NOT_GOVERNING_CASHIER".into());
    }
    let current = shifts::require_operating_currency(conn, &scope.branch_id)?;
    let proof = gift_financial_opening::legacy_currency_proof(conn, &scope, shift_id)?;
    let currency = proof
        .as_ref()
        .map(|(_, currency)| currency.clone())
        .unwrap_or(current.clone());
    if currency != current {
        return Err("SHIFT_CURRENCY_MISMATCH".into());
    }
    if recorded.as_ref().is_some_and(|value| value != &currency)
        || drawer_currency
            .as_ref()
            .is_some_and(|value| value != &currency)
    {
        return Err("LEGACY_SHIFT_CURRENCY_CONFLICT".into());
    }
    let audit: Option<String> = conn.query_row(
        "SELECT payload_json FROM recovery_action_log WHERE action_id=?1 AND entity_id=?2 AND success=1 ORDER BY created_at DESC LIMIT 1",
        params![ACTION, shift_id], |row| row.get(0),
    ).optional().map_err(|error| error.to_string())?;
    let already_applied = if let Some(raw) = audit {
        let audit: Value = serde_json::from_str(&raw).map_err(|_| "LEGACY_SHIFT_AUDIT_INVALID")?;
        if audit["currency"] != currency
            || audit["organizationId"] != scope.organization_id
            || audit["branchId"] != scope.branch_id
            || audit["terminalId"] != scope.terminal_id
            || audit["drawerId"] != *drawer_id
            || recorded.as_deref() != Some(currency.as_str())
            || drawer_currency.as_deref() != Some(currency.as_str())
        {
            return Err("LEGACY_SHIFT_AUDIT_INVALID".into());
        }
        true
    } else {
        if recorded.is_some() {
            return Err("LEGACY_SHIFT_ALREADY_RECORDED".into());
        }
        false
    };
    // Known units constrain recovery, never supply proof for unknown history.
    // Include all payment states and both ownership links so a void/refund or
    // reassigned order cannot hide contradictory original financial evidence.
    let conflict: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM (
          SELECT currency FROM orders WHERE staff_shift_id=?1
          UNION ALL SELECT p.currency FROM order_payments p LEFT JOIN orders o ON o.id=p.order_id WHERE p.staff_shift_id=?1 OR o.staff_shift_id=?1
          UNION ALL SELECT currency FROM shift_expenses WHERE staff_shift_id=?1
          UNION ALL SELECT currency FROM driver_earnings WHERE staff_shift_id=?1
          UNION ALL SELECT currency FROM staff_payments WHERE cashier_shift_id=?1
          UNION ALL SELECT currency FROM staff_shifts WHERE transferred_to_cashier_shift_id=?1
          UNION ALL SELECT currency FROM satellite_cash_handovers WHERE cashier_shift_id=?1
          UNION ALL SELECT e.currency FROM ecr_transactions e JOIN orders o ON o.id=e.order_id WHERE o.staff_shift_id=?1
          UNION ALL SELECT currency FROM gift_financial_openings WHERE shift_id=?1
          UNION ALL SELECT currency FROM gift_financial_closings WHERE shift_id=?1
        ) WHERE currency IS NOT NULL AND currency<>?2)", params![shift_id,currency], |row|row.get(0),
    ).map_err(|error|format!("read legacy shift monetary evidence: {error}"))?;
    if conflict {
        return Err("LEGACY_SHIFT_CURRENCY_CONFLICT".into());
    }
    Ok(Proposal {
        scope,
        shift_id: shift_id.into(),
        staff_id,
        drawer_id: drawer_id.clone(),
        currency,
        proof: proof.map(|(key, _)| key),
        already_applied,
    })
}

/// Read-only, exact proposal before any payment UI or draft freeze.
pub(crate) fn admission(conn: &Connection, shift_id: &str) -> Result<Value, String> {
    let proposal = proposal(conn, shift_id)?;
    Ok(
        json!({"success":false,"code":REQUIRED,"shiftId":proposal.shift_id,
        "currency":proposal.currency,"proofAvailable":proposal.proof.is_some()}),
    )
}

/// Uses native session/grants, never a renderer-supplied staff identity.
/// The snapshot is outside the SQLite lock; eligibility is rechecked inside
/// the immediate transaction because a shift can close while it is written.
pub(crate) fn confirm(
    db: &db::DbState,
    auth_state: &auth::AuthState,
    input: Value,
) -> Result<Value, auth::GuardedCommandError> {
    if input.get("confirmed").and_then(Value::as_bool) != Some(true) {
        return Err("LEGACY_SHIFT_EXPLICIT_CONFIRMATION_REQUIRED".into());
    }
    let shift_id = input
        .get("shiftId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("LEGACY_SHIFT_ID_REQUIRED")?;
    let currency = input
        .get("currency")
        .and_then(Value::as_str)
        .filter(|value| value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase()))
        .ok_or("LEGACY_SHIFT_CURRENCY_INVALID")?;
    let session = auth::get_session_json(auth_state);
    let session_staff = session
        .get("staffId")
        .and_then(Value::as_str)
        .ok_or("UNAUTHORIZED")?;
    let (actor, via) = if let Some(pin) = input
        .get("managerPin")
        .and_then(Value::as_str)
        .filter(|pin| !pin.is_empty())
    {
        auth::confirm_privileged_action(
            Some(json!({"pin":pin,"scope":"cash_drawer_control","approval":"void_orders"})),
            db,
            auth_state,
        )?;
        let approver =
            auth::authorize_money_action(auth::MoneyApproval::VoidOrders, db, auth_state)?;
        (
            approver
                .manager_staff_id
                .ok_or("LEGACY_SHIFT_MANAGER_APPROVAL_REQUIRED")?,
            "manager_pin",
        )
    } else {
        auth::authorize_privileged_action(
            auth::PrivilegedActionScope::CashDrawerControl,
            db,
            auth_state,
        )?;
        (session_staff.to_string(), "cash_drawer_control")
    };
    {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        let proposal = proposal(&conn, shift_id)?;
        if proposal.currency != currency {
            return Err("LEGACY_SHIFT_CURRENCY_CONFLICT".into());
        }
        if proposal.already_applied {
            return Ok(
                json!({"success":true,"shiftId":shift_id,"currency":currency,"alreadyApplied":true}),
            );
        }
    }
    let snapshot = crate::recovery::create_pre_recovery_action_snapshot(db)?;
    // A logout, expiry or user switch while the backup was being created
    // cannot retain the earlier session's authority.
    let current_session = auth::get_session_json(auth_state);
    if current_session.is_null() || current_session["sessionId"] != session["sessionId"] {
        return Err("UNAUTHORIZED".into());
    }
    if via == "cash_drawer_control" {
        auth::authorize_privileged_action(
            auth::PrivilegedActionScope::CashDrawerControl,
            db,
            auth_state,
        )?;
    }
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    db::with_full_sync(&conn, |conn| {
        apply(conn, shift_id, currency, &actor, via, &snapshot.id)
    })
    .map_err(Into::into)
}

fn apply(
    conn: &Connection,
    shift_id: &str,
    currency: &str,
    actor: &str,
    via: &str,
    snapshot: &str,
) -> Result<Value, String> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let proposal = proposal(&tx, shift_id)?;
    if proposal.currency != currency {
        return Err("LEGACY_SHIFT_CURRENCY_CONFLICT".into());
    }
    if proposal.already_applied {
        return Ok(
            json!({"success":true,"shiftId":shift_id,"currency":currency,"alreadyApplied":true}),
        );
    }
    tx.execute(
        "UPDATE staff_shifts SET currency=?2 WHERE id=?1 AND currency IS NULL",
        params![shift_id, currency],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE cash_drawer_sessions SET currency=?2 WHERE id=?1 AND currency IS NULL",
        params![proposal.drawer_id, currency],
    )
    .map_err(|error| error.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let evidence = json!({"version":1,"organizationId":proposal.scope.organization_id,"branchId":proposal.scope.branch_id,
        "terminalId":proposal.scope.terminal_id,"shiftId":shift_id,"cashierStaffId":proposal.staff_id,
        "drawerId":proposal.drawer_id,"currency":currency,"via":via,"approvedBy":actor,
        "openingProofKey":proposal.proof,"snapshotId":snapshot,"confirmedAt":now,
        "historicalChildrenUnchanged":true});
    tx.execute("INSERT INTO recovery_action_log(id,action_id,issue_code,entity_type,entity_id,success,message,actor_staff_id,payload_json,created_at)
        VALUES(?1,?2,?3,'staff_shift',?4,1,'Confirmed operating currency for active legacy shift; historical money unchanged',?5,?6,?7)",
        params![uuid::Uuid::new_v4().to_string(),ACTION,REQUIRED,shift_id,actor,evidence.to_string(),now])
        .map_err(|error|error.to_string())?;
    shifts::require_shift_operating_currency(&tx, shift_id)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(
        json!({"success":true,"shiftId":shift_id,"currency":currency,"alreadyApplied":false,"snapshotId":snapshot}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{fake_keyring, harness::TestDb};

    fn setup() -> TestDb {
        let test = TestDb::open();
        let conn = test.state.conn.lock().unwrap();
        for (category, key, value) in [
            ("terminal", "organization_id", "org-legacy"),
            ("terminal", "branch_id", "branch-legacy"),
            ("terminal", "terminal_id", "terminal-legacy"),
            ("restaurant", "currency", "EUR"),
            ("restaurant", "store_currency_branch_id", "branch-legacy"),
            ("restaurant", "store_currency_available", "true"),
            ("restaurant", "store_currency_source", "branch_country"),
        ] {
            db::set_setting(&conn, category, key, value).unwrap();
        }
        db::set_setting(
            &conn,
            "staff",
            "admin_pin_hash",
            &bcrypt::hash("1234", 4).unwrap(),
        )
        .unwrap();
        conn.execute_batch("INSERT INTO staff_shifts(id,staff_id,branch_id,terminal_id,role_type,status,check_in_time,created_at,updated_at)
            VALUES('legacy','cashier','branch-legacy','terminal-legacy','cashier','active','2026-10-05T10:00:00Z','now','now');
            INSERT INTO cash_drawer_sessions(id,staff_shift_id,cashier_id,branch_id,terminal_id,opening_amount,opening_amount_cents,opened_at,created_at,updated_at)
            VALUES('drawer','legacy','cashier','branch-legacy','terminal-legacy',20,2000,'2026-10-05T10:00:00Z','now','now');
            INSERT INTO orders(id,items,total_amount,status,order_type,payment_status,staff_shift_id,branch_id,terminal_id,created_at,updated_at)
            VALUES('old-order','[]',6,'completed','pickup','paid','legacy','branch-legacy','terminal-legacy','now','now');
            INSERT INTO order_payments(id,order_id,method,amount,currency,status,staff_shift_id,created_at,updated_at)
            VALUES('old-payment','old-order','cash',6,'EUR','completed','legacy','now','now');").unwrap();
        crate::sync_queue::enqueue_payload_item(
            &conn,
            "orders",
            "old-order",
            "INSERT",
            &json!({"id":"old-order","total":6,"currency":null}),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        drop(conn);
        test
    }
    fn login(db: &db::DbState, auth: &auth::AuthState, grant: bool) {
        assert_eq!(
            auth::login(Some(json!({"pin":"1234"})), db, auth).unwrap()["success"],
            true
        );
        if grant {
            auth::confirm_privileged_action(
                Some(json!({"pin":"1234","scope":"cash_drawer_control"})),
                db,
                auth,
            )
            .unwrap();
        }
    }
    fn input() -> Value {
        json!({"shiftId":"legacy","currency":"EUR","confirmed":true})
    }
    fn unknown(conn: &Connection) {
        assert_eq!(
            shifts::recorded_operating_currency(conn, "staff_shifts", "legacy").unwrap(),
            None
        );
    }

    #[test]
    #[serial_test::serial]
    fn legacy_shift_currency_read_only_admission_reproduces_upgrade_refusal() {
        let _keyring = fake_keyring::install_empty();
        let db = setup();
        let conn = db.state.conn.lock().unwrap();
        assert_eq!(
            shifts::require_shift_operating_currency(&conn, "legacy").unwrap_err(),
            "SHIFT_CURRENCY_UNAVAILABLE"
        );
        let before = conn.total_changes();
        assert_eq!(
            admission(&conn, "legacy").unwrap(),
            json!({"success":false,"code":REQUIRED,"shiftId":"legacy","currency":"EUR","proofAvailable":false})
        );
        assert_eq!(conn.total_changes(), before);
        unknown(&conn);
    }

    #[test]
    #[serial_test::serial]
    fn legacy_shift_currency_snapshot_audit_restart_and_retry_preserve_history() {
        let _keyring = fake_keyring::install_empty();
        let test = setup();
        let auth = auth::AuthState::new();
        login(&test.state, &auth, true);
        let reply = confirm(&test.state, &auth, input()).unwrap();
        assert_eq!(reply["success"], true);
        let points = crate::recovery::list_recovery_points(&test.state).unwrap();
        let point = points
            .iter()
            .find(|point| point.id == reply["snapshotId"].as_str().unwrap())
            .unwrap();
        let snapshot = Connection::open(&point.snapshot_path).unwrap();
        unknown(&snapshot);
        let conn = test.state.conn.lock().unwrap();
        assert_eq!(
            shifts::require_shift_operating_currency(&conn, "legacy").unwrap(),
            "EUR"
        );
        assert_eq!(
            shifts::recorded_operating_currency(&conn, "cash_drawer_sessions", "drawer").unwrap(),
            Some("EUR".into())
        );
        assert_eq!(
            shifts::recorded_operating_currency(&conn, "orders", "old-order").unwrap(),
            None
        );
        assert_eq!(
            shifts::shift_summary_currency(&conn, "legacy").unwrap(),
            None,
            "aggregate still contains unknown historic money"
        );
        let audit: String = conn
            .query_row(
                "SELECT payload_json FROM recovery_action_log WHERE action_id=?1",
                [ACTION],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!audit.contains("1234"));
        assert!(audit.contains("snapshotId"));
        let original: String = conn
            .query_row(
                "SELECT data FROM parity_sync_queue WHERE record_id='old-order'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&original).unwrap(),
            json!({"id":"old-order","total":6,"currency":null})
        );
        drop(conn);
        drop(snapshot);
        let test = test.restart();
        let auth = auth::AuthState::new();
        login(&test.state, &auth, true);
        assert_eq!(
            confirm(&test.state, &auth, input()).unwrap()["alreadyApplied"],
            true
        );
        let conn = test.state.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM recovery_action_log WHERE action_id=?1",
                [ACTION],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT amount,currency FROM order_payments WHERE id='old-payment'",
                [],
                |row| Ok((row.get::<_, f64>(0)?, row.get::<_, String>(1)?))
            )
            .unwrap(),
            (6.0, "EUR".into())
        );
        assert!(conn
            .execute(
                "UPDATE staff_shifts SET currency='CHF' WHERE id='legacy'",
                []
            )
            .is_err());
    }

    #[test]
    #[serial_test::serial]
    fn legacy_shift_currency_requires_native_auth_fresh_approval_and_explicit_confirmation() {
        let _keyring = fake_keyring::install_empty();
        let test = setup();
        let auth = auth::AuthState::new();
        assert!(confirm(&test.state, &auth, input()).is_err());
        login(&test.state, &auth, false);
        assert!(confirm(&test.state, &auth, input()).is_err());
        login(&test.state, &auth, true);
        assert!(confirm(
            &test.state,
            &auth,
            json!({"shiftId":"legacy","currency":"EUR"})
        )
        .is_err());
        assert!(confirm(
            &test.state,
            &auth,
            json!({"shiftId":"legacy","currency":"CHF","confirmed":true})
        )
        .is_err());
        let conn = test.state.conn.lock().unwrap();
        unknown(&conn);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM recovery_action_log WHERE action_id=?1",
                [ACTION],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    #[serial_test::serial]
    fn legacy_shift_currency_manager_pin_is_verified_and_audited_without_trusting_actor_input() {
        let _keyring = fake_keyring::install_empty();
        let test = setup();
        let auth = auth::AuthState::new();
        login(&test.state, &auth, false);
        {
            let conn = test.state.conn.lock().unwrap();
            let directory = json!({"version":1,"branch_id":"branch-legacy","synced_at":chrono::Utc::now().to_rfc3339(),
                "staff":[{"id":"real-manager","canLoginPos":true,"isActive":true,"hasPin":true,
                    "pinHash":bcrypt::hash("2468",4).unwrap(),"permissions":["pos.orders.cancel"]}]});
            db::set_setting(
                &conn,
                "staff_auth_cache",
                "branch_branch-legacy",
                &directory.to_string(),
            )
            .unwrap();
        }
        let mut request = input();
        request["managerPin"] = json!("9999");
        request["staffId"] = json!("forged-actor");
        assert!(confirm(&test.state, &auth, request.clone()).is_err());
        unknown(&test.state.conn.lock().unwrap());
        request["managerPin"] = json!("2468");
        assert_eq!(
            confirm(&test.state, &auth, request).unwrap()["success"],
            true
        );
        let conn = test.state.conn.lock().unwrap();
        let (actor, payload): (String, String) = conn
            .query_row(
                "SELECT actor_staff_id,payload_json FROM recovery_action_log WHERE action_id=?1",
                [ACTION],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(actor, "real-manager");
        assert!(!payload.contains("2468"));
        assert!(!payload.contains("forged-actor"));
    }

    #[test]
    #[serial_test::serial]
    fn legacy_shift_currency_rejects_foreign_closed_and_non_cashier_shift() {
        let _keyring = fake_keyring::install_empty();
        for mutation in [
            "UPDATE staff_shifts SET terminal_id='elsewhere'",
            "UPDATE staff_shifts SET branch_id='elsewhere'",
            "UPDATE staff_shifts SET role_type='driver'",
            "UPDATE staff_shifts SET status='closed'",
            "UPDATE cash_drawer_sessions SET closed_at='now'",
            "UPDATE cash_drawer_sessions SET cashier_id='elsewhere'",
        ] {
            let test = setup();
            let conn = test.state.conn.lock().unwrap();
            conn.execute_batch(mutation).unwrap();
            assert!(admission(&conn, "legacy").is_err(), "{mutation}");
            unknown(&conn);
        }
    }

    #[test]
    #[serial_test::serial]
    fn legacy_shift_currency_rejects_each_known_conflicting_unit_and_rolls_back_audit_failure() {
        let _keyring = fake_keyring::install_empty();
        for mutation in [
            "UPDATE order_payments SET currency='CHF'",
            "UPDATE orders SET currency='USD'",
            "UPDATE cash_drawer_sessions SET currency='GBP'",
            "UPDATE local_settings SET setting_value='CHF' WHERE setting_key='currency'",
        ] {
            let test = setup();
            let conn = test.state.conn.lock().unwrap();
            conn.execute_batch(mutation).unwrap();
            assert!(admission(&conn, "legacy").is_err(), "{mutation}");
            unknown(&conn);
        }
        let test = setup();
        let conn = test.state.conn.lock().unwrap();
        conn.execute_batch("CREATE TRIGGER fail_currency_audit BEFORE INSERT ON recovery_action_log BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;").unwrap();
        assert!(apply(
            &conn,
            "legacy",
            "EUR",
            "admin",
            "cash_drawer_control",
            "snapshot-test"
        )
        .is_err());
        unknown(&conn);
        assert_eq!(
            shifts::recorded_operating_currency(&conn, "cash_drawer_sessions", "drawer").unwrap(),
            None
        );
    }
}
