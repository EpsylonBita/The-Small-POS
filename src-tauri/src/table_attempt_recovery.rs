//! Crash recovery for exact canonical edits and committed cancellations.
//! No PIN/approval token or payment collection is ever dispatched by this owner.
use crate::{
    database_lock::run_blocking_command,
    db::DbState,
    table_session_cache::{self, Scope},
};
use chrono::{Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{future::Future, pin::Pin};
use tauri::{Emitter, Manager};

#[derive(Debug, Clone)]
struct Attempt {
    kind: String,
    event: String,
    order: String,
    session: Option<String>,
    request: Value,
    generation: i64,
    attempts: i64,
}
#[derive(Debug, Clone)]
struct Failure {
    code: &'static str,
    retry: bool,
}
impl Failure {
    fn guarded(code: &'static str) -> Self {
        Self { code, retry: false }
    }
}
impl From<crate::api::AdminFetchError> for Failure {
    fn from(error: crate::api::AdminFetchError) -> Self {
        if error.is_transport_failure() {
            return Self {
                code: "NETWORK_ERROR",
                retry: true,
            };
        }
        match error.status() {
            Some(408 | 429 | 502 | 503 | 504) => Self {
                code: "SERVICE_TEMPORARILY_UNAVAILABLE",
                retry: true,
            },
            Some(401 | 403) => Self::guarded("AUTHORIZATION_REQUIRED"),
            Some(409) if error.code() == Some("TABLE_SNAPSHOT_CHANGED") => Self {
                code: "CANONICAL_SNAPSHOT_CHANGED",
                retry: true,
            },
            Some(409) => Self::guarded("CANONICAL_CONFLICT_REVIEW_REQUIRED"),
            _ => Self::guarded("CANONICAL_RECOVERY_REVIEW_REQUIRED"),
        }
    }
}

pub(crate) fn schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS table_attempt_recovery_v1 (
        organization_id TEXT NOT NULL,branch_id TEXT NOT NULL,terminal_id TEXT NOT NULL,owner_terminal_id TEXT NOT NULL,
        kind TEXT NOT NULL,client_event_id TEXT NOT NULL,local_order_id TEXT NOT NULL,
        session_id TEXT,request_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,next_retry_at TEXT,lease_until TEXT,
        generation INTEGER NOT NULL DEFAULT 0,last_error_code TEXT,updated_at TEXT NOT NULL,
        PRIMARY KEY(organization_id,branch_id,terminal_id,kind,client_event_id));
        CREATE TABLE IF NOT EXISTS table_attempt_recovery_audit_v1 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,organization_id TEXT NOT NULL,branch_id TEXT NOT NULL,terminal_id TEXT NOT NULL,
        kind TEXT NOT NULL,client_event_id TEXT NOT NULL,before_json TEXT NOT NULL,outcome TEXT NOT NULL,created_at TEXT NOT NULL);")
        .map_err(|e|e.to_string())
}

fn remember(
    conn: &Connection,
    kind: &str,
    order: &str,
    session: Option<&str>,
    request: &Value,
) -> Result<(), String> {
    let scope = table_session_cache::current_scope(conn)?;
    schema(conn)?;
    let event = request
        .get("client_event_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 255)
        .ok_or("Recovery attempt has no stable event")?;
    conn.execute("INSERT OR IGNORE INTO table_attempt_recovery_v1(organization_id,branch_id,terminal_id,kind,client_event_id,local_order_id,session_id,request_json,next_retry_at,updated_at,owner_terminal_id)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![scope.organization,scope.branch,scope.terminal,kind,event,order,session,request.to_string(),
        (Utc::now()+Duration::seconds(30)).to_rfc3339(),Utc::now().to_rfc3339(),scope.owner]).map_err(|e|e.to_string())?;
    let original:String=conn.query_row("SELECT request_json FROM table_attempt_recovery_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND kind=?4 AND client_event_id=?5",params![scope.organization,scope.branch,scope.terminal,kind,event],|r|r.get(0)).map_err(|e|e.to_string())?;
    if original != request.to_string() {
        return Err("RECOVERY_ORIGINAL_REQUEST_REQUIRED".into());
    }
    Ok(())
}
pub(crate) fn remember_item(conn: &Connection, order: &str, request: &Value) -> Result<(), String> {
    remember(
        conn,
        "item_edit",
        order,
        request.get("table_session_id").and_then(Value::as_str),
        request,
    )
}
pub(crate) fn remember_cancel(
    conn: &Connection,
    order: &str,
    session: &str,
    event: &str,
    reason: &str,
    actor: &str,
) -> Result<(), String> {
    remember(
        conn,
        "whole_order_cancel",
        order,
        Some(session),
        &crate::table_manual_cancellation::original(conn,event)?.unwrap_or_else(||json!({"client_event_id":event,"cancellation_reason":reason,"approved_staff_id":actor,"action":"whole_order_cancel"})),
    )
}
pub(crate) fn foreground_applied(conn: &Connection, kind: &str, event: &str) -> Result<(), String> {
    let scope = table_session_cache::current_scope(conn)?;
    schema(conn)?;
    conn.execute("UPDATE table_attempt_recovery_v1 SET status='applied',lease_until=NULL,next_retry_at=NULL,last_error_code=NULL,updated_at=?1
        WHERE organization_id=?2 AND branch_id=?3 AND terminal_id=?4 AND kind=?5 AND client_event_id=?6",
        params![Utc::now().to_rfc3339(),scope.organization,scope.branch,scope.terminal,kind,event]).map_err(|e|e.to_string())?;
    Ok(())
}

fn claim(conn: &Connection) -> Result<Option<(Scope, Attempt)>, String> {
    let scope = table_session_cache::current_scope(conn)?;
    schema(conn)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Upgrade the exact immutable intent stores shipped before this worker.
    // Successful old attempts are harmless exact replays/receipt reads; no
    // legacy cancellation can obtain approval or send a mutation here.
    let exists = |name: &str| {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [name],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())
    };
    if exists("order_item_edit_attempts_v1")? {
        tx.execute("INSERT OR IGNORE INTO table_attempt_recovery_v1(organization_id,branch_id,terminal_id,kind,client_event_id,local_order_id,session_id,request_json,updated_at,owner_terminal_id)
            SELECT organization_id,branch_id,terminal_id,'item_edit',client_event_id,order_id,json_extract(request_json,'$.table_session_id'),json_set(request_json,'$.client_event_id',client_event_id),?4,?5
            FROM order_item_edit_attempts_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND json_valid(request_json)",params![scope.organization,scope.branch,scope.terminal,Utc::now().to_rfc3339(),scope.owner]).map_err(|e|e.to_string())?;
    }
    if exists("table_cancel_attempts_v1")? {
        tx.execute("INSERT OR IGNORE INTO table_attempt_recovery_v1(organization_id,branch_id,terminal_id,kind,client_event_id,local_order_id,session_id,request_json,updated_at,owner_terminal_id)
            SELECT c.organization_id,c.branch_id,c.terminal_id,'whole_order_cancel',c.client_event_id,COALESCE((SELECT o.id FROM orders o WHERE o.table_session_id=c.session_id AND o.organization_id=c.organization_id AND o.branch_id=c.branch_id LIMIT 1),''),c.session_id,
            json_object('client_event_id',c.client_event_id,'action','whole_order_cancel','cancellation_reason',c.cancellation_reason,'approved_staff_id',c.approved_staff_id),?4,?5
            FROM table_cancel_attempts_v1 c WHERE c.organization_id=?1 AND c.branch_id=?2 AND c.terminal_id=?3",params![scope.organization,scope.branch,scope.terminal,Utc::now().to_rfc3339(),scope.owner]).map_err(|e|e.to_string())?;
    }
    let row:Option<(String,String,String,Option<String>,String,i64,i64)>=tx.query_row("SELECT kind,client_event_id,local_order_id,session_id,request_json,generation,attempts FROM table_attempt_recovery_v1
        WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND owner_terminal_id=?4 AND
        (((status IN ('pending','approval_required') OR (kind='whole_order_cancel' AND status='auth_required')) AND (next_retry_at IS NULL OR julianday(next_retry_at)<=julianday('now')))
          OR (status='processing' AND julianday(lease_until)<=julianday('now')))
        ORDER BY updated_at ASC LIMIT 1",params![scope.organization,scope.branch,scope.terminal,scope.owner],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(|e|e.to_string())?;
    let Some((kind, event, order, session, raw, generation, attempts)) = row else {
        return Ok(None);
    };
    let request =
        serde_json::from_str(&raw).map_err(|_| "Persisted recovery request is invalid")?;
    tx.execute("UPDATE table_attempt_recovery_v1 SET status='processing',generation=generation+1,lease_until=?1,updated_at=?2
        WHERE organization_id=?3 AND branch_id=?4 AND terminal_id=?5 AND kind=?6 AND client_event_id=?7 AND generation=?8",
        params![(Utc::now()+Duration::seconds(120)).to_rfc3339(),Utc::now().to_rfc3339(),scope.organization,scope.branch,scope.terminal,kind,event,generation]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some((
        scope,
        Attempt {
            kind,
            event,
            order,
            session,
            request,
            generation: generation + 1,
            attempts,
        },
    )))
}

trait Transport: Sync {
    fn send(
        &self,
        path: String,
        method: &'static str,
        body: Option<Value>,
    ) -> Pin<Box<dyn Future<Output = Result<Value, Failure>> + Send + '_>>;
}
struct NativeTransport<'a>(&'a DbState);
impl Transport for NativeTransport<'_> {
    fn send(
        &self,
        path: String,
        method: &'static str,
        body: Option<Value>,
    ) -> Pin<Box<dyn Future<Output = Result<Value, Failure>> + Send + '_>> {
        Box::pin(async move {
            crate::admin_fetch_detailed(Some(self.0), &path, method, body)
                .await
                .map_err(Failure::from)
        })
    }
}

async fn item_snapshot(
    transport: &dyn Transport,
    attempt: &Attempt,
    dispatch_edit: bool,
) -> Result<Value, Failure> {
    let remote = attempt
        .request
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| Failure::guarded("RECOVERY_REQUEST_INVALID"))?;
    uuid::Uuid::parse_str(remote).map_err(|_| Failure::guarded("RECOVERY_REQUEST_INVALID"))?;
    if attempt
        .request
        .get("client_event_id")
        .and_then(Value::as_str)
        != Some(attempt.event.as_str())
        || attempt
            .request
            .get("expected_version")
            .and_then(Value::as_i64)
            .is_none_or(|v| v < 1)
    {
        return Err(Failure::guarded("RECOVERY_REQUEST_INVALID"));
    }
    if dispatch_edit {
        let reply = transport
            .send(
                "/api/pos/orders".into(),
                "PATCH",
                Some(attempt.request.clone()),
            )
            .await?;
        if reply.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(Failure::guarded("CANONICAL_EDIT_UNCONFIRMED"));
        }
    }
    // Replay may return an older journal response: hydrate fresh authoritative
    // parent/check/ledger, never project a check's scoped lines into the parent.
    let mut sessions = Vec::new();
    if let Some(id) = &attempt.session {
        uuid::Uuid::parse_str(id).map_err(|_| Failure::guarded("RECOVERY_REQUEST_INVALID"))?;
        let reply = transport
            .send(format!("/api/pos/table-sessions/{id}"), "GET", None)
            .await?;
        let session = reply
            .get("session")
            .filter(|s| s.get("id").and_then(Value::as_str) == Some(id.as_str()))
            .ok_or_else(|| Failure::guarded("CANONICAL_SNAPSHOT_INVALID"))?;
        sessions.push(session.clone());
    }
    let reply = transport
        .send(
            format!("/api/pos/orders/sync?order_id={remote}&limit=1"),
            "GET",
            None,
        )
        .await?;
    let orders = reply
        .get("orders")
        .and_then(Value::as_array)
        .filter(|rows| rows.len() == 1 && rows[0].get("id").and_then(Value::as_str) == Some(remote))
        .ok_or_else(|| Failure::guarded("CANONICAL_SNAPSHOT_INVALID"))?;
    let parent = &orders[0];
    if sessions
        .iter()
        .any(|session| session.pointer("/order/version") != parent.get("version"))
    {
        return Err(Failure {
            code: "CANONICAL_SNAPSHOT_CHANGED",
            retry: true,
        });
    }
    let reply = transport
        .send(
            format!("/api/pos/payments?order_id={remote}&limit=500"),
            "GET",
            None,
        )
        .await?;
    if reply.get("has_more").and_then(Value::as_bool) != Some(false) {
        return Err(Failure::guarded("CANONICAL_LEDGER_INCOMPLETE"));
    }
    let mut payments = reply
        .get("payments")
        .and_then(Value::as_array)
        .ok_or_else(|| Failure::guarded("CANONICAL_LEDGER_INCOMPLETE"))?
        .clone();
    for payment in &mut payments {
        if payment.get("order_id").and_then(Value::as_str) != Some(remote) {
            return Err(Failure::guarded("CANONICAL_LEDGER_SCOPE_CHANGED"));
        }
        if payment.get("organization_id").is_none() {
            payment["organization_id"] = parent["organization_id"].clone();
        }
    }
    let mut tables = Vec::new();
    if !sessions.is_empty() {
        let reply = transport
            .send("/api/pos/tables".into(), "GET", None)
            .await?;
        tables = reply
            .get("tables")
            .and_then(Value::as_array)
            .ok_or_else(|| Failure::guarded("CANONICAL_SNAPSHOT_INVALID"))?
            .clone();
        for session in &sessions {
            let id = session["id"].as_str().unwrap();
            let after = transport
                .send(format!("/api/pos/table-sessions/{id}"), "GET", None)
                .await?;
            if after.pointer("/session/snapshot_revision") != session.get("snapshot_revision") {
                return Err(Failure {
                    code: "CANONICAL_SNAPSHOT_CHANGED",
                    retry: true,
                });
            }
        }
    }
    let after = transport
        .send(
            format!("/api/pos/orders/sync?order_id={remote}&limit=1"),
            "GET",
            None,
        )
        .await?;
    if after.pointer("/orders/0/version") != parent.get("version")
        || after.pointer("/orders/0/updated_at") != parent.get("updated_at")
    {
        return Err(Failure {
            code: "CANONICAL_SNAPSHOT_CHANGED",
            retry: true,
        });
    }
    Ok(
        json!({"success":true,"cafe_lan_snapshot":{"orders":orders,"sessions":sessions,"tables":tables,"payments":payments}}),
    )
}

async fn dispatch(transport: &dyn Transport, attempt: &Attempt) -> Result<Option<Value>, Failure> {
    if attempt.kind == "item_edit" {
        return item_snapshot(transport, attempt, true).await.map(Some);
    }
    if attempt.kind != "whole_order_cancel" {
        return Err(Failure::guarded("RECOVERY_REQUEST_INVALID"));
    }
    let session = attempt
        .session
        .as_deref()
        .ok_or_else(|| Failure::guarded("RECOVERY_REQUEST_INVALID"))?;
    let actor = attempt
        .request
        .get("approved_staff_id")
        .and_then(Value::as_str)
        .ok_or_else(|| Failure::guarded("ORIGINAL_CANCEL_APPROVER_REQUIRED"))?;
    uuid::Uuid::parse_str(session)
        .and_then(|_| uuid::Uuid::parse_str(actor))
        .map_err(|_| Failure::guarded("RECOVERY_REQUEST_INVALID"))?;
    let query = {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query
            .append_pair("expected_action", "whole_order_cancel")
            .append_pair("approved_staff_id", actor)
            .finish()
    };
    let event: String = url::form_urlencoded::byte_serialize(attempt.event.as_bytes()).collect();
    let reply = transport
        .send(
            format!("/api/pos/table-sessions/{session}/operations/{event}?{query}"),
            "GET",
            None,
        )
        .await?;
    if reply.get("committed").and_then(Value::as_bool) == Some(false) {
        return Ok(None);
    }
    if reply.get("success").and_then(Value::as_bool) != Some(true)
        || reply.get("committed").and_then(Value::as_bool) != Some(true)
        || reply
            .pointer("/event/client_event_id")
            .and_then(Value::as_str)
            != Some(attempt.event.as_str())
        || reply.pointer("/event/action").and_then(Value::as_str) != Some("whole_order_cancel")
        || reply.pointer("/event/session_id").and_then(Value::as_str) != Some(session)
        || reply
            .pointer("/event/approved_staff_id")
            .and_then(Value::as_str)
            != Some(actor)
    {
        return Err(Failure::guarded("CANONICAL_RECEIPT_IDENTITY_CHANGED"));
    }
    let parent = reply
        .pointer("/event/order_id")
        .and_then(Value::as_str)
        .ok_or_else(|| Failure::guarded("CANONICAL_SNAPSHOT_INVALID"))?;
    if !reply
        .pointer("/cafe_lan_snapshot/orders")
        .and_then(Value::as_array)
        .is_some_and(|rows| {
            rows.iter()
                .any(|r| r.get("id").and_then(Value::as_str) == Some(parent))
        })
        || !reply
            .pointer("/cafe_lan_snapshot/sessions")
            .and_then(Value::as_array)
            .is_some_and(|rows| {
                rows.iter()
                    .any(|r| r.get("id").and_then(Value::as_str) == Some(session))
            })
        || !reply
            .pointer("/cafe_lan_snapshot/payments")
            .is_some_and(Value::is_array)
        || !reply
            .pointer("/cafe_lan_snapshot/tables")
            .is_some_and(Value::is_array)
    {
        return Err(Failure::guarded("CANONICAL_SNAPSHOT_INVALID"));
    }
    Ok(Some(reply))
}

fn finish(
    conn: &Connection,
    scope: &Scope,
    attempt: &Attempt,
    result: Result<Option<Value>, Failure>,
) -> Result<Value, String> {
    let current = table_session_cache::current_scope(conn)?;
    if current.organization != scope.organization
        || current.branch != scope.branch
        || current.terminal != scope.terminal
        || current.owner != scope.owner
    {
        return Err("Recovery scope changed".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let live:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM table_attempt_recovery_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3
        AND kind=?4 AND client_event_id=?5 AND generation=?6 AND status='processing')",params![scope.organization,scope.branch,scope.terminal,attempt.kind,attempt.event,attempt.generation],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !live {
        return Ok(json!({"state":"stale"}));
    }
    let (status, code, retry) = match result {
        Ok(Some(response)) => match crate::sync::apply_lan_canonical_response(
            &tx,
            if attempt.kind == "item_edit" {
                "/api/pos/orders"
            } else {
                "/api/pos/table-sessions"
            },
            &response,
        ) {
            Ok(()) => ("applied", None, false),
            Err(_) => (
                "conflict",
                Some("CANONICAL_SNAPSHOT_REVIEW_REQUIRED"),
                false,
            ),
        },
        Ok(None) => (
            "approval_required",
            Some("FRESH_CANCELLATION_APPROVAL_REQUIRED"),
            true,
        ),
        Err(failure)
            if failure.code == "AUTHORIZATION_REQUIRED" && attempt.kind == "whole_order_cancel" =>
        {
            ("auth_required", Some(failure.code), true)
        }
        Err(failure) if failure.retry => ("pending", Some(failure.code), true),
        Err(failure) => (
            if failure.code == "AUTHORIZATION_REQUIRED" {
                "auth_required"
            } else {
                "conflict"
            },
            Some(failure.code),
            false,
        ),
    };
    let attempts = attempt.attempts.saturating_add(1);
    let delay = if matches!(status, "approval_required" | "auth_required") {
        300
    } else {
        (5_i64.saturating_mul(1_i64 << attempts.min(6))).min(300)
    };
    let next = retry.then(|| (Utc::now() + Duration::seconds(delay)).to_rfc3339());
    tx.execute("INSERT INTO table_attempt_recovery_audit_v1(organization_id,branch_id,terminal_id,kind,client_event_id,before_json,outcome,created_at)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![scope.organization,scope.branch,scope.terminal,attempt.kind,attempt.event,
        tx.query_row("SELECT json_object('status',status,'attempts',attempts,'generation',generation,'next_retry_at',next_retry_at,'lease_until',lease_until,'last_error_code',last_error_code,'updated_at',updated_at) FROM table_attempt_recovery_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND kind=?4 AND client_event_id=?5",params![scope.organization,scope.branch,scope.terminal,attempt.kind,attempt.event],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?,status,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM table_attempt_recovery_audit_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND kind=?4 AND client_event_id=?5
        AND id NOT IN (SELECT id FROM table_attempt_recovery_audit_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND kind=?4 AND client_event_id=?5 ORDER BY id DESC LIMIT 32)",
        params![scope.organization,scope.branch,scope.terminal,attempt.kind,attempt.event]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE table_attempt_recovery_v1 SET status=?1,attempts=?2,next_retry_at=?3,lease_until=NULL,last_error_code=?4,updated_at=?5
        WHERE organization_id=?6 AND branch_id=?7 AND terminal_id=?8 AND kind=?9 AND client_event_id=?10 AND generation=?11",
        params![status,attempts,next,code,Utc::now().to_rfc3339(),scope.organization,scope.branch,scope.terminal,attempt.kind,attempt.event,attempt.generation]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(
        json!({"state":status,"kind":attempt.kind,"orderId":attempt.order,"sessionId":attempt.session,"clientEventId":attempt.event,"errorCode":code,"nextRetryAt":next}),
    )
}

fn apply_foreground_item_snapshot(
    conn: &Connection,
    captured: &Scope,
    attempt: &Attempt,
    response: &Value,
) -> Result<Option<Value>, String> {
    let current = table_session_cache::current_scope(conn)?;
    if current.organization != captured.organization
        || current.branch != captured.branch
        || current.terminal != captured.terminal
        || current.owner != captured.owner
    {
        return Err("Recovery scope changed".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::sync::apply_lan_canonical_response(&tx, "/api/pos/orders", response)?;
    foreground_applied(&tx, "item_edit", &attempt.event)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(response
        .pointer("/cafe_lan_snapshot/sessions")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("id").and_then(Value::as_str) == attempt.session.as_deref())
        })
        .cloned())
}

pub(crate) async fn confirm_foreground_item(
    db: &DbState,
    order: &str,
    request: &Value,
) -> Result<Option<Value>, String> {
    let _lease = crate::repairs::acquire_terminal_binding_lease()?;
    let captured = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        table_session_cache::current_scope(&conn)?
    };
    let attempt = Attempt {
        kind: "item_edit".into(),
        event: request
            .get("client_event_id")
            .and_then(Value::as_str)
            .ok_or("Confirmed edit has no event")?
            .into(),
        order: order.into(),
        session: request
            .get("table_session_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        request: request.clone(),
        generation: 0,
        attempts: 0,
    };
    let response=item_snapshot(&NativeTransport(db),&attempt,false).await.map_err(|failure|format!("Order edit confirmation is pending: {}. Retry the original change after reconnecting.",failure.code))?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    apply_foreground_item_snapshot(&conn, &captured, &attempt, &response)
}

pub(crate) async fn run_background(db: &DbState, app: &tauri::AppHandle) -> Result<(), String> {
    // Same lifecycle lease as identity-bound writes: reset/rebind waits for
    // this bounded owner, and it never applies a late response to a new scope.
    let _lease = crate::repairs::acquire_terminal_binding_lease()?;
    for _ in 0..2 {
        let next = {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            claim(&conn)?
        };
        let Some((scope, attempt)) = next else {
            break;
        };
        let result = dispatch(&NativeTransport(db), &attempt).await;
        let event = {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            finish(&conn, &scope, &attempt, result)?
        };
        let _ = app.emit("table_attempt_recovery", &event);
        if event["state"] == "applied" {
            let _ = app.emit("order_realtime_update", json!({"source":"crash_recovery","orderId":event["orderId"],"client_event_id":event["clientEventId"]}));
        }
    }
    Ok(())
}

pub(crate) fn inspect_edit(
    conn: &Connection,
    event: &str,
    order: &str,
) -> Result<Option<Value>, String> {
    schema(conn)?;
    let scope = table_session_cache::current_scope(conn)?;
    conn.query_row("SELECT status,last_error_code FROM table_attempt_recovery_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3
        AND kind='item_edit' AND client_event_id=?4 AND owner_terminal_id=?6 AND (local_order_id=?5 OR local_order_id IN (SELECT id FROM orders WHERE supabase_id=?5 AND organization_id=?1 AND branch_id=?2))",params![scope.organization,scope.branch,scope.terminal,event,order,scope.owner],
        |r|Ok(json!({"recoveryState":r.get::<_,String>(0)?,"errorCode":r.get::<_,Option<String>>(1)?}))).optional().map_err(|e|e.to_string())
}

pub(crate) fn status(conn: &Connection) -> Result<Value, String> {
    schema(conn)?;
    let scope = table_session_cache::current_scope(conn)?;
    let mut stmt=conn.prepare("SELECT kind,client_event_id,local_order_id,session_id,status,last_error_code,next_retry_at FROM table_attempt_recovery_v1
        WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND owner_terminal_id=?4 AND status<>'applied' ORDER BY updated_at LIMIT 100").map_err(|e|e.to_string())?;
    let attempts=stmt.query_map(params![scope.organization,scope.branch,scope.terminal,scope.owner],|r|Ok(json!({"kind":r.get::<_,String>(0)?,"clientEventId":r.get::<_,String>(1)?,"orderId":r.get::<_,String>(2)?,"sessionId":r.get::<_,Option<String>>(3)?,"state":r.get::<_,String>(4)?,"errorCode":r.get::<_,Option<String>>(5)?,"nextRetryAt":r.get::<_,Option<String>>(6)?})))
        .map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(json!({"success":true,"attempts":attempts}))
}
// On the blocking pool, never the window thread or a runtime worker (Tomikro
// 20/10/2026, see database_lock.rs).
#[tauri::command]
pub async fn table_attempt_recovery_status(app: tauri::AppHandle) -> Result<Value, String> {
    run_blocking_command("table_attempt_recovery_status", move || {
        let db = app.state::<DbState>();
        let _lease = crate::repairs::acquire_terminal_binding_lease()?;
        let conn = db
            .lock_traced("table_attempt_recovery_status")
            .map_err(|e| e.to_string())?;
        status(&conn)
    })
    .await
}

/// An operator may read a selected original cancellation receipt after a
/// snapshot admission failure. This never revives another refused operation.
fn select_original_cancel(
    conn: &Connection,
    event: &str,
) -> Result<Option<(Scope, Attempt)>, String> {
    if event.trim().is_empty() || event.len() > 255 {
        return Err("RECOVERY_REQUEST_INVALID".into());
    }
    let scope = table_session_cache::current_scope(conn)?;
    schema(conn)?;
    let row: Option<(String, Option<String>, String, String, Option<String>, i64, i64)> = conn.query_row(
        "SELECT local_order_id,session_id,request_json,status,last_error_code,generation,attempts
         FROM table_attempt_recovery_v1 WHERE organization_id=?1 AND branch_id=?2
           AND terminal_id=?3 AND owner_terminal_id=?4 AND kind='whole_order_cancel' AND client_event_id=?5",
        params![scope.organization, scope.branch, scope.terminal, scope.owner, event],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
    ).optional().map_err(|e| e.to_string())?;
    let (order, session, raw, status, code, generation, attempts) =
        row.ok_or("RECOVERY_ORIGINAL_UNAVAILABLE")?;
    if status == "applied" {
        return Ok(None);
    }
    if status != "conflict" || code.as_deref() != Some("CANONICAL_SNAPSHOT_REVIEW_REQUIRED") {
        return Err("RECOVERY_ORIGINAL_CONFIRMATION_NOT_ALLOWED".into());
    }
    generation
        .checked_add(1)
        .filter(|value| *value > 0)
        .ok_or("RECOVERY_ORIGINAL_CHANGED")?;
    let request: Value = serde_json::from_str(&raw).map_err(|_| "RECOVERY_REQUEST_INVALID")?;
    if request.get("client_event_id").and_then(Value::as_str) != Some(event)
        || request.get("action").and_then(Value::as_str) != Some("whole_order_cancel")
        || session
            .as_deref()
            .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
        || request
            .get("approved_staff_id")
            .and_then(Value::as_str)
            .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err("RECOVERY_REQUEST_INVALID".into());
    }
    let original_parent: Option<String> = conn.query_row(
        "SELECT COALESCE(NULLIF(supabase_id,''),id) FROM orders WHERE id=?1 AND organization_id=?2 AND branch_id=?3",
        params![order, scope.organization, scope.branch], |r| r.get(0),
    ).optional().map_err(|e| e.to_string())?;
    if original_parent
        .as_deref()
        .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err("RECOVERY_ORIGINAL_ORDER_UNAVAILABLE".into());
    }
    Ok(Some((
        scope,
        Attempt {
            kind: "whole_order_cancel".into(),
            event: event.into(),
            order,
            session,
            request,
            generation,
            attempts,
        },
    )))
}

fn claim_original_cancel(
    conn: &Connection,
    scope: &Scope,
    attempt: &Attempt,
    snapshot_id: &str,
) -> Result<Attempt, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let next_generation = attempt
        .generation
        .checked_add(1)
        .filter(|value| *value > 0)
        .ok_or("RECOVERY_ORIGINAL_CHANGED")?;
    let before: String = tx.query_row(
        "SELECT json_object('status',status,'attempts',attempts,'generation',generation,
            'next_retry_at',next_retry_at,'lease_until',lease_until,'last_error_code',last_error_code,
            'updated_at',updated_at,'remedyVersion',1,'snapshotId',?6)
         FROM table_attempt_recovery_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3
           AND owner_terminal_id=?4 AND kind='whole_order_cancel' AND client_event_id=?5",
        params![scope.organization, scope.branch, scope.terminal, scope.owner, attempt.event, snapshot_id],
        |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    let claimed = tx.execute(
        "UPDATE table_attempt_recovery_v1 SET status='processing',generation=generation+1,lease_until=?1,updated_at=?2
         WHERE organization_id=?3 AND branch_id=?4 AND terminal_id=?5 AND owner_terminal_id=?6
           AND kind='whole_order_cancel' AND client_event_id=?7 AND generation=?8 AND status='conflict'
           AND last_error_code='CANONICAL_SNAPSHOT_REVIEW_REQUIRED'",
        params![(Utc::now()+Duration::seconds(120)).to_rfc3339(), Utc::now().to_rfc3339(),
            scope.organization, scope.branch, scope.terminal, scope.owner, attempt.event, attempt.generation],
    ).map_err(|e| e.to_string())?;
    if claimed != 1 {
        return Err("RECOVERY_ORIGINAL_CHANGED".into());
    }
    tx.execute("INSERT INTO table_attempt_recovery_audit_v1(organization_id,branch_id,terminal_id,kind,client_event_id,before_json,outcome,created_at)
        VALUES(?1,?2,?3,'whole_order_cancel',?4,?5,'original_confirmation_selected',?6)",
        params![scope.organization, scope.branch, scope.terminal, attempt.event, before, Utc::now().to_rfc3339()])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Attempt {
        generation: next_generation,
        ..attempt.clone()
    })
}

fn original_cancel_evidence(
    conn: &Connection,
    scope: &Scope,
    attempt: &Attempt,
) -> Result<(String, String), String> {
    conn.query_row(
        "SELECT r.request_json,COALESCE(NULLIF(o.supabase_id,''),o.id)
         FROM table_attempt_recovery_v1 r JOIN orders o ON o.id=r.local_order_id
           AND o.organization_id=r.organization_id AND o.branch_id=r.branch_id
         WHERE r.organization_id=?1 AND r.branch_id=?2 AND r.terminal_id=?3 AND r.owner_terminal_id=?4
           AND r.kind='whole_order_cancel' AND r.client_event_id=?5",
        params![scope.organization, scope.branch, scope.terminal, scope.owner, attempt.event],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|_| "RECOVERY_ORIGINAL_ORDER_UNAVAILABLE".into())
}

async fn confirm_original_with_transport(
    db: &DbState,
    event: &str,
    transport: &dyn Transport,
) -> Result<Value, String> {
    let (selected, original) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let selected = select_original_cancel(&conn, event)?;
        let original = selected
            .as_ref()
            .map(|(scope, attempt)| original_cancel_evidence(&conn, scope, attempt))
            .transpose()?;
        (selected, original)
    };
    let Some((scope, attempt)) = selected else {
        return Ok(json!({"state":"applied"}));
    };
    let original = original.ok_or("RECOVERY_ORIGINAL_ORDER_UNAVAILABLE")?;
    // The restore point contains the refused original, before even scheduling
    // metadata changes. Snapshot failure must leave both intent and mirrors intact.
    let point = crate::recovery::create_pre_recovery_action_snapshot(db)?;
    let attempt = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let (current, selected) =
            select_original_cancel(&conn, event)?.ok_or("RECOVERY_ORIGINAL_CHANGED")?;
        if current.organization != scope.organization
            || current.branch != scope.branch
            || current.terminal != scope.terminal
            || current.owner != scope.owner
            || selected.order != attempt.order
            || selected.session != attempt.session
            || selected.generation != attempt.generation
            || selected.attempts != attempt.attempts
            || original_cancel_evidence(&conn, &current, &selected)? != original
        {
            return Err("RECOVERY_ORIGINAL_CHANGED".into());
        }
        claim_original_cancel(&conn, &scope, &attempt, &point.id)?
    };
    let mut result = dispatch(transport, &attempt).await;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    if original_cancel_evidence(&conn, &scope, &attempt)? != original {
        return Err("RECOVERY_ORIGINAL_REQUEST_REQUIRED".into());
    }
    if let Ok(Some(response)) = &result {
        if response.pointer("/event/order_id").and_then(Value::as_str) != Some(original.1.as_str())
        {
            result = Err(Failure::guarded("CANONICAL_RECEIPT_IDENTITY_CHANGED"));
        }
    }
    finish(&conn, &scope, &attempt, result)
}

#[tauri::command]
pub async fn table_attempt_recovery_confirm_original(
    db: tauri::State<'_, DbState>,
    app: tauri::AppHandle,
    client_event_id: String,
) -> Result<Value, String> {
    let _lease = crate::repairs::acquire_terminal_binding_lease()?;
    let event =
        confirm_original_with_transport(&db, &client_event_id, &NativeTransport(&db)).await?;
    let _ = app.emit("table_attempt_recovery", &event);
    if event["state"] == "applied" && event.get("clientEventId").is_some() {
        let _ = app.emit("order_realtime_update", json!({"source":"crash_recovery","orderId":event["orderId"],"client_event_id":event["clientEventId"]}));
    }
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    const ORG: &str = "11111111-1111-4111-8111-111111111111";
    const BRANCH: &str = "22222222-2222-4222-8222-222222222222";
    const TERMINAL: &str = "33333333-3333-4333-8333-333333333333";
    const ORDER: &str = "44444444-4444-4444-8444-444444444444";
    const LINE: &str = "55555555-5555-4555-8555-555555555555";
    const SESSION: &str = "66666666-6666-4666-8666-666666666666";
    const ACTOR: &str = "77777777-7777-4777-8777-777777777777";
    fn parent(version: i64, status: &str) -> Value {
        json!({"id":ORDER,"organization_id":ORG,"branch_id":BRANCH,"owner_terminal_id":TERMINAL,"terminal_id":TERMINAL,"source_terminal_id":TERMINAL,
            "version":version,"order_number":"001","order_type":"pickup","status":status,"payment_status":"pending","total_amount":10,"subtotal":10,"tax_amount":0,
            "created_at":"2099-01-01T12:00:00Z","updated_at":"2099-01-01T12:00:00Z","table_id":null,"table_session_id":null,
            "order_items":[{"id":LINE,"quantity":1,"unit_price":10,"total_price":10,"name":"Coffee"}]})
    }
    fn setup(db: &DbState) -> String {
        let conn = db.conn.lock().unwrap();
        for (k, v) in [
            ("__ignore_keyring", "1"),
            ("organization_id", ORG),
            ("branch_id", BRANCH),
            ("terminal_id", TERMINAL),
            ("source_terminal_id", TERMINAL),
            ("owner_terminal_db_id", TERMINAL),
            ("source_terminal_db_id", TERMINAL),
            ("pos_operating_mode", "main_isolated"),
        ] {
            crate::db::set_setting(&conn, "terminal", k, v).unwrap();
        }
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        crate::sync::apply_lan_canonical_response(&conn,"/api/pos/orders",&json!({"success":true,"cafe_lan_snapshot":{"orders":[parent(1,"pending")],"sessions":[],"tables":[],"payments":[]}})).unwrap();
        conn.execute_batch("COMMIT").unwrap();
        conn.query_row("SELECT id FROM orders WHERE supabase_id=?1", [ORDER], |r| {
            r.get(0)
        })
        .unwrap()
    }
    fn request() -> Value {
        json!({"id":ORDER,"status":"pending","expected_version":1,"client_event_id":"original-event","items":[{"id":LINE,"quantity":1,"unit_price":10}]})
    }
    fn due(conn: &Connection) {
        conn.execute(
            "UPDATE table_attempt_recovery_v1 SET next_retry_at=NULL",
            [],
        )
        .unwrap();
    }
    struct Fake {
        receipt: Option<Value>,
        final_parent: Option<Value>,
        fresh_parent: Option<Value>,
        calls: Mutex<Vec<(String, String, Option<Value>)>>,
    }
    impl Transport for Fake {
        fn send(
            &self,
            path: String,
            method: &'static str,
            body: Option<Value>,
        ) -> Pin<Box<dyn Future<Output = Result<Value, Failure>> + Send + '_>> {
            Box::pin(async move {
                self.calls
                    .lock()
                    .unwrap()
                    .push((path.clone(), method.into(), body));
                if path.contains("/operations/") {
                    return Ok(self.receipt.clone().unwrap_or(
                        json!({"success":true,"committed":false,"approval_required":true}),
                    ));
                }
                if method == "PATCH" {
                    return Ok(json!({"success":true}));
                }
                if path.starts_with("/api/pos/orders/sync") {
                    let reads = self
                        .calls
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|(p, _, _)| p.starts_with("/api/pos/orders/sync"))
                        .count();
                    let current = if reads > 1 {
                        self.final_parent
                            .clone()
                            .or_else(|| self.fresh_parent.clone())
                            .unwrap_or_else(|| parent(2, "pending"))
                    } else {
                        self.fresh_parent
                            .clone()
                            .unwrap_or_else(|| parent(2, "pending"))
                    };
                    return Ok(json!({"orders":[current]}));
                }
                if path.starts_with("/api/pos/payments?") {
                    return Ok(json!({"payments":[],"has_more":false}));
                }
                Err(Failure::guarded("UNEXPECTED_REQUEST"))
            })
        }
    }
    fn fake(receipt: Option<Value>) -> Fake {
        Fake {
            receipt,
            final_parent: None,
            fresh_parent: None,
            calls: Mutex::new(Vec::new()),
        }
    }
    fn cancel_receipt() -> Value {
        let parent = parent(2, "cancelled");
        let mut scoped = parent.clone();
        scoped["order_items"] = json!([]);
        scoped["total_amount"] = json!(0);
        json!({"success":true,"committed":true,"event":{"client_event_id":"cancel-original","action":"whole_order_cancel","approved_staff_id":ACTOR,"session_id":SESSION,"order_id":ORDER,"terminal_id":TERMINAL},
            "cafe_lan_snapshot":{"orders":[parent],"sessions":[{"id":SESSION,"organization_id":ORG,"branch_id":BRANCH,"active_order_id":ORDER,"snapshot_revision":2,"status":"cancelled","order":scoped,"items":[],"payments":[],"tables":[],"balance":{"order_total":0,"paid_total":0,"outstanding_balance":0,"tip_total":0}}],"tables":[],"payments":[]}})
    }
    fn original_conflict(db: &DbState) -> (String, String) {
        let local = setup(db);
        let conn = db.conn.lock().unwrap();
        remember_cancel(
            &conn,
            &local,
            SESSION,
            "cancel-original",
            "Guest left",
            ACTOR,
        )
        .unwrap();
        conn.execute("UPDATE table_attempt_recovery_v1 SET status='conflict',last_error_code='CANONICAL_SNAPSHOT_REVIEW_REQUIRED'", []).unwrap();
        let raw = conn
            .query_row(
                "SELECT request_json FROM table_attempt_recovery_v1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        (local, raw)
    }

    #[tokio::test]
    async fn original_cancel_confirmation_reads_selected_receipt_and_admits_once_after_restart() {
        let disk = crate::tests::harness::TestDb::open();
        let (local, original) = original_conflict(&disk.state);
        let disk = disk.restart();
        let transport = fake(Some(cancel_receipt()));
        let confirmed = confirm_original_with_transport(&disk.state, "cancel-original", &transport)
            .await
            .unwrap();
        assert_eq!(confirmed["state"], json!("applied"));
        let points = crate::recovery::list_recovery_points(&disk.state).unwrap();
        assert_eq!(
            points.len(),
            1,
            "operator admission requires its full restore point"
        );
        assert_eq!(
            points[0].kind,
            crate::recovery::RecoveryPointKind::PreRecoveryAction
        );
        let saved = Connection::open_with_flags(
            &points[0].snapshot_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(saved.query_row("SELECT status,generation,request_json FROM table_attempt_recovery_v1 WHERE kind='whole_order_cancel'", [],
            |r| Ok((r.get::<_, String>(0)?,r.get::<_, i64>(1)?,r.get::<_, String>(2)?))).unwrap(),
            ("conflict".into(),0,original.clone()), "snapshot must precede the processing claim");
        assert_eq!(
            saved
                .query_row("SELECT status FROM orders WHERE id=?1", [&local], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            "pending"
        );
        drop(saved);
        assert_eq!(
            transport.calls.lock().unwrap().len(),
            1,
            "must read the selected original receipt"
        );
        assert!(transport
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|(_, method, body)| method == "GET" && body.is_none()));
        {
            let conn = disk.state.conn.lock().unwrap();
            assert_eq!(
                conn.query_row("SELECT status FROM orders WHERE id=?1", [&local], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
                "cancelled"
            );
            assert_eq!(
                conn.query_row(
                    "SELECT request_json FROM table_attempt_recovery_v1",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                original
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM order_payments", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM table_attempt_recovery_audit_v1 WHERE outcome='applied'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
            let audit: String = conn.query_row("SELECT before_json FROM table_attempt_recovery_audit_v1 WHERE outcome='original_confirmation_selected'", [], |r| r.get(0)).unwrap();
            let audit: Value = serde_json::from_str(&audit).unwrap();
            assert_eq!(audit["snapshotId"], json!(points[0].id));
            assert_eq!(audit["remedyVersion"], json!(1));
            assert_eq!(audit["status"], json!("conflict"));
            assert_eq!(audit["generation"], json!(0));
        }
        assert_eq!(
            confirm_original_with_transport(&disk.state, "cancel-original", &transport)
                .await
                .unwrap()["state"],
            json!("applied")
        );
        assert_eq!(
            transport.calls.lock().unwrap().len(),
            1,
            "already admitted original must be quiet"
        );
        assert_eq!(
            crate::recovery::list_recovery_points(&disk.state)
                .unwrap()
                .len(),
            1,
            "already admitted original creates no additional snapshot"
        );
    }

    #[tokio::test]
    async fn original_cancel_confirmation_snapshot_failure_prevents_claim_or_dispatch() {
        let disk = crate::tests::harness::TestDb::open();
        let (local, original) = original_conflict(&disk.state);
        let root = crate::recovery::recovery_root_for_db(&disk.state);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("points"), b"blocked snapshot directory").unwrap();
        let transport = fake(Some(cancel_receipt()));
        assert!(
            confirm_original_with_transport(&disk.state, "cancel-original", &transport)
                .await
                .is_err()
        );
        assert!(transport.calls.lock().unwrap().is_empty());
        let conn = disk.state.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT status,generation,request_json FROM table_attempt_recovery_v1",
                [],
                |r| Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?
                ))
            )
            .unwrap(),
            ("conflict".into(), 0, original)
        );
        assert_eq!(
            conn.query_row("SELECT status FROM orders WHERE id=?1", [&local], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "pending"
        );
    }

    #[tokio::test]
    async fn original_cancel_confirmation_never_claims_another_pending_item_edit() {
        let disk = crate::tests::harness::TestDb::open();
        let (local, original) = original_conflict(&disk.state);
        {
            let conn = disk.state.conn.lock().unwrap();
            remember_item(&conn, &local, &request()).unwrap();
            due(&conn);
        }
        let transport = fake(Some(cancel_receipt()));
        let confirmed = confirm_original_with_transport(&disk.state, "cancel-original", &transport)
            .await
            .unwrap();
        assert_eq!(confirmed["state"], json!("applied"));
        assert!(transport
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(
                |(path, method, body)| path.contains("/operations/cancel-original?")
                    && method == "GET"
                    && body.is_none()
            ));
        let conn = disk.state.conn.lock().unwrap();
        let retained: (String, String) = conn.query_row("SELECT status,request_json FROM table_attempt_recovery_v1 WHERE kind='whole_order_cancel'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(retained, ("applied".into(), original));
        assert_eq!(
            conn.query_row(
                "SELECT status FROM table_attempt_recovery_v1 WHERE kind='item_edit'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "pending"
        );
    }

    #[tokio::test]
    async fn original_cancel_confirmation_rejects_wrong_kind_state_or_owner_without_network() {
        for change in [
            "status='pending'",
            "status='processing'",
            "last_error_code='AUTHORIZATION_REQUIRED'",
            "kind='item_edit'",
            "owner_terminal_id='foreign'",
        ] {
            let disk = crate::tests::harness::TestDb::open();
            original_conflict(&disk.state);
            disk.state
                .conn
                .lock()
                .unwrap()
                .execute(
                    &format!("UPDATE table_attempt_recovery_v1 SET {change}"),
                    [],
                )
                .unwrap();
            let transport = fake(Some(cancel_receipt()));
            assert!(
                confirm_original_with_transport(&disk.state, "cancel-original", &transport)
                    .await
                    .is_err(),
                "{change}"
            );
            assert!(transport.calls.lock().unwrap().is_empty(), "{change}");
        }
    }

    #[tokio::test]
    async fn original_cancel_confirmation_retains_uncommitted_or_invalid_original() {
        for reply in [
            None,
            Some({
                let mut reply = cancel_receipt();
                reply["event"]["approved_staff_id"] = json!(ORG);
                reply
            }),
            Some({
                let mut reply = cancel_receipt();
                reply["cafe_lan_snapshot"]["sessions"][0]["branch_id"] = json!(ORG);
                reply
            }),
        ] {
            let disk = crate::tests::harness::TestDb::open();
            let (local, original) = original_conflict(&disk.state);
            let transport = fake(reply);
            let confirmed =
                confirm_original_with_transport(&disk.state, "cancel-original", &transport)
                    .await
                    .unwrap();
            assert_ne!(confirmed["state"], json!("applied"));
            assert_eq!(transport.calls.lock().unwrap().len(), 1);
            assert!(transport
                .calls
                .lock()
                .unwrap()
                .iter()
                .all(|(_, method, body)| method == "GET" && body.is_none()));
            let conn = disk.state.conn.lock().unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT request_json FROM table_attempt_recovery_v1",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                original
            );
            assert_eq!(
                conn.query_row("SELECT status FROM orders WHERE id=?1", [&local], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
                "pending"
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM order_payments", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[tokio::test]
    async fn original_cancel_confirmation_refuses_another_parent_with_a_valid_receipt_scope() {
        let disk = crate::tests::harness::TestDb::open();
        let (local, original) = original_conflict(&disk.state);
        let mut receipt = cancel_receipt();
        receipt["event"]["order_id"] = json!(ACTOR);
        receipt["cafe_lan_snapshot"]["orders"][0]["id"] = json!(ACTOR);
        receipt["cafe_lan_snapshot"]["sessions"][0]["active_order_id"] = json!(ACTOR);
        receipt["cafe_lan_snapshot"]["sessions"][0]["order"]["id"] = json!(ACTOR);
        let result =
            confirm_original_with_transport(&disk.state, "cancel-original", &fake(Some(receipt)))
                .await
                .unwrap();
        assert_eq!(result["state"], json!("conflict"));
        assert_eq!(
            result["errorCode"],
            json!("CANONICAL_RECEIPT_IDENTITY_CHANGED")
        );
        let conn = disk.state.conn.lock().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT status FROM orders WHERE id=?1", [&local], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "pending"
        );
        assert_eq!(
            conn.query_row(
                "SELECT request_json FROM table_attempt_recovery_v1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            original
        );
    }

    struct OriginalCancelRace<'a> {
        db: &'a DbState,
        change: &'static str,
    }
    impl Transport for OriginalCancelRace<'_> {
        fn send(
            &self,
            path: String,
            method: &'static str,
            body: Option<Value>,
        ) -> Pin<Box<dyn Future<Output = Result<Value, Failure>> + Send + '_>> {
            Box::pin(async move {
                assert!(path.contains("/operations/cancel-original?"));
                assert_eq!(method, "GET");
                assert!(body.is_none());
                let conn = self.db.conn.lock().unwrap();
                match self.change {
                    "request" => {
                        conn.execute(
                            "UPDATE table_attempt_recovery_v1 SET request_json=request_json||' '",
                            [],
                        )
                        .unwrap();
                    }
                    "generation" => {
                        conn.execute(
                            "UPDATE table_attempt_recovery_v1 SET generation=generation+1",
                            [],
                        )
                        .unwrap();
                    }
                    "owner" => {
                        crate::db::set_setting(&conn, "terminal", "owner_terminal_db_id", ACTOR)
                            .unwrap();
                    }
                    _ => unreachable!(),
                }
                Ok(cancel_receipt())
            })
        }
    }

    #[tokio::test]
    async fn original_cancel_confirmation_checks_frozen_bytes_generation_and_binding_after_await() {
        for change in ["request", "generation", "owner"] {
            let disk = crate::tests::harness::TestDb::open();
            let (local, original) = original_conflict(&disk.state);
            let transport = OriginalCancelRace {
                db: &disk.state,
                change,
            };
            let result =
                confirm_original_with_transport(&disk.state, "cancel-original", &transport).await;
            if change == "generation" {
                assert_eq!(result.unwrap()["state"], json!("stale"));
            } else {
                assert!(result.is_err(), "{change}");
            }
            let conn = disk.state.conn.lock().unwrap();
            assert_eq!(
                conn.query_row("SELECT status FROM orders WHERE id=?1", [&local], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
                "pending"
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM order_payments", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                conn.query_row(
                    "SELECT request_json FROM table_attempt_recovery_v1",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                if change == "request" {
                    original + " "
                } else {
                    original
                }
            );
        }
    }

    #[tokio::test]
    async fn original_cancel_confirmation_preserves_conflicting_local_work() {
        let disk = crate::tests::harness::TestDb::open();
        let (local, original) = original_conflict(&disk.state);
        disk.state
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE orders SET sync_status='pending',total_amount=99 WHERE id=?1",
                [&local],
            )
            .unwrap();
        let result = confirm_original_with_transport(
            &disk.state,
            "cancel-original",
            &fake(Some(cancel_receipt())),
        )
        .await
        .unwrap();
        assert_eq!(result["state"], json!("conflict"));
        let conn = disk.state.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT total_amount FROM orders WHERE id=?1",
                [&local],
                |r| r.get::<_, f64>(0)
            )
            .unwrap(),
            99.0
        );
        assert_eq!(
            conn.query_row(
                "SELECT request_json FROM table_attempt_recovery_v1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            original
        );
    }

    #[test]
    fn original_cancel_confirmation_claim_and_scope_fences_reject_late_results() {
        let disk = crate::tests::harness::TestDb::open();
        let (local, original) = original_conflict(&disk.state);
        let conn = disk.state.conn.lock().unwrap();
        let (scope, selected) = select_original_cancel(&conn, "cancel-original")
            .unwrap()
            .expect("selected original");
        let attempt =
            claim_original_cancel(&conn, &scope, &selected, "test-restore-point").unwrap();
        assert!(
            claim_original_cancel(&conn, &scope, &selected, "test-restore-point").is_err(),
            "duplicate operator claim"
        );
        conn.execute(
            "UPDATE table_attempt_recovery_v1 SET generation=generation+1",
            [],
        )
        .unwrap();
        assert_eq!(
            finish(&conn, &scope, &attempt, Ok(Some(cancel_receipt()))).unwrap()["state"],
            json!("stale")
        );
        crate::db::set_setting(&conn, "terminal", "owner_terminal_db_id", ACTOR).unwrap();
        assert!(finish(&conn, &scope, &attempt, Ok(Some(cancel_receipt()))).is_err());
        assert_eq!(
            conn.query_row(
                "SELECT request_json FROM table_attempt_recovery_v1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            original
        );
        assert_eq!(
            conn.query_row("SELECT status FROM orders WHERE id=?1", [&local], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "pending"
        );
    }
    #[tokio::test]
    async fn crash_attempt_item_disk_restart_replays_immutable_body_and_applies_before_ack() {
        let db = crate::tests::harness::TestDb::open();
        let local = setup(&db.state);
        {
            let conn = db.state.conn.lock().unwrap();
            remember_item(&conn, &local, &request()).unwrap();
            due(&conn);
        }
        let db = db.restart();
        let (scope, attempt) = {
            let conn = db.state.conn.lock().unwrap();
            claim(&conn).unwrap().unwrap()
        };
        let transport = fake(None);
        let reply = dispatch(&transport, &attempt).await;
        assert_eq!(transport.calls.lock().unwrap()[0].2, Some(request()));
        let conn = db.state.conn.lock().unwrap();
        let applied = finish(&conn, &scope, &attempt, reply).unwrap();
        assert_eq!(applied["state"], json!("applied"));
        assert_eq!(
            conn.query_row("SELECT version FROM orders WHERE id=?1", [&local], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(claim(&conn).unwrap().is_none());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM order_payments", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(transport
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|(_, method, _)| method != "POST"));
    }
    #[tokio::test]
    async fn crash_edit_foreground_mirrors_full_financial_header_before_ack_without_redispatch() {
        let disk = crate::tests::harness::TestDb::open();
        let local = setup(&disk.state);
        let (scope, attempt) = {
            let conn = disk.state.conn.lock().unwrap();
            remember_item(&conn, &local, &request()).unwrap();
            due(&conn);
            claim(&conn).unwrap().unwrap()
        };
        let mut transport = fake(None);
        let mut full = parent(2, "pending");
        full["subtotal"] = json!(18);
        full["tax_amount"] = json!(2);
        full["discount_amount"] = json!(10);
        transport.fresh_parent = Some(full);
        let response = item_snapshot(&transport, &attempt, false).await.unwrap();
        assert!(transport
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|(_, method, _)| method == "GET"));
        let conn = disk.state.conn.lock().unwrap();
        apply_foreground_item_snapshot(&conn, &scope, &attempt, &response).unwrap();
        let finance:(f64,i64,f64,i64,f64,i64)=conn.query_row("SELECT subtotal,subtotal_cents,tax_amount,tax_amount_cents,discount_amount,discount_amount_cents FROM orders WHERE id=?1",[&local],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).unwrap();
        assert_eq!(finance, (18.0, 1800, 2.0, 200, 10.0, 1000));
        assert_eq!(
            inspect_edit(&conn, "original-event", &local)
                .unwrap()
                .unwrap()["recoveryState"],
            json!("applied")
        );
        conn.execute(
            "UPDATE orders SET sync_status='pending',total_amount=99 WHERE id=?1",
            [&local],
        )
        .unwrap();
        assert!(apply_foreground_item_snapshot(&conn, &scope, &attempt, &response).is_err());
        assert_eq!(
            conn.query_row(
                "SELECT total_amount FROM orders WHERE id=?1",
                [&local],
                |r| r.get::<_, f64>(0)
            )
            .unwrap(),
            99.0
        );
    }

    #[tokio::test]
    async fn crash_attempt_same_version_changed_money_snapshot_never_acknowledges() {
        let disk = crate::tests::harness::TestDb::open();
        let local = setup(&disk.state);
        let (scope, attempt) = {
            let conn = disk.state.conn.lock().unwrap();
            remember_item(&conn, &local, &request()).unwrap();
            due(&conn);
            claim(&conn).unwrap().unwrap()
        };
        let mut transport = fake(None);
        let mut changed = parent(2, "pending");
        changed["updated_at"] = json!("2099-01-01T12:01:00Z");
        transport.final_parent = Some(changed);
        let result = dispatch(&transport, &attempt).await;
        assert_eq!(
            result.as_ref().unwrap_err().code,
            "CANONICAL_SNAPSHOT_CHANGED"
        );
        let conn = disk.state.conn.lock().unwrap();
        assert_eq!(
            finish(&conn, &scope, &attempt, result).unwrap()["state"],
            json!("pending")
        );
        assert_eq!(
            conn.query_row("SELECT version FROM orders WHERE id=?1", [&local], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn crash_attempt_edit_inspection_accepts_canonical_alias_and_fences_owner() {
        let disk = crate::tests::harness::TestDb::open();
        let local = setup(&disk.state);
        let conn = disk.state.conn.lock().unwrap();
        remember_item(&conn, &local, &request()).unwrap();
        foreground_applied(&conn, "item_edit", "original-event").unwrap();
        assert_eq!(
            inspect_edit(&conn, "original-event", ORDER)
                .unwrap()
                .unwrap()["recoveryState"],
            json!("applied")
        );
        crate::db::set_setting(&conn, "terminal", "owner_terminal_db_id", ACTOR).unwrap();
        assert!(inspect_edit(&conn, "original-event", ORDER)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn crash_attempt_cancel_missing_receipt_never_dispatches_approval_or_mutation() {
        let db = crate::tests::harness::TestDb::open();
        let local = setup(&db.state);
        let (scope, attempt) = {
            let conn = db.state.conn.lock().unwrap();
            remember_cancel(
                &conn,
                &local,
                SESSION,
                "cancel-original",
                "guest left",
                ACTOR,
            )
            .unwrap();
            due(&conn);
            claim(&conn).unwrap().unwrap()
        };
        let transport = fake(None);
        let result = dispatch(&transport, &attempt).await;
        let conn = db.state.conn.lock().unwrap();
        assert_eq!(
            finish(&conn, &scope, &attempt, result).unwrap()["state"],
            json!("approval_required")
        );
        assert_eq!(
            conn.query_row("SELECT status FROM orders WHERE id=?1", [&local], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "pending"
        );
        assert!(transport
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|(path, method, body)| path.contains("/operations/")
                && method == "GET"
                && body.is_none()));
        assert!(claim(&conn).unwrap().is_none());
        let raw: String = conn
            .query_row(
                "SELECT request_json FROM table_attempt_recovery_v1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!raw.contains("approval_token"));
        assert!(!raw.contains("pin"));
    }
    #[tokio::test]
    async fn crash_attempt_cancel_auth_renewal_rechecks_receipt_without_approval_or_mutation() {
        let disk = crate::tests::harness::TestDb::open();
        let local = setup(&disk.state);
        let (scope, attempt) = {
            let conn = disk.state.conn.lock().unwrap();
            remember_cancel(
                &conn,
                &local,
                SESSION,
                "cancel-original",
                "Guest left",
                ACTOR,
            )
            .unwrap();
            due(&conn);
            claim(&conn).unwrap().unwrap()
        };
        {
            let conn = disk.state.conn.lock().unwrap();
            let denied = finish(
                &conn,
                &scope,
                &attempt,
                Err(Failure::guarded("AUTHORIZATION_REQUIRED")),
            )
            .unwrap();
            assert_eq!(denied["state"], json!("auth_required"));
            assert!(denied["nextRetryAt"].is_string());
            assert!(claim(&conn).unwrap().is_none());
            due(&conn);
        }
        let (scope, attempt) = {
            let conn = disk.state.conn.lock().unwrap();
            claim(&conn).unwrap().unwrap()
        };
        let transport = fake(Some(cancel_receipt()));
        let result = dispatch(&transport, &attempt).await;
        let conn = disk.state.conn.lock().unwrap();
        assert_eq!(
            finish(&conn, &scope, &attempt, result).unwrap()["state"],
            json!("applied")
        );
        assert!(transport
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|(_, method, _)| method == "GET"));
    }

    #[tokio::test]
    async fn crash_attempt_cancel_committed_receipt_recovers_once_without_new_cancel() {
        let db = crate::tests::harness::TestDb::open();
        let local = setup(&db.state);
        {
            let conn = db.state.conn.lock().unwrap();
            remember_cancel(
                &conn,
                &local,
                SESSION,
                "cancel-original",
                "guest left",
                ACTOR,
            )
            .unwrap();
            due(&conn);
        }
        let db = db.restart();
        let (scope, attempt) = {
            let conn = db.state.conn.lock().unwrap();
            claim(&conn).unwrap().unwrap()
        };
        let transport = fake(Some(cancel_receipt()));
        let result = dispatch(&transport, &attempt).await;
        let conn = db.state.conn.lock().unwrap();
        assert_eq!(
            finish(&conn, &scope, &attempt, result).unwrap()["state"],
            json!("applied")
        );
        assert_eq!(
            conn.query_row("SELECT status FROM orders WHERE id=?1", [&local], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "cancelled"
        );
        assert!(claim(&conn).unwrap().is_none());
        assert_eq!(transport.calls.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn crash_attempt_incomplete_snapshot_or_wrong_actor_never_acknowledges() {
        let db = crate::tests::harness::TestDb::open();
        let local = setup(&db.state);
        let (scope, attempt) = {
            let conn = db.state.conn.lock().unwrap();
            remember_cancel(
                &conn,
                &local,
                SESSION,
                "cancel-original",
                "guest left",
                ACTOR,
            )
            .unwrap();
            due(&conn);
            claim(&conn).unwrap().unwrap()
        };
        let mut invalid = cancel_receipt();
        invalid["cafe_lan_snapshot"]["sessions"][0]["branch_id"] = json!(ORG);
        let transport = fake(Some(invalid));
        let result = dispatch(&transport, &attempt).await;
        let conn = db.state.conn.lock().unwrap();
        assert_eq!(
            finish(&conn, &scope, &attempt, result).unwrap()["state"],
            json!("conflict")
        );
        assert_eq!(
            conn.query_row("SELECT status FROM orders WHERE id=?1", [&local], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "pending"
        );
        drop(conn);
        let mut invalid = cancel_receipt();
        invalid["event"]["approved_staff_id"] = json!(ORG);
        assert_eq!(
            dispatch(&fake(Some(invalid)), &attempt)
                .await
                .unwrap_err()
                .code,
            "CANONICAL_RECEIPT_IDENTITY_CHANGED"
        );
        let mut incomplete = cancel_receipt();
        incomplete
            .as_object_mut()
            .unwrap()
            .remove("cafe_lan_snapshot");
        assert_eq!(
            dispatch(&fake(Some(incomplete)), &attempt)
                .await
                .unwrap_err()
                .code,
            "CANONICAL_SNAPSHOT_INVALID"
        );
    }
    #[test]
    fn crash_attempt_lease_generation_and_scope_fence_late_response() {
        let db = crate::tests::harness::TestDb::open();
        let local = setup(&db.state);
        let conn = db.state.conn.lock().unwrap();
        remember_item(&conn, &local, &request()).unwrap();
        due(&conn);
        let (scope, old) = claim(&conn).unwrap().unwrap();
        assert!(claim(&conn).unwrap().is_none());
        conn.execute(
            "UPDATE table_attempt_recovery_v1 SET lease_until='2000-01-01T00:00:00Z'",
            [],
        )
        .unwrap();
        let (_, new) = claim(&conn).unwrap().unwrap();
        assert!(new.generation > old.generation);
        assert_eq!(
            finish(&conn, &scope, &old, Ok(Some(json!({"success":true})))).unwrap()["state"],
            json!("stale")
        );
        crate::db::set_setting(&conn, "terminal", "branch_id", ORG).unwrap();
        assert!(finish(&conn, &scope, &new, Ok(None)).is_err());
    }
    #[test]
    fn crash_attempt_transport_cooldown_survives_restart_and_permanent_errors_park() {
        let db = crate::tests::harness::TestDb::open();
        let local = setup(&db.state);
        {
            let conn = db.state.conn.lock().unwrap();
            remember_item(&conn, &local, &request()).unwrap();
            due(&conn);
            let (scope, attempt) = claim(&conn).unwrap().unwrap();
            let event = finish(
                &conn,
                &scope,
                &attempt,
                Err(Failure::from(crate::api::AdminFetchError::transport(
                    "lost connection",
                ))),
            )
            .unwrap();
            assert_eq!(event["state"], json!("pending"));
            assert!(event["nextRetryAt"].is_string());
        }
        let db = db.restart();
        let conn = db.state.conn.lock().unwrap();
        assert!(claim(&conn).unwrap().is_none());
        due(&conn);
        let (scope, attempt) = claim(&conn).unwrap().unwrap();
        assert_eq!(attempt.request, request());
        assert_eq!(
            finish(
                &conn,
                &scope,
                &attempt,
                Err(Failure::from(crate::api::AdminFetchError::with_status(
                    "denied", 403
                )))
            )
            .unwrap()["state"],
            json!("auth_required")
        );
        assert!(claim(&conn).unwrap().is_none());
        assert!(!Failure::from(crate::api::AdminFetchError::with_status("unknown", 500)).retry);
        assert!(
            Failure::from(crate::api::AdminFetchError::with_status(
                "temporarily unavailable",
                503
            ))
            .retry
        );
    }
    #[test]
    fn crash_attempt_changed_body_with_same_event_is_rejected() {
        let db = crate::tests::harness::TestDb::open();
        let local = setup(&db.state);
        let conn = db.state.conn.lock().unwrap();
        remember_item(&conn, &local, &request()).unwrap();
        let mut changed = request();
        changed["expected_version"] = json!(2);
        assert_eq!(
            remember_item(&conn, &local, &changed).unwrap_err(),
            "RECOVERY_ORIGINAL_REQUEST_REQUIRED"
        );
    }
}
