//! Confirmed calls that first obtain an authoritative server answer. HTTP never
//! runs inside a business transaction or while holding the checkout mutex.
use super::{
    clock,
    contracts::Command,
    critical_op::SupportPermit,
    guards::{self, Scope},
    snapshot,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};

pub(super) enum Prepared {
    Order(Value),
    Shift {
        server: String,
        drawer: Option<String>,
    },
}
pub(super) fn handles(c: &Command) -> bool {
    matches!(
        c.payload["action"]["action_id"].as_str(),
        Some("shift.void_empty.v1" | "order.adopt_server_state.v1")
    )
}
pub(super) fn failure(code: String) -> String {
    if super::evidence::DETAILS.contains(&code.as_str()) {
        format!("POLICY_REFUSED|{code}")
    } else {
        code
    }
}
fn void_server_error(error: crate::api::AdminFetchError) -> String {
    if let Some(code) = error
        .code()
        .filter(|c| ["SHIFT_NOT_EMPTY", "SHIFT_NOT_ACTIVE", "SHIFT_SCOPE_DENIED"].contains(c))
    {
        return code.into();
    }
    // A transport, timeout, unreadable reply or 5xx can follow a committed
    // delete. Only an explicit client refusal proves the request was refused.
    if error
        .status()
        .is_some_and(|s| (400..500).contains(&s) && s != 408)
    {
        "SERVER_UNAVAILABLE".into()
    } else {
        "OUTCOME_UNKNOWN".into()
    }
}
fn row(c: &Connection, table: &str, id: &str) -> Result<Value, String> {
    guards::rows(
        c,
        &format!("SELECT * FROM {} WHERE id=?", super::replica::quote(table)),
        &[id.to_string().into()],
    )?
    .into_iter()
    .next()
    .ok_or("PROTECTED_RECORD".into())
}
fn order_scope(c: &Connection, id: &str, scope: &Scope) -> Result<String, String> {
    let (local, _, org, _) = crate::order_state::resolve(c, id)?;
    let r = row(c, "orders", &local)?;
    if org != scope.organization_id || r["branch_id"] != scope.branch_id {
        return Err("PROTECTED_RECORD".into());
    }
    Ok(local)
}

/// Windows check-in writes staff_shifts, cash_drawer_sessions and the parity
/// shift_open row. It writes no attendance/time-clock row or staff login record.
/// Cashier handoff can also claim other staff shifts: that is activity and blocks
/// the void. All schema links are inspected, including future movement tables.
pub(crate) fn empty_shift(
    c: &Connection,
    id: &str,
    scope: &Scope,
) -> Result<Option<String>, String> {
    let r = row(c, "staff_shifts", id).map_err(|_| "SHIFT_NOT_FOUND")?;
    if r["branch_id"] != scope.branch_id
        || r["terminal_id"] != scope.terminal_id
        || super::identity::local(c)? != *scope
    {
        return Err("SHIFT_SCOPE_DENIED".into());
    }
    if r["status"] != "active" {
        return Err("SHIFT_NOT_ACTIVE".into());
    }
    super::confirmed_sql::no_submitted_close(c, id).map_err(|_| "SHIFT_COVERED_BY_CLOSEOUT")?;
    if crate::shifts::gift_opening_key_for_shift(c, id)?.is_some() {
        return Err("SHIFT_HAS_FISCAL_ACTIVITY".into());
    }
    for (key, value) in r.as_object().ok_or("POLICY_REFUSED")? {
        if (key.starts_with("total_")
            || key.starts_with("repair_") && (key.contains("sales") || key.contains("count"))
            || ["payment_amount", "is_transfer_pending"].contains(&key.as_str()))
            && value.as_f64().is_some_and(|n| n != 0.0)
        {
            return Err("SHIFT_NOT_EMPTY".into());
        }
    }
    // A zero-float driver/server is assigned a responsible cashier by the
    // check-in itself. Borrowed starting cash is a movement; the initial
    // zero-cash ownership link alone is not one.
    if matches!(r["role_type"].as_str(), Some("driver" | "server"))
        && (r["opening_cash_amount"].as_f64().is_some_and(|n| n != 0.0)
            || r["opening_cash_amount_cents"]
                .as_i64()
                .is_some_and(|n| n != 0))
    {
        return Err("SHIFT_NOT_EMPTY".into());
    }
    if !matches!(r["role_type"].as_str(), Some("driver" | "server"))
        && r["transferred_to_cashier_shift_id"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    {
        return Err("SHIFT_NOT_EMPTY".into());
    }
    let drawers = guards::rows(
        c,
        "SELECT * FROM cash_drawer_sessions WHERE staff_shift_id=?",
        &[id.to_string().into()],
    )?;
    if drawers.len() > 1 {
        return Err("SHIFT_DRAWER_NOT_EXCLUSIVE".into());
    }
    let drawer = drawers
        .first()
        .and_then(|d| d["id"].as_str())
        .map(str::to_string);
    if let Some(d) = drawers.first() {
        if !d["closed_at"].is_null()
            || d["branch_id"] != scope.branch_id
            || d["terminal_id"] != scope.terminal_id
            || d["staff_shift_id"] != id
        {
            return Err("SHIFT_DRAWER_NOT_OPEN".into());
        }
        if !d["closing_amount"].is_null()
            || !d["reconciled_at"].is_null()
            || d["cashier_id"] != r["staff_id"]
            || d["opening_amount_cents"] != r["opening_cash_amount_cents"]
        {
            return Err("SHIFT_DRAWER_NOT_OPEN".into());
        }
        for (key, value) in d.as_object().ok_or("POLICY_REFUSED")? {
            if (key.starts_with("total_")
                || key.starts_with("cash_drop")
                || key.starts_with("driver_cash_")
                || key.starts_with("closing_")
                || key.starts_with("variance_")
                || key == "reconciled")
                && value.as_f64().is_some_and(|n| n != 0.0)
            {
                return Err("SHIFT_NOT_EMPTY".into());
            }
        }
    }
    for t in guards::schema(c)? {
        if ["cash_drawer_sessions", "parity_sync_queue", "sync_queue"].contains(&t.name.as_str()) {
            continue;
        }
        let mut clauses = Vec::new();
        for col in &t.columns {
            if col == "shift_id" || col.ends_with("_shift_id") {
                clauses.push(format!("{}=?1", super::replica::quote(col)));
            }
            if col == "drawer_session_id" || col == "cash_drawer_session_id" {
                clauses.push(format!("{}=?2", super::replica::quote(col)));
            }
        }
        if t.columns.iter().any(|k| k == "entity_id") && t.name != "support_txn_marker" {
            clauses.push("entity_id IN (?1,?2)".into());
        }
        if clauses.is_empty() {
            continue;
        }
        let found: bool = c
            .query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM {} WHERE ({}) AND ?2 IS ?2)",
                    super::replica::quote(&t.name),
                    clauses.join(" OR ")
                ),
                params![id, drawer],
                |r| r.get(0),
            )
            .map_err(guards::error)?;
        if found {
            return Err(if t.name.contains("fiscal") || t.name.contains("ecr") {
                "SHIFT_HAS_FISCAL_ACTIVITY"
            } else {
                "SHIFT_NOT_EMPTY"
            }
            .into());
        }
    }
    // An own queue record can be removed only if it is the check-in itself.
    let qs = guards::rows(
        c,
        "SELECT * FROM parity_sync_queue WHERE record_id IN (?1,?2)",
        &[
            id.to_string().into(),
            drawer
                .clone()
                .map(Into::into)
                .unwrap_or(rusqlite::types::Value::Null),
        ],
    )?;
    for q in qs {
        let p: Value = serde_json::from_str(q["data"].as_str().ok_or("SHIFT_HAS_LOCAL_WORK")?)
            .map_err(|_| "SHIFT_HAS_LOCAL_WORK")?;
        if q["organization_id"] != scope.organization_id
            || q["status"] == "processing"
            || q["operation"] != "INSERT"
            || q["table_name"] != "staff_shifts"
            || q["module_type"] != "shifts"
            || p["shiftId"] != id
            || p["branchId"] != scope.branch_id
            || p["terminalId"] != scope.terminal_id
            || p["checkInTime"] != r["check_in_time"]
            || !p.as_object().is_some_and(|p| {
                p.keys().all(|k| {
                    matches!(
                        k.as_str(),
                        "shiftId"
                            | "staffId"
                            | "staffName"
                            | "branchId"
                            | "terminalId"
                            | "roleType"
                            | "openingCash"
                            | "opening_cash_cents"
                            | "checkInTime"
                            | "reportDate"
                            | "periodStartAt"
                            | "calculationVersion"
                            | "isDayStart"
                            | "currency"
                            | "offline_check_in"
                            | "ordinary_opening_offline"
                    )
                })
            })
        {
            return Err("SHIFT_HAS_LOCAL_WORK".into());
        }
        let marked: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM parity_sync_set_aside WHERE queue_id=?1)",
                [q["id"].as_str().ok_or("SHIFT_HAS_LOCAL_WORK")?],
                |r| r.get(0),
            )
            .map_err(guards::error)?;
        if marked {
            return Err("SHIFT_HAS_LOCAL_WORK".into());
        }
    }
    let legacy: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_queue WHERE entity_id IN (?1,?2))",
            params![id, drawer],
            |r| r.get(0),
        )
        .map_err(guards::error)?;
    if legacy {
        return Err("SHIFT_HAS_LOCAL_WORK".into());
    }
    for (table, record, payload) in [
        ("parity_sync_queue", "record_id", "data"),
        ("sync_queue", "entity_id", "payload"),
    ] {
        let linked:bool=c.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} q WHERE q.{record}<>?1 AND (?2 IS NULL OR q.{record}<>?2) AND EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(q.{payload}) THEN q.{payload} ELSE '{{}}' END) j WHERE j.type='text' AND j.value IN (?1,?2)))"),params![id,drawer],|r|r.get(0)).map_err(guards::error)?;
        if linked {
            return Err("SHIFT_HAS_LOCAL_WORK".into());
        }
    }
    Ok(drawer)
}

pub(super) fn prepare(
    app: &tauri::AppHandle,
    c: &Command,
    live: &Path,
    scope: &Scope,
    permit: &SupportPermit,
) -> Result<Prepared, String> {
    use tauri::Manager;
    let input = &c.payload["action"]["inputs"];
    let shift = c.payload["action"]["action_id"] == "shift.void_empty.v1";
    let id = input[if shift { "shift_id" } else { "order_id" }]
        .as_str()
        .ok_or("INVALID_INPUT")?;
    uuid::Uuid::parse_str(id).map_err(|_| "INVALID_INPUT")?;
    let db =
        super::replica::read_connection(live, permit, Instant::now() + Duration::from_secs(2))?;
    let drawer = if shift {
        empty_shift(&db, id, scope)?
    } else {
        let local = order_scope(&db, id, scope)?;
        crate::order_state::eligible(&db, &local, true)?;
        None
    };
    if shift {
        let cap = c.payload["rows_cap"]
            .as_u64()
            .filter(|n| (1..=50).contains(n))
            .ok_or("INVALID_INPUT")?;
        let queued: u64 = db
            .query_row(
                "SELECT count(*) FROM parity_sync_queue WHERE record_id IN (?1,?2)",
                params![id, drawer],
                |r| r.get(0),
            )
            .map_err(guards::error)?;
        if 1 + u64::from(drawer.is_some()) + queued > cap {
            return Err("POLICY_REFUSED".into());
        }
    }
    let remote = if shift {
        String::new()
    } else {
        crate::order_state::resolve(&db, id)?.1
    };
    drop(db);
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    let state = app.state::<crate::db::DbState>();
    let result = tauri::async_runtime::block_on(async {
        let (base, key) = crate::resolve_admin_endpoint(Some(&state))
            .await
            .map_err(|_| "SERVER_UNAVAILABLE")?;
        if shift {
            let reply=crate::api::fetch_from_admin_detailed_with_timeout(&base,&key,"/api/pos/shifts/void-empty","POST",Some(json!({"shift_id":id,"drawer_session_id":drawer,"reason":"support_founder_confirmed"})),Duration::from_secs(5)).await
                .map_err(void_server_error)?;
            if reply["success"] != true
                || !matches!(
                    reply["outcome"].as_str(),
                    Some("deleted" | "already_absent")
                )
            {
                return Err("OUTCOME_UNKNOWN".into());
            }
            Ok(Prepared::Shift {
                server: reply["outcome"].as_str().unwrap_or("").into(),
                drawer,
            })
        } else {
            crate::order_state::fetch(&base, &key, &remote)
                .await
                .map(Prepared::Order)
        }
    });
    if permit.is_cancelled() {
        return Err(if matches!(result, Ok(Prepared::Shift { .. }))
            || matches!(&result,Err(code) if code=="OUTCOME_UNKNOWN")
        {
            "OUTCOME_UNKNOWN"
        } else {
            "PREEMPTED_BY_CRITICAL_OPERATION"
        }
        .into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn void_preserves_server_refusals_and_reports_ambiguous_writes_as_unknown() {
        for (status, code) in [
            (409, "SHIFT_NOT_EMPTY"),
            (409, "SHIFT_NOT_ACTIVE"),
            (403, "SHIFT_SCOPE_DENIED"),
        ] {
            let e = crate::api::AdminFetchError::from_http_response_for_test(
                status,
                &json!({"success":false,"code":code,"error":"refused"}).to_string(),
            );
            assert_eq!(void_server_error(e), code);
        }
        assert_eq!(
            void_server_error(crate::api::AdminFetchError::transport(
                "reply lost after send"
            )),
            "OUTCOME_UNKNOWN"
        );
        assert_eq!(
            void_server_error(crate::api::AdminFetchError::with_status(
                "reply unknown",
                500
            )),
            "OUTCOME_UNKNOWN"
        );
        assert_eq!(
            void_server_error(crate::api::AdminFetchError::with_status(
                "request timed out",
                408
            )),
            "OUTCOME_UNKNOWN"
        );
        assert_eq!(
            void_server_error(crate::api::AdminFetchError::with_status(
                "request refused",
                429
            )),
            "SERVER_UNAVAILABLE"
        );
    }
}

pub(super) fn run(
    store: &Connection,
    live: &Path,
    c: &Command,
    scope: &Scope,
    now: i64,
    permit: &SupportPermit,
    snap: &snapshot::Snapshot,
    prepared: Prepared,
    recheck: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let cap = c.payload["rows_cap"]
        .as_u64()
        .filter(|n| (1..=50).contains(n))
        .ok_or("INVALID_INPUT")?;
    let conn = Connection::open_with_flags(
        live,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(guards::error)?;
    conn.execute_batch("PRAGMA foreign_keys=ON")
        .map_err(guards::error)?;
    let effects = super::confirmed_actions::Effects::install(&conn);
    let start = Instant::now();
    let tx = permit.begin_write(&conn)?;
    let schema = guards::schema(&conn)?;
    recheck()?;
    if super::identity::local(&conn)? != *scope
        || snapshot::full_for_write(&conn, &schema, permit, start + Duration::from_millis(250))?
            != snap.full
    {
        return Err("PAYLOAD_DRIFT".into());
    }
    let input = &c.payload["action"]["inputs"];
    let expected_order = match &prepared {
        Prepared::Order(server) => Some(server.clone()),
        _ => None,
    };
    let (evidence, undo, affected) = match prepared {
        Prepared::Order(server) => {
            let id = input["order_id"].as_str().ok_or("INVALID_INPUT")?;
            let local = order_scope(&conn, id, scope)?;
            let evidence = crate::order_state::adopt(&conn, &local, &server, true)?;
            (
                evidence,
                json!({"kind":"snapshot","reference":snap.id,"reason":"Restores the till copy only; the server is unchanged."}),
                vec![local],
            )
        }
        Prepared::Shift { server, drawer } => {
            let id = input["shift_id"].as_str().ok_or("INVALID_INPUT")?;
            if empty_shift(&conn, id, scope)? != drawer {
                return Err("PAYLOAD_DRIFT".into());
            }
            let mut removed = Vec::new();
            for (table, sql) in [
                (
                    "parity_sync_queue",
                    "DELETE FROM parity_sync_queue WHERE record_id IN (?1,?2)",
                ),
                (
                    "cash_drawer_sessions",
                    "DELETE FROM cash_drawer_sessions WHERE staff_shift_id=?1 OR id=?2",
                ),
                (
                    "staff_shifts",
                    "DELETE FROM staff_shifts WHERE id=?1 AND ?2 IS ?2",
                ),
            ] {
                let n = conn
                    .execute(sql, params![id, drawer])
                    .map_err(guards::error)?;
                removed.push(json!({"table":table,"count":n}));
            }
            let absent:bool=conn.query_row("SELECT NOT EXISTS(SELECT 1 FROM staff_shifts WHERE id=?1) AND NOT EXISTS(SELECT 1 FROM cash_drawer_sessions WHERE staff_shift_id=?1 OR id=?2) AND NOT EXISTS(SELECT 1 FROM parity_sync_queue WHERE record_id IN (?1,?2))",params![id,drawer],|r|r.get(0)).map_err(guards::error)?;
            if !absent {
                return Err("OUTCOME_UNKNOWN".into());
            }
            (
                json!({"kind":"shift_void","shift_id":id,"drawer_session_id":drawer,"local_absent":true,"server":server,"removed":removed}),
                json!({"kind":"unavailable","reference":null,"reason":"Deleted on the server and the till; a new check-in creates a new shift."}),
                vec![id.to_string()],
            )
        }
    };
    let post = std::cell::RefCell::new(None);
    super::confirmed_actions::finish_tx(
        &conn, tx, c, now, permit, start, &recheck, &effects, cap, &post, &schema,
    )?;
    conn.progress_handler(0, None::<fn() -> bool>);
    // A separate read after COMMIT proves the final local result.
    if evidence["kind"] == "shift_void" {
        let absent: bool = conn
            .query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM staff_shifts WHERE id=?1) AND NOT EXISTS(SELECT 1 FROM cash_drawer_sessions WHERE staff_shift_id=?1 OR id=?2) AND NOT EXISTS(SELECT 1 FROM parity_sync_queue WHERE record_id IN (?1,?2))",
                params![evidence["shift_id"].as_str().ok_or("OUTCOME_UNKNOWN")?,evidence["drawer_session_id"].as_str()],
                |r| r.get(0),
            )
            .map_err(|_| "OUTCOME_UNKNOWN")?;
        if !absent {
            return Err("OUTCOME_UNKNOWN".into());
        }
    } else {
        let status: String = conn
            .query_row(
                "SELECT status FROM orders WHERE id=?1",
                [evidence["order_id"].as_str().ok_or("OUTCOME_UNKNOWN")?],
                |r| r.get(0),
            )
            .map_err(|_| "OUTCOME_UNKNOWN")?;
        if evidence["after_status"] != status {
            return Err("OUTCOME_UNKNOWN".into());
        }
        let fresh = row(
            &conn,
            "orders",
            evidence["order_id"].as_str().ok_or("OUTCOME_UNKNOWN")?,
        )
        .map_err(|_| "OUTCOME_UNKNOWN")?;
        let server = expected_order.as_ref().ok_or("OUTCOME_UNKNOWN")?;
        for field in [
            "status",
            "version",
            "updated_at",
            "cancelled_at",
            "cancellation_reason",
        ] {
            if fresh[field] != server[field] {
                return Err("OUTCOME_UNKNOWN".into());
            }
        }
        if fresh["remote_version"] != server["version"] {
            return Err("OUTCOME_UNKNOWN".into());
        }
        for row in evidence["rows"].as_array().ok_or("OUTCOME_UNKNOWN")? {
            let terminal:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM parity_sync_queue WHERE id=?1 AND status='superseded')",[row["queue_id"].as_str().ok_or("OUTCOME_UNKNOWN")?],|r|r.get(0)).map_err(|_|"OUTCOME_UNKNOWN")?;
            if !terminal {
                return Err("OUTCOME_UNKNOWN".into());
            }
        }
    }
    // The server deletion cannot be undone locally: restoring this pre-delete
    // copy would revive a check-in the server now refuses (SHIFT_VOIDED). With
    // no post-change watermark, restore::validate refuses the snapshot, and
    // taking it already superseded every older one.
    if evidence["kind"] != "shift_void" {
        super::confirmed::save_post(
            store,
            &snap.id,
            post.borrow().as_ref().ok_or("OUTCOME_UNKNOWN")?,
        )?;
    }
    Ok(
        json!({"step":"action","kind":"untrusted_till_data","outcome":"resolved","observation_time":clock::iso(now+start.elapsed().as_millis() as i64),"snapshot_id":snap.id,"snapshot":snapshot::metadata(store,&snap.id).map_err(|_|"OUTCOME_UNKNOWN")?,"affected_ids":affected,"changed_rows":super::confirmed_actions::changes(&conn,&effects,cap).map_err(|_|"OUTCOME_UNKNOWN")?,"verification":{"fresh":true,"matches_expected":true,"sync":"acknowledged"},"evidence":evidence,"undo":undo}),
    )
}
