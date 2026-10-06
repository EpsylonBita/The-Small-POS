//! Durable, scoped server check snapshots. A parent order is never a check cache.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub(crate) struct Scope {
    pub(crate) organization: String,
    pub(crate) branch: String,
    pub(crate) terminal: String,
    pub(crate) owner: String,
}

pub(crate) fn current_scope(conn: &Connection) -> Result<Scope, String> {
    let setting = |key: &str| {
        crate::db::get_setting(conn, "terminal", key)
            .or_else(|| crate::storage::get_credential(key))
            .filter(|value| !value.trim().is_empty())
    };
    let terminal = crate::terminal_helpers::resolve_canonical_terminal_identity_in_connection(conn)
        .ok_or("Table cache terminal identity is unavailable")?;
    Ok(Scope {
        organization: setting("organization_id")
            .ok_or("Table cache organization is unavailable")?,
        branch: setting("branch_id").ok_or("Table cache branch is unavailable")?,
        owner: setting("owner_terminal_db_id")
            .or_else(|| setting("owner_terminal_id"))
            .or_else(|| setting("parent_terminal_id"))
            .unwrap_or_else(|| terminal.clone()),
        terminal,
    })
}

fn schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS table_session_snapshots_v1 (
        organization_id TEXT NOT NULL, branch_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL, owner_terminal_id TEXT NOT NULL,
        session_id TEXT NOT NULL, snapshot_revision INTEGER NOT NULL,
        captured_at TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        PRIMARY KEY (organization_id, branch_id, terminal_id, owner_terminal_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS table_order_history_v1 (
        organization_id TEXT NOT NULL,branch_id TEXT NOT NULL,owner_terminal_id TEXT NOT NULL,
        order_id TEXT NOT NULL,PRIMARY KEY(organization_id,branch_id,owner_terminal_id,order_id)
    );
    CREATE TABLE IF NOT EXISTS table_cancel_attempts_v1 (
        organization_id TEXT NOT NULL, branch_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
        session_id TEXT NOT NULL, client_event_id TEXT NOT NULL, cancellation_reason TEXT NOT NULL,
        approved_staff_id TEXT,
        PRIMARY KEY (organization_id, branch_id, terminal_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS order_item_edit_attempts_v1 (
        organization_id TEXT NOT NULL, branch_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
        order_id TEXT NOT NULL, request_json TEXT NOT NULL, client_event_id TEXT NOT NULL,
        PRIMARY KEY (organization_id, branch_id, terminal_id, order_id, request_json)
    );",
    )
    .map_err(|error| format!("Table cache schema is unavailable: {error}"))?;
    let has_actor:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('table_cancel_attempts_v1') WHERE name='approved_staff_id')",[],|row|row.get(0))
        .map_err(|error|error.to_string())?;
    if !has_actor {
        conn.execute_batch(
            "ALTER TABLE table_cancel_attempts_v1 ADD COLUMN approved_staff_id TEXT",
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn remember_order_history(conn: &Connection, order: &Value) -> Result<(), String> {
    if order
        .get("has_table_service_history")
        .and_then(Value::as_bool)
        != Some(true)
        && !["table_id", "table_session_id"].iter().any(|key| {
            order
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
        })
    {
        return Ok(());
    }
    let scope = current_scope(conn)?;
    if text(order, "organization_id")? != scope.organization
        || text(order, "branch_id")? != scope.branch
        || text(order, "owner_terminal_id")? != scope.owner
    {
        return Err("Table order history belongs to another owner scope".into());
    }
    remember_order_history_scoped(conn, &scope, text(order, "id")?)
}

fn remember_order_history_scoped(
    conn: &Connection,
    scope: &Scope,
    order_id: &str,
) -> Result<(), String> {
    uuid::Uuid::parse_str(order_id)
        .map_err(|_| "Table order history has no canonical order identity")?;
    schema(conn)?;
    conn.execute("INSERT OR IGNORE INTO table_order_history_v1(organization_id,branch_id,owner_terminal_id,order_id) VALUES (?1,?2,?3,?4)",
        params![scope.organization,scope.branch,scope.owner,order_id]).map_err(|error|error.to_string())?;
    Ok(())
}

pub(crate) fn has_order_history(
    conn: &Connection,
    order_id: &str,
    remote_id: Option<&str>,
    organization: Option<&str>,
    branch: Option<&str>,
    owner: Option<&str>,
) -> Result<bool, String> {
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='table_order_history_v1')",[],|row|row.get(0)).map_err(|error|error.to_string())?;
    if !exists {
        return Ok(false);
    }
    conn.query_row("SELECT EXISTS(SELECT 1 FROM table_order_history_v1 WHERE order_id IN (?1,?2) AND (?3 IS NULL OR organization_id=?3) AND (?4 IS NULL OR branch_id=?4) AND (?5 IS NULL OR owner_terminal_id=?5))",
        params![order_id,remote_id,organization,branch,owner],|row|row.get(0)).map_err(|error|error.to_string())
}

pub(crate) fn existing_item_edit_attempt(
    conn: &Connection,
    order: &str,
    event: &str,
) -> Result<Option<Value>, String> {
    let scope = current_scope(conn)?;
    schema(conn)?;
    let raw:Option<String>=conn.query_row("SELECT request_json FROM order_item_edit_attempts_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND order_id=?4 AND client_event_id=?5 LIMIT 1",params![scope.organization,scope.branch,scope.terminal,order,event],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|raw| {
        let mut request: Value =
            serde_json::from_str(&raw).map_err(|_| "Original edit request is unavailable")?;
        request["client_event_id"] = json!(event);
        Ok(request)
    })
    .transpose()
}

pub(crate) fn item_edit_attempt(
    conn: &Connection,
    order_id: &str,
    request: &mut Value,
) -> Result<(), String> {
    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    item_edit_attempt_inner(&transaction, order_id, request)?;
    crate::table_attempt_recovery::remember_item(&transaction, order_id, request)?;
    transaction.commit().map_err(|error| error.to_string())
}

fn item_edit_attempt_inner(
    conn: &Connection,
    order_id: &str,
    request: &mut Value,
) -> Result<(), String> {
    let scope = current_scope(conn)?;
    schema(conn)?;
    let requested = request
        .as_object_mut()
        .ok_or("Invalid canonical order edit")?
        .remove("client_event_id");
    let raw = request.to_string();
    let previous:Option<String>=conn.query_row("SELECT client_event_id FROM order_item_edit_attempts_v1
        WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND order_id=?4 AND request_json=?5",
        params![scope.organization,scope.branch,scope.terminal,order_id,raw],|row|row.get(0)).optional()
        .map_err(|error|format!("Read stable order item edit: {error}"))?;
    let event = previous.unwrap_or_else(|| {
        requested
            .and_then(|id| id.as_str().map(ToString::to_string))
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    });
    conn.execute("INSERT OR IGNORE INTO order_item_edit_attempts_v1 (organization_id,branch_id,terminal_id,order_id,request_json,client_event_id)
        VALUES (?1,?2,?3,?4,?5,?6)",params![scope.organization,scope.branch,scope.terminal,order_id,raw,event])
        .map_err(|error|format!("Persist stable order item edit: {error}"))?;
    request["client_event_id"] = json!(event);
    Ok(())
}

/// Only event intent and its original actor are durable. PINs and approval tokens are
/// obtained again on reconnect and never enter this SQLite store.
pub(crate) fn cancellation_attempt(
    conn: &Connection,
    local_order_id: &str,
    session_id: &str,
    reason: &str,
    approved_staff_id: &str,
    requested: Option<&str>,
) -> Result<String, String> {
    let scope = current_scope(conn)?;
    schema(conn)?;
    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let event = cancellation_attempt_scoped(
        &transaction,
        &scope,
        session_id,
        reason,
        approved_staff_id,
        requested,
    )?;
    crate::table_attempt_recovery::remember_cancel(
        &transaction,
        local_order_id,
        session_id,
        &event,
        reason,
        approved_staff_id,
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(event)
}

/// The check's saved cancellation attempt (its event, reason and approver).
///
/// Only an attempt that may have applied money pins its original identity:
/// its frozen return is resumed with the same event, reason and approver,
/// never replaced. A reason-only attempt replays under its event with the
/// same approval, and otherwise gives way to a new event; so does an attempt
/// whose server refusal is proven (review 06/10/2026). A frozen return always
/// travels under its own event, so the request sent is the one saved.
fn cancellation_attempt_scoped(
    conn: &Connection,
    scope: &Scope,
    session_id: &str,
    reason: &str,
    approved_staff_id: &str,
    requested: Option<&str>,
) -> Result<String, String> {
    use crate::table_manual_cancellation::{event_money_state, EventMoneyState};
    let requested = requested.map(str::trim).filter(|s| !s.is_empty());
    let previous: Option<(String,String,Option<String>)> = conn.query_row("SELECT client_event_id,cancellation_reason,approved_staff_id FROM table_cancel_attempts_v1
        WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND session_id=?4",
        params![scope.organization,scope.branch,scope.terminal,session_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))
        .optional().map_err(|error| format!("Read cancellation attempt: {error}"))?;
    let new_event = || {
        requested
            .map(ToString::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    };
    let Some((event, previous_reason, previous_actor)) = previous else {
        let event = new_event();
        conn.execute("INSERT INTO table_cancel_attempts_v1 (organization_id,branch_id,terminal_id,session_id,client_event_id,cancellation_reason,approved_staff_id)
            VALUES (?1,?2,?3,?4,?5,?6,?7)",params![scope.organization,scope.branch,scope.terminal,session_id,event,reason,approved_staff_id])
            .map_err(|error| format!("Save cancellation attempt: {error}"))?;
        return Ok(event);
    };
    let same_approval =
        previous_actor.as_deref() == Some(approved_staff_id) && previous_reason == reason;
    let requested_state = match requested {
        Some(id) if id != event => event_money_state(conn, &scope.organization, &scope.branch, id)?,
        _ => EventMoneyState::None,
    };
    let replacement = match event_money_state(conn, &scope.organization, &scope.branch, &event)? {
        EventMoneyState::Unresolved | EventMoneyState::Applied => {
            if requested.is_some_and(|id| id != event) {
                return Err("TABLE_CANCELLATION_PENDING: A cancellation of this check is saved and may already be recorded. Resume it with its original reason and approver, or ask a manager to clear it. The table was not released.".into());
            }
            if previous_actor.as_deref() != Some(approved_staff_id) {
                return Err("ORIGINAL_CANCEL_APPROVER_REQUIRED: A cancellation attempt is pending. Its original approving staff member must retry after reconnecting. The table was not released.".into());
            }
            if previous_reason != reason {
                return Err("A cancellation attempt is pending. Retry with its original reason after reconnecting.".into());
            }
            return Ok(event);
        }
        EventMoneyState::Refused => {
            if requested == Some(event.as_str()) {
                return Err(format!(
                    "{}: this cancellation was refused by the server and is not sent again. A manager can clear it.",
                    crate::table_manual_cancellation::REFUSED
                ));
            }
            new_event()
        }
        EventMoneyState::None => {
            // A new frozen return must travel under its own event; a plain
            // retry with the same approval replays the saved one.
            if same_approval && requested_state == EventMoneyState::None {
                return Ok(event);
            }
            match requested {
                Some(id) if id != event => id.to_string(),
                _ => uuid::Uuid::new_v4().to_string(),
            }
        }
    };
    conn.execute("UPDATE table_cancel_attempts_v1 SET client_event_id=?1,cancellation_reason=?2,approved_staff_id=?3
        WHERE organization_id=?4 AND branch_id=?5 AND terminal_id=?6 AND session_id=?7 AND client_event_id=?8",
        params![replacement,reason,approved_staff_id,scope.organization,scope.branch,scope.terminal,session_id,event])
        .map_err(|error| format!("Save cancellation attempt: {error}"))?;
    Ok(replacement)
}

pub(crate) fn invalidate(conn: &Connection, session_ids: &[Value]) -> Result<(), String> {
    let scope = current_scope(conn)?;
    schema(conn)?;
    for id in session_ids.iter().filter_map(Value::as_str) {
        conn.execute("DELETE FROM table_session_snapshots_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3
            AND owner_terminal_id=?4 AND session_id=?5",params![scope.organization,scope.branch,scope.terminal,scope.owner,id])
            .map_err(|error| format!("Invalidate released table check: {error}"))?;
    }
    Ok(())
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing table snapshot {key}"))
}

fn number(value: &Value, key: &str) -> Result<f64, String> {
    value
        .get(key)
        .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))
        .filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or_else(|| format!("Invalid table snapshot {key}"))
}

fn validate(scope: &Scope, session: &Value) -> Result<i64, String> {
    uuid::Uuid::parse_str(text(session, "id")?)
        .map_err(|_| "Invalid table snapshot session identity")?;
    if text(session, "organization_id")? != scope.organization
        || text(session, "branch_id")? != scope.branch
    {
        return Err("Table snapshot belongs to another organization or branch".into());
    }
    let revision = session
        .get("snapshot_revision")
        .and_then(Value::as_i64)
        .filter(|n| *n >= 0)
        .ok_or("Missing table snapshot revision")?;
    let order = session
        .get("order")
        .ok_or("Missing scoped table snapshot order")?;
    if text(order, "owner_terminal_id")? != scope.owner {
        return Err("Table snapshot belongs to another owner terminal".into());
    }
    let order_id = text(order, "id")?;
    if text(session, "active_order_id")? != order_id {
        return Err("Table snapshot active order identity changed".into());
    }
    let balance = session
        .get("balance")
        .ok_or("Missing scoped table snapshot balance")?;
    for key in [
        "order_total",
        "paid_total",
        "outstanding_balance",
        "tip_total",
    ] {
        number(balance, key)?;
    }
    order
        .get("order_items")
        .and_then(Value::as_array)
        .ok_or("Missing scoped table snapshot lines")?;
    let allocations = session
        .get("items")
        .and_then(Value::as_array)
        .ok_or("Missing table allocations")?;
    for allocation in allocations {
        if text(allocation, "table_session_id")? != text(session, "id")?
            || text(allocation, "organization_id")? != scope.organization
            || text(allocation, "branch_id")? != scope.branch
        {
            return Err("Table allocation scope mismatch".into());
        }
        let quantity = number(allocation, "quantity")?;
        if number(allocation, "paid_quantity")? > quantity + 0.0005 {
            return Err("Table allocation paid quantity is invalid".into());
        }
    }
    session
        .get("payments")
        .and_then(Value::as_array)
        .ok_or("Missing scoped table payment ledger")?;
    session
        .get("tables")
        .and_then(Value::as_array)
        .ok_or("Missing table links")?;
    Ok(revision)
}

pub(crate) fn save(conn: &Connection, session: &Value) -> Result<bool, String> {
    let scope = current_scope(conn)?;
    save_scoped(conn, &scope, session)
}

fn save_scoped(conn: &Connection, scope: &Scope, session: &Value) -> Result<bool, String> {
    let revision = validate(scope, session)?;
    remember_order_history_scoped(conn, scope, text(session, "active_order_id")?)?;
    for allocation in session["items"].as_array().unwrap() {
        if let Some(order_id) = allocation.get("order_id").and_then(Value::as_str) {
            remember_order_history_scoped(conn, scope, order_id)?;
        }
    }
    schema(conn)?;
    let mut cached_session = session.clone();
    // Audit events are not required to read a check and may carry a consumed
    // approval proof. Keep financial scope, never persist that proof here.
    if let Some(object) = cached_session.as_object_mut() {
        object.remove("events");
    }
    let changed = conn.execute("INSERT INTO table_session_snapshots_v1
        (organization_id, branch_id, terminal_id, owner_terminal_id, session_id, snapshot_revision, captured_at, snapshot_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT (organization_id, branch_id, terminal_id, owner_terminal_id, session_id)
        DO UPDATE SET snapshot_revision=excluded.snapshot_revision, captured_at=excluded.captured_at,
        snapshot_json=excluded.snapshot_json WHERE excluded.snapshot_revision >= table_session_snapshots_v1.snapshot_revision",
        params![scope.organization, scope.branch, scope.terminal, scope.owner, text(session,"id")?, revision,
            chrono::Utc::now().to_rfc3339(), cached_session.to_string()])
        .map_err(|error| format!("Save scoped table snapshot: {error}"))?;
    Ok(changed > 0)
}

pub(crate) fn load(conn: &Connection, request: &Value) -> Result<Value, String> {
    let scope = current_scope(conn)?;
    load_scoped(conn, &scope, request)
}

fn load_scoped(conn: &Connection, scope: &Scope, request: &Value) -> Result<Value, String> {
    schema(conn)?;
    let session_id = text(request, "sessionId")?;
    let row: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT snapshot_json, captured_at, snapshot_revision
        FROM table_session_snapshots_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3
        AND owner_terminal_id=?4 AND session_id=?5",
            params![
                scope.organization,
                scope.branch,
                scope.terminal,
                scope.owner,
                session_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| format!("Read scoped table snapshot: {error}"))?;
    let (raw, captured_at, revision) = row.ok_or("No scoped saved table check is available")?;
    let session: Value =
        serde_json::from_str(&raw).map_err(|_| "Saved table check is unreadable")?;
    if validate(scope, &session)? != revision || text(&session, "id")? != session_id {
        return Err("Saved table check revision or identity is invalid".into());
    }
    if let Some(order_id) = request
        .get("orderId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        if text(&session, "active_order_id")? != order_id {
            return Err("Saved table order identity changed".into());
        }
    }
    let table_id = text(request, "tableId")?;
    let linked = session
        .get("tables")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .any(|link| {
            link.get("table_id").and_then(Value::as_str) == Some(table_id)
                && link.get("released_at").map_or(true, Value::is_null)
        });
    if !linked
        || !matches!(
            session.get("status").and_then(Value::as_str),
            Some("open" | "partially_paid" | "settled")
        )
    {
        return Err("Saved table check is released or belongs to another table".into());
    }
    Ok(json!({"success":true,"stale":true,"capturedAt":captured_at,"session":session}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope() -> Scope {
        Scope {
            organization: "org".into(),
            branch: "branch".into(),
            terminal: "terminal".into(),
            owner: "owner".into(),
        }
    }
    fn snapshot(revision: i64) -> Value {
        json!({"id":"11111111-1111-4111-8111-111111111111",
        "organization_id":"org","branch_id":"branch","active_order_id":"22222222-2222-4222-8222-222222222222","status":"partially_paid","snapshot_revision":revision,
        "order":{"id":"22222222-2222-4222-8222-222222222222","owner_terminal_id":"owner","order_items":[{"id":"line","quantity":1}]},
        "items":[{"table_session_id":"11111111-1111-4111-8111-111111111111","organization_id":"org","branch_id":"branch","quantity":1,"paid_quantity":0.5}],
        "payments":[{"id":"receipt","amount":5}],"balance":{"order_total":10,"paid_total":5,"tip_total":0,"outstanding_balance":5},
        "tables":[{"table_id":"target","released_at":null}]})
    }
    fn request() -> Value {
        json!({"sessionId":"11111111-1111-4111-8111-111111111111","tableId":"target","orderId":"22222222-2222-4222-8222-222222222222"})
    }
    #[test]
    fn cancellation_retry_keeps_event_and_original_actor_without_approval_secrets() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        let first = cancellation_attempt_scoped(
            &conn,
            &scope(),
            "session",
            "customer left",
            "staff-a",
            Some("original-event"),
        )
        .unwrap();
        assert_eq!(
            cancellation_attempt_scoped(
                &conn,
                &scope(),
                "session",
                "customer left",
                "staff-a",
                Some("new-event")
            )
            .unwrap(),
            first
        );
        // Review 06/10/2026: a reason-only attempt (no money can move) never
        // locks the check. Another approver or another reason starts a new
        // event instead of ORIGINAL_CANCEL_APPROVER_REQUIRED forever.
        let second = cancellation_attempt_scoped(
            &conn,
            &scope(),
            "session",
            "customer left",
            "staff-b",
            None,
        )
        .unwrap();
        assert_ne!(second, first);
        let third = cancellation_attempt_scoped(
            &conn,
            &scope(),
            "session",
            "different reason",
            "staff-b",
            None,
        )
        .unwrap();
        assert_ne!(third, second);
        let actor: String = conn
            .query_row(
                "SELECT approved_staff_id FROM table_cancel_attempts_v1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(actor, "staff-b");
        let sensitive_columns:i64=conn.query_row("SELECT COUNT(*) FROM pragma_table_info('table_cancel_attempts_v1') WHERE name IN ('pin','manager_pin','approval_token')",[],|row|row.get(0)).unwrap();
        assert_eq!(sensitive_columns, 0);
    }

    /// A frozen table return under `event`: `outcome` NULL while its server
    /// outcome may be unknown, `refused` once a refusal is proven.
    fn frozen_return(conn: &Connection, event: &str, outcome: Option<&str>) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS table_manual_cancel_intents_v1 (
              organization_id TEXT NOT NULL,branch_id TEXT NOT NULL,terminal_id TEXT NOT NULL,
              event_id TEXT NOT NULL,order_id TEXT NOT NULL,session_id TEXT NOT NULL,
              generation TEXT NOT NULL,channel TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,
              request_json TEXT NOT NULL,applied INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
              dispatch_count INTEGER,last_dispatch_at TEXT,outcome TEXT,refusal_code TEXT,resolved_at TEXT,resolved_by TEXT,
              PRIMARY KEY(organization_id,branch_id,terminal_id,event_id));",
        )
        .unwrap();
        conn.execute("INSERT INTO table_manual_cancel_intents_v1(organization_id,branch_id,terminal_id,event_id,order_id,session_id,generation,channel,reason,actor,request_json,created_at,dispatch_count,outcome)
            VALUES('org','branch','terminal',?1,'order','session','g','bank','customer left','staff-a','{}','now',1,?2)",params![event,outcome]).unwrap();
    }

    #[test]
    fn a_saved_return_that_may_have_applied_money_keeps_its_original_identity() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        frozen_return(&conn, "money-event", None);
        assert_eq!(
            cancellation_attempt_scoped(
                &conn,
                &scope(),
                "session",
                "customer left",
                "staff-a",
                Some("money-event")
            )
            .unwrap(),
            "money-event"
        );
        assert!(cancellation_attempt_scoped(
            &conn,
            &scope(),
            "session",
            "customer left",
            "staff-b",
            None
        )
        .unwrap_err()
        .contains("ORIGINAL_CANCEL_APPROVER_REQUIRED"));
        assert!(cancellation_attempt_scoped(
            &conn,
            &scope(),
            "session",
            "other reason",
            "staff-a",
            None
        )
        .is_err());
        assert!(cancellation_attempt_scoped(
            &conn,
            &scope(),
            "session",
            "customer left",
            "staff-a",
            Some("new-event")
        )
        .unwrap_err()
        .contains("TABLE_CANCELLATION_PENDING"));
        // A proven refusal releases the check for a new approver and event.
        conn.execute(
            "UPDATE table_manual_cancel_intents_v1 SET outcome='released'",
            [],
        )
        .unwrap();
        assert_eq!(
            cancellation_attempt_scoped(
                &conn,
                &scope(),
                "session",
                "customer left",
                "staff-b",
                Some("new-event")
            )
            .unwrap(),
            "new-event"
        );
    }

    #[test]
    fn a_frozen_return_travels_under_its_own_event_not_an_older_attempt() {
        // Symptom: a refund frozen under a new event was sent as the older
        // attempt's plain request, refused, and left orphaned (applied=0),
        // holding every manual table cancellation in the branch.
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        assert_eq!(
            cancellation_attempt_scoped(
                &conn,
                &scope(),
                "session",
                "customer left",
                "staff-a",
                Some("plain-event")
            )
            .unwrap(),
            "plain-event"
        );
        frozen_return(&conn, "money-event", None);
        assert_eq!(
            cancellation_attempt_scoped(
                &conn,
                &scope(),
                "session",
                "customer left",
                "staff-a",
                Some("money-event")
            )
            .unwrap(),
            "money-event"
        );
        let saved: String = conn
            .query_row(
                "SELECT client_event_id FROM table_cancel_attempts_v1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(saved, "money-event");
        // A refused saved return is never resumed under its event.
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn).unwrap();
        frozen_return(&conn, "refused-event", Some("refused"));
        cancellation_attempt_scoped(
            &conn,
            &scope(),
            "session",
            "customer left",
            "staff-a",
            Some("refused-event"),
        )
        .unwrap();
        assert!(cancellation_attempt_scoped(
            &conn,
            &scope(),
            "session",
            "customer left",
            "staff-a",
            Some("refused-event")
        )
        .unwrap_err()
        .contains("TABLE_CANCELLATION_REFUSED"));
    }
    #[test]
    fn durable_cache_keeps_scoped_lines_and_ledger_and_rejects_old_revision() {
        let conn = Connection::open_in_memory().unwrap();
        save_scoped(&conn, &scope(), &snapshot(2)).unwrap();
        let mut older = snapshot(1);
        older["balance"]["paid_total"] = json!(0);
        assert!(!save_scoped(&conn, &scope(), &older).unwrap());
        let cached = load_scoped(&conn, &scope(), &request()).unwrap();
        assert_eq!(cached["session"]["balance"]["paid_total"], json!(5));
        assert_eq!(
            cached["session"]["order"]["order_items"][0]["quantity"],
            json!(1)
        );
        assert_eq!(cached["stale"], json!(true));
    }
    #[test]
    fn history_survives_check_cache_invalidation_and_is_owner_scoped() {
        let conn = Connection::open_in_memory().unwrap();
        save_scoped(&conn, &scope(), &snapshot(2)).unwrap();
        conn.execute("DELETE FROM table_session_snapshots_v1", [])
            .unwrap();
        let order = "22222222-2222-4222-8222-222222222222";
        assert!(has_order_history(
            &conn,
            order,
            None,
            Some("org"),
            Some("branch"),
            Some("owner")
        )
        .unwrap());
        assert!(!has_order_history(
            &conn,
            order,
            None,
            Some("org"),
            Some("branch"),
            Some("other-owner")
        )
        .unwrap());
    }
    #[test]
    fn cache_refuses_foreign_branch_owner_changed_order_or_released_table() {
        let conn = Connection::open_in_memory().unwrap();
        save_scoped(&conn, &scope(), &snapshot(2)).unwrap();
        let mut foreign = scope();
        foreign.branch = "elsewhere".into();
        assert!(load_scoped(&conn, &foreign, &request()).is_err());
        foreign = scope();
        foreign.owner = "other".into();
        assert!(load_scoped(&conn, &foreign, &request()).is_err());
        let mut changed = request();
        changed["orderId"] = json!("new-order");
        assert!(load_scoped(&conn, &scope(), &changed).is_err());
        changed = request();
        changed["tableId"] = json!("source");
        assert!(load_scoped(&conn, &scope(), &changed).is_err());
    }
    #[test]
    fn cache_refuses_missing_revision_and_paid_scope_corruption() {
        let conn = Connection::open_in_memory().unwrap();
        let mut invalid = snapshot(2);
        invalid.as_object_mut().unwrap().remove("snapshot_revision");
        assert!(save_scoped(&conn, &scope(), &invalid).is_err());
        invalid = snapshot(2);
        invalid["items"][0]["paid_quantity"] = json!(2);
        assert!(save_scoped(&conn, &scope(), &invalid).is_err());
    }
}
