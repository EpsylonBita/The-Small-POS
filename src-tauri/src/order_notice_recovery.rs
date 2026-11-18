//! The refused customer correction is retained until a fresh, scoped snapshot
//! permits an audited replacement. Queue scheduling is never proof of healing.
use crate::{order_header_preflight as preflight, sync_queue};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicI8, Ordering},
    OnceLock,
};
use tauri::Emitter;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static REACHABLE: AtomicI8 = AtomicI8::new(-1);
#[cfg(test)]
thread_local! {
    // A reachability test must not change the state seen by parallel payment tests.
    static TEST_REACHABLE: std::cell::Cell<Option<Option<bool>>> = const { std::cell::Cell::new(None) };
}
pub(crate) fn install_events(app: tauri::AppHandle) {
    let _ = APP.set(app);
}
pub(crate) fn set_server_reachable(online: bool) {
    REACHABLE.store(i8::from(online), Ordering::Relaxed);
}
pub(crate) fn online() -> bool {
    REACHABLE.load(Ordering::Relaxed) == 1
}
pub(crate) fn notify_queue_changed() {
    if let Some(app) = APP.get() {
        let _ = app.emit("order_sync_notices_changed", json!({}));
    }
}

pub(crate) const RESEND: &str = "resendOrderCustomerCorrection";
pub(crate) const KEEP: &str = "keepServerOrderCustomerDetails";

/// Optional observers never borrow the till's business mutex. Only WAL allows
/// an independent reader without delaying its writer; older/non-file stores
/// skip this pass. Zero busy timeout also keeps automatic writes best effort.
pub(crate) fn observer_connection(
    path: &std::path::Path,
    write: bool,
) -> Result<Connection, String> {
    let flags = if write {
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let conn = Connection::open_with_flags(path, flags | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| "ORDER_NOTICE_DATABASE_UNAVAILABLE")?;
    conn.busy_timeout(std::time::Duration::ZERO)
        .map_err(|_| "ORDER_NOTICE_DATABASE_UNAVAILABLE")?;
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .map_err(|_| "ORDER_NOTICE_DATABASE_UNAVAILABLE")?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err("ORDER_NOTICE_WAL_REQUIRED".into());
    }
    // A remedy's audit, retirement and replacement are as durable as any write
    // of the business connection (`db::open_and_configure`).
    conn.execute_batch(if write {
        "PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL"
    } else {
        "PRAGMA foreign_keys=ON"
    })
    .map_err(|_| "ORDER_NOTICE_DATABASE_UNAVAILABLE")?;
    if !write {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
        conn.progress_handler(100, Some(move || std::time::Instant::now() >= deadline));
    }
    Ok(conn)
}

/// What reaches us must say what kind of failure it was, so that we know
/// where to start (founder, 17/11/2026). The message is never logged or sent:
/// it is only matched against these fixed classes, and the one name taken from
/// it is a lower-case schema identifier of the till's own static SQL. Android
/// uses the same vocabulary (`orderNoticeFailureCode`).
pub(crate) fn notice_failure_code(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    let named = |prefix: &str, marker: &str| -> String {
        let name = lower
            .find(marker)
            .map(|at| error[at + marker.len()..].trim_start())
            .map(|rest| {
                rest.chars()
                    .take_while(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.')
                    })
                    .collect::<String>()
            })
            .and_then(|path| path.rsplit('.').next().map(str::to_string))
            .filter(|name| {
                name.len() <= 40
                    && name
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
            });
        let mut code = match name {
            Some(name) => format!("{prefix}_{}", name.to_ascii_uppercase()),
            None => prefix.to_string(),
        };
        code.truncate(64);
        code
    };
    if lower.contains("no such table") {
        return named("NOTICE_TABLE_MISSING", "no such table:");
    }
    if lower.contains("no such column") {
        return named("NOTICE_COLUMN_MISSING", "no such column:");
    }
    let class = [
        ("malformed json", "NOTICE_DATA_MALFORMED"),
        ("disk image is malformed", "NOTICE_DATABASE_DAMAGED"),
        ("not a database", "NOTICE_DATABASE_DAMAGED"),
        ("database is locked", "NOTICE_DATABASE_BUSY"),
        ("database table is locked", "NOTICE_DATABASE_BUSY"),
        ("database is busy", "NOTICE_DATABASE_BUSY"),
        ("interrupted", "NOTICE_READ_INTERRUPTED"),
        ("disk i/o error", "NOTICE_STORAGE_ERROR"),
        ("database or disk is full", "NOTICE_STORAGE_ERROR"),
        ("unable to open database", "NOTICE_STORAGE_ERROR"),
        // `table_session_cache::current_scope`: the till's own identity is missing.
        ("table cache", "ORDER_NOTICE_SCOPE_UNAVAILABLE"),
    ]
    .iter()
    .find(|(text, _)| lower.contains(text))
    .map(|(_, code)| *code);
    if let Some(code) = class {
        return code.into();
    }
    match crate::order_notice_evidence::machine_code(error).as_str() {
        "UNCLASSIFIED_REFUSAL" => "ORDER_NOTICE_OBSERVATION_FAILED".into(),
        code => code.into(),
    }
}

/// Our own classifier's output, or a code that reached Health through it.
pub(crate) fn is_notice_failure_code(code: &str) -> bool {
    (3..=64).contains(&code.len())
        && code.starts_with(|c: char| c.is_ascii_uppercase())
        && code
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// Log only a fixed site and the kind of failure, never a raw SQLite/request error.
pub(crate) fn observe<T>(site: &'static str, result: Result<T, String>) -> Result<T, String> {
    if let Err(error) = &result {
        tracing::warn!(site, code = %notice_failure_code(error),
            "Optional order notice work skipped");
    }
    result
}

pub(crate) fn opened_at(conn: &Connection, queue: &str) -> Result<String, String> {
    conn.query_row("SELECT COALESCE((SELECT MIN(json_extract(payload_json,'$.openedAt')) FROM recovery_action_log WHERE json_extract(payload_json,'$.replacementQueueId')=?1),(SELECT COALESCE(last_attempt,created_at) FROM parity_sync_queue WHERE id=?1))",[queue],|r|r.get(0)).map_err(|e|e.to_string())
}

#[derive(Clone, Debug)]
pub(crate) struct Refused {
    pub id: String,
    pub order: String,
    pub data: String,
    pub error: String,
    pub status: String,
}

pub(crate) fn matches(operation: &str, status: &str, error: &str, payload: &Value) -> bool {
    operation == "UPDATE"
        && sync_queue::has_only_order_header_keys(payload)
        && crate::edit_settlement_recovery::EDIT_HEADER_FIELDS
            .iter()
            .any(|(camel, snake)| {
                payload
                    .get(*camel)
                    .or_else(|| payload.get(*snake))
                    .is_some()
            })
        && ((status == "conflict"
            && error == sync_queue::UNKNOWN_CONFLICT_REVIEW
            && sync_queue::is_identified_order_edit_payload(payload))
            || (status == "failed"
                && error == "ORDER_EDIT_BASE_UNAVAILABLE"
                && sync_queue::is_marked_precreate_order_edit(payload)))
}

pub(crate) fn refused(conn: &Connection, id: &str) -> Result<Option<Refused>, String> {
    let scope = crate::table_session_cache::current_scope(conn)?;
    let row: Option<(Refused, String)> = conn
        .query_row(
            "SELECT q.id,q.record_id,q.data,COALESCE(q.error_message,''),q.status,
            COALESCE(q.last_attempt,q.created_at),q.operation
         FROM parity_sync_queue q JOIN orders o ON o.id=q.record_id
         WHERE q.id=?1 AND q.table_name='orders' AND q.organization_id=?2
           AND o.organization_id=?2 AND o.branch_id=?3
           AND COALESCE(q.module_type,'')<>'repairs'
           AND lower(trim(COALESCE(o.plugin,''))) IN ('','pos')
           AND NULLIF(o.table_session_id,'') IS NULL AND NULLIF(o.table_id,'') IS NULL
           AND COALESCE(o.order_context,'')<>'repair_settlement'
           AND NOT EXISTS(SELECT 1 FROM parity_sync_set_aside s WHERE s.queue_id=q.id)",
            params![id, scope.organization, scope.branch],
            |r| {
                Ok((
                    Refused {
                        id: r.get(0)?,
                        order: r.get(1)?,
                        data: r.get(2)?,
                        error: r.get(3)?,
                        status: r.get(4)?,
                    },
                    r.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.and_then(|(row, op)| {
        serde_json::from_str::<Value>(&row.data)
            .ok()
            .filter(|p| matches(&op, &row.status, &row.error, p))
            .map(|_| row)
    }))
}

pub(crate) fn capture(conn: &Connection, row: &Refused) -> Result<Value, String> {
    if sync_queue::order_write_holds_payment(conn, &row.order)? {
        return Err("ORDER_HEADER_SYNC_REQUIRED".into());
    }
    preflight::capture_except(conn, &row.order, &Value::Null, Some(&row.id))
}

pub(crate) fn verify(before: &Value, answer: &Value) -> Result<Value, String> {
    let canonical = preflight::exact_order(answer)?;
    if canonical["id"] != before["id"]
        || canonical["organization_id"] != before["organizationId"]
        || canonical["branch_id"] != before["branchId"]
    {
        return Err("EDIT_SETTLEMENT_SCOPE_MISMATCH".into());
    }
    let version = canonical["version"]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
    if before["remoteVersion"]
        .as_i64()
        .is_some_and(|v| version < v)
        || preflight::drift(before, canonical)?
            .iter()
            .any(|(_, adoptable)| !adoptable)
    {
        return Err("EDIT_CANONICAL_ORIGINAL_CHANGED".into());
    }
    Ok(canonical.clone())
}

/// Caller owns the immediate transaction and native critical-operation fence.
pub(crate) fn apply(
    conn: &Connection,
    row: &Refused,
    before: &Value,
    answer: &Value,
    action: &str,
    snapshot: &str,
) -> Result<Value, String> {
    let Some(current) = refused(conn, &row.id)? else {
        return Ok(
            json!({"success":true,"requiresRefresh":true,"verification":{"status":"pending"}}),
        );
    };
    if current.data != row.data
        || current.status != row.status
        || current.error != row.error
        || capture(conn, &current)? != *before
    {
        return Err("ORDER_VERSION_CONFLICT".into());
    }
    let canonical = verify(before, answer)?;
    let scope = crate::table_session_cache::current_scope(conn)?;
    let mut payload: Value = serde_json::from_str(&row.data).map_err(|e| e.to_string())?;
    let event = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let new_id = if action == RESEND {
        payload["client_event_id"] = json!(event);
        payload["expected_version"] = canonical["version"].clone();
        // Status is the new request's envelope, not a customer correction.
        // Delivery may have progressed while the original was parked. Use
        // the freshly verified till/server status, never replay the old one.
        payload["status"] = canonical["status"].clone();
        payload
            .as_object_mut()
            .ok_or("REMEDY_NOT_APPLICABLE")?
            .remove("base_before_create");
        payload["header_edit_original"] =
            json!({"version":1,"canonicalVersion":canonical["version"],"original":before});
        let intended: Vec<(&str, Value)> = crate::edit_settlement_recovery::EDIT_HEADER_FIELDS
            .iter()
            .filter_map(|(camel, snake)| {
                payload
                    .get(*snake)
                    .or_else(|| payload.get(*camel))
                    .map(|value| (*snake, value.clone()))
            })
            .collect();
        sync_queue::adopt_edit_ack_headers(conn, &row.order, &scope.organization, &intended)?;
        Some(sync_queue::enqueue(
            conn,
            &sync_queue::EnqueueInput {
                table_name: "orders".into(),
                record_id: row.order.clone(),
                operation: "UPDATE".into(),
                data: payload.to_string(),
                organization_id: scope.organization.clone(),
                priority: Some(0),
                module_type: Some("orders".into()),
                conflict_strategy: Some("server-wins".into()),
                version: Some(1),
            },
        )?)
    } else if action == KEEP {
        let headers: Vec<(&str, Value)> = crate::edit_settlement_recovery::EDIT_HEADER_FIELDS
            .iter()
            .filter(|(_, key)| *key != "order_type")
            .map(|(_, key)| {
                canonical
                    .get(*key)
                    .map(|v| (*key, v.clone()))
                    .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")
            })
            .collect::<Result<_, _>>()?;
        sync_queue::adopt_edit_ack_headers(conn, &row.order, &scope.organization, &headers)?;
        conn.execute(
            "UPDATE orders SET remote_version=?1 WHERE id=?2 AND organization_id=?3",
            params![canonical["version"].as_i64(), row.order, scope.organization],
        )
        .map_err(|e| e.to_string())?;
        let adopted = crate::edit_settlement_recovery::capture_order_headers(conn, &row.order)?;
        if headers.iter().any(|(key, v)| {
            !crate::edit_settlement_recovery::same_canonical_header(&adopted[*key], v)
        }) {
            return Err("ORDER_VERSION_CONFLICT".into());
        }
        None
    } else {
        return Err("REMEDY_NOT_APPLICABLE".into());
    };
    let recipe = if action == RESEND {
        "order-customer-correction.resend"
    } else {
        "order-customer-correction.keep-server"
    };
    let outcome = if action == RESEND {
        "pending"
    } else {
        "resolved"
    };
    let opened = opened_at(conn, &row.id)?;
    conn.execute("INSERT INTO recovery_action_log (id,action_id,issue_code,issue_id,recipe_id,recipe_version,entity_type,entity_id,order_id,snapshot_point_id,success,created_at,payload_json) VALUES (?1,?2,'customer_correction_refused',?3,?4,1,'order',?5,?5,?6,?7,?8,?9)",params![uuid::Uuid::new_v4().to_string(),action,row.id,recipe,row.order,snapshot,action==KEEP,now,json!({"openedAt":opened,"nativeOrderCorrection":true,"outcome":outcome,"organizationId":scope.organization,"retiredQueueId":row.id,"retiredRequest":row.data,"reason":row.error,"replacementQueueId":new_id,"clientEventId":event}).to_string()]).map_err(|e|e.to_string())?;
    let removed = conn
        .execute(
            "DELETE FROM parity_sync_queue WHERE id=?1 AND data=?2 AND status=?3",
            params![row.id, row.data, row.status],
        )
        .map_err(|e| e.to_string())?;
    if removed != 1 {
        return Err("ORDER_VERSION_CONFLICT".into());
    }
    conn.execute("UPDATE recovery_action_log SET success=0,payload_json=json_set(payload_json,'$.outcome','failed') WHERE json_extract(payload_json,'$.nativeOrderCorrection')=1 AND json_extract(payload_json,'$.replacementQueueId')=?1",[&row.id]).map_err(|e|e.to_string())?;
    Ok(
        json!({"success":true,"requiresRefresh":true,"verification":{"status":if action==KEEP {"passed"}else{"pending"}},"snapshotPointId":snapshot}),
    )
}

/// Only called after the normal fenced ACK has validated and adopted the
/// canonical header snapshot. A vanished queue row alone is never success.
pub(crate) fn acknowledged(conn: &Connection, queue: &str, now: &str) -> Result<(), String> {
    conn.execute("UPDATE recovery_action_log SET success=1,payload_json=json_set(payload_json,'$.outcome','resolved','$.verifiedAt',?2) WHERE action_id=?3 AND json_extract(payload_json,'$.replacementQueueId')=?1",params![queue,now,RESEND]).map_err(|e|e.to_string())?;
    Ok(())
}

/// A later status write may prevent projection into the local order, but does
/// not invalidate the server's acknowledgement of this exact identified edit.
pub(crate) fn acknowledge_response(
    conn: &Connection,
    queue: &str,
    order: &str,
    payload: &Value,
    response: Option<&Value>,
    now: &str,
) -> Result<(), String> {
    let tracked:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM recovery_action_log WHERE json_extract(payload_json,'$.nativeOrderCorrection')=1 AND json_extract(payload_json,'$.replacementQueueId')=?1)",[queue],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !tracked {
        return Ok(());
    }
    let scope = crate::table_session_cache::current_scope(conn)?;
    let remote: String = conn
        .query_row(
            "SELECT supabase_id FROM orders WHERE id=?1 AND organization_id=?2 AND branch_id=?3",
            params![order, scope.organization, scope.branch],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let answer = response
        .filter(|r| r["success"] == true)
        .ok_or("ORDER_HEADER_ACK_SNAPSHOT_REQUIRED")?;
    let canonical = &answer["data"];
    if canonical["id"] != remote
        || canonical["organization_id"] != scope.organization
        || canonical["branch_id"] != scope.branch
        || !canonical["version"]
            .as_i64()
            .zip(payload["expected_version"].as_i64())
            .is_some_and(|(version, expected)| version > expected)
    {
        return Err("ORDER_HEADER_ACK_SNAPSHOT_REQUIRED".into());
    }
    acknowledged(conn, queue, now)
}

/// Indexed order lookups, never a page of the generic 500-row queue. `None`
/// reads the scoped orders needing attention for Health and shift checkout.
pub(crate) const ORDER_HAS_OPEN_NOTICE: &str = "ORDER_HAS_OPEN_NOTICE";
pub(crate) const ORDER_NOTICE_CHECK_UNAVAILABLE: &str = "ORDER_NOTICE_CHECK_UNAVAILABLE";

/// Staff completion uses the card's exact reader, including pending proof.
/// Call under the transaction that writes the status. Payment and incoming
/// snapshots do not call this guard; earlier stages and cancellation pass.
pub(crate) fn require_no_open_notice(
    conn: &Connection,
    order_id: &str,
    next_status: &str,
) -> Result<(), String> {
    if !matches!(next_status, "delivered" | "completed") {
        return Ok(());
    }
    let result = observe(
        "completion_gate",
        notices(conn, Some(&[order_id.to_string()])),
    );
    crate::order_notice_gate::record(conn, result.as_ref().err().map(String::as_str));
    let notices = result.map_err(|_| ORDER_NOTICE_CHECK_UNAVAILABLE.to_string())?;
    if notices.as_array().is_some_and(|rows| !rows.is_empty()) {
        return Err(ORDER_HAS_OPEN_NOTICE.into());
    }
    Ok(())
}

pub(crate) fn notices(conn: &Connection, ids: Option<&[String]>) -> Result<Value, String> {
    let reachable = match REACHABLE.load(Ordering::Relaxed) {
        1 => Some(true),
        0 => Some(false),
        _ => None,
    };
    #[cfg(test)]
    let reachable = TEST_REACHABLE
        .with(|value| value.get())
        .unwrap_or(reachable);
    notices_when(conn, ids, reachable)
}

/// `reachable` says whether the server answers now (`None`: not known yet).
/// A money row that only waits is the employee's business when the till is
/// online and the money still has not left after ten minutes. Offline, every
/// recent order waits and nobody can act on it: the till's own offline state
/// says so, the orders do not. A row refused for good always shows.
fn notices_when(
    conn: &Connection,
    ids: Option<&[String]>,
    reachable: Option<bool>,
) -> Result<Value, String> {
    let waiting_counts = reachable == Some(true);
    let scope = crate::table_session_cache::current_scope(conn)?;
    let selected = ids.map(|ids| json!(ids).to_string());
    let mut stmt=conn.prepare("SELECT q.id,o.id,COALESCE(o.order_number,o.id),q.operation,q.data,q.status,COALESCE(q.error_message,''),q.module_type,COALESCE(q.last_attempt,q.created_at),q.created_at,q.table_name FROM orders o JOIN parity_sync_queue q ON (q.table_name='orders' AND q.record_id=o.id) OR (q.table_name='payments' AND q.record_id IN (SELECT id FROM order_payments WHERE order_id=o.id)) OR (q.table_name='payment_adjustments' AND q.record_id IN (SELECT id FROM payment_adjustments WHERE order_id=o.id)) WHERE o.organization_id=?1 AND o.branch_id=?2 AND q.organization_id=?1 AND (?3 IS NULL OR o.id IN (SELECT value FROM json_each(?3))) AND q.status IN ('pending','processing','failed','conflict') AND NOT EXISTS(SELECT 1 FROM parity_sync_set_aside s WHERE s.queue_id=q.id)").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map(params![scope.organization, scope.branch, selected], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, String>(9)?,
                r.get::<_, String>(10)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        let (id, order, number, _, _, status, error, module, since, created, table) =
            row.map_err(|e| e.to_string())?;
        let parked = status == "conflict"
            || (status == "failed" && sync_queue::is_refused_for_good(&error, &module));
        let old = is_older_than_ten_minutes(conn, &created)?;
        let pending:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM recovery_action_log WHERE json_extract(payload_json,'$.nativeOrderCorrection')=1 AND action_id=?1 AND json_extract(payload_json,'$.replacementQueueId')=?2 AND json_extract(payload_json,'$.outcome')='pending')",params![RESEND,id],|r|r.get(0)).map_err(|e|e.to_string())?;
        let exact = table == "orders" && refused(conn, &id)?.is_some();
        let employee_pending: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM recovery_action_log WHERE issue_id=?1 AND json_extract(payload_json,'$.employeeOrderAttempt')=1 AND json_extract(payload_json,'$.outcome')<>'resolved')",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
        let kind = if exact || pending {
            "customer_correction_refused"
        } else if table != "orders" && (parked || employee_pending || (old && waiting_counts)) {
            "payment_not_on_server"
        } else if table == "orders" && (parked || employee_pending) {
            "change_refused"
        } else {
            continue;
        };
        result.push(json!({"orderId":order,"orderNumber":number,"kind":kind,"queueId":id,"since":since,"state":if (pending||employee_pending)&&!parked {"pending"}else if parked {"refused"}else{"waiting"},"failedAgain":pending&&parked,"actions":if exact {vec![RESEND,KEEP]}else{vec![]}}));
    }
    // The canonical financial outbox is separate from parity; include its
    // payment and adjustment rows without changing their recovery ownership.
    let mut stmt=conn.prepare("SELECT CAST(q.id AS TEXT),o.id,COALESCE(o.order_number,o.id),q.status,COALESCE(q.last_error,''),q.created_at,COALESCE(q.updated_at,q.created_at) FROM sync_queue q JOIN orders o ON o.id=CASE WHEN q.entity_type='payment' THEN (SELECT order_id FROM order_payments WHERE id=q.entity_id) WHEN q.entity_type='payment_adjustment' THEN (SELECT order_id FROM payment_adjustments WHERE id=q.entity_id) END WHERE o.organization_id=?1 AND o.branch_id=?2 AND (?3 IS NULL OR o.id IN (SELECT value FROM json_each(?3))) AND q.status NOT IN ('synced','applied') AND NOT EXISTS(SELECT 1 FROM parity_sync_queue p JOIN parity_sync_set_aside s ON s.queue_id=p.id WHERE p.record_id=q.entity_id)").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map(params![scope.organization, scope.branch, selected], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, order, number, status, error, created, updated) =
            row.map_err(|e| e.to_string())?;
        let old = is_older_than_ten_minutes(conn, &created)?;
        let parked = status == "failed" && sync_queue::is_refused_for_good(&error, "financial");
        let employee_pending: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM recovery_action_log WHERE issue_id=?1 AND json_extract(payload_json,'$.employeeOrderAttempt')=1 AND json_extract(payload_json,'$.outcome')<>'resolved')",[format!("financial:{id}")],|r|r.get(0)).map_err(|e|e.to_string())?;
        if parked || employee_pending || (old && waiting_counts) {
            result.push(json!({"orderId":order,"orderNumber":number,"kind":"payment_not_on_server","queueId":format!("financial:{id}"),"since":if parked {updated}else{created},"state":if parked {"refused"}else if employee_pending {"pending"}else{"waiting"},"actions":[]}));
        }
    }
    // A missing replacement without an ACK is still unverified. Retain its
    // notice, including after a generic clear; setting it aside is explicit.
    let mut stmt=conn.prepare("SELECT a.order_id,COALESCE(o.order_number,o.id),json_extract(a.payload_json,'$.replacementQueueId'),a.created_at FROM recovery_action_log a JOIN orders o ON o.id=a.order_id WHERE a.action_id=?1 AND json_extract(a.payload_json,'$.nativeOrderCorrection')=1 AND json_extract(a.payload_json,'$.outcome')='pending' AND o.organization_id=?2 AND o.branch_id=?3 AND (?4 IS NULL OR o.id IN (SELECT value FROM json_each(?4))) AND NOT EXISTS(SELECT 1 FROM parity_sync_queue q WHERE q.id=json_extract(a.payload_json,'$.replacementQueueId'))").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map(
            params![RESEND, scope.organization, scope.branch, selected],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (order, number, id, since) = row.map_err(|e| e.to_string())?;
        result.push(json!({"orderId":order,"orderNumber":number,"queueId":id,"since":since,"kind":"customer_correction_refused","state":"pending","actions":[]}));
    }
    let unavailable = if crate::support::critical_op::global().active() {
        Some("busy")
    } else if reachable == Some(false) {
        Some("offline")
    } else {
        None
    };
    for notice in &mut result {
        notice["unavailableReason"] = json!(unavailable);
        let id = notice["queueId"].as_str().unwrap_or_default();
        let audit: Option<String> = conn.query_row("SELECT payload_json FROM recovery_action_log WHERE (id=?1 OR (json_extract(payload_json,'$.nativeOrderCorrection')=1 AND json_extract(payload_json,'$.replacementQueueId')=?2)) AND json_extract(payload_json,'$.automatic')=1 ORDER BY created_at DESC LIMIT 1", params![format!("automatic-order-header:{id}"),id], |r| r.get(0)).optional().map_err(|e|e.to_string())?;
        let audit = audit.and_then(|value| serde_json::from_str::<Value>(&value).ok());
        let running = audit.as_ref().is_some_and(|a| a["outcome"] == "running");
        let queued = audit.as_ref().is_some_and(|a| a["outcome"] == "pending")
            && notice["state"] == "pending";
        let will_attempt = if let Some(row) = refused(conn, id)? {
            reachable == Some(true)
                && unavailable.is_none()
                && !crate::order_notice_auto::editing(&row.order)
                && crate::order_notice_auto::deferred_reason(id).is_none()
                && crate::order_notice_auto::eligible(conn, &row)?
        } else {
            false
        };
        notice["automatic"] = json!(running || queued || will_attempt);
        if running || queued || will_attempt {
            notice["state"] = json!("pending");
            notice["actions"] = json!([]);
        }
    }
    Ok(json!(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::orders::driver_restore_tests as fixture;

    fn setup(unbound: bool) -> (Connection, Refused, Value, Value) {
        let conn = fixture::test_conn();
        fixture::paid_delivery_order(&conn);
        let mut payload = json!({"customer_name":"Corrected","client_event_id":"refused-event","expected_version":1});
        if unbound {
            payload["base_before_create"] = json!(true);
            payload["expected_version"] = Value::Null;
        }
        let id = sync_queue::enqueue(
            &conn,
            &sync_queue::EnqueueInput {
                table_name: "orders".into(),
                record_id: fixture::ORDER.into(),
                operation: "UPDATE".into(),
                data: payload.to_string(),
                organization_id: fixture::ORG.into(),
                priority: None,
                module_type: None,
                conflict_strategy: None,
                version: None,
            },
        )
        .unwrap();
        conn.execute(
            "UPDATE parity_sync_queue SET status=?1,error_message=?2 WHERE id=?3",
            params![
                if unbound { "failed" } else { "conflict" },
                if unbound {
                    "ORDER_EDIT_BASE_UNAVAILABLE"
                } else {
                    "UNKNOWN_CONFLICT_REVIEW"
                },
                id
            ],
        )
        .unwrap();
        conn.execute(
            "UPDATE orders SET customer_name='Corrected' WHERE id=?1",
            [fixture::ORDER],
        )
        .unwrap();
        let row = refused(&conn, &id).unwrap().unwrap();
        let before = capture(&conn, &row).unwrap();
        let mut canonical = before["headers"].clone();
        for (key, value) in [
            ("id", before["id"].clone()),
            ("organization_id", before["organizationId"].clone()),
            ("branch_id", before["branchId"].clone()),
            ("status", before["status"].clone()),
            (
                "total_amount",
                json!(before["totalCents"].as_i64().unwrap() as f64 / 100.0),
            ),
            (
                "items",
                serde_json::from_str(before["items"].as_str().unwrap()).unwrap(),
            ),
            ("notes", before["notes"].clone()),
            (
                "special_instructions",
                before["special_instructions"].clone(),
            ),
            ("version", json!(50)),
            ("customer_name", json!("Earlier")),
        ] {
            canonical[key] = value;
        }
        let answer = json!({"success":true,"exact_order_lookup":true,"orders":[canonical]});
        (conn, row, before, answer)
    }

    #[test]
    fn open_notice_refuses_staff_completion_without_writing() {
        for status in ["delivered", "completed"] {
            let (conn, _, _, _) = setup(false);
            conn.execute(
                "UPDATE orders SET status='ready' WHERE id=?1",
                [fixture::ORDER],
            )
            .unwrap();
            let before = conn.total_changes();
            let result = crate::commands::orders::apply_order_status_in_connection(
                &conn,
                fixture::ORDER,
                status,
                None,
                None,
                "2026-11-17T12:00:00Z",
            );
            assert!(matches!(result, Err(ref code) if code == "ORDER_HAS_OPEN_NOTICE"));
            assert_eq!(
                conn.total_changes(),
                before,
                "a refused move must write nothing"
            );
            let status: String = conn
                .query_row(
                    "SELECT status FROM orders WHERE id=?1",
                    [fixture::ORDER],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(status, "ready");
        }
    }

    fn staff_move(
        conn: &Connection,
        status: &str,
    ) -> Result<crate::commands::orders::LocalStatusChange, String> {
        crate::commands::orders::apply_order_status_in_connection(
            conn,
            fixture::ORDER,
            status,
            None,
            None,
            "2026-11-17T12:00:00Z",
        )
    }

    #[test]
    fn notice_failure_code_names_the_kind_of_failure_without_carrying_its_text() {
        for (message, expected) in [
            (
                "no such table: recovery_action_log",
                "NOTICE_TABLE_MISSING_RECOVERY_ACTION_LOG",
            ),
            (
                "no such table: main.parity_sync_queue",
                "NOTICE_TABLE_MISSING_PARITY_SYNC_QUEUE",
            ),
            (
                "no such column: a.payload_json",
                "NOTICE_COLUMN_MISSING_PAYLOAD_JSON",
            ),
            (
                "no such column: Maria Papadopoulou",
                "NOTICE_COLUMN_MISSING",
            ),
            ("malformed JSON", "NOTICE_DATA_MALFORMED"),
            (
                "database disk image is malformed",
                "NOTICE_DATABASE_DAMAGED",
            ),
            ("file is not a database", "NOTICE_DATABASE_DAMAGED"),
            ("database is locked", "NOTICE_DATABASE_BUSY"),
            ("interrupted", "NOTICE_READ_INTERRUPTED"),
            ("disk I/O error", "NOTICE_STORAGE_ERROR"),
            ("database or disk is full", "NOTICE_STORAGE_ERROR"),
            (
                "Table cache branch is unavailable",
                "ORDER_NOTICE_SCOPE_UNAVAILABLE",
            ),
            (
                "ORDER_NOTICE_READ_FAILED: private data",
                "ORDER_NOTICE_READ_FAILED",
            ),
            (
                "something nobody has seen yet about customer@example.test",
                "ORDER_NOTICE_OBSERVATION_FAILED",
            ),
        ] {
            let code = notice_failure_code(message);
            assert_eq!(code, expected, "{message}");
            assert!(is_notice_failure_code(&code), "{code}");
        }
        assert!(!is_notice_failure_code("no such table: orders"));
        assert!(!is_notice_failure_code("ab"));
    }

    #[test]
    fn notice_containment_failed_read_refuses_completion_but_allows_earlier_statuses() {
        for status in ["delivered", "completed", "ready", "cancelled"] {
            let (conn, _, _, _) = setup(false);
            if status == "cancelled" {
                conn.execute(
                    "DELETE FROM order_payments WHERE order_id=?1",
                    [fixture::ORDER],
                )
                .unwrap();
                conn.execute(
                    "UPDATE orders SET payment_status='pending' WHERE id=?1",
                    [fixture::ORDER],
                )
                .unwrap();
            }
            conn.execute_batch("DROP TABLE recovery_action_log")
                .unwrap();
            assert!(notices(&conn, Some(&[fixture::ORDER.into()])).is_err());
            let before = conn.total_changes();
            let result = staff_move(&conn, status);
            if matches!(status, "delivered" | "completed") {
                assert!(matches!(result, Err(ref code) if code == ORDER_NOTICE_CHECK_UNAVAILABLE));
                assert_eq!(conn.total_changes(), before);
                continue;
            }
            assert!(result.is_ok(), "{status}");
            assert_eq!(
                conn.query_row(
                    "SELECT status FROM orders WHERE id=?1",
                    [fixture::ORDER],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                status
            );
        }
    }

    #[test]
    fn notice_containment_missing_audit_does_not_fail_queue_ack() {
        let (conn, row, _, _) = setup(false);
        let generation: i64 = conn
            .query_row(
                "SELECT claim_generation FROM parity_sync_queue WHERE id=?1",
                [&row.id],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute_batch("DROP TABLE recovery_action_log")
            .unwrap();
        sync_queue::mark_success(&conn, &row.id, generation).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM parity_sync_queue WHERE id=?1",
                [&row.id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn notice_containment_failed_read_does_not_block_payment() {
        let (conn, _, _, _) = setup(false);
        conn.execute_batch("DROP TABLE recovery_action_log")
            .unwrap();
        conn.execute(
            "DELETE FROM order_payments WHERE order_id=?1",
            [fixture::ORDER],
        )
        .unwrap();
        conn.execute(
            "UPDATE orders SET payment_status='pending' WHERE id=?1",
            [fixture::ORDER],
        )
        .unwrap();
        let input = crate::payments::build_payment_record_input(&json!({"orderId":fixture::ORDER,"method":"cash","amount":10.75,"currency":"EUR","staffId":"cashier","staffShiftId":"cashier-shift","idempotencyKey":"notice-read-failed-still-pay"})).unwrap();
        crate::payments::record_payment_in_connection(
            &conn,
            &input,
            &crate::payments::PaymentInsertOptions::local(),
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM order_payments WHERE order_id=?1",
                [fixture::ORDER],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn notice_containment_observer_never_borrows_business_mutex_or_waits_for_writer() {
        let fixture = crate::tests::harness::TestDb::open();
        let live = fixture.state.conn.lock().unwrap();
        let tx = crate::db::immediate_transaction(&live).unwrap();
        let read = observer_connection(&fixture.state.db_path, false).unwrap();
        assert_eq!(
            read.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let write = observer_connection(&fixture.state.db_path, true).unwrap();
        let gate = crate::support::critical_op::CriticalOpGate::new();
        let permit = gate.try_begin_support(true, None).unwrap();
        assert!(permit.begin_write_nowait(&write).is_err());
        assert_eq!(
            write
                .query_row("PRAGMA busy_timeout", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(tx);
        let own = permit.begin_write_nowait(&write).unwrap();
        let _sale = gate.begin_critical(crate::support::critical_op::CriticalKind::Checkout);
        assert!(own
            .execute("UPDATE orders SET status='completed'", [])
            .is_err());
        drop(own);
        assert!(crate::db::immediate_transaction(&live).is_ok());
    }

    #[test]
    fn notice_containment_health_keeps_owner_observations_fresh_when_notice_read_fails() {
        let fixture = crate::tests::harness::TestDb::open();
        fixture
            .state
            .conn
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE recovery_action_log")
            .unwrap();
        let health = crate::diagnostics::get_system_health(&fixture.state).unwrap();
        assert!(!health["readFailures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|source| source == "orderNotices" || source == "orderIssueEvidence"));
        assert!(health["observerFailures"]
            .as_array()
            .unwrap()
            .contains(&json!("orderIssueEvidence")));
        assert!(health["orderNotices"].is_null());
        assert!(health["orderIssueEvidence"].is_null());
    }

    #[test]
    fn open_notice_completion_allowed_without_notice_and_after_resolution() {
        for resolved in [false, true] {
            let conn = if resolved {
                let (conn, row, before, answer) = setup(false);
                assert!(staff_move(&conn, "completed").is_err());
                run(&conn, &row, &before, &answer, KEEP).unwrap();
                conn
            } else {
                let conn = fixture::test_conn();
                fixture::paid_delivery_order(&conn);
                conn
            };
            conn.execute(
                "UPDATE orders SET status='ready' WHERE id=?1",
                [fixture::ORDER],
            )
            .unwrap();
            assert!(matches!(
                staff_move(&conn, "completed"),
                Ok(crate::commands::orders::LocalStatusChange::Applied { .. })
            ));
            assert_eq!(
                conn.query_row(
                    "SELECT status FROM orders WHERE id=?1",
                    [fixture::ORDER],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                "completed"
            );
        }
    }

    #[test]
    fn open_notice_all_kinds_and_pending_proof_hold_completion() {
        for kind in [
            "header",
            "unbound",
            "items",
            "money",
            "pending",
            "missing_ack",
        ] {
            let (conn, row, before, answer) = setup(kind == "unbound");
            match kind {
                "items" => {
                    conn.execute("UPDATE parity_sync_queue SET data=json_set(data,'$.items',json('[]')) WHERE id=?1", [&row.id]).unwrap();
                }
                "money" => {
                    run(&conn, &row, &before, &answer, KEEP).unwrap();
                    conn.execute("INSERT INTO sync_queue(entity_type,entity_id,operation,payload,idempotency_key,status,last_error,created_at) VALUES('payment',?1,'INSERT','{}','notice-payment','failed','UNKNOWN_CONFLICT_REVIEW',datetime('now'))", [fixture::PAYMENT]).unwrap();
                }
                "pending" | "missing_ack" => {
                    run(&conn, &row, &before, &answer, RESEND).unwrap();
                    if kind == "missing_ack" {
                        conn.execute(
                            "DELETE FROM parity_sync_queue WHERE record_id=?1",
                            [fixture::ORDER],
                        )
                        .unwrap();
                    }
                }
                _ => {}
            }
            assert!(
                !notices(&conn, Some(&[fixture::ORDER.into()]))
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .is_empty(),
                "{kind}"
            );
            let before = conn.total_changes();
            assert!(
                matches!(staff_move(&conn, "completed"), Err(ref code) if code == ORDER_HAS_OPEN_NOTICE),
                "{kind}"
            );
            assert_eq!(conn.total_changes(), before, "{kind}");
        }
    }

    #[test]
    fn open_notice_earlier_stages_and_cancel_are_not_gated() {
        for status in ["preparing", "ready", "out_for_delivery", "cancelled"] {
            let (conn, _, _, _) = setup(false);
            if status == "cancelled" {
                // Existing paid-cancel rules still apply, independently of notices.
                conn.execute(
                    "DELETE FROM order_payments WHERE order_id=?1",
                    [fixture::ORDER],
                )
                .unwrap();
                conn.execute(
                    "UPDATE orders SET payment_status='pending' WHERE id=?1",
                    [fixture::ORDER],
                )
                .unwrap();
            }
            assert!(
                matches!(
                    staff_move(&conn, status),
                    Ok(crate::commands::orders::LocalStatusChange::Applied { .. })
                ),
                "{status}"
            );
        }
    }

    #[test]
    fn open_notice_driver_assignment_succeeds_but_keeps_the_order_active() {
        let (conn, _, _, _) = setup(false);
        let (_, _, status, _) = crate::commands::orders::assign_driver_locally(
            &conn,
            fixture::ORDER,
            "driver-1",
            None,
            "2026-11-17T12:00:00Z",
        )
        .unwrap();
        assert_eq!(status, "pending");
        let assigned: String = conn
            .query_row(
                "SELECT driver_id FROM orders WHERE id=?1",
                [fixture::ORDER],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(assigned, "driver-1");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM parity_sync_queue WHERE record_id=?1 AND json_extract(data,'$.status')='delivered'", [fixture::ORDER], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn order_notice_failed_read_keeps_driver_assignment_but_holds_completion() {
        let (conn, _, _, _) = setup(false);
        conn.execute_batch("DROP TABLE recovery_action_log")
            .unwrap();
        let (_, _, status, refusal) = crate::commands::orders::assign_driver_locally(
            &conn,
            fixture::ORDER,
            "driver-1",
            None,
            "2026-11-17T12:00:00Z",
        )
        .unwrap();
        assert_eq!(status, "pending");
        assert_eq!(refusal.as_deref(), Some(ORDER_NOTICE_CHECK_UNAVAILABLE));
        assert_eq!(
            conn.query_row(
                "SELECT driver_id FROM orders WHERE id=?1",
                [fixture::ORDER],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "driver-1"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM driver_earnings WHERE order_id=?1",
                [fixture::ORDER],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM parity_sync_queue WHERE record_id=?1 AND json_extract(data,'$.status')='delivered'", [fixture::ORDER], |r|r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn order_notice_failed_read_keeps_platform_ready_but_holds_completion() {
        let (conn, _, _, _) = setup(false);
        conn.execute_batch("DROP TABLE recovery_action_log")
            .unwrap();
        conn.execute(
            "UPDATE orders SET plugin='efood',ghost_metadata=?1 WHERE id=?2",
            params![
                json!({"food_delivery":{"delivery_provider":"platform_delivery"}}).to_string(),
                fixture::ORDER
            ],
        )
        .unwrap();
        let db = crate::db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: Default::default(),
        };
        let result = crate::commands::orders::notify_platform_ready_locally(
            &db,
            fixture::ORDER,
            "2026-11-17T12:00:00Z",
        )
        .unwrap();
        assert!(
            matches!(result, crate::commands::orders::PlatformReadyLocal::Applied {local_status:"ready", completion_refusal:Some(ref code), ..} if code == ORDER_NOTICE_CHECK_UNAVAILABLE)
        );
    }

    #[test]
    fn open_notice_platform_ready_succeeds_but_keeps_the_order_active() {
        for has_notice in [true, false] {
            let (conn, row, before, answer) = setup(false);
            if !has_notice {
                run(&conn, &row, &before, &answer, KEEP).unwrap();
            }
            conn.execute(
                "UPDATE orders SET plugin='efood',ghost_metadata=?1 WHERE id=?2",
                params![
                    json!({"food_delivery":{"delivery_provider":"platform_delivery"}}).to_string(),
                    fixture::ORDER
                ],
            )
            .unwrap();
            let db = crate::db::DbState {
                conn: std::sync::Mutex::new(conn),
                db_path: std::path::PathBuf::new(),
            };
            let result = crate::commands::orders::notify_platform_ready_locally(
                &db,
                fixture::ORDER,
                "2026-11-17T12:00:00Z",
            )
            .unwrap();
            let expected = if has_notice { "ready" } else { "delivered" };
            assert!(
                matches!(result, crate::commands::orders::PlatformReadyLocal::Applied { local_status, .. } if local_status == expected)
            );
            let conn = db.conn.lock().unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT status FROM orders WHERE id=?1",
                    [fixture::ORDER],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn open_notice_does_not_refuse_payment_recording() {
        let (conn, _, _, _) = setup(false);
        conn.execute(
            "DELETE FROM order_payments WHERE order_id=?1",
            [fixture::ORDER],
        )
        .unwrap();
        conn.execute(
            "UPDATE orders SET payment_status='pending' WHERE id=?1",
            [fixture::ORDER],
        )
        .unwrap();
        let input = crate::payments::build_payment_record_input(&json!({"orderId":fixture::ORDER,"method":"cash","amount":10.75,"currency":"EUR","staffId":"cashier","staffShiftId":"cashier-shift","idempotencyKey":"notice-still-pay"})).unwrap();
        crate::payments::record_payment_in_connection(
            &conn,
            &input,
            &crate::payments::PaymentInsertOptions::local(),
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM order_payments WHERE order_id=?1",
                [fixture::ORDER],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert!(!notices(&conn, None).unwrap().as_array().unwrap().is_empty());
    }

    #[test]
    fn open_notice_does_not_gate_an_incoming_completed_snapshot() {
        let (conn, row, before, answer) = setup(false);
        // An order edit has its own existing merge hold. Use a money notice
        // to prove this new completion guard does not intercept incoming state.
        run(&conn, &row, &before, &answer, KEEP).unwrap();
        conn.execute("INSERT INTO sync_queue(entity_type,entity_id,operation,payload,idempotency_key,status,last_error,created_at) VALUES('payment',?1,'INSERT','{}','notice-incoming','failed','UNKNOWN_CONFLICT_REVIEW',datetime('now'))", [fixture::PAYMENT]).unwrap();
        assert!(!notices(&conn, None).unwrap().as_array().unwrap().is_empty());
        let mut remote = fixture::Server::mirror(&conn).order;
        remote["id"] = json!(fixture::REMOTE_ORDER);
        remote["status"] = json!("completed");
        remote["version"] = json!(51);
        remote["updated_at"] =
            json!((chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339());
        assert_eq!(
            crate::sync::apply_remote_orders_page_for_test(&conn, vec![remote]),
            None
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM orders WHERE id=?1",
                [fixture::ORDER],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "completed"
        );
    }

    #[test]
    fn open_notice_failed_status_enqueue_rolls_back_the_status() {
        let conn = fixture::test_conn();
        fixture::paid_delivery_order(&conn);
        conn.execute(
            "UPDATE orders SET status='ready' WHERE id=?1",
            [fixture::ORDER],
        )
        .unwrap();
        conn.execute_batch("CREATE TRIGGER fail_status_queue BEFORE INSERT ON parity_sync_queue BEGIN SELECT RAISE(ABORT,'test queue failure'); END;").unwrap();
        assert!(staff_move(&conn, "completed").is_err());
        assert_eq!(
            conn.query_row(
                "SELECT status FROM orders WHERE id=?1",
                [fixture::ORDER],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "ready"
        );
    }

    #[test]
    fn open_notice_is_read_after_write_admission() {
        let (conn, row, _, _) = setup(false);
        conn.execute(
            "UPDATE parity_sync_queue SET status='pending' WHERE id=?1",
            [&row.id],
        )
        .unwrap();
        assert_eq!(notices(&conn, None).unwrap(), json!([]));
        crate::db::BEFORE_WRITE_ADMISSION.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |conn| {
                conn.execute(
                    "UPDATE parity_sync_queue SET status='conflict' WHERE id=?1",
                    [&row.id],
                )
                .unwrap();
            }));
        });
        assert!(
            matches!(staff_move(&conn, "completed"), Err(ref code) if code == ORDER_HAS_OPEN_NOTICE)
        );
    }
    #[test]
    fn open_notice_waiting_payment_uses_the_same_reachability_as_the_card() {
        let conn = fixture::test_conn();
        fixture::paid_delivery_order(&conn);
        conn.execute("INSERT INTO sync_queue(entity_type,entity_id,operation,payload,idempotency_key,status,created_at) VALUES('payment',?1,'INSERT','{}','notice-waiting','pending',datetime('now','-11 minutes'))", [fixture::PAYMENT]).unwrap();
        let before = conn.total_changes();
        let previous = TEST_REACHABLE.with(|value| value.replace(Some(Some(true))));
        let visible = notices(&conn, Some(&[fixture::ORDER.into()]));
        let result = staff_move(&conn, "completed");
        TEST_REACHABLE.with(|value| value.set(previous));
        assert_eq!(visible.unwrap()[0]["state"], "waiting");
        assert!(matches!(result, Err(ref code) if code == ORDER_HAS_OPEN_NOTICE));
        assert_eq!(conn.total_changes(), before);
    }

    fn run(
        conn: &Connection,
        row: &Refused,
        before: &Value,
        answer: &Value,
        action: &str,
    ) -> Result<Value, String> {
        let tx = crate::db::immediate_transaction(conn).map_err(|e| e.to_string())?;
        let result = apply(&tx, row, before, answer, action, "snapshot")?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(result)
    }
    #[test]
    fn automatic_order_attempt_admission_offline_busy_editing_and_once() {
        let (conn, row, _, _) = setup(false);
        for (online, busy, editing) in [
            (false, false, false),
            (true, true, false),
            (true, false, true),
        ] {
            assert!(
                !crate::order_notice_auto::admitted(&conn, &row, online, busy, editing).unwrap()
            );
        }
        assert!(crate::order_notice_auto::admitted(&conn, &row, true, false, false).unwrap());
        let tx = crate::db::immediate_transaction(&conn).unwrap();
        assert!(crate::order_notice_auto::claim(&tx, &row).unwrap());
        tx.commit().unwrap();
        // Reopen an actual SQLite file: no connection or process-local flag
        // may be needed to remember that this request consumed its attempt.
        let path = std::env::temp_dir().join(format!(
            "pos-automatic-attempt-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        conn.execute("VACUUM INTO ?1", [path.to_str().unwrap()])
            .unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        assert!(!crate::order_notice_auto::eligible(&conn, &row).unwrap());
        assert!(!crate::order_notice_auto::claim(&conn, &row).unwrap());
        let notice = notices_when(&conn, None, Some(true)).unwrap();
        assert_eq!(notice[0]["state"], "pending");
        assert_eq!(notice[0]["automatic"], true);
        assert_eq!(notice[0]["actions"], json!([]));
        assert_eq!(
            require_no_open_notice(&conn, fixture::ORDER, "delivered"),
            Err(ORDER_HAS_OPEN_NOTICE.into())
        );
        crate::order_notice_auto::fail(&conn, &row.id, "AUTOMATIC_ATTEMPT_INTERRUPTED").unwrap();
        assert!(!crate::order_notice_auto::eligible(&conn, &row).unwrap());
        let notice = notices_when(&conn, None, Some(true)).unwrap();
        assert_eq!(notice[0]["state"], "refused");
        assert_eq!(notice[0]["automatic"], false);
        assert_eq!(notice[0]["actions"][0], RESEND);
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn automatic_order_attempt_window_editing_is_shared_and_cleared_on_destroy() {
        let id = "isolated-edit-lease-test-order";
        crate::order_notice_auto::set_editing("edit-window:session".into(), vec![id.into()])
            .unwrap();
        assert!(crate::order_notice_auto::editing(id));
        crate::order_notice_auto::clear_window("other-window");
        assert!(crate::order_notice_auto::editing(id));
        crate::order_notice_auto::clear_window("edit-window");
        assert!(!crate::order_notice_auto::editing(id));
    }

    #[test]
    fn employee_order_attempt_stays_visible_and_holds_completion_until_ack() {
        let (conn, row, _, _) = setup(false);
        conn.execute(
            "UPDATE parity_sync_queue SET data='{\"items\":[]}' WHERE id=?1",
            [&row.id],
        )
        .unwrap();
        let id = crate::order_notice_evidence::employee_attempt(&conn, &json!({"queueId":row.id}))
            .unwrap();
        conn.execute(
            "UPDATE parity_sync_queue SET status='pending',error_message=NULL WHERE id=?1",
            [&row.id],
        )
        .unwrap();
        crate::order_notice_evidence::employee_attempt(
            &conn,
            &json!({"attemptId":id,"outcome":"pending"}),
        )
        .unwrap();
        let notice = notices(&conn, None).unwrap();
        assert_eq!(notice[0]["kind"], "change_refused");
        assert_eq!(notice[0]["state"], "pending");
        assert_eq!(
            require_no_open_notice(&conn, fixture::ORDER, "completed"),
            Err(ORDER_HAS_OPEN_NOTICE.into())
        );
        assert_eq!(
            crate::order_notice_evidence::collect(&conn).unwrap()[0]["refusal_code"],
            "UNKNOWN_CONFLICT_REVIEW"
        );
        let generation = conn
            .query_row(
                "SELECT claim_generation FROM parity_sync_queue WHERE id=?1",
                [&row.id],
                |r| r.get(0),
            )
            .unwrap();
        sync_queue::mark_success(&conn, &row.id, generation).unwrap();
        assert_eq!(notices(&conn, None).unwrap(), json!([]));
    }

    #[test]
    fn automatic_order_attempt_audit_ack_and_no_replacement_retry() {
        for unbound in [false, true] {
            let (conn, row, before, answer) = setup(unbound);
            assert!(crate::order_notice_auto::claim(&conn, &row).unwrap());
            let tx = crate::db::immediate_transaction(&conn).unwrap();
            crate::order_notice_auto::apply(&tx, &row, &before, &answer).unwrap();
            tx.commit().unwrap();
            assert!(refused(&conn, &row.id).unwrap().is_none());
            let raw:String=conn.query_row("SELECT payload_json FROM recovery_action_log WHERE json_extract(payload_json,'$.nativeOrderCorrection')=1",[],|r|r.get(0)).unwrap();
            let audit: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(audit["automatic"], true);
            assert_eq!(audit["retiredRequest"], row.data);
            assert_eq!(audit["reason"], row.error);
            let replacement = audit["replacementQueueId"].as_str().unwrap();
            let pending = notices_when(&conn, None, Some(true)).unwrap();
            assert_eq!(pending[0]["automatic"], true);
            assert_eq!(pending[0]["state"], "pending");
            assert_eq!(
                require_no_open_notice(&conn, fixture::ORDER, "completed"),
                Err(ORDER_HAS_OPEN_NOTICE.into())
            );
            conn.execute("UPDATE parity_sync_queue SET status='conflict',error_message='UNKNOWN_CONFLICT_REVIEW' WHERE id=?1",[replacement]).unwrap();
            let refused_again = refused(&conn, replacement).unwrap().unwrap();
            assert!(!crate::order_notice_auto::eligible(&conn, &refused_again).unwrap());
            let failed = notices_when(&conn, None, Some(true)).unwrap();
            assert_eq!(failed[0]["automatic"], false);
            assert_eq!(failed[0]["failedAgain"], true);
            acknowledged(&conn, replacement, "2026-11-17T12:00:00Z").unwrap();
            conn.execute("DELETE FROM parity_sync_queue WHERE id=?1", [replacement])
                .unwrap();
            assert_eq!(notices(&conn, None).unwrap(), json!([]));
        }
    }

    #[test]
    fn automatic_order_attempt_rolls_back_replacement_and_retirement_on_audit_failure() {
        let (conn, row, before, answer) = setup(false);
        crate::order_notice_auto::claim(&conn, &row).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_automatic_audit BEFORE INSERT ON recovery_action_log WHEN json_extract(NEW.payload_json,'$.nativeOrderCorrection')=1 BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;").unwrap();
        {
            let tx = crate::db::immediate_transaction(&conn).unwrap();
            assert!(crate::order_notice_auto::apply(&tx, &row, &before, &answer).is_err());
        }
        assert!(refused(&conn, &row.id).unwrap().is_some());
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE table_name='orders'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert!(!crate::order_notice_auto::eligible(&conn, &row).unwrap());
    }

    #[test]
    fn automatic_order_attempt_refuses_changed_canonical_without_mutating_order() {
        let (conn, row, before, mut answer) = setup(false);
        crate::order_notice_auto::claim(&conn, &row).unwrap();
        answer["orders"][0]["total_amount"] = json!(999);
        {
            let tx = crate::db::immediate_transaction(&conn).unwrap();
            assert!(crate::order_notice_auto::apply(&tx, &row, &before, &answer).is_err());
        }
        assert!(refused(&conn, &row.id).unwrap().is_some());
        crate::order_notice_auto::fail(&conn, &row.id, "EDIT_CANONICAL_ORIGINAL_CHANGED").unwrap();
        let evidence = crate::order_notice_evidence::collect(&conn).unwrap();
        assert_eq!(evidence[0].as_object().unwrap().len(), 9);
        assert_eq!(
            evidence[0]["automatic_attempt"],
            json!({"ran":true,"outcome":"failed","reason":"EDIT_CANONICAL_ORIGINAL_CHANGED"})
        );
        assert_eq!(evidence[0]["shape_class"], "header-only");
        assert_eq!(evidence[0]["refusal_code"], "UNKNOWN_CONFLICT_REVIEW");
        assert_eq!(evidence[0]["table_name"], "orders");
        assert_eq!(evidence[0]["operation"], "update");
        assert!(evidence[0]["open_for_ms"].is_i64());
        assert_eq!(evidence[0]["app_version"], env!("CARGO_PKG_VERSION"));
        let exported = crate::diagnostics::redact_remote_diagnostics_value(evidence);
        let text = exported.to_string();
        for private in [
            "Corrected",
            "Earlier",
            fixture::ORDER,
            "customer_name",
            "retiredRequest",
            "refused-event",
        ] {
            assert!(!text.contains(private), "{private}");
        }
        let attempt =
            crate::order_notice_evidence::employee_attempt(&conn, &json!({"queueId":row.id}))
                .unwrap();
        crate::order_notice_evidence::employee_attempt(
            &conn,
            &json!({"attemptId":attempt,"outcome":"failed","code":"ORDER_VERSION_CONFLICT"}),
        )
        .unwrap();
        assert_eq!(
            crate::order_notice_evidence::collect(&conn).unwrap()[0]["employee_attempt"]["outcome"],
            "failed"
        );
    }
    #[test]
    fn order_notice_evidence_financial_wait_uses_android_table_and_milliseconds() {
        let conn = fixture::test_conn();
        fixture::paid_delivery_order(&conn);
        conn.execute("INSERT INTO sync_queue(entity_type,entity_id,operation,payload,idempotency_key,status,created_at) VALUES('payment',?1,'INSERT','{}','android-evidence-wait','pending',datetime('now','-11 minutes'))",[fixture::PAYMENT]).unwrap();
        let previous = TEST_REACHABLE.with(|value| value.replace(Some(Some(true))));
        let evidence = crate::order_notice_evidence::collect(&conn);
        TEST_REACHABLE.with(|value| value.set(previous));
        let evidence = evidence.unwrap();
        assert_eq!(evidence[0]["table_name"], "order_payments");
        assert_eq!(evidence[0]["operation"], "insert");
        assert_eq!(evidence[0]["shape_class"], "money");
        assert_eq!(evidence[0]["refusal_code"], "AWAITING_CONFIRMATION");
        assert!(evidence[0]["open_for_ms"].as_i64().unwrap() >= 660_000);
        assert!(evidence[0]["open_for_ms"].as_i64().unwrap() < 720_000);
        assert_eq!(
            evidence[0]["employee_attempt"],
            json!({"ran":false,"outcome":"not_run","reason":"NOT_ATTEMPTED"})
        );
    }
    #[test]
    fn order_notice_recovery_exact_matcher_excludes_other_shapes() {
        let base = json!({"client_event_id":"event","expected_version":1,"customer_name":"Name"});
        assert!(matches(
            "UPDATE",
            "conflict",
            "UNKNOWN_CONFLICT_REVIEW",
            &base
        ));
        for key in [
            "items",
            "settlement_context",
            "total_amount",
            "payment_status",
            "order_type",
            "payment_method",
            "table_session_id",
            "tip_amount",
        ] {
            let mut payload = base.clone();
            payload[key] = json!(1);
            assert!(
                !matches("UPDATE", "conflict", "UNKNOWN_CONFLICT_REVIEW", &payload),
                "{key}"
            );
        }
        for (op, status, error) in [
            ("INSERT", "conflict", "UNKNOWN_CONFLICT_REVIEW"),
            ("UPDATE", "pending", "UNKNOWN_CONFLICT_REVIEW"),
            ("UPDATE", "failed", "HTTP_500"),
            ("UPDATE", "conflict", "DIFFERENT_CONFLICT"),
        ] {
            assert!(!matches(op, status, error, &base));
        }
        let mut unbound = base.clone();
        unbound["expected_version"] = Value::Null;
        assert!(!matches(
            "UPDATE",
            "failed",
            "ORDER_EDIT_BASE_UNAVAILABLE",
            &unbound
        ));
        unbound["base_before_create"] = json!(true);
        assert!(matches(
            "UPDATE",
            "failed",
            "ORDER_EDIT_BASE_UNAVAILABLE",
            &unbound
        ));
        unbound["client_event_id"] = json!("");
        assert!(!matches(
            "UPDATE",
            "failed",
            "ORDER_EDIT_BASE_UNAVAILABLE",
            &unbound
        ));
    }
    #[test]
    fn order_notice_recovery_resend_is_atomic_audited_and_pending_until_ack() {
        for unbound in [false, true] {
            let (conn, row, before, answer) = setup(unbound);
            assert_eq!(
                notices(&conn, Some(&[fixture::ORDER.into()])).unwrap()[0]["kind"],
                "customer_correction_refused"
            );
            assert_eq!(
                run(&conn, &row, &before, &answer, RESEND).unwrap()["verification"]["status"],
                "pending"
            );
            assert!(refused(&conn, &row.id).unwrap().is_none());
            let (_new_id, data): (String, String) = conn
                .query_row(
                    "SELECT id,data FROM parity_sync_queue WHERE record_id=?1",
                    [fixture::ORDER],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            let next: Value = serde_json::from_str(&data).unwrap();
            assert_ne!(next["client_event_id"], "refused-event");
            assert_eq!(next["expected_version"], 50);
            assert_eq!(next["customer_name"], "Corrected");
            assert!(next.get("base_before_create").is_none());
            let audit: String = conn
                .query_row(
                    "SELECT payload_json FROM recovery_action_log WHERE action_id=?1",
                    [RESEND],
                    |r| r.get(0),
                )
                .unwrap();
            let audit: Value = serde_json::from_str(&audit).unwrap();
            assert_eq!(audit["retiredRequest"], row.data);
            assert_eq!(audit["retiredQueueId"], row.id);
            run(&conn, &row, &before, &answer, RESEND).unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM recovery_action_log WHERE action_id=?1",
                    [RESEND],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
            assert_eq!(notices(&conn, None).unwrap()[0]["state"], "pending");
            let mut canonical = answer["orders"][0].clone();
            canonical["version"] = json!(51);
            sync_queue::apply_ack_for_test(
                &conn,
                "orders",
                fixture::ORDER,
                &json!({"success":true,"data":canonical}),
            )
            .unwrap();
            assert_eq!(notices(&conn, None).unwrap(), json!([]));
        }
    }
    #[test]
    fn order_notice_recovery_keep_server_is_verified_audited_idempotent() {
        let (conn, row, before, answer) = setup(false);
        assert_eq!(
            run(&conn, &row, &before, &answer, KEEP).unwrap()["verification"]["status"],
            "passed"
        );
        assert_eq!(
            crate::edit_settlement_recovery::capture_order_headers(&conn, fixture::ORDER).unwrap()
                ["customer_name"],
            "Earlier"
        );
        assert_eq!(notices(&conn, None).unwrap(), json!([]));
        run(&conn, &row, &before, &answer, KEEP).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM recovery_action_log WHERE action_id=?1",
                [KEEP],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn order_notice_recovery_preflight_refusal_and_unavailable_change_nothing() {
        for action in [RESEND, KEEP] {
            let (conn, row, before, answer) = setup(false);
            for (key, value) in [
                ("id", json!("other")),
                ("organization_id", json!("other")),
                ("branch_id", json!("other")),
                ("status", json!("cancelled")),
                ("total_amount", json!(999)),
                ("items", json!([])),
                ("version", json!(0)),
            ] {
                let mut changed = answer.clone();
                changed["orders"][0][key] = value;
                assert!(
                    run(&conn, &row, &before, &changed, action).is_err(),
                    "{key}"
                );
                assert_eq!(refused(&conn, &row.id).unwrap().unwrap().data, row.data);
            }
            assert!(run(&conn, &row, &before, &Value::Null, action).is_err());
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM recovery_action_log WHERE action_id IN (?1,?2)",
                    params![RESEND, KEEP],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        }
    }
    #[test]
    fn order_notice_recovery_failed_audit_or_delete_rolls_back_every_write() {
        for action in [RESEND, KEEP] {
            for table in ["recovery_action_log", "parity_sync_queue"] {
                let (conn, row, before, answer) = setup(false);
                let operation = if table == "recovery_action_log" {
                    "INSERT"
                } else {
                    "DELETE"
                };
                conn.execute_batch(&format!("CREATE TRIGGER fail_recovery BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT,'test'); END;")).unwrap();
                assert!(run(&conn, &row, &before, &answer, action).is_err());
                assert_eq!(refused(&conn, &row.id).unwrap().unwrap().data, row.data);
                assert_eq!(capture(&conn, &row).unwrap(), before);
                assert_eq!(
                    conn.query_row(
                        "SELECT COUNT(*) FROM parity_sync_queue WHERE record_id=?1",
                        [fixture::ORDER],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                    1
                );
            }
        }
    }
    #[test]
    fn order_notice_recovery_notice_scope_provider_table_and_money_boundaries() {
        let (conn, row, _, _) = setup(false);
        assert_eq!(notices(&conn, Some(&["other".into()])).unwrap(), json!([]));
        for (column, value) in [
            ("plugin", "wolt"),
            ("table_id", "a-table"),
            ("order_context", "repair_settlement"),
        ] {
            conn.execute(
                &format!("UPDATE orders SET {column}=?1 WHERE id=?2"),
                params![value, fixture::ORDER],
            )
            .unwrap();
            assert!(refused(&conn, &row.id).unwrap().is_none());
            conn.execute(
                &format!("UPDATE orders SET {column}=NULL WHERE id=?1"),
                [fixture::ORDER],
            )
            .unwrap();
        }
        conn.execute(
            "UPDATE parity_sync_queue SET data=json_set(data,'$.items',json('[]')) WHERE id=?1",
            [&row.id],
        )
        .unwrap();
        assert_eq!(notices(&conn, None).unwrap()[0]["kind"], "change_refused");
        conn.execute(
            "UPDATE parity_sync_queue SET status='pending' WHERE id=?1",
            [&row.id],
        )
        .unwrap();
        assert_eq!(notices(&conn, None).unwrap(), json!([]));
        conn.execute("INSERT INTO sync_queue(entity_type,entity_id,operation,payload,idempotency_key,status,created_at) VALUES('payment',?1,'INSERT','{}','notice-payment','pending',datetime('now','-11 minutes'))",[fixture::PAYMENT]).unwrap();
        // Offline (or not known yet) a waiting payment is the till's offline
        // state, not a notice on every recent order.
        assert_eq!(notices_when(&conn, None, Some(false)).unwrap(), json!([]));
        assert_eq!(notices_when(&conn, None, None).unwrap(), json!([]));
        let online = notices_when(&conn, None, Some(true)).unwrap();
        assert_eq!(online[0]["kind"], "payment_not_on_server");
        assert_eq!(online[0]["state"], "waiting");
        conn.execute("UPDATE sync_queue SET created_at=datetime('now') WHERE idempotency_key='notice-payment'",[]).unwrap();
        assert_eq!(notices(&conn, None).unwrap(), json!([]));
        conn.execute("UPDATE sync_queue SET status='failed',last_error='UNKNOWN_CONFLICT_REVIEW',updated_at='2026-11-17T12:00:00Z' WHERE idempotency_key='notice-payment'",[]).unwrap();
        assert_eq!(notices(&conn, None).unwrap()[0]["state"], "refused");
        assert_eq!(
            notices(&conn, None).unwrap()[0]["since"],
            "2026-11-17T12:00:00Z"
        );
        conn.execute("UPDATE sync_queue SET updated_at='2026-11-17T12:01:00Z' WHERE idempotency_key='notice-payment'",[]).unwrap();
        assert_eq!(
            notices(&conn, None).unwrap()[0]["since"],
            "2026-11-17T12:01:00Z"
        );
    }

    #[test]
    fn order_notice_recovery_set_aside_is_silent_and_missing_ack_is_not_healed() {
        let (conn, row, before, answer) = setup(false);
        conn.execute("INSERT INTO parity_sync_set_aside(queue_id,table_name,record_id,reason_code,set_aside_by_staff_id,set_aside_at,organization_id) VALUES(?1,'orders',?2,'UNKNOWN_CONFLICT_REVIEW','manager',datetime('now'),?3)",params![row.id,fixture::ORDER,fixture::ORG]).unwrap();
        assert!(refused(&conn, &row.id).unwrap().is_none());
        assert_eq!(notices(&conn, None).unwrap(), json!([]));
        conn.execute(
            "DELETE FROM parity_sync_set_aside WHERE queue_id=?1",
            [&row.id],
        )
        .unwrap();
        run(&conn, &row, &before, &answer, RESEND).unwrap();
        conn.execute(
            "DELETE FROM parity_sync_queue WHERE record_id=?1",
            [fixture::ORDER],
        )
        .unwrap();
        assert_eq!(notices(&conn, None).unwrap()[0]["state"], "pending");
    }
    #[test]
    fn order_notice_recovery_busy_or_preempted_cannot_write() {
        let (conn, row, before, answer) = setup(false);
        let gate = crate::support::critical_op::CriticalOpGate::new();
        for kind in [
            crate::support::critical_op::CriticalKind::Checkout,
            crate::support::critical_op::CriticalKind::Card,
            crate::support::critical_op::CriticalKind::ShiftClose,
            crate::support::critical_op::CriticalKind::ZClose,
        ] {
            let critical = gate.begin_critical(kind);
            assert!(gate.try_begin_support(true, None).is_err());
            drop(critical);
            let permit = gate.try_begin_support(true, None).unwrap();
            let critical = gate.begin_critical(kind);
            assert!(permit.begin_write(&conn).is_err());
            drop(permit);
            drop(critical);
            conn.progress_handler(0, None::<fn() -> bool>);
            assert_eq!(capture(&conn, &row).unwrap(), before);
        }
        assert!(verify(&before, &answer).is_ok());
    }
    #[test]
    fn order_notice_recovery_ack_checks_scope_even_with_a_newer_status() {
        let (conn, row, before, answer) = setup(false);
        run(&conn, &row, &before, &answer, RESEND).unwrap();
        let id: String = conn
            .query_row(
                "SELECT id FROM parity_sync_queue WHERE record_id=?1",
                [fixture::ORDER],
                |r| r.get(0),
            )
            .unwrap();
        let payload = json!({"expected_version":50});
        let mut canonical = answer["orders"][0].clone();
        canonical["version"] = json!(51);
        let mut wrong = canonical.clone();
        wrong["organization_id"] = json!("other");
        assert!(acknowledge_response(
            &conn,
            &id,
            fixture::ORDER,
            &payload,
            Some(&json!({"success":true,"data":wrong})),
            "now"
        )
        .is_err());
        assert_eq!(notices(&conn, None).unwrap()[0]["state"], "pending");
        acknowledge_response(
            &conn,
            &id,
            fixture::ORDER,
            &payload,
            Some(&json!({"success":true,"data":canonical})),
            "now",
        )
        .unwrap();
        assert_eq!(notices(&conn, None).unwrap(), json!([]));
    }
    #[test]
    fn order_notice_recovery_resend_keeps_the_current_delivery_status_and_original_headers() {
        let (conn, row, _, mut answer) = setup(false);
        conn.execute(
            "UPDATE parity_sync_queue SET data=json_set(data,'$.status','pending') WHERE id=?1",
            [&row.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE orders SET status='delivered',customer_name='Earlier' WHERE id=?1",
            [fixture::ORDER],
        )
        .unwrap();
        answer["orders"][0]["status"] = json!("delivered");
        let row = refused(&conn, &row.id).unwrap().unwrap();
        let before = capture(&conn, &row).unwrap();
        run(&conn, &row, &before, &answer, RESEND).unwrap();
        let data: String = conn
            .query_row(
                "SELECT data FROM parity_sync_queue WHERE record_id=?1",
                [fixture::ORDER],
                |r| r.get(0),
            )
            .unwrap();
        let data: Value = serde_json::from_str(&data).unwrap();
        assert_eq!(data["status"], "delivered");
        assert_eq!(data["customer_name"], "Corrected");
        assert_eq!(
            crate::edit_settlement_recovery::capture_order_headers(&conn, fixture::ORDER).unwrap()
                ["customer_name"],
            "Corrected"
        );
    }
}

fn is_older_than_ten_minutes(conn: &Connection, created: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT julianday('now')-julianday(?1)>=10.0/1440.0",
        [created],
        |r| r.get::<_, Option<bool>>(0),
    )
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Order notice timestamp is unavailable".into())
}
